import assert from 'node:assert/strict';
import { createDecipheriv,createHmac,randomUUID } from 'node:crypto';
import { createServer,type ServerResponse } from 'node:http';
import test from 'node:test';
import { GuacamoleHttpSession } from './guacamole.js';
import { encryptDesktopDefinition } from './security.js';

test('Guacamole stock HTTP adapter keeps auth secrets out of URLs and aborts active upstream on revocation',{timeout:10_000},async t=>{
  const key=Buffer.from('4c0b569e4c96df157eee1b65dd0e4d41','hex'),sessionId=randomUUID(),tunnelId=randomUUID();
  const readers=new Set<ServerResponse>();let disconnected=false;
  let sawScopedJson=false;const urls:string[]=[];
  const server=createServer(async(req,res)=>{
    urls.push(req.url!);let body='';for await(const chunk of req)body+=chunk.toString();
    if(req.url==='/guacamole/api/tokens'){
      const data=new URLSearchParams(body).get('data')!;
      const cipher=createDecipheriv('aes-128-cbc',key,Buffer.alloc(16));
      const decoded=Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]);
      assert.deepEqual(decoded.subarray(0,32),createHmac('sha256',key).update(decoded.subarray(32)).digest());
      const json=JSON.parse(decoded.subarray(32).toString());assert.deepEqual(Object.keys(json.connections),[sessionId]);sawScopedJson=true;
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authToken:'local-test-auth-token'}));return;
    }
    if(req.url==='/guacamole/tunnel?connect'){
      const form=new URLSearchParams(body);assert.equal(form.get('token'),'local-test-auth-token');assert.equal(form.get('GUAC_ID'),sessionId);assert.equal(form.get('GUAC_DATA_SOURCE'),'json');
      res.setHeader('Guacamole-Tunnel-Token','local-test-tunnel-token');res.end(tunnelId);return;
    }
    assert.equal(req.headers['guacamole-tunnel-token'],'local-test-tunnel-token');
    if(req.url!.includes('?read:')){readers.add(res);res.writeHead(200,{'Content-Type':'application/octet-stream'});res.write('4.sync,1.1;');res.once('close',()=>readers.delete(res));return;}
    if(req.url===`/guacamole/tunnel?write:${tunnelId}`){
      if(body==='10.disconnect;'){disconnected=true;for(const reader of readers)reader.end('0.;');}
      res.end();return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address==='object');
  const tunnel=new GuacamoleHttpSession({baseUrl:`http://127.0.0.1:${address.port}/guacamole/`,key});
  t.after(()=>tunnel.close());
  await tunnel.connect(encryptDesktopDefinition({sessionId,expiresAt:Date.now()+30_000,protocol:'vnc',hostname:'explicit-test-fixture',port:5900,password:'test-only-password'},key),sessionId);
  assert.equal(sawScopedJson,true);
  const stream=await tunnel.read();const iterator=stream[Symbol.asyncIterator]();
  assert.match((await iterator.next()).value.toString(),/sync/);
  let browserClosed=false;tunnel.onClose(()=>{browserClosed=true;});
  tunnel.close();
  assert.equal(browserClosed,true);assert.equal(tunnel.isClosed,true);
  await assert.rejects(tunnel.read());await assert.rejects(tunnel.write('3.nop;'));
  await new Promise<void>((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(disconnected){clearInterval(timer);resolve();}else if(Date.now()-start>2500){clearInterval(timer);reject(new Error('Upstream disconnect was not sent'));}},10);});
  assert.equal(urls.some(url=>url.includes('local-test-auth-token')||url.includes('local-test-tunnel-token')||url.includes('test-only-password')),false);
  await iterator.return?.();
});

test('revocation aborts pending JSON authentication and never creates a late tunnel',{timeout:5000},async t=>{
  let connected=false;let requested!:()=>void;
  const requestSeen=new Promise<void>(resolve=>{requested=resolve;});
  const server=createServer((req,res)=>{if(req.url==='/api/tokens'){requested();res.once('close',()=>{});}else{connected=true;res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address==='object');
  const tunnel=new GuacamoleHttpSession({baseUrl:`http://127.0.0.1:${address.port}/`,key:Buffer.alloc(16)});
  const connecting=tunnel.connect('local-test-encrypted-data',randomUUID());
  await requestSeen;tunnel.close();await assert.rejects(connecting);assert.equal(connected,false);
});

test('revocation during upstream tunnel creation drains its bounded handshake then disconnects the late tunnel',{timeout:5000},async t=>{
  let connecting!:()=>void;const connectSeen=new Promise<void>(resolve=>{connecting=resolve;});
  let disconnected=false;
  const server=createServer((req,res)=>{
    if(req.url==='/api/tokens'){res.end(JSON.stringify({authToken:'fixture-token'}));return;}
    if(req.url==='/tunnel?connect'){connecting();setTimeout(()=>{res.setHeader('Guacamole-Tunnel-Token','fixture-tunnel-token');res.end(randomUUID());},50);return;}
    disconnected=true;res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address==='object');
  const tunnel=new GuacamoleHttpSession({baseUrl:`http://127.0.0.1:${address.port}/`,key:Buffer.alloc(16)});
  const connect=tunnel.connect('fixture-data',randomUUID());await connectSeen;tunnel.close();
  await assert.rejects(connect);assert.equal(disconnected,true);assert.equal(tunnel.isClosed,true);
});
