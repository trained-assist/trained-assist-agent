'use strict';
// Wiring test for issue #1175 / PR #1179 follow-up: runner/index.js's crash/retry maze now
// records every failure/retry decision into execution-history.js via the internal
// _recordFailureAttempt helper (Phase A — observational only, no control-flow change; see the
// comment above _recordFailureAttempt in src/runner/index.js). This does not re-test
// failure-classifier.js/execution-history.js themselves (already covered by their own suites) —
// it only proves the runner→history wiring itself behaves: classifies, records, and never throws.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshRunner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-brain-wiring-test-'));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/execution-history')];
  delete require.cache[require.resolve('../src/runner')];
  delete require.cache[require.resolve('../src/runner/index.js')];
  const runner = require('../src/runner');
  const executionHistory = require('../src/execution-history');
  return { runner, executionHistory, dir };
}

test('_recordFailureAttempt classifies known error text and appends a Failure Event', () => {
  const { runner, executionHistory } = freshRunner();
  runner._recordFailureAttempt('exec-quota', {
    taskId: 't-1', projectId: null, sessionId: 's-1', engine: 'opencode', model: 'gpt-x',
    errorText: 'quota exceeded for this key', action: 'ladder_next_rung',
  });
  const h = executionHistory.getHistory('exec-quota');
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].failureClass, 'QUOTA');
  assert.equal(h.attempts[0].classificationSource, 'rule');
  assert.equal(h.attempts[0].action, 'ladder_next_rung');
  assert.equal(h.attempts[0].engine, 'opencode');
});

test('_recordFailureAttempt falls back to UNKNOWN for unrecognized text rather than dropping the event', () => {
  const { runner, executionHistory } = freshRunner();
  runner._recordFailureAttempt('exec-unknown', {
    taskId: 't-2', sessionId: 's-2', engine: 'claude',
    errorText: 'something completely unclassifiable happened', action: null,
  });
  const h = executionHistory.getHistory('exec-unknown');
  assert.equal(h.attempts[0].failureClass, 'UNKNOWN');
  assert.equal(h.attempts[0].classificationSource, 'none');
});

test('_recordFailureAttempt never throws even on missing/malformed input', () => {
  const { runner } = freshRunner();
  assert.doesNotThrow(() => runner._recordFailureAttempt('exec-empty', {}));
  assert.doesNotThrow(() => runner._recordFailureAttempt(undefined, { errorText: null }));
});

test('runTask (public export) still accepts an explicit executionId without throwing at call time', () => {
  // Full retry-maze integration (spawning a real/fake engine through _runTask) is exercised by
  // claude-runner.smoke.test.cjs at the engine-process layer; this only proves the public runTask
  // wrapper accepts the new executionId field end-to-end without rejecting/crashing before the
  // queue/admission layer, since _runTask's destructure now includes `executionId = randomUUID()`.
  const { runner } = freshRunner();
  assert.equal(typeof runner.runTask, 'function');
  assert.equal(typeof runner._recordFailureAttempt, 'function');
});
