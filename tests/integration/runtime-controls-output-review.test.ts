import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { linux, stackRoot } from './helpers/linux-stack.js';

test('read-only review of original actual output cap and persisted truncation marker', { skip: process.env.HOMELAB_OUTPUT_REVIEW !== '1' ? 'Requires retained explicitly owned actual control evidence' : false }, async () => {
  const url=new URL(await linux('sudo','-n','/bin/cat',`${stackRoot}/config/database-admin-url`));url.hostname='127.0.0.1';url.port='15439';
  const db=new pg.Pool({connectionString:url.href});
  const job='81983447-24d2-4cba-a860-122cac7e42ce',owner='3e8f092e-579d-488d-8d79-9eca5709ed0d',operation='53945cbd-e759-4f62-98d8-ba0b6aabb31b';
  try{
    await db.query('BEGIN READ ONLY');
    assert.equal((await db.query('SELECT state FROM jobs WHERE id=$1 AND requester_id=$2',[job,owner])).rows[0].state,'completed');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM operations WHERE job_id=$1',[job])).rows[0].n,1);
    const bytes=(await db.query("SELECT sum(octet_length(payload->>'data'))::int AS n FROM job_events WHERE job_id=$1 AND type='log'",[job])).rows[0].n;assert.equal(bytes,2048);
    const limit=(await db.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='output.limited'",[job])).rows;assert.equal(limit.length,1);assert.equal(limit[0].payload.reason,'job_output_budget');assert.equal(limit[0].payload.accepted_bytes,0);assert.equal(limit[0].payload.host_sequence,2);
    const responses=(await db.query("SELECT response_body FROM agent_rpc_requests WHERE machine_id=$1 AND path=$2 AND response_status=200",['6c5d03fd-7140-4689-a8c2-c3211d14a0a1',`/v1/operations/${operation}/logs?after=0`])).rows;
    assert.ok(responses.some(row=>row.response_body.logs.some((chunk:any)=>chunk.sequence===2&&chunk.truncated===true&&chunk.stream==='system')));
    await db.query('COMMIT');
    await writeFile('docs/acceptance/runtime-controls-output-reviewed-result.json',JSON.stringify({outcome:'PASS',scope:'READ-ONLY assertions of original physical output command; no new execution, mutation or replay',job_id:job,operation_id:operation,published_bytes:bytes,limit_events:limit,host_truncation_marker:true,reviewed_at:new Date().toISOString()},null,2)+'\n');
  }finally{await db.end();}
});
