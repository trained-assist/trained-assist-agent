#!/usr/bin/env node
// Issue enrichment: ask a cheap OpenRouter model to classify a freshly opened
// issue (size/ambiguity/category + one-line summary) and post it as a comment
// + labels. Read-only w.r.t. code — never touches the working tree. See
// docs/free-llm-credentials.md for the shared OpenRouter policy and issue #584
// for the wider free-LLM triage design this is phase A of.

const MODEL = process.env.MODEL || 'deepseek/deepseek-chat';

const { OPENROUTER_API_KEY, GH_TOKEN, REPO, ISSUE_NUMBER } = process.env;

function fail(reason) {
  console.error(`[issue-triage] giving up: ${reason}`);
  process.exit(1);
}

if (!OPENROUTER_API_KEY) fail('OPENROUTER_API_KEY not set');
if (!REPO || !ISSUE_NUMBER) fail('missing REPO/ISSUE_NUMBER env');

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const issue = await gh(`/issues/${ISSUE_NUMBER}`);
const body = (issue.body || '').slice(0, 6000);
const existingLabels = (issue.labels || []).map((l) => l.name);

const systemPrompt = `You triage incoming GitHub issues for a solo-maintained project. Given a title and body, reply with ONLY a JSON object (no markdown fence, no prose) with this exact shape:
{"category":"bug|feature|question|housekeeping|duplicate","size":"XS|S|M|L|XL","ambiguity":"low|medium|high","summary":"one plain-language sentence","next_step":"one concrete actionable next step"}
size = rough implementation effort (XS = single small edit, XL = multi-system redesign). ambiguity = how many open design questions must be resolved with the architect before work can start (low = none, high = several). If the body already contains its own analysis, do not repeat it verbatim in summary — condense to what's new/actionable.`;

const userPrompt = `Title: ${issue.title}\n\nBody:\n${body}\n\nExisting labels: ${existingLabels.join(', ') || '(none)'}`;

async function classify() {
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

function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\n([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  return JSON.parse(candidate);
}

let result;
try {
  result = extractJson(await classify());
} catch (e) {
  fail(`could not get a usable classification: ${e.message}`);
}

const VALID_CATEGORY = ['bug', 'feature', 'question', 'housekeeping', 'duplicate'];
const VALID_SIZE = ['XS', 'S', 'M', 'L', 'XL'];
const VALID_AMBIGUITY = ['low', 'medium', 'high'];
if (
  !VALID_CATEGORY.includes(result.category) ||
  !VALID_SIZE.includes(result.size) ||
  !VALID_AMBIGUITY.includes(result.ambiguity)
) {
  fail(`classification failed validation: ${JSON.stringify(result)}`);
}

const newLabels = [`size:${result.size}`, `ambiguity:${result.ambiguity}`];
if (result.ambiguity === 'high') newLabels.push('needs-architect');

// Ensure labels exist (creating a label that already exists is a 422 — ignore it).
for (const name of newLabels) {
  const color = name.startsWith('size:') ? 'c5def5' : name === 'needs-architect' ? 'd93f0b' : 'fbca04';
  try {
    await gh('/labels', { method: 'POST', body: JSON.stringify({ name, color }) });
  } catch {
    // already exists — fine
  }
}

await gh(`/issues/${ISSUE_NUMBER}/labels`, {
  method: 'POST',
  body: JSON.stringify({ labels: [...new Set([...existingLabels, ...newLabels])] }),
});

const commentBody = `🤖 Триаж (\`${MODEL}\`): **${result.category}**, размер \`${result.size}\`, неоднозначность \`${result.ambiguity}\`.

${result.summary}

**Следующий шаг:** ${result.next_step}`;

await gh(`/issues/${ISSUE_NUMBER}/comments`, {
  method: 'POST',
  body: JSON.stringify({ body: commentBody }),
});

console.log(`[issue-triage] labeled #${ISSUE_NUMBER}: ${newLabels.join(', ')}`);
