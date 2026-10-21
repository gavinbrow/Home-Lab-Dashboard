import type { FastifyInstance } from "fastify";
import type { ApiContext } from "../../core/context.js";
import { z } from "zod";
import { ExecutionContextSchema,RunContextSchema, type RunContext, type Workspace, type PolicyGrant } from "@homelab/contracts";
import {probeValidity} from '@homelab/providers';
import {captureExecution} from './execution.js';
import {registerWorkspaceTerminals} from './terminals.js';
import {jobTiming} from './timing.js';
import {registerConversationExports} from './exports.js';
import { resolveRunContext } from "@homelab/policy";
import { submitJob, cancelJob,digest } from "@homelab/worker";
import { providerSnapshot } from "../providers/index.js";
import { resolveProfile,assertProviderScope,captureMachineGenerations } from "@homelab/worker/authority";
import { BlobStore,loadRetainedAttachments } from '@homelab/storage';
import { encodeSse, parseCursor } from "./sse.js";
import {registerLifecycleRoutes} from './lifecycle.js';
const id=z.uuid();
const publicJob=`id,kind,context,workspace_id,state,reason,result,previous_job_id,modifies_workspace,cancel_requested,created_at,started_at,ended_at,updated_at,last_heartbeat_at,lease_until AS last_lease_until,payload->'execution_context' AS execution_context`;
const createSchema=z.object({idempotency_key:z.string().min(1).max(200),kind:z.enum(["chat","command","agent"]),context:RunContextSchema,payload:z.object({prompt:z.string().max(100000).optional(),conversation_id:id.optional(),attachment_ids:z.array(id).max(8).default([]),command:z.object({executable:z.string().min(1).max(4096),args:z.array(z.string().max(16384)).max(200)}).optional()}).strict(),grant_id:id.optional(),modifies_workspace:z.boolean().default(false)}).strict();
function bad(code:string,message:string,statusCode=400):never { throw Object.assign(new Error(message),{code,statusCode}); }

export default async function register(app:FastifyInstance,context:ApiContext):Promise<void>{
  await registerLifecycleRoutes(app,context);
  await registerWorkspaceTerminals(app,context);
  await registerConversationExports(app,context);
  app.post('/jobs/commands/preflight',async request=>{const body=z.object({execution_context:ExecutionContextSchema,grant_id:id}).strict().parse(request.body);return (await captureExecution(context,request.actor!,body.execution_context,body.grant_id,['run_command'])).execution_context;});
  app.post('/jobs/commands',async(request,reply)=>{
   const body=z.object({idempotency_key:z.string().min(1).max(200),execution_context:ExecutionContextSchema,grant_id:id,command:z.object({executable:z.string().min(1).max(4096),args:z.array(z.string().max(16384)).max(200)}).strict()}).strict().parse(request.body);
   const hash=digest(body),previous=(await context.db.query('SELECT id,state,payload FROM jobs WHERE requester_id=$1 AND idempotency_key=$2',[request.actor!.id,body.idempotency_key])).rows[0];if(previous){if(previous.payload.client_request_hash!==hash)bad('idempotency_conflict','Idempotency conflict',409);return reply.code(202).send({id:previous.id,state:previous.state});}
   const captured=await captureExecution(context,request.actor!,body.execution_context,body.grant_id,['run_command']);
   const job=await submitJob(context.db,{requester_id:request.actor!.id,idempotency_key:body.idempotency_key,kind:'command',context:null,workspace_id:body.execution_context.workspace_id,modifies_workspace:true,payload:{...captured,command:body.command,client_request_hash:hash}});return reply.code(202).send({id:job.id,state:job.state,execution_context:captured.execution_context});
  });
  const validate=async(run:RunContext,owner:string)=>{
    const provider=(await context.db.query("SELECT * FROM providers WHERE id=$1 AND owner_id=$2",[run.provider_id,owner])).rows[0];
    if(!provider)bad("provider_not_found","Provider not found",404);
    if(provider.revision!==run.provider_config_revision||provider.endpoint!==run.provider_endpoint||provider.adapter!==run.provider_adapter)bad("provider_revision_conflict","Provider configuration changed",409);
    let workspace:Workspace|null=null;
    if(run.workspace_id)workspace=(await context.db.query<Workspace>("SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2",[run.workspace_id,owner])).rows[0]??null;
    if(workspace&&run.project_instruction_revision!==workspace.instruction_revision)bad("instruction_revision_conflict","Project instructions changed",409);
    if(run.execution_identity_id){
      const identity=(await context.db.query("SELECT * FROM execution_identities WHERE id=$1 AND owner_id=$2 AND machine_id=$3",[run.execution_identity_id,owner,run.execution_machine_id])).rows[0];
      if(!identity)bad("identity_not_found","Execution identity not found",404);
    }
    if(run.profile_id){
      const profile=(await context.db.query("SELECT r.definition FROM agent_profile_revisions r JOIN agent_profiles p ON p.id=r.profile_id WHERE r.profile_id=$1 AND r.revision=$2 AND p.owner_id=$3 AND p.archived_at IS NULL",[run.profile_id,run.profile_revision,owner])).rows[0];
      if(!profile)bad("profile_not_found","Profile revision unavailable",404);
    }
    try{return {context:resolveRunContext(run,workspace),provider};}catch(e){bad("context_conflict",e instanceof Error?e.message:"Invalid context",409);}
  };
  app.post("/jobs/preflight",async request=>{const body=z.object({context:RunContextSchema}).parse(request.body);await resolveProfile(context.db,request.actor!.id,body.context);return (await validate(body.context,request.actor!.id)).context;});
  app.post("/jobs",async(request,reply)=>{
    const body=createSchema.parse(request.body);const actor=request.actor!;
    const clientHash=digest(body);const previous=(await context.db.query("SELECT id,state,context,payload FROM jobs WHERE requester_id=$1 AND idempotency_key=$2",[actor.id,body.idempotency_key])).rows[0];
    if(previous){if(previous.payload.client_request_hash!==clientHash)bad("idempotency_conflict","Idempotency key reused with different request",409);return reply.code(202).send({id:previous.id,state:previous.state,context:previous.context});}
    const machine_identity_generations=await captureMachineGenerations(context.db,actor.id,[body.context.execution_machine_id]);
    const resolved=await validate(body.context,actor.id);
    let profile;try{profile=await resolveProfile(context.db,actor.id,body.context,body.kind==="command"?"run_command":undefined);}catch(error){bad("profile_scope_denied",error instanceof Error?error.message:"Profile denied",403);}
    if(body.kind==="agent"&&!profile)bad("profile_required","Agent tasks require a profile",400);
    for(const capability of new Set([...(profile?.required_capabilities??[]),...(body.kind==='agent'?['tools']:[])])){if(!(await probeValidity(context.db,body.context.provider_id,body.context.model_id,body.context.provider_config_revision,capability)).valid)bad("capability_unverified",`Required model capability ${capability} is unverified`,409);}
    if(body.kind==="chat"&&(body.context.workspace_id||body.modifies_workspace))bad("plain_chat_scope","Plain chat has no execution workspace");
    if(body.kind!=="chat"&&!body.context.workspace_id)bad("workspace_required","Execution jobs require a workspace");
    if(body.kind==="chat"&&!body.payload.prompt)bad("prompt_required","Chat prompt required");
    if(body.kind==="command"&&!body.payload.command)bad("command_required","Command executable and arguments required");
    let grant:PolicyGrant|null=null;
    if(body.kind!=="chat"){
      if(!body.grant_id)bad("grant_required","A persisted execution grant is required",403);
      grant=(await context.db.query<PolicyGrant>("SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2",[body.grant_id,actor.id])).rows[0]??null;
      const decision=context.policy({actor,tool:body.kind==="command"?"run_command":"agent.run",machine_id:body.context.execution_machine_id,workspace_id:body.context.workspace_id,profile_id:body.context.profile_id,grant,current_grant:grant});
      if(!decision.allowed)bad(decision.code,decision.reason,403);
      if(body.context.policy_revision!==grant?.revision)bad("policy_revision_conflict","Policy revision changed",409);
    }
    if(body.payload.conversation_id){const conversation=await context.db.query("SELECT id FROM conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND archived_at IS NULL",[body.payload.conversation_id,actor.id]);if(!conversation.rowCount)bad("conversation_not_found","Conversation not found",404);}
    const provider=providerSnapshot(resolved.provider);await assertProviderScope(context.db,actor.id,body.context,profile??null,provider,grant??undefined);
    if(body.payload.attachment_ids.length&&!body.payload.conversation_id)bad('attachment_conversation_required','Create or select the attachment conversation before submission');
    const attachments=body.payload.attachment_ids.length?await loadRetainedAttachments(context.db,new BlobStore(context.config.artifactRoot),actor.id,body.payload.attachment_ids,body.payload.conversation_id!):[];
    for(const attachment of attachments){
      if(attachment.mime_type.startsWith('image/')){if(!(await probeValidity(context.db,body.context.provider_id,body.context.model_id,body.context.provider_config_revision,'image_input')).valid)bad('image_capability_unverified','Selected model has no passing image-input probe',409);}
      else if(!['text/plain','text/markdown','application/json','text/csv'].includes(attachment.mime_type))bad('attachment_context_unsupported','This attachment supports download but cannot be sent as model context',422);
    }
    const attachmentSnapshots=attachments.map(a=>({id:a.id,filename:a.filename,mime_type:a.mime_type,sha256:a.sha256,size_bytes:a.bytes.length}));
    const job=await submitJob(context.db,{requester_id:actor.id,idempotency_key:body.idempotency_key,kind:body.kind,context:resolved.context,payload:{...body.payload,machine_identity_generations,attachment_snapshots:attachmentSnapshots,client_request_hash:clientHash,grant,profile_snapshot:profile,provider_snapshot:provider},modifies_workspace:body.kind!=="chat"});
    await context.audit(actor.id,"job.submit",job.id,"accepted",{kind:job.kind});
    return reply.code(202).send({id:job.id,state:job.state,context:job.context});
  });
  app.get("/jobs",async request=>{
    const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),before:z.string().max(500).optional()}).parse(request.query);
    let cursor:[string,string]|undefined;if(query.before){try{cursor=z.tuple([z.iso.datetime(),id]).parse(JSON.parse(Buffer.from(query.before,'base64url').toString()));}catch{bad('invalid_cursor','Invalid job pagination cursor');}}
    const rows=(await context.db.query(`SELECT ${publicJob} FROM jobs WHERE requester_id=$1 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $2`,[request.actor!.id,query.limit+1,cursor?.[0]??null,cursor?.[1]??null])).rows,more=rows.length>query.limit,items=rows.slice(0,query.limit);
    const events=items.length?(await context.db.query("SELECT job_id,type,payload,created_at FROM job_events WHERE job_id=ANY($1::uuid[]) AND type IN ('job.state','job.uncertainty') ORDER BY id",[items.map(r=>r.id)])).rows:[];
    const last=items.at(-1);return {items:items.map(row=>({...row,timing:jobTiming(row,events.filter(e=>e.job_id===row.id))})),next_cursor:more&&last?Buffer.from(JSON.stringify([last.created_at.toISOString(),last.id])).toString('base64url'):null};
  });
  app.get("/jobs/:id",async(request,reply)=>{
    const job=(await context.db.query(`SELECT ${publicJob} FROM jobs WHERE id=$1 AND requester_id=$2`,[id.parse((request.params as {id:string}).id),request.actor!.id])).rows[0];
    if(!job)return reply.code(404).send({error:{code:"not_found",message:"Job not found"}});
    const events=(await context.db.query("SELECT id::text,sequence::text,type,payload,created_at FROM job_events WHERE job_id=$1 ORDER BY id DESC LIMIT 100",[job.id])).rows.reverse();
    const operations=(await context.db.query("SELECT id,step_id,machine_id,status,receipt,outcome,created_at,updated_at FROM operations WHERE job_id=$1 ORDER BY created_at",[job.id])).rows;
    job.timing=jobTiming(job,(await context.db.query("SELECT type,payload,created_at FROM job_events WHERE job_id=$1 AND type IN ('job.state','job.uncertainty') ORDER BY id",[job.id])).rows);
    const output=(await context.db.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='output.usage' ORDER BY sequence DESC LIMIT 1",[job.id])).rows[0]?.payload;job.output_budget=output?{limit_bytes:output.limit_bytes,retained_bytes:output.cumulative_bytes,received_bytes:output.received_bytes,limited_events:output.limited_events,scope:output.scope}:null;
    job.file_changes=(await context.db.query('SELECT id,operation_id,path,before_hash,after_hash,kind,details,created_at FROM file_changes WHERE job_id=$1 ORDER BY created_at,id',[job.id])).rows;
    return {...job,events,operations,steps:(await context.db.query('SELECT id,sequence,kind,state,request,result,created_at FROM job_steps WHERE job_id=$1 ORDER BY sequence',[job.id])).rows,artifacts:(await context.db.query('SELECT id,relative_path,sha256,size_bytes,mime_type,created_at FROM artifacts WHERE job_id=$1',[job.id])).rows,checkpoints:(await context.db.query("SELECT id,reason,manifest_hash,consistency,created_at FROM checkpoints WHERE reason LIKE $1",[`job:${job.id}:%`])).rows,verification_status:job.result?.verification_status??job.result?.verification?.status??"not_run"};
  });
  app.post("/jobs/:id/cancel",async(request,reply)=>{
    const job=await cancelJob(context.db,id.parse((request.params as {id:string}).id),request.actor!.id);
    if(!job)return reply.code(404).send({error:{code:"not_found",message:"Job not found"}});
    await context.audit(request.actor!.id,"job.cancel",job.id,"requested");
    return {id:job.id,state:job.state,reason:job.reason};
  });
  app.get("/jobs/:id/events",async(request,reply)=>{
    const jobId=id.parse((request.params as {id:string}).id),owner=request.actor!.id;
    let cursor=parseCursor(request.headers["last-event-id"]??(request.query as {after?:string}).after);
    if(!(await context.db.query("SELECT id FROM jobs WHERE id=$1 AND requester_id=$2",[jobId,owner])).rowCount)return reply.code(404).send({error:{code:"not_found",message:"Job not found"}});
    reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
    let closed=false;reply.raw.on("close",()=>{closed=true;});
    const write=async(chunk:string)=>{if(closed)return;if(!reply.raw.write(chunk))await new Promise<void>(resolve=>{const done=()=>{reply.raw.off("drain",done);reply.raw.off("close",done);resolve();};reply.raw.once("drain",done);reply.raw.once("close",done);});};
    try{
      const range=(await context.db.query("SELECT MIN(id)::text AS first FROM job_events WHERE job_id=$1",[jobId])).rows[0];
      if(cursor!=="0"&&range.first&&BigInt(cursor)<BigInt(range.first)){
        const snapshot=(await context.db.query(`SELECT ${publicJob} FROM jobs WHERE id=$1`,[jobId])).rows[0];
        await write(`event: history.gap\ndata: ${JSON.stringify({reason:"cursor_expired",snapshot,first_event_id:range.first})}\n\n`);
      }
      while(!closed){
        const session=await context.db.query("SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()",[request.sessionId,owner]);if(!session.rowCount)break;
        const events=(await context.db.query("SELECT id::text,job_id,sequence::text,type,payload,created_at FROM job_events WHERE job_id=$1 AND id>$2::bigint ORDER BY id LIMIT 100",[jobId,cursor])).rows;
        for(const event of events){await write(encodeSse(event.id,event.type,{schema_version:1,id:event.id,job_id:event.job_id,sequence:event.sequence,type:event.type,timestamp:event.created_at,payload:event.payload}));cursor=event.id;if(closed)break;}
        if(!events.length)await write(": heartbeat\n\n");
        if(events.length<100)await new Promise<void>(resolve=>{const timer=setTimeout(done,1000);function done(){clearTimeout(timer);reply.raw.off("close",done);resolve();}reply.raw.once("close",done);});
      }
    }catch{if(!closed)reply.raw.write("event: stream.error\ndata: {\"reason\":\"stream_unavailable\"}\n\n");}finally{reply.raw.end();}
  });
  app.get("/conversations",async request=>{const query=z.object({archived:z.enum(['true','false']).default('false'),deleted:z.enum(['true','false']).default('false')}).parse(request.query);return {items:(await context.db.query(`SELECT id,title,context,archived_at,deleted_at,created_at,updated_at FROM conversations WHERE owner_id=$1 AND ${query.deleted==='true'?'deleted_at IS NOT NULL':'deleted_at IS NULL'} ${query.deleted==='true'?'':query.archived==='true'?'AND archived_at IS NOT NULL':'AND archived_at IS NULL'} ORDER BY updated_at DESC LIMIT 100`,[request.actor!.id])).rows};});
  app.post("/conversations",async(request,reply)=>{const body=z.object({title:z.string().min(1).max(200),context:RunContextSchema.optional()}).parse(request.body);const {randomUUID}=await import("node:crypto");const result=await context.db.query("INSERT INTO conversations(id,owner_id,title,context) VALUES($1,$2,$3,$4::jsonb) RETURNING *",[randomUUID(),request.actor!.id,body.title,JSON.stringify(body.context??{})]);return reply.code(201).send(result.rows[0]);});
  app.get("/conversations/:id",async(request,reply)=>{
    const conversation=(await context.db.query("SELECT * FROM conversations WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",[id.parse((request.params as {id:string}).id),request.actor!.id])).rows[0];if(!conversation)return reply.code(404).send({error:{code:"not_found",message:"Conversation not found"}});
    const query=z.object({limit:z.coerce.number().int().min(1).max(1000).default(100),before:z.string().max(500).optional()}).parse(request.query);let cursor:[string,string]|undefined;
    if(query.before){try{cursor=z.tuple([z.iso.datetime(),id]).parse(JSON.parse(Buffer.from(query.before,'base64url').toString()));}catch{bad('invalid_cursor','Invalid message cursor');}}
    const rows=(await context.db.query("SELECT m.*,j.context AS job_context,j.payload->'execution_context' AS job_execution_context FROM messages m LEFT JOIN jobs j ON j.id=m.job_id WHERE m.conversation_id=$1 AND ($3::timestamptz IS NULL OR (m.created_at,m.id)<($3::timestamptz,$4::uuid)) ORDER BY m.created_at DESC,m.id DESC LIMIT $2",[conversation.id,query.limit+1,cursor?.[0]??null,cursor?.[1]??null])).rows,more=rows.length>query.limit,messages=rows.slice(0,query.limit),last=messages.at(-1);
    return {...conversation,messages:messages.reverse(),next_cursor:more&&last?Buffer.from(JSON.stringify([last.created_at.toISOString(),last.id])).toString('base64url'):null};
  });
}






