import {readdir} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import type {Pool} from 'pg';
const directory=fileURLToPath(new URL('../../../db/migrations/',import.meta.url));
/** A new worker must never consume a job using an older persisted schema. */
export async function assertRuntimeSchema(db:Pick<Pool,'query'>):Promise<void>{
 const required=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();if(!required.length)throw new Error('worker_schema_manifest_unavailable');
 let applied:Set<string>;try{applied=new Set((await db.query('SELECT name FROM schema_migrations WHERE name=ANY($1::text[])',[required])).rows.map(row=>row.name));}catch{throw new Error('worker_schema_ledger_unavailable');}
 const missing=required.filter(name=>!applied.has(name));if(missing.length)throw new Error(`worker_schema_mismatch: ${missing.join(', ')}`);
}
