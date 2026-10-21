import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrate} from '../../../apps/api/src/core/migrate.js';
import {BlobStore,collectBlobs} from '../src/index.js';

test('actual PostgreSQL GC fences publishers, retains references, revives quarantine and denies late dangling refs',{skip:!process.env.HOMELAB_LOCAL_PG_URL,timeout:30000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
 const admin=new pg.Pool({connectionString:url.href}),name=`homelab_gc_${randomUUID().replaceAll('-','')}`,root=await mkdtemp(join(tmpdir(),'homelab-gc-'));let db:pg.Pool|undefined;
 try {
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new pg.Pool({connectionString:url.href});await migrate(db);
  const store=new BlobStore(root,64*1024*1024,{db});const bytes=Buffer.from('retained binary\0proof'),blob=await store.put(bytes);
  const old=new Date(Date.now()-3600000);await db.query('UPDATE blob_objects SET last_published_at=$2 WHERE hash=$1',[blob.hash,old]);
  const publisher=await db.connect();await publisher.query('BEGIN');await publisher.query("SELECT pg_advisory_xact_lock(hashtextextended('homelab-blob:'||$1,0))",[blob.hash]);
  let collectorDone=false;const pending=collectBlobs(db,store,{minimumAgeMs:60000,quarantineAgeMs:60000}).then(r=>{collectorDone=true;return r;});
  await new Promise(r=>setTimeout(r,40));assert.equal(collectorDone,false);
  await publisher.query('INSERT INTO blob_references(owner_kind,owner_id,hash) VALUES($1,$2,$3)',['test','published',blob.hash]);await publisher.query('COMMIT');publisher.release();
  assert.deepEqual((await pending).quarantined,[]);assert.deepEqual(await store.get(blob.hash),bytes);
  await db.query("DELETE FROM blob_references WHERE owner_kind='test'");
  const owner=randomUUID(),attachment=randomUUID(),job=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'gc-history@example.invalid','unused')",[owner]);
  await db.query("INSERT INTO attachments(id,owner_id,filename,mime_type,size_bytes,sha256,storage_key)VALUES($1,$2,'snapshot','application/octet-stream',$3,$4,$4)",[attachment,owner,bytes.length,blob.hash]);
  const epoch=(await db.query('SELECT dispatch_epoch FROM runtime_control')).rows[0].dispatch_epoch;
  await db.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,kind,state,dispatch_epoch,payload)VALUES($1::uuid,$2,$1::text,'fixture','chat','queued',$3,$4::jsonb)",[job,owner,epoch,JSON.stringify({attachment_snapshots:[{sha256:blob.hash}]})]);
  await db.query('DELETE FROM attachments WHERE id=$1',[attachment]);
  assert.deepEqual((await collectBlobs(db,store,{minimumAgeMs:60000,quarantineAgeMs:60000})).quarantined,[]);assert.deepEqual(await store.get(blob.hash),bytes);
  await db.query('DELETE FROM jobs WHERE id=$1',[job]);
  assert.deepEqual((await collectBlobs(db,store,{minimumAgeMs:60000,quarantineAgeMs:60000})).quarantined,[blob.hash]);
  await assert.rejects(db.query('INSERT INTO blob_references(owner_kind,owner_id,hash) VALUES($1,$2,$3)',['test','late',blob.hash]),/blob_not_live/);
  assert.equal((await readdir(join(root,'.gc'))).length,1);
  await store.put(bytes);assert.equal((await readdir(join(root,'.gc'))).length,0);assert.deepEqual(await store.get(blob.hash),bytes);
  await db.query('UPDATE blob_objects SET last_published_at=$2 WHERE hash=$1',[blob.hash,old]);
  await collectBlobs(db,store,{minimumAgeMs:60000,quarantineAgeMs:60000});
  await db.query("CREATE FUNCTION fail_blob_revive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.state<>'live' AND NEW.state='live' THEN RAISE EXCEPTION 'injected_publish_rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_revive BEFORE UPDATE ON blob_objects FOR EACH ROW EXECUTE FUNCTION fail_blob_revive()");
  await assert.rejects(store.put(bytes),/injected_publish_rollback/);
  assert.equal((await readdir(join(root,'.gc'))).length,0);
  await access(join(root,blob.hash.slice(0,2),blob.hash));
  await db.query('DROP TRIGGER fail_revive ON blob_objects');
  const deleted=await collectBlobs(db,store,{minimumAgeMs:60000,quarantineAgeMs:60000,now:new Date(Date.now()+120000)});assert.deepEqual(deleted.deleted,[blob.hash]);
  await assert.rejects(access(join(root,blob.hash.slice(0,2),blob.hash)),/ENOENT/);
  assert.equal((await db.query('SELECT state FROM blob_objects WHERE hash=$1',[blob.hash])).rows[0].state,'quarantined');
  await assert.rejects(db.query('INSERT INTO blob_references(owner_kind,owner_id,hash) VALUES($1,$2,$3)',['test','after-delete',blob.hash]),/blob_not_live/);
  await db.query('CREATE TRIGGER fail_revive BEFORE UPDATE ON blob_objects FOR EACH ROW EXECUTE FUNCTION fail_blob_revive()');
  await assert.rejects(store.put(bytes),/injected_publish_rollback/);await access(join(root,blob.hash.slice(0,2),blob.hash));await db.query('DROP TRIGGER fail_revive ON blob_objects');
  assert.deepEqual((await collectBlobs(db,store,{minimumAgeMs:60000,quarantineAgeMs:60000})).quarantined,[blob.hash]);
  await assert.rejects(access(join(root,blob.hash.slice(0,2),blob.hash)),/ENOENT/);
  await collectBlobs(db,store,{minimumAgeMs:60000,quarantineAgeMs:60000,now:new Date(Date.now()+120000)});
  await store.put(bytes);await db.query('UPDATE blob_objects SET last_published_at=$2 WHERE hash=$1',[blob.hash,old]);
  await db.query('UPDATE runtime_control SET maintenance_mode=true WHERE singleton=true');
  await assert.rejects(store.put(bytes),/maintenance or restore/);
  await assert.rejects(collectBlobs(db,store,{minimumAgeMs:60000,quarantineAgeMs:60000}),/maintenance_blocked/);
 }finally{await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();await rm(root,{recursive:true,force:true});}
});


