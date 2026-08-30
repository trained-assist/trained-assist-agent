'use strict';

// BFO ФНС (bo.nalog.gov.ru) — main free source
// Gives INN, OGRN, director, financials without auth

const { scoreName, scoreToConfidence } = require('../lib/matcher');

const BASE = 'https://bo.nalog.gov.ru';
const DELAY_MS = 220;
const DELAY_JITTER = 80;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function delay() {
  await sleep(DELAY_MS + Math.random() * DELAY_JITTER);
}

async function fetchJson(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) { await sleep(30_000); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      if (attempt < retries) await sleep(3_000);
    }
  }
  return null;
}

/**
 * Search BFO for a single query string.
 * Returns array of raw candidates.
 */
async function bfoSearch(query, cache) {
  const cached = cache.get('bo_search', query);
  if (cached !== null) return cached;

  await delay();
  const url = `${BASE}/advanced-search/organizations/search?query=${encodeURIComponent(query)}&page=0&size=10`;
  const data = await fetchJson(url);
  const result = data?.content ?? [];
  cache.set('bo_search', query, result);
  return result;
}

/**
 * Fetch financial detail for a BFO organization id.
 * Returns { revenue_mln, revenue_year, net_profit_mln, net_profit_year } or {}
 */
async function bfoFinances(inn, bfoId, cache) {
  const cacheKey = inn || String(bfoId);
  const cached = cache.get('bo_detail', cacheKey);
  if (cached !== null) return cached;

  await delay();
  const data = await fetchJson(`${BASE}/nbo/organizations/${bfoId}/bfo/`);
  if (!Array.isArray(data)) { cache.set('bo_detail', cacheKey, {}); return {}; }

  // find latest annual report (periodType == 12)
  const annual = data
    .filter(p => p.periodType === 12)
    .sort((a, b) => b.period - a.period);

  let result = {};
  for (const period of annual) {
    const fin = period?.typeCorrections?.[0]?.correction?.financialResult;
    if (!fin) continue;
    const revenue = fin.current2110;
    const profit = fin.current2400;
    if (revenue == null) continue;
    result = {
      revenue_mln: Math.round(revenue / 1000 * 10) / 10,
      revenue_year: period.period,
      net_profit_mln: profit != null ? Math.round(profit / 1000 * 10) / 10 : null,
      net_profit_year: profit != null ? period.period : null,
    };
    break;
  }

  cache.set('bo_detail', cacheKey, result);
  return result;
}

/**
 * Try to match a company via BFO using multiple query variants.
 * Returns enriched result or null.
 */
async function enrichViaBfo(company, variants, cache) {
  let bestCandidate = null;
  let bestScore = -1;
  let bestSecond = -1;

  for (const { query } of variants) {
    const candidates = await bfoSearch(query, cache);
    if (!candidates.length) continue;

    for (const c of candidates) {
      const name = c.shortName || c.fullName || '';
      const active = c.statusCode === 1;
      const score = scoreName(company.name, name, { catalogName: company.name, active });
      if (score > bestScore) {
        bestSecond = bestScore;
        bestScore = score;
        bestCandidate = c;
      } else if (score > bestSecond) {
        bestSecond = score;
      }
    }

    // stop early on high confidence
    if (bestScore >= 120) break;
  }

  if (!bestCandidate || bestScore < 60) return null;

  const gap = bestScore - bestSecond;
  const confidence = scoreToConfidence(bestScore, gap);
  if (confidence === 'low') return null;

  const finances = await bfoFinances(bestCandidate.inn, bestCandidate.id, cache);

  return {
    inn: bestCandidate.inn,
    ogrn: bestCandidate.ogrn,
    legal: bestCandidate.shortName || bestCandidate.fullName,
    okved: bestCandidate.okved2,
    requisites_confidence: confidence,
    requisites_source: 'bo.nalog.gov.ru',
    ...finances,
    _bfo_id: bestCandidate.id,
  };
}

module.exports = { enrichViaBfo, bfoSearch, bfoFinances };
