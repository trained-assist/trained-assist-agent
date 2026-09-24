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

test('classifyError catches retired/unavailable model slugs and provider overload as quota-class (skip the rung, do not dead-stop the task)', () => {
  const { mod } = freshModule();
  const unavailable = mod.classifyError('This model is unavailable for free. The paid version is available now - use this slug instead: xiaomi/mimo-v2.5');
  assert.equal(unavailable.class, 'quota');
  assert.ok(unavailable.ttlMs > 24 * 60 * 60 * 1000, 'retired-slug TTL should be long (effectively permanent), not a short quota window');

  assert.equal(mod.classifyError('model not found').class, 'quota');
  assert.equal(mod.classifyError('No endpoints found matching your data policy').class, 'quota');

  const overloaded = mod.classifyError('Upstream error from Nvidia: Service temporarily overloaded');
  assert.equal(overloaded.class, 'quota');
  assert.ok(overloaded.ttlMs <= 15 * 60 * 1000, 'overload TTL should be short — this is transient provider congestion, retry soon');

  assert.equal(mod.classifyError('HTTP 503 Service Unavailable').class, 'quota');
});

test('classifyError recognizes opencode\'s generic "Unexpected server error" (dead model slug) as a per-rung quota failure', () => {
  const { mod } = freshModule();
  // Confirmed live 2026-09-24: an invalid opencode-go slug (gpt-6-astra) returned exactly this,
  // while the valid sibling (gpt-6-luna) worked. Must degrade the ladder, not dead-end on the rung.
  const v = mod.classifyError('{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details."}}}');
  assert.equal(v.class, 'quota');
  assert.ok(v.ttlMs > 0, 'short TTL, not permanent');
});

test('classifyError recognizes context-overflow text as its own class, distinct from quota/config', () => {
  const { mod } = freshModule();
  assert.equal(mod.classifyError('This model\'s maximum context length is 128000 tokens').class, 'context');
  assert.equal(mod.classifyError('context_length_exceeded').class, 'context');
  assert.equal(mod.classifyError('prompt is too long: 250000 tokens > 200000 maximum').class, 'context');
  assert.equal(mod.classifyError('input too long for requested model').class, 'context');
  assert.equal(mod.classifyError('too many tokens in the request').class, 'context');
});

test('recordFailure does NOT persist exhaustion for context-overflow (unlike quota/config) — it must not block other tasks sharing the rung', () => {
  const { mod } = freshModule();
  const verdict = mod.recordFailure('p', 'build', 'big-model', 'Error: context_length_exceeded');
  assert.deepEqual(verdict, { class: 'context', model: 'big-model', alertNeeded: false });
  // A fresh task with no skip list still resolves the same model — nothing was marked exhausted.
  assert.equal(mod.resolveModel({ ladder: { build: ['big-model', 'other-model'] } }, 'p', 'build'), 'big-model');
});

test('resolveModel skipModels excludes a rung for one call without touching persisted state', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2', 'm3'] };
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build', ['m1']), 'm2');
  // Unaffected call (no skipModels) still resolves m1 — the skip was never persisted.
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1');
});

test('buildOcProfileOverrides skipModels only affects the build role, not other roles', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'p', {
    ladder: { build: ['m1', 'm2'], review: ['m1', 'm3'] },
  });
  const resolved = mod.buildOcProfileOverrides('p', dir, { skipModels: ['m1'] });
  assert.equal(resolved.agent.build.model, 'm2', 'build role skips m1 per opts.skipModels');
  assert.equal(resolved.agent.review.model, 'm1', 'review role ignores build-only skipModels');
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

test('real free profile: every role ladder ends on a paid rung, not another :free model', () => {
  const freeProfile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.opencode', 'profiles', 'free.json'), 'utf8'));
  for (const [role, ladder] of Object.entries(freeProfile.ladder)) {
    const lastRung = ladder[ladder.length - 1];
    assert.ok(!lastRung.endsWith(':free'), `${role}'s last rung (${lastRung}) must be a paid model — if every :free rung is rate-limited/dead, there must be one guaranteed-to-work fallback left`);
  }
});
