'use strict';

// Developer skill — git clone → local edit → test → commit → PR workflow
// Requires GitHub token (scope: repo) from 60-github.js / agent-tokens/{userId}/github.
//
// Workflow:
//   1. dev_clarify_requirements — clarify User Story before touching code
//   2. dev_workspace_setup — clone repo to agent-data/dev/<owner>_<repo>/
//   3. Claude edits files with native Read/Edit/Write tools
//   4. Claude runs tests via bash (npm test, pytest, etc.)
//   5. Claude commits + pushes via bash; creates PR via github_create_pr

const fs   = require('fs');
const path = require('path');
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
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    } catch {}
  }
  throw new Error('GitHub токен не подключён. Вызови connect({ service: "github" }) чтобы получить ссылку для ввода токена.');
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

module.exports = {
  isReady: () => {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
    if (!USER_ID) return false;
    return fs.existsSync(path.join(os.homedir(), 'agent-tokens', USER_ID, 'github'));
  },
  setupTools: [],

  tools: {

    dev_clarify_requirements: {
      description: 'Generate structured User Story clarification questions BEFORE writing any code. Call whenever the user\'s requirement is vague, ambiguous, or missing acceptance criteria. Returns a checklist — ask only the questions that are actually unclear.',
      inputSchema: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string', description: 'User\'s raw task description' },
          context: { type: 'string', description: 'Optional: what\'s already known about the project' },
        },
      },
      handler: async ({ description, context }) => {
        const known = context ? `\n\nИзвестно: ${context}` : '';
        return {
          instruction: `Задача: "${description.slice(0, 300)}"${known}\n\nЗадай ТОЛЬКО неясные из описания вопросы:`,
          questions: {
            required: [
              'Кто пользователь этой фичи? (конечный user, внутренняя команда, API-клиент)',
              'Опиши сценарий: "Как [роль], я хочу [действие], чтобы [цель]"',
              'Как проверим что готово? (acceptance criteria / тест-кейсы)',
            ],
            scope: [
              'Какой стек/платформа? (Web/iOS/Android/CLI/API/Telegram bot/другое)',
              'Расширяем существующее или с нуля?',
              'Что точно НЕ входит в эту итерацию?',
            ],
            technical: [
              'Есть ли ограничения по технологиям/библиотекам?',
              'Нужна ли интеграция с чем-то внешним (API, БД, очередь)?',
              'Ожидаемый масштаб: сотни запросов в день или миллионы?',
            ],
          },
          note: 'Не задавай все вопросы подряд — только то, что реально неясно. Если задача маленькая — достаточно 1–2.',
        };
      },
    },

    dev_workspace_setup: {
      description: 'Clone a GitHub repo to the VM and prepare it for development: git clone, configure credentials for push, detect and install dependencies (npm/pip/cargo). Returns the workspace path. After this, Claude can edit files directly and run tests via bash.',
      inputSchema: {
        type: 'object',
        required: ['repo'],
        properties: {
          repo: { type: 'string', description: 'owner/repo (e.g. acme/my-app)' },
          branch: { type: 'string', description: 'Branch to checkout after clone (default: repo default branch)' },
        },
      },
      handler: async ({ repo, branch }) => {
        const token = getToken();
        const devDir = getDevDir();
        fs.mkdirSync(devDir, { recursive: true });

        const safeName = repo.replace('/', '_').replace(/[^a-zA-Z0-9_.-]/g, '-');
        const wsPath = path.join(devDir, safeName);

        // If already cloned — update instead of re-cloning
        if (fs.existsSync(path.join(wsPath, '.git'))) {
          try {
            run('git', ['fetch', '--all'], { cwd: wsPath });
            if (branch) {
              run('git', ['checkout', branch], { cwd: wsPath });
              run('git', ['pull', '--ff-only'], { cwd: wsPath });
            } else {
              run('git', ['pull', '--ff-only'], { cwd: wsPath });
            }
            return { workspace: wsPath, status: 'updated', repo, branch: branch || 'default' };
          } catch (e) {
            // If pull fails (dirty), still return workspace so Claude can inspect
            return { workspace: wsPath, status: 'exists_dirty', note: e.message };
          }
        }

        // Clone with token in URL for auth
        const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
        run('git', ['clone', cloneUrl, wsPath], { timeout: 120_000 });

        // Replace remote URL with token-embedded version for push (stores in .git/config only)
        run('git', ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repo}.git`], { cwd: wsPath });

        // Configure git identity (needed for commits)
        run('git', ['config', 'user.email', 'agent@recruiter-assistant.ru'], { cwd: wsPath });
        run('git', ['config', 'user.name', 'AI Agent'], { cwd: wsPath });

        if (branch) {
          run('git', ['checkout', '-b', branch, `origin/${branch}`], { cwd: wsPath });
        }

        // Detect and install dependencies
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

        return {
          workspace: wsPath,
          status: 'cloned',
          repo,
          branch: branch || 'default',
          deps,
          deps_log: depsLog,
          next_steps: [
            `cd ${wsPath}  # work in this directory`,
            'git checkout -b feat/your-feature-name  # create feature branch',
            '# ... edit files, run tests ...',
            'git add -p && git commit -m "feat: ..."',
            'git push -u origin feat/your-feature-name',
            '# Then call github_create_pr to open the PR',
          ],
        };
      },
    },

    dev_workspace_list: {
      description: 'List repos that have been cloned to the VM for development. Shows workspace path, last commit, and current branch.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const devDir = getDevDir();
        if (!fs.existsSync(devDir)) return { workspaces: [], dev_dir: devDir };

        const entries = fs.readdirSync(devDir, { withFileTypes: true })
          .filter(e => e.isDirectory() && fs.existsSync(path.join(devDir, e.name, '.git')));

        const workspaces = entries.map(e => {
          const wsPath = path.join(devDir, e.name);
          let branch = '?';
          let lastCommit = '?';
          let remote = '?';
          try {
            branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wsPath });
            lastCommit = run('git', ['log', '-1', '--format=%h %s (%ar)'], { cwd: wsPath });
            const remoteUrl = run('git', ['remote', 'get-url', 'origin'], { cwd: wsPath });
            // Strip token from URL for display
            remote = remoteUrl.replace(/https:\/\/[^@]+@/, 'https://');
          } catch {}
          return { name: e.name, path: wsPath, branch, last_commit: lastCommit, remote };
        });

        return { workspaces, dev_dir: devDir, count: workspaces.length };
      },
    },

    dev_new_repo: {
      description: 'Create a new GitHub repository, then clone it locally. Use when the user wants to start a project from scratch and doesn\'t have an existing repo.',
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

        // Clone locally
        const devDir = getDevDir();
        fs.mkdirSync(devDir, { recursive: true });
        const safeName = fullName.replace('/', '_');
        const wsPath = path.join(devDir, safeName);

        const cloneUrl = `https://x-access-token:${token}@github.com/${fullName}.git`;
        run('git', ['clone', cloneUrl, wsPath], { timeout: 60_000 });
        run('git', ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${fullName}.git`], { cwd: wsPath });
        run('git', ['config', 'user.email', 'agent@recruiter-assistant.ru'], { cwd: wsPath });
        run('git', ['config', 'user.name', 'AI Agent'], { cwd: wsPath });

        return {
          repo: fullName,
          url: repoData.html_url,
          workspace: wsPath,
          status: 'created_and_cloned',
          next_steps: [
            `cd ${wsPath}`,
            'git checkout -b feat/initial-setup',
            '# ... add files, write code ...',
            'git add . && git commit -m "feat: initial implementation"',
            'git push -u origin feat/initial-setup',
            '# Then call github_create_pr',
          ],
        };
      },
    },

  },
};
