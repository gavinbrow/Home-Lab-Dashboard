import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { IdSchema } from '@homelab/contracts';
import type { ApiContext } from '../../core/context.js';
import { ActiveRegistry, RemoteError, requireOrigin, ticketHash } from './security.js';
import { bridgeTerminal, connectSsh, type SshConnection, type SshCredential } from './ssh.js';
import { registerDesktop } from './desktop.js';
import { registerSftp,sftpPolicySchema } from './sftp.js';
import { gatewayLeaseReady } from './gateway-control.js';
import { assertRemoteEnabled,remoteAccessReady } from './lifecycle.js';
import { registerConnectionLifecycle } from './connections.js';
import { issueRemoteSession } from './sessions.js';
export { registerGatewayControl as registerAgentRoutes } from './gateway-control.js';

const endpoint = z.object({
  enabled:z.boolean().default(true),
  hostname: z.string().min(1).max(253).regex(/^[^\s/\\\0]+$/),
  port: z.number().int().min(1).max(65535), username: z.string().min(1).max(256),
  host_key_fingerprints: z.array(z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/)).min(1).max(8),
  host_key_verified_out_of_band: z.literal(true),
  account_scope:z.enum(['human_management','sftp_chroot']).default('human_management'),
  sftp:sftpPolicySchema.optional(),
}).strict().superRefine((value,ctx)=>{
  if((value.account_scope==='sftp_chroot')!==Boolean(value.sftp))ctx.addIssue({code:'custom',message:'SFTP-only chroot accounts require an explicit confinement policy; broad human accounts cannot use it'});
});
const credential = z.object({ password:z.string().min(1).max(4096).optional(),
  privateKey:z.string().min(1).max(65536).optional(), passphrase:z.string().max(4096).optional(),
}).strict().refine(value => Boolean(value.password) !== Boolean(value.privateKey));
const createConnection = z.object({ machine_id:IdSchema, kind:z.literal('ssh'), config:endpoint,
  credential:credential }).strict().refine(body=>body.config.sftp?.verified_at===undefined,'Verification time is server-owned');
const launch = z.object({ connection_id:IdSchema }).strict();
type ConnectionRow = { id:string; machine_id:string; config:z.infer<typeof endpoint>; credential_ref:string; version:number };
const sshConfig = (row:ConnectionRow):SshConnection => ({ hostname:row.config.hostname,
  port:row.config.port, username:row.config.username, hostKeyFingerprints:row.config.host_key_fingerprints });

export default async function register(app:FastifyInstance, context:ApiContext):Promise<void> {
  const registry = new ActiveRegistry();
  const desktop = await registerDesktop(app,context,registry);
  await registerSftp(app,context);
  await registerConnectionLifecycle(app,context);
  const ownedConnection = async (id:string, ownerId:string):Promise<ConnectionRow> => {
    await assertRemoteEnabled(context);
    const result = await context.db.query<ConnectionRow>(`SELECT r.id,r.machine_id,r.config,r.credential_ref,r.version
      FROM remote_connections r JOIN machines m ON m.id=r.machine_id AND m.owner_id=r.owner_id
      WHERE r.id=$1 AND r.owner_id=$2 AND r.kind='ssh' AND COALESCE(r.config->>'enabled','true')='true'`, [id,ownerId]);
    const row = result.rows[0];
    if (!row) throw new RemoteError('REMOTE_CONNECTION_NOT_FOUND',404);
    row.config=endpoint.parse(row.config);
    return row;
  };
  const secret = async (ownerId:string, row:ConnectionRow):Promise<SshCredential> =>
    credential.parse(JSON.parse(await context.secrets.get(ownerId,row.credential_ref)));

  app.get('/remote/capabilities', async () => {const enabled=await remoteAccessReady(context);return {
    terminal:{ available:enabled, transport:'websocket', account_scope:'human_management', verified_on_real_host:false },
    sftp:{ available:enabled, code:'SFTP_CHROOT_REQUIRED', reason:'Supported for operator-attested OpenSSH chroot-only accounts after root marker, known-outside-canary denial and hash round-trip tests. Broad SSH accounts and unverified Windows ACL scopes remain unavailable.' },
    desktop:{ available:enabled&&desktop.configured&&gatewayLeaseReady(context), code:desktop.configured?'DESKTOP_GATEWAY_LEASE_REQUIRED':'DESKTOP_GATEWAY_UNCONFIGURED',
      reason:desktop.configured?'Session-bound WebSocket/HTTP gateway requires a fresh authoritative Guacamole session-lease extension heartbeat. Each desktop still requires actual display/control and session-mode testing.':'Configure the internal Guacamole 1.6.0 service and matching protected JSON key.',verified_on_real_host:false },
  };});

  app.get('/remote/connections', async request => {
    const result = await context.db.query(`SELECT id,machine_id,kind,version,created_at,
      config - 'password' - 'privateKey' - 'passphrase' AS config FROM remote_connections WHERE owner_id=$1 ORDER BY created_at`,[request.actor!.id]);
    return { items:result.rows };
  });

  app.post('/remote/connections', async (request,reply) => {
    const body = createConnection.parse(request.body);
    const ownerId = request.actor!.id;
    const machine = await context.db.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2',[body.machine_id,ownerId]);
    if (!machine.rowCount) throw new RemoteError('MACHINE_NOT_FOUND',404);
    const id = randomUUID();
    const secretId = await context.secrets.put(ownerId,`SSH connection ${id}`,JSON.stringify(body.credential));
    await context.db.query(`INSERT INTO remote_connections(id,owner_id,machine_id,kind,config,credential_ref,version)
      VALUES($1,$2,$3,'ssh',$4,$5,1)`,[id,ownerId,body.machine_id,body.config,secretId]);
    await context.db.query(`UPDATE machines SET capabilities=jsonb_set(capabilities,'{ssh}',
      $3::jsonb),updated_at=now() WHERE id=$1 AND owner_id=$2`,[body.machine_id,ownerId,JSON.stringify({
        supported:null,configured:true,permitted:false,health_state:'unverified',observed_at:null,
        last_test_at:null,last_success_at:null,reason:'SSH connection configured; actual identity, PTY, and policy verification are outstanding.',
      })]);
    await context.audit(ownerId,'remote.connection.create',id,'configured',{ machine_id:body.machine_id,kind:'ssh',verified_on_real_host:false });
    return reply.code(201).send({id,machine_id:body.machine_id,kind:'ssh',version:1,health_state:'unverified'});
  });

  app.post('/remote/connections/:id/test', async request => {
    const id = IdSchema.parse((request.params as {id:string}).id);
    const row = await ownedConnection(id,request.actor!.id);
    try {
      const client = await connectSsh(sshConfig(row),await secret(request.actor!.id,row));
      client.end();
      await context.audit(request.actor!.id,'remote.ssh.authentication_test',id,'succeeded');
      return { authentication:'passed', host_key:'matched', identity:'unverified', pty:'unverified', sftp:'unverified',
        reason:'Authentication alone does not establish identity, shell behavior, file confinement, or desktop capability.' };
    } catch (error) {
      await context.audit(request.actor!.id,'remote.ssh.authentication_test',id,'failed');
      throw error;
    }
  });

  app.post('/terminals', async (request,reply) => {
    if (context.config.restoreMode) throw new RemoteError('RESTORE_MODE_REMOTE_DISABLED',503);
    const body = launch.parse(request.body);
    const row = await ownedConnection(body.connection_id,request.actor!.id);
    if(row.config.account_scope!=='human_management')throw new RemoteError('SSH_ACCOUNT_SFTP_ONLY',403);
    const {id,ticket,expiresAt}=await issueRemoteSession(context.db,{ownerId:request.actor!.id,authSessionId:request.sessionId!,connectionId:row.id,connectionVersion:row.version,kind:'terminal'});
    await context.audit(request.actor!.id,'remote.terminal.issue',id,'issued',{machine_id:row.machine_id});
    reply.header('Cache-Control','no-store');
    return reply.code(201).send({id,ticket,expires_at:expiresAt.toISOString(),socket_path:`/api/v1/terminals/${id}/socket`,account_scope:'human_management'});
  });

  app.get('/terminals/:id/socket',{websocket:true,preValidation:async request => {
    requireOrigin(request.headers.origin,context.config.origin);
    await assertRemoteEnabled(context);
  }},(socket:WebSocket,request) => {
    let attached = false;
    const timer = setTimeout(() => socket.close(1008,'Attach required'),5_000);
    timer.unref();
    socket.once('close',() => clearTimeout(timer));
    socket.once('message',raw => {
      if (attached) return;
      attached = true;
      clearTimeout(timer);
      void (async () => {
        requireOrigin(request.headers.origin,context.config.origin);
        await assertRemoteEnabled(context);
        const id = IdSchema.parse((request.params as {id:string}).id);
        if (Buffer.byteLength(raw.toString())>512) throw new RemoteError('REMOTE_TICKET_INVALID');
        const message = z.object({type:z.literal('attach'),ticket:z.string()}).strict().parse(JSON.parse(raw.toString()));
        const result = await context.db.query<{connection_id:string}>(`UPDATE remote_sessions r SET ticket_consumed_at=now(),state='active',expires_at=now()+interval '8 hours'
          FROM sessions s WHERE r.id=$1 AND r.owner_id=$2 AND r.auth_session_id=$3 AND r.kind='terminal' AND r.state='issued'
          AND r.revoked_at IS NULL AND r.ticket_consumed_at IS NULL AND r.expires_at>now() AND r.ticket_hash=$4
          AND s.id=r.auth_session_id AND s.user_id=r.owner_id AND s.revoked_at IS NULL AND s.expires_at>now() RETURNING r.connection_id`,
          [id,request.actor!.id,request.sessionId,ticketHash(message.ticket)]);
        if (!result.rows[0]) throw new RemoteError('REMOTE_TICKET_DENIED');
        const expiresAt = Date.now()+8*60*60_000;
        // Register pending SSH handshakes too, so logout/revoke cannot leave a late tunnel alive.
        let cancelled = false;
        let stop: (()=>void)|undefined;
        registry.add(id,{ownerId:request.actor!.id,authSessionId:request.sessionId!,expiresAt,
          close:() => {cancelled=true; stop?.(); socket.close(1008,'Session revoked');}});
        socket.once('close',() => {cancelled=true; stop?.(); registry.remove(id);});
        try {
          const row = await ownedConnection(result.rows[0].connection_id,request.actor!.id);
          const client = await connectSsh(sshConfig(row),await secret(request.actor!.id,row));
          if (cancelled || socket.readyState!==1) {client.destroy(); return;}
          stop = await bridgeTerminal(client,socket,() => {
            registry.remove(id);
            void context.db.query("UPDATE remote_sessions SET state='closed' WHERE id=$1 AND state='active'",[id]).catch(()=>{});
            void context.audit(request.actor!.id,'remote.terminal.disconnect',id,'closed').catch(()=>{});
          });
          if (cancelled) stop();
          await context.audit(request.actor!.id,'remote.terminal.connect',id,'connected',{machine_id:row.machine_id});
        } catch (error) {
          registry.revoke(id);
          await context.db.query("UPDATE remote_sessions SET state='closed' WHERE id=$1 AND state='active'",[id]);
          throw error;
        }
      })().catch(() => socket.close(1008,'Remote access denied'));
    });
  });

  app.post('/terminals/:id/revoke', async request => {
    const id = IdSchema.parse((request.params as {id:string}).id);
    const result = await context.db.query(`UPDATE remote_sessions SET state='revoked',revoked_at=now()
      WHERE id=$1 AND owner_id=$2 AND kind='terminal' RETURNING id`,[id,request.actor!.id]);
    if (!result.rowCount) throw new RemoteError('REMOTE_SESSION_NOT_FOUND',404);
    registry.revoke(id);
    await context.audit(request.actor!.id,'remote.terminal.revoke',id,'revoked');
    return {id,state:'revoked'};
  });

  // Each process closes its own live transports on durable revocation or a DB outage.
  const sweep = setInterval(() => {
    registry.expire();
    const localIds = registry.ids();
    if (!localIds.length) return;
    void context.db.query<{id:string}>(`SELECT local.id FROM unnest($1::uuid[]) AS local(id)
      LEFT JOIN remote_sessions r ON r.id=local.id LEFT JOIN sessions s ON s.id=r.auth_session_id
      WHERE r.id IS NULL OR r.state<>'active' OR r.revoked_at IS NOT NULL OR r.expires_at<=now()
      OR s.id IS NULL OR s.user_id<>r.owner_id OR s.revoked_at IS NOT NULL OR s.expires_at<=now()
      OR NOT EXISTS(SELECT 1 FROM runtime_control WHERE singleton=true AND restore_mode=false AND maintenance_mode=false)`,[localIds]).then(result => {
        for (const row of result.rows) registry.revoke(row.id);
      }).catch(() => registry.closeAll());
  },1000);
  sweep.unref();
  app.addHook('preClose',async () => {clearInterval(sweep);registry.closeAll();});
}
