#!/usr/bin/env node
// Cheap-first CI auto-fix: ask an OpenRouter model for a unified diff patch
// fixing a failed PR check. Exits 0 (fix committed+pushed) or 1 (couldn't
// confidently fix — caller should fall back to the Claude step).
// See docs/free-llm-credentials.md for the model/fallback policy this follows.

import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const MODEL = 'deepseek/deepseek-chat';
const MAX_ATTEMPTS = 2;
const LOG_CHAR_LIMIT = 15000;
const DIFF_CHAR_LIMIT = 15000;

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

function fail(reason) {
  console.error(`[autofix-openrouter] giving up: ${reason}`);
  process.exit(1);
}

if (!OPENROUTER_API_KEY) fail('OPENROUTER_API_KEY not set');
if (!RUN_ID || !REPO || !PR_NUMBER) fail('missing RUN_ID/REPO/PR_NUMBER env');

let failedLog;
try {
  failedLog = sh(`gh run view ${RUN_ID} --log-failed -R ${REPO}`);
} catch (e) {
  fail(`could not fetch failed log: ${e.message}`);
}
failedLog = failedLog.slice(-LOG_CHAR_LIMIT);

let prDiff = '';
try {
  sh(`git fetch origin ${BASE_BRANCH} --quiet`);
  prDiff = sh(`git diff origin/${BASE_BRANCH}...HEAD`).slice(0, DIFF_CHAR_LIMIT);
} catch {
  // best effort — proceed without diff context
}

const systemPrompt = `You are a CI auto-fix bot. You will be shown a failed GitHub Actions log and the current PR diff. Reply with ONLY a valid unified diff (git diff format, with a/ b/ prefixes, applicable via "git apply") that fixes the failure. Make the smallest possible change — no refactors, no unrelated edits. If you cannot confidently produce a correct patch from the given information, reply with exactly: CANNOT_FIX`;

const userPrompt = `Failed CI log (tail):\n\`\`\`\n${failedLog}\n\`\`\`\n\nCurrent PR diff vs ${BASE_BRANCH}:\n\`\`\`diff\n${prDiff}\n\`\`\`\n\nProduce the fix.`;

async function callOpenRouter() {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
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

let patch = null;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !patch; attempt++) {
  let content;
  try {
    content = await callOpenRouter();
  } catch (e) {
    console.error(`[autofix-openrouter] attempt ${attempt} failed: ${e.message}`);
    continue;
  }
  if (!content || content.includes('CANNOT_FIX')) {
    console.error(`[autofix-openrouter] attempt ${attempt}: model declined to fix`);
    continue;
  }
  const candidate = extractPatch(content);
  if (!candidate.startsWith('diff --git') && !candidate.startsWith('---')) {
    console.error(`[autofix-openrouter] attempt ${attempt}: malformed patch, retrying`);
    continue;
  }
  patch = candidate;
}

if (!patch) fail('model produced no usable patch after retries');

const patchFile = 'autofix-openrouter.patch';
writeFileSync(patchFile, patch + '\n');

try {
  execFileSync('git', ['apply', '--whitespace=fix', patchFile], { stdio: 'inherit' });
} catch (e) {
  unlinkSync(patchFile);
  fail(`patch did not apply: ${e.message}`);
}
unlinkSync(patchFile);

try {
  sh('npm test');
} catch (e) {
  console.error('[autofix-openrouter] patch applied but tests still fail, reverting');
  sh('git checkout -- .');
  sh('git clean -fd');
  fail('patch failed local test run');
}

sh('git config user.name "trained-assist-autofix"');
sh('git config user.email "autofix@trained-assist.bot"');
sh('git add -A');
sh(`git commit -m "fix: auto-fix CI failure via OpenRouter (${MODEL}) [autofix]"`);
sh('git push');

const commentBody = `🤖 Auto-fixed by OpenRouter (\`${MODEL}\`) — cheap-model pass, no Claude call needed.\n\nFix applied for the failure in run ${RUN_ID}, tests pass locally.`;
writeFileSync('autofix-comment.txt', commentBody);
sh(`gh pr comment ${PR_NUMBER} -R ${REPO} --body-file autofix-comment.txt`);
unlinkSync('autofix-comment.txt');

console.log('[autofix-openrouter] fix committed and pushed successfully');
