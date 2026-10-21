import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Limits,PolicyGrant } from '@homelab/contracts';
import type { JobRow } from '@homelab/worker';
import type { JobHandler,RuntimeContext } from '@homelab/worker/runtime';
import { revalidateCapturedAction,type CapturedAction } from './resolve.js';

export type ActionOperationResult=
  | {state:'pending';reason:string}
  | {state:'unknown';reason:string}
  | {state:'known';operation_id:string;status:string;exit_code?:number|null;output?:string;result?:Record<string,unknown>};
export interface ActionExecutionContext {
  execution_machine_id:string;execution_identity_id:string;workspace_id:string;workspace_revision:number;
  environment_id:string|null;environment_generation:number|null;profile_id:string|null;profile_revision:number|null;policy_revision:number;limits:Limits;
}
export interface ActionOperations {
  executeCommand(job:JobRow,runtime:RuntimeContext,input:{step_id:string;command:{executable:string;args:string[];env?:Record<string,string>};tool:'actions.run';grant:PolicyGrant;context:ActionExecutionContext;mutating:boolean;verification?:boolean}):Promise<ActionOperationResult>;
  executeControl(job:JobRow,runtime:RuntimeContext,input:{step_id:string;machine_id:string;workspace_id?:string|null;profile_id?:string|null;target_id:string;kind:string;verb:string;grant:PolicyGrant;policy_revision:number;max_log_bytes:number;mutating:boolean}):Promise<ActionOperationResult>;
}
async function reserve(db:Pool,job:JobRow,payload:CapturedAction):Promise<boolean> {
  const client=await db.connect();
  const keys=[`action:${payload.action_id}`,...(payload.helper?[`target:${payload.machine_id}:${payload.helper.target_id}`]:[])].sort();
  try {
    await client.query('BEGIN');
    for(const key of keys) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
      const occupied=await client.query("SELECT id FROM resource_reservations WHERE resource_type='action' AND resource_id=$1 AND job_id<>$2 AND state IN ('held','uncertain') LIMIT 1",[key,job.id]);
      if(occupied.rows.length) {await client.query('ROLLBACK');return false;}
      await client.query("INSERT INTO resource_reservations(id,resource_type,resource_id,job_id,state) SELECT $1,'action',$2,$3,'held' WHERE NOT EXISTS(SELECT 1 FROM resource_reservations WHERE resource_type='action' AND resource_id=$2 AND job_id=$3 AND state IN ('held','uncertain'))",[randomUUID(),key,job.id]);
    }
    await client.query('COMMIT');return true;
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
async function release(db:Pool,jobId:string) {await db.query("UPDATE resource_reservations SET state='released' WHERE job_id=$1 AND resource_type='action' AND state IN ('held','uncertain')",[jobId]);}
async function audit(db:Pool,job:JobRow,action:string,outcome:string,details:unknown) {await db.query('INSERT INTO audit_events(actor_id,action,target,outcome,details) VALUES($1,$2,$3,$4,$5)',[job.requester_id,action,job.id,outcome,details]);}
async function retainResult(runtime:RuntimeContext,job:JobRow,result:unknown) {
  await runtime.assertLease();
  const updated=await runtime.db.query('UPDATE jobs SET result=$4 WHERE id=$1 AND lease_owner=$2 AND fence=$3 AND lease_until>now()',[job.id,job.lease_owner,job.fence,result]);
  if(!updated.rowCount) throw Error('action_result_lease_lost');
}
async function executionEvidence(db:Pool,jobId:string) {
  const rows=(await db.query("SELECT id,step_id,outcome->'before_checkpoint'->>'id' AS before_checkpoint_id,outcome->'after_checkpoint'->>'id' AS after_checkpoint_id FROM operations WHERE job_id=$1 ORDER BY created_at,id",[jobId])).rows;
  return Promise.all(rows.map(async row=>{
    const changes=(await db.query('SELECT id,path,kind,before_hash,after_hash,details FROM file_changes WHERE job_id=$1 AND operation_id=$2 ORDER BY path,id LIMIT 201',[jobId,row.id])).rows;
    const count=Number((await db.query('SELECT count(*) AS count FROM file_changes WHERE job_id=$1 AND operation_id=$2',[jobId,row.id])).rows[0].count);
    return {operation_id:row.id,step_id:row.step_id,before_checkpoint_id:row.before_checkpoint_id??null,after_checkpoint_id:row.after_checkpoint_id??null,changed_files:changes.slice(0,200),changed_file_count:count,changes_truncated:count>200};
  }));
}
async function observeTarget(db:Pool,payload:CapturedAction,result:Extract<ActionOperationResult,{state:'known'}>) {
  if(!payload.helper||typeof result.result?.status!=='string'||!succeeded(result)) return;
  await db.query('INSERT INTO service_observations(target_id,state,reason,observed_at) VALUES($1,$2,$3,now())',[payload.helper.target_id,result.result.status,'Durable host helper operation receipt']);
  await db.query("UPDATE service_targets SET config=config||jsonb_build_object('helper_verified_at',now()::text,'enrollment_state','verified') WHERE id=$1",[payload.helper.target_id]);
}
const succeeded=(r:Extract<ActionOperationResult,{state:'known'}>)=>['succeeded','completed'].includes(r.status)&&(r.exit_code===undefined||r.exit_code===null||r.exit_code===0);
export const verificationPassed=(result:Extract<ActionOperationResult,{state:'known'}>,expectedExitCode:number)=>['succeeded','completed','failed'].includes(result.status)&&result.exit_code===expectedExitCode;

/** Each stable step is reconciled by the injected durable operation layer. */
export function createActionHandler(operations:ActionOperations):JobHandler {
  return async(job,runtime)=>{
    const payload=job.payload as unknown as CapturedAction;
    if(payload.schema_version!==1||!payload.action_definition||!payload.grant) {await runtime.fail('saved_action_payload_invalid');return;}
    const outstanding=(await runtime.db.query("SELECT id FROM operations WHERE job_id=$1 AND status NOT IN ('succeeded','failed','cancelled','rejected') LIMIT 1",[job.id])).rows.length>0;
    if(!outstanding) {
      if(await runtime.cancelled()) {await release(runtime.db,job.id);await runtime.cancel('cancelled_before_action_dispatch');return;}
      try {await revalidateCapturedAction(runtime.db,job.requester_id,payload);} catch(error) {
        const reason=error instanceof Error?error.message:'action_scope_denied';
        await audit(runtime.db,job,'action.dispatch','denied',{reason});await release(runtime.db,job.id);await runtime.fail(reason);return;
      }
    }
    if(!await reserve(runtime.db,job,payload)) {await runtime.wait('action_target_busy',5);return;}
    const accept=async(result:ActionOperationResult):Promise<Extract<ActionOperationResult,{state:'known'}>|null>=>{
      if(result.state==='pending') {await runtime.wait(result.reason,5);return null;}
      if(result.state==='unknown') {await runtime.db.query("UPDATE resource_reservations SET state='uncertain' WHERE job_id=$1 AND resource_type='action' AND state='held'",[job.id]);await runtime.interrupt(result.reason);return null;}
      if(result.status==='cancelled') {await release(runtime.db,job.id);await runtime.cancel('host_action_cancelled');return null;}
      return result;
    };
    const context=():ActionExecutionContext|null=>{
      const ws=payload.workspace_snapshot;
      if(!ws||!payload.workspace_id||!payload.execution_identity_id) return null;
      return {execution_machine_id:payload.machine_id,execution_identity_id:payload.execution_identity_id,workspace_id:payload.workspace_id,workspace_revision:Number(ws.revision),environment_id:ws.environment_id as string|null,environment_generation:ws.environment_generation as number|null,profile_id:payload.profile_id,profile_revision:payload.profile_snapshot?Number(payload.profile_snapshot.revision):null,policy_revision:payload.grant!.revision,limits:payload.limits};
    };
    let primary:Extract<ActionOperationResult,{state:'known'}>|null=null;
    if(payload.command) {
      const execution=context();
      if(!execution) {await release(runtime.db,job.id);await runtime.wait('execution_identity_unconfigured',30);return;}
      primary=await accept(await operations.executeCommand(job,runtime,{step_id:'action_command',command:{executable:payload.command.executable,args:payload.command.args,env:payload.command.env},tool:'actions.run',grant:payload.grant,context:execution,mutating:true}));
    } else if(payload.helper) {
      primary=await accept(await operations.executeControl(job,runtime,{step_id:'action_control',machine_id:payload.machine_id,workspace_id:payload.workspace_id,profile_id:payload.profile_id,target_id:payload.helper.target_id,kind:payload.helper.type,verb:payload.helper.operation,grant:payload.grant,policy_revision:payload.grant.revision,max_log_bytes:payload.helper.max_log_bytes,mutating:!['status','logs'].includes(payload.helper.operation)}));
    }
    if(!primary) return;
    if(!succeeded(primary)) {await audit(runtime.db,job,'action.finished','failed',{operation_id:primary.operation_id,exit_code:primary.exit_code??null});await retainResult(runtime,job,{operation_id:primary.operation_id,exit_code:primary.exit_code??null,verification:{status:'not_run'},execution_evidence:await executionEvidence(runtime.db,job.id)});await release(runtime.db,job.id);await runtime.fail('saved_action_operation_failed');return;}
    if(payload.helper?.operation==='status'&&typeof primary.result?.status!=='string') {await retainResult(runtime,job,{operation_id:primary.operation_id,verification:{status:'not_run'}});await release(runtime.db,job.id);await runtime.fail('helper_status_evidence_missing');return;}
    if(payload.helper&&['status','logs'].includes(payload.helper.operation)) await observeTarget(runtime.db,payload,primary);
    const verification:{status:string;operation_id?:string;expected?:unknown;observed?:unknown}={status:'not_run'};
    const allowNewPhase=async(stepId:string)=>{
      if((await runtime.db.query('SELECT id FROM operations WHERE job_id=$1 AND step_id=$2',[job.id,stepId])).rows.length) return true;
      try {await revalidateCapturedAction(runtime.db,job.requester_id,payload);return true;} catch(error) {
        const reason=error instanceof Error?error.message:'action_scope_changed';
        await audit(runtime.db,job,'action.verification','denied',{reason,operation_id:primary!.operation_id});
        await retainResult(runtime,job,{operation_id:primary!.operation_id,verification:{status:'not_run',reason}});
        await release(runtime.db,job.id);await runtime.fail(reason);return false;
      }
    };
    if(payload.verification) {
      if(!await allowNewPhase('action_verification')) return;
      const execution=context();
      if(!execution) {await release(runtime.db,job.id);await runtime.fail('verification_identity_unconfigured');return;}
      const checked=await accept(await operations.executeCommand(job,runtime,{step_id:'action_verification',command:{executable:payload.verification.command.executable,args:payload.verification.command.args,env:payload.verification.command.env},tool:'actions.run',grant:payload.grant,context:execution,mutating:true,verification:true}));
      if(!checked) return;
      Object.assign(verification,{status:verificationPassed(checked,payload.verification.expected_exit_code)?'passed':'failed',operation_id:checked.operation_id,expected:payload.verification.expected_exit_code,observed:checked.exit_code??null});
    } else if(payload.helper && ['start','stop','restart'].includes(payload.helper.operation)) {
      if(!await allowNewPhase('action_postcondition')) return;
      const checked=await accept(await operations.executeControl(job,runtime,{step_id:'action_postcondition',machine_id:payload.machine_id,workspace_id:payload.workspace_id,profile_id:payload.profile_id,target_id:payload.helper.target_id,kind:payload.helper.type,verb:'status',grant:payload.grant,policy_revision:payload.grant.revision,max_log_bytes:payload.helper.max_log_bytes,mutating:false}));
      if(!checked) return;
      const expected=payload.helper.operation==='stop'?'stopped':'running';
      const observed=checked.result?.status;
      await observeTarget(runtime.db,payload,checked);
      Object.assign(verification,{status:succeeded(checked)&&observed===expected?'passed':'failed',operation_id:checked.operation_id,expected,observed});
    }
    await runtime.appendEvent('action.verification',verification);
    await audit(runtime.db,job,'action.finished',verification.status==='failed'?'verification_failed':'success',{action_id:payload.action_id,action_revision:payload.action_revision,operation_id:primary.operation_id,verification});
    await release(runtime.db,job.id);
    if(verification.status==='failed') {await retainResult(runtime,job,{action_id:payload.action_id,action_revision:payload.action_revision,operation_id:primary.operation_id,verification,execution_evidence:await executionEvidence(runtime.db,job.id)});await runtime.fail('saved_action_verification_failed');return;}
    await runtime.complete({action_id:payload.action_id,action_revision:payload.action_revision,affected_target:payload.affected_target,operation_id:primary.operation_id,exit_code:primary.exit_code??null,result:primary.result??null,verification,execution_evidence:await executionEvidence(runtime.db,job.id)});
  };
}
