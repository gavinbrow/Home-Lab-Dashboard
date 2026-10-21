import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { generateKeyPairSync, randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentBroker } from '@homelab/transport';
import { ProfileDefinitionSchema, RunContextSchema, type Workspace } from '@homelab/contracts';
import { createProviderAdapter, type ProviderAdapter, type ProviderSnapshot } from '@homelab/providers';
import { BlobStore, RootedHostFileAdapter, createCheckpointForJob, sha256 } from '@homelab/storage';
import { migrate } from '../../apps/api/src/core/migrate.js';
import { submitJob } from '../../apps/worker/src/queue.js';
import { runWorker } from '../../apps/worker/src/runtime.js';
import { createAgentHandler, type AgentDependencies } from '../../apps/worker/src/agent.js';
import { createAgentTools } from '../../apps/worker/src/agent-tools.js';
import { createOperationExecutor } from '../../apps/worker/src/operations.js';
import { startGoRelay } from './helpers/go-relay.js';
import { buildApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/auth/password.js';

const actualProvider = process.env.HOMELAB_REAL_OLLAMA_URL;
const selectedModel = process.env.HOMELAB_REAL_MODEL ?? 'qwen3:0.6b';
test(`persisted agent through actual signed Go relay: ${actualProvider ? `actual Ollama ${selectedModel}` : 'explicit deterministic provider fixture'}`, {
  skip: !(process.env.HOMELAB_LOCAL_PG_URL && process.env.HOMELAB_AGENT_EXE) ? 'Explicit owned PostgreSQL and built Go executable required' : false,
  timeout: actualProvider ? 180_000 : 90_000
}, async t => {
  const url = new URL(process.env.HOMELAB_LOCAL_PG_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  if (actualProvider) { const endpoint = new URL(actualProvider); assert.equal(endpoint.hostname, '127.0.0.1'); assert.equal(endpoint.port, '11438'); assert.ok(['qwen3:0.6b', 'qwen2.5:1.5b'].includes(selectedModel), 'Choose an explicitly approved local test model'); }
  const admin = new pg.Pool({ connectionString: url.href, max: 2 });
  const databaseName = `homelab_agent_relay_${randomUUID().replaceAll('-', '')}`;
  const previousDispatch = process.env.DISPATCH_ENABLED;
  let db: pg.Pool | undefined;
  let host: Awaited<ReturnType<typeof startGoRelay>> | undefined;
  let worker: Promise<void> | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const apiEnvironment = ['APP_ORIGIN', 'MASTER_KEY', 'ARTIFACT_ROOT', 'DISPATCH_SIGNING_KEY_FILE', 'DISPATCH_SIGNING_KEY_ID', 'COOKIE_SECURE', 'NODE_ENV'] as const;
  const previousApiEnvironment = Object.fromEntries(apiEnvironment.map(name => [name, process.env[name]]));
  const workerAbort = new AbortController();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`; db = new pg.Pool({ connectionString: url.href, max: 10 });
    await migrate(db); process.env.DISPATCH_ENABLED = 'true';
    await db.query('UPDATE runtime_control SET dispatch_enabled=true');
    const owner = randomUUID(), machine = randomUUID(), workspaceId = randomUUID(), identity = randomUUID(), grantId = randomUUID(), profileId = randomUUID(), projectId = randomUUID(), providerId = randomUUID(), poolId = randomUUID();
    await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'agent-relay@example.invalid','unused-auth')", [owner]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'Actual Go loopback host','unknown')", [machine, owner]);
    const key = generateKeyPairSync('ed25519');
    const broker = new AgentBroker(db, { signer: { keyId: 'agent-relay-component', privateKeyPem: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
    host = await startGoRelay({ db, broker, machine, workspace: workspaceId, identity, grant: grantId });
    assert.equal((host.health as any).machine_id, machine);
    const files = new RootedHostFileAdapter((target, method, route, body, options) => broker.rpc(target, method, route, body, { ...options, timeoutMs: 10_000, expectedMachineGeneration: host!.machineGeneration }));
    const binding = await files.binding(machine, workspaceId);
    assert.equal(binding.canonical_root, host.root);
    const limits = { max_tool_steps: 12, wall_time_seconds: 120, per_command_timeout_seconds: 30, max_output_bytes: 1024 * 1024 };
    const profile = ProfileDefinitionSchema.parse({ instructions: 'Use the structured file tools to complete the requested task. Do not use a shell. Perform actual verification before reporting completion.', tools: ['file.read', 'file.write', 'artifact.retain'], machine_ids: [machine], workspace_ids: [workspaceId], limits, required_verification: true });
    const grant = { id: grantId, owner_id: owner, revision: 1, tools: ['agent.run', 'file.read', 'file.write', 'artifact.retain', 'checkpoint.restore', 'checkpoint.create'], machine_ids: [machine], workspace_ids: [workspaceId], profile_ids: [profileId], secret_ids: [], expires_at: null, revoked_at: null };
    const modelId = actualProvider ? selectedModel : 'explicit-deterministic-provider-fixture';
    const snapshot: ProviderSnapshot = { id: providerId, revision: 1, adapter: 'ollama', baseUrl: actualProvider ?? 'http://explicit-no-network.invalid', runtimePoolId: poolId, routing: 'local', allowedAddresses: ['127.0.0.1'], allowPrivateHttp: true, timeoutMs: 120_000, contextLength: 4096 };
    await db.query("INSERT INTO provider_runtime_pools(id,owner_id,name) VALUES($1,$2,'One sequential inference slot')", [poolId, owner]);
    await db.query("INSERT INTO providers(id,owner_id,name,adapter,endpoint,runtime_pool_id,config,routing_classification) VALUES($1,$2,$3,'ollama',$4,$5,$6::jsonb,'local')", [providerId, owner, actualProvider ? 'Actual isolated Ollama' : 'Explicit injected provider fixture', snapshot.baseUrl, poolId, JSON.stringify({ allowed_addresses: ['127.0.0.1'], allow_private_http: true })]);
    let probeEvidence: Record<string, unknown> = { source: 'Explicit deterministic fixture only', fixture: true };
    if (actualProvider) {
      const probePath = modelId === 'qwen2.5:1.5b' ? 'docs/providers/actual-provider-qwen25-component-results.json' : 'docs/providers/actual-provider-component-results.json';
      const actualProbe = JSON.parse(await readFile(probePath, 'utf8'));
      const catalog = actualProbe.tests.find((item: any) => item.name === 'catalog' && item.outcome === 'PASS').evidence;
      const version = actualProbe.tests.find((item: any) => item.name === 'version' && item.outcome === 'PASS').evidence.server_version;
      assert.equal(catalog.id, modelId, 'Only genuine evidence for the explicitly selected model is accepted');
      probeEvidence = { source: probePath, live_provider: true, model_digest: catalog.metadata.digest, model_variant: catalog.metadata.variant ?? null, server_version: version };
    }
    await db.query("INSERT INTO capability_probes(id,owner_id,provider_id,model_id,capability,state,config_revision,evidence) VALUES($1,$2,$3,$4,'tools','tested_pass',1,$5::jsonb)", [randomUUID(), owner, providerId, modelId, JSON.stringify(probeEvidence)]);
    await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Actual Go agent project')", [projectId, owner]);
    await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,quota_bytes) VALUES($1,$2,$3,'Actual rooted project','native',$4,$5,$6,$6,16777216)", [workspaceId, owner, projectId, machine, binding.approved_root_id, host.root]);
    await db.query("INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity,restriction_verified) VALUES($1,$2,$3,'File-only fixture; no native execution','file-only-no-shell',false)", [identity, owner, machine]);
    await db.query("INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids,profile_ids) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)", [grantId, owner, JSON.stringify(grant.tools), JSON.stringify([machine]), JSON.stringify([workspaceId]), JSON.stringify([profileId])]);
    await db.query("INSERT INTO agent_profiles(id,owner_id,name) VALUES($1,$2,'File-only actual host profile')", [profileId, owner]);
    await db.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition) VALUES($1,1,$2,$3::jsonb)', [profileId, profile.instructions, JSON.stringify(profile)]);
    const context = RunContextSchema.parse({ schema_version: 1, provider_id: providerId, provider_config_revision: 1, provider_adapter: 'ollama', provider_endpoint: snapshot.baseUrl, model_id: modelId, profile_id: profileId, profile_revision: 1, execution_machine_id: machine, execution_identity_id: identity, workspace_id: workspaceId, workspace_revision: 1, environment_id: null, environment_generation: null, project_instruction_revision: 1, policy_revision: 1, limits });
    const store = new BlobStore(join(host.directory, 'retained-artifacts'));
    const checkpoint: AgentDependencies['checkpoint'] = async (job, runtime, reason) => {
      const row = (await db!.query('SELECT * FROM workspaces WHERE id=$1', [workspaceId])).rows[0]; row.quota_bytes = Number(row.quota_bytes);
      const captured = await createCheckpointForJob({ db: db!, store, adapter: files, workspace: row as Workspace, job, reason, assertLease: () => runtime.assertLease() });
      return { id: captured.id, manifest_hash: captured.manifest_hash, consistency: captured.consistency };
    };
    const operations = createOperationExecutor({ broker, checkpoint });
    let inferences = 0;
    const makeAdapter: NonNullable<AgentDependencies['makeAdapter']> = (provider, deps) => {
      if (actualProvider) {
        const adapter = createProviderAdapter(provider, deps);
        return { discoverModels: signal => adapter.discoverModels(signal), getServerVersion: signal => adapter.getServerVersion?.(signal) ?? Promise.resolve(null), getRuntimeState: signal => adapter.getRuntimeState(signal), getCapabilities: () => adapter.getCapabilities(), manage: (action, input, signal) => adapter.manage(action, input, signal), streamChat: (request, options) => { inferences++; return adapter.streamChat({ ...request, thinking: false, temperature: 0, maxOutputTokens: 512 }, options); } };
      }
      const adapter: ProviderAdapter = {
        async discoverModels() { return []; }, async getRuntimeState() { return { observedAt: new Date().toISOString(), residency: 'unknown', models: [], providerActiveRequests: null }; }, getCapabilities() { return { tools: 'unknown', images: 'unknown', cancellation: 'client-abort-only' }; }, async manage() { return {}; },
        async *streamChat() {
          inferences++;
          const toolCalls = inferences === 1 ? [{ id: 'write-report', name: 'write_file', arguments: { path: 'report.txt', content: 'ALPHA42', expected_sha256: null } }, { id: 'verify-report', name: 'verify_file', arguments: { path: 'report.txt' } }, { id: 'retain-report', name: 'publish_artifact', arguments: { path: 'report.txt', mime_type: 'text/plain' } }] : [];
          yield { type: 'completed', requestedModel: modelId, resolvedModel: modelId, finishReason: 'stop', toolCalls, usage: { source: 'provider', inputTokens: null, outputTokens: null, cachedInputTokens: null, loadSeconds: null, promptEvaluationSeconds: null, generationSeconds: null, promptTokensPerSecond: null, decodeTokensPerSecond: null }, wallSeconds: 0.01, firstContentSeconds: null };
        }
      }; return adapter;
    };
    const handler = createAgentHandler({ resolveCredential: async () => { throw new Error('No provider credentials configured in this local fixture'); }, makeAdapter, checkpoint, executeTool: createAgentTools({ broker, files, store, operations, checkpoint }) });
    const prompt = 'Call exactly ONE tool per assistant turn, wait for its result, then continue. First call write_file with exactly {"path":"report.txt","content":"ALPHA42","expected_sha256":null}. After it succeeds call verify_file with exactly {"path":"report.txt"}; OMIT sha256 completely, never send "null". After verification call publish_artifact with exactly {"path":"report.txt","mime_type":"text/plain"}; the key is mime_type, never mimeType. Then finish. Do not use any other tools or fields.';
    const job = await submitJob(db, { requester_id: owner, idempotency_key: 'actual-go-agent', kind: 'agent', context, payload: { prompt, grant, provider_snapshot: snapshot, profile_snapshot: profile, machine_identity_generations: { [machine]: host.machineGeneration } }, modifies_workspace: true });
    worker = runWorker(db, { agent: handler }, workerAbort.signal, 'actual-go-agent-worker');
    let finished: any;
    for (let attempt = 0; attempt < (actualProvider ? 1600 : 700); attempt++) {
      finished = (await db.query('SELECT state,reason,result FROM jobs WHERE id=$1', [job.id])).rows[0];
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(finished.state)) break;
      await delay(100);
    }
    if (actualProvider) {
      const evidence = { evidence_scope: 'actual isolated Ollama plus actual signed Go rooted files and PostgreSQL', model_id: modelId, observed_at: new Date().toISOString(), job_id: job.id, ...finished, inferences, steps: (await db.query('SELECT id,sequence,kind,state,request,result FROM job_steps WHERE job_id=$1 ORDER BY sequence', [job.id])).rows, operations: (await db.query('SELECT id,status,request,receipt FROM operations WHERE job_id=$1', [job.id])).rows };
      const evidenceFile = modelId === 'qwen2.5:1.5b' ? 'actual-model-qwen25-15b-result.json' : 'actual-model-agent-result.json';
      await writeFile(join(process.cwd(), 'docs', 'acceptance', evidenceFile), `${JSON.stringify(evidence, null, 2)}\n`);
    }
    assert.equal(finished.state, 'completed', `${JSON.stringify(finished)}; host=${host.diagnostic()}`);
    assert.equal(await readFile(join(host.root, 'report.txt'), 'utf8'), 'ALPHA42');
    assert.equal(finished.result.verification_status, 'passed');
    assert.ok(finished.result.verifications.some((result: any) => result.kind === 'file:report.txt' && result.passed));
    const changed = (await db.query('SELECT * FROM operations WHERE job_id=$1', [job.id])).rows;
    assert.equal(changed.length, 1); assert.equal(changed[0].status, 'succeeded');
    assert.ok(changed[0].receipt && changed[0].request.operation_id === changed[0].id);
    assert.ok((await db.query('SELECT count(*)::int AS count FROM checkpoints WHERE workspace_id=$1', [workspaceId])).rows[0].count >= 4);
    const retained = (await db.query('SELECT * FROM artifacts WHERE job_id=$1', [job.id])).rows;
    assert.equal(retained.length, 1); assert.equal(retained[0].sha256, sha256(Buffer.from('ALPHA42')));
    const signingFile = join(host.directory, 'api-signing-key.pem');
    await writeFile(signingFile, broker.signer!.privateKeyPem, { mode: 0o600 });
    const apiOrigin = 'http://127.0.0.1:5173';
    Object.assign(process.env, { APP_ORIGIN: apiOrigin, MASTER_KEY: randomBytes(32).toString('base64'), ARTIFACT_ROOT: store.root, DISPATCH_SIGNING_KEY_FILE: signingFile, DISPATCH_SIGNING_KEY_ID: broker.signer!.keyId, COOKIE_SECURE: 'false', NODE_ENV: 'test' });
    const apiPassword = randomBytes(24).toString('base64url');
    await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [owner, await hashPassword(apiPassword)]);
    app = await buildApp({ db });
    const apiAddress = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = await fetch(new URL('/api/v1/auth/login', apiAddress), { method: 'POST', headers: { origin: apiOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'agent-relay@example.invalid', password: apiPassword }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = (await login.json() as any).csrf_token;
    const api = async (path: string, body: unknown) => {
      const response = await fetch(new URL(`/api/v1${path}`, apiAddress), { method: 'POST', headers: { cookie, origin: apiOrigin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      return { status: response.status, body: await response.json() as any };
    };
    await t.test('actual authenticated checkpoint restoration preserves unrelated later bytes and rejects a changed preview', async () => {
      const ws = { ...(await db!.query('SELECT * FROM workspaces WHERE id=$1', [workspaceId])).rows[0], quota_bytes: 16777216 } as Workspace;
      await files.write(ws, 'report.txt', Buffer.from('external edit'), sha256(Buffer.from('ALPHA42')));
      await files.write(ws, 'unrelated-later.txt', Buffer.from('preserve this later work'), null);
      const review = { checkpoint_id: finished.result.after_checkpoint.id, grant_id: grantId, paths: ['report.txt'], delete_extras: false };
      const preview = await api(`/projects/${workspaceId}/restore/preview`, review);
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      await files.write(ws, 'unrelated-later.txt', Buffer.from('newest later work'), sha256(Buffer.from('preserve this later work')));
      const stale = await api(`/projects/${workspaceId}/restore`, { ...review, operation_id: randomUUID(), expected_manifest_hash: preview.body.expected_manifest_hash, plan_hash: preview.body.plan_hash });
      assert.equal(stale.status, 409, JSON.stringify(stale.body));
      const refreshed = await api(`/projects/${workspaceId}/restore/preview`, review);
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
      const request = { ...review, operation_id: randomUUID(), expected_manifest_hash: refreshed.body.expected_manifest_hash, plan_hash: refreshed.body.plan_hash };
      const restored = await api(`/projects/${workspaceId}/restore`, request);
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.equal((await files.read(ws, 'report.txt')).toString(), 'ALPHA42');
      assert.equal((await files.read(ws, 'unrelated-later.txt')).toString(), 'newest later work');
      assert.ok(restored.body.before_checkpoint_id && restored.body.after_checkpoint_id);
      const replayed = await api(`/projects/${workspaceId}/restore`, request);
      assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    });
    await t.test('published bytes remain available independently of stopped host connection', async () => {
      await host!.stopConnection();
      assert.equal((await store.get(retained[0].sha256)).toString(), 'ALPHA42');
      const download = await fetch(new URL(`/api/v1/artifacts/${retained[0].id}/download`, apiAddress), { headers: { cookie }, signal: AbortSignal.timeout(3000) });
      assert.equal(download.status, 200);
      assert.equal(await download.text(), 'ALPHA42');
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM workspace_locks WHERE workspace_id=$1', [workspaceId])).rows[0].count, 0);
    });
  } finally {
    workerAbort.abort(); await worker?.catch(() => undefined); await app?.close(); await host?.close(); await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end();
    if (previousDispatch === undefined) delete process.env.DISPATCH_ENABLED; else process.env.DISPATCH_ENABLED = previousDispatch;
    for (const name of apiEnvironment) { if (previousApiEnvironment[name] === undefined) delete process.env[name]; else process.env[name] = previousApiEnvironment[name]; }
  }
});
