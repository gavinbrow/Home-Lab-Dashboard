import { readFile,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const ident=(value:string)=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value)||value.startsWith('pg_')||value==='postgres')throw new Error('Unsafe application role');return `"${value}"`;};
const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;
async function protectedText(path:string){const info=await stat(path);if(!info.isFile()||(process.platform!=='win32'&&(info.mode&0o077)!==0))throw new Error('Credential file must be a protected regular file');return(await readFile(path,'utf8')).trim();}
export async function provisionDatabase(admin:pg.Pool,options:{database:string;appRole:string;migrationRole:string;appPassword:string;migrationPassword:string}){
 const app=ident(options.appRole),migrator=ident(options.migrationRole);
 if(options.appRole===options.migrationRole||options.appPassword.length<24||options.migrationPassword.length<24)throw new Error('Distinct roles and passwords of at least 24 characters required');
 const client=await admin.connect();
 try{
  if((await client.query('SELECT current_database() AS name')).rows[0].name!==options.database)throw new Error('EXPECTED_DATABASE does not match connection');
  await client.query('BEGIN');await client.query('SET LOCAL standard_conforming_strings=on');await client.query('SELECT pg_advisory_xact_lock(474345740)');
  for(const [name,quoted,password] of [[options.appRole,app,options.appPassword],[options.migrationRole,migrator,options.migrationPassword]]){
   if((await client.query('SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname=$1 AND d.datname<>current_database()',[name])).rowCount)throw new Error('Role owns an unrelated database');
   if((await client.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1',[name])).rowCount)throw new Error('Role has preexisting memberships; review explicitly');
   const exists=(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount;
   await client.query(`${exists?'ALTER':'CREATE'} ROLE ${quoted} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password!)}`);
  }
  const dbname='"'+options.database.replaceAll('"','""')+'"';
  await client.query(`ALTER DATABASE ${dbname} OWNER TO ${migrator}`);
  await client.query(`REVOKE CREATE,TEMPORARY ON DATABASE ${dbname} FROM PUBLIC,${app}`);
  await client.query(`GRANT CONNECT ON DATABASE ${dbname} TO ${app}`);
  await client.query(`ALTER SCHEMA public OWNER TO ${migrator}`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC,${app}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${app}`);
  const objects=await client.query("SELECT c.relkind,quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p','S','v','m','f') ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END");
  for(const row of objects.rows){const kind=({S:'SEQUENCE',v:'VIEW',m:'MATERIALIZED VIEW',f:'FOREIGN TABLE'} as Record<string,string>)[row.relkind]??'TABLE';await client.query(`ALTER ${kind} ${row.name} OWNER TO ${migrator}`);}
  const functions=await client.query("SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'");
  for(const row of functions.rows)await client.query(`ALTER FUNCTION ${row.name} OWNER TO ${migrator}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${app}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${app}`);
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${app}`);
  await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${app}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${app}`);
  if((await client.query("SELECT to_regclass('public.schema_migrations') AS name")).rows[0].name){await client.query(`REVOKE ALL ON schema_migrations FROM ${app}`);await client.query(`GRANT SELECT ON schema_migrations TO ${app}`);}
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`${name} required`);return value;};
 const pool=new pg.Pool({connectionString:await protectedText(required('DATABASE_ADMIN_URL_FILE')),max:1});
 try{await provisionDatabase(pool,{database:required('EXPECTED_DATABASE'),appRole:process.env.APP_DB_ROLE??'homelab_app',migrationRole:process.env.MIGRATION_DB_ROLE??'homelab_migrator',appPassword:await protectedText(required('APP_DB_PASSWORD_FILE')),migrationPassword:await protectedText(required('MIGRATION_DB_PASSWORD_FILE'))});console.log('Scoped database roles provisioned');}finally{await pool.end();}
}
