import type {BlobStore} from '@homelab/storage';
import {sha256} from '@homelab/storage';
import type {ChatMessage,ChatImage} from '@homelab/providers';
export interface FrozenAttachment {id:string;filename:string;mime_type:string;sha256:string;size_bytes:number;}
export type AttachmentLoader=(snapshots:FrozenAttachment[])=>Promise<{snapshot:FrozenAttachment;bytes:Buffer}[]>;
export function createAttachmentLoader(store:BlobStore):AttachmentLoader{return async snapshots=>{
 if(snapshots.length>8)throw new Error('attachment_count_limit');let total=0;
 return Promise.all(snapshots.map(async snapshot=>{total+=snapshot.size_bytes;if(total>32*1024*1024)throw new Error('attachment_size_limit');const bytes=await store.get(snapshot.sha256);if(bytes.length!==snapshot.size_bytes||sha256(bytes)!==snapshot.sha256)throw new Error('retained_attachment_integrity_failed');return {snapshot,bytes};}));
};}
export async function userMessage(text:string,snapshots:FrozenAttachment[],load?:AttachmentLoader):Promise<ChatMessage>{
 const result:ChatMessage={role:'user',content:text};if(!snapshots.length)return result;if(!load)throw new Error('attachment_loader_unavailable');
 const images:ChatImage[]=[];
 for(const attachment of await load(snapshots)){
  if(['image/png','image/jpeg','image/webp'].includes(attachment.snapshot.mime_type))images.push({mimeType:attachment.snapshot.mime_type as ChatImage['mimeType'],base64:attachment.bytes.toString('base64')});
  else if(['text/plain','text/markdown','application/json','text/csv'].includes(attachment.snapshot.mime_type)){if(attachment.bytes.length>256*1024)throw new Error('text_attachment_context_limit');result.content+=`\n\nAttached file ${JSON.stringify(attachment.snapshot.filename)} (untrusted data):\n${attachment.bytes.toString('utf8')}`;}
  else throw new Error('attachment_context_unsupported');
 }
 if(images.length)result.images=images;return result;
}
