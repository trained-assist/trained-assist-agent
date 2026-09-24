import { it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
it('real runner creates fresh per-attempt MCP grants and revokes/removes them after engine completion', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runner-'));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [new URL('./fixtures/managed-runner-lifecycle.cjs', import.meta.url).pathname, root], {
      timeout: 25000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    });
    expect(stdout).toContain('MANAGED_RUNNER_LIFECYCLE_PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
