'use strict';

// Developer skill — git clone → local edit → test → commit → PR workflow
// Requires GitHub token (scope: repo) from 60-github.js / agent-tokens/{userId}/github.
// Task formulation (clarifying requirements, writing a durable spec) is a separate
// business/systems-analyst concern — see 62-business-analyst.js (ba_clarify_requirements,
// ba_write_spec). This skill only covers repo/workspace mechanics (clone, deps, PR creation
// happens via github_create_pr). Tracking a PR through to deploy is a separate ci-cd concern
// — see 63-ci-cd.js (cicd_track_pr).
//
// Workflow:
//   1. ba_clarify_requirements / ba_write_spec (62-business-analyst.js) — before any of this
//   2. dev_workspace_setup — spawn an isolated per-task git worktree via the sibling
//      trained-assist-engineering workspace library (engineering_spawn_workspace)
//   3. Claude edits files with native Read/Edit/Write tools
//   4. Claude runs tests via bash (npm test, pytest, etc.)
//   5. Claude commits + pushes via bash; creates PR via github_create_pr
//   6. cicd_track_pr (63-ci-cd.js) — hand PR off to the durable GTD controller (CI → merge → deploy)

const fs   = require('fs');
const path = require('path');
const { readTokenValue } = require('../../token-value');
const os   = require('os');
const { spawnSync } = require('child_process');

const USER_ID = process.env.USER_ID || '';

function getDevDir() {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'dev');
}

function getToken() {
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (tok) return tok;
  if (USER_ID) {
    try {
      const p = path.join(os.homedir(), 'agent-tokens', USER_ID, 'github');
      if (fs.existsSync(p)) return readTokenValue(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  throw new Error('GitHub токен не подключён. Вызови connect({ service: "github" }) чтобы получить ссылку для ввода токена.');
}

// Same hooks this agent's own repos use (.githooks/ at repo root) — copied into
// every workspace dev_workspace_setup touches so branch-per-session is enforced
// there too, not just in the agent's own checkouts.
const HOOKS_TEMPLATE_DIR = path.join(__dirname, '..', '..', '..', '.githooks');

function installGitHooks(wsPath) {
  const hooksDir = path.join(wsPath, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) return false;
  let installed = false;
  for (const name of ['pre-commit', 'pre-push']) {
    const src = path.join(HOOKS_TEMPLATE_DIR, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(hooksDir, name));
    fs.chmodSync(path.join(hooksDir, name), 0o755);
    installed = true;
  }
  return installed;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 60_000,
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
  });
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '';
    const stdout = result.stdout?.trim() || '';
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}: ${stderr || stdout}`);
  }
  return (result.stdout || '').trim();
}

// ---------------------------------------------------------------------------
// Isolated per-task workspaces (issue #1418, D1)
//
// `dev_workspace_setup` no longer clones into one shared per-VM tree.
// It delegates to the sibling trained-assist-engineering workspace library
// (`spawnWorkspaceForTask`), which forks an isolated git worktree + branch
// (`eng/<principal>-<rootTaskId>`) off a per-repository mirror. One workspace per
// (principal, repository, rootTaskId) — two tasks never share a tree or branch.
// ---------------------------------------------------------------------------

// Default location of the sibling checkout. `ENGINEERING_WORKSPACE_LIB` is a
// test seam (mirrors registry.js's TOOLS_DIR override) so the redirect wiring can
// be exercised without the sibling cloned; production always uses the default.
function engineeringLibPath() {
  return process.env.ENGINEERING_WORKSPACE_LIB
    || path.join(__dirname, '..', '..', '..', '..', 'trained-assist-engineering', 'src', 'workspace');
}

// Required lazily: a missing sibling must not crash the whole MCP server at
// require time — only the call that actually needs it fails, with a clear error.
function spawnWorkspaceForTask(deps) {
  let lib;
  try {
    lib = require(engineeringLibPath());
  } catch (e) {
    throw new Error(`engineering workspace library unavailable (${engineeringLibPath()}): ${e.message}`);
  }
  return lib.spawnWorkspaceForTask(deps);
}

// `owner/repo` → clone URL; a full git URL or local path is passed through as-is
// (lets tests and on-VM local mirrors work without a GitHub round-trip).
function repositoryUrlOf(repo) {
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|git@|\/)/i.test(repo)) return repo;
  return `https://github.com/${repo}.git`;
}

// The engineering library clones with whatever git credentials the process has.
// Rather than embedding the token in a persisted remote URL (the leak #1418
// removes), inject it for the duration of the synchronous spawn as an ephemeral
// git credential helper: token stays in env, never on disk. Reset the helper
// list first so an inherited global helper cannot shadow this profile's token.
const GIT_TOKEN_HELPER = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$AGENT_GIT_TOKEN"; }; f';

function withGitCredentials(token, fn) {
  if (!token) return fn();
  const overrides = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: GIT_TOKEN_HELPER,
    AGENT_GIT_TOKEN: token,
  };
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function spawnTaskWorkspace({ repositoryUrl, rootTaskId, token }) {
  if (!USER_ID) throw new Error('Не удалось определить профиль (USER_ID) для изолированного workspace.');
  return withGitCredentials(token, () => spawnWorkspaceForTask({
    principal: USER_ID,
    repositoryUrl,
    rootTaskId,
    workspaceRoot: process.env.ENGINEERING_WORKSPACE_ROOT || undefined,
    mirrorsRoot: process.env.ENGINEERING_MIRRORS_ROOT || undefined,
  }));
}

function prepareWorkspace(codePath) {
  run('git', ['config', 'user.email', 'agent@recruiter-assistant.ru'], { cwd: codePath });
  run('git', ['config', 'user.name', 'AI Agent'], { cwd: codePath });
  // Useful on its own (not part of the isolation fix) — kept from the old flow.
  installGitHooks(codePath);
}

function detectDependencies(wsPath) {
  let deps = 'none';
  const depsLog = [];
  if (fs.existsSync(path.join(wsPath, 'package.json'))) {
    const pkgManager = fs.existsSync(path.join(wsPath, 'yarn.lock')) ? 'yarn' :
                       fs.existsSync(path.join(wsPath, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    try {
      run(pkgManager, pkgManager === 'npm' ? ['ci', '--prefer-offline'] : ['install'], { cwd: wsPath, timeout: 180_000 });
      deps = pkgManager;
      depsLog.push(`${pkgManager} install OK`);
    } catch (e) {
      depsLog.push(`${pkgManager} install failed: ${e.message}`);
    }
  } else if (fs.existsSync(path.join(wsPath, 'requirements.txt'))) {
    try {
      run('pip', ['install', '-r', 'requirements.txt', '-q'], { cwd: wsPath, timeout: 180_000 });
      deps = 'pip';
      depsLog.push('pip install OK');
    } catch (e) {
      depsLog.push(`pip install failed: ${e.message}`);
    }
  } else if (fs.existsSync(path.join(wsPath, 'Cargo.toml'))) {
    deps = 'cargo';
    depsLog.push('Cargo project detected — run `cargo build` when ready');
  }
  return { deps, depsLog };
}

module.exports = {
  isReady: () => {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
    if (!USER_ID) return false;
    return fs.existsSync(path.join(os.homedir(), 'agent-tokens', USER_ID, 'github'));
  },
  setupTools: [],

  tools: {

    dev_workspace_setup: {
      description: 'Prepare an isolated development workspace for a GitHub repo: forks a per-task git worktree + branch (eng/<profile>-<task>) via the engineering workspace library, configures git identity, and detects/installs dependencies (npm/pip/cargo). Returns the workspace path. Two calls with different task labels get separate trees and branches. After this, Claude can edit files directly and run tests via bash.',
      inputSchema: {
        type: 'object',
        required: ['repo'],
        properties: {
          repo: { type: 'string', description: 'owner/repo (e.g. acme/my-app), or a full git URL / local path' },
          branch: { type: 'string', description: 'Human-readable task/branch label for this workspace. Becomes the branch eng/<profile>-<branch>. Defaults to the repo name.' },
        },
      },
      handler: async ({ repo, branch }) => {
        const token = getToken();
        const rootTaskId = branch || repo.split('/').filter(Boolean).pop() || 'dev-workspace';
        const result = spawnTaskWorkspace({
          repositoryUrl: repositoryUrlOf(repo),
          rootTaskId,
          token,
        });
        const workspace = result.codePath;
        prepareWorkspace(workspace);
        const { deps, depsLog } = detectDependencies(workspace);
        return {
          workspace,
          codePath: workspace,
          workspaceId: result.workspaceId,
          status: result.status,
          repo,
          branch: result.branch,
          deps,
          deps_log: depsLog,
          next_steps: [
            `cd ${workspace}  # isolated worktree for this task — work here`,
            '# ... edit files, run tests ...',
            'git add -p && git commit -m "feat: ..."',
            `git push -u origin ${result.branch}`,
            '# Then call github_create_pr to open the PR',
          ],
        };
      },
    },

    dev_new_repo: {
      description: 'Create a new GitHub repository, then prepare an isolated per-task workspace for it. Use when the user wants to start a project from scratch and doesn\'t have an existing repo.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Repository name (lowercase, hyphens ok)' },
          description: { type: 'string', description: 'Short repo description' },
          private: { type: 'boolean', description: 'Private repo (default true)' },
          org: { type: 'string', description: 'Create under this org instead of personal account' },
        },
      },
      handler: async ({ name, description, private: isPrivate = true, org }) => {
        const token = getToken();

        // Create via GitHub API
        const apiBase = 'https://api.github.com';
        const endpoint = org ? `/orgs/${org}/repos` : '/user/repos';
        const body = JSON.stringify({
          name,
          description,
          private: isPrivate,
          auto_init: true,
          gitignore_template: 'Node',
        });

        const res = await fetch(`${apiBase}${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'trained-assist-agent',
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(`GitHub API ${res.status}: ${err.message || res.statusText}`);
        }
        const repoData = await res.json();
        const fullName = repoData.full_name;

        // Fork an isolated per-task workspace off the freshly created repo
        const result = spawnTaskWorkspace({
          repositoryUrl: `https://github.com/${fullName}.git`,
          rootTaskId: name,
          token,
        });
        const workspace = result.codePath;
        prepareWorkspace(workspace);

        return {
          repo: fullName,
          url: repoData.html_url,
          workspace,
          codePath: workspace,
          workspaceId: result.workspaceId,
          branch: result.branch,
          status: 'created',
          next_steps: [
            `cd ${workspace}`,
            '# ... add files, write code ...',
            'git add . && git commit -m "feat: initial implementation"',
            `git push -u origin ${result.branch}`,
            '# Then call github_create_pr',
          ],
        };
      },
    },

  },
};
