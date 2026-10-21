import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { transaction,assertOwnedLease } from "./database.js";
type LeaseGuard={id:string;lease_owner:string|null;fence:string};
/** Capacity never expires merely because a worker lease expired. */
export async function reserveProvider(db:Pool,poolId:string,jobId:string,modelId?:string,maxModelConcurrency=1,exclusive=false,guard?:LeaseGuard):Promise<boolean>{
  return transaction(db,async client=>{
    if(guard)await assertOwnedLease(client,guard);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`provider:${poolId}`]);
    const exclusiveOther=await client.query("SELECT id FROM resource_reservations WHERE resource_type='provider_exclusive' AND resource_id=$1 AND job_id<>$2 AND state IN ('held','uncertain') LIMIT 1",[poolId,jobId]);
    if(exclusiveOther.rowCount)return false;
    if(exclusive&&(await client.query("SELECT id FROM resource_reservations WHERE resource_type='provider' AND resource_id=$1 AND job_id<>$2 AND state IN ('held','uncertain') LIMIT 1",[poolId,jobId])).rowCount)return false;
    const existing=await client.query("SELECT id,state FROM resource_reservations WHERE resource_type='provider' AND resource_id=$1 AND job_id=$2 AND state IN ('held','uncertain')",[poolId,jobId]);
    if(existing.rowCount&&existing.rows[0].state!=="held")return false;
    const pool=(await client.query("SELECT max_concurrency FROM provider_runtime_pools WHERE id=$1",[poolId])).rows[0];
    if(!pool)throw new Error("Provider runtime pool missing");
    const count=(await client.query("SELECT COUNT(*)::int AS count FROM resource_reservations WHERE resource_type='provider' AND resource_id=$1 AND state IN ('held','uncertain')",[poolId])).rows[0].count;
    if(!existing.rowCount&&count>=pool.max_concurrency)return false;
    if(modelId){
      const key=`${poolId}:${modelId}`;
      const model=(await client.query("SELECT count(*)::int AS count,count(*) FILTER(WHERE job_id=$2)::int AS own FROM resource_reservations WHERE resource_type='provider_model' AND resource_id=$1 AND state IN ('held','uncertain')",[key,jobId])).rows[0];
      if(!model.own&&model.count>=maxModelConcurrency)return false;
      if(!model.own)await client.query("INSERT INTO resource_reservations(id,resource_type,resource_id,job_id,state) VALUES($1,'provider_model',$2,$3,'held')",[randomUUID(),key,jobId]);
    }
    if(!existing.rowCount)await client.query("INSERT INTO resource_reservations(id,resource_type,resource_id,job_id,state) VALUES($1,'provider',$2,$3,'held')",[randomUUID(),poolId,jobId]);
    if(exclusive)await client.query("INSERT INTO resource_reservations(id,resource_type,resource_id,job_id,state) SELECT $1,'provider_exclusive',$2,$3,'held' WHERE NOT EXISTS(SELECT 1 FROM resource_reservations WHERE resource_type='provider_exclusive' AND resource_id=$2 AND job_id=$3 AND state IN ('held','uncertain'))",[randomUUID(),poolId,jobId]);
    return true;
  });
}
export async function releaseProvider(db:Pool,jobId:string,guard?:LeaseGuard):Promise<void>{await transaction(db,async client=>{if(guard)await assertOwnedLease(client,guard);await client.query("UPDATE resource_reservations SET state='released' WHERE job_id=$1 AND resource_type IN ('provider','provider_model','provider_exclusive') AND state='held'",[jobId]);});}
export async function markProviderUncertain(db:Pool,jobId:string,guard?:LeaseGuard):Promise<void>{await transaction(db,async client=>{if(guard)await assertOwnedLease(client,guard);await client.query("UPDATE resource_reservations SET state='uncertain' WHERE job_id=$1 AND resource_type IN ('provider','provider_model','provider_exclusive') AND state='held'",[jobId]);});}
