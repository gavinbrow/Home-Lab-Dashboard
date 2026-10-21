import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../apps/api/src/core/migrate.js';
import { buildApp } from '../../apps/api/src/app.js';

// This is actual PostgreSQL and HTTP, but local component evidence only. It does
// not establish Windows/Linux host, model, desktop or release acceptance.
test('local real PostgreSQL: migrations, HTTP sessions, durable queue and saved action transactions', {
  skip: !process.env.HOMELAB_LOCAL_PG_URL ? 'Opt in with an explicitly owned throwaway loopback HOMELAB_LOCAL_PG_URL' : false,
  timeout: 60_000
}, async t => {
  const source = new URL(process.env.HOMELAB_LOCAL_PG_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname), 'Local component tests only target loopback');
  const admin = new pg.Pool({ connectionString: source.href, max: 2 });
  const databaseName = `homelab_integration_${randomUUID().replaceAll('-', '')}`;
  const artifactRoot = await mkdtemp(join(tmpdir(), 'homelab-validation-'));
  const variables = ['APP_ORIGIN', 'MASTER_KEY', 'BOOTSTRAP_TOKEN', 'ARTIFACT_ROOT', 'DISPATCH_ENABLED', 'RESTORE_MODE', 'COOKIE_SECURE', 'NODE_ENV'] as const;
  const previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  const bootstrapToken = randomBytes(32).toString('base64url');
  const password = randomBytes(24).toString('base64url');
  const origin = 'http://127.0.0.1:5173';
  Object.assign(process.env, { APP_ORIGIN: origin, MASTER_KEY: randomBytes(32).toString('base64'), BOOTSTRAP_TOKEN: bootstrapToken, ARTIFACT_ROOT: artifactRoot, DISPATCH_ENABLED: 'false', RESTORE_MODE: 'false', COOKIE_SECURE: 'false', NODE_ENV: 'test' });
  let db: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    source.pathname = `/${databaseName}`;
    db = new pg.Pool({ connectionString: source.href, max: 5 });
    await migrate(db);
    await migrate(db);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count >= 1, true);
    app = await buildApp({ db });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    let cookie = '';
    let csrf = '';
    const http = async (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(new URL(path, address), { method, redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { origin, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      const body = await response.json() as any;
      return { status: response.status, body, headers: response.headers };
    };
    assert.equal((await http('GET', '/readyz')).status, 200);
    assert.equal((await http('GET', '/api/v1/jobs')).status, 401);
    const login = await http('POST', '/api/v1/auth/bootstrap', { email: 'local-validation@example.invalid', password, token: bootstrapToken });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    csrf = login.body.csrf_token;
    const ownerId = login.body.actor.id;
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/i);
    assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/i);
    await t.test('session, CSRF and origin boundaries use the real database', async () => {
      assert.equal((await http('GET', '/api/v1/auth/session')).status, 200);
      assert.equal((await http('POST', '/api/v1/conversations', { title: 'denied' }, { 'x-csrf-token': 'wrong' })).status, 403);
      assert.equal((await http('POST', '/api/v1/conversations', { title: 'denied' }, { origin: 'http://untrusted.invalid' })).status, 403);
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM conversations')).rows[0].count, 0);
    });
    const providerId = randomUUID();
    await db.query("INSERT INTO providers(id,owner_id,name,adapter,endpoint,config) VALUES($1,$2,'local no-contact fixture','ollama','http://provider.invalid',$3::jsonb)", [providerId, ownerId, JSON.stringify({ allowed_addresses: ['127.0.0.1'], allow_private_http: true })]);
    const runContext = { schema_version: 1, provider_id: providerId, provider_config_revision: 1, provider_adapter: 'ollama', provider_endpoint: 'http://provider.invalid', model_id: 'local-no-contact', profile_id: null, profile_revision: null, execution_machine_id: null, execution_identity_id: null, workspace_id: null, workspace_revision: null, environment_id: null, environment_generation: null, project_instruction_revision: null, policy_revision: 1, limits: { max_tool_steps: 2, wall_time_seconds: 10, per_command_timeout_seconds: 2, max_output_bytes: 1024 } };
    await t.test('simultaneous identical submissions persist one job/event/outbox, conflicting payload is denied', async () => {
      const payload = { kind: 'chat', context: runContext, payload: { prompt: 'Do not contact providers in this test' }, idempotency_key: 'local-concurrent-chat' };
      const responses = await Promise.all([http('POST', '/api/v1/jobs', payload), http('POST', '/api/v1/jobs', payload)]);
      for (const response of responses) assert.equal(response.status, 202, JSON.stringify(response.body));
      assert.equal(responses[0].body.id, responses[1].body.id);
      const jobId = responses[0].body.id;
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM job_events WHERE job_id=$1', [jobId])).rows[0].count, 1);
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM dispatch_outbox WHERE job_id=$1', [jobId])).rows[0].count, 1);
      assert.equal((await http('POST', '/api/v1/jobs', { ...payload, payload: { prompt: 'changed' } })).status, 409);
      assert.equal((await http('POST', `/api/v1/jobs/${jobId}/cancel`, {})).body.state, 'cancelled');
      assert.equal((await http('POST', `/api/v1/jobs/${jobId}/cancel`, {})).body.state, 'cancelled');
      const events = (await db!.query('SELECT id::text FROM job_events WHERE job_id=$1 ORDER BY id', [jobId])).rows;
      assert.equal(events.length, 2);
      const streamAbort = new AbortController();
      const stream = await fetch(new URL(`/api/v1/jobs/${jobId}/events`, address), { headers: { cookie, 'last-event-id': events[0].id }, signal: streamAbort.signal });
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      try {
        let retained = '';
        while (!retained.includes(`id: ${events[1].id}\n`)) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          retained += new TextDecoder().decode(chunk.value);
        }
        assert.ok(!retained.includes(`id: ${events[0].id}\n`), 'Replay resumes after persisted cursor');
      } finally { streamAbort.abort(); await reader.cancel().catch(() => undefined); }
      await db!.query("UPDATE providers SET revision=2,endpoint='http://changed-no-contact.invalid' WHERE id=$1", [providerId]);
      const reattached = await http('POST', '/api/v1/jobs', payload);
      assert.equal(reattached.status, 202, JSON.stringify(reattached.body));
      assert.equal(reattached.body.id, jobId);
      assert.equal(reattached.body.context.provider_config_revision, 1);
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM jobs WHERE id=$1', [jobId])).rows[0].count, 1);
    });
    await t.test('missing host file adapter fails explicitly without local filesystem inference', async () => {
      assert.equal((await http('POST', '/api/v1/projects', { canonical_root: artifactRoot })).status, 400, 'Legacy arbitrary local paths are not a valid host binding');
      const machineId = randomUUID();
      await db!.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'unconfigured host binding fixture','linux')", [machineId, ownerId]);
      assert.equal((await http('POST', '/api/v1/projects', { name: 'Unavailable real host binding', machine_id: machineId, host_workspace_id: randomUUID() })).status, 503);
    });
    await t.test('saved action concurrent enqueue is atomic and parameter injection is denied', async () => {
      const machineId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID(), grantId = randomUUID();
      await db!.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'local unconfigured Linux contract fixture','linux')", [machineId, ownerId]);
      await db!.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'local transaction fixture')", [projectId, ownerId]);
      await db!.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path) VALUES($1,$2,$3,'no host access','native',$4,'local-fixture','/not-accessed','/not-accessed')", [workspaceId, ownerId, projectId, machineId]);
      await db!.query("INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids) VALUES($1,$2,'[\"actions.run\",\"run_command\"]',$3::jsonb,$4::jsonb)", [grantId, ownerId, JSON.stringify([machineId]), JSON.stringify([workspaceId])]);
      const definition = { schema_version: 1, machine_ids: [machineId], workspace_ids: [workspaceId], parameters: { label: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$', max_length: 32 } }, command: { executable: '/never-executed/echo', args: [{ parameter: 'label' }], cwd_policy: 'workspace_root' }, limits: {} };
      const created = await http('POST', '/api/v1/actions', { name: 'Local queued action', definition });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const route = `/api/v1/actions/${created.body.id}/runs`;
      const payload = { revision: 1, machine_id: machineId, workspace_id: workspaceId, grant_id: grantId, parameters: { label: 'safe' }, idempotency_key: 'local-action-race' };
      const responses = await Promise.all([http('POST', route, payload), http('POST', route, payload)]);
      for (const response of responses) assert.equal(response.status, 202, JSON.stringify(response.body));
      assert.equal(responses[0].body.id, responses[1].body.id);
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM action_dispatches WHERE action_id=$1', [created.body.id])).rows[0].count, 1);
      assert.equal((await db!.query("SELECT count(*)::int AS count FROM jobs WHERE payload->>'action_id'=$1", [created.body.id])).rows[0].count, 1);
      assert.equal((await http('POST', route, { ...payload, parameters: { label: 'changed' } })).status, 409);
      assert.equal((await http('POST', route, { ...payload, idempotency_key: 'local-injection', parameters: { label: 'x;shutdown' } })).status, 403);
    });
    await t.test('logout revokes persisted session', async () => {
      assert.equal((await http('POST', '/api/v1/auth/logout', {})).status, 200);
      assert.equal((await http('GET', '/api/v1/jobs')).status, 401);
    });
  } finally {
    await app?.close();
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    await rm(artifactRoot, { recursive: true, force: true });
    for (const key of variables) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
