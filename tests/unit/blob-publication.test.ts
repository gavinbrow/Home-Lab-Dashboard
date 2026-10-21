import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../apps/api/src/core/migrate.js';
test('actual PostgreSQL frozen queued references survive source purge and block non-live publication',{skip:!process.env.HOMELAB_LOCAL_PG_URL?'Explicit disposable loopback PostgreSQL required':false,timeout:60000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
 const admin=new Pool({connectionString:url.href}),name=`blob_refs_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new Pool({connectionString:url.href});await migrate(db);
  const owner=randomUUID(),attachment=randomUUID(),job=randomUUID(),hash='a'.repeat(64),external='b'.repeat(64);
  await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'blob@example.test','unused')",[owner]);
  await db.query("INSERT INTO attachments(id,owner_id,filename,mime_type,size_bytes,sha256,storage_key)VALUES($1,$2,'fixture','text/plain',1,$3,$3)",[attachment,owner,hash]);
  const epoch=(await db.query('SELECT dispatch_epoch FROM runtime_control')).rows[0].dispatch_epoch;
  await db.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,context,kind,state,dispatch_epoch,payload)VALUES($1::uuid,$2,$1::text,'request',null,'chat','queued',$3,$4)",[job,owner,epoch,{attachment_snapshots:[{sha256:hash}]}]);
  await db.query('DELETE FROM attachments WHERE id=$1',[attachment]);
  assert.equal(Number((await db.query("SELECT count(*) FROM blob_references WHERE hash=$1 AND owner_kind='jobs' AND owner_id=$2",[hash,job])).rows[0].count),1);
  await db.query("UPDATE blob_objects SET state='quarantining' WHERE hash=$1",[hash]);
  await assert.rejects(db.query("INSERT INTO attachments(id,owner_id,filename,mime_type,size_bytes,sha256,storage_key)VALUES($1,$2,'denied','text/plain',1,$3,$3)",[randomUUID(),owner,hash]),/blob_not_live/);
  await db.query("INSERT INTO backup_runs(id,status,manifest)VALUES($1,'complete',$2)",[randomUUID(),{files:[{sha256:external}]}]);
  assert.equal((await db.query('SELECT hash FROM blob_objects WHERE hash=$1',[external])).rowCount,0);
 }finally{await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();}
});
