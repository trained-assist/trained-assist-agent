'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { hhFetch } = require('./hh-utils');
const RESUME_VERSION = 1;

// The negotiations API embeds a summary, never treat it as a full resume.
async function hydrateResume(neg, token, fetchResume = hhFetch) {
  const id = neg.resume?.id;
  neg._resume_status = 'unavailable';
  if (!id || !token?.access_token) return neg;
  const key = createHash('sha256').update(`${process.env.HH_API_BASE_URL || 'https://api.hh.ru'}:${token.access_token}:${id}`).digest('hex');
  const file = path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'hh-resumes', `${key}.json`);
  let resume;
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - cached.at < 3600000 && cached.updated === neg.resume.updated_at) resume = cached.resume;
  } catch { /* cache miss */ }
  try {
    if (!resume) {
      resume = await fetchResume(`/resumes/${encodeURIComponent(id)}`, token);
      if (!resume || String(resume.id) !== String(id)) throw new Error('Invalid resume response');
      if (resume.can_view_full_info === false) {
        neg._resume_status = 'restricted';
        return neg;
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify({ at: Date.now(), updated: neg.resume.updated_at, resume }), { mode: 0o600 });
      } catch { /* resume remains usable without a cache */ }
    }
    neg.resume = resume;
    neg._resume_status = 'full';
  } catch { /* display summary explicitly; do not score partial data */ }
  return neg;
}

async function hydrateResumes(negotiations, token) {
  for (let i = 0; i < negotiations.length; i += 4) {
    await Promise.all(negotiations.slice(i, i + 4).map(neg => hydrateResume(neg, token)));
  }
  return negotiations;
}

function buildResumeText(neg, candidateMessages = []) {
  const r = neg.resume || {};
  const lines = [`# Кандидат: ${[r.last_name, r.first_name].filter(Boolean).join(' ') || 'Кандидат'}`];
  const add = (label, value) => { if (value) lines.push(`${label}: ${value}`); };
  const names = value => (value || []).map(x => x.name || x.id).filter(Boolean).join(', ');
  add('Позиция', r.title);
  if (r.total_experience?.months) add('Опыт (месяцев)', r.total_experience.months);
  add('Локация', r.area?.name);
  if (r.salary) add('Зарплата', `${r.salary.amount ?? ''} ${r.salary.currency || ''}`);
  if (r.experience?.length) lines.push('\nОпыт работы:');
  for (const job of r.experience || []) {
    lines.push(`- ${job.company || ''} (${job.start || ''}–${job.end || 'н.в.'}): ${job.position || ''}`);
    add('Локация работы', job.area?.name);
    add('Отрасли', names(job.industries));
    if (job.description) lines.push(job.description);
  }
  add('\nО себе', r.skills);
  add('\nНавыки', (r.skill_set || []).join(', '));
  add('\nУровень образования', r.education?.level?.name);
  for (const [key, label] of Object.entries({ primary: 'Образование', additional: 'Курсы', elementary: 'Образование', attestation: 'Аттестации' })) {
    for (const edu of r.education?.[key] || []) add(label, [edu.name, edu.organization, edu.result, edu.year].filter(Boolean).join(', '));
  }
  for (const lang of r.language || []) add('Язык', [lang.name, lang.level?.name].filter(Boolean).join(' — '));
  add('Специализации', names(r.professional_roles || r.specialization));
  add('Занятость', names(r.employments));
  add('График', names(r.schedules));
  add('Переезд', [r.relocation?.type?.name, names(r.relocation?.area)].filter(Boolean).join(', '));
  add('Командировки', r.business_trip_readiness?.name);
  add('Время в пути', r.travel_time?.name);
  add('Водительские права', (r.driver_license_types || []).map(x => x.id).join(', '));
  for (const cert of r.certificate || []) add('Сертификат', [cert.title, cert.organization, cert.achieved_at, cert.url].filter(Boolean).join(', '));
  if (neg.message) add('\nСопроводительное письмо', neg.message);
  if (candidateMessages.length) {
    lines.push('\nОтветы кандидата в переписке:');
    for (const m of candidateMessages) lines.push(`- ${m.text || ''}`);
  }
  return lines.join('\n');
}

function resumeHash(neg) { return createHash('sha256').update(buildResumeText(neg)).digest('hex'); }

function resumeNotice(neg, ats) {
  if (neg?._resume_status !== 'full') return 'Полное резюме не загружено. Показана краткая версия HH; оценка по ней не выполняется.';
  if (ats?.score != null && (ats.resume_version !== RESUME_VERSION || ats.resume_hash !== resumeHash(neg))) return 'Полное резюме загружено. Старая оценка требует пересчёта по полному тексту.';
  return ats?.score != null ? 'Оценка выполнена по полному резюме и ответам кандидата.' : 'Полное резюме загружено; ожидает оценки.';
}
module.exports = { hydrateResume, hydrateResumes, buildResumeText, resumeNotice, resumeHash, RESUME_VERSION };
