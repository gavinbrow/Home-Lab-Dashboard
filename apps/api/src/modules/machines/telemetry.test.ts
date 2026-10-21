import test from 'node:test';
import assert from 'node:assert/strict';
import { counterRate, observationAgeMs, summarizeValues } from './telemetry.js';

test('counter rates preserve reset, reboot, unavailable and collection gaps', () => {
  assert.equal(counterRate(100, 160, 2, true), 30);
  assert.equal(counterRate(100, 10, 2, true), null);
  assert.equal(counterRate(100, 160, 2, false), null);
  assert.equal(counterRate(null, 160, 2, true), null);
  assert.equal(counterRate(100, 160, 0, true), null);
  assert.equal(counterRate(100, 160, 121, true), null);
  assert.equal(counterRate(100, 100, 2, true), 0);
  assert.equal(counterRate(100, Infinity, 2, true), null);
});

test('future observation timestamp does not make delayed data fresh', () => {
  assert.equal(observationAgeMs('2026-10-21T01:05:00Z', '2026-10-21T01:00:00Z', Date.parse('2026-10-21T01:02:00Z')), 120000);
  assert.equal(observationAgeMs('invalid', '2026-10-21T01:00:00Z'), null);
});

test('rollups retain missing count and never substitute zero for absent sensors', () => {
  assert.deepEqual(summarizeValues([null, null]), { min: null, max: null, mean: null, count: 0, missing: 2 });
  assert.deepEqual(summarizeValues([10, null, 20, 30]), { min: 10, max: 30, mean: 20, count: 3, missing: 1 });
  assert.equal(summarizeValues([Number.MAX_VALUE, Number.MAX_VALUE]).mean, Number.MAX_VALUE);
});
