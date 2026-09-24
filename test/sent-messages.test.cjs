// /clean_up_flood store: records outgoing TEXT ids per (bot token, chat), dedupes,
// keeps chats/bots separate, and deletes via Telegram on demand (batch, with a
// per-id fallback when deleteMessages is unavailable/rejected).
const os = require('os'), fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

// AGENT_DATA_DIR must be set before requiring data-paths/sent-messages (load-time const).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-msg-'));
process.env.AGENT_DATA_DIR = tmp;

const sm = require('../src/sent-messages');
const TOKEN = '123:ABC';
const CHAT = 555;

sm.record(TOKEN, CHAT, 10);
sm.record(TOKEN, CHAT, 11);
sm.record(TOKEN, CHAT, 10); // duplicate
ok(JSON.stringify(sm.list(TOKEN, CHAT)) === JSON.stringify([10, 11]), 'records ids in order and dedupes');
ok(sm.list(TOKEN, 777).length === 0, 'a different chat has its own store');
ok(sm.list('999:ZZZ', CHAT).length === 0, 'a different bot token has its own store');
ok(sm.list(TOKEN, CHAT).every((id) => Number.isInteger(id)), 'list returns plain ids');

(async () => {
  // 1. Happy path: deleteMessages batch succeeds, store is cleared.
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  let r = await sm.deleteAll(TOKEN, CHAT);
  ok(r.total === 2 && r.deleted === 2 && r.failed === 0, `deleteAll reports all deleted (got ${JSON.stringify(r)})`);
  ok(sm.list(TOKEN, CHAT).length === 0, 'store is cleared after deleteAll');

  // 2. Fallback: deleteMessages rejected → delete one by one.
  sm.record(TOKEN, CHAT, 20);
  sm.record(TOKEN, CHAT, 21);
  const perId = [];
  global.fetch = async (u, o) => {
    if (String(u).includes('/deleteMessages')) return { ok: false, json: async () => ({ ok: false, description: 'unknown method' }) };
    perId.push(JSON.parse(o.body).message_id);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  r = await sm.deleteAll(TOKEN, CHAT);
  ok(perId.includes(20) && perId.includes(21), 'falls back to per-id deleteMessage');
  ok(r.deleted === 2, `per-id fallback counts deletes (got ${JSON.stringify(r)})`);

  // 3. Empty store is a no-op.
  r = await sm.deleteAll(TOKEN, CHAT);
  ok(r.total === 0 && r.deleted === 0, 'empty store is a no-op');

  console.log(`\nsent-messages: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
