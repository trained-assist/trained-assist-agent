const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { writeMcpConfig } = require('./browser');

const STREAM_INTERVAL_MS = 3000;
const MAX_MSG_LEN = 3500;

/**
 * Runs `claude --dangerously-skip-permissions` for a task,
 * streams output to Telegram by editing a "thinking" message.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {object} opts.user   - { id, name, username, workDir }
 * @param {string} opts.task
 * @param {string|null} opts.context
 * @param {object} opts.secrets - { BOT_TOKEN, ANTHROPIC_API_KEY, ... }
 */
async function runTask({ taskId, user, task, context, secrets }) {
  const { BOT_TOKEN } = secrets;
  const chatId = user.id;

  fs.mkdirSync(user.workDir, { recursive: true });

  // Send "thinking" message, get message_id for streaming edits
  const thinkMsg = await tgSend(BOT_TOKEN, chatId, '⏳ Думаю…');
  const msgId = thinkMsg?.result?.message_id;

  const prompt = context ? `${context}\n\n${task}` : task;
  const fullOutput = { text: '' };

  // Build the log viewer URL (TODO: expose via /logs/:taskId)
  // For now: stream output directly to Telegram

  // Write per-user MCP config — gives Claude access only to this user's Chrome profile
  const mcpConfig = writeMcpConfig(user.workDir, user.id);

  const proc = spawn('claude', [
    '--dangerously-skip-permissions',
    '--mcp-config', mcpConfig,
    '--print', prompt,
  ], {
    cwd: user.workDir,
    env: { ...process.env, ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY },
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

  return result;
}

async function tgSend(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return res.json();
}

async function tgEdit(token, chatId, messageId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
  return res.json();
}

module.exports = { runTask };
