import { relativePath } from './path.js';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** STORE + data descriptors; bounded chunk memory, ZIP32 bounds checked before publication. */
export async function* streamZip(entries: ReadonlyArray<{path:string;size:number;chunks:()=>AsyncIterable<Uint8Array>}>,maxBytes:number):AsyncGenerator<Uint8Array>{
 if(entries.length>65535)throw new Error('zip_entry_limit');
 const central:Buffer[]=[],names=new Set<string>();let offset=0,centralSize=0;
 for(const e of entries){
  const path=relativePath(e.path),key=path.toLowerCase();if(names.has(key))throw new Error('duplicate_archive_path');names.add(key);
  const name=Buffer.from(path);if(name.length>65535||e.size>0xffffffff||e.size<0)throw new Error('zip32_limit');
  const start=offset,header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x808,6);header.writeUInt16LE(0x21,12);header.writeUInt16LE(name.length,26);
  offset+=30+name.length+e.size+16;centralSize+=46+name.length;
  if(offset+centralSize+22>maxBytes||offset>0xffffffff)throw new Error('export_quota_exceeded');
  yield header;yield name;let crc=0xffffffff,size=0;
  for await(const bytes of e.chunks()){size+=bytes.length;if(size>e.size)throw new Error('zip_size_mismatch');for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}yield bytes;}
  if(size!==e.size)throw new Error('zip_size_mismatch');crc=(crc^0xffffffff)>>>0;
  const descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(size,8);descriptor.writeUInt32LE(size,12);yield descriptor;
  const d=Buffer.alloc(46);d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt16LE(0x808,8);d.writeUInt16LE(0x21,14);d.writeUInt32LE(crc,16);d.writeUInt32LE(size,20);d.writeUInt32LE(size,24);d.writeUInt16LE(name.length,28);d.writeUInt32LE(start,42);central.push(d,name);
 }
 for(const part of central)yield part;
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);yield end;
}

/** Bounded ZIP32 STORE archive. Names are validated and links are never dereferenced. */
export function buildZip(entries: ReadonlyArray<{ path: string; bytes: Uint8Array }>, maxBytes = 64 * 1024 * 1024): Buffer {
  if (entries.length > 65535) throw new Error('zip_entry_limit');
  const local: Buffer[] = [], central: Buffer[] = [];
  const names = new Set<string>();
  let offset = 0, centralSize = 0;
  for (const entry of entries) {
    const path = relativePath(entry.path);
    const key = path.toLocaleLowerCase('en-US');
    if (names.has(key)) throw new Error('duplicate_archive_path');
    names.add(key);
    const name = Buffer.from(path, 'utf8');
    if (name.length > 65535 || entry.bytes.byteLength > 0xffffffff) throw new Error('zip32_limit');
    const bytes = Buffer.from(entry.bytes), crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(directory, name);
    offset += header.length + name.length + bytes.length; centralSize += directory.length + name.length;
    if (offset + centralSize + 22 > maxBytes || offset > 0xffffffff) throw Object.assign(new Error('export_quota_exceeded'), { code: 'export_quota_exceeded', statusCode: 413 });
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
