const fs = require('fs');

// Employer-side rejection reason. `discard_vacancy_closed` is reserved for a
// vacancy that is actually being closed (hh_bulk_reject). Rejecting a candidate
// on a still-open vacancy MUST use `discard_by_employer` ("Не подходит"): the
// closed-vacancy reason tells the candidate the vacancy is closed while it keeps
// accepting responses, and HH can treat that as abuse of the reason.
const REJECT_REASON_ACTION = 'discard_by_employer';

// Single source of truth for the standard rejection text. The review page renders
// it into every ОТКЛОНИТЬ card and the server/client both rebuild it from here, so
// a rejection can never fall back to an LLM draft (invitations, "[Имя]" placeholders,
// wrong-name greetings) that one click would send.
const REJECTION_GREETING = 'Спасибо за отклик и уделённое время. Мы изучили ваше резюме и решили продолжить с другими кандидатами. Желаем успехов в поиске работы!';

function standardRejectionText(firstName) {
  const name = String(firstName || '').trim();
  return (name ? name + ', здравствуйте! ' : 'Здравствуйте! ') + REJECTION_GREETING;
}

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

module.exports = { sendRejection, REJECT_REASON_ACTION, REJECTION_GREETING, standardRejectionText };
