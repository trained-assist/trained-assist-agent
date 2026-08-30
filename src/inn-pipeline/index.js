'use strict';

const path = require('path');
const fs = require('fs');
const { DiskCache } = require('./lib/cache');
const { queryVariants } = require('./lib/variants');
const { isBadMatch } = require('./lib/matcher');
const { enrichViaBfo } = require('./sources/bfo');
const { enrichViaDadata } = require('./sources/dadata');
const { egrulLookup } = require('./sources/egrul');
const { checkoFinances, isQuotaExhausted } = require('./sources/checko');
const { findInnOnSite } = require('./sources/site-scraper');
const { logCall } = require('./lib/usage-log');

function isRussian(company) {
  const c = (company.country || '').toUpperCase();
  return !c || c === 'RUS' || c === 'RU' || c === 'РОССИЯ';
}

/**
 * Run pool of async tasks with limited concurrency.
 */
async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;

  async function run() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

/**
 * Main enrichment pipeline.
 *
 * @param {object[]} exhibitors  - array from exhibitors.json
 * @param {object}   config      - { dadataToken, dadataSecret, checkoKey, cacheDir, workers }
 * @param {function} onProgress  - called with { done, total, company, result } after each company
 * @returns {{ enriched, report }}
 */
async function enrich(exhibitors, config = {}, onProgress = null) {
  const {
    dadataToken = null,
    dadataSecret = null,
    checkoKey = null,
    cacheDir = path.join(process.cwd(), '.inn-cache'),
    workers = 8,
  } = config;

  const userId = config.userId || '';
  const cache = new DiskCache(cacheDir);
  const russian = exhibitors.filter(isRussian);
  const enriched = {};
  const stats = { total: exhibitors.length, russian: russian.length, with_inn: 0, with_revenue: 0, sources: {}, bad_matches_cleared: 0 };
  const apiCalls = {};
  const apiErrors = {};

  function trackCall(source, success, ms, extra = {}) {
    if (success) apiCalls[source] = (apiCalls[source] || 0) + 1;
    else         apiErrors[source] = (apiErrors[source] || 0) + 1;
    logCall(userId, source, success, ms, extra);
  }

  let done = 0;

  async function processCompany(company) {
    const id = company.id || company.name;
    const variants = queryVariants(company);
    let result = null;

    // Phase 1a: find INN on company website
    if (company.website) {
      const t0 = Date.now();
      try {
        const siteInn = await findInnOnSite(company.website, cache);
        trackCall('site', !!siteInn, Date.now() - t0, { company: company.name });
        if (siteInn) variants.unshift({ query: siteInn, label: 'site_inn' });
      } catch { trackCall('site', false, Date.now() - t0, { company: company.name }); }
    }

    // Phase 1b: BFO
    const t1 = Date.now();
    result = await enrichViaBfo(company, variants, cache);
    trackCall('bfo', !!result, Date.now() - t1, { company: company.name });

    // Phase 2: DaData fallback
    if (!result && dadataToken) {
      const t2 = Date.now();
      result = await enrichViaDadata(company, variants, dadataToken, dadataSecret, cache);
      trackCall('dadata', !!result, Date.now() - t2, { company: company.name });
    }

    if (!result) {
      done++;
      if (onProgress) onProgress({ done, total: russian.length, company, result: null });
      return;
    }

    // Sanity check
    if (isBadMatch(result)) {
      stats.bad_matches_cleared++;
      result = { requisites_confidence: 'low', requisites_comment: 'bad_match_cleared' };
      done++;
      if (onProgress) onProgress({ done, total: russian.length, company, result });
      enriched[id] = result;
      return;
    }

    // Phase 3: EGRUL — director
    if (result.inn && !result.director_name) {
      const t3 = Date.now();
      const eg = await egrulLookup(result.inn, cache);
      trackCall('egrul', !!eg, Date.now() - t3, { inn: result.inn });
      if (eg) {
        result.director_name = eg.director_name;
        result.director_position = eg.director_position;
        if (!result.legal) result.legal = eg.legal;
        if (!result.ogrn) result.ogrn = eg.ogrn;
      }
    }

    // Phase 4: Checko financials
    if (result.inn && result.revenue_mln == null && checkoKey && !isQuotaExhausted()) {
      const t4 = Date.now();
      const fin = await checkoFinances(result.inn, checkoKey, cache);
      trackCall('checko', !!(fin && !fin._quota_exhausted), Date.now() - t4, { inn: result.inn });
      if (fin && !fin._quota_exhausted) Object.assign(result, fin);
    }

    // Tally stats
    const src = result.requisites_source || 'unknown';
    stats.sources[src] = (stats.sources[src] || 0) + 1;
    if (result.inn) stats.with_inn++;
    if (result.revenue_mln != null) stats.with_revenue++;

    enriched[id] = result;
    done++;
    if (onProgress) onProgress({ done, total: russian.length, company, result });
  }

  await pool(russian, processCompany, workers);

  const report = {
    ...stats,
    api_calls: apiCalls,
    api_errors: Object.keys(apiErrors).length ? apiErrors : undefined,
    coverage_percent: stats.russian > 0 ? Math.round(stats.with_inn / stats.russian * 1000) / 10 : 0,
  };

  return { enriched, report };
}

module.exports = { enrich };
