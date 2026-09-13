# Concurrency lane granularity — resolved design

Status: **decided 2026-09-13** (owner constraint locked). Supersedes the earlier
"single profile-keyed lane" super-solution for the *serialization* dimension.
Branch: `fix/per-repo-concurrency-cap`.

## The owner constraint (non-negotiable)

> «Несколько параллельных сессий на профиле — это нормально, это нужно, от этого
> не откажемся.»

Multiple `claude` processes may run concurrently **for one profile**. Any design
that serializes an entire profile down to one live task at a time is rejected.

This kills "lane keyed by profile" (serialization) outright. It does **not** kill a
per-profile *cap* (a counting bound that still permits N-way parallelism).

## The principle: key each mechanism by the resource it actually protects

There are three independent mechanisms. They must not be conflated (conflating them
is what produced R6/R7 and the fixing-in-circles).

| Mechanism | Protects | Correct key | Bound |
|---|---|---|---|
| **Serialization lane** | one workspace's files on disk + its context store | **resolved workDir** (`cwd`) = profile-root when no project, else project dir | 1 (serial chain) |
| **Fairness cap** | global slots — one profile must not starve others | **profile** (`username`) | 4 (`MAX_CONCURRENT_TASKS_PER_KEY`) |
| **Global admission** | host RAM (OOM) | process-global | 6 (`MAX_CONCURRENT_TASKS`) |

Reasoning:

- **Why the lane is keyed by workDir, not chatId, not profile.** The thing a lane
  exists to protect is a shared on-disk workspace: two `claude` writing the same
  files/`context` at once corrupt each other (this is R6). After projects-abstraction
  the `cwd` is repointed into the *project* folder (`runner.js`: `user.cwd =
  projects.projectDir(...)`). So:
  - Two sessions in **different projects** of one profile → different `cwd` → no
    shared files → **parallel, and wanted** (satisfies the owner constraint).
  - Two sessions in the **same project** (or same profile-root when project-less),
    reached from web *and* chat, or from two chats → same `cwd` → **must serialize**
    (this is the R6 corruption bug; a cap of 4 does NOT prevent it).
  - `chatId` is the wrong key because web (`id:0`) and chat (`chatId`) are different
    keys for the *same* workDir → the R6 race. `profile` is the wrong key because it
    over-serializes different projects → violates the owner constraint.

- **Why the cap is keyed by profile.** Fairness only: one profile spread across many
  projects could otherwise grab all 6 global slots and starve every other profile.
  Cap = 4 lets a single profile run up to 4 concurrent (constraint satisfied) while
  leaving headroom under the global 6. Per-key **counts** live in a `Map<key,count>`
  (not a single process-global integer) — that is the structural fix for R7
  (a limit set for one profile leaking to all).

- **Why global admission stays.** RAM is a host-wide resource; its guard is
  host-wide. Unchanged.

## The one genuinely shared per-profile resource: context store

`context_set` writes by **USERNAME** (profile), not `cwd` — so two *different*
projects of one profile still share one context file. This is NOT a reason to
serialize whole multi-minute sessions at profile granularity. It is a small-file
write race, fixed at its own altitude:

- **context writes must be atomic**: write temp + `rename()` (rename is atomic on
  the same filesystem). Concurrent cross-project writers then never observe a
  half-written file; last writer wins per-key, which is the existing semantics.

## Ordering of the two admission gates (already in code, keep)

1. `_acquireKeySlot(profile)` — cheap, spawns nothing; a task blocked on its
   profile's cap waits here **without** holding a scarce global slot.
2. `_waitForRam()` + `_acquireSlot()` — only once past the cap.

Lane wraps both: `laneTail = prev.then(() => acquireKey → acquireGlobal → run)`.

## What changes vs. current `fix/per-repo-concurrency-cap`

Already correct on the branch: per-profile **cap** (`capKey = username`), per-key
count map (R7 structural fix), gate ordering.

**Still to change (this doc's delta):**

1. **Re-key the lane** `chatLanes` from `chatId` → **resolved workDir**. Requires
   resolving the project binding *before* entering the lane (today it resolves deep
   inside `_runTask`). Extract a shared `resolveBoundProject(user, opts)` →
   `{ boundProjectId, cwd }`; call it in `runTask` for the lane key AND reuse it in
   `_runTask` (removes the duplicated binding logic — the duplication the owner
   flagged).
2. **Atomic context write** in the context-store module (temp + rename).
3. `wakeup`/lane-clear must delete by the **workDir** key, not `chatId`.

## Acceptance scenarios (S8 — must be red before the change, green after)

- **S8.1 same-project serializes:** two tasks, same profile, same project (one via
  web `id:0`, one via chat) → never overlap; second starts after first ends.
- **S8.2 different-project parallel:** two tasks, same profile, different projects →
  overlap (both live at once), given cap ≥ 2 and global ≥ 2.
- **S8.3 cross-profile isolated:** a cap set/reached for profile A never blocks
  profile B; B runs concurrently.
- **S8.4 per-profile cap bounds total:** N > cap tasks across many projects of one
  profile → at most `cap` live at once; the rest queue.
- **S8.5 atomic context:** concurrent `context_set` on two projects of one profile →
  file always parses (never a torn write); no lost key from the *other* project’s
  namespace.

## Explicitly rejected alternatives

- **Single profile-keyed serialization lane** ("super-solution" as serialization):
  rejected by the owner constraint — over-serializes, kills wanted parallelism.
- **Lane keyed by chatId** (status quo before this branch): leaves R6 — web and chat
  hit the same workDir under different keys and race.
- **Cap only, no lane re-key:** a cap of 4 still lets up to 4 `claude` race on the
  *same* project workDir — corruption, not fairness. Cap and lane solve different
  problems; both are needed.

## No release until staging green

Per the intake-refactor discipline: S8.1–S8.5 land as failing tests first, implement
second, no merge until all green + a smoke run on staging.
