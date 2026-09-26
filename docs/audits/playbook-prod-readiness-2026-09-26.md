# Playbooks — production-readiness audit (2026-09-26)

Epic: [#1372](https://github.com/trained-assist/trained-assist-agent/issues/1372) · P3d: [#1426](https://github.com/trained-assist/trained-assist-agent/issues/1426)

- **Branch / base:** `docs/playbook-prod-readiness-audit-3` off `main` @ `0e5af19` (`feat(playbooks): #1372 P3d-2 — finalization gate driven by validation_mode (#1442)`).
- **Method:** code trace hop-by-hop (`file:line`), the playbook-path test suites run locally, and a network-free end-to-end simulation that drives the *real* modules with injected engine/LLM/GitHub fakes. No `src/` file was modified.
- **Question:** how far is Playbooks from **real production use**? "Merged" ≠ "works in prod".

## TL;DR

A user can, **today in prod**: see `playbook_*` tools, `playbook_run` the engineering playbook into a persisted 16-item DRAFT plan, activate it through `task_update status=active`, and watch the server tick claim steps, resolve each agent step to a different engine/profile (OpenCode `value`/`max`, Claude for `doctor`), execute `programmatic` steps with **no engine**, record validation rows + evidence, and finalize `done` **only** through the machine gate.

What is **not** production-real yet:

1. **The 4 `programmatic` steps of `development.json` are not actually deterministic.** Three of their validation keys are unregistered, and the two registered CI/merge keys are permanently `inconclusive` on the staging/deploy half. Under the default `programmatic+llm` mode every programmatic step therefore falls through to the cheap-LLM judge — the "objective checks don't burn a model" promise (the whole point of P3d) is not delivered. Under `programmatic` mode those steps can never pass.
2. **P3b step-role wiring is incomplete:** `ocRole` (researcher→explore, reviewer→review) is computed by the resolver and then silently dropped (`_runTask` never accepts it, `buildOcProfileOverrides` always resolves the `build` role), and `forceClaude` is hard-coded `true` for every step including OpenCode ones.
3. **Hooks (P4) and playbook migration / audience default (P5) are missing entirely** — hooks are rendered into prompts but never executed; only one playbook is in the registry and nothing picks a playbook by audience.

Plus two execution-ordering issues found in the sim (a delay-gated step does not block later steps; `claimNextRunnable` ignores injected `now`).

---

## 1. Evidence: tests and simulation

### Test suites (all green locally)

| Command | Result |
|---|---|
| `npx vitest run tests/unit/playbook-*.test.js tests/unit/durable-*.test.js` | **9 files, 117 tests passed** (store, authoring, compiler/run, executor, validators, validators-mode, durable store, plan persistence, tasks MCP) |
| `node test/gtd-durable-wiring.test.cjs` | **52 passed, 0 failed** (fire pipeline, escalation, crash recovery, re-entrancy, draft gating, attempt budget, expired waiter, legacy engine, programmatic, inconclusive key, agent evidence, LLM mode, per-step override, fast-pass skip, finalization gate) |

### End-to-end simulation (no network / no LLM / no engine)

Script: `docs/audits/playbook-prod-readiness-sim.cjs` · output: `docs/audits/playbook-prod-readiness-sim.out`.

It calls the real MCP tool registry and handlers, the real store, and the real `gtd-controller.runDueDurable`, with `runTask`/`registry`/`llmValidate` injected. Key output:

```
playbook_* tools discovered: playbook_list, playbook_get, playbook_draft, playbook_edit, playbook_save, playbook_run
task.status=draft  playbook=development@1  items=16
fires while draft = 0 (expect 0)
task.status after task_update = active
state before fast-forwarding the waiter: 0:done ... 10:done 11:waiting 12:done 13:done 14:done 15:done
task reached terminal status=done
items: 16/16 done
validation rows=16 (pass=16, fail=0, inconclusive=0)
engine steps fired:
   [opencode/value] (forceClaude) role=null — Define user value
   [opencode/value] (forceClaude) role=null — Record acceptance criteria
   [opencode/max]   (forceClaude) role=null — Define validation
   ... (12 agent fires total; the 4 programmatic steps did NOT spawn an engine)
```

Contrast — the **real** deterministic registry on the engineering playbook's keys (with a fake GitHub token, network-free):

```
tests_lint_regression_green → unregistered            (→ falls to LLM judge)
pr_opened                   → unregistered            (→ falls to LLM judge)
ci_green                    → pass
ci_and_staging_green        → inconclusive  {"reason":"staging-unverified"}
merged / pr_merged          → pass
merged_and_deployed         → inconclusive  {"reason":"deploy-unverified"}
```

---

## 2. End-to-end path table

| # | Hop | Verdict | Evidence (`file:line` / command) | What a prod user actually sees |
|---|-----|---------|----------------------------------|--------------------------------|
| 1 | **Registry / visibility** — `playbook_*` callable, `development.json` resolves | **REAL** | Auto-discovery `src/mcp-skills/registry.js:14-32` (no `isReady` in `102-playbooks.js` → always registered); 6 tools `src/mcp-skills/tools/102-playbooks.js:47,56,83,104,123,141`; resolution profile→sibling→system `src/playbook-store.js:125-135,163-170`; `playbooks/development.json` scope `system` v1 | Claude/Telegram user's session already has `playbook_list/get/draft/edit/save/run`; `development` lists as `system` |
| 2 | **Authoring** (Hermes: `playbook_draft/edit/save`) | **REAL (needs an LLM key)** | `src/playbook-authoring.js:217-358`; `src/hermes-run.js:40-58`; key = per-profile `openrouter` **or** server `OPENROUTER_API_KEY` (`src/hh-scoring.js:297-305`); key is deployed to GCP (`infra/env-manifest.json:60`, `.github/workflows/ci.yml:257-266`); without any key → `AUTHORING_INVALID` (`playbook-authoring.js:228-230`) | A user can describe a process and get a validated profile-scope playbook saved under `~/users/<profile>/playbooks/`. Works in prod; fails cleanly if the secret is ever removed |
| 3 | **Compile → DRAFT plan** (`playbook_run` → `compilePlaybook` → `task_create`) | **REAL** | `102-playbooks.js:162-189` → `src/playbook-compiler.js:56-113` → `101-durable-tasks.js:82-92` `createPlan` (`durable-task-store.js:119-148`); sim step 1: 16 items, `status=draft`, pinned `development@1` | One atomic transaction persists goal + 16 contract items; nothing runs until activation |
| 4 | **Activation** (`task_update status=active`) | **REAL** | `101-durable-tasks.js:177-183`; `src/durable-task-store.js:156-196`; draft unclaimable, active claimable (sim step 2/2b, wiring tests 5) | Explicit "запускай" flips the plan to claimable |
| 5 | **Tick is scheduled in prod** | **REAL** | `src/server.js:1980` `if (process.env.TEST_MODE !== '1') scheduleGtdController(secrets)`; first tick +2 min, then every 5 min `:262-263`; `gtd-controller.js:977-982` → `runDueDurable` | The scheduler runs on the live GCP service; draft plans wait, active plans progress every 5 min |
| 6 | **Fire a step to an engine** (workDir fixed by P3b) | **REAL (with 2 wiring defects)** | `gtd-controller.js:262-373`; `workDir = userWorkDir(task.profile_id)` `:307`; `resolveStepExecution` `:301-303`; opts `:367-372`; map `src/playbook-executor.js:25-37`. **Defect A:** `ocRole` never forwarded (`_runTask` signature `src/runner/index.js:1440` has no `ocRole`; ladder always resolves `build` `:1934`). **Defect B:** `forceClaude: true` hard-coded `gtd-controller.js:370` | Agent steps really run on OpenCode `value`/`max` / Claude `doctor`; `researcher/reviewer` roles are **not** honoured (all OpenCode steps use the `build` ladder) |
| 7 | **Programmatic step executes without an engine** | **REAL (orchestration)** | `gtd-controller.js:315-340` — no `runTask`; registry eval, evidence, complete/fail/retry; sim: 4 programmatic items fired 0 engines | CI/PR/wait/merge steps no longer burn a model *run* — but see hop 8 for what validates them |
| 8 | **Validation** (`validation_mode`, registry, LLM judge) | **PARTIAL / STUBBED for this playbook** | registry `src/playbook-validators.js:384-394`; modes `:37-39`; resolution `:205-219`; LLM judge `:301-326`; default `programmatic+llm` `:38`. `development.json` uses `tests_lint_regression_green`/`pr_opened` (**unregistered**) and `ci_and_staging_green`/`merged_and_deployed` (**deterministically `inconclusive`**, sim §4b) | With the deployed `OPENROUTER_API_KEY`, every programmatic step is judged by an LLM (`google/gemini-2.5-flash`) instead of by code. Under `programmatic` mode the plan can **never** finalize. Deterministic `file_exists`/`command_exit_zero`/`ci_green`/`merged` exist but this playbook never names them |
| 9 | **Evidence recording** | **REAL** | `durable-task-store.js:430-479` (`recordValidation`, `setItemEvidence`); `gtd-controller.js:320-323,396-398` | Each step leaves `task_validation_results` rows + `task_items.evidence_json`; sim=16/16 rows |
| 10 | **Finalization gate** | **REAL (no bypass)** | `durable-task-store.js:172-177` (`updateTask done` throws on unmet), `:217-253` (`finalizePlan`); `gtd-controller.js:237-254` (`settleTaskCompletion` uses `finalizePlan`); `grep "SET status"` in `src/` → **no raw-SQL `done` bypass left**; wiring tests 17 | A contract plan with a missing/failed validation stays `active` and logs `finalization blocked` — cannot be closed "from memory" |
| 11 | **Hooks** (`on_enter`/`on_exit`/`on_complete`/`on_fail`/`task_done`) | **MISSING** | `grep` for hook keys outside `playbook-store.js`/`playbook-authoring.js`/`102-playbooks.js` → **none**; only rendered to text `src/playbook-store.js:80-113` | The user gets no stage/step notifications; `development.json`'s `task_done`/`task_failed` hooks do nothing (`P4`) |
| 12 | **Playbook migration + audience default** | **MISSING** | only `playbooks/development.json`; `grep AUDIENCE_DEFAULT_PLAYBOOK` → **none**; freelance lives in sibling PR, exhibition not started | Only the engineering playbook exists; a user is never *automatically* given the right playbook — the LLM must choose `playbook_run` (`P5`) |

---

## 3. Ranked gap list

### WORKS TODAY
- MCP autodiscovery + all six `playbook_*` tools, profile-scoped resolution (`P0`).
- `playbook_run` → atomic DRAFT plan with pinned `{playbook_id,playbook_version}` (`P2`).
- Explicit `draft→active` activation; per-step attempt budget + `execution_timeout_seconds`; delay waiters with `expireWaitingDeadlines` (`P3a`).
- Per-step engine/profile resolution and real firing on OpenCode/Claude (`P3b` engine/profile half).
- Programmatic steps execute with no engine run; validation + evidence rows written; `programmatic` / `+llm` / `+llm-fastpass` modes selectable per step/plan/env (`P3d-1`).
- Finalization gate that cannot be bypassed (`P3d-2`).

### ONE SMALL FIX
1. **Make the engineering playbook's programmatic steps deterministic.** Either register the keys it uses, or (smaller) change `playbooks/development.json` to the registered vocabulary — map "Run tests, lint and regression checks" → `command_exit_zero: "npm run check && npm test"`, "Open PR" → a new `pr_opened` GitHub validator, CI/merge keep `ci_green`/`merged` (the `staging`/`deployed` halves have no signal — don't require them).
2. **Finish P3b role wiring:** accept `ocRole` in `_runTask` (`src/runner/index.js:1440`) and pass it from `runDueDurable` (`gtd-controller.js:367-372`); set `forceClaude: step.engine === 'claude'` instead of `true`.
3. **Per-profile GitHub token prerequisite:** `_ghToken(profileId)` reads `~/agent-tokens/<profile>/github` (`gtd-controller.js:756-762`); a profile that hasn't connected GitHub makes `ci_*`/`merged*` `inconclusive` (`src/playbook-validators.js:100-101,127-128`).
4. **Fix execution ordering / time injection:** either (a) make `completeItem` gate the *next sibling only* by creating items non-claimable (`durable-task-store.js:132-144` sets every item `pending`), or (b) have `claimNextRunnable` respect `due_at`/position gating (`:342-356`). Separately, `claimNextRunnable` calls `nowMs()` internally (`:345`) so an injected `now` cannot drive it (found while building the sim).

### MISSING SLICE
5. **P4 — hook runtime** in `runDueDurable`/stage transitions + consent policy. Only rendering exists today.
6. **P3c — recovery policy** after a step exhausts `max_attempts` (currently the item stays `failed` forever; no ladder/cross-engine escalation).
7. **P5 — playbook migration + `AUDIENCE_DEFAULT_PLAYBOOK`** (+ `docs/playbooks.md`). Only `development.json` exists.
8. **Deterministic `pr_opened` validator and a real staging/deploy health signal** (or an explicit product decision to leave staging/deploy to the LLM/non-blocking).

---

## 4. Explicit production blockers for the engineering playbook end-to-end

| Blocker | Status / detail |
|---|---|
| `OPENROUTER_API_KEY` on GCP | **Present** (`infra/env-manifest.json:60`, written by `ci.yml`/`deploy-manual.yml`). Required by the LLM judge (`playbook-validators.js:303`) and by OpenCode profiles `value`/`max`. Not a blocker — but it means programmatic steps currently *depend* on it. |
| Per-profile GitHub token | **Prereq.** Needed for `ci_green`/`merged*`; connect GitHub via ZeroCreds (`~/agent-tokens/<profile>/github`). Without it those validators are `inconclusive`. |
| Deterministic validators for `development.json` keys | **Blocker for the "no model" guarantee.** `tests_lint_regression_green` and `pr_opened` are unregistered; `ci_and_staging_green`/`merged_and_deployed` are permanently `inconclusive` deterministically. |
| `opencode` binary on the VM | **Verify.** Installed only by `scripts/setup-opencode.sh`; **not** invoked by `scripts/setup.sh` or `deploy.sh` (which only runs `infra/opencode-switch-profile.sh`). Runner defaults to `OPENCODE_BIN || 'opencode'` (`src/runner/claude-runner.js:220`). If absent, `bachelor`/`master` steps fail at spawn and retry to budget. |
| `.opencode/profiles/{value,max}.json` | **Present & tracked** (`.opencode/profiles/`), so they ship with the release. Models need `OPENROUTER_API_KEY` / `OPENCODE_GO_API_KEY` (both deployed). |
| Hooks not executed | **Blocker for the notification UX** of the playbook. `task_done`/`task_failed`/stage hooks are data only (`P4`). |
| Playbooks not migrated / no audience default | **Blocker for "user says «поставь изменение X» → Hermes picks `development`"**. Nothing maps an audience to a default playbook; only manual `playbook_run` works. |
| Doc/UX drift | `docs/user-scenarios/engineering/01-development-playbook.md:7` names `ba_development_playbook` as "the tool" with compiler `src/playbook-compiler.js`, but `ba_development_playbook` returns a **static stage list** (`src/development-playbook.js`) and never calls the compiler — the compiler path is `playbook_run`. `src/mcp-skills/tools/00-meta.js:66` still says "автовыполнение пока не включено" (stale: P3a/P3d are merged and the tick executes). |

---

## 5. What to do first

**Do the smallest thing that makes the P3d contract actually deterministic, then finish the P3b wiring** — in this order:

1. **Align `playbooks/development.json` with the registered validator vocabulary** (or add the two missing validators): `command_exit_zero` for tests/lint, a new `pr_opened` GitHub validator, `ci_green` + `merged` for the deliver steps (drop the `_staging`/`_deployed` halves until a real signal exists). This turns the four programmatic steps from "LLM-judged" into "code-judged" and is the literal Definition-of-Done of P3d.
2. **Finish P3b**: forward `ocRole`, and set `forceClaude` only for `engine === 'claude'`.
3. **Then** P4 (hooks + consent) and P5 (`AUDIENCE_DEFAULT_PLAYBOOK` + freelance/exhibition playbooks), because neither has a correct machine verdict to build on until (1) is done.

---

## Appendix — reproduce

```bash
npx vitest run tests/unit/playbook-*.test.js tests/unit/durable-*.test.js   # 117 passed
node test/gtd-durable-wiring.test.cjs                                      # 52 passed, 0 failed
node docs/audits/playbook-prod-readiness-sim.cjs                           # writes the .out evidence file
```
