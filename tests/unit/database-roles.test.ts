import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {provisionDatabase} from '../../db/provision.js';
import {migrate} from '../../apps/api/src/core/migrate.js';
test('actual PostgreSQL application role cannot own schema or perform DDL',{skip:!process.env.HOMELAB_LOCAL_PG_URL?'Explicit disposable loopback PostgreSQL required':false,timeout:60000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
 const suffix=randomUUID().replaceAll('-',''),name=`roles_${suffix}`,appRole=`app_${suffix}`,migrationRole=`mig_${suffix}`;
 const admin=new Pool({connectionString:url.href}),password=randomBytes(32).toString('hex');let scoped:Pool|undefined,app:Pool|undefined,migrator:Pool|undefined;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;scoped=new Pool({connectionString:url.href});
  await provisionDatabase(scoped,{database:name,appRole,migrationRole,appPassword:password,migrationPassword:password+'m'});
  const migrationUrl=new URL(url);migrationUrl.username=migrationRole;migrationUrl.password=password+'m';migrator=new Pool({connectionString:migrationUrl.href});
  const previous=process.env.APP_DB_ROLE;process.env.APP_DB_ROLE=appRole;try{await migrate(migrator);}finally{if(previous===undefined)delete process.env.APP_DB_ROLE;else process.env.APP_DB_ROLE=previous;}
  const appUrl=new URL(url);appUrl.username=appRole;appUrl.password=password;app=new Pool({connectionString:appUrl.href});
  await app.query("INSERT INTO users(id,email,password_hash)VALUES($1,'roles@example.test','unused')",[randomUUID()]);
  assert.ok((await app.query('SELECT count(*) FROM schema_migrations')).rows[0].count>0);
  for(const sql of ['CREATE TABLE public.forbidden(id int)','CREATE TEMP TABLE forbidden(id int)','ALTER TABLE users ADD COLUMN forbidden text','DROP TABLE users',"UPDATE schema_migrations SET checksum='forbidden'",`GRANT ${migrationRole} TO ${appRole}`])await assert.rejects(app.query(sql),/permission denied|must be owner|not permitted|admin option/i);
  const role=(await scoped.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=$1',[appRole])).rows[0];assert.deepEqual(role,{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false});
  await migrate(migrator); // DDL owner can still rerun verified migrations.
 }finally{await app?.end();await migrator?.end();await scoped?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);for(const role of [appRole,migrationRole])await admin.query(`DROP ROLE IF EXISTS "${role}"`);await admin.end();}
});
