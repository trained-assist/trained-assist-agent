const { test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../src/retry-policy');

function withEnv(value, fn) {
  const prev = process.env.TEST_MODE;
  if (value === undefined) delete process.env.TEST_MODE;
  else process.env.TEST_MODE = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TEST_MODE;
    else process.env.TEST_MODE = prev;
  }
}

test('prod (TEST_MODE unset) uses minute-scale exponential-ish backoff: 30s/3min/10min', () => {
  withEnv(undefined, () => {
    assert.equal(mod.isTestMode(), false);
    assert.deepEqual(mod.getRetryDelays(), [30_000, 180_000, 600_000]);
    assert.equal(mod.getRetryDelayMs(1), 30_000);
    assert.equal(mod.getRetryDelayMs(2), 180_000);
    assert.equal(mod.getRetryDelayMs(3), 600_000);
  });
});

test('TEST_MODE=1 collapses the same 3-step schedule to milliseconds', () => {
  withEnv('1', () => {
    assert.equal(mod.isTestMode(), true);
    const delays = mod.getRetryDelays();
    assert.equal(delays.length, 3);
    assert.ok(delays.every(d => d <= 100), 'test-mode delays must be fast, not real minutes');
    assert.equal(mod.getRetryDelayMs(1), delays[0]);
  });
});

test('MAX_RETRIES is 3 — original attempt + 3 retries = 4 tries total', () => {
  assert.equal(mod.MAX_RETRIES, 3);
});

test('getRetryDelayMs returns null once attempts are exhausted (attempt 0 or > MAX_RETRIES)', () => {
  withEnv(undefined, () => {
    assert.equal(mod.getRetryDelayMs(0), null);
    assert.equal(mod.getRetryDelayMs(4), null);
    assert.equal(mod.getRetryDelayMs(-1), null);
  });
});
