import type { Pool } from 'pg';
import type { ClientChannel } from 'ssh2';
import type { SecretStore } from '../../core/context.js';
import type { JsonValue } from '@homelab/contracts';
import { connectSsh } from './ssh.js';
import { verifySftpConfinement } from './sftp.js';
import { randomUUID } from 'node:crypto';
import { GuacamoleHttpSession,guacamoleSettings } from './guacamole.js';
import { encryptDesktopDefinition } from './security.js';

type ProbeResult={health_state:'unconfigured'|'unverified'|'degraded'|'healthy'|'unreachable';reason:string;evidence:JsonValue};
/** Test jobs operate only on enrolled owner-scoped records; no browser-provided destination. */
export async function probeMachineCapability(db:Pool,secrets:SecretStore,machineId:string,ownerId:string,capability:string,authSessionId?:string):Promise<ProbeResult> {
  const kind=capability==='desktop'?'desktop':'ssh';
  const control=(await db.query('SELECT restore_mode,maintenance_mode FROM runtime_control WHERE singleton=true')).rows[0];
  if(!control||control.restore_mode||control.maintenance_mode)return {health_state:'unverified',reason:'Remote capability tests are disabled by durable maintenance/restore mode.',evidence:{remote_access_disabled:true}};
  const row=(await db.query(`SELECT r.* FROM remote_connections r JOIN machines m ON m.id=r.machine_id AND m.owner_id=r.owner_id
    WHERE r.machine_id=$1 AND r.owner_id=$2 AND r.kind=$3
    AND COALESCE(r.config->>'enabled','true')='true'
    AND ($4<>'sftp' OR r.config->>'account_scope'='sftp_chroot')
    AND ($4<>'ssh' OR COALESCE(r.config->>'account_scope','human_management')='human_management') ORDER BY r.created_at DESC LIMIT 1`,[machineId,ownerId,kind,capability])).rows[0];
  if(!row)return {health_state:'unconfigured',reason:`No enrolled ${capability} connection is configured for this owner and machine.`,evidence:{connection_found:false}};
  try{
    if(capability==='sftp'){
      const evidence=await verifySftpConfinement({secrets},row,ownerId),now=new Date().toISOString();
      await db.query(`UPDATE remote_connections SET config=jsonb_set(config,'{sftp,verified_at}',to_jsonb($3::text)) WHERE id=$1 AND owner_id=$2 AND version=$4`,[row.id,ownerId,now,row.version]);
      return {health_state:'healthy',reason:'Pinned SFTP root marker, known-outside-canary denial, random-file hash round trip and cleanup passed within the operator-attested OpenSSH chroot.',evidence:{...evidence,operator_attested_chroot:true,connection_id:row.id,verified_at:now}};
    }
    if(capability==='ssh'){
      const client=await connectSsh({hostname:row.config.hostname,port:row.config.port,username:row.config.username,hostKeyFingerprints:row.config.host_key_fingerprints},JSON.parse(await secrets.get(ownerId,row.credential_ref)));
      const timer=setTimeout(()=>client.destroy(),15_000);timer.unref();
      try{
        const channel=await new Promise<ClientChannel>((resolve,reject)=>client.shell({term:'xterm-256color',cols:100,rows:30},(error,value)=>error?reject(error):resolve(value)));
        channel.setWindow(40,120,0,0);channel.destroy();
        return {health_state:'degraded',reason:'Pinned SSH authentication and PTY open/resize passed. Actual shell identity and browser Unicode/Ctrl+C behavior still require interactive verification.',evidence:{connection_id:row.id,host_key:'matched',authentication:'passed',pty:'opened',resize:'sent',identity:'unverified',browser_control:'unverified'}};
      }finally{clearTimeout(timer);client.destroy();}
    }
    if(capability==='desktop'){
      if(authSessionId){
        const settings=await guacamoleSettings();
        if(!settings)return {health_state:'unconfigured',reason:'Internal Guacamole and protected JSON key are not configured for the capability worker.',evidence:{gateway_configured:false}};
        const session=await db.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[authSessionId,ownerId]);
        if(!session.rowCount)return {health_state:'unverified',reason:'The browser session that requested this desktop test is no longer active; submit a fresh test after signing in.',evidence:{requesting_session_active:false}};
        const id=randomUUID(),upstream=new GuacamoleHttpSession(settings);
        await db.query(`INSERT INTO remote_sessions(id,owner_id,auth_session_id,machine_id,connection_id,kind,state,expires_at)
          VALUES($1,$2,$3,$4,$5,'desktop','active',now()+interval '1 minute')`,[id,ownerId,authSessionId,machineId,row.id]);
        try{
          const password=JSON.parse(await secrets.get(ownerId,row.credential_ref)).password;
          await upstream.connect(encryptDesktopDefinition({sessionId:id,expiresAt:Date.now()+45_000,protocol:row.config.protocol,hostname:row.config.hostname,port:row.config.port,username:row.config.username,domain:row.config.domain,password},settings.key),id);
          const stream=await upstream.read();let display='';
          for await(const chunk of stream){display+=chunk.toString('utf8');if(/4\.(size|sync),/.test(display))break;if(display.length>2_097_152)throw new Error('display limit');}
          if(!/4\.(size|sync),/.test(display))throw new Error('No display handshake');
          return {health_state:'degraded',reason:'The requesting owner session authorized an authenticated Guacamole/guacd display handshake. Actual browser controls and operator-observed session mode still require interactive verification.',evidence:{connection_id:row.id,connection_version:row.version,display_handshake:'received',browser_control:'unverified',session_mode_verified:false}};
        }finally{upstream.close();await db.query("UPDATE remote_sessions SET state='closed' WHERE id=$1 AND state='active'",[id]);}
      }
      const observation=row.config.observation;
      const current=observation&&row.config.session_mode_verified&&Date.now()-Date.parse(observation.observed_at)<24*60*60_000
        && (await db.query(`SELECT id FROM audit_events WHERE actor_id=$1 AND target=$2 AND action='remote.desktop.observation'
          AND outcome='operator_verified' AND details->>'connection_version'=$3 ORDER BY created_at DESC LIMIT 1`,[ownerId,row.id,String(row.version)])).rowCount;
      return current
        ? {health_state:'degraded',reason:'Recent operator-observed desktop control evidence exists for this exact connection revision. A background test cannot impersonate the browser session; launch a fresh desktop session to retest network/display behavior.',evidence:{connection_id:row.id,connection_version:row.version,operator_observed_at:observation.observed_at,session_mode:row.config.session_mode,network_retested:false}}
        : {health_state:'unverified',reason:'Launch the enrolled desktop through an authenticated browser session, test keyboard/mouse/resize/reconnect, and record the operator-observed session mode. Background probes cannot impersonate a browser session.',evidence:{connection_id:row.id,connection_version:row.version,session_mode_verified:false}};
    }
    return {health_state:'unverified',reason:'Capability probe is not implemented for this capability.',evidence:{}};
  }catch{return {health_state:'unreachable',reason:`The enrolled ${capability} probe failed; inspect server configuration, trusted identity and scoped credentials.`,evidence:{connection_id:row.id,probe:'failed'}};}
}
