'use strict';
// Issue-fixer — F2 slice: selects candidate GitHub issues for the "Фиксер" pipeline
// stage (issue -> relevance-gate -> PR). See ISSUES-TO-PR-SPEC.md §3.3/§6 in the
// owner's working project.
//
// This slice deliberately makes NO model calls and creates NO PRs — it only answers
// "which open issues are structurally eligible right now" and remembers what it has
// already queued, so a re-run does not re-report the same issue as new. The
// relevance-gate (F3) and execution (F4) are separate, later slices.
//
// Dedup / idempotency — a durable `state.json` under `~/agent-data/issue-fixer/`
// (global, not per-profile: issues live in one repo, not per-user). On a non-dry-run,
// a selected issue gets the `fixer:queued` label (so GitHub itself is a second source
// of truth if state is ever lost) and is recorded in state.queued.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { atomicJson } = require('./atomic-json');

const REPO = process.env.ISSUE_FIXER_REPO || 'trained-assist/trained-assist-agent';
const AGENT_DATA_DIR = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
const STATE_DIR = path.join(AGENT_DATA_DIR, 'issue-fixer');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

// Labels that take an issue out of consideration entirely (gate verdicts, lifecycle,
// epics, coherence guard). `fixer:queued` is here too: once queued, a plain re-run
// should not re-select it (F3/F4 will move it to pr-opened/failed, or an operator can
// remove the label to force a re-try).
const EXCLUDE_LABELS = new Set([
  'needs-architect', 'scope:out', 'fixer:queued', 'fixer:pr-opened', 'fixer:failed', 'mixed-changes',
]);
const EPIC_LABELS = ['feat', 'architecture', 'size:XL'];

// ── State ─────────────────────────────────────────────────────────────────────
function readState(statePath = STATE_PATH) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (s && s.queued && typeof s.queued === 'object') return s;
  } catch { /* missing or unreadable -> fresh state */ }
  return { queued: {} };
}
function writeState(state, statePath = STATE_PATH) {
  try {
    atomicJson(statePath, state);
  } catch (e) {
    console.warn(`[issue-fixer] could not persist state: ${e.message}`);
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────
function labelNames(issue) {
  return (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

function isEpic(names) {
  return EPIC_LABELS.every(l => names.includes(l));
}

// One open GitHub issue -> eligible for the fixer queue right now?
// Pure decision, no I/O — kept separate from `run` so it's trivially unit-testable.
function isCandidate(issue, state) {
  if (!issue || issue.state !== 'open') return false;
  if (issue.pull_request) return false; // GitHub issues API also returns PRs
  const names = labelNames(issue);
  if (names.some(l => EXCLUDE_LABELS.has(l))) return false;
  if (isEpic(names)) return false;
  // Not yet triaged (no size:* label) -> wait for issue-triage.yml, retry next tick.
  if (!names.some(l => l.startsWith('size:'))) return false;
  if (state.queued[String(issue.number)]) return false;
  return true;
}

function selectCandidates(issues, state) {
  return issues.filter(i => isCandidate(i, state)).sort((a, b) => a.number - b.number);
}

// ── GitHub ────────────────────────────────────────────────────────────────────
function resolveToken() {
  if (process.env.GITHUB_ISSUES_TOKEN) return process.env.GITHUB_ISSUES_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const url = execSync('git config --get remote.origin.url', { cwd: path.join(__dirname, '..') }).toString().trim();
    const m = url.match(/:\/\/[^:@/]+:([^@]+)@/) || url.match(/x-access-token:([^@]+)@/);
    if (m) return m[1];
  } catch { /* no token available */ }
  return null;
}

async function ghListOpenIssues(token, repo = REPO) {
  const issues = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'trained-assist-agent' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub list HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const batch = await res.json();
    issues.push(...batch);
    if (batch.length < 100) break;
  }
  return issues;
}

async function ghAddLabel(number, label, token, repo = REPO) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/labels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'trained-assist-agent',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ labels: [label] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub label HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function run({
  dryRun = false,
  token = resolveToken(),
  repo = REPO,
  now = Date.now(),
  statePath = STATE_PATH,
  listIssues = ghListOpenIssues,
  addLabel = ghAddLabel,
  logger = console,
} = {}) {
  const state = readState(statePath);
  const result = { repo, total: 0, candidates: [], queued: [], skipped: 0, errors: [] };

  let issues;
  try {
    if (!token) throw new Error('no GitHub token available');
    issues = await listIssues(token, repo);
  } catch (e) {
    result.errors.push(`list: ${e.message}`);
    return result;
  }

  result.total = issues.length;
  const candidates = selectCandidates(issues, state);
  result.skipped = issues.length - candidates.length;

  for (const issue of candidates) {
    result.candidates.push({ number: issue.number, title: issue.title, labels: labelNames(issue) });
    if (dryRun) continue;

    try {
      await addLabel(issue.number, 'fixer:queued', token, repo);
      state.queued[String(issue.number)] = { at: now, title: issue.title };
      result.queued.push(issue.number);
    } catch (e) {
      result.errors.push(`${issue.number}: ${e.message}`);
      logger.warn(`[issue-fixer] could not queue #${issue.number}: ${e.message}`);
    }
  }

  if (!dryRun && result.queued.length) writeState(state, statePath);
  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun }).then((r) => {
    if (r.errors.length && r.total === 0) {
      console.error(`[issue-fixer] fatal: ${r.errors.join('; ')}`);
      process.exit(1);
    }
    console.log(`[issue-fixer] repo=${r.repo} total=${r.total} candidates=${r.candidates.length}` +
      `${dryRun ? ' (dry-run)' : ''} queued=${r.queued.length} skipped=${r.skipped} errors=${r.errors.length}`);
    for (const c of r.candidates) console.log(`  + #${c.number} ${c.title} [${c.labels.join(',')}]`);
    for (const e of r.errors) console.log(`  ! ${e}`);
    process.exit(0);
  }).catch((e) => {
    console.error('[issue-fixer] fatal:', e.message);
    process.exit(1);
  });
}

module.exports = {
  isCandidate, selectCandidates, labelNames, isEpic,
  readState, writeState, resolveToken,
  ghListOpenIssues, ghAddLabel,
  run, REPO, STATE_PATH, EXCLUDE_LABELS, EPIC_LABELS,
};
