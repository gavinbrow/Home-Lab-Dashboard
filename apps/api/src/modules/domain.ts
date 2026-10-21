import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IdSchema,ProfileDefinitionSchema,getContractJsonSchemas } from '@homelab/contracts';
import type { ApiModule } from '../core/context.js';
import { HttpError } from '../core/errors.js';
const definition=ProfileDefinitionSchema;
const register:ApiModule=async(app,context)=>{
 app.get('/contracts',async()=>getContractJsonSchemas());
 async function ownedDefinition(owner:string,value:z.infer<typeof definition>){
  for(const [table,ids]of [['machines',value.machine_ids],['workspaces',value.workspace_ids],['execution_identities',value.execution_identity_ids],['secrets',value.secret_ids]]as const){if(ids.length){const rows=await context.db.query(`SELECT id FROM ${table} WHERE owner_id=$1 AND id=ANY($2::uuid[])`,[owner,ids]);if(rows.rowCount!==new Set(ids).size)throw new HttpError(403,'profile_resource_denied','Profile resources must belong to owner');}}
  const providers=[...new Set([...value.allowed_models.map(model=>model.provider_id),...(value.default_provider_id?[value.default_provider_id]:[])])];
  if(providers.length&&(await context.db.query('SELECT id FROM providers WHERE owner_id=$1 AND id=ANY($2::uuid[])',[owner,providers])).rowCount!==providers.length)throw new HttpError(403,'profile_provider_denied','Profile providers must belong to owner');
  if(value.required_verification&&!value.verification_commands.length)throw new HttpError(400,'verification_required','Required verification needs at least one configured command');
 }
 app.get('/activity',async(request)=>({items:(await context.db.query('SELECT id,action,target,outcome,details,created_at FROM audit_events WHERE actor_id=$1 ORDER BY id DESC LIMIT 200',[request.actor!.id])).rows}));
 app.get('/settings/runtime',async()=>{
  const row=(await context.db.query('SELECT dispatch_enabled,dispatch_epoch,restore_mode,maintenance_mode,max_concurrent_jobs FROM runtime_control WHERE singleton=true')).rows[0];
  return {...row,deployment_dispatch_enabled:context.config.dispatchEnabled,deployment_restore_mode:context.config.restoreMode,agent_transport_configured:!!context.agentBroker?.signer};
 });
 app.patch('/settings/runtime',async(request)=>{
  const body=z.object({expected_dispatch_epoch:IdSchema,max_concurrent_jobs:z.number().int().min(1).max(64),dispatch_enabled:z.boolean()}).strict().parse(request.body);
  if(body.dispatch_enabled&&(!context.config.dispatchEnabled||context.config.restoreMode))throw new HttpError(409,'deployment_dispatch_disabled','Enable dispatch in protected deployment configuration after completing restore reconciliation');
  const row=(await context.db.query('UPDATE runtime_control SET max_concurrent_jobs=$1,dispatch_enabled=$2 WHERE singleton=true AND dispatch_epoch=$3 AND restore_mode=false AND maintenance_mode=false RETURNING dispatch_enabled,dispatch_epoch,restore_mode,maintenance_mode,max_concurrent_jobs',[body.max_concurrent_jobs,body.dispatch_enabled,body.expected_dispatch_epoch])).rows[0];
  if(!row)throw new HttpError(409,'runtime_control_conflict','Runtime epoch changed or maintenance/recovery is active');await context.audit(request.actor!.id,'runtime.configure',body.expected_dispatch_epoch,'success',{max_concurrent_jobs:body.max_concurrent_jobs,dispatch_enabled:body.dispatch_enabled});return row;
 });
 app.get('/agent-rpcs/:id',async(request)=>{
  const {id}=z.object({id:IdSchema}).parse(request.params);
  const row=(await context.db.query('SELECT r.id,r.machine_id,r.method,r.path,r.created_at,r.expires_at,r.dispatch_epoch,r.state,r.delivery_count,r.response_status,r.responded_at FROM agent_rpc_requests r JOIN machines m ON m.id=r.machine_id WHERE r.id=$1 AND m.owner_id=$2',[id,request.actor!.id])).rows[0];
  if(!row)throw new HttpError(404,'not_found','Host request unavailable');return row;
 });
 app.get('/execution-identities',async(request)=>{
  const query=z.object({machine_id:IdSchema.optional()}).parse(request.query);
  return {items:(await context.db.query('SELECT id,machine_id,name,os_identity,restriction_verified,config,created_at FROM execution_identities WHERE owner_id=$1 AND ($2::uuid IS NULL OR machine_id=$2) ORDER BY created_at DESC LIMIT 200',[request.actor!.id,query.machine_id??null])).rows};
 });
 app.post('/execution-identities',async(request,reply)=>{
  const body=z.object({machine_id:IdSchema,host_identity_id:IdSchema,name:z.string().min(1).max(120)}).strict().parse(request.body),owner=request.actor!.id;
  if(!(await context.db.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2',[body.machine_id,owner])).rowCount)throw new HttpError(404,'not_found','Machine unavailable');
  if(!context.agentBroker)throw new HttpError(503,'relay_unconfigured','Agent transport is not configured');
  const response=await context.agentBroker.rpc(body.machine_id,'GET','/v1/identities',null,{ownerId:owner}) as {items?:unknown[]}|unknown[];
  const records=Array.isArray(response)?response:response.items;
  const identity=z.object({id:IdSchema,os_identity:z.string().min(1),restriction_verified:z.boolean(),config:z.record(z.string(),z.unknown()).optional()}).passthrough().parse(records?.find(value=>typeof value==='object'&&value!==null&&(value as {id?:string}).id===body.host_identity_id));
  const row=(await context.db.query('INSERT INTO execution_identities(id,owner_id,machine_id,name,os_identity,restriction_verified,config)VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO UPDATE SET name=$4,os_identity=$5,restriction_verified=$6,config=$7::jsonb WHERE execution_identities.owner_id=$2 AND execution_identities.machine_id=$3 RETURNING id,machine_id,name,os_identity,restriction_verified,config',[identity.id,owner,body.machine_id,body.name,identity.os_identity,identity.restriction_verified,JSON.stringify(identity.config??{})])).rows[0];
  if(!row)throw new HttpError(409,'identity_conflict','Execution identity is registered to another resource');await context.audit(owner,'identity.register',identity.id,'success');return reply.code(201).send(row);
 });
 app.get('/grants',async(request)=>({items:(await context.db.query('SELECT * FROM permission_grants WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200',[request.actor!.id])).rows}));
 app.post('/grants',async(request,reply)=>{
  const body=z.object({tools:z.array(z.string().min(1).max(100)).max(100),machine_ids:z.array(IdSchema).max(100),workspace_ids:z.array(IdSchema).max(100),profile_ids:z.array(IdSchema).max(100).default([]),secret_ids:z.array(IdSchema).max(100).default([]),expires_at:z.iso.datetime().nullable().default(null)}).strict().parse(request.body),owner=request.actor!.id;
  if(body.expires_at&&Date.parse(body.expires_at)<=Date.now())throw new HttpError(400,'invalid_expiry','Grant expiry must be in the future');
  for(const [table,ids]of [['machines',body.machine_ids],['workspaces',body.workspace_ids],['agent_profiles',body.profile_ids],['secrets',body.secret_ids]] as const){if(ids.length){const owned=await context.db.query(`SELECT id FROM ${table} WHERE owner_id=$1 AND id=ANY($2::uuid[])`,[owner,ids]);if(owned.rows.length!==new Set(ids).size)throw new HttpError(403,'scope_denied','All grant resources must belong to owner');}}
  const id=randomUUID();await context.db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids,profile_ids,secret_ids,expires_at)VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8)',[id,owner,JSON.stringify(body.tools),JSON.stringify(body.machine_ids),JSON.stringify(body.workspace_ids),JSON.stringify(body.profile_ids),JSON.stringify(body.secret_ids),body.expires_at]);await context.audit(owner,'grant.create',id,'success');return reply.code(201).send((await context.db.query('SELECT * FROM permission_grants WHERE id=$1',[id])).rows[0]);
 });
 app.post('/grants/:id/revoke',async(request)=>{const {id}=z.object({id:IdSchema}).parse(request.params);const result=await context.db.query('UPDATE permission_grants SET revoked_at=now(),revision=revision+1 WHERE id=$1 AND owner_id=$2 RETURNING *',[id,request.actor!.id]);if(!result.rows[0])throw new HttpError(404,'not_found','Grant unavailable');await context.audit(request.actor!.id,'grant.revoke',id,'success');return result.rows[0];});
 app.get('/secrets',async(request)=>({items:(await context.db.query('SELECT id,name,version,created_at FROM secrets WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200',[request.actor!.id])).rows}));
 app.post('/secrets',async(request,reply)=>{const body=z.object({name:z.string().min(1).max(120),value:z.string().min(1).max(1048576)}).strict().parse(request.body),id=await context.secrets.put(request.actor!.id,body.name,body.value);await context.audit(request.actor!.id,'secret.create',id,'success');return reply.code(201).send({id,name:body.name,configured:true});});
 app.post('/secrets/:id/rotate',async(request)=>{
  const {id}=z.object({id:IdSchema}).parse(request.params),body=z.object({value:z.string().min(1).max(1048576),expected_version:z.number().int().positive()}).strict().parse(request.body);
  if(!context.secrets.rotate)throw new HttpError(503,'secret_store_unavailable','Credential rotation is unavailable');
  const version=await context.secrets.rotate(request.actor!.id,id,body.value,body.expected_version);await context.audit(request.actor!.id,'secret.rotate',id,'success',{version});return {id,version,configured:true};
 });
 app.get('/secrets/:id/versions',async(request)=>{
  const {id}=z.object({id:IdSchema}).parse(request.params);
  if(!(await context.db.query('SELECT id FROM secrets WHERE id=$1 AND owner_id=$2',[id,request.actor!.id])).rowCount)throw new HttpError(404,'not_found','Credential unavailable');
  return {items:(await context.db.query('SELECT version,created_at FROM secret_versions WHERE secret_id=$1 ORDER BY version DESC',[id])).rows};
 });
 app.get('/profiles',async(request)=>({items:(await context.db.query('SELECT p.*,r.instructions,r.definition FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=p.current_revision WHERE owner_id=$1 ORDER BY p.created_at DESC LIMIT 200',[request.actor!.id])).rows}));
 app.post('/profiles',async(request,reply)=>{
  const body=z.object({name:z.string().min(1).max(120),definition}).parse(request.body);await ownedDefinition(request.actor!.id,body.definition);const id=randomUUID(),client=await context.db.connect();
  try{await client.query('BEGIN');await client.query('INSERT INTO agent_profiles(id,owner_id,name)VALUES($1,$2,$3)',[id,request.actor!.id,body.name]);await client.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition)VALUES($1,1,$2,$3::jsonb)',[id,body.definition.instructions,JSON.stringify(body.definition)]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  await context.audit(request.actor!.id,'profile.create',id,'success');return reply.code(201).send({id,name:body.name,current_revision:1,definition:body.definition});
 });
 app.get('/profiles/:id/revisions',async(request)=>{const {id}=z.object({id:IdSchema}).parse(request.params);return {items:(await context.db.query('SELECT r.* FROM agent_profile_revisions r JOIN agent_profiles p ON p.id=r.profile_id WHERE p.id=$1 AND p.owner_id=$2 ORDER BY r.revision DESC',[id,request.actor!.id])).rows};});
 app.post('/profiles/:id/revisions',async(request,reply)=>{
  const {id}=z.object({id:IdSchema}).parse(request.params),body=z.object({expected_revision:z.number().int().positive(),definition}).parse(request.body);await ownedDefinition(request.actor!.id,body.definition);const client=await context.db.connect();
  try{await client.query('BEGIN');const result=await client.query('UPDATE agent_profiles SET current_revision=current_revision+1 WHERE id=$1 AND owner_id=$2 AND current_revision=$3 AND archived_at IS NULL RETURNING current_revision',[id,request.actor!.id,body.expected_revision]);if(!result.rows[0])throw new HttpError(409,'revision_conflict','Profile changed or unavailable');const revision=result.rows[0].current_revision;await client.query('INSERT INTO agent_profile_revisions(profile_id,revision,instructions,definition)VALUES($1,$2,$3,$4::jsonb)',[id,revision,body.definition.instructions,JSON.stringify(body.definition)]);await client.query('COMMIT');await context.audit(request.actor!.id,'profile.revise',id,'success');return reply.code(201).send({profile_id:id,revision,definition:body.definition});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
 app.post('/profiles/:id/archive',async(request)=>{const {id}=z.object({id:IdSchema}).parse(request.params);const result=await context.db.query('UPDATE agent_profiles SET archived_at=now() WHERE id=$1 AND owner_id=$2 RETURNING id',[id,request.actor!.id]);if(!result.rows[0])throw new HttpError(404,'not_found','Profile unavailable');await context.audit(request.actor!.id,'profile.archive',id,'success');return {id,archived:true};});
};
export default register;
