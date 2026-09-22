'use strict';
// Project abstraction — the durable "container" that a session belongs to.
//
// Model (approved with the user, 2026-09-11):
//   profile (user workspace)  ─┬─> PROJECT ─┬─> session
//                              │            └─> session   (many sessions per project)
//                              └─> PROJECT ...
//
// This inverts the old broken model where a "session" was just a Telegram chat thread
// with nowhere to live, so artifacts piled up in the workspace root (interviews/,
// expo-pipeline/, vacancy-drafts/, dozens of *.bak files …). Now every session is
// anchored to a project folder, and that folder is the session's cwd.
//
// Layout (FLAT — projects are typed by a name prefix, never nested by domain):
//   <workDir>/projects/<id>/
//       project.json           meta {id,name,type,createdAt,lastAt}
//       PROFILE.md             domain rules for this project (hand-authored, merged into system prompt)
//       agent-project-notes.md agent-LEARNED notes scoped to this project (mirrors profile-tier
//                               agent-notes.md; not seeded — Claude writes it as it learns).
//       <type scaffold>       recruiting → interviews/{transcripts,analysis}, criteria.md, applylink/
//   <workDir>/projects/active-<chatId>.json   which project this chat is currently in
//
// Project TYPE is declared by a prefix at creation time (user's "recruiting: name" idea):
//   "recruiting: Менеджер продаж"  -> {type:'recruiting', name:'Менеджер продаж'}
//   "Проект без типа"              -> {type:'generic',    name:'Проект без типа'}

const fs = require('fs');
const path = require('path');

const PROJECTS_DIR = 'projects';
const META_FILE = 'project.json';
const PROFILE_FILE = 'PROFILE.md';
const NOTES_FILE = 'agent-project-notes.md';
const MAX_NAME = 120;

// ── Type registry ─────────────────────────────────────────────────────────────
// Each type declares: matching prefixes, a human label, the folder scaffold to roll
// out on creation, and a PROFILE.md seed with domain rules that stack with the persona.
// Start with `recruiting` (structure matches the existing interview/applylink paths so
// migration is a move, not a rewrite). Add sales/production later by the same schema.
const TYPES = {
  recruiting: {
    label: 'Рекрутинг',
    prefixes: ['recruiting', 'рекрутинг', 'hr', 'вакансия', 'найм'],
    dirs: ['interviews', 'interviews/transcripts', 'interviews/analysis', 'applylink'],
    seedFiles: {
      'criteria.md': '# Критерии оценки (эталон заказчика)\n\nОпиши здесь профиль ДА / красные флаги. Используется interview_analyze для всех разборов этого проекта.\n',
    },
    profile:
      '# Домен проекта: Рекрутинг\n\n' +
      '- Тип работы: подбор кандидатов на конкретную вакансию.\n' +
      '- Разборы интервью — через interview_analyze; эталон — criteria.md этого проекта.\n' +
      '- Отклики/форма — applylink/ этого проекта.\n' +
      '- Все транскрипты и анализы кладём в interviews/, не в корень профиля.\n',
  },
  expo: {
    label: 'Выставка',
    prefixes: ['expo', 'выставка', 'exhibition', 'экспо'],
    dirs: ['site', 'site/_archive', 'deploy', 'data'],
    seedFiles: {
      'EVENT.md':
        '# Выставка\n\n' +
        '- EVENT_KEY: <напр. flowersexpo2026>\n' +
        '- Дата / город:\n' +
        '- Каталог-сайт: site/<slug>.html → deploy/<slug>/index.html\n' +
        '- Telegram-бот: deploy/<slug>/telegram_companies.json\n' +
        '- Деплой: npx wrangler pages deploy deploy/<slug> --project-name <slug>\n',
    },
    profile:
      '# Домен проекта: Выставка (Flexi)\n\n' +
      '- Одна выставка = один проект. Time-boxed: собрали участников → каталог → отработали стенды → закрыли.\n' +
      '- Каталог-сайт живёт в site/, собранный деплой — в deploy/<slug>/ (index.html + telegram_companies.json).\n' +
      '- Пер-выставочные pipeline-данные (участники, ИНН, финансы, EX-массив) — в data/, не в корень профиля.\n' +
      '- Общие данные (brands.json, cpm-list.json, критерии классификации) — durable-инфра профиля, НЕ копируются в проект.\n' +
      '- Классификация target/near-target и revenue-фильтры — через expo_* инструменты.\n' +
      '- Деплой: npx wrangler pages deploy deploy/<slug> --project-name <slug>.\n',
  },
  bugs: {
    label: 'Баги и фичи',
    // Canonical id — one reserved project per profile (owner's voice: "создаётся сессия
    // в папке Bugs and Features"), never a fresh id-<n> per report like other types.
    id: 'bugs-and-features',
    prefixes: [
      'bugs', 'bug', 'баги', 'баг', 'фичи', 'фича', 'features', 'feature',
      'bugs and features', 'bug and features',
    ],
    dirs: ['reports', '_processed', 'collector'],
    seedFiles: {
      'reports/README.md':
        '# Контракт: reports/\n\n' +
        'Одна папка на один инцидент/фичу: `reports/<YYYY-MM-DD>-<slug>/`.\n\n' +
        '- `report.json` — `{id, kind:"bug"|"feature", title, summary, status:"open", severity, area, createdAt, sessionId, attachments:[]}`\n' +
        '- `transcript.md` — сырые сообщения пользователя (текст + транскрипты голоса)\n' +
        '- `attachments/` — скопированные скриншоты/фото/файлы\n' +
        '- `evidence/` — логи/сниппеты\n\n' +
        'На каждый отчёт обязательна одна строка в `../index.jsonl` (главный фид сборщика).\n',
      'collector/README.md':
        '# Контракт: как сборщик читает этот проект\n\n' +
        'Сборщик — отдельный сервис (вне этого проекта), который:\n\n' +
        '1. Читает `../index.jsonl` (append-only, 1 строка = 1 отчёт) с курсором.\n' +
        '2. Берёт записи со `status:"open"`.\n' +
        '3. Делает своё дело (дедуп/группировка/триаж/фикс-сессия).\n' +
        '4. Помечает `status:"processed"` и/или переносит папку отчёта в `../_processed/`.\n\n' +
        'Формат строки индекса: `{id, kind, title, dir, status, createdAt, sessionId}`.\n',
    },
    profile:
      '# Домен проекта: Приём баг/фич\n\n' +
      '- Ты — приёмщик багов и предложений. Вход — сессия из нескольких сообщений (текст, голос,\n' +
      '  скриншоты), накопленных пользователем.\n' +
      '- Классифицируй: баг или фича.\n' +
      '- Для КАЖДОГО инцидента создай `reports/<дата>-<slug>/`: `report.json` (см. reports/README.md),\n' +
      '  `transcript.md` (сырые сообщения), `attachments/` (скопируй вложения), `evidence/`.\n' +
      '- Допиши одну строку в `index.jsonl` — это фид сборщика. Не создавай GitHub issues.\n' +
      '- Ничего не удаляй; структурируй как считаешь полезным, «от души».\n',
  },
  generic: {
    label: 'Проект',
    prefixes: ['project', 'проект'],
    dirs: [],
    seedFiles: {},
    profile: '# Проект\n\nДоменных правил пока нет. Добавь их сюда — они попадут в системный промпт сессий этого проекта.\n',
  },
};

function typeOf(key) {
  return TYPES[key] || TYPES.generic;
}

// ── Naming ──────────────────────────────────────────────────────────────────

// Split a "type: name" input into {type, name}. Unknown/absent prefix -> generic.
function parseTypedName(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/^([\p{L}]+)\s*[:：]\s*(.+)$/u);
  if (m) {
    const key = m[1].toLowerCase();
    for (const [type, def] of Object.entries(TYPES)) {
      if (type === key || def.prefixes.includes(key)) {
        return { type, name: m[2].trim().slice(0, MAX_NAME) };
      }
    }
  }
  return { type: 'generic', name: raw.slice(0, MAX_NAME) };
}

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9а-я]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'project';
}

// ── Paths ─────────────────────────────────────────────────────────────────────

function projectsRoot(workDir) {
  return path.join(workDir, PROJECTS_DIR);
}
function projectDir(workDir, id) {
  return path.join(projectsRoot(workDir), id);
}
function metaPath(workDir, id) {
  return path.join(projectDir(workDir, id), META_FILE);
}
function profilePath(workDir, id) {
  return path.join(projectDir(workDir, id), PROFILE_FILE);
}
function notesPath(workDir, id) {
  return path.join(projectDir(workDir, id), NOTES_FILE);
}

function atomicWrite(fp, data) {
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

function getProject(workDir, id) {
  if (!workDir || !id) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(workDir, id), 'utf8'));
  } catch {
    return null;
  }
}

// List projects (meta only), most-recently-touched first.
function listProjects(workDir) {
  const root = projectsRoot(workDir);
  let ids = [];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
  return ids
    .map(id => getProject(workDir, id))
    .filter(Boolean)
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

// Re-sort a project list by usage (session count) descending, most-recent as tiebreaker.
// `countByProject` ({id: count}) lives in session-store, not here, so callers that have
// it (server.js) pass it in; without it we keep the recency-only order from listProjects.
function sortByUsage(list, countByProject) {
  if (!countByProject) return list;
  return [...list].sort((a, b) => {
    const ca = countByProject[a.id] || 0, cb = countByProject[b.id] || 0;
    if (cb !== ca) return cb - ca;
    return (b.lastAt || 0) - (a.lastAt || 0);
  });
}

// Create a project from a raw "type: name" string (or explicit {name,type}).
// Rolls out the type scaffold + PROFILE.md. Idempotent by id: existing project is returned.
function createProject(workDir, input, { now = Date.now() } = {}) {
  const parsed = typeof input === 'string'
    ? parseTypedName(input)
    : { type: input.type || 'generic', name: input.name || 'project' };
  const def = typeOf(parsed.type);

  // Singleton types (e.g. bugs -> bugs-and-features) declare a fixed canonical id: reuse
  // the existing project instead of minting a sibling. Other types: <type>-<slug>[-n].
  let id;
  if (def.id) {
    id = def.id;
    const existing = getProject(workDir, id);
    if (existing) return existing;
  } else {
    const base = `${parsed.type}-${slugify(parsed.name)}`;
    id = base;
    let n = 2;
    // If a real project already lives at `id`, make a fresh sibling instead of colliding.
    while (getProject(workDir, id)) id = `${base}-${n++}`;
  }

  const dir = projectDir(workDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of def.dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const [rel, content] of Object.entries(def.seedFiles)) {
    const fp = path.join(dir, rel);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
  }
  const pfp = profilePath(workDir, id);
  if (!fs.existsSync(pfp)) fs.writeFileSync(pfp, def.profile);

  const meta = { id, name: parsed.name, type: parsed.type, label: def.label, createdAt: now, lastAt: now };
  atomicWrite(metaPath(workDir, id), JSON.stringify(meta, null, 2));
  return meta;
}

function touchProject(workDir, id, { now = Date.now() } = {}) {
  const meta = getProject(workDir, id);
  if (!meta) return;
  meta.lastAt = now;
  try { atomicWrite(metaPath(workDir, id), JSON.stringify(meta, null, 2)); } catch { /* best-effort */ }
}

// ── Name + 3-sense summary (durable, LLM-generated, regenerated as project grows) ──
// The folder/id is immutable; only the display `name` + `summary` change. `nameLocked`
// is set when the user renames by hand — auto-naming then leaves the name alone but may
// still refresh the summary. `summarySessionCount` records how many sessions the summary
// reflects, so we know when it's stale.
function setProjectSummary(workDir, id, { name, summary, type } = {}, sessionCount, { now = Date.now() } = {}) {
  const meta = getProject(workDir, id);
  if (!meta) return false;
  if (name && !meta.nameLocked) meta.name = name;
  if (summary) meta.summary = summary;
  if (type && meta.type === 'generic' && TYPES[type]) { meta.type = type; meta.label = typeOf(type).label; }
  if (typeof sessionCount === 'number') meta.summarySessionCount = sessionCount;
  meta.summaryAt = now;
  try { atomicWrite(metaPath(workDir, id), JSON.stringify(meta, null, 2)); return true; }
  catch { return false; }
}

// True when a project's summary is missing or the session count grew since we last made it.
function needsSummary(meta, sessionCount) {
  if (!meta) return false;
  if (!meta.summary || !meta.summary.start) return true;
  if (typeof sessionCount === 'number') return (meta.summarySessionCount || 0) !== sessionCount;
  return false;
}

// Manual rename — display-only, and locks the name against auto-naming.
function renameProject(workDir, id, name, { now = Date.now() } = {}) {
  const meta = getProject(workDir, id);
  if (!meta) return null;
  meta.name = String(name || '').trim().slice(0, MAX_NAME) || meta.name;
  meta.nameLocked = true;
  meta.lastAt = now;
  try { atomicWrite(metaPath(workDir, id), JSON.stringify(meta, null, 2)); } catch { /* best-effort */ }
  return meta;
}

// Reversible "delete": move the project folder under projects/_archive/ instead of rm.
// Returns the archive path, or null if nothing moved. Never removes session data.
function archiveProject(workDir, id) {
  const dir = projectDir(workDir, id);
  if (!fs.existsSync(dir)) return null;
  const archiveRoot = path.join(projectsRoot(workDir), '_archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  let dest = path.join(archiveRoot, id);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(archiveRoot, `${id}-${n++}`);
  fs.renameSync(dir, dest);
  return dest;
}

// Canonical "Bugs and Features" reserved project — finds the existing bugs-type project,
// or creates the singleton if none exists yet. Idempotent; safe to call on every
// /bug_or_feature invocation.
function bugsProject(workDir, { now = Date.now() } = {}) {
  const existing = listProjects(workDir).find(p => p.type === 'bugs');
  if (existing) return existing;
  return createProject(workDir, { type: 'bugs', name: TYPES.bugs.label }, { now });
}

// ── Active project per chat ─────────────────────────────────────────────────

function _activePath(workDir, chatId) {
  return path.join(projectsRoot(workDir), `active-${chatId || 'default'}.json`);
}
function getActiveProjectId(workDir, chatId) {
  try {
    const { id } = JSON.parse(fs.readFileSync(_activePath(workDir, chatId), 'utf8'));
    return getProject(workDir, id) ? id : null; // ignore stale pointer
  } catch {
    return null;
  }
}
function setActiveProjectId(workDir, id, chatId, { now = Date.now() } = {}) {
  try {
    fs.mkdirSync(projectsRoot(workDir), { recursive: true });
    atomicWrite(_activePath(workDir, chatId), JSON.stringify({ id, at: now }));
    touchProject(workDir, id, { now });
  } catch (e) {
    console.warn('[projects] setActiveProjectId:', e.message);
  }
}

// ── Binding decision for a NEW session ──────────────────────────────────────
// Pure over the on-disk state. Caller (runner/gateway) turns 'ask' into a prompt.
//   { action:'auto',   project }              exactly one project -> bind silently
//   { action:'ask',    choices, active }      several projects   -> ask which / offer new
//   { action:'create', suggestType }          no projects yet    -> create the first one
// A CONTINUING session never calls this — it keeps the project stored on the session.
function decideNewSessionProject(workDir, chatId, countByProject) {
  const projects = sortByUsage(listProjects(workDir), countByProject);
  if (projects.length === 0) return { action: 'create', suggestType: 'generic' };
  if (projects.length === 1) return { action: 'auto', project: projects[0] };
  return { action: 'ask', choices: projects, active: getActiveProjectId(workDir, chatId) };
}

// PROFILE.md text for merging into the system prompt (null if none).
function profileText(workDir, id) {
  if (!id) return null;
  try {
    const t = fs.readFileSync(profilePath(workDir, id), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

// agent-project-notes.md text — same shape as profile-tier agent-notes.md, but scoped to
// one project. Never seeded (unlike PROFILE.md): only exists once Claude/Hermes writes
// something project-specific it learned, so an empty file never pollutes the prompt.
function notesText(workDir, id) {
  if (!id) return null;
  try {
    const t = fs.readFileSync(notesPath(workDir, id), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

module.exports = {
  TYPES,
  parseTypedName,
  slugify,
  projectsRoot,
  projectDir,
  profilePath,
  notesPath,
  getProject,
  listProjects,
  sortByUsage,
  createProject,
  bugsProject,
  touchProject,
  getActiveProjectId,
  setActiveProjectId,
  decideNewSessionProject,
  profileText,
  notesText,
  setProjectSummary,
  needsSummary,
  renameProject,
  archiveProject,
};
