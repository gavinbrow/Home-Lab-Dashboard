import type { Pool } from 'pg';
import type { Workspace } from '@homelab/contracts';
import type { WorkspaceBinding } from './workspace.js';

function fenced(): never { throw Object.assign(new Error('The writer reservation changed during reconciliation.'), { code: 'writer_fenced', statusCode: 409 }); }
/** Serializes with AgentBroker's guarded enqueue on the SAME writer row. */
export async function releaseUndispatchedWriter(db: Pool, input: { workspace: Workspace; owner: string; lockOwner: string; operationId: string; writerFencing: boolean }): Promise<{ released: boolean; rpc_id: string | null }> {
  if (!input.writerFencing) throw Object.assign(new Error('This adapter cannot fence a paused dispatcher.'), { code: 'host_outcome_unknown', statusCode: 409 });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspace.id]);
    const lock = (await client.query('SELECT * FROM workspace_locks WHERE workspace_id=$1 FOR UPDATE', [input.workspace.id])).rows[0];
    if (!lock || lock.lock_owner !== input.lockOwner || lock.job_id) fenced();
    const rpc = (await client.query('SELECT id FROM agent_rpc_requests WHERE id=$1 AND machine_id=$2', [lock.rpc_id ?? input.operationId, input.workspace.machine_id])).rows[0];
    if (rpc) { await client.query('COMMIT'); return { released: false, rpc_id: rpc.id }; }
    await client.query('INSERT INTO audit_events(actor_id,action,target,outcome,details) VALUES($1,$2,$3,$4,$5::jsonb)', [input.owner, 'workspace.writer.reconcile', input.workspace.id, 'not_dispatched', JSON.stringify({ operation_id: input.operationId, verification: 'atomic_enqueue_fenced_before_durable_dispatch' })]);
    await client.query('DELETE FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2 AND job_id IS NULL', [input.workspace.id, input.lockOwner]);
    await client.query('COMMIT');
    return { released: true, rpc_id: null };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

/** Call only after terminal host receipt verification; never use elapsed time as evidence. */
export async function releaseKnownWriter(db: Pool, input: { workspace: Workspace; owner: string; lockOwner: string; operationId: string; rpcId: string; outcome: 'completed' | 'rejected_before_effects' | 'accepted_partial'; binding?: WorkspaceBinding }): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspace.id]);
    const lock = (await client.query('SELECT * FROM workspace_locks WHERE workspace_id=$1 FOR UPDATE', [input.workspace.id])).rows[0];
    if (!lock || lock.lock_owner !== input.lockOwner || lock.job_id || (lock.rpc_id && lock.rpc_id !== input.rpcId)) fenced();
    if (input.binding) {
      const next = input.binding;
      if (next.workspace_id !== input.workspace.id || next.canonical_root !== input.workspace.canonical_root || next.approved_root_id !== input.workspace.approved_root_id) throw new Error('storage_binding_changed');
      await client.query('UPDATE workspaces SET state=$2,revision=$3,environment_id=$4,environment_generation=$5,updated_at=now() WHERE id=$1 AND revision<=$3', [input.workspace.id, next.state, next.revision, next.environment_id, next.environment_generation]);
      if (next.environment_id && next.environment_generation) await client.query(`INSERT INTO environment_generations(id,workspace_id,machine_id,generation,runtime_id,image_digest,state,mount_path)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET runtime_id=EXCLUDED.runtime_id,state=EXCLUDED.state`, [next.environment_id, input.workspace.id, input.workspace.machine_id, next.environment_generation, next.runtime_id ?? null, next.image_digest ?? null, next.runtime_id ? 'running' : 'removed', next.runtime_path]);
    }
    await client.query('INSERT INTO audit_events(actor_id,action,target,outcome,details) VALUES($1,$2,$3,$4,$5::jsonb)', [input.owner, 'workspace.writer.reconcile', input.workspace.id, input.outcome, JSON.stringify({ operation_id: input.operationId, rpc_id: input.rpcId, verification: 'terminal_host_receipt' })]);
    await client.query('DELETE FROM workspace_locks WHERE workspace_id=$1 AND lock_owner=$2 AND job_id IS NULL', [input.workspace.id, input.lockOwner]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
