'use strict';

// Telegram send/edit primitives (issue #942 P1.4). Routes every outgoing
// message through the Markdown->TG-HTML degradation ladder in ../tg-format
// at this single chokepoint, so no caller can leak raw markdown.

const { formatForTelegram, makeLlmFixer } = require('../tg-format');

const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

// Lazy singleton cheap-LLM fixer for the formatting ladder (rung 2).
let _tgFixer;
function tgFixer() {
  if (_tgFixer === undefined) _tgFixer = makeLlmFixer(process.env.OPENROUTER_API_KEY);
  return _tgFixer;
}

async function tgFormat(text, extra) {
  if (extra && extra.parse_mode) return { text, extra };
  const { text: out, parse_mode } = await formatForTelegram(text, { llmFix: tgFixer() });
  return { text: out, extra: parse_mode ? { ...extra, parse_mode } : extra };
}

async function tgSend(token, chatId, text, extra = {}) {
  const f = await tgFormat(text, extra);
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: f.text, ...f.extra }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(`Telegram sendMessage failed (${data.error_code || res.status})`);
  return data;
}

async function tgEdit(token, chatId, messageId, text, extra = {}, retries = 3) {
  const f = await tgFormat(text, extra);
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${TG_API}/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: f.text, ...f.extra }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (res.status === 429) {
      const wait = (data.parameters?.retry_after || 5) * 1000;
      console.warn(`[tg] 429 rate limit on editMessageText, retry after ${wait}ms (attempt ${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok || !data.ok) {
      if (data.error_code === 400 && /message is not modified/i.test(data.description || '')) return data;
      throw new Error(`Telegram editMessageText failed (${data.error_code || res.status})`);
    }
    return data;
  }
  throw new Error('Telegram editMessageText rate limit retries exhausted');
}

module.exports = { TG_API, tgFormat, tgSend, tgEdit };
