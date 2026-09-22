// Contract test for the "bugs" project type (Bugs & Features intake redesign, see
// generic-gtd-task-management-automation/BUGS-AND-FEATURES-SPEC.md §3.1/3.2/3.3, PR1).
// One reserved singleton project per profile, canonical id 'bugs-and-features'.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const projects = require('../src/projects');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugs-project-test-'));

// bugsProject() creates the canonical singleton when none exists yet.
const p1 = projects.bugsProject(workDir);
ok(p1.id === 'bugs-and-features', 'canonical id bugs-and-features');
ok(p1.type === 'bugs', 'type is bugs');

// Idempotent: second call returns the same project, no sibling minted.
const p2 = projects.bugsProject(workDir);
ok(p2.id === p1.id, 'bugsProject is idempotent');
ok(projects.listProjects(workDir).filter(p => p.type === 'bugs').length === 1, 'exactly one bugs project on disk');

// createProject() with a "bugs: ..." typed name also resolves to the same singleton.
const p3 = projects.createProject(workDir, 'bugs: что угодно');
ok(p3.id === 'bugs-and-features', 'createProject("bugs: ...") reuses the canonical id, not a fresh sibling');

// Scaffold dirs.
const dir = projects.projectDir(workDir, p1.id);
for (const d of ['reports', '_processed', 'collector']) {
  ok(fs.existsSync(path.join(dir, d)), `scaffold dir created: ${d}`);
}

// Seed files (the collector's contract).
ok(fs.existsSync(path.join(dir, 'reports', 'README.md')), 'reports/README.md seeded');
ok(fs.existsSync(path.join(dir, 'collector', 'README.md')), 'collector/README.md seeded');
const reportsReadme = fs.readFileSync(path.join(dir, 'reports', 'README.md'), 'utf8');
ok(reportsReadme.includes('index.jsonl'), 'reports/README.md documents the index.jsonl contract');

// PROFILE.md — merged into the session system prompt — carries the intake protocol.
const profile = projects.profileText(workDir, p1.id);
ok(!!profile, 'PROFILE.md is non-empty');
ok(profile.includes('index.jsonl'), 'PROFILE.md instructs writing to index.jsonl');
ok(profile.includes('Не создавай GitHub issues'), 'PROFILE.md explicitly forbids creating GitHub issues (spec: no public GitHub)');

// Type registry sanity.
ok(projects.TYPES.bugs.id === 'bugs-and-features', 'TYPES.bugs declares the canonical id');
ok(projects.parseTypedName('bug: сломалось').type === 'bugs', 'parseTypedName recognizes bug: prefix');
ok(projects.parseTypedName('фича: хочу X').type === 'bugs', 'parseTypedName recognizes фича: prefix');

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`\nbugs-project: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
