'use strict';

const fs = require('fs');
const path = require('path');

// Single source of truth for the candidate-message system prompt.
//
// This used to be copy-pasted independently in src/server.js (/hh/generate-message,
// the real path the /hh/review page hits), src/hh-scoring.js (background auto-draft
// job after hh_batch_evaluate), and src/mcp-skills/tools/90-hh.js (chat-triggered
// hh_regenerate_messages / hh_draft_review_page). Editing one copy silently did not
// affect the others. Edit the prompt HERE — all three call sites render from it.
//
// The base instructions below are also editable per-recruiter without a code deploy,
// via the /hh/style page: a non-empty `agent-tokens/<user>/hh-message-base-prompt`
// file overrides MESSAGE_SYSTEM_BASE entirely. Call loadBaseOverride() at each call
// site (same pattern already used for the hh-message-style file) and pass the result
// as `baseOverride`.

const BASE_PROMPT_FILENAME = 'hh-message-base-prompt';

function loadBaseOverride(tokensBase, username) {
  try {
    const file = path.join(tokensBase, String(username), BASE_PROMPT_FILENAME);
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    }
  } catch { /* ignore */ }
  return null;
}

const MESSAGE_SYSTEM_BASE = 'Ты — рекрутер. ВСЕГДА пиши сообщение, даже если данных мало.\n' +
  'Пишешь сообщение кандидату на HeadHunter. Это может быть первое сообщение или ответ внутри уже идущей переписки — на входе всегда полная история диалога и результат ATS-оценки кандидата (скор, вердикт).\n\n' +
  'Если это первое сообщение (истории переписки ещё нет): 1) Приветствие с именем 2) 1-2 предложения что в резюме зацепило 3) короткое описание роли 4) конкретный вопрос для квалификации (самый важный пробел из требований вакансии) 5) призыв к действию.\n\n' +
  'Если кандидат уже отвечал в переписке: прочитай его ответы и учти скор/вердикт. Если скор хороший/проходной и ответы кандидата по делу, или скор высокий сразу — аккуратно, ничего не обещая, предложи следующий шаг: сейчас планируем процесс собеседований, предложи созвониться. Если скор низкий или в ответах остались пробелы — задай уточняющий вопрос по самому важному пробелу.\n\n' +
  'Если кандидат ещё не ответил на наше последнее сообщение: напиши короткий вежливый follow-up без давления, упомяни, что писал(а) ранее.\n\n' +
  'Если это отказ: напиши вежливый отказ — уважительно, тепло, без объяснения причин, пожелай удачи в поиске.\n\n' +
  'Про время звонка — ВАЖНО: если ниже в контексте дан блок "Доступность для звонка" с реальными данными — используй только их (предложи слот из указанной доступности или дай ссылку на запись). Если такого блока нет — НЕ придумывай время и дату (никаких «утро», «завтра днём», «в среду в 15:00»); вместо этого спроси у кандидата, когда ему удобно созвониться.\n\n' +
  'Форматирование: каждый вопрос — отдельная строка (через \\n). Между смысловыми блоками — пустая строка. Не пиши всё в один абзац.\n' +
  'Длина: 4-7 предложений (follow-up и отказ — 2-3). Не используй шаблонные фразы. Пиши от первого лица на русском языке.\n' +
  'НЕЛЬЗЯ: обещать перезвонить или позвонить — только переписка в HH. Не используй слова «перезвоню», «позвоню», «свяжусь по телефону», «созвонимся». Не обещай трудоустройство или конкретные условия — только предлагай следующий шаг процесса.\n' +
  'НЕЛЬЗЯ оставлять плейсхолдеры в квадратных или фигурных скобках (например «[Ваше имя]», «{company}») — если имя рекрутера не задано явно в контексте, просто не называй себя по имени, представься только по компании/роли ("Я — рекрутер компании X").';

const REJECTION_SYSTEM_BASE = 'Ты — рекрутер. Напиши вежливый отказ кандидату.\n' +
  'Тон: уважительный, тёплый, без объяснения причин. Пожелай удачи в поиске. 2-3 предложения. Пиши на русском языке.';

// interview_config lives inside ats_config.json (set via the ATS editor). Only treat
// it as real, usable availability if invite_call_enabled is on AND there's actual
// availability text or a booking link — otherwise the model has nothing concrete to
// offer and must ask the candidate instead of inventing a time (see #606).
function hasRealAvailability(interviewConfig) {
  const ic = interviewConfig || {};
  return !!(ic.invite_call_enabled && (ic.availability?.trim() || ic.booking_url?.trim()));
}

function buildAvailabilityBlock(interviewConfig) {
  if (!hasRealAvailability(interviewConfig)) return '';
  const ic = interviewConfig;
  const notes = [];
  if (ic.level) notes.push(`Уровень позиции: ${ic.level}.`);
  if (ic.requirements) notes.push(`Требования к звонку: ${ic.requirements}.`);
  if (ic.availability) notes.push(`Доступность рекрутера: ${ic.availability}.`);
  if (ic.booking_url) notes.push(`Ссылка для самостоятельной записи: ${ic.booking_url}.`);
  return `\n\nДоступность для звонка:\n${notes.join('\n')}`;
}

// message_config.json (set via the recruiter-identity page): agency/name/signature/rules.
function buildRecruiterIdentity(msgCfg) {
  if (!msgCfg) return '';
  return [
    msgCfg.represent_as || (msgCfg.agency ? `Ты пишешь от лица агентства ${msgCfg.agency}.` : ''),
    msgCfg.recruiter_name ? `Твоё имя: ${msgCfg.recruiter_name}.` : '',
    msgCfg.signature ? `Подпись в конце каждого сообщения: «${msgCfg.signature}».` : '',
    ...(msgCfg.rules || []).map(r => `ПРАВИЛО: ${r}`),
  ].filter(Boolean).join('\n');
}

function buildMessageSystemPrompt({ vacancyContext = '', recruiterCtx = '', commStyle = '', baseOverride = '' } = {}) {
  let prompt = (baseOverride || MESSAGE_SYSTEM_BASE) + (vacancyContext ? '\n\n## Контекст вакансии\n' + vacancyContext : '');
  if (recruiterCtx) prompt += `\n\n## Идентичность рекрутера\n${recruiterCtx}`;
  if (commStyle) prompt += `\n\n## Стиль общения рекрутера\n${commStyle}`;
  return prompt;
}

function buildRejectionSystemPrompt({ recruiterCtx = '', commStyle = '' } = {}) {
  let prompt = REJECTION_SYSTEM_BASE;
  if (recruiterCtx) prompt += `\n\n## Идентичность рекрутера\n${recruiterCtx}`;
  if (commStyle) prompt += `\n\n## Стиль рекрутера\n${commStyle}`;
  return prompt;
}

module.exports = {
  hasRealAvailability,
  buildAvailabilityBlock,
  buildRecruiterIdentity,
  buildMessageSystemPrompt,
  buildRejectionSystemPrompt,
  loadBaseOverride,
  BASE_PROMPT_FILENAME,
  DEFAULT_MESSAGE_BASE: MESSAGE_SYSTEM_BASE,
};
