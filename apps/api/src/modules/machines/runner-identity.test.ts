import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRunnerIdentity } from './runner-identity.js';

test('runner identity compares UID and GID, never accepts arbitrary nonempty output', () => {
  assert.deepEqual(verifyRunnerIdentity('1000:2000', '1000\n', '2000\n'), { matched: true, actual: '1000:2000' });
  assert.equal(verifyRunnerIdentity('1000:2000', '0\n', '0\n').matched, false);
  assert.equal(verifyRunnerIdentity('1000:2000', '1000\n', '3000\n').matched, false);
  assert.equal(verifyRunnerIdentity('1000:2000', 'success', 'success').matched, false);
  assert.equal(verifyRunnerIdentity('unverified-name', '1000', '2000').matched, null);
});

test('Windows identity requires the protected SID and one actual SID result', () => {
  assert.equal(verifyRunnerIdentity('S-1-5-21-1234', '"test\\user","S-1-5-21-1234"\r\n', undefined, true).matched, true);
  assert.equal(verifyRunnerIdentity('S-1-5-21-1234', '"test\\user","S-1-5-18"', undefined, true).matched, false);
  assert.equal(verifyRunnerIdentity('S-1-5-21-1234', 'S-1-5-21-1234 S-1-5-18', undefined, true).matched, false);
  assert.equal(verifyRunnerIdentity('user', '"test\\user","S-1-5-21-1234"', undefined, true).matched, null);
});
