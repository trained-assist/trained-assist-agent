// Contract + behaviour test for the issue-fixer selection slice (F2,
// ISSUES-TO-PR-SPEC.md §3.3/§6 in the owner's working project).
//
// F2 makes no model calls and opens no PRs — it only decides which open issues are
// structurally eligible right now, and remembers what it already queued so a re-run
// does not re-report the same issue. Network (GitHub list + label) is always injected.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const fixer = require('../src/issue-fixer');
const { isCandidate, selectCandidates, run } = fixer;

function issue(number, { state = 'open', labels = [], pull_request } = {}) {
  return { number, title: `Issue ${number}`, state, labels: labels.map(name => ({ name })), pull_request };
}

// ── Part 1: pure selection logic ────────────────────────────────────────────────
const emptyState = { queued: {} };

ok(isCandidate(issue(1, { labels: ['size:S'] }), emptyState), 'open issue with size:S label is a candidate');
ok(!isCandidate(issue(2, { state: 'closed', labels: ['size:S'] }), emptyState), 'closed issue is never a candidate');
ok(!isCandidate(issue(3, { labels: ['size:S'], pull_request: {} }), emptyState), 'PRs (returned by the issues API too) are excluded');
ok(!isCandidate(issue(4, { labels: [] }), emptyState), 'issue without any size:* label waits for triage');
ok(!isCandidate(issue(5, { labels: ['size:S', 'needs-architect'] }), emptyState), 'needs-architect excludes');
ok(!isCandidate(issue(6, { labels: ['size:S', 'scope:out'] }), emptyState), 'scope:out excludes');
ok(!isCandidate(issue(7, { labels: ['size:S', 'fixer:queued'] }), emptyState), 'already fixer:queued excludes');
ok(!isCandidate(issue(8, { labels: ['size:S', 'fixer:pr-opened'] }), emptyState), 'fixer:pr-opened excludes');
ok(!isCandidate(issue(9, { labels: ['size:S', 'fixer:failed'] }), emptyState), 'fixer:failed excludes');
ok(!isCandidate(issue(10, { labels: ['size:S', 'mixed-changes'] }), emptyState), 'mixed-changes excludes');
ok(!isCandidate(issue(11, { labels: ['feat', 'architecture', 'size:XL'] }), emptyState), 'epic (feat+architecture+size:XL) excludes');
ok(isCandidate(issue(12, { labels: ['feat', 'size:XL'] }), emptyState), 'size:XL alone (not a full epic combo) is still a candidate');
ok(!isCandidate(issue(13, { labels: ['size:S'] }), { queued: { 13: { at: 1 } } }), 'issue already in state.queued excludes');

const mixed = [
  issue(1, { labels: ['size:S'] }),
  issue(2, { state: 'closed', labels: ['size:S'] }),
  issue(3, { labels: ['size:M', 'needs-architect'] }),
  issue(4, { labels: ['size:XS'] }),
];
const cands = selectCandidates(mixed, emptyState);
ok(cands.length === 2 && cands[0].number === 1 && cands[1].number === 4, 'selectCandidates filters + sorts by number');

// ── Part 2: run() — GitHub + state wired through injected functions ────────────
(async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-fixer-test-'));
  const statePath = path.join(stateDir, 'state.json');

  const issues = [
    issue(101, { labels: ['size:S', 'bug'] }),
    issue(102, { labels: ['size:M', 'needs-architect'] }), // excluded
    issue(103, { labels: [] }), // no size:* yet -> excluded
  ];

  // (a) dry-run: reports the candidate, touches neither labels nor state.
  const labeled = [];
  let r = await run({
    dryRun: true,
    token: 't',
    statePath,
    listIssues: async () => issues,
    addLabel: async (n) => labeled.push(n),
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.total === 3 && r.candidates.length === 1 && r.candidates[0].number === 101, 'dry-run selects exactly the eligible issue');
  ok(labeled.length === 0 && !fs.existsSync(statePath), 'dry-run never labels or writes state');

  // (b) real run: labels the candidate and persists state.
  r = await run({
    dryRun: false,
    token: 't',
    statePath,
    now: 1000,
    listIssues: async () => issues,
    addLabel: async (n) => labeled.push(n),
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.queued.length === 1 && r.queued[0] === 101 && labeled.includes(101), 'real run labels the candidate fixer:queued');
  ok(fs.existsSync(statePath), 'state.json persisted after a real run');
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  ok(saved.queued['101'] && saved.queued['101'].at === 1000, 'state records the queued issue with a timestamp');

  // (c) second run: issue 101 already queued in state -> not re-selected, not re-labeled.
  labeled.length = 0;
  r = await run({
    dryRun: false,
    token: 't',
    statePath,
    listIssues: async () => issues,
    addLabel: async (n) => labeled.push(n),
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.candidates.length === 0 && labeled.length === 0, 'second run does not re-queue the same issue (idempotent)');

  // (d) label API failure surfaces as an error and does not corrupt state.
  const failStatePath = path.join(stateDir, 'fail-state.json');
  r = await run({
    dryRun: false,
    token: 't',
    statePath: failStatePath,
    listIssues: async () => [issue(201, { labels: ['size:XS'] })],
    addLabel: async () => { throw new Error('HTTP 403'); },
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.errors.length === 1 && r.errors[0].includes('201') && r.queued.length === 0, 'label failure is reported, issue is not marked queued');
  ok(!fs.existsSync(failStatePath), 'nothing persisted when nothing was successfully queued');

  // (e) no token -> fatal error, no crash.
  r = await run({ dryRun: true, token: null, statePath, listIssues: async () => issues });
  ok(r.errors.length === 1 && r.total === 0, 'missing token is a soft error, not a throw');

  console.log(`issue-fixer.test.cjs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
