'use strict';

// Google Drive skill — per-user Service Account.
//
// Setup flow:
//   1. gdrive_setup → creates SA in trained-assist-gdrive-sa project (via VM ADC),
//      stores JSON key as agent-tokens/{userId}/gdrive
//   2. User shares Drive folder with the SA email returned by gdrive_setup
//   3. gdrive_list_files / gdrive_read_file / etc. work from that point
//
// Note: SA is created in a separate GCP project (trained-assist-gdrive-sa) that has
// no org policies blocking key creation, unlike the main project (alesa-personal-assistent).

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const GCP_PROJECT = 'trained-assist-gdrive-sa';
const USER_ID     = process.env.USER_ID || process.env.AGENT_USER_ID || '';

// ── Access token cache (per SA email, 55-min TTL) ─────────────────────────────

const _tokenCache = new Map();

// ── GCP ADC — get VM access token from metadata service ──────────────────────

async function getAdcToken() {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`GCP metadata ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// ── Service Account JWT auth ──────────────────────────────────────────────────

function parseSaJson(userId) {
  const uid = userId || USER_ID;
  const raw = uid
    ? (() => { try { return fs.readFileSync(path.join(os.homedir(), 'agent-tokens', uid, 'gdrive'), 'utf8').trim(); } catch { return null; } })()
    : process.env.GDRIVE_SA_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function makeJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive', // full scope required — drive.readonly misses externally-shared files
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  return `${data}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function exchangeJwt(sa) {
  const jwt = makeJwt(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google OAuth ошибка: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function getAccessToken(sa) {
  const key = sa.client_email;
  const cached = _tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const token = await exchangeJwt(sa);
  _tokenCache.set(key, { token, expiresAt: Date.now() + 3_600_000 });
  return token;
}

function requireSa() {
  const sa = parseSaJson();
  if (!sa) {
    throw new Error(
      'Google Drive не настроен. Вызови gdrive_setup — это автоматически создаст сервис-аккаунт.\n\n' +
      'После этого расшарь нужные папки Drive с SA email который вернёт gdrive_setup.'
    );
  }
  return sa;
}

// ── Drive API helper ──────────────────────────────────────────────────────────

async function driveApi(method, apiPath, body = null, sa = null) {
  if (!sa) sa = requireSa();
  const token = await getAccessToken(sa);
  const url   = apiPath.startsWith('http') ? apiPath : `https://www.googleapis.com${apiPath}`;
  const opts  = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const msg = err.error?.message || err.message || res.statusText;
    if (res.status === 403) throw new Error(`Нет доступа (403): ${msg}\n\nРасшарь файл/папку с SA email (gdrive_status покажет email).`);
    if (res.status === 404) throw new Error(`Файл/папка не найдена (404): ${msg}`);
    throw new Error(`Drive API ${res.status}: ${msg}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function exportFile(fileId, mimeType, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Export ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

async function downloadFile(fileId, sa) {
  const token = await getAccessToken(sa);
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

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    gdrive_setup: {
      description: 'First-time setup: creates a dedicated Google Service Account for this user, stores the credentials, and returns the SA email to share Drive folders with. Run this once before using other gdrive tools.',
      inputSchema: {
        type: 'object',
        properties: {
          display_name: { type: 'string', description: 'Human-readable SA name (optional, defaults to user ID)' },
        },
      },
      handler: async ({ display_name } = {}) => {
        const userId = USER_ID;
        if (!userId) throw new Error('USER_ID не задан');

        const existing = parseSaJson(userId);
        if (existing) {
          return {
            status: 'already_configured',
            sa_email: existing.client_email,
            message: `SA уже настроен. Поделись папкой Drive с: ${existing.client_email}`,
          };
        }

        let adcToken;
        try {
          adcToken = await getAdcToken();
        } catch (e) {
          throw new Error(
            `Не удалось получить ADC токен с VM: ${e.message}\n\n` +
            'Убедись что агент запущен на GCP VM с активным service account.'
          );
        }

        const nameSource = display_name || process.env.AGENT_USER_NAME || '';
        const handleSource = (process.env.AGENT_USER_HANDLE || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
        const _slug = (nameSource
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')   // non-ascii (Cyrillic etc.) and spaces → -
          .replace(/^-+|-+$/g, '')        // trim leading/trailing -
          .slice(0, 20))                  // leave room for suffix
          || handleSource                 // fallback: Telegram @handle (always ASCII)
          || 'user';
        const _suffix = Math.random().toString(36).slice(2, 6); // 4 random alphanumeric chars
        // GCP SA accountId: 6-30 chars, must start with lowercase letter
        const _raw = `${_slug}-${_suffix}`;
        const accountId = /^[a-z]/.test(_raw) ? _raw : `u-${_raw}`.slice(0, 30);
        const saName    = nameSource || `Agent User ${userId}`;

        // Create Service Account in the dedicated project (no org policies)
        const createRes = await fetch(
          `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${adcToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId, serviceAccount: { displayName: saName } }),
            signal: AbortSignal.timeout(15000),
          }
        );

        let saData = null;
        if (!createRes.ok) {
          const err = await createRes.json().catch(() => ({}));
          const msg = err.error?.message || createRes.statusText;
          if (createRes.status !== 409) {
            throw new Error(`Не удалось создать SA (${createRes.status}): ${msg}`);
          }
          // 409 = SA already exists — continue with derived email
        } else {
          saData = await createRes.json().catch(() => null);
        }
        const saEmail = saData?.email || `${accountId}@${GCP_PROJECT}.iam.gserviceaccount.com`;

        // Create key for the SA
        const keyRes = await fetch(
          `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts/${encodeURIComponent(saEmail)}/keys`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${adcToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE' }),
            signal: AbortSignal.timeout(15000),
          }
        );

        if (!keyRes.ok) {
          const err = await keyRes.json().catch(() => ({}));
          throw new Error(`Не удалось создать ключ SA (${keyRes.status}): ${err.error?.message || keyRes.statusText}`);
        }

        const keyData = await keyRes.json();
        const saJson  = JSON.parse(Buffer.from(keyData.privateKeyData, 'base64').toString('utf8'));

        // Save to user token file
        const tokensDir = path.join(os.homedir(), 'agent-tokens', userId);
        fs.mkdirSync(tokensDir, { recursive: true });
        fs.writeFileSync(path.join(tokensDir, 'gdrive'), JSON.stringify(saJson), { mode: 0o600 });
        process.env.GDRIVE_SA_JSON = JSON.stringify(saJson);

        return {
          status: 'created',
          sa_email: saJson.client_email,
          next_step: `Поделись нужными папками Google Drive с этим email:\n${saJson.client_email}\n\nВ Drive: правый клик на папке → Поделиться → добавь email выше → роль "Читатель" или "Редактор".\n\nПосле этого вызови gdrive_list_files чтобы убедиться что всё работает.`,
        };
      },
    },

    gdrive_status: {
      description: 'Check Google Drive connection. Shows the SA email to share folders with.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const sa = parseSaJson();
        if (!sa) {
          return { status: 'not_configured', message: 'Google Drive не настроен. Вызови gdrive_setup.' };
        }
        try {
          const data = await driveApi('GET', '/drive/v3/files?pageSize=1&fields=files(id)', null, sa);
          return {
            status: 'connected',
            sa_email: sa.client_email,
            project_id: sa.project_id,
            files_accessible: data.files?.length ?? 0,
            instruction: `Поделись папкой Drive с: ${sa.client_email}`,
          };
        } catch (e) {
          return { status: 'error', sa_email: sa.client_email, error: e.message };
        }
      },
    },

    gdrive_list_files: {
      description: 'List files in a Google Drive folder shared with your Service Account.',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id:  { type: 'string', description: 'Folder ID from Drive URL (after /folders/). Empty = list all shared files.' },
          page_size:  { type: 'number', description: 'Max files (default 30, max 100)' },
          page_token: { type: 'string', description: 'Next page token from previous result' },
        },
      },
      handler: async ({ folder_id, page_size = 30, page_token } = {}) => {
        const sa    = requireSa();
        const limit = Math.min(page_size || 30, 100);
        let q       = 'trashed=false';
        if (folder_id) q += ` and '${folder_id.replace(/'/g, '')}' in parents`;
        const fields  = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)';
        let apiPath   = `/drive/v3/files?pageSize=${limit}&orderBy=modifiedTime desc&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}`;
        if (page_token) apiPath += `&pageToken=${encodeURIComponent(page_token)}`;
        const data = await driveApi('GET', apiPath, null, sa);
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
        const sa   = requireSa();
        const meta = await driveApi('GET', `/drive/v3/files/${file_id}?fields=id,name,mimeType,size`, null, sa);
        const mime = meta.mimeType;
        let content;
        if (MIME_READABLE[mime] === null)  content = await downloadFile(file_id, sa);
        else if (MIME_READABLE[mime])      content = await exportFile(file_id, MIME_READABLE[mime], sa);
        else return { error: `Тип файла не поддерживается: ${mime}`, supported: 'Google Docs, Sheets, Slides, text/plain, CSV, JSON, HTML, Markdown' };
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
        const sa      = requireSa();
        const n       = Math.min(limit || 20, 50);
        const escaped = query.replace(/'/g, "\\'");
        let q         = `(name contains '${escaped}' or fullText contains '${escaped}') and trashed=false`;
        if (folder_id) q += ` and '${folder_id.replace(/'/g, '')}' in parents`;
        const fields  = 'files(id,name,mimeType,size,modifiedTime,webViewLink)';
        const data    = await driveApi('GET', `/drive/v3/files?pageSize=${n}&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}`, null, sa);
        return {
          query,
          results: data.files?.map(f => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, url: f.webViewLink })) ?? [],
          count: data.files?.length ?? 0,
        };
      },
    },

    gdrive_create_file: {
      description: 'Create a new text file in a Drive folder shared with your SA.',
      inputSchema: {
        type: 'object',
        required: ['name', 'content'],
        properties: {
          name:      { type: 'string', description: 'File name (e.g. report.txt)' },
          content:   { type: 'string', description: 'Text content' },
          folder_id: { type: 'string', description: 'Parent folder ID (optional)' },
        },
      },
      handler: async ({ name, content, folder_id }) => {
        const sa      = requireSa();
        const token   = await getAccessToken(sa);
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
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(`Create ${res.status}: ${err.error?.message || res.statusText}`); }
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
        const sa    = requireSa();
        const token = await getAccessToken(sa);
        const res   = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${file_id}?uploadType=media&fields=id,name,modifiedTime`,
          {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain; charset=UTF-8' },
            body: content, signal: AbortSignal.timeout(15000),
          }
        );
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(`Update ${res.status}: ${err.error?.message || res.statusText}`); }
        const file = await res.json();
        return { updated: true, file_id: file.id, name: file.name, modified: file.modifiedTime };
      },
    },

    gdrive_delete_file: {
      description: 'Move a file to trash in Google Drive. Pass permanent:true to delete forever.',
      inputSchema: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id:   { type: 'string', description: 'File ID to delete' },
          permanent: { type: 'boolean', description: 'Permanently delete (default false = trash)' },
        },
      },
      handler: async ({ file_id, permanent = false }) => {
        const sa = requireSa();
        if (permanent) {
          await driveApi('DELETE', `/drive/v3/files/${file_id}`, null, sa);
          return { deleted: true, file_id, permanent: true };
        }
        await driveApi('PATCH', `/drive/v3/files/${file_id}`, { trashed: true }, sa);
        return { trashed: true, file_id };
      },
    },

  },
};
