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

  const cache = new DiskCache(cacheDir);
  const russian = exhibitors.filter(isRussian);
  const enriched = {};
  const stats = { total: exhibitors.length, russian: russian.length, with_inn: 0, with_revenue: 0, sources: {}, bad_matches_cleared: 0 };

  let done = 0;

  async function processCompany(company) {
    const id = company.id || company.name;
    const variants = queryVariants(company);
    let result = null;

    // Phase 1a: find INN on company website (fast, async)
    const siteInnPromise = company.website ? findInnOnSite(company.website, cache) : Promise.resolve(null);

    // Phase 1b: BFO search — try site_inn first if we already have one
    const site_inn = await siteInnPromise;
    const bfoVariants = site_inn
      ? [{ query: site_inn, label: 'site_inn' }, ...variants]
      : variants;

    result = await enrichViaBfo(company, bfoVariants, cache);
    if (result && site_inn) result.site_inn_found = true;

    // Phase 2: DaData fallback
    if (!result && dadataToken) {
      result = await enrichViaDadata(company, variants, dadataToken, dadataSecret, cache);
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

    // Phase 3: EGRUL — enrich director if missing
    if (result.inn && !result.director_name) {
      const eg = await egrulLookup(result.inn, cache);
      if (eg) {
        result.director_name = eg.director_name;
        result.director_position = eg.director_position;
        if (!result.legal) result.legal = eg.legal;
        if (!result.ogrn) result.ogrn = eg.ogrn;
      }
    }

    // Phase 4: Checko for missing financials
    if (result.inn && result.revenue_mln == null && checkoKey && !isQuotaExhausted()) {
      const fin = await checkoFinances(result.inn, checkoKey, cache);
      if (fin?._quota_exhausted) {
        // don't abort, just stop trying Checko
      } else if (fin) {
        Object.assign(result, fin);
      }
    }

    // Tally stats
    const src = result.requisites_source || 'unknown';
    stats.sources[src] = (stats.sources[src] || 0) + 1;
    if (result.inn) stats.with_inn++;
    if (result.revenue_mln != null) stats.with_revenue++;

    result.site_inn_found = !!site_inn;
    enriched[id] = result;
    done++;
    if (onProgress) onProgress({ done, total: russian.length, company, result });
  }

  await pool(russian, processCompany, workers);

  const report = {
    ...stats,
    coverage_percent: stats.russian > 0 ? Math.round(stats.with_inn / stats.russian * 1000) / 10 : 0,
  };

  return { enriched, report };
}

module.exports = { enrich };
