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
    else if (label === 'nalog') {
      try {
        const parsed = JSON.parse(val);
        if (parsed.auth_token)    extra.NALOG_TOKEN         = parsed.auth_token;
        if (parsed.refresh_token) extra.NALOG_REFRESH_TOKEN  = parsed.refresh_token;
        if (parsed.expires)       extra.NALOG_TOKEN_EXPIRES  = parsed.expires;
      } catch { extra.NALOG_TOKEN = val; }
    }
    else extra[label.toUpperCase().replace(/[^A-Z0-9]/g, '_')] = val;
  }
  return extra;
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

  // Send "thinking" message, get message_id for streaming edits
  const thinkMsg = await tgSend(BOT_TOKEN, chatId, '⏳ Думаю…');
  const msgId = thinkMsg?.result?.message_id;

  const nalogCtx = userTokens.NALOG_TOKEN ? `\n[SYSTEM CONTEXT — nalog.ru API]
NALOG_TOKEN env var contains a valid JWT for lknpd.nalog.ru. Use it like:
  Authorization: Bearer $NALOG_TOKEN
Base URL: https://lknpd.nalog.ru/api/v1
Key endpoints:
  GET /user — profile info (ИНН, name)
  GET /incomes?from=<ISO8601+03:00>&to=<ISO8601+03:00>&limit=10&offset=0 — income list
  GET /incomes/{uuid} — single income receipt
  POST /income — register new income (НПД check-in)
Dates must be ISO8601 with Moscow timezone offset (+03:00), e.g. 2026-06-01T00:00:00+03:00
[END SYSTEM CONTEXT]\n` : '';

  const prompt = sessionContext ? `${nalogCtx}${sessionContext}\n\n${task}` : `${nalogCtx}${task}`;
  const fullOutput = { text: '' };

  // Build the log viewer URL (TODO: expose via /logs/:taskId)
  // For now: stream output directly to Telegram

  // Write per-user MCP config — gives Claude access only to this user's Chrome profile
  const mcpConfig = writeMcpConfig(user.workDir, user.id);

  const userTokens = loadUserTokens(user.id);

  const proc = spawn('claude', [
    '--dangerously-skip-permissions',
    '--mcp-config', mcpConfig,
    '--print', prompt,
  ], {
    cwd: user.workDir,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
      ...userTokens,
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
