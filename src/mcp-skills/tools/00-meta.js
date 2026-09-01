'use strict';

// Meta-tool: skill discovery
// Loaded first (00- prefix) so list_skills appears at top of tools/list

const SKILLS = [
  {
    id: 'nalog-npd',
    name: 'Самозанятый НПД (nalog.ru)',
    description: 'Доходы, чеки НПД через API lknpd.nalog.ru. Токен нужен с Chrome extension.',
    tools: ['nalog_get_profile', 'nalog_get_incomes', 'nalog_create_receipt', 'nalog_refresh_token'],
    requires: 'Открой lknpd.nalog.ru в Chrome → нажми иконку расширения cloud-auth-bridge → "Send token". Токен живёт ~1 час.',
  },
  {
    id: 'tilda-site-ops',
    name: 'Tilda Site Ops',
    description: 'Работа с Tilda: страницы, блоки, публикация. Test-first: сначала тест, потом прод.',
    tools: ['tilda_list_all_projects', 'tilda_set_config', 'tilda_status', 'tilda_list_pages', 'tilda_get_page', 'tilda_backup_page', 'tilda_create_staging', 'tilda_publish_page', 'tilda_get_blocks', 'tilda_save_block'],
    requires: 'browser_session_url → пользователь логинится в удалённый браузер → browser_session_capture_cookies("tilda.ru", "tilda-session")',
  },
  {
    id: 'browser-session',
    name: 'Remote Browser Session',
    description: 'Удалённый Chrome на VM (noVNC). Позволяет залогиниться в любой сервис с IP виртуалки и захватить сессию. Решает IP-binding и CAPTCHA.',
    tools: ['browser_session_status', 'browser_session_url', 'browser_session_capture_cookies', 'browser_session_navigate'],
    requires: 'ничего — браузер всегда запущен',
  },
  {
    id: 'weeek-crm',
    name: 'Weeek CRM',
    description: 'Управление сделками, контактами и воронками в Weeek.net через REST API. Токен не протухает.',
    tools: ['weeek_status', 'weeek_set_token', 'weeek_list_funnels', 'weeek_list_statuses', 'weeek_list_deals', 'weeek_get_deal', 'weeek_create_deal', 'weeek_update_deal', 'weeek_delete_deal', 'weeek_list_contacts', 'weeek_get_contact', 'weeek_create_contact', 'weeek_update_contact'],
    requires: '/settoken weeek <token> — токен: Weeek → Settings → Integrations → API → Generate',
  },
  {
    id: 'company-enrichment',
    name: 'Обогащение компаний (rusprofile)',
    description: 'Найти компанию по названию → ИНН → полные данные (CEO, контакты, выручка, адрес). Бесплатно через rusprofile.ru, или быстрее с DaData API.',
    tools: ['company_find_by_name', 'company_get_by_inn', 'company_find_by_email', 'company_set_dadata_token'],
    requires: 'Ничего — бесплатный режим работает сразу. Опционально: DaData token для ускорения.',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Работа с GitHub: репозитории, issues, pull requests, файлы. Читать/создавать задачи, PR, комментарии, файлы.',
    tools: ['github_status', 'github_list_repos', 'github_get_file', 'github_list_issues', 'github_create_issue', 'github_update_issue', 'github_add_comment', 'github_list_prs', 'github_create_pr', 'github_search', 'github_create_or_update_file'],
    requires: '/settoken github ghp_xxxxx — классический PAT с scope: repo, read:org',
  },
  {
    id: 'inn-enrichment',
    name: 'INN Enrichment — обогащение компаний',
    description: 'Для списка компаний (300–1000) находит ИНН, ОГРН, директора, выручку, прибыль. ' +
      'Источники: BFO ФНС (бесплатно), ЕГРЮЛ (бесплатно), сайты компаний, DaData, Checko. ' +
      'Параллельно, 300 компаний за 10–15 мин. Hit rate 60–85%.',
    tools: ['inn_status', 'inn_set_dadata_token', 'inn_set_checko_key', 'inn_set_rusprofile_cookie', 'inn_enrich_batch'],
    requires: [
      'BFO ФНС — бесплатно, без настройки',
      'ЕГРЮЛ — бесплатно, без настройки',
      'DaData — inn_set_dadata_token(token, secret)  → ускоряет fallback',
      'Checko — inn_set_checko_key(key)  → финансы для компаний не найденных в BFO',
      'Rusprofile — бесплатно; при блокировке → inn_set_rusprofile_cookie(cookie)',
    ].join('\n'),
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Читать, создавать и редактировать файлы в Google Drive через персональный Service Account. Настройка за одну команду — gdrive_setup автоматически создаёт SA.',
    tools: ['gdrive_setup', 'gdrive_status', 'gdrive_list_files', 'gdrive_read_file', 'gdrive_search', 'gdrive_create_file', 'gdrive_update_file', 'gdrive_delete_file'],
    requires: 'Вызови gdrive_setup → получишь email → расшарь папки Drive с этим email.',
  },
  {
    id: 'getcourse',
    name: 'GetCourse',
    description: 'Двухуровневая интеграция с GetCourse. L1 (API key): управление учениками, группами, заказами. L2 (сессия браузера): создание курсов, разделов, уроков, видео- и текстовых блоков.',
    tools: [
      'gc_status', 'gc_connect',
      'gc_user_add', 'gc_user_find', 'gc_group_list', 'gc_order_list',
      'gc_course_create', 'gc_section_create', 'gc_lesson_create',
      'gc_lesson_add_video', 'gc_lesson_add_text', 'gc_lesson_sort',
    ],
    requires: 'Вызови gc_connect — получишь ссылку. Введи домен + API ключ (L1) и/или логин+пароль (L2).',
  },
  {
    id: 'expo-participants',
    name: 'Выставки — список участников',
    description: 'Стандартный скил для сбора участников выставки: найти страницу участников/экспонентов → спарсить компании → CSV для обогащения ИНН. ' +
      'Для JS-сайтов — используй browser/WebFetch чтобы получить HTML, затем expo_parse_participants. ' +
      'Результат сразу совместим с inn_enrich_batch.',
    tools: ['expo_find_participants', 'expo_parse_participants'],
    requires: 'Ничего — достаточно URL сайта выставки. Для JS-сайтов нужен Browser Session или Playwright.',
  },
];

module.exports = {
  tools: {
    list_skills: {
      description: 'List all available agent skills and integrations. Call this when user asks "what can you do?" or "what integrations do you have?"',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ skills: SKILLS }),
    },
  },
};
