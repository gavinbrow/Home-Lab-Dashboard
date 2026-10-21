import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { access,mkdir,readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { authorize } from '@homelab/policy';
import { AgentBroker,HostRpcError } from '@homelab/transport';
import { RootedHostFileAdapter } from '@homelab/storage';
import type { Pool } from 'pg';
import type { ApiContext,ApiModule } from './core/context.js';
import { createPool } from './core/db.js';
import { HttpError } from './core/errors.js';
import { createSecretStore,parseMasterKey } from './core/secrets.js';
import { authBoundary,registerAuth } from './auth/index.js';
import domain from './modules/domain.js';
export async function buildApp(options:{db?:Pool;modules?:ApiModule[];logger?:boolean}={}){
 const production=process.env.NODE_ENV==='production',origin=process.env.APP_ORIGIN||'http://localhost:5173',cookieSecure=process.env.COOKIE_SECURE==='true';
 if(production&&(!cookieSecure||!origin.startsWith('https://')))throw new Error('Production requires HTTPS APP_ORIGIN and secure cookies');
 const app=Fastify({logger:options.logger?{redact:['req.headers.cookie','req.headers.authorization','req.body','res.headers.set-cookie']}:false,bodyLimit:2*1024*1024,trustProxy:false});
 await app.register(cookie);await app.register(websocket,{options:{maxPayload:32768}});
 app.decorateRequest('actor',null);app.decorateRequest('sessionId',null);
 const db=options.db||createPool(),key=parseMasterKey(process.env.MASTER_KEY),artifactRoot=resolve(process.env.ARTIFACT_ROOT||'./data/artifacts');
 const requiredMigrations=(await readdir(resolve('db/migrations'))).filter(name=>name.endsWith('.sql')).sort();
 const context:ApiContext={db,secrets:createSecretStore(db,key),policy:authorize,config:{origin,cookieSecure,artifactRoot,dispatchEnabled:process.env.DISPATCH_ENABLED==='true',restoreMode:process.env.RESTORE_MODE==='true'},audit:async(actorId,action,target,outcome,details={})=>{await db.query('INSERT INTO audit_events(actor_id,action,target,outcome,details)VALUES($1,$2,$3,$4,$5::jsonb)',[actorId,action,target,outcome,JSON.stringify(details)]);}};
 context.agentBroker=new AgentBroker(db);
 let stopTransientMaintenance:(()=>void)|undefined;app.addHook('onReady',async()=>{stopTransientMaintenance=context.agentBroker!.startTransientMaintenance();});app.addHook('onClose',async()=>{stopTransientMaintenance?.();});
 if(context.agentBroker.signer)context.workspaceFiles=new RootedHostFileAdapter((machine,method,path,body,options)=>context.agentBroker!.rpc(machine,method,path,body,options),64*1024*1024,{writerFencing:true});
 app.decorate('apiContext',context);
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff');reply.header('Referrer-Policy','no-referrer');reply.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");return payload;});
 app.setErrorHandler(async(error,request,reply)=>{
  if(error instanceof ZodError)return reply.code(400).send({error:{code:'validation_failed',message:'Invalid request',details:error.issues.map(i=>({path:i.path.join('.'),message:i.message}))},request_id:request.id});
  const err=error as Error&{statusCode?:number;code?:string};const status=err.statusCode&&err.statusCode>=400&&err.statusCode<600?err.statusCode:500;
  if(request.actor&&status>=400&&status<500)await context.audit(request.actor.id,'api.denied',null,'denied',{code:err.code??'request_failed',method:request.method}).catch(()=>undefined);
  const safe=error instanceof HttpError||error instanceof HostRpcError||status<500;
  return reply.code(status).send({error:{code:safe?err.code||'request_failed':'internal_error',message:safe?err.message:'Request could not be completed',...(error instanceof HostRpcError?{details:{rpc_id:error.requestId,outcome_unknown:error.outcomeUnknown}}:{})},request_id:request.id});
 });
 app.get('/healthz',async()=>({status:'alive',schema_version:1}));
 app.get('/readyz',async(_request,reply)=>{
  const checks:{[key:string]:boolean}={database:false,schema:false,artifacts:false,secret_key:!!key,database_role:!production};
  try{await db.query('SELECT 1');checks.database=true;if(production){const role=(await db.query(`SELECT NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication) AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid) AS safe FROM pg_roles r WHERE rolname=current_user`)).rows[0];checks.database_role=role?.safe===true;}const result=await db.query('SELECT name FROM schema_migrations WHERE name=ANY($1::text[])',[requiredMigrations]);checks.schema=result.rowCount===requiredMigrations.length;}catch{}
  try{await mkdir(artifactRoot,{recursive:true});await access(artifactRoot,constants.R_OK|constants.W_OK);checks.artifacts=true;}catch{}
  const ready=Object.values(checks).every(Boolean);return reply.code(ready?200:503).send({status:ready?'ready':'not_ready',checks});
 });
 await app.register(async scope=>registerAuth(scope,context),{prefix:'/api/v1'});
 const loaded:Array<{default:ApiModule;registerAgentRoutes?:ApiModule}>=[];
 if(!options.modules){for(const track of ['machines','jobs','projects','providers','remote','actions','operations'])loaded.push(await import(`./modules/${track}/index.js`));}
 for(const module of loaded)if(module.registerAgentRoutes)await module.registerAgentRoutes(app,context);
 await app.register(async scope=>{scope.addHook('preHandler',authBoundary(context));scope.addHook('preHandler',async request=>{if(!['GET','HEAD','OPTIONS'].includes(request.method)&&!request.url.startsWith('/api/v1/auth/')){const control=(await db.query('SELECT maintenance_mode,restore_mode,maintenance_job_id FROM runtime_control WHERE singleton=true')).rows[0];const reviewedResolution=/^\/api\/v1\/projects\/[0-9a-f-]{36}\/writer\/resolve-partial(?:\?|$)/i.test(request.url);const cancellation=/^\/api\/v1\/jobs\/([0-9a-f-]{36})\/cancel(?:\?|$)/i.exec(request.url);const backupCancellation=!!(cancellation&&request.method==='POST'&&control?.maintenance_mode&&!control.restore_mode&&!context.config.restoreMode&&control.maintenance_job_id===cancellation[1]&&(await db.query("SELECT id FROM jobs WHERE id=$1 AND requester_id=$2 AND kind='operations.backup'",[cancellation[1],request.actor!.id])).rowCount);const recoveryOnly=backupCancellation||reviewedResolution||/^\/api\/v1\/(?:projects\/[0-9a-f-]{36}\/writer|jobs\/[0-9a-f-]{36})\/reconcile(?:\?|$)/i.test(request.url);if((control?.maintenance_mode||control?.restore_mode||context.config.restoreMode)&&!recoveryOnly)throw new HttpError(503,'maintenance_mode','Mutation disabled during maintenance or restore');}});await domain(scope,context);for(const module of options.modules??loaded.map(x=>x.default))await module(scope,context);},{prefix:'/api/v1'});
 if(!options.db)app.addHook('onClose',async()=>{await db.end();});
 return app;
}
