import type { Pool } from 'pg';
import type { Checkpoint, PolicyGrant, Workspace } from '@homelab/contracts';
import { randomUUID } from 'node:crypto';
import { BlobStore } from './blobs.js';
import { captureCheckpointFromAdapter, workspaceSnapshotMetadata, exportCheckpoint, snapshotManifestHash, type WorkspaceFileAdapter } from './workspace.js';

export interface ExportJob { id: string; requester_id: string; fence: string; lease_owner: string | null; payload: Record<string, unknown> }
export interface ExportRuntime {
  assertLease(): Promise<void>; cancelled(): Promise<boolean>;
  complete(result: unknown): Promise<void>; wait(reason: string, seconds?: number): Promise<void>;
  fail(reason: string): Promise<void>; appendEvent(type: string, payload: unknown): Promise<void>;
  cancel(reason: string): Promise<void>;
}

/** The worker must hold its durable workspace writer reservation before invoking. */
export function createProjectExportHandler(options: { db: Pool; store: BlobStore; adapter?: WorkspaceFileAdapter; adapterForJob?: (job: ExportJob, runtime: ExportRuntime) => WorkspaceFileAdapter | undefined; authorize: (owner: string, workspace: Workspace, captured: PolicyGrant) => Promise<void> }) {
  return async (job: ExportJob, runtime: ExportRuntime): Promise<void> => {
    if (await runtime.cancelled()) { await runtime.cancel('export_cancelled_before_capture'); return; }
    const adapter = options.adapterForJob?.(job, runtime) ?? options.adapter;
    if (!adapter) { await runtime.wait('workspace_file_adapter_unavailable', 30); return; }
    const ws = (await options.db.query('SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2', [job.payload.workspace_id, job.requester_id])).rows[0] as Workspace | undefined;
    if (!ws || ws.state !== 'active' || ws.revision !== job.payload.workspace_revision) { await runtime.fail('workspace_revision_conflict'); return; }
    ws.quota_bytes = Number(ws.quota_bytes);
    await options.authorize(job.requester_id, ws, job.payload.grant as PolicyGrant);
    await runtime.assertLease();
    // Resume from the already-recorded immutable checkpoint after worker failure.
    const previous = await options.db.query("SELECT c.* FROM checkpoints c WHERE c.workspace_id=$1 AND c.reason=$2 ORDER BY created_at DESC LIMIT 1", [ws.id, `export:${job.id}`]);
    let checkpoint = previous.rows[0] as Checkpoint | undefined;
    if (!checkpoint) {
      const source = await workspaceSnapshotMetadata(adapter,ws);
      if (job.payload.expected_manifest_hash && job.payload.expected_manifest_hash !== snapshotManifestHash(source)) { await runtime.fail('export_source_changed_review_again'); return; }
      const acknowledged = Array.isArray(job.payload.acknowledged_exclusions) ? job.payload.acknowledged_exclusions as string[] : [];
      if (JSON.stringify([...source.exclusions].sort()) !== JSON.stringify([...acknowledged].sort())) { await runtime.fail('export_exclusions_require_review'); return; }
      checkpoint = await captureCheckpointFromAdapter(options.store, ws, adapter);
      if(snapshotManifestHash(checkpoint.manifest)!==snapshotManifestHash(source)||JSON.stringify([...checkpoint.exclusions].sort())!==JSON.stringify([...acknowledged].sort())){await runtime.fail('export_source_changed_review_again');return;}
      await runtime.assertLease();
      const saved = await options.db.query(`INSERT INTO checkpoints(id,workspace_id,manifest,manifest_hash,consistency,exclusions,reason)
        SELECT $1,$2,$3::jsonb,$4,$5,$6::jsonb,$7 WHERE EXISTS (SELECT 1 FROM jobs WHERE id=$8 AND fence=$9 AND lease_owner=$10 AND lease_until>now()) RETURNING id`, [checkpoint.id, ws.id, JSON.stringify(checkpoint.manifest), checkpoint.manifest_hash, checkpoint.consistency, JSON.stringify(checkpoint.exclusions), `export:${job.id}`, job.id, job.fence, job.lease_owner]);
      if (!saved.rowCount) throw new Error('export_checkpoint_lease_lost');
    }
    await runtime.appendEvent('export.checkpoint', { checkpoint_id: checkpoint.id, consistency: checkpoint.consistency, exclusions: checkpoint.exclusions });
    const existing = await options.db.query('SELECT * FROM artifacts WHERE job_id=$1 AND relative_path=$2 LIMIT 1', [job.id, 'project.zip']);
    if (existing.rows[0]) { await runtime.complete({ artifact_id: existing.rows[0].id, checkpoint_id: checkpoint.id, sha256: existing.rows[0].sha256 }); return; }
    const zip = await exportCheckpoint(options.store, checkpoint);
    await runtime.assertLease();
    await options.authorize(job.requester_id, ws, job.payload.grant as PolicyGrant);
    const artifactId = randomUUID();
    // A fenced worker can write extra immutable blobs, but cannot publish metadata after lease loss.
    const published = await options.db.query(`INSERT INTO artifacts(id,owner_id,workspace_id,job_id,relative_path,sha256,size_bytes,mime_type,storage_key)
      SELECT $1,$2,$3,$4,'project.zip',$5,$6,'application/zip',$5
      WHERE EXISTS (SELECT 1 FROM jobs WHERE id=$4 AND fence=$7 AND lease_owner=$8 AND state='running' AND lease_until>now()) RETURNING id`, [artifactId, job.requester_id, ws.id, job.id, zip.hash, zip.size, job.fence, job.lease_owner]);
    if (!published.rowCount) throw new Error('export_publication_lease_lost');
    await runtime.complete({ artifact_id: artifactId, checkpoint_id: checkpoint.id, sha256: zip.hash, size_bytes: zip.size, consistency: checkpoint.consistency, exclusions: checkpoint.exclusions });
  };
}

