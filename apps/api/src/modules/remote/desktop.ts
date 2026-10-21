import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { IdSchema } from '@homelab/contracts';
import type { ApiContext } from '../../core/context.js';
import { ActiveRegistry, encryptDesktopDefinition, RemoteError, requireOrigin, ticketHash } from './security.js';
import { GuacamoleHttpSession, guacamoleSettings } from './guacamole.js';
import { gatewayLeaseReady } from './gateway-control.js';
import { assertRemoteEnabled } from './lifecycle.js';
import { issueRemoteSession } from './sessions.js';

const configSchema=z.object({enabled:z.boolean().default(true),hostname:z.string().min(1).max(253).regex(/^[^\s/\\\0]+$/),port:z.number().int().min(1).max(65535),
  protocol:z.enum(['rdp','vnc']),username:z.string().max(256).optional(),domain:z.string().max(256).optional(),
  session_mode:z.enum(['physical_screen','remote_session','unverified']).default('unverified'),
  session_mode_verified:z.boolean().default(false),server_type:z.string().min(1).max(128),
  observation:z.object({observed_at:z.string().datetime(),local_screen_behavior:z.enum(['remains_visible','locks','other']),keyboard:z.literal(true),mouse:z.literal(true),resize:z.literal(true),reconnect:z.literal(true)}).optional(),
}).strict();
const credentialSchema=z.object({password:z.string().max(4096)}).strict();
const launchSchema=z.object({connection_id:IdSchema}).strict();
const attachSchema=z.object({ticket:z.string(),width:z.number().int().min(320).max(7680).default(1280),height:z.number().int().min(200).max(4320).default(800)}).strict();
type DesktopEntry={upstream:GuacamoleHttpSession;ownerId:string;authSessionId:string;mode:'websocket'|'http'|null;reads:number;lastInputAt:number};

export async function registerDesktop(app:FastifyInstance,context:ApiContext,registry:ActiveRegistry):Promise<{configured:boolean}> {
  const settings=await guacamoleSettings();
  const entries=new Map<string,DesktopEntry>();
  const connection=async(id:string,owner:string)=>{
    const row=(await context.db.query(`SELECT r.* FROM remote_connections r JOIN machines m ON m.id=r.machine_id AND m.owner_id=r.owner_id
      WHERE r.id=$1 AND r.owner_id=$2 AND r.kind='desktop' AND COALESCE(r.config->>'enabled','true')='true'`,[id,owner])).rows[0];
    if(!row)throw new RemoteError('DESKTOP_CONNECTION_NOT_FOUND',404);
    return {...row,config:configSchema.parse(row.config)};
  };
  const current=async(request:FastifyRequest):Promise<{id:string;entry:DesktopEntry}>=>{
    await assertRemoteEnabled(context);
    const id=IdSchema.parse((request.params as {id:string}).id),entry=entries.get(id);
    if(!entry||entry.ownerId!==request.actor!.id||entry.authSessionId!==request.sessionId||entry.upstream.isClosed)
      throw new RemoteError('DESKTOP_SESSION_NOT_FOUND',404);
    const allowed=await context.db.query(`SELECT r.id FROM remote_sessions r JOIN sessions s ON s.id=r.auth_session_id
      WHERE r.id=$1 AND r.owner_id=$2 AND r.auth_session_id=$3 AND r.kind='desktop' AND r.state='active'
      AND r.revoked_at IS NULL AND r.expires_at>now() AND s.user_id=r.owner_id AND s.revoked_at IS NULL AND s.expires_at>now()`,[id,request.actor!.id,request.sessionId]);
    if(!allowed.rowCount){registry.revoke(id);throw new RemoteError('DESKTOP_SESSION_REVOKED',403);}
    return {id,entry};
  };
  await app.register(async scope=>{
    scope.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_request,body,done)=>done(null,body));
    scope.addContentTypeParser('application/octet-stream',{parseAs:'string',bodyLimit:65_536},(_request,body,done)=>done(null,body));
    scope.post('/remote/desktop-connections',async(request,reply)=>{
      const body=z.object({machine_id:IdSchema,config:configSchema.refine(value=>!value.session_mode_verified&&!value.observation,'Observation is recorded separately after a successful session'),credential:credentialSchema}).strict().parse(request.body);
      const owner=request.actor!.id;
      if(!(await context.db.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2',[body.machine_id,owner])).rowCount)throw new RemoteError('MACHINE_NOT_FOUND',404);
      const id=randomUUID(),secret=await context.secrets.put(owner,`Desktop connection ${id}`,JSON.stringify(body.credential));
      await context.db.query(`INSERT INTO remote_connections(id,owner_id,machine_id,kind,config,credential_ref,version) VALUES($1,$2,$3,'desktop',$4,$5,1)`,[id,owner,body.machine_id,body.config,secret]);
      await context.db.query(`UPDATE machines SET capabilities=jsonb_set(capabilities,'{desktop}',$3::jsonb),updated_at=now() WHERE id=$1 AND owner_id=$2`,[body.machine_id,owner,JSON.stringify({supported:null,configured:true,permitted:false,health_state:'unverified',observed_at:null,last_test_at:null,last_success_at:null,reason:'Desktop configured; actual display/control and session-mode observation remain unverified.'})]);
      await context.audit(owner,'remote.desktop_connection.create',id,'configured',{machine_id:body.machine_id,protocol:body.config.protocol});
      return reply.code(201).send({id,machine_id:body.machine_id,kind:'desktop',version:1,health_state:'unverified'});
    });
    scope.post('/desktop-sessions',async(request,reply)=>{
      await assertRemoteEnabled(context);
      if(!settings)return reply.code(503).send({error:{code:'DESKTOP_GATEWAY_UNCONFIGURED',message:'Configure the internal Guacamole 1.6.0 service and matching protected JSON authentication key.'}});
      if(!gatewayLeaseReady(context))return reply.code(503).send({error:{code:'DESKTOP_GATEWAY_LEASE_REQUIRED',message:'The Guacamole authoritative session-lease extension has not reported a fresh heartbeat.'}});
      if(context.config.restoreMode)throw new RemoteError('RESTORE_MODE_REMOTE_DISABLED',503);
      const body=launchSchema.parse(request.body),row=await connection(body.connection_id,request.actor!.id);
      const {id,ticket,expiresAt}=await issueRemoteSession(context.db,{ownerId:request.actor!.id,authSessionId:request.sessionId!,connectionId:row.id,connectionVersion:row.version,kind:'desktop'});
      await context.audit(request.actor!.id,'remote.desktop.issue',id,'issued',{machine_id:row.machine_id});
      reply.header('Cache-Control','no-store');
      return reply.code(201).send({id,ticket,expires_at:expiresAt.toISOString(),session_mode:row.config.session_mode,session_mode_verified:row.config.session_mode_verified});
    });
    scope.post('/desktop-sessions/:id/attach',async(request,reply)=>{
      await assertRemoteEnabled(context);
      if(!settings||context.config.restoreMode)throw new RemoteError('DESKTOP_GATEWAY_UNAVAILABLE',503);
      if(!gatewayLeaseReady(context))throw new RemoteError('DESKTOP_GATEWAY_LEASE_REQUIRED',503);
      const id=IdSchema.parse((request.params as {id:string}).id),body=attachSchema.parse(request.body);
      const row=(await context.db.query<{connection_id:string}>(`UPDATE remote_sessions r SET state='active',ticket_consumed_at=now(),expires_at=now()+interval '8 hours'
        FROM sessions s WHERE r.id=$1 AND r.owner_id=$2 AND r.auth_session_id=$3 AND r.kind='desktop' AND r.state='issued'
        AND r.revoked_at IS NULL AND r.ticket_consumed_at IS NULL AND r.expires_at>now() AND r.ticket_hash=$4
        AND s.id=r.auth_session_id AND s.user_id=r.owner_id AND s.revoked_at IS NULL AND s.expires_at>now() RETURNING r.connection_id`,[id,request.actor!.id,request.sessionId,ticketHash(body.ticket)])).rows[0];
      if(!row)throw new RemoteError('DESKTOP_TICKET_DENIED',403);
      const upstream=new GuacamoleHttpSession(settings);
      const entry:DesktopEntry={upstream,ownerId:request.actor!.id,authSessionId:request.sessionId!,mode:null,reads:0,lastInputAt:Date.now()};
      entries.set(id,entry);
      registry.add(id,{ownerId:entry.ownerId,authSessionId:entry.authSessionId,expiresAt:Date.now()+8*60*60_000,close:()=>upstream.close()});
      upstream.onClose(()=>{
        entries.delete(id);registry.remove(id);
        void context.db.query("UPDATE remote_sessions SET state='closed' WHERE id=$1 AND state='active'",[id]).catch(()=>{});
        void context.audit(entry.ownerId,'remote.desktop.disconnect',id,'closed').catch(()=>{});
      });
      try{
        const target=await connection(row.connection_id,entry.ownerId);
        const secret=credentialSchema.parse(JSON.parse(await context.secrets.get(entry.ownerId,target.credential_ref)));
        await upstream.connect(encryptDesktopDefinition({sessionId:id,expiresAt:Date.now()+45_000,...target.config,password:secret.password},settings.key),id,body.width,body.height);
        await current(request);
        await context.audit(entry.ownerId,'remote.desktop.connect',id,'connected',{machine_id:target.machine_id,connection_version:target.version,protocol:target.config.protocol,session_mode:target.config.session_mode,session_mode_verified:target.config.session_mode_verified});
        reply.header('Cache-Control','no-store');
        return {id,tunnel_path:`/api/v1/desktop-sessions/${id}/tunnel`,session_mode:target.config.session_mode,session_mode_verified:target.config.session_mode_verified};
      }catch(error){upstream.close();throw error;}
    });
    scope.post('/desktop-sessions/:id/revoke',async request=>{
      const id=IdSchema.parse((request.params as {id:string}).id);
      const result=await context.db.query("UPDATE remote_sessions SET state='revoked',revoked_at=now() WHERE id=$1 AND owner_id=$2 AND kind='desktop' RETURNING id",[id,request.actor!.id]);
      if(!result.rowCount)throw new RemoteError('DESKTOP_SESSION_NOT_FOUND',404);
      registry.revoke(id);
      await context.audit(request.actor!.id,'remote.desktop.revoke',id,'revoked');
      return {id,state:'revoked'};
    });
    scope.post('/remote/desktop-connections/:id/observation',async request=>{
      const id=IdSchema.parse((request.params as {id:string}).id),target=await connection(id,request.actor!.id);
      const body=z.object({desktop_session_id:IdSchema,operator_observed:z.literal(true),session_mode:z.enum(['physical_screen','remote_session']),local_screen_behavior:z.enum(['remains_visible','locks','other']),keyboard:z.literal(true),mouse:z.literal(true),resize:z.literal(true),reconnect:z.literal(true)}).strict().parse(request.body);
      const connected=await context.db.query(`SELECT r.id FROM remote_sessions r JOIN audit_events a ON a.target=r.id::text AND a.actor_id=r.owner_id
        WHERE r.id=$1 AND r.connection_id=$2 AND r.owner_id=$3 AND r.auth_session_id=$4 AND r.kind='desktop'
        AND a.action='remote.desktop.connect' AND a.outcome='connected' AND a.created_at>now()-interval '1 hour'
        AND a.details->>'connection_version'=$5`,[body.desktop_session_id,id,request.actor!.id,request.sessionId,String(target.version)]);
      if(!connected.rowCount)throw new RemoteError('DESKTOP_OBSERVED_SESSION_REQUIRED',409);
      const now=new Date().toISOString(),observation={observed_at:now,local_screen_behavior:body.local_screen_behavior,keyboard:true as const,mouse:true as const,resize:true as const,reconnect:true as const};
      await context.db.query(`UPDATE remote_connections SET config=$3 WHERE id=$1 AND owner_id=$2 AND version=$4`,[id,request.actor!.id,{...target.config,session_mode:body.session_mode,session_mode_verified:true,observation},target.version]);
      await context.db.query(`UPDATE machines SET capabilities=jsonb_set(capabilities,'{desktop}',$3::jsonb),updated_at=now() WHERE id=$1 AND owner_id=$2`,[target.machine_id,request.actor!.id,JSON.stringify({supported:true,configured:true,permitted:true,health_state:'healthy',observed_at:now,last_test_at:now,last_success_at:now,reason:`Operator observed ${body.session_mode}, local screen ${body.local_screen_behavior}, keyboard/mouse/resize/reconnect after an authenticated desktop session.`})]);
      await context.audit(request.actor!.id,'remote.desktop.observation',id,'operator_verified',{desktop_session_id:body.desktop_session_id,connection_version:target.version,session_mode:body.session_mode,...observation});
      return {id,session_mode:body.session_mode,session_mode_verified:true,observation};
    });
    scope.get('/desktop-sessions/:id/tunnel/websocket',{websocket:true,preHandler:async request=>{
      requireOrigin(request.headers.origin,context.config.origin);
      const {entry}=await current(request);if(entry.mode)throw new RemoteError('DESKTOP_TRANSPORT_ALREADY_ATTACHED',409);
      if(Object.keys(request.query as object).length)throw new RemoteError('DESKTOP_TUNNEL_PARAMETERS_DENIED',400);
    }},(socket:WebSocket,request)=>{
      const id=(request.params as {id:string}).id,entry=entries.get(id)!;
      if(!entry||entry.mode){socket.close(1008);return;}entry.mode='websocket';
      entry.upstream.onClose(()=>socket.terminate());
      socket.once('close',()=>entry.upstream.close());socket.on('error',()=>entry.upstream.close());
      socket.send(`0.,36.${id};`);
      socket.on('message',data=>{
        const value=data.toString();
        if(/^0\.,4\.ping,\d{1,2}\.\d{1,20};$/.test(value)){if(socket.readyState===1)socket.send(value);return;}
        if(/^(3\.key|5\.mouse|4\.size),/.test(value))entry.lastInputAt=Date.now();
        try{void entry.upstream.write(value).catch(()=>entry.upstream.close());}catch{entry.upstream.close();}
      });
      void(async()=>{
        const decoder=new StringDecoder('utf8');
        while(!entry.upstream.isClosed){
          const stream=await entry.upstream.read();
          for await(const chunk of stream){
            if(socket.readyState!==1||socket.bufferedAmount>2_097_152){entry.upstream.close();return;}
            const text=decoder.write(chunk);if(text)socket.send(text);
          }
        }
      })().catch(()=>entry.upstream.close());
    });
    scope.route({method:['GET','POST'],url:'/desktop-sessions/:id/tunnel/http',bodyLimit:65_536,handler:async(request,reply)=>{
      if(request.headers.origin)requireOrigin(request.headers.origin,context.config.origin);
      const {id,entry}=await current(request),query=request.raw.url!.split('?')[1]||'';
      reply.header('Cache-Control','no-store');reply.header('Content-Type','application/octet-stream');
      if(query==='connect'&&request.method==='POST'){
        if(entry.mode)throw new RemoteError('DESKTOP_TRANSPORT_ALREADY_ATTACHED',409);
        entry.mode='http';
        // Non-bearer compatibility value: every operation still requires the bound app session.
        return reply.header('Guacamole-Tunnel-Token',id).send(id);
      }
      if(entry.mode!=='http')throw new RemoteError('DESKTOP_TRANSPORT_NOT_ATTACHED',409);
      if(query===`write:${id}`&&request.method==='POST'){
        const data=typeof request.body==='string'?request.body:'';
        if(/^(3\.key|5\.mouse|4\.size),/.test(data))entry.lastInputAt=Date.now();
        await entry.upstream.write(data);return reply.send('');
      }
      if(new RegExp(`^read:${id}:\\d{1,10}$`).test(query)&&request.method==='GET'){
        if(entry.reads>=2)throw new RemoteError('DESKTOP_TOO_MANY_READS',429);
        entry.reads++;
        try{
          const stream=await entry.upstream.read();let finished=false;
          stream.once('end',()=>{finished=true;});
          const unsubscribe=entry.upstream.onClose(()=>{stream.destroy();reply.raw.destroy();});
          reply.raw.once('close',()=>{unsubscribe();entry.reads--;if(!finished)entry.upstream.close();});
          return reply.send(stream);
        }catch(error){entry.reads--;entry.upstream.close();throw error;}
      }
      throw new RemoteError('DESKTOP_TUNNEL_OPERATION_DENIED',400);
    }});
    const idle=setInterval(()=>{for(const [id,entry]of entries)if(Date.now()-entry.lastInputAt>15*60_000)registry.revoke(id);},10_000);idle.unref();
    scope.addHook('preClose',async()=>{clearInterval(idle);for(const entry of entries.values())entry.upstream.close();});
  });
  return {configured:settings!==null};
}
