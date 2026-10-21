import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {AgentBroker} from '@homelab/transport';
import {migrate} from '../../apps/api/src/core/migrate.js';
test('actual PostgreSQL response commit and restore cut serialize on runtime control',{skip:!process.env.HOMELAB_LOCAL_PG_URL?'Explicit disposable loopback PostgreSQL required':false,timeout:30000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));const admin=new Pool({connectionString:url.href}),name=`respond_restore_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined;
 const previous={dispatch:process.env.DISPATCH_ENABLED,restore:process.env.RESTORE_MODE};
 try{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new Pool({connectionString:url.href,max:8,application_name:'homelab-response-barrier'});await migrate(db);process.env.DISPATCH_ENABLED='true';process.env.RESTORE_MODE='false';await db.query('UPDATE runtime_control SET dispatch_enabled=true');
  const owner=randomUUID(),machine=randomUUID(),keys=generateKeyPairSync('ed25519');await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'response-race@example.test','unused')",[owner]);await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'response-race','linux')",[machine,owner]);
  const broker=new AgentBroker(db,{signer:{keyId:'response-race',privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()}});
  const waitBlocked=async(fragment:string)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name='homelab-response-barrier' AND wait_event_type='Lock' AND query LIKE $2",[name,`%${fragment}%`])).rowCount)return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Controlled database lock barrier not reached');};
  const first=await broker.enqueue(machine,'GET','/v1/health');assert.equal((await broker.claim(machine))[0]?.id,first);
  const rowBlock=await db.connect();
  try{
   await rowBlock.query('BEGIN');await rowBlock.query('SELECT id FROM agent_rpc_requests WHERE id=$1 FOR UPDATE',[first]);
   const response=broker.respond(machine,first,200,{before_cut:true});void response.catch(()=>undefined);await waitBlocked('UPDATE agent_rpc_requests SET state=');
   await assert.rejects(db.query('SELECT singleton FROM runtime_control FOR UPDATE NOWAIT'),(error:any)=>error.code==='55P03');
   const restore=db.query('UPDATE runtime_control SET restore_mode=true,dispatch_epoch=gen_random_uuid()');await rowBlock.query('COMMIT');await response;await restore;
   assert.ok((await db.query('SELECT response_hash FROM agent_rpc_requests WHERE id=$1',[first])).rows[0].response_hash);
  }finally{await rowBlock.query('ROLLBACK');rowBlock.release();}
  await db.query('UPDATE runtime_control SET restore_mode=false');const second=await broker.enqueue(machine,'GET','/v1/health');assert.equal((await broker.claim(machine))[0]?.id,second);
  const cut=await db.connect();
  try{
   await cut.query('BEGIN');await cut.query('SELECT singleton FROM runtime_control FOR UPDATE');
   const response=broker.respond(machine,second,200,{after_cut:true});void response.catch(()=>undefined);await waitBlocked('SELECT dispatch_epoch,restore_mode FROM runtime_control');
   await cut.query('UPDATE runtime_control SET restore_mode=true,dispatch_epoch=gen_random_uuid()');await cut.query('COMMIT');await assert.rejects(response,/Unknown RPC or conflicting result/);
   assert.equal((await db.query('SELECT response_hash FROM agent_rpc_requests WHERE id=$1',[second])).rows[0].response_hash,null);
  }finally{await cut.query('ROLLBACK');cut.release();}
 }finally{await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();for(const [key,value]of [['DISPATCH_ENABLED',previous.dispatch],['RESTORE_MODE',previous.restore]]as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
