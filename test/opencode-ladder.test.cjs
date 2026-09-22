const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated OPENCODE_LADDER_STATE_FILE per test run — same pattern as test/auth-flag.test.cjs —
// so this never touches the real ~/.config/opencode/ladder-state.json, and so opencode-ladder.js
// (which resolves STATE_FILE at require time) picks up the fresh path each time.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-ladder-test-'));
  process.env.OPENCODE_LADDER_STATE_FILE = path.join(dir, 'ladder-state.json');
  delete require.cache[require.resolve('../src/opencode-ladder')];
  return { mod: require('../src/opencode-ladder'), dir };
}

function writeProfile(dir, name, json) {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(json));
}

test('classifyError sorts quota vs config vs unrecognized text', () => {
  const { mod } = freshModule();
  assert.equal(mod.classifyError('rate limit exceeded').class, 'quota');
  assert.equal(mod.classifyError('HTTP 429 Too Many Requests').class, 'quota');
  assert.equal(mod.classifyError('usage limit reached').class, 'quota');
  assert.equal(mod.classifyError('quota exceeded for this key').class, 'quota');
  assert.equal(mod.classifyError('subscription required').class, 'config');
  assert.equal(mod.classifyError('this model requires Global regions').class, 'config');
  assert.equal(mod.classifyError('Insufficient account funds').class, 'config');
  assert.equal(mod.classifyError('some unrelated engine crash'), null);
});

test('resolveModel degrades to the next rung once the first is marked exhausted', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2', 'm3'] };
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1');

  mod.markExhausted('p', 'build', 'm1', 60_000);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm2');

  mod.markExhausted('p', 'build', 'm2', 60_000);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm3');
});

test('quota-class exhaustion clears itself once the TTL has passed', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2'] };
  mod.markExhausted('p', 'build', 'm1', -1); // already-expired TTL
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1');
});

test('config-class exhaustion (ttlMs null) never auto-clears', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2'] };
  mod.markExhausted('p', 'build', 'm1', null);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm2');
  // simulate time passing — still exhausted, unlike the TTL case above
  mod.markExhausted('p', 'build', 'm2', 60_000);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm2', 'degrades to the last rung rather than looping forever when every rung is exhausted');
});

test('free-profile retry-storm: every rung exhausted still resolves a model, never undefined', () => {
  const { mod } = freshModule();
  const ladder = { build: ['a', 'b', 'c'] };
  for (const m of ladder.build) mod.markExhausted('free', 'build', m, 60_000);
  const resolved = mod.resolveModel({ ladder }, 'free', 'build');
  assert.equal(resolved, 'c', 'falls back to the last rung instead of returning null/undefined so callers cannot loop indefinitely on a missing model');
});

test('clearExhausted removes one model, one role, or the whole profile', () => {
  const { mod } = freshModule();
  mod.markExhausted('p', 'build', 'm1', 60_000);
  mod.markExhausted('p', 'plan', 'm2', 60_000);

  mod.clearExhausted('p', 'build', 'm1');
  assert.equal(mod.resolveModel({ ladder: { build: ['m1'] } }, 'p', 'build'), 'm1');
  assert.equal(mod.resolveModel({ ladder: { plan: ['m2', 'm3'] } }, 'p', 'plan'), 'm3');

  mod.clearExhausted('p');
  assert.equal(mod.resolveModel({ ladder: { plan: ['m2', 'm3'] } }, 'p', 'plan'), 'm2');
});

test('recordFailure marks the rung exhausted and reports the error class', () => {
  const { mod } = freshModule();
  const quota = mod.recordFailure('p', 'build', 'm1', 'rate limit exceeded');
  assert.deepEqual(quota, { class: 'quota', model: 'm1', alertNeeded: false });
  assert.equal(mod.resolveModel({ ladder: { build: ['m1', 'm2'] } }, 'p', 'build'), 'm2');

  const config = mod.recordFailure('p', 'plan', 'x1', 'subscription required for this model');
  assert.deepEqual(config, { class: 'config', model: 'x1', alertNeeded: true });
});

test('recordFailure returns null for errors outside the ladder-degradation classes (e.g. total auth loss)', () => {
  const { mod } = freshModule();
  assert.equal(mod.recordFailure('p', 'build', 'm1', 'not logged in'), null);
  assert.equal(mod.recordFailure('p', 'build', 'm1', 'some random crash'), null);
});

test('buildOcProfileOverrides resolves every role and carries rolePrompts along unchanged', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'russian', {
    ladder: {
      build: ['gigachat/GigaChat-Pro'],
      review: ['gigachat/GigaChat-Max', 'gigachat/GigaChat-Pro'],
    },
    rolePrompts: { review: 'strict reviewer prompt' },
  });

  const resolved = mod.buildOcProfileOverrides('russian', dir);
  assert.equal(resolved.model, 'gigachat/GigaChat-Pro');
  assert.equal(resolved.agent.build.model, 'gigachat/GigaChat-Pro');
  assert.equal(resolved.agent.review.model, 'gigachat/GigaChat-Max');
  assert.equal(resolved.agent.review.prompt, 'strict reviewer prompt');
  assert.equal(resolved.agent.build.prompt, undefined);
});

test('buildOcProfileOverrides degrades review to its next rung once GigaChat-Max is exhausted', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'russian', {
    ladder: { build: ['gigachat/GigaChat-Pro'], review: ['gigachat/GigaChat-Max', 'gigachat/GigaChat-Pro'] },
  });
  mod.markExhausted('russian', 'review', 'gigachat/GigaChat-Max', 60_000);
  const resolved = mod.buildOcProfileOverrides('russian', dir);
  assert.equal(resolved.agent.review.model, 'gigachat/GigaChat-Pro');
});

test('a legacy profile without `ladder` (flat model/agent) still resolves as a single-rung ladder', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'legacy', {
    model: 'top-level-model',
    agent: { build: { model: 'build-model' } },
  });

  const resolved = mod.buildOcProfileOverrides('legacy', dir);
  assert.equal(resolved.agent.build.model, 'build-model');
  assert.equal(resolved.model, 'build-model');
});

test('MAX_LADDER_ATTEMPTS caps how many rungs a single task may burn through', () => {
  const { mod } = freshModule();
  assert.equal(typeof mod.MAX_LADDER_ATTEMPTS, 'number');
  assert.ok(mod.MAX_LADDER_ATTEMPTS > 0 && mod.MAX_LADDER_ATTEMPTS < 20);
});

test('forceAdvance degrades to the next rung without any error classification (blind crash-retry alternation)', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2'] };
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1');
  mod.forceAdvance('p', 'build', 'm1');
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm2', 'forceAdvance marks m1 exhausted even though no error text was classified');
});

test('forceAdvance is a bounded-TTL exhaustion (RETRY_FORCE_TTL_MS), not permanent', () => {
  const { mod } = freshModule();
  assert.equal(typeof mod.RETRY_FORCE_TTL_MS, 'number');
  assert.ok(mod.RETRY_FORCE_TTL_MS > 0);
});

test('forceAdvance is a no-op when profile or model is missing', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1'] };
  mod.forceAdvance(null, 'build', 'm1');
  mod.forceAdvance('p', 'build', null);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1', 'neither malformed call should have marked anything exhausted');
});
