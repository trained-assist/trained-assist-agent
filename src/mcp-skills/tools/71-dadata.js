'use strict';

// DaData API — прямой доступ для разовых запросов.
// Для batch-обогащения используй inn_enrich_batch (70-inn-enrichment.js).

const path = require('path');
const fs   = require('fs');

const BASE_SUGGEST  = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';
const BASE_FIND_ID  = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const BASE_ADDR     = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const BASE_CLEAN    = 'https://cleaner.dadata.ru/api/v1/clean/address';

const USER_ID = process.env.USER_ID || '';

function readCreds() {
  const token  = process.env.INN_DADATA_TOKEN  || process.env.DADATA_TOKEN  || null;
  const secret = process.env.INN_DADATA_SECRET || process.env.DADATA_SECRET || null;

  // user config fallback (same as 70-inn-enrichment)
  if (!token) {
    try {
      const cfgPath = path.join(
        process.env.AGENT_DATA_DIR || path.join(require('os').homedir(), 'agent-data'),
        'sessions', USER_ID, '.inn-config.json',
      );
      if (fs.existsSync(cfgPath)) {
        const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        return { token: c.dadataToken || null, secret: c.dadataSecret || null };
      }
    } catch { /**/ }
  }
  return { token, secret };
}

async function post(url, creds, body, timeout = 8_000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Token ${creds.token}`,
      'X-Secret':      creds.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`DaData HTTP ${res.status}`);
  return res.json();
}

function formatParty(s) {
  const d = s.data || {};
  const mgmt = d.management || {};
  return {
    name:        s.value,
    short_name:  d.name?.short_with_opf || null,
    inn:         d.inn  || null,
    ogrn:        d.ogrn || null,
    kpp:         d.kpp  || null,
    okved:       d.okved?.code || null,
    okved_name:  d.okved?.name || null,
    status:      d.state?.status || null,  // ACTIVE / LIQUIDATED / LIQUIDATING
    address:     d.address?.value || null,
    region:      d.address?.data?.region || null,
    director:    mgmt.name || null,
    director_pos: mgmt.post || null,
    type:        d.type || null,  // LEGAL / INDIVIDUAL
  };
}

module.exports = { tools: {

  dadata_suggest: {
    description: `Search Russian companies/IPs by name or partial name via DaData.
Returns up to N matching companies with INN, OGRN, address, director, OKVED, status.
Use to find a company INN when you only know the name.`,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Company name or part of it' },
        count: { type: 'number', description: 'Max results (default 5, max 20)', default: 5 },
        status: {
          type: 'string',
          enum: ['ACTIVE', 'LIQUIDATED', 'LIQUIDATING', ''],
          description: 'Filter by status. Default: all',
          default: '',
        },
      },
    },
    handler: async ({ query, count = 5, status = '' }) => {
      const creds = readCreds();
      if (!creds.token) return { error: 'DaData token not configured. Run: inn_set_dadata_token' };

      const body = { query, count: Math.min(count, 20) };
      if (status) body.status = [status];

      let data;
      try { data = await post(BASE_SUGGEST, creds, body); }
      catch (e) { return { error: e.message }; }

      const suggestions = (data.suggestions || []).map(formatParty);
      return { query, count: suggestions.length, suggestions };
    },
  },

  dadata_find: {
    description: `Find a Russian company by INN or OGRN via DaData.
Returns full company card: legal name, address, director, OKVED, status.
More reliable than dadata_suggest when you already have the INN.`,
    inputSchema: {
      type: 'object',
      required: ['inn'],
      properties: {
        inn: { type: 'string', description: 'INN (10 digits) or OGRN (13 digits)' },
      },
    },
    handler: async ({ inn }) => {
      const creds = readCreds();
      if (!creds.token) return { error: 'DaData token not configured. Run: inn_set_dadata_token' };

      let data;
      try { data = await post(BASE_FIND_ID, creds, { query: inn, count: 1 }); }
      catch (e) { return { error: e.message }; }

      const suggestions = data.suggestions || [];
      if (!suggestions.length) return { found: false, inn };
      return { found: true, company: formatParty(suggestions[0]) };
    },
  },

  dadata_address: {
    description: `Suggest or clean a Russian address via DaData.
mode=suggest — autocomplete (returns up to N options).
mode=clean   — normalize and parse a single address into parts.`,
    inputSchema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Address string to look up or clean' },
        mode:    { type: 'string', enum: ['suggest', 'clean'], default: 'suggest' },
        count:   { type: 'number', description: 'Max suggestions (suggest mode only)', default: 3 },
      },
    },
    handler: async ({ address, mode = 'suggest', count = 3 }) => {
      const creds = readCreds();
      if (!creds.token) return { error: 'DaData token not configured.' };

      if (mode === 'clean') {
        let data;
        try {
          const res = await fetch(BASE_CLEAN, {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Token ${creds.token}`,
              'X-Secret':      creds.secret,
            },
            body: JSON.stringify([address]),
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) return { error: `DaData HTTP ${res.status}` };
          data = await res.json();
        } catch (e) { return { error: e.message }; }
        return { mode: 'clean', result: data[0] || null };
      }

      let data;
      try { data = await post(BASE_ADDR, creds, { query: address, count }); }
      catch (e) { return { error: e.message }; }

      return {
        mode: 'suggest',
        suggestions: (data.suggestions || []).map(s => ({
          value: s.value,
          postal_code:  s.data?.postal_code || null,
          region:       s.data?.region      || null,
          city:         s.data?.city        || null,
          street:       s.data?.street      || null,
          house:        s.data?.house       || null,
        })),
      };
    },
  },

}};
