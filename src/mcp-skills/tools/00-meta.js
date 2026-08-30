'use strict';

// Meta-tool: skill discovery
// Loaded first (00- prefix) so list_skills appears at top of tools/list

const SKILLS = [
  {
    id: 'nalog-npd',
    name: 'Самозанятый НПД (nalog.ru)',
    description: 'Доходы, чеки НПД через API lknpd.nalog.ru. Токен нужен с Chrome extension.',
    tools: ['nalog_get_profile', 'nalog_get_incomes', 'nalog_create_receipt', 'nalog_refresh_token'],
    requires: 'Chrome extension → отправить токен nalog.ru',
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
    requires: 'Weeek API token: Settings → Integrations → API → Generate token → weeek_set_token',
  },
  {
    id: 'company-enrichment',
    name: 'Обогащение компаний (rusprofile)',
    description: 'Найти компанию по названию → ИНН → полные данные (CEO, контакты, выручка, адрес). Бесплатно через rusprofile.ru, или быстрее с DaData API.',
    tools: ['company_find_by_name', 'company_get_by_inn', 'company_find_by_email', 'company_set_dadata_token'],
    requires: 'Ничего — бесплатный режим работает сразу. Опционально: DaData token для ускорения.',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Читать, создавать и редактировать файлы в Google Drive через персональный Service Account. Настройка за одну команду — gdrive_setup автоматически создаёт SA.',
    tools: ['gdrive_setup', 'gdrive_status', 'gdrive_list_files', 'gdrive_read_file', 'gdrive_search', 'gdrive_create_file', 'gdrive_update_file', 'gdrive_delete_file'],
    requires: 'Вызови gdrive_setup → получишь email → расшарь папки Drive с этим email.',
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
