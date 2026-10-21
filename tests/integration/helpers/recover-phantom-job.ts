// Explicit operator-authorized recovery of one test-only pre-network interruption.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { linux, stackRoot } from './linux-stack.js';

const jobId='b96bd0da-3b20-4026-8f17-27d248e05f65';
if(process.env.HOMELAB_RECOVER_PHANTOM_JOB!==jobId)throw Error('Exact explicit old-job recovery authorization required');
const final=JSON.parse(await readFile('docs/acceptance/actual-t08-qwen4b-production-end.json','utf8'));
assert.equal(final.job_state,'completed');assert.equal(final.writer_locks,0);
const fixture=JSON.parse(await readFile('tests/integration/.wave3-runtime/actual-t08-browser.json','utf8'));
assert.equal(fixture.job_id,jobId);assert.equal(fixture.api_origin,'http://127.0.0.1:3019');
const old=JSON.parse(await readFile('docs/acceptance/actual-t08-qwen25-result.json','utf8'));
assert.equal(old.forwarded_requests.length,8);assert.ok(old.retained_inferences.slice(0,8).every((row:any)=>row.state==='completed'&&row.metrics.finishReason==='stop'));
const passive=JSON.parse(await readFile('docs/providers/actual-qwen3-4b-8192-passive-envelope.json','utf8'));
const url=new URL(await linux('sudo','-n','/bin/cat',`${stackRoot}/config/database-admin-url`));url.hostname='127.0.0.1';url.port='15439';
const db=new pg.Pool({connectionString:url.href});
const snapshot=async()=>({job:(await db.query('SELECT id,state,reason,fence FROM jobs WHERE id=$1 AND requester_id=$2',[jobId,fixture.ids.owner])).rows[0],operations:(await db.query('SELECT id,status FROM operations WHERE job_id=$1',[jobId])).rows,locks:(await db.query('SELECT workspace_id,job_id FROM workspace_locks WHERE job_id=$1',[jobId])).rows,reservations:(await db.query('SELECT id,resource_type,state FROM resource_reservations WHERE job_id=$1',[jobId])).rows,audits:(await db.query("SELECT id,action,outcome,details,created_at FROM audit_events WHERE actor_id=$1 AND target=$2 AND action IN ('provider.reconcile','job.reconcile') ORDER BY created_at",[fixture.ids.owner,jobId])).rows});
const record:Record<string,any>={scope:'Existing owner+CSRF audited API routes only; no SQL mutation, old-job resume, new generation or lifecycle-unknown change',job_id:jobId,started_at:new Date().toISOString()};
try{
  record.before=await snapshot();assert.equal(record.before.job.state,'interrupted');assert.equal(record.before.operations.length,0);assert.equal(record.before.locks.length,1);
  assert.equal(record.before.reservations.filter((row:any)=>row.state==='uncertain').length,2);
  const evidence=`Operator attestation for test-only job ${jobId}. Exactly eight /api/chat calls were delegated and all eight returned completed/stop; retained actual-t08-qwen25-result.json has their full wire bodies and responses. The ninth durable inference had no tools after the frozen twelve-rejection budget. Frozen harness SHA8A4DBF7FA387776102371152A3068B62144F8C50483BDAE14E30C8A38AE59B3B threw its schema guard before a ninth transport call. No ninth provider request or provider-stop failure is asserted. Independent passive provider evidence at ${passive.observed_at}, before the later independent4B job, recorded /api/ps empty and all slots idle (docs/providers/actual-qwen3-4b-8192-passive-envelope.json and -resource-envelope.txt). Zero host operations exist; the original job remains interrupted. This is operator-attested stopped scope, not machine-confirmed stop proof or expiration-based release. Release only this old job's permits and reconcile its zero-operation writer without replay.`;
  record.operator_evidence=evidence;
  const login=await fetch(`${fixture.api_origin}/api/v1/auth/login`,{method:'POST',headers:{origin:fixture.app_origin,'content-type':'application/json'},body:JSON.stringify({email:fixture.email,password:fixture.password}),signal:AbortSignal.timeout(10000)});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0],csrf=(await login.json() as any).csrf_token;
  const post=async(path:string,body?:unknown)=>{const response=await fetch(`${fixture.api_origin}/api/v1${path}`,{method:'POST',headers:{origin:fixture.app_origin,cookie,'x-csrf-token':csrf,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});return{status:response.status,body:await response.json() as any};};
  record.provider=await post(`/jobs/${jobId}/provider-reconciliation`,{decision:'release_after_independent_stop_verification',evidence});
  assert.equal(record.provider.status,200);assert.equal(record.provider.body.provider_stop_evidence,'operator_attestation');assert.equal(record.provider.body.reservations_released,2);
  record.writer=await post(`/jobs/${jobId}/reconcile`);assert.equal(record.writer.status,200);assert.equal(record.writer.body.workspace_released,true);assert.equal(record.writer.body.replayed,false);assert.deepEqual(record.writer.body.observations,[]);
  record.after=await snapshot();assert.equal(record.after.job.state,'interrupted');assert.equal(record.after.job.reason,record.before.job.reason);assert.equal(record.after.operations.length,0);assert.equal(record.after.locks.length,0);assert.ok(record.after.reservations.every((row:any)=>row.state==='released'));
  assert.ok(record.after.audits.some((row:any)=>row.action==='provider.reconcile'&&row.outcome==='operator_attested_stopped'));assert.ok(record.after.audits.some((row:any)=>row.action==='job.reconcile'&&row.outcome==='host_operations_known'));
  record.outcome='PASS';record.completed_at=new Date().toISOString();console.log(`PHANTOM_RECOVERY_PASS job=${jobId} operator_attested_provider_released=2 writer_released=true replayed=false terminal_history=interrupted`);
}catch(error){record.outcome='FAIL';record.error=error instanceof Error?error.message:String(error);throw error;}
finally{await writeFile('docs/acceptance/phantom-qwen25-audited-recovery.json',JSON.stringify(record,null,2)+'\n');await db.end();}
