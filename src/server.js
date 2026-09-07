const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execSync, execFile, spawn } = require('child_process');
const path = require('path');
const { loadSecrets } = require('./secrets');
const { runTask, generateConnectLink, getQuickAnswer, getPendingTasks, waitForIdle, getActiveTaskCount } = require('./runner');
const { getAuthFlag, clearAuthFailedFlag } = require('./auth-flag');
const { trackChat, pollDriveChanges } = require('./drive-watcher');
const { listSessions, getSession: getSessionData, archiveSessions, getCurrentSessionId } = require('./session-store');
const { startNalogLogin, confirmNalogCode } = require('./nalog-login');
const { startGetcourseLogin, mergeConfig: mergeGetcourseConfig } = require('./getcourse-login');
const { nalogFormHtml } = require('./connect-forms/nalog');
const { getcourseFormHtml } = require('./connect-forms/getcourse');
const { gdriveFormHtml, gdriveSuccessHtml, gdriveErrorHtml } = require('./connect-forms/gdrive');
const { hhSuccessHtml, hhErrorHtml, hhLandingHtml, hhConfirmHtml } = require('./connect-forms/hh');
const { connectFormHtml } = require('./connect-forms/generic');
const { loginCredsFormHtml } = require('./connect-forms/login-creds');
const { weeekFormHtml } = require('./connect-forms/weeek');
const { scoreUnscoredCandidates, generateDraftMessages } = require('./hh-scoring');
const { storeApplication } = require('./hh-vacancy');

const PORT = process.env.PORT || 3001;
const BASE_USERS_DIR = process.env.USERS_DIR ||
  path.join(process.env.HOME || '/home/vova', 'users');

const VM_NAME = process.env.VM_NAME || 'unknown';
let GIT_COMMIT = 'unknown';
try { GIT_COMMIT = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch {}

function trackProjectUsage(workDir, projectName) {
  const file = path.join(workDir, '.project-usage.json');
  let usage = {};
  try { usage = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  usage[projectName] = (usage[projectName] || 0) + 1;
  try { fs.writeFileSync(file, JSON.stringify(usage)); } catch {}
}

const CLASSIFY_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
// Matches assistant replies that signal task completion — session should not be reused
// Active forms: убрал, удалил, сделал, etc.
// Passive short forms: убран/убрана/убраны, удалён/удалена, очищен, заполнен, etc.
const CLASSIFY_DONE_RE = /готово|сделан|убрал|убран|удалил|удалён|завершен|выполнен|очищен|заполнен|исправлен|опубликован|done|completed|всё\s+готово|всё\s+сделано/i;

async function classifyMessage(message, sessions, anthropicKey, openrouterKey) {
  // Filter out sessions that are too old or ended with a completion reply
  const now = Date.now();
  const activeSessions = sessions.filter(s => {
    if (s.lastAt && now - s.lastAt > CLASSIFY_MAX_AGE_MS) return false;
    if (s.lastMessageRole === 'assistant' && s.lastAssistantSnippet && CLASSIFY_DONE_RE.test(s.lastAssistantSnippet)) return false;
    return true;
  });

  if (activeSessions.length === 0) return { sessionId: null, confidence: 'low' };

  // Build a compact description of each session
  const sessionDescriptions = activeSessions.map((s, i) => {
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

  let answer;
  if (openrouterKey) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openrouterKey}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        max_tokens: 64,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenRouter API ${res.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await res.json();
    answer = data.choices?.[0]?.message?.content?.trim() || 'ambiguous';
  } else {
    throw new Error('No API key configured for classify (OPENROUTER_API_KEY required)');
  }

  if (answer === 'ambiguous') return { sessionId: null, confidence: 'low' };

  // Check that the returned ID actually exists in the active (non-filtered) list
  const match = activeSessions.find(s => s.id === answer);
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

  async function check() {
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
      try { connectUrl = await generateConnectLink(username, 'nalog'); } catch (e) {
        console.error('[nalog-expiry] generateConnectLink failed:', e.message); continue;
      }
      const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
      fetch(`${tgBase}/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
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

// Fetch negotiations across all active stages for a vacancy (parallel per-state requests).
// Excludes 'discard' (rejected) and 'hired' (done) — only actionable/in-progress candidates.
const HH_REVIEW_STATES = ['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer'];

async function fetchAllHhNegotiations(vacancyId, accessToken) {
  const results = await Promise.all(HH_REVIEW_STATES.map(async state => {
    let items = [];
    let page = 0, totalPages = 1;
    do {
      const data = await hhApiRequest('GET', `/negotiations/${state}?vacancy_id=${vacancyId}&per_page=50&page=${page}`, accessToken);
      items = items.concat(data.items || []);
      totalPages = data.pages ?? 1;
      page++;
      if (page >= 50) { console.warn(`[hh] fetchAllHhNegotiations: hit 50-page cap for state=${state}`); break; }
    } while (page < totalPages);
    return items.map(item => ({ ...item, _state: state }));
  }));
  return results.flat();
}

function hhCacheFile(dataDir, username) {
  return path.join(dataDir, 'hh', String(username), 'negotiations-cache.json');
}

async function getHhNegotiationsWithCache(dataDir, username, vacancyId, accessToken) {
  const cacheFile = hhCacheFile(dataDir, username);
  const CACHE_TTL_MS = 15 * 60 * 1000;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const ageMs = Date.now() - (cached.synced_at || 0);
    if (ageMs < CACHE_TTL_MS && String(cached.vacancy_id) === String(vacancyId)) {
      return { negotiations: cached.negotiations, synced_at: cached.synced_at };
    }
  } catch {}
  const negotiations = await fetchAllHhNegotiations(vacancyId, accessToken);
  const synced_at = Date.now();
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ synced_at, vacancy_id: String(vacancyId), negotiations }), { mode: 0o600 });
  } catch (e) { console.error('[hh-cache] write error:', e.message); }
  return { negotiations, synced_at };
}

// Background HH scoring: fetch negotiations + score unscored candidates for all users
// with HH token + active vacancy + ATS config. Runs every 5 min so the review page
// shows scores immediately without blocking on page open.
const _hhBgRunning = new Set();

async function runHhScoringForUser(username) {
  if (_hhBgRunning.has(username)) return;
  _hhBgRunning.add(username);
  try {
    const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
    const tokenFile = path.join(hhTokensBase, String(username), 'hh');
    if (!fs.existsSync(tokenFile)) return;
    let tokenData;
    try { tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { return; }
    if (!tokenData?.access_token) return;

    // workDir must match where Claude writes context (/run handler uses BASE_USERS_DIR)
    const workDir = path.join(BASE_USERS_DIR, String(username));
    const vacancyCtxFile = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
    if (!fs.existsSync(vacancyCtxFile)) return;
    let vacancy;
    try { vacancy = JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value; } catch { return; }
    if (!vacancy?.id) return;

    // Only score if ATS config exists (otherwise no criteria to score against)
    const configFile = path.join(workDir, 'contexts', 'hh', 'ats_config.json');
    if (!fs.existsSync(configFile)) return;

    const negotiations = await fetchAllHhNegotiations(vacancy.id, tokenData.access_token);

    const scored = await scoreUnscoredCandidates(negotiations, username, workDir, { maxConcurrent: 4 });
    if (scored > 0) console.log(`[hh-bg] scored ${scored} new candidates for ${username}/${vacancy.id}`);

    const drafted = await generateDraftMessages(negotiations, username, workDir, { maxConcurrent: 3 });
    if (drafted > 0) console.log(`[hh-bg] generated ${drafted} draft messages for ${username}/${vacancy.id}`);
  } catch (e) {
    console.error(`[hh-bg] error for ${username}:`, e.message);
  } finally {
    _hhBgRunning.delete(username);
  }
}

function scheduleHhBackgroundScoring() {
  async function run() {
    const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
    if (!fs.existsSync(hhTokensBase)) return;
    for (const username of fs.readdirSync(hhTokensBase)) {
      runHhScoringForUser(username).catch(() => {});
      await new Promise(r => setTimeout(r, 1000)); // stagger users to avoid API burst
    }
  }
  setTimeout(() => run().catch(() => {}), 3 * 60 * 1000); // first run 3 min after start
  setInterval(() => run().catch(() => {}), 5 * 60 * 1000);
}

async function resumePendingTasks(secrets) {
  const pending = getPendingTasks();
  const cutoff = Date.now() - 15 * 60 * 1000;
  const toResume = pending.filter(t => t.startedAt && t.startedAt > cutoff && t.username && t.userId && t.task);
  // Clean up stale files that are too old to resume — prevents slow startup after many crashes.
  const { clearPendingTask: _clearStale } = require('./runner');
  for (const t of pending) {
    if (!toResume.includes(t) && t.taskId) _clearStale(t.taskId);
  }
  if (toResume.length === 0) return;

  console.log(`[resume] ${toResume.length} pending task(s) from before restart — resuming`);
  const TG_BASE = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

  // Import clearPendingTask to remove original files before re-running
  const { clearPendingTask: _clearPending } = require('./runner');

  for (const p of toResume) {
    console.log(`[resume] task=${p.taskId} user=${p.username} task="${String(p.task).slice(0, 60)}"`);
    // Delete original file immediately — the new runTask will journal under its own taskId
    _clearPending(p.taskId);
    if (p.initialMsgId && secrets.BOT_TOKEN) {
      fetch(`${TG_BASE}/bot${secrets.BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: p.userId, message_id: p.initialMsgId, text: '🔄 Перезапускаю после сбоя…' }),
      }).catch(() => {});
    }
    const workDir = p.workDir || path.join(BASE_USERS_DIR, p.username);
    const user = { id: p.userId, name: p.username, username: p.username, workDir };
    const newTaskId = `${p.username}-resume-${Date.now()}`;
    runTask({ taskId: newTaskId, user, task: p.task, context: p.context || null,
      sessionId: p.sessionId || null, contextFromSession: p.contextFromSession || null,
      forceClaude: !!p.forceClaude, initialMsgId: p.initialMsgId || null,
      pinnedMsgId: p.pinnedMsgId || null, secrets,
    }).catch(err => console.error(`[resume] ${newTaskId} error:`, err.message));
    await new Promise(r => setTimeout(r, 500)); // stagger multiple resumes
  }
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
          signal: AbortSignal.timeout(8000),
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
            'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
            'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
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
          signal: AbortSignal.timeout(8000),
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
              signal: AbortSignal.timeout(8000),
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
              signal: AbortSignal.timeout(8000),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: wkChatId, text: notifyText }),
            }).catch(e => console.error('[connect] tg notify failed:', e.message));
          }
          return;
        }

        res.writeHead(405).end(); return;
      }

      // ── site — generic Playwright login + crawl ───────────────────────────────
      if (service === 'site') {
        if (req.method === 'GET') {
          const t = url.searchParams.get('t') || '';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(siteFormHtml(t));
          return;
        }

        if (req.method === 'POST') {
          let payload;
          try { payload = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
          const { t, url: siteUrl, login, password } = payload;
          if (!t || !siteUrl || !login || !password) { res.writeHead(400).end(JSON.stringify({ error: 'missing fields' })); return; }
          if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

          const pendingFileSite = path.join(CONNECT_PENDING_DIR, `${t}.json`);
          let pendingSite;
          try { pendingSite = JSON.parse(fs.readFileSync(pendingFileSite, 'utf8')); } catch { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
          if (pendingSite.expires < Date.now()) { try { fs.unlinkSync(pendingFileSite); } catch {} res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
          if (pendingSite.service !== 'site') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pendingSite.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }
          try { fs.unlinkSync(pendingFileSite); } catch { res.writeHead(403).end(JSON.stringify({ error: 'link already used' })); return; }

          const siteResult = await connectSite(pendingSite.uid, { url: siteUrl, login, password });
          if (siteResult.error) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: siteResult.error }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(siteResult));
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
            signal: AbortSignal.timeout(8000),
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
    if (req.method === 'OPTIONS' && (url.pathname === '/hh/send' || url.pathname === '/hh/reject' || url.pathname === '/hh/send-and-reject' || url.pathname === '/hh/ats-config' || url.pathname === '/hh/review' || url.pathname === '/hh/reset-ats-results' || url.pathname === '/hh/generate-message' || url.pathname === '/hh/update-style' || url.pathname === '/hh/sync-negotiations')) {
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
      const workDir = path.join(BASE_USERS_DIR, username);
      const vacancyCtxFile = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
      let vacancy = null;
      try { vacancy = JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value; } catch {}
      if (!vacancy?.id) return errPage('Вакансия не выбрана. Скажи боту «мои вакансии» и выбери вакансию.');

      let negotiations = [], syncedAt = null;
      try {
        const result = await getHhNegotiationsWithCache(dataDir, username, vacancy.id, tokenData.access_token);
        negotiations = result.negotiations;
        syncedAt = result.synced_at;
      } catch (e) { console.error('[hh/review] fetch error:', e.message); }

      const callbackBase = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
      const html = generateReviewPageHtml(negotiations, vacancy.title || 'Вакансия', username, callbackBase, dataDir, { syncedAt, vacancyId: vacancy.id });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);

      // Score any unscored candidates in the background after page is already served
      runHhScoringForUser(username).catch(e => console.error('[hh/review] bg-score error:', e.message));
      return;
    }

    // GET /hh/ats-editor?username=X&token=Y — serve the ATS Template Editor HTML page
    // Must be before Bearer-auth gate so browsers can open it directly.
    if (req.method === 'GET' && url.pathname === '/hh/ats-editor') {
      const username = url.searchParams.get('username') || '';
      const agentSecret = process.env.AGENT_SECRET || '';
      if (agentSecret) {
        const { createHmac } = require('crypto');
        const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
        const given = url.searchParams.get('token') || '';
        if (given !== expected) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<!doctype html><html><body style="font-family:system-ui;padding:48px;text-align:center"><h2>Ссылка недействительна. Запроси новую у бота.</h2></body></html>');
        }
      }
      const { atsEditorHtml } = require('./hh-ats-editor-html.js');
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const workDir = path.join(dataDir, 'sessions', username);
      const contextBase = path.join(workDir, 'contexts');
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
        username,
        agentSecret: agentSecret || '',
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // POST /hh/send — send a message to a candidate (called from review page)
    if (req.method === 'POST' && url.pathname === '/hh/send') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
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

    // POST /hh/generate-message — generate draft for one candidate (called from review page)
    if (req.method === 'POST' && url.pathname === '/hh/generate-message') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = JSON.parse(await readBody(req));
      const { username, negotiation_id, resume_text, candidate_name, already_sent, message_type } = body || {};
      if (!username || !negotiation_id) return json(res, 400, { error: 'missing fields' });

      const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const orKeyFile = path.join(hhTokensBase, String(username), 'openrouter');
      const apiKey = fs.existsSync(orKeyFile) ? fs.readFileSync(orKeyFile, 'utf8').trim() : process.env.OPENROUTER_API_KEY;
      if (!apiKey) return json(res, 503, { error: 'OpenRouter key not configured' });

      const styleFile = path.join(hhTokensBase, String(username), 'hh-message-style');
      const commStyle = fs.existsSync(styleFile) ? fs.readFileSync(styleFile, 'utf8').trim() : null;

      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const candDir = path.join(dataDir, 'hh', String(username), 'candidates');
      const histFile = path.join(candDir, `${negotiation_id}.json`);
      const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : { messages: [] };
      const msgs = history.messages || [];
      const hasPriorContact = msgs.some(m => m.role === 'employer');
      const msgType = message_type === 'rejection' ? 'rejection' : (already_sent || hasPriorContact ? 'followup' : 'initial');

      // Read HH token once — reused for resume fetch and vacancy fetch
      let hhToken = null;
      try {
        const hhTokenFile = path.join(hhTokensBase, String(username), 'hh');
        if (fs.existsSync(hhTokenFile)) hhToken = JSON.parse(fs.readFileSync(hhTokenFile, 'utf8'));
      } catch { /* ignore */ }

      // If resume_text from page is too short, fetch full resume from HH API
      let fullResumeText = (resume_text || '').trim();
      if (fullResumeText.length < 80 && msgType === 'initial' && hhToken) {
        try {
          const neg = await hhApiRequest('GET', `/negotiations/${negotiation_id}`, hhToken.access_token);
          const r = neg.resume || {};
          const lines = [];
          if (r.title) lines.push(`Позиция: ${r.title}`);
          if (r.total_experience?.months) {
            const y = Math.floor(r.total_experience.months / 12);
            lines.push(`Опыт: ${y} лет`);
          }
          if (r.area?.name) lines.push(`Локация: ${r.area.name}`);
          if (r.experience?.length) {
            lines.push('Опыт работы:');
            for (const job of r.experience.slice(0, 4)) {
              lines.push(`- ${job.company || ''}: ${job.position || ''}`);
              if (job.description) lines.push(`  ${job.description.slice(0, 250)}`);
            }
          }
          if (r.skill_set?.length) lines.push(`Навыки: ${r.skill_set.slice(0, 20).join(', ')}`);
          if (neg.message) lines.push(`Сопроводительное: ${neg.message.slice(0, 400)}`);
          if (lines.length > 0) fullResumeText = lines.join('\n');
        } catch { /* use whatever we have */ }
      }

      // Fetch vacancy description from HH API for targeted message generation
      let vacancyContext = '';
      if (hhToken) {
        try {
          const vacancyCtxFile = path.join(dataDir, 'sessions', String(username), 'contexts', 'hh', 'active_vacancy.json');
          const vacData = fs.existsSync(vacancyCtxFile) ? JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value : null;
          if (vacData?.id) {
            const vac = await hhApiRequest('GET', `/vacancies/${vacData.id}`, hhToken.access_token);
            const descText = (vac.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
            const skills = (vac.key_skills || []).map(s => s.name).join(', ');
            const parts = [`Вакансия: ${vac.name || ''}`];
            if (descText) parts.push('Описание и требования:\n' + descText);
            if (skills) parts.push('Ключевые навыки: ' + skills);
            vacancyContext = parts.join('\n\n');
          }
        } catch { /* ignore — generate without vacancy context */ }
      }

      const baseSystem = 'Ты — рекрутер. ВСЕГДА пиши сообщение, даже если данных мало.\n' +
        'Тон: профессиональный, уважительный, конкретный. Пиши от первого лица на русском языке.\n' +
        'Структура: 1) Приветствие с именем 2) что зацепило в резюме 3) короткое описание роли 4) 1-2 конкретных вопроса по требованиям вакансии 5) призыв к действию.\n' +
        'Форматирование: каждый вопрос — отдельная строка (через \\n). Между смысловыми блоками — пустая строка. Не пиши всё в один абзац.\n' +
        'Длина: 4-7 предложений. Обязательно задай конкретные вопросы из требований вакансии — не общие, а именно те что важны для этой роли.' +
        (vacancyContext ? '\n\n## Контекст вакансии\n' + vacancyContext : '');
      const followupSystem = `Ты — рекрутер. Напиши короткий follow-up кандидату, который не ответил на первое сообщение.
Тон: лёгкий, без давления. 2-3 предложения. Пиши на русском языке.`;
      const rejectionSystem = `Ты — рекрутер. Напиши вежливый отказ кандидату.
Тон: уважительный, тёплый, без объяснения причин. Пожелай удачи в поиске. 2-3 предложения. Пиши на русском языке.`;

      const activeSystem = msgType === 'rejection' ? rejectionSystem : msgType === 'followup' ? followupSystem : baseSystem;
      const systemPrompt = commStyle
        ? `${activeSystem}\n\n## Стиль общения рекрутера\n${commStyle}`
        : activeSystem;

      const firstName = (candidate_name || 'Кандидат').split(' ')[0];
      const userMsg = msgType === 'rejection'
        ? `Напиши вежливый отказ кандидату ${firstName}.`
        : msgType === 'followup'
          ? `Кандидат ${firstName} не ответил. Напиши follow-up.`
          : `Напиши первое сообщение кандидату ${firstName}.\n\nРезюме:\n${fullResumeText || '(резюме недоступно — напиши общее приглашение)'}`;

      try {
        const message = await new Promise((resolve, reject) => {
          const reqBody = JSON.stringify({
            model: 'openai/gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
            temperature: 0.7,
            max_tokens: 800,
          });
          const hreq = require('https').request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
          }, (hres) => {
            const chunks = [];
            hres.on('data', c => chunks.push(c));
            hres.on('end', () => {
              try {
                const p = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (p.error) reject(new Error(p.error.message || JSON.stringify(p.error)));
                else resolve(p.choices[0].message.content);
              } catch (e) { reject(e); }
            });
          });
          hreq.on('error', reject);
          hreq.write(reqBody);
          hreq.end();
        });

        if (!history.ats_result) history.ats_result = {};
        history.ats_result.draft_message = message;
        fs.mkdirSync(candDir, { recursive: true });
        fs.writeFileSync(histFile, JSON.stringify(history, null, 2), { mode: 0o600 });
        return json(res, 200, { ok: true, message });
      } catch (e) {
        console.error('[hh/generate-message] error:', e.message);
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

    // POST /hh/send-and-reject — send a rejection message then reject in HH
    if (req.method === 'POST' && url.pathname === '/hh/send-and-reject') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = JSON.parse(await readBody(req));
      const { username, negotiation_id, message } = body || {};
      if (!username || !negotiation_id || !message) return json(res, 400, { error: 'missing fields' });

      const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const tokenFile = path.join(hhTokensBase, String(username), 'hh');
      if (!fs.existsSync(tokenFile)) return json(res, 403, { error: 'HH not connected for this user' });
      const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));

      try {
        // Send rejection message first
        await hhApiPost(`/negotiations/${negotiation_id}/messages`, tokenData.access_token, { message });
        // Then reject in HH
        await hhApiPut(`/negotiations/discard_vacancy_closed/${negotiation_id}`, tokenData.access_token);

        // Save to history
        const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
        const histDir = path.join(dataDir, 'hh', String(username), 'candidates');
        fs.mkdirSync(histDir, { recursive: true });
        const histFile = path.join(histDir, `${negotiation_id}.json`);
        const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : { messages: [] };
        history.messages = history.messages || [];
        history.messages.push({ role: 'employer', text: message, timestamp: new Date().toISOString(), type: 'rejection' });
        fs.writeFileSync(histFile, JSON.stringify(history, null, 2), { mode: 0o600 });

        console.log(`[hh/send-and-reject] user=${username} neg=${negotiation_id}`);
        return json(res, 200, { ok: true });
      } catch (e) {
        console.error('[hh/send-and-reject] error:', e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // GET /hh/style?username=X&token=Y — style update page
    if (req.method === 'GET' && url.pathname === '/hh/style') {
      const username = url.searchParams.get('username') || '';
      const agentSecret = process.env.AGENT_SECRET || '';
      const errStylePage = (msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Стиль общения</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f8fafc;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
      };
      if (agentSecret) {
        const { createHmac } = require('crypto');
        const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
        if ((url.searchParams.get('token') || '') !== expected) return errStylePage('Ссылка недействительна. Запроси новую у бота.');
      }
      if (!username) return errStylePage('Не указан пользователь.');
      const hhTokensBase3 = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const styleFile3 = path.join(hhTokensBase3, String(username), 'hh-message-style');
      const existingStyle = fs.existsSync(styleFile3) ? fs.readFileSync(styleFile3, 'utf8').trim() : '';
      const callbackBase3 = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
      const hmacToken3 = agentSecret ? require('crypto').createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16) : '';
      const defaultStyle = '- Тон: профессиональный, дружелюбный, без официоза. Обращение на «вы».\n- Приветствие: «Добрый день, [Имя]!» или «Здравствуйте, [Имя]!»\n- Структура: приветствие → что понравилось в резюме → описание роли → 1-2 конкретных вопроса → призыв ответить\n- Всегда задаю конкретные вопросы по опыту из требований вакансии, не общие\n- Не использую штампы: «рассмотрели вашу кандидатуру», «вакансия открылась», «мы ищем»\n- Длина: 4-6 предложений\n- Подпись: имя рекрутера';
      const rulesValue = (existingStyle || defaultStyle).replace(/`/g, '\\`');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8">
<title>Стиль общения — ${username}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f8fafc;color:#1e293b;max-width:720px;margin:0 auto}
h1{font-size:1.4rem;margin-bottom:4px}
p.sub{color:#64748b;margin:0 0 16px;font-size:.9rem}
h2{font-size:1rem;margin:24px 0 6px;color:#1e293b}
textarea{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font-size:.9rem;line-height:1.5;resize:vertical;background:#fff;color:#1e293b}
textarea::placeholder{color:#94a3b8}
.hint{color:#64748b;font-size:.82rem;margin:6px 0 12px}
button{border:none;padding:10px 24px;border-radius:8px;font-size:.95rem;cursor:pointer;font-weight:600}
.btn-primary{background:#2563eb;color:#fff}
.btn-primary:hover{background:#1d4ed8}
.btn-secondary{background:#e2e8f0;color:#334155}
.btn-secondary:hover{background:#cbd5e1}
button:disabled{opacity:.5;cursor:not-allowed}
.sep{border:none;border-top:1px solid #e2e8f0;margin:28px 0}
.status{margin-top:12px;padding:10px 14px;border-radius:8px;font-size:.9rem;display:none}
.status.ok{background:#dcfce7;color:#166534;display:block}
.status.err{background:#fee2e2;color:#991b1b;display:block}
.status.loading{background:#fef9c3;color:#713f12;display:block}
</style>
</head><body>
<h1>✍️ Стиль общения с кандидатами</h1>
<p class="sub">Правила применяются при генерации сообщений. Отредактируй напрямую или загрузи из примеров диалогов.</p>

<h2>Правила стиля</h2>
<textarea id="rules" rows="10" placeholder="- Тон: ...\n- Приветствие: ...\n- Структура: ...">${rulesValue}</textarea>
<div class="hint">Можно писать в свободной форме — список правил, описание тона, любые инструкции.</div>
<button class="btn-primary" id="btnSave" onclick="saveRules()">Сохранить правила</button>
<div class="status" id="statusSave"></div>

<hr class="sep">

<h2>Или загрузить из примеров / диалогов</h2>
<p class="sub" style="margin-bottom:10px">Можно кидать прямо диалоги целиком — поймём где вы, где кандидат. AI извлечёт правила стиля и заполнит поле выше.</p>
<textarea id="examples" rows="8" placeholder="Рекрутер: Добрый день, Иван! Посмотрела ваше резюме...
Кандидат: Здравствуйте! Да, интересно узнать подробности.
Рекрутер: Отлично! Расскажите, есть ли у вас опыт..."></textarea>
<div class="hint">Примеры используются только для извлечения стиля и не сохраняются.</div>
<button class="btn-secondary" id="btnExtract" onclick="extractStyle()">Извлечь стиль из примеров</button>
<div class="status" id="statusExtract"></div>

<script>
async function saveRules() {
  const text = document.getElementById('rules').value.trim();
  if (!text || text.length < 10) { show('statusSave', 'err', 'Правила не могут быть пустыми.'); return; }
  document.getElementById('btnSave').disabled = true;
  show('statusSave', 'loading', 'Сохраняю...');
  try {
    const r = await fetch('${callbackBase3}/hh/update-style', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: '${username}', token: '${hmacToken3}', examples: text, direct: true}),
    });
    const d = await r.json();
    if (d.ok) show('statusSave', 'ok', '✅ Правила сохранены! Применятся при следующей генерации сообщений.');
    else show('statusSave', 'err', 'Ошибка: ' + (d.error || 'неизвестная'));
  } catch(e) { show('statusSave', 'err', 'Сетевая ошибка: ' + e.message); }
  document.getElementById('btnSave').disabled = false;
}
async function extractStyle() {
  const text = document.getElementById('examples').value.trim();
  if (!text || text.length < 50) { show('statusExtract', 'err', 'Вставь хотя бы пару примеров (мин. 50 символов).'); return; }
  document.getElementById('btnExtract').disabled = true;
  show('statusExtract', 'loading', 'Анализирую примеры... 5–15 секунд...');
  try {
    const r = await fetch('${callbackBase3}/hh/update-style', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: '${username}', token: '${hmacToken3}', examples: text, direct: false, save: false}),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('rules').value = d.style;
      show('statusExtract', 'ok', '✅ Стиль извлечён — проверь поле «Правила стиля» выше и нажми «Сохранить».');
    } else {
      show('statusExtract', 'err', 'Ошибка: ' + (d.error || 'неизвестная'));
    }
  } catch(e) { show('statusExtract', 'err', 'Сетевая ошибка: ' + e.message); }
  document.getElementById('btnExtract').disabled = false;
}
function show(id, type, msg) {
  const s = document.getElementById(id);
  s.className = 'status ' + type; s.textContent = msg;
}
</script>
</body></html>`);
    }

    // POST /hh/update-style — extract style from examples and save
    if (req.method === 'POST' && url.pathname === '/hh/update-style') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body4 = JSON.parse(await readBody(req));
      const { username, token: givenToken, examples, direct = false, save: doSave = true } = body4 || {};
      if (!username || !examples || typeof examples !== 'string') return json(res, 400, { error: 'missing fields' });
      if (!direct && examples.trim().length < 50) return json(res, 400, { error: 'examples too short' });
      const agentSecret4 = process.env.AGENT_SECRET || '';
      if (agentSecret4) {
        const { createHmac } = require('crypto');
        const expected4 = createHmac('sha256', agentSecret4).update(String(username)).digest('hex').slice(0, 16);
        if (givenToken !== expected4) return json(res, 403, { error: 'invalid token' });
      }
      const hhTokensBase4 = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');

      // direct mode: save as-is without AI
      if (direct) {
        fs.mkdirSync(path.join(hhTokensBase4, String(username)), { recursive: true });
        fs.writeFileSync(path.join(hhTokensBase4, String(username), 'hh-message-style'), examples.trim());
        console.log('[hh/update-style] direct save for', username, 'len=', examples.length);
        return json(res, 200, { ok: true, style: examples.trim() });
      }

      const orKeyFile4 = path.join(hhTokensBase4, String(username), 'openrouter');
      const apiKey4 = fs.existsSync(orKeyFile4) ? fs.readFileSync(orKeyFile4, 'utf8').trim() : process.env.OPENROUTER_API_KEY;
      if (!apiKey4) return json(res, 503, { error: 'OpenRouter key not configured' });

      const systemPrompt4 = 'Ты — аналитик коммуникаций. Тебе могут прислать отдельные сообщения рекрутера ИЛИ полные диалоги между рекрутером и кандидатом. Если это диалог — проанализируй только сообщения рекрутера, проигнорируй ответы кандидата.\n\nСоставь краткое описание стиля общения рекрутера. Это описание будет использоваться как инструкция для нейросети при генерации новых сообщений.\n\nФормат — структурированный список на русском языке (через дефис):\n- Тон и манера (формальность, теплота)\n- Характерные обороты и приветствия (с реальными примерами из текста)\n- Структура типичного сообщения\n- Что обычно уточняет или спрашивает\n- Чего избегает\n- Длина сообщений\n\nБудь конкретным — цитируй реальные фразы из примеров.';
      const userMsg4 = 'Примеры (могут быть диалоги или отдельные сообщения рекрутера):\n\n' + examples.trim().slice(0, 4000);

      try {
        const style = await new Promise((resolve, reject) => {
          const reqBody4 = JSON.stringify({
            model: 'openai/gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt4 }, { role: 'user', content: userMsg4 }],
            temperature: 0.3,
            max_tokens: 600,
          });
          const hreq4 = require('https').request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: { Authorization: 'Bearer ' + apiKey4, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody4) },
          }, (hres4) => {
            const chunks4 = [];
            hres4.on('data', c => chunks4.push(c));
            hres4.on('end', () => {
              try {
                const p = JSON.parse(Buffer.concat(chunks4).toString('utf8'));
                if (p.error) reject(new Error(p.error.message || JSON.stringify(p.error)));
                else resolve(p.choices[0].message.content);
              } catch (e) { reject(e); }
            });
          });
          hreq4.on('error', reject);
          hreq4.write(reqBody4);
          hreq4.end();
        });

        if (doSave !== false) {
          fs.mkdirSync(path.join(hhTokensBase4, String(username)), { recursive: true });
          fs.writeFileSync(path.join(hhTokensBase4, String(username), 'hh-message-style'), style.trim());
          console.log('[hh/update-style] saved style for', username, 'len=', style.length);
        }
        return json(res, 200, { ok: true, style });
      } catch (e) {
        console.error('[hh/update-style] error:', e.message);
        return json(res, 500, { error: 'generation failed: ' + e.message });
      }
    }

    // POST /hh/sync-negotiations — force-refresh negotiations cache (called from review page)
    if (req.method === 'POST' && url.pathname === '/hh/sync-negotiations') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = JSON.parse(await readBody(req));
      const { username: syncUser, vacancy_id: syncVacancyId } = body || {};
      if (!syncUser || !syncVacancyId) return json(res, 400, { error: 'missing fields' });
      const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
      const syncTokenFile = path.join(hhTokensBase, String(syncUser), 'hh');
      if (!fs.existsSync(syncTokenFile)) return json(res, 403, { error: 'HH not connected' });
      const syncTokenData = JSON.parse(fs.readFileSync(syncTokenFile, 'utf8'));
      const syncDataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      try {
        const negotiations = await fetchAllHhNegotiations(syncVacancyId, syncTokenData.access_token);
        const cacheFile = hhCacheFile(syncDataDir, syncUser);
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const synced_at = Date.now();
        fs.writeFileSync(cacheFile, JSON.stringify({ synced_at, vacancy_id: String(syncVacancyId), negotiations }), { mode: 0o600 });
        console.log(`[hh/sync] user=${syncUser} vacancy=${syncVacancyId} count=${negotiations.length}`);
        return json(res, 200, { ok: true, count: negotiations.length, synced_at });
      } catch (e) {
        console.error('[hh/sync] error:', e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // GET /images/:filename — serve images generated by skills (public, no auth — Telegram downloads without token)
    const imagesMatch = url.pathname.match(/^\/images\/([a-zA-Z0-9_.-]+\.(?:png|jpg|jpeg))$/);
    if (req.method === 'GET' && imagesMatch) {
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const filePath = path.join(dataDir, 'images', imagesMatch[1]);
      if (!fs.existsSync(filePath)) return json(res, 404, { error: 'not found' });
      const ext = path.extname(filePath).slice(1);
      res.writeHead(200, { 'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // GET /vacancy/:username/:vacancyId — public vacancy landing page (no auth)
    const vacancyPageMatch = url.pathname.match(/^\/vacancy\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && vacancyPageMatch) {
      const [, username, vacancyId] = vacancyPageMatch;
      const htmlPath = path.join(os.homedir(), 'users', username, 'vacancy-drafts', `${vacancyId}.html`);
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      } catch {
        res.writeHead(404).end('Vacancy not found');
      }
      return;
    }

    // GET /health — no auth, liveness check for smoke tests and monitoring
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'alive', uptime: process.uptime(), vm: VM_NAME, commit: GIT_COMMIT });
    }

    // GET /p/:slug — serve a published page (no auth, public)
    const pageServeMatch = url.pathname.match(/^\/p\/([a-z0-9][a-z0-9-]{0,79})$/);
    if (req.method === 'GET' && pageServeMatch) {
      const slug = pageServeMatch[1];
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const pageDir = path.join(dataDir, 'pages', slug);
      const metaFile = path.join(pageDir, 'meta.json');

      if (!fs.existsSync(metaFile)) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<h1>404</h1><p>Page not found.</p>');
      }

      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        return res.end('<h1>500</h1><p>Corrupted page metadata.</p>');
      }

      // Serve raw source if ?raw requested (for AI agents reading markdown)
      const wantsRaw = url.searchParams.has('raw');
      if (wantsRaw) {
        const rawFile = path.join(pageDir, 'source');
        if (fs.existsSync(rawFile)) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(fs.readFileSync(rawFile));
        }
      }

      // Password check
      if (meta.passwordHash) {
        const pw = url.searchParams.get('password') || '';
        const { createHash } = require('crypto');
        const pwHash = pw ? createHash('sha256').update(pw).digest('hex') : '';
        if (!pw || pwHash !== meta.passwordHash) {
          const errMsg = pw ? 'Неверный пароль, попробуйте ещё раз.' : '';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(publishPasswordForm(slug, errMsg));
        }
      }

      const htmlFile = path.join(pageDir, 'index.html');
      if (!fs.existsSync(htmlFile)) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<h1>404</h1><p>Content not found.</p>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlFile));
    }


    // POST /telegram/misha — @cmr_management_bot direct webhook (no AGENT_SECRET auth)
    if (req.method === 'POST' && url.pathname === '/telegram/misha') {
      const mishaBotTokenFile = path.join(os.homedir(), 'agent-tokens', 'misha', 'telegram-bot-token');
      const mishaBotToken = fs.existsSync(mishaBotTokenFile)
        ? fs.readFileSync(mishaBotTokenFile, 'utf8').trim() : null;
      if (!mishaBotToken) {
        console.warn('[misha/webhook] Bot token file missing');
        return json(res, 503, { error: 'bot not configured' });
      }
      let update;
      try { update = JSON.parse(await readBody(req)); } catch { return json(res, 400, {}); }
      json(res, 200, { ok: true });
      processMishaUpdate(update, mishaBotToken, secrets).catch(e =>
        console.error('[misha/webhook] error:', e.message)
      );
      return;
    }

    // Auth: all endpoints require Bearer token
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secrets.AGENT_SECRET}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // POST /report — create a GitHub issue from a user-submitted bug report
    if (req.method === 'POST' && url.pathname === '/report') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, description, sessionId } = body || {};
      if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
      if (!description || typeof description !== 'string' || !description.trim()) return json(res, 400, { error: 'description required' });

      if (!secrets.GITHUB_ISSUES_TOKEN) return json(res, 503, { error: 'reporting not configured' });

      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const workDir = path.join(dataDir, 'sessions', username);

      // Load current session
      let session = null;
      try {
        const sid = sessionId || getCurrentSessionId(workDir);
        if (sid) session = await getSessionData(workDir, sid);
      } catch {}

      // Load recent sessions list
      let recentSessions = [];
      try { recentSessions = await listSessions(workDir, 5); } catch {}

      // Build session section
      let sessionSection = '';
      if (session) {
        const msgs = (session.messages || []).slice(-6);
        const msgLines = msgs.map(m => {
          const role = m.role === 'user' ? '**Пользователь:**' : '**Клод:**';
          const text = (m.content || '').slice(0, 500);
          return `${role} ${text}`;
        }).join('\n\n');
        sessionSection = `\n## Текущая сессия\n\n**Тема:** "${session.topic || '—'}" (${(session.messages || []).length} сообщений)\n**ID:** ${session.id}\n\n### Последние сообщения\n\n${msgLines}\n`;
      }

      // Build recent sessions section
      let recentSection = '';
      if (recentSessions.length > 0) {
        const lines = recentSessions.map((s, i) => {
          const date = s.lastAt ? new Date(s.lastAt).toISOString().slice(0, 10) : '—';
          return `${i + 1}. "${s.topic || '—'}" — ${date}`;
        }).join('\n');
        recentSection = `\n## Последние сессии\n\n${lines}\n`;
      }

      const issueBody = `**Репорт от пользователя:** ${username}\n**Дата:** ${new Date().toISOString()}\n\n## Описание\n\n${description.trim()}${sessionSection}${recentSection}`;

      const issuePayload = JSON.stringify({
        title: `[Report] ${description.trim().slice(0, 80)}`,
        body: issueBody,
        labels: ['user-report'],
      });

      let ghRes;
      try {
        ghRes = await fetch('https://api.github.com/repos/trained-assist/trained-assist-agent/issues', {
          method: 'POST',
          headers: {
            'Authorization': `token ${secrets.GITHUB_ISSUES_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'trained-assist-agent/1.0',
            'Accept': 'application/vnd.github+json',
          },
          body: issuePayload,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        return json(res, 502, { error: `github request failed: ${e.message}` });
      }

      let issueData;
      try { issueData = await ghRes.json(); } catch { issueData = {}; }
      if (ghRes.status >= 400) return json(res, 502, { error: issueData.message || `github returned ${ghRes.status}` });

      return json(res, 200, { ok: true, url: issueData.html_url, number: issueData.number });
    }

    // POST /vacancy/store — receive and persist a vacancy landing page HTML from another VM
    if (req.method === 'POST' && url.pathname === '/vacancy/store') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, vacancyId, html } = body || {};
      if (!username || !vacancyId || !html) return json(res, 400, { error: 'missing fields' });
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username) || !/^[a-zA-Z0-9_-]{1,64}$/.test(vacancyId)) {
        return json(res, 400, { error: 'invalid username or vacancyId' });
      }
      const draftsDir = path.join(os.homedir(), 'users', username, 'vacancy-drafts');
      fs.mkdirSync(draftsDir, { recursive: true });
      fs.writeFileSync(path.join(draftsDir, `${vacancyId}.html`), html, 'utf8');
      const pageUrl = `https://platform.recruiter-assistant.ru/vacancy/${username}/${vacancyId}`;
      return json(res, 200, { ok: true, url: pageUrl });
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

    // POST /tasks/:taskId/extend-timeout — called by session_extend_timeout MCP tool
    // Allows Claude to extend its own 15-min session (up to 8 × 15 min = 2h total)
    if (req.method === 'POST' && /^\/tasks\/[^/]+\/extend-timeout$/.test(url.pathname)) {
      const taskId = url.pathname.split('/')[2];
      const { extendTaskTimeout } = require('./runner');
      const result = extendTaskTimeout(taskId);
      return json(res, result.ok ? 200 : 404, result);
    }

    // POST /tasks/:taskId/stop — user-initiated kill of a running Claude process
    if (req.method === 'POST' && /^\/tasks\/[^/]+\/stop$/.test(url.pathname)) {
      const taskId = url.pathname.split('/')[2];
      const { stopTask } = require('./runner');
      const result = stopTask(taskId);
      return json(res, result.ok ? 200 : 404, result);
    }

    // GET /projects?username=xxx — list project subdirs sorted by session frequency
    if (req.method === 'GET' && url.pathname === '/projects') {
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      const workDir = path.join(BASE_USERS_DIR, username);
      let usage = {};
      try { usage = JSON.parse(fs.readFileSync(path.join(workDir, '.project-usage.json'), 'utf8')); } catch {}

      let subdirs = [];
      try {
        subdirs = fs.readdirSync(workDir, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name);
      } catch {}

      // Root dir always first in candidates; sort by count desc then name asc
      const projects = [
        { name: '', label: '🏠 Корень', count: usage[''] || 0 },
        ...subdirs.map(name => ({ name, label: name, count: usage[name] || 0 })),
      ].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

      return json(res, 200, { projects });
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { userId, username, task, context, sessionId, contextFromSession, forceClaude, telegramUserId, initialMsgId, pinnedMsgId, projectDir, fileBase64, fileName, fileMimeType } = payload;
      if (!userId || !username) return json(res, 400, { error: 'missing fields' });
      // task is optional when forceClaude=true (agent derives it from session's lastUserMessage)
      if (!task && !forceClaude && !fileBase64) return json(res, 400, { error: 'missing fields' });
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
      if (projectDir && !/^[a-zA-Z0-9][a-zA-Z0-9_\-.]*$/.test(projectDir))
        return json(res, 400, { error: 'invalid projectDir' });

      const workDir = path.join(BASE_USERS_DIR, username);
      fs.mkdirSync(workDir, { recursive: true });

      // cwd = project subdir for Claude; workDir stays as data dir for sessions/logs
      const cwd = projectDir ? path.resolve(path.join(workDir, projectDir)) : workDir;
      if (!cwd.startsWith(workDir)) return json(res, 400, { error: 'invalid projectDir' });
      if (projectDir) {
        fs.mkdirSync(cwd, { recursive: true });
        trackProjectUsage(workDir, projectDir);
      }

      const user = { id: userId, name: username, username, workDir, cwd, telegramUserId: telegramUserId || null };
      trackChat(userId);

      // Save attached file (base64) to workDir and prepend path info to the task.
      let effectiveTask = task || '';
      if (fileBase64 && fileName) {
        const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);
        const uploadsDir = path.join(workDir, 'uploads');
        fs.mkdirSync(uploadsDir, { recursive: true });
        const filePath = path.join(uploadsDir, safeName);
        try {
          fs.writeFileSync(filePath, Buffer.from(fileBase64, 'base64'), { mode: 0o600 });
          const typeNote = fileMimeType ? ` (${fileMimeType})` : '';
          const fileNote = `[Файл сохранён: ${filePath}${typeNote}]`;
          effectiveTask = effectiveTask ? `${fileNote}\n\n${effectiveTask}` : fileNote;
        } catch (e) {
          console.error('[/run] file save error:', e.message);
        }
      }

      // Accept request immediately, run task in background
      const taskId = `${username}-${Date.now()}`;
      json(res, 202, { taskId });

      // Fire-and-forget
      runTask({ taskId, user, task: effectiveTask, context, sessionId: sessionId || null, contextFromSession: contextFromSession || null, forceClaude: !!forceClaude, initialMsgId: initialMsgId || null, pinnedMsgId: pinnedMsgId || null, secrets }).catch(err =>
        console.error(`[${taskId}] runTask error:`, err.message)
      );
      return;
    }

    // CORS preflight for /apply (form is hosted on chillai.space, different origin)
    if (req.method === 'OPTIONS' && /^\/apply\//.test(url.pathname)) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // POST /apply/:username/:vacancyId — no auth, public endpoint for candidate applications
    if (req.method === 'POST' && /^\/apply\/[a-zA-Z0-9_-]+\/vac-\d+$/.test(url.pathname)) {
      const parts = url.pathname.split('/');
      const applyUsername = parts[2];
      const vacancyId = parts[3];
      const workDir = path.join(BASE_USERS_DIR, applyUsername);

      let fields = {};
      try {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('multipart/form-data')) {
          // Parse multipart from raw bytes to preserve UTF-8 text correctly
          const rawBuf = await readBodyBuffer(req);
          const boundary = ct.match(/boundary=([^\s;]+)/)?.[1];
          if (boundary) {
            const sep = Buffer.from(`--${boundary}`);
            const parts2 = splitBuffer(rawBuf, sep);
            for (const part of parts2) {
              const headerEnd = indexOfSeq(part, Buffer.from('\r\n\r\n'));
              if (headerEnd === -1) continue;
              const header = part.slice(0, headerEnd).toString();
              const value = part.slice(headerEnd + 4);
              const m = header.match(/Content-Disposition:[^\n]*name="([^"]+)"/);
              if (m && m[1] !== 'resume') {
                // Strip trailing \r\n that multipart adds before next boundary
                const text = value.slice(-2).equals(Buffer.from('\r\n')) ? value.slice(0, -2) : value;
                fields[m[1]] = text.toString('utf8').trim();
              }
            }
          }
        } else {
          const body = await readBody(req);
          if (ct.includes('application/json')) {
            fields = JSON.parse(body);
          } else if (ct.includes('application/x-www-form-urlencoded')) {
            for (const pair of body.split('&')) {
              const [k, v] = pair.split('=');
              if (k) fields[decodeURIComponent(k)] = decodeURIComponent(v || '');
            }
          }
        }
      } catch (e) {
        console.error('[apply] parse error:', e.message);
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid request body' }));
        return;
      }

      const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
      function applyJson(status, data) {
        res.writeHead(status, corsHeaders);
        res.end(JSON.stringify(data));
      }

      const email = String(fields.email || '').trim();
      const phone = String(fields.phone || '').trim();
      if (!email || !phone) return applyJson(400, { error: 'email and phone are required' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return applyJson(400, { error: 'invalid email' });

      try {
        const app = storeApplication(workDir, vacancyId, {
          name: String(fields.name || '').trim().slice(0, 200),
          email,
          phone: phone.slice(0, 30),
          telegram: String(fields.telegram || '').trim().slice(0, 100),
          message: String(fields.message || '').trim().slice(0, 3000),
        }, null, null);

        // Notify recruiter via Telegram if chatId is known
        const chatIdFile = path.join(process.env.HOME || '/home/vova', 'agent-tokens', applyUsername, '.chatid');
        const chatId = fs.existsSync(chatIdFile) ? fs.readFileSync(chatIdFile, 'utf8').trim() : null;
        if (chatId && secrets.BOT_TOKEN) {
          const notifLines = [
            `📬 Новый отклик на вакансию!`,
            '',
            app.name ? `👤 ${app.name}` : '👤 (имя не указано)',
            `📧 ${app.email}`,
            `📞 ${app.phone}`,
            app.telegram ? `✈️ ${app.telegram}` : null,
            app.message ? `\n💬 ${app.message.slice(0, 300)}` : null,
          ].filter(Boolean).join('\n');
          const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
          fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: notifLines }),
          }).catch(e => console.error('[apply] tg notify error:', e.message));
        }

        return applyJson(200, { ok: true });
      } catch (e) {
        console.error('[apply] store error:', e.message);
        return applyJson(500, { error: 'failed to store application' });
      }
    }

    if (req.method === 'POST' && url.pathname === '/tokens') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      // Preflight: ZeroCreds tests reachability before showing the form to the user.
      // Respond immediately without writing anything.
      if (payload._zerocreds_preflight === true) return json(res, 200, { ok: true, preflight: true });

      const userId = payload.userId || url.searchParams.get('userId');
      const label = payload.label || url.searchParams.get('label');
      const { value } = payload;
      if (!userId || !label || !value) return json(res, 400, { error: 'missing fields' });
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(userId))) return json(res, 400, { error: 'invalid userId' });
      if (!/^[a-zA-Z0-9_.-]+$/.test(label) || label.length > 64)
        return json(res, 400, { error: 'invalid label' });

      const tokensDir = path.join(process.env.HOME || '/home/vova', 'agent-tokens', String(userId));
      fs.mkdirSync(tokensDir, { recursive: true });
      const storedValue = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      // If the target path is a directory (e.g. getcourse/ stores a Playwright session),
      // write new credentials inside it as credentials.json rather than overwriting the dir.
      let tokenFilePath = path.join(tokensDir, label);
      try {
        if (fs.statSync(tokenFilePath).isDirectory()) tokenFilePath = path.join(tokenFilePath, 'credentials.json');
      } catch { /* path doesn't exist yet — write flat file */ }
      fs.writeFileSync(tokenFilePath, storedValue, { mode: 0o600 });
      console.log(`[tokens] saved label="${label}" userId=${userId} path=${tokenFilePath}`);

      // Dispatch service-specific post-save actions (Playwright login, notifications, etc.)
      // Add new services here — no need to touch the handler logic below.
      const TOKEN_SERVICE_ACTIONS = {
        'tilda-creds': {
          guard: (c) => c?.email && c?.password,
          pendingMsg: '⏳ Данные получены — вхожу в Tilda...',
          run: (uid, c) => { const { startTildaLogin } = require('./tilda-login'); return startTildaLogin(uid, c.email, c.password); },
          ok: (r) => `✅ Tilda подключена! Сессия сохранена (${r.cookiesCount} cookies). Можно работать.`,
          err: (r) => `❌ Не удалось войти в Tilda: ${r.error}\n\nПроверь email/пароль и повтори: «подключи тильду»`,
        },
        'getcourse': {
          guard: (c) => c?.domain && (c?.login || c?.password),
          pendingMsg: '⏳ Данные получены — вхожу в GetCourse...',
          run: (uid, c) => {
            const { startGetcourseLogin } = require('./getcourse-login');
            const domain = c.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
            return startGetcourseLogin(uid, domain, c.login, c.password);
          },
          ok: (r) => `✅ GetCourse подключён! Сессия сохранена (${r.cookiesCount} cookies). Можно работать.`,
          err: (r) => `❌ Не удалось войти в GetCourse: ${r.error}\n\nПроверь логин/пароль и повтори: «подключи getcourse»`,
        },
      };

      const svcAction = TOKEN_SERVICE_ACTIONS[label];
      if (svcAction) {
        let creds;
        try { creds = JSON.parse(storedValue); } catch { /* not JSON — skip action */ }
        if (creds && svcAction.guard(creds)) {
          const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
          const tgSend = (chatId, text) => fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
            method: 'POST', signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
          }).catch(() => {});

          const chatId = readChatId(String(userId));
          if (chatId && secrets.BOT_TOKEN) tgSend(chatId, svcAction.pendingMsg);

          svcAction.run(String(userId), creds).then(result => {
            const chatId2 = readChatId(String(userId));
            if (chatId2 && secrets.BOT_TOKEN) {
              tgSend(chatId2, result.status === 'ok' ? svcAction.ok(result) : svcAction.err(result));
            }
          }).catch(e => console.error(`[tokens/${label}] action failed:`, e.message));
        }
      }

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

      // Only classify against sessions active in the last 24 hours to avoid linking
      // new tasks to stale contexts from days ago.
      const SESSION_CLASSIFY_TTL_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const recentSessions = sessionList.filter(s => (now - s.lastAt) < SESSION_CLASSIFY_TTL_MS);

      if (recentSessions.length === 0) {
        return json(res, 200, { sessionId: null, confidence: 'low' });
      }

      try {
        const result = await classifyMessage(message, recentSessions, secrets.ANTHROPIC_API_KEY, secrets.OPENROUTER_API_KEY);
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

    // GET /calltips-session?profile=xxx — latest Call Tips session written by agent
    // Call Tips app polls this to prefill candidate name, resume, job, and interview plan
    if (req.method === 'GET' && url.pathname === '/calltips-session') {
      const profile = url.searchParams.get('profile');
      if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile))
        return json(res, 400, { error: 'invalid profile' });
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const filePath = path.join(dataDir, 'sessions', profile, 'calltips-latest.json');
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return json(res, 200, data);
      } catch {
        return json(res, 404, { error: 'No Call Tips session prepared. Ask the agent: "подготовь план для звонка с [имя]"' });
      }
    }

    // POST /calltips-tips — real-time coaching tip from transcript
    // Body: { profile, transcript:[{speaker:'me'|'them',text}], candidateName, jobText, lang, plan }
    // Returns: { dig, next, why }
    if (req.method === 'POST' && url.pathname === '/calltips-tips') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'bad json' }); }

      const { transcript = [], candidateName = '', jobText = '', lang = 'ru', plan } = body;
      const recent = transcript.slice(-20).map(l =>
        `${l.speaker === 'me' ? 'Я' : 'Они'}: ${l.text}`
      ).join('\n');

      // Build plan context (unasked questions only)
      const askedSet = new Set(body.askedQuestions || []);
      const planCtx = plan?.sections?.flatMap(s =>
        s.questions.map((q, i) => {
          const id = `${s.category}-${i}`;
          const mark = askedSet.has(id) ? '[✓]' : '[ ]';
          return `${mark} ${q.text}`;
        })
      ).join('\n') || '';

      const promptText = `Ты — помощник интервьюера в реальном времени. Слушаешь разговор и даёшь ОДИН острый уточняющий вопрос.

ПРАВИЛО: зацепись за конкретное слово или деталь из последней реплики собеседника. Не оценивай — уточняй.
Пример: собеседник сказал "делал лапароскопию" → "А когда вы выбираете открытую операцию вместо лапароскопии?"
Пример: сказал "работал с PostgreSQL" → "Расскажите о самой сложной проблеме с индексами в PostgreSQL."

Собеседник: ${candidateName || 'собеседник'}
Тема: ${(jobText || '').slice(0, 300) || '(не указана)'}

ПЛАН (незаданные вопросы):
${planCtx || '(без плана)'}

ПОСЛЕДНИЕ РЕПЛИКИ:
${recent || '(пока нет)'}

Верни ТОЛЬКО JSON:
{"next":"Если в плане есть незаданный важный вопрос — задай его. Иначе пустая строка.","dig":"ГЛАВНОЕ: один острый уточняющий вопрос к последней реплике — зацепись за конкретную деталь. Всегда заполняй если есть реплики.","why":"Если ответ размытый — попроси конкретный пример. Иначе пустая строка."}
Язык: ${lang === 'en' ? 'English' : 'русский'}.`;

      const anthropicKey = secrets.ANTHROPIC_API_KEY;
      if (!anthropicKey) return json(res, 503, { error: 'ANTHROPIC_API_KEY not configured' });

      const reqBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: promptText }],
      });

      const tip = await new Promise((resolve, reject) => {
        const hReq = require('https').request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(reqBody),
          },
          timeout: 15000,
        }, (hRes) => {
          let data = '';
          hRes.on('data', c => { data += c; });
          hRes.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.content?.[0]?.text || '{}';
              // strip markdown code fences if present
              const clean = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
              resolve(JSON.parse(clean));
            } catch { resolve({ dig: '', next: '', why: '' }); }
          });
        });
        hReq.on('error', reject);
        hReq.on('timeout', () => { hReq.destroy(); reject(new Error('timeout')); });
        hReq.write(reqBody);
        hReq.end();
      }).catch(() => ({ dig: '', next: '', why: '' }));

      return json(res, 200, tip);
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

    // GET /hh/ats-config?username=X — read current ATS config from context
    if (req.method === 'GET' && url.pathname === '/hh/ats-config') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const username = url.searchParams.get('username') || '';
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const contextBase = username
        ? path.join(dataDir, 'sessions', username, 'contexts')
        : path.join(process.cwd(), 'contexts');
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

    // POST /hh/ats-config — save ATS config + stages to context
    if (req.method === 'POST' && url.pathname === '/hh/ats-config') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const body = JSON.parse(await readBody(req));
      const { config, stages, username } = body || {};
      if (!config || typeof config !== 'object') return json(res, 400, { error: 'config required' });
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const contextBase = username
        ? path.join(dataDir, 'sessions', username, 'contexts')
        : path.join(process.cwd(), 'contexts');
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
      console.log(`[hh/ats-config] saved vacancy="${config.vacancy_title}" stages=${stages?.length || 0} user=${username || 'default'}`);
      return json(res, 200, { ok: true });
    }

    // POST /playwright-fetch — run headless Playwright on this VM and return page content.
    // Used by the ru_browser_fetch MCP skill so GCP sessions can fetch RU-geo-blocked pages.
    if (req.method === 'POST' && url.pathname === '/playwright-fetch') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'bad json' }); }

      const { url: targetUrl, selector, waitFor, script, screenshot } = body || {};
      if (!targetUrl || typeof targetUrl !== 'string') return json(res, 400, { error: 'url required' });

      const { chromium } = require('playwright');
      let browser;
      try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: waitFor || 'domcontentloaded', timeout: 30000 });

        const title = await page.title();
        let text = null, scriptResult = null, screenshotB64 = null;

        if (script) {
          scriptResult = await page.evaluate(script);
        }
        if (screenshot) {
          const buf = await page.screenshot({ type: 'png', fullPage: false });
          screenshotB64 = buf.toString('base64');
        }
        if (selector) {
          const el = await page.$(selector);
          text = el ? await el.innerText() : null;
        } else if (!screenshot) {
          text = await page.innerText('body');
        }

        console.log(`[playwright-fetch] ok url=${targetUrl} title="${title}"`);
        return json(res, 200, { ok: true, url: targetUrl, title, text, scriptResult, screenshot: screenshotB64 });
      } catch (e) {
        console.error('[playwright-fetch] error:', e.message);
        return json(res, 500, { error: 'playwright_failed', message: e.message });
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    }

    // POST /report — create GitHub issue from user bug report / feature request
    if (req.method === 'POST' && url.pathname === '/report') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'bad json' }); }

      const { username, description, sessionId } = body || {};
      if (!username || !description) return json(res, 400, { error: 'username and description required' });

      const ghToken = secrets.GITHUB_BUG_REPORT_TOKEN;
      if (!ghToken) return json(res, 503, { error: 'bug reporting not configured (GITHUB_BUG_REPORT_TOKEN missing)' });

      // Collect session context (last 8 messages)
      let contextLines = [];
      try {
        const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
        const workDir = path.join(dataDir, 'sessions', username);
        if (sessionId) {
          const sessionFile = path.join(workDir, 'sessions', `${sessionId}.json`);
          if (fs.existsSync(sessionFile)) {
            const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            const messages = (session.messages || []).slice(-8);
            contextLines = messages.map(m => {
              const role = m.role === 'user' ? '👤 User' : '🤖 Claude';
              const text = (m.content || '').slice(0, 400);
              return `**${role}:** ${text}${(m.content || '').length > 400 ? '…' : ''}`;
            });
          }
        }
      } catch (e) {
        console.warn('[report] failed to load session context:', e.message);
      }

      const now = new Date().toISOString();
      const contextSection = contextLines.length
        ? `## Session context\n\n${contextLines.join('\n\n')}`
        : '## Session context\n\n_No session context available_';

      const issueBody = `## User report\n\n**User:** \`${username}\`  \n**Time:** ${now}  \n**Session:** \`${sessionId || 'unknown'}\`\n\n${description}\n\n---\n\n${contextSection}`;

      const title = description.length > 80 ? description.slice(0, 77) + '…' : description;

      try {
        const ghRes = await fetch('https://api.github.com/repos/trained-assist/trained-assist-agent/issues', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'trained-assist-agent',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ title, body: issueBody, labels: ['user-report'] }),
          signal: AbortSignal.timeout(15000),
        });
        if (!ghRes.ok) {
          const err = await ghRes.json().catch(() => ({}));
          console.error('[report] GitHub API error:', ghRes.status, err.message);
          return json(res, 502, { error: `GitHub API error: ${err.message || ghRes.statusText}` });
        }
        const issue = await ghRes.json();
        console.log(`[report] Issue created: #${issue.number} by ${username}`);
        return json(res, 200, { number: issue.number, url: issue.html_url });
      } catch (e) {
        console.error('[report] error creating issue:', e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // GET /publish/pages?username=X — list published pages for a user
    if (req.method === 'GET' && url.pathname === '/publish/pages') {
      const username = url.searchParams.get('username') || '';
      if (!username) return json(res, 400, { error: 'username required' });
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const indexFile = path.join(dataDir, 'publish-owners', `${username}.json`);
      const pages = fs.existsSync(indexFile)
        ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
        : [];
      return json(res, 200, { pages });
    }

    // DELETE /publish/pages — delete a page by slug
    if (req.method === 'DELETE' && url.pathname === '/publish/pages') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, slug } = body || {};
      if (!username || !slug) return json(res, 400, { error: 'username and slug required' });

      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const metaFile = path.join(dataDir, 'pages', slug, 'meta.json');
      if (!fs.existsSync(metaFile)) return json(res, 404, { error: 'page not found' });
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta.owner !== username) return json(res, 403, { error: 'not your page' });

      fs.rmSync(path.join(dataDir, 'pages', slug), { recursive: true, force: true });

      const indexFile = path.join(dataDir, 'publish-owners', `${username}.json`);
      if (fs.existsSync(indexFile)) {
        const list = JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter(p => p.slug !== slug);
        fs.writeFileSync(indexFile, JSON.stringify(list));
      }
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
  scheduleHhBackgroundScoring();
  resumePendingTasks(secrets).catch(err => console.error('[resume] startup error:', err.message));

  // Deploys restart this service frequently (every few minutes during an
  // active PR streak) — without draining, each restart silently kills
  // whatever Claude Code task is mid-flight for a real user. Give active
  // tasks real time to finish and deliver their Telegram reply before
  // exiting; only tasks still running past DRAIN_TIMEOUT_MS fall back to
  // resumePendingTasks() on the next startup. Keep this comfortably under
  // systemd's TimeoutStopSec (set to 120s in the unit files) so systemd
  // doesn't SIGKILL us mid-drain.
  const DRAIN_TIMEOUT_MS = 90_000;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(); // stop accepting new HTTP connections; existing tasks keep running
    const active = getActiveTaskCount();
    if (active > 0) {
      console.log(`[shutdown] draining ${active} active task(s), up to ${DRAIN_TIMEOUT_MS / 1000}s...`);
      const drained = await waitForIdle(DRAIN_TIMEOUT_MS);
      console.log(drained ? '[shutdown] all tasks drained' : '[shutdown] drain timeout — remaining tasks will resume on next startup');
    }
    // Close any open Playwright browsers so Node exits cleanly
    try { require('./nalog-login').closeAll(); } catch {}
    process.exit(0);
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

function readBodyBuffer(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function indexOfSeq(buf, seq) {
  for (let i = 0; i <= buf.length - seq.length; i++) {
    if (buf.slice(i, i + seq.length).equals(seq)) return i;
  }
  return -1;
}

function splitBuffer(buf, sep) {
  const parts = [];
  let start = 0;
  let pos;
  while ((pos = indexOfSeq(buf.slice(start), sep)) !== -1) {
    parts.push(buf.slice(start, start + pos));
    start += pos + sep.length;
  }
  parts.push(buf.slice(start));
  return parts.filter(p => p.length > 0);
}

// ── HH review page ────────────────────────────────────────────────────────────

function generateReviewPageHtml(negotiations, vacancyTitle, username, callbackBase, dataDir, opts = {}) {
  const { syncedAt, vacancyId } = opts;
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
      for (const job of r.experience) {
        const start = job.start?.slice(0, 7) || '';
        const end = job.end?.slice(0, 7) || 'н.в.';
        lines.push(`- ${job.company || ''} (${start}–${end}): ${job.position || ''}`);
        if (job.description) lines.push(`  ${job.description}`);
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
      neg_state: neg._state || 'response',
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
      already_sent: (history.messages || []).some(m => m.role === 'employer'),
      alternate_url: r.alternate_url || null,
    };
  });

  function sortCandidates(list) {
    return [...list].sort((a, b) => {
      if (a.score != null && b.score != null) return (b.score || 0) - (a.score || 0);
      if (a.score != null) return -1;
      if (b.score != null) return 1;
      return 0;
    });
  }

  const sorted = sortCandidates(candidates);
  const waitingCandidates = sortCandidates(candidates.filter(c => c.neg_state === 'response' && c.verdict !== 'ОТКЛОНИТЬ'));

  const colorMap = { 'ПРОПУСТИТЬ': '#16a34a', 'УТОЧНИТЬ': '#d97706', 'ОТКЛОНИТЬ': '#dc2626' };
  const bgMap = { 'ПРОПУСТИТЬ': '#f0fdf4', 'УТОЧНИТЬ': '#fffbeb', 'ОТКЛОНИТЬ': '#fef2f2' };
  const actionable = sorted.filter(c => c.verdict && c.verdict !== 'ОТКЛОНИТЬ').length;
  const agentSecret = process.env.AGENT_SECRET || '';
  const { createHmac } = require('crypto');
  const pageToken = agentSecret ? createHmac('sha256', agentSecret).update(String(username)).digest('hex').slice(0, 16) : '';

  const ageMin = syncedAt ? Math.round((Date.now() - syncedAt) / 60000) : null;
  const ageText = ageMin === null ? '' : ageMin === 0 ? 'только что' : `${ageMin} мин назад`;

  function buildCardsHtml(list, idxOffset) {
    return list.map((c, localIdx) => {
      const i = idxOffset + localIdx;
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

    const nameHtml = c.alternate_url
      ? `<a href="${esc(c.alternate_url)}" target="_blank" rel="noopener" class="resume-link">${esc(c.name)}</a>`
      : esc(c.name);

    const hasDraft = !!c.draft_message;
    const msgLabel = c.already_sent ? 'Follow-up (уже писали)' : hasDraft ? 'Черновик сообщения' : 'Сообщение';
    const msgSection = isReject
      ? `<div class="msg-section">
           <div class="msg-label-row">
             <label class="msg-label" style="color:#dc2626">Сообщение об отказе</label>
             <button class="btn btn-gen" id="gen-${i}" onclick="generateRejection(${i},'${esc(c.negotiation_id)}','${esc(c.name)}')" title="Сгенерировать отказное сообщение">✦ Сгенерировать отказ</button>
           </div>
           <textarea class="msg-area" id="msg-${i}" rows="4">${hasDraft ? esc(c.draft_message) : ''}</textarea>
           <div class="btns">
             <button class="btn btn-send-reject" onclick="sendAndRejectOne(${i},'${esc(c.negotiation_id)}')">✗ Отправить отказ</button>
             <button class="btn btn-skip" onclick="skipOne(${i})">Пропустить</button>
           </div>
         </div>`
      : `<div class="msg-section">
           <div class="msg-label-row">
             <label class="msg-label">${msgLabel}</label>
             <button class="btn btn-gen" id="gen-${i}" onclick="generateOne(${i},'${esc(c.negotiation_id)}','${esc(c.name)}',${!!c.already_sent})" title="Сгенерировать черновик">✦ Сгенерировать</button>
           </div>
           <textarea class="msg-area" id="msg-${i}" rows="5">${hasDraft ? esc(c.draft_message) : ''}</textarea>
           <div class="btns">
             <button class="btn btn-send" onclick="sendOne(${i},'${esc(c.negotiation_id)}')">✓ Отправить</button>
             <button class="btn btn-skip" onclick="skipOne(${i})">✗ Пропустить</button>
           </div>
         </div>`;

    return `<div class="card" id="card-${i}" data-score="${hasScore ? (c.score || 0).toFixed(1) : '0'}" data-neg="${esc(c.negotiation_id)}" style="background:${bg};border-left:4px solid ${col}">
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
    });
  }

  const waitingCardsHtml = buildCardsHtml(waitingCandidates, 0);
  const allCardsHtml = buildCardsHtml(sorted, 10000);

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
.msg-label-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.msg-label{font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em}
.btn-gen{font-size:11px;padding:3px 8px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;color:#475569;font-weight:500}
.btn-gen:hover:not(:disabled){background:#e2e8f0}
.btn-gen:disabled{opacity:.5;cursor:not-allowed}
.msg-area.generating{background:repeating-linear-gradient(90deg,#f1f5f9 0%,#e2e8f0 50%,#f1f5f9 100%);background-size:200% 100%;animation:shimmer 1.4s infinite linear;opacity:.7}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.msg-area{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:14px;line-height:1.5;font-family:inherit;resize:vertical;min-height:80px}
.msg-area:focus{outline:none;border-color:#6366f1}
.btns{display:flex;gap:8px;margin-top:8px}
.btn{padding:8px 18px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-send{background:#16a34a;color:#fff}
.btn-send-reject{background:#dc2626;color:#fff}
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
.tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:2px solid #e2e8f0;padding-bottom:0}
.tab-btn{padding:8px 18px;border:none;border-radius:8px 8px 0 0;font-size:14px;font-weight:600;cursor:pointer;background:#f1f5f9;color:#64748b;transition:background .15s,color .15s;border-bottom:2px solid transparent;margin-bottom:-2px}
.tab-btn.active{background:#fff;color:#4f46e5;border-bottom:2px solid #4f46e5}
.tab-badge{display:inline-block;background:#e2e8f0;color:#475569;font-size:12px;font-weight:700;padding:1px 7px;border-radius:99px;margin-left:6px}
.tab-btn.active .tab-badge{background:#ede9fe;color:#4f46e5}
@media(max-width:640px){
body{padding:12px 12px 100px}
h1{font-size:18px}
.card{padding:14px}
.card-header{flex-direction:column;gap:8px}
.score-wrap{flex-direction:row;align-self:flex-start}
.footer{padding:10px 12px;flex-wrap:wrap;gap:8px}
.counter{width:100%;font-size:13px}
.btn-reject-all,.btn-send-all{flex:1;padding:10px 12px;font-size:13px}
.btns{flex-wrap:wrap}
.btn{flex:1;min-width:120px;text-align:center}
.toolbar{gap:5px}
.tb-btn{padding:5px 8px;font-size:12px}
.msg-area{font-size:13px}
.tabs{gap:2px}
.tab-btn{padding:7px 12px;font-size:13px}
}
.sync-btn{background:none;border:none;color:#6366f1;font-size:13px;cursor:pointer;font-weight:500;padding:0;text-decoration:underline;text-underline-offset:2px}
.sync-btn:hover{opacity:.75}
.sync-btn:disabled{opacity:.5;cursor:not-allowed;text-decoration:none}
</style>
</head>
<body>
<h1>Кандидаты: ${esc(vacancyTitle)}</h1>
<p class="subtitle">${sorted.length} откликов${actionable ? ' · ' + actionable + ' требуют сообщения' : ''}${ageText ? ` · обновлено ${ageText}` : ''} · <button class="sync-btn" id="syncBtn" onclick="syncNow()">↻ Обновить</button></p>
<div class="tabs">
  <button class="tab-btn active" id="tab-waiting" onclick="switchTab('waiting')">Ждут ответа <span class="tab-badge" id="badge-waiting">${waitingCandidates.length}</span></button>
  <button class="tab-btn" id="tab-all" onclick="switchTab('all')">Все диалоги <span class="tab-badge" id="badge-all">${sorted.length}</span></button>
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
<div id="tab-waiting-container">
  ${waitingCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Нет кандидатов, ожидающих ответа.</p>' : waitingCardsHtml.join('')}
</div>
<div id="tab-all-container" style="display:none">
  ${allCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Откликов нет.</p>' : ''}
  <div id="cards-container"></div>
  <div id="sentinel" style="height:1px;margin-bottom:80px"></div>
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
const HH_VACANCY_ID = '${esc(String(vacancyId || ''))}';
const done = new Set();
let activeTab = 'waiting';

const CARDS_HTML_ALL = ${JSON.stringify(allCardsHtml)};
const LAZY_BATCH = 50;
let rendered = 0;

function renderBatch(count) {
  const container = document.getElementById('cards-container');
  const end = Math.min(rendered + (count || LAZY_BATCH), CARDS_HTML_ALL.length);
  const frag = document.createDocumentFragment();
  for (let j = rendered; j < end; j++) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = CARDS_HTML_ALL[j];
    frag.appendChild(wrapper.firstElementChild);
  }
  container.appendChild(frag);
  rendered = end;
  onCheck();
  if (rendered >= CARDS_HTML_ALL.length) lazyObserver.disconnect();
  setTimeout(autoGenerate, 0);
}

const lazyObserver = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && rendered < CARDS_HTML_ALL.length) renderBatch(LAZY_BATCH);
}, { rootMargin: '1500px' });
lazyObserver.observe(document.getElementById('sentinel'));

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-waiting-container').style.display = tab === 'waiting' ? '' : 'none';
  document.getElementById('tab-all-container').style.display = tab === 'all' ? '' : 'none';
  document.getElementById('tab-waiting').classList.toggle('active', tab === 'waiting');
  document.getElementById('tab-all').classList.toggle('active', tab === 'all');
  if (tab === 'all' && rendered === 0) renderBatch(50);
  onCheck();
}

async function syncNow() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true; btn.textContent = '↻ Обновляю…';
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/sync-negotiations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HH_USER, vacancy_id: HH_VACANCY_ID }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    location.reload();
  } catch(e) {
    showToast('❌ Ошибка обновления: ' + e.message, true);
    btn.disabled = false; btn.textContent = '↻ Обновить';
  }
}

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

async function generateOne(i, negId, candidateName, alreadySent) {
  const btn = document.getElementById('gen-'+i);
  const ta = document.getElementById('msg-'+i);
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  if (ta) { ta.classList.add('generating'); ta.placeholder = '⏳ Генерирую...'; }
  try {
    const resumeEl = document.querySelector('#card-'+i+' pre.resume-text');
    const resumeText = resumeEl?.textContent || '';
    const data = await hhAction('/hh/generate-message', {
      negotiation_id: negId,
      candidate_name: candidateName,
      resume_text: resumeText,
      already_sent: alreadySent,
    });
    if (ta) { ta.value = data.message || ''; ta.classList.remove('generating'); ta.placeholder = ''; }
    if (btn) { btn.disabled = false; btn.textContent = '✦ Переписать'; }
  } catch(e) {
    if (ta) { ta.classList.remove('generating'); ta.placeholder = ''; }
    if (btn) { btn.disabled = false; btn.textContent = '✦ Сгенерировать'; }
  }
}

async function generateRejection(i, negId, candidateName) {
  const btn = document.getElementById('gen-'+i);
  const ta = document.getElementById('msg-'+i);
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  if (ta) { ta.classList.add('generating'); ta.placeholder = '⏳ Генерирую...'; }
  try {
    const data = await hhAction('/hh/generate-message', {
      negotiation_id: negId,
      candidate_name: candidateName,
      message_type: 'rejection',
    });
    if (ta) { ta.value = data.message || ''; ta.classList.remove('generating'); ta.placeholder = ''; }
    if (btn) { btn.disabled = false; btn.textContent = '✦ Переписать отказ'; }
  } catch(e) {
    if (ta) { ta.classList.remove('generating'); ta.placeholder = ''; }
    if (btn) { btn.disabled = false; btn.textContent = '✦ Сгенерировать отказ'; }
    showToast('❌ ' + e.message, true);
  }
}

async function sendAndRejectOne(i, negId) {
  const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
  if (!msg) { showToast('Напишите или сгенерируйте сообщение', true); return; }
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  try {
    await hhAction('/hh/send-and-reject', { negotiation_id: negId, message: msg });
    markDone(i); onCheck(); showToast('✅ Отказ отправлен');
  } catch(e) {
    showToast('❌ ' + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '✗ Отправить отказ'; }
  }
}

async function autoGenerate() {
  const allGenBtns = [...document.querySelectorAll('[id^="gen-"]')];
  const emptyBtns = allGenBtns.filter(btn => {
    const i = btn.id.replace('gen-', '');
    const ta = document.getElementById('msg-'+i);
    return ta && !ta.value.trim();
  });
  if (emptyBtns.length === 0) return;
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < emptyBtns.length) {
      const btn = emptyBtns[idx++];
      btn.click();
      await new Promise(r => setTimeout(r, 50));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, emptyBtns.length) }, worker));
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

const HH_API_TIMEOUT_MS = 15_000;

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
        'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
        'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    if (u.port) reqOpts.port = parseInt(u.port, 10);
    const req = lib.request(reqOpts, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (r.statusCode === 204 || !data) return resolve({});
        if (r.statusCode >= 400) return reject(new Error(`HH ${r.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.setTimeout(HH_API_TIMEOUT_MS, () => {
      req.destroy(new Error(`HH API timeout after ${HH_API_TIMEOUT_MS / 1000}s: ${method} ${apiPath}`));
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

// ── Instant-publish helpers ───────────────────────────────────────────────────

function publishPasswordForm(slug, error) {
  return `<!DOCTYPE html><html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Требуется пароль</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb}
  .box{background:#fff;padding:32px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);text-align:center;max-width:360px;width:100%}
  h2{margin:0 0 16px;font-size:18px;color:#1a1a2e}
  input{width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:12px;box-sizing:border-box}
  button{width:100%;padding:10px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}
  button:hover{background:#1d4ed8}
  .err{color:#dc2626;font-size:14px;margin-bottom:12px}
</style></head><body>
<div class="box">
  <h2>Страница защищена паролем</h2>
  ${error ? `<div class="err">${error}</div>` : ''}
  <form onsubmit="location.href='?password='+encodeURIComponent(document.getElementById('pw').value);return false">
    <input id="pw" type="password" placeholder="Введите пароль" autofocus>
    <button type="submit">Открыть</button>
  </form>
</div></body></html>`;
}



// ── Misha bot ─────────────────────────────────────────────────────────────────
// Direct Telegram webhook for @cmr_management_bot.
// Handles text, voice (Deepgram transcription), photos, /new_deal command.

async function processMishaUpdate(update, botToken, secrets) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const username = 'misha';
  const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

  async function tgSend(text) {
    return fetch(`${tgBase}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    }).then(r => r.json()).catch(() => null);
  }

  async function tgAction(action = 'typing') {
    return fetch(`${tgBase}/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
  }

  async function tgGetFile(fileId) {
    const r = await fetch(`${tgBase}/bot${botToken}/getFile?file_id=${fileId}`,
      { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    return d.result?.file_path || null;
  }

  async function downloadTgFile(filePath, dest) {
    const url = `${tgBase}/file/bot${botToken}/${filePath}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`TG file download ${r.status}`);
    const buf = await r.arrayBuffer();
    fs.writeFileSync(dest, Buffer.from(buf), { mode: 0o600 });
    return dest;
  }

  async function deepgramTranscribe(audioPath) {
    if (!secrets.DEEPGRAM_API_KEY) return null;
    try {
      const audio = fs.readFileSync(audioPath);
      const r = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${secrets.DEEPGRAM_API_KEY}`,
            'Content-Type': 'audio/ogg',
          },
          body: audio,
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!r.ok) return null;
      const d = await r.json();
      return d.results?.channels?.[0]?.alternatives?.[0]?.transcript || null;
    } catch { return null; }
  }

  const workDir = path.join(BASE_USERS_DIR, username);
  fs.mkdirSync(workDir, { recursive: true });
  const uploadsDir = path.join(workDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const text = msg.text || msg.caption || '';
  const cmd = text.split(/\s+/)[0]?.toLowerCase();

  let taskParts = [];
  let forceNewSession = false;

  // /start — check for exhibition deep link parameter
  if (cmd === '/start') {
    const startParam = text.split(/\s+/)[1]; // e.g. "huntingexpo2026_deal_7603045501"
    if (startParam && startParam.includes('_deal_')) {
      const delimIdx = startParam.indexOf('_deal_');
      const eventKey = startParam.slice(0, delimIdx);
      const companyId = startParam.slice(delimIdx + 6);
      const isInn = /^\d{10,12}$/.test(companyId);
      forceNewSession = true;
      taskParts.push(`КОМАНДА: Выставочная сделка (deep link)
Выставка (eventKey): ${eventKey}
${isInn ? `ИНН компании: ${companyId}` : `ID/стенд компании: ${companyId}`}

Пользователь нажал "✈ Создать сделку" на выставочном сайте.

ВАЖНО: НЕ создавай сделку сразу! Сначала:
1. ${isInn ? `Найди компанию по ИНН ${companyId} через MCP tools.` : `Определи компанию по стенду "${companyId}" выставки "${eventKey}".`}
2. Покажи пользователю что нашёл: название компании, город, основную инфу.
3. Спроси: "Есть ли ещё информация? Визитка контакта, голосовое, имя менеджера?"
4. Подожди ответа пользователя. Когда скажет "Готово" или "Создавай" — тогда создай сделку в WEEEK с типом "3 Выставки" и источником на основе eventKey "${eventKey}".`);
    } else {
      await tgSend('Привет! Создаю сделки в WEEEK.\n\n/new_deal — новая сделка\n\nОтправь текст, визитку или голосовое.');
      return;
    }
  }

  // /help — Misha-specific help
  if (cmd === '/help') {
    await tgSend([
      '🤖 Команды:',
      '',
      '/new_deal — создать новую сделку',
      '   Отправь визитку, голосовое, текст — всё в одном потоке',
      '',
      '/sessions — мои диалоги',
      '/usage — расход токенов',
      '/secrets_list — подключённые сервисы',
      '/secrets_log — история обращений к данным',
      '/target_company_prompt — шаблон целевой компании',
      '/company_showcase_spec — спецификация карточки компании',
      '',
      'Или просто напиши что нужно сделать.',
    ].join('\n'));
    return;
  }

  // /target_company_prompt — Flexi target company classification rules
  if (cmd === '/target_company_prompt') {
    // Priority: new path > backward compat old path > flexi-consult shared > hardcoded
    const paths = [
      path.join(workDir, 'contexts', 'prompts', 'target_company_prompt.txt'),
      path.join(workDir, 'contexts', 'target_company_prompt.txt'),
      path.join(BASE_USERS_DIR, 'flexi-consult', 'site-requirements-target.md'),
    ];
    let promptText = paths.reduce((acc, p) => acc || (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null), null);
    if (!promptText) {
      promptText = '⚡️ Flexi target rule:\nЦЕЛЕВАЯ (t:1): российский ПРОИЗВОДИТЕЛЬ И выручка 150млн–1млрд (любая прибыль) ИЛИ 1–5млрд при прибыли ≤100млн.\nПОЧТИ-ЦЕЛЕВАЯ (nt:1): производитель РФ, но выручка неизвестна / <150 / >5 млрд.';
    }
    await tgSend(promptText);
    return;
  }

  // /company_showcase_spec — how to display/present company cards
  if (cmd === '/company_showcase_spec') {
    const paths = [
      path.join(workDir, 'contexts', 'prompts', 'company_showcase_spec.txt'),
      path.join(workDir, 'contexts', 'company_showcase_spec.txt'),
      path.join(BASE_USERS_DIR, 'flexi-consult', 'site-requirements-display.md'),
    ];
    let specText = paths.reduce((acc, p) => acc || (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null), null);
    if (!specText) {
      specText = '🏢 Карточка компании: название, город, выручка, прибыль, директор, сайт, ИНН. Пропускать пустые поля.';
    }
    await tgSend(specText);
    return;
  }

  // /new_deal — clear session and start deal creation
  if (cmd === '/new_deal') {
    forceNewSession = true;
    taskParts.push('КОМАНДА: /new_deal\nНачни создание новой сделки. Попроси Мишу прислать всю информацию: визитку (фото), голосовое, текст с деталями компании. Скажи что он может присылать всё сразу, когда закончит — написать "Готово".');
  }

  // Voice message — transcribe with Deepgram
  if (msg.voice || msg.audio) {
    const fileId = (msg.voice || msg.audio).file_id;
    await tgAction('typing');
    try {
      const tgFilePath = await tgGetFile(fileId);
      if (tgFilePath) {
        const ext = tgFilePath.split('.').pop() || 'ogg';
        const localPath = path.join(uploadsDir, `voice_${Date.now()}.${ext}`);
        await downloadTgFile(tgFilePath, localPath);
        const transcript = await deepgramTranscribe(localPath);
        if (transcript) {
          taskParts.push(`[Голосовое сообщение]\n${transcript}`);
        } else {
          taskParts.push(`[Голосовое сообщение сохранено: ${localPath}]`);
        }
      }
    } catch (e) {
      console.error('[misha] voice download error:', e.message);
      taskParts.push('[Голосовое сообщение — ошибка скачивания]');
    }
  }

  // Photos — download highest resolution
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    await tgAction('upload_photo');
    try {
      const tgFilePath = await tgGetFile(photo.file_id);
      if (tgFilePath) {
        const ext = tgFilePath.split('.').pop() || 'jpg';
        const localPath = path.join(uploadsDir, `photo_${Date.now()}.${ext}`);
        await downloadTgFile(tgFilePath, localPath);
        taskParts.push(`[Фото сохранено: ${localPath}]`);
        if (text) taskParts.push(`Подпись: ${text}`);
      }
    } catch (e) {
      console.error('[misha] photo download error:', e.message);
    }
  }

  // Document
  if (msg.document) {
    try {
      const tgFilePath = await tgGetFile(msg.document.file_id);
      if (tgFilePath) {
        const fname = msg.document.file_name || `doc_${Date.now()}`;
        const localPath = path.join(uploadsDir, fname.replace(/[^a-zA-Z0-9._-]/g, '_'));
        await downloadTgFile(tgFilePath, localPath);
        taskParts.push(`[Документ сохранён: ${localPath}]`);
      }
    } catch (e) {
      console.error('[misha] document download error:', e.message);
    }
  }

  // Plain text
  if (text && cmd !== '/new_deal' && !msg.photo) {
    taskParts.push(text);
  }

  if (taskParts.length === 0) {
    await tgSend('Не понял формат. Попробуй /new_deal или отправь текст, голосовое или фото визитки.');
    return;
  }

  const task = taskParts.join('\n\n');
  const taskId = `misha-${Date.now()}`;

  const sentMsg = await tgSend('⏳ Думаю…');
  const initialMsgId = sentMsg?.result?.message_id || null;

  const user = {
    id: Number(chatId),
    name: username,
    username,
    workDir,
    cwd: workDir,
    telegramUserId: msg.from?.id || null,
  };
  const mishaSecrets = { ...secrets, BOT_TOKEN: botToken };

  const { runTask } = require('./runner');
  runTask({
    taskId,
    user,
    task,
    sessionId: forceNewSession ? `misha-deal-${Date.now()}` : null,
    forceClaude: false,
    initialMsgId,
    pinnedMsgId: null,
    secrets: mishaSecrets,
  }).catch(e => console.error(`[misha/${taskId}] runTask error:`, e.message));
}
