import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { ExecutionContextSchema } from '@homelab/contracts';
import { linux, stackUnc } from './helpers/linux-stack.js';

test('authenticated command cancellation confirms actual container and descendant exit', {
  skip: process.env.HOMELAB_COMMAND_CANCEL !== '1' ? 'Requires exclusive writer booking on the owned actual UI host fixture' : false,
  timeout: 240_000
}, async () => {
  const fixture = JSON.parse(await readFile(resolve('tests/integration/.wave3-runtime/ui-fixture.json'), 'utf8'));
  assert.equal(fixture.api_origin, 'http://127.0.0.1:3021');
  assert.match(fixture.host_directory, /^\/tmp\/homelab-validation-wave2\/sentinel-[0-9a-f-]{36}$/);
  const admin = new URL((await readFile(join(stackUnc, 'config', 'database-admin-url'), 'utf8')).trim()); admin.hostname = '127.0.0.1'; admin.port = '15439';
  const db = new pg.Pool({ connectionString: admin.href, max: 1 });
  const login = await fetch(`${fixture.api_origin}/api/v1/auth/login`, { method: 'POST', headers: { origin: fixture.app_origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: fixture.email, password: fixture.password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = (await login.json() as any).csrf_token;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.api_origin}/api/v1${path}`, { method, headers: { origin: fixture.app_origin, cookie, 'x-csrf-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const suffix = randomUUID(), proofName = `cancel-proof-${suffix}.json`, tickName = `cancel-child-${suffix}.txt`;
  const projectFiles = '\\\\wsl.localhost\\Ubuntu' + fixture.host_directory.replaceAll('/', '\\') + '\\project';
  const evidence: Record<string, any> = { scope: 'Authenticated API, production worker, signed actual Go and restricted Docker process tree; not disconnected cancellation or native Windows coverage', started_at: new Date().toISOString(), workspace_id: fixture.ids.workspace, outcome: 'RUNNING' };
  try {
    const workspace = await request('GET', `/projects/${fixture.ids.workspace}`); assert.equal(workspace.status, 200);
    const grant = (await db.query('SELECT revision FROM permission_grants WHERE id=$1 AND owner_id=$2', [fixture.ids.grant, fixture.ids.owner])).rows[0];
    const execution = ExecutionContextSchema.parse({ schema_version: 1, profile_id: null, profile_revision: null, execution_machine_id: fixture.ids.machine, execution_identity_id: fixture.ids.identity, workspace_id: fixture.ids.workspace, workspace_revision: workspace.body.revision, environment_id: workspace.body.environment_id, environment_generation: workspace.body.environment_generation, project_instruction_revision: workspace.body.instruction_revision, policy_revision: grant.revision, limits: { max_tool_steps: 4, wall_time_seconds: 180, per_command_timeout_seconds: 90, max_output_bytes: 65536 } });
    const child = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync('/workspace/project/${tickName}','x'),200);setTimeout(()=>process.exit(0),60000)`;
    const script = `const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});fs.writeFileSync('/workspace/project/${proofName}',JSON.stringify({operation_id:process.env.HOMELAB_OPERATION_ID,parent:process.pid,child:c.pid}));setTimeout(()=>process.exit(0),60000);`;
    const submitted = await request('POST', '/jobs/commands', { idempotency_key: `cancel-${suffix}`, execution_context: execution, grant_id: fixture.ids.grant, command: { executable: '/usr/local/bin/node', args: ['-e', script] } }); assert.equal(submitted.status, 202, JSON.stringify(submitted.body)); evidence.job_id = submitted.body.id;
    let proof: any;
    for (let attempt = 0; attempt < 240; attempt++) { const raw = await readFile(join(projectFiles, proofName), 'utf8').catch(() => ''); if (raw) { proof = JSON.parse(raw); break; } await delay(250); }
    assert.ok(proof, 'Actual restricted command must launch before cancellation'); evidence.physical_processes = proof;
    for (let attempt = 0; attempt < 40 && !(await readFile(join(projectFiles, tickName)).catch(() => Buffer.alloc(0))).length; attempt++) await delay(100);
    assert.ok((await readFile(join(projectFiles, tickName))).length > 0, 'Actual descendant must have executed before cancellation');
    const cancelled = await request('POST', `/jobs/${submitted.body.id}/cancel`); assert.equal(cancelled.status, 200); evidence.cancel_response = cancelled.body;
    let job: any;
    for (let attempt = 0; attempt < 400; attempt++) { job = (await db.query('SELECT state,reason,result FROM jobs WHERE id=$1 AND requester_id=$2', [submitted.body.id, fixture.ids.owner])).rows[0]; if (['cancelled', 'failed', 'interrupted', 'completed'].includes(job.state)) break; await delay(250); }
    evidence.job = job; assert.equal(job.state, 'cancelled', JSON.stringify(job));
    const operations = (await db.query('SELECT id,status,receipt FROM operations WHERE job_id=$1', [submitted.body.id])).rows;
    evidence.operations = operations; assert.equal(operations.length, 1); assert.equal(operations[0].id, proof.operation_id); assert.equal(operations[0].status, 'cancelled');
    const ids = (await linux('/usr/bin/docker', 'ps', '-aq', '--filter', `label=homelab.operation=${proof.operation_id}`)).split(/\s+/); assert.equal(ids.length, 1);
    const container = JSON.parse(await linux('/usr/bin/docker', 'inspect', '--format', '{{json .}}', ids[0])); evidence.container = { id: container.Id, user: container.Config.User, state: container.State, readonly: container.HostConfig.ReadonlyRootfs };
    assert.equal(container.Config.User, '10001:10001'); assert.equal(container.State.Running, false); assert.equal(container.State.Pid, 0);
    const stoppedTicks = await readFile(join(projectFiles, tickName)); await delay(1200); assert.deepEqual(await readFile(join(projectFiles, tickName)), stoppedTicks, 'Descendant stopped producing writes'); evidence.descendant_ticks_stable_bytes = stoppedTicks.length;
    assert.equal((await db.query('SELECT count(*)::int AS count FROM workspace_locks WHERE job_id=$1', [submitted.body.id])).rows[0].count, 0, 'Writer released only after confirmed host cancellation');
    evidence.outcome = 'PASS'; evidence.completed_at = new Date().toISOString();
  } catch (error) { evidence.outcome = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { await writeFile(resolve('docs/acceptance/command-cancel-result.json'), JSON.stringify(evidence, null, 2) + '\n'); await db.end(); }
});
