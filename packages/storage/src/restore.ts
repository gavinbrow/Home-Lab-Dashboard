import type { Checkpoint, CheckpointEntry } from '@homelab/contracts';
import { BlobStore, sha256 } from './blobs.js';
import { relativePath } from './path.js';
import { snapshotManifestHash, type SnapshotFile, type WorkspaceSnapshot, type WorkspaceFileAdapter, type FileMutation } from './workspace.js';
import type { Workspace } from '@homelab/contracts';

export type RestorePlan = { expected_manifest_hash: string; plan_hash: string; checkpoint_id: string; paths: string[] | null; delete_extras: boolean; write_paths: string[]; delete_paths: string[]; replace_paths: string[]; unchanged_paths: string[] };
export function planRestore(checkpoint: Checkpoint, current: WorkspaceSnapshot, paths: string[] | null, deleteExtras: boolean): RestorePlan {
  if (current.exclusions.length) throw Object.assign(new Error('Snapshot exclusions must be resolved before restoration.'), { code: 'restore_capture_incomplete', statusCode: 409 });
  if (checkpoint.exclusions.length && paths === null) throw Object.assign(new Error('Whole restore cannot use an incomplete checkpoint.'), { code: 'restore_checkpoint_incomplete', statusCode: 409 });
  const selected = paths === null ? null : [...new Set(paths.map(path => relativePath(path)))].sort();
  if (selected && !selected.length) throw Object.assign(new Error('Select at least one path.'), { code: 'restore_paths_required', statusCode: 400 });
  const includes = (path: string) => selected === null || selected.some(root => path === root || path.startsWith(`${root}/`));
  const target = new Map(checkpoint.manifest.filter(entry => includes(entry.path)).map(entry => [entry.path, entry]));
  const present = new Map(current.files.filter(file => includes(file.entry.path)).map(file => [file.entry.path, file.entry]));
  const allPresent = new Map(current.files.map(file => [file.entry.path, file.entry]));
  const allTarget = new Map(checkpoint.manifest.map(entry => [entry.path, entry]));
  for (const path of selected ?? []) if (![...target.keys(), ...present.keys()].some(entry => entry === path || entry.startsWith(`${path}/`))) throw Object.assign(new Error(`Selected path is absent: ${path}`), { code: 'restore_path_missing', statusCode: 409 });
  const unchanged: string[] = [], writes: string[] = [], replacements: string[] = [];
  for (const [path, desired] of target) {
    if (desired.kind === 'symlink') throw Object.assign(new Error('Symlink restoration requires a separately verified host capability.'), { code: 'restore_symlink_unsupported', statusCode: 409 });
    const existing = present.get(path);
    if (existing && existing.kind !== desired.kind) {
      if (!deleteExtras) throw Object.assign(new Error(`File type changed at ${path}; review restoration with deletion enabled to replace it.`), { code: 'restore_kind_conflict', statusCode: 409 });
      replacements.push(path);
    }
    if (existing && snapshotManifestHash([existing]) === snapshotManifestHash([desired])) unchanged.push(path);
    else writes.push(path);
  }
  // Selected nested files may require missing parent directories from the checkpoint.
  // Never replace an unselected file merely to create a parent directory.
  for (const path of [...writes]) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      const existing = allPresent.get(parent);
      if (existing?.kind === 'directory') continue;
      if (replacements.includes(parent) && target.get(parent)?.kind === 'directory') continue;
      if (existing || allTarget.get(parent)?.kind !== 'directory') throw Object.assign(new Error(`Parent directory conflicts at ${parent}.`), { code: 'restore_kind_conflict', statusCode: 409 });
      if (!writes.includes(parent)) writes.push(parent);
    }
  }
  const deletions = deleteExtras ? [...new Set([...present.keys()].filter(path => !target.has(path)).concat(replacements))] : [];
  const expectedHash = snapshotManifestHash(current);
  const data = { checkpoint_id: checkpoint.id, target_manifest_hash: checkpoint.manifest_hash, expected_manifest_hash: expectedHash, paths: selected, delete_extras: deleteExtras, write_paths: writes.sort(), delete_paths: deletions.sort(), replace_paths: replacements.sort(), unchanged_paths: unchanged.sort() };
  return { ...data, plan_hash: sha256(Buffer.from(JSON.stringify(data))) };
}

export async function restoreFiles(store: BlobStore, checkpoint: Checkpoint, plan: RestorePlan): Promise<SnapshotFile[]> {
  // Use the immutable manifest envelope as authority; JSONB key ordering is immaterial.
  const envelope = JSON.parse((await store.get(checkpoint.manifest_hash)).toString('utf8')) as { manifest: CheckpointEntry[] };
  if (snapshotManifestHash(envelope.manifest) !== snapshotManifestHash(checkpoint.manifest)) throw new Error('checkpoint_manifest_mismatch');
  let total = 0;
  const files: SnapshotFile[] = [];
  for (const path of plan.write_paths) {
    const entry = checkpoint.manifest.find(row => row.path === path);
    if (!entry) throw new Error('restore_plan_manifest_mismatch');
    if (entry.kind === 'directory') { files.push({ entry }); continue; }
    if (entry.kind !== 'file' || !entry.sha256) throw new Error('restore_file_kind_unsupported');
    total += entry.size_bytes;
    if (total > store.maxBlobBytes) throw new Error('restore_quota_exceeded');
    const bytes = await store.get(entry.sha256);
    if (bytes.length !== entry.size_bytes) throw new Error('restore_blob_size_mismatch');
    files.push({ entry, bytes });
  }
  return files;
}

function stageId(value: string): string { const h = sha256(Buffer.from(value)); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
/** Stage immutable bytes, then let one host batch perform manifest-CAS publication. */
export async function stageRestoreFiles(store: BlobStore, adapter: WorkspaceFileAdapter, workspace: Workspace, checkpoint: Checkpoint, before: Checkpoint, plan: RestorePlan, mutation: FileMutation): Promise<SnapshotFile[]> {
  if (!adapter.beginUpload || !adapter.uploadChunk) return restoreFiles(store, checkpoint, plan);
  const envelope = JSON.parse((await store.get(checkpoint.manifest_hash)).toString('utf8')) as { manifest: CheckpointEntry[] };
  if (snapshotManifestHash(envelope.manifest) !== snapshotManifestHash(checkpoint.manifest)) throw new Error('checkpoint_manifest_mismatch');
  const result: SnapshotFile[] = [];
  for (const path of plan.write_paths) {
    const entry = checkpoint.manifest.find(row => row.path === path);
    if (!entry) throw new Error('restore_plan_manifest_mismatch');
    if (entry.kind === 'directory') { result.push({ entry }); continue; }
    if (entry.kind !== 'file' || !entry.sha256) throw new Error('restore_file_kind_unsupported');
    const uploadId = stageId(`restore:${mutation.operation_id}:${path}`);
    const previous = before.manifest.find(row => row.path === path);
    // Staging cannot mutate project files, so it carries scope but no project writer guard.
    await adapter.beginUpload(workspace, { upload_id: uploadId, path, total_bytes: entry.size_bytes, sha256: entry.sha256, expected_sha256: previous?.kind === 'file' ? previous.sha256 : null }, { operation_id: uploadId, scope_grant_id: mutation.scope_grant_id, scope_tool: 'checkpoint.restore' });
    for (let offset = 0; offset < entry.size_bytes;) {
      const range = await store.readRange(entry.sha256, offset, Math.min(1024 * 1024, entry.size_bytes - offset));
      await adapter.uploadChunk(workspace, uploadId, { offset, bytes: range.bytes, sha256: range.sha256 }, { operation_id: stageId(`restore-chunk:${uploadId}:${offset}:${range.sha256}`), scope_grant_id: mutation.scope_grant_id, scope_tool: 'checkpoint.restore' });
      offset += range.bytes.length;
    }
    result.push({ entry, upload_id: uploadId });
  }
  return result;
}
