# Projects convergence — master plan (no backward-compat, migrate everyone)

Direction set by user (voice, 2026-09-13): «всё выхватывай, обратная совместимость не нужна;
всё перенести в новые папки, руками пофиксить, сделать чтобы было хорошо.»
Supersedes the opt-in/gradual approach in PROJECT-PICKER-517-findings.md.

## Target end state (ONE project concept)
- Typed projects.js (mechanism B) is the ONLY project concept. Raw-subfolder picker
  (mechanism A) is retired.
- Every profile is on the projects model. No opt-in gate. New profile with 0 projects →
  a default project is created on first task.
- Existing root artifacts (interviews/, expo-pipeline/, applylink/, vacancy-drafts/…) are
  MIGRATED into typed project folders. Nothing important left orphaned in the workspace root.
- At NEW-dialog creation, when ≥2 projects exist, the gateway shows an inline picker
  `[Проект A] [Проект B] … [➕ Новый проект]` and the task waits for the choice (issue #517).
  `➕ Новый` → provisional name from the first message; end-of-session may rename from summary.

## Two live mechanisms today (the fork we're closing)
- A. gateway `fp:`/`nd:folder` picker → agent `GET /projects` (raw subdir names + usage) →
  `/run {projectDir:<folder-name-string>}` → `cwd = workDir/projectDir`. server.js:2464, 2514-2525.
  gateway: callbacks.js fp:/fpg:/nd: ; passes `projectDir` string on KV session.
- B. projects.js typed abstraction. runner.js binding block (~1700). project.json/PROFILE.md.
  web-UI already uses it via POST /web/projects + /web/project-create. `ask` branch is dead UI.

## Change surface (ordered by dependency)

### Step 0 — durable plan (this doc). DONE.

### Step 1 — Migration tool (repo script, generalized, non-destructive)
- `scripts/migrate-profile-to-projects.mjs` (promote the two ad-hoc per-profile scripts to one).
- Uses REAL src/projects.js so ids/scaffold match prod. Ledger-first (projects/.migration-ledger.jsonl),
  mv-only, `--apply` gated, `--all` sweeps every profile under USERS_ROOT.
- Classifier (clear prefixes only; ambiguous stays at root, logged):
  - `interviews/`, `applylink/`, `vacancy-drafts/` → recruiting project
  - `expo-pipeline/` per-expo + built `<slug>.html`/`deploy/<slug>` → expo project(s)
  - unknown → leave at root, report.
- Profiles WITH an existing single obvious project → move into it; profiles with none →
  create default typed by artifact kind; profiles already fully migrated (efi, flexi-consult,
  mbk_luda_recruiter) → no-op.
- Output a DRY-RUN report across all profiles → show user before `--apply` (only irreversible step
  that isn't caught by tests → worth one confirm).

### Step 2 — Agent: projectId in /run + /project-decision + retire raw listing
- `/run` accepts `projectId` (typed). Binds via projects.setActiveProjectId + cwd=projectDir(id).
  Remove the `projectDir` raw-string path (no backward-compat).
- New `GET /project-decision?username=&chatId=` → decideNewSessionProject result
  {action, choices:[{id,name,label}], active} for the gateway to render the picker.
- runner.js: DELETE the `projectEnabled` opt-in gate + dead `projectAskPending`. Always bind.
  New session: auto (1) / create default (0) / bind chosen projectId when gateway passed one;
  if ask and no projectId passed → bind active/most-recent (gateway is responsible for asking first).
- Retire `GET /projects` raw-subdir listing + trackProjectUsage/.project-usage.json.

### Step 3 — Gateway: typed picker at new-dialog + pp: callbacks
- New-dialog dispatch: call agent `GET /project-decision`. If action==='ask' → inline
  `[name…] [➕ Новый проект]`, stash pendingMessage on KV; else dispatch directly.
- `pp:<id>` → run pending task with {projectId:id}. `pp:new` → create provisional-named project
  (first message text) then run with its id.
- Rewrite fp:/nd:folder to the typed list (projectId), or remove folder picker entirely.
  KV session stores `projectId` (not `projectDir` string).

### Step 4 — End-of-session rename from summary (small, later PR)
- session-summary.js: for a project created with a provisional name this session, silent rename
  (projects.renameProject) from the session summary title.

## Deploy ordering (avoid regression window)
Migration (Step 1 --apply) MUST land before Step 2 gate-removal reaches prod — otherwise
un-migrated profiles auto-create «Основной» and cwd moves off their root artifacts.
Sequence: Step1 apply on disk → deploy Step2 agent → deploy Step3 gateway (atomic pair) → Step4.

## Reversibility
- Code: git revert per PR.
- Migration: ledger (projects/.migration-ledger.jsonl) records every mv → reverse-replayable.
