'use strict';
// Vacancy creation dialog — multi-turn message collection + Claude-based generation.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { readHhToken, hhPost } = require('./hh-utils');

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
- response_letter_required: нужно ли сопроводительное письмо? (true/false)
- contacts: { email, phone, telegram } — если упомянуты в материалах

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

  lines.push(
    '',
    '📄 Описание сформировано. Проверь вакансию и при необходимости скажи что поправить.',
    '',
    'Готово? Скажи *«публикуй страницу»* — создам лендинг для кандидатов.',
  );

  return lines.join('\n');
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

function generateVacancyLandingHtml(draft, vacancyId, username, publicUrl) {
  const applyUrl = `${publicUrl}/apply/${encodeURIComponent(username)}/${encodeURIComponent(vacancyId)}`;
  const salary = formatSalary(draft) || 'по договорённости';
  const exp = EXPERIENCE_LABELS[draft.experience] || '';
  const emp = EMPLOYMENT_LABELS[draft.employment] || '';
  const sched = SCHEDULE_LABELS[draft.schedule] || '';
  const tags = [exp, emp, sched].filter(Boolean);
  const descHtml = mdToHtml(draft.description_md || '');
  const skillsHtml = draft.key_skills?.length
    ? draft.key_skills.map(s => `<span class="skill">${escapeHtml(s)}</span>`).join(' ')
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(draft.name) || 'Вакансия'}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #1a1a1a; }
  .hero { background: linear-gradient(135deg, #1a56db 0%, #0e3fa1 100%); color: #fff; padding: 48px 24px 36px; }
  .hero h1 { margin: 0 0 8px; font-size: clamp(22px, 4vw, 36px); font-weight: 700; line-height: 1.2; }
  .company { font-size: 18px; opacity: .85; margin-bottom: 16px; }
  .salary { font-size: 22px; font-weight: 600; }
  .location { opacity: .75; margin-top: 6px; font-size: 15px; }
  .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
  .tag { background: rgba(255,255,255,.18); border-radius: 20px; padding: 4px 14px; font-size: 13px; }
  .container { max-width: 760px; margin: 0 auto; padding: 0 16px 60px; }
  .card { background: #fff; border-radius: 12px; padding: 28px 24px; margin-top: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .card h2 { margin: 0 0 16px; font-size: 18px; color: #1a56db; }
  .skills { display: flex; flex-wrap: wrap; gap: 8px; }
  .skill { background: #eef2fb; color: #1a56db; border-radius: 20px; padding: 4px 12px; font-size: 13px; }
  .desc h2, .desc h3 { color: #333; }
  .desc ul { padding-left: 20px; }
  .desc p, .desc li { line-height: 1.7; color: #444; }
  .form-section { background: #fff; border-radius: 12px; padding: 28px 24px; margin-top: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .form-section h2 { margin: 0 0 20px; font-size: 20px; }
  label { display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500; color: #333; }
  input, textarea, select { width: 100%; padding: 10px 14px; border: 1.5px solid #ddd; border-radius: 8px; font-size: 15px; margin-bottom: 16px; font-family: inherit; transition: border-color .2s; }
  input:focus, textarea:focus { outline: none; border-color: #1a56db; }
  textarea { min-height: 100px; resize: vertical; }
  .req { color: #e53e3e; }
  .hint { font-size: 12px; color: #888; margin-top: -12px; margin-bottom: 16px; }
  .file-label { display: flex; align-items: center; gap: 10px; border: 2px dashed #ddd; border-radius: 8px; padding: 16px; cursor: pointer; margin-bottom: 16px; color: #666; font-size: 14px; }
  .file-label:hover { border-color: #1a56db; color: #1a56db; }
  #resumeFile { display: none; }
  .submit-btn { width: 100%; background: #1a56db; color: #fff; border: none; border-radius: 8px; padding: 14px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 8px; transition: background .2s; }
  .submit-btn:hover { background: #1447b8; }
  .submit-btn:disabled { background: #aaa; cursor: default; }
  .success { display: none; text-align: center; padding: 32px 16px; }
  .success h2 { color: #22863a; }
  @media (max-width: 480px) { .hero { padding: 32px 16px 28px; } .card, .form-section { padding: 20px 16px; } }
</style>
</head>
<body>
<div class="hero">
  <h1>${escapeHtml(draft.name) || 'Вакансия'}</h1>
  ${draft.company_name ? `<div class="company">🏢 ${escapeHtml(draft.company_name)}</div>` : ''}
  <div class="salary">💰 ${escapeHtml(salary)}</div>
  ${draft.area_name ? `<div class="location">📍 ${escapeHtml(draft.area_name)}</div>` : ''}
  ${tags.length ? `<div class="tags">${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
</div>
<div class="container">
  ${descHtml ? `<div class="card desc"><h2>О вакансии</h2>${descHtml}</div>` : ''}
  ${skillsHtml ? `<div class="card"><h2>Ключевые навыки</h2><div class="skills">${skillsHtml}</div></div>` : ''}
  ${draft.company_description ? `<div class="card"><h2>О компании</h2><p>${escapeHtml(draft.company_description)}</p></div>` : ''}

  <div class="form-section" id="applySection">
    <h2>Откликнуться на вакансию</h2>
    <form id="applyForm" enctype="multipart/form-data">
      <label>Имя</label>
      <input type="text" name="name" placeholder="Ваше имя">

      <label>Email <span class="req">*</span></label>
      <input type="email" name="email" required placeholder="you@example.com">

      <label>Телефон <span class="req">*</span></label>
      <input type="tel" name="phone" required placeholder="+7 (999) 000-00-00">

      <label>Telegram</label>
      <input type="text" name="telegram" placeholder="@username">

      <label>Сопроводительное письмо</label>
      <textarea name="message" placeholder="Расскажите о себе, опыте, мотивации..."></textarea>

      <label class="file-label" for="resumeFile">
        📎 <span id="fileLabel">Прикрепить резюме (PDF, DOCX — не обязательно)</span>
      </label>
      <input type="file" id="resumeFile" name="resume" accept=".pdf,.doc,.docx,.txt">

      <button type="submit" class="submit-btn" id="submitBtn">Откликнуться</button>
    </form>
    <div class="success" id="successMsg">
      <h2>✅ Отклик отправлен!</h2>
      <p>Мы свяжемся с вами в ближайшее время.</p>
    </div>
  </div>
</div>
<script>
document.getElementById('resumeFile').addEventListener('change', function() {
  document.getElementById('fileLabel').textContent = this.files[0]?.name || 'Прикрепить резюме';
});
document.getElementById('applyForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Отправляю...';
  const fd = new FormData(this);
  try {
    const r = await fetch(${JSON.stringify(applyUrl)}, { method: 'POST', body: fd });
    if (r.ok) {
      this.style.display = 'none';
      document.getElementById('successMsg').style.display = 'block';
    } else {
      const d = await r.json().catch(() => ({}));
      alert(d.error || 'Ошибка при отправке. Попробуйте ещё раз.');
      btn.disabled = false;
      btn.textContent = 'Откликнуться';
    }
  } catch {
    alert('Сетевая ошибка. Проверьте соединение и попробуйте ещё раз.');
    btn.disabled = false;
    btn.textContent = 'Откликнуться';
  }
});
</script>
</body>
</html>`;
}

// ── Publish landing page via instant-publish ──────────────────────────────────

function publishVacancyPage(workDir, draft, vacancyId, username) {
  return new Promise((resolve, reject) => {
    const publicUrl = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '');
    const html = generateVacancyLandingHtml(draft, vacancyId, username, publicUrl);

    const tmpDir = path.join(workDir, 'vacancy-drafts');
    fs.mkdirSync(tmpDir, { recursive: true });
    const htmlPath = path.join(tmpDir, `${vacancyId}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');

    const slug = `vacancy-${vacancyId.replace(/^vac-/, '').slice(-8)}`;

    execFile('npx', ['instant-publish', 'deploy', htmlPath, '--slug', slug],
      { timeout: 30000, cwd: os.homedir() },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`instant-publish failed: ${stderr || err.message}`));
        // Parse URL from stdout: looks for "https://..." line
        const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
        if (!urlMatch) return reject(new Error(`Could not parse URL from: ${stdout}`));
        const url = urlMatch[0];

        // Save URL to state
        const state = readVacancyState(workDir) || {};
        writeVacancyState(workDir, { ...state, landing_url: url, status: 'draft_ready' });

        resolve(url);
      });
  });
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
