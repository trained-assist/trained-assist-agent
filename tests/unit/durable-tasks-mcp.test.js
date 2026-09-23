// Tests the MCP surface (task_create/task_item_add/task_list/task_get/
// task_update/task_item_complete) on top of DurableTaskStore — see #1201.
// data-paths.js reads AGENT_DATA_DIR at module load, so each test gets a
// fresh tmp dir + fresh require cache to isolate the underlying SQLite file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let dataDir;
let origEnv;

function tools() {
  delete require.cache[require.resolve('../../src/mcp-skills/tools/101-durable-tasks.js')];
  delete require.cache[require.resolve('../../src/data-paths.js')];
  delete require.cache[require.resolve('../../src/durable-task-store.js')];
  return require('../../src/mcp-skills/tools/101-durable-tasks.js').tools;
}

beforeEach(() => {
  origEnv = process.env.AGENT_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'durable-tasks-mcp-'));
  process.env.AGENT_DATA_DIR = dataDir;
});

afterEach(() => {
  if (origEnv === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = origEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

const ctx = { userId: 'alice' };
const otherCtx = { userId: 'bob' };

describe('task_create / task_get / task_list', () => {
  it('create → get round-trips the goal, scoped to the caller profile', async () => {
    const { task_create, task_get } = tools();
    const { task } = await task_create.handler({ goal: 'ship the thing' }, ctx);
    expect(task.profile_id).toBe('alice');
    const got = await task_get.handler({ task_id: task.id }, ctx);
    expect(got.task.goal).toBe('ship the thing');
    expect(got.items).toEqual([]);
  });

  it('list returns progress summary per task', async () => {
    const { task_create, task_item_add, task_list } = tools();
    const { task } = await task_create.handler({ goal: 'g' }, ctx);
    await task_item_add.handler({ task_id: task.id, title: 'step' }, ctx);
    const { tasks } = await task_list.handler({}, ctx);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].progress).toEqual({ total: 1, finished: 0 });
  });

  it('missing profile_id on ctx throws rather than silently reading everything', async () => {
    const { task_list } = tools();
    await expect(task_list.handler({}, {})).rejects.toThrow(/profile_id/);
  });
});

describe('profile isolation at the MCP layer', () => {
  it('a task created by alice is invisible to bob', async () => {
    const { task_create, task_get, task_list } = tools();
    const { task } = await task_create.handler({ goal: 'private' }, ctx);

    const got = await task_get.handler({ task_id: task.id }, otherCtx);
    expect(got.error).toMatch(/not found/);

    const { tasks } = await task_list.handler({}, otherCtx);
    expect(tasks).toEqual([]);
  });

  it('bob cannot complete alice\'s task item', async () => {
    const { task_create, task_item_add, task_item_complete } = tools();
    const { task } = await task_create.handler({ goal: 'g' }, ctx);
    const { item } = await task_item_add.handler({ task_id: task.id, title: 'x' }, ctx);

    const res = await task_item_complete.handler({ item_id: item.id }, otherCtx);
    expect(res.error).toMatch(/not found/);
  });
});

describe('task_item_complete', () => {
  it('completes an item and arms the next sibling', async () => {
    const { task_create, task_item_add, task_item_complete, task_get } = tools();
    const { task } = await task_create.handler({ goal: 'g' }, ctx);
    const { item: item1 } = await task_item_add.handler({ task_id: task.id, title: 'first' }, ctx);
    await task_item_add.handler({ task_id: task.id, title: 'second' }, ctx);

    const done = await task_item_complete.handler({ item_id: item1.id }, ctx);
    expect(done.item.status).toBe('done');

    const { items } = await task_get.handler({ task_id: task.id }, ctx);
    const second = items.find(i => i.title === 'second');
    expect(second.status).toBe('pending');
  });

  it('records failure with the given error text', async () => {
    const { task_create, task_item_add, task_item_complete } = tools();
    const { task } = await task_create.handler({ goal: 'g' }, ctx);
    const { item } = await task_item_add.handler({ task_id: task.id, title: 'x' }, ctx);

    const res = await task_item_complete.handler({ item_id: item.id, error: 'boom' }, ctx);
    expect(res.item.status).toBe('failed');
    expect(res.item.last_error).toBe('boom');
  });
});

describe('task_update', () => {
  it('updates status and bumps revision', async () => {
    const { task_create, task_update } = tools();
    const { task } = await task_create.handler({ goal: 'g' }, ctx);
    const res = await task_update.handler({ task_id: task.id, status: 'done' }, ctx);
    expect(res.task.status).toBe('done');
    expect(res.task.revision).toBeGreaterThan(task.revision);
  });

  it('unknown task_id → error, not a throw', async () => {
    const { task_update } = tools();
    const res = await task_update.handler({ task_id: 'nope', status: 'done' }, ctx);
    expect(res.error).toMatch(/not found/);
  });
});
