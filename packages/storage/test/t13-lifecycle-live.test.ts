import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {sha256} from '../src/index.js';
import {linux,stackUnc,safeImage} from '../../../tests/integration/helpers/linux-stack.js';

test('actual booked Linux T13 restart/replacement preserves original text, binary and existing retained artifact URLs',{
 skip:process.env.HOMELAB_T13_LIFECYCLE!=='1'?'Requires explicit exclusive retained 3019 fixture booking':false,timeout:600000
},async()=>{
 const retainedAttempt=await readFile('docs/storage/T13_LIFECYCLE_RESULT.json','utf8').then(JSON.parse).catch(()=>null);
 assert.ok(!retainedAttempt?.unknown_operation_id,'The original unknown operation and its evidence are preserved; this fixture must not be replayed');
 const fixture=JSON.parse(await readFile('tests/integration/.wave3-runtime/actual-model-browser.json','utf8'));
 const physical=JSON.parse(await readFile('docs/acceptance/actual-model-command-physical-result.json','utf8'));
 assert.equal(fixture.api_origin,'http://127.0.0.1:3019');
 assert.match(physical.canonical_root,/^\/tmp\/homelab-validation-wave2\/sentinel-[a-f0-9-]{36}\/project$/);
 const hostDirectory=dirname(physical.canonical_root),filesDirectory=join(stackUnc,hostDirectory.split('/').at(-1)!);
 const configPath=join(filesDirectory,'supervisor.json'),config=JSON.parse(await readFile(configPath,'utf8'));
 const workspace=config.workspaces.find((w:any)=>w.id===fixture.ids.workspace);
 assert.ok(workspace);assert.equal(workspace.root,physical.canonical_root);assert.equal(workspace.image,safeImage);
 const processes:Array<{child:ChildProcess;pid:number}>=[];
 const evidence:Record<string,any>={scope:'Manual owner API lifecycle acceptance on retained actual-command project; no model retention claim',started_at:new Date().toISOString(),outcome:'RUNNING',workspace_id:fixture.ids.workspace,machine_id:fixture.ids.machine,original_job_id:physical.job_id,original_operation_id:physical.operation_id,canonical_root:physical.canonical_root,model_result:'Original model verification remains separate and was not replayed',container_image:safeImage};
 const evidencePath=resolve('docs/storage/T13_LIFECYCLE_RESULT.json');
 let diagnostic='';
 async function launch(binary:string,args:string[]){
  const child=spawn('wsl.exe',['-d','Ubuntu','--exec','sh','-c','echo $$; exec "$@"','homelab-t13-owned',binary,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stderr!.on('data',b=>{diagnostic=(diagnostic+String(b)).slice(-4096);});
  const pid=await new Promise<number>((done,reject)=>{child.stdout!.once('data',b=>{const value=Number(String(b).split(/\r?\n/)[0]);Number.isSafeInteger(value)&&value>1?done(value):reject(new Error('Missing owned host PID'));});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(`Owned host exited ${code}`));});});
  processes.push({child,pid});return pid;
 }
 async function stopOwned(){for(const tracked of [...processes].reverse()){if(tracked.child.exitCode!==null||tracked.child.signalCode!==null)continue;await linux('/bin/kill','-TERM',String(tracked.pid));for(let i=0;i<100&&tracked.child.exitCode===null;i++)await delay(20);if(tracked.child.exitCode===null)tracked.child.kill();}}
 try{
  const login=await fetch(`${fixture.api_origin}/api/v1/auth/login`,{method:'POST',headers:{origin:fixture.app_origin,'content-type':'application/json'},body:JSON.stringify({email:fixture.email,password:fixture.password}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0],csrf=(await login.json() as any).csrf_token;
  async function api(method:string,path:string,body?:unknown){const response=await fetch(`${fixture.api_origin}/api/v1${path}`,{method,headers:{cookie,origin:fixture.app_origin,'x-csrf-token':csrf,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(100000)});return{status:response.status,body:await response.json() as any};}
  const base=`/projects/${fixture.ids.workspace}`;
  const writer=await api('GET',`${base}/writer`);assert.equal(writer.status,200);assert.equal(writer.body.lock,null,'Exclusive fixture must have no unresolved writer');
  const newGrant=await api('POST','/grants',{tools:['file.read','artifact.retain','environment.restart','environment.rebuild'],machine_ids:[fixture.ids.machine],workspace_ids:[fixture.ids.workspace]});assert.equal(newGrant.status,201,JSON.stringify(newGrant.body));const grant=newGrant.body.id;evidence.manual_grant_id=grant;
  workspace.grant_ids=[...new Set([...(workspace.grant_ids??[]),grant])];workspace.environment_grant_ids=[...new Set([...(workspace.environment_grant_ids??[]),grant])];
  await writeFile(configPath,JSON.stringify(config,null,2));await linux('/bin/chmod','600',`${hostDirectory}/supervisor.json`);
  const suffix=randomUUID(),binary=`${hostDirectory}/homelab-agent-t13-${suffix}`;
  await linux('/bin/cp','/mnt/c/Projects/Home-Lab-Dashboard/agent/bin/homelab-agent-linux-wave3-kernelboot-10',binary);await linux('/bin/chmod','700',binary);
  evidence.host_binary_sha256=(await linux('/usr/bin/sha256sum',binary)).split(' ')[0];
  evidence.owned_supervisor_pid=await launch(binary,['supervisor','--config',`${hostDirectory}/supervisor.json`]);
  evidence.owned_connection_pid=await launch(binary,['connect','--config',`${hostDirectory}/connection.json`]);
  const initial=await api('GET',`${base}/binding`);assert.equal(initial.status,200,JSON.stringify(initial.body));assert.equal(initial.body.canonical_root,physical.canonical_root);assert.equal(initial.body.type,'container');assert.ok(initial.body.runtime_id);evidence.before_binding=initial.body;
  const inspect=async(id:string)=>JSON.parse(await linux('/usr/bin/docker','inspect',id))[0];
  const beforeContainer=await inspect(initial.body.runtime_id);assert.equal(beforeContainer.Config.Labels['homelab.workspace_id'],fixture.ids.workspace);assert.equal(beforeContainer.Mounts.find((m:any)=>m.Destination==='/workspace/project')?.Source,physical.canonical_root);evidence.before_container={id:beforeContainer.Id,image_id:beforeContainer.Image,image:beforeContainer.Config.Image,labels:beforeContainer.Config.Labels,mounts:beforeContainer.Mounts.map((m:any)=>({source:m.Source,destination:m.Destination,rw:m.RW}))};
  async function originalFiles(){const result=[];for(const expected of physical.outputs){const response=await api('GET',`${base}/files?${new URLSearchParams({path:expected.path,mode:'read',grant_id:grant})}`);assert.equal(response.status,200,JSON.stringify(response.body));const bytes=Buffer.from(response.body.content_base64,'base64');assert.equal(sha256(bytes),expected.actual_sha256);assert.equal(bytes.length,expected.size);result.push({path:expected.path,sha256:sha256(bytes),size_bytes:bytes.length});}return result;}
  evidence.files_before=await originalFiles();
  const existing=await api('GET',`${base}/artifacts`);assert.equal(existing.status,200);const artifacts=existing.body.items.slice(0,2).map((a:any)=>({id:a.id,sha256:a.sha256,size_bytes:Number(a.size_bytes),origin:'preexisting diff artifact'}));assert.ok(artifacts.length,'Original operation must have retained diff artifacts');
  for(const expected of physical.outputs){const retained=await api('POST',`${base}/artifacts`,{path:expected.path,expected_sha256:expected.actual_sha256,grant_id:grant});assert.equal(retained.status,200,JSON.stringify(retained.body));artifacts.push({id:retained.body.id,sha256:retained.body.sha256,size_bytes:Number(retained.body.size_bytes),origin:'manual raw artifact, not model-published'});}
  async function downloads(){const result=[];for(const artifact of artifacts){const url=`${fixture.api_origin}/api/v1/artifacts/${artifact.id}/download`,response=await fetch(url,{headers:{cookie},signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha256(bytes),artifact.sha256);assert.equal(bytes.length,artifact.size_bytes);result.push({...artifact,url,downloaded_sha256:sha256(bytes)});}return result;}
  evidence.artifacts_before=await downloads();
  const restartId=randomUUID(),restart=await api('POST',`${base}/environment/restart`,{operation_id:restartId,grant_id:grant});assert.equal(restart.status,200,JSON.stringify(restart.body));assert.equal(restart.body.binding.runtime_id,initial.body.runtime_id);evidence.restart={operation_id:restartId,result:restart.body};
  const rebuildId=randomUUID(),rebuild=await api('POST',`${base}/environment/rebuild`,{operation_id:rebuildId,grant_id:grant});assert.equal(rebuild.status,200,JSON.stringify(rebuild.body));const next=rebuild.body.binding;assert.notEqual(next.runtime_id,initial.body.runtime_id);assert.notEqual(next.environment_id,initial.body.environment_id);assert.ok(next.environment_generation>initial.body.environment_generation);evidence.rebuild={operation_id:rebuildId,result:rebuild.body};
  const replay=await api('POST',`${base}/environment/rebuild`,{operation_id:rebuildId,grant_id:grant});assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.binding.runtime_id,next.runtime_id);evidence.rebuild_replay_same_runtime=true;
  const afterContainer=await inspect(next.runtime_id);assert.equal(afterContainer.Config.Labels['homelab.workspace_id'],fixture.ids.workspace);assert.equal(afterContainer.Mounts.find((m:any)=>m.Destination==='/workspace/project')?.Source,physical.canonical_root);assert.equal(afterContainer.Config.Image,safeImage);assert.equal(afterContainer.Image,beforeContainer.Image);evidence.after_container={id:afterContainer.Id,image_id:afterContainer.Image,image:afterContainer.Config.Image,labels:afterContainer.Config.Labels,mounts:afterContainer.Mounts.map((m:any)=>({source:m.Source,destination:m.Destination,rw:m.RW}))};
  evidence.files_after=await originalFiles();assert.deepEqual(evidence.files_after,evidence.files_before);evidence.artifacts_after=await downloads();
  await stopOwned();evidence.artifacts_host_offline=await downloads();evidence.outcome='PASS';evidence.completed_at=new Date().toISOString();
 }catch(error){evidence.outcome='FAIL';evidence.error=error instanceof Error?error.message:String(error);evidence.host_diagnostic=diagnostic;throw error;}
 finally{await stopOwned();await writeFile(evidencePath,JSON.stringify(evidence,null,2));}
});
