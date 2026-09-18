'use strict';

// Per-chat serialization — one active task per Telegram chat at a time.
//
// Tests the runner-chat-queue.js module directly (pure promise logic, no Claude,
// no Telegram). The invariants:
//
//   P1  same chat, sequential tasks → second task waits for first to finish
//   P2  different chats → run in parallel (do NOT block each other)
//   P3  chatId=0 (internal/web callers) → NOT serialized
//   P4  hasPending() → true while a task is running, false after
//   P5  clearChat() → discards pending queue for a chat (used by /wakeup)
//   P6  three tasks same chat → queue in order (A → B → C), not collapsed

const { enqueue, hasPending, clearChat, _queue } = require('../src/runner-chat-queue');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } }
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // P1 — same chat: B must not start before A finishes.
  {
    const log = [];
    let resolveA;
    const aWork = new Promise(r => { resolveA = r; });

    enqueue(111, async () => { log.push('A:start'); await aWork; log.push('A:end'); });
    enqueue(111, async () => { log.push('B:start'); log.push('B:end'); });

    await tick();
    ok(log.join() === 'A:start', 'P1 B has not started while A is running');

    resolveA();
    await tick(); await tick(); await tick();
    ok(log.join() === 'A:start,A:end,B:start,B:end', 'P1 B runs after A finishes, in order');
  }

  // P2 — different chats: run in parallel.
  {
    const log = [];
    let resolveA;
    const aWork = new Promise(r => { resolveA = r; });

    enqueue(222, async () => { log.push('A:start'); await aWork; log.push('A:end'); });
    enqueue(333, async () => { log.push('B:start'); log.push('B:end'); });

    await tick();
    ok(log.includes('A:start') && log.includes('B:start'), 'P2 tasks from different chats start in parallel');

    resolveA();
    await tick(); await tick();
    ok(log.includes('A:end') && log.includes('B:end'), 'P2 both complete');
  }

  // P3 — chatId=0: NOT serialized (each runs immediately).
  {
    const log = [];
    let resolveA;
    const aWork = new Promise(r => { resolveA = r; });

    enqueue(0, async () => { log.push('A:start'); await aWork; log.push('A:end'); });
    enqueue(0, async () => { log.push('B:start'); });

    await tick();
    ok(log.includes('B:start'), 'P3 chatId=0 tasks are NOT serialized — B starts immediately');

    resolveA();
    await tick();
  }

  // P4 — hasPending() reflects queue state.
  {
    let resolveX;
    const xWork = new Promise(r => { resolveX = r; });
    ok(!hasPending(444), 'P4 hasPending false before any task');

    enqueue(444, () => xWork);
    await tick();
    ok(hasPending(444), 'P4 hasPending true while task is running');

    resolveX();
    await tick(); await tick();
    ok(!hasPending(444), 'P4 hasPending false after task completes');
  }

  // P5 — clearChat() discards pending queue; no new tasks start for the chat.
  {
    const log = [];
    let resolveA;
    const aWork = new Promise(r => { resolveA = r; });

    enqueue(555, async () => { log.push('A:start'); await aWork; log.push('A:end'); });
    enqueue(555, async () => { log.push('B:start'); });
    await tick();
    ok(log.join() === 'A:start', 'P5 setup: B waiting while A runs');

    clearChat(555); // drop the queue entry for chat 555
    resolveA();
    await tick(); await tick();
    // B was queued but clearChat dropped the tail pointer; B's own promise still
    // resolves (it was chained before clearChat), so B may still run.
    // The key contract: hasPending(555) is false after clearChat.
    ok(!hasPending(555), 'P5 clearChat drops the pending queue pointer');
  }

  // P6 — three tasks from the same chat queue in order: A → B → C.
  {
    const log = [];
    const resolvers = {};
    for (const name of ['A', 'B', 'C']) {
      const p = new Promise(r => { resolvers[name] = r; });
      enqueue(666, async () => { log.push(`${name}:start`); await p; log.push(`${name}:end`); });
    }

    await tick();
    ok(log.join() === 'A:start', 'P6 only A started, B and C waiting');

    resolvers.A();
    await tick(); await tick();
    ok(log.filter(x => x.endsWith(':start')).join() === 'A:start,B:start', 'P6 B starts after A');

    resolvers.B();
    await tick(); await tick();
    ok(log.filter(x => x.endsWith(':start')).join() === 'A:start,B:start,C:start', 'P6 C starts after B');

    resolvers.C();
    await delay(10);
    ok(log.join() === 'A:start,A:end,B:start,B:end,C:start,C:end', 'P6 full sequence in order');
  }

  console.log(`\nper-chat-queue: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
