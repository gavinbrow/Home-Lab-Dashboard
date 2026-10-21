import { createHash,createPrivateKey,createPublicKey,randomUUID,sign,verify,type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool,PoolClient } from 'pg';
import {ProfileDefinitionSchema,type JsonValue} from '@homelab/contracts';
export type RpcMethod='GET'|'POST'|'PUT'|'DELETE';
export interface AgentRpcRequest {machine_identity_generation?:string;schema_version:1;id:string;machine_id:string;method:RpcMethod;path:string;body:JsonValue;created_at:string;expires_at:string;dispatch_epoch:string;authorization:{key_id:string;signature:string};}
export type RpcOptions={expectedMachineGeneration?:string;requestId?:string;timeoutMs?:number;expiresInMs?:number;ownerId?:string;signal?:AbortSignal;recoveryRead?:boolean;recoveryResolution?:{review_id:string;owner_id:string};safetyCancellation?:boolean;maintenanceCapture?:boolean;scopeGrantId?:string;scopeTool?:string;workspaceGuard?:{workspace_id:string;lock_owner:string;workspace_revision:number};jobGuard?:{job_id:string;fence:string|number;workspace_id?:string|null;lease_owner?:string;terminal_client_id?:string}};
export interface DispatchSigner {keyId:string;privateKeyPem:string;}
export function canonicalJson(value:unknown):string {
 const normalize=(item:unknown):unknown=>{
  if(item===null||typeof item==='string'||typeof item==='boolean')return item;
  if(typeof item==='number'){if(!Number.isFinite(item))throw new Error('non_finite_json');return item;}
  if(Array.isArray(item))return item.map(normalize);
  if(typeof item==='object'&&Object.getPrototypeOf(item)===Object.prototype){const out:Record<string,unknown>=Object.create(null);for(const key of Object.keys(item as object).sort()){const v=(item as Record<string,unknown>)[key];if(v===undefined)throw new Error('undefined_json');out[key]=normalize(v);}return out;}
  throw new Error('invalid_json_value');
 };
 return JSON.stringify(normalize(value)).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}
export const rpcDigest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Run inside the machine identity replacement/revocation transaction. Never delete evidence. */
export async function quarantineMachineRequests(client:PoolClient,machineId:string){
 await client.query("UPDATE agent_rpc_requests SET state=CASE WHEN delivery_count>0 THEN 'outcome_unknown' ELSE 'expired' END,lease_until=NULL WHERE machine_id=$1 AND state IN ('queued','leased')",[machineId]);
}
export class HostRpcError extends Error {
 constructor(public code:string,message:string,public requestId:string,public statusCode=503,public outcomeUnknown=false){super(message);}
}
export function loadDispatchSigner(env:NodeJS.ProcessEnv=process.env):DispatchSigner|null{
 const file=env.DISPATCH_SIGNING_KEY_FILE,keyId=env.DISPATCH_SIGNING_KEY_ID;
 if(!file&&!keyId)return null;
 if(!file||!keyId||!/^[A-Za-z0-9._-]{1,100}$/.test(keyId))throw new Error('Invalid dispatch signing key configuration');
 const privateKeyPem=readFileSync(file,'utf8'),key=createPrivateKey(privateKeyPem);
 if(key.asymmetricKeyType!=='ed25519')throw new Error('Dispatch signing key must be Ed25519');
 return {keyId,privateKeyPem};
}
export function publicDispatchKey(signer:DispatchSigner){return {key_id:signer.keyId,public_key_pem:createPublicKey(signer.privateKeyPem).export({type:'spki',format:'pem'}).toString()};}
export function signRpc(request:Omit<AgentRpcRequest,'authorization'>,signer:DispatchSigner):AgentRpcRequest{
 const signature=sign(null,Buffer.from(canonicalJson(request)),createPrivateKey(signer.privateKeyPem)).toString('base64');
 return {...request,authorization:{key_id:signer.keyId,signature}};
}
export function verifyRpc(request:AgentRpcRequest,keyId:string,publicKey:string|KeyObject,now=Date.now()):boolean{
 try{
  const {authorization,...content}=request;
  if(authorization.key_id!==keyId||request.schema_version!==1||!Number.isFinite(Date.parse(request.expires_at))||Date.parse(request.expires_at)<=now)return false;
  const key=typeof publicKey==='string'?createPublicKey(publicKey):publicKey;
  if(key.asymmetricKeyType!=='ed25519')return false;
  return verify(null,Buffer.from(canonicalJson(content)),key,Buffer.from(authorization.signature,'base64'));
 }catch{return false;}
}
export function validateRpcRoute(method:RpcMethod,path:string){
 if(!['GET','POST','PUT','DELETE'].includes(method)||path.length>8192||!path.startsWith('/v1/')||path.includes('#'))throw new Error('rpc_route_denied');
 const url=new URL(path,'http://supervisor.invalid');
 if(url.origin!=='http://supervisor.invalid'||decodeURIComponent(path.split('?')[0]!).split('/').some(s=>s==='..'||s==='.')||!/^\/v1\/(health|operations|workspaces|roots|identities|targets|containers|services|rpc-receipts|backup|journal|terminals|host-state)(\/|$)/.test(url.pathname))throw new Error('rpc_route_denied');
}
const uuidPattern='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export function validateRecoveryRead(method:RpcMethod,path:string,body:unknown){
 if(method!=='GET'||body!=null||!(path==='/v1/health'||new RegExp(`^/v1/(operations|rpc-receipts)/${uuidPattern}$`).test(path)||new RegExp(`^/v1/workspaces/${uuidPattern}/(binding|manifest|recovery-manifest)$`).test(path)||new RegExp(`^/v1/targets/${uuidPattern}/actions/${uuidPattern}$`).test(path)||new RegExp(`^/v1/workspaces/${uuidPattern}/file-operations/${uuidPattern}$`).test(path)))throw new Error('recovery_rpc_denied');
}
export function validateSafetyCancel(method:RpcMethod,path:string){if(method!=='POST'||!(new RegExp(`^/v1/operations/${uuidPattern}/cancel$`).test(path)||new RegExp(`^/v1/terminals/${uuidPattern}/cancel$`).test(path)||new RegExp(`^/v1/targets/${uuidPattern}/actions/${uuidPattern}/cancel$`).test(path)))throw new Error('safety_rpc_denied');}
export function validateRecoveryResolution(method:RpcMethod,path:string,body:unknown){
 const record=body as Record<string,unknown>|null;
 const match=new RegExp(`^/v1/workspaces/(${uuidPattern})/file-operations/(${uuidPattern})/reconcile$`).exec(path);
 if(method!=='POST'||!match||!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).sort().join(',')!=='expected_manifest_hash,grant_id,policy_revision,reason,resolution,resolution_id'||typeof record.expected_manifest_hash!=='string'||!/^[a-f0-9]{64}$/.test(record.expected_manifest_hash)||typeof record.grant_id!=='string'||record.grant_id.length<1||record.grant_id.length>200||!Number.isSafeInteger(record.policy_revision)||(record.policy_revision as number)<1||record.resolution!=='accept_partial'||typeof record.reason!=='string'||record.reason.trim().length<8||record.reason.length>4096||typeof record.resolution_id!=='string'||!new RegExp(`^${uuidPattern}$`).test(record.resolution_id))throw new Error('recovery_resolution_denied');
 return {workspace_id:match[1]!,original_operation_id:match[2]!,record};
}
function validateMaintenanceCapture(method:RpcMethod,path:string,body:unknown){
 const record=body as Record<string,unknown>|null;
 const keys=record&&typeof record==='object'&&!Array.isArray(record)?Object.keys(record).sort():[];
 const uuid=new RegExp(`^${uuidPattern}$`);
 const fileCapture=path==='/v1/backup'&&keys.join(',')==='operation_id,workspace_id'&&typeof record?.workspace_id==='string'&&uuid.test(record.workspace_id);
 const journalCapture=path==='/v1/journal/backup'&&keys.join(',')==='operation_id';
 const captureRoute=new RegExp(`^/v1/host-state/captures/${uuidPattern}$`);
 const create=path==='/v1/host-state/captures'&&method==='POST'&&keys.join(',')==='backup_set_id,grant_id,operation_id,policy_revision'&&typeof record?.operation_id==='string'&&uuid.test(record.operation_id)&&typeof record?.backup_set_id==='string'&&uuid.test(record.backup_set_id)&&typeof record?.grant_id==='string'&&record.grant_id.length>0&&record.grant_id.length<=200&&Number.isSafeInteger(record.policy_revision)&&(record.policy_revision as number)>0;
 const ack=new RegExp(`^/v1/host-state/captures/${uuidPattern}/ack$`).test(path)&&method==='POST'&&keys.join(',')==='sha256'&&typeof record?.sha256==='string'&&/^[a-f0-9]{64}$/.test(record.sha256);
 const remove=captureRoute.test(path)&&method==='DELETE'&&body==null;
 if(create||ack||remove)return;
 if(method!=='POST'||!(fileCapture||journalCapture)||typeof record?.operation_id!=='string'||!uuid.test(record.operation_id))throw new Error('maintenance_capture_denied');
}
type RpcRow={id:string;machine_id:string;request_hash:string;method:RpcMethod;path:string;body:JsonValue;authorization_json:AgentRpcRequest['authorization'];created_at:Date;expires_at:Date;dispatch_epoch:string;state:string;response_status:number|null;response_body:JsonValue;response_hash:string|null;delivery_count:number;recovery_read:boolean;safety_cancel:boolean;maintenance_capture:boolean;job_guard:RpcOptions['jobGuard']|null;workspace_guard:RpcOptions['workspaceGuard']|null;scope_grant_id:string|null;scope_tool:string|null;recovery_resolution:RpcOptions['recoveryResolution']|null;machine_identity_generation:string|null;sensitive_payload:boolean;payload_expires_at:Date|null;payload_scrubbed_at:Date|null};
export class AgentBroker {
 readonly signer:DispatchSigner|null;
 constructor(readonly db:Pool,options:{signer?:DispatchSigner|null}={}){this.signer=options.signer===undefined?loadDispatchSigner():options.signer;}
 async enqueue(machineId:string,method:RpcMethod,path:string,body:unknown=null,options:RpcOptions={}):Promise<string>{
  validateRpcRoute(method,path);
  if(!this.signer)throw new HostRpcError('dispatch_key_unconfigured','Dispatch signing key is not configured',options.requestId||'');
  const serialized=canonicalJson(body??null);if(Buffer.byteLength(serialized)>96*1024*1024)throw new Error('rpc_request_too_large');
  const id=options.requestId??randomUUID();
  if(options.recoveryRead)validateRecoveryRead(method,path,body);
  if(options.recoveryResolution){validateRecoveryResolution(method,path,body);if(options.recoveryRead||options.safetyCancellation||options.maintenanceCapture||!options.workspaceGuard||!options.scopeGrantId||options.scopeTool!=='workspace.reconcile')throw new Error('recovery_resolution_denied');}
  if(options.safetyCancellation)validateSafetyCancel(method,path);
  if(options.maintenanceCapture)validateMaintenanceCapture(method,path,body);
  const control=(await this.db.query('SELECT dispatch_epoch,dispatch_enabled,restore_mode,maintenance_mode FROM runtime_control WHERE singleton=true')).rows[0];
  const restoring=control?.restore_mode||process.env.RESTORE_MODE==='true';
  if(!control||(restoring&&!options.recoveryRead&&!options.recoveryResolution)||(method!=='GET'&&!options.safetyCancellation&&!options.maintenanceCapture&&!options.recoveryResolution&&(control.maintenance_mode||!control.dispatch_enabled||process.env.DISPATCH_ENABLED!=='true')))throw new HostRpcError('dispatch_disabled','Remote mutation or restored relay is disabled',id,503);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('invalid_rpc_id');
  const machine=await this.db.query('SELECT id,identity_generation,EXISTS(SELECT 1 FROM agent_certificates WHERE machine_id=machines.id) AS has_enrollment FROM machines WHERE id=$1'+(options.ownerId?' AND owner_id=$2':''),options.ownerId?[machineId,options.ownerId]:[machineId]);
  if(!machine.rowCount)throw new HostRpcError('machine_not_found','Enrolled machine is unavailable',id,404);
  let generation=options.expectedMachineGeneration??null;
  if(options.jobGuard){const job=(await this.db.query('SELECT payload FROM jobs WHERE id=$1',[options.jobGuard.job_id])).rows[0];const captured=job?.payload?.machine_identity_generations?.[machineId];if((captured&&generation&&captured!==generation)||(!captured&&machine.rows[0].has_enrollment))throw new HostRpcError('machine_generation_uncaptured','The original job has no matching installation snapshot',id,409);generation=captured??generation;}
  if((!generation&&machine.rows[0].has_enrollment)||(generation&&generation!==machine.rows[0].identity_generation))throw new HostRpcError('machine_generation_changed','Machine installation changed; create a new authorized request',id,409);
  const bodyRecord=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,any>:null;
  const scopeGrantId=options.scopeGrantId??(options.maintenanceCapture?null:bodyRecord?.grant_id??bodyRecord?.grant?.id??null);
  if(scopeGrantId!==null&&!new RegExp(`^${uuidPattern}$`).test(scopeGrantId))throw new Error('invalid_scope_grant');
  if(options.recoveryResolution&&bodyRecord?.grant_id===scopeGrantId)throw new Error('recovery_grant_must_be_distinct');
  const scopeTool=options.scopeTool??(path==='/v1/operations'?'run_command':/^\/v1\/targets\//.test(path)?'actions.run':null);
  if(scopeTool!==null&&!/^[A-Za-z0-9._:-]{1,100}$/.test(scopeTool))throw new Error('invalid_scope_tool');
  const requestHash=rpcDigest({machine_id:machineId,method,path,body:body??null,recovery_read:!!options.recoveryRead,...(options.recoveryResolution?{recovery_resolution:options.recoveryResolution}:{}),...(generation?{machine_identity_generation:generation}:{}),safety_cancel:!!options.safetyCancellation,maintenance_capture:!!options.maintenanceCapture,scope_grant_id:scopeGrantId,scope_tool:scopeTool});
  const sensitive=/^\/v1\/terminals(?:\/|$)/.test(path);
  const now=new Date(),expires=new Date(now.getTime()+Math.min(options.expiresInMs??120000,sensitive?30000:86400000));
  const request=signRpc({...(generation?{machine_identity_generation:generation}:{}),schema_version:1,id,machine_id:machineId,method,path,body:(body??null)as JsonValue,created_at:now.toISOString(),expires_at:expires.toISOString(),dispatch_epoch:control.dispatch_epoch},this.signer);
  const client=await this.db.connect();
  try{
   await client.query('BEGIN');
   const latest=(await client.query('SELECT * FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
   if(!latest||latest.dispatch_epoch!==control.dispatch_epoch||((latest.restore_mode||process.env.RESTORE_MODE==='true')&&!options.recoveryRead&&!options.recoveryResolution)||(method!=='GET'&&!options.safetyCancellation&&!options.maintenanceCapture&&!options.recoveryResolution&&(latest.maintenance_mode||!latest.dispatch_enabled||process.env.DISPATCH_ENABLED!=='true')))throw new HostRpcError('dispatch_disabled','Dispatch epoch or recovery state changed',id,503);
   const currentMachine=(await client.query('SELECT identity_generation,EXISTS(SELECT 1 FROM agent_certificates WHERE machine_id=machines.id) AS has_enrollment FROM machines WHERE id=$1 FOR SHARE',[machineId])).rows[0];
   if(!currentMachine||(generation&&currentMachine.identity_generation!==generation)||(!generation&&currentMachine.has_enrollment))throw new HostRpcError('machine_generation_changed','Machine installation changed before durable enqueue',id,409);
   if(options.jobGuard){
    const guard=options.jobGuard;
    const job=(await client.query("SELECT id,payload FROM jobs WHERE id=$1 AND fence=$2 AND lease_until>now() AND dispatch_epoch=$3 AND ($4::text IS NULL OR lease_owner=$4) AND state IN ('running','cancelling') AND ($5 OR (cancel_requested=false AND state='running' AND reason IS DISTINCT FROM 'capacity_recovery_only')) FOR UPDATE",[guard.job_id,guard.fence,latest.dispatch_epoch,guard.lease_owner??null,method==='GET'||!!options.safetyCancellation])).rows[0];
    if(job?.payload?.machine_identity_generations?.[machineId]&&job.payload.machine_identity_generations[machineId]!==generation)throw new HostRpcError('machine_generation_changed','Captured job installation differs',id,409);
    if(!job)throw new HostRpcError('worker_fenced','Worker lease is no longer current',id,409);
    if(options.maintenanceCapture&&(!latest.maintenance_mode||latest.maintenance_job_id!==guard.job_id))throw new HostRpcError('maintenance_owner_mismatch','Backup no longer owns maintenance',id,409);
    if(guard.workspace_id&&!(await client.query('SELECT workspace_id FROM workspace_locks WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE',[guard.workspace_id,guard.job_id])).rowCount)throw new HostRpcError('writer_fenced','Workspace reservation is no longer current',id,409);
   }
   if(options.maintenanceCapture&&!options.jobGuard)throw new HostRpcError('maintenance_owner_mismatch','Backup capture requires its current worker lease',id,409);
   if(options.workspaceGuard){
    const guard=options.workspaceGuard;
    const lock=await client.query('SELECT l.workspace_id FROM workspace_locks l JOIN workspaces w ON w.id=l.workspace_id WHERE l.workspace_id=$1 AND l.lock_owner=$2 AND w.revision=$3 AND w.machine_id=$4 FOR UPDATE OF l',[guard.workspace_id,guard.lock_owner,guard.workspace_revision,machineId]);
    if(!lock.rowCount)throw new HostRpcError('writer_fenced','Workspace reservation changed before durable dispatch',id,409);
   }
   if(options.recoveryResolution)await this.checkRecoveryReview(client,{method,path,body:body as JsonValue,machine_id:machineId,workspace_guard:options.workspaceGuard!,recovery_resolution:options.recoveryResolution},id,true);
   const inserted=await client.query('INSERT INTO agent_rpc_requests(id,machine_id,request_hash,method,path,body,authorization_json,created_at,expires_at,dispatch_epoch,recovery_read,safety_cancel,maintenance_capture,job_guard,workspace_guard,scope_grant_id,scope_tool,recovery_resolution,machine_identity_generation,sensitive_payload,payload_expires_at)VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18::jsonb,$19,$20,$21)ON CONFLICT(id)DO NOTHING RETURNING id',[id,machineId,requestHash,method,path,serialized,JSON.stringify(request.authorization),now,expires,control.dispatch_epoch,!!options.recoveryRead,!!options.safetyCancellation,!!options.maintenanceCapture,options.jobGuard?JSON.stringify(options.jobGuard):null,options.workspaceGuard?JSON.stringify(options.workspaceGuard):null,scopeGrantId,scopeTool,options.recoveryResolution?JSON.stringify(options.recoveryResolution):null,generation,sensitive,sensitive?expires:null]);
   if(!inserted.rowCount){const previous=(await client.query('SELECT request_hash,dispatch_epoch,sensitive_payload FROM agent_rpc_requests WHERE id=$1',[id])).rows[0];if(previous?.sensitive_payload&&previous.request_hash?.startsWith('terminal-redacted:'))throw new HostRpcError('terminal_delivery_expired','Terminal delivery bytes were consumed or expired; this ID is never replayed',id,410);if(previous?.request_hash!==requestHash||previous?.dispatch_epoch!==control.dispatch_epoch)throw new HostRpcError('rpc_idempotency_conflict','RPC id reused with different request or restored epoch',id,409);}
   if(options.workspaceGuard)await client.query('UPDATE workspace_locks SET rpc_id=$3 WHERE workspace_id=$1 AND lock_owner=$2',[options.workspaceGuard.workspace_id,options.workspaceGuard.lock_owner,id]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return id;
 }
 async expireTerminalPayloads(forceClosed=false):Promise<number>{
  let total=0;
  for(let batch=0;batch<(forceClosed?64:1);batch++){
   const result=await this.db.query(`WITH expired AS(SELECT r.id FROM agent_rpc_requests r WHERE r.sensitive_payload=true AND r.payload_scrubbed_at IS NULL AND (r.payload_expires_at<=now() OR ($1 AND EXISTS(SELECT 1 FROM terminal_sessions t WHERE t.job_id=(r.job_guard->>'job_id')::uuid AND t.state='exited'))) ORDER BY r.payload_expires_at LIMIT 256 FOR UPDATE ${forceClosed?'':'SKIP LOCKED'}) UPDATE agent_rpc_requests r SET body='null'::jsonb,response_body='null'::jsonb,request_hash='terminal-redacted:'||r.id::text,response_hash=CASE WHEN r.response_hash IS NULL THEN NULL ELSE 'terminal-redacted:'||r.id::text END,authorization_json='{"key_id":"terminal-redacted","signature":""}'::jsonb,payload_scrubbed_at=now(),state=CASE WHEN r.state IN('queued','leased') THEN CASE WHEN r.delivery_count>0 THEN 'outcome_unknown' ELSE 'expired' END ELSE r.state END,lease_until=NULL FROM expired e WHERE r.id=e.id`,[forceClosed]);
   total+=result.rowCount??0;if((result.rowCount??0)<256)break;
  }
  return total;
 }
 startTransientMaintenance(intervalMs=1000):()=>void{const timer=setInterval(()=>{void this.expireTerminalPayloads().catch(()=>undefined);},Math.max(intervalMs,100));timer.unref();return()=>clearInterval(timer);}
 async wait(id:string,timeoutMs=90000,signal?:AbortSignal):Promise<unknown>{
  const deadline=Date.now()+Math.min(Math.max(timeoutMs,1),300000);
  while(true){
   const row=(await this.db.query<RpcRow>('SELECT * FROM agent_rpc_requests WHERE id=$1',[id])).rows[0];
   if(!row)throw new HostRpcError('rpc_not_found','RPC unavailable',id,404);
   if(row.sensitive_payload&&(row.payload_scrubbed_at||(row.payload_expires_at&&row.payload_expires_at.getTime()<=Date.now()))){await this.expireTerminalPayloads();throw new HostRpcError('terminal_delivery_expired','Transient terminal delivery bytes expired; input is never automatically replayed',id,410,row.delivery_count>0);}
   if(row.state==='responded'){
    if(row.sensitive_payload)await this.db.query(`UPDATE agent_rpc_requests SET body='null'::jsonb,response_body='null'::jsonb,request_hash='terminal-redacted:'||id::text,response_hash=CASE WHEN response_hash IS NULL THEN NULL ELSE 'terminal-redacted:'||id::text END,authorization_json='{"key_id":"terminal-redacted","signature":""}'::jsonb,payload_scrubbed_at=now() WHERE id=$1 AND payload_scrubbed_at IS NULL`,[id]);
    if(row.response_status!==null&&row.response_status>=200&&row.response_status<300)return row.response_body;
    const error=(row.response_body as {error?:{code?:string;message?:string}}|null)?.error;
    throw new HostRpcError(error?.code||'host_request_failed',error?.message||'Host rejected the request',id,row.response_status??502,error?.code==='outcome_unknown');
   }
   if(row.state==='expired'||row.state==='outcome_unknown'||Date.now()>=deadline||signal?.aborted){
    throw new HostRpcError(row.delivery_count?'outcome_unknown':'host_unreachable',row.delivery_count?'Host request outcome requires reconciliation':'Machine did not receive request before timeout',id,503,row.delivery_count>0);
   }
   await new Promise<void>(resolve=>setTimeout(resolve,100));
  }
 }
 async rpc(machineId:string,method:RpcMethod,path:string,body:unknown=null,options:RpcOptions={}):Promise<unknown>{return this.wait(await this.enqueue(machineId,method,path,body,options),options.timeoutMs,options.signal);}
 private async checkRecoveryReview(client:PoolClient,row:{method:RpcMethod;path:string;body:JsonValue;machine_id:string;workspace_guard:RpcOptions['workspaceGuard']|null;recovery_resolution:RpcOptions['recoveryResolution']|null},id:string,consume:boolean){
  const authorization=row.recovery_resolution,guard=row.workspace_guard,request=validateRecoveryResolution(row.method,row.path,row.body);
  if(!authorization||!guard||guard.workspace_id!==request.workspace_id)throw new Error('recovery_review_denied');
  const review=(await client.query('SELECT r.*,w.canonical_root,w.machine_id,w.revision FROM storage_recovery_reviews r JOIN workspaces w ON w.id=r.workspace_id AND w.owner_id=r.owner_id WHERE r.id=$1 AND r.owner_id=$2 AND r.workspace_id=$3 FOR UPDATE OF r',[authorization.review_id,authorization.owner_id,guard.workspace_id])).rows[0];
  if(!review||review.machine_id!==row.machine_id||review.revision!==guard.workspace_revision||review.original_operation_id!==request.original_operation_id||review.expected_manifest_hash!==request.record.expected_manifest_hash||review.details.lock_owner!==guard.lock_owner||review.details.canonical_root!==review.canonical_root||review.details.host_policy_revision!==request.record.policy_revision||review.details.resolution_id!==request.record.resolution_id||review.details.rpc_body_hash!==rpcDigest(row.body)||(review.used_at&&review.details.rpc_id!==id)||review.expires_at.getTime()<=Date.now())throw new HostRpcError('recovery_review_changed','Review is expired or does not match the protected recovery request',id,409);
  if(consume)await client.query("UPDATE storage_recovery_reviews SET used_at=COALESCE(used_at,now()),details=details||jsonb_build_object('rpc_id',$2::text) WHERE id=$1",[authorization.review_id,id]);
 }
 private async deliveryAuthority(client:PoolClient,row:Pick<RpcRow,'method'|'path'|'machine_id'|'job_guard'|'workspace_guard'|'scope_grant_id'|'scope_tool'|'recovery_read'|'safety_cancel'|'maintenance_capture'|'recovery_resolution'|'body'|'id'|'machine_identity_generation'>,control:any):Promise<string|null>{
  if((row.machine_identity_generation||control.native_authenticated)&&row.machine_identity_generation!==control.machine_identity_generation)return 'machine_generation_changed';
  if(row.recovery_read)return null; // Exact receipt-only paths were validated independently.
  let job:any=null;
  if(row.job_guard){
   const guard=row.job_guard;
   job=(await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[guard.job_id])).rows[0];
   if(!job||String(job.fence)!==String(guard.fence)||!job.lease_until||job.lease_until.getTime()<=Date.now()||job.dispatch_epoch!==control.dispatch_epoch||(guard.lease_owner&&job.lease_owner!==guard.lease_owner)||!['running','cancelling'].includes(job.state))return 'worker_fenced';
   if(row.method!=='GET'&&!row.safety_cancel&&job.reason==='capacity_recovery_only')return 'capacity_recovery_only';
   if(row.method!=='GET'&&!row.safety_cancel&&(job.cancel_requested||job.state!=='running'))return 'job_cancelled_before_delivery';
   if(guard.workspace_id&&!(await client.query('SELECT workspace_id FROM workspace_locks WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE',[guard.workspace_id,guard.job_id])).rowCount)return 'writer_fenced';
  }
  if(job?.kind==='workspace_terminal'&&!row.safety_cancel){
   const terminal=(await client.query('SELECT t.id,t.active_connection_id FROM terminal_sessions t JOIN sessions s ON s.id=t.auth_session_id AND s.user_id=t.owner_id WHERE t.job_id=$1 AND t.owner_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() FOR SHARE OF t,s',[job.id,job.requester_id])).rows[0];
   if(!terminal)return 'terminal_session_revoked';
   if(row.job_guard?.terminal_client_id&&row.job_guard.terminal_client_id!==terminal.active_connection_id)return 'terminal_client_replaced';
   if(new RegExp(`^/v1/terminals/${uuidPattern}/(attach|input|resize|detach)$`).test(row.path)){const body=row.body as Record<string,JsonValue>|null;if(!body||body.client_id!==terminal.active_connection_id||!terminal.active_connection_id)return 'terminal_client_replaced';}
  }
  if(row.maintenance_capture&&(!job||job.kind!=='operations.backup'||!control.maintenance_mode||control.maintenance_job_id!==job.id))return 'maintenance_owner_mismatch';
  if(row.workspace_guard){
   const guard=row.workspace_guard;
   if(!(await client.query('SELECT l.workspace_id FROM workspace_locks l JOIN workspaces w ON w.id=l.workspace_id WHERE l.workspace_id=$1 AND l.lock_owner=$2 AND w.revision=$3 AND w.machine_id=$4 FOR UPDATE OF l',[guard.workspace_id,guard.lock_owner,guard.workspace_revision,row.machine_id])).rowCount)return 'writer_fenced';
  }
  if(row.recovery_resolution){try{await this.checkRecoveryReview(client,row,row.id,false);}catch{return 'recovery_review_changed';}}
  if(row.safety_cancel||row.maintenance_capture)return null;
  const grantId=row.scope_grant_id??job?.payload?.grant?.id;
  const workspaceId=row.workspace_guard?.workspace_id??row.job_guard?.workspace_id??(/^\/v1\/workspaces\/([^/]+)/.exec(row.path)?.[1]);
  const execution=job?.context??job?.payload?.execution_context??{profile_id:job?.payload?.profile_id,execution_identity_id:job?.payload?.execution_identity_id,limits:job?.payload?.limits,workspace_revision:job?.payload?.workspace_snapshot?.revision};
  const commandAction=job?.kind==='saved_action'&&Boolean(job?.payload?.command||job?.payload?.verification);
  const terminal=job?.kind==='workspace_terminal';
  const requiredTools=[...(row.scope_tool?[row.scope_tool]:[]),...(commandAction?['actions.run','run_command']:[]),...(terminal?['workspace.terminal','run_command']:[])];
  if(job&&row.method!=='GET'&&!row.safety_cancel&&requiredTools.includes('run_command')&&execution.execution_identity_id){
   const identity=(await client.query('SELECT config FROM execution_identities WHERE id=$1 AND owner_id=$2 AND machine_id=$3 AND restriction_verified=true FOR SHARE',[execution.execution_identity_id,job.requester_id,row.machine_id])).rows[0];
   if(!identity||(workspaceId&&!identity.config?.workspace_ids?.includes(workspaceId)))return 'execution_identity_denied';
   if(workspaceId&&execution.workspace_revision&&!(await client.query("SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2 AND machine_id=$3 AND revision=$4 AND state='active' FOR SHARE",[workspaceId,job.requester_id,row.machine_id,execution.workspace_revision])).rowCount)return 'workspace_revision_changed';
  }
  if(grantId){
   const grant=(await client.query('SELECT g.* FROM permission_grants g JOIN machines m ON m.owner_id=g.owner_id WHERE g.id=$1 AND m.id=$2 FOR SHARE OF g',[grantId,row.machine_id])).rows[0];
   if(!grant||grant.revoked_at||(grant.expires_at&&new Date(grant.expires_at).getTime()<=Date.now()))return 'grant_revoked_before_delivery';
   if(!grant.machine_ids.includes(row.machine_id))return 'machine_denied';
   if(workspaceId&&!grant.workspace_ids.includes(workspaceId))return 'workspace_denied';
   if(requiredTools.some(tool=>!grant.tools.includes(tool)))return 'tool_denied';
   if(execution?.profile_id&&!grant.profile_ids.includes(execution.profile_id))return 'profile_denied';
  }
  if(execution?.profile_id){
   const current=(await client.query('SELECT r.definition FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=p.current_revision WHERE p.id=$1 AND p.owner_id=$2 AND p.archived_at IS NULL FOR SHARE OF p',[execution.profile_id,job.requester_id])).rows[0];
   if(!current)return 'profile_revoked_before_delivery';
   const parsed=ProfileDefinitionSchema.safeParse(current.definition);if(!parsed.success)return 'profile_invalid';const profile=parsed.data;
   if(requiredTools.some(tool=>!profile.tools.includes(tool)))return 'profile_tool_denied';
   if(!profile.machine_ids.includes(row.machine_id)||(workspaceId&&!profile.workspace_ids.includes(workspaceId)))return 'profile_target_denied';
   if((row.scope_tool==='run_command'||commandAction||terminal)&&execution.execution_identity_id&&!profile.execution_identity_ids.includes(execution.execution_identity_id))return 'profile_identity_denied';
   if(execution.provider_id&&profile.allowed_models.length&&!profile.allowed_models.some(model=>model.provider_id===execution.provider_id&&model.model_id===execution.model_id))return 'profile_model_denied';
   for(const [key,maximum]of Object.entries(profile.limits)){if(key==='max_concurrent_jobs')continue;const value=execution.limits?.[key];if(typeof maximum==='number'&&(typeof value!=='number'||value>maximum))return 'profile_limit_reduced';}
   const captured=(job.payload?.profile_snapshot?.definition??job.payload?.profile_snapshot)?.network_policy;
   if(captured&&profile.network_policy.mode!=='runtime_default'&&(captured.mode!==profile.network_policy.mode||captured.allowed_hosts?.some((host:string)=>!profile.network_policy.allowed_hosts.includes(host))))return 'profile_network_reduced';
  }
  return null;
 }
 async claim(machineId:string,max=1,certificateSerial?:string):Promise<AgentRpcRequest[]>{
  await this.expireTerminalPayloads();
  const client=await this.db.connect();
  try{
   await client.query('BEGIN');
   const control=(await client.query('SELECT dispatch_epoch,dispatch_enabled,restore_mode,maintenance_mode,maintenance_job_id FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
   if(!control){await client.query('COMMIT');return [];}
   const currentMachine=(await client.query('SELECT identity_generation FROM machines WHERE id=$1 FOR SHARE',[machineId])).rows[0];if(!currentMachine){await client.query('COMMIT');return [];}
   control.machine_identity_generation=currentMachine.identity_generation;control.native_authenticated=!!certificateSerial;
   if(certificateSerial&&!((await client.query('SELECT id FROM agent_certificates WHERE machine_id=$1 AND serial=$2 AND protocol_version=1 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[machineId,certificateSerial])).rowCount))throw new HostRpcError('agent_certificate_revoked','Agent certificate is no longer authorized','',403);
   const restoring=control.restore_mode||process.env.RESTORE_MODE==='true';
   await client.query("UPDATE agent_rpc_requests SET state='outcome_unknown' WHERE machine_id=$1 AND dispatch_epoch<>$2 AND state IN ('queued','leased')",[machineId,control.dispatch_epoch]);
   await client.query("UPDATE agent_rpc_requests SET state=CASE WHEN delivery_count>0 THEN 'outcome_unknown' ELSE 'expired' END WHERE machine_id=$1 AND expires_at<=now() AND state IN ('queued','leased')",[machineId]);
   const canMutate=!restoring&&control.dispatch_enabled&&!control.maintenance_mode&&process.env.DISPATCH_ENABLED==='true';
   // One envelope per poll bounds large checkpoint responses; request count never multiplies the 96MiB frame cap.
   const eligible="machine_id=$1 AND expires_at>now() AND dispatch_epoch=$3 AND (($5 AND ((recovery_read=true AND method='GET') OR recovery_resolution IS NOT NULL)) OR ($5=false AND (method='GET' OR safety_cancel=true OR maintenance_capture=true OR recovery_resolution IS NOT NULL OR $4))) AND (state='queued' OR (state='leased' AND lease_until<now()))";
   // Read IDs/guards first, then acquire job -> workspace -> RPC locks in the same order as enqueue/reconcile.
   const candidate=(await client.query<RpcRow>(`SELECT id,machine_id,method,path,job_guard,workspace_guard,scope_grant_id,scope_tool,recovery_read,safety_cancel,maintenance_capture,recovery_resolution,machine_identity_generation,body FROM agent_rpc_requests WHERE ${eligible} ORDER BY created_at LIMIT $2`,[machineId,1,control.dispatch_epoch,canMutate,restoring])).rows[0];
   if(!candidate){await client.query('COMMIT');return [];}
   const denied=await this.deliveryAuthority(client,candidate,control);
   const rows=(await client.query<RpcRow>(`SELECT * FROM agent_rpc_requests WHERE ${eligible} AND id=$6 LIMIT $2 FOR UPDATE SKIP LOCKED`,[machineId,1,control.dispatch_epoch,canMutate,restoring,candidate.id])).rows;
   if(denied&&rows[0]){
    const row=rows[0];
    if(row.delivery_count>0)await client.query("UPDATE agent_rpc_requests SET state='outcome_unknown',lease_until=NULL WHERE id=$1",[row.id]);
    else {const status=/grant|tool|profile|denied/.test(denied)?403:409,body={error:{code:denied,message:'Authority changed before first host delivery'},never_delivered:true,effects_started:false,source:'control_plane_admission'};await client.query("UPDATE agent_rpc_requests SET state='responded',response_status=$2,response_body=$3::jsonb,response_hash=$4,responded_at=now(),lease_until=NULL WHERE id=$1",[row.id,status,JSON.stringify(body),rpcDigest({status,body})]);}
    await client.query('COMMIT');return [];
   }
   for(const row of rows){if(row.recovery_resolution)validateRecoveryResolution(row.method,row.path,row.body);if(row.recovery_read)validateRecoveryRead(row.method,row.path,row.body);if(row.safety_cancel)validateSafetyCancel(row.method,row.path);if(row.maintenance_capture)validateMaintenanceCapture(row.method,row.path,row.body);}
   for(const row of rows)await client.query("UPDATE agent_rpc_requests SET state='leased',lease_until=now()+interval '30 seconds',delivery_count=delivery_count+1 WHERE id=$1",[row.id]);
   await client.query('COMMIT');
   return rows.map(row=>({...(row.machine_identity_generation?{machine_identity_generation:row.machine_identity_generation}:{}),schema_version:1,id:row.id,machine_id:row.machine_id,method:row.method,path:row.path,body:row.body,authorization:row.authorization_json,created_at:row.created_at.toISOString(),expires_at:row.expires_at.toISOString(),dispatch_epoch:row.dispatch_epoch}));
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 async respond(machineId:string,id:string,status:number,body:unknown,certificateSerial?:string):Promise<void>{
  if(!Number.isInteger(status)||status<200||status>599)throw new Error('invalid_rpc_status');
  const serialized=canonicalJson(body);if(Buffer.byteLength(serialized)>96*1024*1024)throw new Error('rpc_response_too_large');
  const hash=rpcDigest({status,body});
  const client=await this.db.connect();
  try{
  await client.query('BEGIN');
  const control=(await client.query('SELECT dispatch_epoch,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
  if(!control)throw new HostRpcError('restore_mode','Restore reconciliation is required before accepting agent results',id,409);
  const currentMachine=(await client.query('SELECT identity_generation FROM machines WHERE id=$1 FOR SHARE',[machineId])).rows[0];if(!currentMachine)throw new HostRpcError('machine_not_found','Machine unavailable',id,404);
  if(certificateSerial&&!((await client.query('SELECT id FROM agent_certificates WHERE machine_id=$1 AND serial=$2 AND protocol_version=1 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[machineId,certificateSerial])).rowCount))throw new HostRpcError('agent_certificate_revoked','Agent certificate is no longer authorized',id,403);
  const envRestore=process.env.RESTORE_MODE==='true';
  const row=(await client.query("UPDATE agent_rpc_requests SET state=$3,response_status=$4,response_body=CASE WHEN sensitive_payload AND (payload_scrubbed_at IS NOT NULL OR payload_expires_at<=now()) THEN 'null'::jsonb ELSE $5::jsonb END,response_hash=CASE WHEN sensitive_payload AND (payload_scrubbed_at IS NOT NULL OR payload_expires_at<=now()) THEN 'terminal-redacted:'||id::text ELSE $6 END,responded_at=now(),payload_scrubbed_at=CASE WHEN sensitive_payload AND payload_expires_at<=now() THEN COALESCE(payload_scrubbed_at,now()) ELSE payload_scrubbed_at END,lease_until=NULL,body=CASE WHEN sensitive_payload THEN 'null'::jsonb ELSE body END,request_hash=CASE WHEN sensitive_payload THEN 'terminal-redacted:'||id::text ELSE request_hash END,authorization_json=CASE WHEN sensitive_payload THEN '{\"key_id\":\"terminal-redacted\",\"signature\":\"\"}'::jsonb ELSE authorization_json END,payload_expires_at=CASE WHEN sensitive_payload THEN now()+interval '30 seconds' ELSE payload_expires_at END WHERE id=$1 AND machine_id=$2 AND response_hash IS NULL AND delivery_count>0 AND (machine_identity_generation=$9 OR ($10 AND machine_identity_generation IS NULL)) AND dispatch_epoch=$7 AND ($8=false OR recovery_read=true OR recovery_resolution IS NOT NULL) AND EXISTS(SELECT 1 FROM runtime_control c WHERE c.singleton=true AND (c.restore_mode=false OR agent_rpc_requests.recovery_read=true OR agent_rpc_requests.recovery_resolution IS NOT NULL) AND c.dispatch_epoch=agent_rpc_requests.dispatch_epoch) RETURNING id",[id,machineId,'responded',status,serialized,hash,control.dispatch_epoch,envRestore,currentMachine.identity_generation,!certificateSerial])).rows[0];
  if(!row){const prior=(await client.query('SELECT r.response_hash FROM agent_rpc_requests r JOIN runtime_control c ON c.singleton=true AND (c.restore_mode=false OR r.recovery_read=true OR r.recovery_resolution IS NOT NULL) AND c.dispatch_epoch=r.dispatch_epoch WHERE r.id=$1 AND r.machine_id=$2 AND (r.machine_identity_generation=$4 OR ($5 AND r.machine_identity_generation IS NULL)) AND ($3=false OR r.recovery_read=true OR r.recovery_resolution IS NOT NULL)',[id,machineId,envRestore,currentMachine.identity_generation,!certificateSerial])).rows[0];if(prior?.response_hash?.startsWith('terminal-redacted:'))throw new HostRpcError('terminal_delivery_expired','Terminal delivery metadata is retained without enumerable payload fingerprints',id,410);if(prior?.response_hash!==hash)throw new HostRpcError('rpc_response_conflict','Unknown RPC or conflicting result',id,409);}
  await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
}
