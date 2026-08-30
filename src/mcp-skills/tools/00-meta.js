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
  // New skills registered here by their tool files automatically —
  // update this list when adding a skill module.
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
