import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sha256 } from '@homelab/storage';

test('actual signed Go 17MiB resumable binary transfer and staged selected checkpoint restore', {
  skip: process.env.HOMELAB_LARGE_TRANSFER !== '1' ? 'Requires coordinated live owned UI/Go fixture; never creates or guesses a host' : false,
  timeout: 600_000
}, async () => {
  const fixture = JSON.parse(await readFile(resolve('tests/integration/.wave3-runtime/ui-fixture.json'), 'utf8'));
  assert.equal(fixture.api_origin, 'http://127.0.0.1:3021');
  const origin = fixture.app_origin, grant = fixture.ids.grant, project = fixture.ids.workspace;
  const login = await fetch(`${fixture.api_origin}/api/v1/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: fixture.email, password: fixture.password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = (await login.json() as any).csrf_token;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.api_origin}/api/v1/projects/${project}${path}`, { method, headers: { cookie, origin, 'x-csrf-token': csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const path = `transfer-${randomUUID()}.bin`, source = Buffer.alloc(17 * 1024 * 1024);
  for (let offset = 0; offset < source.length; offset++) source[offset] = offset % 251;
  const sourceHash = sha256(source);
  const evidence: Record<string, any> = { scope: 'actual authenticated API/PG/signed Go host; bounded 1MiB chunks; 17MiB file exceeds former inline snapshot size', started_at: new Date().toISOString(), workspace_id: project, path, size_bytes: source.length, expected_sha256: sourceHash, outcome: 'RUNNING' };
  const upload = async (bytes: Buffer, expected: string | null, exerciseBoundaries: boolean) => {
    const id = randomUUID(), hash = sha256(bytes);
    const opened = await request('POST', '/uploads', { operation_id: id, grant_id: grant, path, total_bytes: bytes.length, sha256: hash, expected_sha256: expected }); assert.equal(opened.status, 200, JSON.stringify(opened.body));
    if (exerciseBoundaries) {
      const unpublished = await request('GET', `/files/metadata?${new URLSearchParams({ path, grant_id: grant })}`); assert.equal(unpublished.status, 404, 'Partial upload must not be visible as a complete file');
      const incomplete = await request('POST', `/uploads/${id}/complete`, { operation_id: randomUUID(), grant_id: grant }); assert.equal(incomplete.status, 409);
    }
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      const part = bytes.subarray(offset, Math.min(offset + 1024 * 1024, bytes.length));
      const body = { grant_id: grant, offset, content_base64: part.toString('base64'), sha256: sha256(part) };
      const accepted = await request('PUT', `/uploads/${id}/chunks`, body); assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      if (offset === 0 && exerciseBoundaries) {
        const replay = await request('PUT', `/uploads/${id}/chunks`, body); assert.equal(replay.status, 200);
        const invalid = await request('PUT', `/uploads/${id}/chunks`, { ...body, sha256: '0'.repeat(64) }); assert.equal(invalid.status, 400);
        const resumed = await request('GET', `/uploads/${id}?grant_id=${grant}`); assert.equal(resumed.status, 200); assert.equal(resumed.body.received_bytes, part.length);
      }
    }
    const commit = { operation_id: randomUUID(), grant_id: grant };
    const completed = await request('POST', `/uploads/${id}/complete`, commit); assert.equal(completed.status, 200, JSON.stringify(completed.body)); assert.equal(completed.body.sha256, hash);
    const replayed = await request('POST', `/uploads/${id}/complete`, commit); assert.equal(replayed.status, 200); assert.equal(replayed.body.sha256, hash);
    return id;
  };
  try {
    evidence.upload_id = await upload(source, null, true);
    const checkpoint = await request('POST', '/checkpoints', { grant_id: grant }); assert.equal(checkpoint.status, 200, JSON.stringify(checkpoint.body)); evidence.checkpoint_id = checkpoint.body.id;
    const modified = Buffer.from(source); modified[0] ^= 255; modified[modified.length - 1] ^= 127;
    evidence.replacement_upload_id = await upload(modified, sourceHash, false);
    const review = { checkpoint_id: checkpoint.body.id, grant_id: grant, paths: [path], delete_extras: false };
    const preview = await request('POST', '/restore/preview', review); assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const restore = { ...review, operation_id: randomUUID(), expected_manifest_hash: preview.body.expected_manifest_hash, plan_hash: preview.body.plan_hash };
    const applied = await request('POST', '/restore', restore); assert.equal(applied.status, 200, JSON.stringify(applied.body)); evidence.restore = applied.body;
    const replayed = await request('POST', '/restore', restore); assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    const received: Buffer[] = [];
    for (let offset = 0; offset < source.length; offset += 1024 * 1024) {
      const part = await request('GET', `/files/range?${new URLSearchParams({ path, grant_id: grant, offset: String(offset), length: String(Math.min(1024 * 1024, source.length - offset)) })}`);
      assert.equal(part.status, 200, JSON.stringify(part.body)); const bytes = Buffer.from(part.body.content_base64, 'base64'); assert.equal(sha256(bytes), part.body.sha256); received.push(bytes);
    }
    const actual = Buffer.concat(received); assert.equal(actual.length, source.length); assert.equal(sha256(actual), sourceHash); assert.deepEqual(actual, source);
    evidence.actual_sha256 = sha256(actual); evidence.chunk_count = received.length; evidence.outcome = 'PASS'; evidence.completed_at = new Date().toISOString();
  } catch (error) { evidence.outcome = 'FAIL'; evidence.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { await writeFile(resolve('docs/acceptance/large-transfer-result.json'), JSON.stringify(evidence, null, 2) + '\n'); }
});
