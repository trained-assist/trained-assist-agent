const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeMcpConfig } = require('./browser');
const sessions = require('./session-store');
const { recordUsage } = require('./usage-store');

const STREAM_INTERVAL_MS = 3000;
const MAX_MSG_LEN = 3500;

const CONNECT_PENDING_DIR = path.join(os.homedir(), 'connect-pending');
const AGENT_PUBLIC_URL = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '');

function generateConnectLink(userId, service) {
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(CONNECT_PENDING_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CONNECT_PENDING_DIR, `${token}.json`),
    JSON.stringify({ uid: String(userId), service, expires: Date.now() + 30 * 60 * 1000 })
  );
  // Clean up expired tokens
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(CONNECT_PENDING_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CONNECT_PENDING_DIR, f), 'utf8'));
        if (d.expires < now) fs.unlinkSync(path.join(CONNECT_PENDING_DIR, f));
      } catch {}
    }
  } catch {}
  return `${AGENT_PUBLIC_URL}/connect/${service}?t=${token}`;
}


// Files in agent-tokens dir that are not service credentials
const LOG_FILES = new Set(['.secrets_log']);

function loadUserTokens(userId) {
  const tokensDir = path.join(os.homedir(), 'agent-tokens', String(userId));
  const extra = {};
  if (!fs.existsSync(tokensDir)) return extra;
  const accessed = [];
  for (const file of fs.readdirSync(tokensDir)) {
    if (LOG_FILES.has(file)) continue;
    const val = fs.readFileSync(path.join(tokensDir, file), 'utf8').trim();
    const label = file.toLowerCase();
    accessed.push(label);
    if (label === 'github') { extra.GH_TOKEN = val; extra.GITHUB_TOKEN = val; }
    else if (label === 'figma') extra.FIGMA_TOKEN = val;
    else if (label === 'notion') extra.NOTION_TOKEN = val;
    else if (label === 'linear') extra.LINEAR_API_KEY = val;
    else if (label === 'weeek') extra.WEEEK_API_TOKEN = val;
    else if (label === 'dadata') extra.DADATA_API_TOKEN = val;
    else if (label === 'gdrive') extra.GDRIVE_SA_JSON = val;
    else if (label === 'nalog') {
      try {
        const parsed = JSON.parse(val);
        if (parsed.auth_token)    extra.NALOG_TOKEN         = parsed.auth_token;
        if (parsed.refresh_token) extra.NALOG_REFRESH_TOKEN  = parsed.refresh_token;
        if (parsed.expires)       extra.NALOG_TOKEN_EXPIRES  = parsed.expires;
        if (parsed.device_id)     extra.NALOG_DEVICE_ID      = parsed.device_id;
      } catch { extra.NALOG_TOKEN = val; }
    }
    else extra[label.toUpperCase().replace(/[^A-Z0-9]/g, '_')] = val;
  }
  if (accessed.length > 0) appendSecretsLog(userId, accessed);
  return extra;
}

// Append one line to .secrets_log: ISO timestamp + TAB + services
function appendSecretsLog(userId, services) {
  try {
    const logPath = path.join(os.homedir(), 'agent-tokens', String(userId), '.secrets_log');
    const line = `${new Date().toISOString()}\t${services.join(',')}\n`;
    fs.appendFileSync(logPath, line, { mode: 0o600 });
  } catch { /* non-critical */ }
}

// ── Service metadata for secrets_list / revoke ─────────────────────────────
const SERVICE_DISPLAY = {
  github:         'GitHub',
  weeek:          'Weeek CRM',
  nalog:          'Налог.ру (НПД)',
  figma:          'Figma',
  notion:         'Notion',
  linear:         'Linear',
  tilda:          'Tilda',
  'tilda-session': 'Tilda (сессия)',
  dadata:         'DaData',
  gdrive:         'Google Drive',
};

function listConnectedServices(userId) {
  const tokensDir = path.join(os.homedir(), 'agent-tokens', String(userId));
  if (!fs.existsSync(tokensDir)) return null;
  const files = fs.readdirSync(tokensDir).filter(f => !LOG_FILES.has(f));
  if (files.length === 0) return null;
  return files.map(f => {
    const name = SERVICE_DISPLAY[f.toLowerCase()] || f;
    const mtime = fs.statSync(path.join(tokensDir, f)).mtime;
    return { file: f, name, mtime };
  });
}

function revokeService(userId, serviceName) {
  const tokensDir = path.join(os.homedir(), 'agent-tokens', String(userId));
  const ALIASES = {
    github: 'github', гитхаб: 'github',
    weeek: 'weeek', вик: 'weeek',
    nalog: 'nalog', налог: 'nalog', нпд: 'nalog', самозан: 'nalog',
    figma: 'figma', фигма: 'figma',
    notion: 'notion',
    linear: 'linear',
    tilda: 'tilda', тильда: 'tilda',
    gdrive: 'gdrive', гугл: 'gdrive', google: 'gdrive',
    dadata: 'dadata',
  };
  const key = ALIASES[serviceName.toLowerCase().replace(/[^a-zа-яё]/gi, '')];
  if (!key) return null; // unknown service

  const filePath = path.join(tokensDir, key);
  if (!fs.existsSync(filePath)) return 'not_found';
  fs.unlinkSync(filePath);
  appendSecretsLog(userId, [`revoke:${key}`]);
  return key;
}

function getSecretsLog(userId) {
  const logPath = path.join(os.homedir(), 'agent-tokens', String(userId), '.secrets_log');
  if (!fs.existsSync(logPath)) return null;
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-20).reverse(); // last 20, newest first
}

// ── Quick answers — bypass Claude for known setup/secrets patterns ───────────
// Returns a string if the task matches, null otherwise.

const SETUP_INTENT = /подключ|connect|настро|интегр|привяз|как.*добав|могу.*отправ|зайт|авториз|setup|подрубить/i;
const INN_CAPABILITY_INTENT = /(?:скил|skill|умееш|можешь|есть.{0,30}возможн|есть.{0,30}функц|есть.{0,30}инструм|что.{0,20}умееш).{0,80}(?:инн|огрн|компани|директор|выручк|реквизит|участник|выставк)/i;
const SECRETS_LIST_INTENT = /^\/secrets_list$|список.{0,15}доступ|какие.{0,15}подключ|покажи.{0,15}сервис|мои.{0,15}доступ/i;
const SECRETS_LOG_INTENT  = /^\/secrets_log$|история.{0,15}доступ|лог.{0,15}секрет|обращени.{0,15}секрет/i;
const REVOKE_INTENT       = /отзов|revoke|удал.{0,10}доступ|отключ.{0,10}сервис|убер.{0,10}доступ/i;
const REVOKE_SERVICE_RE   = /(github|гитхаб|weeek|вик|nalog|налог|нпд|самозан|figma|фигма|notion|linear|tilda|тильда|gdrive|гугл|google|dadata)/i;

const TRUST_FOOTER = '\n\n🔒 Данные для входа не видны в переписке с ботом — они поступают прямо на сервер и хранятся в изолированном хранилище, отдельно от ИИ. Все обращения фиксируются в /secrets_log. Отзыв доступов: /secrets_list';

// service: label in /connect/:service route and agent-tokens filename
const QUICK_SETUPS = [
  {
    match: /github|гитхаб/i,
    service: 'github',
    hint: 'Где взять: github.com/settings/tokens → Generate new token (classic) → scopes: repo, read:org',
  },
  {
    match: /weeek|вик(?!тор)/i,
    service: 'weeek',
    hint: 'Где взять: Weeek → Settings → Integrations → API → Generate token',
  },
  {
    match: /google.?drive|гугл.?диск|gdrive/i,
    service: null,
    hint: 'Скажи мне "настрой Google Drive" — вызову gdrive_setup, он создаст сервис-аккаунт автоматически.',
  },
  {
    match: /tilda|тильда/i,
    service: null,
    hint: 'Нужен удалённый браузер — скажи мне "подключи Tilda".',
  },
  {
    match: /nalog|налог|нпд|самозан/i,
    service: 'nalog',
    hint: 'Войдёшь через Госуслуги — страница защищена, данные не проходят через чат.',
  },
  {
    match: /getcourse|геткурс|get.?course/i,
    service: 'getcourse',
    hint: 'Введи домен + API ключ (L1: ученики/заказы) и/или логин+пароль (L2: курсы/уроки).',
  },
];

function getQuickAnswer(task, userId) {
  // /secrets_list — show connected services
  if (SECRETS_LIST_INTENT.test(task)) {
    const services = userId ? listConnectedServices(userId) : null;
    if (!services || services.length === 0) {
      return 'Нет подключённых сервисов.\n\nЧтобы подключить: «подключи GitHub», «подключи Налог.ру» и т. д.';
    }
    const lines = services.map(s => {
      const d = s.mtime.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      return `• ${s.name} — обновлён ${d}`;
    });
    return [
      '🔑 Подключённые сервисы:',
      ...lines,
      '',
      'Отозвать: «отзови доступ к [сервис]»',
      'История обращений: /secrets_log',
    ].join('\n');
  }

  // /secrets_log — show access log
  if (SECRETS_LOG_INTENT.test(task)) {
    const log = userId ? getSecretsLog(userId) : null;
    if (!log || log.length === 0) return 'История обращений пуста.';
    const lines = log.map(l => {
      const [ts, svcs] = l.split('\t');
      const time = new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `${time} — ${svcs}`;
    });
    return '📋 Последние обращения к вашим данным:\n' + lines.join('\n');
  }

  // Revoke — delete a service token
  if (REVOKE_INTENT.test(task)) {
    const svcMatch = task.match(REVOKE_SERVICE_RE);
    if (!svcMatch) return 'Укажи сервис для отзыва, например: «отзови доступ к GitHub»';
    if (!userId) return 'Не удалось определить пользователя.';
    const result = revokeService(userId, svcMatch[1]);
    if (result === null) return `Не распознал сервис «${svcMatch[1]}». Доступные: GitHub, Weeek, Налог.ру, Figma, Tilda, Google Drive.`;
    if (result === 'not_found') return `Сервис «${svcMatch[1]}» не был подключён.`;
    return `✅ Доступ к ${SERVICE_DISPLAY[result] || result} отозван. Данные удалены с сервера.`;
  }

  // Capability question about INN enrichment — answer immediately without calling Claude
  if (INN_CAPABILITY_INTENT.test(task)) {
    return 'Да, есть скил INN Enrichment.\n\nНаходит для списка компаний (300–1000 шт): ИНН, ОГРН, директора, выручку и прибыль.\n\nИсточники: БФО ФНС (бесплатно), ЕГРЮЛ, DaData, Checko — всё уже настроено, ключи у платформы.\n\nПришли JSON-файл со списком компаний — и запущу.';
  }

  if (!SETUP_INTENT.test(task)) {
    console.log('[quick-answer] no setup intent, task=%j', task.slice(0, 120));
    return null;
  }

  for (const { match, service, hint } of QUICK_SETUPS) {
    if (!match.test(task)) continue;
    console.log('[quick-answer] matched service=%s uid=%s', service || 'null', userId);
    if (service && userId) {
      try {
        const link = generateConnectLink(userId, service);
        return `Данные для входа — по ссылке:\n${link}\n\n${hint}${TRUST_FOOTER}`;
      } catch (e) {
        console.error('[quick-answer] generateConnectLink failed:', e.message);
        return hint;
      }
    }
    return hint;
  }

  console.log('[quick-answer] setup intent matched but no service pattern, task=%j', task.slice(0, 120));
  return null;
}

/**
 * Runs `claude --dangerously-skip-permissions` for a task,
 * streams output to Telegram by editing a "thinking" message.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {object} opts.user   - { id, name, username, workDir }
 * @param {string} opts.task
 * @param {string|null} opts.context
 * @param {string|null} opts.sessionId  - existing session to append to
 * @param {object} opts.secrets - { BOT_TOKEN, ANTHROPIC_API_KEY, ... }
 */
async function runTask({ taskId, user, task, context, sessionId, contextFromSession, secrets }) {
  const { BOT_TOKEN } = secrets;
  const chatId = user.id;

  fs.mkdirSync(user.workDir, { recursive: true });

  // Quick answer — check before session creation so system commands
  // (/secrets_list, /secrets_log, connect links, revoke) don't pollute
  // session history with ephemeral utility responses.
  const quickReply = getQuickAnswer(task, user.id);
  if (quickReply) {
    await tgSend(BOT_TOKEN, chatId, quickReply);
    // If continuing an existing session, still log the exchange there
    if (sessionId && sessions.getSession(user.workDir, sessionId)) {
      sessions.appendUserMessage(user.workDir, sessionId, task);
      sessions.appendReply(user.workDir, sessionId, quickReply);
    }
    return quickReply;
  }

  // Resolve session: attach to existing or create new
  let activeSessionId = sessionId;
  let sessionContext = context;

  if (sessionId && sessions.getSession(user.workDir, sessionId)) {
    // Existing session — build context from prior history
    const fromSession = sessions.buildContext(user.workDir, sessionId);
    if (fromSession) {
      sessionContext = context ? `${fromSession}\n\n${context}` : fromSession;
    }
    sessions.appendUserMessage(user.workDir, sessionId, task);
  } else {
    // New session — optionally preload context from another session
    if (contextFromSession) {
      const sourceCtx = sessions.buildContext(user.workDir, contextFromSession);
      if (sourceCtx) {
        sessionContext = context ? `${sourceCtx}\n\n${context}` : sourceCtx;
      }
    }
    activeSessionId = sessions.createSession(user.workDir, { task, id: sessionId || undefined });
  }

  // Send "thinking" message, get message_id for streaming edits
  const thinkMsg = await tgSend(BOT_TOKEN, chatId, '⏳ Думаю…');
  const msgId = thinkMsg?.result?.message_id;

  const userTokens = loadUserTokens(user.id);

  // Skills are now available via trained-skills MCP (tools/list → list_skills).
  // No prompt injection needed — Claude discovers and calls tools directly.
  const prompt = sessionContext ? `${sessionContext}\n\n${task}` : task;
  const fullOutput = { text: '' };

  // Build the log viewer URL (TODO: expose via /logs/:taskId)
  // For now: stream output directly to Telegram

  // Write per-user MCP config — gives Claude access only to this user's Chrome profile
  const mcpConfig = writeMcpConfig(user.workDir, user.id);

  // Strip ANTHROPIC_API_KEY so Claude uses OAuth from ~/.claude/.credentials.json.
  // The API key account is out of credits; OAuth (Mac subscription) has no per-token billing.
  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;

  const systemPromptFile = path.join(__dirname, 'agent-system-prompt.txt');

  const proc = spawn('claude', [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--mcp-config', mcpConfig,
    ...(fs.existsSync(systemPromptFile) ? ['--append-system-prompt-file', systemPromptFile] : []),
    '--print', prompt,
  ], {
    cwd: user.workDir,
    env: {
      ...cleanEnv,
      ...userTokens,
      AGENT_USER_ID: String(user.id),
    },
  });

  let streamTimer = null;
  let lastSent = '';
  let lineBuffer = '';
  let claudeResult = null;  // text from result event
  let claudeUsage = null;   // usage from result event

  function scheduleStream() {
    if (streamTimer) return;
    streamTimer = setInterval(async () => {
      const snippet = fullOutput.text.slice(-MAX_MSG_LEN);
      if (snippet === lastSent || !snippet) return;
      lastSent = snippet;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, `⏳ ${snippet}`).catch(() => {});
    }, STREAM_INTERVAL_MS);
  }

  proc.stdout.on('data', chunk => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep trailing incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') {
          claudeResult = typeof event.result === 'string' ? event.result : null;
          claudeUsage = event.usage || null;
          if (claudeUsage) {
            console.log(`[${taskId}] usage: in=${claudeUsage.input_tokens} out=${claudeUsage.output_tokens} cache_read=${claudeUsage.cache_read_input_tokens || 0} cache_write=${claudeUsage.cache_creation_input_tokens || 0}`);
          }
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              fullOutput.text += block.text;
            }
          }
          scheduleStream();
        }
      } catch {
        // Non-JSON line (e.g. startup messages) — treat as plain text
        fullOutput.text += line + '\n';
        scheduleStream();
      }
    }
  });

  proc.stderr.on('data', chunk => console.error(`[${taskId}] stderr:`, chunk.toString()));

  await new Promise((resolve, reject) => {
    proc.on('close', resolve);
    proc.on('error', reject);
  });

  clearInterval(streamTimer);

  // Prefer the clean result string from the result event; fall back to accumulated stream text
  const result = (claudeResult ?? fullOutput.text).trim() || '(нет вывода)';

  // Record token usage for billing
  if (claudeUsage) {
    recordUsage(user.workDir, {
      taskId,
      sessionId: activeSessionId,
      input_tokens: claudeUsage.input_tokens || 0,
      output_tokens: claudeUsage.output_tokens || 0,
      cache_read_input_tokens: claudeUsage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: claudeUsage.cache_creation_input_tokens || 0,
    });
  }
  const final = result.slice(-MAX_MSG_LEN);

  if (msgId) {
    await tgEdit(BOT_TOKEN, chatId, msgId, `✅ ${final}`).catch(() =>
      tgSend(BOT_TOKEN, chatId, `✅ ${final}`)
    );
  } else {
    await tgSend(BOT_TOKEN, chatId, `✅ ${final}`);
  }

  // Append assistant reply to session history
  if (activeSessionId) {
    sessions.appendReply(user.workDir, activeSessionId, result);
  }

  return result;
}

const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

async function tgSend(token, chatId, text) {
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return res.json();
}

async function tgEdit(token, chatId, messageId, text) {
  const res = await fetch(`${TG_API}/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
  return res.json();
}

module.exports = { runTask };
