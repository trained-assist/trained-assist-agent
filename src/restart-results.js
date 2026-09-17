// Terminal output is durable before delivery. Retry may repeat a Telegram notice,
// never the model or its external effects. Plain text, no classifier/LLM on replay.
const { appendEvent } = require('./restart-notifications');
function createResultDelivery(store, { token, fetchImpl = fetch, append = appendEvent } = {}) {
  const inflight = new Map();
  async function deliver(id) {
    if (inflight.has(id)) return inflight.get(id);
    const promise = (async () => {
      let intent = store.resultForDelivery(id);
      if (intent?.state !== 'delivering') return;
      const target = intent.owner;
      if (!intent.resultReceipts.session) {
        if (target.sessionId && !intent.result.skipSession) await append(target, { id: `result:${id}`, createdAt: intent.updatedAt }, intent.result.text);
        store.acknowledgeResult(id, 'session');
      }
      if (!intent.resultReceipts.telegram) {
        if (target.chatId) {
          if (!token) throw Error('Result delivery token unavailable');
          const pieces = intent.result.text.match(/[\s\S]{1,3900}/gu) || [];
          for (let i = 0; i < pieces.length; i++) {
            intent = store.find(id);
            if (intent.resultReceipts['part:'+i]) continue;
            const editing = pieces.length === 1 && intent.result.messageId;
            const send = async edit => {
              const response = await fetchImpl(`${process.env.TELEGRAM_API_URL || 'https://api.telegram.org'}/bot${token}/${edit?'editMessageText':'sendMessage'}`, {
                method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(5000),
                body:JSON.stringify({chat_id:target.chatId,text:pieces[i],
                  ...(edit ? {message_id:intent.result.messageId} : target.threadId ? {message_thread_id:target.threadId}: {}),
                  ...(i===pieces.length-1 ? intent.result.extra || {reply_markup:{inline_keyboard:[]}} : {})}),
              });
              const data=await response.json();
              if (edit && /message is not modified/i.test(data.description||'')) return;
              if(!response.ok || !data.ok)throw Error('Result delivery failed');
            };
            if(editing) { try { await send(true); } catch { await send(false); } }
            else await send(false);
            store.acknowledgeResult(id,'part:'+i);
          }
        }
        store.acknowledgeResult(id,'telegram');
      }
      store.finishResult(id);
    })().finally(()=>inflight.delete(id));
    inflight.set(id,promise);return promise;
  }
  return { deliver, async flush(skip = () => false) {
    for(const intent of store.all().filter(i=>i.state==='delivering' && !skip(i.id))) {
      try { await deliver(intent.id); } catch(error) { console.error('[restart-result]',intent.id,error.message); }
    }
  } };
}
module.exports={createResultDelivery};
