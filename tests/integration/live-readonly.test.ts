import test from 'node:test';
import assert from 'node:assert/strict';

const optedIn = process.env.HOMELAB_LIVE_READONLY === '1';

test('live component check: anonymous API resource access is denied (partial T01 only)', { skip: !optedIn ? 'Deferred: explicit HOMELAB_LIVE_READONLY=1 and enrolled HTTPS origin required' : false }, async () => {
  const configuredOrigin = process.env.HOMELAB_LIVE_ORIGIN;
  assert.ok(configuredOrigin, 'Set the explicitly enrolled HOMELAB_LIVE_ORIGIN');
  const origin = new URL(configuredOrigin);
  assert.equal(origin.protocol, 'https:', 'Real acceptance uses private HTTPS');
  assert.equal(origin.origin, configuredOrigin, 'Origin only; no credentials, paths, query or fragments');
  for (const route of ['/api/v1/auth/session', '/api/v1/jobs', '/api/v1/machines', '/api/v1/projects', '/api/v1/providers']) {
    const response = await fetch(new URL(route, origin), {
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' }
    });
    assert.ok([401, 403].includes(response.status), `${route}: expected unauthenticated denial, received ${response.status}`);
    await response.body?.cancel();
  }
});
