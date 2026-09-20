'use strict';

// CI/CD skill — get an opened PR to CI-green → merged → deployed-and-verified,
// without a human (or Claude) needing to babysit it. Split out of 61-dev.js:
// dev is repo/workspace mechanics (clone, edit, install deps); this is the
// separate concern of tracking a change through to production once a PR exists.
//
// QA and deploy are NOT split into their own skills (yet): there is no dedicated
// test-runner tool (Claude runs `npm test`/`pytest`/etc. via bash directly) and
// no dedicated deploy tool (deploy is project-specific — wrangler, systemctl,
// gcloud, ad hoc). Splitting those out now would be empty files with no distinct
// behavior. If/when either gets real dedicated tooling, give it its own file then.

const fs   = require('fs');
const path = require('path');

module.exports = {
  isReady: () => true,
  setupTools: [],

  tools: {

    cicd_track_pr: {
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
