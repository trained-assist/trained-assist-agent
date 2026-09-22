// Contract + behaviour test for the bugs collector (BUGS-AND-FEATURES-SPEC.md §3.2/§3.6).
//
// Part 1 (contract): reads the index.jsonl interface across profile dirs under a fake
// USERS_ROOT and returns only open entries — no mutation of the index.
// Part 2 (collection): the quiet gate (3 min no edits), LLM->GitHub filing, dedup via
// collector/state.json, marker-based fallback dedup, and never-throw on a broken profile.
//
// Network is never touched: the LLM, GitHub create and GitHub search are injected.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const collector = require('../src/bugs-collector');
const { collectOpen, readIndex, indexPath, reportDir, run, fallbackIssue } = collector;

const usersRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bugs-collector-test-'));

function writeIndex(profile, lines) {
  const file = indexPath(path.join(usersRoot, profile));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

// Create projects/<profile>/projects/bugs-and-features/reports/<dir> with real files.
function mkReport(profile, dir, { report, transcript = 'user: оно сломалось' } = {}) {
  const rd = reportDir(path.join(usersRoot, profile), { dir });
  fs.mkdirSync(path.join(rd, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(rd, 'evidence'), { recursive: true });
  if (report) fs.writeFileSync(path.join(rd, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(rd, 'transcript.md'), transcript);
  return rd;
}

// Age every file+dir under `dir` so the quiet gate sees it as untouched.
function age(dir, ms) {
  const t = new Date(Date.now() - ms);
  const walk = (d) => {
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      fs.utimesSync(p, t, t);
    }
  };
  walk(dir);
  fs.utimesSync(dir, t, t);
}

// ── Part 1: index contract (unchanged from the stub PR) ────────────────────────
writeIndex('profile-a', [
  { id: 'a1', kind: 'bug', title: 'Кнопка не жмётся', dir: '2026-09-20-button', status: 'open', createdAt: 1, sessionId: 's1' },
  { id: 'a2', kind: 'feature', title: 'Хочу тёмную тему', dir: '2026-09-21-dark-theme', status: 'processed', createdAt: 2, sessionId: 's2' },
]);
writeIndex('profile-b', [
  { id: 'b1', kind: 'feature', title: 'Экспорт в CSV', dir: '2026-09-22-csv-export', status: 'open', createdAt: 3, sessionId: 's3' },
]);
fs.mkdirSync(path.join(usersRoot, 'profile-c'), { recursive: true });
const dIndex = indexPath(path.join(usersRoot, 'profile-d'));
fs.mkdirSync(path.dirname(dIndex), { recursive: true });
fs.writeFileSync(dIndex, '{not json\n' + JSON.stringify({ id: 'd1', kind: 'bug', title: 'X', dir: 'x', status: 'open', createdAt: 4, sessionId: 's4' }) + '\n');

const open = collectOpen({ usersRoot });
ok(open.length === 3, `exactly 3 open entries across profiles (got ${open.length})`);
ok(open.some(o => o.profile === 'profile-a' && o.entry.id === 'a1'), 'profile-a open bug surfaced');
ok(!open.some(o => o.entry.id === 'a2'), 'processed entry excluded');
ok(open.some(o => o.profile === 'profile-d' && o.entry.id === 'd1'), 'valid line survives alongside a malformed one');
ok(Array.isArray(readIndex(path.join(usersRoot, 'profile-c'))) && readIndex(path.join(usersRoot, 'profile-c')).length === 0, 'missing index.jsonl -> empty array');
ok(collectOpen({ usersRoot: path.join(usersRoot, 'does-not-exist') }).length === 0, 'missing usersRoot -> empty array');

// ── Part 2: collection behaviour ─────────────────────────────────────────────
(async () => {
  // Fresh, quiet report in profile-quiet.
  mkReport('profile-quiet', '2026-09-22-quiet', {
    report: { id: 'q1', kind: 'bug', title: 'Падает экспорт', summary: 'Экспорт падает на 3-й минуте', status: 'open', severity: 'high', area: 'web' },
  });
  writeIndex('profile-quiet', [
    { id: 'q1', kind: 'bug', title: 'Падает экспорт', dir: '2026-09-22-quiet', status: 'open', createdAt: 10, sessionId: 's10' },
  ]);
  const quietDir = reportDir(path.join(usersRoot, 'profile-quiet'), { dir: '2026-09-22-quiet' });

  // (a) Fresh folder is NOT quiet yet -> skipped, nothing filed.
  let filed = [];
  let r = await run({
    usersRoot, quietMs: 3 * 60 * 1000,
    token: 't', apiKey: 'k',
    llm: async () => ({ kind: 'bug', title: 'T', body: 'B', labels: [] }),
    createIssue: async (x) => { filed.push(x); return { number: 1, url: 'https://example/1' }; },
    findExisting: async () => null,
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(filed.length === 0 && r.due === 0, 'fresh report is not collected before the quiet gate');

  // (b) After ageing past the gate -> collected exactly once, with the right labels.
  age(quietDir, 4 * 60 * 1000);
  r = await run({
    usersRoot, quietMs: 3 * 60 * 1000,
    token: 't', apiKey: 'k',
    llm: async ({ profile, entry }) => ({ kind: 'feature', title: `Issue ${entry.id}`, body: `body of ${entry.id}`, labels: ['extra'] }),
    createIssue: async (x) => { filed.push(x); return { number: 7, url: 'https://example/7' }; },
    findExisting: async () => null,
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.created.length === 1 && filed.length === 1, 'quiet report collected once');
  ok(filed[0].labels.includes('feature') && filed[0].labels.includes('from-bugs-collector') && filed[0].labels.includes('extra'), 'labels = model kind + from-bugs-collector + model labels');

  // (c) Second run must NOT re-file (state dedup).
  r = await run({
    usersRoot, quietMs: 0,
    token: 't', apiKey: 'k',
    llm: async () => ({ kind: 'bug', title: 'T', body: 'B', labels: [] }),
    createIssue: async (x) => { filed.push(x); return { number: 8, url: 'https://example/8' }; },
    findExisting: async () => null,
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(filed.length === 1 && r.skipped >= 1, 'processed report is not re-filed on the next run');

  // (d) Marker-based fallback dedup: state gone, GitHub already has the issue.
  fs.rmSync(path.join(usersRoot, 'profile-quiet', 'projects', 'bugs-and-features', 'collector', 'state.json'), { force: true });
  let createdAfterMarker = 0;
  r = await run({
    usersRoot, quietMs: 0,
    token: 't', apiKey: 'k',
    llm: async () => ({ kind: 'bug', title: 'T', body: 'B', labels: [] }),
    createIssue: async () => { createdAfterMarker++; return { number: 9, url: 'https://example/9' }; },
    findExisting: async (marker) => marker.includes('profile-quiet/q1') ? { number: 7, url: 'https://example/7' } : null,
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(createdAfterMarker === 0 && r.created.length === 0, 'marker found on GitHub -> no duplicate issue');
  const st = collector.readState(path.join(usersRoot, 'profile-quiet'));
  ok(st.processed.q1 && st.processed.q1.issue === 7, 'marker dedup records the existing issue in state');

  // (e) Broken profile (index points at a missing folder) must not throw.
  writeIndex('profile-broken', [
    { id: 'x1', kind: 'bug', title: 'gone', dir: 'no-such-folder', status: 'open', createdAt: 1, sessionId: 's' },
    { id: 'x2', kind: 'bug', title: 'escape', dir: '../../etc', status: 'open', createdAt: 1, sessionId: 's' },
  ]);
  r = await run({
    usersRoot, quietMs: 0, token: 't', apiKey: 'k',
    llm: async () => ({ kind: 'bug', title: 'T', body: 'B', labels: [] }),
    createIssue: async () => ({ number: 1, url: 'u' }),
    findExisting: async () => null,
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.errors.length >= 1 && r.created.every(c => c.profile !== 'profile-broken'), 'missing folder / bad dir are errors, not crashes');

  // (f) dry-run files nothing.
  mkReport('profile-dry', '2026-09-22-dry', { report: { id: 'z1', kind: 'bug', title: 'Z', summary: 'Z' } });
  writeIndex('profile-dry', [{ id: 'z1', kind: 'bug', title: 'Z', dir: '2026-09-22-dry', status: 'open', createdAt: 1, sessionId: 's' }]);
  age(reportDir(path.join(usersRoot, 'profile-dry'), { dir: '2026-09-22-dry' }), 5 * 60 * 1000);
  let dryCreate = 0;
  r = await run({
    usersRoot, quietMs: 0, dryRun: true, token: 't', apiKey: 'k',
    llm: async () => ({ kind: 'bug', title: 'T', body: 'B', labels: [] }),
    createIssue: async () => { dryCreate++; return { number: 1, url: 'u' }; },
    findExisting: async () => null,
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(dryCreate === 0 && r.created.some(c => c.profile === 'profile-dry' && c.dryRun), 'dry-run reports but files nothing');

  // (g) No API key -> template fallback still files a complete issue.
  const fb = fallbackIssue({ entry: { id: 'f1', title: 'F', kind: 'bug' }, profile: 'p', input: { report: { kind: 'bug', title: 'F', summary: 'S' }, transcript: 't', attachments: ['a.png'], evidence: [] } });
  ok(fb.title.startsWith('[bug]') && fb.body.includes('Профиль') && fb.body.includes('a.png'), 'template fallback keeps the report substance');

  fs.rmSync(usersRoot, { recursive: true, force: true });
  console.log(`\nbugs-collector: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });
