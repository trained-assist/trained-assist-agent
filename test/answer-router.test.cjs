const R = require('../src/answer-router.js');
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

(async () => {
  // 1. normalizeMode — known values pass, unknown/empty → null
  ok(R.normalizeMode('deep') === 'deep', 'normalize deep');
  ok(R.normalizeMode('DEEP') === 'deep', 'normalize case-insensitive');
  ok(R.normalizeMode('clarify') === 'clarify', 'normalize clarify');
  ok(R.normalizeMode('oneshot') === 'oneshot', 'normalize oneshot');
  ok(R.normalizeMode('bogus') === null, 'normalize unknown->null');
  ok(R.normalizeMode('') === null && R.normalizeMode(undefined) === null, 'normalize empty->null');

  // 2. durable roundtrip
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'));
  R.writeMode(wd, 's-1', { mode: 'deep', source: 'workrun' });
  const back = R.readMode(wd, 's-1');
  ok(back && back.mode === 'deep' && back.sessionId === 's-1', 'durable roundtrip');
  ok(R.readMode(wd, 'nope') === null, 'missing->null');
  ok(R.readMode(wd, null) === null && R.writeMode(wd, null, {}) === false, 'guards on empty id');

  // 3. deep block lifts the conciseness cap
  ok(/DEEP/.test(R.buildDeepBlock()) && /НЕ применяется/.test(R.buildDeepBlock()), 'deep block overrides');

  // 4. clarify block asks questions instead of solving
  ok(/CLARIFY/.test(R.buildClarifyBlock()) && /вопрос/i.test(R.buildClarifyBlock()), 'clarify block asks questions');

  // 5. no classifier surface (removed) — decideMode must be gone
  ok(typeof R.decideMode === 'undefined', 'decideMode removed');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
