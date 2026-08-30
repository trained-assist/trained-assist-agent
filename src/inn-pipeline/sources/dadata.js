'use strict';

// DaData API — fallback when BFO finds nothing
// Paid but fast. Does NOT return financial data (need Checko/BFO after).

const { wordOverlap } = require('../lib/matcher');

const DADATA_BASE = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';
const DELAY_MS = 150;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function dadataSuggest(query, token, secret, cache) {
  const cacheKey = `${query}`;
  const cached = cache.get('dadata', cacheKey);
  if (cached !== null) return cached;

  await sleep(DELAY_MS);
  try {
    const res = await fetch(DADATA_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${token}`,
        'X-Secret': secret,
      },
      body: JSON.stringify({ query, count: 5 }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { cache.set('dadata', cacheKey, []); return []; }
    const data = await res.json();
    const suggestions = data.suggestions ?? [];
    cache.set('dadata', cacheKey, suggestions);
    return suggestions;
  } catch {
    return [];
  }
}

/**
 * Multi-pass matching from DaData spec.
 * Returns the first suggestion that passes, or null.
 */
function matchDaData(query, suggestions, city) {
  const q = query.toLowerCase().trim();
  for (const s of suggestions) {
    const name = (s.value || '').toLowerCase();
    if (name === q) return s;
  }
  for (const s of suggestions) {
    const name = (s.value || '').toLowerCase();
    if (name.includes(q)) return s;
  }
  for (const s of suggestions) {
    const name = s.value || '';
    if (wordOverlap(query, name) >= 1.0) return s;
  }
  if (city) {
    for (const s of suggestions) {
      const addr = (s.data?.address?.value || '').toLowerCase();
      if (addr.includes(city.toLowerCase()) && wordOverlap(query, s.value || '') >= 0.7) return s;
    }
  }
  return null;
}

/**
 * Try to enrich a company via DaData.
 * Returns { inn, ogrn, legal, director_name, director_position, ... } or null.
 */
async function enrichViaDadata(company, variants, token, secret, cache) {
  if (!token) return null;

  const { city = '', email = '' } = company;

  for (const { query } of variants) {
    const suggestions = await dadataSuggest(query, token, secret, cache);
    const match = matchDaData(query, suggestions, city);
    if (!match) continue;

    const d = match.data || {};
    const mgmt = (d.management || {});
    return {
      inn: d.inn,
      ogrn: d.ogrn,
      legal: match.value,
      okved: d.okved?.code,
      director_name: mgmt.name || null,
      director_position: mgmt.post || null,
      requisites_confidence: 'high',
      requisites_source: 'dadata',
    };
  }

  // email-domain fallback
  if (email) {
    const domainQuery = email.replace(/@([^.]+).*/, '$1').replace(/[^а-яёa-z0-9]/gi, ' ').trim();
    if (domainQuery) {
      const suggestions = await dadataSuggest(domainQuery, token, secret, cache);
      const match = matchDaData(domainQuery, suggestions, city);
      if (match) {
        const d = match.data || {};
        const mgmt = d.management || {};
        return {
          inn: d.inn,
          ogrn: d.ogrn,
          legal: match.value,
          okved: d.okved?.code,
          director_name: mgmt.name || null,
          director_position: mgmt.post || null,
          requisites_confidence: 'medium',
          requisites_source: 'dadata',
        };
      }
    }
  }

  return null;
}

module.exports = { enrichViaDadata };
