import type { Pool } from 'pg';
import type { Checkpoint } from '@homelab/contracts';
import { BlobStore, sha256 } from './blobs.js';
import { diffCheckpoints } from './diff.js';
import { snapshotManifestHash } from './workspace.js';

function stableId(value: string): string { const h = sha256(Buffer.from(value)); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; }
function text(bytes: Uint8Array): string | null { if (bytes.length > 1024 * 1024 || bytes.includes(0)) return null; try { return new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { return null; } }
function unified(path: string, before: string, after: string): string {
  const a=before.match(/[^\n]*\n|[^\n]+$/g)??[],b=after.match(/[^\n]*\n|[^\n]+$/g)??[];
  const rows=[`--- a/${path}`,`+++ b/${path}`,`@@ -${a.length?1:0},${a.length} +${b.length?1:0},${b.length} @@`];
  for(const [prefix,lines] of [['-',a],['+',b]] as const)for(const line of lines){rows.push(prefix+line.replace(/\n$/,''));if(!line.endsWith('\n'))rows.push('\\ No newline at end of file');}
  return rows.join('\n') + '\n';
}
export async function publishCheckpointChanges(options: { db: Pool; store: BlobStore; job: { id: string; requester_id: string; fence: string; lease_owner: string | null }; operation_id: string; before: Checkpoint; after: Checkpoint; attribution: 'recorded_tool' | 'unconfirmed'; assertLease: () => Promise<void> }) {
  const changes = diffCheckpoints(options.before, options.after);
  const result: { id: string; path: string; kind: string; binary: boolean|null; diff_artifact_id: string }[] = [];
  await options.assertLease();
  const authorized = await options.db.query("SELECT o.id FROM operations o JOIN jobs j ON j.id=o.job_id JOIN workspaces w ON w.id=$3 WHERE o.id=$1 AND j.id=$2 AND j.requester_id=$4 AND w.owner_id=$4 AND o.machine_id=w.machine_id AND COALESCE(j.workspace_id,(j.context->>'workspace_id')::uuid)=w.id", [options.operation_id, options.job.id, options.before.workspace_id, options.job.requester_id]);
  if (!authorized.rowCount) throw new Error('change_provenance_denied');
  const retained=(await options.db.query('SELECT * FROM checkpoints WHERE id=ANY($1::uuid[]) AND workspace_id=$2',[[options.before.id,options.after.id],options.before.workspace_id])).rows;
  for(const checkpoint of [options.before,options.after]){const row=retained.find(r=>r.id===checkpoint.id);if(!row||row.manifest_hash!==checkpoint.manifest_hash||snapshotManifestHash(row.manifest)!==snapshotManifestHash(checkpoint.manifest)||row.exclusions.length||checkpoint.exclusions.length)throw new Error('change_checkpoint_evidence_mismatch');}
  for (const change of changes) {
    const oversized=(change.before?.size_bytes??0)>1048576||(change.after?.size_bytes??0)>1048576;
    const before = !oversized&&change.before?.kind === 'file' && change.before.sha256 ? await options.store.get(change.before.sha256) : Buffer.alloc(0);
    const after = !oversized&&change.after?.kind === 'file' && change.after.sha256 ? await options.store.get(change.after.sha256) : Buffer.alloc(0);
    const left = text(before), right = text(after);
    const binary = left === null || right === null || (change.before?.kind !== 'file' && change.before !== null) || (change.after?.kind !== 'file' && change.after !== null);
    const evidence = { path: change.path, change: change.change, before: change.before, after: change.after, before_checkpoint_id: options.before.id, after_checkpoint_id: options.after.id, attribution: options.attribution, observation_scope: 'Project files only; this does not establish all system-wide or external effects.', binary:oversized?null:binary,content_classification:oversized?'not_inspected_over_1MiB':binary?'binary_or_non_file':'utf8_text' };
    const patch = binary||oversized ? null : unified(change.path, left ?? '', right ?? '');
    const bounded = patch !== null && Buffer.byteLength(patch) <= 128 * 1024;
    const bytes = Buffer.from(bounded ? patch! : JSON.stringify({ ...evidence, text_diff_omitted: !binary, reason: oversized?'Content exceeds the 1 MiB text inspection bound; full before/after bytes remain retained.':binary ? 'Binary or non-file entry; compare retained hashes.' : 'Text diff exceeds 128 KiB; full before/after bytes remain retained.' }, null, 2));
    const blob = await options.store.put(bytes);
    const changeId = stableId(`change:${options.operation_id}:${change.path}:${options.before.id}:${options.after.id}`);
    const artifactId = stableId(`diff:${changeId}`);
    await options.assertLease();
    const client = await options.db.connect();
    try {
      await client.query('BEGIN');
      const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];if(!control||control.maintenance_mode||control.restore_mode)throw new Error('change_publication_maintenance_blocked');
      const lease = await client.query('SELECT j.id FROM jobs j JOIN workspace_locks l ON l.job_id=j.id WHERE j.id=$1 AND j.fence=$2 AND j.lease_owner=$3 AND j.lease_until>now() AND l.workspace_id=$4 FOR UPDATE OF j,l', [options.job.id, options.job.fence, options.job.lease_owner, options.before.workspace_id]);
      if (!lease.rowCount) throw new Error('change_publication_fenced');
      await client.query('INSERT INTO artifacts(id,owner_id,workspace_id,job_id,operation_id,relative_path,sha256,size_bytes,mime_type,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$7) ON CONFLICT(id) DO NOTHING', [artifactId, options.job.requester_id, options.before.workspace_id, options.job.id, options.operation_id, `diffs/${changeId}.${bounded ? 'diff' : 'json'}`, blob.hash, blob.size, bounded ? 'text/plain' : 'application/json']);
      await client.query('INSERT INTO file_changes(id,workspace_id,job_id,operation_id,path,before_hash,after_hash,kind,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(id) DO NOTHING', [changeId, options.before.workspace_id, options.job.id, options.operation_id, change.path, change.before?.sha256 ?? null, change.after?.sha256 ?? null, change.change, JSON.stringify({ ...evidence, diff_artifact_id: artifactId, text_diff_complete: bounded })]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    result.push({ id: changeId, path: change.path, kind: change.change, binary:oversized?null:binary, diff_artifact_id: artifactId });
  }
  return { changes: result, diff_artifact_ids: result.map(change => change.diff_artifact_id) };
}
