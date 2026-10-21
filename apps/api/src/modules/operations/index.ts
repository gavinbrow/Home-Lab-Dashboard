import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {ApiContext} from '../../core/context.js';
import {HttpError} from '../../core/errors.js';
import {submitJob} from '@homelab/worker';
import {captureMachineGenerations} from '@homelab/worker/authority';
import {configuredDestinations,publicRun} from './config.js';
const id=z.uuid();
export default async function register(app:FastifyInstance,context:ApiContext){
 app.get('/backups/readiness',async request=>{
  let configuration:Awaited<ReturnType<typeof configuredDestinations>>=null;
  let configurationStatus='unconfigured';
  try{configuration=await configuredDestinations();if(configuration)configurationStatus='configured';}catch{configurationStatus='invalid_protected_configuration';}
  const control=(await context.db.query('SELECT dispatch_enabled,restore_mode,maintenance_mode FROM runtime_control WHERE singleton')).rows[0];
  const destinations=(await context.db.query('SELECT id,name,kind,repository_ref,enabled FROM backup_destinations WHERE owner_id=$1 ORDER BY created_at',[request.actor!.id])).rows;
  const configured=destinations.filter(row=>row.enabled&&configuration?.destinations[row.repository_ref]);
  const latest=(await context.db.query("SELECT id,status,manifest,created_at,completed_at FROM backup_runs WHERE owner_id=$1 AND status='complete' ORDER BY completed_at DESC NULLS LAST LIMIT 1",[request.actor!.id])).rows[0];
  const reasons=[...(!configuration?['backup_destination_unconfigured']:[]),...(!configured.length?['no_enabled_destination']:[]),...(!control?.dispatch_enabled?['worker_dispatch_disabled']:[]),...(control?.restore_mode?['restore_reconciliation_required']:[]),...(control?.maintenance_mode?['maintenance_active']:[])];
  return {available:reasons.length===0,configuration_status:configurationStatus,reasons,
   configured_destinations:Object.entries(configuration?.destinations??{}).map(([reference,value])=>({reference,label:value.label,separate_device:value.separate_device})),
   destinations:destinations.map(row=>({id:row.id,name:row.name,kind:row.kind,enabled:row.enabled,configured:!!configuration?.destinations[row.repository_ref]})),
   last_complete:latest?publicRun(latest):null,restore:{mode:control?.restore_mode===true,dispatch_disabled:control?.dispatch_enabled!==true,host_reconciliation:'requires_recorded_evidence',procedure:'protected_local_cli'}};
 });
 for(const [route,table]of [['backups','backup_runs'],['restores','restore_runs']]as const){
  app.get('/'+route,async request=>{const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(request.query);return {items:(await context.db.query(`SELECT * FROM ${table} WHERE owner_id=$1 ORDER BY created_at DESC LIMIT $2`,[request.actor!.id,query.limit])).rows.map(publicRun)};});
  app.get('/'+route+'/:id',async request=>{const run=(await context.db.query(`SELECT * FROM ${table} WHERE id=$1 AND owner_id=$2`,[id.parse((request.params as {id:string}).id),request.actor!.id])).rows[0];if(!run)throw new HttpError(404,'not_found','Recovery record unavailable');return publicRun(run);});
 }
 app.post('/backup-destinations',async(request,reply)=>{
  const body=z.object({name:z.string().min(1).max(200),repository_ref:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),enabled:z.boolean().default(false)}).strict().parse(request.body);
  const configured=await configuredDestinations();if(!configured?.destinations[body.repository_ref])throw new HttpError(409,'destination_not_configured','A local administrator must first configure this destination');
  const destinationId=randomUUID();
  await context.db.query("INSERT INTO backup_destinations(id,owner_id,name,kind,repository_ref,enabled) VALUES($1,$2,$3,'restic-local',$4,$5)",[destinationId,request.actor!.id,body.name,body.repository_ref,body.enabled]);
  await context.audit(request.actor!.id,'backup.destination.register',destinationId,'success');return reply.code(201).send({id:destinationId,name:body.name,enabled:body.enabled,configured:true});
 });
 app.post('/backups',async(request,reply)=>{
  const body=z.object({destination_id:id,idempotency_key:z.string().min(1).max(200)}).strict().parse(request.body);
  const destination=(await context.db.query('SELECT id,repository_ref FROM backup_destinations WHERE id=$1 AND owner_id=$2 AND enabled',[body.destination_id,request.actor!.id])).rows[0];
  if(!destination)throw new HttpError(404,'destination_unavailable','Enabled backup destination unavailable');
  const configured=await configuredDestinations();if(!configured?.destinations[destination.repository_ref])throw new HttpError(409,'destination_not_configured','Protected destination configuration unavailable');
  const machineIds=(await context.db.query('SELECT id FROM machines WHERE owner_id=$1 ORDER BY id',[request.actor!.id])).rows.map(row=>row.id);
  const machine_identity_generations=await captureMachineGenerations(context.db,request.actor!.id,machineIds);
  const job=await submitJob(context.db,{requester_id:request.actor!.id,idempotency_key:'backup:'+body.idempotency_key,kind:'operations.backup',context:null,payload:{destination_id:body.destination_id,machine_identity_generations},modifies_workspace:false});
  await context.audit(request.actor!.id,'backup.submit',job.id,'accepted',{destination_id:body.destination_id});
  return reply.code(202).send({id:job.id,state:job.state,backup_id:job.id});
 });
}
