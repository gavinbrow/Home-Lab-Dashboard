import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile,spawn,type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { AgentBroker } from '@homelab/transport';
import { createActionHandler } from '@homelab/actions/handler';
import { createOperationExecutor } from '../../../../worker/src/operations.js';
import { runClaimedJob } from '@homelab/worker/runtime';
import type { JobRow } from '@homelab/worker';
import { buildApp } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import register from './index.js';

const execute=promisify(execFile);
const stack='/tmp/homelab-validation-wave2';
const unc='\\\\wsl.localhost\\Ubuntu\\tmp\\homelab-validation-wave2';
const image='node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
const wsl=async(...args:string[]) => (await execute('wsl.exe',['-d','Ubuntu','--exec',...args],{windowsHide:true,timeout:30000,maxBuffer:1024*1024})).stdout.trim();

// Explicit opt-in: operates only on a newly created, labelled disposable container.
test('actual Linux Docker saved action: authenticated HTTP -> durable worker -> signed mTLS Go helper -> verified restart',{
  skip:process.env.HOMELAB_ACTIONS_STACK!=='1'?'Requires explicitly owned NEW homelab-validation-wave2 stack':false,timeout:120000
},async()=>{
  const values=Object.fromEntries((await readFile(join(unc,'config','runtime.env'),'utf8')).split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1).replace(/^['"]|['"]$/g,'')];}));
  const url=new URL(values.DATABASE_URL);url.hostname='127.0.0.1';url.port='15439';
  assert.equal(url.pathname,'/homelab');
  const db=new pg.Pool({connectionString:url.href,max:6});
  const suffix=randomUUID(),owner=randomUUID(),machine=randomUUID(),target=randomUUID(),grant=randomUUID();
  const directory=`${stack}/actions-${suffix}`,files=join(unc,`actions-${suffix}`);
  const containerName=`homelab-validation-actions-${suffix}`;
  const sourceBinary=process.env.HOMELAB_ACTIONS_AGENT_LINUX??'/mnt/c/Projects/Home-Lab-Dashboard/agent/bin/homelab-agent-linux-debug-amd64';
  const binary=`${directory}/homelab-agent`;
  const port=40000+Math.floor(Math.random()*10000);
  const processes:Array<{child:ChildProcess;pid:number}> = [];
  const previous=new Map<string,string|undefined>();
  let containerId:string|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
  const set=(key:string,value:string)=>{previous.set(key,process.env[key]);process.env[key]=value;};
  let diagnostic='';
  const launch=async(args:string[])=>{
    const child=spawn('wsl.exe',['-d','Ubuntu','--exec','sh','-c','echo $$; exec "$@"','homelab-actions',binary,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stderr!.on('data',chunk=>{diagnostic=(diagnostic+String(chunk)).slice(-4096);});
    const pid=await new Promise<number>((resolve,reject)=>{child.stdout!.once('data',chunk=>{const value=Number(String(chunk).split(/\r?\n/)[0]);Number.isSafeInteger(value)&&value>1?resolve(value):reject(Error('Missing Linux process identity'));});child.once('error',reject);});
    processes.push({child,pid});
  };
  try {
    const control=(await db.query('SELECT dispatch_enabled,restore_mode,maintenance_mode,dispatch_epoch FROM runtime_control WHERE singleton=true')).rows[0];
    assert.equal(control.restore_mode,false);assert.equal(control.maintenance_mode,false);
    // The validation owner authorized enabling this NEW dedicated stack; other concurrent tests need it left enabled.
    if(!control.dispatch_enabled) await db.query('UPDATE runtime_control SET dispatch_enabled=true WHERE singleton=true AND restore_mode=false AND maintenance_mode=false');
    await mkdir(files,{recursive:false});
    await wsl('/bin/chmod','0700',directory);
    await Promise.all(['identity','supervisor','connection','artifacts'].map(name=>mkdir(join(files,name))));
    await wsl('/bin/cp','--',sourceBinary,binary);
    await wsl('/bin/chmod','0700',binary);
    const password=randomBytes(24).toString('base64url');
    await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[owner,`${owner}@actions.invalid`,await hashPassword(password)]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'Actual disposable WSL Linux helper','linux')",[machine,owner]);
    await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids) VALUES($1,$2,$3,$4)',[grant,owner,JSON.stringify(['actions.run']),JSON.stringify([machine])]);
    const token=randomBytes(32).toString('base64url');
    await db.query("INSERT INTO agent_enrollments(id,machine_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[randomUUID(),machine,createHash('sha256').update(token).digest('hex')]);
    await writeFile(join(files,'enrollment-token'),token,{mode:0o600});
    await wsl(binary,'enroll','--endpoint','https://127.0.0.1:3449/agent/v1/enroll','--ca',`${stack}/config/agent-ca-cert.pem`,'--machine-id',machine,'--identity-dir',`${directory}/identity`,'--token-file',`${directory}/enrollment-token`);
    const identity=JSON.parse(await readFile(join(files,'identity','identity.json'),'utf8'));
    assert.equal(identity.machine_id,machine);
    containerId=await wsl('/usr/bin/docker','run','-d','--name',containerName,'--label',`homelab.machine_id=${machine}`,'--label',`homelab.validation=actions-${suffix}`,'--user','10001:10001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--network','none','--pids-limit','32','--memory','64m','--cpus','0.5',image,'node','-e','setInterval(()=>{},1000)');
    assert.match(containerId,/^[a-f0-9]{64}$/);
    const before=await wsl('/usr/bin/docker','inspect','--format','{{.State.StartedAt}}',containerId);
    const localToken=randomBytes(32).toString('base64url');await writeFile(join(files,'local-token'),localToken,{mode:0o600});
    await writeFile(join(files,'supervisor.json'),JSON.stringify({machine_id:machine,dispatch_epoch:identity.dispatch_epoch,data_dir:`${directory}/supervisor`,listen:`127.0.0.1:${port}`,local_token_file:`${directory}/local-token`,docker_path:'/usr/bin/docker',identity_dir:`${directory}/identity`,require_signed_rpc:true,workspaces:[],targets:[{id:target,kind:'docker_container',runtime_id:containerId,name:containerName,grant_ids:[grant],policy_revision:1,allowed_operations:['restart','status','logs']}]}));
    await writeFile(join(files,'connection.json'),JSON.stringify({machine_id:machine,control_plane_url:'https://127.0.0.1:3449',server_ca_file:`${stack}/config/agent-ca-cert.pem`,identity_dir:`${directory}/identity`,supervisor_url:`http://127.0.0.1:${port}`,local_token_file:`${directory}/local-token`,data_dir:`${directory}/connection`,telemetry_interval_seconds:2}));
    await launch(['supervisor','--config',`${directory}/supervisor.json`]);
    await delay(1000);
    await launch(['connect','--config',`${directory}/connection.json`]);
    const signer={keyId:(await readFile(join(unc,'config','dispatch-key-id'),'utf8')).trim(),privateKeyPem:await readFile(join(unc,'config','dispatch-private.pem'),'utf8')};
    const broker=new AgentBroker(db,{signer});
    set('DISPATCH_ENABLED','true');set('RESTORE_MODE','false');set('NODE_ENV','test');set('COOKIE_SECURE','false');set('APP_ORIGIN','http://127.0.0.1:3019');set('MASTER_KEY',values.MASTER_KEY);set('ARTIFACT_ROOT',join(files,'artifacts'));set('DISPATCH_SIGNING_KEY_ID',signer.keyId);set('DISPATCH_SIGNING_KEY_FILE',join(unc,'config','dispatch-private.pem'));
    const health=await broker.rpc(machine,'GET','/v1/health',null,{ownerId:owner,timeoutMs:15000}) as {machine_id:string};assert.equal(health.machine_id,machine,diagnostic);
    app=await buildApp({db,modules:[register]});
    const address=await app.listen({host:'127.0.0.1',port:0});
    let cookie='',csrf='';
    const http=async(method:string,path:string,body?:unknown)=>{
      const response=await fetch(new URL(path,address),{method,headers:{origin:'http://127.0.0.1:3019',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
      return {status:response.status,body:await response.json() as any,headers:response.headers};
    };
    const logged=await http('POST','/api/v1/auth/login',{email:`${owner}@actions.invalid`,password});assert.equal(logged.status,200);cookie=logged.headers.get('set-cookie')!.split(';')[0];csrf=logged.body.csrf_token;
    const registered=await http('POST','/api/v1/actions/targets',{id:target,machine_id:machine,name:'New dedicated Docker validation target',kind:'docker_container',allowed_operations:['restart','status','logs']});assert.equal(registered.status,201);
    const saved=await http('POST','/api/v1/actions',{name:'Actual disposable Docker restart',definition:{schema_version:1,machine_ids:[machine],parameters:{},helper:{type:'docker_container',target_id:target,operation:'restart'},limits:{wall_time_seconds:90,per_command_timeout_seconds:30}}});assert.equal(saved.status,201);
    const request={revision:1,machine_id:machine,grant_id:grant,idempotency_key:`actual-${suffix}`};
    const responses=await Promise.all([http('POST',`/api/v1/actions/${saved.body.id}/runs`,request),http('POST',`/api/v1/actions/${saved.body.id}/runs`,request)]);
    for(const response of responses) assert.equal(response.status,202,JSON.stringify(response.body));
    const jobId=responses[0].body.id;assert.equal(responses[1].body.id,jobId);
    const handler=createActionHandler(createOperationExecutor({broker,checkpoint:async()=>{throw Error('Admin target has no project checkpoint');}}));
    let job:any;
    for(let attempt=0;attempt<60;attempt++) {
      job=(await db.query('SELECT * FROM jobs WHERE id=$1 AND requester_id=$2',[jobId,owner])).rows[0];
      if(['completed','failed','interrupted','cancelled'].includes(job.state)) break;
      const claimed=(await db.query<JobRow>("UPDATE jobs SET lease_owner=$2,lease_until=now()+interval '30 seconds',fence=fence+1,state='running',started_at=COALESCE(started_at,now()) WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) RETURNING *",[jobId,`actual-actions-${suffix}`])).rows[0];
      if(claimed) await runClaimedJob(db,claimed,{saved_action:handler});
      await delay(500);
    }
    assert.equal(job.state,'completed',JSON.stringify({state:job.state,reason:job.reason,diagnostic}));
    assert.equal(job.result.verification.status,'passed');assert.equal(job.result.verification.observed,'running');
    const after=await wsl('/usr/bin/docker','inspect','--format','{{.State.StartedAt}}',containerId);assert.notEqual(after,before);
    assert.equal(await wsl('/usr/bin/docker','inspect','--format','{{.State.Running}}',containerId),'true');
    const operations=(await db.query('SELECT id,step_id,status,receipt FROM operations WHERE job_id=$1 ORDER BY created_at',[jobId])).rows;
    assert.deepEqual(operations.map(op=>op.step_id),['action_control','action_postcondition']);assert.ok(operations.every(op=>op.status==='succeeded'&&op.receipt.request_hash));
    assert.equal((await db.query('SELECT count(*)::int AS count FROM action_dispatches WHERE action_id=$1',[saved.body.id])).rows[0].count,1);
    assert.equal((await http('GET','/api/v1/actions/capabilities')).body.container_controls.health_state,'healthy');
    const evidence={schema_version:1,fixture:'Dedicated disposable WSL Linux Docker container; actual HTTP/auth/PG/signed mTLS relay/Go helper',verified_at:new Date().toISOString(),machine_id:machine,target_id:target,job_id:jobId,container_id:containerId,image,started_at_before:before,started_at_after:after,operations:operations.map(op=>({id:op.id,step_id:op.step_id,status:op.status,request_hash:op.receipt.request_hash})),verification:job.result.verification,idempotency:'Two concurrent identical HTTP submissions produced one job and dispatch',credentials:'omitted',cleanup:'Only newly created test container/processes/config; DB rows retained in dedicated validation stack'};
    await writeFile('docs/actions/actual-docker-results.json',JSON.stringify(evidence,null,2)+'\n');
    await http('POST','/api/v1/auth/logout',{});
  } finally {
    await app?.close();
    for(const process of processes.reverse()) if(process.child.exitCode===null&&process.child.signalCode===null) {await wsl('/bin/kill','-TERM',String(process.pid)).catch(()=>undefined);process.child.kill();}
    if(containerId) await wsl('/usr/bin/docker','rm','-f',containerId).catch(()=>undefined);
    // This exact generated child directory is the only filesystem cleanup target.
    const cleanupPath=resolve(files),cleanupRoot=resolve(unc);
    if(cleanupPath===join(cleanupRoot,`actions-${suffix}`)&&cleanupPath.startsWith(cleanupRoot+'\\actions-')&&suffix.length===36) await rm(cleanupPath,{recursive:true,force:true}).catch(()=>undefined);
    for(const [key,value] of previous) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await db.end();
  }
});
