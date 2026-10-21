import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { colorProbeImage } from '../src/images.js';
import { testProviderConnectivity } from '../src/connectivity.js';
import { createProviderAdapter, createTransport, normalizeEndpoint, type ChatEvent, type ProviderSnapshot } from '../src/index.js';
import { usage } from '../src/stream.js';
const snapshot: ProviderSnapshot = { id: 'fixture', revision: 1, adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', runtimePoolId: 'fixture', routing: 'unknown', allowedAddresses: ['127.0.0.1'], allowPrivateHttp: true, timeoutMs: 100 };
function fixture(payload: string, adapter: ProviderSnapshot['adapter'] = 'openai-compatible') {
  return createProviderAdapter({ ...snapshot, adapter }, { resolveCredential: async () => '', transport: { request: async () => new Response(payload) } });
}
async function collect(adapter: ReturnType<typeof fixture>, tools?: any[]) { const events: ChatEvent[] = []; for await (const event of adapter.streamChat({ model: 'requested', messages: [{ role: 'user', content: 'fixture' }], tools })) events.push(event); return events; }
const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\r\n\r\n`;
test('normalizes a single /v1 without accepting userinfo, query or alternate paths', () => {
  assert.equal(normalizeEndpoint('https://example.test/v1/').pathname, '/v1');
  for (const value of ['file:///tmp/x', 'http://u:p@example.test', 'http://example.test?key=x', 'http://example.test/v1/v1']) assert.throws(() => normalizeEndpoint(value));
});
test('blocks metadata and ungranted plaintext destinations before network I/O', () => {
  assert.throws(() => createTransport({ ...snapshot, allowedAddresses: ['169.254.169.254'] }, async () => ''));
  for (const address of ['::ffff:a9fe:a9fe', '::a9fe:a9fe', 'febf::1', '239.1.2.3', 'ff02::1','fd00:ec2::254']) assert.throws(() => createTransport({ ...snapshot, allowedAddresses: [address] }, async () => ''));
  assert.doesNotThrow(()=>createTransport({...snapshot,baseUrl:'https://[fd00::1]',allowedAddresses:['fd00::1']},async()=>''));
  assert.throws(() => createTransport({ ...snapshot, allowPrivateHttp: false }, async () => ''));
});
test('compatible stream preserves model provenance and missing usage', async () => {
  const events = await collect(fixture(event({ model: 'resolved', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] }) + event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\r\n\r\n'));
  assert.equal(events[0]?.type, 'text'); const done = events[1]; assert.equal(done?.type, 'completed');
  if (done?.type === 'completed') { assert.equal(done.resolvedModel, 'resolved'); assert.equal(done.usage.outputTokens, null); }
});
test('stream truncation never yields complete tool calls', async () => {
  const stream = fixture(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'echo', arguments: '{' } }] } }] }));
  await assert.rejects(collect(stream), /before a complete response/);
});
test('complete tool arguments must pass their declared schema', async () => {
  const tools = [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', required: ['nonce'], properties: { nonce: { type: 'string' } }, additionalProperties: false } } }];
  const wire = (args: string) => event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'echo', arguments: args } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  const invalid=await collect(fixture(wire('{"nonce":1}')),tools);const rejected=invalid[0];assert.equal(rejected?.type,'completed');if(rejected?.type==='completed'){assert.deepEqual(rejected.toolCalls,[]);assert.equal(rejected.rejectedToolCalls?.[0]?.arguments.nonce,1);assert.match(rejected.rejectedToolCalls?.[0]?.error??'',/failed their declared schema/);}
  const events = await collect(fixture(wire('{"nonce":"ok"}')), tools); const done = events[0];
  assert.equal(done?.type, 'completed'); if (done?.type === 'completed') assert.deepEqual(done.toolCalls[0]?.arguments, { nonce: 'ok' });
});
test('plain code blocks never become tool calls', async () => {
  const events = await collect(fixture(event({ choices: [{ index: 0, delta: { content: '```sh\nrm x\n```' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'));
  const done = events[1]; if (done?.type === 'completed') assert.deepEqual(done.toolCalls, []); else assert.fail('missing final event');
});
test('complete rejected tool calls remain separate from valid calls with stable order and no coercion',async()=>{
  const tools=[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false}}}];
  const wire=event({choices:[{index:0,delta:{tool_calls:[{index:0,id:'valid',function:{name:'echo',arguments:'{"nonce":"ok"}'}},{index:1,id:'invalid',function:{name:'echo',arguments:'{"nonce":42}'}}]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n';
  const events=await collect(fixture(wire),tools);const done=events[0];assert.equal(done?.type,'completed');if(done?.type==='completed'){
    assert.deepEqual(done.toolCalls.map(call=>[call.id,call.index]),[['valid',0]]);
    assert.deepEqual(done.rejectedToolCalls?.map(call=>[call.id,call.index,call.arguments.nonce]),[['invalid',1,42]]);
  }
  const broken=event({choices:[{index:0,delta:{tool_calls:[{index:0,id:'bad-json',function:{name:'echo',arguments:'{"nonce":'}}]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n';
  await assert.rejects(collect(fixture(broken),tools),/invalid tool calls/);
});
test('Ollama timing conversion preserves unknown cache semantics', async () => {
  const noCache = usage({ prompt_eval_count: 20, prompt_eval_duration: 1e9, eval_count: 10, eval_duration: 2e9 }, true);
  assert.equal(noCache.decodeTokensPerSecond, 5); assert.equal(noCache.promptTokensPerSecond, null);
  assert.equal(usage({ prompt_eval_count: 20, prompt_eval_cached_count: 5, prompt_eval_duration: 1e9 }, true).promptTokensPerSecond, 15);
  const events = await collect(fixture('{"model":"actual","message":{"content":"ok"},"done":true,"eval_count":2,"eval_duration":1000000000}\n', 'ollama'));
  assert.equal(events.at(-1)?.type, 'completed');
});
test('compatible runtime and management stay explicitly unknown/unsupported', async () => {
  const adapter = fixture('{}'); assert.equal((await adapter.getRuntimeState()).residency, 'unknown');
  await assert.rejects(adapter.manage('load', { model: 'x' }), /unavailable/);
});
test('real local HTTP fixture validates pinned transport and rejects redirects', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/v1/models') { response.setHeader('content-type','application/json'); response.end('{"data":[{"id":"fixture-model"}]}'); }
    else { response.writeHead(302, { location: '/v1/models' }); response.end(); }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const local = { ...snapshot, baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 5000 };
    const adapter = createProviderAdapter(local, { resolveCredential: async () => '' });
    assert.equal((await adapter.discoverModels())[0]?.id,'fixture-model');
    await assert.rejects(createTransport(local,async()=> '').request('/v1/redirect'), /failed or timed out/);
    assert.equal(requests,2);
    await assert.rejects(createTransport({ ...local, allowedAddresses:['127.0.0.2'] },async()=> '').request('/v1/models'), /enrolled destination/);
    assert.equal(requests,2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); }
});
test('provider request deadline also bounds an active response stream',async()=>{
  const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.write('start');const interval=setInterval(()=>response.write('more'),10);response.on('close',()=>clearInterval(interval));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  let guard:ReturnType<typeof setTimeout>|undefined;
  try{
    const response=await createTransport({...snapshot,baseUrl:`http://127.0.0.1:${address.port}`,timeoutMs:80},async()=>'').request('/api/chat');
    await assert.rejects(Promise.race([response.text(),new Promise<never>((_resolve,reject)=>{guard=setTimeout(()=>reject(new Error('deadline_not_enforced')),1500);})]),/Provider stream interrupted/);
  }finally{clearTimeout(guard);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('caller cancellation terminates a response waiting for its next chunk',async()=>{
  const server=createServer((_request,response)=>{response.writeHead(200);response.write('start');});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  let guard:ReturnType<typeof setTimeout>|undefined;
  try{
    const cancel=new AbortController();const response=await createTransport({...snapshot,baseUrl:`http://127.0.0.1:${address.port}`,timeoutMs:5000},async()=>'').request('/api/chat',undefined,cancel.signal);
    const body=response.text();cancel.abort();
    await assert.rejects(Promise.race([body,new Promise<never>((_resolve,reject)=>{guard=setTimeout(()=>reject(new Error('caller_abort_not_enforced')),1500);})]),/Provider stream interrupted/);
  }finally{clearTimeout(guard);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('LM Studio separates catalog residency from claims and native management paths', async () => {
  const calls: {path:string;body:unknown}[] = [];
  const adapter = createProviderAdapter({ ...snapshot, adapter:'lm-studio' }, { resolveCredential:async()=>'', transport:{request:async(path,body)=>{
    calls.push({path,body}); return new Response(JSON.stringify(path === '/api/v1/models' ? {models:[{key:'fixture',loaded_instances:[{id:'instance',config:{context_length:4096}}],capabilities:{trained_for_tool_use:true}}]} : {instance_id:'instance'}));
  }} });
  const models = await adapter.discoverModels(); assert.equal(models[0]?.residency,'loaded'); assert.equal(models[0]?.capabilities.tools,'claimed');
  await adapter.manage('unload',{instanceId:'instance'});
  assert.deepEqual(calls[1],{path:'/api/v1/models/unload',body:{instance_id:'instance'}});
  assert.equal(adapter.getCapabilities().tools,'unknown');
});
test('images use explicit bytes in compatible and native wire formats',async()=>{
  for (const adapterKind of ['openai-compatible','ollama'] as const) {
    let sent:any;
    const adapter=createProviderAdapter({...snapshot,adapter:adapterKind},{resolveCredential:async()=>'',transport:{request:async(_path,body)=>{sent=body;return new Response(adapterKind==='ollama'?'{"done":true,"message":{"content":"red"}}\n':event({choices:[{index:0,delta:{content:'red'},finish_reason:'stop'}]})+'data: [DONE]\n\n');}}});
    const image=colorProbeImage('red');
    for await(const _ of adapter.streamChat({model:'fixture',messages:[{role:'user',content:'Color?',images:[image]}]})){}
    if(adapterKind==='ollama') assert.deepEqual(sent.messages[0].images,[image.base64]);
    else assert.equal(sent.messages[0].content[1].image_url.url,`data:image/png;base64,${image.base64}`);
    await assert.rejects(async()=>{for await(const _ of adapter.streamChat({model:'fixture',messages:[{role:'user',content:'x',images:[{mimeType:'image/png',base64:'https://untrusted.test/image'}]}]})){}},/canonical bounded base64/);
  }
});
test('explicit private CA preserves TLS validation and default trust fails closed',async()=>{
  const cert=await readFile(new URL('./fixtures/localhost-test-ca.pem',import.meta.url),'utf8');
  const key=await readFile(new URL('./fixtures/localhost-test-key.pem',import.meta.url),'utf8');
  const server=createHttpsServer({cert,key},(_req,res)=>res.end('{"data":[]}'));
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const local={...snapshot,baseUrl:`https://127.0.0.1:${address.port}`,timeoutMs:5000};
  try{
    assert.deepEqual(await createProviderAdapter({...local,privateCaPem:cert},{resolveCredential:async()=>''}).discoverModels(),[]);
    await assert.rejects(createProviderAdapter(local,{resolveCredential:async()=>''}).discoverModels(),/connection failed/);
    assert.throws(()=>createTransport({...local,privateCaPem:key},async()=>''),/CA certificates/);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('Ollama pull forwards bounded progress and requires terminal success',async()=>{
  const progress:unknown[]=[];let body:any;
  const make=(wire:string)=>createProviderAdapter({...snapshot,adapter:'ollama'},{resolveCredential:async()=>'',transport:{request:async(_path,value)=>{body=value;return new Response(wire);}}});
  const completed=await make('{"status":"pulling","completed":1,"total":2}\n{"status":"success"}\n').manage('download',{model:'fixture:tag',onProgress:async value=>{progress.push(value);}});
  assert.equal(completed.status,'success');assert.deepEqual(body,{model:'fixture:tag',stream:true});assert.equal(progress.length,2);
  await assert.rejects(make('{"status":"pulling"}\n').manage('download',{model:'fixture:tag'}),/without confirmed completion/);
});
test('connectivity test separates destination, TCP, trusted HTTP, auth and catalog without inference',async()=>{
  let calls=0;const server=createServer((request,response)=>{calls++;assert.equal(request.url,'/v1/models');response.writeHead(401);response.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  try{
    const result=await testProviderConnectivity({...snapshot,baseUrl:`http://127.0.0.1:${address.port}`,timeoutMs:5000},async()=> '');
    assert.deepEqual(result.tests.map(test=>[test.test,test.state]),[['dns','pass'],['connection','pass'],['tls','not_applicable'],['authentication','fail'],['discovery','unknown']]);assert.equal(calls,1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
