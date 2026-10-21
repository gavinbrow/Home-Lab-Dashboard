import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {AgentBroker,quarantineMachineRequests,verifyRpc} from '@homelab/transport';
import {migrate} from '../../apps/api/src/core/migrate.js';
test('actual PostgreSQL replacement fences prepared scopes while certificate rotation preserves installation',{skip:!process.env.HOMELAB_LOCAL_PG_URL?'Explicit disposable loopback PostgreSQL required':false,timeout:60000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
 const admin=new Pool({connectionString:url.href}),name=`machine_generation_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined;
 const previous={dispatch:process.env.DISPATCH_ENABLED,restore:process.env.RESTORE_MODE};
 try{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new Pool({connectionString:url.href});await migrate(db);process.env.DISPATCH_ENABLED='true';process.env.RESTORE_MODE='false';await db.query('UPDATE runtime_control SET dispatch_enabled=true');
  const owner=randomUUID(),machine=randomUUID(),keys=generateKeyPairSync('ed25519');
  await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'generation@example.test','unused')",[owner]);await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'generation','linux')",[machine,owner]);
  const certificate=async(serial:string)=>db!.query("INSERT INTO agent_certificates(id,machine_id,serial,protocol_version,expires_at)VALUES($1,$2,$3,1,now()+interval '1 hour')",[randomUUID(),machine,serial]);await certificate('FIRST');
  const broker=new AgentBroker(db,{signer:{keyId:'generation',privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()}}),old=(await db.query('SELECT identity_generation FROM machines WHERE id=$1',[machine])).rows[0].identity_generation;
  await assert.rejects(broker.enqueue(machine,'GET','/v1/health'),/Machine installation changed/);
  const queued=await broker.enqueue(machine,'GET','/v1/health',null,{expectedMachineGeneration:old});
  const client=await db.connect();let current:string;
  try{await client.query('BEGIN');current=(await client.query('UPDATE machines SET identity_generation=gen_random_uuid() WHERE id=$1 RETURNING identity_generation',[machine])).rows[0].identity_generation;await client.query('UPDATE agent_certificates SET revoked_at=now() WHERE machine_id=$1',[machine]);await quarantineMachineRequests(client,machine);await client.query('COMMIT');}finally{client.release();}
  await certificate('SECOND');
  assert.equal((await db.query('SELECT state FROM agent_rpc_requests WHERE id=$1',[queued])).rows[0].state,'expired');
  await assert.rejects(broker.enqueue(machine,'GET','/v1/health',null,{expectedMachineGeneration:old}),/Machine installation changed/);
  const fresh=await broker.enqueue(machine,'GET','/v1/health',null,{expectedMachineGeneration:current!});
  // Rotation replaces only the certificate, preserving already admitted work.
  await db.query('UPDATE agent_certificates SET revoked_at=now() WHERE machine_id=$1',[machine]);await certificate('THIRD');
  const claim=(await broker.claim(machine,1,'THIRD'))[0]!;assert.equal(claim.id,fresh);assert.equal(claim.machine_identity_generation,current!);assert.equal(verifyRpc(claim,'generation',keys.publicKey),true);assert.equal(verifyRpc({...claim,machine_identity_generation:old},'generation',keys.publicKey),false);
  await broker.respond(machine,fresh,200,{healthy:true},'THIRD');assert.deepEqual(await broker.wait(fresh,1000),{healthy:true});
  const job=randomUUID(),epoch=(await db.query('SELECT dispatch_epoch FROM runtime_control')).rows[0].dispatch_epoch;
  await db.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,context,kind,state,dispatch_epoch,lease_owner,lease_until,fence)VALUES($1::uuid,$2,$1::text,'legacy',null,'command','running',$3,'test',now()+interval '1 minute',1)",[job,owner,epoch]);
  await assert.rejects(broker.enqueue(machine,'GET','/v1/health',null,{expectedMachineGeneration:current!,jobGuard:{job_id:job,fence:1,lease_owner:'test'}}),/original job has no matching/);
 }finally{await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();for(const [key,value]of [['DISPATCH_ENABLED',previous.dispatch],['RESTORE_MODE',previous.restore]]as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
