import { sha256 } from '@noble/hashes/sha2.js';
export const CHUNK_BYTES=1048576;
export const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export const chunkHash=(bytes:Uint8Array)=>hex(sha256(bytes));
export async function hashFile(file:Blob,signal?:AbortSignal,onProgress?:(bytes:number)=>void){const hash=sha256.create();for(let offset=0;offset<file.size;offset+=CHUNK_BYTES){signal?.throwIfAborted();hash.update(new Uint8Array(await file.slice(offset,offset+CHUNK_BYTES).arrayBuffer()));onProgress?.(Math.min(offset+CHUNK_BYTES,file.size));}return hex(hash.digest());}
