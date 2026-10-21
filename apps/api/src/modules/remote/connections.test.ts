import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { buildApp } from '../../app.js';
import { migrate } from '../../core/migrate.js';
import { issueRemoteSession } from './sessions.js';

test('remote credential replacement and disable atomically revoke sessions, stale proofs and racing tickets',{
  skip:!process.env.HOMELAB_LOCAL_PG_URL?'Requires owned disposable loopback HOMELAB_LOCAL_PG_URL':false,timeout:30_000,
},async t=>{
  const source=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(source.hostname));
  const admin=new pg.Pool({connectionString:source.href,max:2}),name=`remote_credentials_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE "${name}"`);source.pathname=`/${name}`;
  const db=new pg.Pool({connectionString:source.href,max:8}),artifactRoot=await mkdtemp(join(tmpdir(),'remote-credentials-'));
  const names=['APP_ORIGIN','MASTER_KEY','BOOTSTRAP_TOKEN','ARTIFACT_ROOT','DISPATCH_ENABLED','RESTORE_MODE','COOKIE_SECURE','NODE_ENV','GUACAMOLE_INTERNAL_URL','GUACAMOLE_JSON_KEY','GUACAMOLE_JSON_KEY_FILE'] as const;
  const previous=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  const origin='http://127.0.0.1:5173',password=randomBytes(24).toString('base64url'),bootstrap=randomBytes(32).toString('base64url');
  Object.assign(process.env,{APP_ORIGIN:origin,MASTER_KEY:randomBytes(32).toString('base64'),BOOTSTRAP_TOKEN:bootstrap,ARTIFACT_ROOT:artifactRoot,DISPATCH_ENABLED:'false',RESTORE_MODE:'false',COOKIE_SECURE:'false',NODE_ENV:'test'});
  delete process.env.GUACAMOLE_INTERNAL_URL;delete process.env.GUACAMOLE_JSON_KEY;delete process.env.GUACAMOLE_JSON_KEY_FILE;
  let app:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{await app?.close();await db.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();for(const key of names)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];await rm(artifactRoot,{recursive:true,force:true});});
  await migrate(db);app=await buildApp({db});
  type Auth={cookie:string;csrf:string};
  const http=async(method:'GET'|'POST',url:string,payload?:Record<string,unknown>,auth?:Auth)=>{
    const response=await app!.inject({method,url,headers:{origin,...(auth?{cookie:auth.cookie,'x-csrf-token':auth.csrf}:{})},...(payload===undefined?{}:{payload})});
    return {status:response.statusCode,body:response.json() as any,headers:response.headers};
  };
  const login=await http('POST','/api/v1/auth/bootstrap',{email:'remote-credentials@example.invalid',password,token:bootstrap});assert.equal(login.status,200);
  const cookie=String(login.headers['set-cookie']).split(';')[0],auth={cookie,csrf:login.body.csrf_token},owner=login.body.actor.id;
  const authSession=(await db.query('SELECT id FROM sessions WHERE token_hash=$1',[createHash('sha256').update(cookie.split('=')[1]).digest('hex')])).rows[0].id;
  const machine=await http('POST','/api/v1/machines',{name:'No-contact remote lifecycle fixture',os:'linux'},auth);assert.equal(machine.status,201);
  const config={hostname:'no-contact-fixture.invalid',port:22,username:'fixture-account',host_key_fingerprints:[`SHA256:${randomBytes(32).toString('base64').replace(/=+$/,'')}`],host_key_verified_out_of_band:true};
  const create=()=>http('POST','/api/v1/remote/connections',{machine_id:machine.body.id,kind:'ssh',config,credential:{password:'fixture-initial-password'}},auth);
  const conn=await create();assert.equal(conn.status,201);
  assert.equal((await http('POST','/api/v1/terminals',{connection_id:conn.body.id},auth)).status,201);
  await db.query(`INSERT INTO remote_sessions(id,owner_id,auth_session_id,machine_id,connection_id,kind,state,expires_at) VALUES($1,$2,$3,$4,$5,'terminal','active',now()+interval '1 hour')`,[randomUUID(),owner,authSession,machine.body.id,conn.body.id]);
  const replacement=randomBytes(24).toString('base64url');
  const rotated=await http('POST',`/api/v1/remote/connections/${conn.body.id}/credentials`,{expected_version:1,credential:{password:replacement}},auth);
  assert.equal(rotated.status,200);assert.equal(rotated.body.version,2);assert.equal(rotated.body.sessions_revoked,2);assert.equal(JSON.stringify(rotated.body).includes(replacement),false);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM remote_sessions WHERE connection_id=$1 AND state IN ('issued','active')",[conn.body.id])).rows[0].count,0);
  assert.equal((await http('POST',`/api/v1/remote/connections/${conn.body.id}/credentials`,{expected_version:1,credential:{password:'stale-fixture-password'}},auth)).status,409);
  const newTicket=await http('POST','/api/v1/terminals',{connection_id:conn.body.id},auth);assert.equal(newTicket.status,201);
  assert.equal((await http('POST',`/api/v1/remote/connections/${conn.body.id}/disable`,{expected_version:2},auth)).status,200);
  assert.equal((await http('POST','/api/v1/terminals',{connection_id:conn.body.id},auth)).status,404);
  await assert.rejects(issueRemoteSession(db,{ownerId:owner,authSessionId:authSession,connectionId:conn.body.id,connectionVersion:2,kind:'terminal'}));
  for(let index=0;index<3;index++){
    const race=await create();
    const results=await Promise.allSettled([issueRemoteSession(db,{ownerId:owner,authSessionId:authSession,connectionId:race.body.id,connectionVersion:1,kind:'terminal'}),http('POST',`/api/v1/remote/connections/${race.body.id}/disable`,{expected_version:1},auth)]);
    assert.equal(results[1].status,'fulfilled');
    assert.equal((await db.query("SELECT count(*)::int AS count FROM remote_sessions WHERE connection_id=$1 AND state IN ('issued','active')",[race.body.id])).rows[0].count,0);
  }
  const policy={type:'openssh_chroot',virtual_root:'/',host_root:'/synthetic/jail',operator_verified_sshd_chroot:true,root_marker_path:'marker',root_marker_sha256:'0'.repeat(64),outside_canary_path:'/synthetic/outside',operator_verified_outside_canary_exists:true,verification_directory:'data'};
  const sftpPayload={machine_id:machine.body.id,kind:'ssh',config:{...config,account_scope:'sftp_chroot',sftp:policy},credential:{password:'fixture-sftp-password'}};
  assert.equal((await http('POST','/api/v1/remote/connections',{...sftpPayload,config:{...sftpPayload.config,sftp:{...policy,verified_at:new Date().toISOString()}}},auth)).status,400);
  const sftp=await http('POST','/api/v1/remote/connections',sftpPayload,auth);assert.equal(sftp.status,201);
  await db.query(`UPDATE remote_connections SET config=jsonb_set(config,'{sftp,verified_at}',to_jsonb($2::text)) WHERE id=$1`,[sftp.body.id,new Date().toISOString()]);
  assert.equal((await http('POST',`/api/v1/remote/connections/${sftp.body.id}/credentials`,{expected_version:1,credential:{password:'fixture-sftp-replacement'}},auth)).status,200);
  assert.equal((await db.query('SELECT config FROM remote_connections WHERE id=$1',[sftp.body.id])).rows[0].config.sftp.verified_at,undefined);
  const desktop=await http('POST','/api/v1/remote/desktop-connections',{machine_id:machine.body.id,config:{hostname:'no-contact-fixture.invalid',port:5900,protocol:'vnc',server_type:'fixture'},credential:{password:'fixture-desktop-password'}},auth);assert.equal(desktop.status,201);
  await db.query(`UPDATE remote_connections SET config=config||'{"session_mode_verified":true,"observation":{"fixture_only":true}}'::jsonb WHERE id=$1`,[desktop.body.id]);
  assert.equal((await http('POST',`/api/v1/remote/connections/${desktop.body.id}/credentials`,{expected_version:1,credential:{password:'fixture-desktop-replacement'}},auth)).status,200);
  const desktopConfig=(await db.query('SELECT config FROM remote_connections WHERE id=$1',[desktop.body.id])).rows[0].config;assert.equal(desktopConfig.session_mode_verified,false);assert.equal(desktopConfig.observation,undefined);
  const outsider=randomUUID(),outsideSession=randomUUID(),outsideToken=randomBytes(32).toString('base64url'),outsideCsrf=randomBytes(32).toString('base64url');
  await db.query('INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users WHERE id=$3',[outsider,'remote-other-owner@example.invalid',owner]);
  await db.query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[outsideSession,outsider,createHash('sha256').update(outsideToken).digest('hex'),outsideCsrf]);
  const outsideAuth={cookie:`homelab_session=${outsideToken}`,csrf:outsideCsrf};
  assert.equal((await http('POST',`/api/v1/remote/connections/${desktop.body.id}/disable`,{expected_version:2},outsideAuth)).status,404);
  assert.equal((await http('POST',`/api/v1/remote/connections/${desktop.body.id}/credentials`,{expected_version:2,credential:{password:'denied-fixture'}},outsideAuth)).status,404);
  const machineState=await http('GET',`/api/v1/machines/${machine.body.id}`,undefined,auth);assert.equal(machineState.body.capabilities.desktop.health_state,'unverified');assert.equal(machineState.body.capabilities.sftp.health_state,'unverified');
});
