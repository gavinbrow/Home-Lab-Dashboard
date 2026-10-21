/** Explicit opt-in synthetic tool-result harness. Actual inference; no host tools/files execute. */
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{createProviderAdapter,type ChatRequest,type ToolCall,type ChatEvent}from'../src/index.js';
import{offeredTools}from'../../../apps/worker/src/agent.js';
const[endpoint,source,output]=process.argv.slice(2);
if(!endpoint||!source||!output||new URL(endpoint).hostname!=='127.0.0.1')throw new Error('Explicit isolated IPv4 loopback endpoint, retained schema export and evidence output required');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const sourceBytes=await readFile(source,'utf8');const retainedTools=JSON.parse(sourceBytes).requests[0].request.tools;
// Preserve current production property ordering on the wire; PostgreSQL JSONB sorts object keys.
const tools=offeredTools({tools:['run_command','file.read','artifact.retain']}as any);
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
if(JSON.stringify(canonical(tools))!==JSON.stringify(canonical(retainedTools)))throw new Error('Production tool schemas changed from the approved retained six-tool set; review before inference');
export const prompt='Run this program once using run_command: {"executable":"/usr/local/bin/node","args":["/workspace/project/sentinel.mjs","/workspace/project","trusted-operation","180"]}. The executable and args are separate fields. After success, verify_file for sentinel-report.txt and sentinel-binary.bin. Then publish_artifact for both files using mime_type text/plain and application/octet-stream respectively. Omit unknown sha256. Do not repeat an accepted command. Complete all five tool calls autonomously.';
const system='Use the supplied structured tools. Follow their exact JSON schemas. Tool rejection with executed:false means nothing ran: repair your own arguments. After command success, verify both files and retain both artifacts. Do not ask the user to perform a step.';
const request:ChatRequest={model:'qwen2.5:1.5b',messages:[{role:'system',content:system},{role:'user',content:prompt}],tools,thinking:false,contextLength:4096,maxOutputTokens:512,temperature:0};
const snapshot={id:'isolated-synthetic-sequence',revision:1,adapter:'ollama' as const,baseUrl:endpoint,runtimePoolId:'isolated-test',routing:'local' as const,allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:45000,contextLength:4096};
const adapter=createProviderAdapter(snapshot,{resolveCredential:async()=>{throw new Error('No credentials allowed');}});
const evidence:any={scope:'Actual existing-model inference with explicitly synthetic tool results; NO host commands, workspace files or artifacts executed/created',started_at:new Date().toISOString(),source,source_sha256:hash(sourceBytes),endpoint,snapshot,model:request.model,prompt,system,schemas:tools,schemas_sha256:hash(JSON.stringify(tools)),initial_request_sha256:hash(JSON.stringify(request)),settings:{thinking:false,temperature:0,max_output_tokens:512,context_length:4096,request_timeout_ms:45000,global_timeout_ms:180000,max_rounds:7,max_repairs:1},rounds:[],outcome:'FAIL',host_tool_executions:0};
const overall=new AbortController();const timer=setTimeout(()=>overall.abort(),180000);
const expectedArgs=['/workspace/project/sentinel.mjs','/workspace/project','trusted-operation','180'];
const paths=['sentinel-report.txt','sentinel-binary.bin'];const verified=new Set<string>();const retained=new Set<string>();let command=false;let repairs=0;
function fixture(call:ToolCall):unknown{
 if(call.name==='run_command'){
  if(command)throw new Error('Command was already accepted; no replay allowed');
  if(call.arguments.executable!=='/usr/local/bin/node'||JSON.stringify(call.arguments.args)!==JSON.stringify(expectedArgs))throw new Error('Use exact separate executable and args from user request');
  command=true;return{status:'succeeded',exit_code:0,output:'Synthetic fixture only: command completed; sentinel-report.txt and sentinel-binary.bin are available.'};
 }
 const path=call.arguments.path;if(typeof path!=='string'||!paths.includes(path))throw new Error('Use an exact requested output path');
 if(!command)throw new Error('Command has not succeeded');
 if(call.name==='verify_file'){
  if(verified.has(path))throw new Error('This file was already verified');
  if(call.arguments.sha256!==undefined&&call.arguments.sha256!==hash('synthetic-fixture:'+path))throw new Error('Expected SHA-256 did not match the synthetic fixture; omit unknown sha256');verified.add(path);
  return{path,sha256:hash('synthetic-fixture:'+path),size:path.endsWith('.bin')?256:70,verification:'passed',synthetic:true};
 }
 if(call.name==='publish_artifact'){
  if(verified.size!==2)throw new Error('Verify both files before retaining either artifact');
  if(retained.has(path))throw new Error('Artifact was already retained');
  const expected=path.endsWith('.bin')?'application/octet-stream':'text/plain';if(call.arguments.mime_type!==expected)throw new Error('Use the exact requested mime_type');retained.add(path);
  return{artifact_id:'synthetic-'+path,retained:true,synthetic:true};
 }
 throw new Error('Only run_command, verify_file and publish_artifact are needed for this task');
}
try{
 evidence.server_version=await adapter.getServerVersion?.(overall.signal);evidence.model_identity=(await adapter.discoverModels(overall.signal)).find(model=>model.id===request.model);
 if(!evidence.model_identity)throw new Error('Explicit existing model is not installed');
 for(let index=0;index<7;index++){
  const round:any={index,started_at:new Date().toISOString(),request:structuredClone(request),request_sha256:hash(JSON.stringify(request)),events:[]};evidence.rounds.push(round);
  let completed:Extract<ChatEvent,{type:'completed'}>|undefined;let text='';
  for await(const event of adapter.streamChat(request,{signal:overall.signal})){round.events.push(event);if(event.type==='text')text+=event.text;else completed=event;}
  round.completed_at=new Date().toISOString();if(!completed)throw new Error('No completed response');
  const calls=[...completed.toolCalls,...(completed.rejectedToolCalls??[])].sort((a,b)=>(a.index??0)-(b.index??0));
  if(!calls.length)throw new Error(completed.finishReason==='length'?'output_budget_exhausted':'premature_finish_before_required_tools');
  request.messages.push({role:'assistant',content:text,toolCalls:calls});round.synthetic_results=[];let invalidRound=false;
  for(const call of calls){
   let result:unknown;
   try{if('error'in call)throw new Error(String(call.error));result={state:'completed',content:fixture(call)};}
   catch(error){invalidRound=true;result={state:'completed',content:{error:'invalid_tool_arguments',reason:error instanceof Error?error.message:'invalid',executed:false,synthetic:true,expected_schema:tools.find((tool:any)=>tool.function.name===call.name)?.function.parameters??null}};}
   round.synthetic_results.push({call,result});request.messages.push({role:'tool',toolName:call.name,toolCallId:call.id,content:JSON.stringify(result)});
  }
  if(invalidRound&&++repairs>1)throw new Error('Single allowed corrective response exhausted');
  if(command&&verified.size===2&&retained.size===2){evidence.outcome='PASS';break;}
 }
 if(evidence.outcome!=='PASS')throw new Error('Bounded round limit reached');
}catch(error){evidence.error=error instanceof Error?error.message:'unknown';}finally{clearTimeout(timer);}
evidence.summary={command_proposal_accepted:command,verified_paths:[...verified],retained_paths:[...retained],repairs,synthetic_results_only:true};evidence.completed_at=new Date().toISOString();
await writeFile(output,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify({output,outcome:evidence.outcome,error:evidence.error??null,rounds:evidence.rounds.length,host_tool_executions:0})+'\n');if(evidence.outcome!=='PASS')process.exitCode=1;
