const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeMcpConfig } = require('./browser');
const sessions = require('./session-store');

const STREAM_INTERVAL_MS = 3000;
const MAX_MSG_LEN = 3500;

function loadUserTokens(userId) {
  const tokensDir = path.join(os.homedir(), 'agent-tokens', String(userId));
  const extra = {};
  if (!fs.existsSync(tokensDir)) return extra;
  for (const file of fs.readdirSync(tokensDir)) {
    const val = fs.readFileSync(path.join(tokensDir, file), 'utf8').trim();
    const label = file.toLowerCase();
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
  return extra;
}

// ── Quick answers — bypass Claude for known setup patterns ───────────────────
// Returns a string if the task matches, null otherwise.

const SETUP_INTENT = /подключ|connect|настро|интегр|привяз|как.*добав|токен.*отправ|отправ.*токен|могу.*отправ|зайт|авториз|setup|подрубить/i;

const QUICK_SETUPS = [
  {
    match: /github|гитхаб/i,
    answer: 'Да — введи прямо в чат:\n`/settoken github ghp_xxxxx`\nТокен сохранится в систему, не в переписку.\n\nСоздать токен: github.com/settings/tokens → Generate new token (classic) → scopes: repo, read:org',
  },
  {
    match: /weeek|вик(?!тор)/i,
    answer: 'Введи:\n`/settoken weeek <token>`\nТокен: Weeek → Settings → Integrations → API → Generate token',
  },
  {
    match: /google.?drive|гугл.?диск|gdrive/i,
    answer: 'Скажи мне "настрой google drive" — вызову gdrive_setup, он автоматически создаст сервис-аккаунт. Потом расшаришь папку с SA email.',
  },
  {
    match: /tilda|тильда/i,
    answer: 'Нужно залогиниться через удалённый браузер. Скажи мне — пришлю ссылку, откроешь, войдёшь в Tilda, сессия захватится автоматически.',
  },
  {
    match: /nalog|налог|нпд|самозан/i,
    answer: 'Открой lknpd.nalog.ru в Chrome → нажми иконку расширения cloud-auth-bridge → Send token. Токен живёт ~1 час.',
  },
];

function getQuickAnswer(task) {
  if (!SETUP_INTENT.test(task)) return null;
  for (const { match, answer } of QUICK_SETUPS) {
    if (match.test(task)) return answer;
  }
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

  // Quick answer — skip Claude entirely for known setup/connect patterns
  const quickReply = getQuickAnswer(task);
  if (quickReply) {
    await tgSend(BOT_TOKEN, chatId, quickReply);
    if (activeSessionId) sessions.appendReply(user.workDir, activeSessionId, quickReply);
    return quickReply;
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
    fullOutput.text += chunk.toString();
    scheduleStream();
  });

  proc.stderr.on('data', chunk => console.error(`[${taskId}] stderr:`, chunk.toString()));

  await new Promise((resolve, reject) => {
    proc.on('close', resolve);
    proc.on('error', reject);
  });

  clearInterval(streamTimer);

  const result = fullOutput.text.trim() || '(нет вывода)';
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
