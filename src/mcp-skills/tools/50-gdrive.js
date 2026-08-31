'use strict';

// Google Drive skill — per-user OAuth2 access.
//
// Setup flow:
//   1. gdrive_setup → generates a connect link (user clicks → Google OAuth2 consent)
//   2. User authorises → refresh token saved to agent-tokens/{userId}/gdrive
//   3. gdrive_list_files / gdrive_read_file / etc. work from that point
//
// Token file format (~/agent-tokens/{userId}/gdrive):
//   JSON: { type:"oauth2", refresh_token, access_token, expiry (ISO), email, scope }
//
// Env vars injected by browser.js into MCP process:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, AGENT_PUBLIC_URL

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const USER_ID          = process.env.USER_ID || process.env.AGENT_USER_ID || '';
const CLIENT_ID        = process.env.GOOGLE_OAUTH_CLIENT_ID     || '';
const CLIENT_SECRET    = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const AGENT_PUBLIC_URL = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '');

// ── Token file helpers ────────────────────────────────────────────────────────

function tokenFilePath(userId) {
  return path.join(os.homedir(), 'agent-tokens', userId, 'gdrive');
}

function readCredentials(userId) {
  try {
    const raw = fs.readFileSync(tokenFilePath(userId || USER_ID), 'utf8').trim();
    const d = JSON.parse(raw);
    if (d.type === 'oauth2' && d.refresh_token) return d;
  } catch {}
  return null;
}

function writeCredentials(userId, data) {
  const dir = path.join(os.homedir(), 'agent-tokens', userId || USER_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gdrive'), JSON.stringify(data), { mode: 0o600 });
}

// ── OAuth2 access token (with in-process cache + refresh) ────────────────────

const _tokenCache = new Map(); // userId → {token, expiresAt}

async function getAccessToken() {
  const uid = USER_ID;
  if (!uid) throw new Error('USER_ID не задан');

  const cached = _tokenCache.get(uid);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const creds = readCredentials(uid);
  if (!creds) {
    throw new Error(
      'Google Drive не настроен. Вызови gdrive_setup чтобы подключить аккаунт.'
    );
  }

  // Check if stored access_token is still fresh
  if (creds.access_token && creds.expiry && new Date(creds.expiry) > new Date(Date.now() + 60_000)) {
    const exp = new Date(creds.expiry).getTime();
    _tokenCache.set(uid, { token: creds.access_token, expiresAt: exp });
    return creds.access_token;
  }

  // Refresh
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET не заданы в MCP env. Обратись к оператору.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: creds.refresh_token,
      grant_type:    'refresh_token',
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Не удалось обновить токен Google: ${data.error_description || data.error || JSON.stringify(data)}`);
  }

  const expiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  writeCredentials(uid, { ...creds, access_token: data.access_token, expiry });
  _tokenCache.set(uid, { token: data.access_token, expiresAt: new Date(expiry).getTime() });
  return data.access_token;
}

// ── Drive API helper ──────────────────────────────────────────────────────────

async function driveApi(method, apiPath, body = null) {
  const token = await getAccessToken();
  const url = apiPath.startsWith('http') ? apiPath : `https://www.googleapis.com${apiPath}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const msg = err.error?.message || err.message || res.statusText;
    if (res.status === 401) throw new Error('Токен Google устарел. Вызови gdrive_setup чтобы переподключиться.');
    if (res.status === 403) throw new Error(`Нет доступа (403): ${msg}`);
    if (res.status === 404) throw new Error(`Файл/папка не найдена (404): ${msg}`);
    throw new Error(`Drive API ${res.status}: ${msg}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function exportFile(fileId, mimeType) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Export ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

async function downloadFile(fileId) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Download ${res.status}`);
  return res.text();
}

const MIME_READABLE = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'text/plain': null, 'text/csv': null, 'application/json': null,
  'text/html': null, 'text/markdown': null,
};

// ── Connect link helper (uses same pending-token infra as other services) ─────

function generateConnectLink(userId) {
  const crypto = require('crypto');
  const CONNECT_PENDING_DIR = path.join(os.homedir(), 'connect-pending');
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(CONNECT_PENDING_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CONNECT_PENDING_DIR, `${token}.json`),
    JSON.stringify({ uid: String(userId), service: 'gdrive', expires: Date.now() + 30 * 60 * 1000 })
  );
  return `${AGENT_PUBLIC_URL}/connect/gdrive?t=${token}`;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    gdrive_setup: {
      description: 'First-time setup or reconnect: generates a one-time link the user must open in a browser to authorise Google Drive access via OAuth2. Run this if gdrive is not connected or if the token expired.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const userId = USER_ID;
        if (!userId) throw new Error('USER_ID не задан');

        const existing = readCredentials(userId);
        if (existing) {
          return {
            status: 'already_configured',
            email: existing.email || '(неизвестно)',
            message: `Google Drive уже подключён (${existing.email || 'email неизвестен'}). Для переподключения сначала вызови gdrive_revoke, затем gdrive_setup снова.`,
          };
        }

        const link = generateConnectLink(userId);
        return {
          status: 'pending',
          connect_url: link,
          message: `Для подключения Google Drive перейди по ссылке:\n${link}\n\nСсылка действует 30 минут. После авторизации вернись в Telegram.`,
        };
      },
    },

    gdrive_status: {
      description: 'Check Google Drive connection status. Shows connected email and whether the token is valid.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const creds = readCredentials(USER_ID);
        if (!creds) {
          return { status: 'not_configured', message: 'Google Drive не подключён. Вызови gdrive_setup.' };
        }
        try {
          const data = await driveApi('GET', '/drive/v3/files?pageSize=1&fields=files(id)');
          return {
            status: 'connected',
            email: creds.email || '(неизвестно)',
            files_accessible: data.files?.length ?? 0,
          };
        } catch (e) {
          return { status: 'error', email: creds.email, error: e.message };
        }
      },
    },

    gdrive_revoke: {
      description: 'Disconnect Google Drive — removes the stored OAuth2 token. User will need to re-authorise via gdrive_setup.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const p = tokenFilePath(USER_ID);
        if (!fs.existsSync(p)) return { status: 'not_configured' };
        const creds = readCredentials(USER_ID);
        // Revoke at Google (best-effort)
        if (creds?.access_token) {
          fetch(`https://oauth2.googleapis.com/revoke?token=${creds.access_token}`, { method: 'POST' }).catch(() => {});
        }
        fs.unlinkSync(p);
        _tokenCache.delete(USER_ID);
        return { status: 'revoked', message: 'Доступ к Google Drive отозван. Для повторного подключения вызови gdrive_setup.' };
      },
    },

    gdrive_list_files: {
      description: 'List files in Google Drive (all shared files, or a specific folder).',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', description: 'Folder ID from Drive URL (after /folders/). Empty = list all accessible files.' },
          page_size:  { type: 'number', description: 'Max files (default 30, max 100)' },
          page_token: { type: 'string', description: 'Next page token from previous result' },
        },
      },
      handler: async ({ folder_id, page_size = 30, page_token } = {}) => {
        const limit = Math.min(page_size || 30, 100);
        let q = 'trashed=false';
        if (folder_id) q += ` and '${folder_id}' in parents`;
        const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)';
        let apiPath = `/drive/v3/files?pageSize=${limit}&orderBy=modifiedTime desc&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}`;
        if (page_token) apiPath += `&pageToken=${encodeURIComponent(page_token)}`;
        const data = await driveApi('GET', apiPath);
        return {
          files: data.files?.map(f => ({
            id: f.id, name: f.name, type: f.mimeType,
            size_kb: f.size ? Math.round(f.size / 1024) : null,
            modified: f.modifiedTime, url: f.webViewLink,
          })) ?? [],
          next_page_token: data.nextPageToken ?? null,
        };
      },
    },

    gdrive_read_file: {
      description: 'Read content of a Drive file. Google Docs → plain text, Sheets → CSV, plain text → as is. Returns first 8000 chars.',
      inputSchema: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id:   { type: 'string', description: 'File ID from Drive URL or list result' },
          max_chars: { type: 'number', description: 'Max chars to return (default 8000)' },
        },
      },
      handler: async ({ file_id, max_chars = 8000 }) => {
        const meta = await driveApi('GET', `/drive/v3/files/${file_id}?fields=id,name,mimeType,size`);
        const mime = meta.mimeType;
        let content;
        if (MIME_READABLE[mime] === null)    content = await downloadFile(file_id);
        else if (MIME_READABLE[mime])        content = await exportFile(file_id, MIME_READABLE[mime]);
        else return { error: `Тип файла не поддерживается для чтения: ${mime}`, supported: 'Google Docs, Sheets, Slides, text/plain, CSV, JSON, HTML, Markdown' };
        const truncated = content.length > max_chars;
        return { file_id, name: meta.name, mime_type: mime, content: truncated ? content.slice(0, max_chars) : content, truncated, total_chars: content.length };
      },
    },

    gdrive_search: {
      description: 'Search files in Google Drive by name or full-text content.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query:     { type: 'string', description: 'Search query — name or content' },
          folder_id: { type: 'string', description: 'Limit to this folder (optional)' },
          limit:     { type: 'number', description: 'Max results (default 20)' },
        },
      },
      handler: async ({ query, folder_id, limit = 20 }) => {
        const n = Math.min(limit || 20, 50);
        const escaped = query.replace(/'/g, "\\'");
        let q = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed=false`;
        if (folder_id) q += ` and '${folder_id}' in parents`;
        const fields = 'files(id,name,mimeType,size,modifiedTime,webViewLink)';
        const data = await driveApi('GET', `/drive/v3/files?pageSize=${n}&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}`);
        return {
          query,
          results: data.files?.map(f => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, url: f.webViewLink })) ?? [],
          count: data.files?.length ?? 0,
        };
      },
    },

    gdrive_create_file: {
      description: 'Create a new text file in Google Drive.',
      inputSchema: {
        type: 'object',
        required: ['name', 'content'],
        properties: {
          name:      { type: 'string', description: 'File name (e.g. report.txt or report.md)' },
          content:   { type: 'string', description: 'Text content' },
          folder_id: { type: 'string', description: 'Parent folder ID (optional)' },
        },
      },
      handler: async ({ name, content, folder_id }) => {
        const token = await getAccessToken();
        const metadata = { name, mimeType: 'text/plain' };
        if (folder_id) metadata.parents = [folder_id];
        const boundary = 'gdrive_mcp_boundary';
        const body = [
          `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
          `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', content, `--${boundary}--`,
        ].join('\r\n');
        const res = await fetch(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body, signal: AbortSignal.timeout(15000),
          }
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(`Create ${res.status}: ${err.error?.message || res.statusText}`);
        }
        const file = await res.json();
        return { created: true, file_id: file.id, name: file.name, url: file.webViewLink };
      },
    },

    gdrive_update_file: {
      description: 'Overwrite content of an existing file in Google Drive.',
      inputSchema: {
        type: 'object',
        required: ['file_id', 'content'],
        properties: {
          file_id: { type: 'string', description: 'File ID to update' },
          content: { type: 'string', description: 'New text content' },
        },
      },
      handler: async ({ file_id, content }) => {
        const token = await getAccessToken();
        const res = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${file_id}?uploadType=media&fields=id,name,modifiedTime`,
          {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain; charset=UTF-8' },
            body: content, signal: AbortSignal.timeout(15000),
          }
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(`Update ${res.status}: ${err.error?.message || res.statusText}`);
        }
        const file = await res.json();
        return { updated: true, file_id: file.id, name: file.name, modified: file.modifiedTime };
      },
    },

    gdrive_delete_file: {
      description: 'Move a file to trash in Google Drive (recoverable). Pass permanent:true to delete forever.',
      inputSchema: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id:   { type: 'string', description: 'File ID to delete' },
          permanent: { type: 'boolean', description: 'Permanently delete (default false = trash)' },
        },
      },
      handler: async ({ file_id, permanent = false }) => {
        if (permanent) {
          await driveApi('DELETE', `/drive/v3/files/${file_id}`);
          return { deleted: true, file_id, permanent: true };
        }
        await driveApi('PATCH', `/drive/v3/files/${file_id}`, { trashed: true });
        return { trashed: true, file_id };
      },
    },

  },
};
