'use strict';

// Concurrency-lane granularity — the serialization lane is keyed by SESSION.
//
// History: the lane was briefly keyed by workDir (#546, "R6 fix"), which
// wrongly serialized two sessions that merely share a project workDir. The
// owner constraint is the opposite: «в 1 workDir могут работать несколько
// сессий с разных чатов или с веба — нормально работает» → those MUST run in
// parallel. The lane's only real job is "one `claude` per transcript", i.e. per
// SESSION. Cross-session limits are the per-profile cap + global semaphore,
// never this lane.
//
// Contract encoded here (runner._laneKey(sessionId, chatId)):
//   L1 same session, reached via web (chat 0) AND chat → SAME key (serialize)
//   L2 two DIFFERENT sessions in the same workDir/chat  → DISTINCT keys (parallel)
//   L3 two web sessions (both chatId 0), different ids   → DISTINCT keys (parallel)
//   L4 brand-new session (no id), same chat              → SAME chat key (collapse)
//   L5 brand-new sessions in different chats             → DISTINCT chat keys

const { _laneKey } = require('../src/runner.js');

let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.log('FAIL:', m)); }

// L1 — same session id from web (0) and from a chat → one lane → serialize.
ok(_laneKey('s-42', '0') === _laneKey('s-42', '774411'),
   'L1 same session via web+chat → same lane');

// L2 — two different sessions in the same chat/workDir → distinct → parallel.
ok(_laneKey('s-1', '774411') !== _laneKey('s-2', '774411'),
   'L2 two sessions same chat → distinct lanes (parallel)');

// L3 — two web sessions, both chatId 0, distinct ids → distinct → parallel
//      (the old chatId-only lane collapsed all web into one; must not).
ok(_laneKey('w-a', '0') !== _laneKey('w-b', '0'),
   'L3 two web sessions (chat 0) → distinct lanes (parallel)');

// L4 — brand-new session (no id yet), same chat → same chat lane → collapse
//      into one session ("one active session per chat").
ok(_laneKey(null, '774411') === _laneKey(undefined, '774411'),
   'L4 new session, same chat → same chat lane');
ok(_laneKey(null, '774411').startsWith('chat:'),
   'L4 new session falls back to chat: lane');

// L5 — brand-new sessions in different chats → distinct chat lanes → parallel.
ok(_laneKey(null, '111') !== _laneKey(null, '222'),
   'L5 new sessions, different chats → distinct lanes');

// A session lane and a chat lane never collide by construction.
ok(_laneKey('111', 'x') !== _laneKey(null, '111'),
   'session:111 and chat:111 namespaces disjoint');

console.log(`lane-granularity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
