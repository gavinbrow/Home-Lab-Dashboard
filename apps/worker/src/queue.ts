import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RunContext, JsonValue } from "@homelab/contracts";
import { digest } from "./hash.js";
import { transaction } from "./database.js";
import type { JobRow } from "./types.js";
export type { JobRow } from "./types.js";
export interface SubmitJobInput { requester_id:string; idempotency_key:string; context:RunContext|null; workspace_id?:string|null; kind:string; payload:Record<string,unknown>; modifies_workspace:boolean; dispatch_epoch?:string; }
export async function appendEventInTransaction(client:PoolClient, jobId:string, type:string, payload:unknown):Promise<void> {
  await client.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE",[jobId]);
  await client.query(`INSERT INTO job_events(job_id,sequence,type,payload)
    VALUES($1,(SELECT COALESCE(MAX(sequence),0)+1 FROM job_events WHERE job_id=$1),$2,$3::jsonb)`,[jobId,type,JSON.stringify(payload)]);
}
export async function appendEvent(db:Pool,jobId:string,type:string,payload:unknown):Promise<void> {
  await transaction(db,client=>appendEventInTransaction(client,jobId,type,payload));
}
export async function submitJobInTransaction(client:PoolClient,input:SubmitJobInput):Promise<JobRow> {
  if (!input.idempotency_key || input.idempotency_key.length>200) throw Object.assign(new Error("A bounded idempotency key is required"),{statusCode:400});
  const hash=digest({context:input.context,kind:input.kind,payload:input.payload,modifies_workspace:input.modifies_workspace,workspace_id:input.workspace_id??input.context?.workspace_id??null});
  const previous=(await client.query<JobRow>('SELECT * FROM jobs WHERE requester_id=$1 AND idempotency_key=$2',[input.requester_id,input.idempotency_key])).rows[0];
  if(previous){if(previous.request_hash!==hash)throw Object.assign(new Error('Idempotency key reused with different request'),{statusCode:409,code:'idempotency_conflict'});return previous;}
  const captured=(input.payload.machine_identity_generations??{}) as Record<string,string>;
  const workspaceId=input.workspace_id??input.context?.workspace_id??(input.payload.execution_context as {workspace_id?:string}|undefined)?.workspace_id??input.payload.workspace_id;
  const workspaceMachine=workspaceId?(await client.query('SELECT machine_id FROM workspaces WHERE id=$1 AND owner_id=$2',[workspaceId,input.requester_id])).rows[0]?.machine_id:null;
  const required=[input.context?.execution_machine_id,(input.payload.execution_context as {execution_machine_id?:string}|undefined)?.execution_machine_id,input.payload.machine_id,workspaceMachine].filter((value):value is string=>typeof value==='string');
  if(required.some(machine=>!captured[machine]))throw Object.assign(new Error('Machine installation generation was not captured at initial scope resolution'),{code:'machine_generation_not_captured',statusCode:409});
  for(const [machine,generation]of Object.entries(captured).sort(([a],[b])=>a.localeCompare(b))){const row=(await client.query('SELECT identity_generation FROM machines WHERE id=$1 AND owner_id=$2 FOR SHARE',[machine,input.requester_id])).rows[0];if(!row||row.identity_generation!==generation)throw Object.assign(new Error('Machine installation changed during request preparation'),{code:'machine_generation_changed',statusCode:409});}
  const provider=(input.payload.provider_snapshot??input.payload.provider) as {runtimePoolId?:string}|undefined;
  if(provider?.runtimePoolId){
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`provider:${provider.runtimePoolId}`]);
    const pool=(await client.query('SELECT max_queue FROM provider_runtime_pools WHERE id=$1 AND owner_id=$2',[provider.runtimePoolId,input.requester_id])).rows[0];
    if(!pool)throw Object.assign(new Error('Provider runtime pool unavailable'),{statusCode:404,code:'provider_pool_unavailable'});
    const count=(await client.query("SELECT COUNT(*)::int AS count FROM jobs WHERE state IN ('queued','waiting') AND (payload->'provider_snapshot'->>'runtimePoolId'=$1 OR payload->'provider'->>'runtimePoolId'=$1)",[provider.runtimePoolId])).rows[0].count;
    if(count>=pool.max_queue)throw Object.assign(new Error('Provider queue capacity reached'),{statusCode:429,code:'provider_queue_full'});
  }
  const control=await client.query("SELECT dispatch_epoch FROM runtime_control WHERE singleton=true");
  if(!control.rowCount) throw new Error("Runtime control is not initialized");
  const id=randomUUID();
  const inserted=await client.query<JobRow>(`INSERT INTO jobs(id,requester_id,idempotency_key,request_hash,context,kind,payload,modifies_workspace,state,dispatch_epoch,workspace_id)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,'queued',$9,$10)
    ON CONFLICT(requester_id,idempotency_key) DO NOTHING RETURNING *`,
    [id,input.requester_id,input.idempotency_key,hash,JSON.stringify(input.context),input.kind,JSON.stringify(input.payload),input.modifies_workspace,input.dispatch_epoch??control.rows[0].dispatch_epoch,input.workspace_id??input.context?.workspace_id??null]);
  if(inserted.rowCount){
    await appendEventInTransaction(client,id,"job.created",{state:"queued",context:input.context});
    await client.query("INSERT INTO dispatch_outbox(job_id,kind,payload) VALUES($1,'job_ready',$2::jsonb)",[id,JSON.stringify({job_id:id})]);
    return inserted.rows[0];
  }
  const existing=(await client.query<JobRow>("SELECT * FROM jobs WHERE requester_id=$1 AND idempotency_key=$2",[input.requester_id,input.idempotency_key])).rows[0];
  if(!existing||existing.request_hash!==hash) throw Object.assign(new Error("Idempotency key reused with different request"),{statusCode:409,code:"idempotency_conflict"});
  return existing;
}
export async function submitJob(db:Pool,input:SubmitJobInput):Promise<JobRow>{ return transaction(db,client=>submitJobInTransaction(client,input)); }
export async function cancelJob(db:Pool,jobId:string,ownerId:string):Promise<JobRow|null>{
  return transaction(db,async client=>{
    const job=(await client.query<JobRow>("SELECT * FROM jobs WHERE id=$1 AND requester_id=$2 FOR UPDATE",[jobId,ownerId])).rows[0];
    if(!job)return null;
    if(["completed","failed","cancelled","interrupted"].includes(job.state)||job.cancel_requested)return job;
    const ops=await client.query("SELECT id FROM operations WHERE job_id=$1 AND status NOT IN ('succeeded','failed','cancelled','rejected') LIMIT 1",[jobId]);
    const immediate=job.state==="queued"&&!ops.rowCount;
    const next=immediate?"cancelled":"cancelling";
    const updated=(await client.query<JobRow>(`UPDATE jobs SET cancel_requested=true,state=$2,reason=$3,ended_at=CASE WHEN $2='cancelled' THEN now() ELSE ended_at END,next_run_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[jobId,next,immediate?"cancelled_before_launch":"cancellation_pending"])).rows[0];
    await appendEventInTransaction(client,jobId,"job.state",{state:next,reason:updated.reason});
    if(!immediate)await client.query("INSERT INTO dispatch_outbox(job_id,kind,payload) VALUES($1,'cancel_requested',$2::jsonb)",[jobId,JSON.stringify({job_id:jobId})]);
    return updated;
  });
}

export { digest } from "./hash.js";
