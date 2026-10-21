import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdSchema } from '@homelab/contracts';
import type { ApiContext } from '../../core/context.js';
import type { PoolClient } from 'pg';
import { RemoteError } from './security.js';

const sshCredential=z.object({password:z.string().min(1).max(4096).optional(),privateKey:z.string().min(1).max(65536).optional(),passphrase:z.string().max(4096).optional()}).strict().refine(value=>Boolean(value.password)!==Boolean(value.privateKey));
const desktopCredential=z.object({password:z.string().max(4096)}).strict();
async function invalidateMachineCapability(client:PoolClient,owner:string,row:{machine_id:string;kind:string;config:{account_scope?:string}}){
  const capability=row.kind==='desktop'?'desktop':row.config.account_scope==='sftp_chroot'?'sftp':'ssh';
  const enabled=(await client.query(`SELECT id FROM remote_connections WHERE machine_id=$1 AND owner_id=$2
    AND COALESCE(config->>'enabled','true')='true' AND kind=$3
    AND ($3='desktop' OR COALESCE(config->>'account_scope','human_management')=$4) LIMIT 1`,[row.machine_id,owner,row.kind,capability==='sftp'?'sftp_chroot':'human_management'])).rowCount!==0;
  await client.query(`UPDATE machines SET capabilities=jsonb_set(capabilities,ARRAY[$3::text],$4::jsonb),updated_at=now()
    WHERE id=$1 AND owner_id=$2`,[row.machine_id,owner,capability,JSON.stringify({supported:null,configured:enabled,permitted:false,
      health_state:enabled?'unverified':'unconfigured',observed_at:null,last_test_at:null,last_success_at:null,
      reason:'Connection credentials or availability changed; rerun the affected connection test.'})]);
}

export async function registerConnectionLifecycle(app:FastifyInstance,context:ApiContext):Promise<void> {
  app.post('/remote/connections/:id/disable',async request=>{
    const id=IdSchema.parse((request.params as {id:string}).id),owner=request.actor!.id;
    const body=z.object({expected_version:z.number().int().positive()}).strict().parse(request.body);
    const client=await context.db.connect();let version:number,revoked=0;
    try{
      await client.query('BEGIN');
      const row=(await client.query('SELECT version,machine_id,kind,config FROM remote_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,owner])).rows[0];
      if(!row)throw new RemoteError('REMOTE_CONNECTION_NOT_FOUND',404);
      if(row.version!==body.expected_version)throw new RemoteError('REMOTE_CONNECTION_VERSION_CONFLICT',409);
      version=row.version+1;
      await client.query(`UPDATE remote_connections SET config=jsonb_set(config,'{enabled}','false'::jsonb),version=$3 WHERE id=$1 AND owner_id=$2`,[id,owner,version]);
      revoked=(await client.query(`UPDATE remote_sessions SET state='revoked',revoked_at=now() WHERE connection_id=$1 AND owner_id=$2 AND state IN ('issued','active')`,[id,owner])).rowCount||0;
      await invalidateMachineCapability(client,owner,row);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await context.audit(owner,'remote.connection.disable',id,'disabled',{version,sessions_revoked:revoked});
    return {id,version,enabled:false,sessions_revoked:revoked};
  });
  app.post('/remote/connections/:id/credentials',async request=>{
    const id=IdSchema.parse((request.params as {id:string}).id),owner=request.actor!.id;
    const body=z.object({expected_version:z.number().int().positive(),credential:z.unknown()}).strict().parse(request.body);
    const row=(await context.db.query('SELECT kind,version,machine_id,config FROM remote_connections WHERE id=$1 AND owner_id=$2',[id,owner])).rows[0];
    if(!row)throw new RemoteError('REMOTE_CONNECTION_NOT_FOUND',404);
    if(row.version!==body.expected_version)throw new RemoteError('REMOTE_CONNECTION_VERSION_CONFLICT',409);
    const credential=row.kind==='ssh'?sshCredential.parse(body.credential):desktopCredential.parse(body.credential);
    const reference=await context.secrets.put(owner,`Remote connection credential revision ${id}`,JSON.stringify(credential));
    const client=await context.db.connect();let revoked=0;
    try{
      await client.query('BEGIN');
      const changed=await client.query(`UPDATE remote_connections SET credential_ref=$3,version=version+1,
        config=CASE WHEN kind='desktop' THEN (config-'observation')||'{"session_mode_verified":false}'::jsonb ELSE config #- '{sftp,verified_at}' END
        WHERE id=$1 AND owner_id=$2 AND version=$4 RETURNING version`,[id,owner,reference,body.expected_version]);
      if(!changed.rowCount)throw new RemoteError('REMOTE_CONNECTION_VERSION_CONFLICT',409);
      revoked=(await client.query(`UPDATE remote_sessions SET state='revoked',revoked_at=now() WHERE connection_id=$1 AND owner_id=$2 AND state IN ('issued','active')`,[id,owner])).rowCount||0;
      await invalidateMachineCapability(client,owner,row);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const version=body.expected_version+1;
    await context.audit(owner,'remote.connection.credentials',id,'replaced',{version,sessions_revoked:revoked});
    return {id,version,sessions_revoked:revoked,capability_tests_invalidated:true};
  });
}
