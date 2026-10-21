import { deflateSync } from 'node:zlib';
import { ProviderError, type ChatImage } from './types.js';
export function validateImages(images: ChatImage[] = []): ChatImage[] {
  if (images.length > 8) throw new ProviderError('invalid-config', 'At most eight images are permitted per message');
  let total = 0;
  for (const image of images) {
    if (!['image/png','image/jpeg','image/webp'].includes(image.mimeType) || typeof image.base64 !== 'string' || image.base64.length>Math.ceil(8*1024*1024/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) throw new ProviderError('invalid-config', 'Image requires a supported MIME type and canonical bounded base64 bytes');
    const bytes = Buffer.from(image.base64,'base64'); total += bytes.length;
    const valid = image.mimeType === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
    if (!valid || !bytes.length || bytes.length > 8*1024*1024 || total > 16*1024*1024) throw new ProviderError('invalid-config', 'Image bytes do not match their MIME type or exceed the byte limit');
  }
  return images;
}
function crc(bytes: Buffer): number { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i=0;i<8;i++) value = (value>>>1) ^ ((value&1) ? 0xedb88320 : 0); } return (value^0xffffffff)>>>0; }
function chunk(type: string, bytes: Buffer): Buffer {
  const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([name,bytes]))); return Buffer.concat([length,name,bytes,sum]);
}
/** Generated entirely in-process; no filesystem or external URL is sent to inference. */
export function colorProbeImage(color: 'red' | 'blue'): ChatImage {
  const size = 64; const header = Buffer.alloc(13); header.writeUInt32BE(size,0); header.writeUInt32BE(size,4); header[8]=8; header[9]=2;
  const pixels = Buffer.alloc((1+size*3)*size);
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) pixels[y*(1+size*3)+1+x*3+(color==='red'?0:2)] = 255;
  return { mimeType:'image/png',base64:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64') };
}
