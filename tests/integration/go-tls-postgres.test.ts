import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes, createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import * as x509 from '@peculiar/x509';
import { AgentBroker } from '@homelab/transport';
import { migrate } from '../../apps/api/src/core/migrate.js';
import { generateLocalPki, loadAuthority } from '../../apps/api/src/modules/machines/pki.js';
import { createAgentServer } from '../../apps/api/src/modules/machines/agent-server.js';
import type { ApiContext } from '../../apps/api/src/core/context.js';

test('actual Go + native TLS + PostgreSQL: enrolled collector, durable sequence and certificate revocation', {
  skip: !(process.env.HOMELAB_LOCAL_PG_URL && process.env.HOMELAB_AGENT_EXE) ? 'Explicit disposable PostgreSQL and built Go executable required' : false,
  timeout: 40_000
}, async t => {
  const url = new URL(process.env.HOMELAB_LOCAL_PG_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const admin = new pg.Pool({ connectionString: url.href, max: 2 });
  const databaseName = `homelab_go_tls_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'homelab-go-tls-'));
  let db: pg.Pool | undefined;
  let server: ReturnType<typeof createAgentServer> | undefined;
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (child && child.exitCode === null) {
      const stopped = new Promise<void>(done => child!.once('exit', () => done()));
      child.kill(); await stopped;
    }
    child = undefined;
  };
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    db = new pg.Pool({ connectionString: url.href, max: 5 });
    await migrate(db);
    const owner = randomUUID(), machine = randomUUID();
    await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,'go-tls@example.invalid','unused-test-auth')", [owner]);
    await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'Actual local Go collector','unknown')", [machine, owner]);
    const pki = await generateLocalPki();
    const authority = await loadAuthority(pki.ca_pem, pki.ca_key_pem);
    const signing = generateKeyPairSync('ed25519');
    const broker = new AgentBroker(db, { signer: { keyId: 'go-tls-component', privateKeyPem: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
    server = createAgentServer({ db, agentBroker: broker, audit: async () => {} } as unknown as ApiContext, { key: pki.server_key_pem, cert: pki.server_pem, ca: pki.ca_pem, authority });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as { port: number }).port;
    const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: 'CN=untrusted-local-request', keys: keyPair, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } });
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO agent_enrollments(id,machine_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')", [randomUUID(), machine, createHash('sha256').update(token).digest('hex')]);
    const enrolled = await new Promise<{ status: number; body: any }>((done, reject) => {
      const request = httpsRequest({ hostname: '127.0.0.1', port, path: '/agent/v1/enroll', method: 'POST', ca: pki.ca_pem, headers: { 'content-type': 'application/json' } }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', bytes => { body += bytes; }); response.on('end', () => done({ status: response.statusCode!, body: JSON.parse(body) })); });
      request.on('error', reject); request.end(JSON.stringify({ token, csr_pem: csr.toString('pem'), protocol_version: 1 }));
    });
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.body.machine_id, machine);
    const paths = { ca: join(directory, 'ca.pem'), cert: join(directory, 'machine.pem'), key: join(directory, 'machine-key.pem'), data: join(directory, 'sequence') };
    await mkdir(paths.data);
    await Promise.all([writeFile(paths.ca, pki.ca_pem), writeFile(paths.cert, enrolled.body.certificate_pem), writeFile(paths.key, privateKey, { mode: 0o600 })]);
    let failures = '';
    const start = () => {
      child = spawn(resolve(process.env.HOMELAB_AGENT_EXE!), ['agent', '--machine-id', machine, '--endpoint', `https://127.0.0.1:${port}/agent/v1/telemetry`, '--ca', paths.ca, '--cert', paths.cert, '--key', paths.key, '--data-dir', paths.data, '--interval', '1s'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      child.stderr!.on('data', bytes => { failures = (failures + String(bytes)).slice(-4096); });
    };
    const counts = async () => (await db!.query('SELECT count(*)::int AS batches,coalesce(max(sequence),0)::int AS last FROM agent_telemetry_batches WHERE machine_id=$1', [machine])).rows[0] as { batches: number; last: number };
    const waitFor = async (condition: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt++) { if (await condition()) return; if (child?.exitCode !== null) throw new Error(`Actual Go agent stopped: ${failures}`); await delay(100); }
      throw new Error(`Actual Go telemetry did not reach PostgreSQL: ${failures}`);
    };
    await t.test('actual Go samples authenticate using enrolled certificate and preserve unavailable values', async () => {
      start();
      await waitFor(async () => (await counts()).batches >= 3);
      assert.ok((await db!.query('SELECT count(*)::int AS count FROM metric_samples WHERE machine_id=$1', [machine])).rows[0].count > 0);
      assert.equal((await db!.query("SELECT count(*)::int AS count FROM metric_samples WHERE machine_id=$1 AND availability='unavailable' AND value IS NOT NULL", [machine])).rows[0].count, 0);
      const actual = (await db!.query('SELECT os,boot_id,last_seen_at FROM machines WHERE id=$1', [machine])).rows[0];
      assert.ok(['windows', 'linux'].includes(actual.os));
      assert.ok(actual.boot_id && actual.last_seen_at);
    });
    await t.test('restarting only the Go connection process advances its durable sequence', async () => {
      await stop();
      const before = await counts();
      start();
      await waitFor(async () => (await counts()).last > before.last);
      assert.ok((await counts()).batches > before.batches);
    });
    await t.test('revoked certificate stops further actual Go ingestion', async () => {
      await db!.query('UPDATE agent_certificates SET revoked_at=now() WHERE machine_id=$1', [machine]);
      await delay(1200);
      const rejected = await counts();
      await delay(1200);
      assert.deepEqual(await counts(), rejected);
      assert.match(failures, /agent_endpoint_status_403/);
    });
  } finally {
    await stop(); await server?.close(); await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
