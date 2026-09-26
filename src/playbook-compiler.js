'use strict';

// Playbook compiler (issue #1372, slice P2): compile a resolved Playbook v1 into
// the concrete durable-plan payload that DurableTaskStore.createPlan consumes.
//
// A playbook is the reusable, versioned process; a run binds it to one concrete
// goal and pins {playbook_id, playbook_version}. The compiler is pure — it never
// touches the store or a session — so the same playbook compiles for many goals
// without mutating the artifact, and a plan already pinned to a version is
// immune to later edits of that playbook.
//
// Rendering substitutes {goal}/{input}/{...vars} in goal/title/instructions.
// Agent steps must declare executor_role + minimum_model_level + context_budget:
// the JSON schema allows null, but the plan contract does not, so a missing one
// is a clear COMPILE_INVALID error — never a silently invented default. The only
// defaults applied are the playbook's own `defaults` (max_attempts / timeout),
// falling back to the house values.

const { validateItem } = require('./durable-task-plan');
const { playbookError, _internal } = require('./playbook-store');

const { substitute } = _internal;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_SECONDS = 600;

// A goal_template that contains {input}/{goal} renders the concrete goal into the
// task goal. A template without a slot is kept and the goal is appended, so the
// run's goal is never silently dropped by a playbook that hardcoded its wording.
function renderGoal(playbook, vars, goal) {
  const template = playbook.goal_template;
  if (typeof template !== 'string' || !template.trim()) return goal;
  const rendered = substitute(template, vars);
  return /\{(input|goal)\}/.test(template) ? rendered : `${rendered} — ${goal}`;
}

// Task-level acceptance criteria. Goal-specific criteria may be supplied per run;
// when omitted, one deterministic criterion is derived from the playbook itself:
// "every step validation passes", carrying each step's validation so P3's
// finalizer has a machine-checkable contract. This is derived, not invented.
function deriveAcceptanceCriteria(playbook, userValue) {
  const validations = [];
  for (const stage of playbook.stages || []) {
    for (const step of stage.steps || []) {
      validations.push({ stage: stage.id, step: step.title, validation: step.validation });
    }
  }
  return [{
    id: `${playbook.id}-complete`,
    description: userValue,
    source: `playbook:${playbook.id}@${playbook.version}`,
    validations,
  }];
}

function compilePlaybook(playbook, { goal, vars = {}, acceptance_criteria = null, user_value = null } = {}) {
  if (!playbook || typeof playbook !== 'object') {
    throw playbookError('COMPILE_INVALID', 'плейбук не передан');
  }
  if (typeof goal !== 'string' || !goal.trim()) {
    throw playbookError('GOAL_REQUIRED', 'нужна цель запуска (goal)');
  }
  const goalText = goal.trim();
  // The run goal always wins over stray vars: a caller cannot shadow {goal}/{input}.
  const renderVars = { ...vars, input: goalText, goal: goalText };
  const defaults = playbook.defaults || {};

  const items = [];
  for (const stage of playbook.stages || []) {
    for (const step of stage.steps || []) {
      const item = {
        title: substitute(step.title, renderVars),
        stage: stage.id,
        execution_kind: step.execution_kind,
        executor_role: step.executor_role ?? null,
        minimum_model_level: step.minimum_model_level ?? null,
        context_budget: step.context_budget ?? null,
        validation: step.validation,
        delay_after_sec: step.delay_after_sec ?? 0,
        max_attempts: step.max_attempts ?? defaults.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
        execution_timeout_seconds:
          step.execution_timeout_seconds ?? defaults.execution_timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
      };
      if (step.instructions) item.instructions = substitute(step.instructions, renderVars);
      try {
        validateItem(item);
      } catch (error) {
        throw playbookError('COMPILE_INVALID', `шаг «${item.title}»: ${error.message}`);
      }
      items.push(item);
    }
  }
  if (!items.length) {
    throw playbookError('COMPILE_INVALID', `плейбук «${playbook.id}» не содержит шагов`);
  }

  const planGoal = renderGoal(playbook, renderVars, goalText);
  const planUserValue = (typeof user_value === 'string' && user_value.trim())
    ? user_value.trim()
    : (playbook.user_value_template
      ? substitute(playbook.user_value_template, renderVars)
      : `Плейбук «${playbook.title}»: ${planGoal}`);
  const criteria = Array.isArray(acceptance_criteria) && acceptance_criteria.length
    ? acceptance_criteria
    : deriveAcceptanceCriteria(playbook, planUserValue);

  return {
    goal: planGoal,
    user_value: planUserValue,
    acceptance_criteria: criteria,
    items,
  };
}

module.exports = {
  compilePlaybook,
  deriveAcceptanceCriteria,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_SECONDS,
};
