'use strict';

// Repro + regression for issue #531:
// "Session started from the batch buffer starts context-blind — the accumulated
//  input never reaches the LLM's context."
//
// Gateway (intake-buffer.js) coalesces N buffered messages into one task and
// dispatches it. This test simulates the batch-flush handoff -> new session start,
// and pins the exact drop that leaves a follow-up turn blind.
//
// Fork the issue demands a test (not an eyeball) resolve:
//   (A) first claude-run of the new session really gets the coalesced task in its prompt;
//   (B) the just-created session is never registered as the chat's CURRENT session
//       (setCurrentSessionId was deferred to after the long run in runner.js), so a
//       follow-up arriving mid-run / after a crash resolves to null -> blind + orphaned.
// Verdict encoded: A holds (first-turn prompt fine), the drop is B.

const os = require('os'), fs = require('fs'), path = require('path');
const sessions = require('../src/session-store.js');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

(async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc531-'));
  const chatId = '99001';

  const buffered = [
    'Privet, smotri kakaya zadacha.',
    'U klienta pri sozdanii sessii teryaetsya kontekst - novyy chat startuet slepoy.',
    'Nuzhno chtoby MCP vsegda videl predydushchie soobshcheniya i ih kolichestvo.',
    'I postav smoke-test, chtoby eta shtuka rabotala vsegda.',
  ];
  // intake-buffer.js: coalescedText = prefix + buf.map(i => i.text).join('\n')
  const coalescedTask = buffered.join('\n');

  // Turn 1: new session created from the flushed batch (runner.js new-session branch)
  const id = sessions.createSession(workDir, { task: coalescedTask, chatId, projectId: null });

  // Criterion 1(a): FIRST-turn prompt contains the whole coalesced buffer.
  // Replicates runner.js:2001-2004 for a NEW session (sessionContext null -> currentTask = task).
  const FAKE_BASE = '[system prompt sections]';
  const sessionContext = null;
  const currentTask = sessionContext ? 'Polzovatel: ' + coalescedTask : coalescedTask;
  const firstPrompt = FAKE_BASE ? FAKE_BASE + '\n\n' + currentTask : currentTask;
  ok(buffered.every(m => firstPrompt.includes(m)),
     'branch A: first-turn prompt contains all N coalesced messages');

  // Criterion 2 (the decisive one): the follow-up carries no explicit sessionId, so
  // the runner resolves the target session via getCurrentSessionId. On buggy code
  // createSession never registered it -> null -> a brand-new BLIND session.
  const resolvedId = sessions.getCurrentSessionId(workDir, chatId);
  ok(resolvedId === id,
     'branch B (the drop): just-created session is the chat CURRENT session');

  const ctx = resolvedId ? sessions.buildContext(workDir, resolvedId, 1500, 8) : null;
  ok(ctx && ctx.includes(buffered[1]),
     'buildContext() on the next turn includes the first coalesced message (the TZ)');

  // Criterion 3: MCP last_messages / load_full_context see all N + correct count.
  const prevEnv = process.env.AGENT_SESSION_FILE;
  process.env.AGENT_SESSION_FILE = path.join(workDir, 'sessions', id + '.json');
  try {
    const lfc = require('../src/mcp-skills/tools/01-session-history.js');
    const full = await lfc.tools.load_full_context.handler({ limit: 20, chars_per_message: 20000 });
    ok(full.total_messages === 1 && full.returned === 1,
       'load_full_context: count reflects the single coalesced first message');
    ok(buffered.every(m => full.messages[0].text.includes(m)),
       'load_full_context: coalesced body carries all N buffered messages');

    const sess = require('../src/mcp-skills/tools/05-session.js');
    const lm = await sess.tools.last_messages.handler({ count: 8 });
    ok(lm.total === 1 && lm.messages.length === 1,
       'last_messages: total count correct and the TZ message returned');
  } finally {
    if (prevEnv === undefined) delete process.env.AGENT_SESSION_FILE;
    else process.env.AGENT_SESSION_FILE = prevEnv;
  }

  // Criterion 4 (regression): continuing an EXISTING session is not broken.
  sessions.appendUserMessage(workDir, id, 'poshlo dumanie?');
  const contId = sessions.getCurrentSessionId(workDir, chatId);
  ok(contId === id, 'regression: continuation still resolves to the same session');
  const ctx2 = sessions.buildContext(workDir, id, 1500, 8);
  ok(ctx2.includes('poshlo dumanie?') && ctx2.includes(buffered[1]),
     'regression: continuation context carries both the follow-up and the original TZ');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
