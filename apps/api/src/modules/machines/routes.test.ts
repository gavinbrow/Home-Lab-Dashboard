import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import register, { registerAgentRoutes } from './index.js';
import { MetricsQuerySchema, MachineCreateSchema, MachineUpdateSchema, MachineTestSchema } from './schemas.js';
import type { ApiContext } from '../../core/context.js';

test('machine request validation rejects claimed capabilities and unbounded history', () => {
  assert.equal(MachineCreateSchema.safeParse({ name: 'New machine', capabilities: { monitoring: 'healthy' } }).success, false);
  assert.equal(MachineUpdateSchema.safeParse({ name: 'Changed without revision' }).success, false);
  assert.equal(MetricsQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }).success, false);
  assert.equal(MetricsQuerySchema.safeParse({ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success, false);
  assert.equal(MachineTestSchema.safeParse({ capability: 'runner', idempotency_key: 'test' }).success, false);
  assert.equal(MachineTestSchema.safeParse({ capability: 'runner', idempotency_key: 'test', command: { executable: 'arbitrary-command' } }).success, false);
});

test('agent endpoints stay unavailable even if a client supplies certificate headers', async () => {
  const app = Fastify();
  await registerAgentRoutes(app, {} as ApiContext);
  try {
    for (const url of ['/agent/enroll', '/agent/telemetry', '/agent/rotate']) {
      const response = await app.inject({ method: 'POST', url, headers: { 'x-client-cert-verified': 'SUCCESS' }, payload: {} });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'capability_disabled');
    }
  } finally { await app.close(); }
});

test('machine access checks the actor before exposing telemetry or enrollment', async () => {
  const app = Fastify();
  const owner = '00000000-0000-4000-8000-000000000001';
  const machine = '00000000-0000-4000-8000-000000000002';
  const calls: unknown[][] = [];
  app.addHook('preHandler', async request => { request.actor = { id: owner, role: 'owner' }; });
  await register(app, { db: { query: async (_sql: string, parameters: unknown[]) => { calls.push(parameters); return { rowCount: 0, rows: [] }; } } } as unknown as ApiContext);
  try {
    const metrics = await app.inject({ url: `/machines/${machine}/metrics?from=2026-10-20T00:00:00Z&to=2026-10-20T01:00:00Z` });
    const enrollment = await app.inject({ method: 'POST', url: `/machines/${machine}/enrollments` });
    assert.equal(metrics.statusCode, 404);
    assert.equal(enrollment.statusCode, 404);
    assert.deepEqual(calls, [[machine, owner], [machine, owner]]);
  } finally { await app.close(); }
});

test('independent failed SSH capability does not override fresh monitoring', async () => {
  const app = Fastify();
  const now = new Date().toISOString();
  const capability = { supported: true, configured: true, permitted: true, observed_at: now, last_test_at: now, last_success_at: now, reason: null };
  app.addHook('preHandler', async request => { request.actor = { id: '00000000-0000-4000-8000-000000000001', role: 'owner' }; });
  const row = { id: '00000000-0000-4000-8000-000000000002', name: 'Unit-test fixture', capabilities: { monitoring: { ...capability, health_state: 'healthy' }, ssh: { ...capability, health_state: 'unreachable', reason: 'Connection refused' } } };
  await register(app, { db: { query: async () => ({ rowCount: 1, rows: [row] }) } } as unknown as ApiContext);
  try {
    const response = await app.inject({ url: '/machines' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].capabilities.monitoring.health_state, 'healthy');
    assert.equal(response.json().items[0].capabilities.ssh.health_state, 'unreachable');
    assert.equal(response.json().items[0].capabilities.ssh.reason, 'Connection refused');
  } finally { await app.close(); }
});
