import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { terminalJobStates, type JobState } from "@homelab/contracts";
import { transaction, LeaseLostError, assertOwnedLease } from "./database.js";
import { appendEventInTransaction, appendEvent } from "./queue.js";
import { assertTransition, type JobRow } from "./types.js";
import {assertRuntimeSchema} from './startup.js';
export interface RuntimeContext {
  db:Pool; signal:AbortSignal;
  appendEvent(type:string,payload:unknown):Promise<void>;
  cancelled():Promise<boolean>; assertLease():Promise<void>;
  complete(result:unknown):Promise<void>; wait(reason:string,seconds?:number):Promise<void>;
  fail(reason:string,result?:unknown):Promise<void>; interrupt(reason:string):Promise<void>; cancel(reason:string):Promise<void>;
}
export type JobHandler=(job:JobRow,runtime:RuntimeContext)=>Promise<void>;
export type HandlerRegistry=Record<string,JobHandler>;

export async function claimJob(db:Pool,worker:string,leaseSeconds=30,targetJobId?:string):Promise<JobRow|null>{
  return transaction(db,async client=>{
    const control=(await client.query("SELECT * FROM runtime_control WHERE singleton=true FOR SHARE")).rows[0];
    if(!control?.dispatch_enabled||control.restore_mode||(control.maintenance_mode&&!control.maintenance_job_id))return null;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('runtime-admission'))");
    const job=(await client.query<JobRow>(`SELECT * FROM jobs WHERE state IN ('queued','running','waiting','cancelling')
      AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now()) AND dispatch_epoch=$1
      AND ($2::uuid IS NULL OR (id=$2 AND kind='operations.backup')) AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,[control.dispatch_epoch,control.maintenance_mode?control.maintenance_job_id:null,targetJobId??null])).rows[0];
    if(!job)return null;
    const durable=(await client.query("SELECT EXISTS(SELECT 1 FROM operations WHERE job_id=$1 AND status NOT IN ('succeeded','failed','cancelled','rejected')) OR EXISTS(SELECT 1 FROM workspace_locks WHERE job_id=$1) OR EXISTS(SELECT 1 FROM resource_reservations WHERE job_id=$1 AND state IN ('held','uncertain')) AS admitted",[job.id])).rows[0].admitted;
    let recoveryOnly=false;
    const active=(await client.query("SELECT COUNT(*)::int AS count FROM jobs j WHERE j.id<>$1 AND (j.lease_until>now() OR EXISTS(SELECT 1 FROM operations o WHERE o.job_id=j.id AND o.status NOT IN ('succeeded','failed','cancelled','rejected')) OR EXISTS(SELECT 1 FROM workspace_locks l WHERE l.job_id=j.id) OR EXISTS(SELECT 1 FROM resource_reservations r WHERE r.job_id=j.id AND r.state IN ('held','uncertain'))) ",[job.id])).rows[0].count;
    if(active>=(control.max_concurrent_jobs??4)&&control.maintenance_job_id!==job.id){if(durable)recoveryOnly=true;else{await client.query("UPDATE jobs SET state='waiting',reason='global_capacity',next_run_at=now()+interval '2 seconds' WHERE id=$1",[job.id]);if(job.state!=='waiting')await appendEventInTransaction(client,job.id,'job.state',{state:'waiting',reason:'global_capacity'});return null;}}
    const profileId=job.context?.profile_id??(job.payload.execution_context as {profile_id?:string}|undefined)?.profile_id??job.payload.profile_id;
    if(profileId){
      const configured=(await client.query('SELECT r.definition FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=p.current_revision WHERE p.id=$1',[profileId])).rows[0]?.definition?.limits?.max_concurrent_jobs;
      const profileSnapshot=job.payload.profile_snapshot as {limits?:{max_concurrent_jobs?:number};definition?:{limits?:{max_concurrent_jobs?:number}}}|undefined;
      const captured=(profileSnapshot?.definition??profileSnapshot)?.limits?.max_concurrent_jobs;
      const maximum=Math.min(configured??Infinity,captured??Infinity);
      if(Number.isFinite(maximum)){
        const occupied=(await client.query("SELECT COUNT(*)::int AS count FROM jobs j WHERE j.id<>$1 AND COALESCE(j.context->>'profile_id',j.payload->'execution_context'->>'profile_id',j.payload->>'profile_id')=$2 AND (j.lease_until>now() OR EXISTS(SELECT 1 FROM operations o WHERE o.job_id=j.id AND o.status NOT IN ('succeeded','failed','cancelled','rejected')) OR EXISTS(SELECT 1 FROM workspace_locks l WHERE l.job_id=j.id) OR EXISTS(SELECT 1 FROM resource_reservations r WHERE r.job_id=j.id AND r.state IN ('held','uncertain')))",[job.id,profileId])).rows[0].count;
        if(occupied>=maximum){if(durable)recoveryOnly=true;else{await client.query("UPDATE jobs SET state='waiting',reason='profile_capacity',next_run_at=now()+interval '2 seconds' WHERE id=$1",[job.id]);if(job.state!=='waiting')await appendEventInTransaction(client,job.id,'job.state',{state:'waiting',reason:'profile_capacity'});return null;}}
      }
    }
    if(job.modifies_workspace&&job.workspace_id){
      await client.query("INSERT INTO workspace_locks(workspace_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[job.workspace_id,job.id]);
      const lock=(await client.query("SELECT job_id FROM workspace_locks WHERE workspace_id=$1",[job.workspace_id])).rows[0];
      if(lock?.job_id!==job.id){
        await client.query("UPDATE jobs SET state='waiting',reason='workspace_writer_busy',next_run_at=now()+interval '5 seconds' WHERE id=$1",[job.id]);
        if(job.reason!=="workspace_writer_busy")await appendEventInTransaction(client,job.id,"job.state",{state:"waiting",reason:"workspace_writer_busy"});
        return null;
      }
    }
    const next=job.cancel_requested?"cancelling":"running";
    if(job.lease_owner&&['running','cancelling'].includes(job.state))await appendEventInTransaction(client,job.id,'job.uncertainty',{since:(job as any).last_heartbeat_at??job.lease_until,until:new Date().toISOString(),reason:'orchestrator_lease_expired'});
    const claimed=(await client.query<JobRow>(`UPDATE jobs SET lease_owner=$2,lease_until=now()+$3*interval '1 second',
      fence=fence+1,state=$4,reason=$5,started_at=COALESCE(started_at,now()),last_heartbeat_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[job.id,worker,leaseSeconds,next,recoveryOnly?'capacity_recovery_only':null])).rows[0];
    claimed.recovery_only=recoveryOnly;
    await client.query("UPDATE dispatch_outbox SET delivered_at=now() WHERE job_id=$1 AND kind='job_ready' AND delivered_at IS NULL",[job.id]);
    if(job.state!==next||job.reason!==claimed.reason)await appendEventInTransaction(client,job.id,"job.state",{state:next,reason:claimed.reason});
    return claimed;
  });
}

export async function runClaimedJob(db:Pool,job:JobRow,handlers:HandlerRegistry,parentSignal?:AbortSignal):Promise<void>{
  const abort=new AbortController();
  const onShutdown=()=>abort.abort(); parentSignal?.addEventListener("abort",onShutdown,{once:true}); if(parentSignal?.aborted)abort.abort();
  let finished=false;
  const assertLease=async()=>{
    const row=(await db.query(`SELECT j.cancel_requested FROM jobs j JOIN runtime_control c ON c.singleton=true
      WHERE j.id=$1 AND j.lease_owner=$2 AND j.fence=$3 AND j.lease_until>now() AND j.dispatch_epoch=c.dispatch_epoch
      AND c.dispatch_enabled=true AND c.restore_mode=false`,[job.id,job.lease_owner,job.fence])).rows[0];
    if(!row){abort.abort();throw new LeaseLostError();}
    return row;
  };
  const heartbeat=setInterval(()=>{void db.query(`UPDATE jobs SET lease_until=now()+interval '30 seconds',last_heartbeat_at=now() WHERE id=$1 AND lease_owner=$2 AND fence=$3 AND lease_until>now()`,[job.id,job.lease_owner,job.fence]).then(r=>{if(!r.rowCount)abort.abort();}).catch(()=>abort.abort());},5000);
  const transition=async(state:JobState,reason:string|null,result?:unknown)=>{
    await transaction(db,async client=>{
      await assertOwnedLease(client,job);
      const current=(await client.query<JobRow>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE",[job.id])).rows[0];
      if(current.lease_owner!==job.lease_owner||current.fence!==job.fence||!current.lease_until||current.lease_until.getTime()<=Date.now())throw new LeaseLostError();
      if(state==="waiting"&&current.state==="cancelling")state="cancelling";
      assertTransition(current.state,state);
      const unresolved=await client.query("SELECT id FROM operations WHERE job_id=$1 AND status NOT IN ('succeeded','failed','cancelled','rejected') LIMIT 1",[job.id]);
      const reservations=await client.query("SELECT id FROM resource_reservations WHERE job_id=$1 AND state IN ('held','uncertain') LIMIT 1",[job.id]);
      if((state==="completed"||state==="cancelled")&&(unresolved.rowCount||reservations.rowCount))throw new Error("Cannot confirm completion while operation or provider outcome is unknown");
      await client.query(`UPDATE jobs SET state=$2,reason=$3,result=COALESCE($4::jsonb,result),ended_at=CASE WHEN $5 THEN now() ELSE ended_at END,
        lease_owner=NULL,lease_until=NULL,next_run_at=now()+interval '5 seconds',updated_at=now() WHERE id=$1`,[job.id,state,reason,result===undefined?null:JSON.stringify(result),terminalJobStates.has(state)]);
      await appendEventInTransaction(client,job.id,"job.state",{state,reason,...(result===undefined?{}:{result})});
      if(terminalJobStates.has(state)&&!unresolved.rowCount&&!reservations.rowCount)await client.query("DELETE FROM workspace_locks WHERE job_id=$1",[job.id]);
    });
    finished=true;
  };
  const runtime:RuntimeContext={db,signal:abort.signal,assertLease:async()=>{await assertLease();},
    appendEvent:async(type,payload)=>{await transaction(db,async client=>{await assertOwnedLease(client,job);await appendEventInTransaction(client,job.id,type,payload);});},
    cancelled:async()=>Boolean((await assertLease()).cancel_requested),
    complete:result=>transition("completed",null,result), wait:async(reason,seconds=5)=>{await transition("waiting",reason);await db.query("UPDATE jobs SET next_run_at=now()+$2*interval '1 second' WHERE id=$1 AND lease_owner IS NULL",[job.id,seconds]);},
    fail:(reason,result)=>transition("failed",reason,result),interrupt:reason=>transition("interrupted",reason),cancel:reason=>transition("cancelled",reason)};
  try{
    await assertLease();
    const handler=handlers[job.kind];
    if(!handler){
      if(job.cancel_requested){
        const outstanding=await db.query("SELECT id FROM operations WHERE job_id=$1 AND status NOT IN ('succeeded','failed','cancelled','rejected') LIMIT 1",[job.id]);
        if(outstanding.rowCount)await runtime.wait("cancellation_pending_host_reconciliation",30);
        else await transition("cancelled","cancelled_before_execution");
      }else await runtime.wait(job.kind==="capability_test"?"capability_probe_unavailable":"handler_unavailable",30);
    }else await handler(job,runtime);
    if(!finished)await runtime.wait("handler_returned_without_terminal_result");
  }catch(error){
    if(!(error instanceof LeaseLostError)&&!abort.signal.aborted&&!finished){
      await runtime.interrupt(error instanceof Error?error.message:"worker_error").catch(()=>undefined);
    }
  }finally{clearInterval(heartbeat);parentSignal?.removeEventListener("abort",onShutdown);abort.abort();}
}
export async function runWorker(db:Pool,handlers:HandlerRegistry,signal:AbortSignal,workerId=`worker-${randomUUID()}`):Promise<void>{
  await assertRuntimeSchema(db);
  const active=new Set<Promise<void>>();
  try{while(!signal.aborted){
    // Execution admission is enforced in PostgreSQL. Recovery orchestration must
    // still run when a configured execution limit is reduced beneath live work.
    const job=active.size<64?await claimJob(db,workerId):null;
    if(job){let task:Promise<void>;task=runClaimedJob(db,job,handlers,signal).finally(()=>active.delete(task));active.add(task);}
    else await new Promise<void>(resolve=>{const timer=setTimeout(done,1000);function done(){clearTimeout(timer);signal.removeEventListener("abort",done);resolve();}signal.addEventListener("abort",done,{once:true});});
  }}finally{await Promise.allSettled(active);}
}






