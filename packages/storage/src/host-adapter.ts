import type { CheckpointEntry, Workspace } from '@homelab/contracts';
import { randomUUID } from 'node:crypto';
import { assertHash, relativePath } from './path.js';
import { sha256 } from './blobs.js';
import type { FileEntry, WorkspaceFileAdapter, WorkspaceSnapshot, WorkspaceBinding, FileMutation, HostMutationReceipt, SnapshotFile, WorkspaceManifest } from './workspace.js';

/** Implement with the enrolled authenticated agent channel. Never accept transport destinations from a request. */
export type HostFileRpc = (machineId: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', route: string, body?: unknown, options?: { requestId?: string; timeoutMs?: number; expectedMachineGeneration?:string; recoveryRead?: boolean; recoveryResolution?: {review_id:string;owner_id:string}; scopeGrantId?: string; scopeTool?: string; workspaceGuard?: { workspace_id: string; lock_owner: string; workspace_revision: number } }) => Promise<unknown>;
function mutationBody(mutation: FileMutation) { return { operation_id: mutation.operation_id, ...(mutation.grant_id ? { grant_id: mutation.grant_id } : {}) }; }
function mutationOptions(ws: Workspace, mutation: FileMutation, tool?: string) { return { requestId: mutation.operation_id, ...(mutation.scope_grant_id ? { scopeGrantId: mutation.scope_grant_id, ...((mutation.scope_tool ?? tool) ? { scopeTool: mutation.scope_tool ?? tool } : {}) } : {}), ...(mutation.lock_owner ? { workspaceGuard: { workspace_id: ws.id, lock_owner: mutation.lock_owner, workspace_revision: mutation.guard_revision ?? ws.revision } } : {}) }; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_host_file_response');
  return value as Record<string, unknown>;
}
function size(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_host_file_size');
  return value;
}
function decode(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4) throw new Error('host_file_response_too_large');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > maxBytes || bytes.toString('base64') !== value) throw new Error('invalid_host_file_base64');
  return bytes;
}
function entry(value: unknown): CheckpointEntry {
  const row = object(value);
  const path = relativePath(String(row.path));
  if (row.kind !== 'file' && row.kind !== 'directory' && row.kind !== 'symlink') throw new Error('invalid_host_file_kind');
  const result: CheckpointEntry = { path, kind: row.kind, size_bytes: size(row.size_bytes), sha256: row.sha256 == null ? null : assertHash(String(row.sha256)) };
  if (row.mode !== undefined) result.mode = size(row.mode);
  if (row.link_target !== undefined) {
    if (typeof row.link_target !== 'string' || row.link_target.length > 4096) throw new Error('invalid_host_link_target');
    result.link_target = row.link_target;
  }
  return result;
}
function binding(value: unknown): WorkspaceBinding {
  const row = object(value);
  for (const field of ['workspace_id', 'approved_root_id', 'canonical_root', 'runtime_path']) if (typeof row[field] !== 'string' || !row[field] || /[\x00-\x1f]/.test(String(row[field]))) throw new Error('invalid_host_workspace_binding');
  if (row.type !== 'native' && row.type !== 'container') throw new Error('invalid_host_workspace_type');
  if (typeof row.writable !== 'boolean') throw new Error('invalid_host_workspace_access');
  if (size(row.revision ?? 1) < 1 || size(row.quota_bytes) < 1) throw new Error('invalid_host_workspace_limits');
  const state = row.state ?? 'active';
  if (state !== 'active' && state !== 'archived' && state !== 'unregistered') throw new Error('invalid_host_workspace_state');
  return { workspace_id: row.workspace_id as string, approved_root_id: row.approved_root_id as string, canonical_root: row.canonical_root as string, runtime_path: row.runtime_path as string, type: row.type, writable: row.writable, quota_bytes: size(row.quota_bytes), revision: size(row.revision ?? 1), state, environment_id: row.environment_id == null ? null : String(row.environment_id), environment_generation: row.environment_generation == null ? null : size(row.environment_generation), image_digest: row.image_digest == null ? null : String(row.image_digest), runtime_id: row.runtime_id == null ? null : String(row.runtime_id), ...(row.policy_revision === undefined ? {} : { policy_revision: size(row.policy_revision) }) };
}
function fileEntry(value: unknown): FileEntry {
  const row = entry(value), raw = object(value);
  return { path: row.path, kind: row.kind, size_bytes: row.size_bytes, modified_at: typeof raw.modified_at === 'string' ? raw.modified_at : null, ...(row.sha256 ? { sha256: row.sha256 } : {}) };
}
function receipt(value: unknown, operationId: string): HostMutationReceipt {
  const row = object(value);
  if (row.operation_id !== operationId) throw new Error('host_operation_identity_mismatch');
  if (row.state === 'conflict' && row.error === 'operation_id_reused') throw Object.assign(new Error('Operation ID already names a different host request.'), { code: 'idempotency_conflict', statusCode: 409 });
  if (row.state === 'conflict' && row.effects_started === false) throw Object.assign(new Error(String(row.reason ?? row.error ?? 'Host state changed before mutation.')), { code: 'content_conflict', statusCode: 409 });
  if (row.state === 'failed' && row.effects_started === false) throw Object.assign(new Error(String(row.reason ?? row.error ?? 'Host rejected this operation before project effects.')), {code:'content_conflict',statusCode:409});
  if (row.state !== 'completed' && row.state !== 'succeeded') throw Object.assign(new Error('Host mutation requires reconciliation.'), { code: 'host_outcome_unknown', statusCode: 409 });
  return row as HostMutationReceipt;
}

export class RootedHostFileAdapter implements WorkspaceFileAdapter {
  readonly writer_fencing: boolean;
  private readonly expectedMachineGeneration?:string;
  constructor(private readonly transport: HostFileRpc, private readonly maxBytes = 64 * 1024 * 1024, options: { writerFencing?: boolean;expectedMachineGeneration?:string } = {}) { this.writer_fencing = options.writerFencing === true;this.expectedMachineGeneration=options.expectedMachineGeneration; }
  private rpc(machine:string,method:Parameters<HostFileRpc>[1],path:string,body?:unknown,options?:Parameters<HostFileRpc>[4]){return this.transport(machine,method,path,body,{expectedMachineGeneration:this.expectedMachineGeneration,...options});}
  private request(ws:Workspace,method:Parameters<HostFileRpc>[1],path:string,body?:unknown,options?:Parameters<HostFileRpc>[4]){return this.rpc(ws.machine_id,method,path,body,{...options,expectedMachineGeneration:ws.machine_identity_generation??this.expectedMachineGeneration});}
  private base(ws: Workspace): string { return `/v1/workspaces/${encodeURIComponent(ws.id)}`; }
  async list(ws: Workspace, path: string): Promise<FileEntry[]> {
    relativePath(path, true);
    const result = await this.request(ws, 'GET', `${this.base(ws)}/files?mode=list&path=${encodeURIComponent(path || '.')}`);
    if (!Array.isArray(result) || result.length > 10000) throw new Error('host_directory_entry_limit');
    return result.map(fileEntry);
  }
  async listPage(ws: Workspace, path: string, options: { limit: number; cursor?: string; include_hidden: boolean }): Promise<{ items: FileEntry[]; next_cursor: string | null }> {
    relativePath(path, true);
    if (options.cursor) relativePath(options.cursor);
    const query = new URLSearchParams({ mode: 'page', path: path || '.', limit: String(options.limit), include_hidden: String(options.include_hidden), ...(options.cursor ? { cursor: options.cursor } : {}) });
    const response = object(await this.request(ws, 'GET', `${this.base(ws)}/files?${query}`));
    if (!Array.isArray(response.items) || response.items.length > options.limit) throw new Error('invalid_host_file_page');
    const cursor = response.next_cursor == null ? null : relativePath(String(response.next_cursor));
    return { items: response.items.map(fileEntry), next_cursor: cursor };
  }
  async search(ws: Workspace, path: string, query: string): Promise<{ items: FileEntry[]; truncated: boolean; scanned: number }> {
    relativePath(path, true);
    if (!query || query.length > 200) throw new Error('invalid_host_search_query');
    const params = new URLSearchParams({ mode: 'search', path: path || '.', q: query });
    const response = object(await this.request(ws, 'GET', `${this.base(ws)}/files?${params}`));
    if (!Array.isArray(response.items) || response.items.length > 100 || typeof response.truncated !== 'boolean') throw new Error('invalid_host_search_response');
    return { items: response.items.map(fileEntry), truncated: response.truncated, scanned: size(response.scanned) };
  }
  async read(ws: Workspace, path: string): Promise<Uint8Array> {
    relativePath(path);
    const result = object(await this.request(ws, 'GET', `${this.base(ws)}/files?mode=read&path=${encodeURIComponent(path)}`));
    const bytes = decode(result.content_base64, Math.min(this.maxBytes, ws.quota_bytes));
    if (bytes.byteLength !== size(result.size_bytes) || sha256(bytes) !== assertHash(String(result.sha256))) throw new Error('host_file_checksum_mismatch');
    return bytes;
  }
  async write(ws: Workspace, path: string, bytes: Uint8Array, expectedHash: string | null, mutation?: FileMutation): Promise<{ sha256: string; size_bytes: number }> {
    mutation ??= { operation_id: randomUUID() };
    relativePath(path);
    if (expectedHash !== null) assertHash(expectedHash);
    if (bytes.byteLength > Math.min(this.maxBytes, ws.quota_bytes)) throw new Error('host_upload_quota_exceeded');
    let response: unknown;
    try { response = await this.request(ws, 'PUT', `${this.base(ws)}/files`, { path, content_base64: Buffer.from(bytes).toString('base64'), expected_sha256: expectedHash, ...(mutation ? mutationBody(mutation) : {}) }, mutation ? mutationOptions(ws, mutation, 'file.write') : undefined); }
    catch (error) {
      const hostError = error as { code?: string; message?: string };
      if (hostError.code === 'file_conflict' || hostError.message === 'file_conflict') throw Object.assign(new Error('The file changed since it was read. Reload and compare before saving.'), { code: 'content_conflict', statusCode: 409 });
      throw error;
    }
    let result = object(response);
    if (result.state !== undefined) {
      const completed = receipt(response, mutation.operation_id);
      result = object(completed.result);
    }
    const hash = assertHash(String(result.sha256));
    if (hash !== sha256(bytes) || size(result.size_bytes) !== bytes.byteLength) throw new Error('host_write_result_unknown');
    return { sha256: hash, size_bytes: bytes.byteLength };
  }
  async snapshot(ws: Workspace): Promise<WorkspaceSnapshot> {
    const result = object(await this.request(ws, 'GET', `${this.base(ws)}/snapshot`));
    if (!Array.isArray(result.files) || result.files.length > 100000 || !Array.isArray(result.exclusions) || !result.exclusions.every(x => typeof x === 'string')) throw new Error('invalid_host_snapshot');
    if (result.consistency !== 'consistent' && result.consistency !== 'best_effort') throw new Error('invalid_host_snapshot_consistency');
    let remaining = Math.min(this.maxBytes, ws.quota_bytes);
    const files = result.files.map(value => {
      const row = object(value), metadata = entry(row.entry);
      if (metadata.kind !== 'file') return { entry: metadata };
      const bytes = decode(metadata.size_bytes === 0 && row.bytes === undefined ? '' : row.bytes, remaining);
      remaining -= bytes.byteLength;
      if (bytes.length !== metadata.size_bytes || sha256(bytes) !== metadata.sha256) throw new Error('host_snapshot_checksum_mismatch');
      return { entry: metadata, bytes };
    });
    return { files, consistency: result.consistency, exclusions: result.exclusions as string[] };
  }
  async bindings(machineId: string,generation?:string): Promise<WorkspaceBinding[]> {
    const response = await this.rpc(machineId, 'GET', '/v1/workspaces',undefined,{expectedMachineGeneration:generation??this.expectedMachineGeneration});
    const rows = Array.isArray(response) ? response : object(response).bindings ?? object(response).items;
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('invalid_host_workspace_bindings');
    return rows.map(binding);
  }
  async manifest(ws: Workspace): Promise<WorkspaceManifest> {
    const row = object(await this.request(ws, 'GET', `${this.base(ws)}/manifest`,null,{recoveryRead:true}));
    if (!Array.isArray(row.manifest) || row.manifest.length > 100000 || !Array.isArray(row.exclusions) || !row.exclusions.every(value => typeof value === 'string') || (row.consistency !== 'best_effort' && row.consistency !== 'consistent')) throw new Error('invalid_host_manifest');
    return { manifest: row.manifest.map(entry), consistency: row.consistency, exclusions: row.exclusions as string[] };
  }
  async readRange(ws: Workspace, path: string, offset: number, length: number) {
    relativePath(path);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) throw new Error('invalid_file_range');
    const query = new URLSearchParams({ mode: 'read_range', path, offset: String(offset), length: String(length) });
    const row = object(await this.request(ws, 'GET', `${this.base(ws)}/files?${query}`));
    const bytes = decode(row.content_base64, length);
    if (size(row.offset) !== offset || sha256(bytes) !== row.sha256) throw new Error('host_range_checksum_mismatch');
    return { bytes, offset, total_bytes: size(row.total_bytes), sha256: String(row.sha256), modified_at: typeof row.modified_at === 'string' ? row.modified_at : null };
  }
  async binding(machineId: string, workspaceId: string, generation?:string): Promise<WorkspaceBinding> {
    const result = binding(await this.rpc(machineId, 'GET', `/v1/workspaces/${encodeURIComponent(workspaceId)}/binding`, null, { recoveryRead: true,expectedMachineGeneration:generation??this.expectedMachineGeneration }));
    if (result.workspace_id !== workspaceId) throw new Error('host_workspace_identity_mismatch');
    return result;
  }
  async restore(ws: Workspace, request: FileMutation & { expected_manifest_hash: string; files: SnapshotFile[]; delete_paths: string[] }): Promise<HostMutationReceipt> {
    const streamed = request.files.some(file => file.upload_id !== undefined);
    const body = { operation_id: request.operation_id, expected_manifest_hash: request.expected_manifest_hash, delete_paths: request.delete_paths, files: request.files.map(file => ({ entry: file.entry, ...(file.upload_id ? { upload_id: file.upload_id } : file.bytes ? { bytes: Buffer.from(file.bytes).toString('base64') } : {}) })) };
    return receipt(await this.request(ws, 'POST', `${this.base(ws)}/${streamed ? 'restore-stream' : 'restore'}`, body, mutationOptions(ws, request, 'checkpoint.restore')), request.operation_id);
  }
  async quarantine(ws: Workspace, path: string, expectedHash: string, mutation: FileMutation): Promise<HostMutationReceipt> {
    return receipt(await this.request(ws, 'DELETE', `${this.base(ws)}/files`, { ...mutationBody(mutation), path: relativePath(path), expected_sha256: assertHash(expectedHash) }, mutationOptions(ws, mutation, 'file.delete')), mutation.operation_id);
  }
  async restoreQuarantine(ws: Workspace, quarantineId: string, mutation: FileMutation): Promise<HostMutationReceipt> {
    return receipt(await this.request(ws, 'POST', `${this.base(ws)}/quarantine/${encodeURIComponent(quarantineId)}/restore`, mutationBody(mutation), mutationOptions(ws, mutation, 'file.restore')), mutation.operation_id);
  }
  async deleteData(ws: Workspace, request: FileMutation & { canonical_root: string }): Promise<HostMutationReceipt> {
    if (request.canonical_root !== ws.canonical_root) throw Object.assign(new Error('Deletion root does not match registered storage.'), { code: 'root_mismatch', statusCode: 409 });
    return receipt(await this.request(ws, 'DELETE', `${this.base(ws)}/data`, { ...mutationBody(request), canonical_root: request.canonical_root }, mutationOptions(ws, request, 'project.delete_data')), request.operation_id);
  }
  async lifecycle(ws: Workspace, action: 'restart' | 'rebuild' | 'remove', mutation: FileMutation): Promise<HostMutationReceipt> {
    return receipt(await this.request(ws, 'POST', `${this.base(ws)}/environment/${action}`, { ...mutationBody(mutation), expected_revision: ws.revision }, mutationOptions(ws, mutation, `environment.${action}`)), mutation.operation_id);
  }
  async setBinding(ws: Workspace, state: Workspace['state'], mutation: FileMutation): Promise<HostMutationReceipt> {
    return receipt(await this.request(ws, 'PUT', `${this.base(ws)}/binding`, { ...mutationBody(mutation), expected_revision: ws.revision, state }, mutationOptions(ws, mutation)), mutation.operation_id);
  }
  async rename(ws: Workspace, source: string, destination: string, expectedHash: string, mutation: FileMutation): Promise<HostMutationReceipt> {
    return receipt(await this.request(ws, 'POST', `${this.base(ws)}/files/rename`, { ...mutationBody(mutation), source_path: relativePath(source), destination_path: relativePath(destination), expected_sha256: assertHash(expectedHash) }, mutationOptions(ws, mutation, 'file.write')), mutation.operation_id);
  }
  async mkdir(ws: Workspace, path: string, mutation: FileMutation): Promise<HostMutationReceipt> {
    return receipt(await this.request(ws, 'POST', `${this.base(ws)}/directories`, { ...mutationBody(mutation), path: relativePath(path) }, mutationOptions(ws, mutation, 'file.write')), mutation.operation_id);
  }
  async quarantineList(ws: Workspace): Promise<unknown[]> {
    const response = object(await this.request(ws, 'GET', `${this.base(ws)}/quarantine`));
    if (!Array.isArray(response.items) || response.items.length > 10000) throw new Error('invalid_host_quarantine_list');
    return response.items;
  }
  async operationReceipt(ws: Workspace, operationId: string): Promise<HostMutationReceipt> {
    const row = object(await this.request(ws, 'GET', `${this.base(ws)}/file-operations/${encodeURIComponent(operationId)}`,null,{recoveryRead:true}));
    if (row.operation_id !== operationId || typeof row.state !== 'string') throw new Error('host_operation_identity_mismatch');
    return row as HostMutationReceipt;
  }
  async rpcReceipt(machineId: string, rpcId: string, generation?:string): Promise<{ id: string; state: string; status?: number; body?: unknown }> {
    const row = object(await this.rpc(machineId, 'GET', `/v1/rpc-receipts/${encodeURIComponent(rpcId)}`, null, { recoveryRead: true,expectedMachineGeneration:generation??this.expectedMachineGeneration }));
    if (row.id !== rpcId || typeof row.state !== 'string') throw new Error('host_rpc_receipt_identity_mismatch');
    return row as { id: string; state: string; status?: number; body?: unknown };
  }
  async resolvePartial(ws: Workspace, request: FileMutation & { original_operation_id: string; expected_manifest_hash: string; policy_revision: number; resolution: 'accept_partial'; reason: string }): Promise<HostMutationReceipt> {
    if (!request.grant_id) throw new Error('host_recovery_grant_required');
    const body = { expected_manifest_hash: assertHash(request.expected_manifest_hash), grant_id: request.grant_id, policy_revision: request.policy_revision, resolution: request.resolution, reason: request.reason, resolution_id: request.operation_id };
    const row = object(await this.request(ws, 'POST', `${this.base(ws)}/file-operations/${encodeURIComponent(request.original_operation_id)}/reconcile`, body, {...mutationOptions(ws, request, 'workspace.reconcile'),recoveryResolution:request.recovery_review}));
    if (row.operation_id !== request.original_operation_id || row.state !== 'failed' || row.reason !== 'operator_accepted_partial_outcome') throw Object.assign(new Error('Partial effects have not been confirmed as an accepted terminal outcome.'), { code: 'host_outcome_unknown', statusCode: 409 });
    return row as HostMutationReceipt;
  }
  async beginUpload(ws: Workspace, request: { upload_id: string; path: string; total_bytes: number; sha256: string; expected_sha256: string | null }, mutation: FileMutation): Promise<Record<string, unknown>> {
    relativePath(request.path); assertHash(request.sha256); if (request.expected_sha256 !== null) assertHash(request.expected_sha256);
    return object(await this.request(ws, 'POST', `${this.base(ws)}/uploads`, request, mutationOptions(ws, mutation, 'file.write')));
  }
  async uploadChunk(ws: Workspace, uploadId: string, request: { offset: number; bytes: Uint8Array; sha256: string }, mutation: FileMutation): Promise<Record<string, unknown>> {
    if (request.bytes.byteLength > 1024 * 1024 || sha256(request.bytes) !== assertHash(request.sha256)) throw new Error('upload_chunk_checksum_mismatch');
    return object(await this.request(ws, 'PUT', `${this.base(ws)}/uploads/${encodeURIComponent(uploadId)}/chunks`, { offset: request.offset, content_base64: Buffer.from(request.bytes).toString('base64'), sha256: request.sha256 }, mutationOptions(ws, mutation, 'file.write')));
  }
  async uploadStatus(ws: Workspace, uploadId: string): Promise<Record<string, unknown>> {
    return object(await this.request(ws, 'GET', `${this.base(ws)}/uploads/${encodeURIComponent(uploadId)}`));
  }
  async completeUpload(ws: Workspace, uploadId: string, mutation: FileMutation): Promise<HostMutationReceipt> {
    return receipt(await this.request(ws, 'POST', `${this.base(ws)}/uploads/${encodeURIComponent(uploadId)}/complete`, { operation_id: mutation.operation_id }, mutationOptions(ws, mutation, 'file.write')), mutation.operation_id);
  }
  async cancelUpload(ws: Workspace, uploadId: string, mutation: FileMutation): Promise<Record<string, unknown>> {
    return object(await this.request(ws, 'DELETE', `${this.base(ws)}/uploads/${encodeURIComponent(uploadId)}`, { operation_id: mutation.operation_id }, mutationOptions(ws, mutation)));
  }
}

