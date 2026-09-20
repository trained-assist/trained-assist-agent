'use strict';

// Business/systems analyst skill — task formulation BEFORE any execution skill
// (dev/ci-cd/qa/deploy) starts work. This is analysis, not coding: classify how
// big a task really is, ask only the questions that matter for that size, and —
// once a task is big enough to drift — pin requirements down in a durable spec.md
// that execution skills implement against instead of re-litigating from chat memory.
//
// Workflow (spec-driven, tiered by size — see ba_clarify_requirements for the tiers):
//   1. ba_clarify_requirements — classify size, clarify the User Story before any work starts
//   2. ba_write_spec — ONLY for feature-tier work: write a durable EARS-style spec.md
//      into the target workspace (requirements + acceptance criteria + tasks), so intent
//      survives the chat and drift is checkable against something concrete
//   3. hand off to the relevant execution skill (dev_workspace_setup for coding, etc.)
//      which implements against the spec and checks tasks off as it goes

const fs   = require('fs');
const path = require('path');

module.exports = {
  isReady: () => true,
  setupTools: [],

  tools: {

    ba_clarify_requirements: {
      description: 'Classify a task by size and generate structured clarification questions BEFORE any execution skill (dev/ci-cd/qa/deploy) starts work. Call for every non-trivial task, even ones that look clear — the tier decision itself (trivial/small/feature) is the point: it tells you whether to skip ceremony or write a durable spec via ba_write_spec. Ask only the questions that are actually unclear for that tier.',
      inputSchema: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string', description: 'User\'s raw task description' },
          context: { type: 'string', description: 'Optional: what\'s already known about the project' },
        },
      },
      handler: async ({ description, context }) => {
        const known = context ? `\n\nИзвестно: ${context}` : '';
        return {
          instruction: `Задача: "${description.slice(0, 300)}"${known}\n\nШаг 1 — определи размер задачи (см. tiers). Шаг 2 — задай ТОЛЬКО неясные из описания вопросы для этого уровня. Не задавай все вопросы подряд — если задача маленькая, достаточно 1–2, а trivial вообще без вопросов.`,
          tiers: {
            trivial: 'Опечатка, переименование, однострочный багфикс, обновление версии зависимости. Не задавай вопросов, не пиши spec — просто делай.',
            small: 'Один чётко очерченный баг/правка в известном месте, объём — единицы файлов. Максимум 1–2 точечных вопроса из "required" ниже, ba_write_spec НЕ нужен.',
            feature: 'Новая функциональность, неоднозначный объём, несколько файлов/модулей, поведение, которое кто-то будет проверять на "готово/не готово". Пройди все три блока вопросов, затем ПЕРЕД передачей в исполнение вызови ba_write_spec — устный список вопрос-ответ забывается между сессиями, файл в репозитории — нет.',
          },
          questions: {
            required: [
              'Кто пользователь этой фичи? (конечный user, внутренняя команда, API-клиент)',
              'Опиши сценарий: "Как [роль], я хочу [действие], чтобы [цель]"',
              'Acceptance criteria в формате EARS: "КОГДА <триггер/событие>, <система> ДОЛЖНА <наблюдаемая реакция>" — если готового ответа нет, сформулируй сам и покажи на подтверждение, не жди пока сформулируют за тебя',
            ],
            scope: [
              'Какой стек/платформа? (Web/iOS/Android/CLI/API/Telegram bot/другое)',
              'Расширяем существующее или с нуля?',
              'Что точно НЕ входит в эту итерацию? (out of scope — фиксируй явно, это тоже часть спеки)',
            ],
            technical: [
              'Есть ли ограничения по технологиям/библиотекам?',
              'Нужна ли интеграция с чем-то внешним (API, БД, очередь)?',
              'Ожидаемый масштаб: сотни запросов в день или миллионы?',
            ],
          },
          note: 'Спека — не бюрократия ради бюрократии: она нужна только пока задача достаточно большая, чтобы "что мы вообще строим" могло разъехаться между сессиями или файлами. Для trivial/small она — чистые накладные расходы, пропускай без сожаления.',
        };
      },
    },

    ba_write_spec: {
      description: 'Write a durable spec.md into a workspace BEFORE execution starts — only for feature-tier work per ba_clarify_requirements. Captures requirements, EARS-style acceptance criteria, explicit out-of-scope, and a task breakdown as a file committed alongside the code, so intent survives across sessions and can be checked against instead of re-litigated from chat memory. Skip this for trivial/small tasks — it is deliberate overhead that only pays off once a feature is big enough to drift.',
      inputSchema: {
        type: 'object',
        required: ['workspace', 'feature', 'requirements', 'acceptance_criteria'],
        properties: {
          workspace: { type: 'string', description: 'Path to the target workspace (e.g. returned by dev_workspace_setup / dev_new_repo)' },
          feature: { type: 'string', description: 'Short feature name, e.g. "CSV export for reports"' },
          requirements: { type: 'string', description: 'What/why in a few sentences — the user story and its motivation' },
          acceptance_criteria: {
            type: 'array', items: { type: 'string' },
            description: 'EARS-style statements, e.g. "КОГДА пользователь нажимает Export, система ДОЛЖНА скачать CSV с текущим фильтром"',
          },
          out_of_scope: { type: 'array', items: { type: 'string' }, description: 'Explicitly excluded from this iteration' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'Implementation steps, checked off as work progresses' },
        },
      },
      handler: async ({ workspace, feature, requirements, acceptance_criteria, out_of_scope, tasks }) => {
        if (!fs.existsSync(workspace)) throw new Error(`Workspace not found: ${workspace}. Set it up first (e.g. dev_workspace_setup).`);

        const slug = feature.toLowerCase().trim()
          .replace(/[^a-z0-9а-яё\s-]/gi, '')
          .replace(/\s+/g, '-')
          .slice(0, 60) || 'feature';

        const specDir = path.join(workspace, 'specs', slug);
        fs.mkdirSync(specDir, { recursive: true });
        const specPath = path.join(specDir, 'spec.md');

        const criteriaBlock = (acceptance_criteria || []).map(c => `- ${c}`).join('\n') || '- (не заполнено)';
        const outOfScopeBlock = (out_of_scope || []).map(c => `- ${c}`).join('\n') || '- (не заполнено)';
        const tasksBlock = (tasks || []).map(t => `- [ ] ${t}`).join('\n') || '- [ ] (не заполнено)';

        const content = `# ${feature}\n\n` +
          `## Requirements\n${requirements}\n\n` +
          `## Acceptance criteria (EARS)\n${criteriaBlock}\n\n` +
          `## Out of scope\n${outOfScopeBlock}\n\n` +
          `## Tasks\n${tasksBlock}\n`;

        fs.writeFileSync(specPath, content);

        return {
          spec_path: specPath,
          note: 'Файл в рабочей копии, не закоммичен. Добавь его в первый коммит фичи (git add specs/), чтобы спека жила рядом с кодом и её было видно в PR — ревьюер валидирует код против неё, а не против переписки в чате.',
          next_steps: [
            `git -C ${workspace} add ${path.relative(workspace, specPath)}`,
            '# ... implement against tasks above, checking them off as you go ...',
          ],
        };
      },
    },

  },
};
