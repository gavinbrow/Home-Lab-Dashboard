import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { AgentBroker, verifyRpc, HostRpcError } from '@homelab/transport';
import { migrate } from '../../apps/api/src/core/migrate.js';

test('actual PostgreSQL signed relay: disabled/restore epochs, machine binding and retry identity', {
  skip: !process.env.HOMELAB_LOCAL_PG_URL ? 'Explicit owned throwaway loopback PostgreSQL required' : false,
  timeout: 30_000
}, async t => {
  const url = new URL(process.env.HOMELAB_LOCAL_PG_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const admin = new pg.Pool({ connectionString: url.href, max: 2 });
  const databaseName = `homelab_transport_${randomUUID().replaceAll('-', '')}`;
  const previousDispatch = process.env.DISPATCH_ENABLED;
  const previousRestore = process.env.RESTORE_MODE;
  let db: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    db = new pg.Pool({ connectionString: url.href, max: 5 });
    await migrate(db);
    const owner = randomUUID(), machine = randomUUID(), otherMachine = randomUUID();
    await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'relay-fixture@example.invalid','not-used-for-auth')", [owner]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$3,'relay-target','unknown'),($2,$3,'other-relay-target','unknown')", [machine, otherMachine, owner]);
    await db.query('UPDATE runtime_control SET dispatch_enabled=true');
    process.env.DISPATCH_ENABLED = 'true';
    const keys = generateKeyPairSync('ed25519');
    const signer = { keyId: 'validation-ephemeral', privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    const broker = new AgentBroker(db, { signer });
    const requestId = randomUUID(), workspaceId = randomUUID();
    const route = `/v1/workspaces/${workspaceId}/files`;
    const body = { path: 'fixture.txt', content_base64: 'Zml4dHVyZQ==', expected_sha256: null };
    await t.test('same RPC identity persists once and different bodies conflict', async () => {
      const ids = await Promise.all([broker.enqueue(machine, 'PUT', route, body, { requestId, ownerId: owner }), broker.enqueue(machine, 'PUT', route, body, { requestId, ownerId: owner })]);
      assert.deepEqual(ids, [requestId, requestId]);
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM agent_rpc_requests WHERE id=$1', [requestId])).rows[0].count, 1);
      await assert.rejects(broker.enqueue(machine, 'PUT', route, { ...body, path: 'changed.txt' }, { requestId }), (error: unknown) => error instanceof HostRpcError && error.statusCode === 409);
    });
    await t.test('disabled mutations do not claim while explicit read-only RPC remains available', async () => {
      process.env.DISPATCH_ENABLED = 'false';
      await db!.query('UPDATE runtime_control SET dispatch_enabled=false');
      await assert.rejects(broker.enqueue(machine, 'PUT', route, body), (error: unknown) => error instanceof HostRpcError && error.code === 'dispatch_disabled');
      const readId = await broker.enqueue(machine, 'GET', '/v1/health');
      const claims = await broker.claim(machine, 8);
      assert.deepEqual(claims.map(claim => claim.id), [readId]);
      assert.equal(verifyRpc(claims[0], signer.keyId, keys.publicKey), true);
      assert.equal(verifyRpc({ ...claims[0], machine_id: otherMachine }, signer.keyId, keys.publicKey), false);
      assert.equal(verifyRpc({ ...claims[0], dispatch_epoch: randomUUID() }, signer.keyId, keys.publicKey), false);
      await broker.respond(machine, readId, 200, { healthy: true });
      assert.deepEqual(await broker.wait(readId, 1000), { healthy: true });
      assert.equal((await db!.query('SELECT delivery_count FROM agent_rpc_requests WHERE id=$1', [requestId])).rows[0].delivery_count, 0);
    });
    await t.test('restore disables all relay claims/results, rotated epoch quarantines historical mutations', async () => {
      const oldRead = await broker.enqueue(machine, 'GET', '/v1/health');
      await db!.query('UPDATE runtime_control SET restore_mode=true');
      assert.deepEqual(await broker.claim(machine, 8), []);
      await assert.rejects(broker.enqueue(machine, 'GET', '/v1/health'));
      await assert.rejects(broker.respond(machine, oldRead, 200, { forbidden: true }));
      process.env.DISPATCH_ENABLED = 'true';
      await db!.query('UPDATE runtime_control SET restore_mode=false,dispatch_enabled=true,dispatch_epoch=gen_random_uuid()');
      assert.deepEqual(await broker.claim(machine, 8), []);
      const historical = (await db!.query('SELECT state,delivery_count FROM agent_rpc_requests WHERE id=$1', [requestId])).rows[0];
      assert.equal(historical.state, 'outcome_unknown');
      assert.equal(historical.delivery_count, 0);
      await assert.rejects(broker.enqueue(machine, 'PUT', route, body, { requestId }), (error: unknown) => error instanceof HostRpcError && error.statusCode === 409);
    });
    await t.test('lease retry preserves signed identity and only its enrolled machine can return an immutable result', async () => {
      const id = await broker.enqueue(machine, 'PUT', route, body, { ownerId: owner });
      const original = (await broker.claim(machine))[0];
      assert.equal(original.id, id);
      await db!.query("UPDATE agent_rpc_requests SET lease_until=now()-interval '1 second' WHERE id=$1", [id]);
      const retry = (await broker.claim(machine))[0];
      assert.deepEqual(retry, original);
      await assert.rejects(broker.respond(otherMachine, id, 200, { sha256: 'fixture' }));
      await broker.respond(machine, id, 200, { result: 'actual host result would be supplied here' });
      await broker.respond(machine, id, 200, { result: 'actual host result would be supplied here' });
      await assert.rejects(broker.respond(machine, id, 200, { result: 'changed' }));
      assert.deepEqual(await broker.wait(id, 1000), { result: 'actual host result would be supplied here' });
    });
    await t.test('cancellation committed before enqueue fences a fresh mutation while exact stop requests can drain', async () => {
      const job = randomUUID();
      await db!.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,kind,payload,state,dispatch_epoch,lease_owner,lease_until,fence,cancel_requested) SELECT $1,$2,'cancel-wins','fixture','validation','{}','cancelling',dispatch_epoch,'validation-jobguard',now()+interval '30 seconds',1,true FROM runtime_control", [job, owner]);
      const guard = { job_id: job, fence: 1, lease_owner: 'validation-jobguard' };
      const denied = randomUUID();
      await assert.rejects(broker.enqueue(machine, 'PUT', route, body, { requestId: denied, jobGuard: guard }), (error: unknown) => error instanceof HostRpcError && error.code === 'worker_fenced');
      assert.equal((await db!.query('SELECT count(*)::int AS count FROM agent_rpc_requests WHERE id=$1', [denied])).rows[0].count, 0);
      process.env.DISPATCH_ENABLED = 'false';
      await db!.query('UPDATE runtime_control SET dispatch_enabled=false,maintenance_mode=true');
      const stop = await broker.enqueue(machine, 'POST', `/v1/operations/${randomUUID()}/cancel`, { fence: 1 }, { safetyCancellation: true, jobGuard: guard });
      assert.deepEqual((await broker.claim(machine)).map(claim => claim.id), [stop]);
      await broker.respond(machine, stop, 200, { state: 'cancelling' });
      await db!.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job]);
      await assert.rejects(broker.enqueue(machine, 'POST', `/v1/operations/${randomUUID()}/cancel`, {}, { safetyCancellation: true, jobGuard: guard }));
      process.env.DISPATCH_ENABLED = 'true';
      await db!.query('UPDATE runtime_control SET dispatch_enabled=true,maintenance_mode=false');
    });
    await t.test('process restore flag independently prevents delivery even before database restore state is set', async () => {
      const id = await broker.enqueue(machine, 'GET', '/v1/health');
      process.env.RESTORE_MODE = 'true';
      assert.deepEqual(await broker.claim(machine), []);
      await assert.rejects(broker.enqueue(machine, 'GET', '/v1/health'));
      await assert.rejects(broker.respond(machine, id, 200, { forbidden: true }));
      assert.equal((await db!.query('SELECT delivery_count FROM agent_rpc_requests WHERE id=$1', [id])).rows[0].delivery_count, 0);
    });
    await t.test('restore permits only explicitly classified bounded read-only reconciliation routes', async () => {
      process.env.RESTORE_MODE = 'true';
      await db!.query('UPDATE runtime_control SET restore_mode=true,dispatch_enabled=false');
      await assert.rejects(broker.enqueue(machine, 'GET', route, null, { recoveryRead: true }));
      await assert.rejects(broker.enqueue(machine, 'POST', '/v1/health', null, { recoveryRead: true }));
      const recovery = await broker.enqueue(machine, 'GET', '/v1/health', null, { recoveryRead: true });
      assert.deepEqual((await broker.claim(machine, 8)).map(claim => claim.id), [recovery]);
      await broker.respond(machine, recovery, 200, { machine_id: machine });
      assert.deepEqual(await broker.wait(recovery, 1000), { machine_id: machine });
    });
  } finally {
    if (previousDispatch === undefined) delete process.env.DISPATCH_ENABLED; else process.env.DISPATCH_ENABLED = previousDispatch;
    if (previousRestore === undefined) delete process.env.RESTORE_MODE; else process.env.RESTORE_MODE = previousRestore;
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});
