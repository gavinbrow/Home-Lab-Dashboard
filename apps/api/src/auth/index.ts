import { createHash,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiContext } from '../core/context.js';
import { HttpError } from '../core/errors.js';
import { hashPassword,verifyPassword } from './password.js';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const credentials=z.object({email:z.email().max(254).transform(s=>s.toLowerCase()),password:z.string().min(12).max(1024)});
export function authBoundary(context:ApiContext){return async(request:FastifyRequest,reply:FastifyReply)=>{
 const token=request.cookies.homelab_session;
 if(!token)throw new HttpError(401,'unauthenticated','Sign in required');
 const result=await context.db.query('SELECT s.id,s.user_id,s.csrf_token FROM sessions s WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()',[digest(token)]);
 const row=result.rows[0];if(!row)throw new HttpError(401,'session_expired','Sign in required');
 request.actor={id:row.user_id,role:'owner'};request.sessionId=row.id;
 if(!['GET','HEAD','OPTIONS'].includes(request.method)) {
  if(request.headers.origin!==context.config.origin || request.headers['x-csrf-token']!==row.csrf_token)throw new HttpError(403,'csrf_failed','Invalid request origin or CSRF token');
 }
 reply.header('Cache-Control','no-store');
};}
export async function registerAuth(app:FastifyInstance,context:ApiContext){
 const dummyPasswordHash=await hashPassword(randomBytes(32).toString('base64url'));
 const attempts=new Map<string,{count:number;reset:number}>();
 const rate=(request:FastifyRequest)=>{const now=Date.now();for(const [key,value]of attempts)if(value.reset<now)attempts.delete(key);const item=attempts.get(request.ip)||{count:0,reset:now+900000};if(++item.count>10)throw new HttpError(429,'login_limited','Try again later');attempts.set(request.ip,item);};
 const checkOrigin=(request:FastifyRequest)=>{if(request.headers.origin!==context.config.origin)throw new HttpError(403,'origin_denied','Invalid request origin');};
 async function startSession(userId:string,reply:FastifyReply){
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),id=randomUUID();
  await context.db.query("INSERT INTO sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,$4,now()+interval '12 hours')",[id,userId,digest(token),csrf]);
  reply.setCookie('homelab_session',token,{httpOnly:true,secure:context.config.cookieSecure,sameSite:'strict',path:'/',maxAge:43200});
  return {actor:{id:userId,role:'owner'},csrf_token:csrf};
 }
 app.get('/auth/status',async()=>({bootstrap_required:(await context.db.query('SELECT 1 FROM users LIMIT 1')).rowCount===0}));
 app.post('/auth/bootstrap',async(request,reply)=>{
  checkOrigin(request);rate(request);
  const body=credentials.extend({token:z.string().min(32).max(1024)}).parse(request.body),expected=process.env.BOOTSTRAP_TOKEN||'';
  if(expected.length<32 || Buffer.byteLength(body.token)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(body.token),Buffer.from(expected)))throw new HttpError(403,'bootstrap_denied','Invalid bootstrap credential');
  const passwordHash=await hashPassword(body.password),client=await context.db.connect(),id=randomUUID();
  try {await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(474345740)');if((await client.query('SELECT 1 FROM users LIMIT 1')).rows.length)throw new HttpError(409,'already_initialized','Owner already initialized');await client.query('INSERT INTO users(id,email,password_hash)VALUES($1,$2,$3)',[id,body.email,passwordHash]);await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await context.audit(id,'owner.bootstrap',id,'success');return startSession(id,reply);
 });
 app.post('/auth/login',async(request,reply)=>{
  checkOrigin(request);rate(request);const body=credentials.parse(request.body);
  const row=(await context.db.query('SELECT * FROM users WHERE email=$1',[body.email])).rows[0];
  const valid=await verifyPassword(body.password,row?.password_hash||dummyPasswordHash);
  if(!row||!valid){await context.audit(null,'auth.login',null,'denied');throw new HttpError(401,'invalid_credentials','Invalid email or password');}
  await context.audit(row.id,'auth.login',row.id,'success');return startSession(row.id,reply);
 });
 app.get('/auth/session',{preHandler:authBoundary(context)},async(request)=>{const row=(await context.db.query('SELECT csrf_token FROM sessions WHERE id=$1',[request.sessionId])).rows[0];return {actor:request.actor,csrf_token:row.csrf_token};});
 app.post('/auth/logout',{preHandler:authBoundary(context)},async(request,reply)=>{await context.db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[request.sessionId]);reply.clearCookie('homelab_session',{path:'/'});await context.audit(request.actor!.id,'auth.logout',request.sessionId,'success');return {ok:true};});
}
