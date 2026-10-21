import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { ExecutionContextSchema } from '@homelab/contracts';
import { sha256 } from '@homelab/storage';
import { submitJob } from '../../apps/worker/src/queue.js';
import { startLinuxStackRelay, linux, stackRoot, stackUnc, safeImage } from './helpers/linux-stack.js';

const workerImage = process.env.HOMELAB_IMMUTABLE_WORKER_IMAGE ?? '';
test('model-free precursor: actual 180s command, killed immutable worker and isolated API outage, same physical launch', {
  skip: process.env.HOMELAB_MODEL_FREE_SURVIVAL !== '1' ? 'Requires explicitly allocated isolated API3459 and immutable worker image' : false,
  timeout: 420_000
}, async () => {
  assert.equal(process.env.HOMELAB_LINUX_STACK, '1');
  assert.match(workerImage, /^sha256:[a-f0-9]{64}$/, 'Explicit current coherent immutable worker image required');
  const admin = new URL((await readFile(join(stackUnc, 'config', 'database-admin-url'), 'utf8')).trim()); admin.hostname = '127.0.0.1'; admin.port = '15439';
  const db = new pg.Pool({ connectionString: admin.href, max: 6 });
  const values = Object.fromEntries((await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/runtime.env`)).split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, '')]; }));
  const ids = Object.fromEntries(['owner', 'machine', 'workspace', 'project', 'identity', 'environment', 'grant'].map(name => [name, randomUUID()]));
  const evidence: Record<string, any> = { scope: 'MODEL-FREE durability precursor; not T08 model/browser acceptance', started_at: new Date().toISOString(), outcome: 'RUNNING', ids, immutable_worker_image: workerImage, isolated_api: 'http://127.0.0.1:3019', image: safeImage };
  const oldDispatch = process.env.DISPATCH_ENABLED; process.env.DISPATCH_ENABLED = 'true';
  let host: Awaited<ReturnType<typeof startLinuxStackRelay>> | undefined;
  let jobId: string | undefined;
  const workers: string[] = [];
  const resultPath = resolve('docs/acceptance/model-free-survival-result.json');
  try {
    assert.equal(await linux('/usr/bin/docker', 'image', 'inspect', '--format', '{{.Id}}', workerImage), workerImage);
    await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'no-browser-login')", [ids.owner, `${ids.owner}@precursor.invalid`]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'Isolated Linux durability precursor','linux')", [ids.machine, ids.owner]);
    host = await startLinuxStackRelay({ db, owner: ids.owner, machine: ids.machine, workspace: ids.workspace, identity: ids.identity, environment: ids.environment, grant: ids.grant, agentOrigin: 'https://127.0.0.1:3459' });
    assert.equal((host.proof as any).verified, true); evidence.identity_proof = host.proof;
    await copyFile('tests/integration/survival-fixture.mjs', join(host.projectFiles, 'sentinel.mjs'));
    await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Model-free durability component')", [ids.project, ids.owner]);
    await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,quota_bytes,environment_id,environment_generation) VALUES($1,$2,$3,'Independent durability root','container',$4,$7,$5,'/workspace/project',67108864,$6,1)", [ids.workspace, ids.owner, ids.project, ids.machine, host.root, ids.environment, ids.workspace]);
    await db.query("INSERT INTO environment_generations(id,workspace_id,machine_id,generation,runtime_id,image_digest,state,mount_path) VALUES($1,$2,$3,1,$4,$5,'running','/workspace/project')", [ids.environment, ids.workspace, ids.machine, host.runtimeId, safeImage]);
    await db.query('INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity,restriction_verified,config) VALUES($1,$2,$3,$4,$5,true,$6)', [ids.identity, ids.owner, ids.machine, 'Actually probed nonroot identity', '10001:10001', { mode: 'container', workspace_ids: [ids.workspace], proof: host.proof }]);
    const grant = { id: ids.grant, owner_id: ids.owner, revision: 1, tools: ['run_command', 'file.read'], machine_ids: [ids.machine], workspace_ids: [ids.workspace], profile_ids: [], secret_ids: [], expires_at: null, revoked_at: null };
    await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids) VALUES($1,$2,$3,$4,$5)', [ids.grant, ids.owner, JSON.stringify(grant.tools), JSON.stringify(grant.machine_ids), JSON.stringify(grant.workspace_ids)]);
    const limits = { max_tool_steps: 4, wall_time_seconds: 360, per_command_timeout_seconds: 240, max_output_bytes: 1024 * 1024 };
    const execution = ExecutionContextSchema.parse({ schema_version: 1, profile_id: null, profile_revision: null, execution_machine_id: ids.machine, execution_identity_id: ids.identity, workspace_id: ids.workspace, workspace_revision: 1, environment_id: ids.environment, environment_generation: 1, project_instruction_revision: 1, policy_revision: 1, limits });
    const submitCommand = (key: string, args: string[]) => submitJob(db, { requester_id: ids.owner, idempotency_key: `${key}-${ids.workspace}`, kind: 'command', context: null, workspace_id: ids.workspace, modifies_workspace: true, payload: { execution_context: execution, grant, machine_identity_generations: { [ids.machine]: host!.machineGeneration }, command: { executable: '/usr/local/bin/node', args } } });
    let job = await submitCommand('harmless-preflight', ['-e', "require('node:fs').writeFileSync('/workspace/project/preflight.txt','SIGNED-LAUNCH-OK');console.log('SIGNED-LAUNCH-OK')"]); jobId = job.id;
    const frozenWorker = join(host.files, 'precursor-worker.ts'), key = join(host.files, 'precursor-key.pem'), config = join(host.files, 'precursor-config.json'), artifacts = `${host.directory}/artifacts`;
    await copyFile('tests/integration/helpers/precursor-worker.ts', frozenWorker);
    const harnessHash = sha256(await readFile(frozenWorker)); evidence.frozen_harness_sha256 = harnessHash;
    await writeFile(key, host.signer.privateKeyPem, { mode: 0o600 });
    await writeFile(config, JSON.stringify({ jobId, databaseUrl: values.DATABASE_URL, keyId: host.signer.keyId, keyFile: '/run/test/signing.pem', artifactRoot: '/runtime/artifacts' }), { mode: 0o600 });
    await linux('sudo', '-n', '/bin/chown', '1000:10001', `${host.directory}/precursor-config.json`, `${host.directory}/precursor-key.pem`);
    await linux('/bin/chmod', '0640', `${host.directory}/precursor-config.json`, `${host.directory}/precursor-key.pem`);
    await linux('/bin/chmod', '0444', `${host.directory}/precursor-worker.ts`);
    await linux('/bin/chmod', '0770', artifacts); await linux('sudo', '-n', '/bin/chown', '10001:1000', artifacts);
    const launch = async () => {
      // Each job receives a separate immutable config; replacement workers reuse it.
      const jobConfig = `${host!.directory}/precursor-config-${job.id}.json`;
      if (!workers.some(id => (evidence.workers ?? []).some((row: any) => row.container_id === id && row.job_id === job.id))) {
        await linux('/bin/cp', '--', `${host!.directory}/precursor-config.json`, jobConfig);
        await writeFile(join(host!.files, `precursor-config-${job.id}.json`), JSON.stringify({ jobId: job.id, databaseUrl: values.DATABASE_URL, keyId: host!.signer.keyId, keyFile: '/run/test/signing.pem', artifactRoot: '/runtime/artifacts' }));
        await linux('sudo', '-n', '/bin/chown', '1000:10001', jobConfig);
        await linux('/bin/chmod', '0440', jobConfig);
      }
      const id = await linux('/usr/bin/docker', 'run', '-d', '--name', `homelab-validation-precursor-worker-${job.id}-${workers.length + 1}`, '--label', `homelab.validation_job=${job.id}`, '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'homelab-validation-wave2_internal', '--memory', '512m', '--pids-limit', '64', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '--env', 'DISPATCH_ENABLED=true', '--env', 'RESTORE_MODE=false', '--mount', `type=bind,source=${host!.directory}/precursor-worker.ts,target=/app/tests/integration/helpers/precursor-worker.ts,readonly`, '--mount', `type=bind,source=${jobConfig},target=/run/test/config.json,readonly`, '--mount', `type=bind,source=${host!.directory}/precursor-key.pem,target=/run/test/signing.pem,readonly`, '--mount', `type=bind,source=${artifacts},target=/runtime/artifacts`, '--entrypoint', 'node', workerImage, '--import', 'tsx', '/app/tests/integration/helpers/precursor-worker.ts', '/run/test/config.json');
      assert.match(id, /^[a-f0-9]{64}$/); workers.push(id);
      const inspection = JSON.parse(await linux('/usr/bin/docker', 'inspect', '--format', '{{json .}}', id));
      assert.equal(inspection.Image, workerImage);
      (evidence.workers ??= []).push({ job_id: job.id, container_id: id, image_id: inspection.Image, linux_pid: inspection.State.Pid, harness_sha256: sha256(await readFile(frozenWorker)), started_at: inspection.State.StartedAt });
      assert.equal(evidence.workers.at(-1).harness_sha256, harnessHash);
      return id;
    };
    const preflightWorker = await launch();
    let preflight: any;
    for (let attempt = 0; attempt < 240; attempt++) { preflight = (await db.query('SELECT state,reason,result FROM jobs WHERE id=$1', [job.id])).rows[0]; if (['completed', 'failed', 'interrupted', 'cancelled'].includes(preflight.state)) break; await delay(250); }
    const preflightOperations = (await db.query('SELECT id,status,receipt,outcome FROM operations WHERE job_id=$1', [job.id])).rows;
    evidence.harmless_launch_preflight = { job_id: job.id, worker: preflightWorker, job: preflight, operations: preflightOperations };
    assert.equal(preflight.state, 'completed', JSON.stringify(preflight));
    assert.equal(preflightOperations.length, 1); assert.equal(preflightOperations[0].status, 'succeeded');
    assert.equal(await readFile(join(host.projectFiles, 'preflight.txt'), 'utf8'), 'SIGNED-LAUNCH-OK');
    console.log(`SIGNED_PREFLIGHT_PASS job=${job.id} operation=${preflightOperations[0].id}`);
    await writeFile(resultPath, JSON.stringify(evidence, null, 2) + '\n');
    job = await submitCommand('model-free', ['/workspace/project/sentinel.mjs', '/workspace/project', 'trusted-operation', '180']); jobId = job.id; evidence.job_id = job.id;
    const first = await launch();
    const counterPath = join(host.projectFiles, 'execution-counter.ndjson'); let physical: any;
    for (let attempt = 0; attempt < 240; attempt++) {
      const text = await readFile(counterPath, 'utf8').catch(() => ''); if (text.trim()) { physical = JSON.parse(text.trim().split('\n')[0]); break; }
      const current = (await db.query('SELECT state,reason FROM jobs WHERE id=$1', [job.id])).rows[0];
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(current.state)) throw Error(`Before counter: ${JSON.stringify(current)}; immutable worker=${await linux('/usr/bin/docker', 'logs', first)}`);
      await delay(250);
    }
    assert.ok(physical, `No counter; worker=${await linux('/usr/bin/docker', 'logs', first)}`);
    const operation = (await db.query('SELECT id FROM operations WHERE id=$1 AND job_id=$2', [physical.operationId, job.id])).rows[0]; assert.ok(operation); evidence.operation_id = operation.id;
    const executionContainers = (await linux('/usr/bin/docker', 'ps', '-aq', '--filter', `label=homelab.operation=${operation.id}`)).split(/\s+/); assert.equal(executionContainers.length, 1);
    evidence.execution_container = JSON.parse(await linux('/usr/bin/docker', 'inspect', '--format', '{{json .}}', executionContainers[0])).Id;
    await linux('/usr/bin/docker', 'kill', '--signal', 'KILL', first); evidence.worker_killed_at = new Date().toISOString(); evidence.physical_start = physical;
    await writeFile(resolve('tests/integration/.wave3-runtime/model-free-progress.json'), JSON.stringify({ state: 'accepted', job_id: job.id, operation_id: operation.id, accepted_at: new Date().toISOString(), api: 'http://127.0.0.1:3019' }));
    console.log(`PRECURSOR_ACCEPTED job=${job.id} operation=${operation.id}; immutable worker killed; isolated3019API outage now`);
    const start = Date.now(); let down = 0, up = 0;
    while (Date.now() - start < 185_000) { try { (await fetch('http://127.0.0.1:3019/readyz', { signal: AbortSignal.timeout(1500) })).ok ? up++ : down++; } catch { down++; } await delay(2000); }
    evidence.worker_absence_seconds = (Date.now() - start) / 1000; evidence.isolated_api_observations = { up, down }; assert.ok(down > 0, 'Independent API outage must be observed');
    await launch(); console.log('PRECURSOR_REPLACEMENT_STARTED');
    let finished: any;
    for (let attempt = 0; attempt < 400; attempt++) { finished = (await db.query('SELECT state,reason,result,fence FROM jobs WHERE id=$1', [job.id])).rows[0]; if (['completed', 'failed', 'interrupted', 'cancelled'].includes(finished.state)) break; await delay(250); }
    evidence.job = finished; assert.equal(finished.state, 'completed', JSON.stringify(finished)); assert.ok(Number(finished.fence) >= 2);
    const starts = (await readFile(counterPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(starts.length, 1); assert.equal(starts[0].operationId, operation.id); evidence.execution_counter = starts;
    assert.equal((await db.query('SELECT count(*)::int AS count FROM operations WHERE job_id=$1', [job.id])).rows[0].count, 1);
    const manifest = JSON.parse(await readFile(join(host.projectFiles, `${operation.id}-manifest.json`), 'utf8')); for (const output of manifest.outputs) assert.equal(sha256(await readFile(join(host.projectFiles, output.path))), output.sha256); evidence.outputs = manifest.outputs;
    const logs = (await db.query("SELECT payload->>'data' AS data FROM job_events WHERE job_id=$1 AND type='log' AND payload->>'operation_id'=$2 ORDER BY id", [job.id, operation.id])).rows.map(row => row.data).join('');
    const sequences = logs.split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line); return Number.isInteger(row.sequence) ? [row.sequence] : []; } catch { return []; } }); assert.deepEqual(sequences, Array.from({ length: 180 }, (_, index) => index + 1)); evidence.numbered_logs = { count: sequences.length, first: sequences[0], last: sequences.at(-1) };
    evidence.operation = (await db.query('SELECT id,status,receipt,outcome FROM operations WHERE id=$1', [operation.id])).rows[0];
    evidence.rpc_dispatches = (await db.query('SELECT id,method,path,delivery_count,state FROM agent_rpc_requests WHERE machine_id=$1 ORDER BY created_at', [ids.machine])).rows;
    assert.equal(sha256(await readFile(frozenWorker)), harnessHash); evidence.outcome = 'PASS'; evidence.completed_at = new Date().toISOString();
  } catch (error) { evidence.outcome = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error); if (jobId) evidence.job = (await db.query('SELECT state,reason,result FROM jobs WHERE id=$1', [jobId])).rows[0]; throw error; }
  finally { await writeFile(resultPath, JSON.stringify(evidence, null, 2) + '\n'); await host?.stop(); await db.end(); if (oldDispatch === undefined) delete process.env.DISPATCH_ENABLED; else process.env.DISPATCH_ENABLED = oldDispatch; /* Retain exact immutable workers/receipts for inspection; cleanup is separately coordinated. */ }
});
