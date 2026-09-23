// Regression test: after a projects reorg (reproject.js restructuring, or any out-of-band
// move) archives/renames a project's folder, a session still bound to the old id must not
// silently keep running in a stale cwd with no explanation (owner voice report 2026-09-23 —
// "какой-то каталог не обновился... сессию даже нельзя продолжить"). The fix is two pure
// helpers the runner's project-binding block uses to detect + self-heal the stale binding:
//   projects.resolveProjectDir  — null (not a guess) once the folder is gone
//   sessions.setSessionProject  — clears the stale pointer so the next message re-resolves
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const projects = require('../src/projects');
const sessions = require('../src/session-store');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-binding-selfheal-test-'));

// resolveProjectDir: live project -> its dir.
const p = projects.createProject(workDir, 'Проект A');
ok(projects.resolveProjectDir(workDir, p.id) === projects.projectDir(workDir, p.id), 'resolveProjectDir returns the dir for a live project');

// resolveProjectDir: folder archived out from under a still-referenced id -> null, not a
// guessed/wrong path.
projects.archiveProject(workDir, p.id);
ok(projects.resolveProjectDir(workDir, p.id) === null, 'resolveProjectDir returns null once the project folder is archived');
ok(projects.resolveProjectDir(workDir, 'no-such-id') === null, 'resolveProjectDir returns null for an unknown id');
ok(projects.resolveProjectDir(workDir, null) === null, 'resolveProjectDir returns null for a null id');

// setSessionProject: clears (or rebinds) both the index entry and the per-session file.
const sid = sessions.createSession(workDir, { task: 'тестовая сессия', chatId: 'c1', projectId: p.id });
ok(sessions.getSession(workDir, sid).projectId === p.id, 'session created bound to the (now-archived) project');
sessions.setSessionProject(workDir, sid, null);
ok(sessions.getSession(workDir, sid).projectId === null, 'setSessionProject(null) clears the per-session file');
ok(sessions.listSessions(workDir, 50).find(s => s.id === sid).projectId === null, 'setSessionProject(null) clears the index entry too');

const p2 = projects.createProject(workDir, 'Проект B');
sessions.setSessionProject(workDir, sid, p2.id);
ok(sessions.getSession(workDir, sid).projectId === p2.id, 'setSessionProject can also rebind to a live project');

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`\nproject-binding-selfheal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
