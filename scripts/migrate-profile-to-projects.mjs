#!/usr/bin/env node
// Generalized profile → typed-projects migration (issue #517 convergence).
//
// Promotes the two ad-hoc per-profile scripts (flexi-consult expo, mbk recruiting)
// into ONE reusable tool. Uses the REAL src/projects.js so ids/scaffold match prod.
//
// Safety contract (same as the ad-hoc scripts):
//   - ledger-first: every move is appended to <profile>/projects/.migration-ledger.jsonl
//     BEFORE it happens → reverse-replayable.
//   - mv-only, never deletes user data.
//   - CONSERVATIVE: only CLEAR artifacts are moved. Anything ambiguous stays at root and
//     is printed under "NEEDS MANUAL DECISION" — that is the «руками пофиксить» surface.
//   - dry-run by default; --apply to execute.
//
// Usage:
//   node scripts/migrate-profile-to-projects.mjs <profile>          # dry-run one profile
//   node scripts/migrate-profile-to-projects.mjs <profile> --apply
//   node scripts/migrate-profile-to-projects.mjs --all              # dry-run every profile
//   node scripts/migrate-profile-to-projects.mjs --all --apply

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const projects = require(path.join(process.cwd(), 'src/projects.js'));

const USERS_ROOT = process.env.USERS_DIR || path.join(process.env.HOME || '/home/vova', 'users');
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const argProfile = process.argv.slice(2).find(a => !a.startsWith('--'));

// Infra/state that ALWAYS stays at the profile root (never a project artifact).
const ROOT_KEEP = new Set([
  'sessions', 'sessions.json', 'contexts', 'skills', 'uploads', 'projects',
  'requirements-log.md', 'agent-notes.md', 'persona.md', 'usage.json',
  'playwright-storage-state.json', 'claude-in-chrome', 'chrome', 'files',
  'CLAUDE.md', 'ROLE.md',
]);

// Given a profile's root entries, produce a move plan + a manual-decision list.
function planProfile(workDir) {
  let entries = [];
  try { entries = fs.readdirSync(workDir, { withFileTypes: true }); } catch { return null; }
  const names = entries.map(e => e.name).filter(n => !n.startsWith('.') && !ROOT_KEEP.has(n));

  const moves = [];  // {fromRel, toRel, note, projectInput}
  const manual = []; // {name, reason}
  const existing = projects.listProjects(workDir);
  const recruitingProjects = existing.filter(p => p.type === 'recruiting');

  for (const name of names) {
    const full = path.join(workDir, name);
    const isDir = fs.statSync(full).isDirectory();

    // ── expo-pipeline/<slug> — per-exhibition data → one expo project per slug ──
    if (name === 'expo-pipeline' && isDir) {
      let slugs = [];
      try { slugs = fs.readdirSync(full, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
      // Per the expo notes, criteria.json/site-config.json at expo-pipeline/ root are
      // SHARED config and stay. Only per-exhibition subdirs move.
      if (slugs.length === 0) { manual.push({ name, reason: 'expo-pipeline has no per-exhibition subdir (shared config?) — left at root' }); continue; }
      for (const slug of slugs) {
        moves.push({
          projectInput: `expo: ${slug}`,
          fromRel: `expo-pipeline/${slug}`,
          toSub: 'data',
          note: 'per-exhibition pipeline data',
        });
      }
      continue;
    }

    // ── recruiting artifacts → the profile's single recruiting project ──────────
    if (['vacancy-drafts', 'transcripts', 'interviews', 'applylink'].includes(name)) {
      if (recruitingProjects.length === 1) {
        const sub = name === 'interviews' ? 'interviews'
          : name === 'transcripts' ? 'interviews/transcripts'
          : name === 'applylink' ? 'applylink'
          : name; // vacancy-drafts → keep name
        moves.push({ projectId: recruitingProjects[0].id, fromRel: name, toSub: sub, note: 'recruiting artifact' });
      } else if (recruitingProjects.length === 0) {
        manual.push({ name, reason: 'recruiting artifact but profile has NO recruiting project — create one (need vacancy name) then move' });
      } else {
        manual.push({ name, reason: `recruiting artifact but ${recruitingProjects.length} recruiting projects exist — ambiguous which one` });
      }
      continue;
    }

    // Anything else at root → manual decision (don't guess).
    manual.push({ name, reason: 'unrecognized root artifact — decide manually' });
  }
  return { moves, manual, existing };
}

function ledgerAppend(workDir, rec) {
  const lp = path.join(workDir, 'projects', '.migration-ledger.jsonl');
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  fs.appendFileSync(lp, JSON.stringify(rec) + '\n');
}

function migrateProfile(profile) {
  const workDir = path.join(USERS_ROOT, profile);
  const plan = planProfile(workDir);
  if (!plan) { console.log(`  (skip ${profile}: not readable)`); return; }
  const { moves, manual, existing } = plan;

  console.log(`\n=== ${profile} ===  (existing projects: ${existing.map(p => p.id).join(', ') || 'none'})`);
  if (!moves.length && !manual.length) { console.log('  clean — nothing to migrate.'); return; }

  for (const m of moves) {
    const target = m.projectId || `«${m.projectInput}»`;
    console.log(`  MOVE  ${m.fromRel}  ->  [${target}]/${m.toSub}/   [${m.note}]`);
  }
  for (const x of manual) console.log(`  MANUAL  ${x.name}  — ${x.reason}`);

  if (!APPLY) return;

  ledgerAppend(workDir, { event: 'migration-start', at: new Date().toISOString(), profile, moves: moves.length });
  for (const m of moves) {
    const from = path.join(workDir, m.fromRel);
    if (!fs.existsSync(from)) { console.log(`  skip (missing): ${m.fromRel}`); continue; }
    const pid = m.projectId || projects.createProject(workDir, m.projectInput).id;
    const toDir = path.join(projects.projectDir(workDir, pid), m.toSub);
    fs.mkdirSync(toDir, { recursive: true });
    const to = path.join(toDir, path.basename(m.fromRel));
    ledgerAppend(workDir, { event: 'move', at: new Date().toISOString(), from: m.fromRel, to: path.relative(workDir, to), projectId: pid, note: m.note });
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
    console.log(`  moved: ${m.fromRel} -> ${path.relative(workDir, to)}`);
  }
  ledgerAppend(workDir, { event: 'migration-done', at: new Date().toISOString(), profile });
}

const targets = ALL
  ? fs.readdirSync(USERS_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  : (argProfile ? [argProfile] : []);

if (!targets.length) {
  console.error('Usage: node scripts/migrate-profile-to-projects.mjs <profile>|--all [--apply]');
  process.exit(1);
}

console.log(`Profile → projects migration  ${APPLY ? 'APPLY' : 'DRY-RUN'}  (root: ${USERS_ROOT})`);
for (const p of targets) migrateProfile(p);
if (!APPLY) console.log('\n(dry-run) nothing moved. Re-run with --apply for a specific profile after reviewing.');
