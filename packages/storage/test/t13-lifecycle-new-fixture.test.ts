import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {AgentBroker} from '@homelab/transport';
import {sha256} from '../src/index.js';
import {hashPassword} from '../../../apps/api/src/auth/password.js';
import {startLinuxStackRelay,linux,stackUnc,safeImage} from '../../../tests/integration/helpers/linux-stack.js';

test('actual fresh T13 fixture preserves copied verified text/binary and retained URLs across restart and runtime replacement',{
 skip:process.env.HOMELAB_T13_NEW_FIXTURE!=='1'?'Requires root-authorized exclusive fresh fixture booking and exact helper11':false,timeout:600000
},async()=>{
 assert.equal(process.env.HOMELAB_LINUX_STACK,'1');
 assert.equal(process.env.HOMELAB_AGENT_LINUX,'/mnt/c/Projects/Home-Lab-Dashboard/agent/bin/homelab-agent-linux-wave3-securityopt-11','Use the exact root-approved immutable helper11');
 const absoluteTemplate=process.env.HOMELAB_T13_ABSOLUTE_TEMPLATE==='1';
 const evidenceFile=absoluteTemplate?'docs/storage/T13_ABSOLUTE_LIFECYCLE_RESULT.json':'docs/storage/T13_FRESH_LIFECYCLE_RESULT.json';
 const prior=await readFile(evidenceFile,'utf8').then(JSON.parse).catch(()=>null),resumeSetup=process.env.HOMELAB_T13_RESUME_SETUP==='1';
 if(prior)assert.ok(resumeSetup&&prior.error==='Remote mutation or restored relay is disabled'&&!prior.restart&&!prior.rebuild&&!prior.canonical_root,'Only the explicitly authorized pre-enqueue setup failure can resume; never replay an unknown lifecycle');
 const sourceProof=JSON.parse(await readFile('docs/acceptance/actual-model-command-physical-result.json','utf8'));
 assert.match(sourceProof.canonical_root,/^\/tmp\/homelab-validation-wave2\/sentinel-[a-f0-9-]{36}\/project$/);
 const sourceDirectory=join(stackUnc,sourceProof.canonical_root.split('/').at(-2)!,'project');
 const sourceFiles: Array<{path:string;bytes:Buffer;sha256:string}>=[];
 for(const expected of sourceProof.outputs){assert.ok(['sentinel-report.txt','sentinel-binary.bin'].includes(expected.path));const bytes=await readFile(join(sourceDirectory,expected.path));assert.equal(bytes.length,expected.size);assert.equal(sha256(bytes),expected.actual_sha256);sourceFiles.push({path:expected.path,bytes,sha256:expected.actual_sha256});}
 assert.equal(sourceFiles.length,2);
 const url=new URL((await readFile(join(stackUnc,'config','database-admin-url'),'utf8')).trim());url.hostname='127.0.0.1';url.port='15439';const db=new pg.Pool({connectionString:url.href,max:4});
 const ids:Record<string,string>=prior?.ids??Object.fromEntries(['owner','machine','workspace','project','identity','environment','grant'].map(key=>[key,randomUUID()]));
 const password=randomBytes(24).toString('base64url'),email=`${ids.owner}@t13-fixture.invalid`,origin='http://localhost:5173',apiOrigin='http://127.0.0.1:3019';
 let host:Awaited<ReturnType<typeof startLinuxStackRelay>>|undefined;
 const evidence:Record<string,any>={scope:'Manual fresh owner API lifecycle acceptance; source-copy provenance is separate from primary-model verification/artifact publication',started_at:new Date().toISOString(),outcome:'RUNNING',ids,api_origin:apiOrigin,...(prior?{setup_attempt_history:[prior]}:{}),source:{canonical_root:sourceProof.canonical_root,original_job_id:sourceProof.job_id,original_operation_id:sourceProof.operation_id,files:sourceFiles.map(({path,sha256,bytes})=>({path,sha256,size_bytes:bytes.length})),original_unknown_restart_id:'6cb0d40a-d549-4255-88e3-8e32e1252cd0',original_fixture_mutated:false},container_image:safeImage};
 async function save(){await writeFile(evidenceFile,JSON.stringify(evidence,null,2));}
 await save();
 const previousDispatch=process.env.DISPATCH_ENABLED,previousRestore=process.env.RESTORE_MODE;process.env.DISPATCH_ENABLED='true';process.env.RESTORE_MODE='false';
 try{
  const control=(await db.query('SELECT dispatch_enabled,restore_mode,maintenance_mode FROM runtime_control WHERE singleton=true')).rows[0];assert.ok(control.dispatch_enabled&&!control.restore_mode&&!control.maintenance_mode,'Do not alter global product dispatch policy for the test');
  await db.query('INSERT INTO users(id,email,password_hash)VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET password_hash=EXCLUDED.password_hash WHERE users.email=EXCLUDED.email',[ids.owner,email,await hashPassword(password)]);
  await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'Explicit fresh T13 isolation fixture','linux') ON CONFLICT(id) DO NOTHING",[ids.machine,ids.owner]);
  if(!prior)host=await startLinuxStackRelay({db,owner:ids.owner,machine:ids.machine,workspace:ids.workspace,identity:ids.identity,environment:ids.environment,grant:ids.grant,agentOrigin:'https://127.0.0.1:3459'});
  else{
   assert.equal((await db.query("SELECT 1 FROM agent_rpc_requests WHERE machine_id=$1 AND method<>'GET'",[ids.machine])).rowCount,0,'No accepted mutation may exist before setup continuation');
   assert.equal((await db.query('SELECT 1 FROM workspaces WHERE id=$1',[ids.workspace])).rowCount,0);assert.equal((await db.query('SELECT 1 FROM jobs WHERE requester_id=$1',[ids.owner])).rowCount,0);
   const matches=[];for(const entry of await readdir(stackUnc)){if(!/^sentinel-[a-f0-9-]{36}$/.test(entry))continue;const cfg=await readFile(join(stackUnc,entry,'supervisor.json'),'utf8').then(JSON.parse).catch(()=>null);if(cfg?.machine_id===ids.machine)matches.push({entry,cfg});}assert.equal(matches.length,1);
   const {entry,cfg}=matches[0],directory=`/tmp/homelab-validation-wave2/${entry}`,files=join(stackUnc,entry),workspace=cfg.workspaces[0];assert.equal(workspace.id,ids.workspace);assert.equal(workspace.root,`${directory}/project`);assert.notEqual(workspace.root,sourceProof.canonical_root);assert.equal(workspace.image,safeImage);assert.deepEqual(workspace.environment_command,['node','-e','setInterval(()=>{},1000)']);
   const oldRuntime=workspace.runtime_id;let oldAbsent=false;try{await linux('/usr/bin/docker','inspect',oldRuntime);}catch(error){oldAbsent=/No such (object|container)/i.test(String((error as any).stderr??error));}assert.ok(oldAbsent,'Prior setup-only base must already be removed by the helper cleanup');
   evidence.setup_resume={same_ids_and_identity:true,prior_initial_runtime_id:oldRuntime,prior_initial_runtime_absent:true,accepted_mutating_rpcs:0};await save();
   const runtimeId=await linux('/usr/bin/docker','run','-d','--name',`homelab-validation-environment-${entry.slice(9)}`,'--label',`homelab.machine_id=${ids.machine}`,'--label',`homelab.workspace_id=${ids.workspace}`,'--user','10001:10001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--network','none','--pids-limit','32','--memory','256m','--cpus','1','--mount',`type=bind,source=${workspace.root},target=/workspace/project`,safeImage,...workspace.environment_command);
   workspace.runtime_id=runtimeId;evidence.setup_resume.new_initial_runtime_id=runtimeId;await writeFile(join(files,'supervisor.json'),JSON.stringify(cfg));
   const tracked:Array<{child:ChildProcess;pid:number}>=[];let diagnostic='';const binary=`${directory}/homelab-agent`;
   async function launch(args:string[]){const child=spawn('wsl.exe',['-d','Ubuntu','--exec','sh','-c','echo $$; exec "$@"','homelab-t13-resume',binary,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stderr!.on('data',b=>{diagnostic=(diagnostic+String(b)).slice(-2048);});const pid=await new Promise<number>((done,reject)=>{child.stdout!.once('data',b=>{const n=Number(String(b).split(/\r?\n/)[0]);n>1&&Number.isSafeInteger(n)?done(n):reject(Error('Missing owned resumed PID'));});child.once('error',reject);});tracked.push({child,pid});}
   const stop=async()=>{for(const p of [...tracked].reverse())if(p.child.exitCode===null&&p.child.signalCode===null){await linux('/bin/kill','-TERM',String(p.pid));for(let i=0;i<100&&p.child.exitCode===null;i++)await delay(20);if(p.child.exitCode===null)p.child.kill();}};
   const signer={keyId:await linux('sudo','-n','/bin/cat','/tmp/homelab-validation-wave2/config/dispatch-key-id'),privateKeyPem:await linux('sudo','-n','/bin/cat','/tmp/homelab-validation-wave2/config/dispatch-private.pem')},broker=new AgentBroker(db,{signer}),machineGeneration=(await db.query('SELECT identity_generation FROM machines WHERE id=$1',[ids.machine])).rows[0].identity_generation;
   // Install cleanup before any process start or signed call can fail.
   host={directory,files,root:workspace.root,projectFiles:join(files,'project'),workspace,broker,signer,stop,runtimeId,machineGeneration,diagnostic:()=>diagnostic} as Awaited<ReturnType<typeof startLinuxStackRelay>>;
   await launch(['supervisor','--config',`${directory}/supervisor.json`]);await delay(500);await launch(['connect','--config',`${directory}/connection.json`]);
   const options={ownerId:ids.owner,expectedMachineGeneration:machineGeneration,timeoutMs:20000};host.health=await broker.rpc(ids.machine,'GET','/v1/health',null,options);host.proof=await broker.rpc(ids.machine,'POST',`/v1/identities/${ids.identity}/verify`,{},options);
  }
  evidence.canonical_root=host.root;evidence.host_directory=host.directory;evidence.host_binary_sha256=(await linux('/usr/bin/sha256sum',`${host.directory}/homelab-agent`)).split(' ')[0];evidence.machine_identity_generation=host.machineGeneration;evidence.identity_proof=host.proof;
  assert.equal(evidence.host_binary_sha256,'8111acfb7678d09b22e19ff39674a2827a6bdb855800cf098411e751af4f44a1');
  if(absoluteTemplate)assert.deepEqual(host.workspace.environment_command,['/usr/local/bin/node','-e','setInterval(()=>{},1000)']);
  evidence.protected_workspace_template=host.workspace;
  assert.equal((host.proof as any).verified,true);
  for(const source of sourceFiles)await writeFile(join(host.projectFiles,source.path),source.bytes);
  await db.query("INSERT INTO projects(id,owner_id,name)VALUES($1,$2,'Fresh manual T13 project')",[ids.project,ids.owner]);
  await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,quota_bytes,environment_id,environment_generation)VALUES($1::uuid,$2,$3,'Fresh manual T13 project','container',$4,$1::text,$5,'/workspace/project',67108864,$6,1)",[ids.workspace,ids.owner,ids.project,ids.machine,host.root,ids.environment]);
  await db.query("INSERT INTO environment_generations(id,workspace_id,machine_id,generation,runtime_id,image_digest,state,mount_path)VALUES($1,$2,$3,1,$4,$5,'running','/workspace/project')",[ids.environment,ids.workspace,ids.machine,host.runtimeId,safeImage]);
  await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids)VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',[ids.grant,ids.owner,JSON.stringify(['file.read','artifact.retain','environment.restart','environment.rebuild']),JSON.stringify([ids.machine]),JSON.stringify([ids.workspace])]);
  const signedBinding=await host.broker.rpc(ids.machine,'GET',`/v1/workspaces/${ids.workspace}/binding`,null,{ownerId:ids.owner,expectedMachineGeneration:host.machineGeneration,scopeGrantId:ids.grant,scopeTool:'file.read',timeoutMs:20000});evidence.signed_binding_preflight=signedBinding;
  assert.equal((signedBinding as any).runtime_id,host.runtimeId);
  const inspect=async(id:string)=>JSON.parse(await linux('/usr/bin/docker','inspect',id))[0];
  const beforeContainer=await inspect(host.runtimeId!);assert.equal(beforeContainer.Config.Labels['homelab.workspace_id'],ids.workspace);assert.equal(beforeContainer.Config.User,'10001:10001');assert.equal(beforeContainer.Config.Image,safeImage);assert.equal(beforeContainer.HostConfig.ReadonlyRootfs,true);assert.equal(beforeContainer.HostConfig.NetworkMode,'none');assert.ok(beforeContainer.HostConfig.CapDrop.includes('ALL'));assert.ok(beforeContainer.HostConfig.SecurityOpt.some((v:string)=>['no-new-privileges','no-new-privileges:true','no-new-privileges=true'].includes(v)));assert.equal(beforeContainer.Mounts.find((m:any)=>m.Destination==='/workspace/project')?.Source,host.root);
  evidence.before_container={id:beforeContainer.Id,image_id:beforeContainer.Image,image:beforeContainer.Config.Image,security_opt:beforeContainer.HostConfig.SecurityOpt,started_at:beforeContainer.State.StartedAt,mounts:beforeContainer.Mounts.map((m:any)=>({source:m.Source,destination:m.Destination,rw:m.RW}))};await save();
  if(absoluteTemplate){
   evidence.phase='awaiting_host_final_config_binding_inspect_review';await save();
   const until=Date.now()+300000;let approved=false;
   while(Date.now()<until){const review=await readFile('tests/integration/.wave3-runtime/t13-absolute-final-go.json','utf8').then(JSON.parse).catch(()=>null);if(review?.approved===true&&review.workspace_id===ids.workspace&&review.runtime_id===host.runtimeId&&review.canonical_root===host.root&&review.host_binary_sha256===evidence.host_binary_sha256){evidence.host_final_review=review;approved=true;break;}await delay(1000);}
   assert.ok(approved,'Do not mutate lifecycle before independent actual config/binding/inspect review');evidence.phase='host_final_review_approved';await save();
  }
  const login=await fetch(`${apiOrigin}/api/v1/auth/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0],csrf=(await login.json() as any).csrf_token;
  async function api(method:string,path:string,body?:unknown){const response=await fetch(`${apiOrigin}/api/v1${path}`,{method,headers:{cookie,origin,'x-csrf-token':csrf,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(100000)});return{status:response.status,body:await response.json() as any};}
  const base=`/projects/${ids.workspace}`,initial=await api('GET',`${base}/binding`);assert.equal(initial.status,200,JSON.stringify(initial.body));assert.equal(initial.body.runtime_id,host.runtimeId);evidence.before_binding=initial.body;
  async function files(){const result=[];for(const source of sourceFiles){const r=await api('GET',`${base}/files?${new URLSearchParams({path:source.path,mode:'read',grant_id:ids.grant})}`);assert.equal(r.status,200,JSON.stringify(r.body));const bytes=Buffer.from(r.body.content_base64,'base64');assert.equal(sha256(bytes),source.sha256);assert.deepEqual(bytes,source.bytes);result.push({path:source.path,sha256:sha256(bytes),size_bytes:bytes.length});}return result;}
  evidence.files_before=await files();const artifacts:Array<{id:string;sha256:string;size_bytes:number;origin:string}>=[];
  for(const source of sourceFiles){const r=await api('POST',`${base}/artifacts`,{path:source.path,expected_sha256:source.sha256,grant_id:ids.grant});assert.equal(r.status,200,JSON.stringify(r.body));artifacts.push({id:r.body.id,sha256:r.body.sha256,size_bytes:Number(r.body.size_bytes),origin:'Manually retained copied source bytes; not model-published'});}
  async function downloads(){const result=[];for(const a of artifacts){const url=`${apiOrigin}/api/v1/artifacts/${a.id}/download`,r=await fetch(url,{headers:{cookie},signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(sha256(bytes),a.sha256);assert.equal(bytes.length,a.size_bytes);result.push({...a,url,downloaded_sha256:sha256(bytes)});}return result;}
  evidence.artifacts_before=await downloads();
  const restartId=randomUUID();evidence.restart={operation_id:restartId,state:'intent_recorded'};await save();const restart=await api('POST',`${base}/environment/restart`,{operation_id:restartId,grant_id:ids.grant});evidence.restart.response=restart;await save();assert.equal(restart.status,200,JSON.stringify(restart.body));assert.equal(restart.body.binding.runtime_id,initial.body.runtime_id);
  const rebuildId=randomUUID();evidence.rebuild={operation_id:rebuildId,state:'intent_recorded'};await save();const rebuild=await api('POST',`${base}/environment/rebuild`,{operation_id:rebuildId,grant_id:ids.grant});evidence.rebuild.response=rebuild;await save();assert.equal(rebuild.status,200,JSON.stringify(rebuild.body));const next=rebuild.body.binding;assert.notEqual(next.runtime_id,initial.body.runtime_id);assert.notEqual(next.environment_id,initial.body.environment_id);assert.ok(next.environment_generation>initial.body.environment_generation);
  const replay=await api('POST',`${base}/environment/rebuild`,{operation_id:rebuildId,grant_id:ids.grant});assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.binding.runtime_id,next.runtime_id);evidence.rebuild_replay_same_runtime=true;
  const afterContainer=await inspect(next.runtime_id);assert.equal(afterContainer.Config.Labels['homelab.workspace_id'],ids.workspace);assert.equal(afterContainer.Image,beforeContainer.Image);assert.equal(afterContainer.Mounts.find((m:any)=>m.Destination==='/workspace/project')?.Source,host.root);evidence.after_container={id:afterContainer.Id,image_id:afterContainer.Image,image:afterContainer.Config.Image,security_opt:afterContainer.HostConfig.SecurityOpt,started_at:afterContainer.State.StartedAt,mounts:afterContainer.Mounts.map((m:any)=>({source:m.Source,destination:m.Destination,rw:m.RW}))};
  evidence.files_after=await files();assert.deepEqual(evidence.files_after,evidence.files_before);evidence.artifacts_after=await downloads();await host.stop();evidence.artifacts_host_offline=await downloads();evidence.outcome='PASS';evidence.completed_at=new Date().toISOString();
 }catch(error){evidence.outcome='FAIL';evidence.error=error instanceof Error?error.message:String(error);throw error;}
 finally{await host?.stop();await db.end();await save();if(previousDispatch===undefined)delete process.env.DISPATCH_ENABLED;else process.env.DISPATCH_ENABLED=previousDispatch;if(previousRestore===undefined)delete process.env.RESTORE_MODE;else process.env.RESTORE_MODE=previousRestore;}
});
