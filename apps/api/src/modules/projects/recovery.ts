import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PolicyGrant, Workspace } from '@homelab/contracts';
import { canonicalJson, rpcDigest } from '@homelab/transport';
import { BlobStore, snapshotManifestHash, workspaceSnapshotMetadata, sha256, releaseKnownWriter, type WorkspaceFileAdapter } from '@homelab/storage';
import type { ApiContext } from '../../core/context.js';

const Id = z.uuid();
function fail(code: string, message: string, statusCode = 409): never { throw Object.assign(new Error(message), { code, statusCode }); }
type Review = { operation_id: string; manifest_hash: string; host_policy_revision: number; canonical_root: string; checkpoint_id: string|null; plan_hash: string; expires_at: string; lock_owner: string; workspace_revision:number; binding_revision:number; machine_id:string; approved_root_id:string; manifest:unknown[]; original_receipt:unknown; resolution_id?: string; request_hash?: string };
export async function registerRecovery(app: FastifyInstance, context: ApiContext, store: BlobStore, adapter: (grantId?: string, tool?: string) => WorkspaceFileAdapter): Promise<void> {
  async function scope(owner: string, workspaceId: string, grantId: string) {
    const row = (await context.db.query("SELECT w.*,to_jsonb(m)->>'identity_generation' AS machine_identity_generation FROM workspaces w JOIN machines m ON m.id=w.machine_id WHERE w.id=$1 AND w.owner_id=$2", [Id.parse(workspaceId), owner])).rows[0];
    if (!row) fail('not_found', 'Project not found.', 404);
    const ws = { ...row, quota_bytes: Number(row.quota_bytes) } as Workspace;
    const grant = (await context.db.query('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2', [grantId, owner])).rows[0] as PolicyGrant | undefined;
    const decision = context.policy({ actor: { id: owner, role: 'owner' }, tool: 'workspace.reconcile', workspace_id: ws.id, machine_id: ws.machine_id, grant, current_grant: grant });
    if (!decision.allowed) fail(decision.code, decision.reason, 403);
    return ws;
  }
  async function locked(ws: Workspace, owner: string, operationId: string) {
    const lock = (await context.db.query('SELECT * FROM workspace_locks WHERE workspace_id=$1', [ws.id])).rows[0];
    if (!lock || lock.job_id || lock.lock_owner?.split(':').at(-1) !== operationId || !lock.lock_owner.includes(`:${owner}:`)) fail('writer_operation_mismatch', 'Select the unresolved file operation that owns this reservation. Job and terminal recovery use their own supervisor workflow.');
    return lock;
  }
  app.get<{ Params: { id: string } }>('/projects/:id/writer/resolve-partial/preview', async request => {
    if (request.actor?.role !== 'owner') fail('ownership_denied', 'Owner authorization is required.', 403);
    const query = z.object({ operation_id: Id, grant_id: Id }).parse(request.query);
    const ws = await scope(request.actor.id, request.params.id, query.grant_id);
    const lock = await locked(ws, request.actor.id, query.operation_id);
    const files = adapter(query.grant_id, 'workspace.reconcile');
    if (!files.operationReceipt || !files.resolvePartial || !files.binding || !files.manifest) fail('capability_unavailable', 'Protected host file recovery is not configured.', 503);
    const original = await files.operationReceipt(ws, query.operation_id);
    if (original.state !== 'outcome_unknown') fail('operation_not_partial_unknown', 'The host must first prove this operation has an unknown partial outcome, rather than an active process.');
    const binding = await files.binding(ws.machine_id, ws.id,ws.machine_identity_generation);
    if (!binding.policy_revision || binding.canonical_root !== ws.canonical_root) fail('recovery_policy_unconfigured', 'Configure the protected host recovery grant and policy revision first.', 503);
    const metadata=await files.manifest(ws),source={files:metadata.manifest.map(entry=>({entry})),consistency:metadata.consistency,exclusions:metadata.exclusions};
    if (source.exclusions.length) fail('recovery_capture_incomplete', 'Resolve unreadable or excluded files before accepting their current state.');
    const captured = {id:null,manifest:source.files.map(f=>f.entry)};
    const reviewId = randomUUID();
    const review: Review = { operation_id: query.operation_id, manifest_hash: snapshotManifestHash(source), host_policy_revision: binding.policy_revision, canonical_root: ws.canonical_root, checkpoint_id: captured.id, expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), lock_owner: lock.lock_owner, plan_hash: '',workspace_revision:ws.revision,binding_revision:binding.revision,machine_id:ws.machine_id,approved_root_id:ws.approved_root_id,manifest:captured.manifest,original_receipt:original };
    review.plan_hash = sha256(Buffer.from(canonicalJson({ ...review, review_id: reviewId, resolution: 'accept_partial' })));
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ws.id]);
      if (!(await client.query('SELECT workspace_id FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2 AND job_id IS NULL FOR UPDATE', [ws.id, lock.lock_owner])).rowCount) fail('writer_fenced', 'Writer changed during review capture.');
      await client.query('INSERT INTO storage_recovery_reviews(id,owner_id,workspace_id,original_operation_id,expected_manifest_hash,plan_hash,expires_at,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[reviewId,request.actor.id,ws.id,query.operation_id,review.manifest_hash,review.plan_hash,review.expires_at,JSON.stringify(review)]);
      await client.query('INSERT INTO file_changes(id,workspace_id,path,kind,details) VALUES($1,$2,$3,$4,$5::jsonb)', [reviewId, ws.id, '', 'partial_recovery_review', JSON.stringify(review)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await context.audit(request.actor.id, 'workspace.partial_recovery.review', ws.id, 'reviewed', { review_id: reviewId, operation_id: query.operation_id, checkpoint_id: captured.id, manifest_hash: review.manifest_hash });
    return { review_id: reviewId, operation_id: query.operation_id, plan_hash: review.plan_hash, expected_manifest_hash: review.manifest_hash, policy_revision: binding.policy_revision, canonical_root: ws.canonical_root, checkpoint_id: captured.id, expires_at: review.expires_at, resolution: 'accept_partial', original_receipt: original, files: captured.manifest, consequence: 'Retain the displayed current files and record the original operation as failed with accepted partial effects. This does not undo or rerun it.' };
  });
  app.post<{ Params: { id: string } }>('/projects/:id/writer/resolve-partial', async request => {
    if (request.actor?.role !== 'owner') fail('ownership_denied', 'Owner authorization is required.', 403);
    const body = z.object({ operation_id: Id, resolution_id: Id, grant_id: Id, recovery_grant_id: z.string().min(1).max(200), review_id: Id, plan_hash: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(8).max(4096), resolution: z.literal('accept_partial') }).parse(request.body);
    const ws = await scope(request.actor.id, request.params.id, body.grant_id);
    const reviewRow = (await context.db.query("SELECT details FROM file_changes WHERE id=$1 AND workspace_id=$2 AND kind='partial_recovery_review'", [body.review_id, ws.id])).rows[0];
    const review = reviewRow?.details as Review | undefined;
    if (!review || review.operation_id !== body.operation_id || review.plan_hash !== body.plan_hash || review.canonical_root !== ws.canonical_root || review.workspace_revision!==ws.revision||review.machine_id!==ws.machine_id||review.approved_root_id!==ws.approved_root_id||Date.parse(review.expires_at) < Date.now()) fail('recovery_review_changed', 'Capture and review the current files again.');
    const requestHash = sha256(Buffer.from(canonicalJson(body)));
    if (review.resolution_id && (review.resolution_id !== body.resolution_id || review.request_hash !== requestHash)) fail('idempotency_conflict', 'The review already names a different acceptance request.');
    const files = adapter(body.grant_id, 'workspace.reconcile');
    if (!files.resolvePartial || !files.binding || !files.operationReceipt || !files.manifest) fail('capability_unavailable', 'Protected host recovery is not configured.', 503);
    const original = await files.operationReceipt(ws, body.operation_id);
    if (review.resolution_id && original.state === 'failed' && original.reason === 'operator_accepted_partial_outcome') {
      const remaining=(await context.db.query('SELECT lock_owner FROM workspace_locks WHERE workspace_id=$1',[ws.id])).rows[0];
      if(remaining?.lock_owner===review.lock_owner) await releaseKnownWriter(context.db,{workspace:ws,owner:request.actor.id,lockOwner:review.lock_owner,operationId:body.operation_id,rpcId:body.resolution_id,outcome:'accepted_partial',binding:await files.binding(ws.machine_id,ws.id,ws.machine_identity_generation)});
      return { resolved: true, outcome: 'accepted_partial', original_receipt: original, checkpoint_id: review.checkpoint_id };
    }
    const lock = await locked(ws, request.actor.id, body.operation_id);
    if (lock.lock_owner !== review.lock_owner) fail('writer_fenced', 'The reservation no longer matches the reviewed operation.');
    const binding = await files.binding(ws.machine_id, ws.id,ws.machine_identity_generation);
    const source = await files.manifest(ws);
    if (source.exclusions.length || snapshotManifestHash(source.manifest) !== review.manifest_hash || binding.policy_revision !== review.host_policy_revision||binding.revision!==review.binding_revision) fail('content_conflict', 'Current files or recovery policy changed. Review again.');
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [ws.id]);
      if (!(await client.query('SELECT workspace_id FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2 AND job_id IS NULL FOR UPDATE', [ws.id, lock.lock_owner])).rowCount) fail('writer_fenced', 'Writer changed before recovery authorization.');
      const claimed = (await client.query('SELECT details FROM file_changes WHERE id=$1 FOR UPDATE', [body.review_id])).rows[0].details as Review;
      if (claimed.resolution_id && (claimed.resolution_id !== body.resolution_id || claimed.request_hash !== requestHash)) fail('idempotency_conflict', 'Review was already claimed.');
      await client.query('UPDATE file_changes SET details=$2::jsonb WHERE id=$1', [body.review_id, JSON.stringify({ ...claimed, resolution_id: body.resolution_id, request_hash: requestHash })]);
      const hostBody={expected_manifest_hash:review.manifest_hash,grant_id:body.recovery_grant_id,policy_revision:review.host_policy_revision,resolution:body.resolution,reason:body.reason,resolution_id:body.resolution_id};
      await client.query('UPDATE storage_recovery_reviews SET details=$2::jsonb WHERE id=$1 AND used_at IS NULL',[body.review_id,JSON.stringify({...claimed,resolution_id:body.resolution_id,request_hash:requestHash,rpc_body_hash:rpcDigest(hostBody)})]);
      await client.query('INSERT INTO audit_events(actor_id,action,target,outcome,details) VALUES($1,$2,$3,$4,$5::jsonb)', [request.actor.id, 'workspace.partial_recovery.authorize', ws.id, 'authorized', JSON.stringify({ review_id: body.review_id, original_operation_id: body.operation_id, resolution_id: body.resolution_id, reason: body.reason, manifest_hash: review.manifest_hash, checkpoint_id: review.checkpoint_id })]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const receipt = await files.resolvePartial(ws, { operation_id: body.resolution_id, original_operation_id: body.operation_id, grant_id: body.recovery_grant_id, scope_grant_id: body.grant_id, lock_owner: lock.lock_owner, expected_manifest_hash: review.manifest_hash, policy_revision: review.host_policy_revision, resolution: 'accept_partial', reason: body.reason,recovery_review:{review_id:body.review_id,owner_id:request.actor.id} });
    const next = await files.binding(ws.machine_id, ws.id,ws.machine_identity_generation);
    await releaseKnownWriter(context.db, { workspace: ws, owner: request.actor.id, lockOwner: lock.lock_owner, operationId: body.operation_id, rpcId: body.resolution_id, outcome: 'accepted_partial', binding: next });
    return { resolved: true, outcome: 'accepted_partial', original_receipt: receipt, checkpoint_id: review.checkpoint_id };
  });
}



