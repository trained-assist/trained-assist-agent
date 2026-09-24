'use strict';

// «Чат = проект» (issue #1312): a project the user explicitly chose is PINNED to the chat;
// every new session of that chat goes into it without the "which project?" picker.
//
//   C1  ≥2 projects, nothing pinned → 'ask' (unchanged behaviour)
//   C2  explicit choice (pinned:true) → decideNewSessionProject = 'auto' + pinned, no picker
//   C3  automatic bookkeeping (runner continuing an OLD session in another project) does
//       NOT steal the pin
//   C4  pin is per chat: another chat of the same profile still gets 'ask'
//   C5  archived pinned project → falls back to 'ask' (never binds to a dead folder)
//   C6  explicit re-choice moves the pin
//   C7  auto-set of the SAME id keeps the pin flag
//   C8  context card shows «📁 Проект: …» for the chat

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.AGENT_TOKENS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pin-tok-'));
const projects = require('../src/projects');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pin-'));
try {
  const a = projects.createProject(root, 'recruiting: Вакансия А');
  const b = projects.createProject(root, 'Основной');
  const CHAT = 111, OTHER = 222;

  ok(projects.decideNewSessionProject(root, CHAT).action === 'ask', 'C1 nothing pinned → ask');

  projects.setActiveProjectId(root, a.id, CHAT, { pinned: true });
  let d = projects.decideNewSessionProject(root, CHAT);
  ok(d.action === 'auto' && d.project.id === a.id && d.pinned === true, `C2 pinned → auto into A (${JSON.stringify({ action: d.action, id: d.project && d.project.id })})`);

  projects.setActiveProjectId(root, b.id, CHAT); // runner auto-bookkeeping for an old B session
  d = projects.decideNewSessionProject(root, CHAT);
  ok(d.action === 'auto' && d.project.id === a.id, 'C3 auto bookkeeping does not steal the pin');
  ok(projects.getPinnedProjectId(root, CHAT) === a.id, 'C3 pinned id still A');

  ok(projects.decideNewSessionProject(root, OTHER).action === 'ask', 'C4 other chat unaffected → ask');

  projects.setActiveProjectId(root, a.id, CHAT); // same id, auto
  ok(projects.getPinnedProjectId(root, CHAT) === a.id, 'C7 auto-set of same id keeps pin');

  projects.setActiveProjectId(root, b.id, CHAT, { pinned: true });
  ok(projects.getPinnedProjectId(root, CHAT) === b.id && projects.decideNewSessionProject(root, CHAT).project.id === b.id, 'C6 explicit re-choice moves the pin');

  // C8 — context card line (card renders only with ≥1 connected service → fake one).
  const tokensRoot = process.env.AGENT_TOKENS_ROOT;
  const username = 'u-pin-' + Date.now();
  fs.mkdirSync(path.join(tokensRoot, username), { recursive: true });
  fs.writeFileSync(path.join(tokensRoot, username, 'github'), JSON.stringify({ value: 'fake' }));
  const { _pin } = require('../src/runner');
  const card = _pin.buildContextCard(username, root, CHAT);
  ok(/📁 Проект: Основной · сменить: \/project/.test(card || ''), `C8 card shows the chat project, got: ${card}`);
  ok(!/📁 Проект/.test(_pin.buildContextCard(username, root, OTHER) || ''), 'C8 chat without a project → no project line');

  projects.archiveProject(root, b.id);
  d = projects.decideNewSessionProject(root, CHAT);
  ok(d.action !== 'auto' || d.project.id !== b.id, 'C5 archived pinned project is never auto-bound');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`chat-pinned-project: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
