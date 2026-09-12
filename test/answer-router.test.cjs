const R = require('../src/answer-router.js');
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
function stub(score) { global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ oneshotScore: score, reason: 'stub' }) } }] }) }); }

(async () => {
  // 1. too short -> oneshot gate, LLM never called
  global.fetch = async () => { throw new Error('LLM must NOT be called'); };
  let r = await R.decideMode('привет', { apiKey: 'k' });
  ok(r.mode === 'oneshot' && r.source === 'gate', 'short->oneshot gate');

  // 2. no key -> oneshot gate (temporarily drop env key)
  const savedKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  r = await R.decideMode('исследуй рынок упаковки в России подробно', {});
  if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
  ok(r.mode === 'oneshot' && r.source === 'gate', 'no key->oneshot gate');

  // 3. low score (murky/research) -> deep
  stub(0.1);
  r = await R.decideMode('разберись почему падает конверсия и что делать', { apiKey: 'k' });
  ok(r.mode === 'deep' && r.source === 'llm', 'low score->deep');

  // 4. high score (specific) -> oneshot
  stub(0.95);
  r = await R.decideMode('создай контакт Иван Петров +79001234567', { apiKey: 'k' });
  ok(r.mode === 'oneshot', 'high score->oneshot');

  // 5. score == threshold -> oneshot (deep only when strictly below)
  stub(R.THRESHOLD);
  r = await R.decideMode('умеренно понятная задача сделать что-то', { apiKey: 'k' });
  ok(r.mode === 'oneshot', 'score==threshold->oneshot');

  // 6. LLM throws -> fail-open oneshot
  global.fetch = async () => { throw new Error('network'); };
  r = await R.decideMode('исследуй что-нибудь большое и мутное для теста', { apiKey: 'k' });
  ok(r.mode === 'oneshot' && r.source === 'fail-open', 'LLM error->fail-open');

  // 7. malformed JSON -> fail-open
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) });
  r = await R.decideMode('исследуй что-нибудь большое и мутное для теста два', { apiKey: 'k' });
  ok(r.mode === 'oneshot' && r.source === 'fail-open', 'bad JSON->fail-open');

  // 8. durable roundtrip
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'));
  R.writeMode(wd, 's-1', { mode: 'deep', score: 0.1, reason: 'x' });
  const back = R.readMode(wd, 's-1');
  ok(back && back.mode === 'deep' && back.sessionId === 's-1', 'durable roundtrip');
  ok(R.readMode(wd, 'nope') === null, 'missing->null');

  // 9. deep block overrides conciseness
  ok(/DEEP/.test(R.buildDeepBlock()) && /НЕ применяется/.test(R.buildDeepBlock()), 'deep block overrides');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
