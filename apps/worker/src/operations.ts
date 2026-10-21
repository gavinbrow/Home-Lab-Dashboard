import { randomUUID } from 'node:crypto';
import type {PoolClient} from 'pg';
import type { PolicyGrant,RunContext,Limits,OperationRequest,OperationReceipt } from '@homelab/contracts';
import { authorize } from '@homelab/policy';
import { HostRpcError,type AgentBroker } from '@homelab/transport';
import { transaction,assertOwnedLease,LeaseLostError } from './database.js';
import { appendEventInTransaction } from './queue.js';
import { digest } from './hash.js';
import { resolveProfile,assertCurrentGrant,wireGrant,expectedMachineGeneration,type ProfileDefinition } from './authority.js';
import type { JobRow } from './types.js';
import type { RuntimeContext } from './runtime.js';
import {accountOutput,remainingOutput} from './output.js';
export type ExecutionContext=Pick<RunContext,'execution_machine_id'|'execution_identity_id'|'workspace_id'|'workspace_revision'|'environment_id'|'environment_generation'|'profile_id'|'profile_revision'|'policy_revision'|'limits'>;
export type OperationResult={state:'pending';reason:string}|{state:'unknown';reason:string}|{state:'known';operation_id:string;status:string;exit_code?:number|null;output?:string;result?:Record<string,unknown>};
export interface CommandInput {step_id:string;command:{executable:string;args:string[];env?:Record<string,string>};tool:string;grant:PolicyGrant;context:ExecutionContext;mutating:boolean;verification?:boolean;}
export interface ControlInput {step_id:string;machine_id:string;target_id:string;kind:string;verb:string;grant:PolicyGrant;policy_revision:number;max_log_bytes:number;mutating:boolean;workspace_id?:string|null;profile_id?:string|null;}
export interface OperationDependencies {broker:AgentBroker;checkpoint(job:JobRow,runtime:RuntimeContext,reason:string):Promise<unknown>;publishChanges?(job:JobRow,runtime:RuntimeContext,operationId:string,before:unknown,after:unknown):Promise<unknown>;}
interface OperationRow {id:string;job_id:string;step_id:string;request_hash:string;request:Record<string,any>;machine_id:string;status:string;receipt:any;outcome:any;log_cursor:string;}
const terminal=new Set(['succeeded','failed','cancelled','rejected','completed']);
async function fencedQuery(runtime:RuntimeContext,job:JobRow,sql:string,values:unknown[]){return transaction(runtime.db,async client=>{await assertOwnedLease(client,job);return client.query(sql,values);});}
export function createOperationExecutor(deps:OperationDependencies){
 const record=async(job:JobRow,runtime:RuntimeContext,op:OperationRow,receipt:any,control=false)=>{
  if(receipt.operation_id!==op.id||(receipt.request_hash&&receipt.request_hash!==op.request_hash)||(receipt.machine_id&&receipt.machine_id!==op.machine_id))throw new Error('host_receipt_identity_mismatch');
  const status=receipt.state==='completed'?'succeeded':receipt.state;
  if(!['received','launching','running','succeeded','failed','cancelled','cancelling','interrupted','outcome_unknown','rejected'].includes(status))throw new Error('invalid_host_receipt');
  await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);await client.query('UPDATE operations SET status=$2,receipt=$3::jsonb,updated_at=now() WHERE id=$1',[op.id,status,JSON.stringify(receipt)]);if(Number.isSafeInteger(receipt.host_sequence))await client.query('INSERT INTO host_receipts(operation_id,host_sequence,receipt) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[op.id,receipt.host_sequence,JSON.stringify(receipt)]);await appendEventInTransaction(client,job.id,'operation.receipt',{operation_id:op.id,receipt});});
  op.status=status;op.receipt=receipt;
 };
 const logAuthority=async(client:PoolClient,job:JobRow,op:OperationRow,input:CommandInput)=>{
  await assertOwnedLease(client,job);const c=job.context??input.context,grant=(op.request.grant??input.grant) as PolicyGrant;
  const machine=(await client.query('SELECT identity_generation FROM machines WHERE id=$1 AND owner_id=$2 FOR SHARE',[op.machine_id,job.requester_id])).rows[0];if(!machine||machine.identity_generation!==expectedMachineGeneration(job,op.machine_id))throw new Error('machine_generation_changed');
  const captured=job.payload.profile_snapshot as ProfileDefinition|{definition:ProfileDefinition}|undefined,profile=captured&&'definition'in captured?captured.definition:captured;
  for(const tool of new Set(['run_command',...(job.kind==='saved_action'||input.tool==='actions.run'?['actions.run']:[])])){await assertCurrentGrant(client,job.requester_id,c,tool,grant);await resolveProfile(client,job.requester_id,c,tool,profile);}
  return grant;
 };
 const logs=async(job:JobRow,runtime:RuntimeContext,op:OperationRow,input:CommandInput):Promise<{backlog:boolean}>=>{
  const unavailable=async(reason:string,backlog=false)=>{await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);const current=(await client.query('SELECT outcome FROM operations WHERE id=$1 FOR UPDATE',[op.id])).rows[0];if(current?.outcome?.log_unavailable!==reason){await client.query("UPDATE operations SET outcome=COALESCE(outcome,'{}'::jsonb)||$2::jsonb WHERE id=$1",[op.id,JSON.stringify({log_unavailable:reason})]);await appendEventInTransaction(client,job.id,'operation.logs.unavailable',{operation_id:op.id,reason});}});return {backlog};};
  let grant:PolicyGrant;try{grant=await transaction(runtime.db,client=>logAuthority(client,job,op,input));}catch(error){if(error instanceof LeaseLostError)throw error;return unavailable('current_log_scope_denied');}
  try{const response=await deps.broker.rpc(op.machine_id,'GET',`/v1/operations/${op.id}/logs?after=${op.log_cursor}`,null,{expectedMachineGeneration:expectedMachineGeneration(job,op.machine_id),ownerId:job.requester_id,timeoutMs:1500,signal:runtime.signal,scopeGrantId:grant.id,scopeTool:'run_command',jobGuard:{job_id:job.id,fence:job.fence,lease_owner:job.lease_owner??undefined,workspace_id:job.workspace_id}}) as {logs:{sequence:number;stream:string;data:string;truncated?:boolean}[]};
   // Host journal pages are at most 256 chunks of 16KiB. Accept a full page,
   // including >1MiB backlogs, without advancing past unpersisted records.
   if(!Array.isArray(response.logs)||response.logs.length>256||response.logs.some(log=>!Number.isSafeInteger(log.sequence)||log.sequence<1||!['stdout','stderr','combined','system'].includes(log.stream)||typeof log.data!=='string'||Buffer.byteLength(log.data)>16384||log.truncated!==undefined&&typeof log.truncated!=='boolean'))return unavailable('invalid_host_log_page');
   const bounded=response.logs.filter(log=>BigInt(log.sequence)>BigInt(op.log_cursor)).sort((a,b)=>a.sequence-b.sequence);
   await transaction(runtime.db,async client=>{await logAuthority(client,job,op,input);const current=(await client.query('SELECT log_cursor FROM operations WHERE id=$1 FOR UPDATE',[op.id])).rows[0];let cursor=BigInt(current.log_cursor);
    for(const log of bounded){if(BigInt(log.sequence)<=cursor)continue;const output=await accountOutput(client,job,`operation:${op.id}:log:${log.sequence}`,'operation_log',log.data,'truncate');if(!output.duplicate){if(output.text)await appendEventInTransaction(client,job.id,'log',{operation_id:op.id,...log,data:output.text,truncated:!!log.truncated||output.limited});if(output.limited)await appendEventInTransaction(client,job.id,'output.limited',{operation_id:op.id,kind:'operation_log',host_sequence:log.sequence,reason:'job_output_budget',source_bytes:Buffer.byteLength(log.data),accepted_bytes:output.accepted_bytes});}cursor=BigInt(log.sequence);}
    await client.query("UPDATE operations SET log_cursor=$2,outcome=COALESCE(outcome,'{}'::jsonb)-'log_unavailable' WHERE id=$1",[op.id,cursor.toString()]);
   });return {backlog:response.logs.length===256&&bounded.length>0};
  }catch(error){if(error instanceof LeaseLostError)throw error;if(error instanceof HostRpcError){const retry=error.statusCode===0||error.statusCode===404||error.statusCode===408||error.statusCode===429||error.statusCode>=500;return unavailable(error.statusCode===403?'current_log_scope_denied':'host_log_transport_unavailable',retry);}return unavailable('current_log_scope_denied');}
 };
 const operate=async(job:JobRow,runtime:RuntimeContext,stepId:string,machineId:string,prepare:()=>Promise<Record<string,any>>,mutating:boolean,kind:'command'|'control',targetId?:string,scopeTool=kind==='control'?'actions.run':'run_command',commandInput?:CommandInput):Promise<OperationResult>=>{
  let op=(await runtime.db.query<OperationRow>('SELECT * FROM operations WHERE job_id=$1 AND step_id=$2',[job.id,stepId])).rows[0];
  const path=()=>kind==='command'?`/v1/operations/${op.id}`:`/v1/targets/${targetId}/actions/${op.id}`;
  const postPath=kind==='command'?'/v1/operations':`/v1/targets/${targetId}/actions`;
  const limits=(job.context?.limits??(job.payload.execution_context as ExecutionContext|undefined)?.limits??job.payload.limits) as Limits|undefined;
  const expired=()=>!!limits&&Date.now()-(job.started_at?.getTime()??Date.now())>=limits.wall_time_seconds*1000;
  if(job.recovery_only&&(!op||['preparing','pending_dispatch'].includes(op.status)))return {state:'pending',reason:'capacity_recovery_only'};
  if(!op||['preparing','pending_dispatch'].includes(op.status)){const remaining=await transaction(runtime.db,client=>remainingOutput(client,job));if(!remaining){const cancelled=await runtime.cancelled();if(op)await fencedQuery(runtime,job,"UPDATE operations SET status=$2,outcome=COALESCE(outcome,'{}'::jsonb)||$3::jsonb WHERE id=$1",[op.id,cancelled?'cancelled':'failed',JSON.stringify({not_dispatched:true,reason:'job_output_budget_exhausted'})]);return {state:'known',operation_id:op?.id??'',status:cancelled?'cancelled':'failed',result:{reason:'job_output_budget_exhausted',not_dispatched:true}};}}
  if(!op){
   if(await runtime.cancelled())return {state:'known',operation_id:'',status:'cancelled'};
   if(expired())return {state:'known',operation_id:'',status:'failed',result:{reason:'job_wall_time_limit'}};
   const body=await prepare();const operationId=randomUUID();body.operation_id=operationId;
   const {fence,dispatch_epoch,request_hash,...hashInput}=body;body.request_hash=digest(hashInput);
   const admitted=await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`machine:${machineId}`]);const maximum=(await client.query('SELECT config FROM machines WHERE id=$1',[machineId])).rows[0]?.config?.max_concurrent_operations??1;const occupied=(await client.query("SELECT COUNT(*)::int AS count FROM operations WHERE machine_id=$1 AND status NOT IN ('succeeded','failed','cancelled','rejected')",[machineId])).rows[0].count;if(occupied>=maximum)return false;await client.query("INSERT INTO operations(id,job_id,step_id,request_hash,request,machine_id,fence,status,replay_class) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,'preparing',$8)",[operationId,job.id,stepId,body.request_hash,JSON.stringify(body),machineId,job.fence,mutating?'mutating':'read_only']);await client.query('UPDATE workspace_locks SET operation_id=$2 WHERE job_id=$1',[job.id,operationId]);await appendEventInTransaction(client,job.id,'operation.prepared',{operation_id:operationId,step_id:stepId});return true;});
   if(!admitted)return {state:'pending',reason:'machine_capacity'};
   op=(await runtime.db.query<OperationRow>('SELECT * FROM operations WHERE id=$1',[operationId])).rows[0];
  }
  if(op.status==='preparing'){
   if(await runtime.cancelled()){await fencedQuery(runtime,job,"UPDATE operations SET status='cancelled',outcome='{\"not_dispatched\":true}' WHERE id=$1",[op.id]);return {state:'known',operation_id:op.id,status:'cancelled'};}
   if(mutating&&job.workspace_id){const checkpoint=await deps.checkpoint(job,runtime,`operation:${op.id}:before`);await fencedQuery(runtime,job,"UPDATE operations SET outcome=$2::jsonb WHERE id=$1",[op.id,JSON.stringify({before_checkpoint:checkpoint})]);}
   await runtime.assertLease();
   await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);await client.query("UPDATE operations SET status='pending_dispatch' WHERE id=$1",[op.id]);await client.query("INSERT INTO dispatch_outbox(job_id,operation_id,kind,payload) VALUES($1,$2,'host_dispatch',$3::jsonb)",[job.id,op.id,JSON.stringify(op.request)]);});op.status='pending_dispatch';
  }
  if(op.status==='dispatching'){
   const admission=(await runtime.db.query('SELECT delivery_count,response_body FROM agent_rpc_requests WHERE id=$1',[op.id])).rows[0];
   if(admission?.delivery_count===0&&admission.response_body?.never_delivered===true&&admission.response_body?.effects_started===false){
    const cancelled=await runtime.cancelled();await fencedQuery(runtime,job,'UPDATE operations SET status=$2,outcome=COALESCE(outcome,\'{}\'::jsonb)||$3::jsonb WHERE id=$1',[op.id,cancelled?'cancelled':'rejected',JSON.stringify(admission.response_body)]);return {state:'known',operation_id:op.id,status:cancelled?'cancelled':'rejected',result:{reason:admission.response_body.error?.code,never_delivered:true}};
   }
  }
  if(op.status==='pending_dispatch'){
   if(await runtime.cancelled()){await fencedQuery(runtime,job,"UPDATE operations SET status='cancelled',outcome=COALESCE(outcome,'{}'::jsonb)||'{\"not_dispatched\":true}'::jsonb WHERE id=$1",[op.id]);return {state:'known',operation_id:op.id,status:'cancelled'};}
   if(expired()){await fencedQuery(runtime,job,"UPDATE operations SET status='failed',outcome='{\"reason\":\"job_wall_time_limit\"}' WHERE id=$1",[op.id]);return {state:'known',operation_id:op.id,status:'failed',result:{reason:'job_wall_time_limit'}};}
   // Revalidate new launches after checkpoint latency; never change an already persisted semantic request.
   const fresh=await prepare();if(fresh.grant?.id!==op.request.grant?.id)throw new Error('captured_grant_changed');
   if(op.request.limits){op.request.limits.max_output_bytes=Math.min(op.request.limits.max_output_bytes,fresh.limits.max_output_bytes);op.request.limits.per_command_timeout_seconds=Math.min(op.request.limits.per_command_timeout_seconds,fresh.limits.per_command_timeout_seconds);op.request.fence=Number(job.fence);const {fence,dispatch_epoch,request_hash,...semantic}=op.request;op.request.request_hash=digest(semantic);op.request_hash=op.request.request_hash;await fencedQuery(runtime,job,'UPDATE operations SET request=$2::jsonb,request_hash=$3,fence=$4 WHERE id=$1',[op.id,JSON.stringify(op.request),op.request_hash,job.fence]);}
   if(await runtime.cancelled()){await fencedQuery(runtime,job,"UPDATE operations SET status='cancelled',outcome='{\"not_dispatched\":true}' WHERE id=$1",[op.id]);return {state:'known',operation_id:op.id,status:'cancelled'};}
   await transaction(runtime.db,async client=>{await assertOwnedLease(client,job);await client.query("UPDATE operations SET status='dispatching' WHERE id=$1",[op.id]);});op.status='dispatching';
   try{const receipt=await deps.broker.rpc(machineId,'POST',postPath,op.request,{expectedMachineGeneration:expectedMachineGeneration(job,machineId),requestId:op.id,ownerId:job.requester_id,timeoutMs:2000,signal:runtime.signal,scopeGrantId:op.request.grant?.id,scopeTool,jobGuard:{job_id:job.id,fence:job.fence,lease_owner:job.lease_owner??undefined,workspace_id:job.workspace_id}});await record(job,runtime,op,receipt,kind==='control');await runtime.db.query("UPDATE dispatch_outbox SET delivered_at=now() WHERE operation_id=$1 AND kind='host_dispatch'",[op.id]);}catch(error){if(!(error instanceof HostRpcError))throw error;if(error.code==="worker_fenced"||error.code==="writer_fenced")throw new LeaseLostError();const sent=await runtime.db.query('SELECT id FROM agent_rpc_requests WHERE id=$1',[op.id]);if(!sent.rowCount)await fencedQuery(runtime,job,"UPDATE operations SET status='pending_dispatch' WHERE id=$1",[op.id]);if(!error.outcomeUnknown&&error.statusCode>=400&&error.statusCode<500){await fencedQuery(runtime,job,"UPDATE operations SET status='rejected',outcome=$2::jsonb WHERE id=$1",[op.id,JSON.stringify({reason:error.code})]);return {state:'known',operation_id:op.id,status:'rejected',result:{reason:error.code}};}return {state:'pending',reason:error.code};}
  }else if(!terminal.has(op.status)&&op.status!=='outcome_unknown'&&op.status!=='interrupted'){
   try{const receipt=await deps.broker.rpc(machineId,'GET',path(),null,{expectedMachineGeneration:expectedMachineGeneration(job,machineId),ownerId:job.requester_id,timeoutMs:2000,signal:runtime.signal});await record(job,runtime,op,receipt,kind==='control');}catch(error){if(error instanceof HostRpcError)return {state:'pending',reason:error.statusCode===404?'host_operation_reconciliation_required':error.code};throw error;}
  }
  if(await runtime.cancelled()&&!terminal.has(op.status)){
   if(kind==='control')return {state:'pending',reason:'action_outcome_pending_cancellation_cannot_undo'};
   try{const cancelBody={fence:Number(job.fence),dispatch_epoch:job.dispatch_epoch};const receipt=await deps.broker.rpc(machineId,'POST',`${path()}/cancel`,cancelBody,{expectedMachineGeneration:expectedMachineGeneration(job,machineId),ownerId:job.requester_id,timeoutMs:2000,signal:runtime.signal,safetyCancellation:true,jobGuard:{job_id:job.id,fence:job.fence,lease_owner:job.lease_owner??undefined,workspace_id:job.workspace_id}});await record(job,runtime,op,receipt,false);}catch(error){if(error instanceof HostRpcError)return {state:'pending',reason:'cancellation_pending_host_reconnect'};throw error;}
  }
  if(kind==='command'&&commandInput&&!['preparing','pending_dispatch','rejected'].includes(op.status)){const page=await logs(job,runtime,op,commandInput);if(terminal.has(op.status)&&page.backlog)return {state:'pending',reason:'host_log_replay'};}
  if(op.status==='outcome_unknown'||op.status==='interrupted')return {state:'unknown',reason:op.receipt?.reason??'host_outcome_unknown'};
  if(!terminal.has(op.status))return {state:'pending',reason:op.status==='running'?'host_operation_running':'host_operation_pending'};
  if(mutating&&job.workspace_id&&op.status!=='rejected'){
   const checkpoint=await deps.checkpoint(job,runtime,`operation:${op.id}:after`);
   const previous=(await runtime.db.query('SELECT outcome FROM operations WHERE id=$1',[op.id])).rows[0]?.outcome;
   const changes=deps.publishChanges&&previous?.before_checkpoint?await deps.publishChanges(job,runtime,op.id,previous.before_checkpoint,checkpoint):undefined;
   await fencedQuery(runtime,job,"UPDATE operations SET outcome=COALESCE(outcome,'{}'::jsonb)||$2::jsonb WHERE id=$1",[op.id,JSON.stringify({after_checkpoint:checkpoint,...(changes?{file_changes:changes}:{})})]);
  }
  const output=(await runtime.db.query("SELECT payload->>'data' AS data FROM job_events WHERE job_id=$1 AND type='log' AND payload->>'operation_id'=$2 ORDER BY id DESC LIMIT 50",[job.id,op.id])).rows.reverse().map(r=>r.data).join('').slice(-16384);
  return {state:'known',operation_id:op.id,status:op.status,exit_code:op.receipt?.exit_code??op.receipt?.result?.exit_code??null,output,result:op.receipt?.result??{}};
 };
 const prepareCommand=async(job:JobRow,runtime:RuntimeContext,input:CommandInput)=>{
  const c=input.context;if(!c.workspace_id||!c.execution_identity_id||!c.execution_machine_id)throw new Error('execution_context_required');
  const current=(await runtime.db.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2',[input.grant.id,job.requester_id])).rows[0];
  const decision=authorize({actor:{id:job.requester_id,role:'owner'},tool:input.tool,machine_id:c.execution_machine_id,workspace_id:c.workspace_id,profile_id:c.profile_id,grant:input.grant,current_grant:current});if(!decision.allowed)throw new Error(decision.code);
  const capturedProfile=job.payload.profile_snapshot as (ProfileDefinition|{definition:ProfileDefinition})|undefined;
  if(job.kind==='saved_action'||input.tool==='actions.run'){const commandDecision=authorize({actor:{id:job.requester_id,role:'owner'},tool:'run_command',machine_id:c.execution_machine_id,workspace_id:c.workspace_id,profile_id:c.profile_id,grant:input.grant,current_grant:current});if(!commandDecision.allowed)throw new Error(commandDecision.code);await resolveProfile(runtime.db,job.requester_id,job.context??c,'run_command',capturedProfile&&'definition'in capturedProfile?capturedProfile.definition:capturedProfile);}
  const profile=await resolveProfile(runtime.db,job.requester_id,job.context??c,input.tool,capturedProfile&&'definition'in capturedProfile?capturedProfile.definition:capturedProfile);
  const workspace=(await runtime.db.query('SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2',[c.workspace_id,job.requester_id])).rows[0];
  if(!workspace||workspace.state!=='active'||workspace.machine_id!==c.execution_machine_id||workspace.revision!==c.workspace_revision||workspace.environment_id!==c.environment_id||workspace.environment_generation!==c.environment_generation)throw new Error('workspace_revision_conflict');
  const identity=(await runtime.db.query('SELECT restriction_verified,config FROM execution_identities WHERE id=$1 AND owner_id=$2 AND machine_id=$3',[c.execution_identity_id,job.requester_id,c.execution_machine_id])).rows[0];if(!identity?.restriction_verified||!identity.config?.workspace_ids?.includes(c.workspace_id))throw new Error('execution_identity_unverified');
  if(c.limits.max_generated_file_bytes!==undefined)throw new Error('command_generated_file_limit_runtime_unsupported');
  const currentProfile=c.profile_id?(await runtime.db.query('SELECT r.definition FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=p.current_revision WHERE p.id=$1 AND p.owner_id=$2',[c.profile_id,job.requester_id])).rows[0]?.definition:null;
  const policies=[profile?.network_policy,currentProfile?.network_policy].filter(Boolean);
  if(policies.some(p=>p?.mode==='allowlist'))throw new Error('network_allowlist_runtime_unsupported');
  const network_policy={mode:policies.some(p=>p?.mode==='deny')?'deny':'runtime_default',allowed_hosts:[]} as const;
  if(network_policy.mode==='deny'&&workspace.type!=='container'&&!(identity.config.network_policy_verified===true&&identity.config.network_policy==='deny'))throw new Error('native_network_policy_unverified');
  if(Object.keys(input.command.env??{}).length)throw new Error('unapproved_command_environment');
  const outputRemaining=await transaction(runtime.db,client=>remainingOutput(client,job));if(!outputRemaining)throw new Error('job_output_budget_exhausted');
  const limits={max_tool_steps:c.limits.max_tool_steps,wall_time_seconds:c.limits.wall_time_seconds,max_output_bytes:Math.min(c.limits.max_output_bytes,outputRemaining),per_command_timeout_seconds:Math.min(c.limits.per_command_timeout_seconds,Math.max(1,Math.ceil(c.limits.wall_time_seconds-(Date.now()-(job.started_at?.getTime()??Date.now()))/1000)))};
  const saved_action=job.payload.action_id?{action_id:job.payload.action_id,revision:job.payload.action_revision,definition_hash:digest(job.payload.action_definition)}:undefined;
  return {machine_identity_generation:expectedMachineGeneration(job,c.execution_machine_id),schema_version:1,operation_id:'',request_hash:'',job_id:job.id,step_id:input.step_id,machine_id:c.execution_machine_id,execution_identity_id:c.execution_identity_id,workspace_id:c.workspace_id,workspace_revision:c.workspace_revision,environment_id:c.environment_id,environment_generation:c.environment_generation,policy_revision:decision.policy_revision,fence:Number(job.fence),dispatch_epoch:job.dispatch_epoch,grant:wireGrant(input.grant),command:{executable:input.command.executable,args:input.command.args,cwd:workspace.runtime_path,env:{}},limits,network_policy,...(saved_action?{saved_action}:{})};
 };
 const executeCommand=async(job:JobRow,runtime:RuntimeContext,input:CommandInput)=>operate(job,runtime,input.step_id,input.context.execution_machine_id!,()=>prepareCommand(job,runtime,input),input.mutating,'command',undefined,input.tool,input);
 const executeControl=async(job:JobRow,runtime:RuntimeContext,input:ControlInput)=>operate(job,runtime,input.step_id,input.machine_id,async()=>{
  const current=(await runtime.db.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2',[input.grant.id,job.requester_id])).rows[0];const decision=authorize({actor:{id:job.requester_id,role:'owner'},tool:'actions.run',machine_id:input.machine_id,workspace_id:input.workspace_id??job.workspace_id,profile_id:input.profile_id??job.context?.profile_id,grant:input.grant,current_grant:current});if(!decision.allowed)throw new Error(decision.code);
  const target=(await runtime.db.query('SELECT * FROM service_targets WHERE id=$1 AND owner_id=$2 AND machine_id=$3',[input.target_id,job.requester_id,input.machine_id])).rows[0];if(!target||target.kind!==input.kind||!target.config.allowed_operations?.includes(input.verb))throw new Error('target_scope_denied');
  return {machine_identity_generation:expectedMachineGeneration(job,input.machine_id),schema_version:1,operation_id:'',job_id:job.id,machine_id:input.machine_id,target_id:input.target_id,target_kind:input.kind,verb:input.verb,grant_id:input.grant.id,grant:wireGrant(input.grant),policy_revision:decision.policy_revision,fence:Number(job.fence),dispatch_epoch:job.dispatch_epoch,max_log_bytes:input.max_log_bytes};
 },input.mutating,'control',input.target_id);
 return {executeCommand,executeControl,prepareCommand};
}



