#!/usr/bin/env node
// Per-change coherence check (issue #898).
//
// Unlike pr-coherence-check.mjs (one question about the whole PR), this script
// asks the LLM about EACH changed file separately:
//   "PR goal + file diff → describe in 1-2 sentences how this change relates to
//    the goal. If the relation is unclear or unrelated — start with 'UNRELATED:'."
//
// Output:
//   all related      → green (exit 0)
//   any UNRELATED    → posts summary comment + `mixed-changes` label (exit 0)
//   >50% model-skips → neutral note (exit 0)
//   No description   → skip (exit 0)
//   Model errors     → skip that file, mark as `skipped`, continue
//   Inline comments  → optional, only when COHERENCE_INLINE=true (format A)
//
// Model chain per file (issue retry logic):
//   free model (deepseek-v4-flash:free) → error → cheap paid (deepseek-chat)
//   → paid also unavailable → skip file
//
// This check NEVER blocks merge. Always exits 0.

import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ── Limits ────────────────────────────────────────────────────────────────────
const PER_FILE_DIFF_LIMIT = 2000;  // max diff chars fed to the model per file
const MAX_FILES           = 25;    // cap per-file LLM calls per PR
const REASON_LIMIT        = 300;   // chars kept from UNRELATED reason
const RESULT_LINE_LIMIT   = 120;   // chars kept from model summary in the comment
const GOAL_ISSUE_LIMIT    = 600;   // chars of linked issue body included in goal
const MIN_DESCRIPTION_WORDS = 20;  // below this PR description → skip the check

// ── Model chain (per issue: free → cheap paid → skip) ────────────────────────
const FREE_MODEL = 'deepseek/deepseek-v4-flash-0731:free';
const FREE_MODEL_FALLBACK = 'deepseek/deepseek-v3-0324:free';
const PAID_CHAIN = [
  'deepseek/deepseek-chat',       // issue-specified paid retry
  'google/gemini-flash-1.5-8b',
  'openai/gpt-4o-mini',
];

const { OPENROUTER_API_KEY, GH_TOKEN, REPO, PR_NUMBER, BASE_BRANCH = 'main', COHERENCE_INLINE } = process.env;

function log(tag, msg) { console.error(`[per-file-coherence ${tag}] ${msg}`); }

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }); }
  catch (e) { return ''; }
}

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

/**
 * Build the per-file prompt. Template from the issue.
 * @param {{goal: string, filename: string, diff: string}} p
 * @returns {string}
 */
export function buildFilePrompt({ goal, filename, diff }) {
  return `PR goal: ${goal}

Changed file: ${filename}
Diff:
${(diff || '').slice(0, PER_FILE_DIFF_LIMIT)}

Describe in 1-2 sentences how this change relates to the PR goal.
If the relation is unclear or the change looks unrelated — start with "UNRELATED:".`;
}

const REFUSAL_RE = /(sorry|i (can'?t|cannot) |not (able|allowed)|не могу|не имею возможности|извините|к сожалению)/i;

/**
 * Parse an LLM verdict for a single file.
 * @param {string} text
 * @returns {{status: 'related'|'unrelated'|'refusal'|'junk', reason?: string}}
 */
export function parseVerdict(text) {
  const t = (text || '').trim();
  if (!t) return { status: 'junk' };
  if (/^UNRELATED:/i.test(t)) return { status: 'unrelated', reason: t.replace(/^UNRELATED:\s*/i, '').slice(0, REASON_LIMIT) };
  if (REFUSAL_RE.test(t)) return { status: 'refusal' };
  if (t.length < 15) return { status: 'junk' };
  return { status: 'related' };
}

/**
 * Summarise per-file results into metrics.
 * @param {Array<{status: string, reason?: string, skipReason?: string}>} results
 * @returns {{total: number, checked: number, skipped: number, unrelated: number, failed: number, modelSkipped: number, neutral: boolean}}
 */
export function computeMetrics(results) {
  const total = results.length;
  const checked = results.filter(r => r.status === 'related' || r.status === 'unrelated').length;
  const unrelated = results.filter(r => r.status === 'unrelated').length;
  const failed = results.filter(r => r.status === 'refusal' || r.status === 'junk').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const modelSkipped = results.filter(r => r.status === 'skipped' && r.skipReason === 'model').length;
  return {
    total,
    checked,
    skipped,
    unrelated,
    failed,
    modelSkipped,
    neutral: total > 0 && modelSkipped / total > 0.5,
  };
}

/**
 * First line number of the new side of the diff (for inline comments).
 * Parses `@@ -a,b +c,d @@` hunks; returns 0 when nothing maps (pure deletions).
 * @param {string} diff
 * @returns {number}
 */
export function firstNewLine(diff) {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(diff || '');
  return m ? Number(m[1]) : 0;
}

/**
 * Find a linked issue number in PR text ("fixes #123", "closes #123", "#123").
 * @param {string} text
 * @returns {number|null}
 */
export function extractLinkedIssue(text) {
  const m = /(?:fixes|closes|resolves|refs|relates to)[\s:]*#(\d+)/i.exec(text || '');
  if (m) return Number(m[1]);
  const bare = /(?:^|[^\w#])#(\d+)/.exec(text || '');
  return bare ? Number(bare[1]) : null;
}

// ── Model call: free → cheap paid → skip ──────────────────────────────────────

async function chat(model, messages, timeoutMs) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`HTTP ${res.status}: ${body.slice(0, 100)}`), { status: res.status });
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${model} returned empty response`);
  return text;
}

/**
 * One attempt on a model. Returns text on success, throws on any failure.
 */
async function callFileModel(messages) {
  let lastErr;
  for (const [model, timeout] of [[FREE_MODEL, 18_000], [FREE_MODEL_FALLBACK, 18_000]]) {
    try {
      const text = await chat(model, messages, timeout);
      if (model !== FREE_MODEL) log('model', `success with ${model}`);
      return text;
    } catch (e) {
      lastErr = e;
      log('model', `${model} failed (${(e.message || '').slice(0, 60)})`);
    }
  }
  log('model', 'free models unavailable — trying cheap paid fallback');
  for (const model of PAID_CHAIN) {
    try {
      const text = await chat(model, messages, 45_000);
      log('model', `success with ${model} (paid fallback)`);
      return text;
    } catch (e) {
      lastErr = e;
      log('model', `${model} failed (${(e.message || '').slice(0, 60)})`);
    }
  }
  throw lastErr;
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function ghRequest(method, path, body) {
  const [owner, repoName] = (REPO || '').split('/');
  if (!owner || !repoName) throw new Error('REPO must be owner/name');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}${path}`, {
    method,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path} → HTTP ${res.status}`), { status: res.status });
  return res;
}

async function ensureLabel() {
  try { await ghRequest('GET', '/labels/mixed-changes'); }
  catch (e) {
    if (e.status !== 404) return;
    await ghRequest('POST', '/labels', { name: 'mixed-changes', color: 'e4e669', description: 'PR contains unrelated changes from multiple concerns' });
    log('label', 'created mixed-changes label');
  }
}

async function postComment(body) {
  if (!PR_NUMBER || !REPO) return;
  await ghRequest('POST', `/issues/${PR_NUMBER}/comments`, { body });
}

async function addLabel() {
  if (!PR_NUMBER || !REPO) return;
  await ensureLabel();
  await ghRequest('POST', `/issues/${PR_NUMBER}/labels`, { labels: ['mixed-changes'] });
}

async function postInlineComment(filename, body) {
  if (!PR_NUMBER || !REPO || !COHERENCE_INLINE) return;
  const line = firstNewLine(sh(`git diff origin/${BASE_BRANCH}...HEAD -- "${filename}"`));
  if (!line) { log('inline', `${filename}: no new-side line to attach to — skipping inline`); return; }
  const commitId = sh('git rev-parse HEAD').trim();
  await ghRequest('POST', `/pulls/${PR_NUMBER}/comments`, { body, path: filename, commit_id: commitId, line });
  log('inline', `${filename}: inline comment at line ${line}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!OPENROUTER_API_KEY) { log('preflight', 'OPENROUTER_API_KEY not set — skipping'); return; }
  if (!REPO || !PR_NUMBER) { log('preflight', 'REPO/PR_NUMBER not set — skipping'); return; }

  // 1. PR metadata
  let prTitle = '', prBody = '', headRef = '';
  try {
    const raw = execSync(`gh pr view ${PR_NUMBER} -R "${REPO}" --json title,body,headRefName`, { encoding: 'utf8' });
    const meta = JSON.parse(raw);
    prTitle = meta.title || '';
    prBody = meta.body || '';
    headRef = meta.headRefName || '';
  } catch { /* proceed without */ }

  // Skip fix/ci-* branches — technical PRs with auto-generated descriptions.
  if (/^fix\/ci-/.test(headRef)) { log('preflight', `fix/ci-* branch (${headRef}) — skipping`); return; }

  // Skip PRs without a meaningful description — nothing to check coherence against.
  const wordCount = (prBody || '').trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_DESCRIPTION_WORDS) {
    log('preflight', `PR description too short (${wordCount} words < ${MIN_DESCRIPTION_WORDS}) — skipping`);
    return;
  }

  // Linked issue body (optional goal context).
  let issueContext = '';
  const linkedIssue = extractLinkedIssue(prBody);
  if (linkedIssue) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${linkedIssue}`, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const data = await res.json();
        issueContext = (data.body || '').slice(0, GOAL_ISSUE_LIMIT);
        log('issue', `linked issue #${linkedIssue} (${issueContext.length} chars of body)`);
      }
    } catch { /* optional — proceed without */ }
  }
  const goal = [prTitle, issueContext ? `Issue: ${issueContext}` : ''].filter(Boolean).join('\n');

  // 2. Changed files
  sh(`git fetch origin ${BASE_BRANCH} --quiet 2>/dev/null`);
  const diffStat = sh(`git diff --stat origin/${BASE_BRANCH}...HEAD`);
  const changedFiles = diffStat
    .split('\n')
    .filter(l => l.includes('|'))
    .map(l => l.trim().split('|')[0].trim())
    .filter(Boolean);

  log('main', `PR #${PR_NUMBER}: ${changedFiles.length} files changed`);
  if (changedFiles.length === 0) { log('main', 'no changed files — skipping'); return; }

  const files = changedFiles.slice(0, MAX_FILES);
  if (changedFiles.length > MAX_FILES) {
    log('main', `more than ${MAX_FILES} files — capping per-file analysis, ${changedFiles.length - MAX_FILES} skipped (cap)`);
  }

  const results = [];
  for (const [i, filename] of files.entries()) {
    const diff = sh(`git diff origin/${BASE_BRANCH}...HEAD -- "${filename}"`).slice(0, PER_FILE_DIFF_LIMIT);
    if (!diff.trim()) { results.push({ file: filename, status: 'skipped', skipReason: 'no-diff' }); continue; }

    log('file', `[${i + 1}/${files.length}] checking ${filename}`);
    let text;
    try {
      text = await callFileModel([
        { role: 'system', content: 'You review whether a single file change is coherent with the PR goal. Reply with 1-2 sentences, or "UNRELATED: <reason>" if the change does not relate to the goal.' },
        { role: 'user', content: buildFilePrompt({ goal, filename, diff }) },
      ]);
    } catch (e) {
      log('file', `${filename}: all models failed (${(e.message || '').slice(0, 60)}) — skipping`);
      results.push({ file: filename, status: 'skipped', skipReason: 'model' });
      continue;
    }

    const verdict = parseVerdict(text);
    log('file', `${filename}: ${verdict.status}${verdict.reason ? ' — ' + verdict.reason : ''}`);
    results.push({ file: filename, status: verdict.status, reason: verdict.reason });
  }

  // 3. Metrics
  const m = computeMetrics(results);
  log('metrics', `checked=${m.checked} skipped=${m.skipped} unrelated=${m.unrelated} failed=${m.failed} modelSkipped=${m.modelSkipped} neutral=${m.neutral}`);

  const hasUnrelated = m.unrelated > 0;
  const commentLines = [];
  for (const r of results) {
    if (r.status === 'related') commentLines.push(`- \`${r.file}\` ✅ related`);
    else if (r.status === 'unrelated') commentLines.push(`- \`${r.file}\` ⚠️ UNRELATED — ${r.reason || 'no reason given'}`);
    else if (r.status === 'skipped') commentLines.push(`- \`${r.file}\` ⏭️ skipped (${r.skipReason || 'unknown'})`);
    else commentLines.push(`- \`${r.file}\` ❓ unclear (${r.status})`);
  }

  let summary = `## 🔍 Per-file coherence check (informational, non-blocking)\n\n`;
  summary += `Checked **${m.checked}** files, skipped **${m.skipped}**, unrelated **${m.unrelated}**, unclear **${m.failed}**.\n\n`;
  if (m.neutral) summary += `> ⚪ Neutral: >50% of files skipped due to model errors — treat results with caution.\n\n`;
  summary += commentLines.join('\n') + '\n\n';
  summary += `> This check never blocks merge.`;
  if (hasUnrelated) {
    summary += `\n> If the changes are actually related, clarify the PR description so the common goal is obvious.`;
  }

  if (hasUnrelated) {
    log('main', `⚠️  ${m.unrelated} unrelated file(s) — posting summary comment + mixed-changes label`);
    try { await postComment(summary); } catch (e) { log('comment', `failed: ${e.message.slice(0, 60)}`); }
    try { await addLabel(); } catch (e) { log('label', `failed: ${e.message.slice(0, 60)}`); }

    // Format A (optional): inline comments on the unrelated files.
    if (COHERENCE_INLINE) {
      for (const r of results) {
        if (r.status !== 'unrelated') continue;
        try {
          await postInlineComment(r.file, `⚠️ **UNRELATED to PR goal**: ${r.reason || 'this change does not relate to the PR goal'}`);
        } catch (e) { log('inline', `${r.file}: failed (${e.message.slice(0, 60)})`); }
      }
    }
  } else if (m.neutral) {
    log('main', 'neutral — posting informational comment');
    try { await postComment(summary); } catch (e) { log('comment', `failed: ${e.message.slice(0, 60)}`); }
  } else {
    log('main', '✅ all files related to PR goal — no action needed');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .catch(e => log('fatal', e.message))
    .finally(() => process.exit(0));
}