import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {executeProviderJob} from '../src/jobs.js';
import {colorProbeImage} from '../src/images.js';
import type {ProviderSnapshot} from '../src/types.js';
const event=(value:unknown)=>`data: ${JSON.stringify(value)}\n\n`;
async function harness(capability:string,handler:(body:any,response:ServerResponse)=>void) {
  const server=createServer(async(request:IncomingMessage,response)=>{
    if(request.method==='GET'){response.end('{"data":[{"id":"fixture-model","digest":"fixture-digest"}]}');return;}
    let bytes='';for await(const chunk of request)bytes+=chunk;handler(JSON.parse(bytes),response);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const provider:ProviderSnapshot={id:'fixture-provider',revision:1,adapter:'openai-compatible',baseUrl:`http://127.0.0.1:${address.port}`,runtimePoolId:'fixture-pool',allowedAddresses:['127.0.0.1'],allowPrivateHttp:true,timeoutMs:5000,routing:'unknown'};
  const probes:any[]=[];let completed:any;let interrupted:string|undefined;const events:any[]=[];
  try {
    await executeProviderJob({id:'fixture-job',requester_id:'fixture-owner',kind:'provider.probe',payload:{provider,model_id:'fixture-model',capability}},
      {db:{query:async(sql,values)=>{if(sql.startsWith('INSERT INTO capability_probes'))probes.push(values);return{rows:[],rowCount:0};}},signal:new AbortController().signal,assertLease:async()=>{},cancelled:async()=>false,appendEvent:async(type,payload)=>{events.push({type,payload});},complete:async result=>{completed=result;},interrupt:async reason=>{interrupted=reason;}},async()=> '');
    return{probes,completed,interrupted,events};
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
test('image probe sends generated distinguishable images and persists smoke evidence',async()=>{
  const result=await harness('image_input',(body,response)=>{
    const images=body.messages[0].content.filter((part:any)=>part.type==='image_url');assert.equal(images.length,2);
    const first=images[0].image_url.url===`data:image/png;base64,${colorProbeImage('red').base64}`?'red':'blue';
    response.end(event({model:'resolved-fixture',choices:[{index:0,delta:{content:first==='red'?'red,blue':'blue,red'},finish_reason:'stop'}]})+'data: [DONE]\n\n');
  });
  assert.equal(result.completed.state,'tested_pass');assert.equal(result.probes[0][7].scope,'image_smoke_test_only');assert.equal(result.probes[0][7].resolved_model,'resolved-fixture');
});
test('invalid complete structured tool call records failed compatibility rather than unknown inference',async()=>{
  const result=await harness('tools',(_body,response)=>response.end(event({choices:[{index:0,delta:{tool_calls:[{index:0,id:'fixture-call',function:{name:'echo_nonce',arguments:'{"nonce":7}'}}]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n'));
  assert.equal(result.completed.state,'tested_fail');assert.equal(result.interrupted,undefined);
});
test('cancellation probe confirms local delivery stop while retaining provider uncertainty',async()=>{
  const result=await harness('cancellation',(_body,response)=>{
    response.writeHead(200,{'content-type':'text/event-stream'});response.write(event({choices:[{index:0,delta:{content:'1'},finish_reason:null}]}));
  });
  assert.equal(result.completed,undefined);assert.equal(result.interrupted,'client_stop_observed_provider_stop_unconfirmed');
  assert.equal(result.probes[0][7].provider_stop,'unconfirmed');assert.equal(result.probes[0][7].client_stop,'observed');
});
