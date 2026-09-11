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
//       project.json          meta {id,name,type,createdAt,lastAt}
//       PROFILE.md            domain rules for this project (merged into the system prompt)
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

// Create a project from a raw "type: name" string (or explicit {name,type}).
// Rolls out the type scaffold + PROFILE.md. Idempotent by id: existing project is returned.
function createProject(workDir, input, { now = Date.now() } = {}) {
  const parsed = typeof input === 'string'
    ? parseTypedName(input)
    : { type: input.type || 'generic', name: input.name || 'project' };
  const def = typeOf(parsed.type);

  // Unique id: <type>-<slug>[-n]
  const base = `${parsed.type}-${slugify(parsed.name)}`;
  let id = base;
  let n = 2;
  // If a real project already lives at `id`, make a fresh sibling instead of colliding.
  while (getProject(workDir, id)) id = `${base}-${n++}`;

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
function decideNewSessionProject(workDir, chatId) {
  const projects = listProjects(workDir);
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

module.exports = {
  TYPES,
  parseTypedName,
  slugify,
  projectsRoot,
  projectDir,
  profilePath,
  getProject,
  listProjects,
  createProject,
  touchProject,
  getActiveProjectId,
  setActiveProjectId,
  decideNewSessionProject,
  profileText,
};
