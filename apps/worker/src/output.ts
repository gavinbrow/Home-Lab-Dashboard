import {createHash} from 'node:crypto';import type {PoolClient} from 'pg';
import {assertOwnedLease} from './database.js';import {appendEventInTransaction} from './queue.js';import type {JobRow} from './types.js';
export function outputLimit(job:JobRow):number{return job.context?.limits.max_output_bytes??(job.payload.execution_context as {limits?:{max_output_bytes?:number}}|undefined)?.limits?.max_output_bytes??(job.payload.limits as {max_output_bytes?:number}|undefined)?.max_output_bytes??100*1024*1024;}
export function utf8Prefix(text:string,limit:number):string{const bytes=Buffer.from(text);if(bytes.length<=limit)return text;let end=Math.min(limit,bytes.length);for(let retry=0;retry<4;retry++,end--){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,Math.max(0,end)));}catch{}}return '';}
async function previous(client:PoolClient,jobId:string):Promise<{used:number;received:number;limited:number}>{
 const row=(await client.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='output.usage' ORDER BY sequence DESC LIMIT 1",[jobId])).rows[0]?.payload;
 if(row)return {used:row.cumulative_bytes,received:row.received_bytes,limited:row.limited_events};
 // Legacy attempts may already contain producer output. Bootstrap once rather
 // than treating a replacement worker as a fresh, empty budget.
 const events=(await client.query("SELECT type,payload FROM job_events WHERE job_id=$1 AND type IN ('assistant.delta','log','terminal.output','agent.tool.started','agent.tool.rejected') ORDER BY sequence",[jobId])).rows;
 let bytes=0;for(const event of events){if(event.type==='terminal.output')bytes+=Buffer.from(event.payload.data??'','base64').length;else if(event.type==='assistant.delta'||event.type==='log')bytes+=Buffer.byteLength(event.payload.text??event.payload.data??'');else if(event.payload.call)bytes+=Buffer.byteLength(JSON.stringify(event.payload.call));}return {used:bytes,received:bytes,limited:0};
}
export async function remainingOutput(client:PoolClient,job:JobRow):Promise<number>{await assertOwnedLease(client,job);return Math.max(0,outputLimit(job)-(await previous(client,job.id)).used);}
/** Atomic producer accounting. Call in the SAME transaction that publishes its
 * output/cursor. Replays keep the stable key and cannot spend the budget twice.
 * The cap bounds cumulative retained UTF-8 content, not upstream server spend.
 * Tool proposals are measured as their complete parsed JSON representation.
 */
export async function accountOutput(client:PoolClient,job:JobRow,key:string,kind:'model_text'|'tool_proposals'|'operation_log'|'terminal_transcript',text:string|Buffer,mode:'reject'|'truncate'){
 await assertOwnedLease(client,job);if(!key||key.length>300)throw new Error('output_chunk_id_invalid');const binary=Buffer.isBuffer(text),sourceBytes=Buffer.byteLength(text),hash=createHash('sha256').update(text).digest('hex');
 const duplicate=(await client.query("SELECT payload FROM job_events WHERE job_id=$1 AND type='output.usage' AND payload->>'key'=$2 LIMIT 1",[job.id,key])).rows[0]?.payload;
 if(duplicate){if(duplicate.source_hash!==hash||duplicate.source_bytes!==sourceBytes)throw new Error('output_chunk_idempotency_conflict');const bytes=binary?text.subarray(0,duplicate.accepted_bytes):Buffer.from(utf8Prefix(text as string,duplicate.accepted_bytes));return {duplicate:true,text:binary?'':bytes.toString('utf8'),bytes,limited:duplicate.limited,accepted_bytes:duplicate.accepted_bytes};}
 const prior=await previous(client,job.id),limit=outputLimit(job),remaining=Math.max(0,limit-prior.used),limited=sourceBytes>remaining;
 const accepted=limited?(mode==='truncate'?(binary?text.subarray(0,remaining):utf8Prefix(text as string,remaining)):''):text,acceptedBytes=Buffer.byteLength(accepted);
 await appendEventInTransaction(client,job.id,'output.usage',{key,kind,encoding:binary?'binary':'utf8',limit_bytes:limit,source_bytes:sourceBytes,source_hash:hash,accepted_bytes:acceptedBytes,cumulative_bytes:prior.used+acceptedBytes,received_bytes:prior.received+sourceBytes,limited,limited_events:prior.limited+(limited?1:0),scope:'retained_producer_content'});
 return {duplicate:false,text:binary?'':accepted as string,bytes:Buffer.from(accepted),limited,accepted_bytes:acceptedBytes};
}
