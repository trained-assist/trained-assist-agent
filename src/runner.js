const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeMcpConfig } = require('./browser');
const sessions = require('./session-store');
const { getCurrentSessionId, setCurrentSessionId } = require('./session-store');
const { isAuthError, detectReason, setAuthFailedFlag } = require('./auth-flag');
const { recordUsage, getUsageTotals } = require('./usage-store');
const {
  loadUserTokens,
  listConnectedServices,
  revokeService,
  getSecretsLog,
  generateConnectLink,
  SERVICE_DISPLAY,
} = require('./user-tokens');
const { initLog, readLog } = require('./requirements-log');
const { hhMyVacancies, hhFunnelStats, hhNewResponses, hhAtsEditor, hhReviewPage, hhWherePrompt, hhShowAtsConfig, hhStylePage } = require('./hh-quick');
const { readVacancyState, initVacancyState, appendVacancyMessage, writeVacancyState, generateVacancyFromMessages, publishVacancyPage, publishToHH } = require('./hh-vacancy');

const STREAM_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 3000;
const MAX_MSG_LEN = 3500;
const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min hard limit — batch INN enrichment takes 10-15 min for 300 companies

// ── Pending-task journal — survives process restart ──────────────────────────
const PENDING_DIR = path.join(
  process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  'pending-tasks'
);

function savePendingTask(taskId, params) {
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(path.join(PENDING_DIR, `${taskId}.json`), JSON.stringify(params), { mode: 0o600 });
  } catch { /* non-critical */ }
}

function clearPendingTask(taskId) {
  try { fs.unlinkSync(path.join(PENDING_DIR, `${taskId}.json`)); } catch { /* non-critical */ }
}

function getPendingTasks() {
  try {
    if (!fs.existsSync(PENDING_DIR)) return [];
    return fs.readdirSync(PENDING_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Quick answers — bypass Claude for known setup/secrets patterns ───────────
// Returns a string if the task matches, null otherwise.

const SETUP_INTENT          = /подключ|connect|настро|интегр|привяз|как.*добав|могу.*отправ|зайт|авториз|setup|подрубить/i;
const INN_CAPABILITY_INTENT  = /(?:скил|skill|умееш|можешь|есть.{0,30}возможн|есть.{0,30}функц|есть.{0,30}инструм|что.{0,20}умееш).{0,80}(?:инн|огрн|компани|директор|выручк|реквизит)/i;
// Only capability/question words, NOT action verbs (собери/собрать/найди → those are tasks, go to Claude)
const EXPO_CAPABILITY_INTENT = /(?:скил|skill|умееш|можешь|есть.{0,30}(?:скил|инструм|возможн)).{0,80}(?:участник|экспонент|выставк|expo)/i;
const GC_CAPABILITY_INTENT   = /(?:умееш|можешь|есть.{0,30}(?:скил|инструм|возможн|функц)|что.{0,20}умееш).{0,80}(?:геткурс|getcourse|курс|урок|ученик|школ)/i;
const SECRETS_LIST_INTENT   = /^\/secrets_list$|список.{0,15}подключённых|какие.{0,15}подключ|покажи.{0,15}сервис|мои.{0,15}доступ/i;
const SECRETS_LOG_INTENT    = /^\/secrets_log$|история.{0,15}доступ|лог.{0,15}секрет|обращени.{0,15}секрет/i;
const REVOKE_INTENT         = /отзов|revoke|удал.{0,10}доступ|отключ.{0,10}сервис|убер.{0,10}доступ/i;
const REVOKE_SERVICE_RE     = /(github|гитхаб|weeek|вик|nalog|налог|нпд|самозан|figma|фигма|notion|linear|tilda|тильда|gdrive|гугл|google|dadata)/i;
// "на какой email шарить", "почта SA", "дай адрес google" — always read from disk, never hallucinate
const GDRIVE_SA_EMAIL_INTENT  = /(?:почт|email|e-mail|адрес).{0,40}(?:сервис|service|sa\b)|(?:сервис|service|sa\b).{0,40}(?:почт|email|e-mail|аккаун)|дай.{0,30}(?:почт|email|адрес).{0,30}(?:гугл|google|drive|аккаун)|на\s+(?:какой|что|какую).{0,30}(?:шар|поделить|пошар)|куда.{0,20}(?:шар|поделить|пошар)/i;
// "пошарить таблицу тебе", "поделиться файлом", "как дать доступ к гугл" — needs SA email answer
// verb forms only (пошари/пошарить/шари), not past/adj (пошаренные/пошарено — those go to LIST)
const GDRIVE_SHARE_INTENT     = /(?:пошар[иьюшт]|поделить|шар[иьюшт]|дать?\s+доступ).{0,50}(?:гугл|google|таблиц|докс|docs|sheets|файл|документ)|(?:гугл|google|таблиц|докс|docs|sheets|файл|документ).{0,50}(?:пошар[иьюшт]|поделить|шар[иьюшт]|дать?\s+доступ)/i;
// "мои файлы гугл", "что мне пошарено", "список документов"
const GDRIVE_LIST_INTENT      = /(?:мои|покажи|список|какие).{0,20}(?:файл|документ|гугл|google|пошарен)|(?:что|какие).{0,30}(?:пошарено|пошарил|открыл)|gdrive.{0,20}(?:файл|документ|список)/i;
// "можешь читать гугл шит", "умеешь работать с гугл таблицами"
const GDRIVE_CAPABILITY_INTENT = /(?:можешь|умеешь|можно|способен|поддержива).{0,40}(?:гугл|google|sheets|docs|csv|таблиц|документ|гшит|spreadsheet)/i;
const SESSIONS_INTENT       = /^\/sessions$|мои.{0,10}диалог|мои.{0,10}сессии|список.{0,10}диалог|покажи.{0,10}истори|мои.{0,10}задач/i;
const HH_MY_VACANCIES_INTENT = /мои.{0,10}вакансии|список.{0,10}вакансий|какие.{0,10}вакансии|с чем работать|покажи.{0,15}вакансии|дай.{0,15}вакансии|мои.{0,10}активные/i;
const HH_FUNNEL_INTENT      = /сколько откликов|статистика воронки|что новенького|воронка кандидатов|статистика.{0,15}вакансии|кандидатов по.{0,15}вакансии|обновление.{0,15}вакансии/i;
const HH_RESPONSES_INTENT   = /новые отклики|кто откликнулся|покажи.{0,10}кандидатов|новых кандидатов|список откликов|пришли отклики|новые кандидаты/i;
const HH_ATS_EDITOR_INTENT  = /открой.{0,10}(?:ats|редактор|конфигуратор)|ats.{0,10}(?:редактор|editor|открой|настрой)|редактор.{0,10}ats|(?:скин|дай|пришл|покажи|дай).{0,20}(?:страниц|ссылк).{0,30}(?:настройк|candidate.?flow|ats|воронк|funnel)|страниц.{0,15}(?:настройк|candidate.?flow|ats|воронк|funnel)|candidate.?flow.{0,20}(?:страниц|ссылк|настройк|редактор)/i;
const HH_REVIEW_PAGE_INTENT = /страниц.{0,20}ревью|ревью.{0,20}кандидат|страниц.{0,20}кандидат|открой.{0,15}кандидат|ссылк.{0,20}кандидат|покажи.{0,15}ссылк|хочу.{0,20}посмотреть.{0,20}откликнувш/i;
const HH_WHERE_PROMPT_INTENT = /где.{0,30}(?:промпт|конфиг|настройк|критери).{0,30}(?:ats|воронк|оценк|кандидат)|(?:промпт|конфиг|настройки).{0,30}(?:ats|воронк|оценк|кандидат)|как.{0,30}(?:посмотреть|правит|редактиров|изменить).{0,50}(?:промпт|конфиг|критери|воронк|оценк)/i;
const HH_SHOW_ATS_CONFIG_INTENT = /(?:покажи|посмотр|какие|что за|дай|вывед).{0,30}(?:правила|критери|оценк|ats|конфиг|настройк).{0,30}(?:кандидат|воронк|оценк|скрининг|ats)|(?:правила|критери|настройки).{0,20}(?:для|по).{0,10}(?:кандидат|оценк|скрининг)|ats.{0,15}правила|что.{0,15}у меня.{0,30}(?:правила|критери|оценк|ats)/i;
const HH_STYLE_INTENT        = /(?:обнови|загрузи|обновить|загрузить|настрой|поменяй|задай|update).{0,30}стиль|стиль.{0,30}(?:общения|переписки|сообщений|рекрут)|communication.{0,15}style|update.{0,15}style/i;
const ILLUSTRATE_CAPABILITY_INTENT = /(?:умееш|можешь|есть.{0,30}(?:скил|инструм|возможн|функц)|что.{0,20}умееш).{0,80}(?:иллюстр|нарисова|рисовать|картинк|изображен|illustrat|draw|image.gen)/i;
const ILLUSTRATE_ENABLE_INTENT = /включ.{0,20}(?:рисован|иллюстр|картинк|рисунок)|добав.{0,20}(?:рисован|иллюстр|генерац)|активируй.{0,20}(?:рисован|иллюстр|скил.{0,10}рисован)|\/enable_illustrate/i;
// Matches concrete draw commands with subject content — these go to Claude even when skill is enabled
const ILLUSTRATE_DRAW_COMMAND = /(?:нарисуй|нарисовать|создай.{0,20}(?:иллюстр|картинк|схем)|сделай.{0,20}(?:иллюстр|картинк|схем)|покажи.{0,20}(?:схем|как устроен|анатоми))\s+\S.{5,}/i;
const NEW_JOB_INTENT            = /новая вакансия|new job post|\/new_job_post|создать вакансию|добавить вакансию|создай вакансию/i;
const VACANCY_DONE_INTENT       = /^всё$|^все$|^готово$|^хватит$|^достаточно$|^запускай$|^стоп, всё$|^всё, запускай$|^ок, всё$/i;
const VACANCY_CANCEL_INTENT     = /отмен.{0,20}вакансии|отмен.{0,20}созда|выйт.{0,15}режим|стоп.{0,10}вакансия|сброс.{0,15}вакансии|\/cancel_vacancy/i;
const VACANCY_PUBLISH_PAGE_INTENT = /публику[йе].{0,20}страниц|создай.{0,20}страниц.{0,20}вакансии|опубликуй.{0,20}лендинг|создай.{0,20}лендинг|страниц.{0,20}готов/i;
const VACANCY_HH_PUBLISH_INTENT   = /опубликуй.{0,20}(?:черновик.{0,15}(?:на\s+)?(?:hh|хх)|(?:на\s+)?(?:hh|хх).{0,15}черновик)|загрузи.{0,20}(?:на\s+)?(?:hh|хх)|публикуй.{0,20}(?:на\s+)?(?:hh|хх)|сохрани.{0,20}черновик.{0,20}(?:hh|хх)/i;
const USAGE_INTENT          = /^\/usage$|сколько.{0,20}потратил|токен.{0,20}статистик|использован.{0,20}токен|стоимость.{0,20}сессий|расход.{0,20}токен/i;
const PING_INTENT           = /^\/ping$|^ты живой|^ты онлайн|^ты работаешь|^привет бот|^ping$/i;
const HELP_INTENT           = /^\/help$|^\/start$|что.{0,10}умееш|чем.{0,10}помож|какие.{0,10}возможн|список.{0,10}команд|помощь/i;
const EXPO_CRITERIA_INTENT  = /требовани.{0,20}(?:целев|компани|квалиф)|критери.{0,20}(?:целев|отбор|компани|выставк)|целев.{0,20}(?:критери|требовани|компани)|покажи.{0,15}критери|мои.{0,10}критери|expo.{0,10}criteria|target.{0,10}criteria/i;
const EXPO_STATUS_INTENT    = /статус.{0,20}(?:пайплайн|pipeline|выставк|обработк)|pipeline.{0,10}статус|сколько.{0,15}целевых|сколько.{0,15}компаний.{0,20}(?:выставк|обработан|pipeline)|expo.{0,10}статус/i;
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
    service: null,
    hint: 'Нужен удалённый браузер — скажи мне "подключи Tilda".',
  },
  {
    match: /nalog|налог|нпд|самозан/i,
    service: 'nalog',
    hint: 'Войдёшь через Госуслуги — страница защищена, данные не проходят через чат.',
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
];

function getQuickAnswer(task, userId, workDir) {
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
    const lines = list.map((s, i) => {
      const d = new Date(s.lastAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      return `${i + 1}. ${s.topic.slice(0, 60)} (${d}, ${s.messageCount} сообщ.)`;
    });
    return '💬 Последние диалоги:\n' + lines.join('\n');
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
    const result = revokeService(userId, svcMatch[1]);
    if (result === null) return `Не распознал сервис «${svcMatch[1]}». Доступные: GitHub, Weeek, Налог.ру, Figma, Tilda, Google Drive.`;
    if (result === 'not_found') return `Сервис «${svcMatch[1]}» не был подключён.`;
    return `✅ Доступ к ${SERVICE_DISPLAY[result] || result} отозван. Данные удалены с сервера.`;
  }

  // "мои файлы гугл", "что мне пошарено", "список документов" — LIST before SHARE (пошаренные matches both)
  if (GDRIVE_LIST_INTENT.test(task) && userId) {
    const catalogPath2 = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-catalog.json');
    try {
      const catalog2 = JSON.parse(fs.readFileSync(catalogPath2, 'utf8'));
      if (!catalog2.length) return '📂 Пока нет пошаренных файлов. Поделись файлом — пришлю уведомление и запишу в список.';
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
    } catch {}
    return '📂 Пока нет пошаренных файлов. Поделись файлом через Google Drive — пришлю уведомление.';
  }

  // "можешь читать гугл шит", "умеешь работать с csv/таблицами"
  if (GDRIVE_CAPABILITY_INTENT.test(task)) {
    if (!userId) return null;
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
          'Google Drive уже подключён. Пошари файл — и пришли мне ссылку или скажи «прочитай [название]».',
        ].join('\n')
      : null; // not configured — let Claude call gdrive_setup automatically
  }

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
          'Как только пошаришь — пришлю уведомление и смогу читать файл.',
        ].join('\n');
      }
    } catch {}
    // SA email asked explicitly — give a helpful "not configured" message instead of routing to Claude
    if (GDRIVE_SA_EMAIL_INTENT.test(task)) {
      return 'Google Drive не настроен. Напиши «подключи Google Drive» — помогу настроить за пару минут.';
    }
    return null; // share intent without config — let Claude call gdrive_setup automatically
  }

  // Capability question about illustration generation
  if (ILLUSTRATE_ENABLE_INTENT.test(task) || ILLUSTRATE_CAPABILITY_INTENT.test(task)) {
    // If the message also contains a concrete drawing subject — let Claude handle it directly
    if (ILLUSTRATE_DRAW_COMMAND.test(task)) return null;

    const illustrateFlagPath = require('path').join(workDir, 'contexts', 'illustrate', '.enabled');
    const illustrateEnabled = require('fs').existsSync(illustrateFlagPath);

    if (ILLUSTRATE_ENABLE_INTENT.test(task)) {
      if (illustrateEnabled) {
        return 'Скил иллюстраций уже включён. Опиши что нарисовать — и начнём!';
      }
      require('fs').mkdirSync(require('path').dirname(illustrateFlagPath), { recursive: true });
      require('fs').writeFileSync(illustrateFlagPath, JSON.stringify({ enabled_at: new Date().toISOString() }));
      return 'Готово! Скил генерации иллюстраций включён.\n\nТеперь могу рисовать медицинские схемы, анатомические диаграммы и инфографику.\nИспользую DALL-E 3 (основной) и Ideogram (альтернатива, лучше с подписями).\n\nОпиши что нарисовать — и начнём!';
    }

    // ILLUSTRATE_CAPABILITY_INTENT
    if (illustrateEnabled) {
      return 'Да, скил иллюстраций включён.\n\nПросто опиши что нарисовать — голосом или текстом. Например:\n• «нарисуй как работают потовые железы в коже»\n• «схема слоёв эпидермиса в разрезе»\n• «инфографика про уход за кожей»\n\nСтили: медицинская схема, flat design, детальная анатомия, инфографика.\nПосле картинки могу наложить подписи по-русски отдельным инструментом.';
    }
    return 'Есть скил генерации иллюстраций (DALL-E 3 + Ideogram), но он ещё не включён.\n\nНапиши «включи рисование» — и я активирую его для тебя.';
  }

  // Capability question about exhibition participants — check before INN (expo+INN combo questions → expo answer)
  if (EXPO_CAPABILITY_INTENT.test(task)) {
    return 'Да, умею собирать участников выставок.\n\nДай мне ссылку на сайт выставки — зайду, найду страницу участников и верну список компаний в CSV.\n\nДальше могу обогатить по ИНН: директор, выручка, сайт — скидывай сразу с таким запросом, если нужно.\n\nПришли URL сайта выставки.';
  }

  // Capability question about INN enrichment — answer immediately without calling Claude
  if (INN_CAPABILITY_INTENT.test(task)) {
    return 'Да, есть скил INN Enrichment.\n\nНаходит для списка компаний (300–1000 шт): ИНН, ОГРН, директора, выручку и прибыль.\n\nИсточники: БФО ФНС (бесплатно), ЕГРЮЛ, DaData, Checko — всё уже настроено, ключи у платформы.\n\nЧасть запросов платные (DaData, Checko), но не переживайте — мы предоставляем пакет ощутимого размера, чтобы получить результат. Если понадобится больше — докупим вместе.\n\nПришли JSON-файл, CSV или ссылку на Google Sheet со списком компаний — и запущу.';
  }

  // Capability question about GetCourse
  if (GC_CAPABILITY_INTENT.test(task)) {
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

  // Expo pipeline — target criteria (quick read from disk, no LLM)
  if (EXPO_CRITERIA_INTENT.test(task) && workDir) {
    try {
      const { formatCriteriaText, readCriteria } = require('./mcp-skills/tools/87-expo-pipeline.js');
      const criteria = readCriteria(workDir);
      return formatCriteriaText(criteria);
    } catch (e) {
      console.error('[quick-answer] expo criteria error:', e.message);
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
            } catch { return null; }
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

  if (!SETUP_INTENT.test(task)) {
    console.log('[quick-answer] no setup intent, task=%j', task.slice(0, 120));
    return null;
  }

  for (const { match, service, hint } of QUICK_SETUPS) {
    if (!match.test(task)) continue;
    console.log('[quick-answer] matched service=%s uid=%s', service || 'null', userId);
    if (service && userId) {
      try {
        const link = generateConnectLink(userId, service);
        return `Данные для входа — по ссылке:\n${link}\n\n${hint}${TRUST_FOOTER}`;
      } catch (e) {
        console.error('[quick-answer] generateConnectLink failed:', e.message);
        return hint;
      }
    }
    return hint;
  }

  console.log('[quick-answer] setup intent matched but no service pattern, task=%j', task.slice(0, 120));
  return null;
}

// Async wrapper: sync quick-answer first, then HH API handlers (no Claude).
async function runQuickAnswer(task, userId, workDir, apiKey = null) {
  const sync = getQuickAnswer(task, userId, workDir);
  if (sync !== null) return sync;

  // Vacancy generation — triggered when collecting mode is done ("всё" set status → "generating")
  if (workDir && apiKey) {
    const vs = readVacancyState(workDir);
    if (vs?.status === 'generating' && vs.messages?.length > 0) {
      const r = await generateVacancyFromMessages(workDir, vs.messages, apiKey).catch(e => {
        console.error('[vacancy] generation error:', e.message);
        writeVacancyState(workDir, { ...vs, status: 'collecting' }); // rollback so user can retry
        return '⚠️ Ошибка при генерации вакансии. Попробуй ещё раз — скажи «всё» когда будешь готов.';
      });
      if (r) return r;
    }
  }

  // Publish vacancy landing page — triggered when draft is ready and user says "публикуй страницу"
  if (workDir && userId && VACANCY_PUBLISH_PAGE_INTENT.test(task)) {
    const vs = readVacancyState(workDir);
    if (vs?.status === 'draft_ready' && vs.draft) {
      const r = await publishVacancyPage(workDir, vs.draft, vs.vacancy_id, userId).then(url => {
        return [
          '🌐 Страница вакансии опубликована!',
          '',
          url,
          '',
          'Отправь эту ссылку рекрутеру для ревью. Кандидаты смогут откликнуться прямо со страницы.',
          '',
          'Когда рекрутер даст правки — скажи что изменить, пересоздам страницу.',
          'Готово публиковать на HH? Скажи «опубликуй черновик на HH».',
        ].join('\n');
      }).catch(e => {
        console.error('[vacancy] publish page error:', e.message);
        return `⚠️ Ошибка при публикации страницы: ${e.message}`;
      });
      if (r) return r;
    }
    if (!vs?.draft) {
      return '⚠️ Нет готового черновика вакансии. Сначала создай вакансию — скажи «новая вакансия».';
    }
  }

  // Publish vacancy as HH draft
  if (workDir && userId && VACANCY_HH_PUBLISH_INTENT.test(task)) {
    const vs2 = readVacancyState(workDir);
    if (!vs2?.draft) {
      return '⚠️ Нет готового черновика вакансии. Сначала создай вакансию — скажи «новая вакансия».';
    }
    const r2 = await publishToHH(workDir, userId).then(({ hhId, areaName, areaId }) => {
      const areaNote = areaId ? '' : `\n⚠️ Город «${areaName}» не распознан — вакансия создана с регионом «Россия». Поправь город в черновике на hh.ru.`;
      return [
        `✅ Черновик вакансии сохранён на HeadHunter!`,
        '',
        `🆔 ID вакансии: ${hhId}`,
        `🔗 Редактировать: https://hh.ru/employer/vacancy/${hhId}/edit`,
        areaNote,
        '',
        'Проверь черновик на hh.ru и опубликуй когда будешь готов.',
      ].filter(Boolean).join('\n');
    }).catch(e => {
      console.error('[vacancy] HH publish error:', e.message);
      return `⚠️ Ошибка при публикации на HH: ${e.message}`;
    });
    if (r2) return r2;
  }

  if (userId && workDir) {
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
    if (HH_REVIEW_PAGE_INTENT.test(task)) return hhReviewPage(userId);
    if (HH_WHERE_PROMPT_INTENT.test(task)) return hhWherePrompt(userId);
    if (HH_SHOW_ATS_CONFIG_INTENT.test(task)) return hhShowAtsConfig(userId);
    if (HH_STYLE_INTENT.test(task)) return hhStylePage(userId);
  }

  return null;
}

// Per-user serial task queue: Map<userId, Promise>
// Prevents concurrent Claude processes for the same user (OOM risk on small VMs).
const userQueues = new Map();

/**
 * Runs `claude --dangerously-skip-permissions` for a task,
 * streams output to Telegram by editing a "thinking" message.
 * Tasks for the same user are serialised — each waits for the previous to finish.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {object} opts.user   - { id, name, username, workDir }
 * @param {string} opts.task
 * @param {string|null} opts.context
 * @param {string|null} opts.sessionId  - existing session to append to
 * @param {object} opts.secrets - { BOT_TOKEN, ANTHROPIC_API_KEY, ... }
 */
function runTask(opts) {
  const userId = String(opts.user.id);
  const prev = userQueues.get(userId) ?? Promise.resolve();
  const current = prev.then(() => _runTask(opts)).catch(err => {
    console.error(`[${opts.taskId}] unhandled queue error:`, err.message);
  });
  userQueues.set(userId, current);
  current.finally(() => {
    clearPendingTask(opts.taskId);
    // Only clear if no newer task was enqueued after us
    if (userQueues.get(userId) === current) userQueues.delete(userId);
  });
  return current;
}

// Returns context card string, or null if no skills configured (no pin needed).
function buildContextCard(username, workDir) {
  const services = username ? listConnectedServices(username) : [];
  if (!services || !services.length) return null;

  // Build service labels, merging inline details where available
  const gcConfig = path.join(os.homedir(), 'agent-tokens', String(username), 'getcourse', 'config.json');
  let gcDomain = null;
  if (fs.existsSync(gcConfig)) {
    try { gcDomain = JSON.parse(fs.readFileSync(gcConfig, 'utf8')).accountDomain || null; } catch {}
  }

  const serviceLabels = services.map(s => {
    if (s.file === 'getcourse' && gcDomain) return `getcourse: ${gcDomain}`;
    return s.name;
  });

  const lines = ['📌 Контекст', '', `🔗 Подключено: ${serviceLabels.join(' · ')}`];

  const PINNED_CONTEXTS = [
    { skill: 'hh', key: 'active_vacancy', label: '💼' },
    { skill: 'gdrive', key: 'pinned_folder', label: '📁' },
  ];
  for (const { skill, key, label } of PINNED_CONTEXTS) {
    const file = path.join(workDir, 'contexts', skill, `${key}.json`);
    if (fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (d.value) {
          const v = typeof d.value === 'string' ? d.value : JSON.stringify(d.value);
          lines.push(`${label} ${v.slice(0, 80)}`);
        }
      } catch {}
    }
  }

  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  lines.push('');
  lines.push(`⏱ ${time} МСК`);

  return lines.join('\n');
}

// Creates or silently updates the context pin after task completion.
// State (msgId + lastCard text) is stored in workDir/.pin_state.json.
async function updateContextPin(token, chatId, workDir, card) {
  const pinFile = path.join(workDir, '.pin_state.json');
  let state = null;
  try { state = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch {}

  if (state?.msgId) {
    // Nothing changed — skip entirely to avoid Telegram "message is not modified" error
    // which would be misread as a failed edit and trigger a duplicate pin.
    if (state.lastCard === card) return;

    const edited = await tgEdit(token, chatId, state.msgId, card).catch(() => null);
    if (edited?.ok) {
      fs.writeFileSync(pinFile, JSON.stringify({ msgId: state.msgId, lastCard: card }));
      return;
    }
    // Edit failed (message deleted?) — fall through to create new
  }

  // No existing pin — send new card message and pin it
  const msg = await tgSend(token, chatId, card);
  const newId = msg?.result?.message_id;
  if (!newId) return;

  const res = await fetch(`${TG_API}/bot${token}/pinChatMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: newId, disable_notification: false }),
  });
  const pinData = await res.json();
  if (!pinData.ok) {
    console.error(`[pin] failed chat=${chatId}:`, JSON.stringify(pinData));
  } else {
    fs.writeFileSync(pinFile, JSON.stringify({ msgId: newId, lastCard: card }));
  }
}

async function _runTask({ taskId, user, task, context, sessionId, contextFromSession, forceClaude, initialMsgId, pinnedMsgId, secrets }) {
  const { BOT_TOKEN } = secrets;
  const chatId = user.id;

  savePendingTask(taskId, {
    taskId, userId: user.id, username: user.username, workDir: user.workDir,
    task, context, sessionId, contextFromSession, forceClaude,
    initialMsgId, pinnedMsgId,
    startedAt: Date.now(),
  });

  fs.mkdirSync(user.workDir, { recursive: true });
  initLog(user.workDir);

  // Resolve session context without writing to disk yet.
  // Session creation / message appending is deferred until we know this is not a utility command.
  let activeSessionId = null;
  let sessionContext = context;
  let sessionExists = false; // true when continuing an existing session (not creating)

  if (sessionId) {
    // Explicit session ID from bot — always honor it, create if needed
    activeSessionId = sessionId;
    const existing = sessions.getSession(user.workDir, sessionId);
    if (existing) {
      sessionExists = true;
      const fromSession = sessions.buildContext(user.workDir, sessionId);
      if (fromSession) sessionContext = context ? `${fromSession}\n\n${context}` : fromSession;
    }
  } else {
    // No explicit session — try to continue the most recent one (within 4h)
    const currentId = getCurrentSessionId(user.workDir);
    if (currentId && sessions.getSession(user.workDir, currentId)) {
      activeSessionId = currentId;
      sessionExists = true;
      const fromSession = sessions.buildContext(user.workDir, currentId);
      if (fromSession) sessionContext = context ? `${fromSession}\n\n${context}` : fromSession;
    }
  }

  if (contextFromSession && !sessionExists) {
    const sourceCtx = sessions.buildContext(user.workDir, contextFromSession);
    if (sourceCtx) sessionContext = context ? `${sourceCtx}\n\n${context}` : sourceCtx;
  }

  // When forceClaude=true (user tapped the expand button), recover task from session if not provided
  if (forceClaude && !task && activeSessionId && sessionExists) {
    const sess = sessions.getSession(user.workDir, activeSessionId);
    task = sess?.lastUserMessage || task;
  }

  // Persist chatId early — needed by OAuth callbacks (e.g. HH, GDrive) that fire
  // after a quick-answer early-return and never reach the Claude path below.
  try {
    const tDir = path.join(os.homedir(), 'agent-tokens', String(user.username));
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(tDir, '.chatid'), String(chatId), { mode: 0o600 });
    const oldChatDir = path.join(os.homedir(), 'agent-tokens', String(user.id));
    if (fs.existsSync(oldChatDir)) {
      fs.writeFileSync(path.join(oldChatDir, '.username'), String(user.username), { mode: 0o600 });
    }
  } catch { /* non-critical */ }

  // Quick answer — bypass Claude. Utility commands skip session logging entirely.
  // forceClaude=true skips quick answers entirely (user explicitly wants Claude).
  const quickReply = forceClaude ? null : await runQuickAnswer(task, user.username, user.workDir, secrets.ANTHROPIC_API_KEY);
  if (quickReply) {
    console.log('[%s] quick-answer len=%d', taskId, quickReply.length);
    const isUtility = PING_INTENT.test(task) || HELP_INTENT.test(task) ||
      SESSIONS_INTENT.test(task) || USAGE_INTENT.test(task) ||
      SECRETS_LIST_INTENT.test(task) || SECRETS_LOG_INTENT.test(task);

    if (!isUtility) {
      if (sessionExists) {
        sessions.appendUserMessage(user.workDir, activeSessionId, task);
        sessions.appendReply(user.workDir, activeSessionId, quickReply);
      } else {
        // New conversation — create session with first exchange
        activeSessionId = sessions.createSession(user.workDir, { task, id: activeSessionId || undefined });
        sessions.appendReply(user.workDir, activeSessionId, quickReply);
      }
      setCurrentSessionId(user.workDir, activeSessionId);
    }
    // NOTE: if you add a new callback_data format here, add a handler in
    // trained-assist-tg-bot/src/handlers/callbacks.js AND add the prefix to
    // KNOWN_CALLBACK_PREFIXES in trained-assist-tg-bot/tests/callbacks.test.js
    const expandMarkup = activeSessionId && !isUtility
      ? { inline_keyboard: [[{ text: '↗️ вдумчивее плиз', callback_data: `ask_claude|${activeSessionId}` }]] }
      : null;
    await tgSend(BOT_TOKEN, chatId, `⚡ ${quickReply}`, expandMarkup ? { reply_markup: expandMarkup } : {});
    return quickReply;
  }

  // Claude path — finalize session (create or append user message)
  if (sessionExists) {
    sessions.appendUserMessage(user.workDir, activeSessionId, task);
  } else {
    activeSessionId = sessions.createSession(user.workDir, { task, id: activeSessionId || undefined });
  }

  // Use bot's pinned placeholder if provided; otherwise send our own
  let msgId = initialMsgId || null;
  if (!msgId) {
    const thinkMsg = await tgSend(BOT_TOKEN, chatId, '⏳ Думаю…');
    msgId = thinkMsg?.result?.message_id;
  }
  const thinkingStart = Date.now();

  const userTokens = loadUserTokens(user.username, user.id);

  // Expired nalog token — tell user immediately, don't waste Claude on it
  const needsNalog = /nalog|налог|нпд|lknpd|самозан|чек|фнс/i.test(task);
  if (needsNalog && userTokens.NALOG_TOKEN_EXPIRES && new Date(userTokens.NALOG_TOKEN_EXPIRES) < new Date()) {
    const expiredMsg = [
      '🔒 Токен Налог.ру истёк.',
      '',
      'Чтобы обновить:',
      '1. Открой lknpd.nalog.ru в Chrome',
      '2. Нажми иконку cloud-auth-bridge → «Send token»',
      '',
      'После этого повтори запрос.',
    ].join('\n');
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, expiredMsg).catch(() => tgSend(BOT_TOKEN, chatId, expiredMsg));
    else await tgSend(BOT_TOKEN, chatId, expiredMsg);
    return expiredMsg;
  }

  // Inject requirements log so Claude can track and update user requirements
  const reqLog = readLog(user.workDir);
  const reqLogSection = reqLog
    ? `[REQUIREMENTS LOG — обновляй в конце каждой задачи]\n${reqLog}`
    : '';

  // Inject per-user agent notes (adaptive logic refinements written by the agent itself)
  const notesPath = path.join(user.workDir, 'agent-notes.md');
  const agentNotes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : '';
  const notesSection = agentNotes
    ? `[AGENT NOTES — твои собственные заметки о логике/решениях для этого юзера]\n${agentNotes}`
    : '';

  // Skills are now available via trained-skills MCP (tools/list → list_skills).
  // No prompt injection needed — Claude discovers and calls tools directly.
  //
  // Context ordering: notes → requirements log → session history → current user message.
  // "Пользователь:" prefix on the current task is critical when session context is
  // present — without it Claude reads the last session message as the current request.
  let baseContext = [notesSection, reqLogSection].filter(Boolean).join('\n\n');
  if (sessionContext) baseContext = baseContext ? `${baseContext}\n\n${sessionContext}` : sessionContext;
  const currentTask = sessionContext ? `Пользователь: ${task}` : task;
  const prompt = baseContext ? `${baseContext}\n\n${currentTask}` : currentTask;
  const fullOutput = { text: '' };

  const sessionFilePath = activeSessionId
    ? path.join(user.workDir, 'sessions', `${activeSessionId}.json`)
    : '';

  // Write per-user MCP config — gives Claude access only to this user's Chrome profile
  const mcpConfig = writeMcpConfig(user.workDir, user.username, { userName: user.name, userHandle: user.username, sessionFilePath });

  // Strip ANTHROPIC_API_KEY so Claude uses OAuth from ~/.claude/.credentials.json.
  // The API key account is out of credits; OAuth (Mac subscription) has no per-token billing.
  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;

  const systemPromptFile = path.join(__dirname, 'agent-system-prompt.txt');

  const proc = spawn(process.env.CLAUDE_BIN || 'claude', [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', mcpConfig,
    ...(fs.existsSync(systemPromptFile) ? ['--append-system-prompt-file', systemPromptFile] : []),
    '--print', prompt,
  ], {
    cwd: user.cwd || user.workDir,
    env: {
      ...cleanEnv,
      ...userTokens,
      AGENT_USER_ID: String(user.username),
      AGENT_CHAT_ID: String(chatId),
      ...(secrets.BOT_TOKEN      ? { AGENT_BOT_TOKEN:    secrets.BOT_TOKEN }      : {}),
      ...(secrets.OPENAI_API_KEY ? { OPENAI_API_KEY:     secrets.OPENAI_API_KEY } : {}),
      ...(secrets.FAL_KEY        ? { FAL_KEY:            secrets.FAL_KEY }        : {}),
      ...(secrets.IDEOGRAM_API_KEY ? { IDEOGRAM_API_KEY: secrets.IDEOGRAM_API_KEY } : {}),
      ...(secrets.RECRAFT_API_KEY  ? { RECRAFT_API_KEY:  secrets.RECRAFT_API_KEY }  : {}),
      ...(user.name     ? { AGENT_USER_NAME: user.name }         : {}),
      ...(user.username ? { AGENT_USER_HANDLE: user.username }   : {}),
      ...(sessionFilePath ? { AGENT_SESSION_FILE: sessionFilePath } : {}),
    },
  });

  let streamTimer = null;
  let heartbeatTimer = null;
  let outputStarted = false;
  let lastSent = '';
  let lineBuffer = '';
  let claudeResult = null;  // text from result event
  let claudeUsage = null;   // usage from result event
  let lastActivity = '';     // last tool name/cmd for heartbeat
  let exitCode = 0;

  // Heartbeat: show elapsed seconds while Claude hasn't produced output yet
  if (msgId) {
    heartbeatTimer = setInterval(async () => {
      if (outputStarted) return;
      const secs = Math.round((Date.now() - thinkingStart) / 1000);
      const label = lastActivity || 'Думаю…';
      await tgEdit(BOT_TOKEN, chatId, msgId, `⏳ ${label} (${secs}с)`).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleStream() {
    if (streamTimer) return;
    outputStarted = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    streamTimer = setInterval(async () => {
      const snippet = fullOutput.text.slice(-MAX_MSG_LEN);
      const secs = Math.round((Date.now() - thinkingStart) / 1000);
      if (snippet) {
        // Show text + current tool activity (always updating so user sees seconds ticking)
        const activitySuffix = lastActivity ? `\n\n${lastActivity} (${secs}с)` : ` (${secs}с)`;
        const newText = `⏳ ${snippet}${activitySuffix}`;
        if (newText === lastSent) return;
        lastSent = newText;
        if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, newText).catch(() => {});
      } else {
        // No text yet (e.g. Claude running tools) — show activity + elapsed
        const label = lastActivity || 'Думаю…';
        const newText = `⏳ ${label} (${secs}с)`;
        if (newText === lastSent) return;
        lastSent = newText;
        if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, newText).catch(() => {});
      }
    }, STREAM_INTERVAL_MS);
  }

  proc.stdout.on('data', chunk => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep trailing incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') {
          claudeResult = typeof event.result === 'string' ? event.result : null;
          claudeUsage = event.usage || null;
          if (claudeUsage) {
            console.log(`[${taskId}] usage: in=${claudeUsage.input_tokens} out=${claudeUsage.output_tokens} cache_read=${claudeUsage.cache_read_input_tokens || 0} cache_write=${claudeUsage.cache_creation_input_tokens || 0}`);
          }
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              fullOutput.text += block.text;
            } else if (block.type === 'tool_use') {
              lastActivity = formatToolActivity(block.name, block.input);
              if (!outputStarted && msgId) {
                const secs = Math.round((Date.now() - thinkingStart) / 1000);
                tgEdit(BOT_TOKEN, chatId, msgId, `⏳ ${lastActivity} (${secs}с)`).catch(() => {});
              }
            }
          }
          scheduleStream();
        }
      } catch {
        // Non-JSON line (e.g. startup messages) — treat as plain text
        fullOutput.text += line + '\n';
        scheduleStream();
      }
    }
  });

  proc.stderr.on('data', chunk => console.error(`[${taskId}] stderr:`, chunk.toString()));

  let timedOut = false;
  try {
    await new Promise((resolve, reject) => {
      const killTimer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
        reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
      }, CLAUDE_TIMEOUT_MS);

      proc.on('close', (code) => {
        clearTimeout(killTimer);
        if (code !== 0) {
          console.error(`[${taskId}] claude exited with code ${code}`);
          exitCode = code;
        }
        resolve(code);
      });
      proc.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });
  } catch (err) {
    console.error(`[${taskId}] claude process error:`, err.message);
    if (timedOut) fullOutput.text += `\n\n⏱ Задача прервана по таймауту (${CLAUDE_TIMEOUT_MS / 60000} мин).`;
  } finally {
    clearInterval(streamTimer);
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // If claude crashed with non-zero exit and produced almost no output — show crash error
  if (exitCode !== 0 && !timedOut && fullOutput.text.trim().length < 50 && !claudeResult) {
    const crashMsg = `⚠️ Процесс завершился с ошибкой (код ${exitCode}). Попробуй ещё раз.`;
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, crashMsg).catch(() => tgSend(BOT_TOKEN, chatId, crashMsg));
    else await tgSend(BOT_TOKEN, chatId, crashMsg);
    return crashMsg;
  }

  // Prefer the clean result string from the result event; fall back to accumulated stream text
  const result = (claudeResult ?? fullOutput.text).trim() || '(нет вывода)';

  // Detect Claude Code auth failure — set flag and send clear message instead of raw error
  if (isAuthError(result)) {
    const reason = detectReason(result);
    setAuthFailedFlag({ reason, error_text: result });
    const authMsg = '⚠️ Авторизация Claude Code истекла — оператор уже уведомлён, скоро починим.';
    if (msgId) {
      await tgEdit(BOT_TOKEN, chatId, msgId, authMsg).catch(() => tgSend(BOT_TOKEN, chatId, authMsg));
    } else {
      await tgSend(BOT_TOKEN, chatId, authMsg);
    }
    if (activeSessionId) sessions.appendReply(user.workDir, activeSessionId, authMsg);
    return authMsg;
  }

  // Record token usage for billing
  if (claudeUsage) {
    recordUsage(user.workDir, {
      taskId,
      sessionId: activeSessionId,
      input_tokens: claudeUsage.input_tokens || 0,
      output_tokens: claudeUsage.output_tokens || 0,
      cache_read_input_tokens: claudeUsage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: claudeUsage.cache_creation_input_tokens || 0,
    });
  }
  const final = result.slice(-MAX_MSG_LEN);

  // Send result
  if (msgId) {
    await tgEdit(BOT_TOKEN, chatId, msgId, `🧠 ${final}`).catch(() =>
      tgSend(BOT_TOKEN, chatId, `🧠 ${final}`)
    );
  } else {
    await tgSend(BOT_TOKEN, chatId, `🧠 ${final}`);
  }

  // Update context pin after task (only if skills are configured)
  const card = buildContextCard(user.username, user.workDir);
  if (card) updateContextPin(BOT_TOKEN, chatId, user.workDir, card).catch(() => {});

  // Append assistant reply to session history
  if (activeSessionId) {
    sessions.appendReply(user.workDir, activeSessionId, result);
    setCurrentSessionId(user.workDir, activeSessionId);
  }

  return result;
}


function formatToolActivity(name, input = {}) {
  switch (name) {
    case 'Bash': {
      const cmd = (input.command || '').trim().replace(/\n/g, ' ').slice(0, 80);
      return `💻 ${cmd}`;
    }
    case 'Read':
      return `📖 Читаю ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'Write':
      return `✍️ Пишу ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'Edit':
      return `✏️ Редактирую ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'WebFetch':
      return `🌐 ${(input.url || '').slice(0, 60)}`;
    case 'WebSearch':
      return `🔍 ${(input.query || '').slice(0, 60)}`;
    case 'Agent':
      return `🤖 Запускаю агента…`;
    default: {
      // MCP tool names: strip "mcp__<server>__" prefix for display
      const shortName = name.replace(/^mcp__[^_]+__/, '');
      switch (shortName) {
        case 'illustrate_generate':  return `🎨 Генерирую иллюстрацию…`;
        case 'illustrate_refine':    return `🎨 Дорабатываю иллюстрацию…`;
        case 'illustrate_preview_prompt': return `🖊 Готовлю промпт…`;
        case 'image_label':          return `🏷 Добавляю подписи на изображение…`;
        case 'image_label_adjust':   return `🏷 Корректирую подписи…`;
        default:                     return `🔧 ${shortName}`;
      }
    }
  }
}

const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

async function tgSend(token, chatId, text, extra = {}) {
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  return res.json();
}

async function tgEdit(token, chatId, messageId, text) {
  const res = await fetch(`${TG_API}/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
  return res.json();
}

module.exports = {
  runTask, getQuickAnswer, runQuickAnswer, generateConnectLink, getPendingTasks, clearPendingTask,
  // Exported for intent-coverage tests only
  _intents: { HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT, HH_RESPONSES_INTENT, HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT },
};
