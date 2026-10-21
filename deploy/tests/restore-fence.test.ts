import 'reflect-metadata';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Pool} from 'pg';
import {migrate} from '../../apps/api/src/core/migrate.js';
import {buildApp} from '../../apps/api/src/app.js';

test('restored snapshot authentication is revoked atomically without clearing writer uncertainty',{
 skip:!process.env.HOMELAB_LOCAL_PG_URL,timeout:30000,
},async()=>{
 const admin=new Pool({connectionString:process.env.HOMELAB_LOCAL_PG_URL});
 const name='restore_fence_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${name}"`);
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);url.pathname='/'+name;
 const db=new Pool({connectionString:url.toString()});let app:Awaited<ReturnType<typeof buildApp>>|undefined;
 const previous={...process.env};
 try{
  await migrate(db);
  const owner=randomUUID(),session=randomUUID(),machine=randomUUID(),project=randomUUID(),workspace=randomUUID(),job=randomUUID(),operation=randomUUID(),remoteConnection=randomUUID(),remoteSession=randomUUID(),terminal=randomUUID(),ticket=randomUUID(),rpc=randomUUID();
  const token=randomBytes(32).toString('base64url'),cookie='homelab_session='+token;
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[owner,owner+'@restore.invalid','nonlogin-fixture']);
  await db.query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,'fixture',now()+interval '1 hour')",[session,owner,createHash('sha256').update(token).digest('hex')]);
  await db.query("INSERT INTO machines(id,owner_id,name,os) VALUES($1,$2,'uncontacted fixture','linux')",[machine,owner]);
  await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'fixture')",[project,owner]);
  await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path) VALUES($1,$2,$3,'fixture','native',$4,'fixture','/uncontacted-fixture','/uncontacted-fixture')",[workspace,owner,project,machine]);
  await db.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,kind,state,dispatch_epoch,workspace_id) SELECT $1,$2,'retained-unknown','fixture','command','running',dispatch_epoch,$3 FROM runtime_control",[job,owner,workspace]);
  await db.query("INSERT INTO operations(id,job_id,step_id,request_hash,request,machine_id,fence,status) VALUES($1,$2,'retained','fixture','{}',$3,1,'outcome_unknown')",[operation,job,machine]);
  await db.query("INSERT INTO workspace_locks(workspace_id,job_id,lock_owner,operation_id,state) VALUES($1,$2,'retained-unknown',$3,'held')",[workspace,job,operation]);
  await db.query("INSERT INTO remote_connections(id,machine_id,kind,config,owner_id) VALUES($1,$2,'rdp','{}',$3)",[remoteConnection,machine,owner]);
  await db.query("INSERT INTO remote_sessions(id,owner_id,auth_session_id,machine_id,connection_id,kind,state,expires_at) VALUES($1,$2,$3,$4,$5,'desktop','active',now()+interval '1 hour')",[remoteSession,owner,session,machine,remoteConnection]);
  await db.query("INSERT INTO terminal_sessions(id,owner_id,workspace_id,job_id,operation_id,machine_id,auth_session_id,state,fence,active_connection_id) VALUES($1,$2,$3,$4,$5,$6,$7,'running',5,$8)",[terminal,owner,workspace,job,operation,machine,session,randomUUID()]);
  await db.query("INSERT INTO terminal_tickets(id,terminal_id,auth_session_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[ticket,terminal,session,randomBytes(32).toString('hex')]);
  const epoch=(await db.query('SELECT dispatch_epoch FROM runtime_control')).rows[0].dispatch_epoch;
  await db.query("INSERT INTO agent_rpc_requests(id,machine_id,request_hash,method,path,body,response_body,response_hash,authorization_json,created_at,expires_at,dispatch_epoch,state,sensitive_payload,payload_expires_at) VALUES($1,$2,'retained-request','POST',$3,'{\"data\":\"fixture-only\"}','{\"data\":\"fixture-only\"}','retained-response','{}',now(),now()+interval '1 hour',$4,'leased',true,now()+interval '1 hour')",[rpc,machine,'/v1/terminals/'+operation+'/write',epoch]);
  Object.assign(process.env,{NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:5173',COOKIE_SECURE:'false',RESTORE_MODE:'false',DISPATCH_ENABLED:'false',MASTER_KEY:randomBytes(32).toString('base64'),ARTIFACT_ROOT:await mkdtemp(join(tmpdir(),'restore-auth-fence-'))});
  app=await buildApp({db,modules:[async scope=>{scope.get('/restore-auth-probe',async request=>({id:request.actor!.id}));}]});
  const auth=()=>app!.inject({method:'GET',url:'/api/v1/restore-auth-probe',headers:{cookie}});
  assert.equal((await auth()).statusCode,200);
  // Reproduce an active snapshot row resurrected after a later logout.
  await db.query('CREATE TABLE fixture_session_snapshot AS SELECT * FROM sessions');
  await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[session]);assert.equal((await auth()).statusCode,401);
  await db.query('UPDATE sessions s SET revoked_at=b.revoked_at FROM fixture_session_snapshot b WHERE s.id=b.id');assert.equal((await auth()).statusCode,200);
  const beforeOperation=(await db.query('SELECT * FROM operations WHERE id=$1',[operation])).rows[0];
  const beforeLock=(await db.query('SELECT * FROM workspace_locks WHERE workspace_id=$1',[workspace])).rows[0];
  await db.query(await readFile(new URL('../restore-fence.sql',import.meta.url),'utf8'));
  assert.equal((await auth()).statusCode,401,'old restored cookie must remain denied');
  const control=(await db.query('SELECT * FROM runtime_control')).rows[0];assert.equal(control.restore_mode,true);assert.equal(control.dispatch_enabled,false);assert.notEqual(control.dispatch_epoch,epoch);
  assert.deepEqual((await db.query('SELECT * FROM operations WHERE id=$1',[operation])).rows[0],beforeOperation);
  assert.deepEqual((await db.query('SELECT * FROM workspace_locks WHERE workspace_id=$1',[workspace])).rows[0],beforeLock);
  const remote=(await db.query('SELECT * FROM remote_sessions WHERE id=$1',[remoteSession])).rows[0];assert.equal(remote.state,'closed');assert.ok(remote.revoked_at&&remote.ticket_consumed_at);
  const terminalRow=(await db.query('SELECT * FROM terminal_sessions WHERE id=$1',[terminal])).rows[0];assert.equal(terminalRow.active_connection_id,null);assert.equal(terminalRow.state,'outcome_unknown');assert.equal(String(terminalRow.fence),'6');
  assert.ok((await db.query('SELECT consumed_at FROM terminal_tickets WHERE id=$1',[ticket])).rows[0].consumed_at);
  const request=(await db.query('SELECT * FROM agent_rpc_requests WHERE id=$1',[rpc])).rows[0];assert.equal(request.state,'outcome_unknown');assert.equal(request.body,null);assert.equal(request.response_body,null);assert.equal(request.request_hash,'terminal-redacted:'+rpc);assert.equal(request.response_hash,'terminal-redacted:'+rpc);assert.deepEqual(request.authorization_json,{key_id:'terminal-redacted',signature:''});assert.ok(request.payload_scrubbed_at);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM audit_events WHERE action='restore.security_fence'")).rows[0].count,1);
 }finally{await app?.close();await db.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end();for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});
