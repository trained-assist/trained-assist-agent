const { test } = require('node:test');
const assert = require('node:assert/strict');

const { nextAction, actionsFor, DEFAULT_RECOVERY_BUDGET } = require('../src/recovery-policy');

test('USER_STOP never retries, regardless of spent/budget', () => {
  assert.equal(nextAction('USER_STOP', { spent: 0 }), null);
  assert.equal(nextAction('USER_STOP', { spent: 5, budget: 99 }), null);
});

test('TRANSIENT: retry same target, then fallback, then terminal', () => {
  assert.equal(nextAction('TRANSIENT', { spent: 0 }), 'retry_same');
  assert.equal(nextAction('TRANSIENT', { spent: 1 }), 'fallback');
  assert.equal(nextAction('TRANSIENT', { spent: 2 }), null); // action list exhausted → terminal
});

test('RATE_LIMIT: backoff/retry then next provider', () => {
  assert.equal(nextAction('RATE_LIMIT', { spent: 0 }), 'backoff_retry_same');
  assert.equal(nextAction('RATE_LIMIT', { spent: 1 }), 'next_provider');
});

test('QUOTA: moves through degradation ladder including free fallback', () => {
  assert.equal(nextAction('QUOTA', { spent: 0 }), 'next_model_or_provider');
  assert.equal(nextAction('QUOTA', { spent: 1 }), 'free_fallback');
});

test('AUTH: alternate configured provider; no alternative → terminal', () => {
  assert.equal(nextAction('AUTH', { spent: 0 }), 'alternate_provider');
  assert.equal(nextAction('AUTH', { spent: 1 }), null);
});

test('CONFIG: alternate target or terminal, never blind same-target retry', () => {
  assert.equal(nextAction('CONFIG', { spent: 0 }), 'alternate_target');
  assert.equal(nextAction('CONFIG', { spent: 1 }), null);
});

test('CONTEXT: compact/larger-context model, then retry — never repeats the identical request forever', () => {
  assert.equal(nextAction('CONTEXT', { spent: 0 }), 'compact_or_larger_context_model');
  assert.equal(nextAction('CONTEXT', { spent: 1 }), 'retry_same');
  assert.equal(nextAction('CONTEXT', { spent: 2 }), null);
});

test('UNKNOWN: conservative retry → fallback → terminal', () => {
  assert.equal(nextAction('UNKNOWN', { spent: 0 }), 'conservative_retry');
  assert.equal(nextAction('UNKNOWN', { spent: 1 }), 'fallback');
  assert.equal(nextAction('UNKNOWN', { spent: 2 }), null);
});

test('unrecognized failure class falls back to the UNKNOWN policy rather than throwing', () => {
  assert.deepEqual(actionsFor('NOT_A_REAL_CLASS'), actionsFor('UNKNOWN'));
});

test('recovery budget exhausted → terminal regardless of failure class', () => {
  assert.equal(nextAction('QUOTA', { spent: DEFAULT_RECOVERY_BUDGET }), null);
  assert.equal(nextAction('TRANSIENT', { spent: DEFAULT_RECOVERY_BUDGET, budget: DEFAULT_RECOVERY_BUDGET }), null);
});

test('every FAILURE_CLASS from the taxonomy resolves to a defined, non-empty action list', () => {
  const { FAILURE_CLASSES } = require('../src/failure-taxonomy');
  for (const cls of FAILURE_CLASSES) {
    const actions = actionsFor(cls);
    assert.ok(Array.isArray(actions) && actions.length > 0, `${cls} has no policy`);
  }
});
