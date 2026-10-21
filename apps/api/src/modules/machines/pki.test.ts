import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash, webcrypto, X509Certificate, generateKeyPairSync } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { Pool } from 'pg';
import Fastify from 'fastify';
import * as x509 from '@peculiar/x509';
import { AgentBroker, type RpcOptions } from '@homelab/transport';
import { generateLocalPki, loadAuthority } from './pki.js';
import { createAgentServer } from './agent-server.js';
import { migrate } from '../../core/migrate.js';
import type { ApiContext } from '../../core/context.js';
import { createCapabilityTestHandler } from './capability-jobs.js';
import { maintainTelemetry } from './retention.js';
import registerBrowser from './index.js';

async function csr() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const request = await x509.Pkcs10CertificateRequestGenerator.create({ name: 'CN=untrusted-subject', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, extensions: [new x509.BasicConstraintsExtension(true)] });
  const key = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
  return { csr_pem: request.toString('pem'), key };
}

test('CA validates proof of possession and replaces CSR identity and CA privileges', async () => {
  const pki = await generateLocalPki();
  const authority = await loadAuthority(pki.ca_pem, pki.ca_key_pem);
  const request = await csr(), machine = randomUUID();
  const certificate = new X509Certificate((await authority.issue(request.csr_pem, machine)).certificate_pem);
  assert.equal(certificate.ca, false);
  assert.match(certificate.subject, new RegExp(machine));
  assert.equal(certificate.subjectAltName, `URI:urn:homelab:machine:${machine}`);
  assert.equal(certificate.verify(new X509Certificate(pki.ca_pem).publicKey), true);
  await assert.rejects(authority.issue(request.csr_pem, 'CN=attacker'));
  const der = Buffer.from(request.csr_pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  der[der.length - 1] = der[der.length - 1]! ^ 1;
  const broken = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----`;
  assert.notEqual(broken, request.csr_pem);
  await assert.rejects(authority.issue(broken, machine));
});

test('issuer preserves external CA ASN.1 name encoding for Go chain verification', async () => {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  // OpenSSL commonly emits UTF8String; parsing/recreating a DN string can choose PrintableString.
  const name = new x509.Name([{ CN: [{ utf8String: 'External Agent CA' }] }]);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({ name, keys, notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 86400000), signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)] });
  assert.notDeepEqual(Buffer.from(ca.subjectName.toArrayBuffer()), Buffer.from(new x509.Name(ca.subject).toArrayBuffer()));
  const key = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
  const authority = await loadAuthority(ca.toString('pem'), key);
  const issued = await authority.issue((await csr()).csr_pem, randomUUID());
  const leaf = new x509.X509Certificate(issued.certificate_pem);
  assert.deepEqual(Buffer.from(leaf.issuerName.toArrayBuffer()), Buffer.from(ca.subjectName.toArrayBuffer()));
});

test('real loopback TLS + isolated PostgreSQL enrollment, dedup, rotation, revocation and RPC', { skip: !process.env.MACHINE_TEST_DATABASE_URL, timeout: 60000 }, async () => {
  const base = new URL(process.env.MACHINE_TEST_DATABASE_URL!);
  const admin = new Pool({ connectionString: base.href });
  const database = 'machine_tls_' + randomBytes(8).toString('hex');
  await admin.query(`CREATE DATABASE ${database}`);
  base.pathname = '/' + database;
  const db = new Pool({ connectionString: base.href });
  const pki = await generateLocalPki();
  const authority = await loadAuthority(pki.ca_pem, pki.ca_key_pem);
  const signer = { keyId: 'loopback-component-test', privateKeyPem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const broker = new AgentBroker(db, { signer });
  const context = { db, agentBroker: broker, audit: async () => {} } as unknown as ApiContext;
  const app = createAgentServer(context, { key: pki.server_key_pem, cert: pki.server_pem, ca: pki.ca_pem, authority });
  try {
    await migrate(db);
    const owner = randomUUID(), machine = randomUUID(), other = randomUUID();
    await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'machine-component@example.invalid','unused-test-password-hash')", [owner]);
    await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'Loopback component fixture','linux'),($3,$2,'Other fixture','linux')", [machine, owner, other]);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };
    const send = (path: string, body: unknown, identity?: { certificate_pem: string; key: string }, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = httpsRequest({ hostname: '127.0.0.1', port: address.port, path: '/agent/v1/' + path, method: 'POST', ca: pki.ca_pem, cert: identity?.certificate_pem, key: identity?.key, headers: { 'Content-Type': 'application/json', ...headers } }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) })); });
      request.on('error', reject); request.end(JSON.stringify(body));
    });
    assert.equal((await send('poll', {}, undefined, { 'x-client-cert-verified': 'SUCCESS' })).status, 401);
    const request = await csr();
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO agent_enrollments(id,machine_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [randomUUID(), machine, createHash('sha256').update(token).digest('hex')]);
    const attempts = await Promise.all([send('enroll', { token, csr_pem: request.csr_pem, protocol_version: 1 }), send('enroll', { token, csr_pem: request.csr_pem, protocol_version: 1 })]);
    assert.deepEqual(attempts.map(x => x.status).sort(), [200, 401]);
    const issued = attempts.find(x => x.status === 200)!.body;
    assert.equal(issued.machine_id, machine);
    assert.equal(issued.machine_identity_generation, (await db.query('SELECT identity_generation FROM machines WHERE id=$1', [machine])).rows[0].identity_generation);
    assert.equal(issued.dispatch_key.key_id, signer.keyId);
    const enqueue = (path: string, options: RpcOptions = {}) => broker.enqueue(machine, 'GET', path, null, { expectedMachineGeneration: issued.machine_identity_generation, ...options });
    const identity = { certificate_pem: issued.certificate_pem, key: request.key };
    assert.equal((await send('enroll', { token, csr_pem: request.csr_pem, protocol_version: 1 })).status, 401);
    const foreignPki = await generateLocalPki();
    const foreign = await (await loadAuthority(foreignPki.ca_pem, foreignPki.ca_key_pem)).issue(request.csr_pem, machine);
    assert.equal((await send('poll', {}, { certificate_pem: foreign.certificate_pem, key: request.key })).status, 401);
    const stamp = (n: number) => new Date(Date.now() - (4 - n) * 1000).toISOString();
    const sample = (n: number) => ({ schema_version: 1, machine_id: machine, boot_id: 'loopback-test-boot', sequence: n, collection_interval_seconds: n === 1 ? null : 1, observed_at: stamp(n), inventory: { hostname: 'component-only', os: 'linux', platform: 'component-test', platform_version: '1', architecture: 'test', logical_cores: 1, agent_version: 'test', memory_definition: 'test fixture' }, metrics: [{ name: 'cpu_utilization', device_id: 'host', value: 10, unit: 'percent', availability: 'available', reason: null, source: 'component-test', kind: 'gauge', observed_at: stamp(n) }] });
    const first = sample(1);
    assert.equal((await send('telemetry', first, identity)).status, 200);
    assert.equal((await send('telemetry', first, identity)).body.duplicate, true);
    assert.equal((await send('telemetry', { ...first, metrics: [{ ...first.metrics[0], value: 99 }] }, identity)).status, 409);
    assert.equal((await send('telemetry', { ...first, machine_id: other }, identity)).status, 403);
    for (const n of [2, 3]) assert.equal((await send('telemetry', sample(n), identity)).status, 200);
    const ordinaryRead = await enqueue('/v1/health');
    await db.query('UPDATE runtime_control SET restore_mode=true');
    assert.equal((await send('telemetry', sample(4), identity)).status, 503);
    await assert.rejects(enqueue('/v1/identities'));
    const recoveryRead = await enqueue('/v1/health', { recoveryRead: true });
    const recovering = await send('poll', { schema_version: 1, machine_id: machine, boot_id: 'loopback-test-boot', max_requests: 1 }, identity);
    assert.equal(recovering.status, 200);
    assert.deepEqual(recovering.body.requests.map((request: { id: string }) => request.id), [recoveryRead]);
    assert.equal((await send('results', { schema_version: 1, machine_id: machine, id: ordinaryRead, status: 200, body: {} }, identity)).status, 409);
    assert.equal((await send('results', { schema_version: 1, machine_id: machine, id: recoveryRead, status: 200, body: { reconciled: true } }, identity)).status, 200);
    assert.deepEqual(await broker.wait(recoveryRead, 1000), { reconciled: true });
    // Remove the deliberately undelivered ordinary read so later normal polling is deterministic.
    await db.query("UPDATE agent_rpc_requests SET state='expired' WHERE id=$1", [ordinaryRead]);
    await db.query('UPDATE runtime_control SET restore_mode=false');
    assert.equal(Number((await db.query('SELECT count(*) FROM metric_samples WHERE machine_id=$1', [machine])).rows[0].count), 3);
    const testId = randomUUID();
    await db.query("INSERT INTO capability_tests(id,owner_id,machine_id,capability,state)VALUES($1,$2,$3,'monitoring','queued')", [testId, owner, machine]);
    await db.query('UPDATE runtime_control SET dispatch_enabled=true');
    const leasedJob = async (id: string, payload: Record<string, unknown> = { machine_id: machine, test: 'monitoring' }) => {
      const generation = (await db.query('SELECT identity_generation FROM machines WHERE id=$1', [machine])).rows[0].identity_generation;
      return (await db.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,context,kind,payload,state,dispatch_epoch,lease_owner,lease_until,fence)SELECT $1::uuid,$2::uuid,($1::uuid)::text,'component-fixture','null'::jsonb,'capability_test',$3::jsonb,'running',dispatch_epoch,'machine-test',now()+interval '5 minutes',1 FROM runtime_control RETURNING *", [id, owner, JSON.stringify({ machine_identity_generations: { [machine]: generation }, ...payload })])).rows[0];
    };
    let result: any;
    await createCapabilityTestHandler({ broker })(await leasedJob(testId), { db, cancelled: async () => false, assertLease: async () => {}, appendEvent: async () => {}, complete: async (value: unknown) => { result = value; } } as any);
    assert.equal(result.health_state, 'healthy');
    const staleGenerationTest = randomUUID();
    await db.query("INSERT INTO capability_tests(id,owner_id,machine_id,capability,state)VALUES($1,$2,$3,'monitoring','queued')", [staleGenerationTest, owner, machine]);
    await createCapabilityTestHandler({ broker })(await leasedJob(staleGenerationTest, { machine_id: machine, test: 'monitoring', machine_identity_generations: { [machine]: randomUUID() } }), { db, cancelled: async () => false, assertLease: async () => {}, complete: async (value: unknown) => { result = value; } } as any);
    assert.equal(result.health_state, 'unverified', 'A prepared test must not adopt a replacement installation generation');
    const rpc = await enqueue('/v1/health');
    const polled = await send('poll', { schema_version: 1, machine_id: machine, boot_id: 'loopback-test-boot', max_requests: 1 }, identity);
    assert.equal(polled.body.requests[0].id, rpc);
    assert.equal((await send('results', { schema_version: 1, machine_id: machine, id: rpc, status: 200, body: { machine_id: machine } }, identity)).status, 200);
    assert.deepEqual(await broker.wait(rpc, 1000), { machine_id: machine });
    const replacement = await csr();
    const rotated = await send('rotate', { csr_pem: replacement.csr_pem, protocol_version: 1 }, identity);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.machine_identity_generation, issued.machine_identity_generation);
    assert.equal((await send('poll', {}, identity)).status, 403);
    await assert.rejects(broker.claim(machine, 1, issued.serial), /no longer authorized/);
    await assert.rejects(broker.respond(machine, rpc, 200, { machine_id: machine }, issued.serial), /no longer authorized/);
    const newIdentity = { certificate_pem: rotated.body.certificate_pem, key: replacement.key };
    assert.equal((await send('poll', { schema_version: 1, machine_id: machine, boot_id: 'loopback-test-boot', max_requests: 1 }, newIdentity)).status, 200);
    // Fault injection covers a dishonest/wrong identity result; it is not a real host execution claim.
    const executionIdentity = randomUUID(), workspace = randomUUID(), runnerTest = randomUUID();
    await db.query("INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity,restriction_verified,config)VALUES($1,$2,$3,'Fault-injection identity','1000:2000',true,$4::jsonb)", [executionIdentity, owner, machine, JSON.stringify({ workspace_ids: [workspace] })]);
    await db.query("INSERT INTO capability_tests(id,owner_id,machine_id,capability,state)VALUES($1,$2,$3,'runner','queued')", [runnerTest, owner, machine]);
    const runner = await leasedJob(runnerTest, { machine_id: machine, test: 'runner', configured_identity: '1000:2000', execution_context: { execution_machine_id: machine, execution_identity_id: executionIdentity, workspace_id: workspace, environment_id: null }, grant: {} });
    await createCapabilityTestHandler({ broker, operations: { executeCommand: async () => ({ state: 'known', status: 'succeeded', exit_code: 0, output: '0\n', operation_id: randomUUID() }) } as any })(runner, { db, cancelled: async () => false, assertLease: async () => {}, complete: async (value: unknown) => { result = value; } } as any);
    assert.equal(result.health_state, 'permission_denied');
    assert.equal((await db.query('SELECT restriction_verified FROM execution_identities WHERE id=$1', [executionIdentity])).rows[0].restriction_verified, false);
    const staleTest = randomUUID();
    await db.query("INSERT INTO capability_tests(id,owner_id,machine_id,capability,state)VALUES($1,$2,$3,'monitoring','queued')", [staleTest, owner, machine]);
    const staleJob = await leasedJob(staleTest);
    await db.query('UPDATE jobs SET fence=fence+1 WHERE id=$1', [staleTest]);
    await assert.rejects(createCapabilityTestHandler({ broker })(staleJob, { db, cancelled: async () => false, assertLease: async () => {}, complete: async () => assert.fail('Lost fence must not complete') } as any), /lease lost/i);
    assert.equal((await db.query('SELECT completed_at FROM capability_tests WHERE id=$1', [staleTest])).rows[0].completed_at, null);
    const racingTest = randomUUID();
    await db.query("INSERT INTO capability_tests(id,owner_id,machine_id,capability,state)VALUES($1,$2,$3,'monitoring','queued')", [racingTest, owner, machine]);
    let checks = 0;
    await createCapabilityTestHandler({ broker })(await leasedJob(racingTest), { db, cancelled: async () => false, assertLease: async () => { if (++checks === 2) await db.query('UPDATE agent_certificates SET revoked_at=now() WHERE serial=$1', [rotated.body.serial]); }, complete: async (value: unknown) => { result = value; } } as any);
    assert.equal(result.health_state, 'permission_denied', 'A certificate revoked between collection and commit cannot promote healthy');
    const control = Fastify();
    control.addHook('preHandler', async request => { request.actor = { id: owner, role: 'owner' }; });
    await registerBrowser(control, context);
    try {
      const ssh = { supported: true, configured: true, permitted: true, health_state: 'healthy', observed_at: new Date().toISOString(), last_test_at: null, last_success_at: null, reason: null };
      await db.query("UPDATE machines SET capabilities=jsonb_set(capabilities,'{ssh}',$2::jsonb) WHERE id=$1", [machine, JSON.stringify(ssh)]);
      const certificateId = (await db.query('SELECT id FROM agent_certificates WHERE serial=$1', [rotated.body.serial])).rows[0].id;
      assert.equal((await control.inject({ method: 'POST', url: `/machines/${machine}/certificates/${certificateId}/revoke` })).statusCode, 200);
      const state = (await control.inject({ url: `/machines/${machine}` })).json();
      assert.equal(state.capabilities.monitoring.health_state, 'permission_denied');
      assert.equal(state.capabilities.ssh.health_state, 'healthy');
      const recheck = randomUUID();
      await db.query("INSERT INTO capability_tests(id,owner_id,machine_id,capability,state)VALUES($1,$2,$3,'monitoring','queued')", [recheck, owner, machine]);
      await createCapabilityTestHandler({ broker })(await leasedJob(recheck), { db, cancelled: async () => false, assertLease: async () => {}, appendEvent: async () => {}, complete: async (value: unknown) => { result = value; } } as any);
      assert.equal(result.health_state, 'permission_denied', 'Fresh historic samples cannot override revoked transport identity');
    } finally { await control.close(); }
    assert.equal((await send('poll', {}, newIdentity)).status, 403);
    // Re-enrollment is a new installation: queued authority and identity proofs cannot transfer.
    await db.query('UPDATE execution_identities SET restriction_verified=true WHERE id=$1', [executionIdentity]);
    const deliveredBeforeReplacement = await enqueue('/v1/health');
    assert.equal((await broker.claim(machine, 1))[0]!.id, deliveredBeforeReplacement);
    const queuedBeforeReplacement = await enqueue('/v1/health');
    const nextToken = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO agent_enrollments(id,machine_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [randomUUID(), machine, createHash('sha256').update(nextToken).digest('hex')]);
    const nextCsr = await csr();
    const reenrolled = await send('enroll', { token: nextToken, csr_pem: nextCsr.csr_pem, protocol_version: 1 });
    assert.equal(reenrolled.status, 200);
    assert.notEqual(reenrolled.body.machine_identity_generation, issued.machine_identity_generation);
    await assert.rejects(enqueue('/v1/health'), /installation changed/);
    assert.equal((await db.query('SELECT restriction_verified FROM execution_identities WHERE id=$1', [executionIdentity])).rows[0].restriction_verified, false);
    const quarantined = (await db.query('SELECT id,state FROM agent_rpc_requests WHERE id=ANY($1::uuid[])', [[deliveredBeforeReplacement, queuedBeforeReplacement]])).rows;
    assert.equal(quarantined.find(row => row.id === deliveredBeforeReplacement).state, 'outcome_unknown');
    assert.equal(quarantined.find(row => row.id === queuedBeforeReplacement).state, 'expired');
    const nextIdentity = { certificate_pem: reenrolled.body.certificate_pem, key: nextCsr.key };
    assert.deepEqual((await send('poll', { schema_version: 1, machine_id: machine, boot_id: 'new-installation', max_requests: 1 }, nextIdentity)).body.requests, []);
    assert.equal((await send('telemetry', sample(4), newIdentity)).status, 403);
    // Revoke after native onRequest authentication but before the broker transaction.
    const originalClaim = broker.claim.bind(broker);
    broker.claim = async (machineId, max, serial) => {
      assert.equal(serial, reenrolled.body.serial, 'Native transport must propagate the authenticated certificate');
      await db.query('UPDATE agent_certificates SET revoked_at=now() WHERE serial=$1', [serial]);
      return originalClaim(machineId, max, serial);
    };
    try {
      assert.equal((await send('poll', { schema_version: 1, machine_id: machine, boot_id: 'new-installation', max_requests: 1 }, nextIdentity)).status, 403);
    } finally { broker.claim = originalClaim; }
    // Multiple tiny retention batches must merge exactly once while preserving missing observations.
    const old = Math.floor((Date.now() - 8 * 86400000) / 300000) * 300000 + 10000;
    for (const [index, value] of [10, null, 30].entries()) await db.query("INSERT INTO metric_samples(machine_id,boot_id,sequence,series,device_id,value,unit,availability,reason,source,observed_at)VALUES($1,'retention-boot',$2,'cpu_utilization','host',$3,'percent',$4,$5,'retention-fixture',$6)", [machine, index + 1, value, value === null ? 'unavailable' : 'available', value === null ? 'sensor_unavailable' : null, new Date(old + index * 1000)]);
    assert.equal((await maintainTelemetry(db, { batch_size: 1 })).raw_deleted, 1);
    assert.equal((await maintainTelemetry(db, { batch_size: 1 })).raw_deleted, 1);
    assert.equal((await maintainTelemetry(db, { batch_size: 1 })).raw_deleted, 1);
    assert.equal((await maintainTelemetry(db, { batch_size: 1 })).raw_deleted, 0);
    const rolled = (await db.query("SELECT * FROM metric_rollups WHERE machine_id=$1 AND boot_id='retention-boot' ORDER BY resolution", [machine])).rows;
    assert.equal(rolled.length, 2);
    for (const row of rolled) { assert.equal(row.min, 10); assert.equal(row.max, 30); assert.equal(row.mean, 20); assert.equal(row.count, 2); assert.equal(row.missing_count, 1); assert.equal(row.unit, 'percent'); assert.equal(row.source, 'retention-fixture'); }
    assert.equal(Number((await db.query('SELECT count(*) FROM metric_samples WHERE machine_id=$1', [machine])).rows[0].count), 3);
    const browser = Fastify();
    browser.addHook('preHandler', async request => { request.actor = { id: owner, role: 'owner' }; });
    await registerBrowser(browser, context);
    try {
      const history = await browser.inject({ url: `/machines/${machine}/metrics?from=${new Date(old).toISOString()}&to=${new Date(old + 4000).toISOString()}&resolution=5m` });
      assert.equal(history.statusCode, 200);
      assert.equal(history.json().items[0].mean, 20);
      assert.equal(history.json().items[0].count, 2);
      assert.equal(history.json().items[0].missing, 1);
      assert.equal(history.json().truncated, false);
      const recentBucket = Math.floor(Date.now() / 300000) * 300000;
      const lateReceipt = new Date(recentBucket + 9000);
      for (const [sequence, observedOffset, receivedOffset] of [[1, 1000, 9000], [2, 2000, 3000]]) await db.query("INSERT INTO metric_samples(machine_id,boot_id,sequence,series,device_id,value,unit,availability,source,observed_at,received_at) VALUES($1,'delayed-receipt',$2,'delay_fixture','host',1,'count','available','fixture',$3,$4)", [machine, sequence, new Date(recentBucket + observedOffset!), new Date(recentBucket + receivedOffset!)]);
      const delayed = await browser.inject({ url: `/machines/${machine}/metrics?from=${new Date(recentBucket).toISOString()}&to=${new Date(recentBucket + 10000).toISOString()}&resolution=5m` });
      const delayedSeries = delayed.json().items.find((row: { series: string }) => row.series === 'delay_fixture');
      assert.equal(delayedSeries.received_at, lateReceipt.toISOString(), 'Latest receipt is independent of observation order');
    } finally { await browser.close(); }
  } finally { await app.close(); await db.end(); await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end(); }
});


