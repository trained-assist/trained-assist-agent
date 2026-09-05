'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');

function getArtifactsPath(username) {
  const dir = path.join(DATA_DIR, 'sessions', username, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'artifacts.jsonl');
}

function readAll(username) {
  const p = getArtifactsPath(username);
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function appendRecord(username, record) {
  const p = getArtifactsPath(username);
  fs.appendFileSync(p, JSON.stringify(record) + '\n');
}

const VALID_TYPES = new Set(['contact', 'decision', 'config', 'url', 'error', 'snippet', 'company', 'document', 'identifier']);

module.exports = {
  tools: {
    store_artifact: {
      description:
        'Сохрани важную информацию о пользователе или задаче — контакт, решение, настройку, ссылку. ' +
        'Данные доступны в следующих сессиях. ' +
        'Используй при любом важном факте который назвал пользователь.',
      inputSchema: {
        type: 'object',
        required: ['type', 'content'],
        properties: {
          type: {
            type: 'string',
            enum: ['contact', 'decision', 'config', 'url', 'error', 'snippet', 'company', 'document', 'identifier'],
          },
          content: { type: 'string', description: 'Содержимое артефакта' },
          metadata: { type: 'object', description: 'Доп. поля: email, role, company, etc.' },
        },
      },
      handler: async ({ type, content, metadata = {} } = {}) => {
        const username = process.env.AGENT_USER_ID;
        if (!username) return { error: 'AGENT_USER_ID not set' };
        if (!type || !VALID_TYPES.has(type)) return { error: `Invalid type: ${type}` };
        if (!content || typeof content !== 'string' || !content.trim()) return { error: 'content is required' };

        const sessionId = process.env.AGENT_SESSION_FILE
          ? path.basename(process.env.AGENT_SESSION_FILE, '.json')
          : undefined;

        // Deduplication: skip if same type+content exists within last 60s
        const now = Date.now();
        const existing = readAll(username);
        const isDuplicate = existing.some(
          a => a.type === type && a.content === content && (now - a.created_at) < 60_000
        );
        if (isDuplicate) return { stored: false, reason: 'duplicate' };

        const record = {
          id: crypto.randomUUID(),
          username,
          type,
          content: content.trim(),
          metadata,
          created_at: now,
          ...(sessionId ? { session_id: sessionId } : {}),
        };

        appendRecord(username, record);
        const total = existing.length + 1;
        return { stored: true, id: record.id, total };
      },
    },

    query_artifacts: {
      description:
        'Найди ранее сохранённые знания о пользователе или проекте. ' +
        'Используй при старте сессии и при любом вопросе где может быть контекст из прошлого.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Фильтр по типу' },
          query: { type: 'string', description: 'Текстовый поиск (по content и metadata)' },
          limit: { type: 'number', description: 'Максимум результатов (default 20)' },
        },
      },
      handler: async ({ type, query, limit = 20 } = {}) => {
        const username = process.env.AGENT_USER_ID;
        if (!username) return { error: 'AGENT_USER_ID not set' };

        let artifacts = readAll(username);

        if (type) artifacts = artifacts.filter(a => a.type === type);

        if (query) {
          const q = query.toLowerCase();
          artifacts = artifacts.filter(a => {
            if (a.content.toLowerCase().includes(q)) return true;
            if (a.metadata && JSON.stringify(a.metadata).toLowerCase().includes(q)) return true;
            return false;
          });
        }

        // Sort newest first
        artifacts.sort((a, b) => b.created_at - a.created_at);
        artifacts = artifacts.slice(0, Math.min(limit, 100));

        if (!artifacts.length) return { found: 0, results: 'Артефакты не найдены.' };

        const lines = artifacts.map(a => {
          const date = new Date(a.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
          const meta = a.metadata && Object.keys(a.metadata).length
            ? ' | ' + Object.entries(a.metadata).map(([k, v]) => `${k}: ${v}`).join(', ')
            : '';
          return `[${a.type}] ${date}${meta}\n${a.content}`;
        });

        return { found: artifacts.length, results: lines.join('\n\n') };
      },
    },

    get_knowledge_summary: {
      description:
        'Покажи сводку всех сохранённых знаний о пользователе. ' +
        'Используй при старте новой задачи чтобы вспомнить контекст.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const username = process.env.AGENT_USER_ID;
        if (!username) return { error: 'AGENT_USER_ID not set' };

        const artifacts = readAll(username);
        if (!artifacts.length) return { total: 0, summary: 'Хранилище пусто.' };

        // Group by type
        const byType = {};
        for (const a of artifacts) {
          if (!byType[a.type]) byType[a.type] = [];
          byType[a.type].push(a);
        }

        const sections = [];
        for (const [type, items] of Object.entries(byType)) {
          // Sort newest first, take last 3
          const recent = [...items].sort((a, b) => b.created_at - a.created_at).slice(0, 3);
          const previews = recent.map(a => `  • ${a.content.slice(0, 120)}`).join('\n');
          sections.push(`${type} (${items.length}):\n${previews}`);
        }

        return {
          total: artifacts.length,
          by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
          summary: sections.join('\n\n'),
        };
      },
    },
  },
};
