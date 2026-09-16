const fs = require('fs');

// Persist each external step: a retry must never resend a delivered message.
async function sendRejection({ historyFile, message, send, discard }) {
  const read = () => fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : { messages: [] };
  const save = (operation, sentMessage) => {
    const history = read();
    history.rejection_operation = operation;
    if (sentMessage) {
      history.messages = history.messages || [];
      history.messages.push({ role: 'employer', text: sentMessage, timestamp: new Date().toISOString(), type: 'rejection' });
    }
    const tmp = historyFile + '.rejection.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, historyFile);
  };
  const previous = read().rejection_operation;
  if (previous?.status === 'done') return { ok: true };
  if (['sending', 'unknown', 'discarding'].includes(previous?.status)) {
    return { ok: false, error: 'Результат предыдущего запроса ещё не подтверждён. Проверьте переписку и статус на HH; повторное сообщение не отправлено.' };
  }
  const operation = { message: previous?.status === 'message_sent' ? previous.message : message, status: 'sending' };
  if (previous?.status !== 'message_sent') {
    save(operation);
    try {
      await send(operation.message);
    } catch (e) {
      // A transport error may occur after HH accepted the message.
      operation.status = /^HH 4\d\d:/.test(e.message) ? 'failed' : 'unknown';
      save(operation);
      return { ok: false, error: operation.status === 'unknown'
        ? 'Доставка сообщения не подтверждена. Проверьте переписку на HH перед повтором.'
        : 'Сообщение не отправлено: ' + e.message };
    }
    operation.status = 'message_sent';
    save(operation, operation.message);
  }
  operation.status = 'discarding';
  save(operation);
  try {
    await discard();
    operation.status = 'done';
    save(operation);
    return { ok: true };
  } catch (e) {
    operation.status = 'message_sent';
    save(operation);
    return { ok: false, message_sent: true, error: 'Сообщение отправлено, но перевод в отказ на HH не подтверждён. Повтор кнопки повторит только перевод в отказ. ' + e.message };
  }
}

module.exports = { sendRejection };
