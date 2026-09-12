'use strict';
// Project restructuring skill — recluster a profile's sessions into projects with
// cheap models, iteratively and reversibly. Engine lives in src/reproject.js.
//
// Flow the assistant drives:
//   1. reproject_preview({criteria})  → cheap-model classification + a proposed
//      structure report. NON-destructive, re-runnable with refined criteria as many
//      times as the user wants. State persists to projects/.reproject-state.json.
//   2. reproject_apply({confirm:true}) → applies the LAST previewed plan. Re-tags
//      sessions to projects, creates new projects, writes a reversible ledger.
//   3. reproject_revert() → undo the last apply from the ledger.
//
// Product-owner invariants: nothing moves without confirm; every apply is reversible;
// classification is cheap-model only (Claude is not used for the sorting).

const path = require('path');
const reproject = require('../../reproject');

let dataPaths = null;
try { dataPaths = require('../../data-paths'); } catch { /* optional */ }

// Resolve the profile root (USERS_ROOT/<username>) — the dir that holds sessions.json,
// sessions/, projects/. Robust across "cwd is now a project subdir" (projects abstraction):
// prefer AGENT_SESSION_FILE (sessions/<id>.json → ../..), then username env, then cwd walk.
function resolveProfileRoot() {
  const sf = process.env.AGENT_SESSION_FILE;
  if (sf) return path.dirname(path.dirname(sf));
  const user = process.env.AGENT_USER_ID || process.env.USER_ID || process.env.AGENT_USERNAME;
  if (user && dataPaths) return dataPaths.userWorkDir(user);
  // Fallback: if cwd is a project dir (.../projects/<id>), climb to the profile root.
  const cwd = process.cwd();
  const m = cwd.split(path.sep);
  const pi = m.lastIndexOf('projects');
  if (pi > 0) return m.slice(0, pi).join(path.sep);
  return cwd;
}

module.exports = {
  tools: {
    reproject_preview: {
      description:
        'Пересобрать структуру проектов профиля: дешёвая модель классифицирует все сессии ' +
        'и предлагает разбивку на проекты. НИЧЕГО не перемещает — только отчёт. ' +
        'Можно вызывать сколько угодно раз с уточнённым criteria, пока структура не устроит. ' +
        'Затем reproject_apply({confirm:true}) применит последний план.',
      inputSchema: {
        type: 'object',
        properties: {
          criteria: {
            type: 'string',
            description: 'Критерий группировки от пользователя (напр. «одна вакансия = один проект»). Необязательно.',
          },
          model: {
            type: 'string',
            description: 'Override модели классификатора (по умолчанию REPROJECT_MODEL / deepseek).',
          },
        },
      },
      handler: async ({ criteria, model } = {}) => {
        const root = resolveProfileRoot();
        try {
          const out = await reproject.preview(root, { criteria, model, now: Date.now() });
          if (out.error) return out;
          return {
            profileRoot: root,
            totalSessions: out.plan.totalSessions,
            projectCount: out.plan.projects.length,
            unassigned: out.plan.unassigned.length,
            warnings: out.plan.warnings,
            report: out.report,
            next: 'Покажи отчёт пользователю. Если ок — reproject_apply({confirm:true}). Если нет — вызови снова с уточнённым criteria.',
          };
        } catch (e) {
          return { error: String(e.message || e) };
        }
      },
    },

    reproject_apply: {
      description:
        'Применить ПОСЛЕДНИЙ предпросмотренный план (из reproject_preview): пере-привязать ' +
        'сессии к проектам, создать новые проекты. Обратимо (пишет ledger). ' +
        'Требует confirm:true. Без confirm возвращает сухой прогон (что будет сделано).',
      inputSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: 'true — реально применить. false/пусто — сухой прогон.' },
        },
      },
      handler: async ({ confirm = false } = {}) => {
        const root = resolveProfileRoot();
        const state = reproject.loadState(root);
        if (!state || !state.plan) {
          return { error: 'Нет сохранённого плана. Сначала вызови reproject_preview.' };
        }
        try {
          const res = reproject.applyPlan(root, state.plan, { dryRun: !confirm, now: Date.now() });
          return {
            applied: !!confirm,
            dryRun: res.dryRun,
            sessionsMoved: res.moves,
            projectsAffected: state.plan.projects.length,
            ledgerWritten: res.ledgerWritten,
            hint: confirm
              ? 'Готово и обратимо: reproject_revert() откатит.'
              : 'Это сухой прогон. Вызови reproject_apply({confirm:true}) чтобы применить.',
          };
        } catch (e) {
          return { error: String(e.message || e) };
        }
      },
    },

    reproject_revert: {
      description: 'Откатить последний reproject_apply по ledger (вернуть прежние projectId сессий).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const root = resolveProfileRoot();
        try {
          return reproject.revertPlan(root, { now: Date.now() });
        } catch (e) {
          return { error: String(e.message || e) };
        }
      },
    },
  },
};
