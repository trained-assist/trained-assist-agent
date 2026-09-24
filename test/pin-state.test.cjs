// Regression test for the per-chat context pin (one profile → many Telegram chats).
// Bug: a single {msgId,chatId} slot in .pin_state.json meant every task from a
// different chat wiped the slot and posted a brand-new pinned card (spam).
// Fix: state is keyed per chatId; each chat edits its own pinned message in place.
const os = require('os'), fs = require('fs'), path = require('path'), http = require('http');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

(async () => {
  // Mock Telegram API: assigns incrementing message_ids, records every call.
  const calls = [];
  let nextId = 100;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const p = JSON.parse(body || '{}');
      const method = req.url.split('/').pop();
      calls.push({ method, ...p });
      if (method === 'sendMessage') {
        res.end(JSON.stringify({ ok: true, result: { message_id: ++nextId } }));
      } else if (method === 'editMessageText') {
        res.end(JSON.stringify({ ok: true, result: { message_id: p.message_id } }));
      } else if (method === 'pinChatMessage') {
        res.end(JSON.stringify({ ok: true, result: true }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise(r => server.listen(0, r));
  process.env.TELEGRAM_API_URL = `http://127.0.0.1:${server.address().port}`;

  const { _pin } = require('../src/runner');
  const { updateContextPin, readPinStore } = _pin;
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  const pinFile = path.join(wd, '.pin_state.json');
  const chatA = -5039573935, chatB = -5496844108;

  // 1. First task in chat A → sends + pins one message.
  await updateContextPin('T', chatA, wd, '📌 A v1');
  const sendsA = calls.filter(c => c.method === 'sendMessage').length;
  ok(sendsA === 1, 'chat A: one sendMessage on first pin');
  const storeA = readPinStore(pinFile);
  const msgA = storeA.chats[String(chatA)]?.msgId;
  ok(!!msgA, 'chat A msgId stored');

  // 2. Second task in chat A → EDITS the same message, no new send.
  calls.length = 0;
  await updateContextPin('T', chatA, wd, '📌 A v2');
  ok(calls.filter(c => c.method === 'sendMessage').length === 0, 'chat A: no new send on update');
  ok(calls.some(c => c.method === 'editMessageText' && c.message_id === msgA), 'chat A: edited same msgId');

  // 3. Task from a DIFFERENT chat B → must NOT touch chat A; sends its own message.
  calls.length = 0;
  await updateContextPin('T', chatB, wd, '📌 B v1');
  ok(calls.filter(c => c.method === 'sendMessage').length === 1, 'chat B: one send (own card)');
  const store3 = readPinStore(pinFile);
  const msgB = store3.chats[String(chatB)]?.msgId;
  ok(msgB && msgB !== msgA, 'chat B has its own msgId');
  ok(store3.chats[String(chatA)]?.msgId === msgA, 'chat A msgId preserved after chat B ran');

  // 4. Back to chat A → still edits A's original message, no spam.
  calls.length = 0;
  await updateContextPin('T', chatA, wd, '📌 A v3');
  ok(calls.filter(c => c.method === 'sendMessage').length === 0, 'chat A: no new send (was clobbered before fix)');
  ok(calls.some(c => c.method === 'editMessageText' && c.message_id === msgA), 'chat A: still edits original msgId');

  // Same chat through a second bot gets a separate pin and never edits main's message.
  calls.length = 0;
  const scope = { botId: 'freelance', audience: 'jobs' };
  await updateContextPin('J', chatA, wd, 'jobs pin', null, scope);
  ok(!calls.some(c => c.method === 'editMessageText' && c.message_id === msgA), 'second bot never edits main pin');
  const jobsKey = JSON.stringify(['freelance', 'jobs', String(chatA)]);
  const jobsId = readPinStore(pinFile).chats[jobsKey]?.msgId;
  ok(jobsId && jobsId !== msgA, 'second bot has its own durable pin');
  calls.length = 0;
  await updateContextPin('J', chatA, wd, 'jobs pin updated', null, scope);
  ok(calls.some(c => c.method === 'editMessageText' && c.message_id === jobsId), 'second bot reuses its own pin');
  ok(readPinStore(pinFile).chats[String(chatA)]?.msgId === msgA, 'main bot pin survives');

  // 5. Legacy flat format migrates under its chatId.
  const legacy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pin2-')), '.pin_state.json');
  fs.writeFileSync(legacy, JSON.stringify({ msgId: 777, chatId: chatA, lastCard: 'old', noPin: true }));
  const migrated = readPinStore(legacy);
  ok(migrated.chats[String(chatA)]?.msgId === 777 && migrated.chats[String(chatA)]?.noPin === true, 'legacy flat format migrated per-chat');

  server.close();
  console.log(`\npin-state: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
