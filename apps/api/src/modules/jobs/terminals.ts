import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {WebSocket} from 'ws';
import {ExecutionContextSchema} from '@homelab/contracts';
import {submitJobInTransaction,cancelJob,digest} from '@homelab/worker';
import type {ApiContext} from '../../core/context.js';
import {captureExecution,executionError} from './execution.js';
import {expectedMachineGeneration} from '@homelab/worker/authority';
const id=z.uuid(),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const dimensions={cols:z.number().int().min(20).max(500),rows:z.number().int().min(5).max(200)};
const sleep=()=>new Promise(resolve=>setTimeout(resolve,500));
export async function registerWorkspaceTerminals(app:FastifyInstance,context:ApiContext){
 const owned=async(request:FastifyRequest)=>{const row=(await context.db.query('SELECT * FROM terminal_sessions WHERE id=$1 AND owner_id=$2',[id.parse((request.params as {id:string}).id),request.actor!.id])).rows[0];if(!row)executionError('terminal_not_found',404);return row;};
 const ticket=async(terminalId:string,sessionId:string)=>{const value=randomBytes(32).toString('base64url');const row=(await context.db.query("INSERT INTO terminal_tickets(id,terminal_id,auth_session_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '60 seconds') RETURNING expires_at",[randomUUID(),terminalId,sessionId,hash(value)])).rows[0];return {ticket:value,expires_at:row.expires_at,ws_path:`/api/v1/workspace-terminals/${terminalId}/ws`};};
 app.get('/workspace-terminals',async request=>{const query=z.object({workspace_id:id.optional()}).parse(request.query);return {items:(await context.db.query('SELECT id,job_id,workspace_id,machine_id,state,metadata,created_at,updated_at,ended_at FROM terminal_sessions WHERE owner_id=$1 AND ($2::uuid IS NULL OR workspace_id=$2) ORDER BY created_at DESC LIMIT 100',[request.actor!.id,query.workspace_id??null])).rows};});
 app.get('/workspace-terminals/:id',async request=>owned(request));
 app.post('/workspace-terminals',async(request,reply)=>{
  if(!context.agentBroker)executionError('agent_transport_unavailable',503);
  const body=z.object({idempotency_key:z.string().min(1).max(200),execution_context:ExecutionContextSchema,grant_id:id,retain_output:z.boolean().default(false),...dimensions}).strict().parse(request.body),owner=request.actor!.id;
  const existing=(await context.db.query('SELECT t.*,j.payload FROM jobs j JOIN terminal_sessions t ON t.job_id=j.id WHERE j.requester_id=$1 AND j.idempotency_key=$2',[owner,body.idempotency_key])).rows[0];
  if(existing){if(existing.payload.client_request_hash!==digest(body))executionError('idempotency_conflict');if(existing.auth_session_id!==request.sessionId)executionError('terminal_session_binding_denied',403);return reply.code(202).send({...existing,...await ticket(existing.id,request.sessionId!)});}
  const captured=await captureExecution(context,request.actor!,body.execution_context,body.grant_id,['workspace.terminal','run_command']);
  const client=await context.db.connect();let row;
  try{await client.query('BEGIN');const job=await submitJobInTransaction(client,{requester_id:owner,idempotency_key:body.idempotency_key,context:null,workspace_id:body.execution_context.workspace_id,kind:'workspace_terminal',modifies_workspace:true,payload:{...captured,cols:body.cols,rows:body.rows,retain_output:body.retain_output,client_request_hash:digest(body)}});
   row=(await client.query('INSERT INTO terminal_sessions(id,owner_id,workspace_id,job_id,machine_id,auth_session_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id) DO UPDATE SET job_id=excluded.job_id RETURNING *',[randomUUID(),owner,body.execution_context.workspace_id,job.id,body.execution_context.execution_machine_id,request.sessionId])).rows[0];await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  if(row.auth_session_id!==request.sessionId)executionError('terminal_session_binding_denied',403);
  await context.audit(owner,'workspace.terminal.create',row.id,'queued',{job_id:row.job_id,logout_policy:'cancel_until_exit_confirmed',disconnect_policy:'host_detach_grace_retains_writer'});
  return reply.code(202).send({...row,...await ticket(row.id,request.sessionId!)});
 });
 app.post('/workspace-terminals/:id/attach',async request=>{const row=await owned(request);if(row.auth_session_id!==request.sessionId)executionError('terminal_session_binding_denied',403);if(['exited','outcome_unknown'].includes(row.state))executionError('terminal_not_attachable');return {...await ticket(row.id,request.sessionId!),id:row.id,job_id:row.job_id,state:row.state};});
 app.post('/workspace-terminals/:id/cancel',async request=>{const row=await owned(request);const job=await cancelJob(context.db,row.job_id,request.actor!.id);if(job?.state==='cancelled')await context.db.query("UPDATE terminal_sessions SET state='exited',ended_at=now(),metadata=metadata||'{\"not_dispatched\":true}'::jsonb WHERE id=$1 AND operation_id IS NULL",[row.id]);return {id:row.id,job_id:row.job_id,state:job?.state==='cancelled'?'exited':'cancelling',exit_confirmed:job?.state==='cancelled'||row.state==='exited'};});
 app.get('/workspace-terminals/:id/ws',{websocket:true,preValidation:async request=>{if(request.headers.origin!==context.config.origin)executionError('terminal_origin_denied',403);}},(socket,request)=>{
  let active=false,closed=false,offset=0,clientId=randomUUID(),terminal:any;let queue=Promise.resolve(),queuedFrames=0,queuedBytes=0;
  const send=async(value:unknown)=>{if(socket.readyState!==1)throw new Error('socket_closed');if(socket.bufferedAmount>1024*1024)throw new Error('terminal_output_backpressure');await new Promise<void>((resolve,reject)=>socket.send(JSON.stringify(value),error=>error?reject(error):resolve()));};
  const options=async()=>{const row=(await context.db.query(`SELECT t.machine_id,j.id,j.fence,j.lease_owner,j.workspace_id,j.payload,s.id AS session_valid FROM terminal_sessions t JOIN jobs j ON j.id=t.job_id JOIN sessions s ON s.id=t.auth_session_id AND s.revoked_at IS NULL AND s.expires_at>now() WHERE t.id=$1 AND t.owner_id=$2 AND t.auth_session_id=$3 AND t.active_connection_id=$4`,[terminal.id,request.actor!.id,request.sessionId,clientId])).rows[0];if(!row?.session_valid)executionError('terminal_connection_revoked',403);const currentScope=await captureExecution(context,request.actor!,row.payload.execution_context,row.payload.grant.id,['workspace.terminal','run_command']);if(currentScope.machine_identity_generations[row.machine_id]!==expectedMachineGeneration({payload:row.payload},row.machine_id))executionError('machine_generation_changed',403);if(!row.lease_owner)executionError('terminal_worker_reconnecting');return {machine:row.machine_id,options:{expectedMachineGeneration:expectedMachineGeneration({payload:row.payload},row.machine_id),ownerId:request.actor!.id,timeoutMs:2500,scopeGrantId:row.payload.grant.id,scopeTool:'workspace.terminal',jobGuard:{terminal_client_id:clientId,job_id:row.id,fence:row.fence,lease_owner:row.lease_owner,workspace_id:row.workspace_id}}};};
  const rpc=async(method:'GET'|'POST',path:string,body?:any,requestId?:string)=>{if(!context.agentBroker)executionError('agent_transport_unavailable',503);const current=await options();return context.agentBroker.rpc(current.machine,method,path,body,{...current.options,...(requestId?{requestId}:{})});};
  const output=async(response:any)=>{await options();const record=response.record??response;if(record?.id!==terminal.id)throw new Error('terminal_receipt_identity_mismatch');if(response.data!==undefined){if(typeof response.data!=='string'||!Number.isSafeInteger(response.offset)||!Number.isSafeInteger(response.next_offset)||response.offset<0||response.next_offset<response.offset)throw new Error('invalid_terminal_output');const bytes=Buffer.from(response.data,'base64');if(bytes.length>65536||response.next_offset-response.offset!==bytes.length)throw new Error('invalid_terminal_output');await send({type:'output',data:response.data,offset:response.offset,next_offset:response.next_offset,truncated:response.truncated===true});offset=response.next_offset;}
   await send({type:'status',id:terminal.id,job_id:terminal.job_id,state:record.state,record});if(record.state==='exited'||record.state==='outcome_unknown')socket.close(1000,'Terminal ended');};
  const handshake=setTimeout(()=>socket.close(1008,'Attach required'),10000);
  socket.on('message',raw=>{const size=Array.isArray(raw)?raw.reduce((sum,b)=>sum+b.length,0):raw instanceof ArrayBuffer?raw.byteLength:raw.length;
   if(size>100000){socket.close(1009,'Terminal frame limit');return;}if(closed||queuedFrames>=8||queuedBytes+size>256*1024){socket.close(1013,'Terminal input backpressure');return;}queuedFrames++;queuedBytes+=size;
   queue=queue.then(async()=>{
   if(closed)return;const rawBytes=Array.isArray(raw)?Buffer.concat(raw):Buffer.from(raw as ArrayBuffer);let message:any;try{message=JSON.parse(rawBytes.toString());}catch{throw new Error('invalid_terminal_frame');}
   if(!active){const attach=z.object({type:z.literal('attach'),ticket:z.string().max(100),csrf_token:z.string().max(100),after:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)}).strict().parse(message);terminal=await owned(request);
    const consumed=await context.db.query(`UPDATE terminal_tickets t SET consumed_at=now() FROM sessions s WHERE t.terminal_id=$1 AND t.auth_session_id=$2 AND t.token_hash=$3 AND t.consumed_at IS NULL AND t.expires_at>now() AND s.id=t.auth_session_id AND s.user_id=$4 AND s.csrf_token=$5 AND s.revoked_at IS NULL AND s.expires_at>now() RETURNING t.id`,[terminal.id,request.sessionId,hash(attach.ticket),request.actor!.id,attach.csrf_token]);if(!consumed.rowCount)executionError('terminal_ticket_denied',403);
    await context.db.query('UPDATE terminal_sessions SET active_connection_id=$2,updated_at=now() WHERE id=$1 AND auth_session_id=$3',[terminal.id,clientId,request.sessionId]);offset=attach.after;active=true;clearTimeout(handshake);
    // Host launch may still be queued. Polling retries attach to the same native invocation only.
    void(async()=>{let attached=false;while(!closed){try{if(!attached){await output(await rpc('POST',`/v1/terminals/${terminal.id}/attach`,{client_id:clientId,after:offset,max:65536}));attached=true;}else await output(await rpc('GET',`/v1/terminals/${terminal.id}?after=${offset}&max=65536`));}catch(error){const code=(error as {code?:string}).code??'terminal_transport_unavailable';if(((error as any).statusCode===403||['terminal_connection_revoked','grant_revoked','grant_expired','profile_tool_denied'].includes(code))){socket.close(1008,code);break;}await send({type:'error',code,reconnecting:true}).catch(()=>undefined);}await sleep();}})().catch(()=>socket.close(1011,'Terminal transport unavailable'));return;
   }
   if(message.type==='detach'){socket.close(1000,'Detached; host grace applies');return;}
   const frame=z.discriminatedUnion('type',[z.object({type:z.literal('input'),id, data:z.string().max(87384)}).strict(),z.object({type:z.literal('resize'),id,...dimensions}).strict()]).parse(message);
   if(frame.type==='input'){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)||Buffer.from(frame.data,'base64').length>65536)throw new Error('invalid_terminal_input');await rpc('POST',`/v1/terminals/${terminal.id}/input`,{client_id:clientId,data:frame.data},frame.id);}else await rpc('POST',`/v1/terminals/${terminal.id}/resize`,{client_id:clientId,cols:frame.cols,rows:frame.rows},frame.id);
   await send({type:`${frame.type}.ack`,id:frame.id,accepted:true});
  }).catch(async error=>{await send({type:'error',code:(error as any).code??(error as Error).message,outcome_unknown:(error as any).outcomeUnknown===true}).catch(()=>undefined);if(!active)socket.close(1008,'Terminal attach denied');}).finally(()=>{queuedFrames--;queuedBytes-=size;});});
  socket.on('close',()=>{closed=true;clearTimeout(handshake);if(!active)return;void(async()=>{try{await rpc('POST',`/v1/terminals/${terminal.id}/detach`,{client_id:clientId});}catch{}finally{await context.db.query('UPDATE terminal_sessions SET active_connection_id=NULL WHERE id=$1 AND active_connection_id=$2',[terminal.id,clientId]);}})().catch(()=>undefined);});
 });
}






