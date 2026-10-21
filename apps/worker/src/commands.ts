import type {PolicyGrant} from '@homelab/contracts';
import type {JobHandler} from './runtime.js';
import type {createOperationExecutor,ExecutionContext} from './operations.js';
import {verifyConfigured} from './verification.js';
export function createCommandHandler(operations:ReturnType<typeof createOperationExecutor>):JobHandler{return async(job,runtime)=>{
 const context=job.context??job.payload.execution_context as ExecutionContext|undefined;
 if(!context)throw new Error('command_execution_context_required');
 const result=await operations.executeCommand(job,runtime,{step_id:'command:0',command:job.payload.command as {executable:string;args:string[]},tool:'run_command',grant:job.payload.grant as PolicyGrant,context,mutating:true});
 if(result.state==='pending'){await runtime.wait(result.reason,2);return;}
 if(result.state==='unknown'){await runtime.interrupt(result.reason);return;}
 if(result.status==='cancelled'){await runtime.cancel('host_command_cancelled');return;}
 if(result.status!=='succeeded'||result.exit_code!==0){await runtime.fail('command_failed',{...result,verification_status:'not_run'});return;}
 const verification=await verifyConfigured(job,runtime,operations);
 if(verification.state==='pending'){await runtime.wait(verification.reason,2);return;}if(verification.state==='unknown'){await runtime.interrupt(verification.reason);return;}
 if(await runtime.cancelled()){await runtime.cancel('command_and_verification_stop_confirmed');return;}
 if(verification.verification_status==='failed'){await runtime.fail(verification.reason??'verification_failed',{...result,...verification});return;}
 await runtime.complete({...result,...verification});
};}
