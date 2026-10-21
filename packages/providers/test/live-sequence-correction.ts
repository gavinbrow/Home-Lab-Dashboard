/** Exactly one retained-transcript correction, bounded by the original probe's deadline. */
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{createProviderAdapter,type ChatRequest,type ChatEvent}from'../src/index.js';
const[source,output]=process.argv.slice(2);if(!source||!output)throw new Error('Retained synthetic probe and output required');
const bytes=await readFile(source,'utf8');const prior=JSON.parse(bytes);const deadline=Date.parse(prior.started_at)+180000;
const remaining=Math.min(45000,deadline-Date.now());if(remaining<1000)throw new Error('Original global probe deadline expired; no request sent');
if(prior.endpoint!=='http://127.0.0.1:11438'||prior.model!=='qwen2.5:1.5b'||prior.rounds.length!==1)throw new Error('Unexpected retained fixture identity');
const first=prior.rounds[0].events.find((event:any)=>event.type==='completed');if(!first)throw new Error('No completed first response');
const request:ChatRequest=structuredClone(prior.rounds[0].request);
const calls=[...first.toolCalls,...(first.rejectedToolCalls??[])].sort((a,b)=>(a.index??0)-(b.index??0));
request.messages.push({role:'assistant',content:'',toolCalls:calls});
for(const call of calls)request.messages.push({role:'tool',toolName:call.name,toolCallId:call.id,content:JSON.stringify({state:'completed',content:{error:'invalid_tool_arguments',executed:false,synthetic:true,reason:'Nothing executed. run_command.args must exclude executable. All file tool paths must be workspace-relative. Repair all five proposals.',expected_schema:request.tools?.find(tool=>tool.function.name===call.name)?.function.parameters??null}})});
request.messages.push({role:'user',content:'Correct your unexecuted proposals now. executable is /usr/local/bin/node; args is exactly ["/workspace/project/sentinel.mjs","/workspace/project","trusted-operation","180"], without the executable. File tool paths are exactly sentinel-report.txt and sentinel-binary.bin, without /workspace/project/. Use verify_file for both, then publish_artifact for both with mime_type text/plain and application/octet-stream. Omit unknown sha256. Return the corrected structured calls; do not ask me to fix them.'});
const snapshot={...prior.snapshot,timeoutMs:remaining};const adapter=createProviderAdapter(snapshot,{resolveCredential:async()=>{throw new Error('No credentials allowed');}});
const evidence:any={scope:'One actual-model corrective response to retained synthetic proposals; NO host tools or files executed',source,source_sha256:createHash('sha256').update(bytes).digest('hex'),started_at:new Date().toISOString(),original_global_deadline:new Date(deadline).toISOString(),request_timeout_ms:remaining,request,events:[],outcome:'FAIL',host_tool_executions:0,harness_error:'Initial harness counted multiple invalid proposals in one response as multiple repair rounds; first transcript retained unchanged.'};
try{
 let completed:Extract<ChatEvent,{type:'completed'}>|undefined;for await(const event of adapter.streamChat(request)){evidence.events.push(event);if(event.type==='completed')completed=event;}
 const accepted=completed?.toolCalls??[];const expectedArgs=['/workspace/project/sentinel.mjs','/workspace/project','trusted-operation','180'];
 const command=accepted[0];const verify=accepted.slice(1,3);const publish=accepted.slice(3,5);const paths=['sentinel-report.txt','sentinel-binary.bin'];
 const goodCommand=command?.name==='run_command'&&command.arguments.executable==='/usr/local/bin/node'&&JSON.stringify(command.arguments.args)===JSON.stringify(expectedArgs);
 const goodVerify=verify.length===2&&verify.every(call=>call.name==='verify_file'&&call.arguments.sha256===undefined)&&JSON.stringify(verify.map(call=>call.arguments.path).sort())===JSON.stringify([...paths].sort());
 const goodPublish=publish.length===2&&publish.every(call=>call.name==='publish_artifact'&&call.arguments.mime_type===(call.arguments.path==='sentinel-report.txt'?'text/plain':'application/octet-stream'))&&JSON.stringify(publish.map(call=>call.arguments.path).sort())===JSON.stringify([...paths].sort());
 evidence.verdict={valid_command:goodCommand,valid_verify_pair:goodVerify,valid_publish_pair:goodPublish,proposal_count:accepted.length,rejected_count:completed?.rejectedToolCalls?.length??0};
 evidence.outcome=accepted.length===5&&goodCommand&&goodVerify&&goodPublish&&!completed?.rejectedToolCalls?.length?'PASS':'FAIL';
}catch(error){evidence.error=error instanceof Error?error.message:'unknown';}
evidence.completed_at=new Date().toISOString();await writeFile(output,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify({output,outcome:evidence.outcome,error:evidence.error??null,verdict:evidence.verdict??null,host_tool_executions:0})+'\n');if(evidence.outcome!=='PASS')process.exitCode=1;
