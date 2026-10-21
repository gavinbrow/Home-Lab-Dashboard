import type {Pool,PoolClient} from 'pg';
import type {JobRow} from '../../../../worker/src/types.js';
/** Runtime -> job row lock order matches dispatch admission. No I/O runs in this transaction. */
export async function withBackupLease<T>(db:Pool,job:JobRow,writeControl:boolean,action:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const control=(await client.query(`SELECT * FROM runtime_control WHERE singleton FOR ${writeControl?'UPDATE':'SHARE'}`)).rows[0];
  const current=(await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
  if(!current||current.lease_owner!==job.lease_owner||String(current.fence)!==String(job.fence)||!current.lease_until||current.lease_until.getTime()<=Date.now()||current.dispatch_epoch!==control?.dispatch_epoch||control.restore_mode)throw new Error('backup_lease_lost');
  const result=await action(client);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

/** Drain admission and the storage API writer barrier share this control lock. */
export async function acquireBackupCut(db:Pool,job:JobRow):Promise<boolean>{
 return withBackupLease(db,job,true,async client=>{
  const active=(await client.query(`SELECT
   EXISTS(SELECT 1 FROM jobs WHERE id<>$1 AND lease_until>now()) OR
   EXISTS(SELECT 1 FROM operations WHERE status NOT IN ('succeeded','failed','cancelled','rejected')) OR
   EXISTS(SELECT 1 FROM workspace_locks) OR
   EXISTS(SELECT 1 FROM resource_reservations WHERE state IN ('held','uncertain')) OR
   EXISTS(SELECT 1 FROM agent_rpc_requests WHERE state IN ('queued','leased') AND method<>'GET' AND NOT maintenance_capture) AS busy`,[job.id])).rows[0].busy;
  if(active)return false;
  return !!(await client.query('UPDATE runtime_control SET maintenance_mode=true,maintenance_job_id=$1 WHERE singleton AND restore_mode=false AND (maintenance_mode=false OR maintenance_job_id=$1) RETURNING singleton',[job.id])).rowCount;
 });
}
