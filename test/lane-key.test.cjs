'use strict';

// S8 — concurrency lane granularity (docs/CONCURRENCY-LANE-GRANULARITY.md).
//
// The bug (R6): the serialization lane was keyed by chatId, so a web entry (id:0)
// and a chat entry hitting the SAME project workDir got DIFFERENT lane keys and
// ran two `claude` on identical files at once → corruption. And keying by profile
// would over-serialize different projects → violate the owner constraint
// («несколько параллельных сессий на профиле — нужно»).
//
// Contract encoded here (lane key = the workDir the task will run in):
//   S8.1 same profile + same project, reached via web AND chat → SAME key (serialize)
//   S8.2 same profile + different projects                     → DISTINCT keys (parallel)
//   S8.3 different profiles                                     → DISTINCT keys (isolated)
//   +    project-less profile root, session-bound project, new-project all resolve sanely.

const os = require('os'), fs = require('fs'), path = require('path');
const projects = require('../src/projects.js');
const sessions = require('../src/session-store.js');
const { resolveLaneKey } = require('../src/lane-key.js');

let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.log('FAIL:', m)); }
const deps = { projects, sessions };

(async () => {
  const profA = fs.mkdtempSync(path.join(os.tmpdir(), 'laneA-'));
  const profB = fs.mkdtempSync(path.join(os.tmpdir(), 'laneB-'));

  // Two projects in profile A.
  const p1 = projects.createProject(profA, { type: 'generic', name: 'Alpha' }).id;
  const p2 = projects.createProject(profA, { type: 'generic', name: 'Beta' }).id;
  // One project in profile B that happens to share the same id string is still a
  // different workDir because the profile root differs.
  const pB = projects.createProject(profB, { type: 'generic', name: 'Alpha' }).id;

  // ── S8.1: same project via web (id:0) and via chat → SAME lane key ──────────
  const webUser  = { id: '0',      workDir: profA };
  const chatUser = { id: '774411', workDir: profA };
  const kWeb  = resolveLaneKey(webUser,  { projectId: p1 }, deps);
  const kChat = resolveLaneKey(chatUser, { projectId: p1 }, deps);
  ok(kWeb === kChat, `S8.1 web & chat on same project must share a lane (${kWeb} vs ${kChat})`);
  ok(kWeb === path.resolve(projects.projectDir(profA, p1)), 'S8.1 key is the project cwd');

  // ── S8.2: different projects, same profile → DISTINCT keys (run parallel) ───
  const kP1 = resolveLaneKey(chatUser, { projectId: p1 }, deps);
  const kP2 = resolveLaneKey(chatUser, { projectId: p2 }, deps);
  ok(kP1 !== kP2, 'S8.2 different projects of one profile must NOT share a lane');

  // ── S8.3: different profiles → DISTINCT keys ────────────────────────────────
  const kA = resolveLaneKey({ id: '1', workDir: profA }, { projectId: p1 }, deps);
  const kB = resolveLaneKey({ id: '1', workDir: profB }, { projectId: pB }, deps);
  ok(kA !== kB, 'S8.3 same project id in different profiles must NOT share a lane');

  // ── project-less profile root ──────────────────────────────────────────────
  const emptyProf = fs.mkdtempSync(path.join(os.tmpdir(), 'laneE-'));
  const kRoot = resolveLaneKey({ id: '5', workDir: emptyProf }, {}, deps);
  ok(kRoot === path.resolve(emptyProf), 'project-less task keys by profile root');

  // ── session-bound project wins, even if a different active project is set ────
  projects.setActiveProjectId(profA, p2, chatUser.id); // active = Beta
  const sid = sessions.createSession(profA, { task: 't', chatId: chatUser.id, projectId: p1 });
  const kSess = resolveLaneKey(chatUser, { sessionId: sid }, deps);
  ok(kSess === path.resolve(projects.projectDir(profA, p1)),
     'continuing session keys by ITS project, not the chat-active one');

  // ── new-project name gets its own lane (not the profile root) ───────────────
  const kNew = resolveLaneKey(chatUser, { newProjectName: 'Gamma' }, deps);
  ok(kNew !== path.resolve(profA) && kNew.includes('gamma'),
     'new-project task does not serialize behind the profile root');

  // ── explicit unknown projectId falls back to active, not a crash ────────────
  const kBad = resolveLaneKey(chatUser, { projectId: 'nonexistent-xyz' }, deps);
  ok(typeof kBad === 'string' && kBad.length > 0, 'unknown projectId resolves without throwing');

  console.log(`\nlane-key: ${pass} passed, ${fail} failed`);
  // cleanup
  for (const d of [profA, profB, emptyProf]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
