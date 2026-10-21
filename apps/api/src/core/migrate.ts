import { readdir,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { createPool } from './db.js';
export async function migrate(db:Pool,directory=resolve('db/migrations')) {
 const client=await db.connect();
 try {
  await client.query('SELECT pg_advisory_lock(474345739)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(directory)).filter(x=>x.endsWith('.sql')).sort()) {
   const sql=await readFile(resolve(directory,name),'utf8'); const checksum=createHash('sha256').update(sql).digest('hex');
   const existing=await client.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name]);
   if(existing.rows.length){if(existing.rows[0].checksum!==checksum)throw new Error(`Migration checksum mismatch: ${name}`); continue;}
   await client.query('BEGIN');
   try {await client.query(sql);await client.query('INSERT INTO schema_migrations(name,checksum)VALUES($1,$2)',[name,checksum]);await client.query('COMMIT');}
   catch(error){await client.query('ROLLBACK');throw error;}
  }
  const appRole=process.env.APP_DB_ROLE??'homelab_app';
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(appRole))throw new Error('Invalid APP_DB_ROLE');
  if((await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[appRole])).rowCount){await client.query(`REVOKE ALL ON schema_migrations FROM "${appRole}"`);await client.query(`GRANT SELECT ON schema_migrations TO "${appRole}"`);}
 } finally {await client.query('SELECT pg_advisory_unlock(474345739)');client.release();}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const db=createPool(process.env.MIGRATION_DATABASE_URL??process.env.DATABASE_URL); try {await migrate(db); console.log('Migrations applied');} finally {await db.end();}
}
