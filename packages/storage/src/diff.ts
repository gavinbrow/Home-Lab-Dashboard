import type { Checkpoint, CheckpointEntry } from '@homelab/contracts';
export type CheckpointChange = { path: string; change: 'added' | 'deleted' | 'modified'; before: CheckpointEntry | null; after: CheckpointEntry | null };
/** Review-only metadata diff; restoration requires a separately authorized host operation. */
export function diffCheckpoints(before: Checkpoint, after: Checkpoint): CheckpointChange[] {
  if (before.workspace_id !== after.workspace_id) throw new Error('checkpoint_workspace_mismatch');
  const left = new Map(before.manifest.map(entry => [entry.path, entry]));
  const right = new Map(after.manifest.map(entry => [entry.path, entry]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths.flatMap(path => {
    const a = left.get(path) ?? null, b = right.get(path) ?? null;
    if (a && b && a.kind === b.kind && a.sha256 === b.sha256 && a.size_bytes === b.size_bytes && a.mode === b.mode && a.link_target === b.link_target) return [];
    return [{ path, change: !a ? 'added' as const : !b ? 'deleted' as const : 'modified' as const, before: a, after: b }];
  });
}
