'use strict';

// nalog.ru НПД skill
// Reads/writes token from ~/agent-tokens/{USER_ID}/nalog
// USER_ID injected via env when MCP server is spawned per-session

const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_ID = process.env.USER_ID || '';

function tokenPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'nalog');
}

function readToken(userId) {
  const file = tokenPath(userId);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeToken(userId, data) {
  const file = tokenPath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

async function nalogFetch(endpoint, { method = 'GET', body, token } = {}) {
  const res = await fetch(`https://lknpd.nalog.ru/api/v1${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// If 401, try refresh then retry once
async function nalogCall(endpoint, opts, tokenData) {
  const data = await nalogFetch(endpoint, { ...opts, token: tokenData.auth_token });
  if (data.code === 'auth.unauthorized' || data.status === 401) {
    const refreshed = await doRefresh(tokenData, USER_ID);
    if (!refreshed.success) return { error: 'Auth failed and refresh failed. Ask user to re-send nalog token from Chrome extension.' };
    const fresh = readToken(USER_ID);
    return nalogFetch(endpoint, { ...opts, token: fresh.auth_token });
  }
  return data;
}

async function doRefresh(t, userId) {
  if (!t?.refresh_token || !t?.device_id) {
    return { success: false, error: 'No refresh_token or device_id stored' };
  }
  try {
    const res = await fetch('https://lknpd.nalog.ru/api/v1/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refreshToken: t.refresh_token,
        deviceInfo: { sourceType: 'WEB', sourceDeviceId: t.device_id, appVersion: '1.0.0', metaDetails: {} },
      }),
    });
    const data = await res.json();
    if (data.token) {
      writeToken(userId, {
        ...t,
        auth_token: data.token,
        expires: data.tokenExpireIn,
        refresh_token: data.refreshToken || t.refresh_token,
      });
      return { success: true, expires: data.tokenExpireIn };
    }
    return { success: false, error: data.message || 'Refresh failed' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  tools: {
    nalog_get_profile: {
      description: 'Get nalog.ru НПД user profile: INN, name, phone. Use to get INN for receipt URLs.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const t = readToken(USER_ID);
        if (!t?.auth_token) return { error: 'Nalog token not found. Ask user to send it from Chrome extension on lknpd.nalog.ru.' };
        return nalogCall('/user', {}, t);
      },
    },

    nalog_get_incomes: {
      description: 'List НПД income records for a date range. Dates in YYYY-MM-DD format.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Start date, YYYY-MM-DD' },
          to:   { type: 'string', description: 'End date, YYYY-MM-DD' },
          limit: { type: 'number', description: 'Max records (default 20)' },
        },
        required: ['from', 'to'],
      },
      handler: async ({ from, to, limit = 20 }) => {
        const t = readToken(USER_ID);
        if (!t?.auth_token) return { error: 'Nalog token not found.' };
        const f = encodeURIComponent(`${from}T00:00:00+03:00`);
        const e = encodeURIComponent(`${to}T23:59:59+03:00`);
        return nalogCall(`/incomes?from=${f}&to=${e}&limit=${limit}&offset=0`, {}, t);
      },
    },

    nalog_create_receipt: {
      description: 'Create НПД receipt (чек). Returns receipt UUID and a public print URL to share with client.',
      inputSchema: {
        type: 'object',
        properties: {
          client_name:   { type: 'string', description: 'Client display name' },
          client_type:   { type: 'string', enum: ['FROM_INDIVIDUAL', 'FROM_LEGAL'], description: 'FROM_INDIVIDUAL for private persons, FROM_LEGAL for companies/ИП' },
          client_inn:    { type: 'string', description: 'Client INN — required for FROM_LEGAL' },
          service_name:  { type: 'string', description: 'Service description on the receipt' },
          amount:        { type: 'number', description: 'Total amount in rubles' },
          payment_type:  { type: 'string', enum: ['CASH', 'WIRE'], description: 'CASH for card/cash, WIRE for bank transfer' },
        },
        required: ['client_name', 'service_name', 'amount'],
      },
      handler: async ({ client_name, client_type = 'FROM_INDIVIDUAL', client_inn, service_name, amount, payment_type = 'CASH' }) => {
        const t = readToken(USER_ID);
        if (!t?.auth_token) return { error: 'Nalog token not found.' };

        const now = new Date();
        // Moscow time offset +03:00
        const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
        const iso = msk.toISOString().replace('Z', '+03:00');

        const body = {
          paymentType: payment_type,
          ignoreMaxTotalIncomeRestriction: false,
          client: {
            displayName: client_name,
            incomeType: client_type,
            inn: client_inn || null,
            contactPhone: null,
          },
          requestTime: iso,
          operationTime: iso,
          services: [{ name: service_name, amount, quantity: 1 }],
          totalAmount: amount,
          ndsType: 'NONE',
        };

        const result = await nalogCall('/income', { method: 'POST', body }, t);

        if (result.approvedReceiptUuid) {
          // Fetch INN to build print URL
          const profile = await nalogCall('/user', {}, readToken(USER_ID));
          const inn = profile.inn || 'UNKNOWN_INN';
          result.printUrl = `https://lknpd.nalog.ru/api/v1/receipt/${inn}/${result.approvedReceiptUuid}/print`;
          result.note = 'Send printUrl to client — no auth required to open it.';
        }

        return result;
      },
    },

    nalog_refresh_token: {
      description: 'Refresh nalog.ru auth token using stored refresh_token + device_id. Call if you get auth errors.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const t = readToken(USER_ID);
        if (!t) return { error: 'No nalog token file found.' };
        return doRefresh(t, USER_ID);
      },
    },
  },
};
