import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { quarantineMachineRequests } from '@homelab/transport';
import type { FastifyInstance } from 'fastify';
import { CapabilitySchema, ExecutionContextSchema, IdSchema, LimitsSchema, type Capability, type Machine, type PolicyGrant } from '@homelab/contracts';
import { submitJobInTransaction } from '@homelab/worker';
import type { ApiContext } from '../../core/context.js';
import { observationAgeMs, summarizeValues } from './telemetry.js';
import { MachineCreateSchema, MachineUpdateSchema, MachineTestSchema, MetricsQuerySchema } from './schemas.js';
import { authorityFromEnvironment } from './pki.js';
import { markAgentCredentialUnavailable } from './agent-credentials.js';
export { startAgentServer } from './agent-server.js';

const capabilityNames = ['monitoring', 'ssh', 'sftp', 'desktop', 'runner', 'containers'] as const;
const disabled = (message: string) => ({ error: { code: 'capability_disabled', message } });
const absent = () => ({ error: { code: 'not_found', message: 'Machine not found' } });
const agentConfigured = () => ['AGENT_TLS_KEY_FILE', 'AGENT_TLS_CERT_FILE', 'AGENT_CA_CERT_FILE', 'AGENT_CA_KEY_FILE'].every(field => !!process.env[field]);

function initialCapabilities(): Record<string, Capability> {
  return Object.fromEntries(capabilityNames.map(name => [name, CapabilitySchema.parse({ supported: null, configured: false, permitted: false, health_state: 'unconfigured', observed_at: null, last_test_at: null, last_success_at: null, reason: 'Capability has not been configured or tested.' })]));
}

function displayMachine(row: Machine & { last_seen_at?: string | Date | null }) {
  const capabilities = Object.fromEntries(Object.entries(row.capabilities).map(([name, value]) => {
    // Reads may age a previously healthy test; they never promote an untested capability.
    let observed = value.observed_at ? Date.parse(value.observed_at) : NaN;
    if (name === 'monitoring' && row.last_seen_at) {
      const received = typeof row.last_seen_at === 'string' ? Date.parse(row.last_seen_at) : row.last_seen_at.getTime();
      observed = Math.min(observed, received);
    }
    return [name, { ...value, health_state: value.health_state === 'healthy' && (!Number.isFinite(observed) || Date.now() - observed > 60000) ? 'stale' : value.health_state }];
  }));
  return { ...row, capabilities };
}

export default async function register(app: FastifyInstance, context: ApiContext): Promise<void> {
  const { db } = context;
  app.get('/machines', async request => {
    const result = await db.query("SELECT id,owner_id,name,os,hostname,tags,revision,capabilities,inventory,boot_id,agent_version,last_seen_at,created_at,COALESCE((config->>'max_concurrent_operations')::integer,1) AS max_concurrent_operations FROM machines WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 500", [request.actor!.id]);
    return { items: result.rows.map(displayMachine) };
  });

  app.post('/machines', async (request, reply) => {
    const parsed = MachineCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid machine definition', details: parsed.error.flatten() } });
    const id = randomUUID();
    const result = await db.query("INSERT INTO machines(id,owner_id,name,os,tags,capabilities,config) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) RETURNING id,owner_id,name,os,hostname,tags,revision,capabilities,created_at,COALESCE((config->>'max_concurrent_operations')::integer,1) AS max_concurrent_operations", [id, request.actor!.id, parsed.data.name, parsed.data.os, JSON.stringify(parsed.data.tags), JSON.stringify(initialCapabilities()), JSON.stringify({ max_concurrent_operations: parsed.data.max_concurrent_operations })]);
    await context.audit(request.actor!.id, 'machine.create', id, 'success');
    return reply.code(201).send(displayMachine(result.rows[0]));
  });

  app.get<{ Params: { id: string } }>('/machines/:id', async (request, reply) => {
    if (!IdSchema.safeParse(request.params.id).success) return reply.code(404).send(absent());
    const result = await db.query("SELECT id,owner_id,name,os,hostname,tags,revision,capabilities,inventory,boot_id,agent_version,last_seen_at,created_at,COALESCE((config->>'max_concurrent_operations')::integer,1) AS max_concurrent_operations FROM machines WHERE id=$1 AND owner_id=$2", [request.params.id, request.actor!.id]);
    if (!result.rowCount) return reply.code(404).send(absent());
    const tests = await db.query('SELECT id,capability,state,reason,evidence,created_at,completed_at FROM capability_tests WHERE machine_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 100', [request.params.id, request.actor!.id]);
    return { ...displayMachine(result.rows[0]), tests: tests.rows, enrollment: { available: agentConfigured(), reason: agentConfigured() ? null : 'Configure the dedicated agent TLS listener and CA files.' } };
  });

  for (const [path, hostPath] of [['host-identities', '/v1/identities'], ['roots', '/v1/roots'], ['host-targets', '/v1/targets']] as const) {
    app.get<{ Params: { id: string } }>(`/machines/:id/${path}`, async (request, reply) => {
      if (!IdSchema.safeParse(request.params.id).success) return reply.code(404).send(absent());
      const owned = await db.query('SELECT id,identity_generation FROM machines WHERE id=$1 AND owner_id=$2', [request.params.id, request.actor!.id]);
      if (!owned.rowCount) return reply.code(404).send(absent());
      if (!context.agentBroker) return reply.code(503).send(disabled('Agent RPC broker is not configured.'));
      return context.agentBroker.rpc(request.params.id, 'GET', hostPath, null, { ownerId: request.actor!.id, expectedMachineGeneration: owned.rows[0].identity_generation, timeoutMs: 20000 });
    });
  }

  app.post<{ Params: { id: string; host_identity_id: string } }>('/machines/:id/execution-identities/:host_identity_id/verify', async (request, reply) => {
    if (!IdSchema.safeParse(request.params.id).success || !IdSchema.safeParse(request.params.host_identity_id).success) return reply.code(404).send(absent());
    z.object({}).strict().parse(request.body ?? {});
    const owned = await db.query('SELECT id,identity_generation FROM machines WHERE id=$1 AND owner_id=$2', [request.params.id, request.actor!.id]);
    if (!owned.rowCount) return reply.code(404).send(absent());
    if (!context.agentBroker) return reply.code(503).send(disabled('Agent RPC broker is not configured.'));
    const result = await context.agentBroker.rpc(request.params.id, 'POST', `/v1/identities/${request.params.host_identity_id}/verify`, {}, { ownerId: request.actor!.id, expectedMachineGeneration: owned.rows[0].identity_generation, timeoutMs: 60000 });
    await context.audit(request.actor!.id, 'machine.execution_identity.verify', request.params.id, 'completed', { identity_id: request.params.host_identity_id });
    return result;
  });

  app.patch<{ Params: { id: string } }>('/machines/:id', async (request, reply) => {
    const parsed = MachineUpdateSchema.safeParse(request.body);
    if (!IdSchema.safeParse(request.params.id).success) return reply.code(404).send(absent());
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid machine update' } });
    const { name, tags, revision, max_concurrent_operations } = parsed.data;
    const result = await db.query("UPDATE machines SET name=COALESCE($1,name),tags=COALESCE($2::jsonb,tags),config=jsonb_set(config,'{max_concurrent_operations}',to_jsonb(COALESCE($6::integer,(config->>'max_concurrent_operations')::integer,1))),revision=revision+1 WHERE id=$3 AND owner_id=$4 AND revision=$5 RETURNING id,owner_id,name,os,hostname,tags,revision,capabilities,created_at,COALESCE((config->>'max_concurrent_operations')::integer,1) AS max_concurrent_operations", [name ?? null, tags ? JSON.stringify(tags) : null, request.params.id, request.actor!.id, revision, max_concurrent_operations ?? null]);
    if (!result.rowCount) {
      const existing = await db.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2', [request.params.id, request.actor!.id]);
      return reply.code(existing.rowCount ? 409 : 404).send(existing.rowCount ? { error: { code: 'revision_conflict', message: 'Machine configuration changed; reload before saving.' } } : absent());
    }
    await context.audit(request.actor!.id, 'machine.update', request.params.id, 'success');
    return displayMachine(result.rows[0]);
  });

  app.delete<{ Params: { id: string } }>('/machines/:id', async (request, reply) => {
    if (!IdSchema.safeParse(request.params.id).success) return reply.code(404).send(absent());
    try {
      // Foreign keys protect enrolled identities, workspaces, observations and retained history.
      const result = await db.query('DELETE FROM machines WHERE id=$1 AND owner_id=$2 RETURNING id', [request.params.id, request.actor!.id]);
      if (!result.rowCount) return reply.code(404).send(absent());
      await context.audit(request.actor!.id, 'machine.delete', request.params.id, 'success');
      return reply.code(204).send();
    } catch (error) {
      if ((error as { code?: string }).code === '23503') return reply.code(409).send({ error: { code: 'machine_in_use', message: 'Machine has retained references and cannot be deleted.' } });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/machines/:id/certificates', async (request, reply) => {
    if (!IdSchema.safeParse(request.params.id).success) return reply.code(404).send(absent());
    const machine = await db.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2', [request.params.id, request.actor!.id]);
    if (!machine.rowCount) return reply.code(404).send(absent());
    const certificates = await db.query('SELECT id,serial,protocol_version,expires_at,revoked_at,created_at FROM agent_certificates WHERE machine_id=$1 ORDER BY created_at DESC LIMIT 100', [request.params.id]);
    return { items: certificates.rows };
  });

  app.post<{ Params: { id: string; certificate_id: string } }>('/machines/:id/certificates/:certificate_id/revoke', async (request, reply) => {
    if (!IdSchema.safeParse(request.params.id).success || !IdSchema.safeParse(request.params.certificate_id).success) return reply.code(404).send(absent());
    const client = await db.connect();
    let revoked;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2 FOR UPDATE', [request.params.id, request.actor!.id]);
      const result = await client.query('UPDATE agent_certificates SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND machine_id=$2 AND EXISTS(SELECT 1 FROM machines WHERE id=$2 AND owner_id=$3) RETURNING id,serial,revoked_at', [request.params.certificate_id, request.params.id, request.actor!.id]);
      if (!result.rowCount) { await client.query('ROLLBACK'); return reply.code(404).send(absent()); }
      revoked = result.rows[0];
      if (await markAgentCredentialUnavailable(client, request.params.id)) await quarantineMachineRequests(client, request.params.id);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await context.audit(request.actor!.id, 'machine.certificate.revoke', request.params.id, 'success', { certificate_id: request.params.certificate_id });
    return { ...revoked, transport_available: agentConfigured(), reason: 'Revoked certificate is denied on every subsequent agent TLS request.' };
  });

  app.post<{ Params: { id: string } }>('/machines/:id/tests', async (request, reply) => {
    if (!IdSchema.safeParse(request.params.id).success) return reply.code(404).send(absent());
    const parsed = MachineTestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: 'Select a capability and idempotency key. Runner tests also require a workspace, execution identity and persisted grant.' } });
    const machine = await db.query('SELECT id,identity_generation FROM machines WHERE id=$1 AND owner_id=$2', [request.params.id, request.actor!.id]);
    if (!machine.rowCount) return reply.code(404).send(absent());
    let runnerPayload = {};
    if (parsed.data.runner) {
      const selected = parsed.data.runner;
      const workspace = (await db.query("SELECT * FROM workspaces WHERE id=$1 AND owner_id=$2 AND machine_id=$3 AND state='active'", [selected.workspace_id, request.actor!.id, request.params.id])).rows[0];
      const identity = (await db.query('SELECT * FROM execution_identities WHERE id=$1 AND owner_id=$2 AND machine_id=$3', [selected.execution_identity_id, request.actor!.id, request.params.id])).rows[0];
      if (!workspace || !identity) return reply.code(404).send(absent());
      const grant = (await db.query<PolicyGrant>('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2', [selected.grant_id, request.actor!.id])).rows[0];
      const decision = context.policy({ actor: request.actor!, tool: 'run_command', machine_id: request.params.id, workspace_id: workspace.id, grant, current_grant: grant });
      if (!decision.allowed) return reply.code(403).send({ error: { code: decision.code, message: decision.reason } });
      const limits = LimitsSchema.parse({ max_tool_steps: 2, wall_time_seconds: 120, per_command_timeout_seconds: 10, max_output_bytes: 32768 });
      runnerPayload = { grant, limits, execution_context: ExecutionContextSchema.parse({ schema_version: 1, execution_machine_id: request.params.id, execution_identity_id: identity.id, workspace_id: workspace.id, workspace_revision: workspace.revision, environment_id: workspace.environment_id, environment_generation: workspace.environment_generation, project_instruction_revision: workspace.instruction_revision, profile_id: null, profile_revision: null, policy_revision: decision.policy_revision, limits }), configured_identity: identity.os_identity };
    }
    if (parsed.data.container) {
      const selected = parsed.data.container;
      const target = (await db.query("SELECT id,kind,config FROM service_targets WHERE id=$1 AND owner_id=$2 AND machine_id=$3 AND kind='docker_container'", [selected.target_id, request.actor!.id, request.params.id])).rows[0];
      if (!target) return reply.code(404).send(absent());
      if (!target.config?.allowed_operations?.includes('status')) return reply.code(403).send({ error: { code: 'target_scope_denied', message: 'The enrolled container target does not permit status inspection.' } });
      const grant = (await db.query<PolicyGrant>('SELECT * FROM permission_grants WHERE id=$1 AND owner_id=$2', [selected.grant_id, request.actor!.id])).rows[0];
      const decision = context.policy({ actor: request.actor!, tool: 'actions.run', machine_id: request.params.id, grant, current_grant: grant });
      if (!decision.allowed) return reply.code(403).send({ error: { code: decision.code, message: decision.reason } });
      runnerPayload = { grant, target_id: target.id, policy_revision: decision.policy_revision, limits: LimitsSchema.parse({ max_tool_steps: 1, wall_time_seconds: 120, per_command_timeout_seconds: 10, max_output_bytes: 32768 }) };
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const job = await submitJobInTransaction(client, { requester_id: request.actor!.id, idempotency_key: parsed.data.idempotency_key, context: null, kind: 'capability_test', payload: { machine_id: request.params.id, machine_identity_generations: { [request.params.id]: machine.rows[0].identity_generation }, test: parsed.data.capability, auth_session_id: parsed.data.capability === 'desktop' ? request.sessionId : null, ...runnerPayload }, modifies_workspace: !!parsed.data.runner, workspace_id: parsed.data.runner?.workspace_id ?? null });
      await client.query("INSERT INTO capability_tests(id,owner_id,machine_id,capability,state,reason,evidence) VALUES($1,$2,$3,$4,'queued',NULL,$5::jsonb) ON CONFLICT(id) DO NOTHING", [job.id, request.actor!.id, request.params.id, parsed.data.capability, JSON.stringify({ job_id: job.id, executed: false })]);
      await client.query('COMMIT');
      await context.audit(request.actor!.id, 'machine.test.request', request.params.id, 'queued', { capability: parsed.data.capability, job_id: job.id });
      return reply.code(202).send({ id: job.id, job_id: job.id, capability: parsed.data.capability, state: job.state, available: true, reason: job.reason, message: 'Capability test queued. Read retained evidence for the actual result.' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  app.get<{ Params: { id: string } }>('/machines/:id/metrics', async (request, reply) => {
    if (!IdSchema.safeParse(request.params.id).success) return reply.code(404).send(absent());
    const parsed = MetricsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', message: 'A bounded valid metric time range and resolution are required.' } });
    const { from, to, limit, resolution } = parsed.data;
    const machine = await db.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2', [request.params.id, request.actor!.id]);
    if (!machine.rowCount) return reply.code(404).send(absent());
    const metricClient = await db.connect();
    try {
    // One snapshot prevents maintenance from moving rows between the raw and rollup reads.
    await metricClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await metricClient.query('SELECT id,boot_id,sequence,series,device_id,value,unit,availability,reason,source,kind,collection_interval_seconds,observed_at,received_at FROM metric_samples WHERE machine_id=$1 AND observed_at >= $2 AND observed_at <= $3 ORDER BY observed_at,id LIMIT $4', [request.params.id, from, to, limit + 1]);
    const truncated = result.rows.length > limit;
    const rows = result.rows.slice(0, limit).map(row => {
      const age_ms = observationAgeMs(new Date(row.observed_at).toISOString(), new Date(row.received_at).toISOString());
      return { ...row, value: row.value === null ? null : Number(row.value), age_ms, stale: age_ms === null || age_ms > 60000 };
    });
    if (resolution === 'raw') { await metricClient.query('COMMIT'); return { items: rows, from, to, resolution, truncated, availability: rows.length ? 'observed' : 'unavailable', reason: rows.length ? null : 'No observations in the requested range.' }; }
    const interval = resolution === '5m' ? 300000 : 3600000;
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = Math.floor(new Date(row.observed_at).getTime() / interval) * interval;
      const key = JSON.stringify([bucket, row.boot_id, row.series, row.device_id, row.unit, row.source, row.kind]);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const items = [...groups.entries()].map(([key, group]) => {
      const [bucket, boot_id, series, device_id, unit, source, kind] = JSON.parse(key);
      return { bucket: new Date(bucket).toISOString(), boot_id, series, device_id, unit, source, kind, ...summarizeValues(group.map(row => row.availability === 'available' ? row.value : null)), reasons: [...new Set(group.map(row => row.reason).filter(Boolean))], observed_at: group[group.length - 1]!.observed_at, received_at: group.reduce((latest, row) => new Date(row.received_at) > new Date(latest) ? row.received_at : latest, group[0]!.received_at) };
    });
    const stored = await metricClient.query('SELECT * FROM metric_rollups WHERE machine_id=$1 AND resolution=$2 AND bucket >= $3 AND bucket <= $4 ORDER BY bucket,series,device_id LIMIT $5', [request.params.id, resolution, new Date(Math.floor(Date.parse(from) / interval) * interval), to, limit + 1]);
    const keyOf = (row: typeof items[number]) => JSON.stringify([row.bucket, row.boot_id, row.series, row.device_id, row.unit, row.source, row.kind]);
    const merged = new Map(items.map(row => [keyOf(row), row]));
    for (const saved of stored.rows.slice(0, limit)) {
      const row: typeof items[number] = { bucket: new Date(saved.bucket).toISOString(), boot_id: saved.boot_id, series: saved.series, device_id: saved.device_id, unit: saved.unit, source: saved.source, kind: saved.kind, min: saved.min, max: saved.max, mean: saved.mean, count: saved.count, missing: saved.missing_count ?? 0, reasons: saved.missing_count ? ['Detailed unavailable reasons expired with source samples.'] : [], observed_at: saved.last_observed_at, received_at: saved.last_received_at };
      const old = merged.get(keyOf(row));
      if (old) {
        const total = row.count + old.count;
        row.mean = total ? (row.mean ?? 0) * (row.count / total) + (old.mean ?? 0) * (old.count / total) : null;
        row.min = row.min === null ? old.min : old.min === null ? row.min : Math.min(row.min, old.min);
        row.max = row.max === null ? old.max : old.max === null ? row.max : Math.max(row.max, old.max);
        row.count = total; row.missing += old.missing; row.reasons.push(...old.reasons);
        if (new Date(old.observed_at) > new Date(row.observed_at)) row.observed_at = old.observed_at;
        if (new Date(old.received_at) > new Date(row.received_at)) row.received_at = old.received_at;
      }
      merged.set(keyOf(row), row);
    }
    const all = [...merged.values()].sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket));
    await metricClient.query('COMMIT');
    return { items: all.slice(0, limit), from, to, resolution, truncated: truncated || stored.rows.length > limit || all.length > limit, gaps_preserved: true, boundary_buckets_may_extend_range: true, availability: all.length ? 'observed' : 'unavailable', reason: all.length ? null : 'No observations in the requested range.' };
    } catch (error) { await metricClient.query('ROLLBACK'); throw error; } finally { metricClient.release(); }
  });

  app.post<{ Params: { id: string } }>('/machines/:id/enrollments', async (request, reply) => {
    if (!IdSchema.safeParse(request.params.id).success) return reply.code(404).send(absent());
    const machine = await db.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2', [request.params.id, request.actor!.id]);
    if (!machine.rowCount) return reply.code(404).send(absent());
    if (!agentConfigured() || !await authorityFromEnvironment()) return reply.code(503).send(disabled('Configure the dedicated agent TLS listener and CA files before enrollment.'));
    const body = z.object({ re_enroll: z.boolean().default(false) }).strict().parse(request.body ?? {});
    const client = await db.connect();
    const token = randomBytes(32).toString('base64url');
    const expires_at = new Date(Date.now() + 10 * 60000).toISOString();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM machines WHERE id=$1 AND owner_id=$2 FOR UPDATE', [request.params.id, request.actor!.id]);
      const existing = await client.query('SELECT id FROM agent_certificates WHERE machine_id=$1 AND revoked_at IS NULL AND expires_at>now() LIMIT 1', [request.params.id]);
      if (existing.rowCount && !body.re_enroll) { await client.query('ROLLBACK'); return reply.code(409).send({ error: { code: 're_enrollment_required', message: 'An installation is already enrolled. Explicitly request re_enroll to replace it.' } }); }
      // Issuing another pending token invalidates its predecessors, without revoking the installed agent yet.
      await client.query('UPDATE agent_enrollments SET expires_at=now() WHERE machine_id=$1 AND consumed_at IS NULL', [request.params.id]);
      const id = randomUUID();
      await client.query('INSERT INTO agent_enrollments(id,machine_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [id, request.params.id, createHash('sha256').update(token).digest('hex'), expires_at]);
      await client.query('COMMIT');
      await context.audit(request.actor!.id, 'machine.enrollment.issue', request.params.id, 'success', { enrollment_id: id, re_enroll: body.re_enroll });
      return reply.code(201).header('Cache-Control', 'no-store').send({ id, machine_id: request.params.id, token, expires_at, protocol_version: 1, endpoint_path: '/agent/v1/enroll', instruction: 'Provide this one-use token through protected agent input. Trust the configured agent CA explicitly.' });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
}

/** Public bootstrap endpoints remain closed until actual TLS identity verification is wired. */
export async function registerAgentRoutes(app: FastifyInstance, _context: ApiContext): Promise<void> {
  for (const path of ['/agent/enroll', '/agent/telemetry', '/agent/rotate']) {
    app.post(path, async (_request, reply) => reply.code(503).send(disabled('Agent certificate transport and issuance are not configured.')));
  }
}

