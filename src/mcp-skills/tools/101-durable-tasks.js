'use strict';

// MCP surface for DurableTaskStore (durable-task-orchestrator-v1). This is the
// read/write layer the GTD scheduler and web UI will eventually consume — see
// issue #1201. Deliberately does NOT touch runner.js/server.js/GTD scheduler
// wiring in this slice; the store already exists (src/durable-task-store.js,
// merged in #1200) and just needed a way to be called.

const crypto = require('crypto');
const { DurableTaskStore } = require('../../durable-task-store');
const { durableTaskDbPath } = require('../../data-paths');

let _store = null;
function store() {
  if (!_store) _store = new DurableTaskStore(durableTaskDbPath());
  return _store;
}

function requireProfile(ctx) {
  const profileId = ctx?.userId;
  if (!profileId) throw new Error('no profile_id on this session — cannot scope durable tasks');
  return String(profileId);
}

module.exports = {
  tools: {

    task_create: {
      description:
        'Create a new durable task (a goal tracked across sessions/restarts in SQLite, ' +
        'not a JSON checklist.md). Scoped to the caller\'s profile.',
      inputSchema: {
        type: 'object',
        required: ['goal'],
        properties: {
          goal: { type: 'string', description: 'What this task is trying to accomplish' },
          project_id: { type: 'string', description: 'Optional project id to associate' },
        },
      },
      handler: async ({ goal, project_id = null }, ctx) => {
        const profileId = requireProfile(ctx);
        const id = crypto.randomUUID();
        const task = store().createTask({ id, profile_id: profileId, project_id, goal });
        return { task };
      },
    },

    task_item_add: {
      description:
        'Add an item (step) to an existing durable task. Items run in position order ' +
        'and can escalate execution tier (free → standard → strong) on failure.',
      inputSchema: {
        type: 'object',
        required: ['task_id', 'title'],
        properties: {
          task_id: { type: 'string' },
          title: { type: 'string' },
          position: { type: 'number', description: 'Order among siblings (default: append)' },
          execution_tier: { type: 'string', enum: ['free', 'standard', 'strong'] },
          delay_after_sec: { type: 'number', description: 'Delay before this item becomes runnable, in seconds' },
        },
      },
      handler: async ({ task_id, title, position, execution_tier, delay_after_sec }, ctx) => {
        const profileId = requireProfile(ctx);
        const task = store().getTask(task_id, profileId);
        if (!task) return { error: 'task not found (or not owned by this profile)' };
        const existing = store().listTaskItems(task_id, profileId);
        const item = store().createTaskItem({
          id: crypto.randomUUID(),
          task_id,
          position: position ?? existing.length,
          title,
          execution_tier: execution_tier || 'free',
          delay_after_sec: delay_after_sec || 0,
        });
        return { item };
      },
    },

    task_list: {
      description: 'List durable tasks for the caller\'s profile, optionally filtered by status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'done', 'failed', 'cancelled'] },
        },
      },
      handler: async ({ status } = {}, ctx) => {
        const profileId = requireProfile(ctx);
        const tasks = store().listTasks(profileId, { status });
        return {
          tasks: tasks.map(t => ({ ...t, progress: store().progressSummary(t.id, profileId) })),
        };
      },
    },

    task_get: {
      description: 'Get a durable task with all its items, scoped to the caller\'s profile.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: { task_id: { type: 'string' } },
      },
      handler: async ({ task_id }, ctx) => {
        const profileId = requireProfile(ctx);
        const task = store().getTask(task_id, profileId);
        if (!task) return { error: 'task not found (or not owned by this profile)' };
        const items = store().listTaskItems(task_id, profileId);
        return { task, items };
      },
    },

    task_update: {
      description: 'Update a durable task\'s goal/status/project_id.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string' },
          goal: { type: 'string' },
          status: { type: 'string', enum: ['active', 'done', 'failed', 'cancelled'] },
          project_id: { type: 'string' },
        },
      },
      handler: async ({ task_id, ...patch }, ctx) => {
        const profileId = requireProfile(ctx);
        const task = store().updateTask(task_id, profileId, patch);
        if (!task) return { error: 'task not found (or not owned by this profile)' };
        return { task };
      },
    },

    task_item_complete: {
      description:
        'Mark a task item done (or failed, with an error). On success this arms the next ' +
        'sibling item per its delay_after_sec policy.',
      inputSchema: {
        type: 'object',
        required: ['item_id'],
        properties: {
          item_id: { type: 'string' },
          error: { type: 'string', description: 'If set, marks the item failed instead of done' },
        },
      },
      handler: async ({ item_id, error }, ctx) => {
        const profileId = requireProfile(ctx);
        const item = error
          ? store().failItem(item_id, profileId, { error })
          : store().completeItem(item_id, profileId);
        if (!item) return { error: 'item not found (or not owned by this profile)' };
        return { item };
      },
    },

  },
};
