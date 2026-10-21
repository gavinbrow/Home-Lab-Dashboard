import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access,mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AgentBroker} from '@homelab/transport';
import type {JobHandler} from '../../../../worker/src/runtime.js';
import {configuredDestinations} from './config.js';
import {withBackupLease,acquireBackupCut} from './lease.js';
import {captureHostBundle,type HostCapture} from './host-capture.js';
type Gap={code:string;workspace_id?:string;machine_id?:string};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const backupScript=fileURLToPath(new URL('../../../../../deploy/backup.py',import.meta.url));
function stableId(job:string,scope:string){const bytes=createHash('sha256').update(job+':'+scope).digest().subarray(0,16);bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
async function exists(path:string){try{await access(path);return true;}catch{return false;}}
function safePath(path:string){if(path.length>4096||path.startsWith('/')||/[\\:\x00<>"|?*]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?$/i.test(part)))throw new Error('unsafe_host_snapshot_path');return path;}
export async function materializeSnapshot(snapshot:any,target:string){
 if(!Array.isArray(snapshot?.files)||snapshot.files.length>100000)throw new Error('invalid_host_snapshot');
 const seen=new Set<string>();let total=0;
 for(const file of snapshot.files){const path=safePath(file.entry.path);if(seen.has(path.toLowerCase()))throw new Error('conflicting_host_snapshot_path');seen.add(path.toLowerCase());if(!['file','directory'].includes(file.entry.kind))throw new Error('unsupported_host_snapshot_entry');if(file.entry.kind==='file'){const bytes=Buffer.from(file.bytes??'','base64');total+=bytes.length;if(total>64*1024*1024||bytes.length!==Number(file.entry.size_bytes)||hash(bytes)!==file.entry.sha256)throw new Error('host_snapshot_integrity_failed');}}
 const pending=target+'.pending-'+randomUUID();await mkdir(pending,{recursive:false,mode:0o700});
 for(const file of snapshot.files){const path=join(pending,safePath(file.entry.path));if(file.entry.kind==='directory')await mkdir(path,{recursive:true,mode:0o700});else{await mkdir(resolve(path,'..'),{recursive:true,mode:0o700});await writeFile(path,Buffer.from(file.bytes??'','base64'),{flag:'wx',mode:0o600});}}
 await rename(pending,target);
}
async function tool(command:string,args:string[],options:{env?:NodeJS.ProcessEnv;signal?:AbortSignal;output?:string;allowIncomplete?:boolean}={}){
 return new Promise<{code:number;stdout:string}>((resolveResult,reject)=>{
  const child=spawn(command,args,{env:options.env??process.env,detached:process.platform!=='win32',shell:false,stdio:['ignore','pipe','pipe']});
  const terminate=()=>{if(!child.pid)return;try{if(process.platform==='win32'){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{shell:false,stdio:'ignore'});killer.on('error',()=>child.kill());}else process.kill(-child.pid,'SIGTERM');}catch{/* already exited */}};
  options.signal?.addEventListener('abort',terminate,{once:true});
  if(options.signal?.aborted)terminate();
  let stdout='',stderr='';const output=options.output?createWriteStream(options.output,{flags:'wx',mode:0o600}):null;
  if(output){child.stdout.pipe(output);output.on('error',()=>{terminate();reject(new Error('backup_output_failed'));});}else child.stdout.on('data',chunk=>{if(stdout.length<2*1024*1024)stdout+=chunk;else terminate();});
  child.stderr.on('data',chunk=>{if(stderr.length<16384)stderr+=chunk;});
  child.on('error',()=>{options.signal?.removeEventListener('abort',terminate);reject(new Error('backup_tool_unavailable'));});
  child.on('close',code=>{options.signal?.removeEventListener('abort',terminate);const finish=()=>{if(code===0||(code===2&&options.allowIncomplete))resolveResult({code:code??1,stdout});else reject(new Error('backup_tool_failed'));};if(output&&!output.writableFinished)output.once('finish',finish);else finish();});
 });
}
function pgEnvironment(url:string){const parsed=new URL(url);if(!['postgres:','postgresql:'].includes(parsed.protocol))throw new Error('invalid_database_configuration');return {...process.env,PGHOST:parsed.hostname,PGPORT:parsed.port||'5432',PGUSER:decodeURIComponent(parsed.username),PGPASSWORD:decodeURIComponent(parsed.password),PGDATABASE:parsed.pathname.slice(1)};}

export function createBackupHandler(dependencies:{broker:AgentBroker}):JobHandler{return async(job,runtime)=>{
 const generations=job.payload.machine_identity_generations as Record<string,string>|undefined;
 const destination=(await runtime.db.query('SELECT * FROM backup_destinations WHERE id=$1 AND owner_id=$2 AND enabled',[job.payload.destination_id,job.requester_id])).rows[0];
 const configured=await configuredDestinations();const config=destination&&configured?.destinations[destination.repository_ref];
 if(!config){await runtime.fail('backup_destination_unavailable');return;}
 const prior=(await runtime.db.query('SELECT * FROM backup_runs WHERE job_id=$1 AND owner_id=$2',[job.id,job.requester_id])).rows[0];
 if(prior&&['complete','incomplete'].includes(prior.status)){await runtime.complete({backup_id:prior.id,status:prior.status});return;}
 await mkdir(config.staging_root,{recursive:true,mode:0o700});
 // A reclaimed lease gets a wholly new cut: never combine old dump/project bytes
 // with a replacement attempt's inventory or trust evidence.
 const runRoot=join(config.staging_root,job.id,String(job.fence));
 await withBackupLease(runtime.db,job,false,client=>client.query("INSERT INTO backup_runs(id,owner_id,job_id,status,manifest,started_at) VALUES($1,$2,$1,'preparing','{}',now()) ON CONFLICT(job_id) DO NOTHING",[job.id,job.requester_id]));
 let acquired=false;
 let cancellationRequested=false;
 const stop=new AbortController(),loseLease=()=>stop.abort();
 runtime.signal.addEventListener('abort',loseLease,{once:true});
 const cancellation=setInterval(()=>{void runtime.cancelled().then(cancel=>{if(cancel){cancellationRequested=true;stop.abort();}}).catch(()=>stop.abort());},500);
 const check=async()=>{await runtime.assertLease();if(await runtime.cancelled()){cancellationRequested=true;stop.abort();throw new Error('backup_cancelled');}};
 const gaps:Gap[]=[];const components:any[]=[];
 const update=async(phase:string,extra:Record<string,unknown>={})=>{await withBackupLease(runtime.db,job,false,client=>client.query('UPDATE backup_runs SET status=$2,manifest=$3::jsonb WHERE id=$1 AND owner_id=$4',[job.id,phase,JSON.stringify({schema_version:1,phase,backup_set_id:job.id,gaps,components,...extra}),job.requester_id]));await runtime.appendEvent('backup.phase',{phase,backup_id:job.id,gaps: gaps.length});};
 const release=async()=>{await withBackupLease(runtime.db,job,true,client=>client.query('UPDATE runtime_control SET maintenance_mode=false,maintenance_job_id=NULL WHERE singleton AND maintenance_job_id=$1',[job.id]));acquired=false;};
 try{
  await check();
  if(!await acquireBackupCut(runtime.db,job)){await runtime.wait('backup_writers_active_or_maintenance_busy',5);return;}acquired=true;
  await mkdir(runRoot,{recursive:true,mode:0o700});
  // A backup must not extend closed terminal delivery payload retention. IDs,
  // request/response hashes, outcomes and idempotency metadata remain durable.
  while(await dependencies.broker.expireTerminalPayloads(true)>0)await check();
  await update('capturing');
  const unsettled=(await runtime.db.query("SELECT DISTINCT machine_id FROM operations WHERE status NOT IN ('succeeded','failed','cancelled','rejected')")).rows;
  const activeMachines=new Set(unsettled.map(row=>row.machine_id));
  if(activeMachines.size)gaps.push({code:'unresolved_operations_at_backup_cut'});
  const workspaces=(await runtime.db.query("SELECT id,machine_id,canonical_root,state FROM workspaces WHERE owner_id=$1 AND state<>'unregistered' ORDER BY id",[job.requester_id])).rows;
  const machines=(await runtime.db.query('SELECT id,name FROM machines WHERE owner_id=$1 ORDER BY id',[job.requester_id])).rows;
  const add=(item:any)=>{components.push({...item,required:true,capture_evidence:'durable_backup_worker',consistent:item.consistent===true});};
  const hostBundles:HostCapture[]=[],fullMachines=new Set<string>();
  for(const machine of machines){
   await check();
   try{
    if(activeMachines.has(machine.id))throw new Error('host_has_unresolved_writers');
    const operationId=stableId(job.id,job.fence+':host-state:'+machine.id);
    const bundle=await captureHostBundle({operationId,backupSetId:job.id,target:join(runRoot,'host-'+machine.id+'.age'),signal:stop.signal,check,cleanupCheck:()=>runtime.assertLease(),
     rpc:async(method,path,body,scope,mutation)=>dependencies.broker.rpc(machine.id,method,path,body,{ownerId:job.requester_id,expectedMachineGeneration:generations?.[machine.id],requestId:stableId(operationId,scope),maintenanceCapture:mutation,signal:method==='DELETE'?runtime.signal:stop.signal,timeoutMs:90000,jobGuard:{job_id:job.id,lease_owner:job.lease_owner!,fence:job.fence}})});
    hostBundles.push(bundle);
    const capturedRoots=new Set(bundle.coverage.components.filter(component=>(component.kind==='project'||component.role==='project')&&['captured','complete'].includes(component.state.toLowerCase())).map(component=>component.workspace_id));
    const expectedRoots=workspaces.filter(workspace=>workspace.machine_id===machine.id).map(workspace=>workspace.id);
    const journal=bundle.coverage.components.some(component=>(['sqlite','journal','supervisor_sqlite_journal'].includes(component.kind)||(component.id==='supervisor-state'&&component.role==='supervisor_state'))&&['captured','complete'].includes(component.state.toLowerCase()));
    const consistent=bundle.coverage.complete&&bundle.coverage.exclusions.length===0&&journal&&expectedRoots.every(id=>capturedRoots.has(id));
    if(consistent)fullMachines.add(machine.id);else gaps.push({code:'host_state_coverage_incomplete',machine_id:machine.id});
    add({id:'host_'+machine.id,kind:'host-state',source:bundle.path,machine_id:machine.id,workspace_ids:expectedRoots.filter(id=>capturedRoots.has(id)),covers_journal:journal,consistent,coverage:bundle.coverage,encrypted:true});
   }catch{gaps.push({code:'host_state_capture_unavailable',machine_id:machine.id});}
  }
  for(const workspace of workspaces){
   if(fullMachines.has(workspace.machine_id))continue;
   await check();
   const target=join(runRoot,'project-'+workspace.id);let consistent=false;
   try{
    if(activeMachines.has(workspace.machine_id))throw new Error('workspace_operation_unresolved');
    const operationId=stableId(job.id,job.fence+':workspace:'+workspace.id);
    const response:any=await dependencies.broker.rpc(workspace.machine_id,'POST','/v1/backup',{workspace_id:workspace.id,operation_id:operationId},{ownerId:job.requester_id,expectedMachineGeneration:generations?.[workspace.machine_id],requestId:operationId,maintenanceCapture:true,signal:stop.signal,timeoutMs:120000,jobGuard:{job_id:job.id,lease_owner:job.lease_owner!,fence:job.fence}});
    const capture=response?.result??response;if(!capture?.snapshot)throw new Error('host_capture_unavailable');
    if(!await exists(target))await materializeSnapshot(capture.snapshot,target);
    consistent=capture.consistency==='quiesced'&&capture.snapshot.consistency==='quiesced'&&!(capture.snapshot.exclusions?.length);
    if(!consistent)gaps.push({code:'workspace_capture_best_effort',workspace_id:workspace.id,machine_id:workspace.machine_id});
   }catch{gaps.push({code:'workspace_capture_unavailable',workspace_id:workspace.id,machine_id:workspace.machine_id});}
   add({id:'project_'+workspace.id,kind:'project',source:target,workspace_id:workspace.id,machine_id:workspace.machine_id,consistent});
  }
  for(const machine of machines){
   if(fullMachines.has(machine.id))continue;
   await check();
   const target=join(runRoot,'journal-'+machine.id+'.sqlite');let consistent=false;
   try{
    const operationId=stableId(job.id,job.fence+':journal:'+machine.id);
    const response:any=await dependencies.broker.rpc(machine.id,'POST','/v1/journal/backup',{operation_id:operationId},{ownerId:job.requester_id,expectedMachineGeneration:generations?.[machine.id],requestId:operationId,maintenanceCapture:true,signal:stop.signal,timeoutMs:120000,jobGuard:{job_id:job.id,lease_owner:job.lease_owner!,fence:job.fence}});
    const capture=response?.result??response;const bytes=Buffer.from(capture.sqlite_bytes??'','base64');
    if(!bytes.length||bytes.length>128*1024*1024||hash(bytes)!==capture.sha256)throw new Error('host_journal_integrity_failed');
    if(!await exists(target))await writeFile(target,bytes,{flag:'wx',mode:0o600});
    consistent=['sqlite_backup_api','sqlite_vacuum_into'].includes(capture.consistency);
    // Journals do not stand in for identity, local spool or native project metadata.
    if(capture.host_state_complete!==true)gaps.push({code:'host_identity_spool_coverage_incomplete',machine_id:machine.id});
   }catch{gaps.push({code:'host_journal_capture_unavailable',machine_id:machine.id});}
   add({id:'journal_'+machine.id,kind:'sqlite',source:target,machine_id:machine.id,consistent});
  }
  const dump=join(runRoot,'database.dump');
  await check();
  if(!await exists(dump)){const pending=dump+'.pending-'+randomUUID();await tool(process.env.PG_DUMP_BINARY??'pg_dump',['-Fc','--no-owner','--no-acl'],{env:pgEnvironment(process.env.DATABASE_URL!),signal:stop.signal,output:pending});await check();await rename(pending,dump);}
  const inventoryFile=join(runRoot,'database-inventory.json');await writeFile(inventoryFile,JSON.stringify({workspaces,machines}));
  add({id:'database',kind:'postgres',source:dump,consistent:true});
  add({id:'artifacts',kind:'artifacts',source:resolve(process.env.ARTIFACT_ROOT??'data/artifacts'),consistent:!activeMachines.size});
  add({id:'keys',kind:'keys',source:config.key_root,consistent:true});add({id:'caddy_ca',kind:'ca',source:config.ca_root,consistent:true});
  const inventory={backup_set_id:job.id,database_inventory_file:inventoryFile,database_inventory_evidence:'same maintenance cut as custom-format pg_dump',quiescence_evidence:gaps.length?'INCOMPLETE: inspect explicit component gaps':'maintenance cut and quiesced host exports',key_recovery_evidence:'protected configured key escrow capture; restore-use test recorded separately',software_version_evidence:'pinned runtime image and schema_migrations',components};
  const inventoryPath=join(runRoot,'inventory.json');await writeFile(inventoryPath,JSON.stringify(inventory));
  const staged=join(runRoot,'set');const python=process.env.BACKUP_PYTHON_BINARY??'python3';
  if(!await exists(join(staged,'manifest.json')))await tool(python,[backupScript,'stage','--inventory',inventoryPath,'--output',staged],{signal:stop.signal,allowIncomplete:true});
  const stageManifest=JSON.parse(await readFile(join(staged,'manifest.json'),'utf8'));
  if(stageManifest.status!=='STAGED')gaps.push({code:'capture_manifest_incomplete'});
  await update('sealing',{coverage:gaps.length?'incomplete':'complete'});
  const resticEnv={...process.env,RESTIC_REPOSITORY:config.repository,RESTIC_PASSWORD_FILE:config.password_file,RESTIC_BINARY:process.env.RESTIC_BINARY??'restic'};
  const receipt=staged+'.seal.json';
  await check();
  if(!await exists(receipt))await tool(python,[backupScript,'seal',staged,'--receipt',receipt],{env:resticEnv,signal:stop.signal,allowIncomplete:true});
  const sealed=JSON.parse(await readFile(receipt,'utf8'));
  for(const bundle of hostBundles){try{await bundle.ack();}catch{gaps.push({code:'host_capture_ack_pending'});}}
  if(!config.separate_device)gaps.push({code:'separate_device_destination_unverified'});
  const status=gaps.length?'incomplete':'complete';
  await check();
  await withBackupLease(runtime.db,job,false,client=>client.query('UPDATE backup_runs SET status=$2,completed_at=now(),manifest=$3::jsonb WHERE id=$1 AND owner_id=$4',[job.id,status,JSON.stringify({schema_version:1,phase:'finished',backup_set_id:job.id,coverage:status,gaps,components:components.map(({source,...item})=>item),encrypted:true,repository_read_check:'PASS',snapshot_id:sealed.snapshot_id,restore_drill:'NOT RUN'}),job.requester_id]));
  await release();
  await runtime.complete({backup_id:job.id,status,encrypted:true,gaps});
 }catch(error){
  if(runtime.signal.aborted)throw error;
  if(cancellationRequested||await runtime.cancelled()){
   await withBackupLease(runtime.db,job,false,client=>client.query("UPDATE backup_runs SET status='cancelled',completed_at=now(),manifest=jsonb_set(manifest,'{phase}',to_jsonb('cancelled'::text)) WHERE id=$1 AND owner_id=$2",[job.id,job.requester_id]));
   if(acquired)await release();
   await runtime.cancel('backup_cancelled');return;
  }
  await withBackupLease(runtime.db,job,false,client=>client.query("UPDATE backup_runs SET status='failed',completed_at=now(),manifest=jsonb_set(manifest,'{failure}',to_jsonb('backup_pipeline_failed'::text)) WHERE id=$1 AND owner_id=$2",[job.id,job.requester_id]));
  if(acquired)await release();
  await runtime.fail('backup_pipeline_failed');
 }finally{clearInterval(cancellation);runtime.signal.removeEventListener('abort',loseLease);stop.abort();if(acquired)await release();}
};}
