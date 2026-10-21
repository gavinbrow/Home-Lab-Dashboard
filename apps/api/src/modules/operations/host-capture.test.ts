import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {captureHostBundle} from './host-capture.js';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(mode:'valid'|'corrupt'|'oversize'){
 const root=await mkdtemp(join(tmpdir(),'homelab-host-ciphertext-'));
 const operationId=randomUUID(),backupSetId=randomUUID(),id=randomUUID(),bytes=Buffer.from('opaque ciphertext only');
 const calls:string[]=[];let polls=0;
 const ready={id,operation_id:operationId,backup_set_id:backupSetId,state:'ready',size_bytes:bytes.length,sha256:sha(bytes),chunk_size_bytes:8,chunk_count:Math.ceil(bytes.length/8),coverage:{complete:true,components:[],exclusions:[]}};
 const rpc=async(method:string,path:string,body:unknown)=>{
  calls.push(method+' '+path);
  if(path.endsWith('/policy'))return {enabled:true,grant_id:'local-capture',policy_revision:1};
  if(method==='POST'&&path.endsWith('/captures')){assert.deepEqual(body,{operation_id:operationId,backup_set_id:backupSetId,grant_id:'local-capture',policy_revision:1});return {...ready,state:'preparing'};}
  if(method==='GET'&&path==='/v1/host-state/captures/'+id){polls++;return ready;}
  if(path.includes('/chunks/')){const index=Number(path.split('/').at(-1)),block=bytes.subarray(index*8,index*8+8);return {id,index,offset:index*8,size_bytes:block.length,sha256:mode==='corrupt'?'0'.repeat(64):sha(block),content_base64:block.toString('base64')};}
  if(path.endsWith('/ack')){assert.equal((body as any).sha256,sha(bytes));assert.deepEqual(await readFile(join(root,'host.age')),bytes);return {acknowledged:true};}
  if(method==='DELETE')return {deleted:true};
  throw new Error('unexpected fixture route');
 };
 return {root,calls,polls,bytes,options:{rpc,operationId,backupSetId,target:join(root,'host.age'),signal:new AbortController().signal,check:async()=>{},pollMs:1,maxBytes:mode==='oversize'?1:1024}};
}
test('host ciphertext chunks validate and fsync before separately acknowledged durable seal',async()=>{
 const f=await fixture('valid');const captured=await captureHostBundle(f.options);
 assert.deepEqual(await readFile(captured.path),f.bytes);
 assert.equal(f.calls.some(call=>call.endsWith('/ack')),false);
 await captured.ack();assert.equal(f.calls.some(call=>call.endsWith('/ack')),true);
});
for(const mode of ['corrupt','oversize'] as const)test('host capture rejects '+mode+' without publishing/acknowledging',async()=>{
 const f=await fixture(mode);await assert.rejects(captureHostBundle(f.options));
 assert.equal((await readdir(f.root)).includes('host.age'),false);
 assert.equal(f.calls.some(call=>call.endsWith('/ack')),false);
 assert.equal(f.calls.some(call=>call.startsWith('DELETE ')),true);
});
