import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../apps/api/src/core/migrate.js';
import {AgentBroker} from '@homelab/transport';
test('actual PostgreSQL late first delivery rechecks cancellation, worker fence and grant revocation',{skip:!process.env.HOMELAB_LOCAL_PG_URL?'Explicit disposable loopback PostgreSQL required':false,timeout:60000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
 const admin=new Pool({connectionString:url.href}),name=`delivery_guard_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined;
 const previous={dispatch:process.env.DISPATCH_ENABLED,restore:process.env.RESTORE_MODE};
 try{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new Pool({connectionString:url.href});await migrate(db);process.env.DISPATCH_ENABLED='true';process.env.RESTORE_MODE='false';
  const owner=randomUUID(),machine=randomUUID(),grant=randomUUID(),keys=generateKeyPairSync('ed25519');
  const broker=new AgentBroker(db,{signer:{keyId:'guard-test',privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()}});
  await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'guard@example.test','not-used')",[owner]);await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'guard','linux')",[machine,owner]);
  await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids)VALUES($1,$2,$3::jsonb,$4::jsonb)',[grant,owner,JSON.stringify(['run_command']),JSON.stringify([machine])]);
  const control=(await db.query('UPDATE runtime_control SET dispatch_enabled=true RETURNING dispatch_epoch')).rows[0];
  const makeJob=async()=>{const id=randomUUID();await db!.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,context,kind,state,dispatch_epoch,fence,lease_owner,lease_until)VALUES($1,$2,$4,'hash',null,'command','running',$3,1,'test',now()+interval '60 seconds')",[id,owner,control.dispatch_epoch,id]);return id;};
  for(const change of ['cancel','fence','capacity','grant']as const){
   const job=await makeJob();const rpc=await broker.enqueue(machine,'POST','/v1/operations',{grant_id:grant},{scopeGrantId:grant,scopeTool:'run_command',jobGuard:{job_id:job,fence:'1',lease_owner:'test'}});
   if(change==='cancel')await db.query("UPDATE jobs SET cancel_requested=true,state='cancelling' WHERE id=$1",[job]);
   if(change==='fence')await db.query('UPDATE jobs SET fence=2 WHERE id=$1',[job]);
   if(change==='capacity')await db.query("UPDATE jobs SET reason='capacity_recovery_only' WHERE id=$1",[job]);
   if(change==='grant')await db.query('UPDATE permission_grants SET revoked_at=now() WHERE id=$1',[grant]);
   assert.deepEqual(await broker.claim(machine),[]);
   const row:{state:string;delivery_count:number;response_status:number;response_body:{never_delivered:boolean;effects_started:boolean}}=(await db.query('SELECT state,delivery_count,response_status,response_body FROM agent_rpc_requests WHERE id=$1',[rpc])).rows[0];
   assert.equal(row.state,'responded');assert.equal(row.delivery_count,0);assert.equal(row.response_body.never_delivered,true);assert.equal(row.response_body.effects_started,false);assert.equal(row.response_status,change==='grant'?403:409);
  }
  const profile=randomUUID(),limits={max_tool_steps:60,wall_time_seconds:1800,per_command_timeout_seconds:300,max_output_bytes:104857600};
  await db.query("INSERT INTO agent_profiles(id,owner_id,name)VALUES($1,$2,'narrowed-profile')",[profile,owner]);await db.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition)VALUES($1,1,$2,$3)',[profile,'',{instructions:'',tools:['run_command'],machine_ids:[machine],workspace_ids:[],limits:{...limits,max_total_tokens:100}}]);await db.query('UPDATE permission_grants SET revoked_at=NULL,profile_ids=$2::jsonb WHERE id=$1',[grant,JSON.stringify([profile])]);
  const narrowed=await makeJob();await db.query('UPDATE jobs SET context=$2::jsonb WHERE id=$1',[narrowed,{profile_id:profile,limits}]);const rpc=await broker.enqueue(machine,'POST','/v1/operations',{}, {scopeGrantId:grant,scopeTool:'run_command',jobGuard:{job_id:narrowed,fence:1,lease_owner:'test'}});assert.deepEqual(await broker.claim(machine),[]);assert.equal((await db.query('SELECT response_body FROM agent_rpc_requests WHERE id=$1',[rpc])).rows[0].response_body.error.code,'profile_limit_reduced');
 }finally{if(db)await db.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();for(const [env,value]of [['DISPATCH_ENABLED',previous.dispatch],['RESTORE_MODE',previous.restore]]as const){if(value===undefined)delete process.env[env];else process.env[env]=value;}}
});
