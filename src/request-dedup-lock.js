'use strict';

// Per-key in-process mutex (issue #1302 §3.4). Serializes overlapping /run
// admissions that share the same logical request key so the
// check-receipt/pending -> materialize media -> runTask -> write-receipt
// sequence in server.js cannot interleave between two concurrent POSTs of the
// SAME (audience, username, chatId, requestId). Distinct keys never contend.
//
// This only protects in-process concurrency (two requests racing inside one
// live server process). It is deliberately not a durable admission store — a
// crash mid-sequence is recovered by the existing receipt files and pending-
// task journal (see server.js POST /run), not by this lock. No separate
// admission DB is introduced.
const tails = new Map(); // key -> Promise (chain marker only, never rejects)

async function withDedupLock(key, fn) {
  const prevTail = tails.get(key) || Promise.resolve();
  const run = prevTail.then(fn, fn); // proceed even if the previous holder threw
  const placeholder = run.then(() => {}, () => {});
  tails.set(key, placeholder);
  placeholder.finally(() => {
    if (tails.get(key) === placeholder) tails.delete(key);
  });
  return run;
}

module.exports = { withDedupLock };
