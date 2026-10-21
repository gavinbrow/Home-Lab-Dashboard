import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { RunContextSchema, ProfileDefinitionSchema } from '@homelab/contracts';
import { sha256 } from '@homelab/storage';
import { hashPassword } from '../../apps/api/src/auth/password.js';
import { submitJob } from '../../apps/worker/src/queue.js';
import { startLinuxStackRelay, linux, stackRoot, stackUnc, safeImage } from './helpers/linux-stack.js';

const workerImage = process.env.HOMELAB_IMMUTABLE_WORKER_IMAGE ?? '';
test('actual qwen3:4b autonomous180s command verifies and retains both real outputs', {
  skip: process.env.HOMELAB_ACTUAL_MODEL_SURVIVAL !== '1' ? 'Requires booked actual T08 4B provider, allocated API3459, browser campaign and immutable worker image' : false,
  timeout: 5_400_000
}, async () => {
  assert.equal(process.env.HOMELAB_LINUX_STACK, '1');
  assert.match(process.env.HOMELAB_AGENT_LINUX ?? '', /securityopt-11$/);
  assert.match(workerImage, /^sha256:[a-f0-9]{64}$/, 'Explicit current coherent immutable worker image required');
  assert.match(process.env.HOMELAB_IMMUTABLE_API_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(await linux('/usr/bin/docker', 'inspect', '--format', '{{.Image}}', 'homelab-validation-wave3-isolated-api'), process.env.HOMELAB_IMMUTABLE_API_IMAGE);
  const admin = new URL((await readFile(join(stackUnc, 'config', 'database-admin-url'), 'utf8')).trim()); admin.hostname = '127.0.0.1'; admin.port = '15439';
  const db = new pg.Pool({ connectionString: admin.href, max: 6 });
  const values = Object.fromEntries((await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/runtime.env`)).split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, '')]; }));
  const ids = Object.fromEntries(['owner', 'machine', 'workspace', 'project', 'identity', 'environment', 'grant', 'profile', 'provider', 'pool'].map(name => [name, randomUUID()]));
  const evidence: Record<string, any> = { scope: 'One NEW actual qwen3:4b T08 command/verification/artifact workflow; browser evidence is independently required', started_at: new Date().toISOString(), outcome: 'RUNNING', ids, immutable_worker_image: workerImage, model: 'qwen3:4b', isolated_api: 'http://127.0.0.1:3019', image: safeImage };
  const oldDispatch = process.env.DISPATCH_ENABLED; process.env.DISPATCH_ENABLED = 'true';
  let host: Awaited<ReturnType<typeof startLinuxStackRelay>> | undefined;
  let jobId: string | undefined;
  const workers: string[] = [];
  const resultPath = resolve('docs/acceptance/actual-t08-qwen4b-production-result.json');
  try {
    assert.equal(await linux('/usr/bin/docker', 'image', 'inspect', '--format', '{{.Id}}', workerImage), workerImage);
    await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'no-browser-login')", [ids.owner, `${ids.owner}@precursor.invalid`]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'Isolated Linux durability precursor','linux')", [ids.machine, ids.owner]);
    host = await startLinuxStackRelay({ db, owner: ids.owner, machine: ids.machine, workspace: ids.workspace, identity: ids.identity, environment: ids.environment, grant: ids.grant, agentOrigin: 'https://127.0.0.1:3459' });
    assert.equal((host.proof as any).verified, true); evidence.identity_proof = host.proof; evidence.host_health = host.health;
    evidence.fixture_directory = host.directory; evidence.actual_api_image = process.env.HOMELAB_IMMUTABLE_API_IMAGE;
    evidence.machine_identity_generation = host.machineGeneration;
    evidence.dispatch_epoch = JSON.parse(await readFile(join(host.files, 'identity', 'identity.json'), 'utf8')).dispatch_epoch;
    await copyFile('tests/integration/survival-fixture.mjs', join(host.projectFiles, 'sentinel.mjs'));
    await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Model-free durability component')", [ids.project, ids.owner]);
    await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,quota_bytes,environment_id,environment_generation) VALUES($1,$2,$3,'Independent durability root','container',$4,$7,$5,'/workspace/project',67108864,$6,1)", [ids.workspace, ids.owner, ids.project, ids.machine, host.root, ids.environment, ids.workspace]);
    await db.query("INSERT INTO environment_generations(id,workspace_id,machine_id,generation,runtime_id,image_digest,state,mount_path) VALUES($1,$2,$3,1,$4,$5,'running','/workspace/project')", [ids.environment, ids.workspace, ids.machine, host.runtimeId, safeImage]);
    await db.query('INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity,restriction_verified,config) VALUES($1,$2,$3,$4,$5,true,$6)', [ids.identity, ids.owner, ids.machine, 'Actually probed nonroot identity', '10001:10001', { mode: 'container', workspace_ids: [ids.workspace], proof: host.proof }]);
    const handoff = JSON.parse(await readFile('docs/providers/t08-4b-production-handoff.json', 'utf8'));
    const probe = JSON.parse(await readFile('docs/providers/actual-qwen3-4b-soft-command-schema-result.json', 'utf8'));
    assert.equal(probe.outcome, 'PASS');
    const modelIdentity = probe.model_identity, serverVersion = probe.server_version;
    assert.equal(modelIdentity.id, handoff.model); assert.equal(modelIdentity.metadata.digest, handoff.model_digest);
    assert.equal(sha256(Buffer.from(handoff.prompt)), handoff.hashes.prompt_sha256);
    assert.equal(sha256(Buffer.from(handoff.profile.instructions)), handoff.hashes.profile_instructions_sha256);
    const limits = handoff.profile.limits;
    const profile = ProfileDefinitionSchema.parse({ instructions: handoff.profile.instructions, tools: ['run_command', 'file.read', 'artifact.retain'], machine_ids: [ids.machine], workspace_ids: [ids.workspace], execution_identity_ids: [ids.identity], limits, network_policy: { mode: 'deny' }, required_verification: true });
    const grant = { id: ids.grant, owner_id: ids.owner, revision: 1, tools: ['agent.run', 'run_command', 'file.read', 'artifact.retain'], machine_ids: [ids.machine], workspace_ids: [ids.workspace], profile_ids: [ids.profile], secret_ids: [], expires_at: null, revoked_at: null };
    await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids,profile_ids) VALUES($1,$2,$3,$4,$5,$6)', [ids.grant, ids.owner, JSON.stringify(grant.tools), JSON.stringify(grant.machine_ids), JSON.stringify(grant.workspace_ids), JSON.stringify(grant.profile_ids)]);
    await db.query("INSERT INTO agent_profiles(id,owner_id,name) VALUES($1,$2,'Actual T08 4B immutable command profile')", [ids.profile, ids.owner]);
    await db.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition) VALUES($1,1,$2,$3)', [ids.profile, profile.instructions, profile]);
    await db.query("INSERT INTO provider_runtime_pools(id,owner_id,name) VALUES($1,$2,'Actual T08 4B isolated CPU fixture')", [ids.pool, ids.owner]);
    const snapshot = { id: ids.provider, revision: 1, adapter: 'ollama', baseUrl: 'http://127.0.0.1:11438', runtimePoolId: ids.pool, routing: 'local', allowedAddresses: ['127.0.0.1'], allowPrivateHttp: true, timeoutMs: 900_000, contextLength: 8192 };
    await db.query("INSERT INTO providers(id,owner_id,name,adapter,endpoint,runtime_pool_id,config,routing_classification) VALUES($1,$2,'Explicit actual qwen3:4b','ollama',$3,$4,$5,'local')", [ids.provider, ids.owner, snapshot.baseUrl, ids.pool, { allowed_addresses: ['127.0.0.1'], allow_private_http: true, timeout_ms: 900000, context_length: 8192 }]);
    assert.equal(serverVersion, '0.40.6');
    await db.query("INSERT INTO capability_probes(id,owner_id,provider_id,model_id,capability,state,config_revision,evidence) VALUES($1,$2,$3,'qwen3:4b','tools','tested_pass',1,$4)", [randomUUID(), ids.owner, ids.provider, { source: 'docs/providers/actual-qwen3-4b-soft-command-schema-result.json', live_provider: true, model_digest: modelIdentity.metadata.digest, server_version: serverVersion }]);
    const context = RunContextSchema.parse({ schema_version: 1, provider_id: ids.provider, provider_config_revision: 1, provider_adapter: 'ollama', provider_endpoint: snapshot.baseUrl, model_id: 'qwen3:4b', profile_id: ids.profile, profile_revision: 1, execution_machine_id: ids.machine, execution_identity_id: ids.identity, workspace_id: ids.workspace, workspace_revision: 1, environment_id: ids.environment, environment_generation: 1, project_instruction_revision: 1, policy_revision: 1, limits });
    const prompt = handoff.prompt;
    const job = await submitJob(db, { requester_id: ids.owner, idempotency_key: `actual-t08-${ids.workspace}`, kind: 'agent', context, modifies_workspace: true, payload: { prompt, grant, profile_snapshot: profile, provider_snapshot: snapshot, machine_identity_generations: { [ids.machine]: host.machineGeneration } } }); jobId = job.id; evidence.job_id = job.id; evidence.provider_snapshot = snapshot; evidence.model_identity = modelIdentity; evidence.generation_settings = { thinking_control: 'omitted; installed native default true', temperature_control: 'omitted; installed native default0.6', production_max_output_tokens: 4096, context_length: 8192, wall_seconds: 3600, provider_timeout_ms: 900000, generation_overrides: false };
    const password = randomBytes(24).toString('base64url'); await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [ids.owner, await hashPassword(password)]);
    await writeFile(resolve('tests/integration/.wave3-runtime/actual-t08-4b-browser.json'), JSON.stringify({ api_origin: 'http://127.0.0.1:3019', app_origin: 'http://localhost:5173', email: `${ids.owner}@precursor.invalid`, password, ids, job_id: job.id, expected_model: 'qwen3:4b' }), { mode: 0o600 });
    console.log(`ACTUAL_MODEL_JOB_READY job=${job.id}; protected browser manifest tests/integration/.wave3-runtime/actual-t08-4b-browser.json`);
    await writeFile(resultPath, JSON.stringify(evidence, null, 2) + '\n');
    const workerUrl = new URL(values.DATABASE_URL); workerUrl.hostname = '127.0.0.1'; workerUrl.port = '15439';
    const frozenWorker = join(host.files, 'immutable-qwen4b-production-worker.ts'), key = join(host.files, 'precursor-key.pem'), config = join(host.files, 'precursor-config.json'), artifacts = '/tmp/homelab-validation-wave2/data/artifacts';
    await copyFile('tests/integration/helpers/immutable-qwen4b-production-worker.ts', frozenWorker);
    const harnessHash = sha256(await readFile(frozenWorker)); evidence.frozen_harness_sha256 = harnessHash;
    await mkdir(join(host.files, 'wire')); await linux('sudo', '-n', '/bin/chown', '10001:1000', `${host.directory}/wire`); await linux('sudo', '-n', '/bin/chmod', '2770', `${host.directory}/wire`);
    evidence.driver_sha256 = sha256(await readFile('tests/integration/actual-t08-qwen4b-production.test.ts')); evidence.workload_sha256 = sha256(await readFile('tests/integration/survival-fixture.mjs'));
    evidence.host_sha256 = (await linux('/usr/bin/sha256sum', `${host.directory}/homelab-agent`)).split(' ')[0]; assert.equal(evidence.host_sha256, '8111acfb7678d09b22e19ff39674a2827a6bdb855800cf098411e751af4f44a1');
    await writeFile(key, host.signer.privateKeyPem, { mode: 0o600 });
    await writeFile(config, JSON.stringify({ jobId, mode: 'actual-t08-qwen4b-production', databaseUrl: workerUrl.href, keyId: host.signer.keyId, keyFile: '/run/test/signing.pem', artifactRoot: '/runtime/artifacts', wireDirectory: '/runtime/wire' }), { mode: 0o600 });
    await linux('sudo', '-n', '/bin/chown', '1000:10001', `${host.directory}/precursor-config.json`, `${host.directory}/precursor-key.pem`);
    await linux('/bin/chmod', '0640', `${host.directory}/precursor-config.json`, `${host.directory}/precursor-key.pem`);
    await linux('/bin/chmod', '0444', `${host.directory}/immutable-qwen4b-production-worker.ts`);
    // Shared real central artifact root is already protected and owned by the runtime UID.
    const launch = async () => {
      // Each job receives a separate immutable config; replacement workers reuse it.
      const jobConfig = `${host!.directory}/precursor-config-${job.id}.json`;
      if (!workers.some(id => (evidence.workers ?? []).some((row: any) => row.container_id === id && row.job_id === job.id))) {
        await linux('/bin/cp', '--', `${host!.directory}/precursor-config.json`, jobConfig);
        await writeFile(join(host!.files, `precursor-config-${job.id}.json`), JSON.stringify({ jobId: job.id, mode: 'actual-t08-qwen4b-production', databaseUrl: workerUrl.href, keyId: host!.signer.keyId, keyFile: '/run/test/signing.pem', artifactRoot: '/runtime/artifacts', wireDirectory: '/runtime/wire' }));
        await linux('sudo', '-n', '/bin/chown', '1000:10001', jobConfig);
        await linux('/bin/chmod', '0440', jobConfig);
      }
      const id = await linux('/usr/bin/docker', 'run', '-d', '--name', `homelab-validation-precursor-worker-${job.id}-${workers.length + 1}`, '--label', `homelab.validation_job=${job.id}`, '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--network', 'host', '--memory', '512m', '--pids-limit', '64', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '--env', 'DISPATCH_ENABLED=true', '--env', 'RESTORE_MODE=false', '--mount', `type=bind,source=${host!.directory}/immutable-qwen4b-production-worker.ts,target=/app/tests/integration/helpers/immutable-qwen4b-production-worker.ts,readonly`, '--mount', `type=bind,source=${jobConfig},target=/run/test/config.json,readonly`, '--mount', `type=bind,source=${host!.directory}/precursor-key.pem,target=/run/test/signing.pem,readonly`, '--mount', `type=bind,source=${artifacts},target=/runtime/artifacts`, '--mount', `type=bind,source=${host!.directory}/wire,target=/runtime/wire`, '--entrypoint', 'node', workerImage, '--import', 'tsx', '/app/tests/integration/helpers/immutable-qwen4b-production-worker.ts', '/run/test/config.json');
      assert.match(id, /^[a-f0-9]{64}$/); workers.push(id);
      const inspection = JSON.parse(await linux('/usr/bin/docker', 'inspect', '--format', '{{json .}}', id));
      assert.equal(inspection.Image, workerImage);
      (evidence.workers ??= []).push({ job_id: job.id, container_id: id, image_id: inspection.Image, linux_pid: inspection.State.Pid, harness_sha256: sha256(await readFile(frozenWorker)), started_at: inspection.State.StartedAt });
      assert.equal(evidence.workers.at(-1).harness_sha256, harnessHash);
      return id;
    };
    const first = await launch();
    const counterPath = join(host.projectFiles, 'execution-counter.ndjson'); let physical: any;
    for (let attempt = 0; attempt < 14400; attempt++) {
      const text = await readFile(counterPath, 'utf8').catch(() => ''); if (text.trim()) { physical = JSON.parse(text.trim().split('\n')[0]); break; }
      const current = (await db.query('SELECT state,reason FROM jobs WHERE id=$1', [job.id])).rows[0];
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(current.state)) throw Error(`Before counter: ${JSON.stringify(current)}; immutable worker=${await linux('/usr/bin/docker', 'logs', first)}`);
      await delay(250);
    }
    assert.ok(physical, `No counter; worker=${await linux('/usr/bin/docker', 'logs', first)}`);
    const operation = (await db.query('SELECT id FROM operations WHERE id=$1 AND job_id=$2', [physical.operationId, job.id])).rows[0]; assert.ok(operation); evidence.operation_id = operation.id;
    const executionContainers = (await linux('/usr/bin/docker', 'ps', '-aq', '--filter', `label=homelab.operation=${operation.id}`)).split(/\s+/); assert.equal(executionContainers.length, 1);
    evidence.execution_container = JSON.parse(await linux('/usr/bin/docker', 'inspect', '--format', '{{json .}}', executionContainers[0])).Id;
    evidence.physical_start = physical;
    let authoritativeReceipt: any, visibleLogCount = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      authoritativeReceipt = (await db.query('SELECT receipt FROM operations WHERE id=$1 AND job_id=$2', [operation.id, job.id])).rows[0]?.receipt;
      const chunks = (await db.query("SELECT payload->>'data' AS data FROM job_events WHERE job_id=$1 AND type='log' AND payload->>'operation_id'=$2 ORDER BY id", [job.id, operation.id])).rows.map(row => row.data).join('');
      visibleLogCount = chunks.split(/\r?\n/).filter(line => { try { return Number.isInteger(JSON.parse(line).sequence); } catch { return false; } }).length;
      if (/^osboot-v1:linux:[a-f0-9-]{36}$/.test(authoritativeReceipt?.boot_id ?? '') && visibleLogCount >= 3) break;
      await delay(250);
    }
    assert.match(authoritativeReceipt?.boot_id ?? '', /^osboot-v1:linux:[a-f0-9-]{36}$/);
    assert.ok(visibleLogCount >= 3, 'Several canonical live numbered logs must exist before requesting browser closure');
    evidence.authoritative_running_receipt = authoritativeReceipt;
    const cursor = (await db.query('SELECT COALESCE(max(id),0)::text AS id FROM job_events WHERE job_id=$1', [job.id])).rows[0].id;
    await writeFile(resolve('tests/integration/.wave3-runtime/actual-t08-4b-progress.json'), JSON.stringify({ state: 'accepted-live-logs', job_id: job.id, operation_id: operation.id, accepted_at: new Date().toISOString(), physical_start: physical, event_cursor: cursor, boot_id: authoritativeReceipt.boot_id, numbered_log_count: visibleLogCount, api: 'http://127.0.0.1:3019' }));
    console.log(`ACTUAL_MODEL_ACCEPTED job=${job.id} operation=${operation.id} cursor=${cursor}; frontend must capture visible ACK/logs then close ALL dashboard tabs180s`);
    let finished: any;
    for (let attempt = 0; attempt < 14400; attempt++) { finished = (await db.query('SELECT state,reason,result,fence FROM jobs WHERE id=$1', [job.id])).rows[0]; if (['completed', 'failed', 'interrupted', 'cancelled'].includes(finished.state)) break; await delay(250); }
    evidence.job = finished; assert.equal(finished.state, 'completed', JSON.stringify(finished)); assert.ok(Number(finished.fence) >= 1);
    const starts = (await readFile(counterPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(starts.length, 1); assert.equal(starts[0].operationId, operation.id); evidence.execution_counter = starts;
    assert.equal((await db.query('SELECT count(*)::int AS count FROM operations WHERE job_id=$1', [job.id])).rows[0].count, 1);
    const manifest = JSON.parse(await readFile(join(host.projectFiles, `${operation.id}-manifest.json`), 'utf8')); for (const output of manifest.outputs) assert.equal(sha256(await readFile(join(host.projectFiles, output.path))), output.sha256); evidence.outputs = manifest.outputs;
    const logs = (await db.query("SELECT payload->>'data' AS data FROM job_events WHERE job_id=$1 AND type='log' AND payload->>'operation_id'=$2 ORDER BY id", [job.id, operation.id])).rows.map(row => row.data).join('');
    const sequences = logs.split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line); return Number.isInteger(row.sequence) ? [row.sequence] : []; } catch { return []; } }); assert.deepEqual(sequences, Array.from({ length: 180 }, (_, index) => index + 1)); evidence.numbered_logs = { count: sequences.length, first: sequences[0], last: sequences.at(-1) };
    evidence.operation = (await db.query('SELECT id,status,receipt,outcome FROM operations WHERE id=$1', [operation.id])).rows[0];
    evidence.tool_steps = (await db.query('SELECT id,sequence,kind,state,request,result FROM job_steps WHERE job_id=$1 ORDER BY sequence', [job.id])).rows;
    evidence.inferences = (await db.query('SELECT id,state,provider_id,model_id,metrics FROM inference_requests WHERE job_id=$1 ORDER BY created_at', [job.id])).rows;
    evidence.artifacts = (await db.query("SELECT id,relative_path,sha256,size_bytes FROM artifacts WHERE job_id=$1 AND relative_path=ANY($2::text[]) ORDER BY created_at", [job.id, ['sentinel-report.txt', 'sentinel-binary.bin']])).rows;
    assert.equal(evidence.artifacts.length, 2, 'Both model-published files must be retained');
    for (const output of manifest.outputs) assert.ok(evidence.artifacts.some((item: any) => item.sha256 === output.sha256), 'Retained artifact hash must match actual host bytes');
    evidence.rpc_dispatches = (await db.query('SELECT id,method,path,delivery_count,state FROM agent_rpc_requests WHERE machine_id=$1 ORDER BY created_at', [ids.machine])).rows;
    assert.equal(sha256(await readFile(frozenWorker)), harnessHash); evidence.outcome = 'PASS'; evidence.completed_at = new Date().toISOString();
  } catch (error) { evidence.outcome = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error); if (jobId) evidence.job = (await db.query('SELECT state,reason,result FROM jobs WHERE id=$1', [jobId])).rows[0]; throw error; }
  finally { if (host) { const wireFiles = await readdir(join(host.files, 'wire')).catch(() => []); evidence.forwarded_requests = await Promise.all(wireFiles.filter(file => /^request-[0-9]+\.json$/.test(file)).sort().map(async file => JSON.parse(await readFile(join(host!.files, 'wire', file), 'utf8')))); if (jobId) { evidence.retained_inferences = (await db.query('SELECT id,state,request,response,metrics FROM inference_requests WHERE job_id=$1 ORDER BY created_at', [jobId])).rows; evidence.retained_steps = (await db.query('SELECT id,sequence,kind,state,request,result FROM job_steps WHERE job_id=$1 ORDER BY sequence', [jobId])).rows; } } await writeFile(resultPath, JSON.stringify(evidence, null, 2) + '\n'); await host?.stop(); await db.end(); if (oldDispatch === undefined) delete process.env.DISPATCH_ENABLED; else process.env.DISPATCH_ENABLED = oldDispatch; /* Retain exact immutable workers/receipts for inspection; cleanup is separately coordinated. */ }
});
