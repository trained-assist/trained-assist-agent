'use strict';
// Uses a cheap LLM (DeepSeek via OpenRouter) to decide the most common
// next action a naive user would take given the current conversation state.

// Common first messages a new user would send to an AI assistant bot.
const FIRST_STEP_MESSAGES = [
  'привет',
  'ты работаешь?',
  'что умеешь?',
  'помоги мне',
  'привет! кто ты?',
];

async function decideFirstAction() {
  return { type: 'text', content: FIRST_STEP_MESSAGES[0] };
}

async function decideNextAction({ conversation, latestText, buttons, stepNumber, alternativeMode, openrouterKey }) {
  const buttonsDesc = buttons?.length
    ? buttons.map((b, i) => `${i + 1}. "${b.text}" → callback_data="${b.callback_data}"`).join('\n')
    : 'нет кнопок';

  const conversationText = conversation
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Агент'}: ${m.text.slice(0, 400)}`)
    .join('\n\n');

  const modeNote = alternativeMode
    ? 'Ты должен выбрать ВТОРОЙ по вероятности вариант (не самый очевидный первый, но тоже распространённый).'
    : 'Выбери САМЫЙ банальный, самый ожидаемый вариант — то, что сделает большинство новых пользователей.';

  const prompt = `Ты — среднестатистический новый пользователь Telegram-бота (AI-помощник для рекрутинга и задач). Ты не технарь, просто обычный человек, который первый раз пользуется ботом.

ШАГ ${stepNumber}/7 тест-сессии.

История разговора (последние сообщения):
${conversationText}

Агент только что ответил:
${latestText.slice(0, 600)}

Доступные кнопки:
${buttonsDesc}

${modeNote}

Правила:
- Если есть кнопки — скорее всего нажмёшь на самую понятную/первую
- Если нет кнопок — напишешь короткое очевидное сообщение
- Не задавай сложных вопросов, не пиши длинные тексты
- Действуй как любопытный, но ленивый пользователь

Ответь ТОЛЬКО JSON (без markdown, без пояснений):
Если напишешь текст: {"type":"text","content":"..."}
Если нажмёшь кнопку: {"type":"button","callbackData":"...","buttonText":"..."}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`OpenRouter error: ${res.status}`);

  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || '').trim();

  // Parse JSON, stripping markdown fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    // Fallback: send generic follow-up
    return { type: 'text', content: 'расскажи подробнее' };
  }
}

module.exports = { decideFirstAction, decideNextAction };
