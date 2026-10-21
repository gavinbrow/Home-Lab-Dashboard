import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Workspace } from '@homelab/contracts';
import { AgentBroker } from '@homelab/transport';
import { migrate } from '../../../apps/api/src/core/migrate.js';
import { releaseUndispatchedWriter, withWorkspaceWriter } from '../src/index.js';

function barrier<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('actual PostgreSQL: paused API writer cannot enqueue after reconciliation replaces its reservation', { skip: !process.env.HOMELAB_LOCAL_PG_URL ? 'Explicit owned loopback PostgreSQL required' : false, timeout: 30000 }, async t => {
  const url = new URL(process.env.HOMELAB_LOCAL_PG_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const admin = new pg.Pool({ connectionString: url.href });
  const database = `homelab_storage_race_${randomUUID().replaceAll('-', '')}`;
  const previousDispatch = process.env.DISPATCH_ENABLED, previousRestore = process.env.RESTORE_MODE;
  let db: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    url.pathname = `/${database}`;
    db = new pg.Pool({ connectionString: url.href, max: 8 });
    await migrate(db);
    const owner = randomUUID(), machine = randomUUID(), project = randomUUID(), workspaceId = randomUUID();
    await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [owner, 'storage-race@example.invalid', 'unused']);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'race-machine','unknown')", [machine, owner]);
    await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'race-project')", [project, owner]);
    await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path) VALUES($1,$2,$3,'race-workspace','native',$4,'approved','/approved','/approved')", [workspaceId, owner, project, machine]);
    const ws = (await db.query('SELECT * FROM workspaces WHERE id=$1', [workspaceId])).rows[0] as Workspace;
    await db.query('UPDATE runtime_control SET dispatch_enabled=true');
    process.env.DISPATCH_ENABLED = 'true'; process.env.RESTORE_MODE = 'false';
    const keys = generateKeyPairSync('ed25519');
    const broker = new AgentBroker(db, { signer: { keyId: 'race-test', privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() } });
    const path = `/v1/workspaces/${ws.id}/files`;
    await t.test('reconcile wins before original enqueue; resumed original is fenced and replacement stays held', async () => {
      const operationId = randomUUID();
      const entered = barrier<{ operation_id: string; lock_owner: string }>(), resume = barrier();
      const original = withWorkspaceWriter(db!, ws, owner, 'file.write', async mutation => {
        entered.resolve(mutation); await resume.promise;
        await broker.enqueue(machine, 'PUT', path, { operation_id: operationId, path: 'original', content_base64: 'eA==', expected_sha256: null }, { requestId: operationId, workspaceGuard: { workspace_id: ws.id, lock_owner: mutation.lock_owner, workspace_revision: ws.revision } });
      }, { operationId }).then(() => null, error => error as { code: string });
      const mutation = await entered.promise;
      const released = await releaseUndispatchedWriter(db!, { workspace: ws, owner, lockOwner: mutation.lock_owner, operationId, writerFencing: true });
      assert.equal(released.released, true);
      const replacementEntered = barrier<string>(), replacementResume = barrier();
      const replacement = withWorkspaceWriter(db!, ws, owner, 'file.write', async next => { replacementEntered.resolve(next.lock_owner); await replacementResume.promise; });
      const replacementOwner = await replacementEntered.promise;
      resume.resolve();
      assert.equal((await original)?.code, 'writer_fenced');
      assert.equal((await db!.query('SELECT lock_owner FROM workspace_locks WHERE workspace_id=$1', [ws.id])).rows[0].lock_owner, replacementOwner);
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM agent_rpc_requests WHERE id=$1', [operationId])).rows[0].count, 0);
      replacementResume.resolve(); await replacement;
    });
    await t.test('enqueue wins; reconciliation observes RPC and retains original writer against replacement', async () => {
      const operationId = randomUUID();
      const enqueued = barrier<{ operation_id: string; lock_owner: string }>(), resume = barrier();
      const original = withWorkspaceWriter(db!, ws, owner, 'file.write', async mutation => {
        await broker.enqueue(machine, 'PUT', path, { operation_id: operationId, path: 'accepted', content_base64: 'eA==', expected_sha256: null }, { requestId: operationId, workspaceGuard: { workspace_id: ws.id, lock_owner: mutation.lock_owner, workspace_revision: ws.revision } });
        enqueued.resolve(mutation); await resume.promise;
        return broker.wait(operationId, 1000);
      }, { operationId });
      const mutation = await enqueued.promise;
      const released = await releaseUndispatchedWriter(db!, { workspace: ws, owner, lockOwner: mutation.lock_owner, operationId, writerFencing: true });
      assert.deepEqual(released, { released: false, rpc_id: operationId });
      await assert.rejects(withWorkspaceWriter(db!, ws, owner, 'file.write', async () => undefined), error => (error as { code: string }).code === 'workspace_locked');
      assert.equal((await db!.query('SELECT rpc_id FROM workspace_locks WHERE workspace_id=$1', [ws.id])).rows[0].rpc_id, operationId);
      assert.equal((await broker.claim(machine))[0].id, operationId);
      await broker.respond(machine, operationId, 200, { operation_id: operationId, state: 'completed', result: { size_bytes: 1 } });
      resume.resolve(); await original;
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM workspace_locks WHERE workspace_id=$1', [ws.id])).rows[0].count, 0);
    });
  } finally {
    if (previousDispatch === undefined) delete process.env.DISPATCH_ENABLED; else process.env.DISPATCH_ENABLED = previousDispatch;
    if (previousRestore === undefined) delete process.env.RESTORE_MODE; else process.env.RESTORE_MODE = previousRestore;
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
