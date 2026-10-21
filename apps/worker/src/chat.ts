import { randomUUID } from "node:crypto";
import { createProviderAdapter,refreshModelIdentity,probeValidity, type ProviderSnapshot, type ChatMessage, type ChatEvent, type ProviderAdapter } from "@homelab/providers";
import type { JobHandler } from "./runtime.js";
import { transaction,assertOwnedLease } from "./database.js";
import { appendEventInTransaction } from "./queue.js";
import { reserveProvider,releaseProvider,markProviderUncertain } from "./reservations.js";
import {userMessage,type AttachmentLoader,type FrozenAttachment} from './attachments.js';
import {assertProviderScope,resolveProfile} from './authority.js';
import {prepareInferenceBudget,TokenBudgetError} from './budgets.js';
import {accountOutput,remainingOutput} from './output.js';
export function createChatHandler(resolveCredential:(owner:string,id:string)=>Promise<string>,makeAdapter:(snapshot:ProviderSnapshot,deps:{resolveCredential:(ref:string)=>Promise<string>})=>ProviderAdapter=createProviderAdapter,loadAttachments?:AttachmentLoader):JobHandler{
 return async(job,runtime)=>{
  if(!job.context)throw new Error("Chat context is missing");
  const existing=(await runtime.db.query("SELECT * FROM inference_requests WHERE job_id=$1 ORDER BY created_at LIMIT 1",[job.id])).rows[0];
  if(existing){
   if(existing.state==="completed"){await releaseProvider(runtime.db,job.id,job);if(await runtime.cancelled())await runtime.cancel("inference_finished_after_cancel_request");else await runtime.complete(existing.response);return;}
   await markProviderUncertain(runtime.db,job.id,job);
   await runtime.db.query("UPDATE inference_requests SET state='interrupted' WHERE id=$1",[existing.id]);
   await runtime.db.query("UPDATE messages SET state='interrupted' WHERE job_id=$1 AND role='assistant'",[job.id]);
   await runtime.interrupt("provider_outcome_unknown_no_automatic_replay");return;
  }
  if(job.recovery_only){await runtime.wait('capacity_recovery_only',2);return;}
  if(await runtime.cancelled()){await runtime.cancel("cancelled_before_inference");return;}
  const snapshot=job.payload.provider_snapshot as ProviderSnapshot;
  if(!snapshot||snapshot.id!==job.context.provider_id||snapshot.revision!==job.context.provider_config_revision||snapshot.baseUrl!==job.context.provider_endpoint)throw new Error("Frozen provider snapshot mismatch");
  const effectiveProfile=await resolveProfile(runtime.db,job.requester_id,job.context,undefined,job.payload.profile_snapshot as any);
  await assertProviderScope(runtime.db,job.requester_id,job.context,effectiveProfile,snapshot);
  if(!await reserveProvider(runtime.db,snapshot.runtimePoolId,job.id,job.context.model_id,snapshot.maxModelConcurrency??1,false,job)){await runtime.wait("provider_capacity",5);return;}
  let conversationId=job.payload.conversation_id as string|undefined;
  const messages:ChatMessage[]=[];
  const profile=job.payload.profile_snapshot as {instructions?:string}|null|undefined;
  if(profile?.instructions)messages.push({role:"system",content:profile.instructions});
  if(conversationId){
   const history=(await runtime.db.query("SELECT role,content FROM messages WHERE conversation_id=$1 AND state='completed' ORDER BY created_at,id LIMIT 201",[conversationId])).rows;
   if(history.length>200){await releaseProvider(runtime.db,job.id,job);await runtime.fail('model_context_limit_requires_explicit_summary');return;}
   for(const m of history){if(m.role==='user')messages.push(await userMessage(typeof m.content==='string'?m.content:String(m.content.text??''),m.content.attachment_snapshots??[],loadAttachments));else if(["assistant","system"].includes(m.role))messages.push({role:m.role,content:typeof m.content==="string"?m.content:String(m.content.text??"")});}
  }
  const prompt=String(job.payload.prompt??"");
  const attachmentSnapshots=(job.payload.attachment_snapshots??[]) as FrozenAttachment[];
  if(Array.isArray(job.payload.replay_messages)){messages.length=0;messages.push(...job.payload.replay_messages as ChatMessage[]);}else messages.push(await userMessage(prompt,attachmentSnapshots,loadAttachments));
  if(Buffer.byteLength(JSON.stringify(messages))>1024*1024){await releaseProvider(runtime.db,job.id,job);await runtime.fail('model_context_limit_requires_explicit_summary');return;}
  const adapter=makeAdapter(snapshot,{resolveCredential:ref=>resolveCredential(job.requester_id,ref)});
  await refreshModelIdentity(runtime.db,snapshot,job.context.model_id,job.requester_id,adapter,runtime.signal);
  for(const capability of new Set([...(effectiveProfile?.required_capabilities??[]),...(messages.some(m=>m.images?.length)?['image_input']:[])])){if(!(await probeValidity(runtime.db,snapshot.id,job.context.model_id,snapshot.revision,capability)).valid){await releaseProvider(runtime.db,job.id,job);await runtime.fail(`model_capability_unverified:${capability}`);return;}}
  const outputRemaining=await transaction(runtime.db,client=>remainingOutput(client,job));if(!outputRemaining){await releaseProvider(runtime.db,job.id,job);await runtime.fail('job_output_budget_exhausted');return;}
  let budgeted;
  try{budgeted=await prepareInferenceBudget(adapter,{model:job.context.model_id,messages,...(snapshot.contextLength?{contextLength:snapshot.contextLength}:{}),maxOutputTokens:Math.min(4096,outputRemaining)},job.context.limits.max_total_tokens);}catch(error){await releaseProvider(runtime.db,job.id,job);await runtime.fail(error instanceof TokenBudgetError?error.code:'token_budget_preflight_failed',{token_budget:{mode:'unsupported_or_exhausted',generation_started:false}});return;}
  if(await runtime.cancelled()){await releaseProvider(runtime.db,job.id,job);await runtime.cancel('cancelled_before_inference');return;}
  await runtime.appendEvent('inference.budget',budgeted.budget);
  const inferenceId=randomUUID(),assistantId=randomUUID();
  await runtime.assertLease();
  try{await transaction(runtime.db,async client=>{
   await assertOwnedLease(client,job);
   const admitted=await resolveProfile(client,job.requester_id,job.context!,undefined,job.payload.profile_snapshot as any);await assertProviderScope(client,job.requester_id,job.context!,admitted,snapshot);
   for(const capability of new Set([...(admitted?.required_capabilities??[]),...(messages.some(m=>m.images?.length)?['image_input']:[])]))if(!(await probeValidity(client,snapshot.id,job.context!.model_id,snapshot.revision,capability)).valid)throw new Error(`model_capability_unverified:${capability}`);
   if(!conversationId){conversationId=randomUUID();await client.query("INSERT INTO conversations(id,owner_id,title,context) VALUES($1,$2,$3,$4::jsonb)",[conversationId,job.requester_id,prompt.slice(0,120)||"Conversation",JSON.stringify(job.context)]);}
   if(!job.payload.replay_messages)await client.query("INSERT INTO messages(id,conversation_id,job_id,role,content,state,model_id) VALUES($1,$2,$3,'user',$4::jsonb,'completed',$5)",[randomUUID(),conversationId,job.id,JSON.stringify({text:prompt,attachment_snapshots:attachmentSnapshots}),job.context!.model_id]);
   await client.query("INSERT INTO messages(id,conversation_id,job_id,role,content,state,model_id) VALUES($1,$2,$3,'assistant',$4::jsonb,'streaming',$5)",[assistantId,conversationId,job.id,JSON.stringify({text:''}),job.context!.model_id]);
   await client.query("INSERT INTO inference_requests(id,job_id,provider_id,model_id,state,request) VALUES($1,$2,$3,$4,'streaming',$5::jsonb)",[inferenceId,job.id,job.context!.provider_id,job.context!.model_id,JSON.stringify({...budgeted.request,provider_snapshot:snapshot,token_budget:budgeted.budget})]);
   await appendEventInTransaction(client,job.id,"assistant.started",{message_id:assistantId,conversation_id:conversationId,model_id:job.context!.model_id});
  });}catch(error){await runtime.assertLease();await releaseProvider(runtime.db,job.id,job);await runtime.fail(error instanceof Error?error.message:'inference_admission_failed');return;}
  const abort=new AbortController();const onLost=()=>abort.abort();runtime.signal.addEventListener("abort",onLost,{once:true});
  const remaining=Math.max(1,job.context.limits.wall_time_seconds*1000-(Date.now()-(job.started_at?.getTime()??Date.now())));
  const timeout=setTimeout(()=>abort.abort(),remaining);
  const cancellation=setInterval(()=>{void runtime.cancelled().then(cancel=>{if(cancel)abort.abort();}).catch(()=>abort.abort());},1000);
  let delta=0;let text="",completed:Extract<ChatEvent,{type:"completed"}>|null=null;
  try{
   for await(const event of adapter.streamChat(budgeted.request,{signal:abort.signal})){
    await runtime.assertLease();
    if(event.type==="text"){
     const limited=await transaction(runtime.db,async client=>{
   await assertOwnedLease(client,job);const output=await accountOutput(client,job,`inference:${inferenceId}:delta:${delta++}`,'model_text',event.text,'truncate');if(!output.duplicate)text+=output.text;
   if(Buffer.byteLength(text)>4*1024*1024)throw new Error("inference_context_output_limit");
      const update=await client.query("UPDATE messages SET content=$2::jsonb WHERE id=$1 AND EXISTS(SELECT 1 FROM jobs WHERE id=$3 AND lease_owner=$4 AND fence=$5 AND lease_until>now())",[assistantId,JSON.stringify({text}),job.id,job.lease_owner,job.fence]);
      if(!update.rowCount)throw new Error("Inference lease lost");
      await appendEventInTransaction(client,job.id,"assistant.delta",{message_id:assistantId,text:output.text});return output.limited;
     });if(limited)throw new Error("job_output_budget_exhausted");
    }else completed=event;
   }
   if(!completed)throw new Error("provider_stream_missing_completion");
   await runtime.assertLease();
   const calls=[...completed.toolCalls,...(completed.rejectedToolCalls??[])];if(calls.length){const output=await transaction(runtime.db,client=>accountOutput(client,job,`inference:${inferenceId}:calls`,'tool_proposals',JSON.stringify(calls),'reject'));if(output.limited)throw new Error("job_output_budget_exhausted");}
   const result={conversation_id:conversationId,message_id:assistantId,text,provenance:completed,verification_status:"not_run"};
   await transaction(runtime.db,async client=>{
   await assertOwnedLease(client,job);
    await client.query("UPDATE messages SET state='completed',content=$2::jsonb WHERE id=$1",[assistantId,JSON.stringify({text,provenance:completed})]);
    await client.query("UPDATE inference_requests SET state='completed',response=$2::jsonb,metrics=$3::jsonb,completed_at=now() WHERE id=$1",[inferenceId,JSON.stringify(result),JSON.stringify(completed)]);
    await client.query("UPDATE conversations SET updated_at=now() WHERE id=$1",[conversationId]);
    await appendEventInTransaction(client,job.id,"assistant.completed",result);
   });
   await releaseProvider(runtime.db,job.id,job);
   if(await runtime.cancelled())await runtime.cancel("inference_finished_after_cancel_request");else await runtime.complete(result);
  }catch(error){
   const known=!!completed||!!(error as {responseComplete?:boolean}).responseComplete;
   if(known)await releaseProvider(runtime.db,job.id,job);else await markProviderUncertain(runtime.db,job.id,job);
   await runtime.db.query("UPDATE inference_requests SET state=$3,response=$2::jsonb WHERE id=$1",[inferenceId,JSON.stringify({partial_text:text,provider_stop_confirmed:known}),known?'failed':'interrupted']);
   await runtime.db.query("UPDATE messages SET state='interrupted' WHERE id=$1",[assistantId]);
   if(known)await runtime.fail(error instanceof Error&&error.message==='job_output_budget_exhausted'?'job_output_budget_exhausted':'inference_response_rejected',{partial_text:text,provider_stop_confirmed:true});else await runtime.interrupt(error instanceof Error&&error.message==='job_output_budget_exhausted'?"job_output_budget_exhausted_provider_stop_unconfirmed":"inference_interrupted_provider_stop_unconfirmed");
  }finally{clearTimeout(timeout);clearInterval(cancellation);runtime.signal.removeEventListener("abort",onLost);abort.abort();}
 };
}





