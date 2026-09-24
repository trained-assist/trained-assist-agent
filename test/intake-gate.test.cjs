const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCompleteness } = require('../src/intake-gate');

function fakeFetch(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  });
}

test('holds when text or key is missing', async () => {
  assert.deepEqual(await checkCompleteness('', 'key'), { level: 'insufficient', complete: false });
  assert.deepEqual(await checkCompleteness('hi', ''), { level: 'insufficient', complete: false });
});

test('propagates API errors to the fail-closed HTTP boundary', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => checkCompleteness('do the thing', 'key', { fetchImpl }));
});

test('maps clear to actionable after the gateway quiet period', async () => {
  const result = await checkCompleteness('запусти отчёт по кандидатам', 'key', { fetchImpl: fakeFetch('clear') });
  assert.deepEqual(result, { level: 'clear', complete: true });
});

test('maps likely to actionable after the gateway quiet period', async () => {
  const result = await checkCompleteness('наверное готово', 'key', { fetchImpl: fakeFetch('likely') });
  assert.deepEqual(result, { level: 'likely', complete: true });
});

test('maps model answer "insufficient" to complete=false', async () => {
  const result = await checkCompleteness('сделай так чтобы', 'key', { fetchImpl: fakeFetch('insufficient') });
  assert.deepEqual(result, { level: 'insufficient', complete: false });
});

test('an unrecognised answer holds the buffer', async () => {
  const result = await checkCompleteness('что-то', 'key', { fetchImpl: fakeFetch('maybe???') });
  assert.deepEqual(result, { level: 'insufficient', complete: false });
});

// The exact voice transcript must be actionable even if the model would refuse it.
test('named link recall bypasses model ambiguity without a paid request', async () => {
  for (const text of [
    'Слушай, напомни пожалуйста мне ссылку для холодного поиска, где там кандидат?',
    'Пришли ссылку на отчёт',
    'дай мне ссылку на результаты',
  ]) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: () => { throw new Error('must not call model'); } });
    assert.deepEqual(result, { level: 'clear', complete: true });
  }
});
test('unfinished link requests remain subject to the gate', async () => {
  for (const text of ['напомни ссылку', 'дай ссылку на', 'пришли ссылку на отчёт и', 'пришли ссылку на отчёт\nи сделай так чтобы']) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: fakeFetch('insufficient') });
    assert.deepEqual(result, { level: 'insufficient', complete: false });
  }
});

test('wait instructions dominate named-link shortcuts and optimistic model answers', async () => {
  for (const text of ['пришли ссылку на отчёт, подожди, ещё допишу', 'я ещё пишу', 'не запускай', 'сейчас пришлю файл']) {
    assert.deepEqual(await checkCompleteness(text, 'key', {fetchImpl: () => {throw Error('must not call');}}), {level:'insufficient',complete:false});
  }
});
test('keeps the end of long input where waiting instructions or task details arrive', async () => {
  let prompt;
  await checkCompleteness('a'.repeat(7000)+' LAST DETAIL', 'key', {fetchImpl: async (_, options) => {
    prompt=JSON.parse(options.body).messages[0].content; return fakeFetch('likely')();
  }});
  assert.ok(prompt.includes('LAST DETAIL'));
});
