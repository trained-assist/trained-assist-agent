/**
 * classify-message.js — decide which existing session a new message belongs to.
 *
 * Extracted from server.js for testability (no server spin-up needed).
 * The /classify endpoint in server.js imports and calls `classifyMessage` from here.
 */

// Sessions older than this are excluded from classification entirely.
const CLASSIFY_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

// Sessions older than this are matched with 'medium' confidence.
// 'medium' tells the gateway: session resolved, but it's been a while — confirm with user.
const CLASSIFY_STALE_MS = 60 * 60 * 1000; // 1 hour

const CLASSIFY_DONE_RE =
  /готово|сделан|убрал|убран|удалил|удалён|завершен|выполнен|очищен|заполнен|исправлен|опубликован|done|completed|всё\s+готово|всё\s+сделано/i;

function sessionAgeStr(ageMs) {
  if (ageMs < 60_000) return 'только что';
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} мин назад`;
  const hours = Math.round((ageMs / 3_600_000) * 10) / 10;
  return `${hours} ч назад`;
}

/**
 * @param {string} message - new user message
 * @param {Array<{id,topic,lastAt,lastUserMessage,lastMessageRole,lastAssistantSnippet}>} sessions
 * @param {string} openrouterKey
 * @returns {Promise<{sessionId:string|null, confidence:'high'|'medium'|'low', sessionAge?:number}>}
 */
async function classifyMessage(message, sessions, openrouterKey) {
  const now = Date.now();

  const activeSessions = sessions.filter(s => {
    if (s.lastAt && now - s.lastAt > CLASSIFY_MAX_AGE_MS) return false;
    if (
      s.lastMessageRole === 'assistant' &&
      s.lastAssistantSnippet &&
      CLASSIFY_DONE_RE.test(s.lastAssistantSnippet)
    ) return false;
    return true;
  });

  if (activeSessions.length === 0) return { sessionId: null, confidence: 'low' };

  const sessionDescriptions = activeSessions.map((s, i) => {
    const ageMs = now - (s.lastAt || now);
    const lastMsg = s.lastUserMessage
      ? `\n   Последнее сообщение: "${s.lastUserMessage.slice(0, 100)}"`
      : '';
    return (
      `${i + 1}. ID: ${s.id}\n` +
      `   Тема: "${s.topic}"\n` +
      `   Время с последнего сообщения: ${sessionAgeStr(ageMs)}` +
      lastMsg
    );
  }).join('\n\n');

  const prompt = `Пользователь написал новое сообщение. Определи, к какому из существующих диалогов оно относится.

СУЩЕСТВУЮЩИЕ ДИАЛОГИ:
${sessionDescriptions}

НОВОЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:
"${message}"

Ответь ТОЛЬКО одной строкой — ID диалога если уверен, или слово "ambiguous" если непонятно.
Правила:
- Если новое сообщение явно продолжает один из диалогов по теме — напиши его ID
- Если тема нового сообщения явно не связана ни с одним диалогом — напиши "ambiguous"
- Если прошло 2+ часа и тема не очевидно совпадает — напиши "ambiguous"
- Если сообщение может относиться к нескольким диалогам — напиши "ambiguous"
- Не пиши ничего лишнего, только ID или "ambiguous"`;

  if (!openrouterKey) {
    throw new Error('No API key configured for classify (OPENROUTER_API_KEY required)');
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify({
      model: 'z-ai/glm-5.3-flash',
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
  const answer = data.choices?.[0]?.message?.content?.trim() || 'ambiguous';

  if (answer === 'ambiguous') return { sessionId: null, confidence: 'low' };

  const match = activeSessions.find(s => s.id === answer);
  if (!match) return { sessionId: null, confidence: 'low' };

  const matchAge = now - (match.lastAt || now);
  const confidence = matchAge > CLASSIFY_STALE_MS ? 'medium' : 'high';

  return { sessionId: match.id, confidence, sessionAge: matchAge };
}

module.exports = { classifyMessage, CLASSIFY_MAX_AGE_MS, CLASSIFY_STALE_MS };
