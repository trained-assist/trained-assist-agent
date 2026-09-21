'use strict';

// Candidate-for-client report: persistent recruiter requirements log + HTML profile template.
// Issue #982. Pure fs/string logic — no LLM, no network (recruiter tools must stay cheap).
//
// Storage (per profile, under the Claude workspace = user.workDir):
//   candidate-reports/<slug>-report-notes.md   ← requirements log, read on EVERY regeneration
//   candidate-reports/<slug>-report-data.json  ← last structured report, so a regeneration
//                                                 only changes what the recruiter asked for
//   candidate-reports/<slug>-profile.html      ← last rendered profile
//   candidate-reports/.last-candidate          ← slug of the candidate worked on last, so
//                                                 "добавь в требования: …" needs no name

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const NOTES_SUFFIX = '-report-notes.md';
const SECTIONS = {
  include: 'Что включать',
  exclude: 'Что НЕ включать / формулировки',
  history: 'История правок',
};

// ── Paths ────────────────────────────────────────────────────────────────────

function reportsDir(workDir) {
  return path.join(workDir, 'candidate-reports');
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// publish_page strips non-ASCII from slugs, so Cyrillic names would all collapse to «profile-».
// ASCII transliteration + short hash keeps the public URL stable, readable and collision-free.
const RU = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function publishSlug(profile, slug) {
  const ascii = [...slug].map(ch => RU[ch] ?? ch).join('').replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').slice(0, 30);
  const h = createHash('sha256').update(`${profile}:${slug}`).digest('hex').slice(0, 6);
  return `profile-${ascii ? ascii + '-' : ''}${h}`;
}

const notesPath = (workDir, slug) => path.join(reportsDir(workDir), `${slug}${NOTES_SUFFIX}`);
const dataPath = (workDir, slug) => path.join(reportsDir(workDir), `${slug}-report-data.json`);
const htmlPath = (workDir, slug) => path.join(reportsDir(workDir), `${slug}-profile.html`);
const lastCandidateFile = (workDir) => path.join(reportsDir(workDir), '.last-candidate');

// ── Candidate resolution ─────────────────────────────────────────────────────
// Recruiters say "Чайка", "Чайки", "Дмитрия Чайку" — match by word stem, not by exact slug.

function stem(w) {
  return w.length > 4 ? w.slice(0, -2) : w.length > 3 ? w.slice(0, -1) : w;
}
const sameWord = (a, b) => a === b || a.startsWith(stem(b)) || b.startsWith(stem(a));
const tokens = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function listCandidates(workDir) {
  try {
    return fs.readdirSync(reportsDir(workDir))
      .filter(f => f.endsWith(NOTES_SUFFIX))
      .map(f => f.slice(0, -NOTES_SUFFIX.length));
  } catch { return []; }
}

function getLastCandidate(workDir) {
  try {
    const slug = fs.readFileSync(lastCandidateFile(workDir), 'utf8').trim();
    return slug && fs.existsSync(notesPath(workDir, slug)) ? slug : null;
  } catch { return null; }
}

function setLastCandidate(workDir, slug) {
  fs.mkdirSync(reportsDir(workDir), { recursive: true });
  fs.writeFileSync(lastCandidateFile(workDir), slug, { mode: 0o600 });
}

// → { slug } | { ambiguous: [slug…] } | { none: true }   (existing candidates only)
function resolveCandidate(workDir, hint) {
  const want = tokens(hint);
  if (!want.length) {
    const last = getLastCandidate(workDir);
    return last ? { slug: last } : { none: true };
  }
  const all = listCandidates(workDir);
  const exact = all.find(s => s === slugify(hint));
  if (exact) return { slug: exact };
  const hits = all.filter(s => {
    const have = tokens(s);
    return want.every(w => have.some(h => sameWord(w, h)));
  });
  if (hits.length === 1) return { slug: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return { none: true };
}

// ── Notes file (markdown) ────────────────────────────────────────────────────

function emptyNotes(name) {
  return { name: name || '', include: [], exclude: [], history: [] };
}

function parseNotes(md) {
  const notes = emptyNotes();
  const title = String(md).match(/^#\s+(?:Требования к профилю:\s*)?(.+)$/m);
  if (title) notes.name = title[1].trim();
  let bucket = null;
  for (const line of String(md).split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      bucket = Object.keys(SECTIONS).find(k => SECTIONS[k].toLowerCase() === h[1].toLowerCase()) || null;
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (b && bucket) notes[bucket].push(b[1]);
  }
  return notes;
}

function renderNotes(notes) {
  const block = (key) => {
    const items = notes[key].length ? notes[key].map(i => `- ${i}`).join('\n') : '_пока пусто_';
    return `## ${SECTIONS[key]}\n${items}`;
  };
  return [`# Требования к профилю: ${notes.name}`, '', block('include'), '', block('exclude'), '', block('history'), ''].join('\n');
}

function readNotes(workDir, slug) {
  try { return parseNotes(fs.readFileSync(notesPath(workDir, slug), 'utf8')); }
  catch { return null; }
}

function writeNotes(workDir, slug, notes) {
  fs.mkdirSync(reportsDir(workDir), { recursive: true });
  const file = notesPath(workDir, slug);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderNotes(notes), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// «Не упоминать…», «убери…», «без…» → constraint on wording; «включи…», «добавь в профиль…» → inclusion.
// Everything else is a formulation rule («писать от первого лица», «нюансы подавать честно») and
// lives with the exclusions, exactly like in the issue's example file.
const INCLUDE_LEAD = /^(?:включ\S*|добав\S*|показ\S*|указ\S*|обязательно|нужн\S*)\s/i;
const NEGATIVE_LEAD = /^(?:не\s|нельзя|убер\S*|убра\S*|удал\S*|без\s|исключ\S*|выкин\S*|никаких)/i;

function classifyNote(text) {
  const t = String(text).trim();
  if (NEGATIVE_LEAD.test(t)) return 'exclude';
  return INCLUDE_LEAD.test(t) ? 'include' : 'exclude';
}

const ddmm = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;

// Append one requirement (+ history line). `nameForNew` is used only when the candidate has no
// notes file yet. → { slug, section, duplicate }
function addNote(workDir, slug, text, { now = new Date(), nameForNew = '' } = {}) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty requirement');
  const notes = readNotes(workDir, slug) || emptyNotes(nameForNew || slug);
  const section = classifyNote(clean);
  const duplicate = notes[section].some(i => i.toLowerCase() === clean.toLowerCase());
  if (!duplicate) {
    notes[section].push(clean);
    notes.history.push(`${ddmm(now)} — добавлено: ${clean}`);
    writeNotes(workDir, slug, notes);
  }
  setLastCandidate(workDir, slug);
  return { slug, section, duplicate };
}

// Create an empty notes file for a new candidate so the log exists from the first generation.
function ensureNotes(workDir, slug, name) {
  let notes = readNotes(workDir, slug);
  if (!notes) { notes = emptyNotes(name || slug); writeNotes(workDir, slug, notes); }
  return notes;
}

function logHistory(workDir, slug, entry, now = new Date()) {
  const notes = readNotes(workDir, slug);
  if (!notes) return;
  notes.history.push(`${ddmm(now)} — ${entry}`);
  writeNotes(workDir, slug, notes);
}

// Quoted phrases in negative rules are hard bans: «Не писать «рассматривает удалённый формат»».
function forbiddenPhrases(notes) {
  const out = [];
  for (const item of notes.exclude) {
    if (!NEGATIVE_LEAD.test(item)) continue;
    const re = /«([^»]{3,200})»|"([^"]{3,200})"|“([^”]{3,200})”/g;
    let m;
    while ((m = re.exec(item))) out.push((m[1] || m[2] || m[3]).trim());
  }
  return [...new Set(out)];
}

function collectStrings(v, acc = []) {
  if (typeof v === 'string') acc.push(v);
  else if (Array.isArray(v)) v.forEach(x => collectStrings(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => collectStrings(x, acc));
  return acc;
}

const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

// → [{ phrase }] for every banned phrase that still appears in the report text
function findViolations(data, notes) {
  const hay = norm(collectStrings(data).join('\n'));
  return forbiddenPhrases(notes).filter(p => hay.includes(norm(p))).map(phrase => ({ phrase }));
}

// ── HTML profile template ────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');
const safeImg = (u) => (/^(https?:\/\/|data:image\/(png|jpe?g|webp|gif);base64,)/i.test(String(u || '').trim()) ? String(u).trim() : '');
const paras = (s) => String(s || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

const STATUS = {
  yes:     { sym: '✓', cls: 'yes',     label: 'соответствует' },
  partial: { sym: '~', cls: 'partial', label: 'частично / с нюансом' },
  no:      { sym: '✗', cls: 'no',      label: 'не соответствует' },
};

const CSS = `
:root{--ink:#1c2430;--mute:#5d6b7c;--line:#dfe4ea;--acc:#1f4e8c;--yes:#1e7a46;--partial:#a86a00;--no:#b3261e}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:#fff}
.page{max-width:820px;margin:0 auto;padding:28px 32px}
header{display:flex;gap:20px;align-items:flex-start;border-bottom:2px solid var(--acc);padding-bottom:16px}
.photo{width:104px;height:104px;border-radius:8px;object-fit:cover;flex:none;background:#eef1f5}
h1{margin:0 0 2px;font-size:24px}
.role{color:var(--mute);margin:0 0 8px}
.contacts{font-size:13px;color:var(--mute)}
.contacts span+span::before{content:"·";margin:0 8px}
.badges{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
.badge{background:#eaf1fb;color:var(--acc);border-radius:999px;padding:3px 12px;font-size:12px;font-weight:600}
h2{font-size:16px;color:var(--acc);margin:22px 0 8px;text-transform:uppercase;letter-spacing:.04em}
p{margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--mute);font-weight:600}
td.st{width:28px;text-align:center;font-weight:700;font-size:16px}
.yes{color:var(--yes)}.partial{color:var(--partial)}.no{color:var(--no)}
.legend{font-size:12px;color:var(--mute);margin-top:6px}
.job{margin-bottom:10px;break-inside:avoid}
.job b{display:block}.job .per{color:var(--mute);font-size:12px}
.job ul{margin:4px 0 0 18px;padding:0}
.conclusion{background:#f6f8fb;border-left:4px solid var(--acc);padding:10px 14px;break-inside:avoid}
.video a{color:var(--acc);word-break:break-all}
@page{size:A4;margin:0}
@media print{
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{max-width:none;padding:14mm 16mm}
  a{color:inherit;text-decoration:none}
  h2,tr{break-inside:avoid}h2{break-after:avoid}
}`;

// data: { candidate:{name,age,position,contacts[],badges[],photo_url}, client:{company,vacancy},
//         summary, matrix:[{requirement,status:'yes'|'partial'|'no',comment}],
//         experience:[{period,company,role,details[]}], conclusion, video_url }
// → { html, warnings[] }
function renderProfileHtml(data) {
  const d = data || {};
  const c = d.candidate || {};
  const warnings = [];
  if (!c.name) throw new Error('candidate.name is required');
  if (!d.summary) warnings.push('нет summary (краткое резюме от первого лица)');
  if (!Array.isArray(d.matrix) || !d.matrix.length) warnings.push('нет matrix (матрица соответствия вакансии)');
  if (!d.conclusion) warnings.push('нет conclusion (вывод рекрутера от первого лица)');
  if (!safeUrl(d.video_url)) warnings.push('нет video_url (ссылка на видео скрининга)');

  const head = [c.age ? `${esc(c.age)}` : '', c.position ? esc(c.position) : ''].filter(Boolean).join(' · ');
  const contacts = (c.contacts || []).map(x => `<span>${esc(x)}</span>`).join('');
  const badges = (c.badges || []).map(x => `<span class="badge">${esc(x)}</span>`).join('');
  const photo = safeImg(c.photo_url);
  const cl = d.client || {};
  const forWho = [cl.vacancy, cl.company].filter(Boolean).join(' — ');

  const matrixRows = (d.matrix || []).map(r => {
    const s = STATUS[r.status] || STATUS.partial;
    return `<tr><td class="st ${s.cls}" title="${s.label}">${s.sym}</td><td>${esc(r.requirement)}</td><td>${esc(r.comment || '')}</td></tr>`;
  }).join('');

  const jobs = (d.experience || []).map(j => `
    <div class="job"><b>${esc([j.role, j.company].filter(Boolean).join(', '))}</b>
      <span class="per">${esc(j.period || '')}</span>
      ${(j.details || []).length ? `<ul>${j.details.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>`).join('');

  const video = safeUrl(d.video_url);

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.name)}${forWho ? ` — ${esc(forWho)}` : ''}</title>
<style>${CSS}</style></head>
<body><div class="page">
<header>
  ${photo ? `<img class="photo" src="${esc(photo)}" alt="">` : ''}
  <div>
    <h1>${esc(c.name)}</h1>
    ${head ? `<p class="role">${head}</p>` : ''}
    ${contacts ? `<div class="contacts">${contacts}</div>` : ''}
    ${badges ? `<div class="badges">${badges}</div>` : ''}
    ${forWho ? `<div class="contacts" style="margin-top:8px">Для: ${esc(forWho)}</div>` : ''}
  </div>
</header>
${d.summary ? `<h2>Кратко о себе</h2>${paras(d.summary)}` : ''}
${matrixRows ? `<h2>Соответствие вакансии</h2>
<table><thead><tr><th></th><th>Требование</th><th>Комментарий</th></tr></thead><tbody>${matrixRows}</tbody></table>
<div class="legend"><span class="yes">✓</span> соответствует · <span class="partial">~</span> частично / с нюансом · <span class="no">✗</span> не соответствует</div>` : ''}
${jobs ? `<h2>Опыт</h2>${jobs}` : ''}
${d.conclusion ? `<h2>Вывод рекрутера</h2><div class="conclusion">${paras(d.conclusion)}</div>` : ''}
${video ? `<h2>Видео-скрининг</h2><p class="video"><a href="${esc(video)}">${esc(video)}</a></p>` : ''}
</div></body></html>`;
  return { html, warnings };
}

function saveReport(workDir, slug, data, html) {
  fs.mkdirSync(reportsDir(workDir), { recursive: true });
  fs.writeFileSync(dataPath(workDir, slug), JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.writeFileSync(htmlPath(workDir, slug), html, { mode: 0o600 });
}

function loadReportData(workDir, slug) {
  try { return JSON.parse(fs.readFileSync(dataPath(workDir, slug), 'utf8')); } catch { return null; }
}

module.exports = {
  SECTIONS,
  reportsDir, slugify, publishSlug, notesPath, htmlPath,
  listCandidates, resolveCandidate, getLastCandidate, setLastCandidate,
  parseNotes, renderNotes, readNotes, writeNotes, ensureNotes, classifyNote, addNote, logHistory,
  forbiddenPhrases, findViolations,
  renderProfileHtml, saveReport, loadReportData,
};
