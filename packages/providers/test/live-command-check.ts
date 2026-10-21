/** Explicit isolated native inference only: tool proposals are validated but never executed. */
import{readFile,writeFile}from'node:fs/promises';
import{createProviderAdapter,type ChatRequest,type ChatEvent}from'../src/index.js';
const[endpoint,model,source,output,mode='baseline']=process.argv.slice(2);
if(!endpoint||!model||!source||!output||new URL(endpoint).hostname!=='127.0.0.1')throw new Error('Explicit isolated IPv4 loopback endpoint, exact model, sanitized request export and output required');
if(!['baseline','soft-no-think'].includes(mode))throw new Error('Unknown explicit diagnostic mode');
const original=JSON.parse(await readFile(source,'utf8')).requests[0].request;
const soft=mode==='soft-no-think';const messages=original.messages.map((message:any,index:number)=>({...message,content:message.content+(soft&&index===original.messages.length-1?'\n/no_think':'')}));
const request:ChatRequest={model,messages,tools:original.tools,thinking:soft?true:false,contextLength:4096,maxOutputTokens:soft?1024:256,temperature:0};
const adapter=createProviderAdapter({id:'isolated-command-schema-check',revision:1,adapter:'ollama',baseUrl:endpoint,runtimePoolId:'isolated-test',routing:'local',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:soft?360000:180000,contextLength:4096},{resolveCredential:async()=>{throw new Error('No credentials permitted');}});
const evidence:any={scope:'actual isolated inference, prior offered schemas/prompt with explicit documented controls, no tools executed',started_at:new Date().toISOString(),endpoint,model,source,mode,soft_control:soft?{instruction:'/no_think',strength:'soft',source:'https://qwenlm.github.io/blog/qwen3/#advanced-usages',native_think:true}:null,request,events:[]};
const overall=new AbortController();const deadline=setTimeout(()=>overall.abort(),soft?420000:240000);
let completed:Extract<ChatEvent,{type:'completed'}>|undefined;
try{
 evidence.server_version=await adapter.getServerVersion?.(overall.signal);evidence.model_identity=(await adapter.discoverModels(overall.signal)).find(item=>item.id===model);
 for await(const event of adapter.streamChat(request,{signal:overall.signal})){evidence.events.push(event);if(event.type==='completed')completed=event;}
 const call=completed?.toolCalls[0];const expected=['/workspace/project/sentinel.mjs','/workspace/project','trusted-operation','180'];
 evidence.outcome=completed?.toolCalls.length===1&&call?.name==='run_command'&&call.arguments.executable==='/usr/local/bin/node'&&JSON.stringify(call.arguments.args)===JSON.stringify(expected)?'PASS':'FAIL';
}catch(error){evidence.outcome='FAIL';evidence.error=error instanceof Error?error.message:'unknown';}finally{clearTimeout(deadline);}
evidence.completed_at=new Date().toISOString();await writeFile(output,JSON.stringify(evidence,null,2)+'\n');
process.stdout.write(JSON.stringify({output,outcome:evidence.outcome,tools_executed:0})+'\n');if(evidence.outcome!=='PASS')process.exitCode=1;
