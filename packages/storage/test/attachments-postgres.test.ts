import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize } from '@homelab/policy';
import { migrate } from '../../../apps/api/src/core/migrate.js';
import { registerAttachments } from '../../../apps/api/src/modules/projects/attachments.js';
import type { ApiContext } from '../../../apps/api/src/core/context.js';
import { BlobStore, sha256 } from '../src/index.js';

test('actual PostgreSQL attachment routes retain immutable bytes and reject quota before blob publication', { skip: !process.env.HOMELAB_LOCAL_PG_URL ? 'Explicit owned loopback PostgreSQL required' : false, timeout: 30000 }, async () => {
  const url = new URL(process.env.HOMELAB_LOCAL_PG_URL!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const admin = new pg.Pool({ connectionString: url.href });
  const name = `homelab_attachments_${randomUUID().replaceAll('-', '')}`;
  const root = await mkdtemp(join(tmpdir(), 'homelab-attachments-'));
  let db: pg.Pool | undefined;
  const app = Fastify();
  try {
    await admin.query(`CREATE DATABASE "${name}"`); url.pathname = `/${name}`;
    db = new pg.Pool({ connectionString: url.href,max:1 }); await migrate(db);
    const owner = randomUUID(), otherOwner = randomUUID();
    await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3)', [owner, 'attachment-owner@example.invalid', 'unused', otherOwner, 'attachment-other@example.invalid']);
    let actor = owner;
    app.decorateRequest('actor', null);
    app.addHook('preHandler', async request => { request.actor = { id: actor, role: 'owner' }; });
    const context: ApiContext = { db, policy: authorize, secrets: { put: async () => { throw new Error('unused'); }, get: async () => { throw new Error('unused'); } }, config: { artifactRoot: root, origin: 'http://127.0.0.1', cookieSecure: false, dispatchEnabled: false, restoreMode: false }, audit: async (actorId, action, target, outcome, details) => { await db!.query('INSERT INTO audit_events(actor_id,action,target,outcome,details) VALUES($1,$2,$3,$4,$5::jsonb)', [actorId, action, target, outcome, JSON.stringify(details ?? {})]); } };
    await registerAttachments(app, context, new BlobStore(root));
    const bytes = Buffer.from('<svg onload="unsafe()"/>');
    const uploaded = await app.inject({ method: 'POST', url: '/attachments', payload: { filename: 'diagram.svg', content_base64: bytes.toString('base64') } });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const attachment = uploaded.json();
    assert.equal(attachment.mime_type, 'text/plain');
    assert.equal(attachment.sha256, sha256(bytes));
    const download = await app.inject({ method: 'GET', url: `/attachments/${attachment.id}/download` });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, bytes);
    assert.equal(download.headers['content-type'], 'application/octet-stream');
    assert.match(String(download.headers['content-disposition']), /^attachment;/);
    actor = otherOwner;
    assert.equal((await app.inject({ method: 'GET', url: `/attachments/${attachment.id}/download` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `/attachments/${attachment.id}` })).statusCode, 404);
    actor = owner;
    assert.equal((await app.inject({ method: 'DELETE', url: `/attachments/${attachment.id}` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/attachments/${attachment.id}/download` })).statusCode, 404);
    assert.deepEqual(await new BlobStore(root).get(attachment.sha256), bytes);
    // Retained tombstones remain counted. No 512 MiB allocation is needed to test metadata quota.
    await db.query('UPDATE attachments SET size_bytes=$2 WHERE id=$1', [attachment.id, 512 * 1024 * 1024]);
    const rejectedBytes = Buffer.from('must never be published');
    const rejectedHash = sha256(rejectedBytes);
    const rejected = await app.inject({ method: 'POST', url: '/attachments', payload: { filename: 'rejected.txt', content_base64: rejectedBytes.toString('base64') } });
    assert.equal(rejected.statusCode, 413, rejected.body);
    await assert.rejects(access(join(root, rejectedHash.slice(0, 2), rejectedHash)));
    const purged=await app.inject({method:'DELETE',url:`/attachments/${attachment.id}/purge`,payload:{confirm:true,expected_sha256:attachment.sha256}});
    assert.equal(purged.statusCode,200,purged.body);assert.equal(purged.json().library_metadata_removed,true);
    assert.equal((await db.query('SELECT id FROM attachments WHERE id=$1',[attachment.id])).rowCount,0);
  } finally {
    await app.close(); await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
