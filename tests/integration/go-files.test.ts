import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const executable = process.env.HOMELAB_AGENT_EXE;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('actual local Go executable: collector and rooted file bytes, conflicts and escape denials', {
  skip: !executable ? 'Opt in with explicitly built HOMELAB_AGENT_EXE; never starts arbitrary native shell' : false,
  timeout: 45_000
}, async t => {
  const binary = resolve(executable!);
  const machine = randomUUID(), workspace = randomUUID(), readonlyWorkspace = randomUUID();
  const { stdout } = await run(binary, ['collect', '--machine-id', machine], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const sample = JSON.parse(stdout);
  assert.equal(sample.schema_version, 1);
  assert.equal(sample.machine_id, machine);
  assert.ok(sample.boot_id && sample.observed_at && sample.inventory.os);
  assert.ok(Array.isArray(sample.metrics) && sample.metrics.length > 0);
  for (const metric of sample.metrics) {
    assert.ok(['available', 'unavailable'].includes(metric.availability));
    if (metric.availability === 'unavailable') assert.equal(metric.value, null);
  }
  const runtime = await mkdtemp(join(tmpdir(), 'homelab-go-validation-'));
  const root = join(runtime, 'project'), readonlyRoot = join(runtime, 'readonly-project'), metadata = join(runtime, 'metadata'), outside = join(runtime, 'outside');
  await Promise.all([mkdir(root), mkdir(readonlyRoot), mkdir(metadata), mkdir(outside)]);
  await writeFile(join(outside, 'sentinel.txt'), 'outside remains unchanged');
  const token = randomBytes(32).toString('base64url');
  const tokenPath = join(metadata, 'local-token');
  await writeFile(tokenPath, token, { mode: 0o600 });
  const reservation = createServer();
  await new Promise<void>(resolveReady => reservation.listen(0, '127.0.0.1', resolveReady));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolveClosed, reject) => reservation.close(error => error ? reject(error) : resolveClosed()));
  const configPath = join(metadata, 'supervisor.json');
  await writeFile(configPath, JSON.stringify({ machine_id: machine, dispatch_epoch: randomUUID(), data_dir: metadata, listen: `127.0.0.1:${port}`, local_token_file: tokenPath, docker_path: '', workspaces: [{ id: workspace, root, revision: 1, writable: true, container_enabled: false }, { id: readonlyWorkspace, root: readonlyRoot, revision: 1, writable: false, container_enabled: false }] }), { mode: 0o600 });
  const child = spawn(binary, ['supervisor', '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let failure = '';
  child.stderr.on('data', bytes => { if (failure.length < 4096) failure += String(bytes).slice(0, 4096 - failure.length); });
  const url = `http://127.0.0.1:${port}`;
  const request = async (method: string, route: string, payload?: unknown, bearer = token) => {
    if (method === 'PUT' && payload && typeof payload === 'object') payload = { operation_id: randomUUID(), ...payload };
    const response = await fetch(new URL(route, url), { method, redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${bearer}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const text = await response.text(); let body: any;
    try { body = JSON.parse(text); } catch { body = { error: { message: text.trim() } }; }
    return { status: response.status, body };
  };
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Go supervisor exited before readiness: ${failure}`);
      try { healthy = (await request('GET', '/v1/health')).status === 200; } catch { /* Starting explicitly owned process. */ }
      if (healthy) break;
      await delay(50);
    }
    assert.equal(healthy, true, 'Actual Go supervisor becomes ready');
    assert.equal((await request('GET', '/v1/health')).body.machine_id, machine);
    assert.equal((await request('GET', '/v1/health', undefined, 'invalid-token')).status, 401);
    const files = `/v1/workspaces/${workspace}/files`;
    await t.test('binary writes and conditional conflicts use actual rooted filesystem bytes', async () => {
      const bytes = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]);
      const created = await request('PUT', files, { path: 'untracked-output.bin', content_base64: bytes.toString('base64'), expected_sha256: null });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      assert.equal((created.body.result ?? created.body).sha256, hash(bytes));
      assert.deepEqual(await readFile(join(root, 'untracked-output.bin')), bytes);
      const fetched = await request('GET', `${files}?mode=read&path=untracked-output.bin`);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.content_base64, bytes.toString('base64'));
      const missingVersion = await request('PUT', files, { path: 'untracked-output.bin', content_base64: '', expected_sha256: null });
      const staleVersion = await request('PUT', files, { path: 'untracked-output.bin', content_base64: '', expected_sha256: '0'.repeat(64) });
      for (const conflict of [missingVersion, staleVersion]) assert.ok(conflict.status === 409 || conflict.body.state === 'conflict');
      assert.deepEqual(await readFile(join(root, 'untracked-output.bin')), bytes);
      const updated = Buffer.from('updated by authorized file API');
      assert.equal((await request('PUT', files, { path: 'untracked-output.bin', content_base64: updated.toString('base64'), expected_sha256: hash(bytes) })).status, 200);
      assert.deepEqual(await readFile(join(root, 'untracked-output.bin')), updated);
      assert.ok((await request('PUT', `/v1/workspaces/${readonlyWorkspace}/files`, { path: 'denied.txt', content_base64: '', expected_sha256: null })).status >= 400);
    });
    await t.test('path traversal, Windows forms, unenrolled workspace and junction escape fail closed', async () => {
      for (const path of ['../outside/sentinel.txt', 'C:\\Windows\\win.ini', 'CON', 'file:stream']) {
        const response = await request('GET', `${files}?mode=read&path=${encodeURIComponent(path)}`);
        assert.ok(response.status >= 400, `Denied path ${path}`);
      }
      assert.ok((await request('GET', `/v1/workspaces/${randomUUID()}/files`)).status >= 400);
      await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      try {
        assert.ok((await request('GET', `${files}?mode=read&path=escape%2Fsentinel.txt`)).status >= 400);
        assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside remains unchanged');
      } finally { await unlink(join(root, 'escape')); }
    });
    await t.test('snapshot includes real hidden and binary files with truthful best-effort capture', async () => {
      assert.equal((await request('PUT', files, { path: '.project-instructions', content_base64: Buffer.from('instructions').toString('base64'), expected_sha256: null })).status, 200);
      const captured = await request('GET', `/v1/workspaces/${workspace}/snapshot`);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.consistency, 'best_effort');
      assert.ok(captured.body.files.some((entry: any) => entry.entry.path === '.project-instructions'));
      assert.ok(captured.body.files.some((entry: any) => entry.entry.path === 'untracked-output.bin'));
    });
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise<void>(resolveStopped => child.once('exit', () => resolveStopped()));
      child.kill();
      await stopped;
    }
    await rm(runtime, { recursive: true, force: true });
  }
});
