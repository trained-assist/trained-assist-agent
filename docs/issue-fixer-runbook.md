# Issue-fixer runbook

Three-stage pipeline over the open-issue backlog on `trained-assist/trained-assist-agent`,
implemented in `src/issue-fixer.js`. Spec: `ISSUES-TO-PR-SPEC.md` (owner's project dir).

## Stages

1. **Queue** (`node src/issue-fixer.js`) — selects candidate issues (open, not an epic, not
   already queued) via the GitHub API, dedups against `~/agent-data/issue-fixer/state.json`,
   labels them `fixer:queued`.
2. **Gate** (`node src/issue-fixer.js --gate`) — classifies each `fixer:queued` issue against
   `docs/user-scenarios/GOALS.md` + `docs/user-scenarios/**` with a cheap OpenRouter model
   (`deepseek/deepseek-chat`), labels `scope:in`/`scope:out` + `fixability:auto`/`fixability:human`,
   posts the verdict as a comment. The owner's conservative default (fixability=auto only for
   `bug` issues with a repro and `size:XS`/`size:S`) is applied in code — the model can only
   downgrade auto→human, never upgrade.
3. **Execute** (`node src/issue-fixer.js --execute`) — for issues the gate marked
   `fixability:auto`: isolated clone under `~/agent-data/issue-fixer/work/<issue>` (never the
   live checkout), runs `opencode run --format json --auto -m deepseek` against a prompt built
   from the issue + gate verdict, verifies with `npm ci && npm run check && npm test`, up to
   3 attempts. On success: push + `gh pr create` with `Closes #N` and a hidden idempotency
   marker, label `fixer:pr-opened`. On exhaustion: label `fixer:failed` + a log comment.

All three stages accept `--dry-run` (no writes to GitHub, no `opencode`/model calls).

**No auto-merge anywhere in this pipeline** — execute only opens a PR; a human reviews and
merges it, same as any other PR. This is explicit from the owner's original voice request.

## Cron

`ops/cron/install.sh` installs `scripts/issue-fixer-cron.sh` hourly (`5 * * * *`), running
queue → gate → execute in sequence. Re-run `ops/cron/install.sh` any time to reinstall the
managed block (idempotent — rewrites only the block between its markers).

Hourly, not tight-poll: unlike the bugs-collector (debounced on file quiet-time, cheap to
poll often), every issue-fixer stage costs a GitHub/LLM call and `--execute` costs a full
clone + `npm ci` + test run per candidate — there's no quiet-file gate protecting it from
redundant work, so a tighter interval would mostly waste API/LLM/CPU budget on issues that
haven't changed since the last pass.

Logs land in `~/agent-data/issue-fixer-logs/run-<timestamp>.log`, last 200 kept. A pass that
finds nothing to do at any stage deletes its own log (same "quiet by default" convention as
`bugs-collector-cron.sh`).

## Manual operation

```bash
cd ~/trained-assist-agent
source ~/secrets.env  # GITHUB_ISSUES_TOKEN, OPENROUTER_API_KEY

node src/issue-fixer.js --dry-run           # see what would be queued
node src/issue-fixer.js --gate --dry-run    # see what would be gated — no model call, no labels
node src/issue-fixer.js --execute --dry-run # see what's executable, no clone/opencode/PR

node src/issue-fixer.js                     # real queue pass
node src/issue-fixer.js --gate              # real gate pass
node src/issue-fixer.js --execute           # real execute pass — clones, runs opencode, may open PRs
```

## Troubleshooting

- **Issue stuck at `fixer:queued`, never gated**: check `fixer:queued` is present and neither
  `scope:in`/`scope:out` label exists yet — the gate only picks up issues in exactly that state.
- **Issue stuck at `scope:in`+`fixability:auto`, never executed**: check
  `~/agent-data/issue-fixer/state.json` for a `pr`/`failedAt` entry under that issue number —
  execute skips anything already recorded there (idempotency). Also check
  `ghSearchPrByMarker` isn't finding a stale open PR with the same hidden marker.
- **Repeated `fixer:failed`**: read the log comment on the issue (has the last verify/engine
  output) or the matching `~/agent-data/issue-fixer-logs/run-*.log` on the box.
- **Cron not running**: `crontab -l` on the box should show the managed block from
  `ops/cron/install.sh`; if missing, re-run `ops/cron/install.sh`.
