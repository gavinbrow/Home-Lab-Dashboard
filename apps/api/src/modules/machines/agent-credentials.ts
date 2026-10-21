import type { Pool, PoolClient } from 'pg';
import type { Capability } from '@homelab/contracts';

export async function agentCredentialState(db: Pool | PoolClient, machine: string) {
  const result = await db.query("SELECT count(*)::integer AS total,count(*) FILTER(WHERE revoked_at IS NULL AND expires_at>clock_timestamp() AND protocol_version=1 AND fingerprint_sha256 IS NOT NULL)::integer AS active,array_agg(id ORDER BY id) FILTER(WHERE revoked_at IS NULL AND expires_at>clock_timestamp() AND protocol_version=1 AND fingerprint_sha256 IS NOT NULL) AS active_ids FROM agent_certificates WHERE machine_id=$1", [machine]);
  return result.rows[0] as { total: number; active: number; active_ids: string[] | null };
}

/** Preserve remote SSH/desktop state and historical measurements when agent trust is revoked. */
export async function markAgentCredentialUnavailable(db: PoolClient, machine: string) {
  const credentials = await agentCredentialState(db, machine);
  if (credentials.active) return false;
  const patch: Partial<Capability> = { permitted: false, health_state: credentials.total ? 'permission_denied' : 'unconfigured', reason: credentials.total ? 'No current, unrevoked compatible agent certificate remains.' : 'Enroll the host agent before testing this capability.' };
  for (const capability of ['monitoring', 'runner', 'containers']) await db.query("UPDATE machines SET capabilities=jsonb_set(capabilities,ARRAY[$2::text],COALESCE(capabilities->$2,'{}'::jsonb)||$3::jsonb) WHERE id=$1", [machine, capability, JSON.stringify(patch)]);
  return true;
}
