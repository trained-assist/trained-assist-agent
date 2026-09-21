'use strict';

// Checks outgoing HH messages for 5 classes of errors before sending.
// Regex checks run first (free). LLM check is one cheap call covering the rest.

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GUARD_MODEL = 'google/gemini-2.5-flash';

// ─── Regex checks ─────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = [
  /\{\{[^}]+\}\}/,                     // {{имя}}, {{name}}
  /\{[A-Za-zА-Яа-яёЁ_][^}]{0,29}\}/,  // {имя}, {name}
  /\[[A-Za-zА-Яа-яёЁ][^\]]{0,49}\]/,  // [имя], [ваше имя], [название компании]
];

function hasPlaceholder(text) {
  return PLACEHOLDER_RE.some(p => p.test(text));
}

// Plain \b doesn't detect word boundaries around Cyrillic letters (JS \w is ASCII-only),
// so Cyrillic alternatives use explicit lookaround instead of \b.
const CYR_BOUND_BEFORE = '(?<![а-яёА-ЯЁ])';
const CYR_BOUND_AFTER = '(?![а-яёА-ЯЁ])';
const cyrWord = (w) => `${CYR_BOUND_BEFORE}${w}${CYR_BOUND_AFTER}`;
const TIME_EXPR_RE = new RegExp([
  '\\d{1,2}[:.]\\d{2}\\b',
  `${CYR_BOUND_BEFORE}в\\s*\\d{1,2}\\s*(?:час|ч\\.)`,
  cyrWord('утром'), cyrWord('днём'), cyrWord('днем'), cyrWord('вечером'),
  cyrWord('сегодня'), cyrWord('завтра'), cyrWord('послезавтра'),
  cyrWord('понедельник'), cyrWord('вторник'), cyrWord('сред[ау]'), cyrWord('четверг'),
  cyrWord('пятниц[ау]'), cyrWord('суббот[ау]'), cyrWord('воскресень[ея]'),
].join('|'), 'gi');

// Detects a recruiter message naming a specific call time/date that wasn't echoed
// from the candidate's own messages — i.e. the model invented it rather than
// reflecting real availability configured for the vacancy.
function hasInventedTime(messageText, conversationHistory) {
  const found = messageText.match(TIME_EXPR_RE);
  if (!found) return false;
  const candidateText = conversationHistory
    .filter(m => m.role !== 'employer')
    .map(m => m.text || '')
    .join(' ')
    .toLowerCase();
  return !found.every(t => candidateText.includes(t.toLowerCase()));
}

// ─── LLM ──────────────────────────────────────────────────────────────────────

function llmCall(apiKey, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: GUARD_MODEL, messages, temperature: 0, max_tokens: 300 });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (httpRes) => {
      const chunks = [];
      httpRes.on('data', c => chunks.push(c));
      httpRes.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('guard timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getApiKey(username) {
  if (username) {
    const base = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
    const f = path.join(base, String(username), 'openrouter');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  }
  return process.env.OPENROUTER_API_KEY || null;
}

async function llmCheck(messageText, history, apiKey) {
  const ctx = history.slice(-6).map(m => {
    const who = m.role === 'employer' ? 'Рекрутер' : 'Кандидат';
    return `${who}: ${m.text.slice(0, 300)}`;
  }).join('\n');

  const prompt = `Проверь новое сообщение рекрутера. Ответь ТОЛЬКО JSON, без пояснений.
${ctx ? `\nИстория переписки:\n${ctx}\n` : ''}
Новое сообщение: "${messageText}"

{"repeated_question": true/false, "repeated_intro": true/false, "template_garbage": true/false, "reason": "причина если хоть одно true, иначе null"}

repeated_question = тот же вопрос уже задавался в истории
repeated_intro = рекрутер снова пишет "Меня зовут X" или "Я — X из Y" хотя уже представлялся
template_garbage = текст явно является незаполненным шаблоном или бессмысленным набором фраз`;

  const raw = await module.exports.llmCall(apiKey, [{ role: 'user', content: prompt }]);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('guard: no json in llm response');
  return JSON.parse(match[0]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} messageText
 * @param {Array<{role:string, text:string}>} conversationHistory
 * @param {{ username?: string, apiKey?: string }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, checks: object }>}
 */
async function bullshitGuard(messageText, conversationHistory = [], options = {}) {
  const checks = { empty: false, placeholder: false, invented_time: false, repeated_question: false, repeated_intro: false, template_garbage: false };

  if (!messageText || messageText.trim().length === 0) {
    checks.empty = true;
    return { ok: false, reason: 'пустое сообщение', checks };
  }

  if (hasPlaceholder(messageText)) {
    checks.placeholder = true;
    return { ok: false, reason: 'незаполненный placeholder в тексте', checks };
  }

  // Informational only, not blocking: a recruiter typing their own real availability
  // ("завтра в 15:00") is a legitimate message, not an AI hallucination — this check
  // can't tell the two apart, so it flags for the guard log but lets the send through.
  if (options.allowSpecificTime !== true && hasInventedTime(messageText, conversationHistory)) {
    checks.invented_time = true;
  }

  const apiKey = options.apiKey || getApiKey(options.username);
  let llmChecked = false;
  if (conversationHistory.length > 0) {
    if (!apiKey) {
      checks.llm_skipped = 'no_api_key';
    } else {
      try {
        const r = await llmCheck(messageText, conversationHistory, apiKey);
        llmChecked = true;
        checks.repeated_question = !!r.repeated_question;
        checks.repeated_intro = !!r.repeated_intro;
        checks.template_garbage = !!r.template_garbage;

        if (checks.repeated_question || checks.repeated_intro || checks.template_garbage) {
          return { ok: false, reason: r.reason || 'обнаружена проблема в сообщении', checks };
        }
      } catch (e) {
        console.warn('[bullshit-guard] llm check skipped:', e.message);
        checks.llm_skipped = `error: ${e.message}`;
      }
    }
  }

  // degraded = semantic (LLM) check never ran even though there was history to check against —
  // the message passed only on the free regex checks. Callers should log this so a run of
  // API failures doesn't silently defeat the guard.
  return { ok: true, checks, degraded: conversationHistory.length > 0 && !llmChecked };
}

module.exports = { bullshitGuard, hasPlaceholder, hasInventedTime, getApiKey, llmCall };
