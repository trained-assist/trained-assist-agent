// Owner-authenticated adapters for the durable ledger. Importing does not create
// state or start work; the execution coordinator remains responsible for claims.
const fs = require('fs');
const path = require('path');
const { SYSTEM_ROOT } = require('./data-paths');
const { createIntentStore } = require('./restart-intents');
const { appendEvent } = require('./restart-notifications');
const HANDLE = /^[0-9a-f-]{36}$/;
function title(intent) { return String(intent.payload.task || 'Отложенная задача').replace(/\s+/g, ' ').slice(0, 160); }
function createConfirmationService(store, { token, route, fetchImpl = fetch, append = appendEvent } = {}) {
  let flushing = Promise.resolve();
  return {
    list(principal) {
      return store.confirmations(principal).map(({ event, intent }) => ({ handle: event.handle,
        title: title(intent), state: intent.state, sessionId: intent.owner.sessionId,
        projectId: intent.owner.projectId, initiatedAt: intent.initiatedAt }));
    },
    decide(handle, principal, action) {
      if (!HANDLE.test(handle || '') || !['confirm', 'cancel'].includes(action)) throw Error('Invalid decision');
      return store.decide(handle, principal, action);
    },
    flush() {
      const drain = async () => {
        for (const { event, intent } of store.pendingConfirmationNotices()) {
          const target = intent.owner;
          const text = `После рестарта задача ожидает подтверждения: ${title(intent)}\nЕсли ещё актуально — нажмите «Запустить». Часть действий могла успеть выполниться; перед продолжением нужно проверить их результат.`;
          for (const channel of ['session', 'telegram']) {
            if (event.delivered[channel] || (channel === 'session' ? !target.sessionId : !target.chatId)) continue;
            try {
              if (channel === 'session') {
                await append(target, { id: `confirmation:${event.handle}`, createdAt: event.createdAt }, text);
              } else {
                if (!token || !['m', 'r'].includes(route)) throw Error('Confirmation delivery is not configured');
                const response = await fetchImpl(`${process.env.TELEGRAM_API_URL || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
                  body: JSON.stringify({ chat_id: target.chatId, text,
                    ...(target.threadId ? { message_thread_id: target.threadId } : {}),
                    reply_markup: { inline_keyboard: [[
                      { text: '▶️ Запустить', callback_data: `ri:${route}:y:${event.handle}` },
                      { text: 'Отменить', callback_data: `ri:${route}:n:${event.handle}` },
                    ]] } }),
                });
                const result = await response.json();
                if (!response.ok || !result.ok) throw Error('Confirmation delivery failed');
              }
              store.acknowledgeConfirmation(event.handle, channel);
            } catch (error) { console.error('[restart-confirmation]', channel, error.message); }
          }
        }
      };
      flushing = flushing.then(drain, drain);
      return flushing;
    },
  };
}
// Dormant until the execution cutover creates the ledger. Never migrate JSON or
// reopen admission merely because a user loaded the UI or clicked a callback.
let singleton;
let deliveryOptions;
function existingConfirmationService(options) {
  if (options) deliveryOptions = options;
  if (singleton) return singleton;
  const file = path.join(SYSTEM_ROOT, 'restart-intents.sqlite');
  if (!fs.existsSync(file)) return null;
  singleton = createConfirmationService(createIntentStore(file), deliveryOptions);
  return singleton;
}
module.exports = { createConfirmationService, existingConfirmationService };
