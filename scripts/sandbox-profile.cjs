#!/usr/bin/env node
'use strict';
// Disposable sandbox profile for exercising project restructuring (reproject apply/
// revert, migrate-profile-to-projects) WITHOUT touching a live user (issue #1311).
//
// Builds users/<name>/ under an ISOLATED temp USERS_DIR with the shape real profiles
// have: several typed projects, same-name artifacts in two projects (criteria.md
// collision), nested + empty folders, flat legacy artifacts at the profile root,
// sessions bound to projects, a gtd record pointing into a project folder.
//
// Usage (standalone, for a manual/live smoke):
//   node scripts/sandbox-profile.cjs            # prints {usersDir, profileRoot, projects}
// Library:
//   const { buildSandboxProfile, manifest } = require('./scripts/sandbox-profile.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projects = require('../src/projects');

// Bookkeeping files that restructuring legitimately rewrites — excluded from the
// "no user file lost" manifest. Everything else is user data and must survive.
const BOOKKEEPING = [
  /^sessions\.json$/, /^sessions\//, /^gtd\//,
  /^projects\/\.reproject-/, /^projects\/\.migration-ledger/, /^projects\/active-/,
  /(^|\/)project\.json$/, /\.tmp$/,
];

function write(fp, content) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

function buildSandboxProfile({ usersDir, name = `sandbox-${Date.now()}`, now = 1_000 } = {}) {
  usersDir = usersDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ta-sandbox-users-'));
  const root = path.join(usersDir, name);
  fs.mkdirSync(root, { recursive: true });

  const recA = projects.createProject(root, 'recruiting: Вакансия А', { now });
  const recB = projects.createProject(root, 'recruiting: Вакансия Б', { now: now + 1 });
  const expo = projects.createProject(root, 'expo: Выставка 2026', { now: now + 2 });
  const gen = projects.createProject(root, 'Основной', { now: now + 3 });
  const dir = id => projects.projectDir(root, id);

  // Same-name artifacts in two recruiting projects → guaranteed merge conflict.
  write(path.join(dir(recA.id), 'criteria.md'), 'criteria A — senior backend');
  write(path.join(dir(recB.id), 'criteria.md'), 'criteria B — junior QA');
  write(path.join(dir(recA.id), 'interviews', 'transcripts', 'ivanov.txt'), 'transcript ivanov');
  write(path.join(dir(recA.id), 'interviews', 'analysis', 'ivanov.md'), 'analysis ivanov');
  write(path.join(dir(recA.id), 'applylink', 'vacancy.json'), '{"id":"v-a"}');
  write(path.join(dir(recB.id), 'interviews', 'transcripts', 'petrov.txt'), 'transcript petrov');
  write(path.join(dir(expo.id), 'data', 'companies.json'), '[{"n":"ООО Ткань"}]');
  write(path.join(dir(expo.id), 'site', 'index.html'), '<html>expo</html>');
  write(path.join(dir(expo.id), 'deep', 'a', 'b', 'c', 'nested.txt'), 'deeply nested');
  fs.mkdirSync(path.join(dir(expo.id), 'empty-folder'), { recursive: true });
  write(path.join(dir(gen.id), 'notes-2026-09-24.md'), 'generic notes');

  // Flat legacy artifacts at the profile root (what migrate-profile-to-projects sees).
  write(path.join(root, 'interviews', 'transcripts', 'legacy-sidorov.txt'), 'legacy transcript');
  write(path.join(root, 'report-2026-09-01.md'), 'legacy report');
  write(path.join(root, 'agent-notes.md'), '- note');
  write(path.join(root, 'projects', '_archive', 'old-thing', 'kept.txt'), 'archived but kept');

  const sessions = [
    { id: 's-a1', topic: 'Разбор Иванова', projectId: recA.id, lastAt: now + 10 },
    { id: 's-a2', topic: 'Критерии А', projectId: recA.id, lastAt: now + 11 },
    { id: 's-b1', topic: 'Петров QA', projectId: recB.id, lastAt: now + 12 },
    { id: 's-e1', topic: 'Выставка сайт', projectId: expo.id, lastAt: now + 13 },
    { id: 's-g1', topic: 'Разное', projectId: gen.id, lastAt: now + 14 },
    { id: 's-legacy', topic: 'Старая сессия без проекта', lastAt: now + 5 },
  ];
  write(path.join(root, 'sessions.json'), JSON.stringify(sessions, null, 2));
  for (const s of sessions) write(path.join(root, 'sessions', `${s.id}.json`), JSON.stringify({ ...s, messages: [] }));

  write(path.join(root, 'gtd', 's-a1.json'), JSON.stringify({ sessionId: 's-a1', projectDir: dir(recA.id) }));

  return { usersDir, name, root, projects: { recA, recB, expo, gen } };
}

// path → sha256 of every user file under root (bookkeeping excluded).
function manifest(root) {
  const out = new Map();
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (BOOKKEEPING.some(re => re.test(rel))) continue;
      out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  })(root);
  return out;
}

// Content hashes that existed before but are gone after — i.e. LOST user data.
function lostFiles(before, after) {
  const have = new Map();
  for (const sha of after.values()) have.set(sha, (have.get(sha) || 0) + 1);
  const lost = [];
  for (const [rel, sha] of before) {
    if (have.get(sha)) have.set(sha, have.get(sha) - 1);
    else lost.push(rel);
  }
  return lost;
}

module.exports = { buildSandboxProfile, manifest, lostFiles };

if (require.main === module) {
  const sb = buildSandboxProfile({ usersDir: process.env.SANDBOX_USERS_DIR });
  console.log(JSON.stringify({
    usersDir: sb.usersDir, profileRoot: sb.root,
    projects: Object.fromEntries(Object.entries(sb.projects).map(([k, p]) => [k, projects.projectDir(sb.root, p.id)])),
  }, null, 2));
}
