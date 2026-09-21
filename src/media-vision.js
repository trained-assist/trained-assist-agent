'use strict';

const fs = require('fs');

// Vision OCR/description for image attachments, for engines whose underlying model
// has no multimodal input (OpenCode's minimax/GigaChat/DeepSeek profiles — unlike
// Claude Code, whose own Read tool already hands the image to the model natively).
// Same OpenRouter + google/gemini-2.5-flash pattern proven in applylink/worker.js's
// resume OCR (geminiPdf/imageToText) — reused here, not reinvented.

const PROMPT = [
  'Опиши это изображение для текстового ассистента, который не может видеть картинки.',
  'Сначала дословно перепиши ВЕСЬ читаемый текст (вывеска, документ, скриншот, подпись и т.п.), сохраняя язык оригинала.',
  'Если текста нет или его мало — одним-двумя предложениями опиши, что на фото (сцена, объект, люди, контекст).',
  'Ответ — только транскрипция/описание, без вводных фраз от себя.',
].join(' ');

// A model that can't or won't read the image often answers with a refusal SENTENCE
// (not an HTTP error) — real prose that would otherwise leak into the task as if it
// were the extracted content. Catch common openers in English and Russian.
function isRefusal(t) {
  if (!t) return true;
  const s = t.trim().toLowerCase();
  return /^(i'?m sorry|i am sorry|i cannot|i can'?t|sorry,? but|unfortunately|as an ai|i'?m unable|i am unable)/.test(s)
    || /(извините|к сожалению|я не могу|не могу извлечь|не могу прочитать|как (?:ии|ai)|к сожал)/.test(s.slice(0, 80));
}

async function extractImageText({ filePath, mimeType, openrouterKey, fetchImpl = fetch, timeoutMs = 20000 }) {
  if (!openrouterKey) return { ok: false, text: '', reason: 'no_key' };
  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return { ok: false, text: '', reason: 'read_error' }; }

  const mime = (mimeType || 'image/jpeg').split(';')[0];
  const b64 = buf.toString('base64');

  // Overridable for test mocking — same convention as HH_API_BASE_URL in src/hh-utils.js.
  const base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai';
  let r;
  try {
    r = await fetchImpl(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + openrouterKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ] }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, text: '', reason: 'network_error' };
  }
  if (!r.ok) return { ok: false, text: '', reason: `http_${r.status}` };

  let d;
  try { d = await r.json(); } catch { return { ok: false, text: '', reason: 'bad_json' }; }
  const t = (d.choices?.[0]?.message?.content || '').trim();
  if (isRefusal(t)) return { ok: false, text: '', reason: 'refusal' };
  if (!t) return { ok: false, text: '', reason: 'empty' };
  return { ok: true, text: t };
}

module.exports = { extractImageText, isRefusal };
