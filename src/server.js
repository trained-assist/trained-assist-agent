const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execSync, execFile, spawn } = require('child_process');
const path = require('path');
const { loadSecrets } = require('./secrets');
const { runTask, generateConnectLink, getQuickAnswer } = require('./runner');
const { getAuthFlag, clearAuthFailedFlag } = require('./auth-flag');
const { trackChat, pollDriveChanges } = require('./drive-watcher');
const { listSessions, getSession: getSessionData, archiveSessions } = require('./session-store');
const { startNalogLogin, confirmNalogCode } = require('./nalog-login');
const { startGetcourseLogin, mergeConfig: mergeGetcourseConfig } = require('./getcourse-login');
const { nalogFormHtml } = require('./connect-forms/nalog');
const { getcourseFormHtml } = require('./connect-forms/getcourse');
const { gdriveFormHtml, gdriveSuccessHtml, gdriveErrorHtml } = require('./connect-forms/gdrive');
const { hhSuccessHtml, hhErrorHtml, hhLandingHtml, hhConfirmHtml } = require('./connect-forms/hh');
const { connectFormHtml } = require('./connect-forms/generic');
const { loginCredsFormHtml } = require('./connect-forms/login-creds');
const { weeekFormHtml } = require('./connect-forms/weeek');

const PORT = process.env.PORT || 3001;
const BASE_USERS_DIR = process.env.USERS_DIR ||
  path.join(process.env.HOME || '/home/vova', 'users');

async function classifyMessage(message, sessions, apiKey) {
  // Build a compact description of each session
  const sessionDescriptions = sessions.map((s, i) => {
    const lastMsg = s.lastUserMessage ? `\n   Последнее: "${s.lastUserMessage.slice(0, 100)}"` : '';
    return `${i + 1}. ID: ${s.id}\n   Тема: "${s.topic}"${lastMsg}`;
  }).join('\n\n');

  const prompt = `Пользователь написал новое сообщение. Определи, к какому из существующих диалогов оно относится.

СУЩЕСТВУЮЩИЕ ДИАЛОГИ:
${sessionDescriptions}

НОВОЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:
"${message}"

Ответь ТОЛЬКО одной строкой — ID диалога если уверен, или слово "ambiguous" если непонятно.
Правила:
- Если сообщение явно продолжает один из диалогов — напиши его ID
- Если сообщение может относиться к нескольким диалогам или ни к одному — напиши "ambiguous"
- Не пиши ничего лишнего, только ID или "ambiguous"`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  const answer = data.content?.[0]?.text?.trim() || 'ambiguous';

  if (answer === 'ambiguous') return { sessionId: null, confidence: 'low' };

  // Check that the returned ID actually exists in the provided list
  const match = sessions.find(s => s.id === answer);
  if (!match) return { sessionId: null, confidence: 'low' };

  return { sessionId: match.id, confidence: 'high' };
}

// OAuth2 state store: state_token → {userId, expires}
const oauthStateStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStateStore) {
    if (v.expires < now) oauthStateStore.delete(k);
  }
}, 60_000);

const GDRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'openid',
  'email',
].join(' ');

function readChatId(username) {
  try { return fs.readFileSync(path.join(os.homedir(), 'agent-tokens', String(username), '.chatid'), 'utf8').trim() || null; }
  catch { return null; }
}

function scheduleNalogExpiryChecks(secrets) {
  const notified = new Set();
  const AGENT_TOKENS_DIR = path.join(os.homedir(), 'agent-tokens');
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const NOTIFY_WINDOW_MS  = 10 * 60 * 1000; // notify if expired within last 10 min

  function check() {
    if (!fs.existsSync(AGENT_TOKENS_DIR)) return;
    const now = Date.now();
    for (const username of fs.readdirSync(AGENT_TOKENS_DIR)) {
      const nalogFile = path.join(AGENT_TOKENS_DIR, username, 'nalog');
      if (!fs.existsSync(nalogFile)) continue;
      let tokenData;
      try { tokenData = JSON.parse(fs.readFileSync(nalogFile, 'utf8')); } catch { continue; }
      if (!tokenData.expires || !tokenData.auth_token) continue;
      const expiresMs = new Date(tokenData.expires).getTime();
      if (isNaN(expiresMs)) continue;
      const age = now - expiresMs;
      if (age < 0 || age > NOTIFY_WINDOW_MS) continue;
      const key = `${username}-${tokenData.expires}`;
      if (notified.has(key)) continue;
      notified.add(key);

      // Read the chatId stored by runner.js so we can send Telegram notification
      const chatIdFile = path.join(AGENT_TOKENS_DIR, username, '.chatid');
      let chatId;
      try { chatId = fs.readFileSync(chatIdFile, 'utf8').trim(); } catch { continue; }
      if (!chatId || !/^-?\d+$/.test(chatId)) continue;

      let connectUrl;
      try { connectUrl = generateConnectLink(username, 'nalog'); } catch (e) {
        console.error('[nalog-expiry] generateConnectLink failed:', e.message); continue;
      }
      const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
      fetch(`${tgBase}/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⚠️ Токен Налог.ру истёк. Хотите войти заново?\n\n👉 ${connectUrl}\n\nСсылка действительна 30 минут.`,
        }),
      }).catch(e => console.error('[nalog-expiry] tg notify failed:', e.message));
      console.log('[nalog-expiry] notified username=%s chatId=%s about expired token', username, chatId);
    }
  }

  setTimeout(check, 60 * 1000); // first check 1 min after start (tokens may be fresh on restart)
  setInterval(check, CHECK_INTERVAL_MS);
}

async function main() {
  const secrets = await loadSecrets();

  const GDRIVE_CLIENT_ID     = secrets.GOOGLE_OAUTH_CLIENT_ID;
  const GDRIVE_CLIENT_SECRET = secrets.GOOGLE_OAUTH_CLIENT_SECRET;
  const GDRIVE_REDIRECT_URI  = `${(process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '')}/connect/gdrive/callback`;

  const HH_CLIENT_ID     = secrets.HH_CLIENT_ID;
  const HH_CLIENT_SECRET = secrets.HH_CLIENT_SECRET;
  const HH_REDIRECT_URI  = process.env.HH_REDIRECT_URI || 'https://recruiter-assistant.ru/hh-callback';
  // Parse callback path from the registered redirect URI so the route handler matches regardless of domain
  const HH_CALLBACK_PATH = (() => { try { return new URL(HH_REDIRECT_URI).pathname; } catch { return '/hh-callback'; } })();

  const server = http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ── POST /connect/nalog/code — confirm 2FA code (no AGENT_SECRET needed) ──
    if (req.method === 'POST' && url.pathname === '/connect/nalog/code') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
      const { session, code } = payload;
      if (!session || !code) { res.writeHead(400).end(JSON.stringify({ error: 'missing session or code' })); return; }
      if (!/^[a-f0-9]{32}$/.test(session)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid session' })); return; }
      if (!/^\d{4,8}$/.test(code.trim())) { res.writeHead(400).end(JSON.stringify({ error: 'invalid code format' })); return; }

      const result = await confirmNalogCode(session, code.trim());
      if (result.error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: result.error })); return; }

      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, expires: result.expires }));
      if (result.userId) {
        const chatId = readChatId(result.userId);
        if (chatId) tgNotifyNalog(secrets.BOT_TOKEN, chatId, result.expires);
      }
      return;
    }

    // ── GET /connect/gdrive/start?t=TOKEN — redirect to Google OAuth2 ────────
    if (req.method === 'GET' && url.pathname === '/connect/gdrive/start') {
      const t = url.searchParams.get('t') || '';
      if (!/^[a-f0-9]{32}$/.test(t)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Неверный токен.'));
        return;
      }
      if (!GDRIVE_CLIENT_ID) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Google OAuth не настроен на сервере.'));
        return;
      }

      const CONNECT_PENDING_DIR = path.join(os.homedir(), 'connect-pending');
      const pendingFile = path.join(CONNECT_PENDING_DIR, `${t}.json`);
      let pending;
      try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Ссылка недействительна или устарела.'));
        return;
      }
      if (pending.expires < Date.now()) {
        try { fs.unlinkSync(pendingFile); } catch {}
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Ссылка устарела. Попроси новую через Telegram.'));
        return;
      }
      if (pending.service !== 'gdrive') {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Неверный сервис.'));
        return;
      }
      if (!/^-?\d{1,20}$/.test(pending.uid)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Неверный UID.'));
        return;
      }

      // Consume pending token; generate OAuth state
      try { fs.unlinkSync(pendingFile); } catch {
        // Already consumed by a concurrent request — return the same error as expired
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Ссылка уже использована.'));
        return;
      }
      const crypto = require('crypto');
      const stateToken = crypto.randomBytes(16).toString('hex');
      oauthStateStore.set(stateToken, { userId: pending.uid, expires: Date.now() + 15 * 60 * 1000 });

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', GDRIVE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', GDRIVE_REDIRECT_URI);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', GDRIVE_SCOPES);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('state', stateToken);

      res.writeHead(302, { 'Location': authUrl.toString() }).end();
      return;
    }

    // ── GET /connect/gdrive/callback?code=...&state=... ──────────────────────
    if (req.method === 'GET' && url.pathname === '/connect/gdrive/callback') {
      const code  = url.searchParams.get('code')  || '';
      const state = url.searchParams.get('state') || '';
      const error = url.searchParams.get('error') || '';

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml(`Ошибка авторизации: ${error}`));
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Неверный callback.'));
        return;
      }

      const stateData = oauthStateStore.get(state);
      if (!stateData || stateData.expires < Date.now()) {
        oauthStateStore.delete(state);
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Сессия авторизации устарела. Начни заново через Telegram.'));
        return;
      }
      oauthStateStore.delete(state);
      const { userId } = stateData;

      // Exchange code for tokens
      let tokenData;
      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: GDRIVE_CLIENT_ID,
            client_secret: GDRIVE_CLIENT_SECRET,
            redirect_uri: GDRIVE_REDIRECT_URI,
            grant_type: 'authorization_code',
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        tokenData = await tokenRes.json();
        if (!tokenData.refresh_token) {
          throw new Error(tokenData.error_description || tokenData.error || 'no refresh_token in response');
        }
      } catch (e) {
        console.error('[gdrive/callback] token exchange failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml(`Ошибка получения токена: ${e.message}`));
        return;
      }

      // Get user email via tokeninfo
      let email = '';
      try {
        const infoRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${tokenData.access_token}`, { signal: AbortSignal.timeout(5000) });
        const info = await infoRes.json();
        email = info.email || '';
      } catch { /* non-critical */ }

      // Save to user token file
      const tokensDir = path.join(os.homedir(), 'agent-tokens', userId);
      fs.mkdirSync(tokensDir, { recursive: true });
      const credData = {
        type: 'oauth2',
        access_token:  tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expiry: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
        email,
        scope: tokenData.scope || '',
      };
      fs.writeFileSync(path.join(tokensDir, 'gdrive'), JSON.stringify(credData), { mode: 0o600 });
      console.log(`[gdrive/callback] saved tokens for userId=${userId} email=${email}`);

      // Notify user in Telegram (userId is username; look up chatId from .chatid file)
      const notifyChatId = readChatId(userId);
      if (notifyChatId) {
        const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
        fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: notifyChatId,
            text: `✅ Google Drive подключён!${email ? ` (${email})` : ''}\n\nТеперь расшари нужные папки/файлы с ассистентом — он попросит тебя об этом когда нужно. Управление доступами: /secrets_list`,
          }),
        }).catch(e => console.error('[gdrive/callback] tg notify failed:', e.message));
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveSuccessHtml(email));
      return;
    }

    // ── GET /connect/hh/start?t=TOKEN — confirm page (token NOT consumed here) ──
    // Telegram link previews auto-fetch URLs; we show a button page so the token
    // is only consumed when the user actually clicks through to /connect/hh/authorize.
    if (req.method === 'GET' && url.pathname === '/connect/hh/start') {
      const t = url.searchParams.get('t') || '';
      if (!/^[a-f0-9]{32}$/.test(t)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный токен.'));
        return;
      }
      if (!HH_CLIENT_ID) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('HH OAuth не настроен на сервере.'));
        return;
      }

      const CONNECT_PENDING_DIR_HH = path.join(os.homedir(), 'connect-pending');
      const pendingFile = path.join(CONNECT_PENDING_DIR_HH, `${t}.json`);
      let pending;
      try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка недействительна или устарела.'));
        return;
      }
      if (pending.expires < Date.now()) {
        try { fs.unlinkSync(pendingFile); } catch {}
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка устарела. Попроси новую через Telegram.'));
        return;
      }
      if (pending.service !== 'hh') {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный сервис.'));
        return;
      }

      // Token is valid — show confirm page. Do NOT delete the file yet.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhConfirmHtml(t));
      return;
    }

    // ── GET /connect/hh/authorize?t=TOKEN — consume token, redirect to hh.ru OAuth ──
    if (req.method === 'GET' && url.pathname === '/connect/hh/authorize') {
      const t = url.searchParams.get('t') || '';
      if (!/^[a-f0-9]{32}$/.test(t)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный токен.'));
        return;
      }
      if (!HH_CLIENT_ID) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('HH OAuth не настроен на сервере.'));
        return;
      }

      const CONNECT_PENDING_DIR_AUTH = path.join(os.homedir(), 'connect-pending');
      const pendingFileAuth = path.join(CONNECT_PENDING_DIR_AUTH, `${t}.json`);
      let pendingAuth;
      try { pendingAuth = JSON.parse(fs.readFileSync(pendingFileAuth, 'utf8')); } catch {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка недействительна или устарела.'));
        return;
      }
      if (pendingAuth.expires < Date.now()) {
        try { fs.unlinkSync(pendingFileAuth); } catch {}
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка устарела. Попроси новую через Telegram.'));
        return;
      }
      if (pendingAuth.service !== 'hh') {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный сервис.'));
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(pendingAuth.uid)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный UID.'));
        return;
      }

      try { fs.unlinkSync(pendingFileAuth); } catch {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка уже использована.'));
        return;
      }
      const crypto = require('crypto');
      const hhStateToken = crypto.randomBytes(16).toString('hex');
      oauthStateStore.set(hhStateToken, { userId: pendingAuth.uid, expires: Date.now() + 15 * 60 * 1000 });

      const hhAuthUrl = new URL('https://hh.ru/oauth/authorize');
      hhAuthUrl.searchParams.set('response_type', 'code');
      hhAuthUrl.searchParams.set('client_id', HH_CLIENT_ID);
      hhAuthUrl.searchParams.set('redirect_uri', HH_REDIRECT_URI);
      hhAuthUrl.searchParams.set('state', hhStateToken);

      res.writeHead(302, { 'Location': hhAuthUrl.toString() }).end();
      return;
    }

    // ── GET /hh-callback?code=...&state=... (path derived from HH_REDIRECT_URI) ──
    if (req.method === 'GET' && url.pathname === HH_CALLBACK_PATH) {
      const code  = url.searchParams.get('code')  || '';
      const state = url.searchParams.get('state') || '';
      const error = url.searchParams.get('error') || '';

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml(`Ошибка авторизации: ${error}`));
        return;
      }
      if (!code || !state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhLandingHtml());
        return;
      }

      const hhStateData = oauthStateStore.get(state);
      if (!hhStateData || hhStateData.expires < Date.now()) {
        oauthStateStore.delete(state);
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Сессия авторизации устарела. Начни заново через Telegram.'));
        return;
      }
      oauthStateStore.delete(state);
      const hhUserId = hhStateData.userId; // username (profile name)

      // Exchange code for tokens
      let hhTokenData;
      try {
        const tokenRes = await fetch('https://hh.ru/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: HH_CLIENT_ID,
            client_secret: HH_CLIENT_SECRET,
            code,
            redirect_uri: HH_REDIRECT_URI,
          }).toString(),
          signal: AbortSignal.timeout(10000),
        });
        hhTokenData = await tokenRes.json();
        if (!hhTokenData.access_token) {
          throw new Error(hhTokenData.error_description || hhTokenData.error || 'no access_token');
        }
      } catch (e) {
        console.error('[hh/callback] token exchange failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml(`Ошибка получения токена: ${e.message}`));
        return;
      }

      // Get user info from HH
      let hhDisplayName = '';
      let hhEmployerId = null;
      try {
        const meRes = await fetch('https://api.hh.ru/me', {
          headers: {
            Authorization: `Bearer ${hhTokenData.access_token}`,
            'User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
            'HH-User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
          },
          signal: AbortSignal.timeout(5000),
        });
        const me = await meRes.json();
        hhDisplayName = [me.last_name, me.first_name].filter(Boolean).join(' ');
        hhEmployerId = (me.employer && me.employer.id) || null;
      } catch { /* non-critical */ }

      // Save token to ~/agent-tokens/{username}/hh
      const hhTokensDir = path.join(os.homedir(), 'agent-tokens', hhUserId);
      fs.mkdirSync(hhTokensDir, { recursive: true });
      fs.writeFileSync(
        path.join(hhTokensDir, 'hh'),
        JSON.stringify({
          access_token:  hhTokenData.access_token,
          refresh_token: hhTokenData.refresh_token || null,
          employer_id:   hhEmployerId,
          saved_at:      new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      console.log(`[hh/callback] saved token for userId=${hhUserId} name=${hhDisplayName} employer_id=${hhEmployerId}`);

      // Notify user in Telegram
      const hhChatId = readChatId(hhUserId);
      if (hhChatId) {
        const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
        fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: hhChatId,
            text: `✅ HeadHunter подключён!${hhDisplayName ? ` (${hhDisplayName})` : ''}\n\nМожешь начинать работу с вакансиями и откликами.`,
          }),
        }).catch(e => console.error('[hh/callback] tg notify failed:', e.message));
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhSuccessHtml(hhDisplayName));
      return;
    }

    // ── /connect/:service — token collection form (no AGENT_SECRET needed) ──
    const connectMatch = url.pathname.match(/^\/connect\/([a-z0-9_-]+)$/);
    if (connectMatch) {
      const service = connectMatch[1];
      const CONNECT_PENDING_DIR = path.join(os.homedir(), 'connect-pending');

      // ── nalog — multi-step browser login via Госуслуги ──────────────────────
      if (service === 'nalog') {
        if (req.method === 'GET') {
          const t = url.searchParams.get('t') || '';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(nalogFormHtml(t));
          return;
        }

        if (req.method === 'POST') {
          const body = await readBody(req);
          let payload;
          try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
          const { t, login, password } = payload;
          if (!t || !login || !password) { res.writeHead(400).end(JSON.stringify({ error: 'missing fields' })); return; }
          if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

          const pendingFile = path.join(CONNECT_PENDING_DIR, `${t}.json`);
          let pending;
          try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
          if (pending.expires < Date.now()) { try { fs.unlinkSync(pendingFile); } catch {} res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
          if (pending.service !== 'nalog') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

          try { fs.unlinkSync(pendingFile); } catch { res.writeHead(403).end(JSON.stringify({ error: 'link already used' })); return; } // one-time use

          // Browser login may take 30–60s; form sets fetch timeout to 90s
          const result = await startNalogLogin(pending.uid, login, password);

          if (result.error) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: result.error }));
            return;
          }

          if (result.status === 'ok') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', expires: result.expires }));
            const nalogChatId = readChatId(pending.uid);
            if (nalogChatId) tgNotifyNalog(secrets.BOT_TOKEN, nalogChatId, result.expires);
            return;
          }

          if (result.status === 'need_code') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'need_code', sessionId: result.sessionId }));
            return;
          }

          res.writeHead(500).end(JSON.stringify({ error: 'unexpected result' }));
          return;
        }

        res.writeHead(405).end(); return;
      }

      // ── hh — redirect to OAuth2 start ───────────────────────────────────────
      if (service === 'hh') {
        if (req.method === 'GET') {
          const t = url.searchParams.get('t') || '';
          res.writeHead(302, { Location: `/connect/hh/start?t=${encodeURIComponent(t)}` }).end();
          return;
        }
        res.writeHead(405).end(); return;
      }

      // ── gdrive — OAuth2 authorization page ───────────────────────────────────
      if (service === 'gdrive') {
        if (req.method === 'GET') {
          const t = url.searchParams.get('t') || '';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveFormHtml(t));
          return;
        }
        res.writeHead(405).end(); return;
      }

      // ── getcourse — two-level connect form (domain + apiKey + login/password) ──
      if (service === 'getcourse') {
        if (req.method === 'GET') {
          const t = url.searchParams.get('t') || '';
          // Pre-fill from saved config if available
          let gcSaved = null;
          try {
            if (/^[a-f0-9]{32}$/.test(t)) {
              const pf = path.join(os.homedir(), 'connect-pending', `${t}.json`);
              const pending = JSON.parse(fs.readFileSync(pf, 'utf8'));
              if (pending.uid && pending.expires > Date.now()) {
                const cfgFile = path.join(os.homedir(), 'agent-tokens', pending.uid, 'getcourse', 'config.json');
                if (fs.existsSync(cfgFile)) {
                  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
                  gcSaved = {
                    domain: cfg.accountDomain || null,
                    apiKey: cfg.apiKey || null,
                    login: cfg.login || null,
                    password: cfg.password || null,
                    hasSession: !!(cfg.sessionCookies && cfg.sessionCookies.length > 0),
                  };
                }
              }
            }
          } catch { /* non-critical: render form without pre-fill */ }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(getcourseFormHtml(t, gcSaved));
          return;
        }

        if (req.method === 'POST') {
          const body = await readBody(req);
          let payload;
          try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
          const { t, domain, apiKey, login, password } = payload;
          if (!t || !domain) { res.writeHead(400).end(JSON.stringify({ error: 'missing t or domain' })); return; }
          if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

          const pendingFile = path.join(CONNECT_PENDING_DIR, `${t}.json`);
          let pending;
          try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
          if (pending.expires < Date.now()) { try { fs.unlinkSync(pendingFile); } catch {} res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
          if (pending.service !== 'getcourse') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

          try { fs.unlinkSync(pendingFile); } catch { res.writeHead(403).end(JSON.stringify({ error: 'link already used' })); return; } // one-time use

          const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
          const patch = { accountDomain: cleanDomain };
          if (apiKey) patch.apiKey = apiKey.trim();
          if (login) patch.login = login.trim();
          if (password) patch.password = password; // stored for form pre-fill on next connect
          mergeGetcourseConfig(pending.uid, patch);

          let cookiesCount = 0;
          let level = [];
          if (apiKey) level.push('L1');

          if (login && password) {
            const result = await startGetcourseLogin(pending.uid, cleanDomain, login.trim(), password);
            if (result.error) {
              res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: result.error }));
              return;
            }
            cookiesCount = result.cookiesCount || 0;
            level.push('L2');
          }

          if (!level.length) level.push('domain-only');

          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, level }));
          const gcChatId = readChatId(pending.uid);
          if (gcChatId) tgNotifyGetcourse(secrets.BOT_TOKEN, gcChatId, cleanDomain, level, cookiesCount);
          return;
        }

        res.writeHead(405).end(); return;
      }

      // login-creds services: two-field (email+password) forms
      const LOGIN_CREDS_META = {
        'tilda-creds': {
          name: 'Tilda (логин)',
          hint: 'Сохраните логин и пароль от tilda.ru — ассистент сможет входить автоматически, не видя данных в чате.',
          emailLabel: 'Email от Tilda',
          emailPlaceholder: 'you@example.com',
        },
      };
      const loginCredsMeta = LOGIN_CREDS_META[service];
      if (loginCredsMeta) {
        if (req.method === 'GET') {
          const t = url.searchParams.get('t') || '';
          let lcSaved = null;
          try {
            if (/^[a-f0-9]{32}$/.test(t)) {
              const pf = path.join(os.homedir(), 'connect-pending', `${t}.json`);
              const pending = JSON.parse(fs.readFileSync(pf, 'utf8'));
              if (pending.uid && pending.expires > Date.now()) {
                const credsFile = path.join(os.homedir(), 'agent-tokens', pending.uid, service);
                if (fs.existsSync(credsFile)) {
                  const stored = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
                  lcSaved = { email: stored.email || null, password: stored.password || null };
                }
              }
            }
          } catch { /* non-critical */ }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(loginCredsFormHtml(service, loginCredsMeta, t, lcSaved));
          return;
        }

        if (req.method === 'POST') {
          const body = await readBody(req);
          let payload;
          try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
          const { t, email, password } = payload;
          if (!t || !email || !password) { res.writeHead(400).end(JSON.stringify({ error: 'missing fields' })); return; }
          if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

          const pendingFile = path.join(CONNECT_PENDING_DIR, `${t}.json`);
          let pending;
          try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
          if (pending.expires < Date.now()) { try { fs.unlinkSync(pendingFile); } catch {} res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
          if (pending.service !== service) { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

          const tokensDir = path.join(os.homedir(), 'agent-tokens', pending.uid);
          fs.mkdirSync(tokensDir, { recursive: true });
          fs.writeFileSync(
            path.join(tokensDir, service),
            JSON.stringify({ email: email.trim(), password }),
            { mode: 0o600 }
          );
          try { fs.unlinkSync(pendingFile); } catch {}
          console.log(`[connect] saved ${service} creds for uid=${pending.uid}`);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));

          const lcChatId = readChatId(pending.uid);
          if (lcChatId) {
            const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
            fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: lcChatId,
                text: `✅ ${loginCredsMeta.name} сохранён! Ассистент теперь может входить автоматически — данные изолированы от чата.\n\nУправление: /secrets_list`,
              }),
            }).catch(e => console.error('[connect] tg notify failed:', e.message));
          }
          return;
        }

        res.writeHead(405).end(); return;
      }

      // ── weeek — L1 (API token) + optional L2 (login+password for deal comments) ──
      if (service === 'weeek') {
        if (req.method === 'GET') {
          const t = url.searchParams.get('t') || '';
          let savedToken = null, savedLogin = null;
          try {
            if (/^[a-f0-9]{32}$/.test(t)) {
              const pf = path.join(os.homedir(), 'connect-pending', `${t}.json`);
              const pending = JSON.parse(fs.readFileSync(pf, 'utf8'));
              if (pending.uid && pending.expires > Date.now()) {
                const tokFile = path.join(os.homedir(), 'agent-tokens', pending.uid, 'weeek');
                if (fs.existsSync(tokFile)) savedToken = fs.readFileSync(tokFile, 'utf8').trim() || null;
                const loginFile = path.join(os.homedir(), 'agent-tokens', pending.uid, 'weeek-login');
                if (fs.existsSync(loginFile)) {
                  const stored = JSON.parse(fs.readFileSync(loginFile, 'utf8'));
                  savedLogin = { email: stored.email || null, password: stored.password || null };
                }
              }
            }
          } catch { /* non-critical */ }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end(weeekFormHtml(t, savedToken, savedLogin));
          return;
        }

        if (req.method === 'POST') {
          const body = await readBody(req);
          let payload;
          try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
          const { t, token: apiToken, email, password } = payload;
          if (!t || !apiToken) { res.writeHead(400).end(JSON.stringify({ error: 'missing t or token' })); return; }
          if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

          const pendingFile = path.join(CONNECT_PENDING_DIR, `${t}.json`);
          let pending;
          try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
          if (pending.expires < Date.now()) { try { fs.unlinkSync(pendingFile); } catch {} res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
          if (pending.service !== 'weeek') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid in token' })); return; }

          const tokensDir = path.join(os.homedir(), 'agent-tokens', pending.uid);
          fs.mkdirSync(tokensDir, { recursive: true });
          fs.writeFileSync(path.join(tokensDir, 'weeek'), String(apiToken).trim(), { mode: 0o600 });

          const level = ['L1'];
          if (email && password) {
            fs.writeFileSync(
              path.join(tokensDir, 'weeek-login'),
              JSON.stringify({ email: email.trim(), password }),
              { mode: 0o600 }
            );
            level.push('L2');
          }

          try { fs.unlinkSync(pendingFile); } catch {}
          console.log(`[connect] saved weeek token (level=${level.join('+')}) for uid=${pending.uid}`);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, level }));

          const wkChatId = readChatId(pending.uid);
          if (wkChatId) {
            const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
            let notifyText = '✅ Weeek CRM подключён!\n';
            notifyText += '• L1 (API токен): ✓ создание сделок, контактов, задач\n';
            if (level.includes('L2')) notifyText += '• L2 (логин+пароль): ✓ комментарии к сделкам\n';
            notifyText += '\nУправление: /secrets_list';
            fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: wkChatId, text: notifyText }),
            }).catch(e => console.error('[connect] tg notify failed:', e.message));
          }
          return;
        }

        res.writeHead(405).end(); return;
      }

      const SERVICE_META = {
        github: { name: 'GitHub', placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx', hint: 'github.com/settings/tokens → Generate new token (classic) → scopes: <b>repo</b>, <b>read:org</b>' },
      };
      const meta = SERVICE_META[service];
      if (!meta) { res.writeHead(404).end('Unknown service'); return; }

      if (req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        // Pre-fill from saved token if available
        let savedValue = null;
        try {
          if (/^[a-f0-9]{32}$/.test(t)) {
            const pf = path.join(os.homedir(), 'connect-pending', `${t}.json`);
            const pending = JSON.parse(fs.readFileSync(pf, 'utf8'));
            if (pending.uid && pending.expires > Date.now()) {
              const tokenFile = path.join(os.homedir(), 'agent-tokens', pending.uid, service);
              if (fs.existsSync(tokenFile)) {
                savedValue = fs.readFileSync(tokenFile, 'utf8').trim() || null;
              }
            }
          }
        } catch { /* non-critical */ }
        const html = connectFormHtml(service, meta, t, savedValue);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        return;
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        let payload;
        try { payload = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
        const { t, value } = payload;
        if (!t || !value) { res.writeHead(400).end(JSON.stringify({ error: 'missing t or value' })); return; }
        if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

        const pendingFile = path.join(CONNECT_PENDING_DIR, `${t}.json`);
        let pending;
        try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
        if (pending.expires < Date.now()) { try { fs.unlinkSync(pendingFile); } catch {} res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
        if (pending.service !== service) { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }

        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid in token' })); return; }
        const tokensDir = path.join(os.homedir(), 'agent-tokens', pending.uid);
        fs.mkdirSync(tokensDir, { recursive: true });
        fs.writeFileSync(path.join(tokensDir, service), String(value).trim(), { mode: 0o600 });
        try { fs.unlinkSync(pendingFile); } catch {} // one-time use; ignore if already deleted
        console.log(`[connect] saved ${service} token for uid=${pending.uid}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));

        // Notify user in Telegram (fire-and-forget)
        const svcChatId = readChatId(pending.uid);
        if (svcChatId) {
          const SERVICE_NAMES = { github: 'GitHub' };
          const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
          fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: svcChatId,
              text: `✅ ${SERVICE_NAMES[service] || service} подключён! Данные для входа сохранены в изолированном хранилище — в чат не попадают.\n\nУправление доступами: /secrets_list`,
            }),
          }).catch(e => console.error('[connect] tg notify failed:', e.message));
        }
        return;
      }

      res.writeHead(405).end(); return;
    }

    // CORS preflight for browser-facing endpoints (no auth needed for OPTIONS)
    if (req.method === 'OPTIONS' && (url.pathname === '/hh/send' || url.pathname === '/hh/reject' || url.pathname === '/hh/ats-config' || url.pathname === '/hh/review' || url.pathname === '/hh/reset-ats-results')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    // ── HH browser-facing endpoints (no AGENT_SECRET — authenticated by HH token file) ──

    // GET /hh/review?username=X&token=Y — on-demand candidate review page
    if (req.method === 'GET' && url.pathname === '/hh/review') {
      const username = url.searchParams.get('username') || '';
      const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const tokenFile = path.join(hhTokensBase, String(username), 'hh');
      const errPage = (msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>HH Ревью</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}h2{margin-bottom:12px}</style>
</head><body><h2>${msg}</h2></body></html>`);
      };
      // Token check: HMAC-SHA256(AGENT_SECRET, username).slice(0,16)
      const agentSecret = process.env.AGENT_SECRET || '';
      if (agentSecret) {
        const { createHmac } = require('crypto');
        const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
        const given = url.searchParams.get('token') || '';
        if (given !== expected) return errPage('Ссылка недействительна. Запроси новую у бота.');
      }
      if (!username || !fs.existsSync(tokenFile)) return errPage('HH не подключён. Скажи боту «подключи HH».');
      let tokenData;
      try { tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { return errPage('Ошибка чтения токена.'); }

      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const workDir = path.join(dataDir, 'sessions', username);
      const vacancyCtxFile = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
      let vacancy = null;
      try { vacancy = JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value; } catch {}
      if (!vacancy?.id) return errPage('Вакансия не выбрана. Скажи боту «мои вакансии» и выбери вакансию.');

      const tab = url.searchParams.get('tab') || 'waiting';
      const reviewToken = url.searchParams.get('token') || '';

      // Read from cache; sync if stale (>15 min) or vacancy changed
      const CACHE_TTL_MS = 15 * 60 * 1000;
      const cacheFile = path.join(dataDir, 'hh', username, 'negotiations-cache.json');
      let cache = null;
      try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

      const cacheAge = cache ? Date.now() - new Date(cache.synced_at || 0).getTime() : Infinity;
      const cacheStale = cacheAge > CACHE_TTL_MS || cache?.vacancy_id !== vacancy.id;

      if (cacheStale) {
        try {
          cache = await syncHhNegotiations(username, vacancy, tokenData.access_token, dataDir);
        } catch (e) {
          console.error('[hh/review] sync error:', e.message);
          cache = cache || { items: [], synced_at: null, total: 0 };
        }
      }

      const allItems = cache.items || [];
      // Filter by tab: waiting = consider state only; all = everything
      const negotiations = allItems
        .filter(n => tab === 'waiting' ? (n._state === 'consider') : true)
        .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

      const syncedAt = cache.synced_at ? new Date(cache.synced_at) : null;
      const ageMin = syncedAt ? Math.floor((Date.now() - syncedAt.getTime()) / 60000) : null;

      const callbackBase = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
      const html = generateReviewPageHtml(negotiations, vacancy.title || 'Вакансия', username, callbackBase, dataDir, {
        tab, token: reviewToken, totalAll: allItems.length, ageMin,
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // POST /hh/send — send a message to a candidate (called from review page)
    if (req.method === 'POST' && url.pathname === '/hh/send') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = JSON.parse(await readBody(req));
      const { username, negotiation_id, message } = body || {};
      if (!username || !negotiation_id || !message) return json(res, 400, { error: 'missing fields' });

      const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const tokenFile = path.join(hhTokensBase, String(username), 'hh');
      if (!fs.existsSync(tokenFile)) return json(res, 403, { error: 'HH not connected for this user' });
      const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));

      try {
        await hhApiPost(`/negotiations/${negotiation_id}/messages`, tokenData.access_token, { message });
        const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
        const histDir = path.join(dataDir, 'hh', String(username), 'candidates');
        fs.mkdirSync(histDir, { recursive: true });
        const histFile = path.join(histDir, `${negotiation_id}.json`);
        const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : { messages: [] };
        history.messages = history.messages || [];
        history.messages.push({ role: 'employer', text: message, timestamp: new Date().toISOString() });
        fs.writeFileSync(histFile, JSON.stringify(history, null, 2), { mode: 0o600 });
        console.log(`[hh/send] user=${username} neg=${negotiation_id} len=${message.length}`);
        return json(res, 200, { ok: true });
      } catch (e) {
        console.error('[hh/send] error:', e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // POST /hh/reject — bulk reject candidates (called from review page)
    if (req.method === 'POST' && url.pathname === '/hh/reject') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = JSON.parse(await readBody(req));
      const { username, negotiation_ids } = body || {};
      if (!username || !Array.isArray(negotiation_ids) || negotiation_ids.length === 0) {
        return json(res, 400, { error: 'missing fields' });
      }
      const hhTokensBase2 = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const tokenFile2 = path.join(hhTokensBase2, String(username), 'hh');
      if (!fs.existsSync(tokenFile2)) return json(res, 403, { error: 'HH not connected for this user' });
      const tokenData2 = JSON.parse(fs.readFileSync(tokenFile2, 'utf8'));
      const results = [];
      for (const negId of negotiation_ids) {
        try {
          await hhApiPut(`/negotiations/discard_vacancy_closed/${negId}`, tokenData2.access_token);
          results.push({ negotiation_id: negId, ok: true });
        } catch (e) { results.push({ negotiation_id: negId, ok: false, error: e.message }); }
      }
      const failed = results.filter(r => !r.ok).length;
      console.log(`[hh/reject] user=${username} total=${negotiation_ids.length} failed=${failed}`);
      return json(res, 200, { ok: true, results });
    }

    // Auth: all endpoints require Bearer token
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secrets.AGENT_SECRET}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'alive', uptime: process.uptime() });
    }

    // GET /capabilities?userId=XXX — list services with tokens on this machine
    if (req.method === 'GET' && url.pathname === '/capabilities') {
      const userId = url.searchParams.get('userId') || '';
      if (!userId || !/^[a-zA-Z0-9_]{1,64}$/.test(userId)) return json(res, 400, { error: 'invalid userId' });
      const tokensDir = path.join(os.homedir(), 'agent-tokens', userId);
      const SKIP = new Set(['.secrets_log', 'gdrive-seen', 'gdrive-catalog', 'gdrive-catalog.json']);
      let capabilities = [];
      if (fs.existsSync(tokensDir)) {
        capabilities = fs.readdirSync(tokensDir).filter(f => !SKIP.has(f) && !f.startsWith('.'));
      }
      // skills[] — MCP tool categories available on this agent
      const SKILL_NAMES = {
        '10-nalog.js': 'nalog', '20-tilda.js': 'tilda', '21-browser-session.js': 'browser',
        '30-weeek.js': 'weeek', '40-company.js': 'company', '50-gdrive.js': 'gdrive',
        '60-github.js': 'github', '70-inn-enrichment.js': 'inn', '80-getcourse.js': 'getcourse',
        '85-expo.js': 'expo', '86-expo-flexi.js': 'expo-flexi', '90-hh.js': 'hh',
        '92-flexi-sales.js': 'flexi-sales',
      };
      const toolsDir = path.join(__dirname, 'mcp-skills', 'tools');
      const skills = fs.existsSync(toolsDir)
        ? fs.readdirSync(toolsDir).map(f => SKILL_NAMES[f]).filter(Boolean)
        : [];
      const upsell_text = process.env.AGENT_UPSELL_TEXT ||
        'За HH-рекрутингом, налогами, задачами Weeek и другим — обратитесь к @super_personal_assistant_bot';
      return json(res, 200, { capabilities, skills, upsell_text });
    }

    // POST /quick — quick deterministic answer without Claude Code (<200ms)
    if (req.method === 'POST' && url.pathname === '/quick') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
      const { userId, query } = payload;
      if (!userId || !query) return json(res, 400, { error: 'missing fields' });
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(userId))) return json(res, 400, { error: 'invalid userId' });
      const workDir = path.join(BASE_USERS_DIR, String(userId));
      const start = Date.now();
      const answer = getQuickAnswer(String(query), String(userId), workDir) || null;
      return json(res, 200, { answer, ms: Date.now() - start });
    }

    // GET /skills — list all available MCP skills (for bot /skills command)
    if (req.method === 'GET' && url.pathname === '/skills') {
      const { tools: metaTools } = require('./mcp-skills/tools/00-meta.js');
      const { skills } = await metaTools.list_skills.handler();
      return json(res, 200, { skills });
    }

    // GET /health-full — runs actual claude call, verifies OAuth end-to-end
    if (req.method === 'GET' && url.pathname === '/health-full') {
      const start = Date.now();
      const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;
      try {
        const output = await new Promise((resolve, reject) => {
          execFile('claude', ['--dangerously-skip-permissions', '--print', 'say: pipeline-ok'], {
            env: cleanEnv,
            timeout: 45000,
          }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stdout || stderr || err.message).trim().slice(0, 300)));
            resolve(stdout.trim());
          });
        });
        const ok = output.toLowerCase().includes('pipeline-ok');
        return json(res, ok ? 200 : 500, { ok, output: output.slice(0, 200), auth: 'oauth', latencyMs: Date.now() - start });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message, latencyMs: Date.now() - start });
      }
    }

    // GET /internal/auth-status — read/clear Claude Code auth flag (for repair system)
    if (req.method === 'GET' && url.pathname === '/internal/auth-status') {
      const flag = getAuthFlag();
      return json(res, 200, {
        claude_auth_ok: !flag.failed,
        ...(flag.failed ? { reason: flag.reason, vm: flag.vm, failed_at: flag.failed_at, error_text: flag.error_text } : {}),
      });
    }

    // POST /internal/auth-status/clear — mark repaired (called by repair system after fixing auth)
    if (req.method === 'POST' && url.pathname === '/internal/auth-status/clear') {
      clearAuthFailedFlag();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpus = os.cpus();
      const load = os.loadavg();
      let disk = null;
      try {
        const df = execSync('df -BM / --output=size,used,avail', { encoding: 'utf8' });
        const [, line] = df.trim().split('\n');
        const [size, used, avail] = line.trim().split(/\s+/).map(s => parseInt(s));
        disk = { totalMb: size, usedMb: used, availMb: avail };
      } catch { /* ignore */ }
      return json(res, 200, {
        cpu: { cores: cpus.length, load1m: load[0], load5m: load[1] },
        memory: { totalMb: Math.round(totalMem / 1048576), usedMb: Math.round(usedMem / 1048576), freeMb: Math.round(freeMem / 1048576) },
        disk,
        uptime: process.uptime(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { userId, username, task, context, sessionId, contextFromSession, forceClaude, telegramUserId, initialMsgId, pinnedMsgId } = payload;
      if (!userId || !username) return json(res, 400, { error: 'missing fields' });
      // task is optional when forceClaude=true (agent derives it from session's lastUserMessage)
      if (!task && !forceClaude) return json(res, 400, { error: 'missing fields' });
      if (!/^-?\d{1,20}$/.test(String(userId))) {
        console.log('[/run] 400 invalid userId:', userId);
        return json(res, 400, { error: 'invalid userId' });
      }
      if (telegramUserId && !/^\d{1,20}$/.test(String(telegramUserId))) {
        console.log('[/run] 400 invalid telegramUserId:', telegramUserId);
        return json(res, 400, { error: 'invalid telegramUserId' });
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(username) || username.length > 32) {
        console.log('[/run] 400 invalid username:', username);
        return json(res, 400, { error: 'invalid username' });
      }
      if (sessionId && !/^[a-zA-Z0-9_-]+$/.test(sessionId))
        return json(res, 400, { error: 'invalid sessionId' });
      if (contextFromSession && !/^[a-zA-Z0-9_-]+$/.test(contextFromSession))
        return json(res, 400, { error: 'invalid contextFromSession' });

      const workDir = path.join(BASE_USERS_DIR, username);
      fs.mkdirSync(workDir, { recursive: true });
      const user = { id: userId, name: username, username, workDir, telegramUserId: telegramUserId || null };
      trackChat(userId);

      // Accept request immediately, run task in background
      const taskId = `${username}-${Date.now()}`;
      json(res, 202, { taskId });

      // Fire-and-forget
      runTask({ taskId, user, task: task || '', context, sessionId: sessionId || null, contextFromSession: contextFromSession || null, forceClaude: !!forceClaude, initialMsgId: initialMsgId || null, pinnedMsgId: pinnedMsgId || null, secrets }).catch(err =>
        console.error(`[${taskId}] runTask error:`, err.message)
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/tokens') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { userId, label, value } = payload;
      if (!userId || !label || !value) return json(res, 400, { error: 'missing fields' });
      if (!/^[a-zA-Z0-9_]{1,64}$/.test(String(userId))) return json(res, 400, { error: 'invalid userId' });
      if (!/^[a-zA-Z0-9_.-]+$/.test(label) || label.length > 64)
        return json(res, 400, { error: 'invalid label' });

      const tokensDir = path.join(process.env.HOME || '/home/vova', 'agent-tokens', String(userId));
      fs.mkdirSync(tokensDir, { recursive: true });
      fs.writeFileSync(path.join(tokensDir, label), String(value), { mode: 0o600 });
      console.log(`[tokens] saved label="${label}" for userId=${userId}`);
      return json(res, 200, { ok: true });
    }

    // GET /sessions?username=xxx[&limit=N] — list sessions for a user
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
      const workDir = path.join(BASE_USERS_DIR, username);
      return json(res, 200, { sessions: listSessions(workDir, limit) });
    }

    // POST /sessions/archive — remove sessions from the index
    if (req.method === 'POST' && url.pathname === '/sessions/archive') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
      const { username, sessionIds } = payload;
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      if (!Array.isArray(sessionIds) || sessionIds.length === 0)
        return json(res, 400, { error: 'sessionIds must be a non-empty array' });
      const workDir = path.join(BASE_USERS_DIR, username);
      const archived = archiveSessions(workDir, sessionIds);
      return json(res, 200, { archived });
    }

    // GET /sessions/:id?username=xxx — get full session with messages
    const sessionMatch = url.pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const id = sessionMatch[1];
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      const workDir = path.join(BASE_USERS_DIR, username);
      const session = getSessionData(workDir, id);
      if (!session) return json(res, 404, { error: 'not found' });
      return json(res, 200, session);
    }

    // POST /classify — decide which session a message belongs to
    if (req.method === 'POST' && url.pathname === '/classify') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { message, sessions: sessionList } = payload;
      if (!message || !Array.isArray(sessionList) || sessionList.length === 0)
        return json(res, 400, { error: 'missing fields' });

      try {
        const result = await classifyMessage(message, sessionList, secrets.ANTHROPIC_API_KEY);
        return json(res, 200, result);
      } catch (e) {
        console.error('[classify] error:', e.message);
        return json(res, 200, { sessionId: null, confidence: 'low' }); // fallback: show picker
      }
    }

    // GET /files?username=xxx&path=relative — list directory contents
    if (req.method === 'GET' && url.pathname === '/files') {
      const username = url.searchParams.get('username');
      const relPath  = url.searchParams.get('path') || '';
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      const workDir = path.join(BASE_USERS_DIR, username);
      const target  = path.resolve(path.join(workDir, relPath));
      if (target !== workDir && !target.startsWith(workDir + path.sep))
        return json(res, 400, { error: 'path traversal' });

      try {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.')) // hide dotfiles
          .map(e => {
            if (e.isDirectory()) {
              let count = 0;
              try { count = fs.readdirSync(path.join(target, e.name)).filter(n => !n.startsWith('.')).length; } catch {}
              return { name: e.name, type: 'dir', count };
            }
            let size = 0;
            try { size = fs.statSync(path.join(target, e.name)).size; } catch {}
            return { name: e.name, type: 'file', size };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        return json(res, 200, { path: relPath, entries });
      } catch (e) {
        return json(res, 404, { error: 'not found' });
      }
    }

    // GET /files/read?username=xxx&path=relative — read a file
    if (req.method === 'GET' && url.pathname === '/files/read') {
      const username = url.searchParams.get('username');
      const relPath  = url.searchParams.get('path') || '';
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      const workDir = path.join(BASE_USERS_DIR, username);
      const target  = path.resolve(path.join(workDir, relPath));
      if (target !== workDir && !target.startsWith(workDir + path.sep))
        return json(res, 400, { error: 'path traversal' });

      const ext = path.extname(target).toLowerCase();
      const READABLE = ['.md', '.json', '.txt', '.log', '.js', '.ts', '.yaml', '.yml', '.toml', '.env'];
      if (!READABLE.includes(ext))
        return json(res, 400, { error: 'not a readable file type' });

      try {
        const raw = fs.readFileSync(target, 'utf8');
        const MAX = 3500;
        return json(res, 200, {
          path: relPath,
          content: raw.length > MAX ? raw.slice(0, MAX) : raw,
          truncated: raw.length > MAX,
          size: raw.length,
        });
      } catch (e) {
        return json(res, 404, { error: 'not found' });
      }
    }

    // POST /webhooks/weeek-session — triggered by CF Worker when WEEEK_APP_COOKIE expires (401)
    // Auth: Bearer AGENT_SECRET (same as other endpoints)
    if (req.method === 'POST' && url.pathname === '/webhooks/weeek-session') {
      json(res, 202, { ok: true, message: 'Refresh started' });
      // Run refresh in background, send Telegram alert with result
      const refreshScript = path.join(__dirname, '..', 'scripts', 'refresh-weeek-session.js');
      const env = {
        ...process.env,
        TELEGRAM_BOT_TOKEN: secrets.BOT_TOKEN,
        CF_API_TOKEN: secrets.CF_API_TOKEN || '',
        OPERATOR_CHAT_ID: secrets.OPERATOR_CHAT_ID || '1714048',
      };
      const child = spawn('node', [refreshScript], { env, detached: true, stdio: 'inherit' });
      child.unref();
      console.log('[weeek-session] Refresh script started, pid:', child.pid);
      return;
    }

    // POST /admin/refresh-weeek-session — synchronous refresh, returns new cookie
    // Used by CF Workers (flexi-exhibition-deal-bot) to recover from 401/403 mid-request
    if (req.method === 'POST' && url.pathname === '/admin/refresh-weeek-session') {
      const { execSync } = require('child_process');
      const refreshScript = path.join(__dirname, '..', 'scripts', 'refresh-weeek-session.js');
      const body = await readBody(req).then(b => { try { return JSON.parse(b); } catch { return {}; } });
      const profiles = (body.profiles || 'flexi,flexi-consult').split(',').map(s => s.trim()).filter(Boolean);
      const env = {
        ...process.env,
        TELEGRAM_BOT_TOKEN: secrets.BOT_TOKEN,
        CF_API_TOKEN: secrets.CF_API_TOKEN || '',
        OPERATOR_CHAT_ID: secrets.OPERATOR_CHAT_ID || '1714048',
        WEEEK_SESSION_PROFILES: profiles.join(','),
      };
      try {
        execSync(`node "${refreshScript}"`, { env, timeout: 90000, stdio: 'pipe' });
        // Read back the freshly written cookie
        const cookiePath = path.join(os.homedir(), 'agent-tokens', profiles[0], 'weeek-session');
        const cookie = fs.existsSync(cookiePath) ? fs.readFileSync(cookiePath, 'utf8').trim() : '';
        if (!cookie) return json(res, 500, { ok: false, error: 'Refresh succeeded but cookie file is empty' });
        console.log('[weeek-session] Sync refresh done, profile=%s, cookie length=%d', profiles[0], cookie.length);
        return json(res, 200, { ok: true, cookie });
      } catch (e) {
        console.error('[weeek-session] Sync refresh failed:', e.message.slice(0, 200));
        return json(res, 500, { ok: false, error: e.message.slice(0, 300) });
      }
    }

    // ── ATS Template Editor ────────────────────────────────────────────────────

    // GET /hh/ats-editor?username=X — serve the ATS Template Editor HTML page
    if (req.method === 'GET' && url.pathname === '/hh/ats-editor') {
      const username = url.searchParams.get('username') || '';
      const { atsEditorHtml } = require('./hh-ats-editor-html.js');
      const contextBase = process.env.CONTEXT_DIR || path.join(process.cwd(), 'contexts');
      const configFile = path.join(contextBase, 'hh', 'ats_config.json');
      const stagesFile = path.join(contextBase, 'hh', 'ats_stages.json');
      let currentConfig = null;
      let currentStages = null;
      try {
        if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile, 'utf8')).value;
        if (fs.existsSync(stagesFile)) currentStages = JSON.parse(fs.readFileSync(stagesFile, 'utf8')).value;
      } catch {}
      const callbackBase = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
      const html = atsEditorHtml(currentConfig, currentStages, {
        callbackBase,
        username: username || secrets.HH_DEFAULT_USER || '',
        agentSecret: secrets.AGENT_SECRET || '',
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // GET /hh/ats-config?username=X — read current ATS config from context
    if (req.method === 'GET' && url.pathname === '/hh/ats-config') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const contextBase = process.env.CONTEXT_DIR || path.join(process.cwd(), 'contexts');
      const configFile = path.join(contextBase, 'hh', 'ats_config.json');
      const stagesFile = path.join(contextBase, 'hh', 'ats_stages.json');
      let config = null;
      let stages = null;
      try {
        if (fs.existsSync(configFile)) config = JSON.parse(fs.readFileSync(configFile, 'utf8')).value;
        if (fs.existsSync(stagesFile)) stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8')).value;
      } catch {}
      return json(res, 200, { ok: true, config, stages });
    }

    // POST /hh/reset-ats-results — clear ats_result from all candidate history files
    // so hh_batch_review re-evaluates them with the current (updated) ATS config
    if (req.method === 'POST' && url.pathname === '/hh/reset-ats-results') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = JSON.parse(await readBody(req));
      const { username } = body || {};
      if (!username) return json(res, 400, { error: 'username required' });
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const candDir = path.join(dataDir, 'hh', String(username), 'candidates');
      let reset = 0;
      let skipped = 0;
      if (fs.existsSync(candDir)) {
        for (const f of fs.readdirSync(candDir)) {
          if (!f.endsWith('.json')) continue;
          const fp = path.join(candDir, f);
          try {
            const hist = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (hist.ats_result !== undefined) {
              delete hist.ats_result;
              hist.ats_reset_at = new Date().toISOString();
              fs.writeFileSync(fp, JSON.stringify(hist, null, 2));
              reset++;
            } else {
              skipped++;
            }
          } catch { skipped++; }
        }
      }
      console.log(`[hh/reset-ats-results] user=${username} reset=${reset} skipped=${skipped}`);
      return json(res, 200, { ok: true, reset, skipped });
    }

    // POST /hh/sync-negotiations — force-sync HH negotiations to cache (for cron job / manual refresh)
    if (req.method === 'POST' && url.pathname === '/hh/sync-negotiations') {
      const body = JSON.parse(await readBody(req));
      const { username } = body || {};
      if (!username) return json(res, 400, { error: 'username required' });

      const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const tokenFile = path.join(hhTokensBase, String(username), 'hh');
      if (!fs.existsSync(tokenFile)) return json(res, 404, { error: 'HH token not found' });
      let tokenData;
      try { tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { return json(res, 500, { error: 'token read error' }); }

      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const workDir = path.join(dataDir, 'sessions', username);
      const vacancyCtxFile = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
      let vacancy = null;
      try { vacancy = JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value; } catch {}
      if (!vacancy?.id) return json(res, 400, { error: 'no active vacancy' });

      try {
        const cache = await syncHhNegotiations(username, vacancy, tokenData.access_token, dataDir);
        console.log(`[hh/sync-negotiations] user=${username} synced=${cache.total}`);
        return json(res, 200, { ok: true, synced: cache.total, synced_at: cache.synced_at });
      } catch (e) {
        console.error('[hh/sync-negotiations] error:', e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // POST /hh/ats-config — save ATS config + stages to context
    if (req.method === 'POST' && url.pathname === '/hh/ats-config') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = JSON.parse(await readBody(req));
      const { config, stages } = body || {};
      if (!config || typeof config !== 'object') return json(res, 400, { error: 'config required' });
      const contextBase = process.env.CONTEXT_DIR || path.join(process.cwd(), 'contexts');
      const hhContextDir = path.join(contextBase, 'hh');
      fs.mkdirSync(hhContextDir, { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        path.join(hhContextDir, 'ats_config.json'),
        JSON.stringify({ value: config, updated_at: now }, null, 2),
      );
      if (Array.isArray(stages)) {
        fs.writeFileSync(
          path.join(hhContextDir, 'ats_stages.json'),
          JSON.stringify({ value: stages, updated_at: now }, null, 2),
        );
      }
      console.log(`[hh/ats-config] saved vacancy="${config.vacancy_title}" stages=${stages?.length || 0}`);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[request-handler] unhandled error:', err);
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: 'internal server error' }));
    }
  });

  server.listen(PORT, () => console.log(`assist-agent listening on :${PORT}`));

  // Drive watcher: poll every 2 min for new files shared with the SA
  const driveOpts = { botToken: secrets.BOT_TOKEN, tgBase: process.env.TELEGRAM_API_URL };
  pollDriveChanges(driveOpts).catch(() => {});
  setInterval(() => pollDriveChanges(driveOpts).catch(() => {}), 2 * 60 * 1000);

  scheduleNalogExpiryChecks(secrets);

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Close any open Playwright browsers so Node exits cleanly
    try { require('./nalog-login').closeAll(); } catch {}
    // Force-exit after 10s if something still hangs
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT',  shutdown);
}

function tgNotifyNalog(botToken, chatId, expires) {
  const expiresStr = expires ? new Date(expires).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '~1 час';
  const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  fetch(`${tgBase}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ Налог.ру подключён! Данные авторизации сохранены — действуют до ${expiresStr} (МСК).\n\nТеперь можно работать с чеками НПД. Управление доступами: /secrets_list`,
    }),
  }).catch(e => console.error('[nalog] tg notify failed:', e.message));
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── HH review page ────────────────────────────────────────────────────────────

// ── HH negotiations cache sync ────────────────────────────────────────────────

async function syncHhNegotiations(username, vacancy, accessToken, dataDir) {
  const ACTIVE_STATES = ['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer'];
  const results = await Promise.all(
    ACTIVE_STATES.map(st =>
      hhApiRequest('GET', `/negotiations/${st}?vacancy_id=${vacancy.id}&per_page=100&page=0`, accessToken)
        .then(d => (d.items || []).map(n => ({ ...n, _state: st })))
        .catch(() => []),
    ),
  );
  const items = results.flat();
  const cache = { synced_at: new Date().toISOString(), vacancy_id: vacancy.id, vacancy_name: vacancy.title, total: items.length, items };
  const cacheFile = path.join(dataDir, 'hh', String(username), 'negotiations-cache.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 });
  return cache;
}

function generateReviewPageHtml(negotiations, vacancyTitle, username, callbackBase, dataDir, opts = {}) {
  const { tab = 'waiting', token = '', totalAll = null, ageMin = null } = opts;
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const candDir = path.join(dataDir || path.join(os.homedir(), 'agent-data'), 'hh', String(username), 'candidates');
  function readHistory(negId) {
    const file = path.join(candDir, `${negId}.json`);
    if (!fs.existsSync(file)) return { messages: [], ats_result: null };
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { messages: [], ats_result: null }; }
  }

  function buildResumeText(neg) {
    const r = neg.resume || {};
    const lines = [];
    if (r.title) lines.push(`Позиция: ${r.title}`);
    if (r.total_experience?.months) {
      const y = Math.floor(r.total_experience.months / 12);
      const m = r.total_experience.months % 12;
      lines.push(`Опыт: ${y} лет${m ? ' ' + m + ' мес' : ''}`);
    }
    if (r.area?.name) lines.push(`Локация: ${r.area.name}`);
    if (r.salary) lines.push(`Зарплата: ${r.salary.amount?.toLocaleString('ru-RU')} ${r.salary.currency}`);
    if (r.experience?.length) {
      lines.push('\nОпыт работы:');
      for (const job of r.experience.slice(0, 5)) {
        const start = job.start?.slice(0, 7) || '';
        const end = job.end?.slice(0, 7) || 'н.в.';
        lines.push(`- ${job.company || ''} (${start}–${end}): ${job.position || ''}`);
        if (job.description) lines.push(`  ${job.description.slice(0, 300)}`);
      }
    }
    if (r.skill_set?.length) lines.push(`\nНавыки: ${r.skill_set.slice(0, 25).join(', ')}`);
    if (r.education?.primary?.length) {
      const edu = r.education.primary[0];
      lines.push(`\nОбразование: ${edu.name || ''}, ${edu.organization || ''} (${edu.year || ''})`);
    }
    if (neg.message) lines.push(`\nСопроводительное письмо:\n${neg.message.slice(0, 600)}`);
    return lines.join('\n');
  }

  const candidates = negotiations.map(neg => {
    const r = neg.resume || {};
    const history = readHistory(neg.id);
    const ats = history.ats_result || null;
    const daysAgo = neg.updated_at ? Math.floor((Date.now() - new Date(neg.updated_at).getTime()) / 86400000) : null;
    return {
      negotiation_id: neg.id,
      name: [r.last_name, r.first_name].filter(Boolean).join(' ') || 'Кандидат',
      score: ats?.score ?? null,
      verdict: ats?.verdict ?? null,
      reasoning: ats?.reasoning ?? null,
      matched: ats?.matched || [],
      gaps: ats?.gaps || [],
      draft_message: ats?.draft_message ?? null,
      days_since_activity: daysAgo,
      resume_text: buildResumeText(neg),
      history_messages: history.messages || [],
      alternate_url: r.alternate_url || null,
    };
  });

  const sorted = [...candidates].sort((a, b) => {
    if (a.score != null && b.score != null) return (b.score || 0) - (a.score || 0);
    if (a.score != null) return -1;
    if (b.score != null) return 1;
    return 0;
  });

  const colorMap = { 'ПРОПУСТИТЬ': '#16a34a', 'УТОЧНИТЬ': '#d97706', 'ОТКЛОНИТЬ': '#dc2626' };
  const bgMap = { 'ПРОПУСТИТЬ': '#f0fdf4', 'УТОЧНИТЬ': '#fffbeb', 'ОТКЛОНИТЬ': '#fef2f2' };
  const actionable = sorted.filter(c => c.verdict && c.verdict !== 'ОТКЛОНИТЬ').length;
  const agentSecret = process.env.AGENT_SECRET || '';

  const cards = sorted.map((c, i) => {
    const hasScore = c.score != null;
    const col = colorMap[c.verdict] || '#94a3b8';
    const bg = bgMap[c.verdict] || '#fff';
    const scorePct = hasScore ? Math.round((c.score || 0) * 10) : 0;

    const matched = (c.matched || []).map(m => `<span class="tag tag-ok">${esc(m)}</span>`).join('');
    const gaps = (c.gaps || []).map(g => `<span class="tag tag-gap">${esc(g)}</span>`).join('');
    const daysNote = c.days_since_activity != null ? `<span class="meta"> · активность ${c.days_since_activity}д назад</span>` : '';

    const histMsgs = c.history_messages || [];
    const histSection = histMsgs.length === 0
      ? '<div class="hist-none">💬 Первое сообщение — переписки ещё не было</div>'
      : `<details class="hist-details"><summary class="hist-summary">📨 История диалога (${histMsgs.length} сообщ.)</summary>
           <div class="hist-thread">${histMsgs.map(m => `
             <div class="hist-msg hist-${esc(m.role || 'employer')}">
               <span class="hist-who">${m.role === 'employer' ? 'Рекрутер' : 'Кандидат'}</span>
               <span class="hist-time">${(m.timestamp || '').slice(0, 10)}</span>
               <div class="hist-text">${esc(m.text || '')}</div>
             </div>`).join('')}
           </div></details>`;

    const resumeSection = c.resume_text
      ? `<details class="resume-details"><summary class="resume-summary">📄 Резюме (текст)</summary>
           <pre class="resume-text">${esc(c.resume_text)}</pre>
         </details>`
      : '';

    const isActionable = c.verdict && c.verdict !== 'ОТКЛОНИТЬ';
    const isReject = c.verdict === 'ОТКЛОНИТЬ';

    const checkboxHtml = isActionable
      ? `<input type="checkbox" class="card-cb" id="cb-${i}" data-idx="${i}" data-score="${(c.score || 0).toFixed(1)}" checked onchange="onCheck()">`
      : isReject
        ? `<input type="checkbox" class="reject-cb" id="cb-${i}" data-idx="${i}" data-score="${(c.score || 0).toFixed(1)}" onchange="onCheck()">`
        : `<input type="checkbox" class="card-cb" id="cb-${i}" data-idx="${i}" data-score="0" onchange="onCheck()">`;

    const scoreHtml = hasScore
      ? `<div class="score-wrap">
           <div class="score-bar"><div class="score-fill" style="width:${scorePct}%;background:${col}"></div></div>
           <span class="score-num" style="color:${col}">${(c.score || 0).toFixed(1)}/10</span>
           <span class="verdict-badge" style="background:${col}">${esc(c.verdict)}</span>
         </div>`
      : '<span class="verdict-none">не оценён</span>';

    const hhBtnHtml = c.alternate_url
      ? `<a href="${esc(c.alternate_url)}" target="_blank" rel="noopener" class="hh-btn">HH ↗</a>`
      : '';
    const nameHtml = esc(c.name) + hhBtnHtml;

    const msgSection = (isActionable && c.draft_message)
      ? `<div class="msg-section">
           <label class="msg-label">Черновик сообщения</label>
           <textarea class="msg-area" id="msg-${i}" rows="5">${esc(c.draft_message)}</textarea>
           <div class="btns">
             <button class="btn btn-send" onclick="sendOne(${i},'${esc(c.negotiation_id)}')">✓ Отправить</button>
             <button class="btn btn-skip" onclick="skipOne(${i})">✗ Пропустить</button>
           </div>
         </div>`
      : isReject
        ? '<div class="reject-note">Будет отклонён через bulk_reject — сообщение не нужно</div>'
        : `<div class="msg-section">
             <label class="msg-label">Сообщение</label>
             <textarea class="msg-area" id="msg-${i}" rows="3" placeholder="Введите сообщение..."></textarea>
             <div class="btns">
               <button class="btn btn-send" onclick="sendOne(${i},'${esc(c.negotiation_id)}')">✓ Отправить</button>
               <button class="btn btn-skip" onclick="skipOne(${i})">✗ Пропустить</button>
             </div>
           </div>`;

    return `<div class="card${i >= 20 ? ' hidden-page' : ''}" id="card-${i}" data-score="${hasScore ? (c.score || 0).toFixed(1) : '0'}" data-neg="${esc(c.negotiation_id)}" data-name="${esc(c.name.toLowerCase())}" style="background:${bg};border-left:4px solid ${col}">
  <div class="card-header">
    <div class="card-header-left">
      ${checkboxHtml}
      <div>
        <span class="name">${nameHtml}</span>
        ${daysNote}
      </div>
    </div>
    ${scoreHtml}
  </div>
  ${c.reasoning ? `<p class="reasoning">${esc(c.reasoning)}</p>` : ''}
  ${matched || gaps ? `<div class="tags">${matched}${gaps}</div>` : ''}
  ${histSection}
  ${resumeSection}
  ${msgSection}
</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ревью кандидатов — ${esc(vacancyTitle)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b;padding:24px 24px 96px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
.subtitle{color:#64748b;font-size:14px;margin-bottom:16px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.toolbar-label{font-size:13px;color:#64748b;margin-right:4px}
.tb-btn{padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;background:#fff;color:#475569;transition:background .15s,color .15s}
.tb-btn:hover,.tb-btn.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.tb-sep{width:1px;height:20px;background:#e2e8f0;margin:0 4px}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);transition:opacity .3s}
.card.done{opacity:.4;pointer-events:none}
.card.skipped{opacity:.35;pointer-events:none}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:10px}
.card-header-left{display:flex;align-items:flex-start;gap:10px}
.card-cb,.reject-cb{width:18px;height:18px;margin-top:2px;cursor:pointer;flex-shrink:0}
.card-cb{accent-color:#4f46e5}
.reject-cb{accent-color:#dc2626}
.name{font-size:17px;font-weight:600}
.resume-link{color:inherit;text-decoration:none}
.resume-link:hover{text-decoration:underline}
.meta{font-size:12px;color:#94a3b8}
.score-wrap{display:flex;align-items:center;gap:8px;flex-shrink:0}
.score-bar{width:80px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden}
.score-fill{height:100%;border-radius:3px;transition:width .4s}
.score-num{font-size:14px;font-weight:600;min-width:38px}
.verdict-badge{font-size:12px;font-weight:700;color:#fff;padding:3px 8px;border-radius:99px;white-space:nowrap}
.verdict-none{font-size:12px;color:#94a3b8;font-style:italic}
.reasoning{font-size:13px;color:#475569;line-height:1.5;margin-bottom:10px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.tag{font-size:12px;padding:2px 8px;border-radius:4px;font-weight:500}
.tag-ok{background:#dcfce7;color:#15803d}
.tag-gap{background:#fee2e2;color:#b91c1c}
.msg-section{border-top:1px solid #e2e8f0;padding-top:12px;margin-top:8px}
.msg-label{display:block;font-size:12px;font-weight:600;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.msg-area{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:14px;line-height:1.5;font-family:inherit;resize:vertical;min-height:80px}
.msg-area:focus{outline:none;border-color:#6366f1}
.btns{display:flex;gap:8px;margin-top:8px}
.btn{padding:8px 18px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-send{background:#16a34a;color:#fff}
.btn-skip{background:#e2e8f0;color:#475569}
.reject-note{font-size:13px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic}
.hist-none{font-size:12px;color:#94a3b8;margin:8px 0 4px;font-style:italic}
.hist-details,.resume-details{margin:8px 0 4px}
.hist-summary,.resume-summary{font-size:12px;font-weight:600;color:#64748b;cursor:pointer;padding:4px 0;user-select:none}
.hist-thread{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.hist-msg{padding:8px 10px;border-radius:8px;font-size:13px}
.hist-employer{background:#eff6ff;border-left:3px solid #3b82f6}
.hist-applicant{background:#f0fdf4;border-left:3px solid #22c55e}
.hist-who{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-right:8px}
.hist-time{font-size:11px;color:#94a3b8}
.hist-text{margin-top:4px;white-space:pre-wrap;line-height:1.4}
.resume-text{font-size:12px;white-space:pre-wrap;font-family:inherit;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-top:8px;line-height:1.5;max-height:300px;overflow-y:auto;color:#334155}
.footer{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #e2e8f0;padding:12px 24px;display:flex;align-items:center;gap:16px;box-shadow:0 -2px 8px rgba(0,0,0,.08)}
.counter{font-size:14px;color:#475569;flex:1}
.counter strong{color:#1e293b}
.btn-send-all{background:#4f46e5;color:#fff;padding:9px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-send-all:disabled{opacity:.4;cursor:not-allowed}
.btn-send-all:not(:disabled):hover{opacity:.85}
.btn-reject-all{background:#dc2626;color:#fff;padding:9px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-reject-all:disabled{opacity:.4;cursor:not-allowed}
.btn-reject-all:not(:disabled):hover{opacity:.85}
.toast{position:fixed;top:20px;right:20px;padding:10px 18px;border-radius:8px;background:#16a34a;color:#fff;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);animation:fadein .2s}
.toast-err{background:#dc2626}
@keyframes fadein{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
.tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:2px solid #e2e8f0;padding-bottom:0}
.tab-link{padding:10px 20px;font-size:14px;font-weight:600;color:#64748b;text-decoration:none;border-radius:8px 8px 0 0;border:2px solid transparent;border-bottom:none;margin-bottom:-2px;transition:color .15s,background .15s}
.tab-link:hover{color:#4f46e5;background:#f1f5f9}
.tab-link.active{color:#4f46e5;background:#fff;border-color:#e2e8f0;border-bottom-color:#fff}
.hh-btn{display:inline-flex;align-items:center;padding:2px 8px;font-size:12px;font-weight:600;color:#cc0000;border:1px solid #fca5a5;border-radius:4px;text-decoration:none;margin-left:8px;white-space:nowrap;vertical-align:middle}
.hh-btn:hover{background:#fff1f2}
.search-wrap{margin-bottom:12px}
.search-input{width:100%;max-width:360px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-family:inherit;outline:none}
.search-input:focus{border-color:#6366f1}
.card.hidden-page{display:none}
.card.hidden-search{display:none}
.load-more-wrap{text-align:center;margin:8px 0 16px}
.btn-load-more{padding:9px 28px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;background:#fff;color:#475569;transition:background .15s}
.btn-load-more:hover{background:#f1f5f9}
.page-info{font-size:13px;color:#94a3b8;margin-top:6px}
</style>
</head>
<body>
<h1>Кандидаты: ${esc(vacancyTitle)}</h1>
<div class="tabs">
  <a class="tab-link${tab === 'waiting' ? ' active' : ''}" href="?username=${esc(username)}&token=${esc(token)}&tab=waiting">💬 Ждут ответа</a>
  <a class="tab-link${tab === 'all' ? ' active' : ''}" href="?username=${esc(username)}&token=${esc(token)}&tab=all">📋 Все диалоги${totalAll != null ? ' (' + totalAll + ')' : ''}</a>
</div>
<p class="subtitle">${sorted.length} кандидатов${actionable ? ' · ' + actionable + ' требуют сообщения' : ''}${ageMin != null ? ' · кэш ' + (ageMin === 0 ? 'только что' : ageMin + ' мин назад') : ''} · <a href="?username=${esc(username)}&token=${esc(token)}&tab=${esc(tab)}" style="color:#6366f1">обновить</a></p>
<div class="search-wrap">
  <input id="searchInput" class="search-input" type="search" placeholder="Поиск по ФИО…" oninput="filterCards()">
</div>
<div class="toolbar">
  <span class="toolbar-label">Балл:</span>
  <button class="tb-btn score-btn" data-bucket="10" onclick="toggleBucket(10)">10</button>
  <button class="tb-btn score-btn" data-bucket="9" onclick="toggleBucket(9)">9</button>
  <button class="tb-btn score-btn" data-bucket="8" onclick="toggleBucket(8)">8</button>
  <button class="tb-btn score-btn" data-bucket="7" onclick="toggleBucket(7)">7</button>
  <button class="tb-btn score-btn" data-bucket="6" onclick="toggleBucket(6)">6</button>
  <button class="tb-btn score-btn" data-bucket="5" onclick="toggleBucket(5)">5</button>
  <button class="tb-btn score-btn" data-bucket="4" onclick="toggleBucket(4)">4</button>
  <button class="tb-btn score-btn" data-bucket="3" onclick="toggleBucket(3)">3</button>
  <button class="tb-btn score-btn" data-bucket="2" onclick="toggleBucket(2)">2</button>
  <button class="tb-btn score-btn" data-bucket="1" onclick="toggleBucket(1)">1</button>
  <div class="tb-sep"></div>
  <button class="tb-btn" onclick="selectAll(false)">✗ Снять все</button>
</div>
${cards || '<p style="color:#94a3b8;padding:24px;text-align:center">Откликов нет.</p>'}
<div class="load-more-wrap" id="loadMoreWrap" ${sorted.length <= 20 ? 'style="display:none"' : ''}>
  <button class="btn-load-more" onclick="loadMore()">Показать ещё 20</button>
  <div class="page-info" id="pageInfo">Показано 20 из ${sorted.length}</div>
</div>
<div class="footer">
  <div class="counter">Отправить: <strong id="selCount">0</strong> · Отказать: <strong id="rejCount">0</strong> · Готово: <strong id="sentCount">0</strong></div>
  <button class="btn-reject-all" id="rejectAllBtn" onclick="rejectAll()" disabled>Отказать (0)</button>
  <button class="btn-send-all" id="sendAllBtn" onclick="sendAll()" disabled>Отправить (0)</button>
</div>
<script>
const CALLBACK_BASE = '${callbackBase}';
const HH_USER = '${esc(username)}';
const HH_SECRET = '${esc(agentSecret)}';
const done = new Set();

function showToast(msg, isError) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' toast-err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

async function hhAction(endpoint, payload) {
  const r = await fetch(CALLBACK_BASE + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HH_SECRET },
    body: JSON.stringify({ username: HH_USER, ...payload }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function onCheck() {
  const ns = document.querySelectorAll('.card-cb:checked').length;
  const nr = document.querySelectorAll('.reject-cb:checked').length;
  document.getElementById('selCount').textContent = ns;
  document.getElementById('rejCount').textContent = nr;
  const sb = document.getElementById('sendAllBtn');
  sb.textContent = 'Отправить (' + ns + ')'; sb.disabled = ns === 0;
  const rb = document.getElementById('rejectAllBtn');
  rb.textContent = 'Отказать (' + nr + ')'; rb.disabled = nr === 0;
}

let shownCount = Math.min(20, ${sorted.length});
const totalCount = ${sorted.length};

function loadMore() {
  const cards = document.querySelectorAll('.card.hidden-page');
  let shown = 0;
  for (const c of cards) {
    if (shown >= 20) break;
    c.classList.remove('hidden-page');
    shown++;
    shownCount++;
  }
  const remaining = document.querySelectorAll('.card.hidden-page').length;
  document.getElementById('pageInfo').textContent = 'Показано ' + shownCount + ' из ' + totalCount;
  if (remaining === 0) document.getElementById('loadMoreWrap').style.display = 'none';
}

function filterCards() {
  const q = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  document.querySelectorAll('.card').forEach(card => {
    if (!q) {
      card.classList.remove('hidden-search');
      // restore pagination hiding for cards beyond current shown count
      const idx = parseInt(card.id.replace('card-', ''));
      if (idx >= shownCount) card.classList.add('hidden-page');
      return;
    }
    const name = card.dataset.name || '';
    if (name.includes(q)) {
      card.classList.remove('hidden-search');
      card.classList.remove('hidden-page'); // reveal even if beyond pagination window
    } else {
      card.classList.add('hidden-search');
    }
  });
}

const activeBuckets = new Set();
function toggleBucket(n) {
  const btn = document.querySelector('.score-btn[data-bucket="'+n+'"]');
  if (activeBuckets.has(n)) { activeBuckets.delete(n); btn.classList.remove('active'); }
  else { activeBuckets.add(n); btn.classList.add('active'); }
  document.querySelectorAll('.card-cb,.reject-cb').forEach(cb => {
    if (done.has(parseInt(cb.dataset.idx))) return;
    const bucket = Math.floor(parseFloat(cb.dataset.score || 0));
    cb.checked = activeBuckets.has(bucket);
  });
  onCheck();
}

function selectAll(checked) {
  document.querySelectorAll('.card-cb,.reject-cb').forEach(cb => {
    if (!done.has(parseInt(cb.dataset.idx))) cb.checked = checked;
  });
  activeBuckets.clear();
  document.querySelectorAll('.score-btn').forEach(b => b.classList.remove('active'));
  onCheck();
}

function markDone(i) {
  done.add(i);
  document.getElementById('card-'+i).classList.add('done');
  const cb = document.getElementById('cb-'+i);
  if (cb) { cb.checked = false; cb.disabled = true; }
  document.getElementById('sentCount').textContent = done.size;
}

async function sendOne(i, negId) {
  const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
  if (!msg) { showToast('Сообщение пустое', true); return; }
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  try {
    await hhAction('/hh/send', { negotiation_id: negId, message: msg });
    markDone(i); onCheck(); showToast('✅ Отправлено!');
  } catch(e) {
    showToast('❌ ' + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '✓ Отправить'; }
  }
}

function skipOne(i) {
  done.add(i);
  document.getElementById('card-'+i).classList.add('skipped');
  const cb = document.getElementById('cb-'+i);
  if (cb) { cb.checked = false; cb.disabled = true; }
  onCheck();
}

async function sendAll() {
  const cbs = [...document.querySelectorAll('.card-cb:checked')];
  const sb = document.getElementById('sendAllBtn');
  sb.disabled = true; sb.textContent = '⏳ Отправляю...';
  let ok = 0;
  for (const cb of cbs) {
    const i = parseInt(cb.dataset.idx);
    const negId = document.getElementById('card-'+i)?.dataset.neg || '';
    const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
    if (!msg) continue;
    try { await hhAction('/hh/send', { negotiation_id: negId, message: msg }); markDone(i); ok++; }
    catch(e) { showToast('❌ ' + e.message, true); }
  }
  onCheck();
  if (ok > 0) showToast('✅ Отправлено ' + ok + ' сообщений');
}

async function rejectAll() {
  const cbs = [...document.querySelectorAll('.reject-cb:checked')];
  const negIds = cbs.map(cb => document.getElementById('card-'+parseInt(cb.dataset.idx))?.dataset.neg || '').filter(Boolean);
  if (!negIds.length) return;
  const rb = document.getElementById('rejectAllBtn');
  rb.disabled = true; rb.textContent = '⏳ Отклоняю...';
  try {
    const res = await hhAction('/hh/reject', { negotiation_ids: negIds });
    cbs.forEach(cb => markDone(parseInt(cb.dataset.idx)));
    onCheck();
    const failed = (res.results || []).filter(r => !r.ok).length;
    showToast(failed ? '⚠️ ' + failed + ' ошибок из ' + negIds.length : '✅ Отклонено ' + negIds.length + ' кандидатов');
  } catch(e) {
    showToast('❌ ' + e.message, true);
    rb.disabled = false; rb.textContent = 'Отказать (' + negIds.length + ')';
  }
}

onCheck();
</script>
</body>
</html>`;
}

// ── HH API helpers (used by /hh/send and /hh/reject) ─────────────────────────

function hhApiRequest(method, apiPath, accessToken, body) {
  return new Promise((resolve, reject) => {
    const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
    const u = new URL(base);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : '';
    const reqOpts = {
      hostname: u.hostname,
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
        'HH-User-Agent': 'trained-assist-agent/1.0 (ispyq.com@gmail.com)',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    if (u.port) reqOpts.port = parseInt(u.port, 10);
    const req = lib.request(reqOpts, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode === 204 || !data) return resolve({});
        if (r.statusCode >= 400) return reject(new Error(`HH ${r.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

function hhApiPost(apiPath, token, body) { return hhApiRequest('POST', apiPath, token, body); }
function hhApiPut(apiPath, token, body) { return hhApiRequest('PUT', apiPath, token, body || undefined); }

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection] at:', promise, 'reason:', reason);
  // Log but do NOT crash — a single bad request should not kill the server.
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // Same: log and keep running unless it's a startup error.
});

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

function tgNotifyGetcourse(botToken, chatId, domain, level, cookiesCount) {
  const lines = [`✅ GetCourse подключён! [${domain}]`];
  if (level.includes('L1')) lines.push('• API ключ: ✓ (управление учениками)');
  if (level.includes('L2')) lines.push(`• Сессия: ✓ (${cookiesCount} куки, создание курсов)`);
  if (!level.includes('L1') && !level.includes('L2')) lines.push('• Только домен сохранён (введите API ключ или логин)');
  const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  fetch(`${tgBase}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
  }).catch(e => console.error('[getcourse] tg notify failed:', e.message));
}

