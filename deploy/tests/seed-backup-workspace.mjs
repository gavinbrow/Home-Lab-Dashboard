// Explicit disposable fixture only: parameters never become shell/SQL fragments.
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
const root='/fixture';
const host=JSON.parse(await readFile(root+'/host-fixture.json','utf8'));
const config=JSON.parse(await readFile(host.supervisor_config,'utf8'));
const workspace=config.workspaces.find(item=>item.id===host.workspace_id);
if(!workspace||workspace.root!==host.project_root||!workspace.grant_ids?.length)throw new Error('Fixture rooted binding unavailable');
const grantId=workspace.grant_ids[0];
if(!/^[0-9a-f-]{36}$/.test(grantId))throw new Error('Fixture needs a UUID local file grant');
const db=new Pool({connectionString:(await readFile(root+'/config/database-admin-url','utf8')).trim(),max:1});
try{
 const owner=(await db.query("SELECT id FROM users WHERE email='backup-fixture@example.invalid'")).rows[0].id;
 const project=randomUUID(),oldJob=randomUUID(),oldRpc=randomUUID(),oldEpoch=randomUUID();
 await db.query('BEGIN');
 await db.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Actual enrolled backup fixture')",[project,owner]);
 await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,revision,state,quota_bytes) VALUES($1,$2,$3,'Actual rooted files','native',$4,$5,$6,$6,$7,'active',$8)",[workspace.id,owner,project,host.machine_id,workspace.approved_root_id,workspace.root,workspace.revision,workspace.quota_bytes]);
 await db.query("INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)",[grantId,owner,JSON.stringify(['file.read','file.write','project.export','workspace.reconcile']),JSON.stringify([host.machine_id]),JSON.stringify([workspace.id])]);
 const grant=(await db.query('SELECT * FROM permission_grants WHERE id=$1',[grantId])).rows[0];
 const generations={[host.machine_id]:host.generation};
 await db.query("INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,kind,state,dispatch_epoch,workspace_id,payload,modifies_workspace) VALUES($1::uuid,$2,$1::text,'explicit-historical-fixture','project_export','queued',$3,$4,$5::jsonb,true)",[oldJob,owner,oldEpoch,workspace.id,JSON.stringify({workspace_id:workspace.id,workspace_revision:workspace.revision,machine_identity_generations:generations,grant})]);
 await db.query("INSERT INTO agent_rpc_requests(id,machine_id,request_hash,method,path,body,authorization_json,created_at,expires_at,dispatch_epoch,machine_identity_generation) VALUES($1,$2,'explicit-historical-fixture','GET','/v1/health','null','{}',now(),now()+interval '1 day',$3,$4)",[oldRpc,host.machine_id,oldEpoch,host.generation]);
 await db.query('COMMIT');
 const control=(await db.query('SELECT dispatch_epoch FROM runtime_control WHERE singleton')).rows[0];
 const proof={project_id:project,workspace_id:workspace.id,machine_id:host.machine_id,machine_generation:host.generation,grant_id:grantId,old_job_id:oldJob,old_rpc_id:oldRpc,historical_epoch:oldEpoch,current_epoch:control.dispatch_epoch};
 await writeFile(root+'/db-fixture.json',JSON.stringify(proof,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({status:'SEEDED',workspace_id:workspace.id,machine_id:host.machine_id,historical_delivery_count:0}));
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
