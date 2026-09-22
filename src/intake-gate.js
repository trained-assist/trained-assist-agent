// ШАГ 1.2 — cheap completeness gate. Given a coalesced intake buffer, decide
// how confidently it reads as a finished, actionable request:
//   • "clear"        — unambiguous, launch now.
//   • "likely"       — probably done, but give the user a few minutes to add
//                       more or notice and launch manually before it fires.
//   • "insufficient" — genuinely not enough to act on (or obviously cut off
//                       mid-thought) — never auto-launch this one, the user
//                       must add content or tap the button themselves.
// STRONG bias toward "clear"/"likely": we only want "insufficient" to catch
// requests nobody could act on. On any doubt or error we fail open to "clear"
// — never trap the user behind a gate they can't see the reason for.
//
// Extracted from server.js (a require() of that module boots the whole HTTP
// server) so this — the only piece with real branching logic worth a unit
// test — can be tested in isolation.
async function checkCompleteness(text, openrouterKey, { fetchImpl = fetch } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed || !openrouterKey) return { level: 'clear', complete: true };

  const prompt = `Пользователь пишет ассистенту в Telegram. Оцени, насколько уверенно можно начинать выполнять это как законченный запрос.

СООБЩЕНИЕ:
"""
${trimmed.slice(0, 1200)}
"""

Ответь ТОЛЬКО одним словом:
- "clear" — однозначно законченная мысль/просьба/вопрос, можно начинать сразу (даже короткая, даже без деталей).
- "likely" — скорее всего законченная мысль, но есть небольшая неопределённость (могло бы быть продолжение, но по умолчанию можно начинать).
- "insufficient" — реально не хватает контекста чтобы понять, что делать, ИЛИ мысль явно оборвана на полуслове: обрывается на предлоге/союзе, "сделай так чтобы", "а можешь", "нужно чтобы…" без продолжения, висящее "и".

Сильно склоняйся к "clear". Используй "insufficient" только когда по сообщению реально невозможно понять задачу. Ничего лишнего, одно слово.`;

  const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterKey}`,
    },
    body: JSON.stringify({
      model: 'z-ai/glm-5.3-flash',
      max_tokens: 8,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter API ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const answer = (data.choices?.[0]?.message?.content || '').toLowerCase();
  const level = answer.includes('insufficient') ? 'insufficient' : answer.includes('likely') ? 'likely' : 'clear';
  // `complete` kept alongside `level` so a caller mid-rollout on the old binary
  // contract still fails open instead of breaking.
  return { level, complete: level !== 'insufficient' };
}

module.exports = { checkCompleteness };
