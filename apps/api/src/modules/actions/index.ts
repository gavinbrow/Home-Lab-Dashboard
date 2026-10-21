import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../../core/context.js';
import { ActionDefinitionSchema, canonicalHash } from './definition.js';
import { ActionSelectionSchema, resolveAuthorizedAction } from '@homelab/actions';
import { submitJobInTransaction } from '@homelab/worker';

const id=z.uuid();
const create=z.object({name:z.string().min(1).max(160),definition:ActionDefinitionSchema}).strict();
const revision=z.object({expected_revision:z.number().int().positive(),definition:ActionDefinitionSchema}).strict();
const run=ActionSelectionSchema;
const failure=(code:string,message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode,code});
const capability=(configured:boolean,permitted:boolean,lastTest:string|null)=>{
  const observed=lastTest&&Number.isFinite(Date.parse(lastTest))?lastTest:null;
  const state=!configured?'unconfigured':!permitted?'permission_denied':!observed?'unverified':Date.now()-Date.parse(observed)>300000?'stale':'healthy';
  return {supported:true,configured,permitted,health_state:state,observed_at:observed,last_test_at:observed,last_success_at:observed,reason:state==='unconfigured'?'Enroll a protected host helper target or restricted workspace runner':state==='permission_denied'?'An active actions.run scope grant is required':state==='unverified'?'Configured integration has not completed a host helper test':state==='stale'?'Last host helper evidence is older than five minutes':null};
};
const targetSchema=z.object({id:z.uuid(),machine_id:z.uuid(),name:z.string().min(1).max(160),kind:z.enum(['systemd','windows_service','docker_container']),allowed_operations:z.array(z.enum(['status','logs','start','stop','restart'])).min(1).max(5)}).strict();

export default async function register(app:FastifyInstance,context:ApiContext):Promise<void> {
  // Authentication, CSRF and Origin are enforced by the parent /api/v1 scope.
  app.get('/actions/targets',async request=>({items:(await context.db.query('SELECT id,machine_id,name,kind,config,created_at FROM service_targets WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200',[request.actor!.id])).rows}));
  app.post('/actions/targets',async(request,reply)=>{
    const body=targetSchema.parse(request.body),owner=request.actor!.id;
    try {
      if(!(await context.db.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2',[body.machine_id,owner])).rows.length) throw failure('machine_denied','Machine unavailable',403);
      const config={allowed_operations:body.allowed_operations,enrollment_state:'unverified',reason:'Must match a separately enrolled protected host target'};
      await context.db.query('INSERT INTO service_targets(id,owner_id,machine_id,name,kind,config) VALUES($1,$2,$3,$4,$5,$6)',[body.id,owner,body.machine_id,body.name,body.kind,config]);
      await context.audit(owner,'action.target_registered',body.id,'unverified',{machine_id:body.machine_id,kind:body.kind});
      return reply.code(201).send({...body,config});
    } catch(error) {
      await context.audit(owner,'action.target_registered',body.id,'denied',{machine_id:body.machine_id});
      if((error as {code?:string}).code==='23505') throw failure('target_conflict','Target identifier is already registered',409);
      throw error;
    }
  });
  app.get('/actions',async request=>({items:(await context.db.query('SELECT a.*, r.definition FROM saved_actions a JOIN saved_action_revisions r ON r.action_id=a.id AND r.revision=a.current_revision WHERE a.owner_id=$1 ORDER BY a.created_at DESC LIMIT 200',[request.actor!.id])).rows}));
  app.post('/actions',async(request,reply)=>{
    const body=create.parse(request.body), actionId=randomUUID();
    const client=await context.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO saved_actions(id,owner_id,name,current_revision) VALUES($1,$2,$3,1)',[actionId,request.actor!.id,body.name]);
      await client.query('INSERT INTO saved_action_revisions(action_id,revision,definition) VALUES($1,1,$2)',[actionId,body.definition]);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    await context.audit(request.actor!.id,'action.created',actionId,'success',{revision:1});
    return reply.code(201).send({id:actionId,name:body.name,current_revision:1,definition:body.definition});
  });
  app.get('/actions/:id/revisions',async request=>{
    const actionId=id.parse((request.params as {id:string}).id);
    return {items:(await context.db.query('SELECT r.* FROM saved_action_revisions r JOIN saved_actions a ON a.id=r.action_id WHERE a.id=$1 AND a.owner_id=$2 ORDER BY r.revision DESC LIMIT 200',[actionId,request.actor!.id])).rows};
  });
  app.post('/actions/:id/revisions',async(request,reply)=>{
    const actionId=id.parse((request.params as {id:string}).id), body=revision.parse(request.body);
    const client=await context.db.connect();
    try {
      await client.query('BEGIN');
      const update=await client.query('UPDATE saved_actions SET current_revision=current_revision+1 WHERE id=$1 AND owner_id=$2 AND current_revision=$3 RETURNING current_revision',[actionId,request.actor!.id,body.expected_revision]);
      if(!update.rows.length) throw failure('revision_conflict','Action missing or modified; reload before adding a revision',409);
      const next=update.rows[0].current_revision as number;
      await client.query('INSERT INTO saved_action_revisions(action_id,revision,definition) VALUES($1,$2,$3)',[actionId,next,body.definition]);
      await client.query('COMMIT');
      await context.audit(request.actor!.id,'action.revised',actionId,'success',{revision:next});
      return reply.code(201).send({action_id:actionId,revision:next,definition:body.definition});
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  });
  app.get('/actions/:id/runs',async request=>{
    const actionId=id.parse((request.params as {id:string}).id);
    return {items:(await context.db.query("SELECT id,state,reason,created_at,started_at,ended_at,payload->'verification' AS verification_requested,result FROM jobs WHERE requester_id=$1 AND kind='saved_action' AND payload->>'action_id'=$2 ORDER BY created_at DESC LIMIT 200",[request.actor!.id,actionId])).rows};
  });
  app.get('/actions/capabilities',async request=>{
    const owner=request.actor!.id;
    const targets=(await context.db.query('SELECT kind,config FROM service_targets WHERE owner_id=$1',[owner])).rows;
    const runners=(await context.db.query('SELECT capabilities FROM machines WHERE owner_id=$1',[owner])).rows;
    const permitted=(await context.db.query("SELECT id FROM permission_grants WHERE owner_id=$1 AND tools ? 'actions.run' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) LIMIT 1",[owner])).rows.length>0;
    const latest=(items:typeof targets)=>items.map(t=>t.config.helper_verified_at).filter((v):v is string=>typeof v==='string').sort().at(-1)??null;
    const services=targets.filter(t=>['systemd','windows_service'].includes(t.kind)),containers=targets.filter(t=>t.kind==='docker_container');
    const runnerTest=runners.map(r=>r.capabilities?.runner).filter(r=>r?.health_state==='healthy').map(r=>r.last_success_at as string).filter(Boolean).sort().at(-1)??null;
    return {saved_actions:capability(targets.length>0||runners.some(r=>r.capabilities?.runner?.configured),permitted,latest(targets)??runnerTest),service_controls:capability(services.length>0,permitted,latest(services)),container_controls:capability(containers.length>0,permitted,latest(containers))};
  });
  app.post('/actions/:id/runs',async(request,reply)=>{
    const actionId=id.parse((request.params as {id:string}).id), body=run.parse(request.body), actor=request.actor!;
    try {
      const payload=await resolveAuthorizedAction(context.db,actor.id,actionId,body);
      const client=await context.db.connect();
      let job;
      try {
        await client.query('BEGIN');
        const hash=canonicalHash({action_id:actionId,...body});
        // The unique dispatch row serializes simultaneous requests before enqueueing.
        await client.query('INSERT INTO action_dispatches(id,owner_id,action_id,action_revision,idempotency_key,request_hash,request) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',[randomUUID(),actor.id,actionId,body.revision,body.idempotency_key,hash,body]);
        const dispatch=(await client.query('SELECT request_hash,job_id FROM action_dispatches WHERE owner_id=$1 AND idempotency_key=$2 FOR UPDATE',[actor.id,body.idempotency_key])).rows[0];
        if(dispatch.request_hash!==hash) throw failure('idempotency_conflict','Idempotency key already identifies another action request',409);
        if(dispatch.job_id) job=(await client.query('SELECT * FROM jobs WHERE id=$1 AND requester_id=$2',[dispatch.job_id,actor.id])).rows[0];
        else {
          job=await submitJobInTransaction(client,{requester_id:actor.id,idempotency_key:`action:${body.idempotency_key}`,context:null,workspace_id:body.workspace_id,kind:'saved_action',payload,modifies_workspace:Boolean(body.workspace_id)});
          await client.query('UPDATE action_dispatches SET job_id=$1 WHERE owner_id=$2 AND idempotency_key=$3',[job.id,actor.id,body.idempotency_key]);
        }
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
      await context.audit(actor.id,'action.submitted',actionId,'queued',{revision:body.revision,machine_id:body.machine_id,workspace_id:body.workspace_id,verification:'not_run'});
      return reply.code(202).send(job);
    } catch(error) {
      await context.audit(actor.id,'action.submitted',actionId,'denied',{reason:error instanceof Error?error.message:'Action denied'});
      if(error instanceof Error && !('statusCode' in error) && /^(action_|parameter_)/.test(error.message)) throw failure('action_scope_or_parameters_invalid',error.message,403);
      throw error;
    }
  });
}

