import test from 'node:test';
import assert from 'node:assert/strict';
import { RunContextSchema, type PolicyGrant, type Workspace } from '@homelab/contracts';
import { authorize, resolveRunContext } from '@homelab/policy';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const actor = { id: id(1), role: 'owner' as const };
const grant: PolicyGrant = { id: id(2), owner_id: actor.id, revision: 1, tools: ['run_command'], machine_ids: [id(3)], workspace_ids: [id(4)], profile_ids: [id(5)], expires_at: null, revoked_at: null };
const request = { actor, tool: 'run_command', machine_id: id(3), workspace_id: id(4), profile_id: id(5), grant, current_grant: grant };

test('local policy integration: current expansion cannot expand immutable run grant and revocation denies dispatch', () => {
  assert.equal(authorize(request).allowed, true);
  const expanded = { ...grant, revision: 2, machine_ids: [...grant.machine_ids, id(6)] };
  assert.equal(authorize({ ...request, machine_id: id(6), current_grant: expanded }).allowed, false);
  assert.equal(authorize({ ...request, current_grant: { ...grant, revision: 2, revoked_at: '2026-10-20T00:00:00Z' } }).allowed, false);
  assert.equal(authorize({ ...request, current_grant: null }).allowed, false);
  assert.equal(authorize({ ...request, actor: { id: id(9), role: 'owner' } }).allowed, false);
});

test('local contracts/policy integration: model location never changes workspace machine and stale generations fail closed', () => {
  const context = RunContextSchema.parse({ schema_version: 1, provider_id: id(10), provider_config_revision: 1, provider_adapter: 'ollama', provider_endpoint: 'https://provider.invalid', model_id: 'explicit-test-model', profile_id: id(5), profile_revision: 1, execution_machine_id: id(3), execution_identity_id: id(11), workspace_id: id(4), workspace_revision: 1, environment_id: id(12), environment_generation: 1, project_instruction_revision: 1, policy_revision: 1, limits: {} });
  const workspace: Workspace = { id: id(4), owner_id: actor.id, project_id: id(13), name: 'Local contract fixture', type: 'container', machine_id: id(3), approved_root_id: id(14), canonical_root: '/disposable', runtime_path: '/workspace/project', revision: 1, instruction_revision: 1, state: 'active', quota_bytes: 1000, environment_id: id(12), environment_generation: 1 };
  const resolved = resolveRunContext(context, workspace);
  assert.deepEqual(resolved, context);
  assert.notEqual(resolved, context);
  assert.throws(() => resolveRunContext({ ...context, execution_machine_id: id(15) }, workspace), /workspace_machine_mismatch/);
  assert.throws(() => resolveRunContext(context, { ...workspace, environment_generation: 2 }), /environment_generation_mismatch/);
  assert.throws(() => resolveRunContext(context, null), /workspace_required/);
});
