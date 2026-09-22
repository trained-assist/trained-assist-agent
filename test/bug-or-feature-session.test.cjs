// Contract test for the new /bug_or_feature intake (Bugs & Features redesign, see
// generic-gtd-task-management-automation/BUGS-AND-FEATURES-SPEC.md §3.4, PR2).
// The command opens a FRESH session inside the reserved `bugs-and-features` project and
// returns a greeting. It must NOT capture the next message and must NEVER call GitHub.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const projects = require('../src/projects');
const sessions = require('../src/session-store');
const { runQuickAnswer } = require('../src/runner/intent-engine');

// Hard-fail any network attempt: the old path POSTed an issue to api.github.com.
let fetchCalls = 0;
global.fetch = () => { fetchCalls++; throw new Error('network disabled in test'); };

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-of-session-test-'));
const chatId = 'test-chat-1';

(async () => {
  // ── First invocation ────────────────────────────────────────────────────────
  const greeting = await runQuickAnswer('/bug_or_feature', 'testuser', workDir, null, false, chatId);
  ok(typeof greeting === 'string' && greeting.length > 0, 'returns a non-empty reply');
  ok(/Bugs and Features/i.test(greeting), 'greeting names the "Bugs and Features" project');
  ok(/▶️/.test(greeting), 'greeting points at the ▶️ button');
  ok(/несколько сообщений/i.test(greeting), 'greeting says multiple messages are welcome');

  const proj = projects.listProjects(workDir).find(p => p.type === 'bugs');
  ok(!!proj && proj.id === 'bugs-and-features', 'bugs-and-features project exists after the command');

  const cur = sessions.getCurrentSessionId(workDir, chatId);
  ok(!!cur, 'a current session is registered for the chat');
  const sess = cur ? sessions.getSession(workDir, cur) : null;
  ok(!!sess && sess.projectId === 'bugs-and-features', 'the new session is bound to the bugs project');

  // ── No pending-capture file: the next message is NOT swallowed ───────────────
  const ofPending = path.join(workDir, 'contexts', 'bugreport', `or-feature-pending-${chatId}.json`);
  ok(!fs.existsSync(ofPending), 'no or-feature-pending flag is written');

  const before = cur ? sessions.getSession(workDir, cur).messages.length : -1;
  const followUp = await runQuickAnswer('сегодня раздел отчётов пришёл пустой, но уже само прошло', 'testuser', workDir, null, true, chatId);
  ok(!followUp || !/Отчёт отправлен|github/i.test(followUp), 'a plain follow-up is not converted into a GitHub report');
  const after = cur ? sessions.getSession(workDir, cur).messages.length : -1;
  ok(after === before, 'the follow-up does not append anything to the intake session on its own');

  // ── A second invocation starts a FRESH session (not the old one) ─────────────
  await new Promise(r => setTimeout(r, 5)); // createSession ids are ms-stamped
  await runQuickAnswer('/bug_or_feature', 'testuser', workDir, null, true, chatId);
  const cur2 = sessions.getCurrentSessionId(workDir, chatId);
  ok(!!cur2 && cur2 !== cur, 'each /bug_or_feature opens a fresh session');

  // ── GitHub / network was never touched ───────────────────────────────────────
  ok(fetchCalls === 0, 'no network call (GitHub issue) was attempted');

  // ── PR3 (Harness A): a fresh gateway-supplied sessionId is honored ───────────
  // The gateway now forces a new session (fresh id, forceNew:true) for /bug_or_feature —
  // the agent must create the bugs session under THAT exact id, or the gateway's
  // lastSessionId points at an orphan and every buffered follow-up misroutes.
  const gatewayId = `s-${Date.now()}-gw`;
  const greeting3 = await runQuickAnswer('/bug_or_feature', 'testuser', workDir, null, false, chatId, null, gatewayId);
  ok(/Bugs and Features/i.test(greeting3), 'honored-id invocation still greets');
  const sess3 = sessions.getSession(workDir, gatewayId);
  ok(!!sess3 && sess3.projectId === 'bugs-and-features', 'session was created under the gateway-supplied id');
  const cur3 = sessions.getCurrentSessionId(workDir, chatId);
  ok(cur3 === gatewayId, 'current-session pointer matches the gateway-supplied id');

  // ── PR3 safety net: a sessionId that already exists (sessionExists=true) is never
  // reused for the new bugs session — would silently overwrite a real conversation.
  await new Promise(r => setTimeout(r, 5));
  const existingId = gatewayId; // sess3 already exists on disk under this id
  await runQuickAnswer('/bug_or_feature', 'testuser', workDir, null, true, chatId, null, existingId);
  const cur4 = sessions.getCurrentSessionId(workDir, chatId);
  ok(!!cur4 && cur4 !== existingId, 'sessionExists=true never overwrites the existing session id');
  const sess3Untouched = sessions.getSession(workDir, existingId);
  ok(sess3Untouched.messages.length === sess3.messages.length, 'the earlier session under that id is left untouched');

  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`\nbug-or-feature-session: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
