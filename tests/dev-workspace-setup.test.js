// Issue #1418 (D1): dev_workspace_setup must stop cloning into one shared
// per-VM tree and instead delegate to the sibling engineering workspace library
// (spawnWorkspaceForTask), returning an isolated worktree per (profile, repo, task).
//
// The redirect wiring runs everywhere via the ENGINEERING_WORKSPACE_LIB seam +
// a fake library. The real-sibling integration test is skipped unless the
// trained-assist-engineering checkout is present (it is not in CI).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const DEV_MODULE = require.resolve('../src/mcp-skills/tools/61-dev.js');
const FAKE_LIB = require.resolve('./fixtures/engineering-workspace-lib.js');
const REAL_SIBLING = path.join(process.cwd(), '..', 'trained-assist-engineering', 'src', 'workspace');
const siblingExists = fs.existsSync(path.join(REAL_SIBLING, 'index.js'));

let tmpRoot;
let callsFile;
let dev;
let savedEnv;

function readCalls() {
  return fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, 'utf8')) : [];
}

describe('dev_workspace_setup redirect to engineering workspaces', () => {
  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-ws-'));
    callsFile = path.join(tmpRoot, 'calls.json');
    savedEnv = { ...process.env };
    process.env.USER_ID = 'tester';
    process.env.GH_TOKEN = 'test-token';
    process.env.ENGINEERING_WORKSPACE_LIB = FAKE_LIB;
    process.env.ENGINEERING_WORKSPACE_ROOT = path.join(tmpRoot, 'workspaces');
    process.env.ENGINEERING_MIRRORS_ROOT = path.join(tmpRoot, 'mirrors');
    process.env.FAKE_ENGINEERING_CALLS = callsFile;
    delete require.cache[DEV_MODULE];
    dev = require(DEV_MODULE);
  });

  afterAll(() => {
    for (const key of ['USER_ID', 'GH_TOKEN', 'ENGINEERING_WORKSPACE_LIB', 'ENGINEERING_WORKSPACE_ROOT', 'ENGINEERING_MIRRORS_ROOT', 'FAKE_ENGINEERING_CALLS']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(callsFile, { force: true });
  });

  it('delegates to the engineering library and returns an isolated workspace path', async () => {
    const res = await dev.tools.dev_workspace_setup.handler({ repo: 'acme/app', branch: 'fix-one' });

    expect(res.workspace).toBe(res.codePath);
    expect(res.workspace.startsWith(tmpRoot)).toBe(true);
    expect(res.workspace.endsWith(path.join('fix-one', 'code'))).toBe(true);
    expect(res.branch).toBe('eng/tester-fix-one');
    expect(res.status).toBe('code_ready');
    expect(res.repo).toBe('acme/app');

    const calls = readCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      principal: 'tester',
      repositoryUrl: 'https://github.com/acme/app.git',
      rootTaskId: 'fix-one',
      gitToken: 'test-token',
    });
    // Token travels as an ephemeral credential helper, never a persisted remote URL
    expect(calls[0].credentialHelper).toMatch(/x-access-token/);
  });

  it('gives two task labels on the same repo two separate workspaces and branches', async () => {
    const a = await dev.tools.dev_workspace_setup.handler({ repo: 'acme/app', branch: 'fix-one' });
    const b = await dev.tools.dev_workspace_setup.handler({ repo: 'acme/app', branch: 'fix-two' });

    expect(a.workspace).not.toBe(b.workspace);
    expect(a.branch).not.toBe(b.branch);
    expect(a.branch).toBe('eng/tester-fix-one');
    expect(b.branch).toBe('eng/tester-fix-two');
  });

  it('derives a human task label from the repo when no branch is given', async () => {
    const res = await dev.tools.dev_workspace_setup.handler({ repo: 'acme/app' });
    expect(res.branch).toBe('eng/tester-app');
  });

  it('passes a full git URL or local path through unchanged', async () => {
    await dev.tools.dev_workspace_setup.handler({ repo: '/tmp/some/local-repo', branch: 'local' });
    expect(readCalls()[0].repositoryUrl).toBe('/tmp/some/local-repo');
  });

  it('removes the shared-directory dev_workspace_list tool', () => {
    expect(dev.tools.dev_workspace_list).toBeUndefined();
  });

  it('no longer constructs the shared AGENT_DATA_DIR/dev path', () => {
    const src = fs.readFileSync(DEV_MODULE, 'utf8');
    expect(src).not.toMatch(/AGENT_DATA_DIR[^\n]*dev/);
  });
});

describe.skipIf(!siblingExists)('dev_workspace_setup against the real sibling library', () => {
  it('spawns two separate git worktrees for two task labels', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-ws-real-'));
    const prev = { ...process.env };
    process.env.USER_ID = 'tester';
    process.env.GH_TOKEN = 'test-token';
    process.env.ENGINEERING_WORKSPACE_ROOT = path.join(root, 'workspaces');
    process.env.ENGINEERING_MIRRORS_ROOT = path.join(root, 'mirrors');
    delete process.env.ENGINEERING_WORKSPACE_LIB; // exercise the real sibling checkout
    try {
      const remote = path.join(root, 'real-remote');
      execFileSync('git', ['init', '-q', '-b', 'main', remote]);
      execFileSync('git', ['-C', remote, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', remote, 'config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(remote, 'README.md'), 'hello\n');
      execFileSync('git', ['-C', remote, 'add', '.']);
      execFileSync('git', ['-C', remote, 'commit', '-q', '-m', 'init']);

      const a = await dev.tools.dev_workspace_setup.handler({ repo: remote, branch: 'task-one' });
      const b = await dev.tools.dev_workspace_setup.handler({ repo: remote, branch: 'task-two' });

      expect(a.codePath).not.toBe(b.codePath);
      expect(a.branch).toBe('eng/tester-task-one');
      expect(b.branch).toBe('eng/tester-task-two');

      const branchOf = (p) => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: p, encoding: 'utf8' }).trim();
      expect(branchOf(a.codePath)).toBe('eng/tester-task-one');
      expect(branchOf(b.codePath)).toBe('eng/tester-task-two');
    } finally {
      for (const key of Object.keys({ ...process.env, ...prev })) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
