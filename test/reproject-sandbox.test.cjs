'use strict';

// Sandbox restructuring invariants (issue #1311) — "reorg cut my folders" must not recur.
//
// Runs the REAL restructuring code (src/reproject.js apply/revert and
// scripts/migrate-profile-to-projects.mjs) on a disposable, realistic profile built by
// scripts/sandbox-profile.cjs in an isolated temp USERS_DIR. Never touches live users.
//
//   S1  two applies in a row, then two reverts → profile is byte-identical to the start
//       (the 2nd apply used to overwrite the ledger → 1st apply was unrevertable)
//   S2  no user file is ever lost at any step (content-hash multiset before ⊆ after)
//   S3  a same-name conflict is never clobbered; it stays and is named in warnings
//   S4  gtd projectDir repointed by apply is restored by revert
//   S5  revert with an empty stack is a clean error, not a crash
//   S6  legacy single-object ledger (pre-stack format) is still revertable
//   S7  migrate --apply into a project whose interviews/ already exists keeps BOTH the
//       project's own transcripts and the migrated root ones (used to rmSync the dest)
//   S8  migrate --apply twice is idempotent and still loses nothing

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const reproject = require('../src/reproject');
const projects = require('../src/projects');
const { buildSandboxProfile, manifest, lostFiles } = require('../scripts/sandbox-profile.cjs');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } }
const REPO = path.join(__dirname, '..');

function sameManifest(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function sessionProjects(root) {
  return Object.fromEntries(JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8')).map(s => [s.id, s.projectId || null]));
}
function planInto(pid, sessionIds) {
  return { totalSessions: sessionIds.length, projects: [{ cluster: 'x', name: 'x', type: 'generic', existingProjectId: pid, sessionIds, memberTopics: [] }], unassigned: [], warnings: [] };
}

const cleanup = [];

// ── S1–S5: reproject apply ×2 / revert ×2 ────────────────────────────────────
{
  const sb = buildSandboxProfile();
  cleanup.push(sb.usersDir);
  const { root } = sb;
  const { recA, recB, expo, gen } = sb.projects;
  const m0 = manifest(root);
  const sp0 = sessionProjects(root);
  const gtdFp = path.join(root, 'gtd', 's-a1.json');
  const gtd0 = fs.readFileSync(gtdFp, 'utf8');

  // apply #1: vacate recruiting A into recruiting B (criteria.md collides).
  const a1 = reproject.applyPlan(root, planInto(recB.id, ['s-a1', 's-a2', 's-b1']), { dryRun: false, now: 100 });
  ok(a1.moves === 2, `S1 apply#1 retagged 2 sessions (got ${a1.moves})`);
  ok(lostFiles(m0, manifest(root)).length === 0, `S2 nothing lost after apply#1: ${lostFiles(m0, manifest(root))}`);
  ok(fs.readFileSync(path.join(projects.projectDir(root, recB.id), 'criteria.md'), 'utf8') === 'criteria B — junior QA', 'S3 destination criteria.md not clobbered');
  ok(fs.readFileSync(path.join(projects.projectDir(root, recA.id), 'criteria.md'), 'utf8') === 'criteria A — senior backend', 'S3 conflicting source criteria.md left in place');
  ok((a1.warnings || []).some(w => w.includes(recA.id) && w.includes('не перенесены')), 'S3 conflict is named in warnings');
  ok(fs.existsSync(path.join(projects.projectDir(root, recB.id), 'interviews', 'transcripts', 'ivanov.txt')), 'S1 A transcripts merged into B');

  // apply #2: vacate expo into generic (nested + empty dirs).
  const a2 = reproject.applyPlan(root, planInto(gen.id, ['s-e1', 's-g1']), { dryRun: false, now: 200 });
  ok(a2.moves === 1, `S1 apply#2 retagged 1 session (got ${a2.moves})`);
  ok(fs.existsSync(path.join(projects.projectDir(root, gen.id), 'deep', 'a', 'b', 'c', 'nested.txt')), 'S1 nested expo file merged into generic');
  ok(lostFiles(m0, manifest(root)).length === 0, `S2 nothing lost after apply#2: ${lostFiles(m0, manifest(root))}`);
  ok(reproject.readLedgerStack(root).length === 2, 'S1 ledger keeps BOTH applies (stack of 2)');

  // revert ×2 → exact original.
  const r2 = reproject.revertPlan(root, { now: 300 });
  ok(r2.reverted === 1 && r2.remainingApplies === 1, `S1 revert#1 undoes apply#2 only (${JSON.stringify(r2)})`);
  ok(sessionProjects(root)['s-a1'] === recB.id, 'S1 apply#1 still in effect after first revert');
  const r1 = reproject.revertPlan(root, { now: 400 });
  ok(r1.reverted === 2 && r1.remainingApplies === 0, `S1 revert#2 undoes apply#1 (${JSON.stringify(r1)})`);
  ok((r1.notReverted || []).length === 0 && (r2.notReverted || []).length === 0, 'S1 every moved file went back');

  const mEnd = manifest(root);
  ok(sameManifest(m0, mEnd), `S1 profile byte-identical after 2 reverts (lost=${lostFiles(m0, mEnd)}, extra=${lostFiles(mEnd, m0)})`);
  ok(JSON.stringify(sessionProjects(root)) === JSON.stringify(sp0), 'S1 every session back on its original project');
  ok(JSON.parse(fs.readFileSync(gtdFp, 'utf8')).projectDir === JSON.parse(gtd0).projectDir, 'S4 gtd projectDir restored by revert');

  const r0 = reproject.revertPlan(root, { now: 500 });
  ok(r0.error && r0.reverted === 0, 'S5 revert with empty stack → clean error');
}

// ── S6: legacy ledger format ─────────────────────────────────────────────────
{
  const sb = buildSandboxProfile();
  cleanup.push(sb.usersDir);
  const { root } = sb;
  const { recA, recB } = sb.projects;
  reproject.applyPlan(root, planInto(recB.id, ['s-a1', 's-a2', 's-b1']), { dryRun: false, now: 100 });
  const stack = reproject.readLedgerStack(root);
  fs.writeFileSync(reproject.ledgerPath(root), JSON.stringify(stack[0])); // pre-stack shape
  const r = reproject.revertPlan(root, { now: 200 });
  ok(r.reverted === 2 && sessionProjects(root)['s-a1'] === recA.id, `S6 legacy ledger revertable (${JSON.stringify(r)})`);
}

// ── S7–S8: migrate-profile-to-projects --apply ───────────────────────────────
{
  const sb = buildSandboxProfile();
  cleanup.push(sb.usersDir);
  const { root, usersDir, name } = sb;
  // Exactly one recruiting project → root interviews/ is auto-migrated into it.
  projects.archiveProject(root, sb.projects.recB.id);
  const recDir = projects.projectDir(root, sb.projects.recA.id);
  const m0 = manifest(root);

  const run = () => execFileSync(process.execPath, ['scripts/migrate-profile-to-projects.mjs', name, '--apply'],
    { cwd: REPO, env: { ...process.env, USERS_DIR: usersDir }, encoding: 'utf8' });
  const out1 = run();
  ok(/moved: interviews/.test(out1), `S7 migration moved root interviews/ (${out1.split('\n').filter(l => /interviews/.test(l)).join(' | ')})`);
  ok(fs.existsSync(path.join(recDir, 'interviews', 'transcripts', 'ivanov.txt')), 'S7 project\'s OWN transcript survived migration');
  ok(fs.existsSync(path.join(recDir, 'interviews', 'analysis', 'ivanov.md')), 'S7 project\'s own analysis survived migration');
  ok(fs.existsSync(path.join(recDir, 'interviews', 'transcripts', 'legacy-sidorov.txt')), 'S7 migrated root transcript landed in project');
  ok(lostFiles(m0, manifest(root)).length === 0, `S7 nothing lost: ${lostFiles(m0, manifest(root))}`);

  run();
  ok(lostFiles(m0, manifest(root)).length === 0, `S8 second --apply still loses nothing: ${lostFiles(m0, manifest(root))}`);
}

for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
console.log(`reproject-sandbox: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
