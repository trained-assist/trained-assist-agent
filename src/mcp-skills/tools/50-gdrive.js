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
// no org policies blocking key creation, unlike the main GCP project.

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
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents',
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

// ── Sheets API helper ─────────────────────────────────────────────────────────

async function sheetsApi(method, apiPath, body = null, sa = null) {
  if (!sa) sa = requireSa();
  const token = await getAccessToken(sa);
  const res = await fetch(`https://sheets.googleapis.com/v4${apiPath}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

// ── Docs API helper (structural, index-based edits — preserves formatting) ───

async function docsApi(method, apiPath, body = null, sa = null) {
  if (!sa) sa = requireSa();
  const token = await getAccessToken(sa);
  const res = await fetch(`https://docs.googleapis.com/v1${apiPath}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error?.status === 'PERMISSION_DENIED' && data.error?.details?.some(d => d.reason === 'SERVICE_DISABLED')) {
      throw new Error(
        'Google Docs API отключён в GCP-проекте сервис-аккаунта. Точечное редактирование Google Docs (gdrive_docs_get_structure / gdrive_docs_insert_text) недоступно, пока владелец проекта его не включит: ' +
        'https://console.cloud.google.com/apis/library/docs.googleapis.com?project=trained-assist-gdrive-sa — у самого сервис-аккаунта нет прав включить API себе.'
      );
    }
    throw new Error(`Docs API ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data;
}

// Flatten a Docs API document.body.content tree into a linear list of paragraphs.
// Each entry keeps the Docs API character index range so callers can compute a
// precise insertText location without touching anything else in the document.
function flattenDocStructure(doc) {
  const out = [];
  const walk = (elements) => {
    for (const el of elements || []) {
      if (el.paragraph) {
        const style = el.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
        const bullet = el.paragraph.bullet ? true : false;
        const text = (el.paragraph.elements || [])
          .map(e => e.textRun?.content || '')
          .join('')
          .replace(/\n$/, '');
        out.push({ startIndex: el.startIndex, endIndex: el.endIndex, style, bullet, text });
      } else if (el.table) {
        for (const row of el.table.tableRows || []) {
          for (const cell of row.tableCells || []) walk(cell.content);
        }
      } else if (el.sectionBreak) {
        // no text content
      }
    }
  };
  walk(doc.body?.content);
  return out;
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
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}&supportsAllDrives=true`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Export ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

async function downloadFile(fileId, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`Download ${res.status}`);
  return res.text();
}

async function downloadFileBuffer(fileId, sa) {
  const token = await getAccessToken(sa);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(30000) }
  );
  if (!res.ok) throw new Error(`Download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const MIME_READABLE = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'text/plain': null, 'text/csv': null, 'application/json': null,
  'text/html': null, 'text/markdown': null,
};

// Excel MIME types we can parse with the built-in xlsx reader (ZIP-based).
const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel.sheet.macroEnabled.12',                    // .xlsm
]);

// ── Public files — NO Service Account needed ─────────────────────────────────
// A Google file shared "anyone with the link" is fetchable over plain HTTP.
// Do NOT reflexively call gdrive_setup for these. Two facts drive this path:
//   • CSV export (…/export?format=csv) returns only VISIBLE cell text and drops
//     any hyperlink embedded inside a cell — a limitation of the CSV format,
//     not of access.
//   • XLSX export (…/export?format=xlsx) preserves in-cell hyperlinks. The xlsx
//     is a zip; each worksheet's <hyperlink> maps to a URL via its .rels file.

const zlib = require('zlib');

// Minimal ZIP central-directory reader — enough for xlsx, no external deps.
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count && buf.readUInt32LE(off) === 0x02014b50; n++) {
    const method   = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen  = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commLen  = buf.readUInt16LE(off + 32);
    const lho      = buf.readUInt32LE(off + 42);
    const name     = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commLen;
  }
  return entries;
}

// Extract in-cell hyperlinks from an xlsx buffer → [{ sheet, cell, url }].
function extractXlsxHyperlinks(buf) {
  const entries = readZipEntries(buf);
  const out = [];
  for (const p of Object.keys(entries)) {
    const m = p.match(/^xl\/worksheets\/(sheet\d+)\.xml$/);
    if (!m) continue;
    const sheet = m[1];
    const xml = entries[p]().toString('utf8');
    const rels = {};
    const relsFile = entries[`xl/worksheets/_rels/${sheet}.xml.rels`];
    if (relsFile) {
      for (const r of relsFile().toString('utf8').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
        rels[r[1]] = r[2];
      }
    }
    // Attribute order varies (r:id may precede ref) — parse each tag order-agnostically.
    for (const h of xml.matchAll(/<hyperlink\b[^>]*\/?>/g)) {
      const tag = h[0];
      const rid = (tag.match(/r:id="([^"]+)"/) || [])[1];
      const ref = (tag.match(/\bref="([^"]+)"/) || [])[1] || null;
      if (rid && rels[rid]) out.push({ sheet, cell: ref, url: rels[rid] });
    }
  }
  return out;
}

// Decode XML entities in cell text.
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Convert column letters (A, B, AA, …) to 1-based number.
function colLetterToNum(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
  return n;
}

// Parse an xlsx Buffer → multi-sheet CSV text (no external deps, uses readZipEntries).
function parseXlsxToText(buf) {
  let entries;
  try { entries = readZipEntries(buf); } catch (e) { return `Ошибка чтения xlsx: ${e.message}`; }

  // Shared strings table
  const ss = [];
  if (entries['xl/sharedStrings.xml']) {
    const xml = entries['xl/sharedStrings.xml']().toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(t => decodeXmlEntities(t[1]));
      ss.push(parts.join(''));
    }
  }

  // Sheet names (workbook.xml + rels)
  const sheetNames = {}, rIdToNum = {};
  if (entries['xl/workbook.xml']) {
    const xml = entries['xl/workbook.xml']().toString('utf8');
    for (const m of xml.matchAll(/<sheet\b[^>]+\bname="([^"]+)"[^>]+\br:id="([^"]+)"/g)) sheetNames[m[2]] = m[1];
  }
  if (entries['xl/_rels/workbook.xml.rels']) {
    const xml = entries['xl/_rels/workbook.xml.rels']().toString('utf8');
    for (const m of xml.matchAll(/Id="([^"]+)"[^>]*Target="worksheets\/(sheet\d+)\.xml"/g)) rIdToNum[m[1]] = m[2];
  }

  const sections = [];
  for (let idx = 1; entries[`xl/worksheets/sheet${idx}.xml`]; idx++) {
    const xml = entries[`xl/worksheets/sheet${idx}.xml`]().toString('utf8');
    const rId = Object.keys(rIdToNum).find(k => rIdToNum[k] === `sheet${idx}`);
    const name = (rId && sheetNames[rId]) || `Sheet${idx}`;

    const rowsMap = new Map();
    let maxCol = 0;

    for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowNum = parseInt(rm[1]);
      const cells = new Map();
      for (const cm of rm[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1], inner = cm[2];
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        if (!ref) continue;
        const col = colLetterToNum(ref.replace(/\d+/g, ''));
        maxCol = Math.max(maxCol, col);
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        let value = '';
        if (type === 's' && vMatch) value = ss[parseInt(vMatch[1])] ?? '';
        else if (type === 'inlineStr') { const t = inner.match(/<t[^>]*>([^<]*)<\/t>/); value = t ? decodeXmlEntities(t[1]) : ''; }
        else if (type === 'b' && vMatch) value = vMatch[1] === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') value = vMatch ? vMatch[1] : '#ERR';
        else if (vMatch) value = type === 'str' ? decodeXmlEntities(vMatch[1]) : vMatch[1];
        cells.set(col, value);
      }
      if (cells.size > 0) rowsMap.set(rowNum, cells);
    }

    if (rowsMap.size > 0) {
      const maxRow = Math.max(...rowsMap.keys());
      const lines = [];
      for (let r = 1; r <= maxRow; r++) {
        const c = rowsMap.get(r) || new Map();
        const row = [];
        for (let ci = 1; ci <= maxCol; ci++) {
          const v = c.get(ci) || '';
          row.push(v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v);
        }
        lines.push(row.join(','));
      }
      sections.push(`=== ${name} ===\n${lines.join('\n')}`);
    }
  }
  return sections.length ? sections.join('\n\n') : '(пустой файл)';
}

// Pull a Google file ID out of any Drive/Docs/Sheets URL (or return the raw ID).
function parseFileId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

// ── SA lifecycle helpers (used by runner.js revoke flow) ─────────────────────

// Reads the SA email for a user without loading the full SA JSON into scope.
function getSaEmail(userId) {
  const sa = parseSaJson(userId);
  return sa ? sa.client_email : null;
}

// Deletes the GCP Service Account for a user. Best-effort — errors are logged
// but don't fail the revoke (the local token file is the source of truth).
async function deleteServiceAccount(userId) {
  const saEmail = getSaEmail(userId);
  if (!saEmail) return { deleted: false, reason: 'no_sa_configured' };
  let adcToken;
  try { adcToken = await getAdcToken(); }
  catch (e) { return { deleted: false, reason: `adc_error: ${e.message}` }; }
  const url = `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts/${encodeURIComponent(saEmail)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adcToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (res.ok || res.status === 404) return { deleted: true };
  const err = await res.json().catch(() => ({}));
  return { deleted: false, reason: `gcp_${res.status}: ${err.error?.message || res.statusText}` };
}

// ── Tools ─────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => !!parseSaJson(USER_ID),
  // These tools need no SA — expose them before gdrive_setup so Claude never
  // reflexively calls gdrive_setup for public files/folders.
  setupTools: ['gdrive_setup', 'gdrive_status', 'gdrive_public_sheet', 'gdrive_public_folder'],
  deleteServiceAccount,

  tools: {

    gdrive_setup: {
      description: 'First-time setup: creates a dedicated Google Service Account for this user, stores the credentials, and returns the SA email to share Drive folders with. Run this once before using other gdrive tools. IMPORTANT: when the result contains reply_to_user, send that text verbatim to the user — do NOT paraphrase or add instructions like "send me a link". After sharing, the user just needs to send any message and you will call gdrive_list_files automatically.',
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
            message: `SA уже настроен. Email: ${existing.client_email}`,
            reply_to_user: `🧠 Google Drive уже подключён!\n\nEmail сервис-аккаунта: \`${existing.client_email}\`\n\nРасшарь нужные папки с этим email → после этого напиши любое сообщение, я сам проверю доступ. Ссылку слать не нужно.`,
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

        // Delete existing user-managed keys to avoid accumulation (GCP limit: 10 keys per SA)
        try {
          const keysRes = await fetch(
            `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts/${encodeURIComponent(saEmail)}/keys?keyTypes=USER_MANAGED`,
            { headers: { 'Authorization': `Bearer ${adcToken}` }, signal: AbortSignal.timeout(10000) }
          );
          if (keysRes.ok) {
            const { keys = [] } = await keysRes.json();
            for (const k of keys) {
              await fetch(`https://iam.googleapis.com/v1/${k.name}`, {
                method: 'DELETE', headers: { 'Authorization': `Bearer ${adcToken}` }, signal: AbortSignal.timeout(5000),
              }).catch(() => {});
            }
          }
        } catch { /* non-critical — proceed to create new key */ }


        // Create key for the SA — retry up to 4x because GCP may return 404 briefly after SA creation (propagation delay)
        let keyData = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
          const keyRes = await fetch(
            `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts/${encodeURIComponent(saEmail)}/keys`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${adcToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE' }),
              signal: AbortSignal.timeout(15000),
            }
          );
          if (keyRes.ok) { keyData = await keyRes.json(); break; }
          const err = await keyRes.json().catch(() => ({}));
          if (keyRes.status !== 404 || attempt === 3) {
            throw new Error(`Не удалось создать ключ SA (${keyRes.status}): ${err.error?.message || keyRes.statusText}`);
          }
        }
        const saJson  = JSON.parse(Buffer.from(keyData.privateKeyData, 'base64').toString('utf8'));

        // Save to user token file
        const tokensDir = path.join(os.homedir(), 'agent-tokens', userId);
        fs.mkdirSync(tokensDir, { recursive: true });
        fs.writeFileSync(path.join(tokensDir, 'gdrive'), JSON.stringify(saJson), { mode: 0o600 });
        // Note: not setting GDRIVE_SA_JSON in process.env — the MCP server reads from disk via USER_ID

        return {
          status: 'created',
          sa_email: saJson.client_email,
          reply_to_user: `🧠 Готово! Расшарь нужные папки/файлы с этим email:\n\`${saJson.client_email}\`\n\nКак расшарить: правый клик на папке → Поделиться → добавь email → роль "Читатель" (или "Редактор" если нужна запись).\n\nПосле шаринга просто напиши мне — я сам проверю доступ. Никакую ссылку слать не нужно.`,
        };
      },
    },

    gdrive_status: {
      description: 'Check Google Drive connection status and how many files are accessible. ' +
        'NOTE: files_accessible counts only folder-shared files via files.list — files shared directly by ID return 0 here but are still readable via gdrive_read_file(file_id). ' +
        'If files_accessible=0 but you have a file ID, try gdrive_read_file directly before concluding access is broken.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const sa = parseSaJson();
        if (!sa) {
          return { status: 'not_configured', message: 'Google Drive не настроен. Вызови gdrive_setup.' };
        }
        try {
          const data = await driveApi('GET', '/drive/v3/files?pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true', null, sa);
          return {
            status: 'connected',
            files_accessible: data.files?.length ?? 0,
            note: 'files_accessible=0 is normal if files are shared directly by ID (not via folder). Use gdrive_read_file(file_id) to confirm access.',
          };
        } catch (e) {
          return { status: 'error', error: e.message };
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
        let apiPath   = `/drive/v3/files?pageSize=${limit}&orderBy=modifiedTime desc&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true`;
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

    gdrive_public_sheet: {
      description: 'Read a PUBLIC Google file (shared "anyone with the link") — NO Service Account, NO gdrive_setup needed.\n\n' +
        'Handles two cases automatically:\n' +
        '• Google Sheets URL (docs.google.com/spreadsheets/…) → exports as CSV + extracts in-cell hyperlinks\n' +
        '• Raw Drive file URL (drive.google.com/file/d/…) — e.g. an Excel .xlsx uploaded to Drive → downloads the binary and parses all sheets as CSV\n\n' +
        'ALWAYS try this tool first when the user gives you ANY Google Drive or Docs link and you do NOT have SA configured. ' +
        'Only fall back to gdrive_read_file / gdrive_setup when the file is private (403).',
      inputSchema: {
        type: 'object',
        required: ['url_or_id'],
        properties: {
          url_or_id: { type: 'string', description: 'Full Google Sheets/Drive URL or the bare file ID' },
          gid:       { type: 'string', description: 'Sheet/tab gid for CSV export (Google Sheets only; default first tab)' },
          max_chars: { type: 'number', description: 'Max chars to return (default 8000)' },
        },
      },
      handler: async ({ url_or_id, gid, max_chars = 8000 }) => {
        const id = parseFileId(url_or_id);
        if (!id) return { error: 'Не смог извлечь file ID из ввода', input: url_or_id };

        // Detect raw Drive file vs Google Sheet by URL pattern.
        const urlStr = String(url_or_id);
        const isRawDriveFile = /drive\.google\.com\/file\//i.test(urlStr) ||
          /drive\.usercontent\.google\.com/i.test(urlStr);
        const isGoogleSheet = /docs\.google\.com\/spreadsheets/i.test(urlStr);

        // Raw Drive file (e.g. xlsx uploaded to Drive) — download binary, parse.
        if (isRawDriveFile && !isGoogleSheet) {
          try {
            const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
            const r = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
            if (r.status === 403 || r.status === 401) {
              return { error: 'private_file', message: 'Файл не публичный (403). Нужен gdrive_setup — расшарь файл с SA email.' };
            }
            if (!r.ok) throw new Error(`Download ${r.status}`);
            const ct = r.headers.get('content-type') || '';
            if (ct.includes('text/html')) {
              return { error: 'html_response', message: 'Google Drive вернул HTML-страницу (возможно требует подтверждения или файл приватный). Попробуй gdrive_setup.' };
            }
            const buf = Buffer.from(await r.arrayBuffer());
            const text = parseXlsxToText(buf);
            const truncated = text.length > max_chars;
            return {
              file_id: id,
              source: 'drive_file_download',
              csv: truncated ? text.slice(0, max_chars) : text,
              csv_truncated: truncated,
              hyperlinks: [],
              hyperlink_count: 0,
            };
          } catch (e) {
            return { error: `download_failed: ${e.message}` };
          }
        }

        const base = `https://docs.google.com/spreadsheets/d/${id}/export`;

        // CSV — visible cell text (fast, but drops in-cell hyperlinks).
        let csv = '', csvError = null;
        try {
          const csvUrl = `${base}?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}`;
          const r = await fetch(csvUrl, { signal: AbortSignal.timeout(15000) });
          if (r.status === 403 || r.status === 401) {
            return { error: 'private_file', message: 'Файл не публичный (403). Это приватный файл — нужен gdrive_setup: расшарь его с SA email (gdrive_status покажет email).' };
          }
          if (!r.ok) throw new Error(`CSV ${r.status}`);
          csv = await r.text();
        } catch (e) { csvError = e.message; }

        // XLSX — preserves in-cell hyperlinks.
        let hyperlinks = [], linkError = null;
        try {
          const r = await fetch(`${base}?format=xlsx`, { signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error(`XLSX ${r.status}`);
          hyperlinks = extractXlsxHyperlinks(Buffer.from(await r.arrayBuffer()));
        } catch (e) { linkError = e.message; }

        const truncated = csv.length > max_chars;
        return {
          file_id: id,
          csv: truncated ? csv.slice(0, max_chars) : csv,
          csv_truncated: truncated,
          hyperlinks,
          hyperlink_count: hyperlinks.length,
          ...(csvError ? { csv_error: csvError } : {}),
          ...(linkError ? { hyperlink_error: linkError } : {}),
        };
      },
    },

    gdrive_public_folder: {
      description: 'List files in a PUBLIC Google Drive folder (shared "anyone with the link") — NO Service Account needed.\n\n' +
        'Use this when the user shares a Drive FOLDER link (drive.google.com/drive/folders/…). ' +
        'Returns a list of files with their IDs and names. After getting the list, use gdrive_public_sheet to read individual xlsx/csv files.',
      inputSchema: {
        type: 'object',
        required: ['folder_url_or_id'],
        properties: {
          folder_url_or_id: { type: 'string', description: 'Google Drive folder URL or folder ID' },
        },
      },
      handler: async ({ folder_url_or_id }) => {
        const urlStr = String(folder_url_or_id);
        // Extract folder ID from URL like drive.google.com/drive/folders/{id} or drive.google.com/drive/u/0/folders/{id}
        const fmatch = urlStr.match(/\/folders\/([A-Za-z0-9_-]{20,})/) || urlStr.match(/^([A-Za-z0-9_-]{20,})$/);
        const folderId = fmatch ? fmatch[1] : null;
        if (!folderId) return { error: 'Не смог извлечь folder ID из ввода', input: folder_url_or_id };

        // Try listing via SA if available, otherwise explain the limitation.
        const sa = parseSaJson();
        if (sa) {
          try {
            const q = `'${folderId}' in parents and trashed=false`;
            const fields = 'files(id,name,mimeType,size,modifiedTime,webViewLink)';
            const data = await driveApi('GET', `/drive/v3/files?pageSize=50&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true`, null, sa);
            return {
              folder_id: folderId,
              files: data.files?.map(f => ({
                id: f.id, name: f.name, type: f.mimeType,
                size_kb: f.size ? Math.round(f.size / 1024) : null,
                modified: f.modifiedTime, url: f.webViewLink,
              })) ?? [],
              count: data.files?.length ?? 0,
            };
          } catch (e) {
            return { error: e.message, folder_id: folderId };
          }
        }

        // No SA — Drive API requires auth even for public folders.
        // Return a helpful message with the folder ID so the user can open it.
        return {
          folder_id: folderId,
          files: null,
          note: 'Google Drive API требует аутентификацию для листинга папок даже у публичных. ' +
            'Запусти gdrive_setup один раз и расшарь эту папку с SA email — после этого gdrive_list_files заработает. ' +
            'Если знаешь ID конкретного файла внутри — можешь попробовать gdrive_public_sheet(file_id).',
          folder_url: `https://drive.google.com/drive/folders/${folderId}`,
        };
      },
    },

    gdrive_read_file: {
      description: 'Read content of a Drive file (requires gdrive_setup / SA access). ' +
        'Supports: Google Docs → plain text, Google Sheets → CSV, Excel .xlsx/.xlsm → parsed CSV (all sheets), plain text/CSV/JSON/HTML/Markdown → as is. ' +
        'IMPORTANT: ALWAYS try this tool for Excel files — never say "I can\'t read Excel". ' +
        'For old .xls format, suggest the user open it in Google Sheets first. ' +
        'NOTE: for public files without SA, use gdrive_public_sheet (for file URLs) or gdrive_public_folder (for folders).',
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
        const meta = await driveApi('GET', `/drive/v3/files/${file_id}?fields=id,name,mimeType,size&supportsAllDrives=true`, null, sa);
        const mime = meta.mimeType;
        let content;
        if (EXCEL_MIMES.has(mime)) {
          const buf = await downloadFileBuffer(file_id, sa);
          content = parseXlsxToText(buf);
        } else if (mime === 'application/vnd.ms-excel') {
          return {
            error: 'Формат .xls (старый Excel) не поддерживается напрямую.',
            hint: 'Открой файл в Drive → правый клик → Открыть с помощью → Google Таблицы. Затем вызови gdrive_read_file с ID новой таблицы.',
            file_id, name: meta.name, mime_type: mime,
          };
        } else if (MIME_READABLE[mime] === null) {
          content = await downloadFile(file_id, sa);
        } else if (MIME_READABLE[mime]) {
          content = await exportFile(file_id, MIME_READABLE[mime], sa);
        } else {
          return { error: `Тип файла не поддерживается: ${mime}`, supported: 'Google Docs, Sheets, Excel (.xlsx/.xlsm), Slides, text, CSV, JSON, HTML, Markdown' };
        }
        const truncated = content.length > max_chars;
        return { file_id, name: meta.name, mime_type: mime, content: truncated ? content.slice(0, max_chars) : content, truncated, total_chars: content.length };
      },
    },

    gdrive_docs_get_structure: {
      description: 'Read the STRUCTURE of a Google Doc (headings, paragraphs, list items) with precise Docs-API character indices — for PRECISE editing that does not touch formatting. ' +
        'Use this before gdrive_docs_insert_text: find the paragraph you want to anchor to (a heading or an existing line), then pass its endIndex (or the next paragraph\'s startIndex) as the insert location. ' +
        'Unlike gdrive_read_file (which flattens the doc to plain text and is safe only for READING), this never modifies the file.',
      inputSchema: {
        type: 'object',
        required: ['file_id'],
        properties: {
          file_id: { type: 'string', description: 'Google Doc file ID' },
        },
      },
      handler: async ({ file_id }) => {
        const sa  = requireSa();
        const doc = await docsApi('GET', `/documents/${file_id}`, null, sa);
        const paragraphs = flattenDocStructure(doc).filter(p => p.text.trim() !== '' || p.style !== 'NORMAL_TEXT');
        return {
          file_id,
          title: doc.title,
          paragraphs: paragraphs.map(p => ({
            start_index: p.startIndex,
            end_index: p.endIndex,
            style: p.style,       // e.g. HEADING_1, HEADING_2, NORMAL_TEXT
            bullet: p.bullet,
            text: p.text,
          })),
        };
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
        const data    = await driveApi('GET', `/drive/v3/files?pageSize=${n}&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true`, null, sa);
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

    // mimeTypes that render rich formatting Drive would silently flatten on a
    // plain-text media overwrite: headings, bold/italic runs, lists, tables all
    // become one plain-text blob. Never allow gdrive_update_file on these —
    // gdrive_docs_insert_text (index-based) is the safe alternative for Docs.
    gdrive_update_file: {
      description: 'Overwrite content of an existing PLAIN file (.txt, .csv, .json, .md) in Google Drive. ' +
        'REFUSES on native Google Docs/Sheets/Slides — a media overwrite flattens the whole file to plain text and destroys all formatting (headings, bold, lists, tables). ' +
        'For a Google Doc, use gdrive_docs_get_structure + gdrive_docs_insert_text instead (precise, index-based, preserves formatting).',
      inputSchema: {
        type: 'object',
        required: ['file_id', 'content'],
        properties: {
          file_id: { type: 'string', description: 'File ID to update' },
          content: { type: 'string', description: 'New text content' },
        },
      },
      handler: async ({ file_id, content }) => {
        const sa   = requireSa();
        const meta = await driveApi('GET', `/drive/v3/files/${file_id}?fields=id,name,mimeType&supportsAllDrives=true`, null, sa);
        const FORMATTED_MIMES = new Set([
          'application/vnd.google-apps.document',
          'application/vnd.google-apps.spreadsheet',
          'application/vnd.google-apps.presentation',
        ]);
        if (FORMATTED_MIMES.has(meta.mimeType)) {
          throw new Error(
            `Отказ: "${meta.name}" — это нативный Google ${meta.mimeType.split('.').pop()}, а не plain-text файл. ` +
            'gdrive_update_file перезапишет его как один текстовый блок и уничтожит всё форматирование (заголовки, списки, таблицы, жирный/курсив). ' +
            'Для Google Docs используй gdrive_docs_get_structure + gdrive_docs_insert_text — точечная вставка по индексу, не трогает остальной документ.'
          );
        }
        const token = await getAccessToken(sa);
        const res   = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${file_id}?uploadType=media&fields=id,name,modifiedTime&supportsAllDrives=true`,
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

    gdrive_docs_insert_text: {
      description: 'Insert text into a Google Doc at a PRECISE character index, without touching the rest of the document — formatting, headings, tables, images elsewhere are untouched. ' +
        'This is the PRECISE alternative to gdrive_update_file (which overwrites the whole doc as plain text and destroys all native formatting — never use gdrive_update_file on a real Google Doc that has headings/bold/lists/tables). ' +
        'Workflow: 1) call gdrive_docs_get_structure to find the anchor paragraph and its index range. 2) Pass index = anchor paragraph\'s end_index - 1 to insert as a new line right after that paragraph (inherits ITS style — good for adding a list item after another item). ' +
        'Pass index = the NEXT paragraph\'s start_index to insert as a new first line of the section below a heading (inherits the body-text style, not the heading style). ' +
        'Always prefix text with "\\n" unless you intend to merge into the existing line.',
      inputSchema: {
        type: 'object',
        required: ['file_id', 'index', 'text'],
        properties: {
          file_id: { type: 'string', description: 'Google Doc file ID' },
          index:   { type: 'number', description: 'Docs API character index to insert at (from gdrive_docs_get_structure)' },
          text:    { type: 'string', description: 'Text to insert (include a leading \\n to start a new paragraph/list item)' },
        },
      },
      handler: async ({ file_id, index, text }) => {
        const sa = requireSa();
        const resp = await docsApi('POST', `/documents/${file_id}:batchUpdate`, {
          requests: [{ insertText: { location: { index }, text } }],
        }, sa);
        return { inserted: true, file_id, index, chars_inserted: text.length, reply: resp.replies?.[0] ?? null };
      },
    },

    gdrive_write_sheet: {
      description: 'Write rows to a specific tab (sheet) in a Google Spreadsheet. Creates the tab if it does not exist. ' +
        'Use this to save structured data (participants, results, reports) directly into a Google Sheet. ' +
        'rows is an array of arrays — first row should be the header.\n\n' +
        'Example: gdrive_write_sheet({ spreadsheet_id: "1abc...", sheet_name: "Lingerie Show", rows: [["Компания","Сайт","Целевая"],["Рога и копыта","rogaikopyta.ru","Да"]] })',
      inputSchema: {
        type: 'object',
        required: ['spreadsheet_id', 'sheet_name', 'rows'],
        properties: {
          spreadsheet_id: { type: 'string', description: 'Google Spreadsheet ID' },
          sheet_name:     { type: 'string', description: 'Tab name to write to (created if missing)' },
          rows:           { type: 'array',  description: 'Array of rows; each row is array of cell values. First row = header.' },
          clear_first:    { type: 'boolean', description: 'Clear existing data in the tab before writing (default true)' },
        },
      },
      handler: async ({ spreadsheet_id, sheet_name, rows, clear_first = true }) => {
        if (!spreadsheet_id || !sheet_name || !Array.isArray(rows) || rows.length === 0) {
          return { error: 'Нужны: spreadsheet_id, sheet_name, rows (непустой массив)' };
        }
        const sa = requireSa();

        // 1. Get existing sheets to check if tab exists
        const meta = await sheetsApi('GET', `/spreadsheets/${spreadsheet_id}?fields=sheets.properties`, null, sa);
        const sheets = meta.sheets || [];
        const existing = sheets.find(s => s.properties?.title === sheet_name);

        let sheetId;
        if (!existing) {
          // 2. Create new tab
          const resp = await sheetsApi('POST', `/spreadsheets/${spreadsheet_id}:batchUpdate`, {
            requests: [{ addSheet: { properties: { title: sheet_name } } }],
          }, sa);
          sheetId = resp.replies?.[0]?.addSheet?.properties?.sheetId;
        } else {
          sheetId = existing.properties.sheetId;
          if (clear_first) {
            await sheetsApi('POST', `/spreadsheets/${spreadsheet_id}/values/${encodeURIComponent(sheet_name)}:clear`, {}, sa);
          }
        }

        // 3. Write data
        const range = `${sheet_name}!A1`;
        await sheetsApi('PUT', `/spreadsheets/${spreadsheet_id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
          values: rows,
        }, sa);

        return {
          written: true,
          spreadsheet_id,
          sheet_name,
          rows_written: rows.length,
          tab_created: !existing,
          url: `https://docs.google.com/spreadsheets/d/${spreadsheet_id}`,
        };
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
          await driveApi('DELETE', `/drive/v3/files/${file_id}?supportsAllDrives=true`, null, sa);
          return { deleted: true, file_id, permanent: true };
        }
        await driveApi('PATCH', `/drive/v3/files/${file_id}?supportsAllDrives=true`, { trashed: true }, sa);
        return { trashed: true, file_id };
      },
    },

  },
};
