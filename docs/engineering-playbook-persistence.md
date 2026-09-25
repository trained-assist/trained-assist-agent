# Engineering playbook → durable plan (iteration 1)

Call `ba_development_playbook` in the business-analyst group, expand its 16
stages into concrete goal-specific items (normally 15–20), then use ONE
`task_create` call with `goal`, `user_value`, `acceptance_criteria`, `items`, and
optionally `playbook_id`, `playbook_version`, `project_id`, `session_id`.

Each item supplies `execution_kind`, `executor_role`, `minimum_model_level`,
`context_budget`, and a nonempty `validation` object. Agent requirements are
independent enums. Programmatic items may leave role/level/budget null.
Concrete models, provider selection and numeric context sizes belong to the
future executor configuration, never the checklist contract.

The store writes the task, ordered items and optional session link in one
SQLite transaction. Any failure rolls everything back, including earlier
items and revision changes. `task_get` returns the persisted rows, including
JSON contract/validation fields and session links. Profile comes from MCP
context, not tool arguments. For project-bound plans, create/get rebuilds the
Markdown projection from SQLite; projection failure reports a warning without
misrepresenting a committed plan as rolled back. Project/session references must exist under that
profile; item updates check ownership before mutation, including empty patches.

New plans are **drafts**. The existing scheduler cannot claim them. Legacy
`task_update` cannot activate or finalize contract-bearing plans. This release
has no autonomous execution, validator execution, resolver, replan API or
production acceptance finalization. Those are iterations 2–3; iteration 4 is
the real long-running refactor pilot. Legacy goal-only tasks stay compatible.

## Migration and rollback

The existing database gains task contract fields, item requirements and
validation/evidence fields, execution metadata and `task_validation_results`.
Task statuses gain draft/paused/blocked. The parent-table rebuild and additive
columns are transactional, with a foreign-key integrity check before commit.
Existing child rows remain intact. Old free/standard/strong values are copied
to bachelor/master/doctor; old tier columns remain for legacy callers.
Migration runs idempotently on store open. No second database or orchestrator.

Rollback application code by reverting/redeploying; leave additive DB fields
in place. Old code cannot claim draft plans. Do not run a destructive down
migration. Migration briefly locks writes; only new drafts require the new
code to interpret their executor requirements. Old legacy tiers and new
requirements coexist until the executor iteration removes that compatibility
burden.

## Executable acceptance

`tests/unit/durable-plan-persistence.test.js`, included in mandatory staging:

- A first child process calls the playbook and saves 16 concrete steps with
  one MCP call, then exits. A second process retrieves the exact same task,
  every item/validation field and revision. Another profile cannot get/list
  or update it.
- A bad later item and a conflicting session each roll back the entire plan.
- Foreign and empty item patches neither expose nor mutate another profile.
- Draft plans cannot be scheduled or finalized through legacy endpoints.
- A real v1 schema migrates twice without losing items, sessions or executions.
- Foreign project/session references and traversal are rejected; owned
  references work and caller-supplied profile_id cannot change ownership.

This is a local deterministic subprocess acceptance test, not a claim that the
long-running autonomous pilot has passed.

## P2 — `playbook_run` compiles a Playbook v1 into that plan (issue #1372)

Iteration 1 above was still hand-expanded: a caller turned `ba_development_playbook`
into items itself. `playbook_run` closes that gap: it resolves a saved Playbook v1
(profile custom → sibling → system), renders `goal_template`/step titles and
instructions with `{goal}`/`{input}`/vars, applies the playbook's `defaults`, and
compiles stages/steps into the concrete item contract. It then persists the plan
through the **same** `task_create` path — one atomic SQLite transaction, the same
reference checks and the same `checklist.md` projection — pinning
`{playbook_id, playbook_version}`. The compiler (`src/playbook-compiler.js`) is
pure and never touches the store, so a playbook compiles for many goals and a
plan already pinned to a version is immune to later edits.

`acceptance_criteria` may be supplied per run (goal-specific); when omitted, one
criterion is derived from the playbook's own step validations, so the draft always
carries a machine-checkable task contract. Agent steps must declare
`executor_role`/`minimum_model_level`/`context_budget` — the JSON schema allows
null, the plan contract does not, so a missing one fails as `COMPILE_INVALID`
rather than a silently invented default. New plans remain **drafts**; execution is
still a later slice.

`tests/unit/playbook-run.test.js` (mandatory staging) proves: contract carry-over
and defaults, goal rendering, derived vs explicit acceptance criteria, version-pin
immutability (a later profile override never mutates an already-run plan), coded
errors for unknown/invalid playbooks with nothing written, profile isolation, the
projection on a non-legacy plan, and a real two-process restart where `task_get`
returns the same contract.
