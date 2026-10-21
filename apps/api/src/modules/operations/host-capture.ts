import {createHash,randomUUID} from 'node:crypto';
import {open,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import type {RpcMethod} from '@homelab/transport';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const coverage=z.object({complete:z.boolean(),components:z.array(z.object({id:z.string(),kind:z.string().default('unknown'),role:z.string().optional(),workspace_id:z.uuid().optional(),consistency:z.string().optional(),state:z.string()}).passthrough()),exclusions:z.array(z.unknown())}).passthrough();
const status=z.object({id:z.uuid(),operation_id:z.uuid(),backup_set_id:z.uuid(),state:z.enum(['preparing','ready','failed','interrupted']),size_bytes:z.number().int().nonnegative().optional(),sha256:digest.optional(),chunk_size_bytes:z.number().int().positive().max(4*1024*1024).optional(),chunk_count:z.number().int().nonnegative().optional(),coverage:coverage.optional()}).passthrough();
type Rpc=(method:RpcMethod,path:string,body:unknown,scope:string,mutation:boolean)=>Promise<any>;
const unbox=(value:any)=>value?.result??value;
export type HostCapture={id:string;path:string;sha256:string;size_bytes:number;coverage:z.infer<typeof coverage>;ack:()=>Promise<void>};

/** The relay persists ciphertext only. The recipient is pinned by the host; no
 * private identity or replacement recipient is sent through the control plane. */
export async function captureHostBundle(options:{rpc:Rpc;operationId:string;backupSetId:string;target:string;signal:AbortSignal;check:()=>Promise<void>;cleanupCheck?:()=>Promise<void>;maxBytes?:number;pollMs?:number;maxWaitMs?:number}):Promise<HostCapture>{
 const {rpc,operationId,backupSetId,target,signal,check}=options;
 const policy=z.object({enabled:z.literal(true),grant_id:z.string().min(1).max(200),policy_revision:z.number().int().positive()}).passthrough().parse(unbox(await rpc('GET','/v1/host-state/policy',undefined,'policy',false)));
 let capture=status.parse(unbox(await rpc('POST','/v1/host-state/captures',{operation_id:operationId,backup_set_id:backupSetId,grant_id:policy.grant_id,policy_revision:policy.policy_revision},'create',true)));
 const id=capture.id;const route='/v1/host-state/captures/'+id;
 const validateIdentity=()=>{if(capture.id!==id||capture.operation_id!==operationId||capture.backup_set_id!==backupSetId)throw new Error('host_capture_identity_mismatch');};
 try{
  const deadline=Date.now()+(options.maxWaitMs??30*60*1000);
  while(capture.state==='preparing'){
   await check();validateIdentity();if(Date.now()>=deadline)throw new Error('host_capture_preparation_timeout');
   await delay(options.pollMs??1000,undefined,{signal});
   capture=status.parse(unbox(await rpc('GET',route,undefined,'status:'+randomUUID(),false)));
  }
  validateIdentity();
  if(capture.state!=='ready'||capture.size_bytes===undefined||!capture.sha256||!capture.chunk_size_bytes||capture.chunk_count===undefined||!capture.coverage)throw new Error('host_capture_not_ready');
  if(capture.size_bytes<1||capture.size_bytes>(options.maxBytes??64*1024**3)||capture.chunk_count!==Math.ceil(capture.size_bytes/capture.chunk_size_bytes))throw new Error('host_capture_size_invalid');
  const pending=target+'.pending-'+randomUUID(),file=await open(pending,'wx',0o600),whole=createHash('sha256');let offset=0;
  try{
   for(let index=0;index<capture.chunk_count;index++){
    await check();
    const chunk=z.object({id:z.uuid(),index:z.number().int().nonnegative(),offset:z.number().int().nonnegative(),size_bytes:z.number().int().nonnegative().max(4*1024*1024),sha256:digest,content_base64:z.string().max(6*1024*1024)}).passthrough().parse(unbox(await rpc('GET',route+'/chunks/'+index,undefined,'chunk:'+index,false)));
    const bytes=Buffer.from(chunk.content_base64,'base64');
    if(chunk.id!==id||chunk.index!==index||chunk.offset!==offset||chunk.size_bytes!==bytes.length||bytes.length!==Math.min(capture.chunk_size_bytes,capture.size_bytes-offset)||createHash('sha256').update(bytes).digest('hex')!==chunk.sha256)throw new Error('host_capture_chunk_integrity_failed');
    await file.writeFile(bytes);whole.update(bytes);offset+=bytes.length;
   }
   if(offset!==capture.size_bytes||whole.digest('hex')!==capture.sha256)throw new Error('host_capture_integrity_failed');
   await file.sync();
  }finally{await file.close();}
  await check();await rename(pending,target);
  if(process.platform!=='win32'){const directory=await open(dirname(target),'r');try{await directory.sync();}finally{await directory.close();}}
  return {id,path:target,sha256:capture.sha256,size_bytes:capture.size_bytes,coverage:capture.coverage,
   ack:async()=>{await check();await rpc('POST',route+'/ack',{sha256:capture.sha256},'ack',true);}};
 }catch(error){
  // Cancellation is limited to this exact staging capture. A failed lease cannot
  // obtain a fresh signed mutation; the host's bounded retention handles it.
  try{await(options.cleanupCheck??check)();await rpc('DELETE',route,undefined,'cancel',true);}catch{/* fail closed */}
  throw error;
 }
}
