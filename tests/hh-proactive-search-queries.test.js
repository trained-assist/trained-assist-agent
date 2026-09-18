/**
 * Proactive-search query sanity-check + fallback — unit tests.
 *
 * Covers the "30 Аналитиков данных for Финансовый советник" class of bug:
 *  1. queriesLookSane accepts queries that share a keyword with the vacancy
 *  2. queriesLookSane rejects off-topic queries (e.g. data-science terms
 *     for a finance vacancy)
 *  3. queriesLookSane passes-through when the vacancy has no anchors at all
 *     (no title/context/criteria → can't validate, trust the LLM)
 *  4. deriveFallbackQueries builds a small list from vacancy_title + top-3
 *     weighted required criteria, deduplicated, capped at 6
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { queriesLookSane, deriveFallbackQueries } = require('../src/hh-proactive-search.js');

const financeCfg = {
  vacancy_title: 'Финансовый советник (Private Banking Sales)',
  vacancy_context: 'Продажа инвестиционных продуктов HNWI-клиентам, работа с AUM, формирование портфелей.',
  required: [
    { name: 'Private banking опыт', weight: 10 },
    { name: 'Продажа инвестиционных продуктов', weight: 8 },
    { name: 'Знание фондового рынка', weight: 5 },
  ],
  preferred: [
    { name: 'CFA / CIIA', weight: 3 },
  ],
  knockout: [],
  filters: { min_experience_years: 3 },
};

const dataScienceCfg = {
  vacancy_title: 'Senior Data Scientist',
  vacancy_context: 'Построение ML-моделей, A/B-тесты, работа с большими данными.',
  required: [
    { name: 'Python и SQL', weight: 10 },
    { name: 'Опыт с ML-фреймворками', weight: 8 },
  ],
  preferred: [],
  knockout: [],
  filters: { min_experience_years: 3 },
};

describe('queriesLookSane', () => {
  it('accepts queries that share a keyword with the vacancy title', () => {
    const good = ['Финансовый советник', 'Private banking', 'Wealth manager', 'HNWI'];
    expect(queriesLookSane(good, financeCfg)).toBe(true);
  });

  it('rejects off-topic queries — the "Аналитик данных" bug', () => {
    // The bug: for a "Финансовый советник" vacancy, Gemini returned these queries
    // and the search pulled 30 random "Аналитик данных" candidates.
    const bad = ['Аналитик данных', 'Data Scientist', 'Математик', 'Статистик', 'ML Engineer', 'Исследователь данных'];
    expect(queriesLookSane(bad, financeCfg)).toBe(false);
  });

  it('rejects truly off-topic queries (no shared keyword with the vacancy)', () => {
    // Note: we deliberately don't exclude "manager"/"specialist" as stop-words
    // because "Relationship Manager" IS a valid query for a private-banking vacancy.
    // Verify the negative case: queries with NO shared keyword get rejected.
    // Watch out: "Sales" overlaps with "(Private Banking Sales)" in the title.
    const weak = ['Бухгалтер', 'Логист', 'Маркетолог', 'Дизайнер'];
    expect(queriesLookSane(weak, financeCfg)).toBe(false);
  });

  it('accepts queries that match a criterion even if the title does not', () => {
    const fromCriterion = ['Private banking опыт', 'Инвестиционные продукты'];
    expect(queriesLookSane(fromCriterion, financeCfg)).toBe(true);
  });

  it('passes-through when the vacancy has no anchors (trust the LLM)', () => {
    const empty = { vacancy_title: '', vacancy_context: '', required: [], preferred: [], knockout: [], filters: {} };
    expect(queriesLookSane(['Sales', 'Manager'], empty)).toBe(true);
  });

  it('rejects empty query list', () => {
    expect(queriesLookSane([], financeCfg)).toBe(false);
    expect(queriesLookSane(null, financeCfg)).toBe(false);
  });

  it('accepts data-science queries for a data-science vacancy', () => {
    const good = ['Data Scientist', 'Machine Learning', 'Python', 'A/B testing'];
    expect(queriesLookSane(good, dataScienceCfg)).toBe(true);
  });

  it('rejects finance queries for a data-science vacancy', () => {
    const bad = ['Финансовый советник', 'Private banking', 'Wealth manager'];
    expect(queriesLookSane(bad, dataScienceCfg)).toBe(false);
  });
});

describe('deriveFallbackQueries', () => {
  it('uses vacancy_title first', () => {
    const out = deriveFallbackQueries(financeCfg);
    expect(out[0]).toBe('Финансовый советник (Private Banking Sales)');
  });

  it('appends up to top-3 weighted required criteria', () => {
    const out = deriveFallbackQueries(financeCfg);
    expect(out).toContain('Private banking опыт');
    expect(out).toContain('Продажа инвестиционных продуктов');
    expect(out).toContain('Знание фондового рынка');
  });

  it('deduplicates fully-identical entries', () => {
    // Title and criterion strings can share words but are not identical → kept as separate queries.
    // Two truly identical entries (e.g. duplicated required criterion) → dedup to one.
    const cfg = {
      vacancy_title: 'Private banking',
      required: [{ name: 'Private banking опыт', weight: 10 }, { name: 'Private banking опыт', weight: 8 }],
      preferred: [], knockout: [], filters: {},
    };
    const out = deriveFallbackQueries(cfg);
    const privateBankingCount = out.filter(q => /private banking опыт/i.test(q)).length;
    expect(privateBankingCount).toBe(1);
  });

  it('returns at most 6 items', () => {
    const cfg = {
      vacancy_title: 'A B C D E F G H',
      required: [
        { name: 'alpha beta gamma delta', weight: 10 },
        { name: 'epsilon zeta eta theta', weight: 9 },
        { name: 'iota kappa lambda mu', weight: 8 },
        { name: 'nu xi omicron pi', weight: 7 },
      ],
      preferred: [], knockout: [], filters: {},
    };
    expect(deriveFallbackQueries(cfg).length).toBeLessThanOrEqual(6);
  });

  it('handles empty config gracefully', () => {
    const out = deriveFallbackQueries({ vacancy_title: '', required: [], preferred: [], knockout: [], filters: {} });
    expect(out).toEqual([]);
  });
});