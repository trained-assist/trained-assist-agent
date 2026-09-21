'use strict';
/**
 * Plain node assertion runner for tests/hh-proactive-search-queries.test.js
 * Bypasses vitest (broken install on this branch). Covers the query sanity-check
 * + normalization fix for #953/#961:
 *   1. normalizeAtsConfig parses a string-serialized (double-JSON) config
 *   2. legacy experience_min_years maps into filters.min_experience_years
 *   3. queriesLookSane rejects off-topic queries on a normalized live config
 *   4. queriesLookSane accepts on-topic queries
 *   5. string and object configs produce identical hashes (cache stability)
 */
const assert = require('assert');
const {
  queriesLookSane,
  atsConfigHash,
  normalizeAtsConfig,
} = require('../src/hh-proactive-search.js');

let pass = 0, fail = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// Live-shaped ATS config exactly as stored for tes-recruiter (value is a JSON string)
const liveCfgString = JSON.stringify({
  vacancy_id: '137012564',
  title: 'Финансовый советник (Private Banking Sales)',
  vacancy_title: 'Финансовый советник (Private Banking Sales)',
  vacancy_context: 'Private Banking Sales. Привлечение холодных клиентов через личную сеть. Метрики: кол-во клиентов, средний чек, сумма портфеля.',
  knockout: [{ criterion: 'Нет собственной клиентской базы состоятельных клиентов', required: true }],
  required_skills: [{ skill: 'Собственная клиентская база состоятельных клиентов', weight: 3 }],
  preferred_skills: [{ skill: 'Опыт в family office', weight: 1 }],
  experience_min_years: 6,
});

const badQueries = ['Менеджер по продажам', 'Активные продажи', 'Развитие бизнеса', 'Key Account Manager', 'Sales Manager', 'B2B продажи', 'Клиентская база'];
const goodQueries = ['Private Banker', 'Wealth Manager', 'Управляющий активами', 'Собственная клиентская база', 'Финансовый советник'];

test('normalizeAtsConfig parses string-serialized config (#953)', () => {
  const cfg = normalizeAtsConfig(liveCfgString);
  assert.strictEqual(typeof cfg, 'object');
  assert.strictEqual(cfg.vacancy_title, 'Финансовый советник (Private Banking Sales)');
  assert.strictEqual(cfg.required.length, 1);
  assert.strictEqual(cfg.required[0].name, 'Собственная клиентская база состоятельных клиентов');
  assert.strictEqual(cfg.knockout.length, 1);
});

test('legacy experience_min_years maps into filters.min_experience_years', () => {
  const cfg = normalizeAtsConfig(liveCfgString);
  assert.strictEqual(cfg.filters.min_experience_years, 6);
});

test('normalized live config rejects off-topic queries (#953 regression)', () => {
  const cfg = normalizeAtsConfig(liveCfgString);
  assert.strictEqual(queriesLookSane(badQueries, cfg), false);
});

test('normalized live config accepts on-topic queries', () => {
  const cfg = normalizeAtsConfig(liveCfgString);
  assert.strictEqual(queriesLookSane(goodQueries, cfg), true);
});

test('string and object configs produce identical hash (cache stays valid)', () => {
  assert.strictEqual(atsConfigHash(liveCfgString, []), atsConfigHash(JSON.parse(liveCfgString), []));
});

test('empty query list is never sane', () => {
  const cfg = normalizeAtsConfig(liveCfgString);
  assert.strictEqual(queriesLookSane([], cfg), false);
});

(async () => {
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      pass++;
    } catch (e) {
      console.error(`  ✗ ${name}\n    ${e.message}`);
      fail++;
    }
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})();