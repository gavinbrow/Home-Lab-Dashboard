import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { createServer,type ServerResponse } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import WebSocket from 'ws';
import { buildApp } from '../../app.js';
import { migrate } from '../../core/migrate.js';
import remote from './index.js';
import machines from '../machines/index.js';
import { gatewayControlToken } from './gateway-control.js';
import { GuacamoleHttpSession,guacamoleSettings } from './guacamole.js';
import { encryptDesktopDefinition } from './security.js';
import { monitorGuacamoleFixture } from './fixture-client.js';

test('desktop gateway real PostgreSQL/HTTP/WebSocket: replay/session binding and active transport revocation',{
  skip:!process.env.HOMELAB_LOCAL_PG_URL?'Requires owned disposable loopback HOMELAB_LOCAL_PG_URL':false,timeout:60_000,
},async t=>{
  const actual=process.env.HOMELAB_GUAC_FIXTURE==='1';
  const source=new URL(process.env.HOMELAB_LOCAL_PG_URL!);assert.ok(['127.0.0.1','localhost','[::1]',...(actual?['postgres']:[])].includes(source.hostname));
  const admin=new pg.Pool({connectionString:source.href,max:2}),name=`remote_gateway_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE "${name}"`);source.pathname=`/${name}`;
  const db=new pg.Pool({connectionString:source.href,max:8});
  const readers=new Set<ServerResponse>();let disconnects=0;
  const fixture=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk.toString();
    assert.equal(req.url!.includes('fixture-auth-secret'),false);assert.equal(req.url!.includes('fixture-tunnel-secret'),false);
    if(req.url==='/api/tokens'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authToken:'fixture-auth-secret'}));return;}
    if(req.url==='/tunnel?connect'){assert.equal(new URLSearchParams(body).get('token'),'fixture-auth-secret');res.setHeader('Guacamole-Tunnel-Token','fixture-tunnel-secret');res.end(randomUUID());return;}
    assert.equal(req.headers['guacamole-tunnel-token'],'fixture-tunnel-secret');
    if(req.url!.startsWith('/tunnel?read:')){readers.add(res);res.writeHead(200,{'Content-Type':'application/octet-stream'});res.write('4.sync,1.1;');res.once('close',()=>readers.delete(res));return;}
    if(body==='10.disconnect;'){disconnects++;for(const reader of readers)reader.end('0.;');}
    res.end();
  });
  await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));const fixtureAddress=fixture.address();assert.ok(fixtureAddress&&typeof fixtureAddress==='object');
  const artifactRoot=await mkdtemp(join(tmpdir(),'remote-gateway-'));
  const envKeys=['APP_ORIGIN','MASTER_KEY','BOOTSTRAP_TOKEN','ARTIFACT_ROOT','DISPATCH_ENABLED','RESTORE_MODE','COOKIE_SECURE','NODE_ENV','GUACAMOLE_INTERNAL_URL','GUACAMOLE_JSON_KEY','GUACAMOLE_JSON_KEY_FILE'] as const;
  const previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  const origin='http://127.0.0.1:5173',password=randomBytes(24).toString('base64url'),bootstrap=randomBytes(32).toString('base64url');
  Object.assign(process.env,{APP_ORIGIN:origin,MASTER_KEY:randomBytes(32).toString('base64'),BOOTSTRAP_TOKEN:bootstrap,ARTIFACT_ROOT:artifactRoot,DISPATCH_ENABLED:'false',RESTORE_MODE:'false',COOKIE_SECURE:'false',NODE_ENV:'test',...(!actual?{GUACAMOLE_INTERNAL_URL:`http://127.0.0.1:${fixtureAddress.port}/`,GUACAMOLE_JSON_KEY:randomBytes(16).toString('hex')}:{})});if(!actual)delete process.env.GUACAMOLE_JSON_KEY_FILE;
  let app:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{
    await app?.close();fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));
    await db.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
    for(const key of envKeys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
    await rm(artifactRoot,{recursive:true,force:true});
  });
  await migrate(db);app=await buildApp({db});const address=await app.listen({host:actual?'0.0.0.0':'127.0.0.1',port:actual?3000:0});
  if(!actual){
    const beat=()=>fetch(new URL('/internal/remote/desktop-session-check',address),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${gatewayControlToken(Buffer.from(process.env.GUACAMOLE_JSON_KEY!,'hex'))}`},body:JSON.stringify({session_id:null,extension_version:'1.0.0',guacamole_version:'1.6.0'})});
    assert.equal((await beat()).status,204);
    const heartbeat=setInterval(()=>void beat().catch(()=>{}),1000);t.after(()=>clearInterval(heartbeat));
  }
  type Auth={cookie:string;csrf:string};
  const http=async(method:string,path:string,payload:unknown,auth?:Auth)=>{
    const response=await fetch(new URL(path,address),{method,headers:{origin,'Content-Type':'application/json',...(auth?{cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(5000)});
    const body=await response.json() as any;return {response,body};
  };
  const bootstrapReply=await http('POST','/api/v1/auth/bootstrap',{email:'remote-gateway@example.invalid',password,token:bootstrap});
  assert.equal(bootstrapReply.response.status,200);
  const first:Auth={cookie:bootstrapReply.response.headers.get('set-cookie')!.split(';')[0],csrf:bootstrapReply.body.csrf_token};
  if(actual){
    for(let attempt=0;attempt<150;attempt++){
      const capability=await http('GET','/api/v1/remote/capabilities',undefined,first);
      if(capability.body.desktop.available)break;
      if(attempt===149)assert.fail('Actual session-lease extension heartbeat did not reach this test API');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  const machine=await http('POST','/api/v1/machines',{name:'Explicit local protocol fixture',os:'linux'},first);assert.equal(machine.response.status,201);
  const conn=await http('POST','/api/v1/remote/desktop-connections',{machine_id:machine.body.id,config:{hostname:actual?'fixture-vnc':'explicit-loopback-protocol-fixture',port:5900,protocol:'vnc',server_type:'test-fixture'},credential:{password:actual?'':'fixture-desktop-secret'}},first);assert.equal(conn.response.status,201,JSON.stringify(conn.body));
  const issue=()=>http('POST','/api/v1/desktop-sessions',{connection_id:conn.body.id},first);
  const launch=await issue();assert.equal(launch.response.status,201);
  const login=await http('POST','/api/v1/auth/login',{email:'remote-gateway@example.invalid',password});
  const second:Auth={cookie:login.response.headers.get('set-cookie')!.split(';')[0],csrf:login.body.csrf_token};
  assert.equal((await http('POST',`/api/v1/desktop-sessions/${launch.body.id}/attach`,{ticket:launch.body.ticket},second)).response.status,403);
  const attempts=await Promise.all([1,2].map(()=>http('POST',`/api/v1/desktop-sessions/${launch.body.id}/attach`,{ticket:launch.body.ticket},first)));
  assert.deepEqual(attempts.map(item=>item.response.status).sort(),[200,403]);
  const attached=attempts.find(item=>item.response.status===200)!.body;
  assert.equal(JSON.stringify(attached).includes('fixture-auth-secret'),false);assert.equal(JSON.stringify(attached).includes('fixture-tunnel-secret'),false);
  const tunnelPath=attached.tunnel_path+'/http';
  const headers={origin,cookie:first.cookie,'X-CSRF-Token':first.csrf,'Content-Type':'application/x-www-form-urlencoded'};
  const connected=await fetch(new URL(tunnelPath+'?connect',address),{method:'POST',headers,body:''});
  assert.equal(connected.status,200);assert.equal(await connected.text(),launch.body.id);
  assert.equal(connected.headers.get('Guacamole-Tunnel-Token'),launch.body.id);
  const reading=await fetch(new URL(tunnelPath+`?read:${launch.body.id}:0`,address),{headers:{cookie:first.cookie},signal:AbortSignal.timeout(5000)});
  assert.equal(reading.status,200);const reader=reading.body!.getReader();
  let display='';while(!/4\.(sync|size),/.test(display)){const part=await reader.read();assert.equal(part.done,false);display+=new TextDecoder().decode(part.value);assert.ok(display.length<2_097_152);}
  const pending=(async()=>{try{while(!(await reader.read()).done){/* Drain already-sent display bytes until network closes. */}}catch{}})();
  const revoked=await http('POST',`/api/v1/desktop-sessions/${launch.body.id}/revoke`,{},first);assert.equal(revoked.response.status,200);
  await pending;
  assert.equal((await fetch(new URL(tunnelPath+`?read:${launch.body.id}:1`,address),{headers:{cookie:first.cookie}})).status,404);
  const launchWs=await issue();const attachedWs=await http('POST',`/api/v1/desktop-sessions/${launchWs.body.id}/attach`,{ticket:launchWs.body.ticket},first);assert.equal(attachedWs.response.status,200);
  const ws=new WebSocket(new URL(attachedWs.body.tunnel_path+'/websocket',address).href.replace('http:','ws:'),'guacamole',{headers:{origin,cookie:first.cookie}});
  t.after(()=>ws.terminate());
  const seen=new Promise<string>(resolve=>ws.on('message',data=>{if(/4\.(sync|size),/.test(data.toString()))resolve(data.toString());}));
  await seen;
  const closed=new Promise<void>(resolve=>ws.once('close',()=>resolve()));
  assert.equal((await http('POST','/api/v1/auth/logout',{},first)).response.status,200);await closed;
  await new Promise(resolve=>setTimeout(resolve,50));if(!actual)assert.ok(disconnects>=2);
  const restoreLaunch=await http('POST','/api/v1/desktop-sessions',{connection_id:conn.body.id},second);assert.equal(restoreLaunch.response.status,201);
  const restoreAttach=await http('POST',`/api/v1/desktop-sessions/${restoreLaunch.body.id}/attach`,{ticket:restoreLaunch.body.ticket},second);assert.equal(restoreAttach.response.status,200);
  const restoreWs=new WebSocket(new URL(restoreAttach.body.tunnel_path+'/websocket',address).href.replace('http:','ws:'),'guacamole',{headers:{origin,cookie:second.cookie}});
  t.after(()=>restoreWs.terminate());
  await new Promise<void>(resolve=>restoreWs.on('message',data=>{if(/4\.(sync|size),/.test(data.toString()))resolve();}));
  const restoreClosed=new Promise<void>(resolve=>restoreWs.once('close',()=>resolve()));
  await db.query('UPDATE runtime_control SET restore_mode=true WHERE singleton=true');
  await restoreClosed;
  assert.equal((await http('GET','/api/v1/remote/capabilities',undefined,second)).body.desktop.available,false);
  assert.equal((await http('POST','/api/v1/desktop-sessions',{connection_id:conn.body.id},second)).response.status,503);
  const controlSettings=await guacamoleSettings();assert.ok(controlSettings);
  const deniedCheck=await fetch(new URL('/internal/remote/desktop-session-check',address),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${gatewayControlToken(controlSettings.key)}`},body:JSON.stringify({session_id:restoreLaunch.body.id,extension_version:'1.0.0',guacamole_version:'1.6.0'})});assert.equal(deniedCheck.status,403);
  await db.query('UPDATE runtime_control SET restore_mode=false WHERE singleton=true');
  for(let attempt=0;attempt<30;attempt++){
    if((await http('GET','/api/v1/remote/capabilities',undefined,second)).body.desktop.available)break;
    if(attempt===29)assert.fail('Gateway lease readiness did not recover after test restore mode cleared');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(actual){
    const settings=await guacamoleSettings();assert.ok(settings);
    const authId=(await db.query('SELECT id FROM sessions WHERE token_hash=$1',[createHash('sha256').update(second.cookie.split('=')[1]).digest('hex')])).rows[0].id;
    const unmanagedId=randomUUID(),unmanaged=new GuacamoleHttpSession(settings);
    await db.query(`INSERT INTO remote_sessions(id,owner_id,auth_session_id,machine_id,connection_id,kind,state,expires_at) VALUES($1,$2,$3,$4,$5,'desktop','active',now()+interval '1 minute')`,[unmanagedId,bootstrapReply.body.actor.id,authId,machine.body.id,conn.body.id]);
    try{
      await unmanaged.connect(encryptDesktopDefinition({sessionId:unmanagedId,expiresAt:Date.now()+45_000,protocol:'vnc',hostname:'fixture-vnc',port:5900,password:''},settings.key),unmanagedId);
      const stream=await unmanaged.read(),iterator=stream[Symbol.asyncIterator]();assert.equal((await iterator.next()).done,false);
      // This upstream tunnel is deliberately absent from the API process registry:
      // the Java lease listener must close it without knowing its UUID/token here.
      const ended=(async()=>{while(!(await iterator.next()).done){}})();
      await db.query("UPDATE remote_sessions SET state='closed' WHERE id=$1",[unmanagedId]);
      let deadline:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([ended,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Guacamole listener did not close the unknown upstream tunnel')),5000);})]);}finally{clearTimeout(deadline);}
    }finally{unmanaged.close();}
    const late=new GuacamoleHttpSession(settings);
    try{
      await assert.rejects(late.connect(encryptDesktopDefinition({sessionId:unmanagedId,expiresAt:Date.now()+45_000,protocol:'vnc',hostname:'fixture-vnc',port:5900,password:''},settings.key),unmanagedId));
    }finally{late.close();}
    // Force an actual stock Guacamole tunnel to exist while withholding its
    // HTTP handshake from the gateway beyond the production20s deadline.
    const delayedId=randomUUID();
    await db.query(`INSERT INTO remote_sessions(id,owner_id,auth_session_id,machine_id,connection_id,kind,state,expires_at) VALUES($1,$2,$3,$4,$5,'desktop','active',now()+interval '2 minutes')`,[delayedId,bootstrapReply.body.actor.id,authId,machine.body.id,conn.body.id]);
    let received!:()=>void;const tunnelCreated=new Promise<void>(resolve=>{received=resolve;});
    let monitor:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let monitorClient:ReturnType<typeof monitorGuacamoleFixture>|undefined;
    const heldTimers=new Set<ReturnType<typeof setTimeout>>();
    const delayingProxy=createServer(async(req,res)=>{
      try{
        const path=req.url||'';if(!['/api/tokens','/tunnel?connect'].includes(path)){res.writeHead(404);res.end();return;}
        let body='';for await(const part of req)body+=part.toString();
        const upstreamResponse=await fetch(new URL(path.slice(1),settings.baseUrl),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,redirect:'error'});
        const text=await upstreamResponse.text();
        if(path==='/api/tokens'){res.writeHead(upstreamResponse.status,{'Content-Type':'application/json'});res.end(text);return;}
        assert.equal(upstreamResponse.status,200);
        const privateHeader=upstreamResponse.headers.get('Guacamole-Tunnel-Token')!;
        const reading=await fetch(new URL(`tunnel?read:${text.trim()}:0`,settings.baseUrl),{headers:{'Guacamole-Tunnel-Token':privateHeader}});
        monitor=reading.body!.getReader();
        monitorClient=monitorGuacamoleFixture(monitor,async data=>{
          const written=await fetch(new URL(`tunnel?write:${text.trim()}`,settings.baseUrl),{method:'POST',headers:{'Content-Type':'application/octet-stream','Guacamole-Tunnel-Token':privateHeader},body:data,signal:AbortSignal.timeout(2000)});
          assert.equal(written.status,200);await written.body?.cancel();
        });
        await monitorClient.ready;received();
        const timer=setTimeout(()=>{heldTimers.delete(timer);res.setHeader('Guacamole-Tunnel-Token',privateHeader);res.end(text);},22_000);heldTimers.add(timer);
      }catch{res.destroy();}
    });
    await new Promise<void>(resolve=>delayingProxy.listen(0,'127.0.0.1',resolve));
    const proxyAddress=delayingProxy.address();assert.ok(proxyAddress&&typeof proxyAddress==='object');
    const delayed=new GuacamoleHttpSession({...settings,baseUrl:`http://127.0.0.1:${proxyAddress.port}/`});
    try{
      const timedOut=assert.rejects(delayed.connect(encryptDesktopDefinition({sessionId:delayedId,expiresAt:Date.now()+45_000,protocol:'vnc',hostname:'fixture-vnc',port:5900,password:''},settings.key),delayedId));
      await tunnelCreated;await timedOut;delayed.close();
      const remaining=monitorClient!.state.readyAt+20_250-Date.now();
      if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
      assert.equal(monitorClient!.state.closed,false,'The real target must remain alive beyond the production 20 second handshake timeout');
      assert.equal(monitorClient!.state.error,null);
      assert.ok(monitorClient!.state.acknowledgements>0,'The real target display sync must have been acknowledged');
      assert.ok(monitorClient!.state.keepAlives>=3,'The test client must keep the real target alive throughout the held handshake');
      assert.ok(Date.now()-monitorClient!.state.lastKeepAliveAt<6000,'The target must have accepted a keep-alive near the timeout boundary');
      t.diagnostic(`Lost-handshake target alive for ${Date.now()-monitorClient!.state.readyAt}ms before lease revoke; ${monitorClient!.state.acknowledgements} sync acknowledgements, ${monitorClient!.state.keepAlives} keep-alives`);
      const revokedAt=Date.now();
      await db.query("UPDATE remote_sessions SET state='closed' WHERE id=$1",[delayedId]);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([monitorClient!.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Listener left a late unknown-ID tunnel alive after the gateway 20 second timeout')),5000);})]);}finally{clearTimeout(timer);}
      t.diagnostic(`Authoritative lease closure ended the unknown-ID upstream stream in ${Date.now()-revokedAt}ms`);
    }finally{
      await db.query("UPDATE remote_sessions SET state='closed' WHERE id=$1",[delayedId]);
      delayed.close();for(const timer of heldTimers)clearTimeout(timer);delayingProxy.closeAllConnections();
      await new Promise<void>(resolve=>delayingProxy.close(()=>resolve()));await monitor?.cancel().catch(()=>{});
    }
    const outageId=randomUUID(),outage=new GuacamoleHttpSession(settings);
    await db.query(`INSERT INTO remote_sessions(id,owner_id,auth_session_id,machine_id,connection_id,kind,state,expires_at) VALUES($1,$2,$3,$4,$5,'desktop','active',now()+interval '1 minute')`,[outageId,bootstrapReply.body.actor.id,authId,machine.body.id,conn.body.id]);
    try{
      await outage.connect(encryptDesktopDefinition({sessionId:outageId,expiresAt:Date.now()+45_000,protocol:'vnc',hostname:'fixture-vnc',port:5900,password:''},settings.key),outageId);
      const stream=await outage.read(),iterator=stream[Symbol.asyncIterator]();assert.equal((await iterator.next()).done,false);
      const ended=(async()=>{while(!(await iterator.next()).done){}})();
      // This tunnel is not in the API registry. Only Guacamole's own listener
      // can close it when its authoritative session-check API becomes unavailable.
      await app.close();
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([ended,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Listener failed open while the authoritative API was unavailable')),5000);})]);}finally{clearTimeout(timer);}
    }finally{outage.close();await db.query("UPDATE remote_sessions SET state='closed' WHERE id=$1",[outageId]);}
  }
});
