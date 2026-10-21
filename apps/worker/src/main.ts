import { Pool } from 'pg';
import { writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { authorize } from '@homelab/policy';
import { AgentBroker,HostRpcError } from '@homelab/transport';
import { BlobStore,RootedHostFileAdapter,createProjectExportHandler,createCheckpointForJob,publishCheckpointChanges } from '@homelab/storage';
import { createActionHandler } from '@homelab/actions/handler';
import { executeProviderJob } from '@homelab/providers/jobs';
import { createSecretStore,parseMasterKey } from '../../api/src/core/secrets.js';
import { createCapabilityTestHandler } from '../../api/src/modules/machines/capability-jobs.js';
import { probeMachineCapability } from '../../api/src/modules/remote/probes.js';
import { startTelemetryMaintenance } from '../../api/src/modules/machines/retention.js';
import {createBackupHandler} from '../../api/src/modules/operations/worker.js';
import {createAttachmentLoader} from './attachments.js';
import { runWorker,type HandlerRegistry,type JobHandler } from './runtime.js';
import { createChatHandler } from './chat.js';
import { createAgentHandler } from './agent.js';
import { createAgentTools } from './agent-tools.js';
import { createCommandHandler } from './commands.js';
import { createOperationExecutor } from './operations.js';
import {createTerminalHandler} from './terminal.js';
import {expectedMachineGeneration} from './authority.js';
import {assertRuntimeSchema} from './startup.js';
import { reserveProvider,releaseProvider,markProviderUncertain } from './reservations.js';
import type { AgentDependencies } from './agent.js';
import type {ProviderSnapshot} from '@homelab/providers';
import type {PolicyGrant} from '@homelab/contracts';
const db=new Pool({connectionString:process.env.DATABASE_URL,max:10});
const secrets=createSecretStore(db,parseMasterKey(process.env.MASTER_KEY));
const broker=new AgentBroker(db),store=new BlobStore(resolve(process.env.ARTIFACT_ROOT??join(process.cwd(),'data','artifacts')),64*1024*1024,{db});
let stopTransientMaintenance=()=>{};
const files=new RootedHostFileAdapter((machine,method,path,body,options)=>broker.rpc(machine,method,path,body,options));
const scopedFiles=(job:{id:string;requester_id:string;fence:string;lease_owner:string|null;workspace_id?:string|null;payload:Record<string,unknown>},runtime:{signal?:AbortSignal},tool:string)=>new RootedHostFileAdapter((machine,method,path,body,options)=>broker.rpc(machine,method,path,body,{...options,expectedMachineGeneration:expectedMachineGeneration(job,machine),ownerId:job.requester_id,signal:runtime.signal,scopeGrantId:(job.payload.grant as PolicyGrant|undefined)?.id,scopeTool:tool,jobGuard:{job_id:job.id,fence:job.fence,lease_owner:job.lease_owner??undefined,workspace_id:job.workspace_id??job.payload.workspace_id as string|undefined}}));
const checkpoint:AgentDependencies['checkpoint']=async(job,runtime,reason)=>{
 const workspace=(await db.query('SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2',[job.workspace_id??job.context?.workspace_id,job.requester_id])).rows[0];
 if(!workspace)throw new Error('checkpoint_workspace_unavailable');workspace.quota_bytes=Number(workspace.quota_bytes);
 const frozen=job.context??job.payload.execution_context as import('@homelab/contracts').ExecutionContext|undefined;
 if(frozen&&(workspace.state!=='active'||workspace.machine_id!==frozen.execution_machine_id||workspace.revision!==frozen.workspace_revision||workspace.environment_id!==frozen.environment_id||workspace.environment_generation!==frozen.environment_generation))throw new Error('checkpoint_workspace_revision_conflict');
 const grant=job.payload.grant as PolicyGrant|undefined;
 const permission=['file.read','file.write','run_command','actions.run','project.export'].find(tool=>grant?.tools.includes(tool));
 if(!permission)throw new Error('checkpoint_scope_denied');
 const captured=await createCheckpointForJob({db,store,adapter:scopedFiles(job,runtime,permission),workspace,job,reason,assertLease:()=>runtime.assertLease()});
 await runtime.appendEvent('checkpoint.created',{id:captured.id,reason,manifest_hash:captured.manifest_hash,consistency:captured.consistency,exclusions:captured.exclusions});
 return {id:captured.id,manifest_hash:captured.manifest_hash,consistency:captured.consistency};
};
const publishChanges:NonNullable<import('./operations.js').OperationDependencies['publishChanges']>=async(job,runtime,operation_id,before,after)=>{
 const ids=[(before as {id:string}).id,(after as {id:string}).id];const rows=(await db.query('SELECT * FROM checkpoints WHERE id=ANY($1::uuid[])', [ids])).rows;
 return publishCheckpointChanges({db,store,job,operation_id,before:rows.find(r=>r.id===ids[0]),after:rows.find(r=>r.id===ids[1]),attribution:'recorded_tool',assertLease:runtime.assertLease});
};
const operations=createOperationExecutor({broker,checkpoint,publishChanges});
const abort=new AbortController();for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>abort.abort());
const providerHandler:JobHandler=async(job,runtime)=>{
 if(job.recovery_only&&!(await db.query("SELECT id FROM job_events WHERE job_id=$1 AND type='provider.request.started' LIMIT 1",[job.id])).rowCount){await runtime.wait('capacity_recovery_only',2);return;}
 const requiresSlot=job.kind==='provider.probe'||(job.kind==='provider.management'&&job.payload.action!=='download-status');
 const snapshot=job.payload.provider as ProviderSnapshot;
 if(requiresSlot&&!await reserveProvider(db,snapshot.runtimePoolId,job.id,job.payload.model_id as string|undefined,snapshot.maxModelConcurrency??1,job.kind==='provider.management',job)){await runtime.wait('provider_capacity',5);return;}
 const stop=new AbortController(),onLeaseLost=()=>stop.abort();runtime.signal.addEventListener('abort',onLeaseLost,{once:true});
 const cancellation=setInterval(()=>{void runtime.cancelled().then(cancel=>{if(cancel)stop.abort();}).catch(()=>stop.abort());},1000);
 try{
  await executeProviderJob(job,{...runtime,signal:stop.signal,
   complete:async result=>{if(requiresSlot)await releaseProvider(db,job.id,job);await runtime.complete(result);},
   fail:async reason=>{if(requiresSlot)await releaseProvider(db,job.id,job);await runtime.fail(reason);},
   interrupt:async reason=>{if(requiresSlot)await markProviderUncertain(db,job.id,job);await runtime.interrupt(reason);}},(owner,id)=>secrets.get(owner,id));
 }catch(error){if(requiresSlot)await markProviderUncertain(db,job.id,job);throw error;}finally{clearInterval(cancellation);runtime.signal.removeEventListener('abort',onLeaseLost);stop.abort();}
};
const exportHandler=createProjectExportHandler({db,store,adapterForJob:job=>scopedFiles(job,{},'project.export'),authorize:async(owner,workspace,captured)=>{
 const current=(await db.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2',[captured?.id,owner])).rows[0];
 const decision=authorize({actor:{id:owner,role:'owner'},tool:'project.export',machine_id:workspace.machine_id,workspace_id:workspace.id,grant:captured,current_grant:current});if(!decision.allowed)throw new Error(decision.code);
}});
const withReconnect=(handler:JobHandler):JobHandler=>async(job,runtime)=>{try{await handler(job,runtime);}catch(error){if(error instanceof HostRpcError)await runtime.wait(error.code,3);else throw error;}};
const handlers:HandlerRegistry={chat:createChatHandler((owner,id)=>secrets.get(owner,id),undefined,createAttachmentLoader(store)),command:withReconnect(createCommandHandler(operations)),
 workspace_terminal:createTerminalHandler({broker,checkpoint,publishChanges,operations}),
 agent:withReconnect(createAgentHandler({resolveCredential:(owner,id)=>secrets.get(owner,id),checkpoint,loadAttachments:createAttachmentLoader(store),executeTool:createAgentTools({broker,files,scopedFiles,store,operations,checkpoint,publishChanges})})),
 saved_action:withReconnect(createActionHandler(operations)),project_export:withReconnect(exportHandler),capability_test:createCapabilityTestHandler({broker,operations,probe:(machine,owner,capability,authSessionId)=>probeMachineCapability(db,secrets,machine,owner,capability,authSessionId)}),
 'provider.connectivity':providerHandler,'provider.discovery':providerHandler,'provider.runtime':providerHandler,'provider.probe':providerHandler,'provider.management':providerHandler};
handlers['operations.backup']=createBackupHandler({broker});
const healthFile=process.env.WORKER_HEALTH_FILE??join(tmpdir(),'homelab-worker-health');
let stopMaintenance=async()=>{},heartbeat:ReturnType<typeof setInterval>|undefined;
try{await assertRuntimeSchema(db);stopTransientMaintenance=broker.startTransientMaintenance();stopMaintenance=startTelemetryMaintenance(db,()=>process.stderr.write('Telemetry maintenance unavailable\n'));heartbeat=setInterval(()=>{void db.query('SELECT 1').then(()=>writeFile(healthFile,new Date().toISOString(),{mode:0o600})).catch(()=>undefined);},5000);await writeFile(healthFile,new Date().toISOString(),{mode:0o600});if(process.env.DISPATCH_ENABLED==='true'&&process.env.RESTORE_MODE!=='true')await runWorker(db,handlers,abort.signal);else await new Promise<void>(resolve=>{if(abort.signal.aborted)resolve();else abort.signal.addEventListener('abort',()=>resolve(),{once:true});});}catch(error){process.stderr.write(`Worker stopped: ${error instanceof Error&&error.message.startsWith('worker_schema_')?error.message:'runtime/database unavailable'}\n`);process.exitCode=1;}finally{clearInterval(heartbeat);stopTransientMaintenance();await broker.expireTerminalPayloads().catch(()=>undefined);await stopMaintenance();await db.end();}


