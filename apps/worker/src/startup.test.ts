import test from 'node:test';import assert from 'node:assert/strict';import type {Pool} from 'pg';
import {assertRuntimeSchema} from './startup.js';import {runWorker} from './runtime.js';
test('worker refuses an old schema before any queue claim or handler',async()=>{
 const queries:string[]=[];const db={query:async(sql:string,values:any[])=>{queries.push(sql);return {rows:values[0].slice(0,-1).map((name:string)=>({name}))};}} as unknown as Pool;
 await assert.rejects(runWorker(db,{},new AbortController().signal),/worker_schema_mismatch/);assert.equal(queries.length,1);assert.match(queries[0],/schema_migrations/);assert.ok(!queries.some(sql=>/FROM jobs/.test(sql)));
});
test('worker recognizes the complete packaged migration ledger',async()=>{
 const db={query:async(_sql:string,values:any[])=>({rows:values[0].map((name:string)=>({name}))})} as unknown as Pool;await assert.doesNotReject(assertRuntimeSchema(db));
});
