'use strict';
// Vacancy creation dialog — multi-turn message collection + Claude-based generation.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readHhToken, hhFetch, hhPost } = require('./hh-utils');

const STATE_SKILL = 'hh';
const STATE_KEY = 'vacancy_draft';

// ── State I/O ──────────────────────────────────────────────────────────────────

function statePath(workDir) {
  return path.join(workDir, 'contexts', STATE_SKILL, `${STATE_KEY}.json`);
}

function readVacancyState(workDir) {
  try {
    const raw = fs.readFileSync(statePath(workDir), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function writeVacancyState(workDir, state) {
  const file = statePath(workDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2));
}

function initVacancyState(workDir) {
  const id = `vac-${Date.now()}`;
  writeVacancyState(workDir, {
    status: 'collecting',
    vacancy_id: id,
    messages: [],
    started_at: new Date().toISOString(),
    draft: null,
    landing_url: null,
    hh_vacancy_id: null,
  });
  return id;
}

const MAX_MESSAGE_BYTES = 10_000;

function appendVacancyMessage(workDir, text) {
  const state = readVacancyState(workDir) || { messages: [] };
  const trimmed = text.trim().slice(0, MAX_MESSAGE_BYTES);
  state.messages = [...(state.messages || []), trimmed];
  writeVacancyState(workDir, state);
  return state.messages.length;
}

// ── Vacancy generation via Anthropic API ───────────────────────────────────────

const VACANCY_PROMPT = `Ты HR-эксперт. Получи материалы о вакансии (черновики, переговоры, заметки) и сгенерируй структурированную вакансию в JSON.

ТРЕБОВАНИЯ К JSON:
- name: название вакансии (строка)
- description_md: описание вакансии на русском в Markdown (обязанности, требования, условия, что предлагаем)
- area_name: город/регион (строка, например "Москва" или "Удалённо")
- salary_from: минимальная зарплата (число или null)
- salary_to: максимальная зарплата (число или null)
- salary_currency: валюта ("RUR", "USD", "EUR"; по умолчанию "RUR")
- salary_gross: до вычета налогов? (true/false/null)
- experience: опыт работы — одно из: "noExperience", "between1And3", "between3And6", "moreThan6"
- employment: занятость — "full", "part", "project", "volunteer", "probation"
- schedule: график — "fullDay", "shift", "flexible", "remote", "flyInFlyOut"
- key_skills: массив строк (ключевые навыки, до 30 штук)
- company_name: название компании (строка или null)
- company_description: описание компании (строка или null)
- hiring_stages: массив этапов отбора (строки, например ["Скрининг резюме", "Техническое интервью", "Финальное интервью", "Оффер"]) или null если не упомянуто в материалах
- response_letter_required: нужно ли сопроводительное письмо? (true/false)
- contacts: { email, phone, telegram } — если упомянуты в материалах
- professional_role_name: профессиональная роль для HeadHunter (строка — выбери наиболее подходящее: "Менеджер по продажам", "Менеджер по работе с клиентами", "Финансовый консультант", "Разработчик", "Аналитик", "HR-менеджер", "Маркетолог", "Дизайнер", "Руководитель проекта", "Бухгалтер", "Юрист", "Менеджер")

Верни ТОЛЬКО валидный JSON без markdown-оберток и без пояснений.`;

async function generateVacancyFromMessages(workDir, messages, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not available');

  const combined = messages.map((m, i) => `[Блок ${i + 1}]\n${m}`).join('\n\n---\n\n');
  const userMessage = `Вот материалы по вакансии:\n\n${combined}\n\nСгенерируй структурированную вакансию в JSON.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: VACANCY_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() || '';

  // Strip possible markdown fences
  const jsonText = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  const draft = JSON.parse(jsonText);

  // Save draft to state
  const state = readVacancyState(workDir) || {};
  writeVacancyState(workDir, { ...state, status: 'draft_ready', draft });

  return formatVacancyReply(draft, state.vacancy_id || 'unknown');
}

// ── Formatting ─────────────────────────────────────────────────────────────────

const EXPERIENCE_LABELS = {
  noExperience: 'Без опыта',
  between1And3: '1–3 года',
  between3And6: '3–6 лет',
  moreThan6: 'более 6 лет',
};

const EMPLOYMENT_LABELS = {
  full: 'Полная занятость',
  part: 'Частичная занятость',
  project: 'Проектная работа',
  volunteer: 'Волонтёрство',
  probation: 'Стажировка',
};

const SCHEDULE_LABELS = {
  fullDay: 'Полный день',
  shift: 'Сменный график',
  flexible: 'Гибкий график',
  remote: 'Удалённая работа',
  flyInFlyOut: 'Вахтовый метод',
};

function formatSalary(draft) {
  const { salary_from: from, salary_to: to, salary_currency: cur = 'RUR', salary_gross: gross } = draft;
  if (!from && !to) return null;
  const CURRENCY = { RUR: '₽', USD: '$', EUR: '€' };
  const sym = CURRENCY[cur] || cur;
  const gross_tag = gross === true ? ' до вычета налогов' : gross === false ? ' на руки' : '';
  if (from && to) return `${from.toLocaleString('ru-RU')} – ${to.toLocaleString('ru-RU')} ${sym}${gross_tag}`;
  if (from) return `от ${from.toLocaleString('ru-RU')} ${sym}${gross_tag}`;
  return `до ${to.toLocaleString('ru-RU')} ${sym}${gross_tag}`;
}

function formatVacancyReply(draft, vacancyId) {
  const lines = [
    `✅ Черновик вакансии готов (ID: \`${vacancyId}\`)`,
    '',
    `*${draft.name || 'Без названия'}*`,
  ];

  if (draft.company_name) lines.push(`🏢 ${draft.company_name}`);

  const salary = formatSalary(draft);
  if (salary) lines.push(`💰 ${salary}`);

  const area = draft.area_name;
  if (area) lines.push(`📍 ${area}`);

  const exp = EXPERIENCE_LABELS[draft.experience];
  if (exp) lines.push(`📅 Опыт: ${exp}`);

  const emp = EMPLOYMENT_LABELS[draft.employment];
  const sch = SCHEDULE_LABELS[draft.schedule];
  const empSch = [emp, sch].filter(Boolean).join(', ');
  if (empSch) lines.push(`⏱ ${empSch}`);

  if (draft.key_skills?.length) {
    lines.push(`🔑 Навыки: ${draft.key_skills.slice(0, 8).join(', ')}`);
  }

  if (!draft.hiring_stages?.length) {
    lines.push('', '❓ Не указаны этапы отбора — пришли список (например: «Скрининг → Интервью → Оффер»), добавлю на страницу.');
  } else {
    lines.push(`🗂 Этапы: ${draft.hiring_stages.join(' → ')}`);
  }

  lines.push(
    '',
    '📄 Описание сформировано. Проверь вакансию и при необходимости скажи что поправить.',
    '',
    'Готово? Скажи *«публикуй страницу»* — создам лендинг для кандидатов.',
  );

  return lines.join('\n');
}

// ── Missing fields check ──────────────────────────────────────────────────────

function getMissingFields(draft) {
  const missing = [];
  if (!draft.salary_from && !draft.salary_to)
    missing.push('• *Зарплата* — указываем вилку в вакансии? Если да — пришли (например: «150 – 200к на руки»). Если нет — оставим «по договорённости»');
  if (!draft.area_name)
    missing.push('• *Город / формат* — где работа? (например: «Москва», «Удалённо», «Москва + удалёнка»)');
  if (!draft.company_description)
    missing.push('• *О компании* — напиши пару предложений или скажи «сгенерируй о компании»');
  if (!draft.hiring_stages?.length)
    missing.push('• *Этапы отбора* — например: «Скрининг → Тех. интервью → Оффер» или скажи «сгенерируй этапы»');
  const c = draft.contacts || {};
  if (!c.telegram && !c.email && !c.phone)
    missing.push('• *Контакт для «Откликнуться»* — Telegram, email или телефон рекрутера');
  return missing;
}

// ── Vacancy draft read (for landing page and HH publish steps) ────────────────

function readVacancyDraft(workDir) {
  const state = readVacancyState(workDir);
  return state?.draft || null;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Markdown → HTML (minimal, enough for vacancy descriptions) ────────────────

function mdToHtml(md) {
  if (!md) return '';
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[^]*?<\/li>\n?)(\n*<li>[^]*?<\/li>\n?)*/g, m => `<ul>${m}</ul>`)
    .split(/\n\n+/).map(p => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      if (/^<[hul]/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
}

// ── Landing page HTML generation ──────────────────────────────────────────────

// Split description_md by ## headings into [{title, body}] sections.
// Content before the first ## becomes a section with title=null.
function parseDescriptionSections(md) {
  if (!md) return [];
  const sections = [];
  let current = null;
  for (const line of md.split('\n')) {
    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      if (current) sections.push(current);
      current = { title: h2[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      current = { title: null, lines: [line] };
    }
  }
  if (current) sections.push(current);
  return sections.map(s => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

function buildApplyHref(draft) {
  const c = draft.contacts || {};
  if (c.telegram) return `https://t.me/${c.telegram.replace(/^@/, '')}`;
  if (c.email) return `mailto:${c.email}`;
  if (c.phone) return `tel:${c.phone.replace(/\s/g, '')}`;
  return '#';
}

function generateVacancyLandingHtml(draft, vacancyId, username, publicUrl) {
  const salary = formatSalary(draft) || 'по договорённости';
  const exp = EXPERIENCE_LABELS[draft.experience] || '';
  const emp = EMPLOYMENT_LABELS[draft.employment] || '';
  const sched = SCHEDULE_LABELS[draft.schedule] || '';
  const conditionTags = [exp, emp, sched].filter(Boolean);
  const sections = parseDescriptionSections(draft.description_md || '');
  const skillsHtml = draft.key_skills?.length
    ? draft.key_skills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')
    : '';
  const companyHtml = draft.company_description ? mdToHtml(draft.company_description) : '';
  const hiringStages = draft.hiring_stages?.length ? draft.hiring_stages : null;
  const applyHref = buildApplyHref(draft);
  const pubDate = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  const sectionCards = sections.map(({ title, body }) => {
    const content = mdToHtml(body);
    if (!content) return '';
    const heading = title ? `<h2 class="card-title">${escapeHtml(title)}</h2>` : '';
    return `<div class="card">${heading}<div class="card-body">${content}</div></div>`;
  }).join('\n');

  const hiringBlockHtml = hiringStages ? `
      <div class="hiring-block">
        <h3>Процесс рассмотрения</h3>
        <ol class="hiring-stages">
          ${hiringStages.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
        </ol>
      </div>` : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(draft.name) || 'Вакансия'}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f5; color: #1a1a1a; font-size: 15px; line-height: 1.5; }

  /* ── Header ── */
  .page-header { background: #fff; border-bottom: 1px solid #e8e8e8; padding: 24px 16px 20px; }
  .page-header .inner { max-width: 900px; margin: 0 auto; }
  .vacancy-title { margin: 0 0 10px; font-size: clamp(20px, 4vw, 30px); font-weight: 700; line-height: 1.25; color: #1a1a1a; }
  .vacancy-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; color: #767676; font-size: 14px; }
  .meta-company { color: #1a1a1a; font-weight: 500; }
  .meta-sep { color: #ccc; }

  /* ── Layout ── */
  .layout { max-width: 900px; margin: 20px auto; padding: 0 16px 80px; display: grid; grid-template-columns: 1fr 280px; gap: 16px; align-items: start; }
  @media (max-width: 680px) { .layout { grid-template-columns: 1fr; padding-bottom: 100px; } .sidebar { display: none; } }

  /* ── Card ── */
  .card { background: #fff; border-radius: 8px; padding: 20px 20px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
  .card + .card { margin-top: 12px; }
  .card-title { margin: 0 0 14px; font-size: 17px; font-weight: 600; color: #1a1a1a; }
  .card-body { color: #3d3d3d; }
  .card-body p { margin: 0 0 10px; line-height: 1.7; }
  .card-body ul { margin: 0 0 10px; padding-left: 20px; }
  .card-body li { margin-bottom: 4px; line-height: 1.65; }
  .card-body h3 { margin: 14px 0 8px; font-size: 15px; font-weight: 600; color: #1a1a1a; }

  /* ── Conditions card ── */
  .salary-line { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 12px; }
  .cond-tags { display: flex; flex-wrap: wrap; gap: 8px; }
  .cond-tag { background: #f0f0f0; color: #3d3d3d; border-radius: 4px; padding: 4px 10px; font-size: 13px; }

  /* ── Skills ── */
  .skills-wrap { display: flex; flex-wrap: wrap; gap: 8px; }
  .skill-tag { background: #e8f0fe; color: #1a56db; border-radius: 4px; padding: 5px 12px; font-size: 13px; font-weight: 500; }

  /* ── Sidebar apply card ── */
  .apply-card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.07); position: sticky; top: 20px; }
  .apply-btn { display: block; width: 100%; background: #1a56db; color: #fff; border: none; border-radius: 6px; padding: 13px 20px; font-size: 15px; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; transition: background .15s; }
  .apply-btn:hover { background: #1447b8; }
  .apply-contacts { margin-top: 14px; font-size: 13px; color: #767676; display: flex; flex-direction: column; gap: 6px; }
  .apply-contacts a { color: #1a56db; text-decoration: none; }
  .apply-contacts a:hover { text-decoration: underline; }

  /* ── Hiring stages (sidebar) ── */
  .hiring-block { margin-top: 20px; border-top: 1px solid #f0f0f0; padding-top: 16px; }
  .hiring-block h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: #767676; text-transform: uppercase; letter-spacing: .05em; }
  .hiring-stages { list-style: none; margin: 0; padding: 0; counter-reset: stage; }
  .hiring-stages li { counter-increment: stage; display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; font-size: 13px; color: #3d3d3d; line-height: 1.4; }
  .hiring-stages li::before { content: counter(stage); flex-shrink: 0; width: 20px; height: 20px; background: #e8f0fe; color: #1a56db; border-radius: 50%; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }

  /* ── Mobile sticky apply bar ── */
  .mobile-apply-bar { display: none; position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #e8e8e8; padding: 12px 16px; z-index: 100; }
  .mobile-apply-bar .apply-btn { border-radius: 6px; }
  /* Hiring stages card in main col — shown only on mobile when sidebar is hidden */
  .hiring-main-card { display: none; }
  @media (max-width: 680px) { .mobile-apply-bar { display: block; } .hiring-main-card { display: block; } }
</style>
</head>
<body>

<header class="page-header">
  <div class="inner">
    <h1 class="vacancy-title">${escapeHtml(draft.name) || 'Вакансия'}</h1>
    <div class="vacancy-meta">
      ${draft.company_name ? `<span class="meta-company">${escapeHtml(draft.company_name)}</span>` : ''}
      ${draft.company_name && draft.area_name ? `<span class="meta-sep">·</span>` : ''}
      ${draft.area_name ? `<span>${escapeHtml(draft.area_name)}</span>` : ''}
      ${(draft.company_name || draft.area_name) ? `<span class="meta-sep">·</span>` : ''}
      <span>Опубликовано ${pubDate}</span>
    </div>
  </div>
</header>

<div class="layout">
  <main>
    <div class="card">
      <div class="salary-line">${escapeHtml(salary)}</div>
      ${conditionTags.length ? `<div class="cond-tags">${conditionTags.map(t => `<span class="cond-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    </div>

    ${companyHtml ? `<div class="card"><h2 class="card-title">О компании</h2><div class="card-body">${companyHtml}</div></div>` : ''}

    ${sectionCards}

    ${skillsHtml ? `<div class="card"><h2 class="card-title">Ключевые навыки</h2><div class="skills-wrap">${skillsHtml}</div></div>` : ''}
    ${hiringStages ? `<div class="card hiring-main-card"><h2 class="card-title">Процесс рассмотрения</h2><ol class="hiring-stages">${hiringStages.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol></div>` : ''}
  </main>

  <aside class="sidebar">
    <div class="apply-card">
      <a class="apply-btn" href="${escapeHtml(applyHref)}"${applyHref === '#' ? '' : ' target="_blank" rel="noopener"'}>Откликнуться</a>
      ${draft.contacts?.email || draft.contacts?.telegram || draft.contacts?.phone ? `
      <div class="apply-contacts">
        ${draft.contacts.email ? `<a href="mailto:${escapeHtml(draft.contacts.email)}">${escapeHtml(draft.contacts.email)}</a>` : ''}
        ${draft.contacts.telegram ? `<a href="https://t.me/${escapeHtml(draft.contacts.telegram.replace(/^@/, ''))}" target="_blank" rel="noopener">Telegram: ${escapeHtml(draft.contacts.telegram)}</a>` : ''}
        ${draft.contacts.phone ? `<a href="tel:${escapeHtml(draft.contacts.phone.replace(/\s/g, ''))}">${escapeHtml(draft.contacts.phone)}</a>` : ''}
      </div>` : ''}
      ${hiringBlockHtml}
    </div>
  </aside>
</div>

<div class="mobile-apply-bar">
  <a class="apply-btn" href="${escapeHtml(applyHref)}"${applyHref === '#' ? '' : ' target="_blank" rel="noopener"'}>Откликнуться</a>
</div>

</body>
</html>`;
}

// ── Publish landing page via built-in agent route ─────────────────────────────

// Vacancy pages are always served from the RU VM at platform.recruiter-assistant.ru.
// If VACANCY_REMOTE_STORE_URL is set (GCP VM), we POST the HTML there for storage.
// Otherwise we save locally (we are already on the RU VM).
const VACANCY_BASE_URL = 'https://platform.recruiter-assistant.ru';

async function publishVacancyPage(workDir, draft, vacancyId, username) {
  const html = generateVacancyLandingHtml(draft, vacancyId, username, VACANCY_BASE_URL);
  const pageUrl = `${VACANCY_BASE_URL}/vacancy/${username}/${vacancyId}`;

  const remoteStoreUrl = process.env.VACANCY_REMOTE_STORE_URL;
  if (remoteStoreUrl) {
    const endpoint = `${remoteStoreUrl.replace(/\/$/, '')}/vacancy/store`;
    const storeRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AGENT_SECRET}`,
      },
      body: JSON.stringify({ username, vacancyId, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!storeRes.ok) throw new Error(`Vacancy store failed: ${storeRes.status}`);
  } else {
    const draftsDir = path.join(os.homedir(), 'users', username, 'vacancy-drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    fs.writeFileSync(path.join(draftsDir, `${vacancyId}.html`), html, 'utf8');
  }

  const state = readVacancyState(workDir);
  if (state) writeVacancyState(workDir, { ...state, landing_url: pageUrl, status: 'draft_ready' });
  return pageUrl;
}

// ── Application storage (called by server's POST /apply/:username/:vacancyId) ──

function storeApplication(workDir, vacancyId, fields, resumeBuffer, resumeName) {
  const appDir = path.join(workDir, 'vacancy-drafts', vacancyId, 'applications');
  fs.mkdirSync(appDir, { recursive: true });
  const ts = Date.now();
  const meta = { ...fields, submitted_at: new Date(ts).toISOString() };
  fs.writeFileSync(path.join(appDir, `${ts}.json`), JSON.stringify(meta, null, 2));
  if (resumeBuffer && resumeName) {
    const ext = path.extname(resumeName) || '.pdf';
    fs.writeFileSync(path.join(appDir, `${ts}-resume${ext}`), resumeBuffer);
  }
  return meta;
}

// ── HH area name → ID mapping (most common cities) ────────────────────────────

const HH_AREA_MAP = {
  'москва': '1',
  'moscow': '1',
  'санкт-петербург': '2',
  'спб': '2',
  'saint petersburg': '2',
  'russia': '113',
  'россия': '113',
  'удалённо': '113',
  'remote': '113',
  'удаленно': '113',
  'новосибирск': '4',
  'екатеринбург': '3',
  'нижний новгород': '66',
  'казань': '88',
  'ростов-на-дону': '76',
  'красноярск': '26',
  'уфа': '99',
  'воронеж': '15',
  'самара': '78',
  'краснодар': '53',
  'омск': '68',
  'челябинск': '104',
  'пермь': '72',
};

function resolveAreaId(areaName) {
  if (!areaName) return null;
  const key = areaName.toLowerCase().trim();
  return HH_AREA_MAP[key] || null;
}

// Fetch professional role ID from HH API by name. Falls back to generic "Менеджер" (id 25).
async function resolveProfessionalRoleId(roleName, token) {
  try {
    const data = await hhFetch('/professional_roles', token);
    const categories = data?.categories || [];
    const allRoles = categories.flatMap(c => c.roles || []);
    if (!roleName) return '25';
    const norm = roleName.toLowerCase().trim();
    const exact = allRoles.find(r => r.name.toLowerCase() === norm);
    if (exact) return String(exact.id);
    const starts = allRoles.find(r => r.name.toLowerCase().startsWith(norm) || norm.startsWith(r.name.toLowerCase()));
    if (starts) return String(starts.id);
    const contains = allRoles.find(r => r.name.toLowerCase().includes(norm) || norm.includes(r.name.toLowerCase()));
    if (contains) return String(contains.id);
  } catch (e) {
    console.warn('[vacancy] professional_roles lookup failed:', e.message);
  }
  return '25'; // fallback: Менеджер
}

// ── Publish vacancy as draft to HH ────────────────────────────────────────────

async function publishToHH(workDir, userId) {
  const token = readHhToken(userId);
  if (!token?.access_token) throw new Error('HH не подключён. Скажи «подключи hh» для авторизации.');
  if (!token.employer_id) throw new Error('employer_id не найден в токене HH.');

  const state = readVacancyState(workDir);
  const draft = state?.draft;
  if (!draft) throw new Error('Нет готового черновика вакансии.');
  if (state.hh_vacancy_id) throw new Error(`Черновик уже опубликован на HH (id: ${state.hh_vacancy_id}). Открой его на hh.ru для редактирования.`);

  const areaId = resolveAreaId(draft.area_name);
  const professionalRoleId = await resolveProfessionalRoleId(draft.professional_role_name, token);

  const payload = {
    name: draft.name,
    description: mdToHtml(draft.description_md || ''),
    area: { id: areaId || '113' }, // fallback to Russia/remote if unknown city
    type: { id: 'open' },
    billing_type: { id: 'standard' },
    experience: { id: draft.experience || 'noExperience' },
    employment: { id: draft.employment || 'full' },
    schedule: { id: draft.schedule || 'fullDay' },
    response_letter_required: !!draft.response_letter_required,
    accept_temporary: false,
    professional_roles: [{ id: professionalRoleId }],
    status: 'draft', // CRITICAL: save as draft, do NOT publish
  };

  if (draft.salary_from || draft.salary_to) {
    payload.salary = {
      currency: draft.salary_currency || 'RUR',
      gross: draft.salary_gross === true,
    };
    if (draft.salary_from) payload.salary.from = draft.salary_from;
    if (draft.salary_to) payload.salary.to = draft.salary_to;
  }

  if (draft.key_skills?.length) {
    payload.key_skills = draft.key_skills.slice(0, 30).map(name => ({ name }));
  }

  const result = await hhPost(`/vacancies?employer_id=${token.employer_id}`, token, payload);
  const hhId = result.id || result.vacancy_id;

  if (hhId) {
    writeVacancyState(workDir, { ...state, hh_vacancy_id: String(hhId), status: 'hh_draft' });
  }

  return { hhId, areaId, areaName: draft.area_name };
}

module.exports = {
  readVacancyState,
  writeVacancyState,
  initVacancyState,
  appendVacancyMessage,
  generateVacancyFromMessages,
  readVacancyDraft,
  formatVacancyReply,
  getMissingFields,
  generateVacancyLandingHtml,
  publishVacancyPage,
  publishToHH,
  storeApplication,
  resolveAreaId,
  HH_AREA_MAP,
  EXPERIENCE_LABELS,
  EMPLOYMENT_LABELS,
  SCHEDULE_LABELS,
};
