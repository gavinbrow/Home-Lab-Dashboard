import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { AgentBroker } from '@homelab/transport';
import { submitJob } from '../../apps/worker/src/queue.js';
import { linux, stackRoot, stackUnc } from './helpers/linux-stack.js';

test('continue exact owned controls journal after test-only short Docker ID assertion', {
  skip: process.env.HOMELAB_CONTROLS_CONTINUE !== '1' ? 'Explicit continuation of retained owned fixture only' : false, timeout: 200_000
}, async () => {
  const prior = JSON.parse(await readFile('docs/acceptance/runtime-controls-first-physical-partial.json', 'utf8'));
  assert.equal(prior.ids.workspace, '237909ca-eb58-4984-9c10-fa4d6e72ea87');
  assert.equal(prior.lost_ack.job.state, 'cancelled');
  assert.match(prior.error, /a09eff97f588/);
  const ids = prior.ids, directory = prior.fixture_directory;
  assert.match(directory, /^\/tmp\/homelab-validation-wave2\/sentinel-[a-f0-9-]{36}$/);
  const files = '\\\\wsl.localhost\\Ubuntu' + directory.replaceAll('/', '\\'), project = join(files, 'project');
  const admin = new URL(await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/database-admin-url`)); admin.hostname = '127.0.0.1'; admin.port = '15439';
  const db = new pg.Pool({ connectionString: admin.href, max: 4 });
  const evidence: Record<string, any> = { outcome: 'RUNNING', started_at: new Date().toISOString(), scope: 'Same exact control fixture/journal; no repeat lostACK/queued-cancel/timeout launch', prior_evidence: 'runtime-controls-first-physical-partial.json', ids, worker_image: prior.worker_image, host_sha256: prior.host_sha256 };
  const children: Array<{child: ChildProcess; pid: number}> = [], workers: string[] = [];
  process.env.DISPATCH_ENABLED = 'true';
  const endJob = async (id: string) => {
    for (let i = 0; i < 280; i++) { const row = (await db.query('SELECT id,state,reason,result FROM jobs WHERE id=$1 AND requester_id=$2', [id, ids.owner])).rows[0]; if (['completed','failed','interrupted','cancelled'].includes(row.state)) return row; await delay(250); }
    throw Error('Owned continuation did not reach authoritative terminal outcome');
  };
  const launchHost = async (args: string[]) => {
    const child = spawn('wsl.exe', ['-d','Ubuntu','--exec','sh','-c','echo $$; exec "$@"','homelab-owned-control-continuation',`${directory}/homelab-agent`,...args], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    const pid = await new Promise<number>((done,reject) => { child.stdout!.once('data', raw => { const value = Number(String(raw).split(/\r?\n/)[0]); Number.isSafeInteger(value) && value > 1 ? done(value) : reject(Error('Owned process PID missing')); }); child.once('error',reject); });
    children.push({child,pid});
  };
  try {
    assert.equal((await linux('/usr/bin/sha256sum', `${directory}/homelab-agent`)).split(' ')[0], '8111acfb7678d09b22e19ff39674a2827a6bdb855800cf098411e751af4f44a1');
    const connection = JSON.parse(await readFile(join(files,'connection.json'),'utf8')); assert.equal(connection.machine_id, ids.machine); connection.control_plane_url = 'https://127.0.0.1:3459'; await writeFile(join(files,'connection.json'), JSON.stringify(connection), {mode:0o600});
    const timeoutOp = await readFile(join(project,'timeout-start'),'utf8');
    const timed = (await db.query('SELECT id,payload FROM jobs WHERE requester_id=$1 AND id NOT IN($2,$3)', [ids.owner,prior.lost_ack.job_id,prior.queued_cancel.job_id])).rows; assert.equal(timed.length,1);
    assert.equal((await db.query('SELECT id FROM operations WHERE id=$1 AND job_id=$2',[timeoutOp,timed[0].id])).rowCount,1);
    const containerId = await linux('/usr/bin/docker','ps','-aq','--no-trunc','--filter',`label=homelab.operation=${timeoutOp}`); assert.match(containerId,/^[a-f0-9]{64}$/);
    const physical = JSON.parse(await linux('/usr/bin/docker','inspect','--format','{{json .}}',containerId)); assert.equal(physical.State.Running,false);
    evidence.offline_timeout = {job_id:timed[0].id,operation_id:timeoutOp,container:physical.Id,state:physical.State};
    await launchHost(['supervisor','--config',`${directory}/supervisor.json`]); await delay(700); await launchHost(['connect','--config',`${directory}/connection.json`]);
    const oldWorker = `homelab-validation-controls-worker-${timed[0].id}`;
    assert.equal(await linux('/usr/bin/docker','inspect','--format','{{.Image}}',oldWorker),prior.worker_image); await linux('/usr/bin/docker','start',oldWorker); workers.push(oldWorker);
    evidence.offline_timeout.job = await endJob(timed[0].id);
    assert.notEqual(evidence.offline_timeout.job.state,'completed');
    evidence.offline_timeout.operations = (await db.query('SELECT id,status,receipt,outcome FROM operations WHERE job_id=$1',[timed[0].id])).rows; assert.equal(evidence.offline_timeout.operations.length,1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM workspace_locks WHERE job_id=$1',[timed[0].id])).rows[0].n,0);
    const baseConfig = JSON.parse(await readFile(join(files,`controls-${timed[0].id}.json`),'utf8'));
    const submit = async (label:string,script:string,output=2048) => {
      const payload = structuredClone(timed[0].payload); payload.execution_context.limits.per_command_timeout_seconds=10; payload.execution_context.limits.max_output_bytes=output; payload.command={executable:'/usr/local/bin/node',args:['-e',script]};
      const job=await submitJob(db,{requester_id:ids.owner,idempotency_key:`continuation-${label}-${ids.workspace}`,kind:'command',context:null,workspace_id:ids.workspace,modifies_workspace:true,payload});
      const file=`controls-${job.id}.json`; await writeFile(join(files,file),JSON.stringify({...baseConfig,jobId:job.id}),{mode:0o600});
      await linux('sudo','-n','/bin/chown','1000:10001',`${directory}/${file}`); await linux('/bin/chmod','0440',`${directory}/${file}`);
      const worker=await linux('/usr/bin/docker','run','-d','--name',`homelab-validation-controls-worker-${job.id}`,'--label',`homelab.validation_job=${job.id}`,'--user','10001:10001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--network','homelab-validation-wave2_internal','--memory','512m','--cpus','1','--pids-limit','64','--tmpfs','/tmp:rw,nosuid,noexec,size=64m','--env','DISPATCH_ENABLED=true','--env','RESTORE_MODE=false','--mount',`type=bind,source=${directory}/controls-worker.ts,target=/app/tests/integration/helpers/precursor-worker.ts,readonly`,'--mount',`type=bind,source=${directory}/${file},target=/run/test/config.json,readonly`,'--mount',`type=bind,source=${directory}/controls-key.pem,target=/run/test/key.pem,readonly`,'--mount',`type=bind,source=${directory}/artifacts,target=/runtime/artifacts`,'--entrypoint','node',prior.worker_image,'--import','tsx','/app/tests/integration/helpers/precursor-worker.ts','/run/test/config.json'); workers.push(worker); return job;
    };
    const output=await submit('output',"process.stdout.write('A'.repeat(16384))"); evidence.output={job:await endJob(output.id)};
    evidence.output.operations=(await db.query('SELECT id,status,receipt,outcome FROM operations WHERE job_id=$1',[output.id])).rows; assert.equal(evidence.output.operations.length,1);
    const logs=(await db.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='log' ORDER BY id",[output.id])).rows;
    evidence.output.published_log_bytes=logs.reduce((sum,row)=>sum+Buffer.byteLength(row.payload.data??''),0); assert.ok(evidence.output.published_log_bytes<=2048);
    evidence.output.limit_events=(await db.query("SELECT type,payload FROM job_events WHERE job_id=$1 AND type='output.limited'",[output.id])).rows;
    assert.ok(evidence.output.limit_events.some((row:any)=>row.payload.reason==='job_output_budget'));
    const broker=new AgentBroker(db,{signer:{keyId:baseConfig.keyId,privateKeyPem:await readFile(join(files,'controls-key.pem'),'utf8')}});
    const generation=(await db.query('SELECT identity_generation FROM machines WHERE id=$1',[ids.machine])).rows[0].identity_generation;
    const write=async(path:string,size:number)=>{const id=randomUUID();return broker.rpc(ids.machine,'PUT',`/v1/workspaces/${ids.workspace}/files`,{operation_id:id,grant_id:ids.grant,path,content_base64:Buffer.alloc(size,81).toString('base64'),expected_sha256:null},{requestId:id,ownerId:ids.owner,expectedMachineGeneration:generation,scopeGrantId:ids.grant,scopeTool:'file.write',timeoutMs:20000}) as Promise<any>;};
    const a=await write('quota-a.bin',2500);assert.equal(a.state,'completed',JSON.stringify(a));const b=await write('quota-b.bin',2500);evidence.storage_pressure={quota_bytes:4096,first:a,second:b};
    assert.notEqual(b.state,'completed');assert.match(String(b.error??b.reason),/quota/);assert.equal(await readFile(join(project,'quota-b.bin')).then(()=>true,()=>false),false);assert.deepEqual(await readFile(join(project,'quota-a.bin')),Buffer.alloc(2500,81));
    if(b.state==='outcome_unknown'){const blocked=await submit('quota-blocked',"require('node:fs').writeFileSync('/workspace/project/UNSAFE-LAUNCH','bad')",4096);evidence.storage_pressure.new_job=await endJob(blocked.id);assert.notEqual(evidence.storage_pressure.new_job.state,'completed');assert.equal(await readFile(join(project,'UNSAFE-LAUNCH')).then(()=>true,()=>false),false);}
    evidence.outcome='PASS';evidence.completed_at=new Date().toISOString();
  }catch(error){evidence.outcome='FAIL';evidence.error=error instanceof Error?error.message:String(error);throw error;}
  finally{
    await writeFile(resolve('docs/acceptance/runtime-controls-continuation-result.json'),JSON.stringify(evidence,null,2)+'\n');
    for(const id of workers)if(await linux('/usr/bin/docker','inspect','--format','{{.State.Running}}',id).catch(()=>'')==='true')await linux('/usr/bin/docker','stop','--time','10',id);
    for(const item of children.reverse())if(item.child.exitCode===null&&item.child.signalCode===null){await linux('/bin/kill','-TERM',String(item.pid));item.child.kill();}
    await db.end();
  }
});
