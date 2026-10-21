/** Real PostgreSQL capacity test; runs only inside the driver's new temporary database. */
import{Pool}from'pg';
import{randomUUID}from'node:crypto';
import assert from'node:assert/strict';
import{submitJob}from'../../../apps/worker/src/queue.js';
import{reserveProvider,releaseProvider,markProviderUncertain}from'../../../apps/worker/src/reservations.js';
const connectionString=process.env.HOMELAB_TEST_DATABASE_URL;if(!connectionString||!/^\/homelab_provider_[0-9a-f]{32}$/.test(new URL(connectionString).pathname))throw new Error('Use routes-postgres-driver.ts reservations to create an isolated database');
const db=new Pool({connectionString});const owner=randomUUID(),pool=randomUUID();
try{
  await db.query('INSERT INTO users(id,email,password_hash)VALUES($1,$2,$3)',[owner,`${owner}@example.invalid`,'disabled-fixture-login']);
  await db.query('INSERT INTO provider_runtime_pools(id,owner_id,name,max_concurrency,max_queue)VALUES($1,$2,$3,2,100)',[pool,owner,'Explicit capacity fixture']);
  const input=(key:string,shape='provider_snapshot')=>({requester_id:owner,idempotency_key:key,context:null,kind:'provider-capacity-fixture',payload:{[shape]:{runtimePoolId:pool}},modifies_workspace:false});
  const a=await submitJob(db,input('a')),b=await submitJob(db,input('b')),c=await submitJob(db,input('c')),exclusive=await submitJob(db,input('exclusive'));
  assert.equal(await reserveProvider(db,pool,a.id,'model-a',1),true);
  assert.equal(await reserveProvider(db,pool,b.id,'model-a',1),false);
  assert.equal(await reserveProvider(db,pool,c.id,'model-b',1),true);
  assert.equal(await reserveProvider(db,pool,exclusive.id,'model-a',1,true),false);
  await markProviderUncertain(db,a.id);await releaseProvider(db,a.id);await releaseProvider(db,c.id);
  assert.equal(await reserveProvider(db,pool,b.id,'model-a',1),false);
  assert.equal(await reserveProvider(db,pool,exclusive.id,'model-a',1,true),false);
  // Fixture-only reconciliation: no network/model requests were ever dispatched.
  await db.query("UPDATE resource_reservations SET state='released' WHERE job_id=$1 AND state='uncertain'",[a.id]);
  assert.equal(await reserveProvider(db,pool,exclusive.id,undefined,1,true),true);
  assert.equal(await reserveProvider(db,pool,b.id,'model-a',1),false);
  await markProviderUncertain(db,exclusive.id);await releaseProvider(db,exclusive.id);
  assert.equal(await reserveProvider(db,pool,b.id,'model-a',1),false);
  await db.query("UPDATE resource_reservations SET state='released' WHERE job_id=$1 AND state='uncertain'",[exclusive.id]);
  assert.equal(await reserveProvider(db,pool,b.id,'model-a',1),true);await releaseProvider(db,b.id);
  const raceA=await submitJob(db,input('race-a')),raceB=await submitJob(db,input('race-b'));
  const raced=await Promise.all([reserveProvider(db,pool,raceA.id,'same-model',1),reserveProvider(db,pool,raceB.id,'same-model',1)]);assert.equal(raced.filter(Boolean).length,1);
  await releaseProvider(db,raceA.id);await releaseProvider(db,raceB.id);
  await db.query("UPDATE jobs SET state='completed' WHERE requester_id=$1",[owner]);await db.query('UPDATE provider_runtime_pools SET max_queue=1 WHERE id=$1',[pool]);
  const queued=await submitJob(db,input('queue-one'));
  await assert.rejects(submitJob(db,input('queue-two','provider')),error=>(error as any).code==='provider_queue_full');
  assert.equal((await submitJob(db,input('queue-one'))).id,queued.id);
  await assert.rejects(submitJob(db,{...input('queue-one'),payload:{provider_snapshot:{runtimePoolId:pool},changed:true}}),error=>(error as any).code==='idempotency_conflict');
  process.stdout.write(JSON.stringify({scope:'real PostgreSQL provider capacity; no model requests',outcome:'PASS',checks:['per_model_limit','different_model_shared_pool','exclusive_waits_for_held','uncertain_reservation_retained','exclusive_blocks_shared','uncertain_exclusive_blocks_shared','concurrent_same_model_one_winner','aliases_share_queue_limit','idempotency_retry_when_queue_full','changed_request_conflict']})+'\n');
}finally{await db.end();}
