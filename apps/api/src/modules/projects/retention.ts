import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {collectBlobs,type BlobStore} from '@homelab/storage';
import type {ApiContext} from '../../core/context.js';
const Id=z.uuid();
function owner(role:string|undefined){if(role!=='owner')throw Object.assign(new Error('Owner authorization is required.'),{code:'ownership_denied',statusCode:403});}
export async function registerRetention(app:FastifyInstance,context:ApiContext,store:BlobStore){
 app.get('/storage/retention',async request=>{
  owner(request.actor?.role);
  const objects=(await context.db.query('SELECT state,COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM blob_objects GROUP BY state')).rows;
  return {objects:objects.map(r=>({...r,count:Number(r.count),bytes:Number(r.bytes)})),policy:{minimum_unreferenced_age_seconds:86400,quarantine_seconds:86400},references:'Checkpoints, artifacts, attachments, messages, queued jobs, inference, operations, logs and explicit backup blob references protect their content.'};
 });
 app.post('/storage/retention/collect',async request=>{
  owner(request.actor?.role);const b=z.object({limit:z.number().int().min(1).max(500).default(100)}).parse(request.body??{});
  const result=await collectBlobs(context.db,store,{limit:b.limit});
  await context.audit(request.actor!.id,'storage.gc','retained-blobs','completed',result);return result;
 });
 app.get<{Params:{id:string}}>('/jobs/:id/log-retention',async request=>{
  const id=Id.parse(request.params.id);
  if(!(await context.db.query('SELECT id FROM jobs WHERE id=$1 AND requester_id=$2',[id,request.actor!.id])).rowCount)throw Object.assign(new Error('Job not found'),{statusCode:404});
  const rows=(await context.db.query('SELECT l.*,b.state AS blob_state FROM log_segments l LEFT JOIN blob_objects b ON b.hash=l.sha256 WHERE l.job_id=$1 ORDER BY start_offset LIMIT 1001',[id])).rows;
  const expired=(await context.db.query("SELECT COALESCE(SUM((details->>'expired_segments')::bigint),0) AS count FROM audit_events WHERE actor_id=$1 AND target=$2 AND action='logs.expire'",[request.actor!.id,id])).rows[0];
  return {items:rows.slice(0,1000).map(r=>({id:r.id,start_offset:Number(r.start_offset),end_offset:Number(r.end_offset),expires_at:r.expires_at,state:r.blob_state&&r.blob_state!=='live'?'unavailable':r.expires_at&&r.expires_at.getTime()<=Date.now()?'expired_retained':'retained'})),truncated:rows.length>1000,expired_segments:Number(expired.count),expired_bytes_state:'May remain retained by other references or garbage collection grace periods.'};
 });
 app.delete<{Params:{id:string}}>('/jobs/:id/log-retention',async request=>{
  owner(request.actor?.role);const id=Id.parse(request.params.id),b=z.object({confirm_expired:z.literal(true)}).parse(request.body);
  const client=await context.db.connect();let count=0;
  try{await client.query('BEGIN');const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];if(!control||control.maintenance_mode||control.restore_mode)throw Object.assign(new Error('Log expiry is unavailable during maintenance or restore.'),{code:'maintenance_mode',statusCode:409});const job=(await client.query('SELECT state FROM jobs WHERE id=$1 AND requester_id=$2 FOR UPDATE',[id,request.actor!.id])).rows[0];if(!job)throw Object.assign(new Error('Job not found'),{statusCode:404});
   if(!['completed','failed','cancelled'].includes(job.state))throw Object.assign(new Error('Active or unresolved job logs are retained.'),{code:'job_logs_active',statusCode:409});
   count=(await client.query('DELETE FROM log_segments WHERE job_id=$1 AND expires_at<=now()',[id])).rowCount??0;
   await client.query('INSERT INTO audit_events(actor_id,action,target,outcome,details) VALUES($1,$2,$3,$4,$5::jsonb)',[request.actor!.id,'logs.expire',id,'completed',JSON.stringify({expired_segments:count,confirmed:b.confirm_expired})]);await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  return {expired_segments:count,bytes:'Eligible only after all other references are gone and both garbage collection grace periods pass.'};
 });
}
