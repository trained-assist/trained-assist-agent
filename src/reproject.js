'use strict';
// Project restructuring engine — recluster a profile's sessions into projects
// using CHEAP models (not Claude), interactively and reversibly.
//
// Motivation (approved with the user, 2026-09-12): a profile can accumulate dozens
// of sessions that logically belong to different projects (e.g. one vacancy = one
// recruiting project), but were all created before the projects abstraction or under
// the wrong project. Re-sorting them by hand is Claude-expensive and error-prone.
// This engine does the classification with several passes of a cheap/free model and
// leaves Claude only for orchestration + talking to the user.
//
// Non-negotiable rules baked in here (product-owner constraints):
//   1. NOTHING moves on disk without an explicit apply({confirm:true}).
//   2. Every apply writes a LEDGER (prior projectId per session) → fully reversible
//      via revertPlan(). No silent, unrecoverable mutation.
//   3. Classification uses cheap models (REPROJECT_MODEL, default deepseek/deepseek-chat).
//      Model is swappable so we can move to free models later without touching logic.
//   4. Iteration state is durable on disk (projects/.reproject-state.json) so the loop
//      survives a crash / SIGTERM and the user can refine "as many cycles as they want".
//
// This module is PURE logic + I/O helpers. The MCP tool layer (tools/06-reproject.js)
// turns it into reproject_preview / reproject_apply / reproject_revert.

const fs = require('fs');
const path = require('path');

const projects = require('./projects');

const STATE_FILE = '.reproject-state.json';
const LEDGER_FILE = '.reproject-ledger.json';
const DEFAULT_MODEL = process.env.REPROJECT_MODEL || 'deepseek/deepseek-chat';
// Consolidation/naming can use an even cheaper tier; override independently if wanted.
const CONSOLIDATE_MODEL = process.env.REPROJECT_CONSOLIDATE_MODEL || DEFAULT_MODEL;

// ── Profile / session I/O ─────────────────────────────────────────────────────

function sessionIndexPath(profileRoot) {
  return path.join(profileRoot, 'sessions.json');
}
function sessionFilePath(profileRoot, id) {
  return path.join(profileRoot, 'sessions', `${id}.json`);
}
function stateFilePath(profileRoot) {
  return path.join(profileRoot, 'projects', STATE_FILE);
}
function ledgerPath(profileRoot) {
  return path.join(profileRoot, 'projects', LEDGER_FILE);
}

function atomicWrite(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

function readIndex(profileRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionIndexPath(profileRoot), 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.sessions)) return raw.sessions;
    return Object.values(raw);
  } catch {
    return [];
  }
}

// Compact digest of a session for the classifier: head (goal) + tail (outcome),
// heavily clipped so a whole profile fits in one cheap-model prompt.
function digestSession(profileRoot, meta, { headMsgs = 2, tailMsgs = 3, perMsg = 400 } = {}) {
  let messages = [];
  try {
    const s = JSON.parse(fs.readFileSync(sessionFilePath(profileRoot, meta.id), 'utf8'));
    messages = Array.isArray(s.messages) ? s.messages : [];
  } catch {
    /* fall back to index-level snippets */
  }
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, perMsg);
  let lines;
  if (messages.length === 0) {
    lines = [meta.topic, meta.lastUserMessage, meta.lastAssistantSnippet].filter(Boolean).map(clip);
  } else {
    const picked = messages.length <= headMsgs + tailMsgs
      ? messages
      : [...messages.slice(0, headMsgs), ...messages.slice(-tailMsgs)];
    lines = picked.map(m => `${m.role === 'user' ? 'U' : 'A'}: ${clip(m.content)}`);
  }
  return {
    id: meta.id,
    topic: String(meta.topic || '').slice(0, 120),
    projectId: meta.projectId || null,
    messageCount: meta.messageCount || messages.length || 0,
    lastAt: meta.lastAt || 0,
    digest: lines.join('\n').slice(0, 1400),
  };
}

function gatherSessions(profileRoot, opts = {}) {
  return readIndex(profileRoot).map(m => digestSession(profileRoot, m, opts));
}

// ── Cheap model call (OpenRouter, mirrors session-summary.js) ─────────────────

async function callModel({ system, user, apiKey, model = DEFAULT_MODEL, timeoutMs = 60000 }) {
  const orKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (!orKey) throw new Error('OPENROUTER_API_KEY not set — cheap-model classification unavailable');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return parseJsonLoose(text);
  } finally {
    clearTimeout(timer);
  }
}

// Cheap models sometimes wrap JSON in prose/markdown — extract the first balanced object.
function parseJsonLoose(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch { /* try to extract */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* give up */ }
  }
  throw new Error('Model did not return parseable JSON');
}

// ── Cycle 1: assign each session a raw cluster ────────────────────────────────

const CLUSTER_SYSTEM = [
  'Ты классифицируешь рабочие сессии пользователя по проектам.',
  'Проект — это одна связная линия работы (например: одна вакансия/найм, одна выставка, одна разработка).',
  'Тебе дают критерий группировки от пользователя и список сессий (id + краткая выжимка).',
  'Верни СТРОГО JSON: {"assignments":[{"id","cluster","name","type","confidence","reason"}]}.',
  '- cluster: короткий стабильный ключ кластера (латиница/цифры/дефис), одинаковый для сессий одного проекта.',
  '- name: человекочитаемое имя проекта на языке сессий.',
  '- type: один из recruiting|expo|generic (recruiting=подбор/вакансия, expo=выставка, иначе generic).',
  '- confidence: 0..1.',
  '- reason: 1 короткая фраза почему.',
  'Не выдумывай факты. Одинаковые проекты обязаны иметь одинаковый cluster.',
].join('\n');

async function clusterSessions(sessions, criteria, opts = {}) {
  const chunkSize = opts.chunkSize || 40;
  const assignments = [];
  for (let i = 0; i < sessions.length; i += chunkSize) {
    const chunk = sessions.slice(i, i + chunkSize);
    const user = [
      `Критерий группировки от пользователя: ${criteria || 'одна линия работы = один проект; для рекрутинга одна вакансия = один проект'}`,
      '',
      'Сессии:',
      ...chunk.map(s => `--- id=${s.id} (msgs=${s.messageCount})\ntopic: ${s.topic}\n${s.digest}`),
    ].join('\n');
    const out = await callModel({ system: CLUSTER_SYSTEM, user, model: opts.model || DEFAULT_MODEL, apiKey: opts.apiKey });
    for (const a of (out.assignments || [])) {
      if (a && a.id) assignments.push(a);
    }
  }
  return assignments;
}

// ── Cycle 2: consolidate near-duplicate clusters into canonical projects ──────

const CONSOLIDATE_SYSTEM = [
  'Тебе дают черновые кластеры проектов (ключ + имя + сколько сессий).',
  'Некоторые описывают ОДИН И ТОТ ЖЕ проект разными словами. Объедини такие.',
  'Верни СТРОГО JSON: {"map":{"<исходный cluster>":"<канонический cluster>"},"projects":[{"cluster","name","type"}]}.',
  'Канонический cluster — латиница/цифры/дефис. name — самое ясное имя. type — recruiting|expo|generic.',
  'Не объединяй разные проекты. Если сомневаешься — оставь раздельными.',
].join('\n');

async function consolidateClusters(assignments, opts = {}) {
  const byCluster = new Map();
  for (const a of assignments) {
    const k = a.cluster || 'unassigned';
    if (!byCluster.has(k)) byCluster.set(k, { cluster: k, name: a.name || k, type: a.type || 'generic', count: 0 });
    byCluster.get(k).count++;
  }
  const raw = [...byCluster.values()];
  // Nothing to merge → identity map.
  if (raw.length <= 1) {
    return { map: Object.fromEntries(raw.map(r => [r.cluster, r.cluster])), projects: raw };
  }
  const user = 'Черновые кластеры:\n' + raw.map(r => `- ${r.cluster} | "${r.name}" | ${r.type} | ${r.count} сессий`).join('\n');
  let out;
  try {
    out = await callModel({ system: CONSOLIDATE_SYSTEM, user, model: opts.model || CONSOLIDATE_MODEL, apiKey: opts.apiKey });
  } catch {
    out = null; // consolidation is best-effort; fall back to identity
  }
  const map = (out && out.map) || Object.fromEntries(raw.map(r => [r.cluster, r.cluster]));
  const projects = (out && Array.isArray(out.projects) && out.projects.length)
    ? out.projects
    : raw.map(r => ({ cluster: r.cluster, name: r.name, type: r.type }));
  // Ensure every source cluster has a mapping.
  for (const r of raw) if (!map[r.cluster]) map[r.cluster] = r.cluster;
  return { map, projects };
}

// ── Build a plan (structured, non-destructive) ────────────────────────────────

function buildPlan(profileRoot, sessions, assignments, consolidation) {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const existing = projects.listProjects(profileRoot);
  // canonical cluster -> project bucket
  const buckets = new Map();
  const projMeta = new Map((consolidation.projects || []).map(p => [p.cluster, p]));
  const unassigned = [];

  for (const s of sessions) {
    const a = assignments.find(x => x.id === s.id);
    if (!a || !a.cluster) {
      unassigned.push({ id: s.id, topic: s.topic, reason: a && a.reason ? a.reason : 'модель не отнесла сессию ни к одному проекту' });
      continue;
    }
    const canon = consolidation.map[a.cluster] || a.cluster;
    if (!buckets.has(canon)) {
      const pm = projMeta.get(canon) || { name: a.name || canon, type: a.type || 'generic' };
      buckets.set(canon, {
        cluster: canon,
        name: pm.name || a.name || canon,
        type: pm.type || a.type || 'generic',
        sessionIds: [],
        confidences: [],
        members: [], // per-session detail for the report
      });
    }
    const b = buckets.get(canon);
    b.sessionIds.push(s.id);
    const conf = typeof a.confidence === 'number' ? a.confidence : null;
    if (conf != null) b.confidences.push(conf);
    b.members.push({ id: s.id, topic: s.topic, confidence: conf, reason: a.reason || '' });
  }

  const plannedProjects = [...buckets.values()].map(b => {
    // Match to an existing project by (type + slug) so we re-tag instead of duplicating.
    const slug = `${b.type}-${projects.slugify(b.name)}`;
    const match = existing.find(e => e.id === slug || e.id.startsWith(slug + '-'));
    const avgConf = b.confidences.length ? b.confidences.reduce((x, y) => x + y, 0) / b.confidences.length : null;
    const minConf = b.confidences.length ? Math.min(...b.confidences) : null;
    // Sessions the model was unsure about — these are the "ambiguous fit to this folder".
    const weakMembers = b.members
      .filter(m => m.confidence != null && m.confidence < 0.6)
      .sort((x, y) => (x.confidence || 0) - (y.confidence || 0));
    // Clarity of the folder itself: how cleanly its sessions belong here.
    //   clear    — everything confidently in one line of work (a good, obvious folder)
    //   mixed    — mostly fits but a few sessions are borderline (check those)
    //   weak     — low average / single lonely session → the folder itself is doubtful
    let clarity;
    if (avgConf == null) clarity = 'weak';
    else if (avgConf >= 0.75 && weakMembers.length === 0) clarity = 'clear';
    else if (avgConf >= 0.55) clarity = 'mixed';
    else clarity = 'weak';
    if (b.sessionIds.length === 1 && (avgConf == null || avgConf < 0.85)) clarity = 'weak';
    return {
      name: b.name,
      type: b.type,
      existingProjectId: match ? match.id : null,
      sessionCount: b.sessionIds.length,
      sessionIds: b.sessionIds,
      avgConfidence: avgConf == null ? null : Math.round(avgConf * 100) / 100,
      minConfidence: minConf == null ? null : Math.round(minConf * 100) / 100,
      clarity,
      weakMembers: weakMembers.map(m => ({ ...m, confidence: m.confidence == null ? null : Math.round(m.confidence * 100) / 100 })),
    };
  }).sort((a, b) => b.sessionCount - a.sessionCount);

  const warnings = [];
  if (unassigned.length) warnings.push(`${unassigned.length} сессий не классифицированы — останутся без проекта.`);
  const weakProjects = plannedProjects.filter(p => p.clarity === 'weak');
  if (weakProjects.length) warnings.push(`${weakProjects.length} проект(ов) со спорной границей — модель не уверена, что это отдельная линия работы.`);

  return {
    generatedAt: null, // stamped by caller (Date.now unavailable in some harnesses)
    totalSessions: sessions.length,
    projects: plannedProjects,
    unassigned,
    warnings,
  };
}

// ── Render a human report ─────────────────────────────────────────────────────

const CLARITY = {
  clear: { icon: '🟢', label: 'чёткая папка', note: 'все сессии уверенно про одно и то же — папку можно принимать как есть.' },
  mixed: { icon: '🟡', label: 'в основном ок, есть спорные', note: 'ядро сессий подходит, но пару сессий стоит глянуть глазами (ниже помечены).' },
  weak: { icon: '🔴', label: 'спорная папка', note: 'модель не уверена, что это отдельная линия работы (низкая уверенность или одинокая сессия). Возможно, это часть другого проекта или наоборот две разные темы в одной куче.' },
};

function renderReport(plan) {
  const L = [];
  L.push('# Предлагаемая структура проектов');
  L.push('');

  // ── Что это и как читать ────────────────────────────────────────────────
  L.push('## Что произошло');
  L.push('Я прошёлся по всем сессиям профиля дешёвой моделью-классификатором (не Claude — несколько быстрых проходов) и сгруппировал их в **проекты**. Проект = одна связная линия работы: одна вакансия, одна выставка, одна разработка. Каждой сессии модель поставила проект и **уверенность** (0–1) — насколько ей очевидно, что сессия относится именно сюда.');
  L.push('');
  L.push('**Ничего пока не перемещено** — это только предложение. Смотрим, где границы папок хорошие, а где спорные, правим критерий и повторяем сколько нужно. Применение (когда одобрите) полностью обратимо.');
  L.push('');
  L.push('**Как читать статус папки:**');
  L.push(`- ${CLARITY.clear.icon} **${CLARITY.clear.label}** — ${CLARITY.clear.note}`);
  L.push(`- ${CLARITY.mixed.icon} **${CLARITY.mixed.label}** — ${CLARITY.mixed.note}`);
  L.push(`- ${CLARITY.weak.icon} **${CLARITY.weak.label}** — ${CLARITY.weak.note}`);
  L.push('');

  const clear = plan.projects.filter(p => p.clarity === 'clear').length;
  const mixed = plan.projects.filter(p => p.clarity === 'mixed').length;
  const weak = plan.projects.filter(p => p.clarity === 'weak').length;
  L.push(`**Итого:** ${plan.totalSessions} сессий → ${plan.projects.length} проектов (${CLARITY.clear.icon} ${clear} чётких · ${CLARITY.mixed.icon} ${mixed} со спорными · ${CLARITY.weak.icon} ${weak} спорных) · без проекта: ${plan.unassigned.length}.`);
  L.push('');
  L.push('---');
  L.push('');

  // ── Проекты ─────────────────────────────────────────────────────────────
  for (const p of plan.projects) {
    const c = CLARITY[p.clarity] || CLARITY.mixed;
    const tag = p.existingProjectId ? `существующая папка \`${p.existingProjectId}\`` : '**новая папка**';
    const conf = p.avgConfidence == null ? 'уверенность: н/д' : `уверенность ${p.avgConfidence}`;
    L.push(`## ${c.icon} ${p.name}`);
    L.push(`тип: ${p.type} · ${p.sessionCount} сессий · ${conf} · ${tag}`);
    L.push(`_${c.label}: ${c.note}_`);
    if (p.weakMembers && p.weakMembers.length) {
      L.push('');
      L.push('Сессии, которые сюда легли неоднозначно (проверь — возможно, им место в другом проекте):');
      for (const m of p.weakMembers.slice(0, 8)) {
        const why = m.reason ? ` — ${m.reason}` : '';
        L.push(`- «${m.topic || m.id}» (уверенность ${m.confidence ?? '—'})${why}`);
      }
    }
    L.push('');
  }

  // ── Без проекта ─────────────────────────────────────────────────────────
  if (plan.unassigned.length) {
    L.push('---');
    L.push(`## ⚪ Без проекта (${plan.unassigned.length})`);
    L.push('Модель не смогла отнести эти сессии ни к одной линии работы — останутся без папки, пока не уточним критерий:');
    for (const u of plan.unassigned.slice(0, 10)) {
      L.push(`- «${u.topic || u.id}»${u.reason ? ` — ${u.reason}` : ''}`);
    }
    L.push('');
  }

  // ── Что дальше ──────────────────────────────────────────────────────────
  L.push('---');
  if (plan.warnings.length) {
    L.push('**На что обратить внимание:**');
    for (const w of plan.warnings) L.push(`- ${w}`);
    L.push('');
  }
  L.push('**Дальше:**');
  L.push('- Всё нравится → скажите «применяй» (перепривяжу сессии к папкам, обратимо — откат одной командой).');
  L.push('- Что-то не так → скажите, что именно (напр. «разбей X по заказчикам» / «объедини Y и Z» / «это не отдельный проект»), уточню критерий и пересоберу.');
  return L.join('\n');
}

// ── Apply / revert (reversible) ───────────────────────────────────────────────

// Re-tag sessions to their planned projects. Creates new projects as needed.
// Writes a ledger of prior projectId per session so revertPlan() can undo.
// NOTE: this re-tags projectId in the session index + session files. Moving
// cwd-relative artifacts (interviews/ etc.) is a separate backfill step, left out
// here on purpose — re-tagging is the reversible core; artifact moves come later.
function applyPlan(profileRoot, plan, { dryRun = true, now = Date.now() } = {}) {
  const index = readIndex(profileRoot);
  const byId = new Map(index.map(m => [m.id, m]));
  const actions = [];
  const ledger = { at: now, moves: [] };

  // Resolve/ensure a project id for each planned project.
  const projectIdFor = new Map();
  for (const p of plan.projects) {
    let id = p.existingProjectId;
    if (!id) {
      if (dryRun) {
        id = `${p.type}-${projects.slugify(p.name)}`; // predicted id
        actions.push({ kind: 'create-project', id, name: p.name, type: p.type, dryRun: true });
      } else {
        const meta = projects.createProject(profileRoot, { name: p.name, type: p.type }, { now });
        id = meta.id;
        actions.push({ kind: 'create-project', id, name: p.name, type: p.type });
      }
    }
    projectIdFor.set(p, id);
  }

  // Re-tag sessions.
  for (const p of plan.projects) {
    const pid = projectIdFor.get(p);
    for (const sid of p.sessionIds) {
      const meta = byId.get(sid);
      const prev = meta ? (meta.projectId || null) : null;
      if (prev === pid) continue;
      ledger.moves.push({ id: sid, from: prev, to: pid });
      actions.push({ kind: 'retag', id: sid, from: prev, to: pid, dryRun });
      if (!dryRun && meta) {
        meta.projectId = pid;
        // mirror into the per-session file if present
        try {
          const fp = sessionFilePath(profileRoot, sid);
          const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
          s.projectId = pid;
          atomicWrite(fp, JSON.stringify(s));
        } catch { /* session file may not exist */ }
      }
    }
  }

  if (!dryRun) {
    atomicWrite(sessionIndexPath(profileRoot), JSON.stringify(index, null, 2));
    atomicWrite(ledgerPath(profileRoot), JSON.stringify(ledger, null, 2));
  }

  return { dryRun, actions, moves: ledger.moves.length, ledgerWritten: !dryRun };
}

function revertPlan(profileRoot, { now = Date.now() } = {}) {
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath(profileRoot), 'utf8'));
  } catch {
    return { reverted: 0, error: 'no ledger found — nothing to revert' };
  }
  const index = readIndex(profileRoot);
  const byId = new Map(index.map(m => [m.id, m]));
  let n = 0;
  for (const mv of (ledger.moves || [])) {
    const meta = byId.get(mv.id);
    if (!meta) continue;
    meta.projectId = mv.from;
    n++;
    try {
      const fp = sessionFilePath(profileRoot, mv.id);
      const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
      s.projectId = mv.from;
      atomicWrite(fp, JSON.stringify(s));
    } catch { /* best-effort */ }
  }
  atomicWrite(sessionIndexPath(profileRoot), JSON.stringify(index, null, 2));
  // Consume the ledger so a double-revert can't re-apply.
  try { fs.renameSync(ledgerPath(profileRoot), `${ledgerPath(profileRoot)}.reverted-${now}`); } catch { /* ignore */ }
  return { reverted: n };
}

// ── State persistence (iterative refinement across cycles/crashes) ────────────

function saveState(profileRoot, state) {
  atomicWrite(stateFilePath(profileRoot), JSON.stringify(state, null, 2));
}
function loadState(profileRoot) {
  try { return JSON.parse(fs.readFileSync(stateFilePath(profileRoot), 'utf8')); } catch { return null; }
}

// ── One full preview cycle (gather → cluster → consolidate → plan) ────────────

async function preview(profileRoot, { criteria, apiKey, model, now = Date.now() } = {}) {
  const sessions = gatherSessions(profileRoot);
  if (!sessions.length) return { error: 'no sessions found for this profile' };
  const assignments = await clusterSessions(sessions, criteria, { apiKey, model });
  const consolidation = await consolidateClusters(assignments, { apiKey });
  const plan = buildPlan(profileRoot, sessions, assignments, consolidation);
  plan.generatedAt = now;
  const state = { criteria: criteria || null, at: now, plan, assignments };
  saveState(profileRoot, state);
  return { plan, report: renderReport(plan) };
}

module.exports = {
  DEFAULT_MODEL,
  gatherSessions,
  digestSession,
  clusterSessions,
  consolidateClusters,
  buildPlan,
  renderReport,
  applyPlan,
  revertPlan,
  preview,
  saveState,
  loadState,
  callModel,
  parseJsonLoose,
  stateFilePath,
  ledgerPath,
};
