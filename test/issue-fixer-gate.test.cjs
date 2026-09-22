// Contract + behaviour test for the issue-fixer relevance-gate slice (F3,
// ISSUES-TO-PR-SPEC.md §3.2/§6 in the owner's working project).
//
// F3 never touches the working tree and never creates a PR — it only classifies
// already-queued issues (model injected, no real network) and records the verdict
// as labels + a comment. GitHub (labels) is the source of truth for "already
// gated" — a re-run must not re-classify the same issue.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const fixer = require('../src/issue-fixer');
const {
  isPendingGate, selectPendingGate, hasReproHeuristic,
  validateClassification, applyConservativeDefault, runGate,
} = fixer;

function issue(number, { state = 'open', labels = [], body = '', pull_request } = {}) {
  return { number, title: `Issue ${number}`, state, labels: labels.map(name => ({ name })), body, pull_request };
}

// ── Part 1: isPendingGate / selectPendingGate ───────────────────────────────────
ok(isPendingGate(issue(1, { labels: ['fixer:queued', 'size:S'] })), 'queued, not yet gated -> pending');
ok(!isPendingGate(issue(2, { labels: ['size:S'] })), 'never queued (no fixer:queued) -> not pending');
ok(!isPendingGate(issue(3, { labels: ['fixer:queued', 'scope:in'] })), 'already has scope:in -> not pending');
ok(!isPendingGate(issue(4, { labels: ['fixer:queued', 'scope:out'] })), 'already has scope:out -> not pending');
ok(!isPendingGate(issue(5, { state: 'closed', labels: ['fixer:queued'] })), 'closed issue -> not pending');
ok(!isPendingGate(issue(6, { labels: ['fixer:queued'], pull_request: {} })), 'PR (issues API also returns PRs) -> not pending');

const pending = selectPendingGate([
  issue(10, { labels: ['fixer:queued'] }),
  issue(9, { labels: ['fixer:queued'] }),
  issue(8, { labels: ['scope:in'] }),
]);
ok(pending.length === 2 && pending[0].number === 9 && pending[1].number === 10, 'selectPendingGate filters + sorts by number');

// ── Part 2: hasReproHeuristic ────────────────────────────────────────────────────
ok(hasReproHeuristic({ body: 'Steps to reproduce:\n1. open app\n2. click X' }), 'explicit "Steps to reproduce" + numbered list -> true');
ok(hasReproHeuristic({ body: '1. do A\n2. do B\n3. see error' }), 'bare numbered list -> true');
ok(hasReproHeuristic({ body: 'Шаги воспроизведения: открыть страницу и нажать кнопку' }), 'Russian "шаги воспроизведения" -> true');
ok(!hasReproHeuristic({ body: 'It would be nice if we had dark mode.' }), 'no repro signal -> false');
ok(!hasReproHeuristic({ body: '' }), 'empty body -> false');
ok(!hasReproHeuristic({}), 'missing body -> false');

// ── Part 3: validateClassification ──────────────────────────────────────────────
try {
  validateClassification({ scope: 'sideways', fixability: 'auto' });
  ok(false, 'invalid scope should throw');
} catch { ok(true, 'invalid scope throws'); }
try {
  validateClassification({ scope: 'in', fixability: 'maybe' });
  ok(false, 'invalid fixability should throw');
} catch { ok(true, 'invalid fixability throws'); }
try {
  validateClassification(null);
  ok(false, 'null classification should throw');
} catch { ok(true, 'null classification throws'); }
{
  const v = validateClassification({ scope: 'in', fixability: 'auto', area: 'src/x.js', reason: 'r' });
  ok(v.breaks_scenario === null, 'missing breaks_scenario defaults to null');
}

// ── Part 4: applyConservativeDefault — the owner's cap table ────────────────────
// in / auto / bug+repro/XS/S -> stays auto, is a candidate
{
  const v = applyConservativeDefault(
    { scope: 'in', breaks_scenario: 'recruiter/apply', fixability: 'auto', area: 'a', reason: 'r' },
    { hasBugLabel: true, hasRepro: true, sizeLabel: 'S' },
  );
  ok(v.fixability === 'auto' && v.candidate === true, 'bug+repro+size:S+model:auto -> stays auto, is a candidate');
}
// model says auto but NOT a bug label -> capped to human
{
  const v = applyConservativeDefault(
    { scope: 'in', breaks_scenario: 'x', fixability: 'auto', area: 'a', reason: 'r' },
    { hasBugLabel: false, hasRepro: true, sizeLabel: 'XS' },
  );
  ok(v.fixability === 'human' && v.candidate === false, 'auto but not labeled bug -> capped to human');
}
// model says auto but no repro -> capped to human
{
  const v = applyConservativeDefault(
    { scope: 'in', breaks_scenario: 'x', fixability: 'auto', area: 'a', reason: 'r' },
    { hasBugLabel: true, hasRepro: false, sizeLabel: 'XS' },
  );
  ok(v.fixability === 'human', 'auto but no repro -> capped to human');
}
// model says auto but size:M -> capped to human
{
  const v = applyConservativeDefault(
    { scope: 'in', breaks_scenario: 'x', fixability: 'auto', area: 'a', reason: 'r' },
    { hasBugLabel: true, hasRepro: true, sizeLabel: 'M' },
  );
  ok(v.fixability === 'human', 'auto but size:M -> capped to human');
}
// model already said human -> never upgraded to auto
{
  const v = applyConservativeDefault(
    { scope: 'in', breaks_scenario: 'x', fixability: 'human', area: 'a', reason: 'r' },
    { hasBugLabel: true, hasRepro: true, sizeLabel: 'XS' },
  );
  ok(v.fixability === 'human', 'model already human -> stays human even if the cap conditions are met');
}
// conservative:false -> the model's own verdict is trusted as-is
{
  const v = applyConservativeDefault(
    { scope: 'in', breaks_scenario: 'x', fixability: 'auto', area: 'a', reason: 'r' },
    { hasBugLabel: false, hasRepro: false, sizeLabel: 'L', conservative: false },
  );
  ok(v.fixability === 'auto' && v.candidate === true, 'conservative:false trusts the model verdict as-is');
}
// scope=out -> never a candidate even if fixability=auto
{
  const v = applyConservativeDefault(
    { scope: 'out', breaks_scenario: null, fixability: 'auto', area: 'a', reason: 'r' },
    { hasBugLabel: true, hasRepro: true, sizeLabel: 'XS' },
  );
  ok(v.candidate === false, 'scope:out is never a candidate');
}

// ── Part 5: runGate() — GitHub + classify + state wired through injected functions
(async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-fixer-gate-test-'));
  const statePath = path.join(stateDir, 'state.json');

  const issues = [
    issue(201, { labels: ['fixer:queued', 'size:S', 'bug'], body: 'Steps to reproduce:\n1. a\n2. b' }),
    issue(202, { labels: ['fixer:queued', 'size:M'], body: 'feature request, no repro' }),
    issue(203, { labels: ['size:S'] }), // never queued -> not pending
    issue(204, { labels: ['fixer:queued', 'scope:in'] }), // already gated -> not pending
  ];

  const labeled = [];
  const comments = [];
  const classifyFor = {
    201: { scope: 'in', breaks_scenario: 'recruiter/apply', fixability: 'auto', area: 'src/a.js', reason: 'local bug fix' },
    202: { scope: 'in', breaks_scenario: 'recruiter/apply', fixability: 'auto', area: 'src/b.js', reason: 'model says auto but not a repro\'d bug' },
  };

  // (a) dry-run: reports pending issues, touches neither labels/comments nor state.
  let r = await runGate({
    dryRun: true,
    token: 't',
    statePath,
    listIssues: async () => issues,
    classify: async (iss) => classifyFor[iss.number],
    addLabel: async (n, l) => labeled.push([n, l]),
    addComment: async (n, b) => comments.push([n, b]),
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.total === 4 && r.candidates.length === 2, 'dry-run selects both pending (201, 202), skips 203/204');
  ok(labeled.length === 0 && comments.length === 0 && !fs.existsSync(statePath), 'dry-run never labels/comments/writes state');

  // (b) real run: 201 (bug+repro+size:S) stays auto; 202 (no bug label, no repro, size:M) capped to human.
  r = await runGate({
    dryRun: false,
    token: 't',
    statePath,
    now: 5000,
    listIssues: async () => issues,
    classify: async (iss) => classifyFor[iss.number],
    addLabel: async (n, l) => labeled.push([n, l]),
    addComment: async (n, b) => comments.push([n, b]),
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.gatedAuto.length === 1 && r.gatedAuto[0] === 201, '201 (bug+repro+size:S) gated auto');
  ok(r.gatedHuman.length === 1 && r.gatedHuman[0] === 202, '202 (no bug label, no repro) capped to human despite model saying auto');
  ok(labeled.some(([n, l]) => n === 201 && l === 'scope:in'), '201 labeled scope:in');
  ok(labeled.some(([n, l]) => n === 201 && l === 'fixability:auto'), '201 labeled fixability:auto');
  ok(labeled.some(([n, l]) => n === 202 && l === 'needs-human'), '202 labeled needs-human');
  ok(comments.length === 2, 'both gated issues get a comment');

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  ok(saved.queued['201'] && saved.queued['201'].gate.fixability === 'auto', 'state records the gate verdict for 201');
  ok(saved.queued['202'] && saved.queued['202'].gate.fixability === 'human', 'state records the gate verdict for 202');

  // (c) second run: 201/202 now carry scope:in/out -> selectPendingGate excludes them, no re-classify.
  labeled.length = 0; comments.length = 0;
  let classifyCalls = 0;
  r = await runGate({
    dryRun: false,
    token: 't',
    statePath,
    listIssues: async () => issues.map(i => (i.number === 201
      ? issue(201, { labels: [...i.labels.map(l => l.name), 'scope:in', 'fixability:auto'] })
      : i.number === 202 ? issue(202, { labels: [...i.labels.map(l => l.name), 'scope:in', 'needs-human'] })
        : i)),
    classify: async () => { classifyCalls++; return {}; },
    addLabel: async (n, l) => labeled.push([n, l]),
    addComment: async (n, b) => comments.push([n, b]),
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.candidates.length === 0 && classifyCalls === 0, 'already-gated issues are never re-classified (idempotent)');

  // (d) classify() failure surfaces as an error, does not crash, does not label/comment that issue.
  r = await runGate({
    dryRun: false,
    token: 't',
    statePath: path.join(stateDir, 'fail-state.json'),
    listIssues: async () => [issue(301, { labels: ['fixer:queued', 'size:S', 'bug'], body: 'steps to reproduce: 1. x' })],
    classify: async () => { throw new Error('OpenRouter HTTP 500'); },
    addLabel: async (n, l) => labeled.push([n, l]),
    addComment: async (n, b) => comments.push([n, b]),
    logger: { log() {}, warn() {}, error() {} },
  });
  ok(r.errors.length === 1 && r.errors[0].includes('301') && r.gatedAuto.length === 0 && r.gatedHuman.length === 0,
    'classify failure is reported per-issue, gate does not crash');

  // (e) no token -> soft error, no crash.
  r = await runGate({ dryRun: true, token: null, statePath, listIssues: async () => issues });
  ok(r.errors.length === 1 && r.total === 0, 'missing token is a soft error, not a throw');

  console.log(`issue-fixer-gate.test.cjs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
