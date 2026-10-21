import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {AgentBroker} from '@homelab/transport';
import {ProfileDefinitionSchema,type PolicyGrant,type Workspace,type Checkpoint} from '@homelab/contracts';
import {BlobStore,RootedHostFileAdapter,createCheckpointForJob,publishCheckpointChanges} from '@homelab/storage';
import {createActionHandler} from '@homelab/actions/handler';
import {createOperationExecutor} from '../../../../worker/src/operations.js';
import {runClaimedJob,type RuntimeContext} from '@homelab/worker/runtime';
import type {JobRow} from '@homelab/worker';
import {buildApp} from '../../app.js';
import {hashPassword} from '../../auth/password.js';
import register from './index.js';

const execute=promisify(execFile),stack='/tmp/homelab-validation-wave2',tmpUnc='\\\\wsl.localhost\\Ubuntu\\tmp';
const wsl=async(...args:string[])=>(await execute('wsl.exe',['-d','Ubuntu','--exec',...args],{windowsHide:true,timeout:45000,maxBuffer:2*1024*1024})).stdout.trim();
const envFile=(text:string)=>Object.fromEntries(text.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1).replace(/^['"]|['"]$/g,'')];}));

test('actual restricted Linux saved command and disposable transient systemd control retain scoped verification/diff evidence',{
  skip:process.env.HOMELAB_ACTIONS_NATIVE_STACK!=='1'?'Requires explicitly owned refreshed validation stack and existing nobody account':false,timeout:180000
},async()=>{
  const settings=envFile(await wsl('sudo','-n','/bin/cat',`${stack}/config/runtime.env`));
  const appUrl=new URL(settings.DATABASE_URL);appUrl.hostname='127.0.0.1';appUrl.port='15439';
  const adminUrl=new URL(await wsl('sudo','-n','/bin/cat',`${stack}/config/database-admin-url`));adminUrl.hostname='127.0.0.1';adminUrl.port='15439';
  assert.equal(appUrl.pathname,'/homelab');assert.equal(adminUrl.pathname,'/homelab');
  const db=new pg.Pool({connectionString:appUrl.href,max:8}),admin=new pg.Pool({connectionString:adminUrl.href,max:3});
  const suffix=randomUUID(),owner=randomUUID(),machine=randomUUID(),workspaceId=randomUUID(),project=randomUUID(),identityId=randomUUID(),profileId=randomUUID(),grantId=randomUUID(),targetId=randomUUID();
  const directory=`/tmp/homelab-actions-control-native-${suffix}`,files=join(tmpUnc,`homelab-actions-control-native-${suffix}`),nativeRoot=`/srv/homelab-actions-native-${suffix}`;
  const projectRoot=`${nativeRoot}/project`,scratch=`${nativeRoot}/scratch`,spool=`${nativeRoot}/spool`,binary=`${nativeRoot}/homelab-agent`,unit=`homelab-actions-control-${suffix}.service`;
  const artifactRoot=resolve('docs/actions/.native-runtime/artifacts');
  const port=40000+Math.floor(Math.random()*10000),processes:Array<{child:ChildProcess;pid:number}>=[],previous=new Map<string,string|undefined>();
  const jobs:string[]=[],ownedUnits=new Set<string>([unit]);
  let app:Awaited<ReturnType<typeof buildApp>>|undefined,nativeCreated=false,diagnostic='';
  const set=(key:string,value:string)=>{previous.set(key,process.env[key]);process.env[key]=value;};
  const launch=async(args:string[])=>{
    const child=spawn('wsl.exe',['-d','Ubuntu','--exec','sudo','-n','sh','-c','echo $$; exec "$@"','homelab-native-actions',binary,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stderr!.on('data',chunk=>{diagnostic=(diagnostic+String(chunk)).slice(-4096);});
    const pid=await new Promise<number>((done,reject)=>{child.stdout!.once('data',chunk=>{const id=Number(String(chunk).split(/\r?\n/)[0]);id>1&&Number.isSafeInteger(id)?done(id):reject(Error('Missing own Linux PID'));});child.once('error',reject);});processes.push({child,pid});
  };
  try {
    const control=(await db.query('SELECT dispatch_enabled,restore_mode,maintenance_mode,dispatch_epoch FROM runtime_control WHERE singleton=true')).rows[0];
    assert.equal(control.dispatch_enabled,true,'Validation owner enables this dedicated runtime');assert.equal(control.restore_mode,false);assert.equal(control.maintenance_mode,false);
    assert.match(await wsl('/usr/bin/getent','passwd','65534'),/^nobody:/);
    await mkdir(files,{recursive:false});await wsl('/bin/chmod','0700',directory);
    await Promise.all(['identity','supervisor','connection','artifacts'].map(name=>mkdir(join(files,name))));
    await writeFile(join(files,'ca.pem'),await wsl('sudo','-n','/bin/cat',`${stack}/config/agent-ca-cert.pem`),{mode:0o600});
    await wsl('sudo','-n','/bin/mkdir',nativeRoot);nativeCreated=true;
    await wsl('sudo','-n','/bin/chmod','0755',nativeRoot);
    await wsl('sudo','-n','/bin/mkdir',projectRoot,scratch,spool);
    await wsl('sudo','-n','/bin/chown','65534:65534',projectRoot,scratch);
    await wsl('sudo','-n','/bin/chmod','0700',projectRoot,scratch,spool);
    await wsl('sudo','-n','/bin/cp','--',process.env.HOMELAB_ACTIONS_AGENT_LINUX??'/mnt/c/Projects/Home-Lab-Dashboard/agent/bin/homelab-agent-linux-debug-amd64',binary);
    await wsl('sudo','-n','/bin/chmod','0755',binary);
    const actionScript='import json,os,pathlib,sys\ndenied=False\ntry:\n pathlib.Path("../outside-denied.txt").write_text("forbidden")\nexcept OSError as error:\n if error.errno not in (1,13,30):\n  raise\n denied=True\nresult={"uid":os.getuid(),"gid":os.getgid(),"label":sys.argv[1],"outside_write_denied":denied}\npathlib.Path("result.txt").write_text(json.dumps(result)+"\\n")\nprint(json.dumps(result))\nassert result["uid"]==65534 and result["gid"]==65534 and denied\n';
    const verifyScript='import json,pathlib,os\nresult=json.loads(pathlib.Path("result.txt").read_text())\nassert result=={"uid":65534,"gid":65534,"label":"native-proof","outside_write_denied":True}\nassert os.getuid()==65534\nprint("verification passed as uid="+str(os.getuid()))\n';
    for(const [name,body]of [['action.py',actionScript],['verify.py',verifyScript]]) {await writeFile(join(files,name),body);await wsl('sudo','-n','/bin/cp','--',`${directory}/${name}`,`${nativeRoot}/${name}`);await wsl('sudo','-n','/bin/chmod','0644',`${nativeRoot}/${name}`);}
    const password=randomBytes(24).toString('base64url'),limits={max_tool_steps:12,wall_time_seconds:120,per_command_timeout_seconds:30,max_output_bytes:1048576};
    await admin.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[owner,`${owner}@native-actions.invalid`,await hashPassword(password)]);
    await admin.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'Actual restricted Linux action fixture','linux')",[machine,owner]);
    await admin.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Dedicated native action fixture')",[project,owner]);
    await admin.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,quota_bytes) VALUES($1,$2,$3,'Native fixture','native',$4,'native-action-proof',$5,$5,16777216)",[workspaceId,owner,project,machine,projectRoot]);
    await admin.query("INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity,restriction_verified,config) VALUES($1,$2,$3,'Existing nobody restricted identity','65534:65534',false,$4)",[identityId,owner,machine,{workspace_ids:[workspaceId],network_policy_verified:false,network_policy:'deny'}]);
    const profile=ProfileDefinitionSchema.parse({instructions:'Fixed saved actions only within this disposable project',tools:['actions.run','run_command','file.read'],machine_ids:[machine],workspace_ids:[workspaceId],execution_identity_ids:[identityId],limits,network_policy:{mode:'deny',allowed_hosts:[]}});
    await admin.query("INSERT INTO agent_profiles(id,owner_id,name,current_revision) VALUES($1,$2,'Fixed native proof profile',1)",[profileId,owner]);
    await admin.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition) VALUES($1,1,$2,$3)',[profileId,profile.instructions,profile]);
    const grant:PolicyGrant={id:grantId,owner_id:owner,revision:1,tools:['actions.run','run_command','file.read'],machine_ids:[machine],workspace_ids:[workspaceId],profile_ids:[profileId],secret_ids:[],expires_at:null,revoked_at:null};
    await admin.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids,profile_ids) VALUES($1,$2,$3,$4,$5,$6)',[grantId,owner,JSON.stringify(grant.tools),JSON.stringify(grant.machine_ids),JSON.stringify(grant.workspace_ids),JSON.stringify(grant.profile_ids)]);
    const token=randomBytes(32).toString('base64url');await writeFile(join(files,'enrollment-token'),token,{mode:0o600});
    await admin.query("INSERT INTO agent_enrollments(id,machine_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[randomUUID(),machine,createHash('sha256').update(token).digest('hex')]);
    await wsl(binary,'enroll','--endpoint','https://127.0.0.1:3449/agent/v1/enroll','--ca',`${directory}/ca.pem`,'--machine-id',machine,'--identity-dir',`${directory}/identity`,'--token-file',`${directory}/enrollment-token`);
    const enrolled=JSON.parse(await readFile(join(files,'identity','identity.json'),'utf8')),localToken=randomBytes(32).toString('base64url');await writeFile(join(files,'local-token'),localToken,{mode:0o600});
    await wsl('sudo','-n','/usr/bin/systemd-run','--quiet',`--unit=${unit}`,'--service-type=exec','--property=User=65534','--property=Group=65534','--property=NoNewPrivileges=yes','--property=Restart=no','--','/usr/bin/sleep','180');
    await writeFile(join(files,'supervisor.json'),JSON.stringify({machine_id:machine,dispatch_epoch:enrolled.dispatch_epoch,data_dir:`${directory}/supervisor`,listen:`127.0.0.1:${port}`,local_token_file:`${directory}/local-token`,identity_dir:`${directory}/identity`,require_signed_rpc:true,systemctl_path:'/usr/bin/systemctl',workspaces:[{id:workspaceId,root:projectRoot,approved_root_id:'native-action-proof',runtime_path:projectRoot,type:'native',quota_bytes:16777216,revision:1,execution_identity_id:identityId,policy_revision:1,grant_ids:[grantId],writable:true,container_enabled:false,native_enabled:true,native_network_policy:'none',cpus:0.5,memory_bytes:67108864,pids_limit:32,max_output_bytes:1048576,native:{root:projectRoot,scratch,spool_dir:spool,uid:65534,gid:65534,acl_reviewed:true,systemd_run:'/usr/bin/systemd-run',systemctl:'/usr/bin/systemctl'}}],targets:[{id:targetId,kind:'systemd',name:unit,grant_ids:[grantId],policy_revision:1,allowed_operations:['status','restart']}]}));
    await writeFile(join(files,'connection.json'),JSON.stringify({machine_id:machine,control_plane_url:'https://127.0.0.1:3449',server_ca_file:`${stack}/config/agent-ca-cert.pem`,identity_dir:`${directory}/identity`,supervisor_url:`http://127.0.0.1:${port}`,local_token_file:`${directory}/local-token`,data_dir:`${directory}/connection`,telemetry_interval_seconds:2}));
    await launch(['supervisor','--config',`${directory}/supervisor.json`]);await delay(800);await launch(['connect','--config',`${directory}/connection.json`]);
    const signer={keyId:await wsl('sudo','-n','/bin/cat',`${stack}/config/dispatch-key-id`),privateKeyPem:await wsl('sudo','-n','/bin/cat',`${stack}/config/dispatch-private.pem`)};
    await writeFile(join(files,'dispatch-private.pem'),signer.privateKeyPem,{mode:0o600});
    set('DISPATCH_ENABLED','true');set('RESTORE_MODE','false');set('NODE_ENV','test');set('COOKIE_SECURE','false');set('APP_ORIGIN','http://127.0.0.1:3019');set('MASTER_KEY',settings.MASTER_KEY);set('ARTIFACT_ROOT',artifactRoot);set('DISPATCH_SIGNING_KEY_ID',signer.keyId);set('DISPATCH_SIGNING_KEY_FILE',join(files,'dispatch-private.pem'));
    const broker=new AgentBroker(db,{signer});await broker.rpc(machine,'GET','/v1/health',null,{ownerId:owner,expectedMachineGeneration:enrolled.machine_identity_generation,timeoutMs:15000});
    let proof:{verified:boolean;identity:string};
    try {proof=await broker.rpc(machine,'POST',`/v1/identities/${identityId}/verify`,{}, {ownerId:owner,expectedMachineGeneration:enrolled.machine_identity_generation,scopeGrantId:grantId,scopeTool:'run_command',timeoutMs:45000}) as {verified:boolean;identity:string};}
    catch(error) {const names=(await wsl('sudo','-n','/bin/ls',spool)).split(/\r?\n/).filter(n=>/^identity-probe-[a-f0-9]{24}\.log$/.test(n));let output='';for(const name of names){output+=(await wsl('sudo','-n','/bin/cat',`${spool}/${name}`)).slice(-4096);output+=await wsl('sudo','-n','/usr/bin/systemctl','show',`homelab-${name.slice(0,-4)}.service`,'--property=Result,ExecMainCode,ExecMainStatus,User,Group','--no-pager').catch(()=>'');}throw Error(`${error instanceof Error?error.message:'identity_probe_failed'}; disposable probe output: ${output}`);}
    assert.equal(proof.verified,true,diagnostic);assert.equal(proof.identity,'65534');
    await db.query('UPDATE execution_identities SET restriction_verified=true,config=$2 WHERE id=$1',[identityId,{workspace_ids:[workspaceId],network_policy_verified:true,network_policy:'deny'}]);
    const store=new BlobStore(artifactRoot,64*1024*1024,{db});
    const checkpoint=async(job:JobRow,runtime:RuntimeContext,reason:string)=>{
      const workspace=(await db.query('SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2',[job.workspace_id,owner])).rows[0] as Workspace;workspace.quota_bytes=Number(workspace.quota_bytes);
      const adapter=new RootedHostFileAdapter((m,method,path,body,options)=>broker.rpc(m,method,path,body,{...options,ownerId:owner,scopeGrantId:grantId,scopeTool:'file.read',signal:runtime.signal,jobGuard:{job_id:job.id,fence:job.fence,lease_owner:job.lease_owner??undefined,workspace_id:workspaceId}}));
      const result=await createCheckpointForJob({db,store,adapter,workspace,job,reason,assertLease:()=>runtime.assertLease()});return {id:result.id,manifest_hash:result.manifest_hash,consistency:result.consistency};
    };
    const handler=createActionHandler(createOperationExecutor({broker,checkpoint,publishChanges:async(job,runtime,operation_id,before,after)=>{
      const ids=[(before as {id:string}).id,(after as {id:string}).id];
      const snapshots=(await db.query<Checkpoint>('SELECT * FROM checkpoints WHERE id=ANY($1::uuid[])',[ids])).rows;
      return publishCheckpointChanges({db,store,job,operation_id,before:snapshots.find(c=>c.id===ids[0])!,after:snapshots.find(c=>c.id===ids[1])!,attribution:'recorded_tool',assertLease:()=>runtime.assertLease()});
    }}));
    app=await buildApp({db,modules:[register]});const address=await app.listen({host:'127.0.0.1',port:0});let cookie='',csrf='';
    const http=async(method:string,path:string,body?:unknown)=>{const response=await fetch(new URL(path,address),{method,headers:{origin:'http://127.0.0.1:3019',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json() as any,headers:response.headers};};
    const login=await http('POST','/api/v1/auth/login',{email:`${owner}@native-actions.invalid`,password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];csrf=login.body.csrf_token;
    const definition={schema_version:1,machine_ids:[machine],workspace_ids:[workspaceId],profile_ids:[profileId],parameters:{label:{type:'enum',values:['native-proof']}},command:{executable:'/usr/bin/python3',args:[{literal:`${nativeRoot}/action.py`},{parameter:'label'}],cwd_policy:'workspace_root'},verification:{command:{executable:'/usr/bin/python3',args:[{literal:`${nativeRoot}/verify.py`}],cwd_policy:'workspace_root'},expected_exit_code:0},limits};
    const created=await http('POST','/api/v1/actions',{name:'Actual restricted-account fixed action',definition});assert.equal(created.status,201,JSON.stringify(created.body));
    const payload={revision:1,machine_id:machine,workspace_id:workspaceId,profile_id:profileId,execution_identity_id:identityId,grant_id:grantId,parameters:{label:'native-proof'},idempotency_key:`native-${suffix}`};
    assert.equal((await http('POST',`/api/v1/actions/${created.body.id}/runs`,{...payload,parameters:{label:'native-proof; touch /tmp/forbidden'}})).status,403);
    const queued=await Promise.all([http('POST',`/api/v1/actions/${created.body.id}/runs`,payload),http('POST',`/api/v1/actions/${created.body.id}/runs`,payload)]);for(const result of queued)assert.equal(result.status,202,JSON.stringify(result.body));assert.equal(queued[0].body.id,queued[1].body.id);
    const drive=async(jobId:string)=>{
      jobs.push(jobId);
      for(let attempt=0;attempt<80;attempt++) {
        const row=(await db.query<JobRow>('SELECT * FROM jobs WHERE id=$1 AND requester_id=$2',[jobId,owner])).rows[0];
        if(['completed','failed','interrupted','cancelled'].includes(row.state))return row;
        const client=await db.connect();let claimed:JobRow|undefined;
        try {await client.query('BEGIN');if(row.workspace_id) {await client.query('INSERT INTO workspace_locks(workspace_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[row.workspace_id,row.id]);assert.equal((await client.query('SELECT job_id FROM workspace_locks WHERE workspace_id=$1',[row.workspace_id])).rows[0].job_id,row.id);}claimed=(await client.query<JobRow>("UPDATE jobs SET lease_owner=$2,lease_until=now()+interval '30 seconds',fence=fence+1,state='running',started_at=COALESCE(started_at,now()) WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) RETURNING *",[jobId,`actual-native-${suffix}`])).rows[0];await client.query('COMMIT');} catch(error) {await client.query('ROLLBACK');throw error;}finally{client.release();}
        if(claimed)await runClaimedJob(db,claimed,{saved_action:handler});await delay(300);
      }throw Error('Own native action did not reach a known outcome');
    };
    const finished=await drive(queued[0].body.id);const observedOperations=(await db.query('SELECT id,step_id,status,receipt,outcome FROM operations WHERE job_id=$1 ORDER BY created_at',[finished.id])).rows;assert.equal(finished.state,'completed',JSON.stringify({state:finished.state,reason:finished.reason,operations:observedOperations,diagnostic}));
    const result=finished.result as any;assert.equal(result.verification.status,'passed');assert.equal(result.execution_evidence.length,2);
    assert.ok(result.execution_evidence.every((e:any)=>e.before_checkpoint_id&&e.after_checkpoint_id));
    const change=result.execution_evidence[0].changed_files.find((entry:any)=>entry.path==='result.txt');assert.ok(change,'Primary command has an actual retained file change');assert.match(change.details.diff_artifact_id,/^[a-f0-9-]{36}$/);
    const diff=(await db.query('SELECT sha256 FROM artifacts WHERE id=$1 AND owner_id=$2',[change.details.diff_artifact_id,owner])).rows[0];assert.ok(diff);assert.match((await store.get(diff.sha256)).toString('utf8'),/native-proof/);
    const operations=(await db.query('SELECT id,step_id,request,receipt FROM operations WHERE job_id=$1 ORDER BY created_at,id',[finished.id])).rows;
    assert.deepEqual(operations.map(op=>op.step_id),['action_command','action_verification']);
    assert.ok(operations.every(op=>op.request.saved_action?.action_id===created.body.id&&op.request.saved_action.revision===1&&/^[a-f0-9]{64}$/.test(op.request.saved_action.definition_hash)&&op.request.grant.tools.includes('actions.run')&&op.request.grant.tools.includes('run_command')));
    const reader=new RootedHostFileAdapter((m,method,path,body,options)=>broker.rpc(m,method,path,body,{...options,ownerId:owner,expectedMachineGeneration:enrolled.machine_identity_generation,scopeGrantId:grantId,scopeTool:'file.read'}));
    const workspace=(await db.query('SELECT * FROM workspaces WHERE id=$1',[workspaceId])).rows[0] as Workspace;workspace.quota_bytes=Number(workspace.quota_bytes);
    const content=await reader.read(workspace,'result.txt');const observed=JSON.parse(Buffer.from(content).toString('utf8'));assert.deepEqual(observed,{uid:65534,gid:65534,label:'native-proof',outside_write_denied:true});
    assert.equal((await http('POST','/api/v1/actions/targets',{id:targetId,machine_id:machine,name:'Only newly created transient sleep service',kind:'systemd',allowed_operations:['restart','status']})).status,201);
    const controlAction=await http('POST','/api/v1/actions',{name:'Disposable transient systemd restart',definition:{schema_version:1,machine_ids:[machine],helper:{type:'systemd',target_id:targetId,operation:'restart'},parameters:{},limits}});assert.equal(controlAction.status,201);
    const controlQueued=await http('POST',`/api/v1/actions/${controlAction.body.id}/runs`,{revision:1,machine_id:machine,grant_id:grantId,idempotency_key:`systemd-${suffix}`});assert.equal(controlQueued.status,202);
    const controlFinished=await drive(controlQueued.body.id);assert.equal(controlFinished.state,'completed',JSON.stringify({state:controlFinished.state,reason:controlFinished.reason,diagnostic}));assert.equal((controlFinished.result as any).verification.observed,'running');
    await writeFile('docs/actions/actual-native-results.json',JSON.stringify({schema_version:1,verified_at:new Date().toISOString(),fixture:'New dedicated native project under existing nobody65534, no account/security changes or persistent service install',machine_id:machine,workspace_id:workspaceId,identity_id:identityId,job_id:finished.id,action_id:created.body.id,observed_identity:observed,identity_proof:proof,verification:result.verification,execution_evidence:result.execution_evidence,operations:operations.map(op=>({id:op.id,step_id:op.step_id,source:op.request.saved_action,state:op.receipt.state})),systemd:{unit,target_id:targetId,job_id:controlFinished.id,verification:(controlFinished.result as any).verification},credentials:'omitted',cleanup:'Only own supervisor/connector, transient services and unique directories; dedicated-stack DB evidence retained'},null,2)+'\n');
    await http('POST','/api/v1/auth/logout',{});
  } finally {
    await app?.close();
    for(const process of processes.reverse())if(process.child.exitCode===null&&process.child.signalCode===null){await wsl('sudo','-n','/bin/kill','-TERM',String(process.pid)).catch(()=>undefined);process.child.kill();}
    for(const job of jobs)for(const row of (await db.query('SELECT id FROM operations WHERE job_id=$1 AND machine_id=$2',[job,machine]).catch(()=>({rows:[]}))).rows)ownedUnits.add(`homelab-${row.id}.service`);
    if(nativeCreated){const logs=await wsl('sudo','-n','/bin/ls',spool).catch(()=>'');for(const name of logs.split(/\r?\n/))if(/^identity-probe-[a-f0-9]{24}\.log$/.test(name))ownedUnits.add(`homelab-${name.slice(0,-4)}.service`);}
    for(const name of ownedUnits){await wsl('sudo','-n','/usr/bin/systemctl','stop',name).catch(()=>undefined);await wsl('sudo','-n','/usr/bin/systemctl','reset-failed',name).catch(()=>undefined);}
    if(nativeCreated)await wsl('sudo','-n','/usr/bin/python3','-c','import pathlib,shutil,sys;p=pathlib.Path(sys.argv[1]);assert p.parent==pathlib.Path("/srv") and p.name.startswith("homelab-actions-native-") and p.resolve()==p;shutil.rmtree(p)',nativeRoot).catch(()=>undefined);
    // The root supervisor can create protected quarantine directories within this fixture.
    // Validate the exact generated Linux path before removing those owned test files.
    await wsl('sudo','-n','/usr/bin/python3','-c','import pathlib,shutil,sys;p=pathlib.Path(sys.argv[1]);assert p.parent==pathlib.Path("/tmp") and p.name==sys.argv[2] and p.resolve()==p;shutil.rmtree(p)',directory,`homelab-actions-control-native-${suffix}`).catch(()=>undefined);
    for(const [key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await db.end();await admin.end();
  }
});

