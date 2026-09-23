// Regression tests for outsource-project data-loss bugs found during the Renovatio
// session: (1) re-running outsource_new for an existing client created a second,
// orphaned project instead of fixing the first; (2) a missing spreadsheet could only
// be attached by going through outsource_new again (same duplicate risk).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

describe('outsource-project', () => {
  let tmpDir, prevCwd, tools;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outsource-test-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);
    delete require.cache[require.resolve('../../src/mcp-skills/tools/94-outsource-project.js')];
    tools = require('../../src/mcp-skills/tools/94-outsource-project.js').tools;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('outsource_new does not duplicate an existing project by name', async () => {
    const first = await tools.outsource_new.handler({ name: 'Renovatio', description: 'd', createSheet: false });
    expect(first.project_id).toBeTruthy();

    const second = await tools.outsource_new.handler({ name: 'Renovatio', description: 'new info', createSheet: false });
    expect(second.duplicate).toBe(true);
    expect(second.project_id).toBe(first.project_id);

    const list = await tools.outsource_list.handler({});
    expect(list.projects.length).toBe(1);
  });

  it('outsource_new creates a second project when force_new is set', async () => {
    const first = await tools.outsource_new.handler({ name: 'Renovatio', description: 'd', createSheet: false });
    const second = await tools.outsource_new.handler({ name: 'Renovatio', description: 'd2', createSheet: false, force_new: true });
    expect(second.duplicate).toBeUndefined();
    expect(second.project_id).not.toBe(first.project_id);

    const list = await tools.outsource_list.handler({});
    expect(list.projects.length).toBe(2);
  });

  it('outsource_assess is a no-op on spreadsheet attach without a service account (no crash, no duplicate project)', async () => {
    const created = await tools.outsource_new.handler({ name: 'NoSheetClient', description: 'd', createSheet: false });
    expect(created.spreadsheet_url).toBeNull();

    // No SA configured in this test env -> attach path is skipped, but assess must
    // still succeed and must not create any new project.
    const assessed = await tools.outsource_assess.handler({ project_id: created.project_id, spreadsheet_id: 'sheet-123' });
    expect(assessed.project_id).toBe(created.project_id);

    const list = await tools.outsource_list.handler({});
    expect(list.projects.length).toBe(1);
  });
});
