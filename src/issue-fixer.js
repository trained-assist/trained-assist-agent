'use strict';
// Issue-fixer — F2 (selection) + F3 (relevance-gate) slices of the "Фиксер"
// pipeline stage (issue -> relevance-gate -> PR). See ISSUES-TO-PR-SPEC.md
// §3.2/§3.3/§6 in the owner's working project.
//
// F2 (`run`) makes no model calls and creates no PRs — it only answers "which open
// issues are structurally eligible right now" and remembers what it has already
// queued, so a re-run does not re-report the same issue as new.
//
// F3 (`runGate`) picks up issues F2 already labeled `fixer:queued` but not yet
// gated (no `scope:in`/`scope:out` label), asks a cheap model to classify them
// against the owner's `docs/user-scenarios/GOALS.md` + scenario docs, and records
// the verdict as labels (`scope:in|out`, `fixability:auto|needs-human`) + a
// comment. It still creates no PRs — that is F4.
//
// Dedup / idempotency — a durable `state.json` under `~/agent-data/issue-fixer/`
// (global, not per-profile: issues live in one repo, not per-user). GitHub labels
// are the primary source of truth for "what stage is this issue at" (survives a
// lost state.json); state.json additionally records the raw gate verdict.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { atomicJson } = require('./atomic-json');

const REPO = process.env.ISSUE_FIXER_REPO || 'trained-assist/trained-assist-agent';
const AGENT_DATA_DIR = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
const STATE_DIR = path.join(AGENT_DATA_DIR, 'issue-fixer');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const GATE_MODEL = process.env.ISSUE_FIXER_GATE_MODEL || 'deepseek/deepseek-chat';

// Labels this module creates and expects to already have a color the first time
// it adds them to an issue (GitHub's "add labels" endpoint 404s on an unknown
// label name — it does not auto-create, see scripts/issue-triage-openrouter.mjs
// for the same guard on the sibling triage script).
const LABEL_COLORS = {
  'fixer:queued': 'bfd4f2',
  'fixer:pr-opened': '0e8a16',
  'fixer:failed': 'd93f0b',
  'scope:in': 'c2e0c6',
  'scope:out': 'eeeeee',
  'fixability:auto': '0e8a16',
  'needs-human': 'fbca04',
};

// Labels that take an issue out of consideration entirely (gate verdicts, lifecycle,
// epics, coherence guard). `fixer:queued` is here too: once queued, a plain re-run
// should not re-select it (F3/F4 will move it to pr-opened/failed, or an operator can
// remove the label to force a re-try).
const EXCLUDE_LABELS = new Set([
  'needs-architect', 'scope:out', 'fixer:queued', 'fixer:pr-opened', 'fixer:failed', 'mixed-changes',
]);
const EPIC_LABELS = ['feat', 'architecture', 'size:XL'];

// ── State ─────────────────────────────────────────────────────────────────────
function readState(statePath = STATE_PATH) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (s && s.queued && typeof s.queued === 'object') return s;
  } catch { /* missing or unreadable -> fresh state */ }
  return { queued: {} };
}
function writeState(state, statePath = STATE_PATH) {
  try {
    atomicJson(statePath, state);
  } catch (e) {
    console.warn(`[issue-fixer] could not persist state: ${e.message}`);
  }
}

// ── Selection ─────────────────────────────────────────────────────────────────
function labelNames(issue) {
  return (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

function isEpic(names) {
  return EPIC_LABELS.every(l => names.includes(l));
}

// One open GitHub issue -> eligible for the fixer queue right now?
// Pure decision, no I/O — kept separate from `run` so it's trivially unit-testable.
function isCandidate(issue, state) {
  if (!issue || issue.state !== 'open') return false;
  if (issue.pull_request) return false; // GitHub issues API also returns PRs
  const names = labelNames(issue);
  if (names.some(l => EXCLUDE_LABELS.has(l))) return false;
  if (isEpic(names)) return false;
  // Not yet triaged (no size:* label) -> wait for issue-triage.yml, retry next tick.
  if (!names.some(l => l.startsWith('size:'))) return false;
  if (state.queued[String(issue.number)]) return false;
  return true;
}

function selectCandidates(issues, state) {
  return issues.filter(i => isCandidate(i, state)).sort((a, b) => a.number - b.number);
}

// ── GitHub ────────────────────────────────────────────────────────────────────
function resolveToken() {
  if (process.env.GITHUB_ISSUES_TOKEN) return process.env.GITHUB_ISSUES_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const url = execSync('git config --get remote.origin.url', { cwd: path.join(__dirname, '..') }).toString().trim();
    const m = url.match(/:\/\/[^:@/]+:([^@]+)@/) || url.match(/x-access-token:([^@]+)@/);
    if (m) return m[1];
  } catch { /* no token available */ }
  return null;
}

async function ghListOpenIssues(token, repo = REPO) {
  const issues = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'trained-assist-agent' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitHub list HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const batch = await res.json();
    issues.push(...batch);
    if (batch.length < 100) break;
  }
  return issues;
}

async function ghEnsureLabelExists(name, token, repo = REPO) {
  try {
    await fetch(`https://api.github.com/repos/${repo}/labels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'trained-assist-agent',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, color: LABEL_COLORS[name] || 'ededed' }),
      signal: AbortSignal.timeout(15_000),
    });
    // 201 created or 422 already-exists are both fine; a real problem (bad auth,
    // missing repo) will surface on the add-to-issue call right after this.
  } catch { /* network hiccup creating the label is not fatal on its own */ }
}

async function ghAddLabel(number, label, token, repo = REPO) {
  await ghEnsureLabelExists(label, token, repo);
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/labels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'trained-assist-agent',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ labels: [label] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub label HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function ghAddComment(number, body, token, repo = REPO) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'trained-assist-agent',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub comment HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ── Relevance-gate (F3) ──────────────────────────────────────────────────────
// "Which already-queued issues still need a gate verdict?" — pure, no I/O.
function isPendingGate(issue) {
  if (!issue || issue.state !== 'open' || issue.pull_request) return false;
  const names = labelNames(issue);
  if (!names.includes('fixer:queued')) return false;
  if (names.includes('scope:in') || names.includes('scope:out')) return false;
  return true;
}

function selectPendingGate(issues) {
  return issues.filter(isPendingGate).sort((a, b) => a.number - b.number);
}

// Owner's GOALS.md is a deliberate "источник истины" for the gate (ISSUES-TO-PR-SPEC
// §3.2) rather than a hardcoded prompt — read it plus every scenario doc fresh on
// each run so editing docs changes gate behaviour without a code change.
function loadGoalsContext(repoRoot = path.join(__dirname, '..')) {
  const scenariosDir = path.join(repoRoot, 'docs/user-scenarios');
  const goalsPath = path.join(scenariosDir, 'GOALS.md');
  const parts = [];
  try { parts.push(fs.readFileSync(goalsPath, 'utf8')); } catch { /* no GOALS.md yet -> gate leans conservative */ }
  try {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md') && full !== goalsPath) {
          parts.push(`\n\n## ${path.relative(repoRoot, full)}\n\n${fs.readFileSync(full, 'utf8')}`);
        }
      }
    };
    walk(scenariosDir);
  } catch { /* no scenarios dir yet */ }
  const combined = parts.join('\n');
  const CAP = 12_000; // keep the gate prompt small; GOALS.md itself is meant to stay short
  return combined.length > CAP ? `${combined.slice(0, CAP)}\n...(truncated)` : combined;
}

// Explicit reproduction steps in the issue body — one of the two signals (with the
// `bug` label) the conservative default below requires before it will let a model's
// fixability=auto through. Deterministic on purpose: the owner's conservative-default
// rule (checklist §"Открытые вопросы") should not depend on the model grading its own
// homework.
function hasReproHeuristic(issue) {
  const body = issue && issue.body ? issue.body : '';
  if (/steps?\s+to\s+reproduce|repro\s*:|reproduce\s*:|шаги\s+(для\s+)?воспроизвед/i.test(body)) return true;
  return /(^|\n)\s*\d+[.)]\s+\S/.test(body);
}

function buildGateMessages(issue, goalsContext) {
  const system = `Ты — гейт релевантности для автоматического фиксера issue в репозитории trained-assist-agent. Тебе даны цели/сценарии продукта (источник истины) и один открытый GitHub issue. Верни ТОЛЬКО JSON без markdown-обёртки и без пояснений вокруг, в точности такой формы:
{"scope":"in|out","breaks_scenario":"<id сценария или цели, если релевантно, иначе null>","fixability":"auto|human","area":"<домен или путь файла>","reason":"одна строка объяснения"}
scope=in только если issue относится к целям/сценариям ниже и явно НЕ входит в раздел "Вне скоупа". fixability=auto только если фикс локальный и очевидный (существующий баг в существующем сценарии) — НЕ новая фича, НЕ архитектурное решение, НЕ что-то с открытыми вопросами.`;
  const user = `# Цели и сценарии продукта\n\n${goalsContext || '(GOALS.md пуст или отсутствует)'}\n\n---\n\n# Issue #${issue.number}: ${issue.title}\n\n${(issue.body || '').slice(0, 4000)}\n\nЛейблы: ${labelNames(issue).join(', ') || '(нет)'}`;
  return { system, user };
}

function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\n([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  return JSON.parse(candidate);
}

async function openrouterClassify(issue, goalsContext, { model = GATE_MODEL, apiKey = process.env.OPENROUTER_API_KEY } = {}) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const { system, user } = buildGateMessages(issue, goalsContext);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim() || '';
  return extractJson(raw);
}

const VALID_SCOPE = ['in', 'out'];
const VALID_FIXABILITY = ['auto', 'human'];
function validateClassification(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('empty/invalid classification');
  if (!VALID_SCOPE.includes(raw.scope)) throw new Error(`invalid scope: ${JSON.stringify(raw.scope)}`);
  if (!VALID_FIXABILITY.includes(raw.fixability)) throw new Error(`invalid fixability: ${JSON.stringify(raw.fixability)}`);
  return {
    scope: raw.scope,
    breaks_scenario: raw.breaks_scenario || null,
    fixability: raw.fixability,
    area: raw.area || 'unknown',
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  };
}

// The owner's explicit conservative default (ISSUES-TO-PR-SPEC §3.2, checklist
// "Открытые вопросы владельцу"): while GOALS.md is still a draft, fixability=auto
// is allowed through ONLY for a `bug`-labeled issue with an explicit repro and
// size in {XS,S} — regardless of what the model itself said. This caps the
// model's "auto" answer down to "human"; it never upgrades a model "human".
function applyConservativeDefault(classification, { hasBugLabel, hasRepro, sizeLabel, conservative = true } = {}) {
  let fixability = classification.fixability;
  if (conservative && fixability === 'auto') {
    const sizeOk = sizeLabel === 'XS' || sizeLabel === 'S';
    if (!hasBugLabel || !hasRepro || !sizeOk) fixability = 'human';
  }
  const candidate = classification.scope === 'in' && !!classification.breaks_scenario && fixability === 'auto';
  return { ...classification, fixability, candidate };
}

function buildGateComment(verdict, model) {
  const scopeText = verdict.scope === 'in' ? 'в скоупе' : 'вне скоупа';
  const fixText = verdict.fixability === 'auto' ? 'кандидат на авто-PR (F4)' : 'нужен человек';
  const lines = [`🚦 Гейт релевантности (\`${model}\`): **${scopeText}**, ${fixText}.`, '', verdict.reason || '(без объяснения)'];
  if (verdict.breaks_scenario) lines.push('', `Затронутый сценарий/цель: \`${verdict.breaks_scenario}\``);
  if (verdict.area) lines.push(`Область: \`${verdict.area}\``);
  return lines.join('\n');
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function run({
  dryRun = false,
  token = resolveToken(),
  repo = REPO,
  now = Date.now(),
  statePath = STATE_PATH,
  listIssues = ghListOpenIssues,
  addLabel = ghAddLabel,
  logger = console,
} = {}) {
  const state = readState(statePath);
  const result = { repo, total: 0, candidates: [], queued: [], skipped: 0, errors: [] };

  let issues;
  try {
    if (!token) throw new Error('no GitHub token available');
    issues = await listIssues(token, repo);
  } catch (e) {
    result.errors.push(`list: ${e.message}`);
    return result;
  }

  result.total = issues.length;
  const candidates = selectCandidates(issues, state);
  result.skipped = issues.length - candidates.length;

  for (const issue of candidates) {
    result.candidates.push({ number: issue.number, title: issue.title, labels: labelNames(issue) });
    if (dryRun) continue;

    try {
      await addLabel(issue.number, 'fixer:queued', token, repo);
      state.queued[String(issue.number)] = { at: now, title: issue.title };
      result.queued.push(issue.number);
    } catch (e) {
      result.errors.push(`${issue.number}: ${e.message}`);
      logger.warn(`[issue-fixer] could not queue #${issue.number}: ${e.message}`);
    }
  }

  if (!dryRun && result.queued.length) writeState(state, statePath);
  return result;
}

async function runGate({
  dryRun = false,
  token = resolveToken(),
  repo = REPO,
  now = Date.now(),
  statePath = STATE_PATH,
  listIssues = ghListOpenIssues,
  addLabel = ghAddLabel,
  addComment = ghAddComment,
  classify = openrouterClassify,
  goalsContext = loadGoalsContext(),
  model = GATE_MODEL,
  conservative = true,
  logger = console,
} = {}) {
  const state = readState(statePath);
  const result = { repo, total: 0, candidates: [], gatedAuto: [], gatedHuman: [], skipped: 0, errors: [] };

  let issues;
  try {
    if (!token) throw new Error('no GitHub token available');
    issues = await listIssues(token, repo);
  } catch (e) {
    result.errors.push(`list: ${e.message}`);
    return result;
  }

  result.total = issues.length;
  const pending = selectPendingGate(issues);
  result.skipped = issues.length - pending.length;

  for (const issue of pending) {
    result.candidates.push({ number: issue.number, title: issue.title });
    if (dryRun) continue;

    try {
      const names = labelNames(issue);
      const sizeLabel = (names.find(l => l.startsWith('size:')) || '').slice('size:'.length);
      const raw = await classify(issue, goalsContext, { model });
      const validated = validateClassification(raw);
      const verdict = applyConservativeDefault(validated, {
        hasBugLabel: names.includes('bug'),
        hasRepro: hasReproHeuristic(issue),
        sizeLabel,
        conservative,
      });

      await addLabel(issue.number, verdict.scope === 'in' ? 'scope:in' : 'scope:out', token, repo);
      await addLabel(issue.number, verdict.fixability === 'auto' ? 'fixability:auto' : 'needs-human', token, repo);
      await addComment(issue.number, buildGateComment(verdict, model), token, repo);

      const existing = state.queued[String(issue.number)] || { at: now, title: issue.title };
      state.queued[String(issue.number)] = { ...existing, gate: { ...verdict, model, at: now } };
      (verdict.candidate ? result.gatedAuto : result.gatedHuman).push(issue.number);
    } catch (e) {
      result.errors.push(`${issue.number}: ${e.message}`);
      logger.warn(`[issue-fixer] gate failed for #${issue.number}: ${e.message}`);
    }
  }

  if (!dryRun && (result.gatedAuto.length || result.gatedHuman.length)) writeState(state, statePath);
  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const gate = process.argv.includes('--gate');
  const task = gate ? runGate({ dryRun }) : run({ dryRun });
  task.then((r) => {
    if (r.errors.length && r.total === 0) {
      console.error(`[issue-fixer] fatal: ${r.errors.join('; ')}`);
      process.exit(1);
    }
    if (gate) {
      console.log(`[issue-fixer:gate] repo=${r.repo} total=${r.total} pending=${r.candidates.length}` +
        `${dryRun ? ' (dry-run)' : ''} auto=${r.gatedAuto.length} human=${r.gatedHuman.length} skipped=${r.skipped} errors=${r.errors.length}`);
      for (const c of r.candidates) console.log(`  ~ #${c.number} ${c.title}`);
    } else {
      console.log(`[issue-fixer] repo=${r.repo} total=${r.total} candidates=${r.candidates.length}` +
        `${dryRun ? ' (dry-run)' : ''} queued=${r.queued.length} skipped=${r.skipped} errors=${r.errors.length}`);
      for (const c of r.candidates) console.log(`  + #${c.number} ${c.title} [${c.labels.join(',')}]`);
    }
    for (const e of r.errors) console.log(`  ! ${e}`);
    process.exit(0);
  }).catch((e) => {
    console.error('[issue-fixer] fatal:', e.message);
    process.exit(1);
  });
}

module.exports = {
  isCandidate, selectCandidates, labelNames, isEpic,
  readState, writeState, resolveToken,
  ghListOpenIssues, ghAddLabel, ghAddComment, ghEnsureLabelExists,
  run, REPO, STATE_PATH, EXCLUDE_LABELS, EPIC_LABELS, LABEL_COLORS,
  // F3 — relevance-gate
  isPendingGate, selectPendingGate, loadGoalsContext, hasReproHeuristic,
  buildGateMessages, extractJson, openrouterClassify, validateClassification,
  applyConservativeDefault, buildGateComment, runGate, GATE_MODEL,
};
