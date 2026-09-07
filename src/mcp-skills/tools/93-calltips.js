'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const USER_ID = process.env.USER_ID || '';

// ── Helpers ────────────────────────────────────────────────────────────────

function sessionDir() {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'sessions', USER_ID);
}

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function readHhToken() {
  const { readHhToken: read } = require('../../hh-utils');
  return read(USER_ID);
}

function hhRequest(method, apiPath, accessToken, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hh.ru',
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'trained-assist-agent/1.0 (kobzevvv@gmail.com)',
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`HH parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HH request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function hhGet(apiPath, token) {
  return hhRequest('GET', apiPath, token.access_token);
}

function anthropicCall(messages, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error('ANTHROPIC_API_KEY not set'));
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages,
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          resolve(text);
        } catch { reject(new Error('Anthropic parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Get active vacancy ─────────────────────────────────────────────────────

async function getActiveVacancy(token) {
  const me = await hhGet('/me', token);
  const employerId = token.employer_id || me.employer?.id;
  if (!employerId) return null;
  const data = await hhGet(`/employers/${employerId}/vacancies/active`, token);
  return data.items?.[0] || null;
}

// ── Search candidate by name in negotiations ───────────────────────────────

async function findCandidateByName(token, vacancyId, namePart) {
  const query = namePart.toLowerCase();
  for (const state of ['response', 'invitation', 'discard']) {
    try {
      const data = await hhGet(
        `/negotiations/${state}?vacancy_id=${vacancyId}&per_page=50`,
        token
      );
      const found = (data.items || []).find(n => {
        const r = n.resume || {};
        const full = [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ').toLowerCase();
        return full.includes(query);
      });
      if (found) return found;
    } catch {}
  }
  return null;
}

// ── Format resume text ─────────────────────────────────────────────────────

function buildResumeText(negotiation) {
  const resume = negotiation.resume || {};
  const name = [resume.last_name, resume.first_name, resume.middle_name].filter(Boolean).join(' ');
  const lines = [];

  if (resume.title) lines.push(`Позиция: ${resume.title}`);
  if (resume.total_experience?.months) {
    const y = Math.floor(resume.total_experience.months / 12);
    const m = resume.total_experience.months % 12;
    lines.push(`Опыт: ${y} лет${m ? ' ' + m + ' мес' : ''}`);
  }
  if (resume.area?.name) lines.push(`Локация: ${resume.area.name}`);
  if (resume.salary) lines.push(`Зарплата: ${resume.salary.amount?.toLocaleString('ru-RU')} ${resume.salary.currency}`);

  if (resume.experience?.length) {
    lines.push('\nОпыт работы:');
    for (const job of resume.experience.slice(0, 6)) {
      const start = job.start?.slice(0, 7) || '';
      const end = job.end?.slice(0, 7) || 'н.в.';
      lines.push(`- ${job.company || ''} (${start}–${end}): ${job.position || ''}`);
      if (job.description) lines.push(`  ${job.description.slice(0, 400)}`);
    }
  }
  if (resume.skill_set?.length) lines.push(`\nНавыки: ${resume.skill_set.slice(0, 30).join(', ')}`);
  if (resume.education?.primary?.length) {
    const edu = resume.education.primary[0];
    lines.push(`\nОбразование: ${edu.name || ''}, ${edu.organization || ''} (${edu.year || ''})`);
  }
  if (negotiation.message) lines.push(`\nСопроводительное письмо:\n${negotiation.message.slice(0, 600)}`);

  return { name, text: lines.join('\n') };
}

// ── Generate interview plan ────────────────────────────────────────────────

async function generatePlan(candidateName, resumeText, jobText, duration) {
  const qCount = duration < 20 ? 4 : duration < 45 ? 8 : 14;
  const prompt = `Ты опытный рекрутер. Составь структурированный план интервью на ${duration} минут.

Кандидат: ${candidateName}
РЕЗЮМЕ:
${resumeText.slice(0, 3000)}

ВАКАНСИЯ / ТЕМА:
${(jobText || '').slice(0, 1500)}

Сгенерируй ${qCount} вопросов в 3 блоках. Для каждого вопроса — конкретный уточняющий followUp.

Верни ТОЛЬКО JSON (без обёрток, без markdown):
{"sections":[{"category":"technical","title":"Профессиональный опыт","questions":[{"text":"...","followUp":"..."}]},{"category":"soft","title":"Soft Skills","questions":[...]},{"category":"situational","title":"Ситуационные","questions":[...]}]}`;

  const raw = await anthropicCall([{ role: 'user', content: prompt }], 2000);
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(clean);
}

// ── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,

  tools: {
    calltips_prepare: {
      description: 'Prepare a Call Tips interview plan for a candidate. Fetches their HH resume, generates structured question plan, and saves it so the Call Tips app can load it with "📥 Из агента". Use when user says "подготовь план для звонка с [имя]" or "подготовь интервью с [имя]".',
      inputSchema: {
        type: 'object',
        properties: {
          candidate_name: {
            type: 'string',
            description: 'Full name or partial name of the candidate (will be searched in HH responses)',
          },
          vacancy_id: {
            type: 'string',
            description: 'Optional: specific HH vacancy ID. If omitted, uses the most recent active vacancy.',
          },
          duration: {
            type: 'number',
            description: 'Interview duration in minutes. Default: 30.',
          },
          lang: {
            type: 'string',
            description: 'Interview language: ru or en. Default: ru.',
          },
        },
        required: ['candidate_name'],
      },
      handler: async ({ candidate_name, vacancy_id, duration = 30, lang = 'ru' }) => {
        const token = readHhToken();
        if (!token) return { error: 'HH не подключён. Используй hh_connect.' };

        // 1. Get active vacancy
        let vacancy = null;
        let vacId = vacancy_id;
        if (!vacId) {
          vacancy = await getActiveVacancy(token);
          if (!vacancy) return { error: 'Нет активных вакансий на HH. Создай вакансию или укажи vacancy_id.' };
          vacId = vacancy.id;
        } else {
          try { vacancy = await hhGet(`/vacancies/${vacId}`, token); } catch {}
        }

        const jobText = vacancy ? `${vacancy.name}\n\n${(vacancy.description || '').replace(/<[^>]+>/g, ' ').slice(0, 2000)}` : '';

        // 2. Find candidate in negotiations
        const neg = await findCandidateByName(token, vacId, candidate_name);
        if (!neg) {
          return {
            error: `Кандидат "${candidate_name}" не найден в откликах на вакансию "${vacancy?.name || vacId}". Проверь написание имени или vacancy_id.`,
            hint: 'Используй calltips_list_candidates чтобы увидеть список кандидатов.',
          };
        }

        // 3. Build resume context
        const { name: fullName, text: resumeText } = buildResumeText(neg);

        // 4. Generate plan
        const plan = await generatePlan(fullName, resumeText, jobText, duration);

        // 5. Write calltips-latest.json
        const dir = sessionDir();
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'calltips-latest.json');
        const payload = {
          candidateName: fullName,
          resumeText,
          jobText,
          lang,
          duration,
          plan,
          generatedAt: new Date().toISOString(),
          hhNegotiationId: neg.id,
          hhVacancyId: vacId,
        };
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

        const totalQ = plan.sections?.reduce((n, s) => n + s.questions.length, 0) || 0;
        return {
          ok: true,
          candidateName: fullName,
          vacancyName: vacancy?.name || vacId,
          totalQuestions: totalQ,
          sections: plan.sections?.map(s => ({ title: s.title, count: s.questions.length })),
          message: `✅ План готов: ${totalQ} вопросов для ${fullName}.\nОткрой Call Tips → «📥 Из агента» и начинай.`,
        };
      },
    },

    calltips_list_candidates: {
      description: 'List candidates with HH responses ready to prepare interview plans for. Use when user asks "кто откликнулся", "покажи кандидатов", "список откликов".',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Optional: specific vacancy ID.' },
          state: { type: 'string', description: 'Filter: response | invitation | all. Default: all.' },
        },
      },
      handler: async ({ vacancy_id, state = 'all' } = {}) => {
        const token = readHhToken();
        if (!token) return { error: 'HH не подключён. Используй hh_connect.' };

        let vacId = vacancy_id;
        let vacancyName = '';
        if (!vacId) {
          const vac = await getActiveVacancy(token);
          if (!vac) return { error: 'Нет активных вакансий на HH.' };
          vacId = vac.id;
          vacancyName = vac.name;
        }

        const states = state === 'all' ? ['response', 'invitation'] : [state];
        const candidates = [];
        for (const s of states) {
          try {
            const data = await hhGet(`/negotiations/${s}?vacancy_id=${vacId}&per_page=50`, token);
            for (const neg of data.items || []) {
              const r = neg.resume || {};
              const name = [r.last_name, r.first_name].filter(Boolean).join(' ') || 'Кандидат';
              candidates.push({
                name,
                state: s,
                title: r.title || '',
                location: r.area?.name || '',
                negotiation_id: neg.id,
              });
            }
          } catch {}
        }

        return {
          vacancy: vacancyName || vacId,
          total: candidates.length,
          candidates,
          hint: candidates.length
            ? `Используй calltips_prepare(candidate_name="...") чтобы подготовить план для конкретного кандидата.`
            : 'Откликов нет.',
        };
      },
    },
  },
};
