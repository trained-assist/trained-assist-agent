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
