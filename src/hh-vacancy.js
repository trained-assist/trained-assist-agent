'use strict';
// Vacancy creation dialog — multi-turn message collection + Claude-based generation.

const fs = require('fs');
const path = require('path');

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

function appendVacancyMessage(workDir, text) {
  const state = readVacancyState(workDir) || { messages: [] };
  state.messages = [...(state.messages || []), text.trim()];
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
      model: 'claude-sonnet-5',
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

module.exports = {
  readVacancyState,
  writeVacancyState,
  initVacancyState,
  appendVacancyMessage,
  generateVacancyFromMessages,
  readVacancyDraft,
  formatVacancyReply,
  EXPERIENCE_LABELS,
  EMPLOYMENT_LABELS,
  SCHEDULE_LABELS,
};
