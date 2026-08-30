const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeMcpConfig } = require('./browser');
const sessions = require('./session-store');
const { recordUsage, getUsageTotals } = require('./usage-store');
const {
  loadUserTokens,
  listConnectedServices,
  revokeService,
  getSecretsLog,
  generateConnectLink,
  SERVICE_DISPLAY,
} = require('./user-tokens');

const STREAM_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 12000;
const MAX_MSG_LEN = 3500;

// ── Quick answers — bypass Claude for known setup/secrets patterns ───────────
// Returns a string if the task matches, null otherwise.

const SETUP_INTENT          = /подключ|connect|настро|интегр|привяз|как.*добав|могу.*отправ|зайт|авториз|setup|подрубить/i;
const INN_CAPABILITY_INTENT = /(?:скил|skill|умееш|можешь|есть.{0,30}возможн|есть.{0,30}функц|есть.{0,30}инструм|что.{0,20}умееш).{0,80}(?:инн|огрн|компани|директор|выручк|реквизит|участник|выставк)/i;
const SECRETS_LIST_INTENT   = /^\/secrets_list$|список.{0,15}доступ|какие.{0,15}подключ|покажи.{0,15}сервис|мои.{0,15}доступ/i;
const SECRETS_LOG_INTENT    = /^\/secrets_log$|история.{0,15}доступ|лог.{0,15}секрет|обращени.{0,15}секрет/i;
const REVOKE_INTENT         = /отзов|revoke|удал.{0,10}доступ|отключ.{0,10}сервис|убер.{0,10}доступ/i;
const REVOKE_SERVICE_RE     = /(github|гитхаб|weeek|вик|nalog|налог|нпд|самозан|figma|фигма|notion|linear|tilda|тильда|gdrive|гугл|google|dadata)/i;
const SESSIONS_INTENT       = /^\/sessions$|мои.{0,10}диалог|мои.{0,10}сессии|список.{0,10}диалог|покажи.{0,10}истори|мои.{0,10}задач/i;
const USAGE_INTENT          = /^\/usage$|сколько.{0,20}потратил|токен.{0,20}статистик|использован.{0,20}токен|стоимость.{0,20}сессий|расход.{0,20}токен/i;
const PING_INTENT           = /^\/ping$|^ты живой|^ты онлайн|^ты работаешь|^привет бот|^ping$/i;
const HELP_INTENT           = /^\/help$|^\/start$|что.{0,10}умееш|чем.{0,10}помож|какие.{0,10}возможн|список.{0,10}команд|помощь/i;

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

function getQuickAnswer(task, userId, workDir) {
  // /ping — liveness check
  if (PING_INTENT.test(task)) return '🟢 Онлайн. Готов к работе.';

  // /help — capability overview (static, no Claude needed)
  if (HELP_INTENT.test(task)) {
    return [
      '🤖 Что я умею:',
      '',
      '📁 Работа с файлами, кодом, данными',
      '🔗 Интеграции: GitHub, Weeek, Налог.ру, Tilda, GetCourse, Google Drive',
      '🏢 INN Enrichment — поиск ИНН/ОГРН/директоров/выручки по списку компаний',
      '🌐 Браузер — вхожу на сайты и выполняю действия',
      '',
      'Команды:',
      '/secrets_list — подключённые сервисы',
      '/secrets_log — история обращений к данным',
      '/sessions — мои диалоги',
      '/usage — расход токенов',
      '',
      'Чтобы подключить сервис: «подключи GitHub», «подключи Налог.ру» и т. д.',
    ].join('\n');
  }

  // /sessions — list recent sessions
  if (SESSIONS_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию.';
    const list = sessions.listSessions(workDir, 10);
    if (!list || list.length === 0) return 'Нет активных диалогов.';
    const lines = list.map((s, i) => {
      const d = new Date(s.lastAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      return `${i + 1}. ${s.topic.slice(0, 60)} (${d}, ${s.messageCount} сообщ.)`;
    });
    return '💬 Последние диалоги:\n' + lines.join('\n');
  }

  // /usage — token usage stats
  if (USAGE_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию.';
    const t = getUsageTotals(workDir);
    if (!t || t.tasks === 0) return 'Данных об использовании пока нет.';
    const lines = [
      `📊 Использование токенов (всего ${t.tasks} задач):`,
      `• Входящих: ${t.input_tokens.toLocaleString('ru-RU')}`,
      `• Исходящих: ${t.output_tokens.toLocaleString('ru-RU')}`,
    ];
    if (t.cache_read > 0) lines.push(`• Из кэша: ${t.cache_read.toLocaleString('ru-RU')}`);
    if (t.cache_write > 0) lines.push(`• В кэш записано: ${t.cache_write.toLocaleString('ru-RU')}`);
    return lines.join('\n');
  }

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

// Per-user serial task queue: Map<userId, Promise>
// Prevents concurrent Claude processes for the same user (OOM risk on small VMs).
const userQueues = new Map();

/**
 * Runs `claude --dangerously-skip-permissions` for a task,
 * streams output to Telegram by editing a "thinking" message.
 * Tasks for the same user are serialised — each waits for the previous to finish.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {object} opts.user   - { id, name, username, workDir }
 * @param {string} opts.task
 * @param {string|null} opts.context
 * @param {string|null} opts.sessionId  - existing session to append to
 * @param {object} opts.secrets - { BOT_TOKEN, ANTHROPIC_API_KEY, ... }
 */
function runTask(opts) {
  const userId = String(opts.user.id);
  const prev = userQueues.get(userId) ?? Promise.resolve();
  const current = prev.then(() => _runTask(opts)).catch(err => {
    console.error(`[${opts.taskId}] unhandled queue error:`, err.message);
  });
  userQueues.set(userId, current);
  current.finally(() => {
    // Only clear if no newer task was enqueued after us
    if (userQueues.get(userId) === current) userQueues.delete(userId);
  });
  return current;
}

async function _runTask({ taskId, user, task, context, sessionId, contextFromSession, secrets }) {
  const { BOT_TOKEN } = secrets;
  const chatId = user.id;

  fs.mkdirSync(user.workDir, { recursive: true });

  // Quick answer — check before session creation so system commands
  // (/secrets_list, /secrets_log, connect links, revoke) don't pollute
  // session history with ephemeral utility responses.
  const quickReply = getQuickAnswer(task, user.id, user.workDir);
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
  const thinkingStart = Date.now();

  const userTokens = loadUserTokens(user.id);

  // Skills are now available via trained-skills MCP (tools/list → list_skills).
  // No prompt injection needed — Claude discovers and calls tools directly.
  const prompt = sessionContext ? `${sessionContext}\n\n${task}` : task;
  const fullOutput = { text: '' };

  // Write per-user MCP config — gives Claude access only to this user's Chrome profile
  const mcpConfig = writeMcpConfig(user.workDir, user.id);

  // Strip ANTHROPIC_API_KEY so Claude uses OAuth from ~/.claude/.credentials.json.
  // The API key account is out of credits; OAuth (Mac subscription) has no per-token billing.
  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;

  const systemPromptFile = path.join(__dirname, 'agent-system-prompt.txt');

  const proc = spawn('claude', [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
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
  let heartbeatTimer = null;
  let outputStarted = false;
  let lastSent = '';
  let lineBuffer = '';
  let claudeResult = null;  // text from result event
  let claudeUsage = null;   // usage from result event

  // Heartbeat: show elapsed seconds while Claude hasn't produced output yet
  if (msgId) {
    heartbeatTimer = setInterval(async () => {
      if (outputStarted) return;
      const secs = Math.round((Date.now() - thinkingStart) / 1000);
      await tgEdit(BOT_TOKEN, chatId, msgId, `⏳ Думаю… (${secs}с)`).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleStream() {
    if (streamTimer) return;
    outputStarted = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
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
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

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
