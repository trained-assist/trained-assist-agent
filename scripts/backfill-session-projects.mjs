#!/usr/bin/env node
// Session → project backfill (issue #517 convergence, sibling of migrate-profile-to-projects.mjs).
//
// The artifact migration moves interviews/ / expo-pipeline/ into project folders, but it does
// NOT touch the SESSIONS themselves — legacy sessions keep projectId=null and therefore never
// group under a vacancy/exhibition in the picker. This tool closes that gap: it stamps
// projectId onto existing sessions, in BOTH the index (sessions.json) and the full session file.
//
// Safety contract (same spirit as the artifact migrator):
//   - Assignment is EXPLICIT, never guessed on apply. You feed a {sessionId: projectId} map
//     (--map=file.json) or accept the printed heuristic via --auto (only high-confidence rows).
//   - ledger-first: every change is appended to <profile>/projects/.session-backfill-ledger.jsonl
//     with the OLD value BEFORE it is overwritten → reverse-replayable.
//   - Never deletes a session; only sets the projectId field. Unknown projectId → refused.
//   - dry-run by default; --apply to execute.
//
// Usage:
//   node scripts/backfill-session-projects.mjs <profile>                     # dry-run: heuristic suggestion per session
//   node scripts/backfill-session-projects.mjs <profile> --map=map.json --apply
//   node scripts/backfill-session-projects.mjs <profile> --auto --apply      # apply only confident heuristic rows
//
// map.json shape: { "<sessionId>": "<projectId>", ... }   (projectId "" / null = leave unassigned)

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const projects = require(path.join(process.cwd(), 'src/projects.js'));

const USERS_ROOT = process.env.USERS_DIR || path.join(process.env.HOME || '/home/vova', 'users');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const AUTO = argv.includes('--auto');
const mapArg = argv.find(a => a.startsWith('--map='));
const profile = argv.find(a => !a.startsWith('--'));

if (!profile) {
  console.error('Usage: node scripts/backfill-session-projects.mjs <profile> [--map=file.json] [--auto] [--apply]');
  process.exit(1);
}

const workDir = path.join(USERS_ROOT, profile);
const sessionsIndexPath = path.join(workDir, 'sessions.json');
const sessionsDir = path.join(workDir, 'sessions');

// ── Normalise text for matching ──────────────────────────────────────────────
function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}
function tokens(s) {
  return norm(s).match(/[a-zа-я0-9]{3,}/g) || [];
}

// Heuristic: score a session's text against each project's name.
// Confident only when exactly one project scores > 0 AND clearly beats the rest,
// or when the profile has a single project (then everything defaults to it).
function suggest(sessionText, projList) {
  if (projList.length === 0) return { projectId: null, confident: false, why: 'no projects' };
  if (projList.length === 1) return { projectId: projList[0].id, confident: true, why: 'sole project' };

  const stTok = new Set(tokens(sessionText));
  const scored = projList.map(p => {
    const pTok = tokens(p.name);
    let hits = 0;
    for (const t of pTok) if (stTok.has(t)) hits++;
    return { id: p.id, name: p.name, hits };
  }).sort((a, b) => b.hits - a.hits);

  const top = scored[0], second = scored[1];
  if (top.hits >= 2 && top.hits > (second?.hits || 0)) {
    return { projectId: top.id, confident: true, why: `name match (${top.hits} tokens)` };
  }
  if (top.hits === 1 && (second?.hits || 0) === 0) {
    return { projectId: top.id, confident: false, why: 'weak name match (1 token)' };
  }
  return { projectId: null, confident: false, why: 'ambiguous — decide manually' };
}

// ── Load state ────────────────────────────────────────────────────────────────
let index;
try { index = JSON.parse(fs.readFileSync(sessionsIndexPath, 'utf8')); }
catch (e) { console.error(`cannot read ${sessionsIndexPath}: ${e.message}`); process.exit(1); }

const projList = projects.listProjects(workDir);
const projIds = new Set(projList.map(p => p.id));

let explicitMap = null;
if (mapArg) {
  const mp = mapArg.slice('--map='.length);
  explicitMap = JSON.parse(fs.readFileSync(mp, 'utf8'));
  for (const pid of Object.values(explicitMap)) {
    if (pid && !projIds.has(pid)) { console.error(`map references unknown projectId: ${pid}`); process.exit(1); }
  }
}

function ledgerAppend(rec) {
  const lp = path.join(workDir, 'projects', '.session-backfill-ledger.jsonl');
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  fs.appendFileSync(lp, JSON.stringify(rec) + '\n');
}

function readFullText(id) {
  try {
    const full = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8'));
    const msgs = (full.messages || []).slice(0, 4).map(m => m.content).join(' ');
    return `${full.topic || ''} ${msgs}`;
  } catch { return ''; }
}

console.log(`Session backfill  ${APPLY ? 'APPLY' : 'DRY-RUN'}  profile=${profile}`);
console.log(`projects: ${projList.map(p => p.id).join(', ') || '(none)'}\n`);

const plan = []; // {id, from, to, why}
for (const meta of index) {
  const current = meta.projectId || null;
  let target = current;
  let why = '';

  if (explicitMap && Object.prototype.hasOwnProperty.call(explicitMap, meta.id)) {
    target = explicitMap[meta.id] || null;
    why = 'explicit map';
  } else {
    const text = `${meta.topic || ''} ${readFullText(meta.id)}`;
    const s = suggest(text, projList);
    why = s.why;
    if (AUTO && s.confident) target = s.projectId;
    else if (!APPLY) target = s.projectId; // dry-run shows suggestion regardless of confidence
  }

  const mark = target === current ? ' ' : (target ? '→' : '×');
  console.log(`${mark} ${(meta.id).padEnd(38)} ${(current || '∅').slice(0, 20).padEnd(20)} => ${(target || '∅').slice(0, 40).padEnd(40)} [${why}]`);
  console.log(`    ${(meta.topic || '').slice(0, 80)}`);

  if (target !== current) plan.push({ id: meta.id, from: current, to: target, why });
}

console.log(`\n${plan.length} change(s)${APPLY ? '' : ' (dry-run — nothing written)'}`);
if (!APPLY || plan.length === 0) {
  if (!APPLY) console.log('Re-run with --apply (+ --map=file.json or --auto) to write.');
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
ledgerAppend({ event: 'backfill-start', at: new Date().toISOString(), profile, changes: plan.length });
const changeById = new Map(plan.map(p => [p.id, p]));

for (const meta of index) {
  const ch = changeById.get(meta.id);
  if (!ch) continue;
  // full file
  const fp = path.join(sessionsDir, `${meta.id}.json`);
  try {
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    ledgerAppend({ event: 'set-projectId', at: new Date().toISOString(), id: meta.id, from: ch.from, to: ch.to, why: ch.why });
    full.projectId = ch.to || null;
    const tmp = `${fp}.tmp`; fs.writeFileSync(tmp, JSON.stringify(full, null, 2)); fs.renameSync(tmp, fp);
  } catch (e) {
    console.warn(`  warn: full file for ${meta.id}: ${e.message}`);
  }
  meta.projectId = ch.to || null;
}
const tmpIdx = `${sessionsIndexPath}.tmp`;
fs.writeFileSync(tmpIdx, JSON.stringify(index, null, 2));
fs.renameSync(tmpIdx, sessionsIndexPath);
ledgerAppend({ event: 'backfill-done', at: new Date().toISOString(), profile });
console.log(`Applied ${plan.length} change(s). Ledger: projects/.session-backfill-ledger.jsonl`);
