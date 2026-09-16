import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { getProjectDecision } = require('../src/project-decision');
const projects = require('../src/projects');
const sessions = require('../src/session-store');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-decision-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function create(id, name) {
  const dir = path.join(root, 'projects', id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id, name, type: 'generic', lastAt: 1 }));
}
it('loads real project and session modules: multiple projects ask with counts', async () => {
  create('a', 'Alpha'); create('b', 'Beta');
  projects.setActiveProjectId(root, 'b', '42');
  sessions.createSession(root, { id: 'session-a', task: 'task', chatId: '42', projectId: 'a' });
  const out = await getProjectDecision(root, '42');
  expect(out.action).toBe('ask'); expect(out.active).toBe('b');
  expect(out.choices.find(p => p.id === 'a').sessionCount).toBe(1);
  expect(out.choices.find(p => p.id === 'b').sessionCount).toBe(0);
});
it('empty and single project are real data states', async () => {
  expect((await getProjectDecision(root, '42')).action).toBe('create');
  create('a', 'Alpha');
  expect(await getProjectDecision(root, '42')).toMatchObject({ action: 'auto', choices: [{ id: 'a' }] });
});
