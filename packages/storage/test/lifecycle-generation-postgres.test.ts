import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {authorize} from '@homelab/policy';
import {RootedHostFileAdapter,type WorkspaceBinding} from '../src/index.js';
import {migrate} from '../../../apps/api/src/core/migrate.js';
import registerProjects from '../../../apps/api/src/modules/projects/index.js';
import type {ApiContext} from '../../../apps/api/src/core/context.js';

test('actual PostgreSQL lifecycle API forwards captured generation to both binding reads and never refreshes after replacement',{skip:!process.env.HOMELAB_LOCAL_PG_URL,timeout:30000},async()=>{
 const url=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.equal(url.hostname,'127.0.0.1');
 const admin=new pg.Pool({connectionString:url.href}),name=`homelab_lifecycle_generation_${randomUUID().replaceAll('-','')}`,root=await mkdtemp(join(tmpdir(),'homelab-lifecycle-generation-'));
 let db:pg.Pool|undefined;const app=Fastify();
 try{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;db=new pg.Pool({connectionString:url.href});await migrate(db);
  const owner=randomUUID(),machine=randomUUID(),project=randomUUID(),workspace=randomUUID(),grant=randomUUID(),environment=randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash)VALUES($1,'lifecycle-generation@example.invalid','unused')",[owner]);
  await db.query("INSERT INTO machines(id,owner_id,name,os)VALUES($1,$2,'strict transport fixture','linux')",[machine,owner]);
  const generation=(await db.query('SELECT identity_generation FROM machines WHERE id=$1',[machine])).rows[0].identity_generation;
  await db.query("INSERT INTO projects(id,owner_id,name)VALUES($1,$2,'fixture')",[project,owner]);
  await db.query("INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,environment_id,environment_generation)VALUES($1,$2,$3,'fixture','container',$4,'approved','/approved','/workspace',$5,1)",[workspace,owner,project,machine,environment]);
  await db.query('INSERT INTO permission_grants(id,owner_id,tools,machine_ids,workspace_ids)VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',[grant,owner,JSON.stringify(['environment.restart','environment.rebuild','environment.remove']),JSON.stringify([machine]),JSON.stringify([workspace])]);
  let binding:WorkspaceBinding={workspace_id:workspace,approved_root_id:'approved',canonical_root:'/approved',runtime_path:'/workspace',type:'container',writable:true,quota_bytes:10737418240,revision:1,state:'active',environment_id:environment,environment_generation:1,runtime_id:'runtime-original'};
  let bindingCalls=0,rotateAfterLifecycle=false,replaced=false;const seenGenerations:string[]=[];
  const adapter=new RootedHostFileAdapter(async(target,method,path,body,options)=>{
   assert.equal(target,machine);assert.equal(options?.expectedMachineGeneration,generation,'Every RPC must use the initial workspace scope, including binding! calls');seenGenerations.push(options?.expectedMachineGeneration!);
   if(replaced)throw Object.assign(new Error('The original machine installation was replaced.'),{code:'machine_identity_changed',statusCode:409});
   if(path.endsWith('/manifest'))return{manifest:[],consistency:'best_effort',exclusions:[]};
   if(method==='GET'&&path.endsWith('/binding')){bindingCalls++;return{...binding};}
   if(method==='PUT'&&path.endsWith('/binding')){const request=body as any;binding={...binding,state:request.state,revision:binding.revision+1};return{operation_id:request.operation_id,state:'completed',result:{binding}};}
   if(method==='POST'&&path.includes('/environment/')){
    const request=body as any,action=path.split('/').at(-1);
    if(action==='rebuild')binding={...binding,revision:binding.revision+1,environment_id:randomUUID(),environment_generation:binding.environment_generation!+1,runtime_id:`runtime-${randomUUID()}`};
    if(action==='remove')binding={...binding,revision:binding.revision+1,runtime_id:null};
    if(rotateAfterLifecycle){await db!.query('UPDATE machines SET identity_generation=$2 WHERE id=$1',[machine,randomUUID()]);replaced=true;}
    return{operation_id:request.operation_id,state:'completed',result:{binding}};
   }
   throw new Error(`Unexpected fixture RPC ${method} ${path}`);
  },64*1024*1024,{writerFencing:true});
  app.decorateRequest('actor',null);app.addHook('preHandler',async request=>{request.actor={id:owner,role:'owner'};});
  await registerProjects(app,{db,policy:authorize,workspaceFiles:adapter,config:{artifactRoot:root},audit:async()=>{}} as unknown as ApiContext);
  for(const action of ['restart','rebuild','remove']){
   const before=bindingCalls,response=await app.inject({method:'POST',url:`/projects/${workspace}/environment/${action}`,payload:{operation_id:randomUUID(),grant_id:grant}});
   assert.equal(response.statusCode,200,response.body);assert.equal(bindingCalls-before,2,`${action} must scope both before/after bindings`);
  }
  const archive=await app.inject({method:'POST',url:`/projects/${workspace}/archive`,payload:{operation_id:randomUUID()}});assert.equal(archive.statusCode,200,archive.body);
  const activate=await app.inject({method:'POST',url:`/projects/${workspace}/reactivate`,payload:{operation_id:randomUUID()}});assert.equal(activate.statusCode,200,activate.body);
  rotateAfterLifecycle=true;
  const stale=await app.inject({method:'POST',url:`/projects/${workspace}/environment/rebuild`,payload:{operation_id:randomUUID(),grant_id:grant}});
  assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().code,'machine_identity_changed');
  assert.ok(seenGenerations.length>10);assert.ok(seenGenerations.every(value=>value===generation));
  assert.equal((await db.query('SELECT state FROM workspace_locks WHERE workspace_id=$1',[workspace])).rows[0].state,'outcome_unknown','Replacement must not turn an unknown lifecycle result into an unlocked writer');
 }finally{await app.close();await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);await admin.end();await rm(root,{recursive:true,force:true});}
});
