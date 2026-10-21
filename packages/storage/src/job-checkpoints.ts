import type { Pool } from 'pg';
import type { Checkpoint, Workspace } from '@homelab/contracts';
import { BlobStore } from './blobs.js';
import { captureCheckpointFromAdapter, type WorkspaceFileAdapter } from './workspace.js';

/** Call while the job owns the existing workspace writer reservation. */
export async function createCheckpointForJob(options: { db: Pool; store: BlobStore; adapter: WorkspaceFileAdapter; workspace: Workspace; job: { id: string; fence: string; lease_owner: string | null }; reason: string; assertLease: () => Promise<void> }): Promise<Checkpoint> {
  const reason = `job:${options.job.id}:${options.reason}`;
  const existing = (await options.db.query('SELECT * FROM checkpoints WHERE workspace_id=$1 AND reason=$2 ORDER BY created_at DESC LIMIT 1', [options.workspace.id, reason])).rows[0];
  if (existing) {
    if (existing.exclusions.length) throw new Error('checkpoint_capture_incomplete');
    return existing as Checkpoint;
  }
  await options.assertLease();
  const checkpoint = await captureCheckpointFromAdapter(options.store, options.workspace, options.adapter);
  if (checkpoint.exclusions.length) throw new Error('checkpoint_capture_incomplete');
  await options.assertLease();
  const inserted = await options.db.query(`INSERT INTO checkpoints(id,workspace_id,manifest,manifest_hash,consistency,exclusions,reason)
    SELECT $1,$2,$3::jsonb,$4,$5,$6::jsonb,$7 WHERE EXISTS (SELECT 1 FROM jobs j JOIN workspace_locks l ON l.job_id=j.id
    WHERE j.id=$8 AND j.fence=$9 AND j.lease_owner=$10 AND j.lease_until>now() AND l.workspace_id=$2) RETURNING id`, [checkpoint.id, options.workspace.id, JSON.stringify(checkpoint.manifest), checkpoint.manifest_hash, checkpoint.consistency, JSON.stringify(checkpoint.exclusions), reason, options.job.id, options.job.fence, options.job.lease_owner]);
  if (!inserted.rowCount) throw new Error('checkpoint_writer_or_lease_lost');
  return checkpoint;
}
