'use strict';

// Developer skill — git clone → local edit → test → commit → PR workflow
// Requires GitHub token (scope: repo) from 60-github.js / agent-tokens/{userId}/github.
//
// Workflow (spec-driven, tiered by size — see dev_clarify_requirements for the tiers):
//   1. dev_clarify_requirements — classify size, clarify User Story before touching code
//   2. dev_write_spec — ONLY for feature-tier work: write a durable EARS-style spec.md
//      into the repo (requirements + acceptance criteria + tasks), so intent survives
//      the chat and drift is checkable against something concrete
//   3. dev_workspace_setup — clone repo to agent-data/dev/<owner>_<repo>/
//   4. Claude edits files with native Read/Edit/Write tools
//   5. Claude runs tests via bash (npm test, pytest, etc.)
//   6. Claude commits + pushes via bash; creates PR via github_create_pr

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

module.exports = {
  isReady: () => {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
    if (!USER_ID) return false;
    return fs.existsSync(path.join(os.homedir(), 'agent-tokens', USER_ID, 'github'));
  },
  setupTools: [],

  tools: {

    dev_clarify_requirements: {
      description: 'Classify a dev task by size and generate structured clarification questions BEFORE writing any code. Call for every dev task, even ones that look clear — the tier decision itself (trivial/small/feature) is the point: it tells you whether to skip ceremony or write a durable spec via dev_write_spec. Ask only the questions that are actually unclear for that tier.',
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
          instruction: `Задача: "${description.slice(0, 300)}"${known}\n\nШаг 1 — определи размер задачи (см. tiers). Шаг 2 — задай ТОЛЬКО неясные из описания вопросы для этого уровня. Не задавай все вопросы подряд — если задача маленькая, достаточно 1–2, а trivial вообще без вопросов.`,
          tiers: {
            trivial: 'Опечатка, переименование, однострочный багфикс, обновление версии зависимости. Не задавай вопросов, не пиши spec — просто делай и коммить.',
            small: 'Один чётко очерченный баг/правка в известном месте кода, объём — единицы файлов. Максимум 1–2 точечных вопроса из "required" ниже, dev_write_spec НЕ нужен.',
            feature: 'Новая функциональность, неоднозначный объём, несколько файлов/модулей, поведение, которое кто-то будет проверять на "готово/не готово". Пройди все три блока вопросов, затем ПЕРЕД правками кода вызови dev_write_spec — устный список вопрос-ответ забывается между сессиями, файл в репозитории — нет.',
          },
          questions: {
            required: [
              'Кто пользователь этой фичи? (конечный user, внутренняя команда, API-клиент)',
              'Опиши сценарий: "Как [роль], я хочу [действие], чтобы [цель]"',
              'Acceptance criteria в формате EARS: "КОГДА <триггер/событие>, <система> ДОЛЖНА <наблюдаемая реакция>" — если готового ответа нет, сформулируй сам и покажи на подтверждение, не жди пока сформулируют за тебя',
            ],
            scope: [
              'Какой стек/платформа? (Web/iOS/Android/CLI/API/Telegram bot/другое)',
              'Расширяем существующее или с нуля?',
              'Что точно НЕ входит в эту итерацию? (out of scope — фиксируй явно, это тоже часть спеки)',
            ],
            technical: [
              'Есть ли ограничения по технологиям/библиотекам?',
              'Нужна ли интеграция с чем-то внешним (API, БД, очередь)?',
              'Ожидаемый масштаб: сотни запросов в день или миллионы?',
            ],
          },
          note: 'Спека — не бюрократия ради бюрократии: она нужна только пока задача достаточно большая, чтобы "что мы вообще строим" могло разъехаться между сессиями или файлами. Для trivial/small она — чистые накладные расходы, пропускай без сожаления.',
        };
      },
    },

    dev_write_spec: {
      description: 'Write a durable spec.md into the workspace BEFORE editing code — only for feature-tier work per dev_clarify_requirements. Captures requirements, EARS-style acceptance criteria, explicit out-of-scope, and a task breakdown as a file committed alongside the code, so intent survives across sessions and can be checked against instead of re-litigated from chat memory. Skip this for trivial/small tasks — it is deliberate overhead that only pays off once a feature is big enough to drift.',
      inputSchema: {
        type: 'object',
        required: ['workspace', 'feature', 'requirements', 'acceptance_criteria'],
        properties: {
          workspace: { type: 'string', description: 'Path returned by dev_workspace_setup / dev_new_repo' },
          feature: { type: 'string', description: 'Short feature name, e.g. "CSV export for reports"' },
          requirements: { type: 'string', description: 'What/why in a few sentences — the user story and its motivation' },
          acceptance_criteria: {
            type: 'array', items: { type: 'string' },
            description: 'EARS-style statements, e.g. "КОГДА пользователь нажимает Export, система ДОЛЖНА скачать CSV с текущим фильтром"',
          },
          out_of_scope: { type: 'array', items: { type: 'string' }, description: 'Explicitly excluded from this iteration' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'Implementation steps, checked off as work progresses' },
        },
      },
      handler: async ({ workspace, feature, requirements, acceptance_criteria, out_of_scope, tasks }) => {
        if (!fs.existsSync(workspace)) throw new Error(`Workspace not found: ${workspace}. Call dev_workspace_setup first.`);

        const slug = feature.toLowerCase().trim()
          .replace(/[^a-z0-9а-яё\s-]/gi, '')
          .replace(/\s+/g, '-')
          .slice(0, 60) || 'feature';

        const specDir = path.join(workspace, 'specs', slug);
        fs.mkdirSync(specDir, { recursive: true });
        const specPath = path.join(specDir, 'spec.md');

        const criteriaBlock = (acceptance_criteria || []).map(c => `- ${c}`).join('\n') || '- (не заполнено)';
        const outOfScopeBlock = (out_of_scope || []).map(c => `- ${c}`).join('\n') || '- (не заполнено)';
        const tasksBlock = (tasks || []).map(t => `- [ ] ${t}`).join('\n') || '- [ ] (не заполнено)';

        const content = `# ${feature}\n\n` +
          `## Requirements\n${requirements}\n\n` +
          `## Acceptance criteria (EARS)\n${criteriaBlock}\n\n` +
          `## Out of scope\n${outOfScopeBlock}\n\n` +
          `## Tasks\n${tasksBlock}\n`;

        fs.writeFileSync(specPath, content);

        return {
          spec_path: specPath,
          note: 'Файл в рабочей копии, не закоммичен. Добавь его в первый коммит фичи (git add specs/), чтобы спека жила рядом с кодом и её было видно в PR — ревьюер валидирует код против неё, а не против переписки в чате.',
          next_steps: [
            `git -C ${workspace} add ${path.relative(workspace, specPath)}`,
            '# ... implement against tasks above, checking them off as you go ...',
          ],
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
            installGitHooks(wsPath);
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

        // Block commits/pushes to main/master before Claude ever gets a shell here
        installGitHooks(wsPath);

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
            'git checkout -b feat/your-feature-name  # create feature branch — direct commits/pushes to main are hook-blocked',
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

    dev_pr_checklist_gtd: {
      description: 'Call this right after opening a PR (github_create_pr / gh pr create) so the durable GTD ' +
        'controller tracks it to completion (CI green → merged → deployed) on its own — no manual "remind me in ' +
        '20 minutes" needed, and it survives restarts. Writes a checklist.md in the current project directory; the ' +
        'background controller re-checks CI/merge status directly via the GitHub API for free and only wakes an ' +
        'expensive Claude/Codex session if something actually still needs attention. Works from any MCP client ' +
        '(Claude Code, Codex, etc.) — this is the shared reflex, not a client-local convention.',
      inputSchema: {
        type: 'object',
        required: ['pr_url'],
        properties: {
          pr_url: { type: 'string', description: 'Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123' },
          goal: { type: 'string', description: 'One-line description of what the PR does (optional)' },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Checklist item texts. Default: CI green, merged to main, deployed and verified live.',
          },
        },
      },
      handler: async ({ pr_url, goal, items }) => {
        const gtd = require('../../gtd-controller');
        const checklistItems = (Array.isArray(items) && items.length ? items : [
          'CI зелёный',
          'Смержено в main',
          'Задеплоено и проверено вживую',
        ]);

        const checklistPath = path.join(process.cwd(), gtd.CHECKLIST_FILE);
        const goalLine = `Goal: ${goal ? `${goal} — ` : ''}${pr_url}`;
        const itemLines = checklistItems.map(t => `- [ ] ${t}`).join('\n');

        let content = `${goalLine}\n\n${itemLines}\n`;
        let mode = 'created';
        if (fs.existsSync(checklistPath)) {
          // Append below existing content instead of clobbering an in-flight checklist —
          // a project can have more than one PR being tracked over its lifetime.
          const existing = fs.readFileSync(checklistPath, 'utf8').replace(/\s*$/, '');
          content = `${existing}\n\n---\n\n${goalLine}\n\n${itemLines}\n`;
          mode = 'appended';
        }
        fs.writeFileSync(checklistPath, content);

        return {
          ok: true,
          checklist_path: checklistPath,
          mode,
          items: checklistItems,
          note: 'checklist.md written — the GTD controller picks it up automatically after this turn ends, ' +
            'no extra registration call needed.',
        };
      },
    },

  },
};
