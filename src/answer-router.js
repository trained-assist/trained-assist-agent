// Answer Router — на входе сессии выбирает ГЛУБИНУ ответа: short (one-shot) vs deep.
//
// Проблема: по умолчанию ассистент отвечает в один проход (conciseness-правила в
// agent-system-prompt.txt) — это хорошо для конкретных задач, но плохо для research:
// «исследуй/сравни/разберись» нельзя честно закрыть одним абзацем.
//
// Ось этого роутера ⟂ followup-controller: followup решает «довести задачу до конца
// между ходами»; router решает «на первом ходу — короткий ответ или многошаговый
// research-режим». Разные классы, разные модули.
//
// Поток:
//   1. Дешёвый pre-gate: тривиально-короткое/пустое → one-shot без LLM.
//   2. Дешёвая LLM отдаёт oneshotScore 0..1 (+reason). Чем МУТНЕЕ задача, тем ниже
//      score. Порог (env, обратимо) отсекает score<threshold → deep.
//   3. Решение durable-пишется в answer-modes/<sessionId>.json (переживает ходы/краш).
//   4. При сборке промпта на каждом ходу режим ЧИТАЕТСЯ с диска; deep → в системный
//      промпт добавляется блок, снимающий cap «2-3 предложения».
//
// Дизайн-принципы (strict owner): fail-open в one-shot (классификатор — не критичный
// путь: молчит/падает/нет ключа → текущее поведение), durable на диске, порог и модель
// в env (обратимость), никакого зависания.

const fs = require('fs');
const path = require('path');

// ── Настройки (обратимые через env) ─────────────────────────────────────────
const ENABLED   = process.env.ANSWER_ROUTER_ENABLED !== '0';           // kill-switch
const MODEL     = process.env.ANSWER_ROUTER_MODEL || 'google/gemini-2.5-flash';
// score < THRESHOLD → deep. Ниже порог = реже deep (консервативнее). 0.5 = баланс.
const THRESHOLD = clamp01(Number(process.env.ANSWER_ROUTER_THRESHOLD) || 0.5);
const MIN_CHARS = 16;   // короче — почти никогда не research; one-shot без LLM
const MODES_DIR = 'answer-modes';

function clamp01(n) { return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5; }

// Явные research-сигналы: если задача их содержит — почти наверняка не one-shot.
// Используется только как ПОДСКАЗКА в промпте LLM, не как жёсткое правило.
const RESEARCH_HINT = /(исследу|research|сравни|проанализир|analy[sz]e|обзор|разбер[иё]сь|глубок|подробн разбер|market|рынок|due diligence|найди все|собери все|варианты|pros and cons|за и против|многофактор|стратег)/i;

function _dir(workDir) { return path.join(workDir, MODES_DIR); }
function _file(workDir, sessionId) { return path.join(_dir(workDir), `${sessionId}.json`); }

function _atomicWrite(fp, data) {
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, fp);
}

function readMode(workDir, sessionId) {
  try {
    if (!workDir || !sessionId) return null;
    const fp = _file(workDir, sessionId);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) { console.warn('[answer-router] read:', e.message); return null; }
}

function writeMode(workDir, sessionId, rec) {
  try {
    if (!workDir || !sessionId || !rec) return false;
    fs.mkdirSync(_dir(workDir), { recursive: true });
    _atomicWrite(_file(workDir, sessionId), JSON.stringify({ sessionId, ...rec }, null, 2));
    return true;
  } catch (e) { console.error('[answer-router] write:', e.message); return false; }
}

// ── Классификатор (дешёвая LLM, детерминированный, fail-open) ────────────────
// Возвращает {mode:'oneshot'|'deep', score:0..1, reason, source}.
// Любая неопределённость/ошибка → one-shot (текущее безопасное поведение).
async function decideMode(task, { apiKey, timeoutMs = 4000 } = {}) {
  const t = String(task || '').trim();

  // Kill-switch или тривиально-короткое → one-shot без LLM.
  if (!ENABLED) return { mode: 'oneshot', score: 1, reason: 'router disabled', source: 'gate' };
  if (t.length < MIN_CHARS) return { mode: 'oneshot', score: 1, reason: 'too short for research', source: 'gate' };

  const orKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (!orKey) return { mode: 'oneshot', score: 1, reason: 'no OpenRouter key', source: 'gate' };

  const system = [
    'Ты — маршрутизатор глубины ответа ассистента. По ПЕРВОМУ сообщению пользователя оцени,',
    'насколько хорошо задачу закроет ОДИН короткий ответ (one-shot) против многошагового research-режима.',
    'Верни СТРОГО JSON: {"oneshotScore": <float 0..1>, "reason": "<до 10 слов>"}.',
    'oneshotScore=1 — задача КОНКРЕТНАЯ и однозначная, один чёткий ответ/действие исчерпывает её',
    '(«сколько будет 2+2», «переведи фразу», «создай контакт Иван +79...», «поправь опечатку в файле X»).',
    'oneshotScore=0 — задача РАЗМЫТАЯ или research: нужен сбор из нескольких источников, сравнение,',
    'анализ, взвешивание вариантов, план («исследуй рынок X», «что выбрать», «разберись почему», «сделай обзор»).',
    'Чем более расплывчата/многофакторна формулировка — тем НИЖЕ score. Оценивай по существу, не по длине.',
  ].join(' ');

  const hint = RESEARCH_HINT.test(t) ? ' [сигнал: похоже на research/сравнение]' : '';

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 60,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: t.slice(0, 1500) + hint },
        ],
      }),
    });
    if (!res.ok) return { mode: 'oneshot', score: 1, reason: `http ${res.status}`, source: 'fail-open' };
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const obj = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    const score = clamp01(Number(obj?.oneshotScore));
    const reason = String(obj?.reason || '').slice(0, 80);
    const mode = score < THRESHOLD ? 'deep' : 'oneshot';
    return { mode, score, reason, source: 'llm', threshold: THRESHOLD };
  } catch (e) {
    // Классификатор — не критичный путь: любой сбой → безопасный one-shot.
    console.warn('[answer-router] decideMode:', e.message);
    return { mode: 'oneshot', score: 1, reason: 'classifier error', source: 'fail-open' };
  }
}

// ── Блок для системного промпта в deep-режиме ────────────────────────────────
// Явно СНИМАЕТ cap «2-3 предложения» из agent-system-prompt.txt для этой сессии.
const DEEP_BLOCK = [
  '',
  '# РЕЖИМ ОТВЕТА: DEEP (research) — выбран автоматически для этой сессии',
  'Роутер определил задачу как размытую/исследовательскую. Для ЭТОЙ сессии правило',
  '«2-3 предложения / отвечай сразу» НЕ применяется — короткий ответ был бы недобросовестным.',
  '- Сначала короткий план: что нужно узнать/проверить и в каком порядке.',
  '- Собирай факты из НЕСКОЛЬКИХ источников (инструменты/сеть/диск), а не по памяти; итерируй.',
  '- Где выводы неочевидны — перепроверь их, прежде чем утверждать.',
  '- В конце — связный синтез с обоснованием. Длинный результат публикуй через publish_page.',
  '- Уточняющий вопрос уместен ТОЛЬКО если без него нельзя двигаться; иначе действуй по разумным допущениям.',
].join('\n');

function buildDeepBlock() { return DEEP_BLOCK; }

module.exports = {
  decideMode, readMode, writeMode, buildDeepBlock,
  THRESHOLD, MODEL, ENABLED, RESEARCH_HINT,
};
