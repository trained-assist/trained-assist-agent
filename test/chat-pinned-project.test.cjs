'use strict';

// «Чат = проект» (issues #1312, #1318): a project the user explicitly chose is PINNED to
// the chat; every new session of that chat goes into it without the "which project?" picker.
//
//   C1  ≥2 projects, nothing pinned → 'ask'
//   C2  explicit choice (pinned:true) → decideNewSessionProject = 'auto' + pinned
//   C3  automatic bookkeeping (continuing an OLD session in another project) keeps the pin
//   C4  pin is per chat: another chat of the same profile still gets 'ask'
//   C5  archived pinned project: exact outcome — 1 project left → auto into it (not pinned);
//       ≥2 left → ask
//   C6  explicit re-choice moves the pin
//   C7  pin and last-used live in separate files: interleaved writes never lose the pin;
//       legacy pinned:true inside active-*.json is read and migrated on the next write
//   C8  context card «📁 Проект» only when a new session really goes there without asking
//   R*  run-level decision (resolveRunProject): only a menu pick pins
//   P*  /project <name> and /project new pin via the intent engine
//   B*  /bug_or_feature does not steal the pin
//   M*  reorg merging the pinned project moves the pin; revert restores it

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.AGENT_TOKENS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pin-tok-'));
const projects = require('../src/projects');
const sessions = require('../src/session-store');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } }
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const roots = [];

try {
  // ── C1–C6 ───────────────────────────────────────────────────────────────────
  const root = tmp('chat-pin-'); roots.push(root);
  const a = projects.createProject(root, 'recruiting: Вакансия А');
  const b = projects.createProject(root, 'Основной');
  const CHAT = 111, OTHER = 222;

  ok(projects.decideNewSessionProject(root, CHAT).action === 'ask', 'C1 nothing pinned → ask');

  projects.setActiveProjectId(root, a.id, CHAT, { pinned: true });
  let d = projects.decideNewSessionProject(root, CHAT);
  ok(d.action === 'auto' && d.project.id === a.id && d.pinned === true, `C2 pinned → auto into A (${JSON.stringify({ action: d.action, id: d.project && d.project.id })})`);

  projects.setActiveProjectId(root, b.id, CHAT); // runner bookkeeping for an old B session
  d = projects.decideNewSessionProject(root, CHAT);
  ok(d.action === 'auto' && d.project.id === a.id, 'C3 bookkeeping does not steal the pin');
  ok(projects.getActiveProjectId(root, CHAT) === b.id, 'C3 last-used is recorded separately (B)');

  ok(projects.decideNewSessionProject(root, OTHER).action === 'ask', 'C4 other chat unaffected → ask');

  projects.setActiveProjectId(root, b.id, CHAT, { pinned: true });
  ok(projects.getPinnedProjectId(root, CHAT) === b.id && projects.decideNewSessionProject(root, CHAT).project.id === b.id, 'C6 explicit re-choice moves the pin');

  // ── C7: separate files, interleaved writes, legacy migration ────────────────
  const pinFile = path.join(projects.projectsRoot(root), `pin-${CHAT}.json`);
  const actFile = path.join(projects.projectsRoot(root), `active-${CHAT}.json`);
  ok(fs.existsSync(pinFile) && fs.existsSync(actFile), 'C7 pin and last-used are two files');
  for (let i = 0; i < 50; i++) projects.setActiveProjectId(root, i % 2 ? a.id : b.id, CHAT);
  ok(projects.getPinnedProjectId(root, CHAT) === b.id, 'C7 50 interleaved bookkeeping writes never touch the pin');
  ok(!('pinned' in JSON.parse(fs.readFileSync(actFile, 'utf8'))), 'C7 last-used file carries no pin flag');
  // legacy: #1316 stored the pin as pinned:true inside active-*.json
  const LEG = 333;
  fs.writeFileSync(path.join(projects.projectsRoot(root), `active-${LEG}.json`), JSON.stringify({ id: a.id, at: 1, pinned: true }));
  ok(projects.getPinnedProjectId(root, LEG) === a.id, 'C7 legacy pinned:true is read');
  projects.setActiveProjectId(root, b.id, LEG); // bookkeeping write drops the legacy flag…
  ok(projects.getPinnedProjectId(root, LEG) === a.id, 'C7 …but the legacy pin is migrated to pin-*.json first');

  // ── C8: context card ────────────────────────────────────────────────────────
  const tokensRoot = process.env.AGENT_TOKENS_ROOT;
  const username = 'u-pin-' + Date.now();
  fs.mkdirSync(path.join(tokensRoot, username), { recursive: true });
  fs.writeFileSync(path.join(tokensRoot, username, 'github'), JSON.stringify({ value: 'fake' }));
  const { _pin } = require('../src/runner');
  ok(/📁 Проект: Основной · сменить: \/project/.test(_pin.buildContextCard(username, root, CHAT) || ''), 'C8 pinned chat → card shows the project');
  projects.setActiveProjectId(root, a.id, OTHER); // last-used but NOT pinned, 2 projects
  ok(!/📁 Проект/.test(_pin.buildContextCard(username, root, OTHER) || ''), 'C8 ≥2 projects, no pin → no line (bot will ask)');
  const single = tmp('chat-pin-single-'); roots.push(single);
  projects.createProject(single, 'Единственный');
  ok(/📁 Проект: Единственный/.test(_pin.buildContextCard(username, single, OTHER) || ''), 'C8 single project → line shown (auto)');

  // ── C5: archive the pinned project — exact outcome ──────────────────────────
  projects.archiveProject(root, b.id); // A remains alone
  d = projects.decideNewSessionProject(root, CHAT);
  ok(d.action === 'auto' && d.project.id === a.id && !d.pinned, `C5 one project left → auto into A, not pinned (${JSON.stringify({ action: d.action, pinned: d.pinned })})`);
  ok(projects.getPinnedProjectId(root, CHAT) === null, 'C5 dead pin is ignored');
  const three = tmp('chat-pin-3-'); roots.push(three);
  const t1 = projects.createProject(three, 'Один');
  projects.createProject(three, 'Два');
  projects.createProject(three, 'Три');
  projects.setActiveProjectId(three, t1.id, CHAT, { pinned: true });
  projects.archiveProject(three, t1.id);
  ok(projects.decideNewSessionProject(three, CHAT).action === 'ask', 'C5 ≥2 left → ask');

  // ── R*: run-level decision ──────────────────────────────────────────────────
  const run = tmp('chat-pin-run-'); roots.push(run);
  const ra = projects.createProject(run, 'Альфа');
  const rb = projects.createProject(run, 'Бета');
  let r = projects.resolveRunProject(run, { chatId: CHAT, projectId: ra.id });
  ok(r.projectId === ra.id && r.pin === false, 'R1 projectId without projectPicked → binds, does not pin');
  r = projects.resolveRunProject(run, { chatId: CHAT, projectId: rb.id, projectPicked: true });
  ok(r.projectId === rb.id && r.pin === true, 'R2 menu pick → binds + pins');
  r = projects.resolveRunProject(run, { chatId: CHAT, newProjectName: 'Гамма' });
  ok(r.pin === true && projects.getProject(run, r.projectId), 'R3 «➕ Новый проект» → creates + pins');
  r = projects.resolveRunProject(run, { chatId: CHAT, continuing: true, continuingProjectId: ra.id });
  ok(r.projectId === ra.id && r.pin === false, 'R4 continuing session keeps its project, never pins');
  projects.setActiveProjectId(run, rb.id, CHAT, { pinned: true });
  r = projects.resolveRunProject(run, { chatId: CHAT });
  ok(r.projectId === rb.id && r.pin === false, 'R5 plain new message with a pin → pinned project');
  const solo = tmp('chat-pin-solo-'); roots.push(solo);
  const so = projects.createProject(solo, 'Соло');
  r = projects.resolveRunProject(solo, { chatId: CHAT, projectId: so.id });
  ok(r.pin === false, 'R6 single project routed by the gateway is NOT a pin (path-independent)');
  r = projects.resolveRunProject(solo, { chatId: CHAT });
  ok(r.projectId === so.id && r.pin === false, 'R6 single project via plain path → same outcome');

  // ── P*: /project switch / new via the intent engine ─────────────────────────
  const { getQuickAnswer } = require('../src/runner/intent-engine');
  const pr = tmp('chat-pin-cmd-'); roots.push(pr);
  const pa = projects.createProject(pr, 'Первый');
  projects.createProject(pr, 'Второй');
  const ans = getQuickAnswer('/project Второй', 'u', pr, false, CHAT);
  ok(/Проект чата/.test(String(ans)) && projects.getProject(pr, projects.getPinnedProjectId(pr, CHAT)).name === 'Второй', `P1 /project <name> pins (${ans})`);
  const ans2 = getQuickAnswer('/project new recruiting: Третий', 'u', pr, false, CHAT);
  const pinned3 = projects.getProject(pr, projects.getPinnedProjectId(pr, CHAT));
  ok(pinned3 && pinned3.name === 'Третий', `P2 /project new pins the new project (${ans2})`);

  // ── B*: /bug_or_feature does not steal the pin ──────────────────────────────
  projects.setActiveProjectId(pr, pa.id, CHAT, { pinned: true });
  getQuickAnswer('/bug_or_feature', 'u', pr, false, CHAT);
  ok(projects.getPinnedProjectId(pr, CHAT) === pa.id, 'B1 /bug_or_feature keeps the chat pin');
  ok(projects.resolveRunProject(pr, { chatId: CHAT }).projectId === pa.id, 'B1 next new session still goes to the pinned project');

  // ── M*: reorg merge moves the pin, revert restores ──────────────────────────
  const reproject = require('../src/reproject');
  const mr = tmp('chat-pin-merge-'); roots.push(mr);
  const ma = projects.createProject(mr, 'Старый');
  const mb = projects.createProject(mr, 'Новый');
  projects.createProject(mr, 'Третий');
  const s1 = sessions.createSession(mr, { task: 'сессия старого проекта', chatId: CHAT, projectId: ma.id });
  const s2 = sessions.createSession(mr, { task: 'сессия нового', chatId: CHAT, projectId: mb.id });
  projects.setActiveProjectId(mr, ma.id, CHAT, { pinned: true });
  const plan = { projects: [{ existingProjectId: mb.id, name: 'Новый', type: 'generic', sessionIds: [s1, s2] }] };
  const res = reproject.applyPlan(mr, plan, { dryRun: false });
  ok(res.actions.some(x => x.kind === 'repoint-pin'), `M1 apply reports repoint-pin (${JSON.stringify(res.actions.map(x => x.kind))})`);
  ok(projects.getPinnedProjectId(mr, CHAT) === mb.id, 'M1 pin follows the merged project');
  const rv = reproject.revertPlan(mr);
  ok(rv.pinsReverted === 1 && projects.getPinnedProjectId(mr, CHAT) === ma.id, `M2 revert restores the pin (${JSON.stringify(rv)})`);
} finally {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
}
console.log(`chat-pinned-project: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
