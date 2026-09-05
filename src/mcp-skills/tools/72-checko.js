'use strict';

// Checko API — прямой доступ к данным по ИНН.
// Для batch-обогащения используй inn_enrich_batch (70-inn-enrichment.js).
//
// Квота: ~50 запросов/сутки (бесплатный план).
// /v2/finances — единственный endpoint с реальной выручкой, не /v2/company.

const path = require('path');
const fs   = require('fs');

const BASE = 'https://api.checko.ru/v2';

const USER_ID = process.env.USER_ID || '';

function readKey() {
  const env = process.env.INN_CHECKO_KEY || process.env.CHECKO_KEY || null;
  if (env) return env;
  try {
    const cfgPath = path.join(
      process.env.AGENT_DATA_DIR || path.join(require('os').homedir(), 'agent-data'),
      'sessions', USER_ID, '.inn-config.json',
    );
    if (fs.existsSync(cfgPath)) {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return c.checkoKey || null;
    }
  } catch { /**/ }
  return null;
}

async function checkoGet(endpoint, inn, key, extraParams = {}) {
  const params = new URLSearchParams({ key, inn, ...extraParams });
  const res = await fetch(`${BASE}/${endpoint}?${params}`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 403) return { _quota_exhausted: true };
  if (res.status === 404) return { _not_found: true };
  if (!res.ok) throw new Error(`Checko HTTP ${res.status}`);
  return res.json();
}

// CHECKO ENDPOINT CATALOG (static, for discover tool)
const CHECKO_ENDPOINTS = {
  company: {
    description: 'Основные реквизиты компании (название, адрес, статус, ОКВЭД, директор)',
    note: 'Не возвращает финансы на бесплатном плане — используй finances',
    returns: ['name', 'inn', 'ogrn', 'address', 'status', 'okved', 'director'],
  },
  finances: {
    description: 'Финансовая отчётность — выручка (2110) и прибыль (2400) по годам',
    note: 'Главный endpoint для квалификации. Возвращает данные за последние 3-5 лет',
    returns: ['year → {2110: revenue_rub, 2400: profit_rub}'],
  },
  shareholders: {
    description: 'Акционеры и учредители с долями',
    returns: ['name', 'inn', 'share_pct'],
  },
  founders: {
    description: 'Учредители (физлица и юрлица)',
    returns: ['name', 'inn', 'share_pct', 'type'],
  },
  arbitrazh: {
    description: 'Арбитражные дела (суды)',
    returns: ['case_number', 'status', 'sum', 'role'],
  },
  licenses: {
    description: 'Лицензии компании',
    returns: ['license_number', 'activity', 'date_from', 'date_to'],
  },
  contracts: {
    description: 'Государственные контракты (госзакупки)',
    returns: ['contract_number', 'customer', 'sum', 'date'],
  },
};

module.exports = { tools: {

  checko_discover: {
    description: `List all available Checko API endpoints with descriptions.
Use before checko_get to understand what data is available.`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const key = readKey();
      return {
        note: 'Daily quota ~50 requests (free plan). /v2/finances is the main endpoint for revenue.',
        key_configured: !!key,
        endpoints: CHECKO_ENDPOINTS,
        usage: 'Call checko_get with endpoint name and INN to fetch data.',
      };
    },
  },

  checko_get: {
    description: `Get any data about a Russian company from Checko by INN.

endpoint options:
  company     — basic company info (name, address, OKVED, director)
  finances    — revenue & profit by year (2110=revenue, 2400=profit, in rubles)
  shareholders — shareholders with ownership %
  founders    — founders (individuals and legal entities)
  arbitrazh   — court cases
  licenses    — company licenses
  contracts   — government contracts

IMPORTANT: always use "finances" for revenue data, not "company" (company endpoint has no financial data on free plan).`,
    inputSchema: {
      type: 'object',
      required: ['endpoint', 'inn'],
      properties: {
        endpoint: {
          type: 'string',
          enum: Object.keys(CHECKO_ENDPOINTS),
          description: 'Checko endpoint name',
        },
        inn: { type: 'string', description: 'Company INN (10 digits)' },
      },
    },
    handler: async ({ endpoint, inn }) => {
      const key = readKey();
      if (!key) return { error: 'Checko key not configured. Set INN_CHECKO_KEY env var or use inn_set_checko_key.' };

      let data;
      try { data = await checkoGet(endpoint, inn, key); }
      catch (e) { return { error: e.message, inn, endpoint }; }

      if (data._quota_exhausted) return { error: 'Checko daily quota exhausted. Resets at midnight MSK.', quota_exhausted: true };
      if (data._not_found)       return { error: 'Company not found in Checko', inn, endpoint };

      // For finances: restructure to be more readable
      if (endpoint === 'finances') {
        const years = Object.entries(data.data || {}).sort(([a], [b]) => b - a);
        const parsed = years.map(([year, codes]) => ({
          year: parseInt(year),
          revenue_rub:    codes['2110'] ?? null,
          revenue_mln:    codes['2110'] ? Math.round(codes['2110'] / 1_000_000 * 10) / 10 : null,
          profit_rub:     codes['2400'] ?? null,
          profit_mln:     codes['2400'] ? Math.round(codes['2400'] / 1_000_000 * 10) / 10 : null,
        }));
        const latest = parsed.find(r => r.revenue_rub && r.revenue_rub > 0) || null;
        return { inn, endpoint, latest_with_revenue: latest, all_years: parsed };
      }

      return { inn, endpoint, data: data.data ?? data };
    },
  },

  checko_qualify: {
    description: `Check if a Russian company qualifies as a Flexi target (t:1) or near-target (nt:1).
Fetches finances from Checko and applies target criteria:
  t:1  = production OKVED + revenue 150M–5B RUB
  nt:1 = production OKVED but no revenue data, or revenue < 150M / > 5B

Production OKVEDs: 01.x, 16.x, 20.x, 22.x, 23.x, 25.x, 26.x-28.x, 32.x`,
    inputSchema: {
      type: 'object',
      required: ['inn'],
      properties: {
        inn:   { type: 'string', description: 'Company INN' },
        okved: { type: 'string', description: 'Known OKVED code (if already have it). Otherwise fetched from company endpoint.' },
      },
    },
    handler: async ({ inn, okved }) => {
      const key = readKey();
      if (!key) return { error: 'Checko key not configured.' };

      // Get finances
      let finData;
      try { finData = await checkoGet('finances', inn, key); }
      catch (e) { return { error: e.message }; }

      if (finData._quota_exhausted) return { error: 'Quota exhausted', quota_exhausted: true };

      // Get OKVED if not provided
      if (!okved) {
        try {
          const co = await checkoGet('company', inn, key);
          okved = co?.data?.OkvedCode || null;
        } catch { /**/ }
      }

      const TARGET_OKVED = ['01.','16.','20.','22.','23.','25.','26.','27.','28.','32.'];
      const DIST_OKVED   = ['46.','47.','52.','73.','74.'];
      const isProducer   = okved ? TARGET_OKVED.some(p => okved.startsWith(p)) : null;
      const isDist       = okved ? DIST_OKVED.some(p => okved.startsWith(p))   : false;

      const years = Object.entries(finData.data || {}).sort(([a], [b]) => b - a);
      let revenue_mln = null, profit_mln = null, revenue_year = null;
      for (const [yr, codes] of years) {
        const rev = codes['2110'];
        if (rev && rev > 0) {
          revenue_mln  = Math.round(rev / 1_000_000 * 10) / 10;
          profit_mln   = codes['2400'] ? Math.round(codes['2400'] / 1_000_000 * 10) / 10 : null;
          revenue_year = parseInt(yr);
          break;
        }
      }

      let t = 0, nt = 0, reason = '';
      if (isDist) {
        reason = 'Дистрибьютор/ритейл ОКВЭД → не целевой';
      } else if (!inn) {
        nt = 1; reason = 'Нет ИНН → nt:1';
      } else if (revenue_mln === null) {
        if (isProducer !== false) { nt = 1; reason = 'Нет выручки → nt:1 (уточнить на встрече)'; }
        else { reason = 'Нет выручки, ОКВЭД не производственный → не целевой'; }
      } else if (revenue_mln < 150) {
        if (isProducer) { nt = 1; reason = `Выручка ${revenue_mln}M < 150M → nt:1 (маловато)`; }
        else { reason = `Выручка ${revenue_mln}M < 150M, не производитель → не целевой`; }
      } else if (revenue_mln <= 1000) {
        if (isProducer !== false) { t = 1; reason = `Выручка ${revenue_mln}M ∈ [150;1000] → t:1`; }
        else { reason = `Выручка ок, но ОКВЭД не производственный → не целевой`; }
      } else if (revenue_mln <= 5000) {
        if (isProducer !== false) {
          if (profit_mln === null || profit_mln <= 100) { t = 1; reason = `Выручка ${revenue_mln}M ∈ [1B;5B], прибыль ≤100M → t:1`; }
          else { nt = 1; reason = `Выручка ${revenue_mln}M, прибыль ${profit_mln}M > 100M → nt:1 (уже есть консультанты)`; }
        } else { reason = `Выручка ок, но ОКВЭД не производственный → не целевой`; }
      } else {
        nt = 1; reason = `Выручка ${revenue_mln}M > 5B → nt:1 (не наш масштаб)`;
      }

      return {
        inn, okved,
        t, nt,
        revenue_mln, revenue_year, profit_mln,
        is_producer: isProducer,
        reason,
      };
    },
  },

}};
