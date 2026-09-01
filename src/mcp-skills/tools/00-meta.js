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
    tools: ['gdrive_setup', 'gdrive_status', 'gdrive_list_files', 'gdrive_read_file', 'gdrive_search', 'gdrive_create_file', 'gdrive_update_file', 'gdrive_delete_file', 'gdrive_write_sheet'],
    requires: 'Вызови gdrive_setup → получишь email → расшарь папки/файлы Drive с этим email. gdrive_write_sheet создаёт/перезаписывает вкладку в Google Spreadsheet.',
  },
  {
    id: 'getcourse',
    name: 'GetCourse',
    description: 'Двухуровневая интеграция с GetCourse. L1 (API key): управление учениками, группами, заказами. L2 (сессия браузера): создание курсов, разделов, уроков, видео- и текстовых блоков.',
    tools: [
      'gc_status', 'gc_connect',
      'gc_user_add', 'gc_user_find', 'gc_group_list', 'gc_order_list',
      'gc_course_list', 'gc_course_create', 'gc_section_create', 'gc_lesson_create',
      'gc_lesson_add_video', 'gc_lesson_add_text', 'gc_lesson_sort',
    ],
    requires: 'Вызови gc_connect — получишь ссылку. Введи домен + API ключ (L1) и/или логин+пароль (L2).',
  },
  {
    id: 'expo-participants',
    name: 'Выставки — сбор и обогащение участников',
    description:
      'Полный пайплайн для выставочной разведки: от URL каталога до Google Sheet с ИНН, выручкой и колонкой "Целевая?".\n\n' +
      'СТАНДАРТНЫЙ ПАЙПЛАЙН (в порядке шагов):\n' +
      '1. expo_find_participants(site_url) — найти каталог, спарсить список компаний\n' +
      '   → Для JS/Tilda сайтов: Browser Session + expo_parse_participants(html)\n' +
      '2. expo_fetch_company_contacts(catalog_base, companies) — обойти карточки компаний → +сайт, +email\n' +
      '   → Используй для CPM-style каталогов (cpm-digital.ru, catalog.textile-salon.ru, catalog.tourismexpo.ru и подобных)\n' +
      '   → Не нужен если expo_find_participants уже вернул сайты\n' +
      '3. expo_find_inn(companies, out_file) — ИНН для каждой компании\n' +
      '   → Источники: сайт компании (regex) → DaData по названию (4-pass алгоритм)\n' +
      '   → Типичное покрытие: 30–60%. Иностранные бренды без российского юрлица — ИНН нет.\n' +
      '4. expo_enrich_finances(file, criteria) — ОГРН + директор (DaData) + выручка + прибыль (Checko) + Целевая?\n' +
      '   → Критерий по умолчанию: 150–1000 млн любая прибыль / 1000–5000 млн прибыль ≤100 млн\n' +
      '5. gdrive_write_sheet(spreadsheet_id, sheet_name, rows) — записать в Google Sheet\n\n' +
      'ВАЖНЫЕ ОСОБЕННОСТИ:\n' +
      '- Выставочные каталоги — это торговые марки, а не юрлица. ИНН по названию работает плохо для иностранных брендов.\n' +
      '- Лучший источник ИНН: сайт компании → футер/реквизиты → regex.\n' +
      '- DaData suggest/party (по имени и домену) = бесплатно, квота 10k/день.\n' +
      '- Checko — платный, только для финансов по ИНН. Ключ BcCm6AGdVBx9j0MC — пишется в параметре или env.\n\n' +
      'РЕФЕРЕНСНЫЕ СКРИПТЫ (на GCP VM flexi-consult):\n' +
      '- /home/vova/users/flexi-consult/participants/find-inn-cpm.js — ИНН с сайта + DaData\n' +
      '- /home/vova/users/flexi-consult/participants/enrich-finances.js — Checko финансы\n' +
      '- github:flexi-consulting/exhibitions/scripts/enrich_dadata.py — Python-референс алгоритма\n' +
      '- github:flexi-consulting/exhibitions/docs/data-pipeline.md — описание пайплайна',
    tools: [
      'expo_find_participants',
      'expo_parse_participants',
      'expo_fetch_company_contacts',
      'expo_find_inn',
      'expo_enrich_finances',
    ],
    requires: 'Ничего для шагов 1–4. Для шага 5: gdrive_write_sheet требует настроенный Google Drive SA (gdrive_setup).',
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
