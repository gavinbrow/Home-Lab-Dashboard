import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { submitJob, cancelJob } from '../../apps/worker/src/queue.js';
import { ExecutionContextSchema } from '@homelab/contracts';
import { startLinuxStackRelay, linux, stackRoot, safeImage } from './helpers/linux-stack.js';

test('owned actual Go controls: lost acknowledgment, disconnected cancellation, deadlines and bounded output', {
  skip: process.env.HOMELAB_RUNTIME_CONTROLS !== '1' ? 'Requires explicitly booked isolated TLS fault proxy3469 and immutable worker' : false,
  timeout: 360_000
}, async () => {
  const workerImage = process.env.HOMELAB_IMMUTABLE_WORKER_IMAGE ?? '';
  assert.match(workerImage, /^sha256:[a-f0-9]{64}$/);
  assert.match(process.env.HOMELAB_AGENT_LINUX ?? '', /securityopt-11$/);
  const admin = new URL(await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/database-admin-url`)); admin.hostname = '127.0.0.1'; admin.port = '15439';
  const db = new pg.Pool({ connectionString: admin.href, max: 6 });
  const values = Object.fromEntries((await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/runtime.env`)).split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, '')]; }));
  const ids = Object.fromEntries(['owner', 'machine', 'workspace', 'project', 'identity', 'environment', 'grant'].map(name => [name, randomUUID()]));
  const evidence: Record<string, any> = { outcome: 'RUNNING', started_at: new Date().toISOString(), scope: 'Explicit disposable Linux Docker control fixture; no model/nativeWindows/physical reboot claim', ids, worker_image: workerImage };
  const workers: string[] = [];
  let proxy: string | undefined, host: Awaited<ReturnType<typeof startLinuxStackRelay>> | undefined;
  const previousDispatch = process.env.DISPATCH_ENABLED; process.env.DISPATCH_ENABLED = 'true';
  const terminal = async (id: string, timeout = 65_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const row = (await db.query('SELECT id,state,reason,result FROM jobs WHERE id=$1 AND requester_id=$2', [id, ids.owner])).rows[0];
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(row.state)) return row;
      if (Date.now() >= deadline) throw Error(`Owned job ${id} did not terminate: ${row.state}/${row.reason}`);
      await delay(250);
    }
  };
  try {
    await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'no-browser-login')", [ids.owner, `${ids.owner}@controls.invalid`]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'Isolated control evidence','linux')", [ids.machine, ids.owner]);
    host = await startLinuxStackRelay({ db, owner: ids.owner, machine: ids.machine, workspace: ids.workspace, identity: ids.identity, environment: ids.environment, grant: ids.grant, agentOrigin: 'https://127.0.0.1:3459', quotaBytes: 4096, maxOutputBytes: 4096 });
    evidence.fixture_directory = host.directory; evidence.host_proof = host.proof;
    evidence.host_sha256 = (await linux('/usr/bin/sha256sum', `${host.directory}/homelab-agent`)).split(' ')[0];
    await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Finite control checks')", [ids.project, ids.owner]);
    await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,quota_bytes,environment_id,environment_generation) VALUES($1,$2,$3,'4KiB isolated quota','container',$4,$7,$5,'/workspace/project',4096,$6,1)", [ids.workspace, ids.owner, ids.project, ids.machine, host.root, ids.environment, ids.workspace]);
    await db.query("INSERT INTO environment_generations(id,workspace_id,machine_id,generation,runtime_id,image_digest,state,mount_path) VALUES($1,$2,$3,1,$4,$5,'running','/workspace/project')", [ids.environment, ids.workspace, ids.machine, host.runtimeId, safeImage]);
    await db.query('INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity,restriction_verified,config) VALUES($1,$2,$3,$4,$5,true,$6)', [ids.identity, ids.owner, ids.machine, 'Actual container10001', '10001:10001', { mode: 'container', workspace_ids: [ids.workspace], proof: host.proof }]);
    const grant = { id: ids.grant, owner_id: ids.owner, revision: 1, tools: ['run_command', 'file.read', 'file.write'], machine_ids: [ids.machine], workspace_ids: [ids.workspace], profile_ids: [], secret_ids: [], expires_at: null, revoked_at: null };
    await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids) VALUES($1,$2,$3,$4,$5)', [ids.grant, ids.owner, JSON.stringify(grant.tools), JSON.stringify(grant.machine_ids), JSON.stringify(grant.workspace_ids)]);
    const command = async (label: string, script: string, seconds = 90, output = 4096) => {
      const execution = ExecutionContextSchema.parse({ schema_version: 1, profile_id: null, profile_revision: null, execution_machine_id: ids.machine, execution_identity_id: ids.identity, workspace_id: ids.workspace, workspace_revision: 1, environment_id: ids.environment, environment_generation: 1, project_instruction_revision: 1, policy_revision: 1, limits: { max_tool_steps: 4, wall_time_seconds: 120, per_command_timeout_seconds: seconds, max_output_bytes: output } });
      return submitJob(db, { requester_id: ids.owner, idempotency_key: `${label}-${ids.workspace}`, kind: 'command', context: null, workspace_id: ids.workspace, modifies_workspace: true, payload: { execution_context: execution, grant, machine_identity_generations: { [ids.machine]: host!.machineGeneration }, command: { executable: '/usr/local/bin/node', args: ['-e', script] } } });
    };
    const artifactDirectory = `${host.directory}/artifacts`;
    await copyFile('tests/integration/helpers/precursor-worker.ts', join(host.files, 'controls-worker.ts'));
    await writeFile(join(host.files, 'controls-key.pem'), host.signer.privateKeyPem, { mode: 0o600 });
    await linux('sudo', '-n', '/bin/chown', '1000:10001', `${host.directory}/controls-key.pem`);
    await linux('/bin/chmod', '0640', `${host.directory}/controls-key.pem`); await linux('/bin/chmod', '0444', `${host.directory}/controls-worker.ts`);
    await linux('sudo', '-n', '/bin/chown', '10001:1000', artifactDirectory); await linux('sudo', '-n', '/bin/chmod', '0770', artifactDirectory);
    evidence.worker_harness_sha256 = createHash('sha256').update(await readFile(join(host.files, 'controls-worker.ts'))).digest('hex');
    const launchWorker = async (jobId: string) => {
      const file = `controls-${jobId}.json`;
      await writeFile(join(host!.files, file), JSON.stringify({ jobId, databaseUrl: values.DATABASE_URL, keyId: host!.signer.keyId, keyFile: '/run/test/key.pem', artifactRoot: '/runtime/artifacts' }), { mode: 0o600 });
      await linux('sudo', '-n', '/bin/chown', '1000:10001', `${host!.directory}/${file}`); await linux('/bin/chmod', '0440', `${host!.directory}/${file}`);
      const container = await linux('/usr/bin/docker', 'run', '-d', '--name', `homelab-validation-controls-worker-${jobId}`, '--label', `homelab.validation_job=${jobId}`, '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'homelab-validation-wave2_internal', '--memory', '512m', '--cpus', '1', '--pids-limit', '64', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '--env', 'DISPATCH_ENABLED=true', '--env', 'RESTORE_MODE=false', '--mount', `type=bind,source=${host!.directory}/controls-worker.ts,target=/app/tests/integration/helpers/precursor-worker.ts,readonly`, '--mount', `type=bind,source=${host!.directory}/${file},target=/run/test/config.json,readonly`, '--mount', `type=bind,source=${host!.directory}/controls-key.pem,target=/run/test/key.pem,readonly`, '--mount', `type=bind,source=${artifactDirectory},target=/runtime/artifacts`, '--entrypoint', 'node', workerImage, '--import', 'tsx', '/app/tests/integration/helpers/precursor-worker.ts', '/run/test/config.json');
      assert.match(container, /^[a-f0-9]{64}$/); workers.push(container); return container;
    };
    await host.pauseTransport();
    const identity = JSON.parse(await readFile(join(host.files, 'identity', 'identity.json'), 'utf8'));
    for (const [name, path] of Object.entries({ serverKey: `${stackRoot}/config/agent-server-key.pem`, serverCert: `${stackRoot}/config/agent-server-cert.pem`, ca: `${stackRoot}/config/agent-ca-cert.pem`, clientKey: identity.key_file, clientCert: identity.certificate_file })) {
      assert.ok(typeof path === 'string' && (path.startsWith(`${stackRoot}/config/`) || path.startsWith(`${host.directory}/identity/`)));
      await writeFile(join(host.files, `proxy-${name}.pem`), await linux('sudo', '-n', '/bin/cat', path), { mode: 0o600 });
      await linux('sudo', '-n', '/bin/chown', '1000:10001', `${host.directory}/proxy-${name}.pem`); await linux('/bin/chmod', '0640', `${host.directory}/proxy-${name}.pem`);
    }
    const proxyState = `${host.directory}/proxy-state`; await mkdir(join(host.files, 'proxy-state'));
    await linux('sudo', '-n', '/bin/chown', '10001:1000', proxyState); await linux('sudo', '-n', '/bin/chmod', '0770', proxyState);
    await writeFile(join(host.files, 'proxy-state', 'hold'), 'withhold launch acknowledgment');
    await copyFile('tests/integration/helpers/lost-ack-proxy.mjs', join(host.files, 'proxy.mjs'));
    const proxyConfig = { machineId: ids.machine, upstreamPort: 3459, port: 3469, holdFile: '/state/hold', evidenceFile: '/state/dropped.json', ...Object.fromEntries(['serverKey', 'serverCert', 'ca', 'clientKey', 'clientCert'].map(name => [name, `/keys/proxy-${name}.pem`])) };
    await writeFile(join(host.files, 'proxy-config.json'), JSON.stringify(proxyConfig));
    const proxyKeys = `${host.directory}/proxy-keys`; await mkdir(join(host.files, 'proxy-keys'));
    for (const file of ['proxy.mjs', 'proxy-config.json', ...['serverKey', 'serverCert', 'ca', 'clientKey', 'clientCert'].map(name => `proxy-${name}.pem`)]) await linux('/bin/cp', '--', `${host.directory}/${file}`, `${proxyKeys}/${file}`);
    await linux('sudo', '-n', '/bin/chown', '-R', '1000:10001', proxyKeys); await linux('/bin/chmod', '0750', proxyKeys);
    proxy = await linux('/usr/bin/docker', 'run', '-d', '--name', `homelab-validation-lostack-${ids.machine}`, '--label', `homelab.validation_machine=${ids.machine}`, '--network', 'host', '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--cpus', '0.25', '--pids-limit', '32', '--mount', `type=bind,source=${proxyKeys},target=/keys,readonly`, '--mount', `type=bind,source=${proxyState},target=/state`, '--entrypoint', 'node', safeImage, '/keys/proxy.mjs', '/keys/proxy-config.json');
    const connection = JSON.parse(await readFile(join(host.files, 'connection.json'), 'utf8')); connection.control_plane_url = 'https://127.0.0.1:3469'; await writeFile(join(host.files, 'connection.json'), JSON.stringify(connection), { mode: 0o600 }); await host.resumeTransport();
    const child = "require('node:fs').appendFileSync('/workspace/project/child.txt','x');setInterval(()=>require('node:fs').appendFileSync('/workspace/project/child.txt','x'),200);setTimeout(()=>process.exit(0),90000)";
    const script = `const f=require('node:fs');f.appendFileSync('/workspace/project/counter.ndjson',JSON.stringify({operation_id:process.env.HOMELAB_OPERATION_ID})+'\\n');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),90000)`;
    const lost = await command('lostack', script); evidence.lost_ack = { job_id: lost.id }; await launchWorker(lost.id);
    let dropped: any;
    for (let i = 0; i < 240; i++) { const raw = await readFile(join(host.files, 'proxy-state', 'dropped.json'), 'utf8').catch(() => ''); if (raw) { dropped = JSON.parse(raw); break; } await delay(250); }
    assert.ok(dropped, 'Actual host acknowledgment must be dropped before control plane receives it'); evidence.lost_ack.dropped = dropped;
    const rpc = (await db.query('SELECT id,state,response_body FROM agent_rpc_requests WHERE id=$1 AND machine_id=$2', [dropped.rpc_id, ids.machine])).rows[0]; assert.equal(rpc.response_body, null); evidence.lost_ack.before_reconnect_rpc = rpc;
    await host.pauseTransport(); await cancelJob(db, lost.id, ids.owner); await delay(2000);
    const offline = (await db.query('SELECT state,reason FROM jobs WHERE id=$1', [lost.id])).rows[0]; evidence.lost_ack.offline_job = offline;
    assert.ok(!['cancelled', 'completed'].includes(offline.state)); assert.equal((await db.query('SELECT count(*)::int AS n FROM workspace_locks WHERE job_id=$1', [lost.id])).rows[0].n, 1);
    await writeFile(join(host.files, 'proxy-state', 'hold'), ''); await host.resumeTransport();
    const cancelled = await terminal(lost.id); evidence.lost_ack.job = cancelled; assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled));
    const ops = (await db.query('SELECT id,status,receipt FROM operations WHERE job_id=$1', [lost.id])).rows; assert.equal(ops.length, 1); assert.equal(ops[0].id, dropped.operation_id); assert.equal(ops[0].status, 'cancelled'); evidence.lost_ack.operations = ops;
    const starts = (await readFile(join(host.projectFiles, 'counter.ndjson'), 'utf8')).trim().split(/\n/); assert.equal(starts.length, 1);
    const ticks = await readFile(join(host.projectFiles, 'child.txt')); await delay(1000); assert.deepEqual(await readFile(join(host.projectFiles, 'child.txt')), ticks);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM workspace_locks WHERE job_id=$1', [lost.id])).rows[0].n, 0);
    const queued = await command('queuedcancel', "require('node:fs').writeFileSync('/workspace/project/SHOULD-NOT-EXIST','bad')"); await cancelJob(db, queued.id, ids.owner); await launchWorker(queued.id); assert.equal((await terminal(queued.id)).state, 'cancelled'); assert.equal((await db.query('SELECT count(*)::int AS n FROM operations WHERE job_id=$1', [queued.id])).rows[0].n, 0); evidence.queued_cancel = { job_id: queued.id, physical_operations: 0 };
    const timed = await command('offline-timeout', "require('node:fs').writeFileSync('/workspace/project/timeout-start',process.env.HOMELAB_OPERATION_ID);setTimeout(()=>{},60000)", 3); await launchWorker(timed.id);
    let timeoutOp = '';
    for (let i = 0; i < 160; i++) { timeoutOp = await readFile(join(host.projectFiles, 'timeout-start'), 'utf8').catch(() => ''); if (timeoutOp) break; await delay(100); }
    assert.ok(timeoutOp); await host.crashSupervisor(); await delay(5000);
    const executionId = await linux('/usr/bin/docker', 'ps', '-aq', '--no-trunc', '--filter', `label=homelab.operation=${timeoutOp}`); assert.match(executionId, /^[a-f0-9]{64}$/);
    const execution = JSON.parse(await linux('/usr/bin/docker', 'inspect', '--format', '{{json .}}', executionId)); assert.equal(execution.State.Running, false); evidence.offline_timeout = { job_id: timed.id, operation_id: timeoutOp, container: execution.Id, state: execution.State };
    await host.resumeSupervisor(); evidence.offline_timeout.job = await terminal(timed.id); assert.notEqual(evidence.offline_timeout.job.state, 'completed'); assert.equal((await db.query('SELECT count(*)::int AS n FROM operations WHERE job_id=$1', [timed.id])).rows[0].n, 1);
    const output = await command('outputbound', "process.stdout.write('A'.repeat(16384))", 10, 2048); await launchWorker(output.id); evidence.output = { job: await terminal(output.id) };
    const outputOps = (await db.query('SELECT id,status,receipt FROM operations WHERE job_id=$1', [output.id])).rows; evidence.output.operations = outputOps; assert.equal(outputOps.length, 1);
    const logRows = (await db.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='log' ORDER BY id", [output.id])).rows;
    const bytes = logRows.reduce((sum, row) => sum + Buffer.byteLength(row.payload.data ?? ''), 0); evidence.output.published_log_bytes = bytes; assert.ok(bytes <= 2048, `Output publication exceeded explicit2048byte bound: ${bytes}`);
    evidence.output.limit_events = (await db.query("SELECT type,payload FROM job_events WHERE job_id=$1 AND type='output.limited'", [output.id])).rows;
    assert.ok(evidence.output.limit_events.some((row: any) => row.payload.reason === 'job_output_budget'), 'An explicit output budget event must survive even when the marker bytes cannot be retained');
    const writeQuota = async (path: string, size: number) => {
      const operation = randomUUID();
      return host!.broker.rpc(ids.machine, 'PUT', `/v1/workspaces/${ids.workspace}/files`, { operation_id: operation, grant_id: ids.grant, path, content_base64: Buffer.alloc(size, 81).toString('base64'), expected_sha256: null }, { requestId: operation, ownerId: ids.owner, expectedMachineGeneration: host!.machineGeneration, scopeGrantId: ids.grant, scopeTool: 'file.write', timeoutMs: 20_000 });
    };
    const firstQuota = await writeQuota('quota-a.bin', 2500) as any; assert.equal(firstQuota.state, 'completed', JSON.stringify(firstQuota));
    const secondQuota = await writeQuota('quota-b.bin', 2500) as any; evidence.storage_pressure = { quota_bytes: 4096, first: firstQuota, second: secondQuota };
    assert.match(String(secondQuota.error ?? secondQuota.reason), /quota/); assert.notEqual(secondQuota.state, 'completed');
    assert.equal(await readFile(join(host.projectFiles, 'quota-b.bin')).then(() => true, () => false), false);
    assert.deepEqual(await readFile(join(host.projectFiles, 'quota-a.bin')), Buffer.alloc(2500, 81));
    // A conservative unknown receipt must keep the workspace unavailable; never unlock it by timeout.
    if (secondQuota.state === 'outcome_unknown') {
      const blocked = await command('quota-blocked', "require('node:fs').writeFileSync('/workspace/project/UNSAFE-LAUNCH','bad')"); await launchWorker(blocked.id);
      evidence.storage_pressure.new_job = await terminal(blocked.id); assert.notEqual(evidence.storage_pressure.new_job.state, 'completed');
      assert.equal(await readFile(join(host.projectFiles, 'UNSAFE-LAUNCH')).then(() => true, () => false), false);
    }
    evidence.outcome = 'PASS'; evidence.completed_at = new Date().toISOString();
  } catch (error) { evidence.outcome = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    await writeFile(resolve('docs/acceptance/runtime-controls-result.json'), JSON.stringify(evidence, null, 2) + '\n');
    for (const id of workers) if (await linux('/usr/bin/docker', 'inspect', '--format', '{{.State.Running}}', id).catch(() => '') === 'true') await linux('/usr/bin/docker', 'stop', '--time', '10', id);
    await host?.stop(); if (proxy) await linux('/usr/bin/docker', 'stop', '--time', '2', proxy); await db.end();
    if (previousDispatch === undefined) delete process.env.DISPATCH_ENABLED; else process.env.DISPATCH_ENABLED = previousDispatch;
  }
});
