import { createHmac,timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../../core/context.js';
import { guacamoleSettings } from './guacamole.js';
import { remoteAccessReady } from './lifecycle.js';

const leases=new WeakMap<ApiContext,{lastHeartbeat:number}>();
export const gatewayControlToken=(key:Buffer):string=>createHmac('sha256',key).update('homelab-guacamole-session-lease-v1').digest('hex');
export function gatewayLeaseReady(context:ApiContext):boolean {
  const state=leases.get(context);return Boolean(state&&Date.now()-state.lastHeartbeat<5000);
}

/** Internal service authentication, deliberately separate from browser sessions. */
export async function registerGatewayControl(app:FastifyInstance,context:ApiContext):Promise<void> {
  const settings=await guacamoleSettings(),state={lastHeartbeat:0};leases.set(context,state);
  app.post('/internal/remote/desktop-session-check',async(request,reply)=>{
    const expected=settings?`Bearer ${gatewayControlToken(settings.key)}`:'';
    const received=request.headers.authorization||'';
    if(!expected||Buffer.byteLength(expected)!==Buffer.byteLength(received)||!timingSafeEqual(Buffer.from(expected),Buffer.from(received)))return reply.code(403).send();
    const body=z.object({session_id:z.uuid().nullable(),extension_version:z.literal('1.0.0'),guacamole_version:z.literal('1.6.0')}).strict().safeParse(request.body);
    if(!body.success)return reply.code(400).send();
    if(!await remoteAccessReady(context))return reply.code(403).send();
    if(body.data.session_id===null){state.lastHeartbeat=Date.now();return reply.code(204).send();}
    const result=await context.db.query(`SELECT r.id FROM remote_sessions r JOIN sessions s ON s.id=r.auth_session_id
      WHERE r.id=$1 AND r.kind='desktop' AND r.state='active' AND r.revoked_at IS NULL AND r.expires_at>now()
      AND s.user_id=r.owner_id AND s.revoked_at IS NULL AND s.expires_at>now()`,[body.data.session_id]);
    return reply.code(result.rowCount?204:403).send();
  });
}
