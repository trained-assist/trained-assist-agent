'use strict';

// ── Intent-dispatch engine ────────────────────────────────────────────────────
// All ~55 INTENT regex constants, getQuickAnswer(), verifyQuickAnswerIntent(),
// and runQuickAnswer() extracted from runner.js.
// runner.js re-exports these so call sites are unchanged.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const sessions = require('./session-store');
const { generateSummary } = require('./session-summary');
const projects = require('./projects');
const {
  listConnectedServices,
  revokeService,
  getSecretsLog,
  generateConnectLink,
  SERVICE_DISPLAY,
} = require('./user-tokens');
const { hhMyVacancies, hhFunnelStats, hhNewResponses, hhAtsEditor, hhReviewPage, hhWherePrompt, hhShowAtsConfig, hhStylePage, hhStatus, readActiveVacancy, hhSendPreview, hhSendConfirm, hhSendCancel, hhRejectDryRun, hhRejectConfirm, hhRejectCancel, hhBatchEvaluate, hhManualScan } = require('./hh-quick');
const { readVacancyState, initVacancyState, appendVacancyMessage, writeVacancyState, generateVacancyFromMessages, publishVacancyPage, publishToHH, getMissingFields } = require('./hh-vacancy');
const { loadUserSiteIntents } = require('./user-sites');
const { deleteServiceAccount: deleteGdriveSA } = require('./mcp-skills/tools/50-gdrive');
const persona = require('./persona');
const candidateReport = require('./candidate-report');
const profiles = require('./profiles');
const { savePassword: saveWebPassword, generatePassword: genWebPassword } = require('./web-auth');
const { getUsageTotals } = require('./usage-store');

// ── Quick answers — bypass Claude for known setup/secrets patterns ───────────
// Returns a string if the task matches, null otherwise.

const STALE_PR_ALARM_INTENT = /Проверь PR #\d+: CI статус, конфликты/;
const BUG_REPORT_INTENT     = /^\/bugreport\b|баг.{0,15}репорт|bug.{0,10}report|сообщи.{0,15}о.{0,10}(баг|проблем|ошибк)|создай.{0,15}issue|репорт.{0,10}бага|пожаловаться.{0,20}(бот|агент|баг)/i;
const SETUP_INTENT          = /подключ|connect|настро|интегр|привяз|как.*добав|могу.*отправ|зайт|авториз|setup|подрубить/i;
const INN_CAPABILITY_INTENT  = /(?:скил|skill|умееш|можешь|есть.{0,30}возможн|есть.{0,30}функц|есть.{0,30}инструм|что.{0,20}умееш).{0,80}(?:инн|огрн|компани|директор|выручк|реквизит)/i;
// Only capability/question words, NOT action verbs (собери/собрать/найди → those are tasks, go to Claude)
const EXPO_CAPABILITY_INTENT = /(?:скил|skill|умееш|можешь|есть.{0,30}(?:скил|инструм|возможн)).{0,80}(?:участник|экспонент|выставк|expo)/i;
const GC_CAPABILITY_INTENT   = /(?:умееш|можешь|есть.{0,30}(?:скил|инструм|возможн|функц)|что.{0,20}умееш).{0,80}(?:геткурс|getcourse|курс|урок|ученик|школ)/i;
const AUDIO_CAPABILITY_INTENT = /(?:умееш|можешь|поддержива|транскрибир|распознаёш|распознаеш|расшифр).{0,60}(?:аудио|голосов|голос\b|запись|речь|звук|mp3|wav|ogg|voice|audio)|(?:транскрибац|транскрипц|расшифровк|распознавани).{0,40}(?:аудио|голосов|речи|записей|звука|файлов?)|(?:аудио|голосов).{0,40}(?:транскрибац|транскрипц|расшифровк|распознавани)|(?:умееш|можешь).{0,40}(?:из\s+)?(?:аудио|голосовых?\s+сообщений?|голосов(?:ого)?|записей?)\s+(?:в\s+текст|получить\s+текст|сделать\s+текст)|(?:можн[оа]|умееш|можешь).{0,20}(?:прислать|отправить|скинуть)\s+(?:аудио|голосов)/i;
const SECRETS_LIST_INTENT   = /^\/secrets_list$|список.{0,15}подключённых|какие.{0,15}подключ|покажи.{0,15}сервис|мои.{0,15}доступ/i;
const SECRETS_LOG_INTENT    = /^\/secrets_log$|история.{0,15}доступ|лог.{0,15}секрет|обращени.{0,15}секрет/i;
const REVOKE_INTENT         = /отзов|revoke|удал.{0,10}доступ|отключ.{0,10}сервис|убер.{0,10}доступ/i;
const REVOKE_SERVICE_RE     = /(github|гитхаб|weeek|вик|nalog|налог|нпд|самозан|figma|фигма|notion|linear|tilda|тильда|gdrive|гугл|google|dadata)/i;
const REVOKE_CONFIRM_RE     = /^да[,.]?\s*(удал|отключ|подтвер|confirm)|^confirm$|^yes$/i;
// "на какой email шарить", "почта SA", "дай адрес google" — always read from disk, never hallucinate
const GDRIVE_SA_EMAIL_INTENT  = /(?:почт|email|e-mail|адрес).{0,40}(?:сервис|service|sa\b)|(?:сервис|service|sa\b).{0,40}(?:почт|email|e-mail|аккаун)|дай.{0,30}(?:почт|email|адрес).{0,30}(?:гугл|google|drive|аккаун)|на\s+(?:какой|что|какую).{0,30}(?:шар|поделить|пошар)|куда.{0,20}(?:шар|поделить|пошар)/i;
// "пошарить таблицу тебе", "поделиться файлом", "как дать доступ к гугл" — needs SA email answer
// verb forms only (пошари/пошарить/шари), not past/adj (пошаренные/пошарено — those go to LIST)
// Past tense "пошарил/поделился" + "ты видишь/можешь" = "I already shared, can you see it?" — separate intent
const GDRIVE_CONFIRM_INTENT   = /(?:пошарил[аи]?|поделил(?:ся|ась)|шарил[аи]?|дал[аи]?\s+доступ).{0,60}(?:видишь|можешь|проверь|посмотри|видел|открылся|доступно|работает)|(?:видишь|можешь|открылся|доступно|работает).{0,60}(?:пошарил[аи]?|поделил(?:ся|ась)|шарил[аи]?|папк|файл|документ)/i;
const GDRIVE_SHARE_INTENT     = /(?:пошар[иьюшт]|поделить|шар[иьюшт]|дать?\s+доступ).{0,50}(?:гугл|google|таблиц|докс|docs|sheets|файл|документ)|(?:гугл|google|таблиц|докс|docs|sheets|файл|документ).{0,50}(?:пошар[иьюшт]|поделить|шар[иьюшт]|дать?\s+доступ)/i;
// "мои файлы гугл", "что мне пошарено", "список документов"
const GDRIVE_LIST_INTENT      = /(?:мои|покажи|список|какие).{0,20}(?:файл|документ|гугл|google|пошарен)|(?:что|какие).{0,30}(?:пошарено|пошарил|открыл)|gdrive.{0,20}(?:файл|документ|список)/i;
// "пошарил", "дал доступ", "открыл доступ", "готово" after gdrive setup — user confirming they shared
const GDRIVE_SHARED_CONFIRM_INTENT = /^(?:пошарил|поделился|расшарил|дал\s+доступ|открыл\s+доступ|готово|ок|сделал|расшарен|добавил)\.?$/i;
// "можешь читать гугл шит", "умеешь работать с гугл таблицами"
const GDRIVE_CAPABILITY_INTENT = /(?:можешь|умеешь|можно|способен|поддержива).{0,40}(?:гугл|google|sheets|docs|csv|таблиц|документ|гшит|spreadsheet)/i;
const GDRIVE_NOTIF_OFF_INTENT  = /\/gdrive_notif_off|\/google_drive_sharing_notifications_switch_off|выключи.{0,30}(?:уведомлени.{0,30}(?:гугл|google|drive|шаринг)|шаринг.{0,30}уведомлени)|отключи.{0,30}(?:уведомлени.{0,30}(?:гугл|google|drive|шаринг)|шаринг.{0,30}уведомлени)|не.{0,10}уведомля.{0,30}(?:гугл|google|drive|шаринг|файл)|без.{0,20}уведомлени.{0,30}(?:гугл|google|drive|шаринг)/i;
const GDRIVE_NOTIF_ON_INTENT   = /\/gdrive_notif_on|\/google_drive_sharing_notifications_switch_on|включи.{0,30}(?:уведомлени.{0,30}(?:гугл|google|drive|шаринг)|шаринг.{0,30}уведомлени)|верн.{0,20}уведомлени.{0,30}(?:гугл|google|drive|шаринг)/i;
const SESSIONS_INTENT       = /^\/sessions$|мои.{0,10}диалог|мои.{0,10}сессии|список.{0,10}диалог|покажи.{0,10}истори|мои.{0,10}задач/i;
// /bug_or_feature — FAST capture: last messages + logs + note → GitHub issue, no Claude session.
// Distinct from the older free-text BUG_REPORT_INTENT (line ~67) which spawns a full session.
const BUG_OR_FEATURE_INTENT = /^\/(?:bug_or_feature|bug|feature|баг|фича|report|репорт)(?=\s|$)/i;
// "Подробнее N" / "/session N" / "подробнее о 3" — expand one session from the last /sessions list
const SESSION_DETAIL_INTENT = /^\/(?:sessions?|диалог)\s*(\d{1,2})\b|^подробнее(?:\s+(?:о|про|по))?\s*(?:диалог[ае]?\s*|сесси[июя]\s*|№\s*)?(\d{1,2})\b|^(\d{1,2})\s*подробнее/i;
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
// block (runner.js:1334) because the action is symmetric: must work even when no
// token is saved (returns "HH не подключён"), and the intent must NOT be in
// hhIntents (which gates on hhConnected) — otherwise disconnected users could
// not type /hh_disconnect to clean up a stale token file.
const HH_DISCONNECT_INTENT   = /\/hh_disconnect|отключи(?:ть)?\s*(?:hh|хх|headhunter)|удали(?:ть)?\s*(?:hh|хх|headhunter)|hh.{0,15}(?:отключи|удали|разъедин|сброс)|сброс.{0,15}(?:hh|хх|headhunter|авторизац)|выключи.{0,15}(?:hh|хх|headhunter)|reset.{0,15}hh/i;
const ILLUSTRATE_CAPABILITY_INTENT = /(?:умееш|можешь|есть.{0,30}(?:скил|инструм|возможн|функц)|что.{0,20}умееш).{0,80}(?:иллюстр|нарисова|рисовать|картинк|изображен|illustrat|draw|image.gen)/i;
const ILLUSTRATE_ENABLE_INTENT = /включ.{0,20}(?:рисован|иллюстр|картинк|рисунок)|добав.{0,20}(?:рисован|иллюстр|генерац)|активируй.{0,20}(?:рисован|иллюстр|скил.{0,10}рисован)|\/enable_illustrate/i;
// Matches concrete draw commands with subject content — these go to Claude even when skill is enabled
const ILLUSTRATE_DRAW_COMMAND = /(?:нарисуй|нарисовать|создай.{0,20}(?:иллюстр|картинк|схем)|сделай.{0,20}(?:иллюстр|картинк|схем)|покажи.{0,20}(?:схем|как устроен|анатоми))\s+\S.{5,}/i;
// Developer intent — matches "разработай X", "создай приложение", "сделай сервис" etc.
// NOT vacancy creation ("создай вакансию") or illustrate ("создай иллюстрацию") — those have dedicated intents.
const DEV_INTENT = /разраб[оа][тк]|(?:создай|сделай|напиш[иь]).{0,40}(?:приложени|сервис(?!\s*аккаунт)|бот(?!\s*токен|\s*ключ)(?!\s*weeek|\s*hh|\s*tilda|\s*nalog)|сайт(?!\s*с\s+tilda)(?!\s+tilda)|систем|скрипт(?!\s+для\s+(?:выставки|expo))|библиотек|пакет|модул|апи-сервис)|implement\s+\S|build\s+(?:app|service|bot|api)|develop\s+(?:app|feature|bot)/i;
const NEW_JOB_INTENT            = /новая вакансия|new job post|\/new_job_post|создать вакансию|добавить вакансию|создай вакансию/i;
const STOP_TASK_INTENT          = /^\/stop$|^стоп[!.?]?$|^stop[!.?]?$|^остановись[!.?]?$|^отмена[!.?]?$/i;
const GTD_STOP_INTENT           = /^\/gtd_stop$|^\/stop_gtd$|^\/checklist_turn_off$|стоп.{0,5}gtd\b|gtd.{0,5}стоп\b/i;
const ACTIVE_CHECKLIST_INTENT   = /^\/active_checklist$/i;
const WAKEUP_INTENT             = /^\/wakeup$|^wakeup[!.?]?$|^разморозь[!.?]?$|^размораживай[!.?]?$|^очнись[!.?]?$|^просн[иись]+[!.?]?$|^завис[!.?]?$|^зависло[!.?]?$|разбуди.{0,10}бот|рестарт.{0,10}бот|перезапуст.{0,10}бот|бот.{0,10}завис|агент.{0,10}завис/i;
const SKIP_TASK_INTENT          = /^\/skip(?:@\w+)?$/i;
const VACANCY_DONE_INTENT       = /^всё$|^все$|^готово$|^хватит$|^достаточно$|^запускай$|^стоп, всё$|^всё, запускай$|^ок, всё$/i;
const VACANCY_CANCEL_INTENT     = /отмен.{0,20}вакансии|отмен.{0,20}созда|выйт.{0,15}режим|стоп.{0,10}вакансия|сброс.{0,15}вакансии|\/cancel_vacancy/i;
const VACANCY_PUBLISH_PAGE_INTENT = /публику[йе].{0,20}страниц|опубликуй.{0,20}(?:страниц|лендинг)|создай.{0,20}(?:страниц.{0,20}вакансии|лендинг)|сгенерир.{0,20}страниц|сделай.{0,20}страниц.{0,20}вакансии|страниц.{0,30}(?:вакансии.{0,30})?(?:сгенерир|создай|опубликуй|сделай)|страниц.{0,20}готов/i;
const VACANCY_HH_PUBLISH_INTENT   = /опубликуй.{0,20}(?:черновик.{0,15}(?:на\s+)?(?:hh|хх)|(?:на\s+)?(?:hh|хх).{0,15}черновик)|загрузи.{0,20}(?:на\s+)?(?:hh|хх)|публикуй.{0,20}(?:на\s+)?(?:hh|хх)|сохрани.{0,20}черновик.{0,20}(?:hh|хх)/i;
// "Подготовь черновик вакансии на HH" — fast-path when vacancy data already exists or is provided inline
const VACANCY_PREP_DRAFT_INTENT   = /подготов.{0,20}(?:черновик|драфт|вакансию).{0,30}(?:hh|хх|хэдхантер)|создай.{0,20}(?:черновик|драфт).{0,30}(?:hh|хх|хэдхантер)|(?:черновик|драфт).{0,30}(?:в|на)\s+(?:hh|хх|хэдхантер)|положи.{0,20}(?:вакансию|на).{0,20}(?:hh|хх|хэдхантер)|вакансию.{0,20}(?:на|в)\s+(?:hh|хх|хэдхантер)|подготов.{0,10}(?:вакансию|черновик)/i;
const USAGE_INTENT          = /^\/usage$|сколько.{0,20}потратил|токен.{0,20}статистик|использован.{0,20}токен|стоимость.{0,20}сессий|расход.{0,20}токен/i;
// /usage klod, /usage codex — CLI subscription rate-limit check (Claude Code / Codex CLI
// OAuth session on THIS VM: ~/.claude/.credentials.json, ~/.codex/auth.json). Distinct from
// USAGE_INTENT above (per-profile token-SPEND stats) — this reads the operator's own shared
// CLI login, so it's gated to OWNER_USERNAME: a tenant profile has no reason to see the
// operator's personal Claude/Codex subscription usage.
const CLI_USAGE_INTENT      = /^\/?usage\s+(klod|codex|клод|кодекс)\b/i;
const OWNER_USERNAME        = 'trained-assist-product-owner';
const CLI_USAGE_SCRIPTS     = { klod: '/home/vova/bin/usage-klod.sh', codex: '/home/vova/bin/usage-codex.sh' };
const CONTEXT_OFF_INTENT    = /^\/context_off$|выключи.{0,15}контекст|скрой.{0,15}контекст|отключи.{0,15}(?:статус|контекст|карточк)/i;
const CONTEXT_ON_INTENT     = /^\/context_on$|включи.{0,15}контекст|покажи.{0,15}контекст|включи.{0,15}(?:статус|карточк)/i;
const CALLTIPS_PREPARE_INTENT = /(?:подготов|составь|сделай|создай).{0,30}(?:план|вопросы|интервью).{0,30}(?:для|с|звонк)|подготов.{0,20}(?:к|для).{0,10}звонк|план.{0,20}(?:интервью|звонка|встречи).{0,30}(?:с|для)|call.?tips.{0,20}(?:для|с|план|prepare)/i;
// Candidate-for-client report (issue #982): persistent recruiter requirements log per candidate.
// «добавь в требования [к профилю Чайка]: не упоминать удалёнку» / /report_add [имя]: текст
// → group 1 = command head, 2 = optional «к профилю <имя>» middle, 3 = the requirement text.
const REPORT_NOTE_ADD_INTENT  = /^(\/report_add(?:@\S+)?|добавь(?:те)?\s+в\s+требования)([^:\n]{0,80}?)\s*:\s*([\s\S]+)$/i;
// «покажи текущие требования к профилю [Чайка]» / /report_notes [имя]
const REPORT_NOTE_SHOW_INTENT = /^\/report_notes(?:@\S+)?(?:\s+(.+))?$|^(?:покажи|дай|открой|какие|что за)\s+(?:мне\s+)?(?:текущие\s+|мои\s+)?требования\s+(?:к|для)\s+(?:профил\S*|отч[её]т\S*)(?:\s+(.+))?$/i;
// «умеешь делать профиль кандидата для клиента?» — capability question only (NOT the task itself)
const REPORT_CAPABILITY_INTENT = /(?:умееш|можешь|можно|есть.{0,30}(?:возможн|функц|скил|инструм)|как.{0,25}(?:сделать|подготовить|получить|оформить)).{0,60}(?:профил\S*\s+кандидат|отч[её]т\S*\s+(?:по|о)\s+кандидат|кандидат\S*\s+для\s+клиент|резюме\s+для\s+клиент)/i;
const PING_INTENT           = /^\/ping$|^ты живой|^ты онлайн|^ты работаешь|^привет бот|^ping$/i;
const HELP_INTENT           = /^\/help$|^\/start$|что.{0,10}умееш|чем.{0,10}помож|какие.{0,10}возможн|список.{0,10}команд|помощь/i;
// /persona command (aliases /role /роль /персона /character /характер). Cyrillic word boundaries:
// JS \b doesn't fire after a Cyrillic letter, so terminate the command with (?=\s|$) instead of \b.
const PERSONA_INTENT        = /^\/(?:persona|role|роль|персона|character|характер)(?=\s|$)/i;
// Published guide: what a persona is + how to write a good one (patterns/examples).
const PERSONA_GUIDE_URL     = 'https://instant-publish.trainedassist.store/p/persona-guide';
// /project — list / switch / create projects. Lets the user steer which project new
// sessions bind to (see projects.js + the project-binding block in run()).
const PROJECT_INTENT        = /^\/(?:projects?|проекты?|проект)(?=\s|$)/i;
// /switch2klod, /switch2codex (or natural "switch to codex" / "переключись на клод") — which
// CLI (Claude Code vs Codex) runs THIS CHAT's tasks going forward. Any profile can flip its
// own chat — unlike CLI_USAGE_INTENT above, this isn't reading the operator's shared VM
// subscription, it's a per-profile setting. Storage: profile.json engineByChat[chatId]
// (see profiles.getEngine/setEngine) — falls back to the profile-wide `engine` default
// (scripts/set-engine.mjs) when this chat has no override. A task already running keeps
// its engine; the switch takes effect on the next task started in this chat.
// \b doesn't fire after a Cyrillic letter in JS, so both alternatives end on
// (?=\s|$) instead (same fix as PERSONA_INTENT above).
const ENGINE_SWITCH_INTENT  = /^\/?switch\s*2\s*(klod|codex|opencode|клод|кодекс)(?:@\S+)?(?=\s|$)|(?:переключ\S*|switch)\s+(?:меня\s+)?(?:на|to)\s+(klod|claude|codex|opencode|клод|кодекс)(?=\s|$)/i;
const OC_PROFILE_INTENT = /^\/oc_(value|quality|free|mimo|ru(?:ssian-recruiter)?|lavish-luna|ll)(?:@\S+)?\b|^\/oc\s+(value|quality|free|mimo|ru(?:ssian-recruiter)?|lavish-luna|ll)\b/i;
const AGENT_INFO_INTENT = /^\/(?:get_agent_info|agent_info|info)(?:@\S+)?(?=\s|$)/i;
// /get_webpass — PURE SELF-SERVICE for every user. Generates + reveals a fresh web password
// for the CALLER'S OWN profile, writing it to ~/agent-tokens/<user>/.webpasswd (the SAME
// store the site verifies against via POST /web/verify). This is the single fix for "the
// site password only exists for 2 of 11 profiles" — any user mints a working password on
// demand. The password store is scrypt-hashed (one-way), so this always ROTATES: each call
// sets a new password and the previous one dies.
// Deliberately NO cross-profile targeting and NO admin/chat-id gate: resetting your own
// credential can't escalate anything, and every user can self-serve, so cross-profile
// issuance is redundant. This also kills the group-chat-id / @botname gating that kept
// breaking. Tolerate a trailing @botname (Telegram appends it in groups) + ignore any args.
const GET_WEBPASS_INTENT    = /^\/(?:get_webpass|webpass|вебпароль)(?:@\S+)?(?=\s|$)/i;
// Explicit request patterns only — NOT "целевых компаний" buried in a long instruction
const EXPO_CRITERIA_INTENT  = /требовани.{0,20}(?:целев|квалиф)|критери.{0,20}(?:целев|отбор|выставк)|целев.{0,20}(?:критери|требовани)|покажи.{0,15}критери|мои.{0,10}критери|expo.{0,10}criteria|target.{0,10}criteria/i;
const EXPO_STATUS_INTENT    = /статус.{0,20}(?:пайплайн|pipeline|выставк|обработк)|pipeline.{0,10}статус|сколько.{0,15}целевых|сколько.{0,15}компаний.{0,20}(?:выставк|обработан|pipeline)|expo.{0,10}статус/i;
const EXPO_SITE_CONFIG_INTENT = /фильтр.{0,20}(?:сайт|каталог|выставк|диапазон)|сайт.{0,20}фильтр|диапазон.{0,20}(?:выручк|сайт)|настройк.{0,20}(?:сайт|каталог)|какие.{0,10}диапазон|revenue.*filter|site.*filter/i;
// Checks whether a service is connected ("github подключен?", "статус nalog") — NOT imperative "подключи"
const SERVICE_STATUS_INTENT = /(?:подключён|подключен|connected|активен|добавлен|работает|есть ли|подключён ли).{0,30}(?:github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс)|(?:github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс).{0,20}(?:подключён|подключен|connected|активен|добавлен|работает|статус|status)/i;
const SERVICE_STATUS_RE     = /(github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс)/i;

const TRUST_FOOTER = '\n\n🔒 Данные для входа не видны в переписке с ботом — они поступают прямо на сервер и хранятся в изолированном хранилище, отдельно от ИИ. Все обращения фиксируются в /secrets_log. Отзыв доступов: /secrets_list';

// service: label in /connect/:service route and agent-tokens filename
const QUICK_SETUPS = [
  {
    match: /github|гитхаб/i,
    service: 'github',
    hint: 'Где взять: github.com/settings/tokens → Generate new token (classic) → scopes: repo, read:org',
  },
  {
    match: /weeek|вик(?!тор)/i,
    service: 'weeek',
    hint: 'Где взять: Weeek → Settings → Integrations → API → Generate token',
  },
  // Google Drive: pass to Claude so it calls gdrive_setup automatically — no manual step for user
  // { match: /google.?drive|гугл.?диск|gdrive/i, service: null, hint: '...' },
  {
    match: /tilda|тильда/i,
    service: 'tilda-creds',
    hint: 'Email и пароль не попадут в чат — введёшь через защищённую форму, я войду автоматически.',
  },
  {
    match: /nalog|налог|нпд|самозан/i,
    service: 'nalog-creds',
    hint: 'Введёшь логин и пароль Госуслуг через защищённую форму — данные не попадут в чат.',
  },
  {
    match: /getcourse|геткурс|get.?course/i,
    service: 'getcourse',
    hint: 'Введи домен + API ключ (L1: ученики/заказы) и/или логин+пароль (L2: курсы/уроки).',
  },
  {
    match: /head.?hunter|\bhh\b|хантер/i,
    service: 'hh',
    hint: 'Войдёшь через hh.ru как работодатель — страница защищена, токен не проходит через чат.',
  },
  {
    match: /подключи.{0,20}сайт|добавь.{0,20}сайт|connect.{0,15}site|подключить.{0,20}сайт/i,
    service: 'site',
    hint: 'Введи адрес сайта, логин и пароль — я автоматически зайду и изучу его.',
  },
];

// Render the /sessions list. Prefers the durable summary.title over the raw topic;
// no LLM here — reads whatever summaries are already on disk (async enrichment
// happens in runQuickAnswer before this).
function renderSessionsList(list) {
  const lines = list.map((s, i) => {
    const d = new Date(s.lastAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    const title = (s.summary && s.summary.title) ? s.summary.title : s.topic.slice(0, 60);
    return `${i + 1}. ${title} (${d}, ${s.messageCount} сообщ.)`;
  });
  return '💬 Последние диалоги:\n' + lines.join('\n') + '\n\nПодробнее о любом — напишите «Подробнее N» (номер из списка).';
}

// Render the expanded card for one session from its durable summary.
function renderSessionDetail(meta, n) {
  const d = new Date(meta.lastAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const sum = meta.summary || {};
  const out = [`📄 Диалог ${n}: ${sum.title || meta.topic}`, `🕒 ${d} · ${meta.messageCount} сообщ.`, ''];
  if (sum.gist) out.push(sum.gist);
  if (sum.ended) out.push('', `🏁 Чем закончилось: ${sum.ended}`);
  if (sum.key_points && sum.key_points.length) {
    out.push('', 'Ключевые моменты:');
    for (const kp of sum.key_points) out.push(`• ${kp}`);
  }
  if (!sum.gist && !sum.ended && (!sum.key_points || !sum.key_points.length)) {
    out.push('(резюме недоступно — покажу тему)', '', meta.topic);
  }
  return out.join('\n');
}

// Guard rule for return null inside a matched intent block:
//   FALL-THROUGH (not return null): intent matched but data missing → next pattern may give useful answer
//   RETURN NULL (→ Claude): situation ambiguous, or Claude must call a tool (e.g. gdrive_setup) autonomously
// See README.md § "Guard conditions — fall-through vs return null" for the full audit table.
function getQuickAnswer(task, userId, workDir, sessionExists = false, chatId = null, telegramUserId = null) {
  // Stale PR alarm — fires repeatedly from csm-relay after PR is already merged
  if (STALE_PR_ALARM_INTENT.test(task)) {
    const prNum = task.match(/#(\d+)/)?.[1];
    return `✅ PR #${prNum} уже смёрджен. Этот alarm устарел — можно его удалить.`;
  }

  // /persona — view / set / clear the assistant's per-profile role. Injected into the
  // system prompt of every session (see spawn below). Sync file ops, safe in getQuickAnswer.
  if (PERSONA_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию. Попробуй ещё раз.';
    const rest = task.replace(PERSONA_INTENT, '').trim();
    if (!rest) {
      const cur = persona.load(workDir);
      if (!cur) {
        return [
          '🎭 Роль ассистента не задана.',
          '',
          'Как задать:',
          '• Инлайн: `/persona Ты — рекрутер-аналитик. Оцениваешь кандидатов по фактам…`',
          '• Реплаем: ответь этой командой на сообщение с текстом роли — бот возьмёт его как роль (удобно для длинных абзацев).',
          '• Убрать: `/persona clear`',
          '',
          '📖 Что такое персона и как её правильно составить (паттерны + примеры): ' + PERSONA_GUIDE_URL,
        ].join('\n');
      }
      return `🎭 Текущая роль ассистента:\n\n${cur}\n\nИзменить: \`/persona <текст>\` (или реплаем на сообщение с ролью) · убрать: \`/persona clear\`\n\n📖 Как составить хорошую персону: ${PERSONA_GUIDE_URL}`;
    }
    if (/^(clear|сброс|reset|убери|удали)$/i.test(rest)) {
      const had = persona.clear(workDir);
      return had ? '🎭 Роль ассистента убрана. Дальше — базовое поведение.' : '🎭 Роль и так не была задана.';
    }
    const saved = persona.save(workDir, rest);
    return `✅ Роль ассистента сохранена (${saved.length} симв). Применяется с этой сессии в каждом ответе.\n\nПоказать: \`/persona\` · убрать: \`/persona clear\``;
  }

  // /get_webpass — PURE SELF-SERVICE. Issue a fresh web-UI password for the CALLER'S OWN
  // profile. Closes [028]/[029]: 9 of 11 profiles never had a .webpasswd, so the site (which
  // delegates to /web/verify against that store) had nothing to check → 401. Any user mints
  // a working password on demand; the site picks it up with no sync. No cross-profile
  // targeting, no admin/chat-id gate (see comment on GET_WEBPASS_INTENT) — any trailing arg
  // is ignored, the password is always for `userId` (the profile bound to this session).
  if (GET_WEBPASS_INTENT.test(task)) {
    const target = (userId || '').trim();
    if (!target) return 'Не удалось определить профиль. Попробуй ещё раз.';
    const pass = genWebPassword();
    saveWebPassword(target, pass);
    return [
      `🔑 Твой новый веб-пароль:`,
      '',
      `\`${pass}\``,
      '',
      `Вход: https://app.trainedassist.store`,
      `Username: \`${target}\` · пароль — выше.`,
      '',
      '⚠️ Это НОВЫЙ пароль — прежний (если был) больше не работает.',
    ].join('\n');
  }

  // /project — list / switch / create projects. The active project (per chat) decides
  // which project folder NEW sessions bind to (see decideNewSessionProject + the binding
  // block in run()). A running session keeps its own project; switching affects new ones.
  if (PROJECT_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию. Попробуй ещё раз.';
    const rest = task.replace(PROJECT_INTENT, '').trim();
    const list = projects.listProjects(workDir);
    const activeId = projects.getActiveProjectId(workDir, chatId);

    // create: /project new recruiting: Название
    const createMatch = rest.match(/^(?:new|new project|новый|создать|создай|create|add)\s+(.+)$/i);
    if (createMatch) {
      const meta = projects.createProject(workDir, createMatch[1].trim());
      projects.setActiveProjectId(workDir, meta.id, chatId);
      return `✅ Проект создан и выбран: «${meta.name}» (${meta.label}).\nНовые сессии пойдут в него. Список: \`/project\``;
    }

    // rename: /project rename <номер|часть названия> = Новое имя  (locks against auto-naming)
    const renameMatch = rest.match(/^(?:rename|переименуй|переименовать|назови)\s+(.+?)\s*[=:]\s*(.+)$/i);
    if (renameMatch) {
      const q = renameMatch[1].trim(); const newName = renameMatch[2].trim();
      const num = /^\d+$/.test(q) ? parseInt(q, 10) : null;
      const tgt = (num && num >= 1 && num <= list.length) ? list[num - 1]
        : list.find(p => (p.name || '').toLowerCase().includes(q.toLowerCase()) || p.id.toLowerCase().includes(q.toLowerCase()));
      if (!tgt) return `Проект «${q}» не найден. Список: \`/project\``;
      const meta = projects.renameProject(workDir, tgt.id, newName);
      return `✏️ Переименовал: «${meta.name}». Авто-переименование для него теперь отключено.`;
    }

    if (!rest) {
      if (list.length === 0) {
        return [
          '📁 Проектов пока нет.',
          '',
          'Создать: `/project new recruiting: Название` (тип задаётся префиксом — recruiting, generic).',
        ].join('\n');
      }
      // Rich rendering: name + the 3-sense summary (start → middle → end) so a long,
      // meandering project reads clearly. Falls back to the type label when no summary yet.
      const lines = list.map((p, i) => {
        const head = `${p.id === activeId ? '▶️' : '  '} ${i + 1}. ${p.name}${p.type && p.type !== 'generic' ? ` · ${p.label}` : ''}`;
        const s = p.summary;
        if (!s || !s.start) return head;
        const parts = [s.start, s.middle, s.end].filter(Boolean).map(x => `      ${x}`);
        return [head, ...parts].join('\n');
      });
      return [
        '📁 Проекты (▶️ — активный, новые сессии идут в него):',
        '',
        lines.join('\n\n'),
        '',
        'Сменить: `/project <номер или часть названия>`',
        'Переименовать: `/project rename <номер> = Новое имя`',
        'Создать: `/project new recruiting: Название`',
      ].join('\n');
    }

    // switch: by list number or by id/name substring
    let target = null;
    const num = /^\d+$/.test(rest) ? parseInt(rest, 10) : null;
    if (num && num >= 1 && num <= list.length) {
      target = list[num - 1];
    } else {
      const q = rest.toLowerCase();
      target = list.find(p => p.id.toLowerCase() === q || (p.name || '').toLowerCase() === q)
        || list.find(p => (p.name || '').toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    }
    if (!target) return `Проект «${rest}» не найден. Список проектов: \`/project\``;
    projects.setActiveProjectId(workDir, target.id, chatId);
    return `▶️ Активный проект: «${target.name}» (${target.label}).\nСледующие новые сессии пойдут в него. Список: \`/project\``;
  }

  // /switch2klod, /switch2codex — see ENGINE_SWITCH_INTENT above.
  const engineSwitchM = task.trim().match(ENGINE_SWITCH_INTENT);
  if (engineSwitchM && workDir) {
    const raw = (engineSwitchM[1] || engineSwitchM[2] || '').toLowerCase();
    const engine = /^(codex|кодекс)$/.test(raw) ? 'codex' : raw === 'opencode' ? 'opencode' : 'claude';
    profiles.setEngine(workDir, engine, chatId);
    const label = engine === 'codex' ? 'Codex CLI' : engine === 'opencode' ? 'OpenCode' : 'Claude Code';
    return `🔀 Для этого чата переключил движок на ${label}.\nСледующая задача в этом чате пойдёт через него (текущая, если выполняется, — доработает на старом).`;
  }

  // /get_agent_info — show current engine, model, profile, VM, version
  if (AGENT_INFO_INTENT.test(task)) {
    const { execSync } = require('child_process');
    const eng = workDir ? profiles.getEngine(workDir, chatId) : 'claude';
    const vmName = process.env.VM_NAME || 'unknown';
    let commit = 'unknown';
    try { commit = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch {}
    let ocModel = process.env.OPENCODE_MODEL || '(из opencode.json)';
    let ocProfile = 'не задан';
    try {
      const ocCfgPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
      if (fs.existsSync(ocCfgPath)) {
        const ocCfg = JSON.parse(fs.readFileSync(ocCfgPath, 'utf8'));
        if (ocCfg.model) ocModel = ocCfg.model;
      }
      const profileFile = path.join(os.homedir(), '.config', 'opencode', '.current-profile');
      if (fs.existsSync(profileFile)) ocProfile = fs.readFileSync(profileFile, 'utf8').trim();
    } catch {}
    const engineLabel = eng === 'opencode' ? 'OpenCode' : eng === 'codex' ? 'Codex CLI' : 'Claude Code';
    const modelLine = eng === 'opencode'
      ? `🧠 Модель: \`${ocModel}\`\n📦 Профиль OC: ${ocProfile}`
      : `🧠 Модель: \`${process.env.ANTHROPIC_MODEL || 'claude-sonnet'}\``;
    return `🤖 Агент: \`${user?.username || '?'}\`\n🖥 VM: ${vmName}\n⚙️ Движок: ${engineLabel}\n${modelLine}\n🔖 Версия: \`${commit}\``;
  }

  // /oc_value, /oc_quality, /oc_free, /oc_mimo, /oc_ru — switch OpenCode model profile globally
  const ocProfileM = task.trim().match(OC_PROFILE_INTENT);
  if (ocProfileM) {
    const raw = (ocProfileM[1] || ocProfileM[2] || '').toLowerCase().replace(/^ru$/, 'russian-recruiter').replace(/^ll$/, 'lavish-luna');
    const scriptPath = path.join(__dirname, '..', 'infra', 'opencode-switch-profile.sh');
    if (!fs.existsSync(scriptPath)) return '⚠️ infra/opencode-switch-profile.sh не найден';
    try {
      const { execFileSync } = require('child_process');
      execFileSync('bash', [scriptPath, raw], { timeout: 10_000 });
      const PROFILE_LABELS = {
        value:               'VALUE — DeepSeek V4 Flash :free (дефолт)',
        quality:             'QUALITY — DeepSeek paid + GigaChat Ultra plan',
        free:                'FREE — только бесплатный inference (Nemotron)',
        mimo:                'MIMO — A/B-тест MiMo V2.5',
        'russian-recruiter': 'RUSSIAN RECRUITER — GigaChat Pro/Ultra/Max',
        'lavish-luna':       'LAVISH LUNA — GPT-5.6 Luna main + DeepSeek/Kimi/Qwen companions',
      };
      const label = PROFILE_LABELS[raw] || raw;
      return `✅ OpenCode профиль → ${label}\n\nПрименён глобально на этом VM (все чаты). Следующий запуск OpenCode подхватит новые модели.`;
    } catch (e) {
      return `⚠️ Не удалось переключить профиль: ${e.message.slice(0, 200)}`;
    }
  }

  // Developer intent — if GitHub not connected, ask to connect before doing anything
  if (DEV_INTENT.test(task) && userId) {
    const ghPath = path.join(os.homedir(), 'agent-tokens', String(userId), 'github');
    if (!fs.existsSync(ghPath)) {
      return {
        __connectLink: true,
        service: 'github',
        hint: 'Для разработки нужен GitHub.\n\nЕсли аккаунта нет — создай бесплатно на github.com.\n\nТокен: github.com/settings/tokens → Generate new token (classic) → выбери scopes: repo, read:org\n\nПосле подключения расскажи задачу подробнее — уточним User Story и начнём.',
      };
    }
    // GitHub connected — let Claude handle dev tasks with dev_* tools
    return null;
  }

  // Vacancy creation flow — intercept before other intents so collecting mode takes priority
  if (workDir) {
    const vs = readVacancyState(workDir);
    if (vs?.status === 'generating') {
      // Already running an Anthropic API call — block new messages to prevent concurrent generation
      return '⏳ Генерирую вакансию, подожди немного...';
    }
    if (vs?.status === 'collecting') {
      // Cancel — let user escape collecting mode
      if (VACANCY_CANCEL_INTENT.test(task)) {
        writeVacancyState(workDir, { ...vs, status: 'cancelled' });
        return '❌ Создание вакансии отменено. Чтобы начать заново — скажи «новая вакансия».';
      }
      if (VACANCY_DONE_INTENT.test(task.trim())) {
        // Mark as generating; runQuickAnswer async section will call Anthropic API
        writeVacancyState(workDir, { ...vs, status: 'generating' });
        return null; // fall through to async handler
      }
      // Skip other quick-answer patterns while collecting (except ping/help)
      if (!PING_INTENT.test(task) && !HELP_INTENT.test(task)) {
        const count = appendVacancyMessage(workDir, task);
        const countLabel = count === 1 ? 'блок' : count < 5 ? 'блока' : 'блоков';
        return `✅ Принял (${count} ${countLabel}). Ещё что-нибудь? Или скажи «всё» — начну генерировать.\nЧтобы отменить: «отмени создание вакансии».`;
      }
    }
  }

  // ── Candidate-for-client report: requirements log (issue #982) ─────────────
  // Deterministic file ops on <workDir>/candidate-reports/<candidate>-report-notes.md — no Claude.
  // Generating / regenerating the profile itself is Claude's job (candidate_report_* MCP tools,
  // which read the same file); everything around the notes file is answered instantly here.
  // Collecting-mode vacancy flow above wins: there «добавь в требования» means the vacancy.
  const reportAdd = task.trim().match(REPORT_NOTE_ADD_INTENT);
  if (reportAdd && workDir) {
    const isSlash = reportAdd[1].startsWith('/');
    const mid = reportAdd[2].trim();
    // "к профилю Чайка" → explicit report command, may create a new candidate.
    // Bare "к вакансии" / "Чайка" without "профил" → only accepted for an existing candidate.
    const explicit = isSlash || /профил/i.test(mid);
    const hint = mid.replace(/^(?:(?:к|для)\s+)?(?:профил\S*\s*)?/i, '').trim();
    const found = candidateReport.resolveCandidate(workDir, hint);
    if (found.ambiguous) {
      return `Под «${hint}» подходит несколько кандидатов: ${found.ambiguous.join(', ')}. Уточни: \`добавь в требования к профилю <имя>: …\``;
    }
    let slug = found.slug;
    if (!slug && explicit && hint) slug = candidateReport.slugify(hint);
    if (slug && reportAdd[3].trim().length <= 500) {
      const r = candidateReport.addNote(workDir, slug, reportAdd[3], { nameForNew: hint });
      const where = r.section === 'include' ? 'Что включать' : 'Что НЕ включать / формулировки';
      const who = candidateReport.readNotes(workDir, slug)?.name || slug;
      return r.duplicate
        ? `ℹ️ Такое требование к профилю «${who}» уже записано — ничего не менял.`
        : `✅ Записал в требования к профилю «${who}» (${where}). При каждой перегенерации применю автоматически — повторять не нужно.\n\nСмотреть все: «покажи требования к профилю ${who}» · пересобрать: «перегенерируй профиль ${who}»`;
    }
    // No candidate to attach to → fall through: Claude asks/decides (may not be about a report at all).
  }

  const reportShow = task.trim().match(REPORT_NOTE_SHOW_INTENT);
  if (reportShow && workDir) {
    const hint = (reportShow[1] || reportShow[2] || '').trim();
    const found = candidateReport.resolveCandidate(workDir, hint);
    if (found.ambiguous) return `Под «${hint}» подходит несколько кандидатов: ${found.ambiguous.join(', ')}. Уточни имя.`;
    if (found.slug) {
      candidateReport.setLastCandidate(workDir, found.slug);
      return `📋 ${candidateReport.renderNotes(candidateReport.readNotes(workDir, found.slug))}\nДобавить: «добавь в требования: …» · пересобрать: «перегенерируй профиль ${found.slug.replace(/-/g, ' ')}»`;
    }
    const known = candidateReport.listCandidates(workDir);
    if (hint) return `Для «${hint}» требований к профилю пока нет. Добавить: «добавь в требования к профилю ${hint}: не упоминать …»`;
    return known.length
      ? `Требования к профилям есть у: ${known.join(', ')}. Уточни: «покажи требования к профилю <имя>».`
      : 'Пока нет ни одного профиля с требованиями. Начни с «сделай профиль кандидата <имя> для клиента <компания>» — файл требований создастся сам.';
  }

  // Capability question only ("умеешь делать профиль кандидата для клиента?"). A polite task with a
  // concrete target ("можешь сделать профиль кандидата Чайка для клиента АТОН") goes to Claude.
  if (REPORT_CAPABILITY_INTENT.test(task) &&
      !/клиента\s+\p{L}/iu.test(task) && !/(?:кандидата|профиль|профиля)\s+\p{Lu}/u.test(task)) {
    return [
      '📄 Да, делаю профиль кандидата для клиента — аккуратная HTML-страница (печать A4, 2–3 стр.):',
      'шапка с бейджами, кратко о себе, матрица соответствия вакансии ✓/~/✗, опыт, вывод рекрутера от первого лица, видео скрининга.',
      '',
      'Главное — я запоминаю твои правки в файле требований к профилю и применяю их при каждой перегенерации, повторять не нужно.',
      '',
      'Команды:',
      '• «сделай профиль кандидата [имя] для клиента [компания]»',
      '• «перегенерируй профиль [имя]» — читает требования автоматически',
      '• «добавь в требования: не упоминать …» — запомню навсегда',
      '• «покажи требования к профилю [имя]»',
    ].join('\n');
  }

  // New job post command — start collecting mode (guard against overwriting live drafts)
  if (NEW_JOB_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию. Попробуй ещё раз.';
    const existingVs = readVacancyState(workDir);
    if (existingVs && !['cancelled', 'hh_draft'].includes(existingVs.status)) {
      return `⚠️ Уже есть активная вакансия (статус: ${existingVs.status}). Чтобы отменить её и начать новую — скажи «отмени создание вакансии».`;
    }
    initVacancyState(workDir);
    return [
      '📋 Создаём новую вакансию!',
      '',
      'Кидай всё что есть — черновики, требования, заметки со звонков, переговоры с клиентом. Можно кусками, можно всё сразу.',
      '',
      'Когда всё скинешь — скажи «всё».',
    ].join('\n');
  }

  // /bugreport — collect bug description and create GitHub issue
  if (BUG_REPORT_INTENT.test(task)) {
    if (!workDir) return null;
    const bugPendingPath = path.join(workDir, 'contexts', 'bugreport', 'pending.json');
    fs.mkdirSync(path.dirname(bugPendingPath), { recursive: true });
    fs.writeFileSync(bugPendingPath, JSON.stringify({ started_at: new Date().toISOString() }));
    return null; // let Claude handle with bug report context injected below
  }

  // /ping — liveness check
  if (PING_INTENT.test(task)) return '🟢 Онлайн. Готов к работе.';

  // /help — capability overview (static, no Claude needed)
  if (HELP_INTENT.test(task)) {
    return [
      '🤖 Что я умею:',
      '',
      '📁 Работа с файлами, кодом, данными',
      '🔗 Интеграции: GitHub, Weeek, Налог.ру, Tilda, GetCourse, Google Drive',
      '🎨 Иллюстрации — генерирую картинки по описанию (DALL-E 3, FLUX, Ideogram, Recraft)',
      '🏢 INN Enrichment — поиск ИНН/ОГРН/директоров/выручки по списку компаний',
      '🎪 Выставки — собрать участников/экспонентов по URL сайта → CSV',
      '🌐 Браузер — вхожу на сайты и выполняю действия',
      '',
      '💼 HeadHunter (при подключённом HH аккаунте):',
      '  • «подготовь черновик вакансии [компания] на HH» — скидываешь текст/описание, создаю черновик на hh.ru',
      '  • «новая вакансия» — пошаговый сбор данных для вакансии',
      '  • «опубликуй черновик на HH» — отправить готовый черновик на hh.ru',
      '  • «опубликуй страницу вакансии» — лендинг с вакансией',
      '  • Просмотр откликов, воронка, список вакансий',
      '',
      '📄 Профиль кандидата для клиента:',
      '  • «сделай профиль кандидата [имя] для клиента [компания]» / «перегенерируй профиль [имя]»',
      '  • «добавь в требования: не упоминать …» — правки запоминаются и применяются каждый раз',
      '  • «покажи требования к профилю [имя]»',
      '',
      'Команды:',
      '/secrets_list — подключённые сервисы',
      '/secrets_log — история обращений к данным',
      '/sessions — мои диалоги',
      '/usage — расход токенов',
      '',
      'Чтобы подключить сервис: «подключи GitHub», «подключи Налог.ру» и т. д.',
    ].join('\n');
  }

  // /sessions — list recent sessions
  if (SESSIONS_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию.';
    const list = sessions.listSessions(workDir, 10);
    if (!list || list.length === 0) return 'Нет активных диалогов.';
    return renderSessionsList(list);
  }

  // /usage — token usage stats
  if (USAGE_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию.';
    const t = getUsageTotals(workDir);
    if (!t || t.tasks === 0) return 'Данных об использовании пока нет.';
    const lines = [
      `📊 Использование токенов (всего ${t.tasks} задач):`,
      `• Входящих: ${t.input_tokens.toLocaleString('ru-RU')}`,
      `• Исходящих: ${t.output_tokens.toLocaleString('ru-RU')}`,
    ];
    if (t.cache_read > 0) lines.push(`• Из кэша: ${t.cache_read.toLocaleString('ru-RU')}`);
    if (t.cache_write > 0) lines.push(`• В кэш записано: ${t.cache_write.toLocaleString('ru-RU')}`);
    return lines.join('\n');
  }

  // /context_off / /context_on — toggle context card
  if (CONTEXT_OFF_INTENT.test(task) || CONTEXT_ON_INTENT.test(task)) {
    if (!workDir) return 'Не удалось определить рабочую директорию.';
    const flagPath = path.join(workDir, '.context_disabled');
    if (CONTEXT_OFF_INTENT.test(task)) {
      fs.writeFileSync(flagPath, '1');
      return '📌 Контекст-карточка выключена. Чтобы включить — /context_on';
    }
    try { fs.unlinkSync(flagPath); } catch (e) { console.warn('[runner] unlinkSync context flag:', e.message); }
    return '📌 Контекст-карточка включена. Буду показывать статус после каждой задачи.';
  }

  // /secrets_list — show connected services
  if (SECRETS_LIST_INTENT.test(task)) {
    const services = userId ? listConnectedServices(userId) : null;
    if (!services || services.length === 0) {
      return 'Нет подключённых сервисов.\n\nЧтобы подключить: «подключи GitHub», «подключи Налог.ру» и т. д.';
    }
    const lines = services.map(s => {
      const d = s.mtime.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      return `• ${s.name} — обновлён ${d}`;
    });
    return [
      '🔑 Подключённые сервисы:',
      ...lines,
      '',
      'Отозвать: «отзови доступ к [сервис]»',
      'История обращений: /secrets_log',
    ].join('\n');
  }

  // /secrets_log — show access log
  if (SECRETS_LOG_INTENT.test(task)) {
    const log = userId ? getSecretsLog(userId) : null;
    if (!log || log.length === 0) return 'История обращений пуста.';
    const lines = log.map(l => {
      const [ts, svcs] = l.split('\t');
      const time = new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `${time} — ${svcs}`;
    });
    return '📋 Последние обращения к вашим данным:\n' + lines.join('\n');
  }

  // Service status check — "github подключен?", "статус nalog"
  if (SERVICE_STATUS_INTENT.test(task) && userId) {
    const svcMatch = task.match(SERVICE_STATUS_RE);
    if (svcMatch) {
      const ALIASES = { вик: 'weeek', налог: 'nalog', нпд: 'nalog', фигма: 'figma', тильда: 'tilda', геткурс: 'getcourse', гугл: 'gdrive' };
      const key = ALIASES[svcMatch[1].toLowerCase()] || svcMatch[1].toLowerCase();
      const display = SERVICE_DISPLAY[key] || key;
      const services = listConnectedServices(userId);
      const found = services?.find(s => s.file === key);
      if (found) {
        const d = found.mtime.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        return `✅ ${display} подключён (обновлён ${d}).`;
      }
      return `❌ ${display} не подключён. Напиши «подключи ${display}» чтобы добавить.`;
    }
  }

  // Revoke — delete a service token
  if (REVOKE_INTENT.test(task)) {
    const svcMatch = task.match(REVOKE_SERVICE_RE);
    if (!svcMatch) return 'Укажи сервис для отзыва, например: «отзови доступ к GitHub»';
    if (!userId) return 'Не удалось определить пользователя.';

    const isGdrive = /gdrive|гугл|google/i.test(svcMatch[1]);

    if (isGdrive && workDir) {
      const pendingFile = path.join(workDir, '.revoke_gdrive_pending.json');
      if (REVOKE_CONFIRM_RE.test(task)) {
        // Confirmed — check pending file
        let pending = null;
        try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { /* no pending */ }
        const isValid = pending && pending.expiresAt > Date.now();
        if (!isValid) return '⚠️ Подтверждение устарело. Напиши «отключи Google Drive» ещё раз.';
        try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
        // Fire-and-forget SA deletion (getQuickAnswer is sync)
        deleteGdriveSA(userId).catch(e => console.error('[gdrive-revoke] SA delete failed:', e.message));
        const revokeResult = revokeService(userId, 'gdrive');
        if (revokeResult === 'not_found') return 'Сервис Google Drive не был подключён.';
        return '✅ Google Drive отключён. Удаление сервис-аккаунта из GCP запущено.';
      } else {
        // First request — ask for confirmation, write pending file
        const gdriveFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
        if (!fs.existsSync(gdriveFile)) return 'Google Drive не был подключён.';
        try {
          fs.writeFileSync(pendingFile, JSON.stringify({ service: 'gdrive', expiresAt: Date.now() + 5 * 60 * 1000 }), { mode: 0o600 });
        } catch { /* non-critical */ }
        return '⚠️ Это удалит подключение Google Drive и сервис-аккаунт из GCP.\n\nПодтвердить? Напиши «да, удали»';
      }
    }

    const result = revokeService(userId, svcMatch[1]);
    if (result === null) return `Не распознал сервис «${svcMatch[1]}». Доступные: GitHub, Weeek, Налог.ру, Figma, Tilda, Google Drive.`;
    if (result === 'not_found') return `Сервис «${svcMatch[1]}» не был подключён.`;
    return `✅ Доступ к ${SERVICE_DISPLAY[result] || result} отозван. Данные удалены с сервера.`;
  }

  // "мои файлы гугл", "что мне пошарено", "список документов" — LIST before SHARE (пошаренные matches both)
  // User confirms they shared after gdrive setup — pass to Claude to call gdrive_list_files
  if (GDRIVE_SHARED_CONFIRM_INTENT.test(task) && userId) {
    const gdriveFile4 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
    if (fs.existsSync(gdriveFile4)) {
      return null; // gdrive configured — let Claude call gdrive_list_files to verify access
    }
  }

  if (GDRIVE_LIST_INTENT.test(task) && userId) {
    const catalogPath2 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-catalog.json');
    try {
      const catalog2 = JSON.parse(fs.readFileSync(catalogPath2, 'utf8'));
      if (!catalog2.length) return '📂 Пока нет пошаренных файлов. Поделись папкой/файлом Drive с SA email — потом напиши мне, я проверю доступ.';
      const MIME_ICON2 = {
        'application/vnd.google-apps.spreadsheet':  '📊',
        'application/vnd.google-apps.document':     '📄',
        'application/vnd.google-apps.presentation': '📊',
        'application/vnd.google-apps.folder':       '📁',
      };
      const lines2 = catalog2.slice(-20).reverse().map(f => {
        const icon = MIME_ICON2[f.mimeType] || '📎';
        const date = f.sharedAt ? new Date(f.sharedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
        const link = f.webViewLink ? `[${f.name}](${f.webViewLink})` : f.name;
        return `${icon} ${link}${date ? ' — ' + date : ''}`;
      });
      return ['📂 Пошаренные файлы:', '', ...lines2].join('\n');
    } catch (e) { console.warn('[runner] gdrive catalog parse:', e.message); }
    return null; // no catalog yet — let Claude call gdrive_list_files to check live
  }

  // "можешь читать гугл шит", "умеешь работать с csv/таблицами"
  if (GDRIVE_CAPABILITY_INTENT.test(task)) {
    if (!userId || sessionExists) return null;
    const gdriveFile3 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
    const connected = fs.existsSync(gdriveFile3);
    return connected
      ? [
          'Да, умею работать с Google Drive:',
          '',
          '📊 Читать Google Sheets — анализ, формулы, выборки',
          '📄 Читать Google Docs — конспект, резюме, поиск по тексту',
          '📤 Загружать CSV/данные в Google Sheets (создавать новые листы)',
          '📂 Следить за папкой — уведомление когда добавляют новый файл',
          '',
          'Google Drive уже подключён. Пошари папку/файл с SA email — потом напиши мне, я сам найду и прочитаю.',
        ].join('\n')
      : null; // not configured — let Claude call gdrive_setup automatically
  }

  // "я пошарил папку ты видишь?" — past tense + confirmation question → let Claude call gdrive_list_files
  if (GDRIVE_CONFIRM_INTENT.test(task)) return null;

  // "пошарить таблицу тебе", "как поделиться файлом", "email SA" — always read from disk, never hallucinate
  if ((GDRIVE_SHARE_INTENT.test(task) || GDRIVE_SA_EMAIL_INTENT.test(task)) && userId) {
    const gdriveFile2 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
    try {
      const sa2 = JSON.parse(fs.readFileSync(gdriveFile2, 'utf8'));
      if (sa2.client_email) {
        return [
          '📂 Чтобы дать мне доступ к файлу или папке в Google Drive:',
          '',
          '1. Открой файл/папку → кнопка «Поделиться» (Share)',
          `2. Добавь этот email с ролью «Читатель» (или «Редактор» если нужно):`,
          `\`${sa2.client_email}\``,
          '3. Нажми «Отправить»',
          '',
          'После шаринга напиши мне — я сам проверю доступ. Ссылку слать не нужно.',
        ].join('\n');
      }
    } catch (e) { console.warn('[runner] gdrive SA config parse:', e.message); }
    // SA email asked explicitly — give a helpful "not configured" message instead of routing to Claude
    if (GDRIVE_SA_EMAIL_INTENT.test(task)) {
      return 'Google Drive не настроен. Напиши «подключи Google Drive» — помогу настроить за пару минут.';
    }
    return null; // share intent without config — let Claude call gdrive_setup automatically
  }

  // Toggle GDrive sharing notifications
  if (GDRIVE_NOTIF_OFF_INTENT.test(task) && userId) {
    const mutedFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-notif-muted');
    fs.writeFileSync(mutedFile, JSON.stringify({ muted_at: new Date().toISOString() }), { mode: 0o600 });
    return '🔕 Уведомления о шаринге Google Drive отключены.\n\nФайлы продолжают добавляться в каталог — просто без уведомлений в чат. Включить обратно: `/gdrive_notif_on`';
  }
  if (GDRIVE_NOTIF_ON_INTENT.test(task) && userId) {
    const mutedFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-notif-muted');
    if (fs.existsSync(mutedFile)) fs.unlinkSync(mutedFile);
    return '🔔 Уведомления о шаринге Google Drive включены.\n\nБуду писать когда кто-то откроет доступ к файлу или папке.';
  }

  // Capability question about illustration generation
  if (ILLUSTRATE_ENABLE_INTENT.test(task) || ILLUSTRATE_CAPABILITY_INTENT.test(task)) {
    if (!workDir) return null;

    const illustrateFlagPath = path.join(workDir, 'contexts', 'illustrate', '.enabled');
    const illustrateEnabled = fs.existsSync(illustrateFlagPath);

    if (ILLUSTRATE_ENABLE_INTENT.test(task)) {
      if (!illustrateEnabled) {
        fs.mkdirSync(path.dirname(illustrateFlagPath), { recursive: true });
        fs.writeFileSync(illustrateFlagPath, JSON.stringify({ enabled_at: new Date().toISOString() }));
      }
      // If message also has a concrete draw command — enable the skill silently and let Claude handle the drawing
      if (ILLUSTRATE_DRAW_COMMAND.test(task)) return null;
      if (illustrateEnabled) return 'Скил иллюстраций уже включён. Опиши что нарисовать — и начнём!';
      return 'Готово! Скил генерации иллюстраций включён.\n\nТеперь могу рисовать медицинские схемы, анатомические диаграммы и инфографику.\nИспользую DALL-E 3 (основной) и Ideogram (альтернатива, лучше с подписями).\n\nОпиши что нарисовать — и начнём!';
    }

    // ILLUSTRATE_CAPABILITY_INTENT — pure capability question (no draw command); skip in active session
    if (sessionExists || ILLUSTRATE_DRAW_COMMAND.test(task)) return null;
    if (illustrateEnabled) {
      return 'Да, скил иллюстраций включён.\n\nПросто опиши что нарисовать — голосом или текстом. Например:\n• «нарисуй как работают потовые железы в коже»\n• «схема слоёв эпидермиса в разрезе»\n• «инфографика про уход за кожей»\n\nСтили: медицинская схема, flat design, детальная анатомия, инфографика.\nПосле картинки могу наложить подписи по-русски отдельным инструментом.';
    }
    return 'Есть скил генерации иллюстраций (DALL-E 3 + Ideogram), но он ещё не включён.\n\nНапиши «включи рисование» — и я активирую его для тебя.';
  }

  // Capability question about exhibition participants — only if expo pipeline exists for this profile
  if (EXPO_CAPABILITY_INTENT.test(task) && !sessionExists) {
    if (!workDir || !fs.existsSync(path.join(workDir, 'expo-pipeline'))) return null;
    return 'Да, умею собирать участников выставок.\n\nДай мне ссылку на сайт выставки — зайду, найду страницу участников и верну список компаний в CSV.\n\nДальше могу обогатить по ИНН: директор, выручка, сайт — скидывай сразу с таким запросом, если нужно.\n\nПришли URL сайта выставки.';
  }

  // Capability question about INN enrichment — answer immediately without calling Claude
  if (INN_CAPABILITY_INTENT.test(task) && !sessionExists) {
    return 'Да, есть скил INN Enrichment.\n\nНаходит для списка компаний (300–1000 шт): ИНН, ОГРН, директора, выручку и прибыль.\n\nИсточники: БФО ФНС (бесплатно), ЕГРЮЛ, DaData, Checko — всё уже настроено, ключи у платформы.\n\nЧасть запросов платные (DaData, Checko), но не переживайте — мы предоставляем пакет ощутимого размера, чтобы получить результат. Если понадобится больше — докупим вместе.\n\nПришли JSON-файл, CSV или ссылку на Google Sheet со списком компаний — и запущу.';
  }

  // Capability question about GetCourse — only if connected for this profile
  if (GC_CAPABILITY_INTENT.test(task) && !sessionExists) {
    if (!userId || !fs.existsSync(path.join(os.homedir(), 'agent-tokens', String(userId), 'getcourse', 'config.json'))) return null;
    return [
      'Вот что умею в GetCourse:\n',
      '📋 Курсы (L2 — через сессию):',
      '• Список всех курсов — `gc_course_list`',
      '• Создать курс — `gc_course_create`',
      '• Создать раздел в курсе — `gc_section_create`',
      '• Создать урок — `gc_lesson_create`',
      '• Добавить видео-блок в урок — `gc_lesson_add_video`',
      '• Добавить текст-блок в урок — `gc_lesson_add_text`',
      '• Поменять порядок блоков — `gc_lesson_sort`\n',
      '👤 Ученики (L1 — API ключ):',
      '• Добавить/обновить ученика, дать доступ к курсу — `gc_user_add`\n',
      '👤 Ученики, заказы, уведомления, группы (L2 — через сессию, ~15–20с):',
      '• Найти ученика по email → user_id — `gc_user_find`',
      '• Список заказов ученика — `gc_order_list`',
      '• Письма/уведомления ученика — `gc_user_notifications`',
      '• Список групп доступа — `gc_group_list`',
      '• Какие курсы доступны группе — `gc_group_courses`',
      '• К каким тренингам есть доступ у юзера — `gc_user_trainings`\n',
      'Если нужного скила нет — могу использовать GetCourse API или Playwright напрямую.',
      'Если не подключён — скажи «подключи геткурс».',
    ].join('\n');
  }

  // Capability question about audio/voice transcription
  if (AUDIO_CAPABILITY_INTENT.test(task)) {
    return [
      'Да, умею транскрибировать аудио и голосовые сообщения.\n',
      '🎙️ Как это работает:',
      '• Пришли голосовое сообщение или аудиофайл (mp3, wav, ogg, m4a)',
      '• Получишь текст — быстро и с высокой точностью\n',
      '⚡ Движок: Deepgram nova-2',
      '• Поддерживает русский и другие языки',
      '• Быстрее и точнее Whisper',
      '• Расставляет знаки препинания и разбивает по абзацам\n',
      'Просто отправь аудио — и я пришлю транскрипцию.',
    ].join('\n');
  }

  // Expo pipeline — target criteria (quick read from disk, no LLM)
  // Length guard: long messages are instructions, not criteria lookup requests
  if (EXPO_CRITERIA_INTENT.test(task) && task.length < 200 && workDir) {
    try {
      const pipelineDirC = path.join(workDir, 'expo-pipeline');
      if (fs.existsSync(pipelineDirC)) {
        const { formatCriteriaText, readCriteria } = require('./mcp-skills/tools/87-expo-pipeline.js');
        const criteria = readCriteria(workDir);
        return formatCriteriaText(criteria);
      }
    } catch (e) {
      console.error('[quick-answer] expo criteria error:', e.message);
    }
  }

  // Expo pipeline — site config / filter ranges
  if (EXPO_SITE_CONFIG_INTENT.test(task) && task.length < 200 && workDir) {
    try {
      const pipelineDir = path.join(workDir, 'expo-pipeline');
      if (fs.existsSync(pipelineDir)) {
        const { formatSiteConfigText, readSiteConfig } = require('./mcp-skills/tools/87-expo-pipeline.js');
        const config = readSiteConfig(workDir);
        return formatSiteConfigText(config);
      }
    } catch (e) {
      console.error('[quick-answer] expo site-config error:', e.message);
    }
  }

  // Expo pipeline — pipeline status (quick count from disk)
  if (EXPO_STATUS_INTENT.test(task) && workDir) {
    try {
      const pipelineBase = require('path').join(workDir, 'expo-pipeline');
      if (require('fs').existsSync(pipelineBase)) {
        const dirs = require('fs').readdirSync(pipelineBase, { withFileTypes: true })
          .filter(e => e.isDirectory());
        if (dirs.length === 0) return 'Нет активных pipeline. Запусти обработку выставки чтобы начать.';
        const lines = dirs.map(d => {
          const dir = require('path').join(pipelineBase, d.name);
          function count(f, key) {
            try {
              const data = JSON.parse(require('fs').readFileSync(require('path').join(dir, f), 'utf8'));
              const arr = Array.isArray(data) ? data : (data[key] || data.companies || data.results || []);
              return arr.length;
            } catch (e) { console.warn('[runner] expo count parse:', e.message); return null; }
          }
          const c = count('companies.json', 'companies');
          const e = count('enriched.json', 'companies');
          const t = count('targets.json', 'companies');
          return `📁 ${d.name}\n   Компаний: ${c ?? '—'} | Обогащено: ${e ?? '—'} | Целевых: ${t ?? '—'}`;
        });
        return '📊 Статус pipeline:\n\n' + lines.join('\n\n');
      }
    } catch (e) {
      console.error('[quick-answer] expo status error:', e.message);
    }
  }

  // Check user-connected sites (custom intents generated during crawl)
  if (userId) {
    try {
      const siteIntents = loadUserSiteIntents(userId);
      for (const intent of siteIntents) {
        try {
          if (new RegExp(intent.pattern, 'i').test(task)) {
            console.log('[quick-answer] matched site intent=%j site=%s', intent.pattern, intent.slug);
            return intent.response;
          }
        } catch (e) {
          console.warn('[quick-answer] invalid site intent regex:', intent.pattern, e.message);
        }
      }
    } catch (e) {
      console.warn('[quick-answer] loadUserSiteIntents failed:', e.message);
    }
  }

  // Call Tips — "подготовь план для звонка с [имя]"
  // Don't return a quick answer — let Claude use calltips_prepare MCP tool.
  // But log to help with debugging if needed.
  if (CALLTIPS_PREPARE_INTENT.test(task)) {
    console.log('[quick-answer] CALLTIPS_PREPARE_INTENT matched — routing to Claude (calltips_prepare tool)');
    return null; // Claude handles via MCP tool
  }

  // Call Tips download links
  const CALLTIPS_DOWNLOAD_INTENT = /скачать.{0,20}call.?tips|установить.{0,20}call.?tips|call.?tips.{0,20}скачать|загрузить.{0,20}call.?tips|где.{0,20}call.?tips|ссылка.{0,20}call.?tips/i;
  if (CALLTIPS_DOWNLOAD_INTENT.test(task)) {
    return `📥 *Call Tips — скачать*

🍎 *Mac (Apple Silicon)*: https://github.com/trained-assist/call-tips/releases/latest/download/Call.Tips-0.1.0-arm64.dmg

🪟 *Windows (x64)*: https://github.com/trained-assist/call-tips/releases/latest/download/Call.Tips.Setup.0.1.0.exe

*Как начать:*
1. Установи приложение
2. Введи ключ Deepgram (транскрипция) и Agent Secret
3. Напиши мне: "подготовь план для звонка с [имя кандидата]"
4. Нажми 📥 Из агента → Начать звонок`;
  }

  if (!SETUP_INTENT.test(task)) {
    console.log('[quick-answer] no setup intent, task=%j', task.slice(0, 120));
    return null;
  }

  const NAVIGATING_URL_RE = /https?:\/\/[^\s]+\.[^\s]+\/[^\s]+/i;
  const SITE_CONNECT_RE = /подключи.{0,20}сайт|добавь.{0,20}сайт|connect.{0,15}site|подключить.{0,20}сайт/i;
  if (NAVIGATING_URL_RE.test(task) && !SITE_CONNECT_RE.test(task)) {
    console.log('[quick-answer] task contains a URL with path — user is navigating, not connecting; skipping QUICK_SETUPS');
    return null;
  }

  for (const { match, service, hint } of QUICK_SETUPS) {
    if (!match.test(task)) continue;
    console.log('[quick-answer] matched service=%s uid=%s', service || 'null', userId);
    if (service && userId) {
      // Guard: if already connected, don't re-send the connect link
      if (service === 'hh') {
        const hhPath = path.join(os.homedir(), 'agent-tokens', String(userId), 'hh');
        if (fs.existsSync(hhPath)) {
          return 'HeadHunter уже подключён ✅ Могу искать кандидатов, писать сообщения, создавать вакансии.\n\nЕсли хочешь переподключиться под другим аккаунтом — сначала /hh_disconnect.';
        }
      }
      return { __connectLink: true, service, hint };
    }
    return hint;
  }

  console.log('[quick-answer] setup intent matched but no service pattern, task=%j', task.slice(0, 120));
  return null;
}

// Classify whether user wants to publish/generate the vacancy landing page.
// Only called when regex misses AND a vacancy draft exists. Fast DeepSeek call.
async function classifyVacancyPublishIntent(task, workDir, openrouterKey) {
  const orKey = openrouterKey || process.env.OPENROUTER_API_KEY;
  if (!orKey) return false;
  const vs = readVacancyState(workDir);
  if (!vs?.draft) return false; // no draft — nothing to publish

  try {
    const body = JSON.stringify({
      model: 'deepseek/deepseek-v4-flash-0731',
      messages: [
        {
          role: 'system',
          content: 'You classify recruiter bot messages. Answer with a single word: YES or NO.',
        },
        {
          role: 'user',
          content: `Does this message ask to publish, generate, create, or rebuild the vacancy landing page (страница вакансии / лендинг)?\n\nMessage: "${task}"\n\nYES or NO:`,
        },
      ],
      max_tokens: 5,
      temperature: 0,
    });
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(2500),
    });
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toUpperCase() || '';
    return answer.startsWith('YES');
  } catch (e) {
    console.warn('[classifyVacancyPublishIntent] error:', e.message);
    return false;
  }
}

// getQuickAnswer's ~40 INTENT regexes are broad fuzzy-language patterns (e.g. "мои
// вакансии", "покажи ссылку", "включи X") — they misfire on unrelated messages that
// happen to share wording, silently eating a real task instead of reaching Claude.
// Before committing to a matched quick-answer, ask a cheap LLM whether the message
// actually requests it. Skipped for slash commands (unambiguous, no fuzzy match
// possible). Fails OPEN on missing key / timeout / error — a broken OpenRouter call
// must not make quick answers less reliable than before this gate existed.
async function verifyQuickAnswerIntent(task, answerPreview, openrouterKey) {
  const orKey = openrouterKey || process.env.OPENROUTER_API_KEY;
  if (!orKey || !answerPreview) return true;
  try {
    const body = JSON.stringify({
      model: 'deepseek/deepseek-v4-flash-0731',
      messages: [
        {
          role: 'system',
          content: 'You verify chatbot auto-replies before they are sent. Answer with a single word: YES or NO.',
        },
        {
          role: 'user',
          content: `A user sent this message to a chatbot:\n"${task}"\n\nThe bot is about to auto-reply with something like this:\n"${String(answerPreview).slice(0, 300)}"\n\nDoes the user's message actually request this kind of reply? If unsure, answer YES.\n\nYES or NO:`,
        },
      ],
      max_tokens: 5,
      temperature: 0,
    });
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(2500),
    });
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toUpperCase() || '';
    return !answer.startsWith('NO');
  } catch (e) {
    console.warn('[verifyQuickAnswerIntent] error (fail-open):', e.message);
    return true;
  }
}

// Async wrapper: sync quick-answer first, then HH API handlers (no Claude).
async function runQuickAnswer(task, userId, workDir, openrouterKey = null, sessionExists = false, chatId = null, telegramUserId = null) {
  // /bug_or_feature — second step: if a report is awaiting the user's comment, the NEXT
  // message IS that comment. Capture it and file the issue. Guards: a slash command
  // cancels capture (don't bury a command as a note); "отмена" cancels explicitly;
  // a stale flag (>30 min) is ignored so an unrelated later message isn't swallowed.
  if (workDir) {
    const ofPending = path.join(workDir, 'contexts', 'bugreport', `or-feature-pending-${chatId || 'default'}.json`);
    try {
      if (fs.existsSync(ofPending)) {
        const p = JSON.parse(fs.readFileSync(ofPending, 'utf8') || '{}');
        const ageMs = Date.now() - new Date(p.started_at || 0).getTime();
        const fresh = ageMs >= 0 && ageMs < 30 * 60 * 1000;
        const trimmed = task.trim();
        if (!fresh || trimmed.startsWith('/')) {
          fs.unlinkSync(ofPending); // stale, or a real command follows — drop capture, process normally
        } else if (/^(отмена|отменить|отмени|cancel|отбой|не надо)$/i.test(trimmed)) {
          fs.unlinkSync(ofPending);
          return '❌ Отменил. Отчёт не отправлен.';
        } else {
          fs.unlinkSync(ofPending);
          const { createBugReport } = require('./bug-report');
          return await createBugReport({ workDir, chatId, userId, note: task });
        }
      }
    } catch (e) {
      console.warn('[bug_or_feature] pending-consume error:', e.message);
    }
  }

  // Session summaries (durable artifact) — handled here (async) so we can generate
  // missing/stale summaries via LLM before rendering. "Подробнее N" expands one.
  if (workDir) {
    const detailM = task.trim().match(SESSION_DETAIL_INTENT);
    if (detailM) {
      const n = parseInt(detailM[1] || detailM[2] || detailM[3], 10);
      const list = sessions.listSessions(workDir, 10);
      if (!list || list.length === 0) return 'Нет активных диалогов.';
      if (!n || n < 1 || n > list.length) return `Нет диалога №${n}. Напишите /sessions — покажу список.`;
      const meta = list[n - 1];
      if (sessions.needsSummary(meta)) {
        const full = sessions.getSession(workDir, meta.id);
        const sum = full && await generateSummary(full.messages, { apiKey: openrouterKey });
        if (sum) { sessions.setSummary(workDir, meta.id, sum, meta.messageCount); meta.summary = sum; }
      }
      return renderSessionDetail(meta, n);
    }
    if (SESSIONS_INTENT.test(task)) {
      let list = sessions.listSessions(workDir, 10);
      if (!list || list.length === 0) return 'Нет активных диалогов.';
      // Generate summaries for sessions that lack a fresh one — in parallel, persist to disk.
      const stale = list.filter(s => sessions.needsSummary(s));
      if (stale.length && (openrouterKey || process.env.OPENROUTER_API_KEY)) {
        await Promise.all(stale.map(async (s) => {
          const full = sessions.getSession(workDir, s.id);
          if (!full) return;
          const sum = await generateSummary(full.messages, { apiKey: openrouterKey });
          if (sum) sessions.setSummary(workDir, s.id, sum, s.messageCount);
        }));
        list = sessions.listSessions(workDir, 10); // reload with fresh summaries
      }
      // Also refresh the ACTIVE project's name + 3-sense summary if it's stale (session
      // count grew). Cheap: one gemini-2.5-flash call, only when needed. This is how a
      // project "matures" — born with a provisional name, renamed from its real work.
      try {
        const orK = openrouterKey || process.env.OPENROUTER_API_KEY;
        const activePid = projects.getActiveProjectId(workDir, chatId);
        if (orK && activePid) {
          const meta = projects.getProject(workDir, activePid);
          const projSess = sessions.listSessions(workDir, 1000).filter(s => s.projectId === activePid);
          if (meta && projects.needsSummary(meta, projSess.length)) {
            const { generateProjectSummary } = require('./project-summary');
            const res = await generateProjectSummary(projSess, { apiKey: orK });
            if (res) projects.setProjectSummary(workDir, activePid, res, projSess.length);
          }
        }
      } catch (e) { console.warn('[runner] project summary refresh:', e.message); }
      return renderSessionsList(list);
    }
  }

  // /bug_or_feature — bundle last messages + logs + note into a GitHub issue (async).
  // Bare invocation (no inline note) → ask the user what's wrong first, then the next
  // message becomes the note (consumed at the top of runQuickAnswer). Inline note
  // (`/bug_or_feature текст`) fires immediately — the comment is already there.
  if (BUG_OR_FEATURE_INTENT.test(task)) {
    const note = task.replace(BUG_OR_FEATURE_INTENT, '').trim();
    if (!note && workDir) {
      const ofPending = path.join(workDir, 'contexts', 'bugreport', `or-feature-pending-${chatId || 'default'}.json`);
      fs.mkdirSync(path.dirname(ofPending), { recursive: true });
      fs.writeFileSync(ofPending, JSON.stringify({ started_at: new Date().toISOString() }));
      return [
        '📝 Опиши, что случилось или что хочешь улучшить — одним сообщением.',
        'Приложу к отчёту последние сообщения этой сессии и хвост логов.',
        '',
        '(Чтобы отменить — напиши «отмена».)',
      ].join('\n');
    }
    const { createBugReport } = require('./bug-report');
    return await createBugReport({ workDir, chatId, userId, note });
  }

  // /usage klod, /usage codex — see CLI_USAGE_INTENT above.
  const cliUsageM = task.trim().match(CLI_USAGE_INTENT);
  if (cliUsageM) {
    if (userId !== OWNER_USERNAME) {
      return 'Команда доступна только владельцу.';
    }
    const key = /^(codex|кодекс)$/i.test(cliUsageM[1]) ? 'codex' : 'klod';
    const script = CLI_USAGE_SCRIPTS[key];
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile(script, [], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr?.trim() || err.message));
          else resolve({ stdout });
        });
      });
      return stdout.trim();
    } catch (e) {
      console.error('[cli-usage] %s script failed: %s', key, e.message);
      return `⚠️ Не удалось получить данные (${key}): ${e.message}`;
    }
  }

  // Skip regex-based intent matching for long free-form messages — the ~40
  // INTENT patterns were calibrated for short, focused phrasing and misfire on
  // multi-line tasks where a quick answer is almost never what the user wants.
  // Slash commands (unambiguous) are always checked regardless of length.
  const LONG_MSG_QUICK_SKIP = 200;
  const isSlashCommand = /^\//.test(task.trim());
  const sync = (isSlashCommand || task.trim().length <= LONG_MSG_QUICK_SKIP)
    ? getQuickAnswer(task, userId, workDir, sessionExists, chatId, telegramUserId)
    : null;
  if (sync !== null) {
    const preview = (sync && typeof sync === 'object') ? sync.hint : sync;
    const confirmed = isSlashCommand || await verifyQuickAnswerIntent(task, preview, openrouterKey);
    if (confirmed) {
      if (sync && typeof sync === 'object' && sync.__connectLink) {
        try {
          const link = await generateConnectLink(userId, sync.service);
          return `Данные для входа — по ссылке:\n${link}\n\n${sync.hint}${TRUST_FOOTER}`;
        } catch (e) {
          console.error('[quick-answer] generateConnectLink failed:', e.message);
          return sync.hint;
        }
      }
      return sync;
    }
    console.log('[quick-answer] intent-check rejected match len=%d, falling through to Claude, task=%j', preview?.length || 0, task.slice(0, 120));
  }

  // Vacancy generation — triggered when collecting mode is done ("всё" set status → "generating")
  if (workDir && openrouterKey) {
    const vs = readVacancyState(workDir);
    if (vs?.status === 'generating' && vs.messages?.length > 0) {
      const r = await generateVacancyFromMessages(workDir, vs.messages, openrouterKey).catch(e => {
        console.error('[vacancy] generation error:', e.message);
        writeVacancyState(workDir, { ...vs, status: 'collecting' }); // rollback so user can retry
        return '⚠️ Ошибка при генерации вакансии. Попробуй ещё раз — скажи «всё» когда будешь готов.';
      });
      if (r) return r;
    }
  }

  // Publish vacancy landing page — regex fast-path OR Haiku fallback when draft exists
  const hhTokenPath = userId ? path.join(os.homedir(), 'agent-tokens', String(userId), 'hh') : null;
  const hhConnected = hhTokenPath && fs.existsSync(hhTokenPath);
  if (workDir && userId && hhConnected) {
    const wantsPage = VACANCY_PUBLISH_PAGE_INTENT.test(task)
      || await classifyVacancyPublishIntent(task, workDir, openrouterKey);

    if (wantsPage) {
      const vs = readVacancyState(workDir);
      if (vs?.draft) {
        const r = await publishVacancyPage(workDir, vs.draft, vs.vacancy_id, userId).then(url => {
          const missing = getMissingFields(vs.draft);
          const missingNote = missing.length
            ? `\n\n📋 Уточни, чтобы дополнить страницу:\n${missing.join('\n')}`
            : '';
          return [
            '🌐 Страница вакансии опубликована!',
            '',
            url,
            missingNote,
            '',
            'Когда рекрутер даст правки — скажи что изменить, пересоздам страницу.',
            'Готово публиковать на HH? Скажи «опубликуй черновик на HH».',
          ].join('\n');
        }).catch(e => {
          console.error('[vacancy] publish page error (→ Claude):', e.message);
          const vsE = readVacancyState(workDir);
          if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
          return null; // let Claude see the error in its context and handle it
        });
        if (r) return r;
      }
      if (!readVacancyState(workDir)?.draft) {
        return '⚠️ Нет готового черновика вакансии. Сначала создай вакансию — скажи «новая вакансия».';
      }
    }
  }

  // Fast-path: "подготовь черновик вакансии на HH" — when data is already known or being provided
  // Workflow: draft_ready → push to HH immediately; else → start single-shot collecting mode
  if (workDir && userId && hhConnected && VACANCY_PREP_DRAFT_INTENT.test(task)) {
    const vsp = readVacancyState(workDir);
    if (vsp?.status === 'draft_ready' && vsp.draft) {
      const rp = await publishToHH(workDir, userId).then(({ hhId, areaName, areaId }) => {
        const areaNote = areaId ? '' : `\n⚠️ Город «${areaName}» не распознан — вакансия создана с регионом «Россия». Поправь город в черновике на hh.ru.`;
        return [
          `✅ Черновик вакансии сохранён на HeadHunter!`,
          '',
          `🆔 Draft ID: ${hhId}`,
          `🔗 Черновики: https://hh.ru/employer/vacancies/drafts`,
          areaNote,
          '',
          'Черновик НЕ опубликован — он ждёт тебя на hh.ru. Проверь и нажми «Опубликовать» когда будешь готов.',
        ].filter(Boolean).join('\n');
      }).catch(e => {
        console.error('[vacancy] HH publish error (→ Claude):', e.message);
        const vsE = readVacancyState(workDir);
        if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
        return null; // let Claude see the error in its context and handle it
      });
      if (rp) return rp;
    }
    if (vsp?.status === 'collecting') return '⏳ Уже собираем данные для вакансии. Кидай текст — когда всё готово, скажи «всё».';
    if (vsp?.status === 'generating') return '⏳ Уже генерирую черновик вакансии, подожди немного...';
    if (!vsp || ['cancelled', 'hh_draft'].includes(vsp.status)) {
      initVacancyState(workDir);
      return [
        '📋 Готовлю черновик вакансии для HeadHunter!',
        '',
        'Скинь всё что есть: текст с сайта, описание должности, требования, условия.',
        'Можно одним большим куском — всё прочитаю.',
        '',
        'Когда отправишь — скажи «всё», сгенерирую вакансию и выложу черновик на HH.',
      ].join('\n');
    }
  }

  // Publish vacancy as HH draft
  if (workDir && userId && hhConnected && VACANCY_HH_PUBLISH_INTENT.test(task)) {
    const vs2 = readVacancyState(workDir);
    if (!vs2?.draft) {
      return '⚠️ Нет готового черновика вакансии. Сначала создай вакансию — скажи «новая вакансия».';
    }
    const r2 = await publishToHH(workDir, userId).then(({ hhId, areaName, areaId }) => {
      const areaNote = areaId ? '' : `\n⚠️ Город «${areaName}» не распознан — вакансия создана с регионом «Россия». Поправь город в черновике на hh.ru.`;
      return [
        `✅ Черновик вакансии сохранён на HeadHunter!`,
        '',
        `🆔 Draft ID: ${hhId}`,
        `🔗 Черновики: https://hh.ru/employer/vacancies/drafts`,
        areaNote,
        '',
        'Черновик НЕ опубликован — он ждёт тебя на hh.ru. Проверь и нажми «Опубликовать» когда будешь готов.',
      ].filter(Boolean).join('\n');
    }).catch(e => {
      console.error('[vacancy] HH publish error (→ Claude):', e.message);
      const vsE = readVacancyState(workDir);
      if (vsE) writeVacancyState(workDir, { ...vsE, api_error: e.message });
      return null; // let Claude see the error in its context and handle it
    });
    if (r2) return r2;
  }

  if (userId && workDir && hhConnected) {
    const hhIntents = [HH_STATUS_INTENT, HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT,
      HH_RESPONSES_INTENT, HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT,
      HH_WHERE_PROMPT_INTENT, HH_SHOW_ATS_CONFIG_INTENT, HH_STYLE_INTENT,
      HH_EVALUATE_INTENT, HH_SEND_INTENT, HH_SEND_CONFIRM_INTENT, HH_SEND_CANCEL_INTENT,
      HH_REJECT_INTENT, HH_REJECT_CONFIRM_INTENT, HH_REJECT_CANCEL_INTENT, HH_SCAN_INTENT];
    if (hhIntents.some(intent => intent.test(task)) && !task.trim().startsWith('/') &&
        !await verifyQuickAnswerIntent(task, 'Быстрый ответ HeadHunter: вакансии, статистика, ссылки на ревью кандидатов или настройки рекрутинга', openrouterKey)) return null;
    if (HH_STATUS_INTENT.test(task)) return hhStatus(userId);
    if (HH_MY_VACANCIES_INTENT.test(task)) {
      const r = await hhMyVacancies(userId, workDir).catch(() => null);
      if (r) return r;
    }
    if (HH_FUNNEL_INTENT.test(task)) {
      const r = await hhFunnelStats(userId, workDir).catch(() => null);
      if (r) return r;
    }
    if (HH_RESPONSES_INTENT.test(task)) {
      const r = await hhNewResponses(userId, workDir).catch(() => null);
      if (r) return r;
    }
    if (HH_ATS_EDITOR_INTENT.test(task)) return hhAtsEditor(userId);
    if (HH_REVIEW_PAGE_INTENT.test(task)) {
      // Candidate review page — return immediately if active vacancy exists.
      // Vacancy draft existing is irrelevant: user explicitly asked for candidate review, not vacancy publish.
      const av = workDir ? readActiveVacancy(workDir) : null;
      if (av) return hhReviewPage(userId);
    }
    if (HH_WHERE_PROMPT_INTENT.test(task)) return hhWherePrompt(userId);
    if (HH_SHOW_ATS_CONFIG_INTENT.test(task)) return hhShowAtsConfig(userId);
    if (HH_STYLE_INTENT.test(task)) return hhStylePage(userId);
    // Action intents — order matters: confirm/cancel BEFORE the bare intent
    if (HH_SEND_CONFIRM_INTENT.test(task)) return await hhSendConfirm(userId, workDir).catch(() => '⚠️ Не удалось отправить — попробуй ещё раз.');
    if (HH_SEND_CANCEL_INTENT.test(task)) return hhSendCancel(userId, workDir);
    if (HH_SEND_INTENT.test(task)) return await hhSendPreview(userId, workDir, task).catch(() => '⚠️ Не удалось подготовить сообщение.');
    if (HH_REJECT_CONFIRM_INTENT.test(task)) return await hhRejectConfirm(userId, workDir).catch(() => '⚠️ Не удалось отклонить — попробуй ещё раз.');
    if (HH_REJECT_CANCEL_INTENT.test(task)) return hhRejectCancel(userId, workDir);
    if (HH_REJECT_INTENT.test(task)) return await hhRejectDryRun(userId, workDir, task).catch(() => '⚠️ Не удалось подготовить dry-run.');
    if (HH_EVALUATE_INTENT.test(task)) return await hhBatchEvaluate(userId, workDir).catch(() => '⚠️ Не удалось запустить оценку.');
    if (HH_SCAN_INTENT.test(task)) return await hhManualScan(userId, workDir).catch(() => '⚠️ Не удалось запустить скан.');
  }

  // /hh_disconnect — revoke HH token. Outside the hhConnected gate so it works
  // both when a token is saved (revoke it) and when no token exists (idempotent
  // "HH не подключён"). Slash form bypasses verifyQuickAnswerIntent because
  // task starts with '/'.
  if (userId && HH_DISCONNECT_INTENT.test(task)) {
    const revoked = revokeService(userId, 'hh');
    return revoked === 'not_found'
      ? '⚠️ HeadHunter не подключён. Скажи /hh_connect чтобы добавить.'
      : '✅ HeadHunter отключён — токен удалён. Чтобы подключить снова: /hh_connect';
  }

  return null;
}

module.exports = {
  getQuickAnswer,
  verifyQuickAnswerIntent,
  runQuickAnswer,
  // Constants used by runner.js run() function
  STOP_TASK_INTENT,
  GTD_STOP_INTENT,
  ACTIVE_CHECKLIST_INTENT,
  WAKEUP_INTENT,
  SKIP_TASK_INTENT,
  PING_INTENT,
  HELP_INTENT,
  SESSIONS_INTENT,
  SESSION_DETAIL_INTENT,
  USAGE_INTENT,
  SECRETS_LIST_INTENT,
  SECRETS_LOG_INTENT,
  CONTEXT_OFF_INTENT,
  CONTEXT_ON_INTENT,
  PERSONA_INTENT,
  PROJECT_INTENT,
  // Constants for runner.js _intents export
  HH_MY_VACANCIES_INTENT,
  HH_FUNNEL_INTENT,
  HH_RESPONSES_INTENT,
  HH_ATS_EDITOR_INTENT,
  HH_REVIEW_PAGE_INTENT,
  ENGINE_SWITCH_INTENT,
};
