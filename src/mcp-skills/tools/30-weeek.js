'use strict';

// Weeek CRM skill
// Weeek.net REST API — permanent Bearer token (no session expiry).
// Token stored in ~/agent-tokens/{USER_ID}/weeek as plain text.
// To get token: Weeek → Settings → API → Generate token.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const USER_ID = process.env.USER_ID || '';
const WEEEK_BASE = 'https://api.weeek.net/public/v1';

// ── Token storage ─────────────────────────────────────────────────────────────

function tokenPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'weeek');
}

function readToken(userId) {
  const file = tokenPath(userId);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim() || null;
}

function writeToken(userId, token) {
  const file = tokenPath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token.trim(), { mode: 0o600 });
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function weeekFetch(path, { method = 'GET', body, token } = {}) {
  const url = `${WEEEK_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Weeek API ${res.status}: ${data?.message || text.slice(0, 200)}`);
  }
  return data;
}

async function weeekCall(apiPath, opts, userId) {
  const token = readToken(userId);
  if (!token) throw new Error('Weeek token not set. Call weeek_set_token first.');
  return weeekFetch(apiPath, { ...opts, token });
}

const WEEEK_PRIVATE_BASE = 'https://api.weeek.net';

function readSession(userId) {
  const file = path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'weeek-session');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim() || null;
}

function parseWorkspaceId(cookieStr) {
  const m = cookieStr.match(/workspace_id=([^;]+)/);
  return m ? m[1].trim() : null;
}

async function doPrivateFetch(apiPath, { method = 'GET', body, cookie } = {}) {
  const url = `${WEEEK_PRIVATE_BASE}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://app.weeek.net',
      Referer: 'https://app.weeek.net/',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function refreshWeeekSession(userId) {
  const refreshScript = path.join(os.homedir(), 'trained-assist-agent', 'scripts', 'refresh-weeek-session.js');
  const profile = userId || USER_ID || 'flexi';
  const profiles = profile === 'flexi' ? 'flexi' : `${profile},flexi`;
  execSync(`node "${refreshScript}"`, {
    timeout: 90000,
    env: { ...process.env, WEEEK_SESSION_PROFILES: profiles },
    stdio: 'pipe',
  });
  return readSession(userId);
}

async function weeekPrivateFetch(apiPath, { method = 'GET', body, cookie, userId } = {}) {
  let result = await doPrivateFetch(apiPath, { method, body, cookie });
  if ((result.status === 401 || result.status === 403) && userId !== false) {
    // Auto-refresh: run headless Playwright login, get fresh cookie, retry once
    console.log('[weeek/L2] Session expired (%d), auto-refreshing…', result.status);
    try {
      const freshCookie = refreshWeeekSession(userId);
      if (freshCookie) {
        result = await doPrivateFetch(apiPath, { method, body, cookie: freshCookie });
      }
    } catch (e) {
      console.error('[weeek/L2] Auto-refresh failed:', e.message.slice(0, 150));
    }
  }
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      throw new Error('Weeek L2 сессия устарела и авторефреш не удался. Обновите вручную через /connect/weeek.');
    }
    throw new Error(`Weeek Private API ${result.status}: ${result.data?.message || JSON.stringify(result.data).slice(0, 200)}`);
  }
  return result.data;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => !!readToken(USER_ID),
  setupTools: ['weeek_status', 'weeek_set_token'],

  tools: {

    weeek_set_token: {
      description: 'Save Weeek API token for the current user. Get token: Weeek Settings → Integrations → API.',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Weeek API Bearer token' },
          user_id: { type: 'string', description: 'User ID (optional, defaults to session user)' },
        },
        required: ['token'],
      },
      handler: async ({ token, user_id }) => {
        const uid = user_id || USER_ID;
        if (!uid) return { error: 'No user_id' };
        writeToken(uid, token);
        // Verify token works
        try {
          const data = await weeekFetch('/crm/funnels', { token });
          const count = data.funnels?.length ?? '?';
          return { ok: true, message: `Token saved. Found ${count} funnels.` };
        } catch (e) {
          return { ok: true, warning: `Token saved but verification failed: ${e.message}` };
        }
      },
    },

    weeek_status: {
      description: 'Check Weeek API connection status. Returns whether token is set and valid.',
      inputSchema: { type: 'object', properties: { user_id: { type: 'string' } } },
      handler: async ({ user_id } = {}) => {
        const uid = user_id || USER_ID;
        const token = readToken(uid);
        if (!token) return { connected: false, message: 'No token. Call weeek_set_token.' };
        try {
          const data = await weeekFetch('/crm/funnels', { token });
          return { connected: true, funnels: data.funnels?.length ?? 0 };
        } catch (e) {
          return { connected: false, error: e.message };
        }
      },
    },

    weeek_list_funnels: {
      description: 'List all CRM funnels (pipelines) in Weeek.',
      inputSchema: { type: 'object', properties: { user_id: { type: 'string' } } },
      handler: async ({ user_id } = {}) => {
        const uid = user_id || USER_ID;
        const data = await weeekCall('/crm/funnels', {}, uid);
        return { funnels: data.funnels ?? [] };
      },
    },

    weeek_list_statuses: {
      description: 'List statuses (stages/columns) within a funnel.',
      inputSchema: {
        type: 'object',
        properties: {
          funnel_id: { type: 'string', description: 'Funnel ID from weeek_list_funnels' },
          user_id: { type: 'string' },
        },
        required: ['funnel_id'],
      },
      handler: async ({ funnel_id, user_id }) => {
        const uid = user_id || USER_ID;
        const data = await weeekCall(`/crm/funnels/${encodeURIComponent(funnel_id)}/statuses`, {}, uid);
        return { statuses: data.statuses ?? [] };
      },
    },

    weeek_list_deals: {
      description: 'List deals in a CRM status/stage. Supports pagination.',
      inputSchema: {
        type: 'object',
        properties: {
          status_id: { type: 'string', description: 'Status/stage ID from weeek_list_statuses' },
          limit: { type: 'number', description: 'Max deals to return (default 20, max 100)' },
          offset: { type: 'number', description: 'Pagination offset' },
          last_updated: { type: 'string', description: 'Filter deals updated after this ISO date' },
          user_id: { type: 'string' },
        },
        required: ['status_id'],
      },
      handler: async ({ status_id, limit = 20, offset = 0, last_updated, user_id }) => {
        const uid = user_id || USER_ID;
        const params = new URLSearchParams({
          limit: String(Math.min(limit, 100)),
          offset: String(offset),
          sort: '-updatedAt',
        });
        if (last_updated) params.append('lastUpdated', last_updated);
        const data = await weeekCall(`/crm/statuses/${encodeURIComponent(status_id)}/deals?${params}`, {}, uid);
        return { deals: data.deals ?? [], hasMore: data.hasMoreDeals === true };
      },
    },

    weeek_get_deal: {
      description: 'Get a single deal by ID with all its fields.',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'Deal ID' },
          user_id: { type: 'string' },
        },
        required: ['deal_id'],
      },
      handler: async ({ deal_id, user_id }) => {
        const uid = user_id || USER_ID;
        const data = await weeekCall(`/crm/deals/${encodeURIComponent(deal_id)}`, {}, uid);
        return data.deal ?? data;
      },
    },

    weeek_create_deal: {
      description: 'Create a new deal in a CRM status/stage.',
      inputSchema: {
        type: 'object',
        properties: {
          status_id: { type: 'string', description: 'Status/stage ID to create deal in' },
          title: { type: 'string', description: 'Deal title/name' },
          description: { type: 'string', description: 'Deal notes/description (plain text or HTML)' },
          amount: { type: 'number', description: 'Deal amount/price' },
          contact_id: { type: 'string', description: 'Contact ID to link (optional)' },
          custom_fields: { type: 'object', description: 'Custom field values as key-value pairs' },
          user_id: { type: 'string' },
        },
        required: ['status_id', 'title'],
      },
      handler: async ({ status_id, title, description, amount, contact_id, custom_fields, user_id }) => {
        const uid = user_id || USER_ID;
        const body = {
          title,
          ...(description !== undefined && { description }),
          ...(amount !== undefined && { price: amount }),
          ...(contact_id && { contactId: contact_id }),
          ...(custom_fields && { customFields: custom_fields }),
        };
        const data = await weeekCall(`/crm/statuses/${encodeURIComponent(status_id)}/deals`, { method: 'POST', body }, uid);
        return data.deal ?? data;
      },
    },

    weeek_update_deal: {
      description: 'Update an existing deal (title, amount, status, custom fields).',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'Deal ID to update' },
          title: { type: 'string' },
          amount: { type: 'number' },
          status_id: { type: 'string', description: 'Move to this status/stage' },
          custom_fields: { type: 'object', description: 'Custom field values to update' },
          user_id: { type: 'string' },
        },
        required: ['deal_id'],
      },
      handler: async ({ deal_id, title, amount, status_id, custom_fields, user_id }) => {
        const uid = user_id || USER_ID;
        const body = {};
        if (title !== undefined) body.title = title;
        if (amount !== undefined) body.price = amount;
        if (status_id !== undefined) body.statusId = status_id;
        if (custom_fields !== undefined) body.customFields = custom_fields;
        const data = await weeekCall(`/crm/deals/${encodeURIComponent(deal_id)}`, { method: 'PATCH', body }, uid);
        return data.deal ?? data;
      },
    },

    weeek_delete_deal: {
      description: 'Delete a deal permanently.',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['deal_id'],
      },
      handler: async ({ deal_id, user_id }) => {
        const uid = user_id || USER_ID;
        await weeekCall(`/crm/deals/${encodeURIComponent(deal_id)}`, { method: 'DELETE' }, uid);
        return { ok: true, deleted: deal_id };
      },
    },

    weeek_list_contacts: {
      description: 'List CRM contacts with optional search by name or phone/email.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (name, phone, email)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
          offset: { type: 'number' },
          user_id: { type: 'string' },
        },
      },
      handler: async ({ query, limit = 20, offset = 0, user_id } = {}) => {
        const uid = user_id || USER_ID;
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (query) params.set('query', query);
        const data = await weeekCall(`/crm/contacts?${params}`, {}, uid);
        const contacts = (data.contacts ?? []).map(c => ({
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(' '),
          phone: c.phones?.[0]?.phone ?? null,
          email: c.emails?.[0]?.email ?? null,
          company: c.company ?? null,
          createdAt: c.createdAt,
        }));
        return { contacts, hasMore: data.hasMoreContacts === true };
      },
    },

    weeek_get_contact: {
      description: 'Get a single contact by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          contact_id: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['contact_id'],
      },
      handler: async ({ contact_id, user_id }) => {
        const uid = user_id || USER_ID;
        const data = await weeekCall(`/crm/contacts/${encodeURIComponent(contact_id)}`, {}, uid);
        return data.contact ?? data;
      },
    },

    weeek_create_contact: {
      description: 'Create a new CRM contact. API uses firstName/lastName split and phones/emails as string arrays.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Full contact name (will be split into firstName/lastName)' },
          phone: { type: 'string', description: 'Phone number (e.g. "+79001234567")' },
          email: { type: 'string', description: 'Email address' },
          company: { type: 'string', description: 'Company/organization name' },
          user_id: { type: 'string' },
        },
        required: ['name'],
      },
      handler: async ({ name, phone, email, company, user_id }) => {
        const uid = user_id || USER_ID;
        // Weeek API requires firstName (required) and optional lastName
        const parts = String(name).trim().split(/\s+/);
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ') || undefined;
        const body = {
          firstName,
          ...(lastName && { lastName }),
          ...(phone && { phones: [String(phone)] }),
          ...(email && { emails: [String(email)] }),
          ...(company && { company }),
        };
        const data = await weeekCall('/crm/contacts', { method: 'POST', body }, uid);
        const c = data.contact ?? data;
        // Normalize returned contact for easier reading
        if (c && c.firstName) {
          c.name = [c.firstName, c.lastName].filter(Boolean).join(' ');
          c.phone = c.phones?.[0]?.phone ?? null;
          c.email = c.emails?.[0]?.email ?? null;
        }
        return c;
      },
    },

    weeek_update_contact: {
      description: 'Update an existing CRM contact.',
      inputSchema: {
        type: 'object',
        properties: {
          contact_id: { type: 'string' },
          name: { type: 'string', description: 'Full name (split into firstName/lastName)' },
          phone: { type: 'string' },
          email: { type: 'string' },
          company: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['contact_id'],
      },
      handler: async ({ contact_id, name, phone, email, company, user_id }) => {
        const uid = user_id || USER_ID;
        const body = {};
        if (name !== undefined) {
          const parts = String(name).trim().split(/\s+/);
          body.firstName = parts[0];
          if (parts.length > 1) body.lastName = parts.slice(1).join(' ');
        }
        if (phone !== undefined) body.phones = [String(phone)];
        if (email !== undefined) body.emails = [String(email)];
        if (company !== undefined) body.company = company;
        const data = await weeekCall(`/crm/contacts/${encodeURIComponent(contact_id)}`, { method: 'PATCH', body }, uid);
        return data.contact ?? data;
      },
    },

    weeek_add_task: {
      description: 'Add a task/action item to a deal. Use when user mentions a date ("на вторник", "завтра") or specific action to remember.',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'Deal ID to add task to' },
          title: { type: 'string', description: 'Task title (e.g. "Позвонить", "Встреча", "Отправить КП")' },
          due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format (compute from relative: "завтра", "на вторник", etc.)' },
          user_id: { type: 'string' },
        },
        required: ['deal_id', 'title'],
      },
      handler: async ({ deal_id, title, due_date, user_id }) => {
        const uid = user_id || USER_ID;
        const body = { title };
        if (due_date) body.dueDate = due_date;
        const data = await weeekCall(`/crm/deals/${encodeURIComponent(deal_id)}/tasks`, { method: 'POST', body }, uid);
        return data.task ?? data;
      },
    },

    weeek_add_comment: {
      description: 'Add a comment to a CRM deal (requires L2 session — login+password configured via /connect/weeek).',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'Deal ID to comment on' },
          text: { type: 'string', description: 'Comment text (plain text, newlines allowed)' },
          workspace_id: { type: 'string', description: 'Workspace ID (auto-detected from session cookie if omitted)' },
          user_id: { type: 'string' },
        },
        required: ['deal_id', 'text'],
      },
      handler: async ({ deal_id, text, workspace_id, user_id }) => {
        const uid = user_id || USER_ID;
        const cookie = readSession(uid);
        if (!cookie) throw new Error('Weeek L2 сессия не настроена. Добавьте логин+пароль через /connect/weeek.');
        const wsId = workspace_id || parseWorkspaceId(cookie);
        if (!wsId) throw new Error('Не удалось определить workspace_id. Передайте его явно.');
        const content = {
          type: 'doc',
          content: String(text).split(/\r?\n/).map(line =>
            line ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
                 : { type: 'paragraph' }
          ),
        };
        const data = await weeekPrivateFetch(
          `/ws/${encodeURIComponent(wsId)}/crm/deals/${encodeURIComponent(deal_id)}/comments`,
          { method: 'POST', body: { parentId: null, content }, cookie }
        );
        return data.comment ?? data;
      },
    },
  },
};
