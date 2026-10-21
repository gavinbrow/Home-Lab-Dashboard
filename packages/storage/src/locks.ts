import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Workspace } from '@homelab/contracts';

/** Non-expiring reservation: unknown host mutations must be reconciled, never timed out. */
export async function withWorkspaceWriter<T>(db: Pool, workspace: Workspace, actorId: string, action: string, execute: (mutation: { operation_id: string; lock_owner: string }) => Promise<T>, options: { operationId?: string; allowedStates?: Workspace['state'][] } = {}): Promise<T> {
  const operationId = options.operationId ?? randomUUID();
  const token = `${action}:${actorId}:${operationId}`;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const control=(await client.query('SELECT maintenance_mode,restore_mode FROM runtime_control WHERE singleton=true FOR SHARE')).rows[0];
    if(!control||control.maintenance_mode||control.restore_mode)throw Object.assign(new Error('Project mutation is unavailable during maintenance or restore.'),{code:'maintenance_mode',statusCode:409});
    const current = await client.query('SELECT state,revision FROM workspaces WHERE id=$1 AND owner_id=$2 FOR UPDATE', [workspace.id, actorId]);
    if (!current.rows[0] || !(options.allowedStates ?? ['active']).includes(current.rows[0].state) || current.rows[0].revision !== workspace.revision) throw Object.assign(new Error('Workspace changed or is inactive.'), { code: 'workspace_revision_conflict', statusCode: 409 });
    const lock = await client.query('INSERT INTO workspace_locks(workspace_id,lock_owner,state) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING workspace_id', [workspace.id, token, 'held']);
    if (!lock.rowCount) {
      const existing = await client.query('SELECT lock_owner FROM workspace_locks WHERE workspace_id=$1', [workspace.id]);
      if (existing.rows[0]?.lock_owner !== token) throw Object.assign(new Error('Workspace has an active or unresolved writer.'), { code: 'workspace_locked', statusCode: 409 });
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  try {
    const result = await execute({ operation_id: operationId, lock_owner: token });
    await db.query('DELETE FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2', [workspace.id, token]);
    return result;
  } catch (error) {
    const code = (error as { code?: string }).code;
    // These are definitive host rejections before publication. Transport/unknown errors keep the lock.
    if (['content_conflict', 'invalid_relative_path', 'permission_denied', 'grant_revoked', 'tool_denied', 'workspace_denied', 'machine_denied'].includes(code ?? '')) {
      await db.query('DELETE FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2', [workspace.id, token]);
    } else {
      const rpcId = (error as { details?: { rpc_id?: string } }).details?.rpc_id ?? operationId;
      await db.query("UPDATE workspace_locks SET state='outcome_unknown',rpc_id=(SELECT id FROM agent_rpc_requests WHERE id=$3) WHERE workspace_id=$1 AND lock_owner=$2", [workspace.id, token, rpcId]).catch(() => undefined);
    }
    throw error;
  }
}
