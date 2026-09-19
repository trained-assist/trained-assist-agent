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

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const LOG_CHAR_LIMIT = 12000;
const DIFF_CHAR_LIMIT = 10000;
const FILE_CHAR_LIMIT = 8000;
const MAX_FILES = 8;

const STAGE1_MODEL = 'deepseek/deepseek-v4-flash-0731:free';
const STAGE2_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
const STAGE3_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

const {
  OPENROUTER_API_KEY,
  GH_TOKEN,
  RUN_ID,
  REPO,
  PR_NUMBER,
  ORIGINAL_BRANCH = '',
  BASE_BRANCH = 'main',
} = process.env;

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
}

function log(stage, msg) {
  console.error(`[autofix ${stage}] ${msg}`);
}

function fail(reason) {
  console.error(`[autofix] giving up: ${reason}`);
  process.exit(1);
}

async function callModel(model, messages, json = false) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
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

// ── Pre-stage A: Out-of-date branch ─────────────────────────────────────────
// Detection: CI auto-merge step fails with "not up to date with the base branch"
// Fix: git merge origin/<BASE_BRANCH>
function tryFixOutOfDate(failedLog) {
  if (!/not up to date with the base branch|head branch.*behind/i.test(failedLog)) return null;

  log('pre-A', `detected "not up to date" — merging origin/${BASE_BRANCH}...`);
  try {
    sh(`git fetch origin ${BASE_BRANCH} --quiet`);
    sh(`git merge origin/${BASE_BRANCH} --no-edit -m "merge: sync with ${BASE_BRANCH} before merge"`);
    log('pre-A', 'merge successful — no code changes needed');
    return {
      fixed: true,
      problem: `Branch was behind \`${BASE_BRANCH}\` — merged to bring it up to date`,
      fix_approach: `Merged \`origin/${BASE_BRANCH}\` into the branch. No source code changes.`,
    };
  } catch (e) {
    try { sh('git merge --abort'); } catch {}
    return {
      fixed: false,
      reason: `merge with ${BASE_BRANCH} failed (likely conflicts that need human resolution): ${e.message.slice(0, 120)}`,
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
    return { fixed: false, reason: 'no .github/workflows directory found in this repo' };
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
      fixed: false,
      reason: 'no workflow file found with a `gh pr merge` job missing a `permissions:` block',
    };
  }

  return {
    fixed: true,
    problem: `GitHub Actions job lacked \`permissions: contents: write, pull-requests: write\` — GITHUB_TOKEN defaulted to read-only`,
    fix_approach: `Added permissions block to merge job in: ${patched.join(', ')}`,
  };
}

// ── Pre-stage C: Cloudflare Durable Objects migration conflict ───────────────
// Detection: wrangler error code 10074 or specific migration messages
// Action: bail immediately with a precise, actionable error message (not safe to auto-fix)
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

if (!OPENROUTER_API_KEY) fail('OPENROUTER_API_KEY not set');
if (!RUN_ID || !REPO || !PR_NUMBER) fail('missing RUN_ID/REPO/PR_NUMBER env');

// ── Race condition guard ─────────────────────────────────────────────────────
try {
  const prViewRaw = sh(`gh pr view ${PR_NUMBER} -R ${REPO} --json state,statusCheckRollup`);
  const prInfo = JSON.parse(prViewRaw);
  if (prInfo.state !== 'OPEN') {
    log('guard', `PR #${PR_NUMBER} is already ${prInfo.state} — aborting`);
    process.exit(0);
  }
  const checks = prInfo.statusCheckRollup || [];
  if (checks.length > 0 && !checks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT')) {
    log('guard', `PR #${PR_NUMBER} CI no longer shows failures — aborting`);
    process.exit(0);
  }
} catch (e) {
  log('guard', `could not check PR state (${e.message}) — proceeding anyway`);
}

let failedLog;
try {
  failedLog = sh(`gh run view ${RUN_ID} --log-failed -R ${REPO}`).slice(-LOG_CHAR_LIMIT);
} catch (e) {
  fail(`could not fetch CI log: ${e.message}`);
}

let prDiff = '';
try {
  sh(`git fetch origin ${BASE_BRANCH} --quiet`);
  prDiff = sh(`git diff origin/${BASE_BRANCH}...HEAD`).slice(0, DIFF_CHAR_LIMIT);
} catch { /* best effort */ }

// ── Run pre-stage strategies (deterministic, no AI) ──────────────────────────

// Pre-stage C: Cloudflare conflicts — bail with a precise message, never patch blindly
if (checkCloudflareConflict(failedLog)) {
  fail(
    'Cloudflare Durable Objects migration conflict (code 10074 or similar). ' +
    'The migration tag in wrangler.toml is out of sync with what Cloudflare has deployed. ' +
    'Patching this blindly would corrupt live DO state — needs human review of the migration history.'
  );
}

// Pre-stage A + B: deterministic fixes
let preStageDiagnosis = null;

const outOfDateResult = tryFixOutOfDate(failedLog);
if (outOfDateResult) {
  if (!outOfDateResult.fixed) fail(`pre-stage A: ${outOfDateResult.reason}`);
  preStageDiagnosis = { ...outOfDateResult, confidence: 'high' };
}

if (!preStageDiagnosis) {
  const permResult = tryFixMissingPermissions(failedLog);
  if (permResult) {
    if (!permResult.fixed) fail(`pre-stage B: ${permResult.reason}`);
    preStageDiagnosis = { ...permResult, confidence: 'high' };
  }
}

// ── AI pipeline (only runs if pre-stages didn't apply) ───────────────────────

let diagnosis;
let patchToApply = null; // set by stage 3 if AI ran

if (preStageDiagnosis) {
  diagnosis = preStageDiagnosis;
  log('pre', `pre-stage fix applied — skipping AI pipeline`);
} else {
  // ── Stage 1: Diagnose ──────────────────────────────────────────────────────
  log('stage1', `calling ${STAGE1_MODEL} for diagnosis...`);

  const stage1Content = await callModel(STAGE1_MODEL, [
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

  try {
    const raw = stage1Content.replace(/^```json\n?/, '').replace(/```$/, '');
    diagnosis = JSON.parse(raw);
  } catch (e) {
    fail(`stage 1 returned invalid JSON: ${e.message}\nRaw: ${stage1Content.slice(0, 500)}`);
  }

  if (diagnosis.problem === 'CANNOT_DIAGNOSE') {
    fail('stage 1: model could not determine root cause');
  }
  if (diagnosis.confidence === 'low') {
    fail(`stage 1: low confidence — not safe to auto-fix. Root cause: ${diagnosis.problem}`);
  }

  log('stage1', `diagnosis: ${diagnosis.problem.slice(0, 120)}`);
  log('stage1', `confidence: ${diagnosis.confidence || 'unset'}`);
  log('stage1', `files to examine: ${(diagnosis.files_to_examine || []).join(', ') || '(none)'}`);

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
  } else {
    log('stage2', 'no files to load, skipping stage 2 — using diagnosis directly');
  }

  // ── Stage 3: Write patch ───────────────────────────────────────────────────
  log('stage3', `calling ${STAGE3_MODEL} to write patch...`);

  const stage3Content = await callModel(STAGE3_MODEL, [
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

  if (!stage3Content || stage3Content.includes('CANNOT_FIX')) {
    fail('stage 3: model declined to produce a patch');
  }

  const patch = extractPatch(stage3Content);
  if (!patch.startsWith('diff --git') && !patch.startsWith('---')) {
    fail(`stage 3: malformed patch (first 200): ${patch.slice(0, 200)}`);
  }

  patchToApply = patch;
}

// ── Apply patch (AI path only) ────────────────────────────────────────────────

if (patchToApply) {
  const patchFile = 'autofix-openrouter.patch';
  writeFileSync(patchFile, patchToApply + '\n');

  try {
    execFileSync('git', ['apply', '--whitespace=fix', patchFile], { stdio: 'inherit' });
  } catch (e) {
    unlinkSync(patchFile);
    fail(`patch did not apply cleanly: ${e.message}`);
  }
  unlinkSync(patchFile);
}

// ── Verify: run tests ─────────────────────────────────────────────────────────

try {
  sh('npm test');
} catch {
  log('verify', 'tests fail after fix — reverting');
  sh('git checkout -- .');
  sh('git clean -fd');
  fail('fix applied but tests still fail');
}

// ── Create new fix branch + PR (never push to original branch) ───────────────

const ts = Math.floor(Date.now() / 1000);
const safeBranch = (ORIGINAL_BRANCH || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
const fixBranch = `fix/ci-${safeBranch}-${ts}`;
const fixStrategy = preStageDiagnosis ? 'pre-stage (deterministic)' : `AI (${STAGE1_MODEL} → ${STAGE2_MODEL} → ${STAGE3_MODEL})`;

sh('git config user.name "trained-assist-autofix"');
sh('git config user.email "autofix@trained-assist.bot"');
sh('git add -A');
sh(`git commit -m "fix: auto-fix CI failure [autofix]

Diagnosis: ${diagnosis.problem.slice(0, 120).replace(/"/g, "'")}
Strategy: ${fixStrategy}"
`);
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
  `**Strategy:** ${fixStrategy}`,
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

try {
  sh(`gh pr merge --auto --squash "${newPRNumber}" -R "${REPO}"`);
  log('publish', `auto-merge enabled on PR #${newPRNumber}`);
} catch (e) {
  log('publish', `auto-merge not available (${e.message.slice(0, 80)}) — PR will need manual merge`);
}

const commentBody = [
  `🤖 **Auto-fix PR created:** ${newPRUrl}`,
  '',
  `**Root cause:** ${diagnosis.problem}`,
  '',
  `**Fix:** ${diagnosis.fix_approach}`,
  '',
  `**Strategy:** ${fixStrategy}`,
  '',
  `PR #${newPRNumber} will auto-merge when CI passes. This PR will be closed automatically after that.`,
].join('\n');

writeFileSync('comment.txt', commentBody);
try {
  sh(`gh pr comment ${PR_NUMBER} -R "${REPO}" --body-file comment.txt`);
} finally {
  unlinkSync('comment.txt');
}

console.log(`[autofix] fix PR #${newPRNumber} created (strategy: ${fixStrategy})`);
