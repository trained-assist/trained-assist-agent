# Playbooks

Versioned, machine-checkable process artifacts (issue #1372). A playbook compiles into a durable
plan; the plan executes step by step with a per-step executor contract. This file is the registry
overview; the schema is `contracts/playbook.schema.json`.

## Registry & resolution

`PlaybookStore` resolves a playbook id at the highest-precedence level that has it:

```
1. profile custom : ~/users/<profile>/playbooks/<id>.json   (scope "profile")
2. sibling repo   : <repo-parent>/<domain-skill-repo>/playbooks/<id>.json   (scope "system")
3. system repo    : <this repo>/playbooks/<id>.json          (scope "system")
```

- The file location — not the declared `scope` field — is authoritative; a mismatch is an error.
- Repo-owned levels (sibling/system) are immutable from chat: change them via PR. A profile
  override can shadow a repo playbook; `playbook_save` numbers it above what it overrides.
- A running plan pins `{playbook_id, playbook_version}`, so editing a playbook never mutates an
  already-started task.

Tools (`src/mcp-skills/tools/102-playbooks.js`):

| Tool | What |
|---|---|
| `playbook_list` | visible playbooks at their winning level |
| `playbook_get` | full playbook + prompt render (or a draft) |
| `playbook_suggest` | suggested default playbook for an audience (read-only) |
| `playbook_draft` / `playbook_edit` / `playbook_save` | authoring via Hermes (P1) |
| `playbook_run` | compile playbook + goal → **draft** durable plan (P2) |

## Step contract

Each agent step declares:

- `executor_role`: `researcher | developer | reviewer | verifier`
- `minimum_model_level`: `bachelor | master | doctor`
- `context_budget`: `small | medium | large`
- `validation`: a non-empty, machine-checkable object
- `max_attempts`, `execution_timeout_seconds`, `delay_after_sec` (optional; defaults apply)

Objective checks are `execution_kind: programmatic` (no engine). The runtime resolves role/level/
budget to a concrete `{engine, ocProfile, ocRole}` (`src/playbook-executor.js`): bachelor→opencode
`value`, master→opencode `max`, doctor→claude. `checklist.md` renders each item as
`[role/level/budget]` (or `[programmatic]`).

## Lifecycle

```
playbook_run → draft plan → task_update status=active → tick claims items →
(programmatic: registry validation; agent: engine run) → validation/evidence rows →
finalizePlan (only when every acceptance validation passes)
```

- **Activation is explicit.** A draft plan is not claimable; the user says "запускай".
- **Validation modes** (`validation_mode`): `programmatic` (deterministic only),
  `programmatic+llm` (default; cheap LLM judge where no deterministic validator exists),
  `programmatic+llm-fastpass` (loosest; a recorded escape hatch). Resolution: per-step > per-plan
  (`execution_policy_json`) > env `PLAYBOOK_VALIDATION_MODE` > default.
- **Recovery** (P3c): a failing step is classified and recovered via the fixed table in
  `src/recovery-policy.js` (ladder advance / provider switch / backoff), bounded.
- **Hooks** (P4): `notify | check | create_issue | publish` fire at stage/step boundaries;
  external side effects require consent, otherwise the hook is logged as skipped.

## Audience default

`AUDIENCE_DEFAULT_PLAYBOOK` pre-selects a playbook per bot surface (suggestion only — never
auto-runs). Precedence: env `AUDIENCE_DEFAULT_PLAYBOOK` (JSON) → `config/audience-default-playbooks.json`
→ built-ins. Built-ins:

```json
{ "freelance": "freelance-project-spec",
  "exhibition": "exhibition-catalog-to-sales-site",
  "development": "development",
  "default": "development" }
```

## Adding a system playbook

1. Author a draft: `playbook_draft` → `playbook_edit` (drafts are profile-scope).
2. For a repo/system playbook, open a PR adding `playbooks/<id>.json` (`scope: "system"`), validated
   by the schema and compiling cleanly (`compilePlaybook`).
3. Update the audience map in `config/audience-default-playbooks.json` if it should be a default.

## Current playbooks

| id | scope | source |
|---|---|---|
| `development` | system | engineering delivery (16 steps) |
| `freelance-project-spec` | system | freelance project intake → GO/NO-GO |
| `exhibition-catalog-to-sales-site` | system | exhibition catalog → registry check → sales site |
