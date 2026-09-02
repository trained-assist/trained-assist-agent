// Local HTTP server that captures Telegram Bot API calls.
// Use as a drop-in replacement for the Telegram API in tests:
//   const tg = await startMockTelegram();
//   process.env.TELEGRAM_API_URL = tg.url;
//   // ... run task ...
//   tg.texts(); // → array of sent message texts
//   await tg.stop();

import * as http from 'http';

export async function startMockTelegram() {
  const log = [];
  let server;

  const port = await new Promise(resolve => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        log.push({ url: req.url, body: parsed });
        const msgId = Math.floor(Math.random() * 9000 + 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: msgId } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    log,
    clear: () => { log.length = 0; },
    stop: () => new Promise(r => server.close(r)),
    sent: () => log.filter(l => l.url.includes('sendMessage') || l.url.includes('editMessageText')),
    texts: () => log
      .filter(l => l.url.includes('sendMessage') || l.url.includes('editMessageText'))
      .map(l => l.body.text)
      .filter(Boolean),
  };
}
