// F6 — group executable issues by area into one PR (ISSUES-TO-PR-SPEC.md §6/§3).
// Flag, off by default (ISSUE_FIXER_GROUP_BY_AREA=1) — when off, groupExecutable
// must return singleton groups so runExecute's behaviour is byte-identical to the
// pre-F6 single-issue flow (covered by test/issue-fixer-execute.test.cjs, untouched).
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const fixer = require('../src/issue-fixer');
const {
  groupExecutable, buildGroupExecutePrompt, buildGroupPrBody, MARKER, MAX_GROUP_SIZE,
  runExecute,
} = fixer;

function issue(number, { title } = {}) {
  return { number, title: title || `Issue ${number}`, state: 'open', labels: [], body: `body ${number}` };
}

function stateWithAreas(map) {
  const state = { queued: {} };
  for (const [number, area] of Object.entries(map)) {
    state.queued[number] = area === null ? { at: 1 } : { at: 1, gate: { area } };
  }
  return state;
}

// ── groupExecutable ──────────────────────────────────────────────────────────
{
  const issues = [issue(1), issue(2), issue(3)];
  const state = stateWithAreas({ 1: 'src/x.js', 2: 'src/x.js', 3: 'src/y.js' });
  const off = groupExecutable(issues, state, false);
  ok(off.length === 3 && off.every((g) => g.length === 1), 'flag off -> always singleton groups, even with matching areas');
}
{
  const issues = [issue(1), issue(2), issue(3)];
  const state = stateWithAreas({ 1: 'src/x.js', 2: 'src/x.js', 3: 'src/y.js' });
  const on = groupExecutable(issues, state, true);
  ok(on.length === 2, 'flag on -> 1+2 share area src/x.js, 3 is alone -> 2 groups');
  const pair = on.find((g) => g.length === 2);
  ok(pair && pair.map((i) => i.number).sort().join(',') === '1,2', 'the shared-area pair is exactly issues 1+2');
}
{
  const issues = [issue(1), issue(2)];
  const state = stateWithAreas({ 1: 'unknown', 2: null });
  const on = groupExecutable(issues, state, true);
  ok(on.length === 2 && on.every((g) => g.length === 1), 'unknown/missing area never groups, even with each other');
}
{
  const issues = [issue(1), issue(2), issue(3), issue(4)];
  const state = stateWithAreas({ 1: 'src/x.js', 2: 'src/x.js', 3: 'src/x.js', 4: 'src/x.js' });
  const on = groupExecutable(issues, state, true);
  const sizes = on.map((g) => g.length).sort((a, b) => b - a);
  ok(sizes[0] === MAX_GROUP_SIZE && sizes.reduce((a, b) => a + b, 0) === 4, `group capped at MAX_GROUP_SIZE=${MAX_GROUP_SIZE}, no issue dropped`);
}

// ── buildGroupExecutePrompt / buildGroupPrBody ───────────────────────────────
{
  const issues = [issue(10, { title: 'A' }), issue(11, { title: 'B' })];
  const verdicts = { 10: { area: 'src/x.js', reason: 'shared bug A' }, 11: { area: 'src/x.js', reason: 'shared bug B' } };
  const prompt = buildGroupExecutePrompt(issues, verdicts, 'GOALS excerpt');
  ok(prompt.includes('#10') && prompt.includes('#11') && prompt.includes('body 10') && prompt.includes('body 11'), 'group prompt includes both issues');
  ok(prompt.includes('GOALS excerpt') && prompt.includes('2 связанных issue'), 'group prompt carries goals context + group framing');

  const prBody = buildGroupPrBody([11, 10], verdicts);
  ok(prBody.includes(MARKER([10, 11])) && prBody.includes(MARKER([11, 10])), 'PR body marker is order-independent (sorted internally)');
  ok(prBody.includes('Closes #10') && prBody.includes('Closes #11'), 'PR body closes both issues');
  ok(prBody.includes('shared bug A') && prBody.includes('shared bug B'), 'PR body surfaces both gate reasons');
}

// ── runExecute end-to-end with groupByArea:true ──────────────────────────────
(async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-fixer-group-test-'));
  const statePath = path.join(stateDir, 'state.json');

  // Seed state with F3 gate verdicts so groupExecutable has an area to key on.
  const seedState = {
    queued: {
      201: { at: 1, gate: { area: 'src/shared.js', reason: 'part one' } },
      202: { at: 1, gate: { area: 'src/shared.js', reason: 'part two' } },
      203: { at: 1, gate: { area: 'src/other.js', reason: 'unrelated' } },
    },
  };
  fs.writeFileSync(statePath, JSON.stringify(seedState));

  const issues = [
    issue(201, { title: 'fix shared part one' }),
    issue(202, { title: 'fix shared part two' }),
    issue(203, { title: 'fix other' }),
  ].map((i) => ({ ...i, labels: [{ name: 'scope:in' }, { name: 'fixability:auto' }] }));

  const labeled = [];
  const cloneCalls = [];
  const createdPrs = [];

  const r = await runExecute({
    dryRun: false,
    token: 't',
    statePath,
    groupByArea: true,
    now: 9000,
    listIssues: async () => issues,
    addLabel: async (n, l) => labeled.push([n, l]),
    addComment: async () => {},
    findExistingPr: async () => null,
    cloneAndBranch: async (id) => { cloneCalls.push(id); return { cwd: `/tmp/fake-${id}`, branch: `fix/issue-${id}` }; },
    runEngine: async () => ({ ok: true, log: 'edited' }),
    verify: async () => ({ ok: true, log: 'tests pass' }),
    push: async () => {},
    createPr: async ({ branch, title, body }) => {
      const number = 900 + createdPrs.length;
      createdPrs.push({ branch, title, body });
      return { number, url: `https://x/${number}` };
    },
    cleanup: () => {},
    logger: { log() {}, warn() {}, error() {} },
  });

  ok(cloneCalls.length === 2, '201+202 (same area) clone once as a group, 203 clones separately -> 2 clone calls total');
  ok(cloneCalls.includes('201-202') || cloneCalls.includes('202-201'), 'grouped clone id combines both issue numbers');
  ok(r.opened.sort((a, b) => a - b).join(',') === '201,202,203', 'all three issues end up opened');
  ok(createdPrs.length === 2, 'one PR for the 201+202 group, one PR for 203 alone -> 2 PRs total');

  const groupPr = createdPrs.find((p) => p.body.includes('Closes #201') && p.body.includes('Closes #202'));
  ok(groupPr, 'the grouped PR body closes both 201 and 202');
  ok(labeled.filter(([, l]) => l === 'fixer:pr-opened').length === 3, 'all three issues individually labeled fixer:pr-opened');

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  ok(saved.queued['201'].pr === saved.queued['202'].pr, '201 and 202 share the same recorded PR number');
  ok(saved.queued['203'].pr !== saved.queued['201'].pr, '203 got its own separate PR number');

  console.log(`issue-fixer-group.test.cjs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
