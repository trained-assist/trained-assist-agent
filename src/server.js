const http = require('http');
const fs = require('fs');
const os = require('os');
const { execSync, execFile, spawn } = require('child_process');
const path = require('path');
const { loadSecrets } = require('./secrets');
const { runTask } = require('./runner');
const { listSessions, getSession: getSessionData } = require('./session-store');
const { startNalogLogin, confirmNalogCode } = require('./nalog-login');
const { startGetcourseLogin, mergeConfig: mergeGetcourseConfig } = require('./getcourse-login');
const { nalogFormHtml } = require('./connect-forms/nalog');
const { getcourseFormHtml } = require('./connect-forms/getcourse');
const { gdriveFormHtml, gdriveSuccessHtml, gdriveErrorHtml } = require('./connect-forms/gdrive');

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

async function main() {
  const secrets = await loadSecrets();

  const GDRIVE_CLIENT_ID     = secrets.GOOGLE_OAUTH_CLIENT_ID;
  const GDRIVE_CLIENT_SECRET = secrets.GOOGLE_OAUTH_CLIENT_SECRET;
  const GDRIVE_REDIRECT_URI  = `${(process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '')}/connect/gdrive/callback`;

  const server = http.createServer(async (req, res) => {
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
      if (result.userId) tgNotifyNalog(secrets.TELEGRAM_BOT_TOKEN, result.userId, result.expires);
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
        fs.unlinkSync(pendingFile);
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
      fs.unlinkSync(pendingFile);
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

      // Notify user in Telegram
      const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
      fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: userId,
          text: `✅ Google Drive подключён!${email ? ` (${email})` : ''}\n\nТеперь расшари нужные папки/файлы с ассистентом — он попросит тебя об этом когда нужно. Управление доступами: /secrets_list`,
        }),
      }).catch(e => console.error('[gdrive/callback] tg notify failed:', e.message));

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveSuccessHtml(email));
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
          if (pending.expires < Date.now()) { fs.unlinkSync(pendingFile); res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
          if (pending.service !== 'nalog') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
          if (!/^-?\d{1,20}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

          fs.unlinkSync(pendingFile); // one-time use

          // Browser login may take 30–60s; form sets fetch timeout to 90s
          const result = await startNalogLogin(pending.uid, login, password);

          if (result.error) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: result.error }));
            return;
          }

          if (result.status === 'ok') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', expires: result.expires }));
            tgNotifyNalog(secrets.TELEGRAM_BOT_TOKEN, pending.uid, result.expires);
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
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(getcourseFormHtml(t));
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
          if (pending.expires < Date.now()) { fs.unlinkSync(pendingFile); res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
          if (pending.service !== 'getcourse') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
          if (!/^-?\d{1,20}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

          fs.unlinkSync(pendingFile); // one-time use

          const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
          const patch = { accountDomain: cleanDomain };
          if (apiKey) patch.apiKey = apiKey.trim();
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
          tgNotifyGetcourse(secrets.TELEGRAM_BOT_TOKEN, pending.uid, cleanDomain, level, cookiesCount);
          return;
        }

        res.writeHead(405).end(); return;
      }

      const SERVICE_META = {
        github: { name: 'GitHub', placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx', hint: 'github.com/settings/tokens → Generate new token (classic) → scopes: <b>repo</b>, <b>read:org</b>' },
        weeek:  { name: 'Weeek CRM', placeholder: 'Вставьте API токен', hint: 'Weeek → Settings → Integrations → API → Generate token' },
      };
      const meta = SERVICE_META[service];
      if (!meta) { res.writeHead(404).end('Unknown service'); return; }

      if (req.method === 'GET') {
        const t = url.searchParams.get('t') || '';
        const html = connectFormHtml(service, meta, t);
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
        if (pending.expires < Date.now()) { fs.unlinkSync(pendingFile); res.writeHead(403).end(JSON.stringify({ error: 'link expired' })); return; }
        if (pending.service !== service) { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }

        if (!/^-?\d{1,20}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid in token' })); return; }
        const tokensDir = path.join(os.homedir(), 'agent-tokens', pending.uid);
        fs.mkdirSync(tokensDir, { recursive: true });
        fs.writeFileSync(path.join(tokensDir, service), String(value).trim(), { mode: 0o600 });
        fs.unlinkSync(pendingFile); // one-time use
        console.log(`[connect] saved ${service} token for uid=${pending.uid}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));

        // Notify user in Telegram (fire-and-forget)
        const SERVICE_NAMES = { github: 'GitHub', weeek: 'Weeek CRM' };
        const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
        fetch(`${tgBase}/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: pending.uid,
            text: `✅ ${SERVICE_NAMES[service] || service} подключён! Данные для входа сохранены в изолированном хранилище — в чат не попадают.\n\nУправление доступами: /secrets_list`,
          }),
        }).catch(e => console.error('[connect] tg notify failed:', e.message));
        return;
      }

      res.writeHead(405).end(); return;
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
      if (!userId || !/^-?\d{1,20}$/.test(userId)) return json(res, 400, { error: 'invalid userId' });
      const tokensDir = path.join(os.homedir(), 'agent-tokens', userId);
      const SKIP = new Set(['.secrets_log']);
      let capabilities = [];
      if (fs.existsSync(tokensDir)) {
        capabilities = fs.readdirSync(tokensDir).filter(f => !SKIP.has(f) && !f.startsWith('.'));
      }
      return json(res, 200, { capabilities });
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

      const { userId, username, task, context, sessionId, contextFromSession } = payload;
      if (!userId || !username || !task) return json(res, 400, { error: 'missing fields' });
      if (!/^-?\d{1,20}$/.test(String(userId))) {
        console.log('[/run] 400 invalid userId:', userId);
        return json(res, 400, { error: 'invalid userId' });
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
      const user = { id: userId, name: username, username, workDir };

      // Accept request immediately, run task in background
      const taskId = `${username}-${Date.now()}`;
      json(res, 202, { taskId });

      // Fire-and-forget
      runTask({ taskId, user, task, context, sessionId: sessionId || null, contextFromSession: contextFromSession || null, secrets }).catch(err =>
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
      if (!/^-?\d{1,20}$/.test(String(userId))) return json(res, 400, { error: 'invalid userId' });
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

    json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, () => console.log(`assist-agent listening on :${PORT}`));

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

