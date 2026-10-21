import type { JobState, RunContext, PolicyGrant } from "@homelab/contracts";
export interface JobRow {
  id: string; requester_id: string; request_hash: string; idempotency_key: string;
  context: RunContext | null; workspace_id: string | null; kind: string; payload: Record<string, unknown>; result: unknown;
  modifies_workspace: boolean; state: JobState; reason: string | null;
  lease_owner: string | null; lease_until: Date | null; fence: string;
  next_run_at: Date; cancel_requested: boolean; dispatch_epoch: string;
  created_at: Date; started_at: Date | null; ended_at: Date | null;
  recovery_only?:boolean;
}
export interface JobPayload extends Record<string, unknown> { grant?: PolicyGrant; }

export const transitions: Readonly<Record<JobState, ReadonlySet<JobState>>> = {
  queued: new Set(["running", "waiting", "cancelled"]),
  running: new Set(["waiting", "cancelling", "completed", "failed", "interrupted"]),
  waiting: new Set(["running", "cancelling", "cancelled", "failed", "interrupted"]),
  cancelling: new Set(["cancelled", "interrupted"]),
  completed: new Set(), failed: new Set(), cancelled: new Set(), interrupted: new Set(),
};
export function assertTransition(from: JobState, to: JobState): void {
  if (from !== to && !transitions[from].has(to)) throw new Error(`Invalid job transition ${from} -> ${to}`);
}

