// Contract test for the bugs collector stub (issue #1120, PR4 of
// BUGS-AND-FEATURES-SPEC.md §5.2). Reads the index.jsonl interface across profile dirs
// under a fake USERS_ROOT and returns only open entries — no mutation, no triage.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const { collectOpen, readIndex, indexPath } = require('../src/bugs-collector');

const usersRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bugs-collector-test-'));

function writeIndex(profile, lines) {
  const file = indexPath(path.join(usersRoot, profile));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

// Profile A: one open bug, one already-processed feature.
writeIndex('profile-a', [
  { id: 'a1', kind: 'bug', title: 'Кнопка не жмётся', dir: '2026-09-20-button', status: 'open', createdAt: 1, sessionId: 's1' },
  { id: 'a2', kind: 'feature', title: 'Хочу тёмную тему', dir: '2026-09-21-dark-theme', status: 'processed', createdAt: 2, sessionId: 's2' },
]);

// Profile B: one open feature.
writeIndex('profile-b', [
  { id: 'b1', kind: 'feature', title: 'Экспорт в CSV', dir: '2026-09-22-csv-export', status: 'open', createdAt: 3, sessionId: 's3' },
]);

// Profile C: has no bugs-and-features project at all — must not crash the scan.
fs.mkdirSync(path.join(usersRoot, 'profile-c'), { recursive: true });

// Profile D: malformed line mixed with a valid one — malformed is skipped, not fatal.
const dIndex = indexPath(path.join(usersRoot, 'profile-d'));
fs.mkdirSync(path.dirname(dIndex), { recursive: true });
fs.writeFileSync(dIndex, '{not json\n' + JSON.stringify({ id: 'd1', kind: 'bug', title: 'X', dir: 'x', status: 'open', createdAt: 4, sessionId: 's4' }) + '\n');

const open = collectOpen({ usersRoot });
ok(open.length === 3, `exactly 3 open entries across profiles (got ${open.length})`);
ok(open.some(o => o.profile === 'profile-a' && o.entry.id === 'a1'), 'profile-a open bug surfaced');
ok(!open.some(o => o.entry.id === 'a2'), 'processed entry excluded');
ok(open.some(o => o.profile === 'profile-b' && o.entry.id === 'b1'), 'profile-b open feature surfaced');
ok(open.some(o => o.profile === 'profile-d' && o.entry.id === 'd1'), 'valid line survives alongside a malformed one');

// readIndex on a profile with no index.jsonl returns empty, not throw.
ok(Array.isArray(readIndex(path.join(usersRoot, 'profile-c'))) && readIndex(path.join(usersRoot, 'profile-c')).length === 0, 'missing index.jsonl -> empty array');

// Missing USERS_ROOT entirely -> empty array, not throw.
ok(collectOpen({ usersRoot: path.join(usersRoot, 'does-not-exist') }).length === 0, 'missing usersRoot -> empty array');

fs.rmSync(usersRoot, { recursive: true, force: true });
console.log(`\nbugs-collector: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
