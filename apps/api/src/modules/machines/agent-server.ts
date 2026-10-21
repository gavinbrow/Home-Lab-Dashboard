import Fastify, { type FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TLSSocket } from 'node:tls';
import { z } from 'zod';
import { publicDispatchKey, canonicalJson, quarantineMachineRequests } from '@homelab/transport';
import type { PoolClient } from 'pg';
import type { ApiContext } from '../../core/context.js';
import { loadAuthority, type CertificateAuthority, type IssuedCertificate } from './pki.js';

const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const enrollSchema = z.object({ token: z.string().min(32).max(256), csr_pem: z.string().min(100).max(16384), protocol_version: z.literal(1) }).strict();
const rotateSchema = enrollSchema.omit({ token: true });
const metricSchema = z.object({ name: z.string().min(1).max(128), device_id: z.string().max(256), value: z.number().finite().nullable(), unit: z.string().min(1).max(48), availability: z.enum(['available', 'unavailable']), reason: z.string().max(1024).nullable(), source: z.string().min(1).max(128), kind: z.enum(['gauge', 'counter', 'rate']).optional(), observed_at: z.iso.datetime({ offset: true }) }).strict().refine(v => v.availability === 'available' ? v.value !== null : v.value === null && !!v.reason);
const sampleSchema = z.object({ schema_version: z.literal(1), machine_id: z.uuid(), boot_id: z.string().min(1).max(128), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), collection_interval_seconds: z.number().finite().positive().max(86400).nullable().optional(), observed_at: z.iso.datetime({ offset: true }), inventory: z.object({ hostname: z.string().max(255), os: z.enum(['windows', 'linux']), platform: z.string().max(255), platform_version: z.string().max(255), architecture: z.string().max(64), logical_cores: z.number().int().min(1).max(65536), agent_version: z.string().max(64), memory_definition: z.string().max(1024), gpu_devices: z.array(z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(256), vendor: z.literal('NVIDIA') }).strict()).max(256).optional() }).strict(), metrics: z.array(metricSchema).max(4096) }).strict();
const fail = (statusCode: number, code: string, message: string): never => { throw Object.assign(new Error(message), { statusCode, code }); };
interface Identity { machine_id: string; certificate_id: string; serial: string }
async function insertCertificate(client: PoolClient, machine: string, issued: IssuedCertificate) {
  await client.query('INSERT INTO agent_certificates(id,machine_id,serial,protocol_version,expires_at,certificate_pem,fingerprint_sha256,public_key_fingerprint) VALUES($1,$2,$3,1,$4,$5,$6,$7)', [randomUUID(), machine, issued.serial, issued.expires_at, issued.certificate_pem, issued.fingerprint, issued.public_key_fingerprint]);
}
async function assertWritable(client: PoolClient) {
  const control = await client.query('SELECT restore_mode FROM runtime_control WHERE singleton=true FOR SHARE');
  if (process.env.RESTORE_MODE === 'true' || !control.rowCount || control.rows[0].restore_mode) return fail(503, 'restore_mode', 'Agent writes are disabled during restore');
}

export interface AgentTlsMaterial { key: string; cert: string; ca: string; authority: CertificateAuthority }
/** Native TLS authorization is mandatory. No header, cookie, or browser actor can supply identity. */
export function createAgentServer(context: ApiContext, material: AgentTlsMaterial) {
  const app = Fastify({ https: { key: material.key, cert: material.cert, ca: material.ca, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2' }, logger: false, bodyLimit: 8 * 1024 * 1024, requestTimeout: 95000, trustProxy: false });
  const identities = new WeakMap<FastifyRequest, Identity>();
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid agent request' } });
    const status = e.statusCode ?? 500;
    return reply.code(status).send({ error: { code: status < 500 ? e.code ?? 'agent_request_rejected' : 'internal_error', message: status < 500 ? e.message : 'Agent request could not be completed' } });
  });
  app.addHook('onRequest', async request => {
    const socket = request.raw.socket;
    if (!(socket instanceof TLSSocket) || !socket.encrypted) return fail(401, 'tls_required', 'Native TLS is required');
    // The sole certificate-free route still requires encrypted server-authenticated TLS plus a one-use token.
    if (request.method === 'POST' && request.url === '/agent/v1/enroll') {
      const control = await context.db.query('SELECT restore_mode FROM runtime_control WHERE singleton=true');
      if (process.env.RESTORE_MODE === 'true' || !control.rowCount || control.rows[0].restore_mode) return fail(503, 'restore_mode', 'Agent enrollment is disabled during restore');
      return;
    }
    if (!socket.authorized) return fail(401, 'client_certificate_required', 'A trusted client certificate is required');
    const peer = socket.getPeerCertificate();
    if (!peer.fingerprint256 || !peer.raw) return fail(401, 'client_certificate_required', 'A client certificate is required');
    const row = await context.db.query('SELECT id,machine_id FROM agent_certificates WHERE fingerprint_sha256=$1 AND serial=$2 AND revoked_at IS NULL AND expires_at>now() AND protocol_version=1', [peer.fingerprint256, peer.serialNumber]);
    if (row.rowCount !== 1) return fail(403, 'certificate_revoked_or_unknown', 'Certificate is revoked, expired, unknown, or incompatible');
    identities.set(request, { machine_id: row.rows[0].machine_id, certificate_id: row.rows[0].id, serial: peer.serialNumber });
    // The broker independently restricts restore traffic to newly signed, current-epoch
    // receipt/binding reads. Keeping these authenticated transports open permits reconciliation.
    if (request.method === 'POST' && (request.url === '/agent/v1/poll' || request.url === '/agent/v1/results')) return;
    const control = await context.db.query('SELECT restore_mode FROM runtime_control WHERE singleton=true');
    if (process.env.RESTORE_MODE === 'true' || !control.rowCount || control.rows[0].restore_mode) return fail(503, 'restore_mode', 'Agent requests are disabled during restore');
  });

  app.post('/agent/v1/enroll', { bodyLimit: 20 * 1024 }, async request => {
    if ((request.body as { protocol_version?: unknown } | null)?.protocol_version !== 1) return fail(426, 'agent_upgrade_required', 'Agent protocol 1 is required');
    const body = enrollSchema.parse(request.body);
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      await assertWritable(client);
      const pending = await client.query('SELECT machine_id FROM agent_enrollments WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()', [tokenHash(body.token)]);
      if (!pending.rowCount) return fail(401, 'enrollment_invalid', 'Enrollment token is expired, consumed, or invalid');
      // Match token issuance/revocation lock order, then revalidate after any wait.
      await client.query('SELECT id FROM machines WHERE id=$1 FOR UPDATE', [pending.rows[0].machine_id]);
      const enrollment = await client.query('SELECT id,machine_id FROM agent_enrollments WHERE token_hash=$1 AND machine_id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE', [tokenHash(body.token), pending.rows[0].machine_id]);
      if (!enrollment.rowCount) return fail(401, 'enrollment_invalid', 'Enrollment token is expired, consumed, or invalid');
      const machine = enrollment.rows[0].machine_id as string;
      const issued = await material.authority.issue(body.csr_pem, machine);
      await client.query('UPDATE agent_certificates SET revoked_at=COALESCE(revoked_at,now()) WHERE machine_id=$1', [machine]);
      await quarantineMachineRequests(client, machine);
      await client.query('UPDATE execution_identities SET restriction_verified=false WHERE machine_id=$1 AND restriction_verified=true', [machine]);
      const reset = (configured: boolean) => ({ supported: null, configured, permitted: configured, health_state: 'unverified', observed_at: null, last_test_at: null, last_success_at: null, reason: 'Agent identity enrolled; rerun independent capability verification.' });
      const installed = await client.query("UPDATE machines SET identity_generation=gen_random_uuid(),boot_id=NULL,last_seen_at=NULL,agent_version=NULL,inventory='{}'::jsonb,capabilities=capabilities||$2::jsonb WHERE id=$1 RETURNING identity_generation", [machine, JSON.stringify({ monitoring: reset(true), runner: reset(false), containers: reset(false) })]);
      await insertCertificate(client, machine, issued);
      await client.query('UPDATE agent_enrollments SET consumed_at=now() WHERE id=$1', [enrollment.rows[0].id]);
      await client.query('COMMIT');
      await context.audit(null, 'agent.enroll', machine, 'success', { serial: issued.serial, protocol_version: 1 });
      const control = await context.db.query('SELECT dispatch_epoch FROM runtime_control WHERE singleton=true');
      return { machine_id: machine, machine_identity_generation: installed.rows[0].identity_generation, certificate_pem: issued.certificate_pem, ca_pem: issued.ca_pem, expires_at: issued.expires_at, serial: issued.serial, dispatch_key: context.agentBroker?.signer ? publicDispatchKey(context.agentBroker.signer) : null, dispatch_epoch: control.rows[0]?.dispatch_epoch ?? null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });

  app.post('/agent/v1/rotate', { bodyLimit: 20 * 1024 }, async request => {
    if ((request.body as { protocol_version?: unknown } | null)?.protocol_version !== 1) return fail(426, 'agent_upgrade_required', 'Agent protocol 1 is required');
    const body = rotateSchema.parse(request.body);
    const identity = identities.get(request)!;
    const issued = await material.authority.issue(body.csr_pem, identity.machine_id);
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      await assertWritable(client);
      const installed = await client.query('SELECT id,identity_generation FROM machines WHERE id=$1 FOR UPDATE', [identity.machine_id]);
      const current = await client.query('SELECT id FROM agent_certificates WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE', [identity.certificate_id]);
      if (!current.rowCount) return fail(403, 'certificate_revoked', 'Certificate was revoked');
      await insertCertificate(client, identity.machine_id, issued);
      await client.query('UPDATE agent_certificates SET revoked_at=now() WHERE id=$1', [identity.certificate_id]);
      await client.query('COMMIT');
      await context.audit(null, 'agent.rotate', identity.machine_id, 'success', { serial: issued.serial });
      const control = await context.db.query('SELECT dispatch_epoch FROM runtime_control WHERE singleton=true');
      return { machine_id: identity.machine_id, machine_identity_generation: installed.rows[0].identity_generation, certificate_pem: issued.certificate_pem, ca_pem: issued.ca_pem, expires_at: issued.expires_at, serial: issued.serial, dispatch_key: context.agentBroker?.signer ? publicDispatchKey(context.agentBroker.signer) : null, dispatch_epoch: control.rows[0]?.dispatch_epoch ?? null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });

  app.post('/agent/v1/telemetry', async request => {
    const body = sampleSchema.parse(request.body);
    const machine = identities.get(request)!.machine_id;
    if (body.machine_id !== machine) return fail(403, 'machine_mismatch', 'Certificate cannot submit another machine identity');
    if (Date.parse(body.observed_at) - Date.now() > 300000 || Date.now() - Date.parse(body.observed_at) > 86400000 || body.metrics.some(m => Math.abs(Date.parse(m.observed_at) - Date.parse(body.observed_at)) > 300000)) return fail(400, 'clock_skew', 'Telemetry clock skew exceeds bounds');
    if (new Set(body.metrics.map(m => JSON.stringify([m.name, m.device_id]))).size !== body.metrics.length) return fail(400, 'duplicate_series', 'Sample contains duplicate series identities');
    const client = await context.db.connect();
    try {
      await client.query('BEGIN');
      await assertWritable(client);
      await client.query('SELECT id FROM machines WHERE id=$1 FOR UPDATE', [machine]);
      const credential = await client.query('SELECT id FROM agent_certificates WHERE id=$1 AND machine_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND protocol_version=1 FOR SHARE', [identities.get(request)!.certificate_id, machine]);
      if (!credential.rowCount) return fail(403, 'certificate_revoked', 'Certificate is no longer authorized');
      const payloadHash = tokenHash(canonicalJson(body));
      const batch = await client.query('INSERT INTO agent_telemetry_batches(machine_id,boot_id,sequence,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT(machine_id,boot_id,sequence) DO NOTHING RETURNING sequence', [machine, body.boot_id, body.sequence, payloadHash]);
      if (!batch.rowCount) {
        const old = await client.query('SELECT payload_hash FROM agent_telemetry_batches WHERE machine_id=$1 AND boot_id=$2 AND sequence=$3', [machine, body.boot_id, body.sequence]);
        if (old.rows[0].payload_hash !== payloadHash) return fail(409, 'sample_conflict', 'Sequence already refers to different telemetry');
        await client.query('COMMIT'); return { accepted: true, duplicate: true, sequence: body.sequence };
      }
      await client.query('INSERT INTO agent_boot_sequences(machine_id,boot_id,last_sequence,last_observed_at) VALUES($1,$2,0,$3) ON CONFLICT(machine_id,boot_id) DO NOTHING', [machine, body.boot_id, body.observed_at]);
      await client.query('SELECT last_sequence FROM agent_boot_sequences WHERE machine_id=$1 AND boot_id=$2 FOR UPDATE', [machine, body.boot_id]);
      for (const metric of body.metrics) await client.query('INSERT INTO metric_samples(machine_id,boot_id,sequence,series,device_id,value,unit,availability,reason,source,observed_at,collection_interval_seconds,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [machine, body.boot_id, body.sequence, metric.name, metric.device_id, metric.value, metric.unit, metric.availability, metric.reason, metric.source, metric.observed_at, body.collection_interval_seconds ?? null, metric.kind ?? 'gauge']);
      await client.query('UPDATE agent_boot_sequences SET last_sequence=GREATEST(last_sequence,$3),last_observed_at=GREATEST(last_observed_at,$4::timestamptz) WHERE machine_id=$1 AND boot_id=$2', [machine, body.boot_id, body.sequence, body.observed_at]);
      const monitoring = { supported: true, configured: true, permitted: true, health_state: 'unverified', observed_at: body.observed_at, last_test_at: null, last_success_at: null, reason: 'Receiving telemetry; run the independent monitoring test.' };
      await client.query("UPDATE machines SET hostname=$2,os=$3,inventory=$4::jsonb,capabilities=jsonb_set(capabilities,'{monitoring}',CASE WHEN capabilities->'monitoring'->>'health_state'='healthy' THEN (capabilities->'monitoring') || jsonb_build_object('observed_at',$5::text) ELSE $6::jsonb END),last_seen_at=now(),boot_id=$7,agent_version=$8,updated_at=now() WHERE id=$1 AND (capabilities->'monitoring'->>'observed_at' IS NULL OR (capabilities->'monitoring'->>'observed_at')::timestamptz <= $5::timestamptz)", [machine, body.inventory.hostname, body.inventory.os, JSON.stringify(body.inventory), body.observed_at, JSON.stringify(monitoring), body.boot_id, body.inventory.agent_version]);
      await client.query('COMMIT');
      return { accepted: true, duplicate: false, sequence: body.sequence };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });

  const binding = (request: FastifyRequest, machine: string) => { if (identities.get(request)!.machine_id !== machine) return fail(403, 'machine_mismatch', 'Certificate machine identity mismatch'); };
  app.post('/agent/v1/poll', { bodyLimit: 4096 }, async request => {
    const body = z.object({ schema_version: z.literal(1), machine_id: z.uuid(), boot_id: z.string().min(1).max(128), max_requests: z.number().int().min(1).max(8).default(1) }).strict().parse(request.body);
    binding(request, body.machine_id);
    if (!context.agentBroker?.signer) return fail(503, 'relay_unconfigured', 'Agent RPC broker and dispatch signer are not configured');
    return { requests: await context.agentBroker.claim(body.machine_id, body.max_requests, identities.get(request)!.serial), server_time: new Date().toISOString() };
  });
  app.post('/agent/v1/results', { bodyLimit: 96 * 1024 * 1024 }, async request => {
    const body = z.object({ schema_version: z.literal(1), machine_id: z.uuid(), id: z.uuid(), status: z.number().int().min(200).max(599), body: z.json() }).strict().parse(request.body);
    binding(request, body.machine_id);
    if (!context.agentBroker) return fail(503, 'relay_unconfigured', 'Agent RPC broker is not configured');
    await context.agentBroker.respond(body.machine_id, body.id, body.status, body.body, identities.get(request)!.serial);
    return { accepted: true };
  });
  return app;
}

export async function startAgentServer(context: ApiContext) {
  const fields = ['AGENT_TLS_KEY_FILE', 'AGENT_TLS_CERT_FILE', 'AGENT_CA_CERT_FILE', 'AGENT_CA_KEY_FILE'] as const;
  if (fields.every(field => !process.env[field])) return null;
  if (fields.some(field => !process.env[field])) throw new Error('Agent TLS requires all certificate and key files');
  const [key, cert, ca, caKey] = await Promise.all(fields.map(field => readFile(process.env[field]!, 'utf8')));
  const app = createAgentServer(context, { key: key!, cert: cert!, ca: ca!, authority: await loadAuthority(ca!, caKey!) });
  await app.listen({ host: process.env.AGENT_HOST ?? '127.0.0.1', port: Number(process.env.AGENT_PORT ?? 3443) });
  return app;
}


