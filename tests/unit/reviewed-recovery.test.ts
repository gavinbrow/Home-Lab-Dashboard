import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {AgentBroker,rpcDigest} from '@homelab/transport';
import {migrate} from '../../apps/api/src/core/migrate.js';
test('actual PostgreSQL restore admits only current reviewed append-only partial resolution',{skip:!process.env.HOMELAB_LOCAL_PG_URL?'Explicit disposable loopback PostgreSQL required':false,timeout:60000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
 const admin=new Pool({connectionString:url.href}),name=`reviewed_recovery_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined;
 const previous={dispatch:process.env.DISPATCH_ENABLED,restore:process.env.RESTORE_MODE};
 try{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new Pool({connectionString:url.href});await migrate(db);
  const owner=randomUUID(),machine=randomUUID(),project=randomUUID(),workspace=randomUUID(),original=randomUUID(),grant=randomUUID(),lock=`file:${owner}:${original}`;
  await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'recovery@example.test','unused')",[owner]);
  await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'recovery','linux')",[machine,owner]);
  await db.query("INSERT INTO projects(id,owner_id,name)VALUES($1,$2,'recovery')",[project,owner]);
  await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path)VALUES($1,$2,$3,'recovery','native',$4,'approved','/approved','/approved')",[workspace,owner,project,machine]);
  await db.query('INSERT INTO workspace_locks(workspace_id,lock_owner)VALUES($1,$2)',[workspace,lock]);
  await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids)VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',[grant,owner,JSON.stringify(['workspace.reconcile']),JSON.stringify([machine]),JSON.stringify([workspace])]);
  await db.query('UPDATE runtime_control SET restore_mode=true,dispatch_enabled=false');process.env.RESTORE_MODE='true';process.env.DISPATCH_ENABLED='false';
  const keys=generateKeyPairSync('ed25519'),broker=new AgentBroker(db,{signer:{keyId:'recovery',privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()}});
  const route=`/v1/workspaces/${workspace}/file-operations/${original}/reconcile`,body={expected_manifest_hash:'a'.repeat(64),grant_id:'protected-host-recovery',policy_revision:1,resolution:'accept_partial',reason:'Owner reviewed complete current manifest',resolution_id:randomUUID()};
  const review=randomUUID(),options={requestId:body.resolution_id,scopeGrantId:grant,scopeTool:'workspace.reconcile',workspaceGuard:{workspace_id:workspace,lock_owner:lock,workspace_revision:1},recoveryResolution:{review_id:review,owner_id:owner}};
  await db.query("INSERT INTO storage_recovery_reviews(id,owner_id,workspace_id,original_operation_id,expected_manifest_hash,plan_hash,expires_at,details)VALUES($1,$2,$3,$4,$5,$5,now()+interval '10 minutes',$6)",[review,owner,workspace,original,body.expected_manifest_hash,{lock_owner:lock,canonical_root:'/approved',host_policy_revision:1,resolution_id:body.resolution_id,rpc_body_hash:rpcDigest(body)}]);
  await assert.rejects(broker.enqueue(machine,'POST',route,body));
  await assert.rejects(broker.enqueue(machine,'POST',route,{...body,reason:'Tampered owner review'},options),/Review is expired/);
  assert.equal((await db.query('SELECT used_at FROM storage_recovery_reviews WHERE id=$1',[review])).rows[0].used_at,null);
  await broker.enqueue(machine,'POST',route,body,options);
  assert.equal((await broker.claim(machine))[0]?.id,body.resolution_id);
  await broker.respond(machine,body.resolution_id,200,{state:'failed',reason:'operator_accepted_partial_outcome'});
  assert.deepEqual(await broker.wait(body.resolution_id,1000),{state:'failed',reason:'operator_accepted_partial_outcome'});
  await assert.rejects(broker.enqueue(machine,'POST',route,body,{...options,requestId:randomUUID()}),/Review is expired/);
  await assert.rejects(broker.enqueue(machine,'GET',`/v1/workspaces/${workspace}/files`,null,{recoveryRead:true}),/recovery_rpc_denied/);
  const metadata=await broker.enqueue(machine,'GET',`/v1/workspaces/${workspace}/manifest`,null,{recoveryRead:true});assert.equal((await broker.claim(machine))[0]?.id,metadata);
 }finally{await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();for(const [key,value]of [['DISPATCH_ENABLED',previous.dispatch],['RESTORE_MODE',previous.restore]]as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
