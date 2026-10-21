import test from 'node:test';

import assert from 'node:assert/strict';

import {randomUUID} from 'node:crypto';

import {Pool} from 'pg';

import {ProfileDefinitionSchema,RunContextSchema,type PolicyGrant} from '@homelab/contracts';

import type {ProviderAdapter,ProviderSnapshot,ToolCall} from '@homelab/providers';

import {migrate} from '../../api/src/core/migrate.js';

import {createAgentHandler} from './agent.js';

import {createChatHandler} from './chat.js';

import {createTerminalHandler} from './terminal.js';

import {createOperationExecutor} from './operations.js';
import {createCommandHandler} from './commands.js';

import {captureExecution} from '../../api/src/modules/jobs/execution.js';

import {ExecutionContextSchema} from '@homelab/contracts';

import {HostRpcError} from '@homelab/transport';

import Fastify from 'fastify';

import websocket from '@fastify/websocket';

import {WebSocket} from 'ws';

import registerJobs from '../../api/src/modules/jobs/index.js';

import {BlobStore} from '@homelab/storage';

import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';

import {claimJob,runClaimedJob} from './runtime.js';

import {submitJob,cancelJob} from './queue.js';

import {transaction} from './database.js';
import {accountOutput,remainingOutput} from './output.js';
import {reserveProvider,releaseProvider,markProviderUncertain} from './reservations.js';
import {wireGrant} from './authority.js';

import {authorize} from '@homelab/policy';

import {createAgentTools} from './agent-tools.js';

import type {AgentBroker} from '@homelab/transport';

test('agent boundaries stop unstarted tools and revoked provider context',{skip:!process.env.HOMELAB_LOCAL_PG_URL?'Disposable PostgreSQL opt-in required':false,timeout:30000},async t=>{

 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));const admin=new Pool({connectionString:url.href});const name=`agent_boundary_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined;

 try{

  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new Pool({connectionString:url.href});await migrate(db);

  const owner=randomUUID(),machine=randomUUID(),project=randomUUID(),workspace=randomUUID(),identity=randomUUID(),pool=randomUUID(),provider=randomUUID(),profileId=randomUUID(),grantId=randomUUID(),secret=randomUUID();

  await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'boundary@example.invalid','fixture')",[owner]);

  await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'explicit fixture','unknown')",[machine,owner]);

  const machine_identity_generations={[machine]:(await db.query('SELECT identity_generation FROM machines WHERE id=$1',[machine])).rows[0].identity_generation};

  await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'boundary fixture')",[project,owner]);

  await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path) VALUES($1,$2,$3,'fixture','native',$4,'fixture','/not-accessed','/not-accessed')",[workspace,owner,project,machine]);

  await db.query("INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity) VALUES($1,$2,$3,'fixture','not-launched')",[identity,owner,machine]);

  await db.query("INSERT INTO provider_runtime_pools(id,owner_id,name) VALUES($1,$2,'fixture')",[pool,owner]);

  await db.query("INSERT INTO providers(id,owner_id,name,adapter,endpoint,runtime_pool_id) VALUES($1,$2,'fixture','ollama','http://fixture.invalid',$3)",[provider,owner,pool]);

  await db.query("INSERT INTO agent_profiles(id,owner_id,name) VALUES($1,$2,'boundary fixture')",[profileId,owner]);

  const profile=ProfileDefinitionSchema.parse({instructions:'Explicit injected fixture. No actual host or provider.',tools:['file.write'],machine_ids:[machine],workspace_ids:[workspace],secret_ids:[secret],limits:{max_tool_steps:4,wall_time_seconds:10,per_command_timeout_seconds:1,max_output_bytes:4096}});

  await db.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition) VALUES($1,1,$2,$3::jsonb)',[profileId,profile.instructions,JSON.stringify(profile)]);

  await db.query("INSERT INTO capability_probes(id,owner_id,provider_id,model_id,capability,state,config_revision) VALUES($1,$2,$3,'fixture','tools','tested_pass',1)",[randomUUID(),owner,provider]);

  const grant:PolicyGrant={id:grantId,owner_id:owner,revision:1,tools:['agent.run','file.write'],machine_ids:[machine],workspace_ids:[workspace],profile_ids:[profileId],secret_ids:[secret],expires_at:null,revoked_at:null};

  await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids,profile_ids,secret_ids) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb)',[grantId,owner,JSON.stringify(grant.tools),JSON.stringify(grant.machine_ids),JSON.stringify(grant.workspace_ids),JSON.stringify(grant.profile_ids),JSON.stringify(grant.secret_ids)]);

  await db.query('UPDATE runtime_control SET dispatch_enabled=true');

  for(const mode of ['cancel','deadline','grant_revoke','secret_revoke','profile_secret_revoke'] as const)await t.test(mode,async()=>{

   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query('UPDATE permission_grants SET revoked_at=NULL,secret_ids=$2::jsonb WHERE id=$1',[grantId,JSON.stringify([secret])]);

   const snapshot:ProviderSnapshot={id:provider,revision:1,adapter:'ollama',baseUrl:'http://fixture.invalid',runtimePoolId:pool,routing:'unknown',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:1000,...(mode.includes('secret')?{credentialRef:secret}:{})};

   const context=RunContextSchema.parse({schema_version:1,provider_id:provider,provider_config_revision:1,provider_adapter:'ollama',provider_endpoint:snapshot.baseUrl,model_id:'fixture',profile_id:profileId,profile_revision:1,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:{...profile.limits,wall_time_seconds:mode==='deadline'?1:10}});

   const job=await submitJob(db!,{requester_id:owner,idempotency_key:mode,context,kind:'agent',payload:{machine_identity_generations,prompt:'Explicit injected safety fixture',profile_snapshot:profile,provider_snapshot:snapshot,grant:wireGrant(grant)},modifies_workspace:true});

   let requests=0;const calls:ToolCall[]=[{id:'one',name:'write_file',arguments:{path:'one.txt',content:'one',expected_sha256:null}},{id:'two',name:'write_file',arguments:{path:'two.txt',content:'two',expected_sha256:null}}];

   const fixture:ProviderAdapter={async discoverModels(){return [];},async getRuntimeState(){return {observedAt:new Date().toISOString(),residency:'unknown',models:[],providerActiveRequests:null};},getCapabilities(){return {tools:'unknown',images:'unknown',cancellation:'client-abort-only'};},async manage(){return {};},async *streamChat(){requests++;yield {type:'completed',requestedModel:'fixture',resolvedModel:'fixture',finishReason:requests===1?'tool_calls':'stop',toolCalls:requests===1?calls.slice(0,mode==='cancel'||mode==='deadline'?2:1):[],usage:{source:'provider',inputTokens:1,outputTokens:1,cachedInputTokens:null,loadSeconds:null,promptEvaluationSeconds:null,generationSeconds:null,promptTokensPerSecond:null,decodeTokensPerSecond:null},wallSeconds:0.01,firstContentSeconds:null};}};

   let mutations=0;const handler=createAgentHandler({resolveCredential:async()=>{throw new Error('No actual fixture credential');},makeAdapter:()=>fixture,checkpoint:async()=>({explicit_fixture:true}),executeTool:async()=>{

    mutations++;

    if(mode==='cancel')await cancelJob(db!,job.id,owner);

    if(mode==='deadline')await new Promise(resolve=>setTimeout(resolve,1100));

    if(mode==='grant_revoke')await db!.query('UPDATE permission_grants SET revoked_at=now() WHERE id=$1',[grantId]);

    if(mode==='secret_revoke')await db!.query("UPDATE permission_grants SET secret_ids='[]' WHERE id=$1",[grantId]);

    if(mode==='profile_secret_revoke'){await db!.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition) VALUES($1,2,$2,$3::jsonb)',[profileId,profile.instructions,JSON.stringify({...profile,secret_ids:[]})]);await db!.query('UPDATE agent_profiles SET current_revision=2 WHERE id=$1',[profileId]);}

    return {state:'completed',content:{fixture_mutation:mutations}};

   }});

   const claimed=await claimJob(db!,`boundary-${mode}`);assert.equal(claimed?.id,job.id);await runClaimedJob(db!,claimed!,{agent:handler});assert.equal(mutations,1);assert.equal(requests,1,'No context or secret may be sent in a second inference');const result=(await db!.query('SELECT state,reason FROM jobs WHERE id=$1',[job.id])).rows[0];assert.equal(result.state,mode==='cancel'?'cancelled':'failed');const reason=mode==='cancel'?'cancelled_before_next_tool':mode==='deadline'?'job_wall_time_limit':mode==='grant_revoke'?'grant_revoked':mode==='secret_revoke'?'grant_secret_denied':'profile_secret_denied';assert.equal(result.reason,reason);assert.equal((await db!.query('SELECT COUNT(*)::int AS count FROM operations WHERE job_id=$1',[job.id])).rows[0].count,0);

  });

  for(const mode of ['grant_revocation','broker_profile_denial','original_id_recovery','output_flood','output_without_optin','logout_before_launch','grant_during_read','logout_during_read'] as const)await t.test(`terminal ${mode}`,async()=>{

   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query("UPDATE permission_grants SET revoked_at=NULL,tools='[\"workspace.terminal\",\"run_command\"]' WHERE id=$1",[grantId]);

   const context=ExecutionContextSchema.parse({schema_version:1,profile_id:null,profile_revision:null,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:{max_tool_steps:4,wall_time_seconds:10,per_command_timeout_seconds:2,max_output_bytes:4096}});

   const authSession=randomUUID(),terminalId=randomUUID();await db!.query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,'fixture',now()+interval '1 hour')",[authSession,owner,randomUUID()]);

   const job=await submitJob(db!,{requester_id:owner,idempotency_key:`terminal-${mode}`,kind:'workspace_terminal',context:null,workspace_id:workspace,modifies_workspace:true,payload:{machine_identity_generations,execution_context:context,grant:wireGrant({...grant,tools:['workspace.terminal','run_command']}),retain_output:mode==='output_flood'||mode.endsWith('_during_read')}});

   if(mode!=='logout_before_launch')await db!.query("INSERT INTO operations(id,job_id,step_id,request_hash,request,machine_id,fence,status,replay_class) VALUES($1,$2,'terminal','fixture','{}',$3,1,'running','mutating')",[terminalId,job.id,machine]);await db!.query('INSERT INTO terminal_sessions(id,owner_id,workspace_id,job_id,operation_id,machine_id,auth_session_id) VALUES($1,$2,$3,$4,$7,$5,$6)',[terminalId,owner,workspace,job.id,machine,authSession,mode==='logout_before_launch'?null:terminalId]);

   if(mode==='logout_before_launch')await db!.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[authSession]);if(mode==='grant_revocation')await db!.query('UPDATE permission_grants SET revoked_at=now() WHERE id=$1',[grantId]);

   let snapshots=0;const calls:{method:string;path:string;options:any}[]=[];const broker={rpc:async(_machine:string,method:string,path:string,_body:any,options:any)=>{calls.push({method,path,options});assert.ok(path.includes(terminalId));if(mode.endsWith('_during_read')&&method==='GET'){if(mode==='grant_during_read')await db!.query('UPDATE permission_grants SET revoked_at=now() WHERE id=$1',[grantId]);else await db!.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[authSession]);return {record:{id:terminalId,state:'running'},data:Buffer.from('late-private-output').toString('base64'),offset:0,next_offset:19};}if(mode==='broker_profile_denial'&&method==='GET')throw new HostRpcError('profile_network_reduced','fixture denial','fixture',403,false);if(mode==='output_flood'||mode==='output_without_optin'){const after=Number(new URL(path,'http://fixture.invalid').searchParams.get('after'));return {record:{id:terminalId,state:'exited',exit_code:0,output_offset:16384},data:Buffer.alloc(8192,120).toString('base64'),offset:after,next_offset:after+8192};}if(mode!=='original_id_recovery')assert.equal(options.safetyCancellation,true);return {record:{id:terminalId,state:'exited',exit_code:0}};}} as unknown as AgentBroker;

   const handler=createTerminalHandler({broker,operations:{} as any,checkpoint:async()=>{snapshots++;return {id:'fixture'};}});const claimed=(await claimJob(db!,`terminal-${mode}`,30,job.id))!;assert.equal(claimed.id,job.id);await runClaimedJob(db!,claimed,{workspace_terminal:handler});

   assert.equal(calls.filter(c=>c.method==='POST'&&!c.path.endsWith('/cancel')).length,0,'Recovery must never create another native invocation');assert.equal(snapshots,['original_id_recovery','output_flood','output_without_optin'].includes(mode)?1:0);assert.equal((await db!.query('SELECT COUNT(*)::int n FROM workspace_locks WHERE job_id=$1',[job.id])).rows[0].n,0);assert.equal((await db!.query('SELECT state FROM jobs WHERE id=$1',[job.id])).rows[0].state,['original_id_recovery','output_flood','output_without_optin'].includes(mode)?'completed':'failed');if(mode.endsWith('_during_read'))assert.equal((await db!.query("SELECT count(*)::int n FROM job_events WHERE job_id=$1 AND type='terminal.output'",[job.id])).rows[0].n,0);if(mode.startsWith('output_')){const output=(await db!.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='terminal.output'",[job.id])).rows;assert.equal(output.reduce((sum,row)=>sum+Buffer.from(row.payload.data,'base64').length,0),mode==='output_flood'?4096:0);assert.equal((await db!.query("SELECT COUNT(*)::int n FROM job_events WHERE job_id=$1 AND type='terminal.output.gap'",[job.id])).rows[0].n,1);}

  });

  for(const mode of ['token_after_tool','capability_after_tool','capability_during_identity','verification_after_tool','verification_command_after_tool'] as const)await t.test(`current profile ${mode}`,async()=>{
   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query("UPDATE permission_grants SET revoked_at=NULL,tools='[\"agent.run\",\"file.write\",\"run_command\"]',secret_ids=$2 WHERE id=$1",[grantId,JSON.stringify([secret])]);
   const base={...profile,...(mode==='verification_command_after_tool'?{tools:['file.write','run_command'],execution_identity_ids:[identity]}:{})};await db!.query('UPDATE agent_profiles SET current_revision=1 WHERE id=$1',[profileId]);await db!.query('UPDATE agent_profile_revisions SET definition=$2 WHERE profile_id=$1 AND revision=1',[profileId,base]);
   const changed=async()=>{const definition={...base,...(mode==='token_after_tool'?{limits:{...base.limits,max_total_tokens:10}}:mode.startsWith('capability_')?{required_capabilities:['image_input']}:{required_verification:true,...(mode==='verification_command_after_tool'?{verification_commands:[{executable:'/fixture/check',args:[]}]}:{})})};await db!.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition) VALUES($1,2,$2,$3) ON CONFLICT(profile_id,revision) DO UPDATE SET definition=excluded.definition',[profileId,base.instructions,definition]);await db!.query('UPDATE agent_profiles SET current_revision=2 WHERE id=$1',[profileId]);};
   const snapshot:ProviderSnapshot={id:provider,revision:1,adapter:'ollama',baseUrl:'http://fixture.invalid',runtimePoolId:pool,routing:'unknown',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:1000},context=RunContextSchema.parse({schema_version:1,provider_id:provider,provider_config_revision:1,provider_adapter:'ollama',provider_endpoint:snapshot.baseUrl,model_id:'fixture',profile_id:profileId,profile_revision:1,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:base.limits});
   const job=await submitJob(db!,{requester_id:owner,idempotency_key:mode,context,kind:'agent',payload:{machine_identity_generations,prompt:'Explicit current-policy fixture',profile_snapshot:base,provider_snapshot:snapshot,grant:wireGrant({...grant,tools:['agent.run','file.write','run_command']})},modifies_workspace:true});let requests=0,mutations=0,checks=0;
   const adapter={discoverModels:async()=>{if(mode==='capability_during_identity')await changed();return [];},async *streamChat(){requests++;yield {type:'completed',requestedModel:'fixture',resolvedModel:'fixture',finishReason:'stop',toolCalls:requests===1?[{id:'write',name:'write_file',arguments:{path:'fixture.txt',content:'fixture',expected_sha256:null}}]:[],usage:{source:'provider',inputTokens:1,outputTokens:1},wallSeconds:0.01,firstContentSeconds:null};}} as unknown as ProviderAdapter;
   const handler=createAgentHandler({resolveCredential:async()=>'',makeAdapter:()=>adapter,checkpoint:async()=>({fixture:true}),executeTool:async(_job,_runtime,step)=>{if(step.call.name==='verify_command'){checks++;return {state:'completed',verification:{kind:'command:fixture',passed:true,evidence:{explicit_fixture:true}}};}mutations++;await changed();return {state:'completed',content:{fixture:true}};}});const claimed=(await claimJob(db!,mode,30,job.id))!;await runClaimedJob(db!,claimed,{agent:handler});
   const row=(await db!.query('SELECT state,reason,result FROM jobs WHERE id=$1',[job.id])).rows[0];assert.equal(requests,mode==='capability_during_identity'?0:mode.startsWith('verification_')?2:1);assert.equal(mutations,mode==='capability_during_identity'?0:1);assert.equal(checks,mode==='verification_command_after_tool'?1:0);assert.equal(row.state,mode==='verification_command_after_tool'?'completed':'failed');if(mode==='token_after_tool')assert.equal(row.reason,'profile_required_max_total_tokens_missing');else if(mode.startsWith('capability_'))assert.equal(row.reason,'model_tool_capability_unverified');else if(mode==='verification_after_tool')assert.equal(row.reason,'required_verification_missing');else assert.equal(row.result.verification_status,'passed');
   await db!.query('UPDATE agent_profiles SET current_revision=1 WHERE id=$1',[profileId]);await db!.query('UPDATE agent_profile_revisions SET definition=$2 WHERE profile_id=$1 AND revision=1',[profileId,profile]);
  });
  for(const mode of ['pass','fail','required_missing'] as const)await t.test(`manual configured verification ${mode}`,async()=>{
   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query("UPDATE permission_grants SET revoked_at=NULL,tools='[\"run_command\"]' WHERE id=$1",[grantId]);
   const selected={...profile,tools:['run_command'],execution_identity_ids:[identity],required_verification:true,verification_commands:mode==='required_missing'?[]:[{executable:'/fixture/fixed-check',args:['--exact']}]};await db!.query('UPDATE agent_profiles SET current_revision=1 WHERE id=$1',[profileId]);await db!.query('UPDATE agent_profile_revisions SET definition=$2 WHERE profile_id=$1 AND revision=1',[profileId,selected]);
   const context=ExecutionContextSchema.parse({schema_version:1,profile_id:profileId,profile_revision:1,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:profile.limits});const job=await submitJob(db!,{requester_id:owner,idempotency_key:`manual-${mode}`,context:null,workspace_id:workspace,kind:'command',modifies_workspace:true,payload:{machine_identity_generations,execution_context:context,profile_snapshot:selected,grant:wireGrant({...grant,tools:['run_command']}),command:{executable:'/fixture/primary',args:[]}}});
   const calls:any[]=[];const executor={executeCommand:async(_job:any,_runtime:any,input:any)=>{calls.push(input);return {state:'known',operation_id:randomUUID(),status:mode==='fail'&&input.step_id.startsWith('verification:')?'failed':'succeeded',exit_code:mode==='fail'&&input.step_id.startsWith('verification:')?7:0};}} as unknown as ReturnType<typeof createOperationExecutor>;
   const claimed=(await claimJob(db!,`manual-${mode}`,30,job.id))!;await runClaimedJob(db!,claimed,{command:createCommandHandler(executor)});const row=(await db!.query('SELECT state,reason,result FROM jobs WHERE id=$1',[job.id])).rows[0];assert.equal(calls.length,mode==='required_missing'?1:2);if(calls[1]){assert.deepEqual(calls[1].command,selected.verification_commands[0]);assert.equal(calls[1].mutating,true);assert.ok(calls[1].step_id.startsWith('verification:'));}assert.equal(row.state,mode==='pass'?'completed':'failed');assert.equal(row.result.verification_status,mode==='pass'?'passed':'failed');if(mode==='required_missing')assert.equal(row.reason,'required_verification_missing');
   await db!.query('UPDATE agent_profile_revisions SET definition=$2 WHERE profile_id=$1 AND revision=1',[profileId,profile]);await db!.query("UPDATE permission_grants SET tools='[\"agent.run\",\"file.write\"]' WHERE id=$1",[grantId]);
  });
  for(const mode of ['cancel_during_checkpoint','deadline_during_checkpoint'] as const)await t.test(mode,async()=>{

   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query('UPDATE permission_grants SET revoked_at=NULL WHERE id=$1',[grantId]);

   const snapshot:ProviderSnapshot={id:provider,revision:1,adapter:'ollama',baseUrl:'http://fixture.invalid',runtimePoolId:pool,routing:'unknown',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:1000};

   const context=RunContextSchema.parse({schema_version:1,provider_id:provider,provider_config_revision:1,provider_adapter:'ollama',provider_endpoint:snapshot.baseUrl,model_id:'fixture',profile_id:profileId,profile_revision:1,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:{...profile.limits,wall_time_seconds:mode==='deadline_during_checkpoint'?1:10}});

   const job=await submitJob(db!,{requester_id:owner,idempotency_key:mode,context,kind:'agent',payload:{machine_identity_generations,prompt:'Do not dispatch after checkpoint boundary',profile_snapshot:profile,provider_snapshot:snapshot,grant:wireGrant(grant)},modifies_workspace:true});

   let dispatches=0;

   const toolExecutor=createAgentTools({broker:{rpc:async()=>{dispatches++;throw new Error('Must not dispatch');}} as unknown as AgentBroker,files:{} as any,store:{} as any,operations:{} as any,checkpoint:async()=>{if(mode==='cancel_during_checkpoint')await cancelJob(db!,job.id,owner);else await new Promise(resolve=>setTimeout(resolve,1100));return {explicit_fixture:true};}});

   const fixture:ProviderAdapter={async discoverModels(){return [];},async getRuntimeState(){return {observedAt:new Date().toISOString(),residency:'unknown',models:[],providerActiveRequests:null};},getCapabilities(){return {tools:'unknown',images:'unknown',cancellation:'client-abort-only'};},async manage(){return {};},async *streamChat(){yield {type:'completed',requestedModel:'fixture',resolvedModel:'fixture',finishReason:'tool_calls',toolCalls:[{id:'one',name:'write_file',arguments:{path:'never.txt',content:'never',expected_sha256:null}}],usage:{source:'provider',inputTokens:1,outputTokens:1,cachedInputTokens:null,loadSeconds:null,promptEvaluationSeconds:null,generationSeconds:null,promptTokensPerSecond:null,decodeTokensPerSecond:null},wallSeconds:0.01,firstContentSeconds:null};}};

   const handler=createAgentHandler({resolveCredential:async()=>{throw new Error('No fixture credential');},makeAdapter:()=>fixture,checkpoint:async()=>({explicit_fixture:true}),executeTool:toolExecutor});const claimed=(await claimJob(db!,mode))!;await runClaimedJob(db!,claimed,{agent:handler});assert.equal(dispatches,0);const operation=(await db!.query('SELECT status FROM operations WHERE job_id=$1',[job.id])).rows[0];assert.equal(operation.status,mode==='cancel_during_checkpoint'?'cancelled':'failed');assert.equal((await db!.query('SELECT state FROM jobs WHERE id=$1',[job.id])).rows[0].state,mode==='cancel_during_checkpoint'?'cancelled':'failed');

  });

  for(const mode of ['unsupported','oversized'] as const)await t.test(`chat hard token budget ${mode}`,async()=>{

   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");

   const snapshot:ProviderSnapshot={id:provider,revision:1,adapter:'ollama',baseUrl:'http://fixture.invalid',runtimePoolId:pool,routing:'unknown',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:1000};

   const context=RunContextSchema.parse({schema_version:1,provider_id:provider,provider_config_revision:1,provider_adapter:'ollama',provider_endpoint:snapshot.baseUrl,model_id:'fixture',profile_id:null,profile_revision:null,execution_machine_id:null,execution_identity_id:null,workspace_id:null,workspace_revision:null,environment_id:null,environment_generation:null,project_instruction_revision:null,policy_revision:1,limits:{max_tool_steps:1,wall_time_seconds:10,per_command_timeout_seconds:1,max_output_bytes:4096,max_total_tokens:10}});

   const job=await submitJob(db!,{requester_id:owner,idempotency_key:`budget-${mode}`,context,kind:'chat',payload:{machine_identity_generations,prompt:'An oversized exact-framed prompt',provider_snapshot:snapshot},modifies_workspace:false});

   let generated=0;const adapter={discoverModels:async()=>[],streamChat:async function*(){generated++;},...(mode==='oversized'?{countRequestTokens:async()=>({inputTokens:11,source:'fixture-full-request-including-framing',exact:true})}:{})} as unknown as ProviderAdapter;

   const claimed=(await claimJob(db!,`budget-${mode}`))!;await runClaimedJob(db!,claimed,{chat:createChatHandler(async()=>'',()=>adapter)});

   assert.equal(generated,0);const row=(await db!.query('SELECT state,reason FROM jobs WHERE id=$1',[job.id])).rows[0];assert.equal(row.state,'failed');assert.match(row.reason,mode==='oversized'?/prompt_exceeds/:/preflight_unavailable/);assert.equal((await db!.query('SELECT COUNT(*)::int AS n FROM inference_requests WHERE job_id=$1',[job.id])).rows[0].n,0);

  });

  for(const scope of ['global','profile'] as const)await t.test(`capacity reduction allows original recovery only: ${scope}`,async()=>{

   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query('UPDATE runtime_control SET max_concurrent_jobs=$1',[scope==='global'?1:64]);if(scope==='profile')await db!.query("UPDATE agent_profile_revisions SET definition=jsonb_set(definition,'{limits,max_concurrent_jobs}','1'::jsonb) WHERE profile_id=$1",[profileId]);

   const payload={machine_identity_generations,machine_id:machine,...(scope==='profile'?{profile_id:profileId,profile_snapshot:{definition:{...profile,limits:{...profile.limits,max_concurrent_jobs:1}}}}:{})},ids:string[]=[];

   for(let index=0;index<3;index++){const job=await submitJob(db!,{requester_id:owner,idempotency_key:`capacity-${scope}-${index}`,kind:'fixture',context:null,modifies_workspace:false,payload});ids.push(job.id);if(index<2)await db!.query("INSERT INTO operations(id,job_id,step_id,request_hash,request,machine_id,fence,status) VALUES($1,$2,'original','fixture','{}',$3,1,'running')",[randomUUID(),job.id,machine]);}

   assert.equal(await claimJob(db!,'new-job',30,ids[2]),null);const recovered=(await claimJob(db!,'recover-existing',30,ids[0]))!;assert.equal(recovered.recovery_only,true);assert.equal(recovered.reason,'capacity_recovery_only');let calls=0;const executor=createOperationExecutor({broker:{rpc:async()=>{calls++;throw new Error('Fresh dispatch must be blocked');}} as unknown as AgentBroker,checkpoint:async()=>({})});

   await runClaimedJob(db!,recovered,{fixture:async(job,runtime)=>{const result=await executor.executeCommand(job,runtime,{step_id:'new-command',context:{} as any,grant:grant,tool:'run_command',mutating:true,command:{executable:'/never',args:[]}});assert.deepEqual(result,{state:'pending',reason:'capacity_recovery_only'});await runtime.wait('capacity_recovery_only');}});assert.equal(calls,0);await db!.query("UPDATE operations SET status='cancelled' WHERE job_id=ANY($1::uuid[])",[ids]);await db!.query("UPDATE jobs SET state='cancelled',lease_until=NULL,lease_owner=NULL WHERE id=ANY($1::uuid[])",[ids]);await db!.query('UPDATE runtime_control SET max_concurrent_jobs=4');

  });

  await t.test('cumulative output commits atomically, deduplicates replay and rejects stale provider release',async()=>{
   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");
   const job=await submitJob(db!,{requester_id:owner,idempotency_key:'output-atomic',kind:'fixture',context:null,modifies_workspace:false,payload:{limits:{max_output_bytes:10}}});let claimed=(await claimJob(db!,'output-original',30,job.id))!;
   const charge=(key:string,text:string,mode:'reject'|'truncate'='truncate')=>transaction(db!,client=>accountOutput(client,claimed,key,'model_text',text,mode));
   assert.equal((await charge('round1','😀ab')).accepted_bytes,6);
   await assert.rejects(transaction(db!,async client=>{await accountOutput(client,claimed,'rolled-back','model_text','xx','truncate');throw new Error('simulated crash');}),/simulated crash/);
   assert.equal(await transaction(db!,client=>remainingOutput(client,claimed)),4);
   assert.equal((await charge('round1','😀ab')).duplicate,true);await assert.rejects(charge('round1','different'),/idempotency_conflict/);
   assert.equal((await charge('whole-tool','{"executable":"/never"}','reject')).text,'');assert.equal(await transaction(db!,client=>remainingOutput(client,claimed)),4);
   assert.equal((await charge('round2','ééé')).text,'éé');assert.equal(await transaction(db!,client=>remainingOutput(client,claimed)),0);
   assert.equal(await reserveProvider(db!,pool,job.id,'fixture',1,false,claimed),true);const old=claimed;await db!.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);claimed=(await claimJob(db!,'output-replacement',30,job.id))!;
   assert.equal((await charge('round2','ééé')).duplicate,true);await assert.rejects(releaseProvider(db!,job.id,old),/lease lost/);await assert.rejects(markProviderUncertain(db!,job.id,old),/lease lost/);await assert.rejects(reserveProvider(db!,pool,job.id,'fixture',1,false,old),/lease lost/);
   assert.equal((await db!.query("SELECT state FROM resource_reservations WHERE job_id=$1 AND resource_type='provider'",[job.id])).rows[0].state,'held');await releaseProvider(db!,job.id,claimed);await db!.query("UPDATE jobs SET state='completed',lease_owner=NULL,lease_until=NULL WHERE id=$1",[job.id]);
  });
  await t.test('primary and verification logs share budget across replay and replacement',async()=>{
   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query("UPDATE permission_grants SET revoked_at=NULL,tools='[\"run_command\"]' WHERE id=$1",[grantId]);const job=await submitJob(db!,{requester_id:owner,idempotency_key:'output-command-verifier',kind:'fixture',context:null,modifies_workspace:false,payload:{machine_identity_generations,limits:{max_output_bytes:10}}});let claimed=(await claimJob(db!,'logs-original',30,job.id))!;const ids=[randomUUID(),randomUUID()];
   for(const [index,id]of ids.entries())await db!.query("INSERT INTO operations(id,job_id,step_id,request_hash,request,machine_id,fence,status,receipt) VALUES($1,$2,$3,'fixture','{}',$4,$5,'succeeded',$6)",[id,job.id,index?'verification:fixed':'command:0',machine,claimed.fence,{operation_id:id,state:'succeeded',exit_code:0}]);
   const executor=createOperationExecutor({broker:{rpc:async(_machine:string,_method:string,path:string)=>({logs:[{sequence:1,stream:'stdout',data:path.includes(ids[0])?'abcdef':'ééé'}]})} as unknown as AgentBroker,checkpoint:async()=>({})});
   const execute=async(j:any,r:any,step:string)=>executor.executeCommand(j,r,{step_id:step,command:{executable:'/not-launched',args:[]},context:{} as any,tool:'run_command',grant:{...grant,tools:['run_command']},mutating:false});
   await runClaimedJob(db!,claimed,{fixture:async(j,r)=>{await execute(j,r,'command:0');await r.wait('fixture replacement',0);}});await db!.query('UPDATE jobs SET next_run_at=now() WHERE id=$1',[job.id]);claimed=(await claimJob(db!,'logs-replacement',30,job.id))!;
   await runClaimedJob(db!,claimed,{fixture:async(j,r)=>{await execute(j,r,'command:0');await execute(j,r,'verification:fixed');await execute(j,r,'verification:fixed');await r.complete({});}});
   const logs=(await db!.query("SELECT payload->>'data' data FROM job_events WHERE job_id=$1 AND type='log' ORDER BY sequence",[job.id])).rows;assert.deepEqual(logs.map(row=>row.data),['abcdef','éé']);const usages=(await db!.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='output.usage' ORDER BY sequence",[job.id])).rows;assert.equal(usages.length,2);assert.equal(usages.at(-1)!.payload.cumulative_bytes,10);assert.equal(usages.at(-1)!.payload.received_bytes,12);
  });
  for(const mode of ['replacement','revoke_after_read','lease_lost_after_read','full_terminal_page','transient_final_read'] as const)await t.test(`running log ingestion ${mode}`,async()=>{
   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query("UPDATE permission_grants SET revoked_at=NULL,tools='[\"run_command\"]' WHERE id=$1",[grantId]);
   const selectedGrant={...grant,tools:['run_command']},context=ExecutionContextSchema.parse({schema_version:1,profile_id:null,profile_revision:null,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:profile.limits});const job=await submitJob(db!,{requester_id:owner,idempotency_key:`live-log-${mode}`,kind:'fixture',context:null,modifies_workspace:false,payload:{machine_identity_generations,execution_context:context,grant:selectedGrant}});let claimed=(await claimJob(db!,'live-logs-original',30,job.id))!;const operation=randomUUID();await db!.query("INSERT INTO operations(id,job_id,step_id,request_hash,request,machine_id,fence,status,receipt) VALUES($1,$2,'command:0','fixture',$3,$4,$5,$6,$7)",[operation,job.id,{grant:selectedGrant},machine,claimed.fence,mode==='full_terminal_page'||mode==='transient_final_read'?'succeeded':'running',{operation_id:operation,state:mode==='full_terminal_page'||mode==='transient_final_read'?'succeeded':'running',exit_code:0}]);let finished=false,posts=0,reads=0;
   const executor=createOperationExecutor({checkpoint:async()=>({}),broker:{rpc:async(_m:string,method:string,path:string,_body:any,options:any)=>{
    if(method==='POST'){posts++;throw new Error('Never launch a replacement');}if(!path.includes('/logs'))return {operation_id:operation,state:finished?'succeeded':'running',exit_code:0};
    assert.equal(options.scopeGrantId,grantId);assert.equal(options.scopeTool,'run_command');assert.equal(options.jobGuard.fence,claimed.fence);reads++;if(mode==='transient_final_read'&&reads===1)throw new HostRpcError('agent_unavailable','Explicit transient fixture','fixture',503,false);const after=Number(new URL(path,'http://fixture.invalid').searchParams.get('after'));
    if(mode==='revoke_after_read')await db!.query('UPDATE permission_grants SET revoked_at=now() WHERE id=$1',[grantId]);if(mode==='lease_lost_after_read')await db!.query("UPDATE jobs SET fence=fence+1,lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
    return {logs:mode==='full_terminal_page'?(after===0?Array.from({length:256},(_,index)=>({sequence:index+1,stream:'stdout',data:'x'.repeat(16384)})):[{sequence:257,stream:'stdout',data:'final'}]):[{sequence:after||1,stream:'stdout',data:'numbered-log-a'},{sequence:after?after+1:2,stream:'stdout',data:'numbered-log-b'}]};
   }} as unknown as AgentBroker});
   const execute=async(j:any,r:any)=>executor.executeCommand(j,r,{step_id:'command:0',context,grant:selectedGrant,tool:'run_command',mutating:false,command:{executable:'/not-launched',args:[]}});
   await runClaimedJob(db!,claimed,{fixture:async(j,r)=>{const result=await execute(j,r);if(mode==='replacement'||mode==='full_terminal_page'||mode==='transient_final_read'){assert.equal(result.state,'pending');if(mode==='full_terminal_page'||mode==='transient_final_read')assert.equal((result as any).reason,'host_log_replay');await r.wait('test replacement',0);}else await r.wait('scope denied',0);}});
   const before=(await db!.query("SELECT id,payload FROM job_events WHERE job_id=$1 AND type='log' ORDER BY sequence",[job.id])).rows;
   if(mode==='replacement'){assert.equal(before.length,2,'Numbered log events must exist while operation is still running');assert.equal((await db!.query('SELECT status,log_cursor FROM operations WHERE id=$1',[operation])).rows[0].status,'running');}
   if(mode==='revoke_after_read'||mode==='lease_lost_after_read'||mode==='transient_final_read'){assert.equal(before.length,0);assert.equal((await db!.query('SELECT log_cursor FROM operations WHERE id=$1',[operation])).rows[0].log_cursor,'0');}
   if(mode==='replacement'||mode==='full_terminal_page'||mode==='transient_final_read'){await db!.query('UPDATE jobs SET next_run_at=now() WHERE id=$1',[job.id]);claimed=(await claimJob(db!,'live-logs-replacement',30,job.id))!;finished=true;await runClaimedJob(db!,claimed,{fixture:async(j,r)=>{const result=await execute(j,r);assert.equal(result.state,'known');await r.complete({});}});const events=(await db!.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='log' ORDER BY sequence",[job.id])).rows;assert.equal(events.length,mode==='replacement'?3:mode==='transient_final_read'?2:1);assert.equal((await db!.query('SELECT log_cursor FROM operations WHERE id=$1',[operation])).rows[0].log_cursor,mode==='replacement'?'3':mode==='transient_final_read'?'2':'257');assert.equal(reads,2);}
   assert.equal(posts,0);await db!.query("UPDATE jobs SET state='cancelled',lease_owner=NULL,lease_until=NULL WHERE id=$1",[job.id]);await db!.query("UPDATE operations SET status='cancelled' WHERE id=$1",[operation]);await db!.query('UPDATE permission_grants SET revoked_at=NULL WHERE id=$1',[grantId]);
  });
  await t.test('absolute file proposal is persisted as rejected then corrected without rewriting',async()=>{
   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query('UPDATE runtime_control SET max_concurrent_jobs=64');await db!.query('UPDATE agent_profiles SET current_revision=1 WHERE id=$1',[profileId]);await db!.query('UPDATE agent_profile_revisions SET definition=$2 WHERE profile_id=$1 AND revision=1',[profileId,profile]);await db!.query('UPDATE permission_grants SET revoked_at=NULL,tools=$2,secret_ids=$3 WHERE id=$1',[grantId,JSON.stringify(grant.tools),JSON.stringify(grant.secret_ids)]);
   const snapshot:ProviderSnapshot={id:provider,revision:1,adapter:'ollama',baseUrl:'http://fixture.invalid',runtimePoolId:pool,routing:'unknown',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:1000},context=RunContextSchema.parse({schema_version:1,provider_id:provider,provider_config_revision:1,provider_adapter:'ollama',provider_endpoint:snapshot.baseUrl,model_id:'fixture',profile_id:profileId,profile_revision:1,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:profile.limits});let requests=0;const executed:string[]=[];
   const adapter:ProviderAdapter={async discoverModels(){return [];},async getRuntimeState(){return {observedAt:new Date().toISOString(),residency:'unknown',models:[],providerActiveRequests:null};},getCapabilities(){return {tools:'unknown',images:'unknown',cancellation:'client-abort-only'};},async manage(){return {};},async *streamChat(request){requests++;if(requests===2){const feedback=request.messages.find(message=>message.role==='tool');assert.ok(feedback);assert.match(feedback.content,/invalid_tool_arguments/);assert.match(feedback.content,/executed.*false/);assert.match(feedback.content,/pattern/);}yield {type:'completed',requestedModel:'fixture',resolvedModel:'fixture',finishReason:requests<3?'tool_calls':'stop',toolCalls:requests<3?[{id:`path-${requests}`,name:'write_file',arguments:{path:requests===1?'/workspace/project/report.txt':'report.txt',content:'proof',expected_sha256:null}}]:[],usage:{source:'provider',inputTokens:1,outputTokens:1,cachedInputTokens:null,loadSeconds:null,promptEvaluationSeconds:null,generationSeconds:null,promptTokensPerSecond:null,decodeTokensPerSecond:null},wallSeconds:0.01,firstContentSeconds:null};}};
   const handler=createAgentHandler({resolveCredential:async()=>'',makeAdapter:()=>adapter,checkpoint:async()=>({fixture:true}),executeTool:async(_j,_r,step)=>{executed.push(String(step.call.arguments.path));return {state:'completed',content:{fixture:true}};}}),job=await submitJob(db!,{requester_id:owner,idempotency_key:'relative-path-repair',kind:'agent',context,modifies_workspace:true,payload:{machine_identity_generations,prompt:'Injected portable file policy correction',profile_snapshot:profile,provider_snapshot:snapshot,grant}}),claimed=(await claimJob(db!,'relative-path-repair',30,job.id))!;await runClaimedJob(db!,claimed,{agent:handler});assert.equal(requests,3);assert.deepEqual(executed,['report.txt']);assert.equal((await db!.query('SELECT state FROM jobs WHERE id=$1',[job.id])).rows[0].state,'completed');const rejected=(await db!.query("SELECT request,result FROM job_steps WHERE job_id=$1 AND kind='tool' ORDER BY sequence LIMIT 1",[job.id])).rows[0];assert.equal(rejected.request.call.arguments.path,'/workspace/project/report.txt');assert.equal(rejected.result.content.executed,false);assert.equal((await db!.query("SELECT count(*)::int n FROM job_events WHERE job_id=$1 AND type='agent.tool.rejected'",[job.id])).rows[0].n,1);
  });
  await t.test('generated files reserve cumulative bytes before dispatch and replay does not reserve twice',async()=>{
   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query('UPDATE permission_grants SET revoked_at=NULL,tools=$2 WHERE id=$1',[grantId,JSON.stringify(grant.tools)]);
   const context=RunContextSchema.parse({schema_version:1,provider_id:provider,provider_config_revision:1,provider_adapter:'ollama',provider_endpoint:'http://fixture.invalid',model_id:'fixture',profile_id:profileId,profile_revision:1,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:{...profile.limits,max_generated_file_bytes:4096}});const job=await submitJob(db!,{requester_id:owner,idempotency_key:'generated-cumulative',kind:'fixture',context,modifies_workspace:true,payload:{machine_identity_generations,grant}});const claimed=(await claimJob(db!,'generated-cumulative',30,job.id))!;let puts=0;
   const execute=createAgentTools({broker:{rpc:async(_m:string,method:string,_p:string,body:any)=>{assert.equal(method,'PUT');puts++;return {operation_id:body.operation_id,state:'completed',result:{sha256:(await import('@homelab/storage')).sha256(Buffer.from(body.content_base64,'base64')),size_bytes:2500}};}} as unknown as AgentBroker,files:{} as any,store:{} as any,operations:{} as any,checkpoint:async()=>({id:'fixture'})});
   await runClaimedJob(db!,claimed,{fixture:async(j,r)=>{const step={id:randomUUID(),sequence:1,call:{id:'one',name:'write_file',arguments:{path:'one',content:'x'.repeat(2500),expected_sha256:null}}};assert.equal((await execute(j,r,step)).state,'completed');assert.equal((await execute(j,r,step)).state,'completed');await assert.rejects(execute(j,r,{...step,id:randomUUID(),call:{...step.call,id:'two',arguments:{...step.call.arguments,path:'two'}}}),/job_generated_file_budget_exhausted/);await r.complete({});}});assert.equal(puts,1);assert.equal((await db!.query("SELECT count(*)::int n FROM job_events WHERE job_id=$1 AND type='generated_file.reserved'",[job.id])).rows[0].n,1);
  });
  for(const mode of ['chat','agent_rounds','agent_proposal'] as const)await t.test(`real handler cumulative output boundary: ${mode}`,async()=>{
   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query('UPDATE runtime_control SET max_concurrent_jobs=64');await db!.query('UPDATE agent_profiles SET current_revision=1 WHERE id=$1',[profileId]);await db!.query('UPDATE agent_profile_revisions SET definition=$2 WHERE profile_id=$1 AND revision=1',[profileId,profile]);await db!.query('UPDATE permission_grants SET revoked_at=NULL,tools=$2,secret_ids=$3 WHERE id=$1',[grantId,JSON.stringify(grant.tools),JSON.stringify(grant.secret_ids)]);
   const snapshot:ProviderSnapshot={id:provider,revision:1,adapter:'ollama',baseUrl:'http://fixture.invalid',runtimePoolId:pool,routing:'unknown',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:1000};const context=RunContextSchema.parse({schema_version:1,provider_id:provider,provider_config_revision:1,provider_adapter:'ollama',provider_endpoint:snapshot.baseUrl,model_id:'fixture',profile_id:mode==='chat'?null:profileId,profile_revision:mode==='chat'?null:1,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:profile.limits});
   let requests=0,mutations=0;const adapter:ProviderAdapter={async discoverModels(){return [];},async getRuntimeState(){return {observedAt:new Date().toISOString(),residency:'unknown',models:[],providerActiveRequests:null};},getCapabilities(){return {tools:'unknown',images:'unknown',cancellation:'client-abort-only'};},async manage(){return {};},async *streamChat(){requests++;yield {type:'text',text:'x'.repeat(mode==='chat'?3000:requests===1?2000:2500)};if(mode==='chat')yield {type:'text',text:'y'.repeat(2000)};yield {type:'completed',requestedModel:'fixture',resolvedModel:'fixture',finishReason:'tool_calls',toolCalls:requests===1&&mode!=='chat'?[{id:'one',name:'write_file',arguments:{path:'one',content:mode==='agent_proposal'?'z'.repeat(3000):'one',expected_sha256:null}}]:[],usage:{source:'provider',inputTokens:1,outputTokens:1,cachedInputTokens:null,loadSeconds:null,promptEvaluationSeconds:null,generationSeconds:null,promptTokensPerSecond:null,decodeTokensPerSecond:null},wallSeconds:0.01,firstContentSeconds:null};}};
   const job=await submitJob(db!,{requester_id:owner,idempotency_key:`output-handler-${mode}`,kind:mode==='chat'?'chat':'agent',context,modifies_workspace:mode!=='chat',payload:{machine_identity_generations,prompt:'Injected output boundary',provider_snapshot:snapshot,profile_snapshot:mode==='chat'?null:profile,grant}});const handler=mode==='chat'?createChatHandler(async()=>'',()=>adapter):createAgentHandler({resolveCredential:async()=>'',makeAdapter:()=>adapter,checkpoint:async()=>({fixture:true}),executeTool:async()=>{mutations++;return {state:'completed',content:{fixture:true}};}});const claimed=(await claimJob(db!,'output-handler',30,job.id))!;await runClaimedJob(db!,claimed,{[job.kind]:handler});
   const row=(await db!.query('SELECT state,reason FROM jobs WHERE id=$1',[job.id])).rows[0];assert.match(row.reason,/job_output_budget_exhausted/);assert.equal(row.state,mode==='agent_proposal'?'failed':'interrupted');assert.equal(mutations,mode==='agent_rounds'?1:0);assert.equal(requests,mode==='agent_rounds'?2:1);const last=(await db!.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='output.usage' ORDER BY sequence DESC LIMIT 1",[job.id])).rows[0].payload;assert.ok(last.cumulative_bytes<=4096);assert.equal(last.limited,true);if(mode==='agent_proposal')assert.equal((await db!.query("SELECT count(*)::int n FROM job_steps WHERE job_id=$1 AND kind='tool'",[job.id])).rows[0].n,0);
   await db!.query("UPDATE resource_reservations SET state='released' WHERE job_id=$1",[job.id]);await db!.query('DELETE FROM workspace_locks WHERE job_id=$1',[job.id]);
  });
  await t.test('model-free command routes, opaque pagination and frozen soft-deleted attachment export',async()=>{

   await db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");await db!.query("UPDATE permission_grants SET revoked_at=NULL,tools='[\"run_command\",\"workspace.terminal\"]' WHERE id=$1",[grantId]);await db!.query('UPDATE execution_identities SET restriction_verified=true,config=$2 WHERE id=$1',[identity,{workspace_ids:[workspace]}]);

   const authSession=randomUUID();await db!.query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,'fixture',now()+interval '1 hour')",[authSession,owner,randomUUID()]);

   const root=await mkdtemp(join(tmpdir(),'homelab-runtime-api-')),app=Fastify();await app.register(websocket);app.addHook('preHandler',async request=>{request.actor={id:owner,role:'owner'};request.sessionId=authSession;});

   let rpcFixture:(...args:any[])=>Promise<any>=async()=>{throw new Error('Unexpected fixture RPC');};

   try{await registerJobs(app,{db:db!,config:{origin:'http://127.0.0.1',cookieSecure:false,artifactRoot:root,dispatchEnabled:true,restoreMode:false},secrets:{} as any,agentBroker:{rpc:(...args:any[])=>rpcFixture(...args)} as unknown as AgentBroker,policy:authorize,audit:async()=>{}});

    const context=ExecutionContextSchema.parse({schema_version:1,profile_id:null,profile_revision:null,execution_machine_id:machine,execution_identity_id:identity,workspace_id:workspace,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:{max_tool_steps:1,wall_time_seconds:10,per_command_timeout_seconds:1,max_output_bytes:4096}});

    const body={idempotency_key:'model-free-api',execution_context:context,grant_id:grantId,command:{executable:'/fixture/not-launched',args:[]}};const first=await app.inject({method:'POST',url:'/jobs/commands',payload:body});assert.equal(first.statusCode,202,first.body);const repeated=await app.inject({method:'POST',url:'/jobs/commands',payload:body});assert.equal(repeated.json().id,first.json().id);assert.equal((await db!.query('SELECT context FROM jobs WHERE id=$1',[first.json().id])).rows[0].context,null);assert.equal((await app.inject({method:'POST',url:'/jobs/commands/preflight',payload:{execution_context:context,grant_id:grantId}})).statusCode,200);

    const page=(await app.inject('/jobs?limit=1')).json();assert.equal(page.items.length,1);assert.equal(page.items[0].timing.scope,'orchestration');assert.ok(page.next_cursor);const older=(await app.inject(`/jobs?limit=1&before=${page.next_cursor}`)).json();assert.notEqual(older.items[0].id,page.items[0].id);

    const conversation=randomUUID(),attachment=randomUUID(),blob=await new BlobStore(root,1024,{db:db!}).put(Buffer.from('frozen bytes survived deletion'));await db!.query("INSERT INTO conversations(id,owner_id,title,context) VALUES($1,$2,'export fixture','{}')",[conversation,owner]);await db!.query("INSERT INTO attachments(id,owner_id,conversation_id,filename,mime_type,size_bytes,sha256,storage_key,deleted_at) VALUES($1,$2,$3,'original.txt','text/plain',$4,$5,$5,now())",[attachment,owner,conversation,blob.size,blob.hash]);

    await db!.query("INSERT INTO messages(id,conversation_id,job_id,role,content,state) VALUES($1,$2,$3,'user',$4,'completed')",[randomUUID(),conversation,first.json().id,{text:'Original',attachment_snapshots:[{id:attachment,filename:'original.txt',mime_type:'text/plain',size_bytes:blob.size,sha256:blob.hash}]}]);const exported=await app.inject(`/conversations/${conversation}/export`);assert.equal(exported.statusCode,200,exported.body);assert.ok(exported.rawPayload.includes(Buffer.from('frozen bytes survived deletion')));assert.ok(exported.rawPayload.includes(Buffer.from('execution_context')));const downloaded=await app.inject(`/conversations/${conversation}/attachments/${attachment}`);assert.equal(downloaded.body,'frozen bytes survived deletion');const history=(await app.inject(`/conversations/${conversation}?limit=1`)).json();assert.deepEqual(history.messages[0].job_execution_context,context);assert.equal(history.messages[0].content.attachment_snapshots[0].sha256,blob.hash);

    const created=(await app.inject({method:'POST',url:'/workspace-terminals',payload:{idempotency_key:'ws-backpressure',execution_context:context,grant_id:grantId,cols:80,rows:24}})).json();assert.ok(created.id);assert.ok(await claimJob(db!,'ws-fixture',30,created.job_id));

    let releaseInput!:()=>void,inputCalls=0;const blocked=new Promise<void>(resolve=>{releaseInput=resolve;});rpcFixture=async(_machine,method,path)=>{if(path.endsWith('/input')){inputCalls++;await blocked;}return {record:{id:created.id,state:'running'},data:'',offset:0,next_offset:0,truncated:false};};

    const address=await app.listen({host:'127.0.0.1',port:0}),socket=new WebSocket(`${address.replace('http:','ws:')}/workspace-terminals/${created.id}/ws`,{headers:{origin:'http://127.0.0.1'}});

    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});socket.send(JSON.stringify({type:'attach',ticket:created.ticket,csrf_token:'fixture',after:0}));await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No terminal status')),2000);socket.on('message',raw=>{if(JSON.parse(raw.toString()).type==='status'){clearTimeout(timer);resolve();}});});

    const closed=new Promise<number>(resolve=>socket.once('close',code=>resolve(code)));for(let index=0;index<20;index++)socket.send(JSON.stringify({type:'input',id:randomUUID(),data:Buffer.alloc(1000).toString('base64')}));const closeCode=await Promise.race([closed,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Input flood did not close')),2000))]);assert.equal(closeCode,1013);releaseInput();assert.ok(inputCalls<=1,'Only one bounded pending remote input may be retained; queued frames must be dropped on close');    const captured=await captureExecution({db:db!,policy:authorize} as any,{id:owner,role:'owner'},context,grantId,['run_command']);await db!.query('UPDATE machines SET identity_generation=$2 WHERE id=$1',[machine,randomUUID()]);await assert.rejects(submitJob(db!,{requester_id:owner,idempotency_key:'stale-prepared-generation',kind:'command',context:null,workspace_id:workspace,modifies_workspace:true,payload:{...captured,command:body.command}}),/installation changed/);assert.equal((await db!.query("SELECT COUNT(*)::int n FROM jobs WHERE idempotency_key='stale-prepared-generation'")).rows[0].n,0);

   }finally{await app.close();assert.equal(dirname(root),tmpdir());await rm(root,{recursive:true,force:true});}

  });

 }finally{await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();}

});

