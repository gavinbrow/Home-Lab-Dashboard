/** Replay offsets describe bytes, never UTF-16 string positions. */
export function replayChunk(bytes:Uint8Array,offset:number,next:number,after:number,truncated=false){
 if(![offset,next,after].every(n=>Number.isSafeInteger(n)&&n>=0)||next-offset!==bytes.length)throw new Error('Invalid terminal byte offsets');
 return {bytes:next>after?bytes.subarray(Math.max(0,after-offset)):new Uint8Array(),after:Math.max(after,next),gap:truncated||offset>after};
}
export function terminalInputChunks(bytes:Uint8Array):Uint8Array[]{const chunks:Uint8Array[]=[];for(let offset=0;offset<bytes.length;offset+=16384)chunks.push(bytes.slice(offset,offset+16384));return chunks;}
