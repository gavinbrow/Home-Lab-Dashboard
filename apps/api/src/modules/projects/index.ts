import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Checkpoint, PolicyGrant, Workspace } from '@homelab/contracts';
import { BlobStore, RootedHostFileAdapter, relativePath, sha256, withWorkspaceWriter, captureCheckpoint, captureCheckpointFromAdapter, workspaceSnapshotMetadata, diffCheckpoints, snapshotManifestHash, planRestore, stageRestoreFiles, previewFile, releaseUndispatchedWriter, releaseKnownWriter, type WorkspaceSnapshot, type WorkspaceBinding } from '@homelab/storage';
import { submitJob } from '@homelab/worker';
import type { ApiContext } from '../../core/context.js';
import { registerAttachments } from './attachments.js';
import { registerRecovery } from './recovery.js';
import { registerTransfers } from './transfers.js';
import { registerRetention } from './retention.js';

function failure(code: string, message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { code, statusCode });
}
const Id = z.uuid();
const Query = z.object({ path: z.string().default(''), mode: z.enum(['list', 'read', 'search']).default('list'), grant_id: Id, limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().max(4096).optional(), include_hidden: z.enum(['true', 'false']).default('true').transform(value => value === 'true'), q: z.string().max(200).optional() });
const Write = z.object({ path: z.string(), content_base64: z.string().max(24 * 1024 * 1024), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), grant_id: Id, operation_id: Id.optional() });
function terminalReceipt(row: Record<string, unknown>) {
  if (row.error === 'operation_id_reused') return false;
  return row.state === 'completed' || row.state === 'succeeded' || (row.state === 'conflict' && row.effects_started === false) || (row.state === 'failed' && row.reason === 'operator_accepted_partial_outcome' && row.effects_started === true);
}

export default async function register(app: FastifyInstance, context: ApiContext): Promise<void> {
  const store = new BlobStore(context.config.artifactRoot, 64 * 1024 * 1024, { db: context.db });
  await registerAttachments(app, context, store);
  await registerRetention(app,context,store);
  async function workspace(owner: string, id: string): Promise<Workspace> {
    const result = await context.db.query("SELECT w.*,to_jsonb(m)->>'identity_generation' AS machine_identity_generation FROM workspaces w JOIN machines m ON m.id=w.machine_id WHERE w.id=$1 AND w.owner_id=$2", [Id.parse(id), owner]);
    if (!result.rows[0] || result.rows[0].state === 'unregistered') failure('not_found', 'Project not found', 404);
    return { ...result.rows[0], quota_bytes: Number(result.rows[0].quota_bytes) } as Workspace;
  }
  async function grant(owner: string, grantId: string, ws: Workspace, tool: string): Promise<PolicyGrant> {
    const result = await context.db.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2', [grantId, owner]);
    const row = result.rows[0];
    const current = row ? { ...row, expires_at: row.expires_at?.toISOString() ?? null, revoked_at: row.revoked_at?.toISOString() ?? null } as PolicyGrant : null;
    const decision = context.policy({ actor: { id: owner, role: 'owner' }, tool, machine_id: ws.machine_id, workspace_id: ws.id, grant: current, current_grant: current });
    if (!decision.allowed) {
      await context.audit(owner, tool, ws.id, 'denied', { reason: decision.reason });
      failure(decision.code, decision.reason, 403);
    }
    return current!;
  }
  function adapter(scopeGrantId?: string, scopeTool?: string) {
    if (!context.workspaceFiles) failure('capability_unavailable', 'No authenticated rooted host file adapter is configured for this deployment.', 503);
    if (scopeGrantId && context.agentBroker?.signer) return new RootedHostFileAdapter((machine, method, path, body, options) => context.agentBroker!.rpc(machine, method, path, body, { ...options, scopeGrantId, scopeTool }), 64 * 1024 * 1024, { writerFencing: true });
    return context.workspaceFiles;
  }
  await registerRecovery(app, context, store, adapter);
  async function checkpoint(owner: string, workspaceId: string, checkpointId: string): Promise<Checkpoint> {
    await workspace(owner, workspaceId);
    const row = (await context.db.query('SELECT * FROM checkpoints WHERE id=$1 AND workspace_id=$2', [Id.parse(checkpointId), workspaceId])).rows[0];
    if (!row) failure('not_found', 'Checkpoint not found.', 404);
    return row as Checkpoint;
  }
  async function saveCapture(ws: Workspace, reason: string, snapshot?: WorkspaceSnapshot, scopeGrantId?: string, scopeTool?: string): Promise<Checkpoint> {
    const existing = (await context.db.query('SELECT * FROM checkpoints WHERE workspace_id=$1 AND reason=$2 ORDER BY created_at ASC LIMIT 1', [ws.id, reason])).rows[0];
    if (existing) {
      if (existing.exclusions.length) failure('checkpoint_incomplete', 'Resolve excluded or unreadable paths before a protected mutation.', 409);
      return existing as Checkpoint;
    }
    const files = adapter(scopeGrantId, scopeTool);
    const source = snapshot ?? await workspaceSnapshotMetadata(files, ws);
    if (source.exclusions.length) failure('checkpoint_incomplete', 'Resolve excluded or unreadable paths before a protected mutation.', 409);
    const captured = source.files.every(file => file.entry.kind !== 'file' || file.bytes !== undefined) ? await captureCheckpoint(store, ws, source) : await captureCheckpointFromAdapter(store, ws, files);
    if (captured.exclusions.length || snapshotManifestHash(captured.manifest) !== snapshotManifestHash(source)) failure('checkpoint_incomplete', 'Project changed while protecting its bytes. Review the current version before mutation.', 409);
    await context.db.query('INSERT INTO checkpoints(id,workspace_id,manifest,manifest_hash,consistency,exclusions,reason) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7)', [captured.id, ws.id, JSON.stringify(captured.manifest), captured.manifest_hash, captured.consistency, JSON.stringify(captured.exclusions), reason]);
    return captured;
  }
  async function publishBinding(ws: Workspace, next: { state: Workspace['state']; revision: number; environment_id: string | null; environment_generation: number | null }, lockOwner: string) {
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ws.id]);
      if (!(await client.query('SELECT workspace_id FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2 FOR UPDATE', [ws.id, lockOwner])).rowCount) failure('writer_fenced', 'The writer reservation changed before metadata publication.', 409);
      await client.query('UPDATE workspaces SET state=$2,revision=$3,environment_id=$4,environment_generation=$5,updated_at=now() WHERE id=$1', [ws.id, next.state, next.revision, next.environment_id, next.environment_generation]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  await registerTransfers(app, context, { workspace, grant, adapter, capture: saveCapture });
  async function transitionBinding(ws: Workspace, state: Workspace['state'], operationId: string, lockOwner: string) {
    const files = adapter();
    if (!files.setBinding || !files.binding) failure('capability_unavailable', 'Host binding state transitions are not supported by this enrolled host.', 503);
    const prior = (await context.db.query('SELECT details FROM file_changes WHERE id=$1 AND workspace_id=$2 AND kind=$3', [operationId, ws.id, 'binding_intent'])).rows[0]?.details as { expected_revision: number; state: Workspace['state'] } | undefined;
    if (prior && prior.state !== state) failure('idempotency_conflict', 'Operation ID already names a different state transition.', 409);
    const expectedRevision = prior?.expected_revision ?? ws.revision;
    if (!prior) await context.db.query('INSERT INTO file_changes(id,workspace_id,path,kind,details) VALUES($1,$2,$3,$4,$5::jsonb)', [operationId, ws.id, '', 'binding_intent', JSON.stringify({ expected_revision: expectedRevision, state })]);
    const result = await files.setBinding({ ...ws, revision: expectedRevision }, state, { operation_id: operationId, lock_owner: lockOwner, guard_revision: ws.revision });
    const next = await files.binding(ws.machine_id, ws.id,ws.machine_identity_generation);
    if (next.state !== state || next.revision < expectedRevision || next.canonical_root !== ws.canonical_root || next.approved_root_id !== ws.approved_root_id) failure('host_binding_transition_unverified', 'Host binding state or storage identity does not match the requested transition.', 409);
    await publishBinding(ws, next, lockOwner);
    return { ...result, binding: next, files_preserved: true };
  }

  app.get('/project-roots', async request => {
    const query = z.object({ machine_id: Id }).parse(request.query);
    const machine = (await context.db.query("SELECT id,to_jsonb(m)->>'identity_generation' AS machine_identity_generation FROM machines m WHERE id=$1 AND owner_id=$2", [query.machine_id, request.actor!.id])).rows[0];
    if (!machine) failure('not_found', 'Machine not found.', 404);
    const files = adapter();
    if (!files.bindings) failure('capability_unavailable', 'Host root discovery is not supported by this adapter.', 503);
    return { items: await files.bindings(query.machine_id,machine.machine_identity_generation) };
  });

  app.get('/projects', async request => {
    const result = await context.db.query("SELECT * FROM workspaces WHERE owner_id=$1 AND state<>'unregistered' ORDER BY created_at DESC LIMIT 200", [request.actor!.id]);
    return { items: result.rows.map(row => ({ ...row, quota_bytes: Number(row.quota_bytes) })) };
  });
  app.get<{ Params: { id: string } }>('/projects/:id', request => workspace(request.actor!.id, request.params.id));
  app.get<{ Params: { id: string } }>('/projects/:id/binding', async request => {
    const ws = await workspace(request.actor!.id, request.params.id);
    const files = adapter();
    if (!files.binding) failure('capability_unavailable', 'Host workspace bindings are unavailable.', 503);
    return files.binding(ws.machine_id, ws.id,ws.machine_identity_generation);
  });
  app.get<{ Params: { id: string } }>('/projects/:id/writer', async request => {
    const owned = (await context.db.query('SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2', [Id.parse(request.params.id), request.actor!.id])).rowCount;
    if (!owned) failure('not_found', 'Project not found.', 404);
    const lock = (await context.db.query('SELECT workspace_id,job_id,lock_owner,state,rpc_id,created_at FROM workspace_locks WHERE workspace_id=$1', [request.params.id])).rows[0];
    return { lock: lock ? { ...lock, operation_id: lock.lock_owner?.split(':').at(-1) ?? null } : null };
  });
  app.post<{ Params: { id: string } }>('/projects/:id/writer/reconcile', async request => {
    const body = z.object({ operation_id: Id }).parse(request.body);
    const row = (await context.db.query("SELECT w.*,to_jsonb(m)->>'identity_generation' AS machine_identity_generation FROM workspaces w JOIN machines m ON m.id=w.machine_id WHERE w.id=$1 AND w.owner_id=$2", [Id.parse(request.params.id), request.actor!.id])).rows[0];
    if (!row) failure('not_found', 'Project not found.', 404);
    const ws = { ...row, quota_bytes: Number(row.quota_bytes) } as Workspace;
    const lock = (await context.db.query('SELECT * FROM workspace_locks WHERE workspace_id=$1', [ws.id])).rows[0];
    if (!lock) return { resolved: true, reason: 'no_writer_reservation' };
    if (lock.job_id) failure('job_reconciliation_required', 'Reconcile the job that owns this writer reservation.', 409);
    if (lock.lock_owner?.split(':').at(-1) !== body.operation_id || !lock.lock_owner?.includes(`:${request.actor!.id}:`)) failure('writer_operation_mismatch', 'Select the operation currently holding the writer reservation.', 409);
    let rpc = (await context.db.query('SELECT * FROM agent_rpc_requests WHERE id=$1 AND machine_id=$2', [lock.rpc_id ?? body.operation_id, ws.machine_id])).rows[0];
    if (!rpc) {
      const release = await releaseUndispatchedWriter(context.db, { workspace: ws, owner: request.actor!.id, lockOwner: lock.lock_owner, operationId: body.operation_id, writerFencing: adapter().writer_fencing === true });
      if (release.released) return { resolved: true, outcome: 'not_dispatched', verification: 'atomic_enqueue_fenced_before_durable_dispatch' };
      rpc = (await context.db.query('SELECT * FROM agent_rpc_requests WHERE id=$1 AND machine_id=$2', [release.rpc_id, ws.machine_id])).rows[0];
      if (!rpc) failure('host_outcome_unknown', 'Durable RPC metadata needs reconciliation.', 409);
    }
    let outcome = 'not_dispatched';
    let bindingEvidence: WorkspaceBinding | undefined;
    if (rpc) {
      let evidence = rpc.state === 'responded' && rpc.response_status >= 200 && rpc.response_status < 300 ? rpc.response_body as Record<string, unknown> : undefined;
      if (!evidence || !terminalReceipt(evidence)) {
        const files = adapter();
        if (files.rpcReceipt) {
          const cached = await files.rpcReceipt(ws.machine_id, rpc.id,ws.machine_identity_generation);
          if (cached.state === 'completed' && cached.status && cached.status >= 200 && cached.status < 300 && cached.body && typeof cached.body === 'object') evidence = cached.body as Record<string, unknown>;
          else if (files.operationReceipt) evidence = await files.operationReceipt(ws, body.operation_id);
          else failure('host_outcome_unknown', 'The original host RPC has no confirmed terminal response.', 409);
          if (!terminalReceipt(evidence) && files.operationReceipt) evidence = await files.operationReceipt(ws, body.operation_id);
        } else if (files.operationReceipt) evidence = await files.operationReceipt(ws, body.operation_id);
        else failure('host_outcome_unknown', 'The original host mutation still needs receipt reconciliation.', 409);
      }
      if (evidence.operation_id !== body.operation_id || !terminalReceipt(evidence)) failure('host_outcome_unknown', 'The host cannot yet prove completion, accepted partial effects, or a rejection before any effect.', 409);
      outcome = evidence.state === 'conflict' ? 'rejected_before_effects' : evidence.state === 'failed' ? 'accepted_partial' : 'completed';
      const files = adapter();
      if (files.binding) {
        const next = await files.binding(ws.machine_id, ws.id,ws.machine_identity_generation);
        if (next.canonical_root !== ws.canonical_root || next.approved_root_id !== ws.approved_root_id) failure('storage_binding_changed', 'Reconcile the host storage binding before releasing this reservation.', 409);
        bindingEvidence = next;
      }
    }
    await releaseKnownWriter(context.db, { workspace: ws, owner: request.actor!.id, lockOwner: lock.lock_owner, operationId: body.operation_id, rpcId: rpc.id, outcome: outcome as 'completed' | 'rejected_before_effects' | 'accepted_partial', binding: bindingEvidence });
    return { resolved: true, outcome, verification: 'host_receipt' };
  });
  app.post('/projects', async request => {
    const body = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(4000).default(''), machine_id: Id, host_workspace_id: Id }).parse(request.body);
    const owner = request.actor!.id;
    const machine=(await context.db.query("SELECT id,to_jsonb(m)->>'identity_generation' AS machine_identity_generation FROM machines m WHERE id=$1 AND owner_id=$2", [body.machine_id, owner])).rows[0]; if (!machine) failure('not_found', 'Machine not found.', 404);
    const files = adapter();
    if (!files.binding) failure('capability_unavailable', 'Host workspace binding is not configured.', 503);
    const binding = await files.binding(body.machine_id, body.host_workspace_id,machine.machine_identity_generation);
    if (binding.state !== 'active') failure('host_binding_inactive', 'Activate this configured host binding before registering it.', 409);
    const projectId = randomUUID();
    const ws: Workspace = { machine_identity_generation:machine.machine_identity_generation,id: body.host_workspace_id, owner_id: owner, project_id: projectId, name: body.name, type: binding.type, machine_id: body.machine_id, approved_root_id: binding.approved_root_id, canonical_root: binding.canonical_root, runtime_path: binding.runtime_path, revision: binding.revision, instruction_revision: 1, state: 'active', quota_bytes: binding.quota_bytes, environment_id: binding.environment_id, environment_generation: binding.environment_generation };
    const initial = await captureCheckpointFromAdapter(store, ws, files);
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
      if(!control||control.maintenance_mode||control.restore_mode)failure('maintenance_mode','Registration is unavailable during maintenance or restore.',409);
      const existing = await client.query('SELECT id FROM workspaces WHERE id=$1 OR (machine_id=$2 AND canonical_root=$3)', [ws.id, ws.machine_id, ws.canonical_root]);
      if (existing.rowCount) failure('workspace_already_registered', 'This host workspace is already registered.', 409);
      await client.query('INSERT INTO projects(id,owner_id,name,description) VALUES($1,$2,$3,$4)', [projectId, owner, body.name, body.description]);
      await client.query('INSERT INTO project_instruction_revisions(project_id,revision,instructions) VALUES($1,1,$2)', [projectId, '']);
      await client.query('INSERT INTO workspaces(id,owner_id,project_id,name,type,machine_id,approved_root_id,canonical_root,runtime_path,revision,quota_bytes,environment_id,environment_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [ws.id, owner, projectId, ws.name, ws.type, ws.machine_id, ws.approved_root_id, ws.canonical_root, ws.runtime_path, ws.revision, ws.quota_bytes, ws.environment_id, ws.environment_generation]);
      if (binding.environment_id && binding.environment_generation) await client.query('INSERT INTO environment_generations(id,workspace_id,machine_id,generation,runtime_id,image_digest,state,mount_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [binding.environment_id, ws.id, ws.machine_id, binding.environment_generation, binding.runtime_id ?? null, binding.image_digest ?? null, binding.runtime_id ? 'running' : 'configured', binding.runtime_path]);
      await client.query('INSERT INTO checkpoints(id,workspace_id,manifest,manifest_hash,consistency,exclusions,reason) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7)', [initial.id, ws.id, JSON.stringify(initial.manifest), initial.manifest_hash, initial.consistency, JSON.stringify(initial.exclusions), 'registration']);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await context.audit(owner, 'project.register', ws.id, 'completed', { machine_id: ws.machine_id, initial_checkpoint_id: initial.id, files_preserved: true });
    return ws;
  });
  app.get<{ Params: { id: string } }>('/projects/:id/files', async request => {
    const query = Query.parse(request.query);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, query.grant_id, ws, 'file.read');
    const path = relativePath(query.path, query.mode !== 'read');
    if (query.mode === 'list') {
      const files = adapter(query.grant_id, 'file.read');
      if (files.listPage) return files.listPage(ws, path, { limit: query.limit, cursor: query.cursor, include_hidden: query.include_hidden });
      if (query.cursor) failure('capability_unavailable', 'This host adapter does not support pagination.', 503);
      return { items: await files.list(ws, path), next_cursor: null };
    }
    if (query.mode === 'search') {
      const files = adapter(query.grant_id, 'file.read');
      if (!files.search) failure('capability_unavailable', 'This host adapter does not support file search.', 503);
      if (!query.q) failure('search_query_required', 'Enter a search term.');
      return files.search(ws, path, query.q);
    }
    const bytes = await adapter(query.grant_id, 'file.read').read(ws, path);
    if (bytes.byteLength > 16 * 1024 * 1024) failure('file_too_large', 'File exceeds the bounded file API limit.', 413);
    return { path, content_base64: Buffer.from(bytes).toString('base64'), sha256: sha256(bytes), size_bytes: bytes.byteLength };
  });
  app.put<{ Params: { id: string } }>('/projects/:id/files', { bodyLimit: 24 * 1024 * 1024 }, async request => {
    const body = Write.parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    if (ws.state !== 'active') failure('workspace_inactive', 'Archived projects cannot be modified.', 409);
    await grant(request.actor!.id, body.grant_id, ws, 'file.write');
    const files = adapter(body.grant_id, 'file.write');
    const path = relativePath(body.path);
    const bytes = Buffer.from(body.content_base64, 'base64');
    if (bytes.toString('base64') !== body.content_base64) failure('invalid_base64', 'Use canonical base64 content.');
    if (bytes.length > Math.min(ws.quota_bytes, 16 * 1024 * 1024)) failure('file_too_large', 'File exceeds upload quota.', 413);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'file.write', async mutation => {
      await grant(request.actor!.id, body.grant_id, ws, 'file.write');
      await saveCapture(ws, `before-write:${mutation.operation_id}`, undefined, body.grant_id, 'file.write');
      const result = await files.write(ws, path, bytes, body.expected_sha256, { operation_id: mutation.operation_id, lock_owner: mutation.lock_owner, scope_grant_id: body.grant_id });
      await context.audit(request.actor!.id, 'file.write', ws.id, 'completed', { path, sha256: result.sha256, size_bytes: result.size_bytes });
      return { path, ...result, operation_id: mutation.operation_id };
    }, { operationId: body.operation_id });
  });
  app.get<{ Params: { id: string } }>('/projects/:id/preview', async request => {
    const query = z.object({ path: z.string(), grant_id: Id }).parse(request.query);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, query.grant_id, ws, 'file.read');
    const path = relativePath(query.path);
    const bytes = await adapter(query.grant_id, 'file.read').read(ws, path);
    return { path, sha256: sha256(bytes), size_bytes: bytes.length, ...previewFile(bytes, path) };
  });
  app.get<{ Params: { id: string } }>('/projects/:id/files/download', async (request, reply) => {
    const query = z.object({ path: z.string(), grant_id: Id }).parse(request.query);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, query.grant_id, ws, 'file.read');
    const path = relativePath(query.path);
    const bytes = await adapter(query.grant_id, 'file.read').read(ws, path);
    reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1)!)}`).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.from(bytes));
  });
  app.get<{ Params: { id: string } }>('/projects/:id/instructions', async request => {
    const ws = await workspace(request.actor!.id, request.params.id);
    const result = (await context.db.query('SELECT instructions,instruction_revision FROM workspaces WHERE id=$1', [ws.id])).rows[0];
    return { instructions: result.instructions, revision: result.instruction_revision, source: 'project_configuration' };
  });
  app.put<{ Params: { id: string } }>('/projects/:id/instructions', async request => {
    const body = z.object({ instructions: z.string().max(128 * 1024), expected_revision: z.number().int().positive() }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'project.instructions', async mutation => {
      const client = await context.db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ws.id]);
        if (!(await client.query('SELECT workspace_id FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2 FOR UPDATE', [ws.id, mutation.lock_owner])).rowCount) failure('writer_fenced', 'Writer reservation changed before saving instructions.', 409);
        const changed = await client.query('UPDATE workspaces SET instructions=$2,instruction_revision=instruction_revision+1,updated_at=now() WHERE id=$1 AND instruction_revision=$3 RETURNING instruction_revision', [ws.id, body.instructions, body.expected_revision]);
        if (!changed.rowCount) failure('content_conflict', 'Project instructions changed. Reload and compare before saving.', 409);
        const revision = changed.rows[0].instruction_revision;
        await client.query('UPDATE projects SET instructions=$2,instruction_revision=$3 WHERE id=$1', [ws.project_id, body.instructions, revision]);
        await client.query('INSERT INTO project_instruction_revisions(project_id,revision,instructions) VALUES($1,$2,$3)', [ws.project_id, revision, body.instructions]);
        await client.query('COMMIT');
        await context.audit(request.actor!.id, 'project.instructions', ws.id, 'completed', { revision });
        return { instructions: body.instructions, revision, source: 'project_configuration' };
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    });
  });
  app.get<{ Params: { id: string } }>('/projects/:id/instructions/history', async request => {
    const ws = await workspace(request.actor!.id, request.params.id);
    return { items: (await context.db.query('SELECT revision,instructions,created_at FROM project_instruction_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 100', [ws.project_id])).rows };
  });
  app.get<{ Params: { id: string } }>('/projects/:id/checkpoints', async request => {
    const ws = await workspace(request.actor!.id, request.params.id);
    const result = await context.db.query('SELECT * FROM checkpoints WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [ws.id]);
    return { items: result.rows };
  });
  app.post<{ Params: { id: string } }>('/projects/:id/checkpoints', async request => {
    const body = z.object({ grant_id: Id }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'checkpoint.create');
    const files = adapter(body.grant_id, 'checkpoint.create');
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'checkpoint.create', async () => {
      await grant(request.actor!.id, body.grant_id, ws, 'checkpoint.create');
      const checkpoint = await captureCheckpointFromAdapter(store, ws, files);
      await context.db.query('INSERT INTO checkpoints(id,workspace_id,manifest,manifest_hash,consistency,exclusions) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb)', [checkpoint.id, ws.id, JSON.stringify(checkpoint.manifest), checkpoint.manifest_hash, checkpoint.consistency, JSON.stringify(checkpoint.exclusions)]);
      await context.audit(request.actor!.id, 'checkpoint.create', ws.id, 'completed', { checkpoint_id: checkpoint.id, consistency: checkpoint.consistency });
      return checkpoint;
    });
  });
  app.get<{ Params: { id: string; checkpointId: string } }>('/projects/:id/checkpoints/:checkpointId/diff', async request => {
    const ws = await workspace(request.actor!.id, request.params.id);
    const query = z.object({ against: Id }).parse(request.query);
    const rows = await context.db.query('SELECT * FROM checkpoints WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [ws.id, [Id.parse(request.params.checkpointId), query.against]]);
    const before = rows.rows.find(row => row.id === query.against) as Checkpoint | undefined;
    const after = rows.rows.find(row => row.id === request.params.checkpointId) as Checkpoint | undefined;
    if (!before || !after) failure('not_found', 'Checkpoint not found', 404);
    return { items: diffCheckpoints(before, after), before_checkpoint_id: before.id, after_checkpoint_id: after.id };
  });
  app.post<{ Params: { id: string } }>('/projects/:id/exports', async (request, reply) => {
    const body = z.object({ grant_id: Id, idempotency_key: z.string().min(1).max(200), expected_manifest_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), acknowledged_exclusions: z.array(z.string()).max(10000).default([]) }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    if (ws.state !== 'active') failure('workspace_inactive', 'Activate this project before requesting a new export.', 409);
    const captured = await grant(request.actor!.id, body.grant_id, ws, 'project.export');
    const job = await submitJob(context.db, { requester_id: request.actor!.id, idempotency_key: body.idempotency_key, context: null, workspace_id: ws.id, kind: 'project_export', payload: { machine_identity_generations:{[ws.machine_id]:ws.machine_identity_generation??null},workspace_id: ws.id, workspace_revision: ws.revision, grant: captured, expected_manifest_hash: body.expected_manifest_hash ?? null, acknowledged_exclusions: body.acknowledged_exclusions }, modifies_workspace: true });
    await context.audit(request.actor!.id, 'project.export', ws.id, 'queued', { job_id: job.id });
    return reply.code(202).send(job);
  });
  app.post<{ Params: { id: string } }>('/projects/:id/exports/preview', async request => {
    const body = z.object({ grant_id: Id }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'project.export');
    const source = await workspaceSnapshotMetadata(adapter(body.grant_id, 'project.export'), ws);
    return { expected_manifest_hash: snapshotManifestHash(source), consistency: source.consistency, exclusions: source.exclusions, included_paths: source.files.map(file => ({ path: file.entry.path, kind: file.entry.kind, size_bytes: file.entry.size_bytes })), estimated_source_bytes: source.files.reduce((sum, file) => sum + file.entry.size_bytes, 0) };
  });
  const RestoreReview = z.object({ checkpoint_id: Id, grant_id: Id, paths: z.array(z.string()).max(10000).nullable().default(null), delete_extras: z.boolean().default(false) });
  app.post<{ Params: { id: string } }>('/projects/:id/restore/preview', async request => {
    const body = RestoreReview.parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'checkpoint.restore');
    const target = await checkpoint(request.actor!.id, ws.id, body.checkpoint_id);
    const snapshot = await workspaceSnapshotMetadata(adapter(body.grant_id, 'checkpoint.restore'), ws);
    return { ...planRestore(target, snapshot, body.paths, body.delete_extras), consistency: snapshot.consistency, exclusions: snapshot.exclusions };
  });
  app.post<{ Params: { id: string } }>('/projects/:id/restore', async request => {
    const body = RestoreReview.extend({ operation_id: Id, expected_manifest_hash: z.string().regex(/^[a-f0-9]{64}$/), plan_hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'checkpoint.restore');
    const files = adapter(body.grant_id, 'checkpoint.restore');
    if (!files.restore) failure('capability_unavailable', 'The enrolled host does not support checkpoint restoration.', 503);
    const target = await checkpoint(request.actor!.id, ws.id, body.checkpoint_id);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'checkpoint.restore', async mutation => {
      await grant(request.actor!.id, body.grant_id, ws, 'checkpoint.restore');
      const requestHash = sha256(Buffer.from(JSON.stringify(body)));
      const intent = (await context.db.query('SELECT details FROM file_changes WHERE id=$1 AND workspace_id=$2 AND kind=$3', [mutation.operation_id, ws.id, 'restore_intent'])).rows[0]?.details as { request_hash: string; plan: ReturnType<typeof planRestore>; before_checkpoint_id: string } | undefined;
      if (intent && intent.request_hash !== requestHash) failure('idempotency_conflict', 'This operation ID already names a different restore request.', 409);
      let plan: ReturnType<typeof planRestore>;
      let before: Checkpoint;
      if (intent) {
        plan = intent.plan;
        before = await checkpoint(request.actor!.id, ws.id, intent.before_checkpoint_id);
      } else {
        const snapshot = await workspaceSnapshotMetadata(files, ws);
        plan = planRestore(target, snapshot, body.paths, body.delete_extras);
        if (plan.expected_manifest_hash !== body.expected_manifest_hash || plan.plan_hash !== body.plan_hash) failure('content_conflict', 'Project files or the restore plan changed. Review the new diff before applying.', 409);
        before = await saveCapture(ws, `before-restore:${mutation.operation_id}`, snapshot,body.grant_id,'checkpoint.restore');
        await context.db.query('INSERT INTO file_changes(id,workspace_id,path,kind,details) VALUES($1,$2,$3,$4,$5::jsonb)', [mutation.operation_id, ws.id, '', 'restore_intent', JSON.stringify({ request_hash: requestHash, plan, before_checkpoint_id: before.id })]);
      }
      const desired = await stageRestoreFiles(store, files, ws, target, before, plan, { operation_id: mutation.operation_id, scope_grant_id: body.grant_id });
      const result = await files.restore!(ws, { operation_id: mutation.operation_id, lock_owner: mutation.lock_owner, scope_grant_id: body.grant_id, expected_manifest_hash: plan.expected_manifest_hash, files: desired, delete_paths: plan.delete_paths });
      const after = await workspaceSnapshotMetadata(files, ws);
      const present = new Map(after.files.map(file => [file.entry.path, file.entry]));
      if (desired.some(file => { const got = present.get(file.entry.path); return !got || got.kind !== file.entry.kind || got.sha256 !== file.entry.sha256 || got.size_bytes !== file.entry.size_bytes || got.mode !== file.entry.mode; }) || plan.delete_paths.some(path => present.has(path) && !plan.write_paths.includes(path))) failure('restore_verification_failed', 'Host restore returned, but resulting file hashes or permissions require reconciliation.', 409);
      const captured = await saveCapture(ws, `after-restore:${mutation.operation_id}`, after,body.grant_id,'checkpoint.restore');
      await context.audit(request.actor!.id, 'checkpoint.restore', ws.id, 'completed', { operation_id: mutation.operation_id, checkpoint_id: target.id, before_checkpoint_id: before.id, after_checkpoint_id: captured.id, write_paths: plan.write_paths, delete_paths: plan.delete_paths });
      return { ...result, before_checkpoint_id: before.id, after_checkpoint_id: captured.id, plan };
    }, { operationId: body.operation_id });
  });
  app.delete<{ Params: { id: string } }>('/projects/:id/files', async request => {
    const body = z.object({ operation_id: Id, grant_id: Id, path: z.string(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'file.delete');
    const files = adapter();
    if (!files.quarantine) failure('capability_unavailable', 'Recoverable file deletion is not supported by this host.', 503);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'file.delete', async mutation => {
      await grant(request.actor!.id, body.grant_id, ws, 'file.delete');
      const before = await saveCapture(ws, `before-delete:${mutation.operation_id}`, undefined, body.grant_id, 'file.delete');
      const result = await files.quarantine!(ws, relativePath(body.path), body.expected_sha256, { operation_id: mutation.operation_id, lock_owner: mutation.lock_owner, scope_grant_id: body.grant_id });
      await context.audit(request.actor!.id, 'file.delete', ws.id, 'completed', { operation_id: mutation.operation_id, path: body.path, before_checkpoint_id: before.id, recoverable: true });
      return { ...result, before_checkpoint_id: before.id };
    }, { operationId: body.operation_id });
  });
  app.post<{ Params: { id: string; quarantineId: string } }>('/projects/:id/quarantine/:quarantineId/restore', async request => {
    const body = z.object({ operation_id: Id, grant_id: Id }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'file.restore');
    const files = adapter();
    if (!files.restoreQuarantine) failure('capability_unavailable', 'Quarantine recovery is not supported by this host.', 503);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'file.restore', async mutation => {
      await grant(request.actor!.id, body.grant_id, ws, 'file.restore');
      const before = await saveCapture(ws, `before-quarantine-restore:${mutation.operation_id}`, undefined, body.grant_id, 'file.restore');
      const result = await files.restoreQuarantine!(ws, request.params.quarantineId, { operation_id: mutation.operation_id, lock_owner: mutation.lock_owner, scope_grant_id: body.grant_id });
      await context.audit(request.actor!.id, 'file.restore', ws.id, 'completed', { operation_id: mutation.operation_id, before_checkpoint_id: before.id });
      return { ...result, before_checkpoint_id: before.id };
    }, { operationId: body.operation_id });
  });
  app.get<{ Params: { id: string } }>('/projects/:id/quarantine', async request => {
    const query = z.object({ grant_id: Id }).parse(request.query);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, query.grant_id, ws, 'file.restore');
    const files = adapter(query.grant_id, 'file.restore');
    if (!files.quarantineList) failure('capability_unavailable', 'This host does not support quarantine history.', 503);
    return { items: await files.quarantineList(ws) };
  });
  app.post<{ Params: { id: string } }>('/projects/:id/files/rename', async request => {
    const body = z.object({ operation_id: Id, grant_id: Id, source_path: z.string(), destination_path: z.string(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'file.write');
    const files = adapter();
    if (!files.rename) failure('capability_unavailable', 'The enrolled host does not support rooted file moves.', 503);
    const source = relativePath(body.source_path), destination = relativePath(body.destination_path);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'file.rename', async mutation => {
      await grant(request.actor!.id, body.grant_id, ws, 'file.write');
      const before = await saveCapture(ws, `before-rename:${mutation.operation_id}`, undefined, body.grant_id, 'file.write');
      const result = await files.rename!(ws, source, destination, body.expected_sha256, { operation_id: mutation.operation_id, lock_owner: mutation.lock_owner, scope_grant_id: body.grant_id });
      if (sha256(await files.read(ws, destination)) !== body.expected_sha256) failure('rename_verification_failed', 'Moved file content changed; reconcile the result before continuing.', 409);
      await context.audit(request.actor!.id, 'file.rename', ws.id, 'completed', { operation_id: mutation.operation_id, source_path: source, destination_path: destination, before_checkpoint_id: before.id });
      return { ...result, before_checkpoint_id: before.id };
    }, { operationId: body.operation_id });
  });
  app.post<{ Params: { id: string } }>('/projects/:id/directories', async request => {
    const body = z.object({ operation_id: Id, grant_id: Id, path: z.string() }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'file.write');
    const files = adapter();
    if (!files.mkdir) failure('capability_unavailable', 'The enrolled host does not support rooted directory creation.', 503);
    const path = relativePath(body.path);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'file.mkdir', async mutation => {
      await grant(request.actor!.id, body.grant_id, ws, 'file.write');
      const before = await saveCapture(ws, `before-mkdir:${mutation.operation_id}`, undefined, body.grant_id, 'file.write');
      const result = await files.mkdir!(ws, path, { operation_id: mutation.operation_id, lock_owner: mutation.lock_owner, scope_grant_id: body.grant_id });
      await context.audit(request.actor!.id, 'file.mkdir', ws.id, 'completed', { operation_id: mutation.operation_id, path, before_checkpoint_id: before.id });
      return { ...result, before_checkpoint_id: before.id };
    }, { operationId: body.operation_id });
  });
  app.get<{ Params: { id: string } }>('/projects/:id/artifacts', async request => {
    const ws = await workspace(request.actor!.id, request.params.id);
    const result = await context.db.query('SELECT * FROM artifacts WHERE workspace_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 100', [ws.id, request.actor!.id]);
    return { items: result.rows };
  });
  app.post<{ Params: { id: string } }>('/projects/:id/artifacts', async request => {
    const body = z.object({ path: z.string(), grant_id: Id, expected_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    await grant(request.actor!.id, body.grant_id, ws, 'artifact.retain');
    const path = relativePath(body.path);
    const files=adapter(body.grant_id,'artifact.retain');
    let blob:{hash:string;size:number};
    if(files.manifest&&files.readRange){
      const source=await files.manifest(ws),entry=source.manifest.find(e=>e.path===path);
      if(!entry||entry.kind!=='file'||entry.sha256!==body.expected_sha256)failure('content_conflict','Review the current regular file and hash before retaining it.',409);
      async function* chunks(){for(let offset=0;offset<entry!.size_bytes;){const part=await files.readRange!(ws,path,offset,Math.min(1048576,entry!.size_bytes-offset));if(part.offset!==offset||part.total_bytes!==entry!.size_bytes||!part.bytes.length||sha256(part.bytes)!==part.sha256)failure('content_conflict','The file changed during retention.',409);offset+=part.bytes.length;yield part.bytes;}}
      blob=await store.putStream(chunks(),body.expected_sha256,entry.size_bytes);
    }else{
      const bytes=await files.read(ws,path);if(sha256(bytes)!==body.expected_sha256)failure('content_conflict','The file changed before retention.',409);blob=await store.put(bytes,body.expected_sha256);
    }
    const id = randomUUID();
    const client=await context.db.connect();
    try{
      await client.query('BEGIN');const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
      if(!control||control.maintenance_mode||control.restore_mode)failure('maintenance_mode','Artifact publication is unavailable during maintenance or restore.',409);
      const raw=(await client.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2 FOR SHARE',[body.grant_id,request.actor!.id])).rows[0];
      const current=raw?{...raw,expires_at:raw.expires_at?.toISOString()??null,revoked_at:raw.revoked_at?.toISOString()??null} as PolicyGrant:null;
      const decision=context.policy({actor:request.actor!,tool:'artifact.retain',workspace_id:ws.id,machine_id:ws.machine_id,grant:current,current_grant:current});if(!decision.allowed)failure(decision.code,decision.reason,403);
      const inserted=await client.query('INSERT INTO artifacts(id,owner_id,workspace_id,relative_path,sha256,size_bytes,mime_type,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,request.actor!.id,ws.id,path,blob.hash,blob.size,'application/octet-stream',blob.hash]);
      await client.query('INSERT INTO audit_events(actor_id,action,target,outcome,details)VALUES($1,$2,$3,$4,$5::jsonb)',[request.actor!.id,'artifact.retain',ws.id,'completed',JSON.stringify({artifact_id:id,sha256:blob.hash})]);await client.query('COMMIT');return inserted.rows[0];
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
  app.get<{Params:{id:string}}>('/artifacts/:id/range',async request=>{
    const q=z.object({offset:z.coerce.number().int().min(0),length:z.coerce.number().int().min(1).max(1048576)}).parse(request.query);
    const row=(await context.db.query('SELECT * FROM artifacts WHERE id=$1 AND owner_id=$2',[Id.parse(request.params.id),request.actor!.id])).rows[0];if(!row)failure('not_found','Artifact not found.',404);
    const {bytes,...part}=await store.readRange(row.sha256,q.offset,q.length);if(part.total_bytes!==Number(row.size_bytes))failure('artifact_size_mismatch','Retained metadata does not match bytes.',409);
    return {...part,content_base64:bytes.toString('base64'),object_sha256:row.sha256};
  });
  app.get<{ Params: { id: string } }>('/artifacts/:id/download', async (request, reply) => {
    const result = await context.db.query('SELECT * FROM artifacts WHERE id=$1 AND owner_id=$2', [Id.parse(request.params.id), request.actor!.id]);
    const artifact = result.rows[0];
    if (!artifact) failure('not_found', 'Artifact not found', 404);
    const {stream,size}=await store.openRead(artifact.sha256);
    if(size!==Number(artifact.size_bytes)){stream.destroy();failure('artifact_size_mismatch','Retained artifact size does not match its metadata.',409);}
    reply.header('Content-Type', 'application/octet-stream').header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', `attachment; filename="artifact-${artifact.id}"`).header('Cache-Control', 'private, no-store');
    reply.header('Content-Length',size).header('ETag',`"${artifact.sha256}"`);
    return reply.send(stream);
  });
  app.post<{ Params: { id: string } }>('/projects/:id/archive', async request => {
    const body = z.object({ operation_id: Id.optional() }).parse(request.body ?? {});
    const ws = await workspace(request.actor!.id, request.params.id);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'project.archive', async mutation => {
      const result = await transitionBinding(ws, 'archived', mutation.operation_id, mutation.lock_owner);
      await context.audit(request.actor!.id, 'project.archive', ws.id, 'completed', { files_preserved: true });
      return { ...result, id: ws.id, state: 'archived' };
    }, { operationId: body.operation_id, allowedStates: ['active', 'archived'] });
  });
  app.post<{ Params: { id: string } }>('/projects/:id/unregister', async request => {
    const body = z.object({ operation_id: Id.optional() }).parse(request.body ?? {});
    const ws = await workspace(request.actor!.id, request.params.id);
    if (ws.type !== 'native') failure('invalid_lifecycle_action', 'Unregister applies to an existing host folder. Archive a managed project.', 409);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'project.unregister', async mutation => {
      const result = await transitionBinding(ws, 'unregistered', mutation.operation_id, mutation.lock_owner);
      await context.audit(request.actor!.id, 'project.unregister', ws.id, 'completed', { files_preserved: true });
      return { ...result, id: ws.id, state: 'unregistered' };
    }, { operationId: body.operation_id, allowedStates: ['active', 'archived'] });
  });
  app.post<{ Params: { id: string } }>('/projects/:id/reactivate', async request => {
    const body = z.object({ operation_id: Id }).parse(request.body);
    const row = (await context.db.query("SELECT w.*,to_jsonb(m)->>'identity_generation' AS machine_identity_generation FROM workspaces w JOIN machines m ON m.id=w.machine_id WHERE w.id=$1 AND w.owner_id=$2", [Id.parse(request.params.id), request.actor!.id])).rows[0];
    if (!row) failure('not_found', 'Project not found.', 404);
    const ws = { ...row, quota_bytes: Number(row.quota_bytes) } as Workspace;
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'project.reactivate', async mutation => {
      const result = await transitionBinding(ws, 'active', mutation.operation_id, mutation.lock_owner);
      await context.audit(request.actor!.id, 'project.reactivate', ws.id, 'completed', { files_preserved: true });
      return { ...result, id: ws.id, state: 'active' };
    }, { operationId: body.operation_id, allowedStates: ['active', 'archived', 'unregistered'] });
  });
  for (const action of ['restart', 'rebuild', 'remove']) {
    app.post<{ Params: { id: string } }>(`/projects/:id/environment/${action}`, async request => {
      const body = z.object({ operation_id: Id, grant_id: Id }).parse(request.body);
      const ws = await workspace(request.actor!.id, request.params.id);
      if (ws.type !== 'container') failure('environment_not_managed', 'This existing folder has no managed container environment.', 409);
      await grant(request.actor!.id, body.grant_id, ws, `environment.${action}`);
      const files = adapter(body.grant_id, `environment.${action}`);
      if (!files.lifecycle || !files.binding) failure('capability_unavailable', 'The enrolled host does not provide a managed environment broker.', 503);
      return withWorkspaceWriter(context.db, ws, request.actor!.id, `environment.${action}`, async mutation => {
        await grant(request.actor!.id, body.grant_id, ws, `environment.${action}`);
        const before = await saveCapture(ws, `before-environment:${mutation.operation_id}`, undefined, body.grant_id, `environment.${action}`);
        if (before.exclusions.length) failure('checkpoint_incomplete', 'Resolve checkpoint exclusions before replacing runtime resources.', 409);
        const intent = (await context.db.query('SELECT details FROM file_changes WHERE id=$1 AND workspace_id=$2 AND kind=$3', [mutation.operation_id, ws.id, 'environment_intent'])).rows[0]?.details as { action: string; binding: Awaited<ReturnType<NonNullable<typeof files.binding>>> } | undefined;
        if (intent && intent.action !== action) failure('idempotency_conflict', 'Operation ID already names another environment action.', 409);
        const oldBinding = intent?.binding ?? await files.binding!(ws.machine_id, ws.id, ws.machine_identity_generation);
        if (!intent) await context.db.query('INSERT INTO file_changes(id,workspace_id,path,kind,details) VALUES($1,$2,$3,$4,$5::jsonb)', [mutation.operation_id, ws.id, '', 'environment_intent', JSON.stringify({ action, binding: oldBinding })]);
        const result = await files.lifecycle!({ ...ws, revision: oldBinding.revision }, action as 'restart' | 'rebuild' | 'remove', { operation_id: mutation.operation_id, grant_id: body.grant_id, scope_grant_id: body.grant_id, lock_owner: mutation.lock_owner, guard_revision: ws.revision });
        const next = await files.binding!(ws.machine_id, ws.id, ws.machine_identity_generation);
        if (next.canonical_root !== ws.canonical_root || next.approved_root_id !== ws.approved_root_id) failure('storage_binding_changed', 'The host lifecycle operation changed the registered storage binding.', 409);
        const after = await workspaceSnapshotMetadata(files, ws);
        if (after.exclusions.length || snapshotManifestHash(after) !== snapshotManifestHash(before.manifest)) failure('storage_verification_failed', 'Project file hashes changed during the environment operation; reconciliation is required.', 409);
        if (action === 'rebuild' && (next.runtime_id === oldBinding.runtime_id || !next.runtime_id || (next.environment_generation ?? 0) <= (oldBinding.environment_generation ?? 0))) failure('environment_rebuild_unverified', 'Host replacement identity or generation did not change.', 409);
        if (action === 'restart' && (!next.runtime_id || next.runtime_id !== oldBinding.runtime_id)) failure('environment_restart_unverified', 'The restart did not preserve the runtime identity.', 409);
        if (action === 'remove' && next.runtime_id) failure('environment_remove_unverified', 'The host still reports an attached runtime.', 409);
        const client = await context.db.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ws.id]);
          if (!(await client.query('SELECT workspace_id FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2 FOR UPDATE', [ws.id, mutation.lock_owner])).rowCount) failure('writer_fenced', 'The writer reservation changed before environment metadata publication.', 409);
          if (next.environment_id && next.environment_generation) await client.query(`INSERT INTO environment_generations(id,workspace_id,machine_id,generation,runtime_id,image_digest,state,mount_path)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET runtime_id=EXCLUDED.runtime_id,state=EXCLUDED.state`, [next.environment_id, ws.id, ws.machine_id, next.environment_generation, next.runtime_id, next.image_digest, action === 'remove' ? 'removed' : 'running', next.runtime_path]);
          await client.query('UPDATE workspaces SET environment_id=$2,environment_generation=$3,revision=$4,updated_at=now() WHERE id=$1', [ws.id, next.environment_id, next.environment_generation, next.revision]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        await context.audit(request.actor!.id, `environment.${action}`, ws.id, 'completed', { operation_id: mutation.operation_id, before_checkpoint_id: before.id, files_preserved: true, runtime_id: next.runtime_id ?? null, generation: next.environment_generation });
        return { ...result, binding: next, files_preserved: true, before_checkpoint_id: before.id };
      }, { operationId: body.operation_id });
    });
  }
  app.delete<{ Params: { id: string } }>('/projects/:id/data', async request => {
    const body = z.object({ operation_id: Id, grant_id: Id, root_delete_grant_id: z.string().min(1).max(200), canonical_root: z.string().min(1).max(4096) }).parse(request.body);
    const ws = await workspace(request.actor!.id, request.params.id);
    if (body.canonical_root !== ws.canonical_root) failure('root_mismatch', 'Confirm the exact registered storage root.', 409);
    await grant(request.actor!.id, body.grant_id, ws, 'project.delete_data');
    const files = adapter();
    if (!files.deleteData) failure('capability_unavailable', 'Protected project data quarantine is not supported by this host.', 503);
    return withWorkspaceWriter(context.db, ws, request.actor!.id, 'project.delete_data', async mutation => {
      await grant(request.actor!.id, body.grant_id, ws, 'project.delete_data');
      const before = await saveCapture(ws, `before-data-delete:${mutation.operation_id}`, undefined, body.grant_id, 'project.delete_data');
      if (before.exclusions.length) failure('checkpoint_incomplete', 'Cannot protect all files before deletion; resolve checkpoint exclusions first.', 409);
      const result = await files.deleteData!(ws, { operation_id: mutation.operation_id, canonical_root: body.canonical_root, grant_id: body.root_delete_grant_id, scope_grant_id: body.grant_id, lock_owner: mutation.lock_owner });
      if (!files.binding) failure('host_binding_unavailable', 'Deletion completed but binding state needs reconciliation.', 409);
      const next = await files.binding(ws.machine_id, ws.id,ws.machine_identity_generation);
      if (next.state !== 'archived' || next.canonical_root !== ws.canonical_root) failure('host_binding_transition_unverified', 'Deleted data needs host binding reconciliation before archival.', 409);
      await publishBinding(ws, next, mutation.lock_owner);
      await context.audit(request.actor!.id, 'project.delete_data', ws.id, 'completed', { operation_id: mutation.operation_id, canonical_root: ws.canonical_root, before_checkpoint_id: before.id, recoverable: true });
      return { ...result, before_checkpoint_id: before.id, state: 'archived' };
    }, { operationId: body.operation_id, allowedStates: ['active', 'archived'] });
  });
}


