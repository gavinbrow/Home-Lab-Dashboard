import type { Checkpoint, CheckpointEntry, Workspace } from '@homelab/contracts';
import { randomUUID, createHash } from 'node:crypto';
import { BlobStore, sha256 } from './blobs.js';
import { relativePath } from './path.js';
import { streamZip } from './zip.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export type FileEntry = { path: string; kind: 'file' | 'directory' | 'symlink'; size_bytes: number; modified_at: string | null; sha256?: string };
export type SnapshotFile = { entry: CheckpointEntry; bytes?: Uint8Array; upload_id?: string };
export type WorkspaceSnapshot = { files: SnapshotFile[]; consistency: Checkpoint['consistency']; exclusions: string[] };
export type WorkspaceManifest = { manifest: CheckpointEntry[]; consistency: Checkpoint['consistency']; exclusions: string[] };
export type WorkspaceBinding = { workspace_id: string; approved_root_id: string; canonical_root: string; runtime_path: string; type: 'native' | 'container'; writable: boolean; quota_bytes: number; revision: number; state: 'active' | 'archived' | 'unregistered'; environment_id: string | null; environment_generation: number | null; image_digest?: string | null; runtime_id?: string | null; policy_revision?: number };
export type FileMutation = { operation_id: string; grant_id?: string; scope_grant_id?: string; scope_tool?: string; lock_owner?: string; guard_revision?: number; recovery_review?: {review_id:string;owner_id:string} };
export type HostMutationReceipt = { operation_id: string; state: string; [key: string]: unknown };
/** A host adapter must enforce confinement using OS rooted handles, compare-and-swap
 * writes under a host lock, quotas, and staged atomic publication. Never use API-local fs.
 */
export interface WorkspaceFileAdapter {
  readonly writer_fencing?: boolean;
  list(workspace: Workspace, path: string): Promise<FileEntry[]>;
  listPage?(workspace: Workspace, path: string, options: { limit: number; cursor?: string; include_hidden: boolean }): Promise<{ items: FileEntry[]; next_cursor: string | null }>;
  search?(workspace: Workspace, path: string, query: string): Promise<{ items: FileEntry[]; truncated: boolean; scanned: number }>;
  read(workspace: Workspace, path: string): Promise<Uint8Array>;
  write(workspace: Workspace, path: string, bytes: Uint8Array, expectedHash: string | null, mutation?: FileMutation): Promise<{ sha256: string; size_bytes: number }>;
  snapshot(workspace: Workspace): Promise<WorkspaceSnapshot>;
  manifest?(workspace: Workspace): Promise<WorkspaceManifest>;
  readRange?(workspace: Workspace, path: string, offset: number, length: number): Promise<{ bytes: Uint8Array; offset: number; total_bytes: number; sha256: string; modified_at: string | null }>;
  bindings?(machineId: string,expectedMachineGeneration?:string): Promise<WorkspaceBinding[]>;
  binding?(machineId: string, workspaceId: string,expectedMachineGeneration?:string): Promise<WorkspaceBinding>;
  restore?(workspace: Workspace, request: FileMutation & { expected_manifest_hash: string; files: SnapshotFile[]; delete_paths: string[] }): Promise<HostMutationReceipt>;
  quarantine?(workspace: Workspace, path: string, expectedHash: string, mutation: FileMutation): Promise<HostMutationReceipt>;
  restoreQuarantine?(workspace: Workspace, quarantineId: string, mutation: FileMutation): Promise<HostMutationReceipt>;
  deleteData?(workspace: Workspace, request: FileMutation & { canonical_root: string }): Promise<HostMutationReceipt>;
  lifecycle?(workspace: Workspace, action: 'restart' | 'rebuild' | 'remove', mutation: FileMutation): Promise<HostMutationReceipt>;
  setBinding?(workspace: Workspace, state: Workspace['state'], mutation: FileMutation): Promise<HostMutationReceipt>;
  rename?(workspace: Workspace, source: string, destination: string, expectedHash: string, mutation: FileMutation): Promise<HostMutationReceipt>;
  mkdir?(workspace: Workspace, path: string, mutation: FileMutation): Promise<HostMutationReceipt>;
  quarantineList?(workspace: Workspace): Promise<unknown[]>;
  operationReceipt?(workspace: Workspace, operationId: string): Promise<HostMutationReceipt>;
  rpcReceipt?(machineId: string, rpcId: string,expectedMachineGeneration?:string): Promise<{ id: string; state: string; status?: number; body?: unknown }>;
  resolvePartial?(workspace: Workspace, request: FileMutation & { original_operation_id: string; expected_manifest_hash: string; policy_revision: number; resolution: 'accept_partial'; reason: string }): Promise<HostMutationReceipt>;
  beginUpload?(workspace: Workspace, request: { upload_id: string; path: string; total_bytes: number; sha256: string; expected_sha256: string | null }, mutation: FileMutation): Promise<Record<string, unknown>>;
  uploadChunk?(workspace: Workspace, uploadId: string, request: { offset: number; bytes: Uint8Array; sha256: string }, mutation: FileMutation): Promise<Record<string, unknown>>;
  uploadStatus?(workspace: Workspace, uploadId: string): Promise<Record<string, unknown>>;
  completeUpload?(workspace: Workspace, uploadId: string, mutation: FileMutation): Promise<HostMutationReceipt>;
  cancelUpload?(workspace: Workspace, uploadId: string, mutation: FileMutation): Promise<Record<string, unknown>>;
}

export async function workspaceSnapshotMetadata(adapter: WorkspaceFileAdapter, workspace: Workspace): Promise<WorkspaceSnapshot> {
  if (adapter.manifest) {
    try { const source = await adapter.manifest(workspace); return { files: source.manifest.map(entry => ({ entry })), consistency: source.consistency, exclusions: source.exclusions }; }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
  }
  return adapter.snapshot(workspace);
}

/** Captures arbitrarily large permitted files without buffering their complete bytes. */
export async function captureCheckpointFromAdapter(store: BlobStore, workspace: Workspace, adapter: WorkspaceFileAdapter): Promise<Checkpoint> {
  if (!adapter.manifest || !adapter.readRange) return captureCheckpoint(store, workspace, await adapter.snapshot(workspace));
  let source: WorkspaceManifest;
  try { source = await adapter.manifest(workspace); }
  catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return captureCheckpoint(store, workspace, await adapter.snapshot(workspace)); throw error; }
  if (source.manifest.length > 100000) throw new Error('checkpoint_entry_limit');
  const seen = new Set<string>(); let total = 0;
  const manifest = source.manifest.map(entry => {
    relativePath(entry.path);
    if (seen.has(entry.path)) throw new Error('duplicate_checkpoint_path'); seen.add(entry.path);
    if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0) throw new Error('invalid_file_size');
    if (entry.kind === 'file') total += entry.size_bytes;
    return entry;
  });
  if (total > workspace.quota_bytes) throw new Error('checkpoint_quota_exceeded');
  for (const entry of manifest) {
    if (entry.kind !== 'file') continue;
    if (!entry.sha256) throw new Error('checkpoint_missing_hash');
    if (await store.hasSizedObject(entry.sha256, entry.size_bytes)) continue;
    async function* chunks() {
      for (let offset = 0; offset < entry.size_bytes;) {
        const part = await adapter.readRange!(workspace, entry.path, offset, Math.min(1024 * 1024, entry.size_bytes - offset));
        if (part.offset !== offset || part.total_bytes !== entry.size_bytes || part.bytes.length === 0 || sha256(part.bytes) !== part.sha256) throw new Error('host_checkpoint_range_changed');
        offset += part.bytes.length; yield part.bytes;
      }
    }
    await store.putStream(chunks(), entry.sha256, entry.size_bytes);
  }
  const after = await adapter.manifest(workspace);
  const changed = snapshotManifestHash(manifest) !== snapshotManifestHash(after.manifest);
  const exclusions = [...new Set([...source.exclusions, ...after.exclusions, ...(changed ? ['project_changed_during_capture'] : [])])].sort();
  manifest.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const envelope = Buffer.from(JSON.stringify({ schema_version: 1, manifest, consistency: source.consistency, exclusions }));
  const hash = sha256(envelope); await store.put(envelope, hash);
  return { id: randomUUID(), workspace_id: workspace.id, manifest, manifest_hash: hash, consistency: source.consistency, exclusions, created_at: new Date().toISOString() };
}

/** Cross-language host precondition; independent from retained checkpoint envelope hash. */
export function snapshotManifestHash(snapshot: WorkspaceSnapshot | CheckpointEntry[]): string {
  const entries = Array.isArray(snapshot) ? snapshot : snapshot.files.map(file => file.entry);
  const normalized = entries.map(entry => ({ path: relativePath(entry.path), kind: entry.kind, sha256: entry.kind === 'file' ? entry.sha256 : null, size_bytes: entry.kind === 'file' ? entry.size_bytes : 0, mode: entry.mode ?? 0 })).sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  return sha256(Buffer.from(canonical(normalized).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')));
}

export async function captureCheckpoint(store: BlobStore, workspace: Workspace, snapshot: WorkspaceSnapshot): Promise<Checkpoint> {
  if (snapshot.files.length > 100000) throw new Error('checkpoint_entry_limit');
  const manifest: CheckpointEntry[] = [], names = new Set<string>();
  let total = 0;
  for (const file of snapshot.files) {
    const path = relativePath(file.entry.path);
    const key = path.toLowerCase();
    if (names.has(key)) throw new Error('duplicate_checkpoint_path');
    names.add(key);
    if (!['file', 'directory', 'symlink'].includes(file.entry.kind)) throw new Error('invalid_checkpoint_kind');
    if (!Number.isSafeInteger(file.entry.size_bytes) || file.entry.size_bytes < 0) throw new Error('invalid_file_size');
    if (file.entry.kind === 'file') {
      if (!file.bytes || file.bytes.byteLength !== file.entry.size_bytes) throw new Error('snapshot_size_mismatch');
      total += file.bytes.byteLength;
      if (total > workspace.quota_bytes) throw Object.assign(new Error('Checkpoint exceeds the configured workspace quota; no project mutation was started.'), { code: 'checkpoint_quota_exceeded', statusCode: 413 });
      const blob = await store.put(file.bytes, file.entry.sha256 ?? undefined);
      manifest.push({ ...file.entry, path, sha256: blob.hash });
    } else {
      // Preserve a symlink as metadata only; no reads through a link, including internal ones.
      manifest.push({ ...file.entry, path, sha256: null, size_bytes: 0 });
    }
  }
  manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const exclusions = [...snapshot.exclusions].sort();
  const bytes = Buffer.from(JSON.stringify({ schema_version: 1, manifest, consistency: snapshot.consistency, exclusions }));
  const manifestHash = sha256(bytes);
  await store.put(bytes, manifestHash);
  return { id: randomUUID(), workspace_id: workspace.id, manifest, manifest_hash: manifestHash, consistency: snapshot.consistency, exclusions, created_at: new Date().toISOString() };
}

export async function exportCheckpoint(store: BlobStore, checkpoint: Checkpoint): Promise<{ hash: string; size: number }> {
  const metadata = JSON.parse((await store.get(checkpoint.manifest_hash)).toString('utf8')) as { manifest: CheckpointEntry[]; consistency: string; exclusions: string[] };
  if (canonical(metadata.manifest) !== canonical(checkpoint.manifest)
    || metadata.consistency !== checkpoint.consistency || JSON.stringify(metadata.exclusions) !== JSON.stringify([...checkpoint.exclusions].sort())) throw new Error('checkpoint_manifest_mismatch');
  const reserved = '.homelab-export-manifest.json';
  const entries: {path:string;size:number;chunks:()=>AsyncIterable<Uint8Array>}[]=[];
  for(const file of checkpoint.manifest){
    if(file.path.toLowerCase()===reserved)throw new Error('export_manifest_name_conflict');
    if(file.kind!=='file')continue;
    if(!file.sha256)throw new Error('checkpoint_missing_hash');
    entries.push({path:file.path,size:file.size_bytes,chunks:async function*(){
      const digest=createHash('sha256');
      for(let offset=0;offset<file.size_bytes;){const part=await store.readRange(file.sha256!,offset,Math.min(1048576,file.size_bytes-offset));if(part.total_bytes!==file.size_bytes||!part.bytes.length)throw new Error('checkpoint_size_mismatch');offset+=part.bytes.length;digest.update(part.bytes);yield part.bytes;}
      if(digest.digest('hex')!==file.sha256)throw new Error('blob_integrity_failure');
    }});
  }
  const metadataBytes=Buffer.from(JSON.stringify({schema_version:1,checkpoint_id:checkpoint.id,consistency:checkpoint.consistency,exclusions:checkpoint.exclusions,manifest:checkpoint.manifest,limitations:['Symlinks and directory permissions are metadata only.','This archive does not back up external services or NTFS ACLs.']},null,2));
  entries.push({path:reserved,size:metadataBytes.length,chunks:async function*(){yield metadataBytes;}});
  const digest=createHash('sha256');let size=0;
  for await(const chunk of streamZip(entries,store.maxStreamBytes)){digest.update(chunk);size+=chunk.length;}
  return store.putStream(streamZip(entries,store.maxStreamBytes),digest.digest('hex'),size);
}
