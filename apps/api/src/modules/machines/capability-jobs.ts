import type { JobHandler } from '@homelab/worker/runtime';
import type { AgentBroker } from '@homelab/transport';
import type { Capability, JsonValue } from '@homelab/contracts';
import type { PolicyGrant } from '@homelab/contracts';
import type { createOperationExecutor, ExecutionContext } from '../../../../worker/src/operations.js';
import { agentCredentialState } from './agent-credentials.js';
import { assertOwnedLease, LeaseLostError } from '../../../../worker/src/database.js';
import { appendEventInTransaction } from '@homelab/worker';
import { verifyRunnerIdentity } from './runner-identity.js';

export interface ProbeResult { health_state: Capability['health_state']; reason: string | null; evidence: JsonValue; supported?: boolean | null; configured?: boolean; permitted?: boolean; observed_at?: string }
export function createCapabilityTestHandler(options: { broker?: AgentBroker; operations?: ReturnType<typeof createOperationExecutor>; probe?: (machine: string, owner: string, capability: string, authSessionId?: string) => Promise<ProbeResult> } = {}): JobHandler {
  return async (job, runtime) => {
    const machine = String(job.payload.machine_id ?? ''), capability = String(job.payload.test ?? '');
    const unresolvedProbe = async () => ['runner', 'containers'].includes(capability) && !!(await runtime.db.query("SELECT id FROM operations WHERE job_id=$1 AND status NOT IN ('succeeded','failed','cancelled','rejected') LIMIT 1", [job.id])).rowCount;
    const stopProbe = async (state: 'cancelled' | 'interrupted', reason: string) => {
      const client = await runtime.db.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='10s'");
        await assertOwnedLease(client, job);
        await client.query('UPDATE capability_tests SET state=$2,reason=$3,evidence=$4::jsonb,completed_at=now() WHERE id=$1 AND owner_id=$5', [job.id, state, reason, JSON.stringify({ executed: reason === 'cancelled_before_probe' ? false : null, conclusive: false, reason }), job.requester_id]);
        if (state === 'interrupted') await client.query("UPDATE machines SET capabilities=jsonb_set(capabilities,ARRAY[$3::text],COALESCE(capabilities->$3,'{}'::jsonb)||$4::jsonb) WHERE id=$1 AND owner_id=$2 AND capabilities->$3->>'health_state' IS DISTINCT FROM 'permission_denied'", [machine, job.requester_id, capability, JSON.stringify({ health_state: 'degraded', reason: 'Capability probe outcome requires reconciliation.' })]);
        await appendEventInTransaction(client, job.id, 'machine.capability_test', { machine_id: machine, capability, state, reason });
        if (!(await client.query('SELECT id FROM jobs WHERE id=$1 AND lease_until>clock_timestamp()', [job.id])).rowCount) throw new LeaseLostError();
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      if (state === 'cancelled') await runtime.cancel(reason); else await runtime.interrupt(reason);
    };
    if (await runtime.cancelled() && !await unresolvedProbe()) { await stopProbe('cancelled', 'cancelled_before_probe'); return; }
    if (!['monitoring', 'ssh', 'sftp', 'desktop', 'runner', 'containers'].includes(capability)) { await runtime.fail('invalid_capability'); return; }
    const owned = await runtime.db.query('SELECT id,os,boot_id,capabilities,identity_generation FROM machines WHERE id=$1 AND owner_id=$2', [machine, job.requester_id]);
    if (!owned.rowCount) { await runtime.fail('machine_not_found'); return; }
    await runtime.assertLease();
    let result: ProbeResult;
    let credentialStamp: string | null = null;
    const agentCapability = ['monitoring', 'runner', 'containers'].includes(capability);
    const expectedGeneration = (job.payload.machine_identity_generations as Record<string, string> | undefined)?.[machine];
    try {
      const credentials = agentCapability ? await agentCredentialState(runtime.db, machine) : null;
      credentialStamp = credentials ? JSON.stringify(credentials.active_ids ?? []) : null;
      if (agentCapability && expectedGeneration !== owned.rows[0].identity_generation && await unresolvedProbe()) { await runtime.wait('machine_identity_changed_reconciliation_required', 5); return; }
      if (credentials && !credentials.active && await unresolvedProbe()) { await runtime.wait('agent_certificate_unavailable_reconciliation_required', 5); return; }
      if (agentCapability && (!expectedGeneration || expectedGeneration !== owned.rows[0].identity_generation)) result = { health_state: 'unverified', permitted: false, reason: 'Machine installation changed or its original generation was not captured; request a new test.', evidence: { executed: false, check: 'machine_identity_generation' } };
      else if (credentials && !credentials.active) result = { health_state: credentials.total ? 'permission_denied' : 'unconfigured', configured: credentials.total > 0, permitted: false, supported: null, reason: credentials.total ? 'No current, unrevoked compatible agent certificate remains.' : 'Enroll the host agent before testing this capability.', evidence: { executed: true, check: 'current_agent_certificate', active_certificates: 0 } };
      else if (capability === 'monitoring') {
        const samples = await runtime.db.query('SELECT sequence,min(observed_at) AS observed_at,max(received_at) AS received_at,count(*) FILTER(WHERE availability=\'available\') AS available FROM metric_samples WHERE machine_id=$1 AND boot_id=$2 GROUP BY sequence ORDER BY sequence DESC LIMIT 3', [machine, owned.rows[0].boot_id]);
        const ordered = [...samples.rows].reverse();
        const valid = ordered.length === 3 && ordered.every((row, index) => Number(row.available) > 0 && Date.now() - new Date(row.observed_at).getTime() <= 60000 && Date.now() - new Date(row.received_at).getTime() <= 60000 && new Date(row.observed_at).getTime() <= Date.now() + 5000 && (index === 0 || Number(row.sequence) > Number(ordered[index - 1].sequence) && new Date(row.observed_at) > new Date(ordered[index - 1].observed_at)));
        result = { health_state: valid ? 'healthy' : 'degraded', reason: valid ? null : 'Three fresh increasing samples with available observations are required.', supported: true, observed_at: ordered.length ? new Date(ordered[ordered.length - 1].observed_at).toISOString() : undefined, evidence: { executed: true, check: 'three_fresh_increasing_samples', boot_id: owned.rows[0].boot_id, sequences: ordered.map(row => String(row.sequence)), observed_at: ordered.map(row => new Date(row.observed_at).toISOString()), reference_comparison: 'not_run' } };
      } else if (capability === 'runner' && options.operations && job.payload.execution_context && job.payload.grant) {
        const execution = job.payload.execution_context as ExecutionContext;
        if (execution.execution_machine_id !== machine) throw new Error('runner_machine_mismatch');
        const windows = owned.rows[0].os === 'windows' && !execution.environment_id;
        const command = windows ? { executable: 'C:\\Windows\\System32\\whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] } : { executable: '/usr/bin/id', args: ['-u'] };
        const operation = await options.operations.executeCommand(job, runtime, { step_id: 'runner:identity', command, tool: 'run_command', grant: job.payload.grant as PolicyGrant, context: execution, mutating: true, verification: true });
        if (operation.state === 'pending') { await runtime.wait(operation.reason, 2); return; }
        if (operation.state === 'unknown') { await stopProbe('interrupted', operation.reason); return; }
        if (operation.status === 'cancelled') { await stopProbe('cancelled', 'runner_probe_cancelled'); return; }
        let groupOutput: string | undefined;
        let groupOperationId: string | null = null;
        let groupSucceeded = windows;
        if (!windows && operation.status === 'succeeded' && operation.exit_code === 0) {
          const group = await options.operations.executeCommand(job, runtime, { step_id: 'runner:group', command: { executable: '/usr/bin/id', args: ['-g'] }, tool: 'run_command', grant: job.payload.grant as PolicyGrant, context: execution, mutating: true, verification: true });
          if (group.state === 'pending') { await runtime.wait(group.reason, 2); return; }
          if (group.state === 'unknown') { await stopProbe('interrupted', group.reason); return; }
          if (group.status === 'cancelled') { await stopProbe('cancelled', 'runner_probe_cancelled'); return; }
          if (group.status === 'succeeded' && group.exit_code === 0) { groupOutput = group.output; groupSucceeded = true; }
          groupOperationId = group.operation_id;
        }
        const identity = verifyRunnerIdentity(String(job.payload.configured_identity ?? ''), operation.output ?? '', groupOutput, windows);
        const commandPassed = operation.status === 'succeeded' && operation.exit_code === 0 && groupSucceeded;
        const passed = commandPassed && identity.matched === true;
        result = { health_state: passed ? 'healthy' : !commandPassed ? 'degraded' : identity.matched === null ? 'unverified' : 'permission_denied', supported: true, permitted: !commandPassed || identity.matched !== false, reason: passed ? null : !commandPassed ? 'Supervised identity diagnostics did not complete successfully.' : identity.matched === null ? 'Protected identity must expose a comparable UID:GID or Windows SID before verification can pass.' : 'Supervised identity output does not match the protected execution identity.', evidence: { executed: true, operation_id: operation.operation_id, group_operation_id: groupOperationId, exit_code: operation.exit_code ?? null, actual_identity: identity.actual, configured_identity: String(job.payload.configured_identity ?? ''), identity_match: commandPassed ? identity.matched : null, verified_identity_required_by_dispatch: true, verification: 'supervised_identity_command', cancellation_test: 'not_run' } };
      } else if (capability === 'containers' && options.operations && job.payload.target_id && job.payload.grant) {
        const operation = await options.operations.executeControl(job, runtime, { step_id: 'containers:status', machine_id: machine, target_id: String(job.payload.target_id), kind: 'docker_container', verb: 'status', grant: job.payload.grant as PolicyGrant, policy_revision: Number(job.payload.policy_revision), max_log_bytes: 4096, mutating: false });
        if (operation.state === 'pending') { await runtime.wait(operation.reason, 2); return; }
        if (operation.state === 'unknown') { await stopProbe('interrupted', operation.reason); return; }
        if (operation.status === 'cancelled') { await stopProbe('cancelled', 'container_probe_cancelled'); return; }
        const status = operation.result?.status;
        const passed = operation.status === 'succeeded' && typeof status === 'string' && ['running', 'stopped', 'paused', 'restarting', 'exited', 'created', 'dead'].includes(status);
        result = { health_state: passed ? 'healthy' : 'degraded', supported: true, configured: true, permitted: true, reason: passed ? null : 'The enrolled container did not return a recognized status from its protected helper.', evidence: { executed: true, operation_id: operation.operation_id, target_id: String(job.payload.target_id), inspected_status: typeof status === 'string' ? status : null, container_running: passed ? status === 'running' : null, check: 'enrolled_container_status' } };
      } else if (options.probe && ['ssh', 'sftp', 'desktop'].includes(capability)) result = await options.probe(machine, job.requester_id, capability, typeof job.payload.auth_session_id === 'string' ? job.payload.auth_session_id : undefined);
      else result = { health_state: 'unsupported', supported: null, reason: 'No permitted adapter is configured for this capability.', evidence: { executed: false } };
    } catch (error) {
      if (await unresolvedProbe()) { await runtime.wait('probe_reconciliation_required', 5); return; }
      const candidate = (error as { code?: string; message?: string }).code ?? (error as Error).message;
      const code = typeof candidate === 'string' && /^[a-z0-9_]{1,80}$/.test(candidate) ? candidate : 'probe_failed';
      const denied = /denied|grant_revoked|grant_expired/.test(code);
      const unverified = /unverified|revision_conflict|context_required/.test(code);
      result = { health_state: denied ? 'permission_denied' : unverified ? 'unverified' : 'unreachable', reason: denied ? 'Current policy denies this capability test.' : unverified ? 'Execution identity or workspace configuration requires verification.' : 'Capability test could not complete; inspect connection settings and host availability.', evidence: { executed: true, code } };
    }
    await runtime.assertLease();
    const client = await runtime.db.connect();
    try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='10s'");
    await assertOwnedLease(client, job);
    const currentMachine = (await client.query('SELECT capabilities,boot_id,identity_generation FROM machines WHERE id=$1 AND owner_id=$2 FOR UPDATE', [machine, job.requester_id])).rows[0];
    if (!currentMachine) throw new Error('machine_not_found');
    if (credentialStamp !== null) {
      const current = await agentCredentialState(client, machine);
      const executed = result.evidence && typeof result.evidence === 'object' && !Array.isArray(result.evidence) ? result.evidence.executed ?? null : null;
      if (!current.active) result = { health_state: current.total ? 'permission_denied' : 'unconfigured', configured: current.total > 0, permitted: false, supported: null, reason: 'Agent credentials became unavailable before the test result was committed.', evidence: { executed, check: 'current_agent_certificate', prior_result: result.evidence } };
      else if (!expectedGeneration || expectedGeneration !== currentMachine.identity_generation || credentialStamp !== JSON.stringify(current.active_ids ?? []) || currentMachine.boot_id !== owned.rows[0].boot_id) result = { health_state: 'unverified', permitted: false, reason: 'Agent identity or boot changed during the test; rerun verification.', evidence: { executed, prior_result: result.evidence } };
    }
    const previous = (currentMachine.capabilities?.[capability] ?? {}) as Partial<Capability>;
    if (capability === 'runner' && result.evidence && typeof result.evidence === 'object' && !Array.isArray(result.evidence) && result.evidence.identity_match === false) await client.query('UPDATE execution_identities SET restriction_verified=false WHERE id=$1 AND owner_id=$2 AND machine_id=$3', [(job.payload.execution_context as ExecutionContext).execution_identity_id, job.requester_id, machine]);
    const now = new Date().toISOString();
    const state: Capability = { supported: result.supported !== undefined ? result.supported : previous.supported ?? null, configured: result.configured ?? previous.configured ?? false, permitted: result.permitted ?? previous.permitted ?? false, health_state: result.health_state, reason: result.reason, observed_at: result.observed_at ?? now, last_test_at: now, last_success_at: result.health_state === 'healthy' ? now : previous.last_success_at ?? null };
    if (capability === 'monitoring' && result.permitted === undefined && result.health_state !== 'permission_denied' && result.health_state !== 'unconfigured') { state.configured = true; state.permitted = true; }
    if (capability === 'runner' && result.health_state === 'healthy') { state.configured = true; state.permitted = true; }
    await client.query('UPDATE capability_tests SET state=$2,reason=$3,evidence=$4::jsonb,completed_at=now() WHERE id=$1 AND owner_id=$5', [job.id, result.health_state, result.reason, JSON.stringify(result.evidence), job.requester_id]);
    await client.query('UPDATE machines SET capabilities=jsonb_set(capabilities,ARRAY[$3::text],$4::jsonb) WHERE id=$1 AND owner_id=$2', [machine, job.requester_id, capability, JSON.stringify(state)]);
    await appendEventInTransaction(client, job.id, 'machine.capability_test', { machine_id: machine, capability, ...result });
    if (!(await client.query('SELECT id FROM jobs WHERE id=$1 AND lease_until>clock_timestamp()', [job.id])).rowCount) throw new LeaseLostError();
    await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await runtime.complete({ machine_id: machine, capability, ...result });
  };
}
