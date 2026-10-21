import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../../apps/api/src/core/migrate.js';
import { buildApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../apps/api/src/auth/password.js';
test('actual PostgreSQL secret rotation is owner-bound, concurrent CAS and encrypted version recovery', {skip:!process.env.HOMELAB_LOCAL_PG_URL?'Explicit disposable loopback PostgreSQL required':false,timeout:60000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
 const admin=new Pool({connectionString:url.href}),name=`secret_rotation_${randomUUID().replaceAll('-','')}`,root=await mkdtemp(join(tmpdir(),'homelab-rotation-'));
 const variables=['MASTER_KEY','BOOTSTRAP_TOKEN','APP_ORIGIN','ARTIFACT_ROOT','COOKIE_SECURE','NODE_ENV','DISPATCH_SIGNING_KEY_FILE','DISPATCH_SIGNING_KEY_ID','RESTORE_MODE']as const,previous=Object.fromEntries(variables.map(key=>[key,process.env[key]]));
 let db:Pool|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new Pool({connectionString:url.href});await migrate(db);
  const token=randomBytes(32).toString('hex'),origin='http://127.0.0.1:5173',password='component-test-password-123';
  Object.assign(process.env,{MASTER_KEY:randomBytes(32).toString('base64'),BOOTSTRAP_TOKEN:token,APP_ORIGIN:origin,ARTIFACT_ROOT:root,COOKIE_SECURE:'false',NODE_ENV:'test',RESTORE_MODE:'false'});delete process.env.DISPATCH_SIGNING_KEY_FILE;delete process.env.DISPATCH_SIGNING_KEY_ID;
  app=await buildApp({db,modules:[]});
  const bootstrap=await app.inject({method:'POST',url:'/api/v1/auth/bootstrap',headers:{origin},payload:{email:'owner@example.test',password,token}});assert.equal(bootstrap.statusCode,200);
  const session=bootstrap.json(),cookie=bootstrap.headers['set-cookie']!.toString().split(';')[0]!,headers={origin,cookie,'x-csrf-token':session.csrf_token};
  const secret=await app.inject({method:'POST',url:'/api/v1/secrets',headers,payload:{name:'rotation-fixture',value:'first-protected-value'}});assert.equal(secret.statusCode,201);const id=secret.json().id;
  const machine=randomUUID(),connection=randomUUID(),remoteSession=randomUUID();
  await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'rotation','linux')",[machine,session.actor.id]);
  await db.query("INSERT INTO remote_connections(id,machine_id,kind,config,credential_ref,owner_id)VALUES($1,$2,'ssh',$3,$4,$5)",[connection,machine,{sftp:{verified_at:new Date().toISOString()},observation:{healthy:true},session_mode_verified:true},id,session.actor.id]);
  await db.query("INSERT INTO remote_sessions(id,owner_id,auth_session_id,machine_id,connection_id,kind,state,expires_at)VALUES($1,$2,$3,$4,$5,'terminal','active',now()+interval '5 minutes')",[remoteSession,session.actor.id,(await db.query('SELECT id FROM sessions WHERE user_id=$1',[session.actor.id])).rows[0].id,machine,connection]);
  const first='second-protected-value',second='concurrent-protected-value';
  const results=await Promise.all([first,second].map(value=>app!.inject({method:'POST',url:`/api/v1/secrets/${id}/rotate`,headers,payload:{expected_version:1,value}})));
  assert.deepEqual(results.map(result=>result.statusCode).sort(),[200,409]);
  const revoked=(await db.query('SELECT state,revoked_at FROM remote_sessions WHERE id=$1',[remoteSession])).rows[0];assert.equal(revoked.state,'revoked');assert.ok(revoked.revoked_at);
  const invalidated=(await db.query('SELECT version,config FROM remote_connections WHERE id=$1',[connection])).rows[0];assert.equal(invalidated.version,2);assert.equal(invalidated.config.sftp.verified_at,undefined);assert.equal(invalidated.config.session_mode_verified,false);assert.equal(invalidated.config.observation,undefined);
  const winner=[first,second][results.findIndex(result=>result.statusCode===200)]!;
  assert.equal(await app.apiContext.secrets.get(session.actor.id,id),winner);
  assert.ok(!results.some(result=>result.body.includes(winner)));assert.ok(!results.some(result=>result.body.includes('first-protected-value')));
  const versionList=await app.inject({method:'GET',url:`/api/v1/secrets/${id}/versions`,headers:{cookie}});assert.equal(versionList.statusCode,200);assert.deepEqual(versionList.json().items.map((row:{version:number})=>row.version),[1]);
  const otherId=randomUUID();await db.query('INSERT INTO users(id,email,password_hash)VALUES($1,$2,$3)',[otherId,'other@example.test',await hashPassword(password)]);
  const otherLogin=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email:'other@example.test',password}}),otherCookie=otherLogin.headers['set-cookie']!.toString().split(';')[0]!;
  const denied=await app.inject({method:'POST',url:`/api/v1/secrets/${id}/rotate`,headers:{origin,cookie:otherCookie,'x-csrf-token':otherLogin.json().csrf_token},payload:{expected_version:2,value:'forbidden'}});assert.equal(denied.statusCode,404);
  const current=(await db.query('SELECT * FROM secrets WHERE id=$1',[id])).rows[0],old=(await db.query('SELECT * FROM secret_versions WHERE secret_id=$1',[id])).rows[0];assert.equal(current.version,2);assert.equal(current.format_version,2);assert.ok(!JSON.stringify([current,old]).includes(winner));
  const recovered=await import('../../apps/api/src/core/secrets.js');const key=Buffer.from(process.env.MASTER_KEY!,'base64');assert.equal(await recovered.createSecretStore(db,key).get(session.actor.id,id),winner);await assert.rejects(recovered.createSecretStore(db,randomBytes(32)).get(session.actor.id,id));
 }finally{
  if(app)await app.close();if(db)await db.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();await rm(root,{recursive:true,force:true});
  for(const key of variables){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
 }
});
