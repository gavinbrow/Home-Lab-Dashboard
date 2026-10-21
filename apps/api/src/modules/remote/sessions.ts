import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { newTicket,RemoteError } from './security.js';

/** Serialize issuance against disable/credential rotation so a previously
 * authorized stale request cannot mint a fresh ticket after revocation. */
export async function issueRemoteSession(db:Pool,input:{ownerId:string;authSessionId:string;connectionId:string;connectionVersion:number;kind:'terminal'|'desktop'}){
  const id=randomUUID(),{ticket,hash}=newTicket(),expiresAt=new Date(Date.now()+30_000),client=await db.connect();
  try{
    await client.query('BEGIN');
    const row=(await client.query<{machine_id:string}>(`SELECT c.machine_id FROM remote_connections c
      JOIN machines m ON m.id=c.machine_id AND m.owner_id=c.owner_id
      JOIN sessions s ON s.id=$3 AND s.user_id=c.owner_id
      WHERE c.id=$1 AND c.owner_id=$2 AND c.version=$4 AND c.kind=$5 AND COALESCE(c.config->>'enabled','true')='true'
      AND s.revoked_at IS NULL AND s.expires_at>now()
      AND EXISTS(SELECT 1 FROM runtime_control WHERE singleton=true AND restore_mode=false AND maintenance_mode=false)
      FOR SHARE OF c`,[input.connectionId,input.ownerId,input.authSessionId,input.connectionVersion,input.kind==='terminal'?'ssh':'desktop'])).rows[0];
    if(!row)throw new RemoteError('REMOTE_CONNECTION_OR_SESSION_CHANGED',409);
    await client.query(`INSERT INTO remote_sessions(id,owner_id,auth_session_id,machine_id,connection_id,kind,state,expires_at,ticket_hash)
      VALUES($1,$2,$3,$4,$5,$6,'issued',$7,$8)`,[id,input.ownerId,input.authSessionId,row.machine_id,input.connectionId,input.kind,expiresAt,hash]);
    await client.query('COMMIT');return {id,ticket,expiresAt,machineId:row.machine_id};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
