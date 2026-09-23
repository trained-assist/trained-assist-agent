// Contract + behaviour test for the issue-fixer execute slice (F4,
// ISSUES-TO-PR-SPEC.md §3.5/§6 in the owner's working project).
//
// F4 clones in isolation (never the live checkout), runs an engine + verify loop
// (both injected here — no real git/network in test:cjs), and on success opens a PR
// with a hidden marker for idempotency. On failure after maxAttempts it labels
// fixer:failed instead. A re-run must never open a second PR for the same issue.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const fixer = require('../src/issue-fixer');
const {
  isExecutable, selectExecutable, buildExecutePrompt, buildPrBody, buildFailedComment,
  runExecute, MARKER,
} = fixer;

function issue(number, { state = 'open', labels = [], body = '', pull_request } = {}) {
  return { number, title: `Issue ${number}`, state, labels: labels.map(name => ({ name })), body, pull_request };
}

// ── Part 1: isExecutable / selectExecutable ─────────────────────────────────────
ok(isExecutable(issue(1, { labels: ['scope:in', 'fixability:auto'] })), 'gated auto, not yet acted on -> executable');
ok(!isExecutable(issue(2, { labels: ['scope:in', 'needs-human'] })), 'gated human -> not executable');
ok(!isExecutable(issue(3, { labels: ['scope:out', 'fixability:auto'] })), 'scope:out -> not executable');
ok(!isExecutable(issue(4, { labels: ['scope:in', 'fixability:auto', 'fixer:pr-opened'] })), 'already has an open PR -> not executable');
ok(!isExecutable(issue(5, { labels: ['scope:in', 'fixability:auto', 'fixer:failed'] })), 'already failed -> not executable (needs a human to clear the label)');
ok(!isExecutable(issue(6, { state: 'closed', labels: ['scope:in', 'fixability:auto'] })), 'closed issue -> not executable');
ok(!isExecutable(issue(7, { labels: ['scope:in', 'fixability:auto'], pull_request: {} })), 'PR (issues API also returns PRs) -> not executable');

const executable = selectExecutable([
  issue(20, { labels: ['scope:in', 'fixability:auto'] }),
  issue(10, { labels: ['scope:in', 'fixability:auto'] }),
  issue(30, { labels: ['scope:in', 'needs-human'] }),
]);
ok(executable.length === 2 && executable[0].number === 10 && executable[1].number === 20, 'selectExecutable filters + sorts by number');

// ── Part 2: prompt/comment/body builders — pure, deterministic ─────────────────
{
  const p = buildExecutePrompt(issue(42, { body: 'Button X is broken' }), { scope: 'in', fixability: 'auto', area: 'src/x.js', reason: 'local bug' }, 'GOALS excerpt');
  ok(p.includes('#42') && p.includes('Button X is broken') && p.includes('GOALS excerpt') && p.includes('npm ci'), 'prompt includes issue body, gate verdict, goals context, hard rules');
}
{
  const body = buildPrBody(42, { reason: 'local bug' });
  ok(body.includes(MARKER(42)) && body.includes('Closes #42') && body.includes('local bug'), 'PR body carries marker + Closes # + gate reason');
}
{
  const c = buildFailedComment(42, 'some long verify log');
  ok(c.includes('some long verify log') && c.includes('fixer:failed'), 'failed comment includes the log tail and points at the label');
}

// ── Part 3: runExecute() — GitHub + clone/engine/verify/push/PR wired through injected functions
(async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-fixer-execute-test-'));
  const statePath = path.join(stateDir, 'state.json');

  const issues = [
    issue(101, { labels: ['scope:in', 'fixability:auto'], title: 'fixes clean on first try' }),
    issue(102, { labels: ['scope:in', 'fixability:auto'] }), // engine keeps failing verify -> fixer:failed
    issue(103, { labels: ['scope:in', 'needs-human'] }), // not executable
    issue(104, { labels: ['scope:in', 'fixability:auto', 'fixer:pr-opened'] }), // already opened
  ];

  const labeled = [];
  const comments = [];
  const pushed = [];
  const cleaned = [];
  const createdPrs = [];
  let searchCalls = 0;

  const makeDeps = (overrides = {}) => ({
    token: 't',
    statePath,
    listIssues: async () => issues,
    addLabel: async (n, l) => labeled.push([n, l]),
    addComment: async (n, b) => comments.push([n, b]),
    cloneAndBranch: async (n) => ({ cwd: `/tmp/fake-${n}`, branch: `fix/issue-${n}` }),
    findExistingPr: async () => { searchCalls++; return null; },
    push: async (cwd, branch) => pushed.push([cwd, branch]),
    cleanup: (cwd) => cleaned.push(cwd),
    createPr: async ({ branch, title }) => { const number = 900 + createdPrs.length; createdPrs.push({ branch, title }); return { number, url: `https://x/${number}` }; },
    logger: { log() {}, warn() {}, error() {} },
    ...overrides,
  });

  // (a) dry-run: reports executable issues, touches neither labels/comments/clone/state.
  let cloneCalls = 0;
  let r = await runExecute(makeDeps({
    dryRun: true,
    cloneAndBranch: async (n) => { cloneCalls++; return { cwd: `/tmp/fake-${n}`, branch: `fix/issue-${n}` }; },
  }));
  ok(r.total === 4 && r.candidates.length === 2, 'dry-run selects only 101/102 (103 needs-human, 104 already pr-opened)');
  ok(cloneCalls === 0 && labeled.length === 0 && !fs.existsSync(statePath), 'dry-run never clones/labels/writes state');

  // (b) real run: 101 succeeds on first attempt, 102 fails verify every attempt -> fixer:failed after 3 tries.
  let engineCallsFor102 = 0;
  r = await runExecute(makeDeps({
    dryRun: false,
    now: 5000,
    runEngine: async ({ cwd }) => ({ ok: true, log: 'edited files' }),
    verify: async (cwd) => {
      if (cwd.includes('101')) return { ok: true, log: 'tests pass' };
      engineCallsFor102++;
      return { ok: false, log: `verify failed attempt ${engineCallsFor102}` };
    },
  }));
  ok(r.opened.length === 1 && r.opened[0] === 101, '101 opened a PR');
  ok(r.failed.length === 1 && r.failed[0] === 102, '102 exhausted retries -> failed');
  ok(engineCallsFor102 === 3, 'maxAttempts=3 respected before giving up on 102');
  ok(pushed.some(([, b]) => b === 'fix/issue-101') && !pushed.some(([, b]) => b === 'fix/issue-102'), 'only the successful issue gets pushed');
  ok(labeled.some(([n, l]) => n === 101 && l === 'fixer:pr-opened'), '101 labeled fixer:pr-opened');
  ok(labeled.some(([n, l]) => n === 102 && l === 'fixer:failed'), '102 labeled fixer:failed');
  ok(comments.some(([n]) => n === 102) && !comments.some(([n]) => n === 101), 'only the failed issue gets a log comment');
  ok(cleaned.length === 2, 'both attempted issues get their isolated clone cleaned up');

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  ok(saved.queued['101'] && saved.queued['101'].pr === 900, 'state records the PR number for 101');
  ok(saved.queued['102'] && saved.queued['102'].failedAt === 5000, 'state records the failure for 102');

  // (c) second run: label-add had failed last time (no fixer:pr-opened on GitHub), but
  // state.json still remembers the PR -> short-circuits before any clone/engine work.
  let cloneCallsAgain = 0;
  r = await runExecute(makeDeps({
    dryRun: false,
    listIssues: async () => [issue(101, { labels: ['scope:in', 'fixability:auto'] })],
    cloneAndBranch: async () => { cloneCallsAgain++; return { cwd: '/tmp/x', branch: 'x' }; },
  }));
  ok(r.opened.length === 1 && r.opened[0] === 101 && cloneCallsAgain === 0, 'idempotent: state.pr short-circuits before any clone/engine work');

  // (d) state.json lost, but a PR with the marker already exists on GitHub -> found via search, no duplicate.
  let cloneCallsFallback = 0;
  r = await runExecute(makeDeps({
    dryRun: false,
    statePath: path.join(stateDir, 'lost-state.json'),
    listIssues: async () => [issue(201, { labels: ['scope:in', 'fixability:auto'] })],
    findExistingPr: async (n) => { searchCalls++; return n === 201 ? { number: 777, url: 'https://x/777' } : null; },
    cloneAndBranch: async () => { cloneCallsFallback++; return { cwd: '/tmp/x', branch: 'x' }; },
  }));
  ok(r.opened.length === 1 && r.opened[0] === 201 && cloneCallsFallback === 0, 'marker search fallback finds the existing PR, skips clone/engine entirely');
  const savedFallback = JSON.parse(fs.readFileSync(path.join(stateDir, 'lost-state.json'), 'utf8'));
  ok(savedFallback.queued['201'].pr === 777, 'fallback-found PR number is persisted back into state');

  // (e) clone throws -> reported as a per-issue error, does not crash the run.
  r = await runExecute(makeDeps({
    dryRun: false,
    statePath: path.join(stateDir, 'clone-fail-state.json'),
    listIssues: async () => [issue(301, { labels: ['scope:in', 'fixability:auto'] })],
    cloneAndBranch: async () => { throw new Error('git clone: repository not found'); },
  }));
  ok(r.errors.length === 1 && r.errors[0].includes('301') && r.opened.length === 0 && r.failed.length === 0,
    'clone failure surfaces as a per-issue error, execute does not crash');

  // (f) no token -> soft error, no crash.
  r = await runExecute({ dryRun: true, token: null, statePath, listIssues: async () => issues });
  ok(r.errors.length === 1 && r.total === 0, 'missing token is a soft error, not a throw');

  console.log(`issue-fixer-execute.test.cjs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
