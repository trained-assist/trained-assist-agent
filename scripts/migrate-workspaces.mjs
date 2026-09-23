#!/usr/bin/env node
// migrate-workspaces.mjs — one-time, reversible migration of the legacy
// per-profile storage tree into the canonical workspace root.
//
// Background (storage-paths-auth-refactor-spec):
//   Before the USERS_DIR split, every profile's files lived under
//   AGENT_DATA_DIR/sessions/<profile>/. The session store later moved to
//   USERS_DIR/<profile>/, but many consumers (artifacts, calltips, analyses,
//   inn-config, contexts/hh, sites, chat-history …) kept reading/writing the
//   old tree. That drift silently broke several endpoints. This script merges
//   the remaining legacy data into the workspace root so the legacy tree can
//   be retired.
//
//   LEGACY: AGENT_DATA_DIR/sessions/<profile>/**   (deprecated)
//   TARGET: USERS_DIR/<profile>/**                 (canonical)
//
// Guarantees:
//   • Nothing moves without an explicit --apply (default is --dry-run).
//   • Move/merge only — never overwrite. Colliding files are reported and left
//     untouched (the target wins; the legacy copy is preserved).
//   • Every mutation is written to a JSONL ledger → --rollback restores it.
//   • Idempotent: re-running --apply after a successful run is a no-op.
//
// Usage:
//   node scripts/migrate-workspaces.mjs [--dry-run|--apply|--rollback]
//        [--legacy DIR] [--target DIR] [--ledger FILE] [--json] [--quiet]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OPS = { MOVE_DIR: 'move-dir', MOVE_FILE: 'move-file', DUP: 'dup', CONFLICT: 'conflict', REVERT: 'revert-complete' };

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return sha256(a) === sha256(b);
  } catch {
    return false;
  }
}

// Recursively list files (relative paths) under a directory.
function listFilesRel(root) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

// Build a pure plan (no disk mutation). `legacyRoot` and `targetRoot` are the
// two per-profile roots, e.g. <AGENT_DATA_DIR>/sessions and <USERS_DIR>.
export function buildPlan(legacyRoot, targetRoot) {
  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) {
    throw new Error('legacy and target roots must differ');
  }
  const plan = { legacyRoot, targetRoot, profiles: [], moves: [], dups: [], conflicts: [], empty: true };

  let profiles = [];
  try {
    profiles = fs.readdirSync(legacyRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return plan; // legacy root absent → nothing to do
  }
  if (profiles.length === 0) return plan;
  plan.empty = false;

  for (const profile of profiles.sort()) {
    const legacyProfile = path.join(legacyRoot, profile);
    const targetProfile = path.join(targetRoot, profile);
    plan.profiles.push(profile);

    if (!fs.existsSync(targetProfile)) {
      // Whole profile dir can move as one rename.
      plan.moves.push({ op: OPS.MOVE_DIR, profile, from: legacyProfile, to: targetProfile });
      continue;
    }

    // Target exists → merge file by file, never overwrite.
    for (const rel of listFilesRel(legacyProfile)) {
      const from = path.join(legacyProfile, rel);
      const to = path.join(targetProfile, rel);
      if (!fs.existsSync(to)) {
        plan.moves.push({ op: OPS.MOVE_FILE, profile, from, to });
      } else if (sameFile(from, to)) {
        plan.dups.push({ op: OPS.DUP, profile, from, to });
      } else {
        plan.conflicts.push({ op: OPS.CONFLICT, profile, from, to });
      }
    }
  }
  return plan;
}

function appendLedger(ledgerPath, records) {
  if (!ledgerPath || records.length === 0) return;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const lines = records.map(r => JSON.stringify({ ts: new Date().toISOString(), ...r })).join('\n') + '\n';
  fs.appendFileSync(ledgerPath, lines);
}

// Remove now-empty directories left behind under the legacy root (deepest first).
function pruneEmptyDirs(root) {
  if (!fs.existsSync(root)) return;
  const walk = (abs) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) walk(path.join(abs, e.name));
    try { if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs); } catch { /* not empty */ }
  };
  walk(root);
  try { if (fs.readdirSync(root).length === 0) fs.rmdirSync(root); } catch { /* keep if not empty */ }
}

// Apply a plan. Returns { applied, dupsRemoved, conflicts }. Records every
// mutation in the ledger so rollback() can undo it.
export function applyPlan(plan, { ledgerPath = null } = {}) {
  const records = [];
  let applied = 0;
  let dupsRemoved = 0;

  for (const m of plan.moves) {
    fs.mkdirSync(path.dirname(m.to), { recursive: true });
    fs.renameSync(m.from, m.to);
    records.push(m);
    applied++;
  }
  for (const d of plan.dups) {
    // Identical copy already at target — drop the legacy duplicate.
    fs.unlinkSync(d.from);
    records.push(d);
    dupsRemoved++;
  }

  appendLedger(ledgerPath, records);
  pruneEmptyDirs(plan.legacyRoot);

  return { applied, dupsRemoved, conflicts: plan.conflicts.length, records: records.length };
}

// Reverse every recorded mutation. move-dir/move-file move back; dup is
// restored by copying the surviving target file back (content is identical).
export function rollback({ ledgerPath }) {
  let lines = [];
  try {
    lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { reverted: 0, noop: true };
  }
  const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (records.length === 0 || records[records.length - 1].op === OPS.REVERT) {
    return { reverted: 0, noop: true };
  }

  let reverted = 0;
  for (const r of [...records].reverse()) {
    try {
      if (r.op === OPS.MOVE_FILE || r.op === OPS.MOVE_DIR) {
        if (fs.existsSync(r.to)) {
          fs.mkdirSync(path.dirname(r.from), { recursive: true });
          fs.renameSync(r.to, r.from);
          reverted++;
        }
      } else if (r.op === OPS.DUP) {
        if (fs.existsSync(r.to) && !fs.existsSync(r.from)) {
          fs.mkdirSync(path.dirname(r.from), { recursive: true });
          fs.copyFileSync(r.to, r.from);
          reverted++;
        }
      }
    } catch { /* best-effort; keep going */ }
  }
  appendLedger(ledgerPath, [{ op: OPS.REVERT }]);
  return { reverted, noop: false };
}

// Post-apply sanity: target profile dirs exist, and no movable files remain in
// legacy (only declared conflicts may stay).
export function validate(plan) {
  const problems = [];
  for (const profile of plan.profiles) {
    const targetProfile = path.join(plan.targetRoot, profile);
    if (!fs.existsSync(targetProfile)) {
      problems.push(`target missing for profile "${profile}": ${targetProfile}`);
    }
  }
  const remaining = buildPlan(plan.legacyRoot, plan.targetRoot);
  if (!remaining.empty) {
    problems.push(
      `legacy root still holds data after apply (${remaining.moves.length} movable, ` +
      `${remaining.conflicts.length} conflict) — re-run or resolve conflicts`
    );
  }
  return { ok: problems.length === 0, problems };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: 'dry-run', json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.mode = 'dry-run';
    else if (a === '--apply') opts.mode = 'apply';
    else if (a === '--rollback') opts.mode = 'rollback';
    else if (a === '--legacy') opts.legacy = argv[++i];
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--ledger') opts.ledger = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function defaults() {
  const { USERS_ROOT, SYSTEM_ROOT } = require(path.join(__dirname, '..', 'src', 'data-paths.js'));
  return {
    legacy: path.join(SYSTEM_ROOT, 'sessions'),
    target: USERS_ROOT,
    ledger: path.join(SYSTEM_ROOT, 'migrate-workspaces-ledger.jsonl'),
  };
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('Usage: node scripts/migrate-workspaces.mjs [--dry-run|--apply|--rollback] ' +
      '[--legacy DIR] [--target DIR] [--ledger FILE] [--json] [--quiet]');
    return 0;
  }
  const d = defaults();
  const legacyRoot = opts.legacy || d.legacy;
  const targetRoot = opts.target || d.target;
  const ledgerPath = opts.ledger || d.ledger;
  const log = (...m) => { if (!opts.quiet) console.log(...m); };

  if (opts.mode === 'rollback') {
    const res = rollback({ ledgerPath });
    if (opts.json) console.log(JSON.stringify({ mode: 'rollback', ...res }, null, 2));
    else log(res.noop ? 'Nothing to roll back.' : `Rolled back ${res.reverted} operation(s).`);
    return 0;
  }

  const plan = buildPlan(legacyRoot, targetRoot);
  if (opts.mode === 'dry-run') {
    const summary = {
      mode: 'dry-run', legacyRoot, targetRoot,
      profiles: plan.profiles, moveDirs: plan.moves.filter(m => m.op === OPS.MOVE_DIR).length,
      moveFiles: plan.moves.filter(m => m.op === OPS.MOVE_FILE).length,
      dups: plan.dups.length, conflicts: plan.conflicts,
    };
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else {
      if (plan.empty) { log(`Nothing to migrate (legacy root empty or absent: ${legacyRoot}).`); return 0; }
      log(`DRY RUN — legacy: ${legacyRoot}`);
      log(`          target: ${targetRoot}`);
      log(`  profiles: ${plan.profiles.length} (${plan.profiles.join(', ')})`);
      log(`  move dirs:  ${summary.moveDirs}`);
      log(`  move files: ${summary.moveFiles}`);
      log(`  duplicates to drop: ${summary.dups}`);
      log(`  conflicts (kept in place): ${summary.conflicts.length}`);
      for (const c of plan.conflicts) log(`    ! ${c.from}`);
      log('\nRun again with --apply to perform the migration.');
    }
    return 0;
  }

  // apply
  if (plan.empty) { log(`Nothing to migrate (legacy root empty or absent: ${legacyRoot}).`); return 0; }
  const res = applyPlan(plan, { ledgerPath });
  const val = validate(plan);
  const out = { mode: 'apply', legacyRoot, targetRoot, ledgerPath, ...res, validation: val };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else {
    log(`Applied: ${res.applied} move(s), ${res.dupsRemoved} duplicate(s) dropped, ${res.conflicts} conflict(s) left.`);
    log(`Ledger: ${ledgerPath}`);
    if (!val.ok) { log('Validation warnings:'); for (const p of val.problems) log(`  ! ${p}`); }
    else log('Validation: OK');
  }
  return val.ok ? 0 : 1;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`migrate-workspaces: ${e.message}`);
    process.exit(2);
  }
}
