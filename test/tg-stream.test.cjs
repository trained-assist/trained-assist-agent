'use strict';
// Flood-control for editMessageText (issue: "бот тупит" — Telegram 429 storm).
// V2 checks:
// (1) coalesce: rapid successive edits to the SAME chat collapse to <=1 fetch per
//     window, even from different "sessions" sharing a token.
// (2) bestEffort: a 429 on a progress edit returns { flooded } immediately —
//     no retry-with-retry_after sleep, no throw.
// (3) terminal edits still retry on 429, but the wait is capped so a dead
//     message fails fast (caller falls back to sendMessage).
const assert = require('node:assert/strict');
const { tgEdit } = require('../src/runner/tg-stream');

let calls = [];
const realFetch = globalThis.fetch;
function installFetch(statuses) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, status: statuses.shift ? statuses.shift() : statuses });
    const status = calls[calls.length - 1].status;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => status === 429
        ? { ok: false, error_code: 429, parameters: { retry_after: 100 } }
        : { ok: true, result: { message_id: 1 } },
    };
  };
}

(async () => {
  try {
    // (1) coalesce — 3 rapid edits to one chat => exactly 1 fetch
    installFetch(200);
    await tgEdit('tok', 111, 1, 'a', {}, { coalesce: true });
    await tgEdit('tok', 111, 1, 'b', {}, { coalesce: true });
    await tgEdit('tok', 111, 1, 'c', {}, { coalesce: true });
    assert.equal(calls.length, 1, `coalesce: expected 1 fetch, got ${calls.length}`);

    // (1b) different chats are NOT coalesced
    installFetch(200);
    await tgEdit('tok', 1111, 1, 'a', {}, { coalesce: true });
    await tgEdit('tok', 2222, 1, 'b', {}, { coalesce: true });
    assert.equal(calls.length, 2, `coalesce: distinct chats should both land, got ${calls.length}`);

    // (2) bestEffort — 429 drops immediately, no retry, no throw
    installFetch(429);
    const r2 = await tgEdit('tok', 333, 1, 'x', {}, { bestEffort: true });
    assert.equal(calls.length, 1, `bestEffort: expected 1 fetch, got ${calls.length}`);
    assert.equal(r2.flooded, true, 'bestEffort 429 must report flooded');
    assert.equal(r2.ok, false, 'bestEffort 429 must not report ok');

    // (3) terminal edit retries on 429 (3 attempts) with capped wait, then throws
    installFetch([429, 429, 429]);
    const t0 = Date.now();
    let threw = false;
    try {
      await tgEdit('tok', 444, 1, 'final', {}, { retries: 3 });
    } catch (e) {
      threw = /retries exhausted/.test(e.message);
    }
    const elapsed = Date.now() - t0;
    assert.equal(calls.length, 3, `terminal: expected 3 attempts, got ${calls.length}`);
    assert.equal(threw, true, 'terminal: must throw after retries exhausted');
    // 100s retry_after x3 would be 300s; capped at 8s each => well under
    assert.ok(elapsed < 60_000, `terminal wait must be capped (elapsed=${elapsed}ms)`);

    console.log('PASS tg-stream flood-control: coalesce + bestEffort + capped retry');
  } finally {
    globalThis.fetch = realFetch;
  }
})();