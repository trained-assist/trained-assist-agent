// Answer Router — глубина ответа выбирается ЯВНЫМ действием пользователя, не угадывается.
//
// Модель (manual launch, переписано с авто-классификатора #505):
//   • reply   — дефолт: обычное сообщение → быстрый one-shot ответ, терминальный.
//   • workrun — тап по inline-кнопке «⏻ Запустить проработку» → тот же запрос
//               перезапускается как deep work-сессия (план + итерации + источники).
//               Sticky: режим durable-пишется в сайдкар и держится на всех ходах.
//   • clarify — тап по «❓ Уточнить задачу» → one-shot: агент задаёт 3-5 точечных
//               вопросов для хорошего ТЗ. Транзиентно (только этот ход), не пишется.
//
// Почему без классификатора: launch ручной, угадывать «хватит одного ответа или нет»
// не нужно — это снимает целый класс хрупкого кода (scoring/порог/LLM на входе) и
// done-detection. Дешевле в обслуживании, поведение предсказуемо.
//
// Дизайн-принципы (strict owner): durable на диске (переживает ходы/краш), fail-open
// в one-shot (нет сайдкара/ошибка чтения → текущее концизное поведение), никакого
// зависания. Ось ⟂ followup-controller (тот про «довести до конца между ходами»).

const fs = require('fs');
const path = require('path');

const MODES = new Set(['deep', 'clarify', 'oneshot']);
const MODES_DIR = 'answer-modes';

function _dir(workDir) { return path.join(workDir, MODES_DIR); }
function _file(workDir, sessionId) { return path.join(_dir(workDir), `${sessionId}.json`); }

function _atomicWrite(fp, data) {
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, fp);
}

// Нормализует mode из callback/payload в известное значение или null.
function normalizeMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return MODES.has(m) ? m : null;
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

// ── Блок для системного промпта в deep-режиме (проработка) ───────────────────
// Явно СНИМАЕТ cap «2-3 предложения» из agent-system-prompt.txt для этой сессии.
const DEEP_BLOCK = [
  '',
  '# РЕЖИМ ОТВЕТА: DEEP (проработка) — запущен пользователем для этой сессии',
  'Пользователь явно запустил проработку («⏻ Запустить проработку»). Для ЭТОЙ сессии',
  'правило «2-3 предложения / отвечай сразу» НЕ применяется — короткий ответ был бы',
  'недобросовестным.',
  '- Сначала короткий план: что нужно узнать/проверить и в каком порядке.',
  '- Собирай факты из НЕСКОЛЬКИХ источников (инструменты/сеть/диск), а не по памяти; итерируй.',
  '- Где выводы неочевидны — перепроверь их, прежде чем утверждать.',
  '- В конце — связный синтез с обоснованием. Длинный результат публикуй через publish_page.',
  '- Уточняющий вопрос уместен ТОЛЬКО если без него нельзя двигаться; иначе действуй по разумным допущениям.',
].join('\n');

// ── Блок для clarify (уточнение ТЗ) ──────────────────────────────────────────
// One-shot: агент НЕ выполняет задачу, а собирает недостающие вводные вопросами.
const CLARIFY_BLOCK = [
  '',
  '# РЕЖИМ ОТВЕТА: CLARIFY (уточнение) — запрошен пользователем для этого хода',
  'Пользователь нажал «❓ Уточнить задачу». НЕ выполняй задачу и НЕ давай решение сейчас.',
  'Вместо этого задай 3-5 КОРОТКИХ точечных вопросов, ответы на которые нужны для',
  'хорошего ТЗ (объём, критерии готовности, формат результата, ограничения, приоритеты).',
  '- Только вопросы, по одному на строку, без воды и без предисловий.',
  '- Спрашивай лишь то, что реально меняет решение; не переспрашивай очевидное.',
  '- В конце одной строкой: что делать дальше — ответить на вопросы или нажать',
  '  «⏻ Запустить проработку».',
].join('\n');

function buildDeepBlock() { return DEEP_BLOCK; }
function buildClarifyBlock() { return CLARIFY_BLOCK; }

module.exports = {
  MODES, normalizeMode, readMode, writeMode, buildDeepBlock, buildClarifyBlock,
};
