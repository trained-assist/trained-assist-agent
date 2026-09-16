// One ordered status stream until the runner owns the message. Never allow a
// slow queue edit to land after the running/failure status.
function createAdmissionStatus(opts, { edit, send, intervalMs = 15000 }) {
  const token = opts.secrets?.BOT_TOKEN;
  const chatId = opts.user.id;
  let tail = Promise.resolve();
  let timer = null;
  let phase = '';
  let closed = false;
  let outstanding = 0;
  const started = Date.now();
  const publish = text => {
    outstanding++;
    tail = tail.then(async () => {
      if (!token || !opts.initialMsgId) return;
      try {
        const result = await edit(token, chatId, opts.initialMsgId, text);
        if (result?.ok === false && !/message is not modified/i.test(result.description || '')) {
          throw new Error(result.description || 'Telegram edit failed');
        }
      } catch (err) {
        console.warn(`[${opts.taskId}] admission status: ${err.message}`);
        await send(token, chatId, text).catch(() => {});
      }
    }).finally(() => { outstanding--; });
    return tail;
  };
  return {
    waiting(reason) {
      if (closed) return;
      phase = reason;
      if (timer) clearInterval(timer);
      publish(phase);
      timer = setInterval(() => {
        if (!outstanding) publish(`${phase}\nОжидание: ${Math.round((Date.now() - started) / 1000)} с.`);
      }, intervalMs);
      timer.unref?.();
    },
    async finish(text) {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await publish(text);
    },
  };
}
module.exports = { createAdmissionStatus };
