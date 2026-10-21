import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { ProfileDefinitionSchema, RunContextSchema } from '@homelab/contracts';
import { sha256 } from '@homelab/storage';
import { submitJob } from '../../apps/worker/src/queue.js';
import { hashPassword } from '../../apps/api/src/auth/password.js';
import { buildApp } from '../../apps/api/src/app.js';
import { startLinuxStackRelay, linux, stackRoot, stackUnc, safeImage } from './helpers/linux-stack.js';

test('actual model Linux 180-second sentinel survives worker/control-plane loss without execution replay', {
  skip: process.env.HOMELAB_LINUX_SENTINEL !== '1' ? 'Explicit owned Linux stack/model and coordinated API outage required' : false,
  timeout: 1_800_000
}, async () => {
  assert.equal(process.env.HOMELAB_LINUX_STACK, '1');
  assert.equal(process.env.HOMELAB_DASHBOARD_TABS_CLOSED, '1', 'Browser owner must confirm dashboard tabs closed');
  const adminUrl = new URL((await readFile(join(stackUnc, 'config', 'database-admin-url'), 'utf8')).trim()); adminUrl.hostname = '127.0.0.1'; adminUrl.port = '15439';
  const db = new pg.Pool({ connectionString: adminUrl.href, max: 8 });
  const values = Object.fromEntries((await linux('sudo', '-n', '/bin/cat', `${stackRoot}/config/runtime.env`)).split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, '')]; }));
  const workerUrl = new URL(values.DATABASE_URL); workerUrl.hostname = '127.0.0.1'; workerUrl.port = '15439';
  const ids = Object.fromEntries(['owner', 'machine', 'workspace', 'identity', 'environment', 'grant', 'project', 'profile', 'provider', 'pool'].map(key => [key, randomUUID()]));
  // Atomic blob publication requires hardlinks; Windows-to-WSL UNC does not support them.
  const artifactRoot = resolve(`tests/integration/.wave3-runtime/artifacts-${ids.workspace}`);
  const previousEnvironment = { ...process.env };
  process.env.DISPATCH_ENABLED = 'true'; process.env.RESTORE_MODE = 'false';
  let host: Awaited<ReturnType<typeof startLinuxStackRelay>> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let apiDb: pg.Pool | undefined;
  let worker: ChildProcess | undefined;
  let workerDiagnostic = '';
  let jobId: string | undefined;
  let counterTimer: NodeJS.Timeout | undefined;
  let uiPublished = false;
  let startUI: (() => Promise<{ address: string; cookie: string; csrf: string }>) | undefined;
  const waitForUI = async () => {
    if (process.env.HOMELAB_KEEP_UI_FIXTURE !== '1' || !uiPublished) return;
    const until = Date.now() + 20 * 60_000;
    while (Date.now() < until && !(await readFile(resolve('tests/integration/.wave3-runtime/release-ui-fixture'), 'utf8').catch(() => ''))) await delay(1000);
  };
  const evidence: Record<string, any> = { scope: 'actual selected model, PostgreSQL, signed mTLS Go Linux and restricted disposable Docker execution', started_at: new Date().toISOString(), image: safeImage, ids, outcome: 'RUNNING' };
  const evidenceFile = resolve('docs/acceptance/linux-sentinel-result.json');
  const stopWorker = async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) { const exited = new Promise<void>(done => worker!.once('exit', () => done())); worker.kill('SIGKILL'); await exited; }
  };
  try {
    const password = randomBytes(24).toString('base64url');
    await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [ids.owner, `${ids.owner}@validation.invalid`, await hashPassword(password)]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'Actual isolated WSL Linux host','linux')", [ids.machine, ids.owner]);
    host = await startLinuxStackRelay({ db, owner: ids.owner, machine: ids.machine, workspace: ids.workspace, identity: ids.identity, environment: ids.environment, grant: ids.grant });
    assert.equal((host.proof as any).verified, true, 'Actual container UID probe must pass');
    evidence.identity_proof = host.proof; evidence.runtime_id_before = host.runtimeId;
    await copyFile('tests/integration/survival-fixture.mjs', join(host.projectFiles, 'sentinel.mjs'));
    const tools = ['agent.run', 'run_command', 'file.read', 'file.write', 'file.delete', 'file.restore', 'artifact.retain', 'checkpoint.create', 'checkpoint.restore', 'project.export', 'workspace.terminal', 'environment.restart', 'environment.rebuild', 'environment.remove'];
    const limits = { max_tool_steps: 16, wall_time_seconds: 720, per_command_timeout_seconds: 240, max_output_bytes: 1024 * 1024 };
    const profile = ProfileDefinitionSchema.parse({ instructions: 'Complete the task autonomously using tool calls. A schema rejection with executed:false did not execute anything: repair the rejected arguments yourself and call again. Once run_command is accepted or running, wait for its original result and never repeat that command. Then verify and retain both outputs. Do not ask the user to fix tool arguments.', tools: ['run_command', 'file.read', 'artifact.retain'], machine_ids: [ids.machine], workspace_ids: [ids.workspace], execution_identity_ids: [ids.identity], limits, network_policy: { mode: 'deny' }, required_verification: true });
    const grant = { id: ids.grant, owner_id: ids.owner, revision: 1, tools, machine_ids: [ids.machine], workspace_ids: [ids.workspace], profile_ids: [ids.profile], secret_ids: [], expires_at: null, revoked_at: null };
    await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Actual recovery sentinel project')", [ids.project, ids.owner]);
    await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,quota_bytes,environment_id,environment_generation) VALUES($1,$2,$3,'Actual restricted container project','container',$4,$7,$5,'/workspace/project',67108864,$6,1)", [ids.workspace, ids.owner, ids.project, ids.machine, host.root, ids.environment, ids.workspace]);
    await db.query("INSERT INTO environment_generations(id,workspace_id,machine_id,generation,runtime_id,image_digest,state,mount_path) VALUES($1,$2,$3,1,$4,$5,'running','/workspace/project')", [ids.environment, ids.workspace, ids.machine, host.runtimeId, safeImage]);
    await db.query('INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity,restriction_verified,config) VALUES($1,$2,$3,$4,$5,true,$6)', [ids.identity, ids.owner, ids.machine, 'Actually probed nonroot container identity', '10001:10001', { mode: 'container', workspace_ids: [ids.workspace], proof: host.proof }]);
    await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids,profile_ids) VALUES($1,$2,$3,$4,$5,$6)', [ids.grant, ids.owner, JSON.stringify(tools), JSON.stringify([ids.machine]), JSON.stringify([ids.workspace]), JSON.stringify([ids.profile])]);
    await db.query("INSERT INTO agent_profiles(id,owner_id,name) VALUES($1,$2,'Actual sentinel profile')", [ids.profile, ids.owner]);
    await db.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition) VALUES($1,1,$2,$3)', [ids.profile, profile.instructions, profile]);
    await db.query("INSERT INTO provider_runtime_pools(id,owner_id,name) VALUES($1,$2,'Isolated actual CPU model')", [ids.pool, ids.owner]);
    const snapshot = { id: ids.provider, revision: 1, adapter: 'ollama', baseUrl: 'http://127.0.0.1:11438', runtimePoolId: ids.pool, routing: 'local', allowedAddresses: ['127.0.0.1'], allowPrivateHttp: true, timeoutMs: 120_000, contextLength: 4096 };
    await db.query("INSERT INTO providers(id,owner_id,name,adapter,endpoint,runtime_pool_id,config,routing_classification) VALUES($1,$2,'Explicit actual qwen2.5 CPU fixture','ollama',$3,$4,$5,'local')", [ids.provider, ids.owner, snapshot.baseUrl, ids.pool, { allowed_addresses: ['127.0.0.1'], allow_private_http: true, context_length: 4096 }]);
    const probe = JSON.parse(await readFile('docs/providers/actual-provider-qwen25-component-results.json', 'utf8'));
    const catalog = probe.tests.find((item: any) => item.name === 'catalog' && item.outcome === 'PASS').evidence;
    const version = probe.tests.find((item: any) => item.name === 'version' && item.outcome === 'PASS').evidence.server_version;
    assert.equal(catalog.id, 'qwen2.5:1.5b');
    await db.query('INSERT INTO capability_probes(id,owner_id,provider_id,model_id,capability,state,config_revision,evidence) VALUES($1,$2,$3,$4,\'tools\',\'tested_pass\',1,$5)', [randomUUID(), ids.owner, ids.provider, catalog.id, { source: 'docs/providers/actual-provider-qwen25-component-results.json', live_provider: true, model_digest: catalog.metadata.digest, model_variant: catalog.metadata.variant ?? null, server_version: version }]);
    const context = RunContextSchema.parse({ schema_version: 1, provider_id: ids.provider, provider_config_revision: 1, provider_adapter: 'ollama', provider_endpoint: snapshot.baseUrl, model_id: catalog.id, profile_id: ids.profile, profile_revision: 1, execution_machine_id: ids.machine, execution_identity_id: ids.identity, workspace_id: ids.workspace, workspace_revision: 1, environment_id: ids.environment, environment_generation: 1, project_instruction_revision: 1, policy_revision: 1, limits });
    const prompt = 'First use run_command. It requires TWO top-level fields: executable and args. executable is the string /usr/local/bin/node. args is the JSON ARRAY ["/workspace/project/sentinel.mjs","/workspace/project","trusted-operation","180"]. The executable is NOT inside args. Correct JSON: {"executable":"/usr/local/bin/node","args":["/workspace/project/sentinel.mjs","/workspace/project","trusted-operation","180"]}. If schema rejection says executed:false, fix the arguments yourself and retry. After the command is accepted, NEVER launch it again: wait for its actual completion (180 seconds). Then verify_file {"path":"sentinel-report.txt"}, verify_file {"path":"sentinel-binary.bin"}, publish_artifact {"path":"sentinel-report.txt","mime_type":"text/plain"}, publish_artifact {"path":"sentinel-binary.bin","mime_type":"application/octet-stream"}. Omit sha256 on verify_file. One tool per turn; finish after verification and both artifacts.';
    const job = await submitJob(db, { requester_id: ids.owner, idempotency_key: `sentinel-${ids.workspace}`, kind: 'agent', context, payload: { prompt, grant, profile_snapshot: profile, provider_snapshot: snapshot, machine_identity_generations: { [ids.machine]: host.machineGeneration } }, modifies_workspace: true }); jobId = job.id; evidence.job_id = job.id;
    const keyFile = join(host.files, 'worker-signing.pem'); await writeFile(keyFile, host.signer.privateKeyPem, { mode: 0o600 });
    const workerConfig = join(host.files, 'worker-config.json');
    await writeFile(workerConfig, JSON.stringify({ jobId, databaseUrl: workerUrl.href, keyId: host.signer.keyId, keyFile, artifactRoot }), { mode: 0o600 });
    startUI = async () => {
    Object.assign(process.env, { APP_ORIGIN: 'http://localhost:5173', MASTER_KEY: values.MASTER_KEY, ARTIFACT_ROOT: artifactRoot, DISPATCH_SIGNING_KEY_FILE: keyFile, DISPATCH_SIGNING_KEY_ID: host!.signer.keyId, COOKIE_SECURE: 'false', NODE_ENV: 'test', DISPATCH_ENABLED: 'true' });
    apiDb = new pg.Pool({ connectionString: workerUrl.href, max: 6 });
    app = await buildApp({ db: apiDb });
    const requestCounts: Record<string, number> = {};
    app.addHook('onRequest', async request => { const path = `${request.method} ${request.url.split('?')[0]}`; requestCounts[path] = (requestCounts[path] ?? 0) + 1; });
    counterTimer = setInterval(() => { void writeFile(resolve('tests/integration/.wave3-runtime/ui-request-counts.json'), JSON.stringify({ observed_at: new Date().toISOString(), counts: requestCounts })); }, 1000);
    const address = await app.listen({ host: '127.0.0.1', port: 3021 });
    const login = await fetch(new URL('/api/v1/auth/login', address), { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ email: `${ids.owner}@validation.invalid`, password }) }); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = (await login.json() as any).csrf_token;
    await writeFile(resolve('tests/integration/.wave3-runtime/release-ui-fixture'), '');
    await writeFile(resolve('tests/integration/.wave3-runtime/ui-fixture.json'), JSON.stringify({ api_origin: address, app_origin: 'http://localhost:5173', email: `${ids.owner}@validation.invalid`, password, ids, host_directory: host!.directory, artifact_root: artifactRoot, job_id: job.id, artifact_ids: [] }, null, 2), { mode: 0o600 });
    uiPublished = true;
    return { address, cookie, csrf };
    };
    const launchWorker = () => {
      worker = spawn(process.execPath, ['--import', 'tsx', resolve('tests/integration/helpers/sentinel-worker.ts'), workerConfig], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      worker.stderr!.on('data', bytes => { workerDiagnostic = (workerDiagnostic + String(bytes)).slice(-4096); });
    };
    launchWorker();
    const counterPath = join(host.projectFiles, 'execution-counter.ndjson');
    let started: any;
    for (let attempt = 0; attempt < 700; attempt++) {
      const counter = await readFile(counterPath, 'utf8').catch(() => '');
      if (counter.trim()) { started = JSON.parse(counter.trim().split('\n')[0]); break; }
      const row = (await db.query('SELECT state,reason FROM jobs WHERE id=$1', [job.id])).rows[0];
      if (['failed', 'interrupted', 'cancelled'].includes(row.state)) throw Error(`Before sentinel start: ${JSON.stringify(row)}; worker=${workerDiagnostic}`);
      await delay(250);
    }
    assert.ok(started, `Actual startup counter missing; worker=${workerDiagnostic}`);
    const operation = (await db.query('SELECT * FROM operations WHERE id=$1 AND job_id=$2', [started.operationId, job.id])).rows[0]; assert.ok(operation);
    evidence.operation_id = operation.id; evidence.physical_start = started;
    await stopWorker(); evidence.worker_killed_at = new Date().toISOString();
    console.log(`SENTINEL_ACCEPTED job=${job.id} operation=${operation.id}; worker stopped; request coordinated API outage now`);
    await writeFile(resolve('tests/integration/.wave3-runtime/sentinel-progress.json'), JSON.stringify({ state: 'accepted', job_id: job.id, operation_id: operation.id, accepted_at: new Date().toISOString() }));
    const absentStart = Date.now(); let apiDown = 0, apiUp = 0;
    while (Date.now() - absentStart < 185_000) {
      try { const response = await fetch('http://127.0.0.1:3009/readyz', { signal: AbortSignal.timeout(1500) }); response.ok ? apiUp++ : apiDown++; } catch { apiDown++; }
      await delay(2000);
    }
    evidence.browser_absence_seconds = (Date.now() - absentStart) / 1000; evidence.api_outage_observations = { up: apiUp, down: apiDown };
    const { address, cookie, csrf } = await startUI();
    await writeFile(resolve('tests/integration/.wave3-runtime/sentinel-progress.json'), JSON.stringify({ state: 'absence_end', job_id: job.id, operation_id: operation.id, ended_at: new Date().toISOString(), elapsed_seconds: evidence.browser_absence_seconds }));
    console.log('SENTINEL_ABSENCE_END; UI3021 manifest ready; original job reconciliation continues');
    assert.ok(apiDown > 0, 'Actual coordinated control-plane outage must be observed');
    launchWorker(); evidence.replacement_worker_started_at = new Date().toISOString();
    let finished: any;
    for (let attempt = 0; attempt < 1600; attempt++) {
      finished = (await db.query('SELECT state,reason,result FROM jobs WHERE id=$1', [job.id])).rows[0];
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(finished.state)) break;
      await delay(250);
    }
    evidence.job = finished;
    const starts = (await readFile(counterPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); evidence.execution_counter = starts;
    assert.equal(starts.length, 1, 'Physical process startup must occur exactly once'); assert.equal(starts[0].operationId, operation.id);
    assert.equal(finished.state, 'completed', `${JSON.stringify(finished)}; worker=${workerDiagnostic}`); assert.equal(finished.result.verification_status, 'passed');
    const manifest = JSON.parse(await readFile(join(host.projectFiles, `${operation.id}-manifest.json`), 'utf8'));
    for (const output of manifest.outputs) { const bytes: Buffer = await readFile(join(host.projectFiles, output.path)); assert.equal(bytes.length, output.size); assert.equal(sha256(bytes), output.sha256); }
    const retained = (await db.query('SELECT id,relative_path,sha256,size_bytes FROM artifacts WHERE job_id=$1 ORDER BY relative_path', [job.id])).rows; assert.equal(retained.length, 2);
    evidence.outputs = manifest.outputs; evidence.artifacts = retained;
    evidence.operations = (await db.query('SELECT id,status,request_hash,receipt,outcome FROM operations WHERE job_id=$1', [job.id])).rows;
    const logs = (await db.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='log' AND payload->>'operation_id'=$2 ORDER BY id", [job.id, operation.id])).rows.map(row => row.payload.data ?? '').join('');
    const sequences = logs.split(/\r?\n/).flatMap(line => { try { const item = JSON.parse(line); return Number.isInteger(item.sequence) ? [item.sequence] : []; } catch { return []; } });
    assert.deepEqual(sequences, Array.from({ length: 180 }, (_, at) => at + 1)); evidence.numbered_logs = { count: sequences.length, first: sequences[0], last: sequences.at(-1) };
    const rebuilt = await fetch(`${address}/api/v1/projects/${ids.workspace}/environment/rebuild`, { method: 'POST', headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ grant_id: ids.grant, operation_id: randomUUID() }), signal: AbortSignal.timeout(60_000) });
    const replacement = await rebuilt.json() as any; assert.equal(rebuilt.status, 200, JSON.stringify(replacement)); evidence.replacement = replacement;
    const next = (await db.query('SELECT environment_id,environment_generation FROM workspaces WHERE id=$1', [ids.workspace])).rows[0]; assert.equal(next.environment_generation, 2); assert.notEqual(next.environment_id, ids.environment);
    for (const output of manifest.outputs) assert.equal(sha256(await readFile(join(host.projectFiles, output.path))), output.sha256);
    for (const artifact of retained) { const response = await fetch(`${address}/api/v1/artifacts/${artifact.id}/download`, { headers: { cookie } }); assert.equal(response.status, 200); assert.equal(sha256(Buffer.from(await response.arrayBuffer())), artifact.sha256); }
    evidence.outcome = 'PASS'; evidence.completed_at = new Date().toISOString();
    await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
    await writeFile(resolve('tests/integration/.wave3-runtime/ui-fixture.json'), JSON.stringify({ api_origin: address, app_origin: 'http://localhost:5173', email: `${ids.owner}@validation.invalid`, password, ids, host_directory: host.directory, artifact_root: artifactRoot, job_id: job.id, artifact_ids: retained.map(item => item.id) }, null, 2), { mode: 0o600 });
    console.log('SENTINEL_PASS; UI fixture ready3021; waiting explicit release marker (maximum20min)');
    await waitForUI();
  } catch (error) {
    evidence.outcome = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error); evidence.host_diagnostic = host?.diagnostic();
    if (jobId) { evidence.persisted_steps = (await db.query('SELECT id,kind,state,request,result FROM job_steps WHERE job_id=$1 ORDER BY sequence', [jobId])).rows; evidence.job = (await db.query('SELECT state,reason,result FROM jobs WHERE id=$1', [jobId])).rows[0]; }
    await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
    if (startUI && !uiPublished) await startUI().catch(() => undefined);
    if (uiPublished) console.log('SENTINEL_FAILED; actual failed-state UI3021 retained until explicit release; no retry');
    await waitForUI(); throw error;
  } finally {
    if (counterTimer) clearInterval(counterTimer);
    await stopWorker(); await app?.close(); await apiDb?.end(); await host?.stop(); await db.end();
    for (const name of Object.keys(process.env)) if (!(name in previousEnvironment)) delete process.env[name];
    Object.assign(process.env, previousEnvironment);
    // Files, DB evidence and only owned containers remain for coordinated backup/recovery. No broad cleanup.
  }
});
