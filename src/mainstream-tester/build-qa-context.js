'use strict';
// Builds a rich context string for the QA agent Claude Code session.
// Reads: raw bugs from all test runs + GitHub issues/PRs with label mainstream-found.
// Output goes to stdout — consumed by mainstream-qa-agent.sh as the claude --print prompt.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const AGENT_DATA_DIR = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
const MAX_BUG_CHARS = 300;
const MAX_BUGS_SHOWN = 30;

function run(cmd, fallback = '') {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 15_000 }).trim(); }
  catch { return fallback; }
}

// Collect all bugs from all mainstream test runs
function collectBugs() {
  const bugs = {}; // hash → merged entry
  let dirs;
  try {
    dirs = fs.readdirSync(AGENT_DATA_DIR).filter(d => d.startsWith('mainstream-test-'));
  } catch { return bugs; }

  for (const dir of dirs) {
    const dedupPath = path.join(AGENT_DATA_DIR, dir, 'bugs-dedup.json');
    try {
      const dedup = JSON.parse(fs.readFileSync(dedupPath, 'utf8'));
      for (const [hash, entry] of Object.entries(dedup)) {
        if (!bugs[hash]) {
          bugs[hash] = { ...entry };
        } else {
          bugs[hash].occurrences = (bugs[hash].occurrences || 1) + (entry.occurrences || 1);
          if (!bugs[hash].lastSeenAt || entry.lastSeenAt > bugs[hash].lastSeenAt) {
            bugs[hash].lastSeenAt = entry.lastSeenAt;
          }
          if ((bugs[hash].examples?.length || 0) < 5 && entry.examples?.length) {
            bugs[hash].examples = [...(bugs[hash].examples || []), ...entry.examples].slice(0, 5);
          }
        }
      }
    } catch {}
  }
  return bugs;
}

// Extract bug hashes mentioned in a GitHub issue body
function extractHashesFromBody(body) {
  const matches = body?.matchAll(/`([0-9a-f]{16})`/g) || [];
  return [...matches].map(m => m[1]);
}

// Fetch GitHub issues with label mainstream-found
function fetchGithubIssues() {
  const raw = run(
    'gh issue list --label mainstream-found --state all --limit 50 --json number,title,state,body,createdAt,url',
    '[]'
  );
  try { return JSON.parse(raw); } catch { return []; }
}

// Fetch PRs with label mainstream-fix or mainstream-found
function fetchGithubPRs() {
  const raw = run(
    'gh pr list --label mainstream-fix --state all --limit 20 --json number,title,state,headRefName,url,createdAt',
    '[]'
  );
  try { return JSON.parse(raw); } catch { return []; }
}

// Get CI check status for a PR
function getPRChecks(prNumber) {
  const raw = run(`gh pr checks ${prNumber} --json name,state 2>/dev/null`, '[]');
  try {
    const checks = JSON.parse(raw);
    const failing = checks.filter(c => c.state === 'FAILURE' || c.state === 'ERROR').map(c => c.name);
    const pending = checks.filter(c => c.state === 'PENDING' || c.state === 'IN_PROGRESS').map(c => c.name);
    const passing = checks.filter(c => c.state === 'SUCCESS').length;
    return { failing, pending, passing, total: checks.length };
  } catch { return null; }
}

function formatBug(hash, entry) {
  const ex = (entry.examples || [])[0];
  const cat = entry.classification?.category || ex?.type || '?';
  const sev = entry.classification?.severity || '?';
  const title = entry.classification?.title || ex?.type || hash;
  const detail = (ex?.detail || entry.classification?.description || '').slice(0, MAX_BUG_CHARS);
  const task = (ex?.task || '').slice(0, 80);
  return [
    `hash: ${hash} | type: ${cat} | severity: ${sev} | occurrences: ${entry.occurrences}`,
    `title: ${title}`,
    task ? `trigger: "${task}"` : null,
    detail ? `detail: ${detail}` : null,
  ].filter(Boolean).join('\n');
}

async function main() {
  const bugs = collectBugs();
  const issues = fetchGithubIssues();
  const prs = fetchGithubPRs();

  // Figure out which bug hashes are already covered by existing issues
  const coveredHashes = new Set();
  for (const issue of issues) {
    for (const hash of extractHashesFromBody(issue.body)) {
      coveredHashes.add(hash);
    }
  }

  const newBugs = Object.entries(bugs).filter(([h]) => !coveredHashes.has(h));
  const allBugsSorted = newBugs.sort((a, b) => {
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sa = sevOrder[a[1].classification?.severity] ?? 2;
    const sb = sevOrder[b[1].classification?.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    return (b[1].occurrences || 1) - (a[1].occurrences || 1);
  });

  // Get CI status for open PRs
  const prsWithCI = [];
  for (const pr of prs.filter(p => p.state === 'OPEN')) {
    const ci = getPRChecks(pr.number);
    prsWithCI.push({ ...pr, ci });
  }

  // Build the context
  const lines = [];

  lines.push(`# QA Agent — ${new Date().toISOString()}`);
  lines.push('');
  lines.push('You are a QA project manager for the trained-assist-agent Telegram bot.');
  lines.push('Your job: pick the most impactful action(s) and execute them. You have full access to gh CLI, git, and the codebase.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Unprocessed bugs
  lines.push(`## Unprocessed bugs (${allBugsSorted.length} not yet in any issue)`);
  lines.push('');
  if (allBugsSorted.length === 0) {
    lines.push('_No new bugs — all accumulated bugs are covered by existing issues._');
  } else {
    for (const [hash, entry] of allBugsSorted.slice(0, MAX_BUGS_SHOWN)) {
      lines.push('```');
      lines.push(formatBug(hash, entry));
      lines.push('```');
    }
    if (allBugsSorted.length > MAX_BUGS_SHOWN) {
      lines.push(`_...and ${allBugsSorted.length - MAX_BUGS_SHOWN} more_`);
    }
  }

  lines.push('');
  lines.push(`## GitHub issues (label: mainstream-found) — ${issues.length} total`);
  lines.push('');
  if (issues.length === 0) {
    lines.push('_None yet._');
  } else {
    for (const iss of issues.slice(0, 20)) {
      const hashes = extractHashesFromBody(iss.body);
      lines.push(`- #${iss.number} [${iss.state}] ${iss.title}`);
      lines.push(`  ${iss.url} | bugs covered: ${hashes.length}`);
    }
  }

  lines.push('');
  lines.push(`## Open PRs (label: mainstream-fix) — ${prsWithCI.length} open`);
  lines.push('');
  if (prsWithCI.length === 0) {
    lines.push('_No open fix PRs._');
  } else {
    for (const pr of prsWithCI) {
      const ci = pr.ci;
      const ciStr = ci
        ? `CI: ${ci.passing}✓ ${ci.pending.length ? ci.pending.length + '⏳' : ''} ${ci.failing.length ? ci.failing.join(',') + ' ❌' : ''}`
        : 'CI: unknown';
      lines.push(`- #${pr.number} ${pr.title}`);
      lines.push(`  ${pr.url} | branch: ${pr.headRefName} | ${ciStr}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Instructions');
  lines.push('');
  lines.push('Choose the highest-impact action(s) and execute. Options, in rough priority order:');
  lines.push('');
  lines.push('1. **Fix failing CI on an existing mainstream-fix PR** — if a PR has failing checks, diagnose and fix. Commit to that branch.');
  lines.push('2. **Create a fix PR for a well-described issue** — if there\'s a clear, actionable issue with an obvious fix, implement and open a PR. Use branch `mainstream-fix/<issue-n>`, label `mainstream-fix`.');
  lines.push('3. **Create GitHub issue(s) for unprocessed bugs** — group related bugs into one issue when they share a root cause. Include bug hashes in backticks in the body so they\'re tracked. Label: `mainstream-found`.');
  lines.push('4. **Improve a poorly-described existing issue** — if an open issue is vague, update its body with more detail.');
  lines.push('5. **Skip noise** — if unprocessed bugs look like test infra issues (not real product bugs), note why and skip them.');
  lines.push('');
  lines.push('You can do multiple actions if they\'re small. Always report what you did.');
  lines.push('');
  lines.push('Repo: `trained-assist/trained-assist-agent`. Main branch: `main`.');

  process.stdout.write(lines.join('\n') + '\n');
}

main().catch(e => {
  process.stderr.write(`[build-qa-context] error: ${e.message}\n`);
  process.exit(1);
});
