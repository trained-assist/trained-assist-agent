'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * get_chat_history — retrieve conversation history from previous sessions
 * in the same Telegram chat (by liveChatId).
 *
 * Designed for lightweight context loading: the agent can peek at what was
 * discussed before the current session without bloating the main prompt.
 *
 * Scope: only the current user's own sessions (AGENT_DATA_DIR / cwd).
 * No cross-user access possible.
 */

function resolveSessionsDir() {
  const username = process.env.AGENT_USER_ID;
  if (!username) return null;
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'sessions', username, 'sessions');
}

function readSession(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function resolveCurrentChatId() {
  const sessionFile = process.env.AGENT_SESSION_FILE;
  if (!sessionFile) return null;
  const session = readSession(sessionFile);
  if (!session) return null;
  return session.liveChatId ?? session.ownerChatId ?? null;
}

function resolveCurrentSessionId() {
  const sessionFile = process.env.AGENT_SESSION_FILE;
  if (!sessionFile) return null;
  const session = readSession(sessionFile);
  return session?.id || null;
}

function formatTime(ts) {
  if (!ts) return undefined;
  return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

module.exports = {
  tools: {
    get_chat_history: {
      description:
        'Load conversation history from PREVIOUS sessions in the same Telegram chat. ' +
        'Returns sessions and messages from earlier conversations with this user in this chat, ' +
        'excluding the current session. Use when the user references something from a past conversation ' +
        'or you need context that predates the current session.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description:
              'Telegram chat ID to look up. If omitted, uses the current session\'s chat.',
          },
          sessions_limit: {
            type: 'number',
            description: 'Max number of previous sessions to return (default 3, max 10).',
          },
          msg_limit: {
            type: 'number',
            description:
              'Max messages per session to return (default 20, max 100). ' +
              'Returns the most recent messages within each session.',
          },
          include_current: {
            type: 'boolean',
            description:
              'If true, also include the current session in results (default false).',
          },
        },
      },
      handler: async ({
        chat_id,
        sessions_limit = 3,
        msg_limit = 20,
        include_current = false,
      } = {}) => {
        const sessionsDir = resolveSessionsDir();
        if (!sessionsDir) return { error: 'AGENT_USER_ID not set' };

        // Determine which chat to look up
        const targetChatId = chat_id || resolveCurrentChatId();
        if (!targetChatId) {
          return {
            error: 'No chat_id provided and current session has no liveChatId. ' +
              'Pass chat_id explicitly.',
          };
        }

        const currentSessionId = resolveCurrentSessionId();
        const targetChatStr = String(targetChatId);

        // Scan all session files in the directory (same pattern as session_search)
        let files;
        try {
          files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        } catch {
          return { sessions: [], total: 0, chat_id: targetChatStr, note: 'No sessions directory' };
        }

        const matched = [];
        const cap = Math.min(Math.max(1, sessions_limit), 10);
        const msgCap = Math.min(Math.max(1, msg_limit), 100);

        for (const file of files) {
          if (matched.length >= cap) break;

          const session = readSession(path.join(sessionsDir, file));
          if (!session) continue;
          if (!include_current && session.id === currentSessionId) continue;

          const sessionChatId = String(session.liveChatId ?? session.ownerChatId ?? '');
          if (sessionChatId !== targetChatStr) continue;

          const allMsgs = session.messages || [];
          const recentMsgs = allMsgs.slice(-msgCap);

          matched.push({
            session_id: session.id,
            topic: session.topic || '',
            created_at: formatTime(session.createdAt),
            last_at: formatTime(session.lastAt),
            total_messages: allMsgs.length,
            returned_messages: recentMsgs.length,
            messages: recentMsgs.map(m => ({
              role: m.role,
              text: m.content,
              at: formatTime(m.at),
            })),
          });
        }

        // Sort by lastAt descending (most recent first)
        matched.sort((a, b) => {
          const ta = a.last_at ? new Date(a.last_at).getTime() : 0;
          const tb = b.last_at ? new Date(b.last_at).getTime() : 0;
          return tb - ta;
        });

        return {
          chat_id: targetChatStr,
          sessions: matched,
          total: matched.length,
          note: matched.length === 0
            ? 'No previous sessions found for this chat.'
            : undefined,
        };
      },
    },
  },
};
