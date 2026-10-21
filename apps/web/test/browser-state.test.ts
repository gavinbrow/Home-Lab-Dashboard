import assert from 'node:assert/strict';
import test from 'node:test';
import { fromBase64,toBase64,utf8,parseCsv } from '../src/file-codecs.js';
import { assistantTurns,mergeEvents,type EventRecord } from '../src/job-events.js';
const event=(id:string,type:string,payload:unknown):EventRecord=>({id,sequence:id,type,payload,timestamp:'2026-10-21T00:00:00Z'});
test('binary download encoding and UTF-8 editor preserve original BOM and CRLF',()=>{
 const bytes=Uint8Array.from([0,255,17,128,50]);assert.deepEqual(fromBase64(toBase64(bytes)),bytes);assert.equal(utf8(bytes),undefined);
 const original=new TextEncoder().encode('\uFEFFfirst\r\nsecond\r\n');const decoded=utf8(original);assert.equal(decoded,'\uFEFFfirst\r\nsecond\r\n');assert.deepEqual(new TextEncoder().encode(decoded),original);assert.equal(utf8(Uint8Array.from([0xff,0xfe])),undefined);
});
test('bounded CSV preview handles quoted commas, escaped quotes and multiline cells without executing content',()=>{
 const parsed=parseCsv('name,note\r\n"a,b","line 1\nline ""2"""\r\n=cmd(),<script>');assert.deepEqual(parsed.rows,[['name','note'],['a,b','line 1\nline "2"'],['=cmd()','<script>']]);assert.equal(parsed.truncated,false);
 const bounded=parseCsv('a,b,c\n1,2,3\n4,5,6',2,2);assert.deepEqual(bounded.rows,[['a','b'],['1','2']]);assert.equal(bounded.truncated,true);
});
test('SSE replay merges int64 event IDs without duplicate text or unsafe number rounding',()=>{
 const first=event('9007199254740993','assistant.delta',{message_id:'m',text:'first'});const second=event('9007199254740994','assistant.delta',{message_id:'m',text:' second'});
 const merged=mergeEvents([second],[first,second]);assert.deepEqual(merged.map(e=>e.id),[first.id,second.id]);assert.equal(assistantTurns(merged)[0].text,'first second');
 const again=mergeEvents(merged,[first,second]);assert.equal(assistantTurns(again)[0].text,'first second');assert.equal(mergeEvents(again,[event('9007199254740995','log',{})],2).length,2);
});
test('persisted final response replaces partial deltas and preserves separate assistant turns',()=>{
 const rows=[event('1','assistant.delta',{message_id:'a',text:'partial'}),event('2','assistant.completed',{message_id:'a',text:'verified final'}),event('3','assistant.delta',{message_id:'b',text:'next'})];
 assert.deepEqual(assistantTurns(rows).map(t=>[t.text,t.completed]),[['verified final',true],['next',false]]);
});
import { webcrypto } from 'node:crypto';
import { hashFile,chunkHash,CHUNK_BYTES } from '../src/transfer-hash.js';
test('incremental file SHA256 matches native digest across empty and chunk boundaries',async()=>{
 for(const size of [0,1,CHUNK_BYTES-1,CHUNK_BYTES,CHUNK_BYTES+17]){const bytes=Uint8Array.from({length:size},(_,i)=>(i*17+3)%256);const expected=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');assert.equal(await hashFile(new Blob([bytes])),expected);assert.equal(chunkHash(bytes),expected);}
});
test('file hash cancellation aborts before additional chunks',async()=>{const controller=new AbortController();controller.abort();await assert.rejects(hashFile(new Blob([new Uint8Array(4)]),controller.signal),{name:'AbortError'});});
import { currentContextDraft } from '../src/run-context.js';
import type { RunContext, Workspace } from '@homelab/contracts';
import type { Provider } from '../src/Settings.js';
test('historical context draft updates current revisions without inferring execution from model host',()=>{
 const provider={id:'00000000-0000-4000-8000-000000000001',revision:3,adapter:'ollama',endpoint:'http://model.example:11434'} as Provider;
 const workspace={id:'00000000-0000-4000-8000-000000000002',machine_id:'00000000-0000-4000-8000-000000000003',state:'active',revision:7,instruction_revision:2,environment_id:null,environment_generation:null} as Workspace;
 const recorded:RunContext={schema_version:1,provider_id:provider.id,provider_config_revision:1,provider_adapter:'ollama',provider_endpoint:'http://old.example:11434',model_id:'exact-model',profile_id:null,profile_revision:null,execution_machine_id:'00000000-0000-4000-8000-000000000004',execution_identity_id:null,workspace_id:workspace.id,workspace_revision:1,environment_id:null,environment_generation:null,project_instruction_revision:1,policy_revision:1,limits:{max_tool_steps:10,wall_time_seconds:60,per_command_timeout_seconds:10,max_output_bytes:1024}};
 const draft=currentContextDraft(recorded,[provider],[],[workspace]);assert.equal(draft.provider_config_revision,3);assert.equal(draft.workspace_revision,7);assert.equal(draft.execution_machine_id,recorded.execution_machine_id);assert.equal(recorded.provider_config_revision,1);assert.throws(()=>currentContextDraft(recorded,[],[],[workspace]),/provider is unavailable/);assert.throws(()=>currentContextDraft(recorded,[provider],[],[{...workspace,state:'archived'}]),/archived/);
});
import { replayChunk } from '../src/terminal-output.js';
test('terminal replay deduplicates byte overlap and marks a retained-output gap',()=>{const bytes=Uint8Array.from([0xe2,0x82,0xac,65]);assert.deepEqual(replayChunk(bytes,0,4,2).bytes,Uint8Array.from([0xac,65]));assert.equal(replayChunk(bytes,0,4,4).bytes.length,0);assert.equal(replayChunk(bytes,10,14,4).gap,true);assert.equal(replayChunk(bytes,10,14,4).after,14);assert.throws(()=>replayChunk(bytes,0,3,0),/Invalid terminal byte offsets/);});
import { terminalInputChunks } from '../src/terminal-output.js';
test('terminal paste preserves UTF-8 bytes while each base64 frame stays below the 32 KiB transport limit',()=>{const original=new TextEncoder().encode('α🙂'.repeat(10000));const chunks=terminalInputChunks(original);assert.ok(chunks.length>1);for(const chunk of chunks){assert.ok(chunk.length<=16384);assert.ok(JSON.stringify({type:'input',id:'00000000-0000-4000-8000-000000000001',data:toBase64(chunk)}).length<32768);}assert.deepEqual(Buffer.concat(chunks),Buffer.from(original));});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportCoverage } from '../src/ExportCoverage.js';

test('export review renders actual object paths and metadata as escaped text',()=>{
 const html=renderToStaticMarkup(createElement(ExportCoverage,{entries:[{path:'folder/report <final>.txt',kind:'file',size_bytes:1048576},{path:'empty',kind:'directory',size_bytes:0}]}));
 assert.match(html,/folder\/report &lt;final&gt;\.txt/);assert.match(html,/1,048,576/);assert.match(html,/>directory</);assert.doesNotMatch(html,/\[object Object\]|<final>/);
 assert.match(renderToStaticMarkup(createElement(ExportCoverage,{entries:[]})),/No paths included/);
});
