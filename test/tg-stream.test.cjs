'use strict';
// Flood-control for editMessageText (issue: "бот тупит" — Telegram 429 storm).
// V2 checks:
// (1) coalesce: rapid successive edits to the SAME chat collapse to <=1 fetch per
//     window, even from different "sessions" sharing a token.
// (2) bestEffort: a 429 on a progress edit returns { flooded } immediately —
//     no retry-with-retry_after sleep, no throw.
// (3) terminal edits still retry on 429, but the wait is capped so a dead
//     message fails fast (caller falls back to sendMessage).
// (4) starve backstop: a message that loses the per-chat coalesce slot to a
//     sibling message every tick ("постоянно 3 секунды, не меняется" — voice
//     report 2026-09-23) must eventually be forced through, not skipped forever.
const assert = require('node:assert/strict');
const { tgEdit } = require('../src/runner/tg-stream');

let calls = [];
const realFetch = globalThis.fetch;
function installFetch(statuses, retryAfter = 100) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, status: statuses.shift ? statuses.shift() : statuses });
    const status = calls[calls.length - 1].status;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => status === 429
        ? { ok: false, error_code: 429, parameters: { retry_after: retryAfter } }
        : { ok: true, result: { message_id: 1 } },
    };
  };
}

(async () => {
  try {
    // Two bots talking to the same human must not share flood/coalescing state.
    installFetch([200, 200]);
    await tgEdit('8815112204:recruiter', 91002003, 11, 'recruiter', {}, { coalesce: true });
    await tgEdit('8843910332:classic', 91002003, 11, 'classic', {}, { coalesce: true });
    assert.equal(calls.length, 2, 'different bot identities have independent edit slots');
    installFetch([429, 200], 100);
    await tgEdit('8815112204:recruiter', 91002004, 11, 'recruiter', {}, { bestEffort: true });
    await tgEdit('8843910332:classic', 91002004, 11, 'classic', {}, { bestEffort: true });
    assert.equal(calls.length, 2, 'one bot flood must not silence the other bot');
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

// (3) terminal edit retries on 429 (3 attempts); the wait HONORS Telegram's
// retry_after (regression: the old 8s cap sat BELOW the real 9-17s flood, so we
// retried too early, re-429'd and deepened the storm). retry_after=12 → each
// attempt waits the full 12s (not capped to 8), then throws after 3 tries.
installFetch([429, 429, 429], 12);
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
// 12s retry_after x3 waits = ~36s; the old 8s cap would give ~24s. The >= 30s
// bound proves we honor retry_after (12s) instead of capping below it (8s).
assert.ok(elapsed >= 30_000, `terminal wait must honor retry_after 12s, got ${elapsed}ms`);
assert.ok(elapsed < 60_000, `terminal wait bounded (elapsed=${elapsed}ms)`);

// (5) flood gate — a 429 on a progress edit suppresses subsequent best-effort
// edits for THIS chat until retry_after passes (they skip, no fetch), then lets
// one through. Other chats are unaffected.
installFetch([429, 200, 200], 1);
const r5a = await tgEdit('tok', 666, 1, 'a', {}, { bestEffort: true }); // 429 → flooded
assert.equal(r5a.flooded, true, 'flood: first edit reports flooded');
const r5b = await tgEdit('tok', 666, 1, 'b', {}, { bestEffort: true }); // skipped (flood window)
assert.equal(r5b.skipped, true, 'flood: next edit within window must skip, no fetch');
assert.equal(calls.length, 1, `flood: no fetch while window open, got ${calls.length}`);
const r5c = await tgEdit('tok', 777, 1, 'c', {}, { bestEffort: true }); // other chat unaffected
assert.ok(r5c.ok, 'flood: other chat is not suppressed');
assert.equal(calls.length, 2, `flood: other chat should fetch, got ${calls.length}`);

    // (4) starve backstop — msgA wins the coalesce slot every tick, msgB keeps
    // losing; after MAX_STARVE_STREAK (2) consecutive drops, msgB's next edit
    // must be forced through instead of skipped again.
    installFetch(200);
    await tgEdit('tok', 555, 'msgA', 'a0', {}, { bestEffort: true, coalesce: true }); // lands, claims slot
    const b0 = await tgEdit('tok', 555, 'msgB', 'b0', {}, { bestEffort: true, coalesce: true }); // drop 1
    await tgEdit('tok', 555, 'msgA', 'a1', {}, { bestEffort: true, coalesce: true }); // re-claims slot
    const b1 = await tgEdit('tok', 555, 'msgB', 'b1', {}, { bestEffort: true, coalesce: true }); // drop 2
    await tgEdit('tok', 555, 'msgA', 'a2', {}, { bestEffort: true, coalesce: true }); // re-claims slot
    const b2 = await tgEdit('tok', 555, 'msgB', 'b2', {}, { bestEffort: true, coalesce: true }); // forced
    assert.equal(b0.skipped, true, 'starve: 1st drop for msgB should still be skipped');
    assert.equal(b1.skipped, true, 'starve: 2nd drop for msgB should still be skipped');
    assert.ok(!b2.skipped, 'starve: 3rd consecutive drop for msgB must be forced through');

    console.log('PASS tg-stream flood-control: coalesce + bestEffort + capped retry + starve backstop');
  } finally {
    globalThis.fetch = realFetch;
  }
})();