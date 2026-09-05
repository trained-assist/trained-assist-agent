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

    session_extend_timeout: {
      description:
        'Extend the current Claude session timeout by 15 minutes. ' +
        'Call this at the START of a long batch operation (inn_enrich_batch, expo_pipeline_run, etc.) ' +
        'to prevent the 15-min hard limit from killing the task mid-run. ' +
        'Max 8 extensions (2 hours total runtime). ' +
        'Returns extensionsLeft — stop extending when it reaches 0.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const taskId = process.env.AGENT_TASK_ID;
        const port   = process.env.PORT || '3000';
        const secret = process.env.AGENT_SECRET || '';

        if (!taskId) return { ok: false, error: 'AGENT_TASK_ID not set — not running inside agent session' };
        if (!secret) return { ok: false, error: 'AGENT_SECRET not available' };

        try {
          const res = await fetch(`http://localhost:${port}/tasks/${encodeURIComponent(taskId)}/extend-timeout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(5000),
          });
          return await res.json();
        } catch (err) {
          return { ok: false, error: `Failed to reach agent server: ${err.message}` };
        }
      },
    },
  },
};
