'use strict';
// Explicit opt-in: at most 8 paid model calls (2 briefs + 6 assessments).
const e = require('../../src/hh-evidence-evaluator');
const fs = require('fs');
async function main() {
  if (process.env.HH_MODEL_SMOKE !== '1' || !process.env.OPENROUTER_API_KEY) throw new Error('Set HH_MODEL_SMOKE=1 and OPENROUTER_API_KEY explicitly');
  const key = process.env.OPENROUTER_API_KEY;
  const onsite = await e.compileBrief(e.buildBrief({ vacancy_text: 'Дизайнер мебели. Единственное обязательное условие этой проверки — работа очно в Сыктывкаре. Можно переехать в Сыктывкар к началу работы. Требования к профессии в этой проверке не оцениваются.' }, { area: { id: '51', name: 'Сыктывкар' } }), key);
  const remote = await e.compileBrief(e.buildBrief({ vacancy_text: 'Работа полностью удалённая из любого города. Единственное обязательное условие — регулярные личные выезды к клиентам в Республике Коми, еженедельно. Требования к профессии в этой проверке не оцениваются.' }, { area: { id: '51', name: 'Сыктывкар' } }), key);
  const cases = [
    ['onsite-refusal', onsite, 'Только удалённая работа. Переезд в Сыктывкар исключён. Очную работу не рассматриваю.', 'FAIL'],
    ['onsite-unknown', onsite, 'Дизайнер мебели, живу в Москве.', 'REVIEW'],
    ['onsite-relocation', onsite, 'Готов переехать в Сыктывкар к началу работы и работать очно в офисе в Сыктывкаре.', 'PASS'],
    ['remote-travel-refusal', remote, 'Работаю удалённо из Москвы, на регулярные личные выезды в Коми не согласен.', 'FAIL'],
    ['remote-travel-unknown', remote, 'Работаю удалённо из Москвы.', 'REVIEW'],
    ['remote-travel-confirmed', remote, 'Работаю удалённо из Москвы. Готов лично выезжать к клиентам в Республику Коми каждую неделю.', 'PASS'],
  ];
  const results = [];
  for (const [name, brief, skills, expected] of cases) {
    try {
      const result = await e.evaluateCandidate({ id: name, resume_snapshot: { title: 'Дизайнер', area: { id: '1', name: 'Москва' }, skills }, data_completeness: { full_resume: true } }, brief, key);
      results.push({ name, expected, actual: result.verdict, checks: result.checks, pass: result.verdict === expected });
    } catch (error) { results.push({ name, expected, error: error.message, pass: false }); }
  }
  const report = { date: new Date().toISOString(), model: 'google/gemini-2.5-flash', calls_limit: 8, synthetic: true, briefs: [onsite, remote], results };
  const output = process.env.HH_MODEL_SMOKE_OUTPUT || '/tmp/hh-geography-model-smoke.json';
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(results.map(({ name, expected, actual, error, pass }) => ({ name, expected, actual, error, pass }))));
  if (results.some(r => !r.pass)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
