#!/usr/bin/env node
// 3-stage CI auto-fix pipeline via free OpenRouter models:
//   Stage 1 (deepseek-r1:free)          — diagnose: root cause + files to examine
//   Stage 2 (gemini-2.5-flash-lite:free) — contextualize: read real files, describe exact changes
//   Stage 3 (qwen3-235b:free)            — patch: write the unified diff
//
// On success: creates a new fix/ci-* branch + PR (never pushes to original branch).
// The new PR auto-merges when CI passes; ci-fix-cleanup.yml then closes the original PR.
// Exits 0 on success (fix PR created), 1 on failure.

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
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
  console.error(`[autofix stage${stage}] ${msg}`);
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

// ── Preflight ────────────────────────────────────────────────────────────────

if (!OPENROUTER_API_KEY) fail('OPENROUTER_API_KEY not set');
if (!RUN_ID || !REPO || !PR_NUMBER) fail('missing RUN_ID/REPO/PR_NUMBER env');

// ── Race condition guard ─────────────────────────────────────────────────────
// If the old PR was closed/merged or its CI somehow passed while we were waiting,
// there's nothing to fix.
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

// ── Stage 1: Diagnose ────────────────────────────────────────────────────────

log(1, `calling ${STAGE1_MODEL} for diagnosis...`);

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

let diagnosis;
try {
  const raw = stage1Content.replace(/^```json\n?/, '').replace(/```$/, '');
  diagnosis = JSON.parse(raw);
} catch (e) {
  fail(`stage 1 returned invalid JSON: ${e.message}\nRaw: ${stage1Content.slice(0, 500)}`);
}

if (diagnosis.problem === 'CANNOT_DIAGNOSE') {
  fail('stage 1: model could not determine root cause');
}

// Don't attempt fixes the model is uncertain about — better to surface for human review
if (diagnosis.confidence === 'low') {
  fail(`stage 1: low confidence diagnosis — not safe to auto-fix. Root cause: ${diagnosis.problem}`);
}

log(1, `diagnosis: ${diagnosis.problem.slice(0, 120)}`);
log(1, `confidence: ${diagnosis.confidence || 'unset'}`);
log(1, `files to examine: ${(diagnosis.files_to_examine || []).join(', ') || '(none)'}`);

// ── Stage 2: Gather context ──────────────────────────────────────────────────

const fileList = (diagnosis.files_to_examine || []).slice(0, MAX_FILES);
const fileContents = [];

for (const filePath of fileList) {
  const content = readFileSafe(path.join(process.cwd(), filePath));
  if (content !== null) {
    fileContents.push(`=== ${filePath} ===\n${content}`);
    log(2, `loaded ${filePath} (${content.length} chars)`);
  } else {
    log(2, `skipped ${filePath} (not found)`);
  }
}

let changeSpec = diagnosis.fix_approach;

if (fileContents.length > 0) {
  log(2, `calling ${STAGE2_MODEL} for context analysis...`);

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
  log(2, `change spec (first 200): ${changeSpec.slice(0, 200)}`);
} else {
  log(2, 'no files to load, skipping stage 2 — using diagnosis directly');
}

// ── Stage 3: Write patch ─────────────────────────────────────────────────────

log(3, `calling ${STAGE3_MODEL} to write patch...`);

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

// ── Apply + verify ───────────────────────────────────────────────────────────

const patchFile = 'autofix-openrouter.patch';
writeFileSync(patchFile, patch + '\n');

try {
  execFileSync('git', ['apply', '--whitespace=fix', patchFile], { stdio: 'inherit' });
} catch (e) {
  unlinkSync(patchFile);
  fail(`patch did not apply cleanly: ${e.message}`);
}
unlinkSync(patchFile);

try {
  sh('npm test');
} catch {
  log('verify', 'tests still fail after patch — reverting');
  sh('git checkout -- .');
  sh('git clean -fd');
  fail('patch applied but tests still fail');
}

// ── Create new fix branch + PR (never push to original branch) ───────────────

const ts = Math.floor(Date.now() / 1000);
const safeBranch = (ORIGINAL_BRANCH || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
const fixBranch = `fix/ci-${safeBranch}-${ts}`;

sh('git config user.name "trained-assist-autofix"');
sh('git config user.email "autofix@trained-assist.bot"');
sh('git add -A');
sh(`git commit -m "fix: auto-fix CI failure [autofix]

Diagnosis: ${diagnosis.problem.slice(0, 120).replace(/"/g, "'")}"
`);
sh(`git checkout -b ${fixBranch}`);
sh(`git push origin ${fixBranch}`);

log('publish', `pushed fix branch: ${fixBranch}`);

// Create new PR targeting the same base branch
const prTitle = `fix: auto-fix CI failure in ${ORIGINAL_BRANCH || safeBranch}`;
const prBody = [
  `🤖 Automatically generated fix for CI failure in #${PR_NUMBER}`,
  '',
  `**Root cause:** ${diagnosis.problem}`,
  '',
  `**Fix:** ${diagnosis.fix_approach}`,
  '',
  `**Confidence:** ${diagnosis.confidence || 'medium'}`,
  '',
  `Models: \`${STAGE1_MODEL}\` → \`${STAGE2_MODEL}\` → \`${STAGE3_MODEL}\``,
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

// Enable auto-merge if supported (requires repo setting; fails gracefully if not)
try {
  sh(`gh pr merge --auto --squash "${newPRNumber}" -R "${REPO}"`);
  log('publish', `auto-merge enabled on PR #${newPRNumber}`);
} catch (e) {
  log('publish', `auto-merge not available (${e.message.slice(0, 80)}) — PR will need manual merge`);
}

// Comment on old PR with link to fix PR
const commentBody = [
  `🤖 **Auto-fix PR created:** ${newPRUrl}`,
  '',
  `**Root cause:** ${diagnosis.problem}`,
  '',
  `**Fix:** ${diagnosis.fix_approach}`,
  '',
  `PR #${newPRNumber} will auto-merge when CI passes. This PR will be closed automatically after that.`,
  '',
  `Models: \`${STAGE1_MODEL}\` → \`${STAGE2_MODEL}\` → \`${STAGE3_MODEL}\``,
].join('\n');

writeFileSync('comment.txt', commentBody);
try {
  sh(`gh pr comment ${PR_NUMBER} -R "${REPO}" --body-file comment.txt`);
} finally {
  unlinkSync('comment.txt');
}

console.log(`[autofix] fix PR #${newPRNumber} created and auto-merge enabled`);
