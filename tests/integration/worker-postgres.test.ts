import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { RunContextSchema } from '@homelab/contracts';
import type { ProviderAdapter, ProviderSnapshot } from '@homelab/providers';
import { migrate } from '../../apps/api/src/core/migrate.js';
import { submitJob } from '../../apps/worker/src/queue.js';
import { claimJob, runClaimedJob } from '../../apps/worker/src/runtime.js';
import { reserveProvider, markProviderUncertain } from '../../apps/worker/src/reservations.js';
import { createChatHandler } from '../../apps/worker/src/chat.js';
import { captureMachineGenerations } from '../../apps/worker/src/authority.js';

test('local real PostgreSQL: worker concurrency, fencing, unknown outcomes and persisted chat fixture', {
  skip: !process.env.HOMELAB_LOCAL_PG_URL ? 'Explicit throwaway loopback HOMELAB_LOCAL_PG_URL required' : false,
  timeout: 60_000
}, async t => {
  const url = new URL(process.env.HOMELAB_LOCAL_PG_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const admin = new pg.Pool({ connectionString: url.href, max: 2 });
  const databaseName = `homelab_worker_${randomUUID().replaceAll('-', '')}`;
  let db: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    db = new pg.Pool({ connectionString: url.href, max: 10 });
    await migrate(db);
    const owner = randomUUID(), machine = randomUUID(), project = randomUUID(), workspace = randomUUID();
    await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'worker-fixture@example.invalid','not-an-authentication-fixture')", [owner]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'not-enrolled-local-fixture','unknown')", [machine, owner]);
    await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'local lock fixture')", [project, owner]);
    await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path) VALUES($1,$2,$3,'not-accessed','native',$4,'fixture','/not-accessed','/not-accessed')", [workspace, owner, project, machine]);
    // These independent subcases intentionally retain unknown reservations. Give
    // the disposable fixture room for later epoch checks without releasing them.
    await db.query('UPDATE runtime_control SET dispatch_enabled=true,max_concurrent_jobs=16');
    const submit = async (key: string, workspaceId: string | null = null) => submitJob(db!, { requester_id: owner, idempotency_key: key, context: null, kind: 'validation_fixture', payload: { machine_identity_generations: workspaceId ? await captureMachineGenerations(db!, owner, [machine]) : {} }, workspace_id: workspaceId, modifies_workspace: !!workspaceId });
    const hideExisting = () => db!.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");
    await t.test('concurrent queue claims are distinct and a stale fence cannot call the handler', async () => {
      await submit('claim-a'); await submit('claim-b');
      const claims = await Promise.all([claimJob(db!, 'worker-a'), claimJob(db!, 'worker-b')]);
      assert.ok(claims[0] && claims[1]);
      assert.notEqual(claims[0].id, claims[1].id);
      const stale = claims[0];
      await db!.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [stale.id]);
      const fresh = await claimJob(db!, 'replacement-worker');
      assert.equal(fresh!.id, stale.id);
      assert.equal(BigInt(fresh!.fence), BigInt(stale.fence) + 1n);
      let obsoleteHandlerCalled = false;
      await runClaimedJob(db!, stale, { validation_fixture: async () => { obsoleteHandlerCalled = true; } });
      assert.equal(obsoleteHandlerCalled, false);
      await runClaimedJob(db!, fresh!, { validation_fixture: async (_job, runtime) => runtime.complete({ local_fixture: true }) });
      assert.equal((await db!.query('SELECT state FROM jobs WHERE id=$1', [stale.id])).rows[0].state, 'completed');
    });
    await t.test('unknown launch retains workspace writer lock after lease expiry and prevents completion', async () => {
      await hideExisting();
      const first = await submit('unknown-writer', workspace);
      const second = await submit('second-writer', workspace);
      const original = await claimJob(db!, 'original-writer');
      assert.equal(original!.id, first.id);
      const operation = randomUUID();
      await db!.query("INSERT INTO operations(id,job_id,step_id,request_hash,request,machine_id,fence,status) VALUES($1,$2,'fixture-step','fixture-hash','{}',$3,$4,'outcome_unknown')", [operation, first.id, machine, original!.fence]);
      await db!.query('UPDATE workspace_locks SET operation_id=$1 WHERE workspace_id=$2', [operation, workspace]);
      await db!.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id]);
      const replacement = await claimJob(db!, 'reconciler');
      assert.equal(replacement!.id, first.id);
      await runClaimedJob(db!, replacement!, { validation_fixture: async (_job, runtime) => runtime.complete({ forbidden: true }) });
      assert.equal((await db!.query('SELECT state FROM jobs WHERE id=$1', [first.id])).rows[0].state, 'interrupted');
      assert.equal((await db!.query('SELECT job_id FROM workspace_locks WHERE workspace_id=$1', [workspace])).rows[0].job_id, first.id);
      assert.equal(await claimJob(db!, 'second-writer-claim'), null);
      assert.equal((await db!.query('SELECT state,reason FROM jobs WHERE id=$1', [second.id])).rows[0].reason, 'workspace_writer_busy');
    });
    await t.test('provider concurrency is serialized and uncertain reservations do not expire with a lease', async () => {
      const poolId = randomUUID();
      await db!.query("INSERT INTO provider_runtime_pools(id,owner_id,name,max_concurrency) VALUES($1,$2,'local capacity fixture',1)", [poolId, owner]);
      const jobs = [await submit('capacity-a'), await submit('capacity-b')];
      const permits = await Promise.all(jobs.map(job => reserveProvider(db!, poolId, job.id)));
      assert.equal(permits.filter(Boolean).length, 1);
      const winner = jobs[permits.indexOf(true)], loser = jobs[permits.indexOf(false)];
      await markProviderUncertain(db!, winner.id);
      await db!.query("UPDATE resource_reservations SET lease_until=now()-interval '1 day' WHERE job_id=$1", [winner.id]);
      assert.equal(await reserveProvider(db!, poolId, loser.id), false);
      assert.equal(await reserveProvider(db!, poolId, winner.id), false);
    });
    for (const interrupted of [false, true]) {
      await t.test(`chat worker persists ${interrupted ? 'partial interrupted output without retry' : 'completed output and request provenance'} using an explicit injected fixture`, async () => {
        await hideExisting();
        const poolId = randomUUID(), providerId = randomUUID();
        await db!.query("INSERT INTO provider_runtime_pools(id,owner_id,name) VALUES($1,$2,'fixture-only no network')", [poolId, owner]);
        await db!.query("INSERT INTO providers(id,owner_id,name,adapter,endpoint,runtime_pool_id) VALUES($1,$2,'injected fixture','ollama','http://no-network.invalid',$3)", [providerId, owner, poolId]);
        const snapshot: ProviderSnapshot = { id: providerId, revision: 1, adapter: 'ollama', baseUrl: 'http://no-network.invalid', runtimePoolId: poolId, routing: 'unknown', allowedAddresses: ['127.0.0.1'], allowPrivateHttp: true, timeoutMs: 1000 };
        const context = RunContextSchema.parse({ schema_version: 1, provider_id: providerId, provider_config_revision: 1, provider_adapter: 'ollama', provider_endpoint: snapshot.baseUrl, model_id: 'injected-fixture-only', profile_id: null, profile_revision: null, execution_machine_id: null, execution_identity_id: null, workspace_id: null, workspace_revision: null, environment_id: null, environment_generation: null, project_instruction_revision: null, policy_revision: 1, limits: { max_tool_steps: 2, wall_time_seconds: 10, per_command_timeout_seconds: 2, max_output_bytes: 1024 } });
        const job = await submitJob(db!, { requester_id: owner, idempotency_key: `chat-${interrupted}`, context, kind: 'chat', payload: { prompt: 'Local explicit fixture', provider_snapshot: snapshot }, modifies_workspace: false });
        let invocations = 0;
        const adapter: ProviderAdapter = {
          async discoverModels() { return []; }, async getRuntimeState() { return { observedAt: new Date().toISOString(), residency: 'unknown', models: [], providerActiveRequests: null }; },
          getCapabilities() { return { tools: 'unknown', images: 'unknown', cancellation: 'client-abort-only' }; }, async manage() { return {}; },
          async *streamChat() {
            invocations++;
            yield { type: 'text', text: 'explicit local fixture' };
            if (interrupted) throw new Error('Deliberate injected stream loss');
            yield { type: 'completed', requestedModel: context.model_id, resolvedModel: context.model_id, finishReason: 'stop', toolCalls: [], usage: { source: 'provider', inputTokens: null, outputTokens: null, cachedInputTokens: null, loadSeconds: null, promptEvaluationSeconds: null, generationSeconds: null, promptTokensPerSecond: null, decodeTokensPerSecond: null }, wallSeconds: 0.01, firstContentSeconds: 0.001 };
          }
        };
        const handler = createChatHandler(async () => { throw new Error('No credentials are available to this fixture'); }, () => adapter);
        const claimed = await claimJob(db!, `chat-worker-${interrupted}`);
        assert.equal(claimed!.id, job.id);
        await runClaimedJob(db!, claimed!, { chat: handler });
        const expected = interrupted ? 'interrupted' : 'completed';
        assert.equal((await db!.query('SELECT state FROM jobs WHERE id=$1', [job.id])).rows[0].state, expected);
        assert.equal((await db!.query('SELECT state FROM inference_requests WHERE job_id=$1', [job.id])).rows[0].state, expected);
        const messages = (await db!.query('SELECT role,state,content FROM messages WHERE job_id=$1 ORDER BY role', [job.id])).rows;
        assert.equal(messages.length, 2);
        assert.equal(messages.find(row => row.role === 'assistant')!.content.text, 'explicit local fixture');
        assert.equal(messages.find(row => row.role === 'assistant')!.state, expected);
        assert.equal((await db!.query("SELECT count(*)::int AS count FROM job_events WHERE job_id=$1 AND type='assistant.delta'", [job.id])).rows[0].count, 1);
        await runClaimedJob(db!, claimed!, { chat: handler });
        assert.equal(invocations, 1);
        assert.equal((await db!.query('SELECT count(*)::int AS count FROM inference_requests WHERE job_id=$1', [job.id])).rows[0].count, 1);
        if (interrupted) assert.equal((await db!.query('SELECT state FROM resource_reservations WHERE job_id=$1', [job.id])).rows[0].state, 'uncertain');
      });
    }
    await t.test('restore epoch fencing prevents a previously leased handler from committing completion', async () => {
      await hideExisting();
      const submitted = await submit('restore-epoch-fence');
      const claimed = await claimJob(db!, 'pre-restore-worker');
      assert.equal(claimed!.id, submitted.id);
      await runClaimedJob(db!, claimed!, { validation_fixture: async (_job, runtime) => {
        await db!.query('UPDATE runtime_control SET dispatch_epoch=gen_random_uuid(),restore_mode=true,dispatch_enabled=false');
        await runtime.complete({ must_not_commit: true });
      } });
      const observed = (await db!.query('SELECT state,result FROM jobs WHERE id=$1', [submitted.id])).rows[0];
      assert.notEqual(observed.state, 'completed');
      assert.equal(observed.result, null);
      assert.equal(await claimJob(db!, 'post-restore-worker'), null);
    });
  } finally {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});
