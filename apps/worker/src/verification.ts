import type {PolicyGrant} from '@homelab/contracts';
import type {JobRow} from './types.js';import type {RuntimeContext} from './runtime.js';
import type {createOperationExecutor,ExecutionContext,OperationResult} from './operations.js';
import {resolveProfile,type ProfileDefinition} from './authority.js';import {digest} from './hash.js';
type KnownVerification={state:'known';verification_status:'passed'|'failed'|'not_run';reason?:string;verifications:unknown[]};
export type VerificationResult=KnownVerification|{state:'pending';reason:string}|{state:'unknown';reason:string};
/** Fixed profile verification uses separate durable operations, never model prose. */
export async function verifyConfigured(job:JobRow,runtime:RuntimeContext,operations:ReturnType<typeof createOperationExecutor>):Promise<VerificationResult>{
 const context=job.context??job.payload.execution_context as ExecutionContext|undefined;if(!context)return {state:'known',verification_status:'failed',reason:'verification_execution_context_missing',verifications:[]};
 const grant=job.payload.grant as PolicyGrant,verifications:unknown[]=[];
 const run=async(step:string,command:{executable:string;args:string[]})=>operations.executeCommand(job,runtime,{step_id:step,command,tool:'run_command',grant,context,mutating:true,verification:true});
 const unresolved=(await runtime.db.query("SELECT step_id,request FROM operations WHERE job_id=$1 AND step_id LIKE 'verification:%' AND status NOT IN ('succeeded','failed','cancelled','rejected') ORDER BY created_at",[job.id])).rows;
 for(const operation of unresolved){const result=await run(operation.step_id,operation.request.command);if(result.state!=='known')return result;verifications.push(result);}
 if(await runtime.cancelled())return {state:'known',verification_status:'not_run',reason:'cancelled_before_verification',verifications};
 const snapshot=job.payload.profile_snapshot as ProfileDefinition|{definition:ProfileDefinition}|undefined;
 let profile:ProfileDefinition|null;try{profile=await resolveProfile(runtime.db,job.requester_id,context,undefined,snapshot&&'definition'in snapshot?snapshot.definition:snapshot);}catch(error){return {state:'known',verification_status:'failed',reason:error instanceof Error?error.message:'profile_unavailable',verifications};}
 const checks=profile?.verification_commands??[];
 if(!checks.length)return {state:'known',verification_status:profile?.required_verification?'failed':'not_run',...(profile?.required_verification?{reason:'required_verification_missing'}:{}),verifications};
 let passed=true;
 for(const command of checks){const step=`verification:${digest(command)}`;
  const existing=(await runtime.db.query('SELECT id FROM operations WHERE job_id=$1 AND step_id=$2',[job.id,step])).rows[0];
  if(!existing){if(job.recovery_only)return {state:'pending',reason:'capacity_recovery_only'};if(await runtime.cancelled())return {state:'known',verification_status:'not_run',reason:'cancelled_before_verification',verifications};const count=(await runtime.db.query('SELECT COUNT(*)::int n FROM operations WHERE job_id=$1',[job.id])).rows[0].n;if(count>=context.limits.max_tool_steps)return {state:'known',verification_status:'failed',reason:'max_tool_steps_before_verification',verifications};}
  const result:OperationResult=await run(step,command);if(result.state!=='known')return result;verifications.push({command,...result});const success=result.status==='succeeded'&&result.exit_code===0;passed&&=success;
  if(!(await runtime.db.query("SELECT id FROM job_events WHERE job_id=$1 AND type='verification.result' AND payload->>'operation_id'=$2 LIMIT 1",[job.id,result.operation_id])).rowCount)await runtime.appendEvent('verification.result',{operation_id:result.operation_id,kind:`command:${digest(command)}`,passed:success,evidence:{command,exit_code:result.exit_code,status:result.status}});
 }
 return {state:'known',verification_status:passed?'passed':'failed',...(passed?{}:{reason:'verification_failed'}),verifications};
}
