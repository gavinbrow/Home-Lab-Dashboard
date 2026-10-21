/** Fresh, booked continuation of a retained response. No original-request replay or host tools. */
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{createProviderAdapter,type ChatRequest,type ChatEvent,type ToolCall}from'../src/index.js';
const[source,output]=process.argv.slice(2);if(!source||!output)throw new Error('Retained first synthetic response and separate output required');
const bytes=await readFile(source,'utf8');const prior=JSON.parse(bytes);
if(prior.endpoint!=='http://127.0.0.1:11438'||prior.model!=='qwen2.5:1.5b'||prior.rounds.length!==1)throw new Error('Unexpected explicit existing fixture identity');
const first=prior.rounds[0].events.find((event:any)=>event.type==='completed');if(!first)throw new Error('No completed first response');
const request:ChatRequest=structuredClone(prior.rounds[0].request);
const firstCalls=[...first.toolCalls,...(first.rejectedToolCalls??[])].sort((a,b)=>(a.index??0)-(b.index??0));
request.messages.push({role:'assistant',content:'',toolCalls:firstCalls});
for(const call of firstCalls)request.messages.push({role:'tool',toolName:call.name,toolCallId:call.id,content:JSON.stringify({state:'completed',content:{error:'invalid_tool_arguments',executed:false,synthetic:true,reason:'Nothing executed. run_command.args must exclude executable. File tool paths must be workspace-relative. Repair the proposals.',expected_schema:request.tools?.find(tool=>tool.function.name===call.name)?.function.parameters??null}})});
request.messages.push({role:'user',content:'Correct the unexecuted proposals. executable is /usr/local/bin/node; args is exactly ["/workspace/project/sentinel.mjs","/workspace/project","trusted-operation","180"], without the executable. File tool paths are exactly sentinel-report.txt and sentinel-binary.bin, without /workspace/project/. Verify both, then publish both using mime_type text/plain and application/octet-stream. Omit unknown sha256. Use structured calls and repair your own arguments.'});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const started=Date.now();const deadline=started+180000;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),180000);
const evidence:any={scope:'Fresh booked actual-model continuation against retained FIRST response, synthetic tool results only; NO host execution/files/real artifacts',source,source_sha256:hash(bytes),started_at:new Date(started).toISOString(),global_deadline:new Date(deadline).toISOString(),model:prior.model,model_identity:prior.model_identity,server_version:prior.server_version,endpoint:prior.endpoint,snapshot:prior.snapshot,schemas_sha256:prior.schemas_sha256,settings:{...prior.settings,global_timeout_ms:180000,request_timeout_ms:150000,max_response_rounds:2,correction_responses:1,final_synthetic_completion_responses:1},rounds:[],host_tool_executions:0,outcome:'FAIL'};
const paths=['sentinel-report.txt','sentinel-binary.bin'];const verified=new Set<string>();const retained=new Set<string>();let command=false;
function synthetic(call:ToolCall):unknown{
 if(call.name==='run_command'){
  if(command)throw new Error('Repeated accepted command');
  if(call.arguments.executable!=='/usr/local/bin/node'||JSON.stringify(call.arguments.args)!==JSON.stringify(['/workspace/project/sentinel.mjs','/workspace/project','trusted-operation','180']))throw new Error('Executable duplicated or incorrect separate command arguments');
  command=true;return{state:'completed',content:{synthetic:true,status:'succeeded',exit_code:0,output:'Synthetic fixture: command complete; sentinel-report.txt and sentinel-binary.bin available.'}};
 }
 const path=call.arguments.path;if(typeof path!=='string'||!paths.includes(path))throw new Error('File path must be the exact requested workspace-relative path');
 if(!command)throw new Error('Command must succeed before file tools');
 if(call.name==='verify_file'){
  if(verified.has(path)||call.arguments.sha256!==undefined&&call.arguments.sha256!==hash('synthetic-fixture:'+path))throw new Error('Repeated verification or incorrect expected fixture hash');verified.add(path);
  return{state:'completed',content:{synthetic:true,path,sha256:hash('synthetic-fixture:'+path),size:path.endsWith('.bin')?256:70,verification:'passed'}};
 }
 if(call.name==='publish_artifact'){
  if(verified.size!==2||retained.has(path)||call.arguments.mime_type!==(path.endsWith('.bin')?'application/octet-stream':'text/plain'))throw new Error('Both verifications and exact MIME type required before unique retention');retained.add(path);
  return{state:'completed',content:{synthetic:true,artifact_id:'synthetic-'+path,retained:true}};
 }
 throw new Error('Unexpected tool for the requested sequence');
}
try{
 for(let phase=0;phase<2;phase++){
  const remaining=deadline-Date.now();if(remaining<1000)throw new Error('global_budget_exhausted');
  const snapshot={...prior.snapshot,timeoutMs:Math.min(150000,remaining)};const adapter=createProviderAdapter(snapshot,{resolveCredential:async()=>{throw new Error('No credentials permitted');}});
  const round:any={phase:phase===0?'single_corrective_response':'final_synthetic_result_completion',started_at:new Date().toISOString(),request:structuredClone(request),request_sha256:hash(JSON.stringify(request)),timeout_ms:snapshot.timeoutMs,events:[]};evidence.rounds.push(round);
  let completed:Extract<ChatEvent,{type:'completed'}>|undefined;let text='';for await(const event of adapter.streamChat(request,{signal:controller.signal})){round.events.push(event);if(event.type==='completed')completed=event;else text+=event.text;}
  round.completed_at=new Date().toISOString();if(!completed)throw new Error('No completed provider response');
  if(completed.rejectedToolCalls?.length)throw new Error('Corrective response still contains schema-invalid proposals');
  const calls=completed.toolCalls;if(!calls.length&&!(command&&verified.size===2&&retained.size===2))throw new Error(completed.finishReason==='length'?'output_budget_exhausted':'premature_finish_before_required_sequence');
  request.messages.push({role:'assistant',content:text,toolCalls:calls});round.synthetic_results=[];
  for(const call of calls){const result=synthetic(call);round.synthetic_results.push({call,result});request.messages.push({role:'tool',toolName:call.name,toolCallId:call.id,content:JSON.stringify(result)});}
  if(phase===1&&command&&verified.size===2&&retained.size===2)evidence.outcome='PASS';
 }
 if(evidence.outcome!=='PASS')throw new Error('Corrective and final response did not complete the requested synthetic sequence');
}catch(error){evidence.error=error instanceof Error?error.message:'unknown';if(controller.signal.aborted||/interrupted|budget_exhausted/.test(evidence.error))evidence.outcome='INCOMPLETE';}finally{clearTimeout(timer);}
evidence.summary={command_proposal_accepted:command,verified_paths:[...verified],retained_paths:[...retained],synthetic_only:true};evidence.completed_at=new Date().toISOString();
await writeFile(output,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify({output,outcome:evidence.outcome,error:evidence.error??null,summary:evidence.summary,host_tool_executions:0})+'\n');if(evidence.outcome!=='PASS')process.exitCode=1;
