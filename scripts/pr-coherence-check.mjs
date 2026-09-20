#!/usr/bin/env node
// PR coherence check — asks an LLM whether all changed files share a single purpose.
//
// Output:
//   Coherent  → passes silently (exit 0)
//   INCOHERENT → posts a warning comment + adds label `mixed-changes` (exit 0 always)
//   API error  → fails open (exit 0, no comment)
//
// Content is processed in batches to avoid input overflow on large PRs:
//   • Small PRs (≤ STAT_ONLY_MAX_FILES):  stat + per-file diffs → single LLM call
//   • Large PRs (> STAT_ONLY_MAX_FILES):  stat only in single call
//                                          + up to MAX_BATCHES×MAX_BATCH_SIZE file diffs
//                                            each summarised separately → combine for final call
//
// Model chain (same pattern as autofix-openrouter.mjs):
//   hardcoded free models → OpenRouter-discovered free models → cheap paid fallback

import { execSync } from 'node:child_process';

// ── Limits ────────────────────────────────────────────────────────────────────
const STAT_CHAR_LIMIT       = 4000;  // truncate git diff --stat output here
const STAT_ONLY_MAX_FILES   = 15;    // below this: include full diffs in single call
const MAX_BATCH_SIZE        = 8;     // files per summarisation batch
const MAX_BATCHES           = 4;     // max batches (= up to 32 files read in detail)
const PER_FILE_DIFF_LIMIT   = 1500;  // chars per file diff inside a batch
const BATCH_SUMMARY_LIMIT   = 350;   // chars kept from each batch summary in final prompt
const PR_BODY_LIMIT         = 600;   // chars of PR body included in prompts

// ── Model chains ──────────────────────────────────────────────────────────────
const FREE_MODEL_CHAIN = [
  'deepseek/deepseek-v3-0324:free',
  'google/gemma-3-27b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
];
const CHEAP_PAID_FALLBACK = [
  'deepseek/deepseek-chat',      // ~$0.07/1M — DeepSeek V3 paid
  'google/gemini-flash-1.5-8b', // ~$0.04/1M — cheapest capable
  'openai/gpt-4o-mini',         // ~$0.15/1M — reliable last resort
];

const { OPENROUTER_API_KEY, GH_TOKEN, REPO, PR_NUMBER, BASE_BRANCH = 'main' } = process.env;

function log(tag, msg) { console.error(`[coherence ${tag}] ${msg}`); }

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }); }
  catch (e) { return ''; }
}

// ── Free model discovery (cached, same as autofix) ────────────────────────────
let _discovered = null;
async function discoverFreeModels() {
  if (_discovered !== null) return _discovered;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) { _discovered = []; return []; }
    const { data = [] } = await res.json();
    const known = new Set(FREE_MODEL_CHAIN);
    _discovered = data
      .filter(m => m.id.endsWith(':free') && !known.has(m.id))
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
      .map(m => m.id);
    log('model', `discovered ${_discovered.length} additional free models`);
  } catch { _discovered = []; }
  return _discovered;
}

// ── callModel: tries full chain, returns text or throws ───────────────────────
async function callModel(messages) {
  const chain = [...FREE_MODEL_CHAIN, ...(await discoverFreeModels()), ...CHEAP_PAID_FALLBACK];
  let lastErr;
  let paidReached = false;

  for (const model of chain) {
    const isPaid = CHEAP_PAID_FALLBACK.includes(model);
    if (isPaid && !paidReached) {
      paidReached = true;
      log('model', 'all free models exhausted — trying cheap paid fallback');
    }
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature: 0 }),
        signal: AbortSignal.timeout(isPaid ? 60_000 : 18_000),
      });
      if (!res.ok) {
        const body = await res.text();
        throw Object.assign(new Error(`HTTP ${res.status}: ${body.slice(0, 100)}`), { status: res.status });
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) { if (model !== FREE_MODEL_CHAIN[0]) log('model', `success with ${model}`); return text; }
      lastErr = new Error(`${model} returned empty response`);
      log('model', `${model} empty — trying next`);
    } catch (e) {
      lastErr = e;
      const retryable = [400, 404, 429, 503].includes(e.status)
        || e.name === 'AbortError' || e.name === 'TimeoutError';
      if (!retryable) throw e;
      log('model', `${model} ${e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timed out' : `HTTP ${e.status}`} — next`);
    }
  }
  throw lastErr;
}

// ── Get truncated file diff ───────────────────────────────────────────────────
function getFileDiff(filePath) {
  const diff = sh(`git diff origin/${BASE_BRANCH}...HEAD -- "${filePath}"`);
  return diff.slice(0, PER_FILE_DIFF_LIMIT);
}

// ── Summarise a batch of files in one LLM call ───────────────────────────────
async function summariseBatch(files, batchIndex, totalBatches) {
  const diffs = files
    .map(f => `=== ${f} ===\n${getFileDiff(f)}`)
    .filter(d => d.length > 20)
    .join('\n\n');

  if (!diffs) return `Changes in: ${files.join(', ')}`;

  log('batch', `batch ${batchIndex + 1}/${totalBatches}: summarising ${files.length} files…`);
  try {
    return await callModel([
      {
        role: 'system',
        content: 'In ONE short phrase (≤ 15 words, start with a verb), describe what these code changes accomplish. No explanations.',
      },
      { role: 'user', content: diffs.slice(0, MAX_BATCH_SIZE * PER_FILE_DIFF_LIMIT) },
    ]);
  } catch (e) {
    log('batch', `summarisation failed (${e.message.slice(0, 60)}) — using file list`);
    return `Changes in: ${files.join(', ')}`;
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────────
async function ghPost(path, body) {
  const [owner, repoName] = (REPO || '').split('/');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return res;
}

async function ensureLabel() {
  const [owner, repoName] = (REPO || '').split('/');
  const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/labels/mixed-changes`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(8_000),
  });
  if (checkRes.status === 404) {
    await ghPost('/labels', { name: 'mixed-changes', color: 'e4e669', description: 'PR contains unrelated changes from multiple concerns' });
    log('label', 'created mixed-changes label');
  }
}

async function postComment(body) {
  if (!PR_NUMBER || !REPO) return;
  await ghPost(`/issues/${PR_NUMBER}/comments`, { body });
}

async function addLabel() {
  if (!PR_NUMBER || !REPO) return;
  await ensureLabel();
  await ghPost(`/issues/${PR_NUMBER}/labels`, { labels: ['mixed-changes'] });
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (!OPENROUTER_API_KEY) { log('preflight', 'OPENROUTER_API_KEY not set — skipping'); process.exit(0); }
if (!REPO || !PR_NUMBER)  { log('preflight', 'REPO/PR_NUMBER not set — skipping');     process.exit(0); }

// 1. PR metadata
let prTitle = '', prBody = '';
try {
  const raw = execSync(`gh pr view ${PR_NUMBER} -R "${REPO}" --json title,body`, { encoding: 'utf8' });
  const meta = JSON.parse(raw);
  prTitle = meta.title || '';
  prBody  = (meta.body || '').slice(0, PR_BODY_LIMIT);
} catch { /* proceed without */ }

// 2. Changed files
const diffStat = sh(`git fetch origin ${BASE_BRANCH} --quiet 2>/dev/null; git diff --stat origin/${BASE_BRANCH}...HEAD`);
const statForPrompt = diffStat.slice(0, STAT_CHAR_LIMIT);

// Parse file list from stat lines (lines ending with " | N ±")
const changedFiles = diffStat
  .split('\n')
  .filter(l => l.includes('|'))
  .map(l => l.trim().split('|')[0].trim())
  .filter(Boolean);

log('main', `PR #${PR_NUMBER}: ${changedFiles.length} files changed`);

if (changedFiles.length === 0) {
  log('main', 'no changed files found — skipping');
  process.exit(0);
}

// 3. Build the context for the coherence check
let changesContext;

if (changedFiles.length <= STAT_ONLY_MAX_FILES) {
  // Small PR: include actual file diffs (all fit in one prompt)
  log('main', `small PR (${changedFiles.length} files) — including full diffs in single call`);
  const diffs = changedFiles
    .map(f => `=== ${f} ===\n${getFileDiff(f)}`)
    .join('\n\n');
  changesContext = `Diff stat:\n${statForPrompt}\n\nFile diffs:\n${diffs.slice(0, STAT_ONLY_MAX_FILES * PER_FILE_DIFF_LIMIT)}`;
} else {
  // Large PR: batch file diffs → summaries, then combine with stat
  log('main', `large PR (${changedFiles.length} files) — batching diffs, max ${MAX_BATCHES} batches`);

  // Filter out noise files (lock files, generated, etc.) for batching
  const interestingFiles = changedFiles.filter(f =>
    !f.endsWith('package-lock.json') && !f.endsWith('yarn.lock') &&
    !f.endsWith('.lock') && !f.includes('node_modules')
  ).slice(0, MAX_BATCHES * MAX_BATCH_SIZE);

  const batches = [];
  for (let i = 0; i < interestingFiles.length; i += MAX_BATCH_SIZE) {
    batches.push(interestingFiles.slice(i, i + MAX_BATCH_SIZE));
  }

  const summaries = await Promise.all(
    batches.map((batch, idx) => summariseBatch(batch, idx, batches.length))
  );

  const summaryText = summaries
    .map((s, i) => `Batch ${i + 1}: ${s.slice(0, BATCH_SUMMARY_LIMIT)}`)
    .join('\n');

  changesContext = `Diff stat (${changedFiles.length} files total):\n${statForPrompt}\n\nBatch summaries of key changes:\n${summaryText}`;
}

// 4. Final coherence check
log('main', 'running coherence check…');

const systemPrompt = `You are reviewing a pull request for conceptual coherence.

Given a PR title, description, and a summary of changed files, answer:
Can ALL of these changes be explained by ONE coherent task or purpose?

Reply with exactly ONE of:
- A single sentence starting with a verb that describes the coherent purpose (e.g. "Add retry logic to CI autofix pipeline")
- INCOHERENT: <concise reason why the changes don't belong together>

No other text. No explanations. No caveats.`;

const userPrompt = `PR title: "${prTitle}"
Branch description: "${prBody || '(empty)'}"

${changesContext}

Does ONE coherent purpose explain all these changes?`;

let verdict;
try {
  verdict = await callModel([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  log('main', `verdict: ${verdict.slice(0, 120)}`);
} catch (e) {
  log('main', `LLM unavailable (${e.message.slice(0, 80)}) — failing open`);
  process.exit(0);
}

// 5. Act on verdict
if (verdict.trimStart().toUpperCase().startsWith('INCOHERENT')) {
  const reason = verdict.replace(/^INCOHERENT:\s*/i, '').trim();
  log('main', `⚠️  INCOHERENT — posting warning comment`);

  const comment = [
    '⚠️ **Mixed-changes warning** (automated, non-blocking)',
    '',
    `This PR may contain unrelated changes: _${reason}_`,
    '',
    'If the changes are actually related, consider adding a clearer PR description explaining the common purpose. This check never blocks merge.',
  ].join('\n');

  try { await postComment(comment); } catch (e) { log('main', `comment failed: ${e.message.slice(0, 60)}`); }
  try { await addLabel(); } catch (e) { log('main', `label failed: ${e.message.slice(0, 60)}`); }
} else {
  log('main', '✅ coherent — no action needed');
}

// Always exit 0 — this check is informational only, never blocks CI
process.exit(0);
