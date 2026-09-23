'use strict';

const ROLES = ['researcher', 'developer', 'reviewer', 'verifier'];
const LEVELS = ['bachelor', 'master', 'doctor'];
const BUDGETS = ['small', 'medium', 'large'];
const itemSchema = {
  type: 'object', required: ['title', 'execution_kind', 'validation'],
  properties: {
    title: { type: 'string', minLength: 1 },
    stage: { type: 'string' }, instructions: { type: 'string' },
    execution_kind: { type: 'string', enum: ['agent', 'programmatic'] },
    executor_role: { type: ['string', 'null'], enum: [...ROLES, null] },
    minimum_model_level: { type: ['string', 'null'], enum: [...LEVELS, null] },
    context_budget: { type: ['string', 'null'], enum: [...BUDGETS, null] },
    validation: { type: 'object', minProperties: 1 },
    delay_after_sec: { type: 'integer', minimum: 0 },
    max_attempts: { type: 'integer', minimum: 1 },
    execution_timeout_seconds: { type: 'integer', minimum: 1 },
  },
};
function validateItem(item) {
  if (!item || typeof item.title !== 'string' || !item.title.trim()) throw new Error('item title required');
  if (!['agent', 'programmatic'].includes(item.execution_kind)) throw new Error('invalid execution_kind');
  for (const [key, values] of [['executor_role', ROLES], ['minimum_model_level', LEVELS], ['context_budget', BUDGETS]]) {
    if (item.execution_kind === 'programmatic' && item[key] == null) continue;
    if (!values.includes(item[key])) throw new Error(`invalid ${key}`);
  }
  if (!item.validation || typeof item.validation !== 'object' || Array.isArray(item.validation) || !Object.keys(item.validation).length) throw new Error('item validation required');
  for (const key of ['delay_after_sec', 'max_attempts', 'execution_timeout_seconds']) {
    if (item[key] != null && (!Number.isSafeInteger(item[key]) || item[key] < (key === 'delay_after_sec' ? 0 : 1))) throw new Error(`invalid ${key}`);
  }
}
module.exports = { itemSchema, validateItem };
