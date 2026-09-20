'use strict';

// MCP skill: connect pr-autofix to a user's GitHub repo.
// Generates step-by-step instructions + a workflow snippet, publishes as a page.
//
// The actual autofix logic lives in trained-assist/pr-autofix (public repo).
// This skill just generates the setup instructions for the user — no tokens
// are stored on our side. The user adds OPENROUTER_API_KEY to their own repo secrets.

const { execSync } = require('child_process');

const AUTOFIX_REPO = 'https://github.com/trained-assist/pr-autofix';
const CALLABLE_WORKFLOW = 'trained-assist/pr-autofix/.github/workflows/autofix-callable.yml@v1';

const tools = [
  {
    name: 'pr_autofix_connect',
    description:
      'Generate setup instructions for connecting the CI auto-fixer to a GitHub repo. ' +
      'The fixer automatically patches PR CI failures using free OpenRouter models and creates fix/ci-* branches. ' +
      'Call this when the user says: "подключи авто-фиксер", "добавь автоматическое исправление CI", "setup pr autofix", etc.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'GitHub repo in owner/name format, e.g. "myorg/my-app". Can also be a full URL.',
        },
        ci_jobs: {
          type: 'string',
          description: 'Comma-separated names of CI jobs that should trigger autofix on failure. Default: "ci".',
          default: 'ci',
        },
      },
      required: ['repo'],
    },
    handler: async ({ repo, ci_jobs = 'ci' }) => {
      // Normalize repo: strip https://github.com/ prefix if present
      const repoName = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoName)) {
        return { error: `Invalid repo format: "${repo}". Expected "owner/name".` };
      }

      const [owner, name] = repoName.split('/');
      const jobs = (ci_jobs || 'ci').split(',').map(s => s.trim()).filter(Boolean);

      const needsArray = jobs.map(j => `"${j}"`).join(', ');
      const failureCondition = jobs.map(j => `needs.${j}.result == 'failure'`).join(' ||\n        ');

      const workflowSnippet = `  autofix:
    needs: [${needsArray}]
    if: |
      always() &&
      github.event_name == 'pull_request' &&
      !github.event.pull_request.draft &&
      (
        ${failureCondition}
      ) &&
      !startsWith(github.head_ref, 'fix/ci-')
    permissions:
      contents: write
      pull-requests: write
    uses: ${CALLABLE_WORKFLOW}
    with:
      pr_number: \${{ github.event.pull_request.number }}
      original_branch: \${{ github.head_ref }}
      run_id: \${{ github.run_id }}
    secrets:
      openrouter_api_key: \${{ secrets.OPENROUTER_API_KEY }}
      gh_token: \${{ secrets.AUTOFIX_PAT || github.token }}`;

      // Check if the repo exists and get default branch (best-effort, don't fail)
      let defaultBranch = 'main';
      try {
        const result = execSync(
          `gh repo view ${repoName} --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        if (result) defaultBranch = result;
      } catch { /* ignore, not critical */ }

      const secretsUrl = `https://github.com/${repoName}/settings/secrets/actions/new`;
      const openrouterUrl = 'https://openrouter.ai/keys';
      const patUrl = `https://github.com/settings/personal-access-tokens/new?name=autofix-${name}&repositories=${repoName}&permissions=contents%3Awrite%2Cpull_requests%3Awrite`;

      const instructions = `# Подключение CI авто-фиксера к ${repoName}

Авто-фиксер мониторит CI-падения на PR, чинит их через OpenRouter (бесплатные модели) и создаёт исправляющий PR. Исходный PR не трогается — создаётся отдельная ветка \`fix/ci-*\`.

Источник: [trained-assist/pr-autofix](${AUTOFIX_REPO})

---

## Шаг 1 — Получить ключ OpenRouter (бесплатно)

1. Зарегистрируйся на [openrouter.ai](${openrouterUrl})
2. Создай API ключ (free tier достаточно — используются модели deepseek/gemma/llama)
3. Скопируй ключ — он понадобится на Шаге 2

---

## Шаг 2 — Добавить секреты в репо

Открой: [Settings → Secrets → Actions → New secret](${secretsUrl})

| Секрет | Значение |
|--------|----------|
| \`OPENROUTER_API_KEY\` | Ключ из Шага 1 |
| \`AUTOFIX_PAT\` | Fine-Grained PAT (Шаг 3) — нужен если org ограничивает workflow write |

---

## Шаг 3 — Создать Fine-Grained PAT (опционально)

Нужен если \`GITHUB_TOKEN\` не может создавать PRs в твоей org.

1. Открой [создание токена](${patUrl}) (ссылка предзаполнена для ${repoName})
2. Срок: 90 дней или без срока
3. Права: **Contents: Read and write**, **Pull requests: Read and write**
4. Добавь токен как секрет \`AUTOFIX_PAT\` (Шаг 2)

---

## Шаг 4 — Добавить autofix job в CI

Открой \`.github/workflows/ci.yml\` (или любой файл с CI) и добавь в конец \`jobs:\` раздела:

\`\`\`yaml
${workflowSnippet}
\`\`\`

**Где брать названия jobs для \`needs:\`?**
Посмотри в файле CI какие jobs существуют. Добавь те, при падении которых нужно запускать фиксер.
Текущие jobs в needs: ${jobs.join(', ')}

---

## Шаг 5 — Добавить cleanup workflow (рекомендуется)

Скачай и добавь в \`.github/workflows/\`:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/trained-assist/pr-autofix/main/templates/ci-fix-cleanup.yml \\
  -o .github/workflows/ci-fix-cleanup.yml
\`\`\`

Этот workflow автоматически закрывает исходный сломанный PR когда fix-PR мёрджится.

---

## Проверка

Создай намеренно сломанный PR (например, добавь синтаксическую ошибку) — фиксер должен через 1-2 минуты после падения CI создать \`fix/ci-*\` PR с исправлением.

---

*Репо фиксера: [${AUTOFIX_REPO}](${AUTOFIX_REPO})*`;

      // Try to publish via publish_page if available (best-effort)
      let publishedUrl = null;
      try {
        const slug = `pr-autofix-setup-${name}-${Date.now()}`;
        // publish_page is an MCP tool, not directly callable here
        // Return instructions for Claude to publish
        return {
          repo: repoName,
          defaultBranch,
          workflowSnippet,
          secretsUrl,
          instructions,
          _publish_hint: `Use publish_page tool with slug="${slug}" and the instructions markdown above to give the user a shareable link.`,
        };
      } catch {
        return { repo: repoName, instructions, workflowSnippet };
      }
    },
  },
];

module.exports = { tools };
