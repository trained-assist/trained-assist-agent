'use strict';
// Curator agent — runs on a cron schedule, reads all accumulated bugs,
// uses an LLM to intelligently group them and decide what GitHub issues to create.
//
// Unlike the bug-classifier (which is deterministic per-bug), the curator
// sees the full picture and can:
//   - Create 1 issue for 1 critical bug
//   - Create 1 issue for 50 related bugs
//   - Skip noise / false positives
//   - Merge similar bugs under one theme
//
// State: ~/agent-data/mainstream-curator/state.json
//   { processedHashes: {hash: {issueUrl, processedAt}}, lastRunAt }

const fs = require('fs');
const path = require('path');
const os = require('os');

const GITHUB_REPO = 'trained-assist/trained-assist-agent';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CURATOR_DIR = path.join(os.homedir(), 'agent-data', 'mainstream-curator');
const STATE_FILE = path.join(CURATOR_DIR, 'state.json');
const CURATOR_LOG = path.join(CURATOR_DIR, 'curator.log');

// Model: capable but cheap — DeepSeek V3 is good at structured reasoning
const CURATOR_MODEL = 'deepseek/deepseek-chat';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(CURATOR_DIR, { recursive: true });
    fs.appendFileSync(CURATOR_LOG, line + '\n');
  } catch {}
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { processedHashes: {}, lastRunAt: null }; }
}

function saveState(state) {
  fs.mkdirSync(CURATOR_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Collect all bugs-dedup.json files from all mainstream test runs
function collectAllBugs() {
  const agentDataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const bugs = {};
  let dirs;
  try {
    dirs = fs.readdirSync(agentDataDir).filter(d => d.startsWith('mainstream-test-'));
  } catch { return bugs; }

  for (const dir of dirs) {
    const dedupPath = path.join(agentDataDir, dir, 'bugs-dedup.json');
    try {
      const dedup = JSON.parse(fs.readFileSync(dedupPath, 'utf8'));
      for (const [hash, entry] of Object.entries(dedup)) {
        if (!bugs[hash]) {
          bugs[hash] = { ...entry };
        } else {
          // Merge: sum occurrences, keep more examples
          bugs[hash].occurrences += entry.occurrences;
          bugs[hash].lastSeenAt = entry.lastSeenAt || bugs[hash].lastSeenAt;
          if ((bugs[hash].examples?.length || 0) < 5) {
            bugs[hash].examples = [...(bugs[hash].examples || []), ...(entry.examples || [])].slice(0, 5);
          }
        }
      }
    } catch {}
  }
  return bugs;
}

async function callLLM(prompt, openrouterKey) {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://recruiter-assistant.ru',
    },
    body: JSON.stringify({
      model: CURATOR_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`LLM returned no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

async function createGithubIssue(title, body, githubToken) {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'trained-assist-agent/mainstream-curator',
      'Accept': 'application/vnd.github+json',
    },
    body: JSON.stringify({ title, body, labels: ['mainstream-found'] }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json();
  if (resp.status >= 400) throw new Error(`GitHub ${resp.status}: ${data.message}`);
  return data.html_url;
}

function buildBugSummary(hash, entry) {
  const ex = (entry.examples || []).slice(0, 2);
  const lines = [
    `hash: ${hash}`,
    `type: ${entry.classification?.category || entry.examples?.[0]?.type || '?'}`,
    `severity: ${entry.classification?.severity || '?'}`,
    `occurrences: ${entry.occurrences}`,
    `title: ${entry.classification?.title || '—'}`,
    `description: ${entry.classification?.description || '—'}`,
  ];
  if (ex.length) {
    lines.push(`example task: "${(ex[0].task || '').slice(0, 80)}"`);
    lines.push(`example detail: "${(ex[0].detail || '').slice(0, 150)}"`);
  }
  return lines.join('\n');
}

function buildIssueBody(group, allBugs) {
  const lines = [
    `**Detected by:** mainstream tester (automated curator)`,
    `**Total occurrences across runs:** ${group.hashes.reduce((s, h) => s + (allBugs[h]?.occurrences || 1), 0)}`,
    '',
    `## Problem`,
    '',
    group.description,
    '',
    `## Bugs in this group`,
    '',
  ];

  for (const hash of group.hashes) {
    const entry = allBugs[hash];
    if (!entry) continue;
    const ex = (entry.examples || [])[0];
    lines.push(`### ${entry.classification?.title || hash}`);
    lines.push(`- **Type:** ${ex?.type || '?'} | **Occurrences:** ${entry.occurrences}`);
    if (ex?.task) lines.push(`- **Trigger:** \`${ex.task.slice(0, 100)}\``);
    if (ex?.detail) {
      lines.push('- **Response excerpt:**');
      lines.push('```');
      lines.push(ex.detail.slice(0, 400));
      lines.push('```');
    }
    lines.push(`- **Dedup hash:** \`${hash}\``);
    lines.push('');
  }

  return lines.join('\n');
}

async function run({ openrouterKey, githubToken, dryRun = false }) {
  log('Curator started', dryRun ? '(dry-run)' : '');

  const state = loadState();
  const allBugs = collectAllBugs();

  // Filter to unprocessed bugs (no issue created yet)
  const unprocessed = Object.entries(allBugs).filter(
    ([hash]) => !state.processedHashes[hash]
  );

  if (unprocessed.length === 0) {
    log('No new bugs to process');
    state.lastRunAt = new Date().toISOString();
    saveState(state);
    return;
  }

  log(`Found ${unprocessed.length} unprocessed bugs across all runs`);

  // Build compact bug summaries for LLM
  const bugSummaries = unprocessed.map(([hash, entry]) => buildBugSummary(hash, entry)).join('\n\n---\n\n');

  const prompt = `You are a senior QA engineer triaging bugs found by an automated integration tester.
The tester sends messages to an AI assistant Telegram bot and watches for errors.

Here are ${unprocessed.length} bugs found so far (not yet turned into GitHub issues):

${bugSummaries}

Your task: decide how to group these bugs into GitHub issues.

Rules:
- You can group many related bugs into ONE issue (e.g. "agent always times out on step 3")
- You can create ONE issue per bug (for unique, severe problems)
- You can SKIP bugs that look like false positives or noise (e.g. test infra issues, not real bugs)
- Prioritize: critical/high severity first, known patterns second
- If you see the same root cause across different bug types, group them
- Keep issue titles short and actionable

Reply with JSON only:
{
  "issues": [
    {
      "title": "Short actionable issue title (max 80 chars)",
      "description": "1-3 sentences describing the root cause and impact",
      "hashes": ["hash1", "hash2"],
      "severity": "critical|high|medium|low"
    }
  ],
  "skip": ["hash3", "hash4"],
  "skipReason": "optional explanation of why skipped bugs are noise"
}`;

  let decision;
  try {
    decision = await callLLM(prompt, openrouterKey);
  } catch (e) {
    log('LLM call failed:', e.message);
    return;
  }

  const issues = decision.issues || [];
  const skipped = decision.skip || [];

  log(`LLM decision: ${issues.length} issues to create, ${skipped.length} bugs to skip`);
  if (decision.skipReason) log('Skip reason:', decision.skipReason);

  // Mark skipped bugs as processed
  for (const hash of skipped) {
    state.processedHashes[hash] = { skipped: true, processedAt: new Date().toISOString() };
  }

  // Create GitHub issues
  for (const group of issues) {
    const body = buildIssueBody(group, allBugs);
    log(`Creating issue: "${group.title}" (${group.hashes?.length || 0} bugs)`);

    if (!dryRun && githubToken) {
      try {
        const url = await createGithubIssue(group.title, body, githubToken);
        log(`Issue created: ${url}`);
        for (const hash of group.hashes || []) {
          state.processedHashes[hash] = { issueUrl: url, processedAt: new Date().toISOString() };
        }
      } catch (e) {
        log('GitHub issue creation failed:', e.message);
      }
    } else if (dryRun) {
      log('[dry-run] Would create issue:', group.title);
      log('[dry-run] Hashes:', (group.hashes || []).join(', '));
      for (const hash of group.hashes || []) {
        state.processedHashes[hash] = { dryRun: true, processedAt: new Date().toISOString() };
      }
    } else {
      log('GITHUB_ISSUES_TOKEN not set — skipping issue creation');
    }
  }

  state.lastRunAt = new Date().toISOString();
  saveState(state);
  log('Curator done. Issues created:', issues.length, '| Skipped:', skipped.length);
}

module.exports = { run };

// CLI entry point
if (require.main === module) {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const githubToken = process.env.GITHUB_ISSUES_TOKEN || '';
  const dryRun = process.argv.includes('--dry-run');

  if (!openrouterKey) {
    console.error('[curator] OPENROUTER_API_KEY required');
    process.exit(1);
  }

  run({ openrouterKey, githubToken, dryRun }).catch(e => {
    console.error('[curator] Fatal:', e.message);
    process.exit(1);
  });
}
