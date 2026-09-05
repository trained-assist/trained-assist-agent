'use strict';

const fs = require('fs');

module.exports = {
  tools: {
    load_full_context: {
      description:
        'Load the full conversation history from the current session. ' +
        'Call this when you realise the injected context summary is insufficient — ' +
        'e.g. the user refers to something specific said earlier that you cannot recall, ' +
        'you need to understand a long chain of prior decisions, or you are resuming a complex task. ' +
        'Returns messages newest-first up to `limit`, each body capped at `chars_per_message` characters.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max number of recent messages to return (default 20)',
          },
          chars_per_message: {
            type: 'number',
            description: 'Max characters per message body (default 3000)',
          },
        },
      },
      handler: async ({ limit = 20, chars_per_message = 3000 } = {}) => {
        const sessionFile = process.env.AGENT_SESSION_FILE;
        if (!sessionFile) return { error: 'No active session' };

        let session;
        try {
          session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        } catch {
          return { error: 'Session not found or unreadable' };
        }

        const cap = Math.min(Math.max(1, limit), 100);
        const charCap = Math.min(Math.max(100, chars_per_message), 20000);
        const all = session.messages || [];
        const messages = all.slice(-cap);

        return {
          topic: session.topic || '',
          total_messages: all.length,
          returned: messages.length,
          messages: messages.map(m => ({
            role: m.role,
            text: m.content?.length > charCap
              ? m.content.slice(0, charCap) + `… [truncated, ${m.content.length - charCap} chars omitted]`
              : m.content,
            at: m.at ? new Date(m.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : undefined,
          })),
        };
      },
    },
  },
};
