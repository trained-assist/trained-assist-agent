#!/usr/bin/env node
// CI auto-fix pipeline — three layers:
//
//   Pre-stage (deterministic, no AI):
//     A. Out-of-date branch  → git merge origin/main
//     B. Missing permissions → patch workflow YAML
//     C. Cloudflare DO conflict → bail with precise diagnosis
//
//   AI stages (OpenRouter free models, only if pre-stage didn't apply):
//     Stage 1 (deepseek-v4-flash:free)    — diagnose: root cause + files to examine
//     Stage 2 (nemotron-3-super-120b:free) — contextualize: read real files, describe changes
//     Stage 3 (nemotron-3-ultra-550b:free) — patch: write the unified diff
//
// On success: creates a new fix/ci-* branch + PR (never pushes to original branch).
// The new PR auto-merges when CI passes; ci-fix-cleanup.yml then closes the original PR.
// Exits 0 on success (fix PR created), 1 on failure.
//
// ── Lifecycle ─────────────────────────────────────────────────────────────────
//
// Every action is logged as a GitHub PR comment with the prefix "pr-fixer:".
// GitHub IS the audit log — no external data model needed.
//
// Stage 0 (reasoning)   — understand WHY the PR exists before touching anything.
//                          If unclear → comment + label + stop. Never patch blindly.
// Pre-stage A/B/C       — deterministic fixes (no AI needed).
// Stage 1/2/3 (AI)      — OpenRouter free models.
//
// ── Stats (category taxonomy) ──────────────────────────────────────────────────
// Every run writes ci-fixer-stats.json + appends to $GITHUB_STEP_SUMMARY.
// Categories (used to decide when to escalate to a paid-model second pass):
//
//   success:pre_a_merge              branch was behind → git merge fixed it
//   success:pre_a_conflict_resolved  merge had conflicts → AI resolved them using PR purpose
//   success:pre_b_permissions        job lacked permissions → workflow YAML patched
//   success:ai                       3-stage free-model pipeline fixed it
//
//   fail:stage0_ambiguous       PR purpose unclear — skipping to avoid blind fix
//   fail:cloudflare_do          Cloudflare DO migration conflict (needs human)
//   fail:merge_conflict         git merge had conflicts and AI could not resolve them
//   fail:ai_conflict_resolution AI tried to resolve conflicts but failed/left markers
//   fail:permissions_no_workflow permission error but no patchable workflow found
//   fail:race_pr_closed         PR was already closed/merged before we started
//   fail:ai_no_diagnose         Stage 1 could not identify root cause
//   fail:ai_low_confidence      Stage 1 diagnosed but confidence too low to patch
//   fail:ai_cannot_fix          Stage 3 returned CANNOT_FIX        ← paid-tier candidate
//   fail:ai_corrupt_patch       Stage 3 produced malformed diff     ← paid-tier candidate
//   fail:ai_tests_fail          patch applied but tests still fail  ← paid-tier candidate
//   fail:ai_model_error         OpenRouter API error (network/quota/model gone)
//   fail:other                  unexpected error
//
// ── Batch mode ──────────────────────────────────────────────────────────────────
// Set RUN_ID=0 (or BATCH_MODE=true) to run without a CI log reference.
// In batch mode the script skips the CI log fetch and always tries pre-stage A
// (merge + AI conflict resolution). Use batch-fix-prs.yml workflow to trigger
// multiple PRs at once.

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const LOG_CHAR_LIMIT = 12000;
const DIFF_CHAR_LIMIT = 10000;
const FILE_CHAR_LIMIT = 8000;
const MAX_FILES = 8;

// Free-tier model chain — tried first on 404/429/503 (first success wins).
// After this chain is exhausted, callModel auto-discovers remaining free models
// from OpenRouter's /models API, then falls back to cheap paid models.
const STAGE0_MODEL_CHAIN = [
  'deepseek/deepseek-v3-0324:free',
  'google/gemma-3-12b-it:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
];
// Cheap paid models — last resort after all free options exhausted.
// Costs ~$0.04–0.15 per 1M input tokens (negligible for small conflict resolution prompts).
const CHEAP_PAID_FALLBACK = [
  'deepseek/deepseek-chat',        // ~$0.07/1M — DeepSeek V3 paid, very capable
  'google/gemini-flash-1.5-8b',   // ~$0.04/1M — cheapest capable model
  'openai/gpt-4o-mini',           // ~$0.15/1M — reliable fallback
];

const STAGE0_MODEL = STAGE0_MODEL_CHAIN[0];
const STAGE0_FALLBACK_MODEL = STAGE0_MODEL_CHAIN[1]; // kept for compat, chain handles the rest
const STAGE1_MODEL = 'deepseek/deepseek-v4-flash-0731:free';
const STAGE2_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
const STAGE3_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

const PR_FIXER_PREFIX = 'pr-fixer:';

const {
  OPENROUTER_API_KEY,
  GH_TOKEN,
  RUN_ID,
  REPO,
  PR_NUMBER,
  ORIGINAL_BRANCH = '',
  BASE_BRANCH = 'main',
  GITHUB_STEP_SUMMARY = '',
} = process.env;

// Batch mode: RUN_ID=0 means "no CI run to reference — just try merge + conflict resolution"
const BATCH_MODE = RUN_ID === '0' || process.env.BATCH_MODE === 'true';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
}

function log(stage, msg) {
  console.error(`[autofix ${stage}] ${msg}`);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function writeStats(category, extra = {}) {
  const stats = {
    ts: new Date().toISOString(),
    repo: REPO || '',
    pr: PR_NUMBER || '',
    branch: ORIGINAL_BRANCH || '',
    run_id: RUN_ID || '',
    category,
    ...extra,
  };

  // Machine-readable JSON artifact — aggregatable later via GitHub Actions API
  try { writeFileSync('ci-fixer-stats.json', JSON.stringify(stats, null, 2)); } catch { /* best effort */ }

  // Human-readable Step Summary visible in every GitHub Actions run
  if (GITHUB_STEP_SUMMARY) {
    const icon = category.startsWith('success') ? '✅' : '❌';
    const rows = [
      ['PR', `#${stats.pr}`],
      ['Branch', `\`${stats.branch}\``],
      ['Repo', stats.repo],
      extra.problem ? ['Root cause', extra.problem.slice(0, 200)] : null,
      extra.reason  ? ['Reason',     extra.reason.slice(0, 200)]  : null,
      extra.fix     ? ['Fix',        extra.fix.slice(0, 200)]     : null,
      extra.hint    ? ['Hint',       extra.hint.slice(0, 300)]    : null,
    ].filter(Boolean);

    const tableRows = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
    const md = [
      `## ${icon} CI Fixer — \`${category}\``,
      '',
      '| Field | Value |',
      '|-------|-------|',
      tableRows,
      '',
      '<details><summary>Full JSON</summary>',
      '',
      '```json',
      JSON.stringify(stats, null, 2),
      '```',
      '</details>',
      '',
    ].join('\n');

    try { appendFileSync(GITHUB_STEP_SUMMARY, md); } catch { /* best effort */ }
  }

  console.error(`[autofix stats] ${category} | pr=${stats.pr} | branch=${stats.branch}`);
}

function failWithStats(category, reason, extra = {}) {
  writeStats(category, { reason, ...extra });
  console.error(`[autofix] giving up (${category}): ${reason}`);
  process.exit(1);
}

// Post a comment to the original PR — GitHub is our audit log.
// All comments carry the PR_FIXER_PREFIX so humans can filter them.
async function prComment(body) {
  if (!PR_NUMBER || !REPO) return;
  const text = `${PR_FIXER_PREFIX} ${body}`;
  writeFileSync('__comment.txt', text);
  try {
    sh(`gh pr comment ${PR_NUMBER} -R "${REPO}" --body-file __comment.txt`);
  } catch { /* best effort — never let a comment failure abort the fix */ }
  try { unlinkSync('__comment.txt'); } catch {}
}

async function callModel(model, messages, json = false) {
  const tryModel = async (m) => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: m,
        messages,
        temperature: 0,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(CHEAP_PAID_FALLBACK.includes(m) ? 60_000 : 20_000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error(`OpenRouter HTTP ${res.status}: ${body}`), { status: res.status });
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  };

  // For STAGE0 calls: try full chain (hardcoded free → discovered free → cheap paid)
  const chain = model === STAGE0_MODEL
    ? [...STAGE0_MODEL_CHAIN, ...(await discoverFreeModels()), ...CHEAP_PAID_FALLBACK]
    : [model];

  let lastErr;
  let reachedPaid = false;
  for (const m of chain) {
    const isPaid = CHEAP_PAID_FALLBACK.includes(m);
    try {
      if (m !== model) {
        if (isPaid && !reachedPaid) {
          reachedPaid = true;
          log('model', 'all free models exhausted — falling back to cheap paid models');
        }
        log('model', `trying ${m}${isPaid ? ' (paid)' : ''}`);
      }
      const result = await tryModel(m);
      if (result) return result; // non-empty → success
      lastErr = new Error(`${m} returned empty response`);
      log('model', `${m} empty — trying next`);
    } catch (e) {
      lastErr = e;
      const isRetryable = [400, 403, 404, 429, 503].includes(e.status)
        || e.name === 'AbortError' || e.name === 'TimeoutError';
      if (!isRetryable) throw e;
      if (e.name === 'AbortError' || e.name === 'TimeoutError') log('model', `${m} timed out — trying next`);
    }
  }
  throw lastErr;
}

// Cached list of free models discovered from OpenRouter /models (fetched once per run)
let _discoveredFreeModels = null;
async function discoverFreeModels() {
  if (_discoveredFreeModels !== null) return _discoveredFreeModels;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { _discoveredFreeModels = []; return []; }
    const { data = [] } = await res.json();
    const known = new Set(STAGE0_MODEL_CHAIN);
    _discoveredFreeModels = data
      .filter(m => m.id.endsWith(':free') && !known.has(m.id))
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
      .map(m => m.id);
    log('model', `discovered ${_discoveredFreeModels.length} additional free models from OpenRouter`);
  } catch (e) {
    log('model', `free model discovery failed: ${e.message.slice(0, 60)} — skipping`);
    _discoveredFreeModels = [];
  }
  return _discoveredFreeModels;
}

function extractPatch(raw) {
  const fenced = raw.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : raw).trim();
}

function readFileSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8').slice(0, FILE_CHAR_LIMIT);
  } catch {
    return null;
  }
}

// ── Conflict resolution with AI ──────────────────────────────────────────────
// Called by tryFixOutOfDate when git merge has conflicts.
// Uses the PR's purpose (from Stage 0) to guide resolution — the "why" makes
// per-block decisions more accurate than resolving with no context.
async function resolveConflictsWithAI(conflictedFiles, prPurposeArg) {
  // <<< ... === ... >>> regex — one conflict block at a time
  const CONFLICT_RE = /<<<<<<< [^\n]+\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> [^\n]+/g;

  for (const filePath of conflictedFiles) {
    const fullPath = path.join(process.cwd(), filePath);
    let content;
    try { content = readFileSync(fullPath, 'utf8'); } catch { continue; }

    const blocks = [];
    let match;
    CONFLICT_RE.lastIndex = 0;
    while ((match = CONFLICT_RE.exec(content)) !== null) {
      blocks.push({ full: match[0], ours: match[1], theirs: match[2] });
    }
    if (blocks.length === 0) continue;

    log('conflict-resolve', `${filePath}: resolving ${blocks.length} block(s) with AI (one call per block)...`);

    // Resolve each block independently — smaller prompts, no brittle multi-block parsing.
    // Retry up to 2 times per block on empty response before skipping.
    const resolvedCode = [];
    let failedBlocks = 0;
    for (let bi = 0; bi < blocks.length; bi++) {
      const blockNum = `${bi + 1}/${blocks.length}`;
      let blockResult = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          log('conflict-resolve', `${filePath}: block ${blockNum} empty — waiting 5s, retry ${attempt}...`);
          await new Promise(r => setTimeout(r, 5000));
        }
        try {
          blockResult = await callModel(STAGE0_MODEL, [
            {
              role: 'system',
              content: `Resolve this single git merge conflict. PR purpose: "${prPurposeArg}".
Return ONLY the resolved code — no conflict markers, no explanations, no markdown fences.`,
            },
            {
              role: 'user',
              content: `File: ${filePath}\n\n${blocks[bi].full}`,
            },
          ]);
        } catch (e) {
          log('conflict-resolve', `${filePath}: block ${blockNum} error (attempt ${attempt + 1}): ${e.message.slice(0, 80)}`);
          blockResult = '';
        }
        if (blockResult) break;
      }
      if (!blockResult) {
        log('conflict-resolve', `${filePath}: block ${blockNum} — could not resolve after retries, leaving as-is`);
        resolvedCode.push(blocks[bi].full); // leave original conflict marker
        failedBlocks++;
      } else {
        log('conflict-resolve', `${filePath}: block ${blockNum} OK`);
        resolvedCode.push(blockResult.trim());
      }
    }

    if (failedBlocks === blocks.length) {
      return { ok: false, reason: `AI could not resolve any of ${blocks.length} blocks in ${filePath}` };
    }

    let resolved = content;
    for (let i = 0; i < blocks.length; i++) {
      resolved = resolved.replace(blocks[i].full, resolvedCode[i]);
    }

    // \w after the markers ensures regex patterns like /<<<<<<< [^\n]+/ in source code
    // don't trigger a false positive — real markers are always followed by HEAD/branch-name
    if (/^<{7} \w/m.test(resolved) || /^>{7} \w/m.test(resolved)) {
      return { ok: false, reason: `conflict markers remain in ${filePath} after AI resolution` };
    }

    writeFileSync(fullPath, resolved);

    // Syntax check for JS files — AI sometimes introduces await outside async, etc.
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
      try {
        execFileSync('node', ['--check', fullPath], { encoding: 'utf8' });
        log('conflict-resolve', `${filePath}: resolved OK (syntax valid)`);
      } catch (syntaxErr) {
        writeFileSync(fullPath, content); // restore original conflicted content
        return { ok: false, reason: `AI resolution of ${filePath} introduced syntax error: ${syntaxErr.message.slice(0, 120)}` };
      }
    } else {
      log('conflict-resolve', `${filePath}: resolved OK`);
    }
  }

  return { ok: true };
}

// ── Pre-stage A: Out-of-date branch ─────────────────────────────────────────
// Detection: CI auto-merge step fails with "not up to date with the base branch"
//            OR batch mode (always try merge regardless of log content).
// Fix: git merge origin/<BASE_BRANCH>; if conflicts → AI resolution using PR purpose.
async function tryFixOutOfDate(failedLog, prPurposeArg) {
  const logMatches = /not up to date with the base branch|head branch.*behind/i.test(failedLog);
  if (!BATCH_MODE && !logMatches) return null;

  log('pre-A', `${BATCH_MODE ? 'batch mode' : 'detected "not up to date"'} — merging origin/${BASE_BRANCH}...`);
  try {
    sh(`git fetch origin ${BASE_BRANCH} --quiet`);
    sh(`git merge origin/${BASE_BRANCH} --no-edit -m "merge: sync with ${BASE_BRANCH} before merge"`);
    log('pre-A', 'merge successful — no code changes needed');
    return {
      ok: true,
      category: 'success:pre_a_merge',
      problem: `Branch was behind \`${BASE_BRANCH}\` — merged to bring it up to date`,
      fix_approach: `Merged \`origin/${BASE_BRANCH}\` into the branch. No source code changes.`,
    };
  } catch (mergeErr) {
    const conflictedFiles = sh('git diff --name-only --diff-filter=U').trim().split('\n').filter(Boolean);

    if (conflictedFiles.length === 0) {
      // Non-conflict merge failure (dirty worktree, etc.)
      try { sh('git merge --abort'); } catch {}
      return {
        ok: false,
        category: 'fail:merge_conflict',
        reason: `merge with ${BASE_BRANCH} failed (not a conflict): ${mergeErr.message.slice(0, 100)}`,
        detail: mergeErr.message.slice(0, 200),
      };
    }

    // If Stage 0 failed to get purpose, fall back to branch name — still useful context for AI
    const effectivePurpose = prPurposeArg || `Changes in PR branch: ${ORIGINAL_BRANCH}`;

    log('pre-A', `${conflictedFiles.length} conflict(s): ${conflictedFiles.join(', ')} — asking AI to resolve...`);
    await prComment(`🔀 Merge conflicts in ${conflictedFiles.length} file(s): \`${conflictedFiles.join('`, `')}\`\n\nAsking AI to resolve using context: _"${effectivePurpose.slice(0, 100)}"_…`);

    const resolveResult = await resolveConflictsWithAI(conflictedFiles, effectivePurpose);
    if (!resolveResult.ok) {
      try { sh('git merge --abort'); } catch {}
      return {
        ok: false,
        category: 'fail:ai_conflict_resolution',
        reason: resolveResult.reason,
        detail: `conflicted files: ${conflictedFiles.join(', ')}`,
      };
    }

    sh('git add -A');
    sh(`git commit -m "merge: resolve conflicts with origin/${BASE_BRANCH} [ai-assisted]"`);
    log('pre-A', 'AI conflict resolution successful');
    return {
      ok: true,
      category: 'success:pre_a_conflict_resolved',
      problem: `Branch had merge conflicts with \`${BASE_BRANCH}\` — AI resolved them using PR purpose`,
      fix_approach: `Merged \`origin/${BASE_BRANCH}\`, AI resolved ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')} (context: "${effectivePurpose.slice(0, 60)}")`,
    };
  }
}

// ── Pre-stage B: Missing GitHub Actions permissions ──────────────────────────
// Detection: "Resource not accessible by integration" in CI log
// Fix: add permissions: contents: write / pull-requests: write to the failing job
function patchWorkflowPermissions(content) {
  const lines = content.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Job header: exactly 2 spaces + identifier + colon (no trailing content)
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(line)) {
      // Collect entire job block (all lines until next same-level key or end)
      const jobLines = [line];
      i++;
      while (i < lines.length && (lines[i].startsWith('    ') || lines[i].trim() === '')) {
        jobLines.push(lines[i]);
        i++;
      }

      const jobText = jobLines.join('\n');
      const needsFix = (jobText.includes('gh pr merge') || jobText.includes('gh pr close')) &&
                       !jobText.includes('permissions:');

      if (needsFix) {
        // Insert permissions block before the first 4-space property line
        let inserted = false;
        for (const jl of jobLines) {
          if (!inserted && /^    [a-zA-Z]/.test(jl)) {
            result.push('    permissions:');
            result.push('      contents: write');
            result.push('      pull-requests: write');
            inserted = true;
          }
          result.push(jl);
        }
      } else {
        result.push(...jobLines);
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

function tryFixMissingPermissions(failedLog) {
  if (!/Resource not accessible by integration|GraphQL.*[Mm]erge[Pp]ull[Rr]equest/i.test(failedLog)) return null;

  log('pre-B', 'detected missing GitHub Actions permissions — scanning workflow files...');

  const workflowDir = path.join(process.cwd(), '.github', 'workflows');
  if (!existsSync(workflowDir)) {
    return { ok: false, category: 'fail:permissions_no_workflow', reason: 'no .github/workflows directory found in this repo' };
  }

  const files = readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const patched = [];

  for (const file of files) {
    const fp = path.join(workflowDir, file);
    const orig = readFileSync(fp, 'utf8');
    const updated = patchWorkflowPermissions(orig);
    if (updated !== orig) {
      writeFileSync(fp, updated);
      patched.push(file);
      log('pre-B', `patched: .github/workflows/${file}`);
    }
  }

  if (patched.length === 0) {
    return {
      ok: false,
      category: 'fail:permissions_no_workflow',
      reason: 'no workflow file found with a `gh pr merge` job missing a `permissions:` block',
    };
  }

  return {
    ok: true,
    category: 'success:pre_b_permissions',
    problem: `GitHub Actions job lacked \`permissions: contents: write, pull-requests: write\` — GITHUB_TOKEN defaulted to read-only`,
    fix_approach: `Added permissions block to merge job in: ${patched.join(', ')}`,
  };
}

// ── Pre-stage C: Cloudflare Durable Objects migration conflict ───────────────
// Detection: wrangler error code 10074 or specific migration messages
// Action: bail immediately (not safe to auto-fix — requires human review of DO state)
function checkCloudflareConflict(failedLog) {
  const patterns = [
    /code: 10074/,
    /Cannot apply new-sqlite-class migration.*already depended/i,
    /new-sqlite-class migration.*already depended/i,
    /migration tag.*not found in your wrangler\.toml/i,
    /Applying all available migrations.*Cannot apply/i,
  ];
  return patterns.some(p => p.test(failedLog));
}

// ── Preflight ────────────────────────────────────────────────────────────────

if (!OPENROUTER_API_KEY) failWithStats('fail:other', 'OPENROUTER_API_KEY not set');
if (!REPO || !PR_NUMBER) failWithStats('fail:other', 'missing REPO/PR_NUMBER env');
if (!BATCH_MODE && !RUN_ID) failWithStats('fail:other', 'missing RUN_ID env (set RUN_ID=0 for batch/manual mode)');

// Configure git identity early — needed for merge commits (before tryFixOutOfDate)
try {
  sh('git config user.name "trained-assist-autofix"');
  sh('git config user.email "autofix@trained-assist.bot"');
} catch { /* non-fatal — will fail later if identity really needed */ }

// ── Race condition guard (skipped in batch mode) ─────────────────────────────
if (!BATCH_MODE) {
  try {
    const prViewRaw = sh(`gh pr view ${PR_NUMBER} -R ${REPO} --json state,statusCheckRollup`);
    const prInfo = JSON.parse(prViewRaw);
    if (prInfo.state !== 'OPEN') {
      writeStats('fail:race_pr_closed', { reason: `PR is already ${prInfo.state}` });
      log('guard', `PR #${PR_NUMBER} is already ${prInfo.state} — aborting`);
      process.exit(0); // not a real failure — nothing to do
    }
    const checks = prInfo.statusCheckRollup || [];
    if (checks.length > 0 && !checks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT')) {
      writeStats('fail:race_pr_closed', { reason: 'CI no longer shows failures' });
      log('guard', `PR #${PR_NUMBER} CI no longer shows failures — aborting`);
      process.exit(0);
    }
  } catch (e) {
    log('guard', `could not check PR state (${e.message}) — proceeding anyway`);
  }
}

let failedLog = '';
if (BATCH_MODE) {
  log('batch', `batch mode (RUN_ID=${RUN_ID || 'unset'}) — skipping CI log fetch, will always attempt merge`);
} else {
  try {
    failedLog = sh(`gh run view ${RUN_ID} --log-failed -R ${REPO}`).slice(-LOG_CHAR_LIMIT);
  } catch (e) {
    failWithStats('fail:other', `could not fetch CI log: ${e.message}`);
  }
}

let prDiff = '';
try {
  sh(`git fetch origin ${BASE_BRANCH} --quiet`);
  prDiff = sh(`git diff origin/${BASE_BRANCH}...HEAD`).slice(0, DIFF_CHAR_LIMIT);
} catch { /* best effort */ }

// ── Stage 0: Reasoning — understand WHY this PR exists ───────────────────────
// Before touching anything, ask: is the PR's purpose clear enough to auto-fix?
// If not — comment and stop. Never patch blindly.
// prPurpose is module-scoped so tryFixOutOfDate (pre-stage A) can use it for
// AI conflict resolution after Stage 0 runs.
let prPurpose = '';
{
  log('stage0', 'fetching PR metadata for purpose reasoning...');

  let prMeta = { title: '', body: '', commits: [] };
  try {
    const raw = sh(`gh pr view ${PR_NUMBER} -R ${REPO} --json title,body,commits`);
    prMeta = JSON.parse(raw);
  } catch { /* non-fatal — proceed with empty */ }

  const commitMessages = (prMeta.commits || [])
    .slice(-10)
    .map(c => c.messageHeadline || '')
    .filter(Boolean)
    .join('\n');

  const prContext = [
    `PR title: ${prMeta.title || '(no title)'}`,
    `PR body: ${(prMeta.body || '(empty)').slice(0, 800)}`,
    `Recent commits:\n${commitMessages || '(none)'}`,
    `Branch: ${ORIGINAL_BRANCH}`,
  ].join('\n\n');

  let reasoning;
  try {
    const raw = await callModel(STAGE0_MODEL, [
      {
        role: 'system',
        content: `You are a PR reviewer. Given a PR's title, body, and commit messages, decide whether the PR's purpose is clear enough to safely attempt an automated CI fix.

Reply with valid JSON only:
{
  "purpose": "one sentence describing what this PR is trying to do",
  "is_clear": true,
  "ambiguity_reason": ""
}

Set is_clear=false if:
- The PR title/body is empty or gibberish
- The change seems to be a significant business-logic redesign (not just a technical fix)
- You cannot tell what the PR is trying to accomplish at all

Set is_clear=true for ordinary feature PRs, bug fixes, refactors, dependency updates — even if you don't know the codebase details.`,
      },
      { role: 'user', content: prContext },
    ], true);
    const cleaned = raw.replace(/^```json\n?/, '').replace(/```$/, '');
    reasoning = JSON.parse(cleaned);
  } catch (e) {
    log('stage0', `reasoning model error (${e.message.slice(0, 80)}) — assuming clear and proceeding`);
    reasoning = { purpose: 'unknown (model error)', is_clear: true, ambiguity_reason: '' };
  }

  prPurpose = reasoning.purpose;
  log('stage0', `purpose: ${prPurpose}`);
  log('stage0', `is_clear: ${reasoning.is_clear}`);

  if (!reasoning.is_clear) {
    if (BATCH_MODE) {
      // In batch mode we're here to merge a stale branch, not to diagnose CI failures.
      // Proceed with branch name as purpose fallback for conflict resolution.
      log('stage0', `ambiguous in batch mode — proceeding anyway (purpose: ${reasoning.purpose})`);
    } else {
      const why = reasoning.ambiguity_reason || 'could not determine PR purpose';
      await prComment(`🤷 PR purpose unclear — ${why}\n\nSkipping automated fix. Please clarify the PR description or link a related issue.`);
      writeStats('fail:stage0_ambiguous', { reason: why, purpose: reasoning.purpose });
      log('stage0', `ambiguous PR — stopping`);
      process.exit(0); // not a failure — just not our job
    }
  }

  // Announce we're starting — purpose confirmed
  await prComment(`🔍 Starting automated fix\n\n**PR purpose:** ${reasoning.purpose}\n**CI failure:** fetching logs…`);
}

// ── Run pre-stage strategies (deterministic, no AI) ──────────────────────────

// Pre-stage C: Cloudflare conflicts — bail with a precise message, never patch blindly
if (checkCloudflareConflict(failedLog)) {
  await prComment('❌ Cannot auto-fix: Cloudflare Durable Objects migration conflict (code 10074)\n\nThe migration tag in `wrangler.toml` is out of sync with what Cloudflare has deployed. Patching this blindly would corrupt live DO state. Needs human review of the migration history.');
  failWithStats(
    'fail:cloudflare_do',
    'Cloudflare DO migration conflict (code 10074 or similar) — migration tag out of sync with deployed state',
    { hint: 'Check wrangler.toml migration history vs what Cloudflare has deployed. Code 10074 = class already has live instances that depend on a previous schema. Patching blindly would corrupt live DO state — needs human review.' }
  );
}

// Pre-stage A + B: deterministic fixes
let preStageDiagnosis = null;

const outOfDateResult = await tryFixOutOfDate(failedLog, prPurpose);
if (outOfDateResult) {
  if (!outOfDateResult.ok) {
    const icon = outOfDateResult.category === 'fail:ai_conflict_resolution' ? '🤖' : '❌';
    await prComment(`${icon} Could not fix: ${outOfDateResult.reason}\n\n\`\`\`\n${outOfDateResult.detail || ''}\n\`\`\``);
    failWithStats(outOfDateResult.category, outOfDateResult.reason, { detail: outOfDateResult.detail });
  }
  preStageDiagnosis = outOfDateResult;
}

if (!preStageDiagnosis) {
  const permResult = tryFixMissingPermissions(failedLog);
  if (permResult) {
    if (!permResult.ok) {
      await prComment(`❌ Could not fix: GitHub Actions permissions issue but no patchable workflow found\n\nReason: ${permResult.reason}`);
      failWithStats(permResult.category, permResult.reason);
    }
    preStageDiagnosis = permResult;
  }
}

// ── AI pipeline (only runs if pre-stages didn't apply) ───────────────────────

let diagnosis;
let patchToApply = null; // set by stage 3 if AI ran

if (preStageDiagnosis) {
  diagnosis = preStageDiagnosis;
  log('pre', `pre-stage fix applied (${preStageDiagnosis.category}) — skipping AI pipeline`);
  await prComment(`🔧 Deterministic fix applied (no AI needed)\n\n**Cause:** ${preStageDiagnosis.problem}\n**Fix:** ${preStageDiagnosis.fix_approach}`);
} else {
  // ── Stage 1: Diagnose ──────────────────────────────────────────────────────
  log('stage1', `calling ${STAGE1_MODEL} for diagnosis...`);
  await prComment('🔎 Stage 1/3: diagnosing CI failure with free LLM…');

  let stage1Content;
  try {
    stage1Content = await callModel(STAGE1_MODEL, [
      {
        role: 'system',
        content: `You are a CI failure analyst. Given a failed GitHub Actions log and a PR diff, identify the root cause and which source files need to be changed.

Reply with valid JSON only:
{
  "problem": "concise one-paragraph root cause description",
  "files_to_examine": ["path/to/file1.js", "path/to/file2.js"],
  "fix_approach": "brief description of what to change and where",
  "confidence": "high|medium|low"
}

Rules:
- files_to_examine: list up to ${MAX_FILES} specific source files (not node_modules, not lock files)
- If the fix is obvious from the log alone and needs no extra file context, set files_to_examine to []
- If you cannot determine the cause, set problem to "CANNOT_DIAGNOSE"
- confidence: high = clear deterministic fix; medium = likely fix; low = uncertain`,
      },
      {
        role: 'user',
        content: `Failed CI log (tail):\n\`\`\`\n${failedLog}\n\`\`\`\n\nPR diff vs ${BASE_BRANCH}:\n\`\`\`diff\n${prDiff}\n\`\`\``,
      },
    ], true);
  } catch (e) {
    await prComment(`❌ Stage 1 model error — could not diagnose CI failure\n\n\`${e.message.slice(0, 200)}\``);
    failWithStats('fail:ai_model_error', `Stage 1 model error: ${e.message.slice(0, 200)}`);
  }

  try {
    const raw = stage1Content.replace(/^```json\n?/, '').replace(/```$/, '');
    diagnosis = JSON.parse(raw);
  } catch (e) {
    await prComment(`❌ Stage 1 returned unparseable response — cannot proceed`);
    failWithStats('fail:ai_no_diagnose', `Stage 1 returned invalid JSON: ${e.message}`, { raw: stage1Content.slice(0, 300) });
  }

  if (diagnosis.problem === 'CANNOT_DIAGNOSE') {
    await prComment('❌ Stage 1: could not identify root cause from CI logs\n\nThe failure may require context only a human has. Please check the CI run directly.');
    failWithStats('fail:ai_no_diagnose', 'Stage 1 could not identify root cause');
  }
  if (diagnosis.confidence === 'low') {
    await prComment(`❌ Stage 1: diagnosis confidence too low — not safe to auto-fix\n\n**Suspected cause:** ${diagnosis.problem}\n\nPlease review manually.`);
    failWithStats('fail:ai_low_confidence', `Low confidence — not safe to auto-fix`, { problem: diagnosis.problem });
  }

  log('stage1', `diagnosis: ${diagnosis.problem.slice(0, 120)}`);
  log('stage1', `confidence: ${diagnosis.confidence || 'unset'}`);
  log('stage1', `files to examine: ${(diagnosis.files_to_examine || []).join(', ') || '(none)'}`);
  await prComment(`✅ Stage 1/3: root cause identified (confidence: ${diagnosis.confidence || '?'})\n\n**Cause:** ${diagnosis.problem}\n**Plan:** ${diagnosis.fix_approach}`);;

  // ── Stage 2: Gather context ────────────────────────────────────────────────
  const fileList = (diagnosis.files_to_examine || []).slice(0, MAX_FILES);
  const fileContents = [];

  for (const filePath of fileList) {
    const content = readFileSafe(path.join(process.cwd(), filePath));
    if (content !== null) {
      fileContents.push(`=== ${filePath} ===\n${content}`);
      log('stage2', `loaded ${filePath} (${content.length} chars)`);
    } else {
      log('stage2', `skipped ${filePath} (not found)`);
    }
  }

  let changeSpec = diagnosis.fix_approach;

  if (fileContents.length > 0) {
    log('stage2', `calling ${STAGE2_MODEL} for context analysis...`);

    try {
      const stage2Content = await callModel(STAGE2_MODEL, [
        {
          role: 'system',
          content: `You are a code reviewer helping plan a minimal CI fix. You will receive:
1. A root cause diagnosis
2. The actual source file contents
3. The PR diff

Your job: describe exactly what lines/functions need to change to fix the CI failure. Be specific (file, function name, what to add/remove/change). Do NOT write code — only describe the change in plain English.

If the diagnosis is wrong given what you see in the files, correct it.`,
        },
        {
          role: 'user',
          content: `Root cause: ${diagnosis.problem}\n\nProposed fix approach: ${diagnosis.fix_approach}\n\nSource files:\n\n${fileContents.join('\n\n')}\n\nPR diff:\n\`\`\`diff\n${prDiff}\n\`\`\`\n\nDescribe the exact changes needed.`,
        },
      ]);

      changeSpec = stage2Content;
      log('stage2', `change spec (first 200): ${changeSpec.slice(0, 200)}`);
    } catch (e) {
      log('stage2', `model error (${e.message.slice(0, 80)}) — falling back to stage 1 diagnosis`);
    }
  } else {
    log('stage2', 'no files to load, skipping stage 2 — using diagnosis directly');
  }

  // ── Stage 3: Write patch ───────────────────────────────────────────────────
  log('stage3', `calling ${STAGE3_MODEL} to write patch...`);
  await prComment('🔧 Stage 3/3: generating patch…');

  let stage3Content;
  try {
    stage3Content = await callModel(STAGE3_MODEL, [
      {
        role: 'system',
        content: `You are a CI auto-fix bot. Write a unified diff (git format, "diff --git a/... b/..." prefix) that fixes a CI failure.

Rules:
- Smallest possible change — no refactors, no unrelated edits
- Valid git diff format, applicable via "git apply"
- Wrap in a single \`\`\`diff code block
- If you cannot produce a correct patch, reply exactly: CANNOT_FIX`,
      },
      {
        role: 'user',
        content: `Root cause:\n${diagnosis.problem}\n\nWhat to change:\n${changeSpec}\n\nCurrent PR diff (for context on what already changed):\n\`\`\`diff\n${prDiff}\n\`\`\`\n\nWrite the fix patch.`,
      },
    ]);
  } catch (e) {
    failWithStats('fail:ai_model_error', `Stage 3 model error: ${e.message.slice(0, 200)}`, { problem: diagnosis.problem });
  }

  if (!stage3Content || stage3Content.includes('CANNOT_FIX')) {
    await prComment(`❌ Stage 3: model declined to generate a patch\n\n**Cause:** ${diagnosis.problem}\n\nThis likely requires a code change that needs human judgement.`);
    failWithStats('fail:ai_cannot_fix', 'Stage 3 declined to produce a patch', {
      problem: diagnosis.problem,
      fix_approach: diagnosis.fix_approach,
    });
  }

  const patch = extractPatch(stage3Content);
  if (!patch.startsWith('diff --git') && !patch.startsWith('---')) {
    await prComment(`❌ Stage 3: generated a malformed diff — cannot apply\n\n**Cause:** ${diagnosis.problem}`);
    failWithStats('fail:ai_corrupt_patch', 'Stage 3 produced malformed diff', {
      problem: diagnosis.problem,
      patch_head: patch.slice(0, 100),
    });
  }

  patchToApply = patch;
  diagnosis.fix_approach = changeSpec; // use refined spec from stage 2
}

// ── Apply patch (AI path only) ────────────────────────────────────────────────

if (patchToApply) {
  const patchFile = 'autofix-openrouter.patch';
  writeFileSync(patchFile, patchToApply + '\n');

  try {
    execFileSync('git', ['apply', '--whitespace=fix', patchFile], { stdio: 'inherit' });
  } catch (e) {
    unlinkSync(patchFile);
    await prComment(`❌ Patch did not apply cleanly\n\n**Cause:** ${diagnosis.problem}\n\n\`\`\`\n${e.message.slice(0, 300)}\n\`\`\``);
    failWithStats('fail:ai_corrupt_patch', 'Patch did not apply cleanly', {
      problem: diagnosis.problem,
      git_error: e.message.slice(0, 200),
    });
  }
  unlinkSync(patchFile);
}

// ── Verify: run tests ─────────────────────────────────────────────────────────
// Skip for conflict resolution — push fix PR and let CI report failures.
// The loop: conflict resolved → fix PR → CI fails → fixer picks up next iteration.

if (!preStageDiagnosis?.category.startsWith('success:pre_a')) {
  await prComment('🧪 Patch applied — running tests…');
  try {
    sh('npm test');
  } catch (e) {
    sh('git checkout -- .');
    sh('git clean -fd');
    await prComment(`❌ Tests still fail after patch\n\n**Cause:** ${diagnosis.problem}\n\nReverted. Needs human review.\n\n\`\`\`\n${e.message.slice(0, 300)}\n\`\`\``);
    failWithStats('fail:ai_tests_fail', 'Patch applied but tests still fail', {
      problem: diagnosis.problem,
      test_error: e.message.slice(0, 300),
    });
  }
}

// ── Create new fix branch + PR (never push to original branch) ───────────────

const ts = Math.floor(Date.now() / 1000);
const safeBranch = (ORIGINAL_BRANCH || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
const fixBranch = `fix/ci-${safeBranch}-${ts}`;
const fixStrategy = preStageDiagnosis
  ? preStageDiagnosis.category
  : `ai:free (${STAGE1_MODEL} → ${STAGE2_MODEL} → ${STAGE3_MODEL})`;

sh('git config user.name "trained-assist-autofix"');
sh('git config user.email "autofix@trained-assist.bot"');
sh('git add -A');
// Pre-stage A (conflict resolution or clean merge) may have already committed.
// Skip the commit if nothing is staged — avoids "nothing to commit" crash.
if (sh('git status --porcelain').trim()) {
  sh(`git commit -m "fix: auto-fix CI failure [autofix]

Diagnosis: ${diagnosis.problem.slice(0, 120).replace(/"/g, "'")}
Strategy: ${fixStrategy}"
`);
}
sh(`git checkout -b ${fixBranch}`);
sh(`git push origin ${fixBranch}`);

log('publish', `pushed fix branch: ${fixBranch}`);

const prTitle = `fix: auto-fix CI failure in ${ORIGINAL_BRANCH || safeBranch}`;
const prBody = [
  `🤖 Automatically generated fix for CI failure in #${PR_NUMBER}`,
  '',
  `**Root cause:** ${diagnosis.problem}`,
  '',
  `**Fix:** ${diagnosis.fix_approach}`,
  '',
  `**Strategy:** \`${fixStrategy}\``,
  '',
  `---`,
  `<!-- ci-fixer-original-pr: ${PR_NUMBER} -->`,
].join('\n');

writeFileSync('pr-body.txt', prBody);
let newPRUrl;
try {
  newPRUrl = sh(
    `gh pr create --repo "${REPO}" --base "${BASE_BRANCH}" --head "${fixBranch}" --title "${prTitle}" --body-file pr-body.txt`
  ).trim();
} finally {
  unlinkSync('pr-body.txt');
}

const newPRNumber = newPRUrl.match(/\/pull\/(\d+)$/)?.[1] || '?';
log('publish', `created new PR #${newPRNumber}: ${newPRUrl}`);

// Close any stale fix/ci-* PRs for the same original branch (excluding the one just created)
try {
  const safeBranchForClose = (ORIGINAL_BRANCH || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
  const stalePRs = JSON.parse(
    sh(`gh pr list -R "${REPO}" --json number,headRefName --state open`)
  ).filter(pr =>
    pr.headRefName.startsWith(`fix/ci-${safeBranchForClose}-`) &&
    String(pr.number) !== String(newPRNumber)
  );
  for (const stale of stalePRs) {
    sh(`gh pr close ${stale.number} -R "${REPO}" --comment "♻️ Superseded by #${newPRNumber}: ${newPRUrl}"`);
    log('publish', `closed stale fix PR #${stale.number} (superseded by #${newPRNumber})`);
  }
} catch (e) {
  log('publish', `could not close stale fix PRs: ${e.message.slice(0, 80)}`);
}

try {
  sh(`gh pr merge --auto --squash "${newPRNumber}" -R "${REPO}"`);
  log('publish', `auto-merge enabled on PR #${newPRNumber}`);
} catch (e) {
  log('publish', `auto-merge not available (${e.message.slice(0, 80)}) — PR will need manual merge`);
}

// Close the original PR immediately — don't rely on webhook events from ci-fix-cleanup.yml
// which can be dropped by GitHub. The fix PR is now the source of truth.
try {
  sh(`gh pr close ${PR_NUMBER} -R "${REPO}" --comment "🤖 Superseded by #${newPRNumber}: ${newPRUrl} (pending CI + auto-merge)."`);
  log('publish', `closed original PR #${PR_NUMBER}`);
} catch (e) {
  log('publish', `could not close original PR: ${e.message.slice(0, 80)}`);
}

await prComment([
  `✅ Fix PR created: ${newPRUrl}`,
  '',
  `**Root cause:** ${diagnosis.problem}`,
  `**Fix:** ${diagnosis.fix_approach}`,
  `**Strategy:** \`${fixStrategy}\``,
  '',
  `PR #${newPRNumber} will auto-merge when CI passes.`,
].join('\n'));

// ── Write success stats ───────────────────────────────────────────────────────
writeStats(preStageDiagnosis ? preStageDiagnosis.category : 'success:ai', {
  problem: diagnosis.problem,
  fix: diagnosis.fix_approach,
  fix_branch: fixBranch,
  fix_pr: newPRNumber,
  strategy: fixStrategy,
});

console.log(`[autofix] fix PR #${newPRNumber} created (strategy: ${fixStrategy})`);
