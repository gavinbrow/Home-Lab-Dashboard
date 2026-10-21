/** Creates and removes only its generated database on an explicit loopback test server. */
import{Pool}from'pg';
import{randomUUID}from'node:crypto';
import{migrate}from'../../../apps/api/src/core/migrate.js';
const source=process.env.HOMELAB_TEST_DATABASE_URL;if(!source)throw new Error('Explicit HOMELAB_TEST_DATABASE_URL test admin endpoint required');
const url=new URL(source);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Loopback test PostgreSQL only');
const admin=new Pool({connectionString:source,max:2});const name=`homelab_provider_${randomUUID().replace(/-/g,'')}`;let created=false;let db:Pool|undefined;
const campaign=process.argv[2]??'routes';if(!['routes','reservations'].includes(campaign))throw new Error('Unknown provider test campaign');
try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname=`/${name}`;db=new Pool({connectionString:url.href});await migrate(db);await db.end();db=undefined;
  process.env.HOMELAB_TEST_DATABASE_URL=url.href;if(campaign==='routes')await import('./routes-postgres.js');else await import('./reservations-postgres.js');
}finally{
  await db?.end();if(created){if(!/^homelab_provider_[0-9a-f]{32}$/.test(name))throw new Error('Unsafe test database cleanup name');await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);}await admin.end();
}
