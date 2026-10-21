import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,randomUUID } from 'node:crypto';
import { canonicalJson,rpcDigest,signRpc,verifyRpc,validateRpcRoute,validateSafetyCancel } from '../src/index.js';
test('canonical transport preserves dangerous object property names as data',()=>{
 const value=JSON.parse('{"__proto__":{"x":1},"constructor":"data"}');
 assert.equal(canonicalJson(value),'{"__proto__":{"x":1},"constructor":"data"}');assert.notEqual(rpcDigest(value),rpcDigest({}));
 assert.equal(canonicalJson({text:'\u2028\u2029'}),'{"text":"\\u2028\\u2029"}');
});
test('signed relay binds every request field, machine, expiry and epoch',()=>{
 const keys=generateKeyPairSync('ed25519'),signer={keyId:'test',privateKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
 const request=signRpc({schema_version:1,id:randomUUID(),machine_id:randomUUID(),method:'GET',path:'/v1/health',body:null,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),dispatch_epoch:randomUUID()},signer);
 assert.ok(verifyRpc(request,'test',keys.publicKey));assert.equal(verifyRpc({...request,path:'/v1/workspaces'},'test',keys.publicKey),false);assert.equal(verifyRpc(request,'other',keys.publicKey),false);assert.equal(verifyRpc(request,'test',keys.publicKey,Date.now()+120000),false);
});
test('relay paths deny arbitrary remote protocols and traversal',()=>{
 for(const path of ['https://remote/v1/health','/v1/../private','/v1/%2e%2e/private','/v1/arbitrary','/v1/health#fragment'])assert.throws(()=>validateRpcRoute('GET',path));
 validateRpcRoute('GET','/v1/workspaces/abc/files?path=report.txt');
});
test('safety cancellation permits only fixed operation or enrolled target receipt verbs',()=>{
 const target=randomUUID(),operation=randomUUID();validateSafetyCancel('POST',`/v1/operations/${operation}/cancel`);validateSafetyCancel('POST',`/v1/targets/${target}/actions/${operation}/cancel`);
 for(const path of [`/v1/targets/${target}/actions/${operation}/restart`,`/v1/targets/${target}/actions/${operation}/cancel?target=other`,'/v1/operations/not-a-uuid/cancel'])assert.throws(()=>validateSafetyCancel('POST',path));
 assert.throws(()=>validateSafetyCancel('GET',`/v1/operations/${operation}/cancel`));
});
