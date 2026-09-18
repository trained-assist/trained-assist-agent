#!/usr/bin/env node
// 3-stage CI auto-fix pipeline via free OpenRouter models:
//   Stage 1 (deepseek-r1:free)          — diagnose: root cause + files to examine
//   Stage 2 (gemini-2.5-flash-lite:free) — contextualize: read real files, describe exact changes
//   Stage 3 (qwen3-235b:free)            — patch: write the unified diff
// Exits 0 on success (fix committed+pushed), 1 on failure.

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';

const LOG_CHAR_LIMIT = 12000;
const DIFF_CHAR_LIMIT = 10000;
const FILE_CHAR_LIMIT = 8000; // per file in stage 2
const MAX_FILES = 8;

// Stage model defaults — override via AUTOFIX_STAGE{1,2,3}_MODEL repo secrets
// Stage 1 alternatives: microsoft/phi-4-reasoning-plus:free, qwen/qwen3-235b-a22b:free
// Stage 2 alternatives: google/gemini-2.0-flash-exp:free (also 1M ctx)
// Stage 3 alternatives: qwen/qwen3-235b-a22b:free, deepseek/deepseek-chat-v3-0324:free, meta-llama/llama-3.3-70b-instruct:free
const STAGE1_MODEL = process.env.STAGE1_MODEL || 'deepseek/deepseek-r1:free';
const STAGE2_MODEL = process.env.STAGE2_MODEL || 'google/gemini-2.5-flash-lite-preview-06-17:free';
const STAGE3_MODEL = process.env.STAGE3_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct:free';

const {
  OPENROUTER_API_KEY,
  GH_TOKEN,
  RUN_ID,
  REPO,
  PR_NUMBER,
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
  "fix_approach": "brief description of what to change and where"
}

Rules:
- files_to_examine: list up to ${MAX_FILES} specific source files (not node_modules, not lock files)
- If the fix is obvious from the log alone and needs no extra file context, set files_to_examine to []
- If you cannot determine the cause, set problem to "CANNOT_DIAGNOSE"`,
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

log(1, `diagnosis: ${diagnosis.problem.slice(0, 120)}`);
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

// ── Commit + push ────────────────────────────────────────────────────────────

sh('git config user.name "trained-assist-autofix"');
sh('git config user.email "autofix@trained-assist.bot"');
sh('git add -A');
sh(`git commit -m "fix: auto-fix CI failure [autofix]\\n\\nDiagnosis: ${diagnosis.problem.slice(0, 120).replace(/"/g, "'")}"`);
sh('git push');

const commentBody = [
  `🤖 **Auto-fixed** via 3-stage OpenRouter pipeline`,
  '',
  `**Root cause:** ${diagnosis.problem}`,
  '',
  `**Fix:** ${diagnosis.fix_approach}`,
  '',
  `Models: \`${STAGE1_MODEL}\` → \`${STAGE2_MODEL}\` → \`${STAGE3_MODEL}\``,
].join('\n');

writeFileSync('autofix-comment.txt', commentBody);
sh(`gh pr comment ${PR_NUMBER} -R ${REPO} --body-file autofix-comment.txt`);
unlinkSync('autofix-comment.txt');

console.log('[autofix] 3-stage fix committed and pushed successfully');
