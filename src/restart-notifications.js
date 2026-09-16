const fs = require('fs');
const path = require('path');
const { atomicJson } = require('./maintenance');
const { userWorkDir, SYSTEM_ROOT } = require('./data-paths');
const sessions = require('./session-store');

function restartTarget({ username, chatId = null, sessionId = null, threadId = null }) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(username)) throw Error('Invalid restart profile');
  if (chatId != null && (!Number.isSafeInteger(chatId))) throw Error('Invalid restart chat');
  if (threadId != null && (!Number.isSafeInteger(threadId) || threadId < 1)) throw Error('Invalid restart topic');
  const workDir = userWorkDir(username);
  // Capture the pointer NOW. Delivery must never follow a later active session.
  sessionId = sessionId || (chatId != null ? sessions.getCurrentSessionId(workDir, chatId) : null);
  if (sessionId && (!/^[a-zA-Z0-9_-]+$/.test(sessionId) || !sessions.getSession(workDir, sessionId))) throw Error('Restart session does not belong to profile');
  if (!sessionId && (chatId == null || chatId === 0)) throw Error('Restart recipient required');
  return { username, chatId, sessionId, threadId };
}
function message(event) {
  const text = {
    draining: '⏸ Рестарт запланирован. Новые задачи временно не запускаются; сообщения сохраняются. Ждём завершения текущих задач, максимум 40 минут.',
    restarting: '🔄 Начинаю перезапуск сервера. Незавершённые задачи сохранены.',
    ready: '✅ Сервер перезапущен, восстановление завершено. Свежие задачи возобновляются; остальные ожидают подтверждения.',
    failed: '⚠️ Перезапуск или восстановление не завершены. Требуется проверка состояния сервера.',
    cancelled: '✅ Ожидание рестарта отменено. Очередь продолжает работу.',
  }[event.phase];
  return `${text}\nОперация: ${event.operationId}`;
}
function appendEvent(target, event, text) {
  const workDir = userWorkDir(target.username);
  const file = path.join(workDir, 'sessions', `${target.sessionId}.json`);
  const full = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Same event may be retried after a crash between append and receipt.
  if (!full.messages.some(m => m.restartEventId === event.id)) {
    full.messages.push({ role: 'assistant', content: text, at: event.createdAt, restartEventId: event.id });
    full.lastAt = Math.max(full.lastAt || 0, event.createdAt);
    full.messageCount = full.messages.length;
    atomicJson(file, full);
  }
  const indexFile = path.join(workDir, 'sessions.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const meta = index.find(s => s.id === target.sessionId);
  if (meta) {
    Object.assign(meta, { lastAt: full.lastAt, messageCount: full.messageCount,
      lastMessageRole: full.messages.at(-1).role, lastAssistantSnippet: full.messages.at(-1).content.slice(0, 120) });
    index.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    atomicJson(indexFile, index);
  }
}
function createRestartNotifier(gate, { token, fetchImpl = fetch, append = appendEvent } = {}) {
  let running = Promise.resolve();
  async function drain() {
    const reportFile = path.join(SYSTEM_ROOT, 'restart-failure.json');
    if (fs.existsSync(reportFile)) {
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      const state = gate.status();
      if (state.id === report.id && state.phase === 'restarting') gate.fail('External restart/readiness failed');
      fs.unlinkSync(reportFile);
    }
    const blocked = new Set();
    for (const event of gate.pendingNotifications()) {
      const target = event.target;
      for (const channel of ['session', 'telegram']) {
        if (event.delivered[channel] || (channel === 'session' ? !target.sessionId : target.chatId == null || target.chatId === 0)) continue;
        const key = JSON.stringify([channel, target.username, channel === 'session' ? target.sessionId : target.chatId, target.threadId]);
        if (blocked.has(key)) continue;
        try {
          const text = message(event);
          if (channel === 'session') append(target, event, text);
          else {
            if (!token) throw Error('Telegram token unavailable');
            const response = await fetchImpl(`${process.env.TELEGRAM_API_URL || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: target.chatId, text,
                ...(target.threadId ? { message_thread_id: target.threadId } : {}) }),
              signal: AbortSignal.timeout(5000),
            });
            const data = await response.json();
            if (!response.ok || !data.ok) throw Error(`Telegram delivery failed (${response.status})`);
          }
          gate.acknowledgeNotification(event.id, channel);
        } catch (error) {
          blocked.add(key);
          console.error('[restart-notification]', event.id, channel, error.message);
        }
      }
    }
  }
  return { flush() { running = running.then(drain, drain); return running; } };
}
module.exports = { restartTarget, createRestartNotifier, appendEvent, message };
