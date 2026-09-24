'use strict';

// ── HH domain intent patterns ─────────────────────────────────────────────
// Regex constants extracted from src/runner/intent-engine.js (issue #942 P2.1).
// Core loads these via loadDomainIntents('hh') — the intent-engine no longer
// hardcodes HH-specific patterns, only dispatches on names it loads.

const HH_STATUS_INTENT       = /hh.{0,10}статус|статус.{0,10}hh|статус.{0,10}(?:рекрут|вакансии|оценки|скоринга)|как.{0,15}дела.{0,15}hh|что.{0,15}активн.{0,15}hh|включена.{0,15}оценка|работает.{0,15}(?:скоринг|оценка|hh)|\/hh_status/i;
const HH_MY_VACANCIES_INTENT = /мои.{0,10}вакансии|список.{0,10}вакансий|какие.{0,10}вакансии|с чем работать|покажи.{0,15}вакансии|дай.{0,15}вакансии|мои.{0,10}активные|\/hh_vacancies|\/hh_switch/i;
const HH_FUNNEL_INTENT      = /сколько откликов|статистика воронки|что новенького|воронка кандидатов|статистика.{0,15}вакансии|кандидатов по.{0,15}вакансии|обновление.{0,15}вакансии|\/hh_funnel/i;
const HH_RESPONSES_INTENT   = /новые отклики|кто откликнулся|покажи.{0,10}кандидатов|новых кандидатов|список откликов|пришли отклики|новые кандидаты|\/hh_responses|\/hh_new/i;
const HH_ATS_EDITOR_INTENT  = /открой.{0,10}(?:ats|редактор|конфигуратор)|ats.{0,10}(?:редактор|editor|открой|настрой)|редактор.{0,10}ats|(?:скин|дай|пришл|покажи|дай).{0,20}(?:страниц|ссылк).{0,30}(?:настройк|candidate.?flow|ats|воронк|funnel)|страниц.{0,15}(?:настройк|candidate.?flow|ats|воронк|funnel)|candidate.?flow.{0,20}(?:страниц|ссылк|настройк|редактор)|\/hh_ats_editor/i;
const HH_REVIEW_PAGE_INTENT = /страниц.{0,20}ревью|ревью.{0,20}кандидат|страниц.{0,20}кандидат|открой.{0,15}кандидат|ссылк.{0,20}кандидат|покажи.{0,15}ссылк|хочу.{0,20}посмотреть.{0,20}откликнувш|кандидат.{0,30}(?:с оценк|с драфт|с баллами|с ответами)|(?:оценки|оценк).{0,20}кандидат|(?:покажи|открой|дай|хочу|нужн).{0,20}драфты|(?:список|покажи|кто).{0,30}кандидат.{0,60}(?:сообщени|написать|отправить|отказать|отклонить|драфт|ответ|нужно)|кому.{0,20}(?:написать|отправить|отказать|отклонить|сообщени)|покажи.{0,20}(?:список|всех).{0,20}кандидат|\/hh_review/i;
const HH_WHERE_PROMPT_INTENT = /где.{0,30}(?:промпт|конфиг|настройк|критери).{0,30}(?:ats|воронк|оценк|кандидат)|(?:промпт|конфиг|настройки).{0,30}(?:ats|воронк|оценк|кандидат)|как.{0,30}(?:посмотреть|правит|редактиров|изменить).{0,50}(?:промпт|конфиг|критери|воронк|оценк)/i;
const HH_SHOW_ATS_CONFIG_INTENT = /(?:покажи|посмотр|какие|что за|дай|вывед).{0,30}(?:правила|критери|оценк|ats|конфиг|настройк).{0,30}(?:кандидат|воронк|оценк|скрининг|ats)|(?:правила|критери|настройки).{0,20}(?:для|по).{0,10}(?:кандидат|оценк|скрининг)|ats.{0,15}правила|что.{0,15}у меня.{0,30}(?:правила|критери|оценк|ats)|\/hh_ats(?!\s*_)/i;
const HH_STYLE_INTENT        = /(?:обнови|загрузи|обновить|загрузить|настрой|поменяй|задай|update).{0,30}стиль|стиль.{0,30}(?:общения|переписки|сообщений|рекрут)|communication.{0,15}style|update.{0,15}style/i;
// /hh_evaluate — manual trigger of batch scoring (idempotent, no confirm needed)
const HH_EVALUATE_INTENT     = /\/hh_evaluate|\/hh_score|переоцени|обнови оценк|прогони оценку|оцени (?:всех |кандидат|новых|откликнувш)/i;
// /hh_send <id> <text> — show preview, then save to pending_send, await /hh_send_yes to actually send
const HH_SEND_INTENT         = /^\/hh_send(?:\s|$)|\/hh_send\s+\S+|отправь сообщени.{0,20}кандидат|напиши кандидат\s+\S/i;
const HH_SEND_CONFIRM_INTENT = /^\/hh_send_(?:yes|confirm|go)|^\/hh_send\s+(?:yes|да|go|confirm)\b/i;
const HH_SEND_CANCEL_INTENT  = /^\/hh_send_(?:no|cancel|stop|отмена)\b/i;
// /hh_reject [ids] — dry-run, then /hh_reject_yes to execute mass reject
const HH_REJECT_INTENT       = /^\/hh_reject(?:\s|$)|\/hh_reject\s+\S|массовый отказ|отклони (?:всех |кандидат)|откажи (?:всем|кандидат)/i;
const HH_REJECT_CONFIRM_INTENT = /^\/hh_reject_(?:yes|confirm|go)|^\/hh_reject\s+(?:yes|да|go|confirm)\b/i;
const HH_REJECT_CANCEL_INTENT  = /^\/hh_reject_(?:no|cancel|stop|отмена)\b/i;
// /hh_scan — manual trigger of proactive search outside cron schedule
const HH_SCAN_INTENT         = /\/hh_scan|запусти скан|просканируй|обнови скан|ручн.{0,15}скан/i;
// /hh_disconnect — revoke stored HH OAuth token. Lives OUTSIDE the hhConnected
// block in intent-engine.js because the action is symmetric: must work even when
// no token is saved (returns "HH не подключён"), and the intent must NOT be in
// hhIntents (which gates on hhConnected) — otherwise disconnected users could
// not type /hh_disconnect to clean up a stale token file.
// Credential mutations require a complete standalone request, never a substring
// in a specification, quotation, negation, or multi-message batch.
const HH_DISCONNECT_INTENT = /^\s*(?:\[Сообщение \d+\]\s*)?(?:\/hh_disconnect(?:@[a-z0-9_]+)?|(?:отключи(?:ть)?|удали(?:ть)?|выключи|сброс|reset) +(?:hh|хх|headhunter)(?: +авторизации)?|(?:hh|хх|headhunter) +(?:отключи|удали|сброс))\s*[.!]?\s*$/i;
// /hh publish draft — publish an existing vacancy draft to HeadHunter as a draft
const VACANCY_HH_PUBLISH_INTENT = /опубликуй.{0,20}(?:черновик.{0,15}(?:на\s+)?(?:hh|хх)|(?:на\s+)?(?:hh|хх).{0,15}черновик)|загрузи.{0,20}(?:на\s+)?(?:hh|хх)|публикуй.{0,20}(?:на\s+)?(?:hh|хх)|сохрани.{0,20}черновик.{0,20}(?:hh|хх)/i;
// /hh prep draft — "подготовь черновик вакансии на HH": fast-path push when draft_ready, else single-shot collect
const VACANCY_PREP_DRAFT_INTENT = /подготов.{0,20}(?:черновик|драфт|вакансию).{0,30}(?:hh|хх|хэдхантер)|создай.{0,20}(?:черновик|драфт).{0,30}(?:hh|хх|хэдхантер)|(?:черновик|драфт).{0,30}(?:в|на)\s+(?:hh|хх|хэдхантер)|положи.{0,20}(?:вакансию|на).{0,20}(?:hh|хх|хэдхантер)|вакансию.{0,20}(?:на|в)\s+(?:hh|хх|хэдхантер)|подготов.{0,10}(?:вакансию|черновик)/i;

const HH_SERVICE_CHANGE_INTENT = /(?:почин|исправ|прокач|доработ|устарел|отстала от жизни|сервис.{0,20}(?:стар|подост)|логик.{0,50}(?:архив|звезд|звёзд)|(?:кнопк|ссылк|апдейт).{0,30}(?:не работа|стар|не включ))/i;

// Only standalone stop commands mutate state. Longer complaints go to the full agent.
const HH_NOTIFY_OFF_INTENT = /^\s*(?:\[Сообщение \d+\]\s*)?(?:\/hh_notify_off(?:@[a-z0-9_]+)?|(?:выключи|отключи|останови)(?:,?\s+пожалуйста,?)?\s+(?:автопоиск|холодный поиск|уведомления(?:\s+(?:о новых кандидатах|холодного поиска|о холодном поиске|hh|хх))?))(?:,?\s+пожалуйста)?[.!]?\s*$/i;
const HH_NOTIFICATION_REQUEST = /\/hh_notify_(?:on|off)|автопоиск|уведомлен[\s\S]{0,160}(?:кандидат|холодн|hh|хх)|(?:кандидат|холодн)[\s\S]{0,160}уведомлен/i;
module.exports = {
  HH_NOTIFY_OFF_INTENT,
  HH_NOTIFICATION_REQUEST,
  HH_SERVICE_CHANGE_INTENT,
  HH_STATUS_INTENT,
  HH_MY_VACANCIES_INTENT,
  HH_FUNNEL_INTENT,
  HH_RESPONSES_INTENT,
  HH_ATS_EDITOR_INTENT,
  HH_REVIEW_PAGE_INTENT,
  HH_WHERE_PROMPT_INTENT,
  HH_SHOW_ATS_CONFIG_INTENT,
  HH_STYLE_INTENT,
  HH_EVALUATE_INTENT,
  HH_SEND_INTENT,
  HH_SEND_CONFIRM_INTENT,
  HH_SEND_CANCEL_INTENT,
  HH_REJECT_INTENT,
  HH_REJECT_CONFIRM_INTENT,
  HH_REJECT_CANCEL_INTENT,
  HH_SCAN_INTENT,
  HH_DISCONNECT_INTENT,
  VACANCY_HH_PUBLISH_INTENT,
  VACANCY_PREP_DRAFT_INTENT,
};
