/** Explicit opt-in actual-provider component verification; never run by fixture suite. */
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createProviderAdapter, type ChatRequest } from '../src/index.js';
const [endpoint,model,output] = process.argv.slice(2);
if (!endpoint || !model || !output) throw new Error('Usage: tsx live-check.ts <explicit-loopback-endpoint> <exact-model-id> <evidence-json>');
const url=new URL(endpoint);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('This harness only permits an explicitly isolated loopback provider');
const adapter=createProviderAdapter({id:'isolated-actual-provider',revision:1,adapter:'ollama',baseUrl:endpoint,runtimePoolId:'isolated-test-pool',routing:'local',allowedAddresses:url.hostname==='[::1]'?['::1']:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:120000},{resolveCredential:async()=>{throw new Error('No credentials permitted for isolated component test');}});
const evidence:any={scope:'actual isolated provider component test; not release acceptance',started_at:new Date().toISOString(),endpoint,model,tests:[]};
let failed=false;
async function check(name:string,run:()=>Promise<unknown>){try{evidence.tests.push({name,outcome:'PASS',evidence:await run()});}catch(error){failed=true;evidence.tests.push({name,outcome:'FAIL',reason:error instanceof Error?error.message:'unknown error',...((error as any)?.evidence?{evidence:(error as any).evidence}:{})});}}
const nonce=randomUUID().replace(/-/g,'').slice(0,8);
async function generate(request:ChatRequest){let text='';let text_events=0;let completed:any;for await(const event of adapter.streamChat(request)){if(event.type==='text'){text+=event.text;text_events++;}else completed=event;}if(!completed)throw new Error('No completed response');return{text,text_events,completed};}
await check('version',async()=>({server_version:await adapter.getServerVersion?.()}));
await check('catalog',async()=>{const models=await adapter.discoverModels();const selected=models.find(item=>item.id===model);if(!selected)throw new Error('Exact model not discovered');return selected;});
await check('streaming',async()=>{const value=await generate({model,messages:[{role:'user',content:`Reply with exactly this word: ${nonce}`}],thinking:false,maxOutputTokens:128,temperature:0});if(!value.text.includes(nonce)||value.text_events<2)throw Object.assign(new Error('Nonce or incremental delivery missing'),{evidence:value});return value;});
await check('tool_call_round_trip',async()=>{
 const request:ChatRequest={model,messages:[{role:'user',content:`Use the echo_nonce tool to echo the word ${nonce}. After receiving the result, reply with that word.`}],tools:[{type:'function',function:{name:'echo_nonce',description:'Echo the provided word.',parameters:{type:'object',required:['nonce'],properties:{nonce:{type:'string',description:'The word to echo'}},additionalProperties:false}}}],thinking:false,maxOutputTokens:256,temperature:0};
 const first=await generate(request);if(first.completed.toolCalls.length!==1)throw Object.assign(new Error('Expected one validated structured call'),{evidence:first});const call=first.completed.toolCalls[0];
 if(call.name!=='echo_nonce'||call.arguments.nonce!==nonce)throw new Error('Tool identity or arguments mismatch');
 request.messages.push({role:'assistant',content:first.text,toolCalls:first.completed.toolCalls},{role:'tool',content:JSON.stringify({nonce}),toolCallId:call.id,toolName:call.name});
 const final=await generate(request);if(!final.text.includes(nonce))throw new Error('Returned tool result not consumed');return{first,final,fixture_tool_executions:1};
});
await check('structured_output',async()=>{const result=await generate({model,messages:[{role:'user',content:`Return JSON object with nonce ${nonce}.`}],thinking:false,maxOutputTokens:128,temperature:0,jsonSchema:{type:'object',required:['nonce'],properties:{nonce:{type:'string',const:nonce}},additionalProperties:false}});if(JSON.parse(result.text).nonce!==nonce)throw new Error('Structured nonce mismatch');return result;});
await check('runtime',()=>adapter.getRuntimeState());
await check('unload',()=>adapter.manage('unload',{model}));
evidence.completed_at=new Date().toISOString();await writeFile(output,JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify({output,tests:evidence.tests.map((item:any)=>({name:item.name,outcome:item.outcome}))})+'\n');if(failed)process.exitCode=1;
