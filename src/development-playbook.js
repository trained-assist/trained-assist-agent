'use strict';

module.exports = {
  id: 'engineering-development', version: 1,
  instructions: 'Adapt these stages into roughly 15–20 concrete items for the goal. Each item needs execution_kind, executor_role, minimum_model_level, context_budget and validation. Programmatic items may use null executor requirements. Preserve user_value, acceptance criteria and required validation. Persist the whole plan with ONE task_create call. Iteration 1 stores a draft; it does not execute it.',
  stages: [
    'Define user value', 'Record acceptance criteria', 'Define validation',
    'Research or reproduce the problem', 'Identify root cause when needed',
    'Design the smallest change', 'Check risks and rollback',
    'Split implementation into small slices', 'Implement',
    'Run tests, lint and regression checks', 'Open PR',
    'Wait for CI and staging; repair failures', 'Merge and deploy',
    'Verify the actual user scenario', 'Observe when needed',
    'Finalize only with current acceptance evidence',
  ].map((title, stage) => ({ stage, title })),
  executor_requirements: {
    execution_kind: ['agent', 'programmatic'],
    executor_role: ['researcher', 'developer', 'reviewer', 'verifier'],
    minimum_model_level: ['bachelor', 'master', 'doctor'],
    context_budget: ['small', 'medium', 'large'],
  },
};
