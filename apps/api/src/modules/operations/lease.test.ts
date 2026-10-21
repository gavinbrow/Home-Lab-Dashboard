import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {migrate} from '../../core/migrate.js';
import {withBackupLease,acquireBackupCut} from './lease.js';
test('replacement backup fence prevents stale finally and failure status writes',{
 skip:!process.env.HOMELAB_LOCAL_PG_URL,timeout:30000,
},async()=>{
 const admin=new Pool({connectionString:process.env.HOMELAB_LOCAL_PG_URL});
 const name='backup_lease_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE DATABASE "${name}"`);
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);url.pathname='/'+name;
 const db=new Pool({connectionString:url.toString()});
 try{
  await migrate(db);
  const owner=randomUUID(),jobId=randomUUID();
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[owner,owner+'@example.invalid','nonlogin-fixture']);
  await db.query(`INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,kind,state,dispatch_epoch,lease_owner,lease_until,fence) SELECT $1,$2,'backup-fence-fixture','fixture','operations.backup','running',dispatch_epoch,'old-worker',now()+interval '1 minute',1 FROM runtime_control`,[jobId,owner]);
  await db.query('UPDATE runtime_control SET dispatch_enabled=true,maintenance_mode=true,maintenance_job_id=$1',[jobId]);
  await db.query("INSERT INTO backup_runs(id,owner_id,job_id,status,manifest) VALUES($1,$2,$1,'capturing','{}')",[jobId,owner]);
  const old=(await db.query('SELECT * FROM jobs WHERE id=$1',[jobId])).rows[0];
  await db.query("UPDATE jobs SET lease_owner='replacement-worker',fence=2,lease_until=now()+interval '1 minute' WHERE id=$1",[jobId]);
  await assert.rejects(withBackupLease(db,old,true,client=>client.query('UPDATE runtime_control SET maintenance_mode=false,maintenance_job_id=NULL')),/backup_lease_lost/);
  await assert.rejects(withBackupLease(db,old,false,client=>client.query("UPDATE backup_runs SET status='failed' WHERE id=$1",[jobId])),/backup_lease_lost/);
  const control=(await db.query('SELECT * FROM runtime_control')).rows[0];assert.equal(control.maintenance_mode,true);assert.equal(control.maintenance_job_id,jobId);
  assert.equal((await db.query('SELECT status FROM backup_runs WHERE id=$1',[jobId])).rows[0].status,'capturing');
  const current=(await db.query('SELECT * FROM jobs WHERE id=$1',[jobId])).rows[0];
  await withBackupLease(db,current,false,client=>client.query("UPDATE backup_runs SET status='sealing' WHERE id=$1",[jobId]));
  await withBackupLease(db,current,true,client=>client.query('UPDATE runtime_control SET maintenance_mode=false,maintenance_job_id=NULL WHERE maintenance_job_id=$1',[jobId]));
  assert.equal((await db.query('SELECT maintenance_mode FROM runtime_control')).rows[0].maintenance_mode,false);
  const writer=randomUUID();
  await db.query(`INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,kind,state,dispatch_epoch,lease_owner,lease_until,fence) SELECT $1,$2,'active-writer','fixture','chat','running',dispatch_epoch,'writer',now()+interval '1 minute',1 FROM runtime_control`,[writer,owner]);
  assert.equal(await acquireBackupCut(db,current),false,'active writer blocks maintenance acquisition');
  assert.equal((await db.query('SELECT maintenance_mode FROM runtime_control')).rows[0].maintenance_mode,false);
  await db.query("UPDATE jobs SET state='completed',lease_owner=NULL,lease_until=NULL WHERE id=$1",[writer]);
  assert.equal(await acquireBackupCut(db,current),true,'drained cut can be acquired');
  await withBackupLease(db,current,true,client=>client.query('UPDATE runtime_control SET maintenance_mode=false,maintenance_job_id=NULL WHERE maintenance_job_id=$1',[jobId]));
 }finally{await db.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end();}
});
