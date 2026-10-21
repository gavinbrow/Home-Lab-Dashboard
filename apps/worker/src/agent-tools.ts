import { randomUUID } from 'node:crypto';
import type { Workspace,PolicyGrant } from '@homelab/contracts';
import { authorize } from '@homelab/policy';
import { HostRpcError,type AgentBroker } from '@homelab/transport';
import { sha256,type WorkspaceFileAdapter,type BlobStore } from '@homelab/storage';
import { resolveAuthorizedAction } from '@homelab/actions';
import { createActionHandler } from '@homelab/actions/handler';
import { transaction,assertOwnedLease,LeaseLostError } from './database.js';
import { appendEventInTransaction } from './queue.js';
import { digest } from './hash.js';
import {expectedMachineGeneration} from './authority.js';
import { agentToolPermissions,agentToolSchemas,type AgentDependencies,type AgentToolResult } from './agent.js';
import type { JobRow } from './types.js';
import type { RuntimeContext } from './runtime.js';
import type { createOperationExecutor,OperationDependencies } from './operations.js';
async function fencedQuery(runtime:RuntimeContext,job:JobRow,sql:string,values:unknown[]){return transaction(runtime.db,async client=>{await assertOwnedLease(client,job);return client.query(sql,values);});}
export function createAgentTools(options:{broker:AgentBroker;files:WorkspaceFileAdapter;scopedFiles?:(job:JobRow,runtime:RuntimeContext,tool:string)=>WorkspaceFileAdapter;store:BlobStore;operations:ReturnType<typeof createOperationExecutor>;checkpoint:AgentDependencies['checkpoint'];publishChanges?:OperationDependencies['publishChanges']}):AgentDependencies['executeTool']{
 const authorizeTool=async(job:JobRow,runtime:RuntimeContext,tool:string)=>{
  const c=job.context!;const captured=job.payload.grant as PolicyGrant;const current=(await runtime.db.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2',[captured.id,job.requester_id])).rows[0];const decision=authorize({actor:{id:job.requester_id,role:'owner'},tool,machine_id:c.execution_machine_id,workspace_id:c.workspace_id,profile_id:c.profile_id,grant:captured,current_grant:current});if(!decision.allowed)throw new Error(decision.code);
 };
 // Each invocation receives its own context; no mutable shared per-job state is retained.

 const execute:AgentDependencies['executeTool']=async(job,runtime,step):Promise<AgentToolResult>=>{
  const call=step.call,args=call.arguments as Record<string,any>,context=job.context!;
  const existing=(await runtime.db.query('SELECT * FROM operations WHERE job_id=$1 AND step_id=$2',[job.id,step.id])).rows[0];
  if(['list_files','read_file','write_file','apply_patch','verify_file','publish_artifact'].includes(call.name)&&(!existing||['preparing','pending_dispatch'].includes(existing.status))){const checked=agentToolSchemas[call.name as keyof typeof agentToolSchemas].safeParse(args);if(!checked.success){if(existing)await fencedQuery(runtime,job,"UPDATE operations SET status='rejected',outcome=COALESCE(outcome,'{}'::jsonb)||$2::jsonb WHERE id=$1",[existing.id,JSON.stringify({reason:'invalid_tool_arguments',effects_started:false})]);return {state:'completed',content:{error:'invalid_tool_arguments',reason:checked.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0,2000),executed:false}};}}
  const ws=(await runtime.db.query<Workspace>('SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2',[context.workspace_id,job.requester_id])).rows[0];
  if(!ws||ws.state!=='active'||ws.machine_id!==context.execution_machine_id||ws.revision!==context.workspace_revision||ws.environment_id!==context.environment_id||ws.environment_generation!==context.environment_generation)throw new Error('workspace_revision_conflict');
  ws.quota_bytes=Number(ws.quota_bytes);
  const permission=agentToolPermissions[call.name as keyof typeof agentToolPermissions];
  const files=options.scopedFiles?.(job,runtime,permission)??options.files;

  if(job.recovery_only&&(!existing||['preparing','pending_dispatch'].includes(existing.status)))return {state:'pending',reason:'capacity_recovery_only'};
  if(!existing){if(await runtime.cancelled())return {state:'pending',reason:'cancellation_at_safe_boundary'};if(Date.now()-(job.started_at?.getTime()??Date.now())>=context.limits.wall_time_seconds*1000)throw new Error('job_wall_time_limit');await authorizeTool(job,runtime,permission);}
  if(call.name==='run_command'||call.name==='verify_command'){
   const result=await options.operations.executeCommand(job,runtime,{step_id:step.id,command:args as {executable:string;args:string[]},tool:'run_command',grant:job.payload.grant as PolicyGrant,context,mutating:true,verification:call.name==='verify_command'});
   if(result.state==='pending')return result;if(result.state==='unknown')return {state:'interrupted',reason:result.reason};
   return {state:'completed',content:result,...(call.name==='verify_command'?{verification:{kind:`command:${digest(args)}`,passed:result.status==='succeeded'&&result.exit_code===0,evidence:{operation_id:result.operation_id,exit_code:result.exit_code,command:args}}}:{})};
  }
  if(call.name==='write_file'||call.name==='apply_patch'){
   let op=existing;
   if(!op){
    let content=String(args.content??'');
    if(call.name==='apply_patch'){const before=Buffer.from(await files.read(ws,args.path));if(sha256(before)!==args.expected_sha256) return {state:'completed',content:{error:'content_conflict'}};const current=before.toString('utf8');if(!args.before||current.split(args.before).length!==2)return {state:'completed',content:{error:'patch_requires_exactly_one_match'}};content=current.replace(args.before,args.after);}
    const bytes=Buffer.from(content);if(bytes.length>(context.limits.max_generated_file_bytes??Math.min(context.limits.max_output_bytes,1024*1024)))throw new Error('generated_file_limit');
    const operationId=randomUUID();const request={operation_id:operationId,path:args.path,content_base64:bytes.toString('base64'),expected_sha256:args.expected_sha256,grant_id:(job.payload.grant as PolicyGrant).id};
    await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);const generated=(await client.query("SELECT COALESCE(sum(octet_length(decode(request->>'content_base64','base64'))),0)::text AS total FROM operations WHERE job_id=$1 AND request ? 'content_base64'",[job.id])).rows[0];const maximum=context.limits.max_generated_file_bytes??Math.min(context.limits.max_output_bytes,1024*1024);if(BigInt(generated.total)+BigInt(bytes.length)>BigInt(maximum))throw new Error('job_generated_file_budget_exhausted');await appendEventInTransaction(client,job.id,'generated_file.reserved',{operation_id:operationId,bytes:bytes.length,cumulative_bytes:Number(generated.total)+bytes.length,limit_bytes:maximum,scope:'prepared_file_content'});await client.query("INSERT INTO operations(id,job_id,step_id,request_hash,request,machine_id,fence,status,replay_class) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,'preparing','mutating')",[operationId,job.id,step.id,digest(request),JSON.stringify(request),ws.machine_id,job.fence]);await client.query('UPDATE workspace_locks SET operation_id=$2 WHERE job_id=$1',[job.id,operationId]);});op=(await runtime.db.query('SELECT * FROM operations WHERE id=$1',[operationId])).rows[0];
   }
   if(op.status==='preparing'){
    await authorizeTool(job,runtime,'file.write');if(await runtime.cancelled()){await fencedQuery(runtime,job,"UPDATE operations SET status='cancelled' WHERE id=$1",[op.id]);return {state:'completed',content:{cancelled:true}};}
    const checkpoint=await options.checkpoint(job,runtime,`operation:${op.id}:before`);await runtime.assertLease();await fencedQuery(runtime,job,"UPDATE operations SET status='pending_dispatch',outcome=$2::jsonb WHERE id=$1",[op.id,JSON.stringify({before_checkpoint:checkpoint})]);op.status='pending_dispatch';
   }
   let receipt:any=op.receipt;
   if(op.status==='dispatching'){
    const admission=(await runtime.db.query('SELECT delivery_count,response_body FROM agent_rpc_requests WHERE id=$1',[op.id])).rows[0];
    if(admission?.delivery_count===0&&admission.response_body?.never_delivered===true&&admission.response_body?.effects_started===false){const cancelled=await runtime.cancelled();await fencedQuery(runtime,job,'UPDATE operations SET status=$2,outcome=COALESCE(outcome,\'{}\'::jsonb)||$3::jsonb WHERE id=$1',[op.id,cancelled?'cancelled':'rejected',JSON.stringify(admission.response_body)]);return {state:'completed',content:{operation_id:op.id,cancelled,error:admission.response_body.error?.code,never_delivered:true}};}
   }
   if(op.status==='pending_dispatch'){
    if(Date.now()-(job.started_at?.getTime()??Date.now())>=context.limits.wall_time_seconds*1000){await fencedQuery(runtime,job,"UPDATE operations SET status='failed',outcome='{\"reason\":\"job_wall_time_limit\"}' WHERE id=$1",[op.id]);return {state:'completed',content:{error:'job_wall_time_limit'}};}
    await authorizeTool(job,runtime,'file.write');if(await runtime.cancelled()){await fencedQuery(runtime,job,"UPDATE operations SET status='cancelled' WHERE id=$1",[op.id]);return {state:'completed',content:{cancelled:true}};}
    await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);await client.query("UPDATE operations SET status='dispatching' WHERE id=$1",[op.id]);await client.query("INSERT INTO dispatch_outbox(job_id,operation_id,kind,payload) VALUES($1,$2,'file_mutation',$3::jsonb)",[job.id,op.id,JSON.stringify(op.request)]);});
    try{receipt=await options.broker.rpc(ws.machine_id,'PUT',`/v1/workspaces/${ws.id}/files`,op.request,{expectedMachineGeneration:expectedMachineGeneration(job,ws.machine_id),requestId:op.id,ownerId:job.requester_id,timeoutMs:2000,signal:runtime.signal,scopeGrantId:op.request.grant_id,scopeTool:'file.write',jobGuard:{job_id:job.id,fence:job.fence,lease_owner:job.lease_owner??undefined,workspace_id:ws.id}});}catch(error){if(error instanceof HostRpcError){const enqueued=await runtime.db.query('SELECT id FROM agent_rpc_requests WHERE id=$1',[op.id]);if(!enqueued.rowCount)await fencedQuery(runtime,job,"UPDATE operations SET status='pending_dispatch' WHERE id=$1",[op.id]);if(!error.outcomeUnknown&&['file_conflict','invalid_path','path_denied','workspace_write_denied','workspace_denied','invalid_request','grant_revoked','scope_denied','worker_fenced','writer_fenced'].includes(error.code)){if(error.code==='worker_fenced'||error.code==='writer_fenced')throw new LeaseLostError();await fencedQuery(runtime,job,"UPDATE operations SET status='rejected',outcome=$2::jsonb WHERE id=$1",[op.id,JSON.stringify({reason:error.code})]);return {state:'completed',content:{operation_id:op.id,error:error.code,message:error.message.slice(0,1000),executed:false}};}return {state:'pending',reason:error.code};}throw error;}
   }else if(op.status==='dispatching'){
    try{receipt=await options.broker.rpc(ws.machine_id,'GET',`/v1/workspaces/${ws.id}/file-operations/${op.id}`,null,{expectedMachineGeneration:expectedMachineGeneration(job,ws.machine_id),ownerId:job.requester_id,timeoutMs:2000,signal:runtime.signal});}catch(error){if(error instanceof HostRpcError)return {state:'pending',reason:'file_mutation_reconciliation_required'};throw error;}
   }
   if(receipt){
    if(receipt.operation_id&&receipt.operation_id!==op.id)throw new Error('file_receipt_identity_mismatch');
    if(['outcome_unknown','received'].includes(receipt.state)){await fencedQuery(runtime,job,"UPDATE operations SET status='outcome_unknown',receipt=$2::jsonb WHERE id=$1",[op.id,JSON.stringify(receipt)]);return {state:'interrupted',reason:'file_mutation_outcome_unknown'};}
    if(receipt.state==='conflict'||receipt.state==='failed'){await fencedQuery(runtime,job,"UPDATE operations SET status='failed',receipt=$2::jsonb WHERE id=$1",[op.id,JSON.stringify(receipt)]);return {state:'completed',content:{operation_id:op.id,error:receipt.error??receipt.reason??'file_conflict'}};}
    const result=receipt.result??receipt;if(result.sha256!==sha256(Buffer.from(op.request.content_base64,'base64')))throw new Error('file_mutation_result_hash_unknown');
    await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);await client.query("UPDATE operations SET status='succeeded',receipt=$2::jsonb WHERE id=$1",[op.id,JSON.stringify(receipt)]);await client.query("UPDATE dispatch_outbox SET delivered_at=now() WHERE operation_id=$1 AND kind='file_mutation'",[op.id]);await appendEventInTransaction(client,job.id,'file.changed',{operation_id:op.id,path:op.request.path,before_hash:op.request.expected_sha256,after_hash:result.sha256,size_bytes:result.size_bytes});});
    const after=await options.checkpoint(job,runtime,`operation:${op.id}:after`);
    const before=(await runtime.db.query('SELECT outcome FROM operations WHERE id=$1',[op.id])).rows[0]?.outcome?.before_checkpoint;
    const changes=options.publishChanges&&before?await options.publishChanges(job,runtime,op.id,before,after):undefined;
    if(!changes)await fencedQuery(runtime,job,'INSERT INTO file_changes(id,workspace_id,job_id,operation_id,path,before_hash,after_hash,kind,details) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb WHERE NOT EXISTS(SELECT 1 FROM file_changes WHERE operation_id=$4)',[randomUUID(),ws.id,job.id,op.id,op.request.path,op.request.expected_sha256,result.sha256,op.request.expected_sha256?'modified':'added',JSON.stringify({after_checkpoint:after})]);
    await fencedQuery(runtime,job,"UPDATE operations SET outcome=COALESCE(outcome,'{}'::jsonb)||$2::jsonb WHERE id=$1",[op.id,JSON.stringify({after_checkpoint:after,file_changes:changes})]);
    return {state:'completed',content:{operation_id:op.id,path:op.request.path,sha256:result.sha256,size_bytes:result.size_bytes,after_checkpoint:after,file_changes:changes}};
   }
   if(op.status==='cancelled')return {state:'completed',content:{cancelled:true}};
   return {state:'pending',reason:'file_mutation_pending'};
  }
  if(call.name==='list_files')return {state:'completed',content:await files.list(ws,String(args.path??''))};
  if(call.name==='read_file'){const bytes=Buffer.from(await files.read(ws,args.path));if(bytes.length>1024*1024)throw new Error('tool_read_limit');return {state:'completed',content:{path:args.path,text:bytes.toString('utf8'),sha256:sha256(bytes),size_bytes:bytes.length}};}
  if(call.name==='verify_file'){const bytes=Buffer.from(await files.read(ws,args.path)),hash=sha256(bytes);return {state:'completed',content:{path:args.path,sha256:hash,size_bytes:bytes.length},verification:{kind:`file:${args.path}`,passed:args.sha256===undefined||args.sha256===hash,evidence:{path:args.path,sha256:hash,expected_sha256:args.sha256??null,size_bytes:bytes.length}}};}
  if(call.name==='inspect_machine'){const machine=(await runtime.db.query('SELECT id,name,os,hostname,capabilities,updated_at FROM machines WHERE id=$1 AND owner_id=$2',[ws.machine_id,job.requester_id])).rows[0];return {state:'completed',content:{machine,source:'persisted_observation',observed_at:machine.updated_at}};}
  if(call.name==='publish_artifact'){
   const previous=(await runtime.db.query('SELECT id,sha256,size_bytes FROM artifacts WHERE job_id=$1 AND relative_path=$2 ORDER BY created_at LIMIT 1',[job.id,args.path])).rows[0];if(previous)return {state:'completed',content:previous,artifacts:[previous.id]};
   const bytes=await files.read(ws,args.path),blob=await options.store.put(bytes),artifactId=randomUUID();await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);await client.query('INSERT INTO artifacts(id,owner_id,workspace_id,job_id,relative_path,sha256,size_bytes,mime_type,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6)',[artifactId,job.requester_id,ws.id,job.id,args.path,blob.hash,blob.size,args.mime_type]);await appendEventInTransaction(client,job.id,'artifact.retained',{id:artifactId,path:args.path,sha256:blob.hash,size_bytes:blob.size});});return {state:'completed',content:{id:artifactId,sha256:blob.hash,size_bytes:blob.size},artifacts:[artifactId]};
  }
  if(call.name==='run_saved_action'){
   const actionStep=(await runtime.db.query('SELECT request FROM job_steps WHERE id=$1',[step.id])).rows[0];
   const captured=actionStep.request.resolved_action??await resolveAuthorizedAction(runtime.db,job.requester_id,args.action_id,{revision:args.revision,machine_id:ws.machine_id,workspace_id:ws.id,profile_id:context.profile_id,execution_identity_id:context.execution_identity_id,grant_id:(job.payload.grant as PolicyGrant).id,parameters:args.parameters,idempotency_key:step.id});
   if(!actionStep.request.resolved_action)await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);await client.query("UPDATE job_steps SET request=jsonb_set(request,'{resolved_action}',$2::jsonb) WHERE id=$1",[step.id,JSON.stringify(captured)]);});
   let outcome:AgentToolResult|undefined;
   const nestedRuntime:RuntimeContext={...runtime,complete:async result=>{outcome={state:'completed',content:result};},fail:async reason=>{outcome={state:'completed',content:{error:reason}};},wait:async reason=>{outcome={state:'pending',reason};},interrupt:async reason=>{outcome={state:'interrupted',reason};},cancel:async reason=>{outcome={state:'completed',content:{cancelled:true,reason}};}};
   const actionOps={executeCommand:(j:JobRow,r:RuntimeContext,input:any)=>options.operations.executeCommand(j,r,{...input,step_id:`${step.id}:${input.step_id}`}),executeControl:(j:JobRow,r:RuntimeContext,input:any)=>options.operations.executeControl(j,r,{...input,step_id:`${step.id}:${input.step_id}`})};
   await createActionHandler(actionOps)({...job,kind:'saved_action',payload:captured},nestedRuntime);return outcome??{state:'pending',reason:'saved_action_pending'};
  }
  throw new Error('unsupported_agent_tool');
 };
 return async(job,runtime,step)=>{try{return await execute(job,runtime,step);}catch(error){
  if(error instanceof HostRpcError&&!error.outcomeUnknown&&error.statusCode>=400&&error.statusCode<500&&['read_file','list_files','verify_file','publish_artifact'].includes(step.call.name)){
   const target=String(step.call.arguments.path??'');const content={error:error.code,message:error.message.slice(0,1000),path:target,executed:false};
   return {state:'completed',content,...(step.call.name==='verify_file'?{verification:{kind:`file:${target}`,passed:false,evidence:content}}:{})};
  }
  throw error;
 }};
}




