'use strict';

// Company enrichment skill (Russian companies)
// Free: Rusprofile.ru web scraping — INN lookup, CEO, contacts, revenue
// Optional: DaData API (paid) — stored in ~/agent-tokens/{USER_ID}/dadata
//
// Rusprofile rate limit: ~1 req/sec. Responses cached in memory per process.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const USER_ID = process.env.USER_ID || '';
const RUSPROFILE_BASE = 'https://www.rusprofile.ru';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ── In-process cache (resets on restart, but avoids hammering rusprofile in one session) ──
const _cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { _cache.set(key, { ts: Date.now(), data }); }

// ── DaData token ──────────────────────────────────────────────────────────────

function dadataTokenPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'dadata');
}

function readDadataToken(userId) {
  const file = dadataTokenPath(userId);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim() || null;
}

// ── Rusprofile HTML parsing helpers ───────────────────────────────────────────

function decodeHtml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(s) {
  return decodeHtml(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*/g, ' ')  // catch incomplete tags at end of slice
    .replace(/\s+/g, ' ').trim();
}

function compact(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function unique(arr) { return [...new Set(arr.filter(Boolean))]; }
function stripMarkers(s) { return String(s || '').replace(/[!~]/g, '').trim(); }

function normalizeInn(s) { return String(s || '').replace(/\D+/g, ''); }

function extractClipValue(html, id) {
  const m = html.match(new RegExp(`<span[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
  return m ? stripTags(m[1]) : '';
}

function extractAddress(html) {
  const ti = html.indexOf('data-clipboard-target="#clip_address"');
  if (ti < 0) return '';
  const as = html.indexOf('<address', ti);
  if (as < 0) return '';
  const ae = html.indexOf('</address>', ti);
  if (ae < 0) return '';
  return stripTags(html.slice(as, ae));
}

function extractContacts(html) {
  const start = html.indexOf('id="contacts-row"');
  if (start < 0) return { phones: [], emails: [], sites: [] };
  const end = html.indexOf('anketa__pre-bottom', start);
  const block = stripTags(html.slice(start, end > start ? end : start + 8000));
  const emails = unique((block.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []));
  const phones = unique(
    (block.match(/(?:\+7|8)\s*\(?\d{3}\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g) || []).map(compact)
  );
  const sites = unique(
    (block.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || [])
      .map(s => s.toLowerCase())
      .filter(s => !s.includes('rusprofile.ru') && !s.includes('@'))
  );
  return { phones, emails, sites };
}

function parseSearchItem(item, refType) {
  const link = item?.url || item?.link || '';
  const id = (link.match(/\/(?:id|ip)\/(\d+)/) || [])[1] || item?.aci_id || '';
  return {
    refType: refType || item?.ref_type || null,
    id,
    link,
    url: link ? `${RUSPROFILE_BASE}${link}` : '',
    inn: stripMarkers(item?.inn),
    ogrn: stripMarkers(item?.ogrn || item?.raw_ogrn),
    name: stripMarkers(item?.name || item?.raw_name || ''),
    ceoName: item?.ceo_name || '',
    region: item?.region || '',
    address: item?.address || '',
    inactive: Boolean(item?.inactive),
    okved: item?.main_okved_id || '',
    okvedDescription: item?.okved_descr || '',
    registrationDate: item?.reg_date || '',
    financeRevenueMlnRub: Number.isFinite(Number(item?.finance_revenue))
      ? Math.round(Number(item.finance_revenue) / 1000) / 1000  // thousands → mln
      : null,
  };
}

function parseSearchResponse(data) {
  const ul = (data?.ul || []).map(i => parseSearchItem(i, 'UL'));
  const ip = (data?.ip || []).map(i => parseSearchItem(i, 'IP'));
  return {
    success: Boolean(data?.success),
    counts: { ul: Number(data?.ul_count || ul.length), ip: Number(data?.ip_count || ip.length) },
    companies: ul,
    entrepreneurs: ip,
    all: [...ul, ...ip],
  };
}

function parseCompanyCard(html) {
  const contacts = extractContacts(html);
  const fullName =
    stripTags((html.match(/company-header__full-name[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) || [])[1]) || '';
  const statusText =
    stripTags((html.match(/<span[^>]*class=["'][^"']*company-header__icon[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1]) || '';
  const directorBlock = (() => {
    const i = html.indexOf('Руководитель');
    return i >= 0 ? stripTags(html.slice(i, i + 600)) : '';
  })();
  return {
    inn: extractClipValue(html, 'clip_inn'),
    kpp: extractClipValue(html, 'clip_kpp'),
    ogrn: extractClipValue(html, 'clip_ogrn'),
    fullName,
    statusText,
    address: extractAddress(html),
    directorBlock,
    contacts,
  };
}

function parseFinanceLatest(html) {
  const m = html.match(/data-points=["']([\s\S]*?)["']/);
  if (!m) return null;
  let points;
  try { points = JSON.parse(decodeHtml(m[1])); } catch { return null; }
  const years = Object.keys(points).filter(y => /^\d{4}$/.test(y)).sort();
  const latestYear = [...years].reverse().find(y => points[y]?.revenue !== undefined || points[y]?.profit !== undefined);
  if (!latestYear) return null;
  const row = points[latestYear] || {};
  const toRub = v => (v === null || v === undefined || v === '') ? null : Math.round(Number(v) * 1000);
  const toMln = rub => rub === null ? null : Math.round(rub / 1000) / 1000;
  const revenueRub = toRub(row.revenue);
  const profitRub = toRub(row.profit);
  return { year: Number(latestYear), revenueRub, revenueMlnRub: toMln(revenueRub), profitRub, profitMlnRub: toMln(profitRub) };
}

// ── HTTP with pacing ──────────────────────────────────────────────────────────

let _lastReq = 0;
const MIN_DELAY_MS = 1000;

async function rusprofileFetch(urlPath, accept = 'text/html') {
  const url = urlPath.startsWith('http') ? urlPath : `${RUSPROFILE_BASE}${urlPath}`;
  const cacheKey = crypto.createHash('md5').update(url).digest('hex');
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const elapsed = Date.now() - _lastReq;
  if (_lastReq && elapsed < MIN_DELAY_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  _lastReq = Date.now();

  const res = await fetch(url, {
    headers: { accept, 'user-agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Rusprofile ${res.status}: ${url}`);
  const body = await res.text();
  const payload = { body, status: res.status };
  cacheSet(cacheKey, payload);
  return { ...payload, fromCache: false };
}

async function rusprofileSearch(query) {
  const encoded = encodeURIComponent(String(query).trim());
  const { body } = await rusprofileFetch(
    `/ajax.php?query=${encoded}&action=search`,
    'application/json,text/plain,*/*'
  );
  const data = JSON.parse(body);
  return parseSearchResponse(data);
}

async function rusprofileCard(link) {
  const p = link.startsWith('http') ? new URL(link).pathname : link;
  const { body } = await rusprofileFetch(p);
  return parseCompanyCard(body);
}

async function rusprofileFinance(cardId) {
  const { body } = await rusprofileFetch(`/finance/${cardId}`);
  return parseFinanceLatest(body);
}

// ── DaData helpers ────────────────────────────────────────────────────────────

async function dadataFindByName(query, token, limit = 5) {
  const res = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${token}`,
    },
    body: JSON.stringify({ query, count: limit, status: ['ACTIVE'] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DaData ${res.status}`);
  const data = await res.json();
  return (data.suggestions || []).map(s => ({
    name: s.value,
    inn: s.data?.inn || '',
    kpp: s.data?.kpp || '',
    ogrn: s.data?.ogrn || '',
    type: s.data?.type || '',
    status: s.data?.state?.status || '',
    address: s.data?.address?.value || '',
    ceoName: s.data?.management?.name || '',
    okved: s.data?.okved || '',
  }));
}

async function dadataFindByInn(inn, token) {
  const res = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${token}`,
    },
    body: JSON.stringify({ query: inn }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DaData ${res.status}`);
  const data = await res.json();
  const s = (data.suggestions || [])[0];
  if (!s) return null;
  return {
    name: s.value,
    inn: s.data?.inn || '',
    kpp: s.data?.kpp || '',
    ogrn: s.data?.ogrn || '',
    type: s.data?.type || '',
    status: s.data?.state?.status || '',
    address: s.data?.address?.value || '',
    ceoName: s.data?.management?.name || '',
    okved: s.data?.okved || '',
    okvedName: s.data?.okved_type || '',
    phone: s.data?.phones?.[0]?.value || '',
    email: s.data?.emails?.[0]?.value || '',
    capital: s.data?.finance?.authorized_capital || null,
    revenue: s.data?.finance?.revenue || null,
  };
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    company_set_dadata_token: {
      description: 'Save DaData API token for enhanced company lookups (paid, optional). Get at dadata.ru.',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['token'],
      },
      handler: async ({ token, user_id }) => {
        const uid = user_id || USER_ID;
        if (!uid) return { error: 'No user_id' };
        const file = dadataTokenPath(uid);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, token.trim(), { mode: 0o600 });
        return { ok: true, message: 'DaData token saved.' };
      },
    },

    company_find_by_name: {
      description: 'Find Russian company by name. Returns INN, CEO, address, OKVED. Free (Rusprofile scraping) or faster with DaData token.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Company name or keywords' },
          limit: { type: 'number', description: 'Max results (default 5)' },
          user_id: { type: 'string' },
        },
        required: ['query'],
      },
      handler: async ({ query, limit = 5, user_id }) => {
        const uid = user_id || USER_ID;
        const dadataToken = readDadataToken(uid);

        if (dadataToken) {
          const results = await dadataFindByName(query, dadataToken, limit);
          return { source: 'dadata', results: results.slice(0, limit) };
        }

        // Free: Rusprofile
        const search = await rusprofileSearch(query);
        return {
          source: 'rusprofile',
          results: search.all.slice(0, limit).map(r => ({
            inn: r.inn,
            name: r.name,
            ceoName: r.ceoName,
            region: r.region,
            address: r.address,
            okved: r.okved,
            okvedDescription: r.okvedDescription,
            registrationDate: r.registrationDate,
            inactive: r.inactive,
            financeRevenueMlnRub: r.financeRevenueMlnRub,
            rusprofileUrl: r.url,
            _id: r.id,  // needed for company_get_by_inn with finance
          })),
        };
      },
    },

    company_get_by_inn: {
      description: 'Get full company data by INN: CEO, contacts (phones, emails, websites), address, revenue, legal status. Free (Rusprofile) or with DaData for faster results.',
      inputSchema: {
        type: 'object',
        properties: {
          inn: { type: 'string', description: '10-digit INN (ИНН юрлица) or 12-digit for IP' },
          include_finance: { type: 'boolean', description: 'Fetch revenue/profit data (extra request, default true)' },
          user_id: { type: 'string' },
        },
        required: ['inn'],
      },
      handler: async ({ inn, include_finance = true, user_id }) => {
        const uid = user_id || USER_ID;
        const normalizedInn = normalizeInn(inn);
        if (!/^\d{10}(\d{2})?$/.test(normalizedInn)) {
          return { error: `Invalid INN: expected 10 or 12 digits, got "${inn}"` };
        }

        const dadataToken = readDadataToken(uid);

        if (dadataToken) {
          const result = await dadataFindByInn(normalizedInn, dadataToken);
          if (!result) return { found: false, inn: normalizedInn, source: 'dadata' };
          return { found: true, source: 'dadata', ...result };
        }

        // Free: Rusprofile
        const search = await rusprofileSearch(normalizedInn);
        const selected =
          search.all.find(i => normalizeInn(i.inn) === normalizedInn && i.refType === 'UL') ||
          search.all.find(i => normalizeInn(i.inn) === normalizedInn) ||
          null;

        if (!selected) return { found: false, inn: normalizedInn, source: 'rusprofile' };

        const card = await rusprofileCard(selected.link);
        let finance = null;
        if (include_finance && selected.refType === 'UL' && selected.id) {
          try { finance = await rusprofileFinance(selected.id); } catch { /* ignore */ }
        }

        return {
          found: true,
          source: 'rusprofile',
          inn: card.inn || normalizedInn,
          kpp: card.kpp,
          ogrn: card.ogrn,
          name: selected.name,
          fullName: card.fullName,
          status: card.statusText,
          region: selected.region,
          address: card.address || selected.address,
          okved: selected.okved,
          okvedDescription: selected.okvedDescription,
          registrationDate: selected.registrationDate,
          ceoName: selected.ceoName,
          directorBlock: card.directorBlock,
          contacts: card.contacts,
          finance,
          rusprofileUrl: selected.url,
        };
      },
    },

    company_find_by_email: {
      description: 'Find company by email address (requires DaData token — paid). Returns INN and company info.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['email'],
      },
      handler: async ({ email, user_id }) => {
        const uid = user_id || USER_ID;
        const dadataToken = readDadataToken(uid);
        if (!dadataToken) {
          return { error: 'DaData token required for email lookup. Call company_set_dadata_token first.' };
        }
        const res = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Token ${dadataToken}` },
          body: JSON.stringify({ query: email }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`DaData ${res.status}`);
        const data = await res.json();
        // email suggestions don't return company — need domain lookup instead
        // Try to find company by email domain
        const domain = email.split('@')[1];
        if (!domain) return { error: 'Invalid email' };
        const results = await dadataFindByName(domain, dadataToken, 5);
        return { source: 'dadata', email, domain, results };
      },
    },

  },
};
