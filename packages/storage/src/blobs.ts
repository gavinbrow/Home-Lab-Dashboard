import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readFile, link, unlink } from 'node:fs/promises';
import type { Pool,PoolClient } from 'pg';
import { isAbsolute, join } from 'node:path';
import { assertHash } from './path.js';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function syncDirectory(path: string): Promise<void> {
  // The supported control-plane deployment is Linux. Windows directory flush
  // semantics require separate host-level durability verification.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** This directory MUST be a persistent, service-owned mount outside project roots.
 * This is not a rooted host workspace adapter. Project code must have no write access here.
 */
export class BlobStore {
  readonly db?: Pool;
  readonly maxStreamBytes: number;
  constructor(readonly root: string, readonly maxBlobBytes = 64 * 1024 * 1024, options: { db?: Pool; maxStreamBytes?: number } = {}) {
    if (!isAbsolute(root)) throw new Error('artifact_root_must_be_absolute');
    if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 1) throw new Error('invalid_blob_limit');
    this.db = options.db;
    this.maxStreamBytes = options.maxStreamBytes ?? 1024 * 1024 * 1024;
  }

  private async directory(hash: string): Promise<string> {
    assertHash(hash);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe_artifact_root');
    const dir = join(this.root, hash.slice(0, 2));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('unsafe_blob_directory');
    await syncDirectory(this.root);
    return dir;
  }

  async put(bytes: Uint8Array, expectedHash?: string,publicationClient?:PoolClient): Promise<{ hash: string; size: number }> {
    if (bytes.byteLength > this.maxBlobBytes) throw Object.assign(new Error('Immutable object exceeds the configured retained storage object limit.'), { code: 'blob_quota_exceeded', statusCode: 413 });
    bytes = Buffer.from(bytes);
    const hash = sha256(bytes);
    if (expectedHash !== undefined && assertHash(expectedHash) !== hash) throw new Error('checksum_mismatch');
    return this.putStream((async function* () { yield bytes; })(), hash, bytes.byteLength,publicationClient);
  }

  async putStream(chunks: AsyncIterable<Uint8Array>, expectedHash: string, expectedSize: number,publicationClient?:PoolClient): Promise<{ hash: string; size: number }> {
    const hash = assertHash(expectedHash);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > this.maxStreamBytes) throw Object.assign(new Error('Stream exceeds retained object limit.'), { code: 'blob_quota_exceeded', statusCode: 413 });
    const dir = await this.directory(hash), target = join(dir, hash), staging = join(dir, `.upload-${randomUUID()}`);
    const handle = await open(staging, 'wx', 0o600);
    const digest = createHash('sha256'); let size = 0;
    try {
      for await (const bytes of chunks) {
        size += bytes.byteLength;
        if (size > expectedSize || bytes.byteLength > this.maxStreamBytes) throw new Error('stream_size_mismatch');
        digest.update(bytes); await handle.writeFile(bytes);
      }
      if (size !== expectedSize || digest.digest('hex') !== hash) throw new Error('checksum_mismatch');
      await handle.sync();
    } catch (error) { await handle.close(); await unlink(staging).catch(() => undefined); throw error; }
    await handle.close();
    const client = publicationClient??(this.db ? await this.db.connect() : undefined);
    try {
      if (client) {
        if(!publicationClient)await client.query('BEGIN');
        const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
        if(!control||control.maintenance_mode||control.restore_mode)throw Object.assign(new Error('Retained publication is unavailable during maintenance or restore.'),{code:'maintenance_mode',statusCode:409});
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`homelab-blob:${hash}`]);
      }
      try { await link(staging, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await syncDirectory(dir);
      const actual = await this.inspect(hash);
      if (actual.size !== size || actual.sha256 !== hash) throw new Error('blob_integrity_failure');
      if (client) {
        const previous=(await client.query('SELECT quarantine_path FROM blob_objects WHERE hash=$1 FOR UPDATE',[hash])).rows[0]?.quarantine_path;
        if(previous) {
          if(!new RegExp(`^${hash}\\.[a-f0-9-]{36}$`).test(previous))throw new Error('unsafe_gc_path');
          const old=join(this.root,'.gc',previous);
          try {const st=await lstat(old);if(!st.isFile()||st.isSymbolicLink())throw new Error('unsafe_gc_target');await unlink(old);await syncDirectory(join(this.root,'.gc'));}
          catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        }
        await client.query("INSERT INTO blob_objects(hash,size_bytes,state) VALUES($1,$2,'live') ON CONFLICT(hash) DO UPDATE SET size_bytes=EXCLUDED.size_bytes,state='live',quarantined_at=NULL,quarantine_path=NULL,last_published_at=now()", [hash, size]);
        if(!publicationClient)await client.query('COMMIT');
      }
    } catch (error) { if (client&&!publicationClient) await client.query('ROLLBACK'); throw error; }
    finally { if(!publicationClient)client?.release(); await unlink(staging).catch(() => undefined); }
    return { hash, size };
  }

  async inspect(hash: string): Promise<{ size: number; sha256: string }> {
    const path = join(await this.directory(assertHash(hash)), hash);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxStreamBytes) throw new Error('unsafe_blob');
    const handle = await open(path, 'r'), digest = createHash('sha256');
    let offset = 0;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); if (!bytesRead) break; digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
    } finally { await handle.close(); }
    return { size: offset, sha256: digest.digest('hex') };
  }
  async hasSizedObject(hash: string, size: number): Promise<boolean> {
    try {
      const stat = await lstat(join(await this.directory(assertHash(hash)), hash));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size) return false;
      if(this.db){const client=await this.db.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('homelab-blob:'||$1,0))",[hash]);const live=await client.query("UPDATE blob_objects SET last_published_at=now() WHERE hash=$1 AND state='live' RETURNING hash",[hash]);await client.query('COMMIT');if(!live.rowCount)return false;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  async readRange(hash: string, offset: number, length: number): Promise<{ bytes: Buffer; offset: number; total_bytes: number; sha256: string }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) throw new Error('invalid_blob_range');
    const path = join(await this.directory(assertHash(hash)), hash), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxStreamBytes || offset > stat.size) throw new Error('unsafe_blob');
    const bytes = Buffer.alloc(Math.min(length, stat.size - offset)), handle = await open(path, 'r');
    try { let read = 0; while (read < bytes.length) { const result = await handle.read(bytes, read, bytes.length - read, offset + read); if (!result.bytesRead) throw new Error('blob_range_short_read'); read += result.bytesRead; } }
    finally { await handle.close(); }
    return { bytes, offset, total_bytes: stat.size, sha256: sha256(bytes) };
  }

  async get(hash: string): Promise<Buffer> {
    const dir = await this.directory(assertHash(hash));
    const path = join(dir, hash);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBlobBytes) throw new Error('unsafe_blob');
    const bytes = await readFile(path);
    if (sha256(bytes) !== hash) throw new Error('blob_integrity_failure');
    return bytes;
  }
  async openRead(hash:string) {
    const verified=await this.inspect(hash);if(verified.sha256!==hash)throw new Error('blob_integrity_failure');
    const handle=await open(join(await this.directory(hash),hash),'r');
    return {stream:handle.createReadStream({autoClose:true}),size:verified.size};
  }
}
