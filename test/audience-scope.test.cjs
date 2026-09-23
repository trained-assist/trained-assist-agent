// Contract test for audience-scoped session/project resolution (AUDIENCE-SCOPE-SPEC).
//
// Bug: two Telegram bots (general-purpose + recruiter) share the same backend, same
// USERS KV (username), and — for a private chat — the same chatId (Telegram user id is
// identical regardless of which bot is messaged). Every session/project lookup keyed
// only by workDir+chatId therefore mixed the two bots' data: the recruiter bot could
// answer with the general bot's active session, and vice versa.
//
// Fix: an `audience` string (default 'default') scopes session/project creation,
// listing, and current-pointer resolution. Every session/project on disk before this
// feature existed has no `audience` field and must keep resolving under the implicit
// 'default' — zero migration, zero behavior change for the existing (general) bot.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const sessions = require('../src/session-store');
const projects = require('../src/projects');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audience-scope-test-'));
}

// ── session-store: listSessions scoping ─────────────────────────────────────────
{
  const wd = tmpDir();
  const CHAT = 4242;
  const generalId = sessions.createSession(wd, { task: 'general bot task', id: 's-gen-1', chatId: CHAT, audience: 'default' });
  const recruiterId = sessions.createSession(wd, { task: 'recruiter bot task', id: 's-rec-1', chatId: CHAT, audience: 'recruiter' });

  const generalList = sessions.listSessions(wd, 10, 'default');
  ok(generalList.some(s => s.id === generalId), 'default audience sees its own session');
  ok(!generalList.some(s => s.id === recruiterId), 'default audience does NOT see the recruiter session (the reported bug)');

  const recruiterList = sessions.listSessions(wd, 10, 'recruiter');
  ok(recruiterList.some(s => s.id === recruiterId), 'recruiter audience sees its own session');
  ok(!recruiterList.some(s => s.id === generalId), 'recruiter audience does NOT see the default/general session');

  // Omitting audience in listSessions must default to 'default' (safe for HTTP paths).
  const omitted = sessions.listSessions(wd, 10);
  ok(!omitted.some(s => s.id === recruiterId), 'listSessions() with no audience arg still excludes the recruiter session');
}

// ── session-store: current-session pointer independence per chatId ─────────────
{
  const wd = tmpDir();
  const CHAT = 777;
  const generalId = sessions.createSession(wd, { task: 'general', id: 's-gen-2', chatId: CHAT, audience: 'default' });
  const recruiterId = sessions.createSession(wd, { task: 'recruiter', id: 's-rec-2', chatId: CHAT, audience: 'recruiter' });

  ok(sessions.getCurrentSessionId(wd, CHAT, 'default') === generalId, 'default pointer resolves to the general session');
  ok(sessions.getCurrentSessionId(wd, CHAT, 'recruiter') === recruiterId, 'recruiter pointer resolves to the recruiter session, independently of the same chatId');

  // resolveChatSession's pointer-fallback branch must also stay audience-scoped.
  ok(sessions.resolveChatSession(wd, 's-unknown', CHAT, 'default') === generalId, 'resolveChatSession falls back to the default-audience pointer');
  ok(sessions.resolveChatSession(wd, 's-unknown', CHAT, 'recruiter') === recruiterId, 'resolveChatSession falls back to the recruiter-audience pointer');
}

// ── session-store: legacy records (no audience field) resolve as 'default' ─────
{
  const wd = tmpDir();
  const CHAT = 999;
  const legacyId = sessions.createSession(wd, { task: 'pre-audience session', chatId: CHAT });
  // Strip the audience field to simulate a record written before this feature existed.
  const sessFile = path.join(wd, 'sessions', `${legacyId}.json`);
  const full = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  delete full.audience;
  fs.writeFileSync(sessFile, JSON.stringify(full, null, 2));
  const idxFile = path.join(wd, 'sessions.json');
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  delete idx.find(s => s.id === legacyId).audience;
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));

  ok(sessions.listSessions(wd, 10, 'default').some(s => s.id === legacyId), 'legacy session (no audience field) shows up under "default"');
  ok(!sessions.listSessions(wd, 10, 'recruiter').some(s => s.id === legacyId), 'legacy session does NOT leak into a non-default audience');
  // The pre-existing pointer file (current-session-<chatId>.json, no audience suffix)
  // must still resolve — this is the byte-for-byte backward-compat guarantee.
  ok(sessions.getCurrentSessionId(wd, CHAT, 'default') === legacyId, 'legacy current-session pointer (unsuffixed filename) still resolves under default audience');
  ok(sessions.getCurrentSessionId(wd, CHAT) === legacyId, 'getCurrentSessionId with audience omitted matches default-audience behavior (no filename change)');
}

// ── projects.js: listProjects / decideNewSessionProject scoping ────────────────
{
  const wd = tmpDir();
  const CHAT = 'chat-a';
  const generalProj = projects.createProject(wd, { type: 'generic', name: 'Основной' }, { audience: 'default' });
  const recruiterProj = projects.createProject(wd, { type: 'recruiting', name: 'Менеджер продаж' }, { audience: 'recruiter' });

  const generalList = projects.listProjects(wd, 'default');
  ok(generalList.some(p => p.id === generalProj.id), 'default audience sees its own project');
  ok(!generalList.some(p => p.id === recruiterProj.id), 'default audience does NOT see the recruiter project');

  const recruiterList = projects.listProjects(wd, 'recruiter');
  ok(recruiterList.some(p => p.id === recruiterProj.id), 'recruiter audience sees its own project');
  ok(!recruiterList.some(p => p.id === generalProj.id), 'recruiter audience does NOT see the default project');

  // A single project per audience -> decideNewSessionProject auto-binds within that scope only.
  const decision = projects.decideNewSessionProject(wd, CHAT, undefined, 'recruiter');
  ok(decision.action === 'auto' && decision.project.id === recruiterProj.id, 'decideNewSessionProject scopes to the given audience');
}

// ── projects.js: legacy projects (no audience field) resolve as 'default' ──────
{
  const wd = tmpDir();
  const legacy = projects.createProject(wd, { type: 'generic', name: 'Старый проект' });
  const metaFile = path.join(wd, 'projects', legacy.id, 'project.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  delete meta.audience;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

  ok(projects.listProjects(wd, 'default').some(p => p.id === legacy.id), 'legacy project (no audience field) shows up under "default"');
  ok(!projects.listProjects(wd, 'recruiter').some(p => p.id === legacy.id), 'legacy project does NOT leak into a non-default audience');
  ok(projects.listProjects(wd).some(p => p.id === legacy.id), 'listProjects() with no audience arg matches default-audience behavior');
}

console.log(`\naudience-scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
