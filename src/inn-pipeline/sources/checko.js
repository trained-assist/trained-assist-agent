'use strict';

// Checko API — financial data by INN (paid, daily quota)

const DELAY_MS = 400;
let quotaExhausted = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkoFinances(inn, apiKey, cache) {
  if (!apiKey || !inn || quotaExhausted) return null;

  const cacheKey = `finances_${inn}`;
  const cached = cache.get('checko', cacheKey);
  if (cached !== null) return cached;

  await sleep(DELAY_MS);
  try {
    const res = await fetch(`https://api.checko.ru/v2/finances?key=${apiKey}&inn=${inn}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 403) {
      quotaExhausted = true;
      return { _quota_exhausted: true };
    }
    if (!res.ok) { cache.set('checko', cacheKey, null); return null; }

    const data = await res.json();
    const years = Object.keys(data.data || {}).sort().reverse();
    for (const year of years) {
      const rev = data.data[year]['2110'];
      const profit = data.data[year]['2400'];
      if (rev && rev > 0) {
        const result = {
          revenue_mln: Math.round(rev / 1000 * 10) / 10,
          revenue_year: parseInt(year, 10),
          net_profit_mln: profit ? Math.round(profit / 1000 * 10) / 10 : null,
          net_profit_year: profit ? parseInt(year, 10) : null,
        };
        cache.set('checko', cacheKey, result);
        return result;
      }
    }
    cache.set('checko', cacheKey, null);
    return null;
  } catch { return null; }
}

function isQuotaExhausted() { return quotaExhausted; }

module.exports = { checkoFinances, isQuotaExhausted };
