'use strict';

// Drive watcher — polls Google Drive API for each user's SA.
//
// For every userId that has ~/agent-tokens/{userId}/gdrive (a service-account JSON key),
// polls Drive API every 2 min for newly shared files and sends a Telegram message.
//
// First run per userId: marks all existing shared files as "seen" (no notification).
// Subsequent runs: notifies on new shares only.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TG_BASE = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

// ── SA JWT auth (mirrors 50-gdrive.js — duplicated to avoid cross-module coupling) ──

const _tokenCache = new Map();

function _makeJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  return `${data}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function _getSaToken(sa) {
  const key = sa.client_email;
  const cached = _tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const jwt = _makeJwt(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`SA auth failed: ${JSON.stringify(data)}`);
  _tokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + 3600_000 });
  return data.access_token;
}

// ── Per-user check ────────────────────────────────────────────────────────────

function _mimeLabel(mimeType = '') {
  if (mimeType.includes('spreadsheet')) return 'таблицу';
  if (mimeType.includes('document'))    return 'документ';
  if (mimeType.includes('presentation')) return 'презентацию';
  if (mimeType.includes('folder'))      return 'папку';
  if (mimeType.includes('video'))       return 'видео';
  return 'файл';
}

// Atomic write for seenFile — prevents corrupt state on crash/OOM mid-write
function _writeSeen(seenFile, seen) {
  const tmp = `${seenFile}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify([...seen]));
    fs.renameSync(tmp, seenFile);
  } catch (e) {
    console.error('[drive-watcher] seenFile write failed:', e.message);
  }
}

async function _checkUser(userId, botToken) {
  const saFile  = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
  const seenFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-seen');
  if (!fs.existsSync(saFile)) return;

  let sa;
  try { sa = JSON.parse(fs.readFileSync(saFile, 'utf8')); }
  catch { return; }
  if (!sa?.client_email || !sa?.private_key) return;

  let token;
  try { token = await _getSaToken(sa); }
  catch (e) {
    console.error(`[drive-watcher] SA auth error userId=${userId}:`, e.message);
    return;
  }

  // Fetch ALL sharedWithMe files, following pagination (max 5 pages × 100 = 500 files).
  // The old pageSize=20 with no loop permanently missed files at positions 21+.
  let files = [];
  let pageToken;
  let pages = 0;
  try {
    do {
      const qs = `q=sharedWithMe%3Dtrue&orderBy=sharedWithMeTime%20desc&pageSize=100` +
        `&fields=nextPageToken%2Cfiles(id%2Cname%2CwebViewLink%2CmimeType%2Cowners)` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?${qs}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) {
        console.error(`[drive-watcher] Drive API ${res.status} for userId=${userId}`);
        return;
      }
      const data = await res.json();
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken;
    } while (pageToken && ++pages < 5);
  } catch (e) {
    console.error(`[drive-watcher] fetch error userId=${userId}:`, e.message);
    return;
  }

  // First run: mark everything as seen silently — don't notify about pre-existing files
  if (!fs.existsSync(seenFile)) {
    _writeSeen(seenFile, new Set(files.map(f => f.id)));
    console.log(`[drive-watcher] userId=${userId} initialized, ${files.length} pre-existing files marked seen`);
    return;
  }

  let seen;
  try { seen = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8'))); }
  catch (e) {
    // Corrupt seenFile — reinitialize with current files to avoid duplicate notifications.
    // Files shared between last good write and now will be missed on this poll only.
    console.error(`[drive-watcher] corrupt seenFile userId=${userId}, reinitializing:`, e.message);
    _writeSeen(seenFile, new Set(files.map(f => f.id)));
    return;
  }

  const newFiles = files.filter(f => !seen.has(f.id));
  if (!newFiles.length) return;

  console.log(`[drive-watcher] userId=${userId}: ${newFiles.length} new shared file(s)`);

  for (const file of newFiles) {
    const label = _mimeLabel(file.mimeType);
    const owner = file.owners?.[0]?.emailAddress || file.owners?.[0]?.displayName || '?';
    const name  = file.name || 'документ';
    const link  = file.webViewLink;
    const text  = link
      ? `📂 Мне открыли доступ к ${label} [${name}](${link})\nОт: ${owner}\n\nПришли ссылку — прочитаю.`
      : `📂 Мне открыли доступ к ${label} «${name}»\nОт: ${owner}\n\nПришли ссылку — прочитаю.`;

    await fetch(`${TG_BASE}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: userId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      }),
    }).catch(e => console.error('[drive-watcher] TG send failed:', e.message));

    // Persist seen state after every send — crash-safe; no duplicates on restart
    seen.add(file.id);
    _writeSeen(seenFile, seen);
  }
}

// ── Scan all users ────────────────────────────────────────────────────────────

async function pollDriveChanges({ botToken }) {
  const tokensBase = path.join(os.homedir(), 'agent-tokens');
  if (!fs.existsSync(tokensBase)) return;

  let entries;
  try { entries = fs.readdirSync(tokensBase); }
  catch { return; }

  for (const userId of entries) {
    if (!/^-?\d+$/.test(userId)) continue; // numeric Telegram IDs (groups have negative IDs)
    await _checkUser(userId, botToken).catch(e =>
      console.error(`[drive-watcher] uncaught error userId=${userId}:`, e.message)
    );
  }
}

// trackChat — kept for API compatibility with server.js (no longer needed)
function trackChat() {}

module.exports = { trackChat, pollDriveChanges };
