'use strict';

const fs = require('fs');

module.exports = {
  tools: {
    last_messages: {
      description: 'Get recent conversation history from the current session. ' +
        'Use when the user refers to something said earlier, or when you need context from previous messages in this chat.',
      inputSchema: {
        type: 'object',
        properties: {
          n: {
            type: 'number',
            description: 'Number of recent messages to return (default 8, max 20)',
          },
        },
      },
      handler: async ({ n = 8 } = {}) => {
        const sessionFile = process.env.AGENT_SESSION_FILE;
        if (!sessionFile) return { error: 'No active session' };

        let session;
        try {
          session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        } catch {
          return { error: 'Session not found or unreadable' };
        }

        const limit = Math.min(Math.max(1, n), 20);
        const messages = (session.messages || []).slice(-limit);

        if (!messages.length) return { messages: [], topic: session.topic || '' };

        return {
          topic: session.topic || '',
          total: session.messages?.length || 0,
          messages: messages.map(m => ({
            role: m.role,
            text: m.content,
            at: m.at ? new Date(m.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : undefined,
          })),
        };
      },
    },
  },
};
