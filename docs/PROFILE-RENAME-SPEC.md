# Owner → Profile rename (durable spec)

**Owner canon (2026-09-14, do not relitigate):** the account that owns sessions,
projects, tokens and limits is a **PROFILE**, never a «user». The word «user» was
reused for both the owner *and* the external Telegram person, which confused even the
owner into believing "1 user = 1 session". Fix: call the owner `profile` / `profileId`
everywhere; keep the external Telegram identity as `telegramUserId` (the *tguser*
layer). Sessions belong to the profile, roam chat→chat, invariant ≤1 live per chat.
See issue #550, memory `profile-not-user-naming`, `session-model-three-layers-clarified`.

## Why this is NOT one blind sed

`grep` counts ~1134 owner-ish identifiers, but "user" has **four distinct meanings**
in this repo. Only bucket A renames:

| Bucket | Examples | Action |
|---|---|---|
| **A. Owner identity** | `username`/`userId` as the workspace owner, `capKey`, `USER_ID` env, `ownerChatId` | **rename → profile\*** (this spec) |
| **B. External Telegram person** | `telegramUserId`, `msg.from.id`, `from.username` | **keep** — this is the tguser layer, correctly separate |
| **C. External API fields** | `user_id` (snake_case) in GetCourse/Weeek/credentials MCP params | **keep** — wire contract with third parties |
| **D. Chat message role** | `role: 'user'` | **keep** — nothing to do with the owner |

**Irreversible / cross-repo constraints (owner cost-calls):**
1. **Do NOT rename on-disk `~/users/<username>/` directories.** The dir name is just an
   ID string; renaming is the only irreversible part and buys zero functional gain.
   The *variable* renames; the *path segment `users/`* and the *value* stay.
2. **`/run` payload `{userId, username, telegramUserId}` is a wire contract with the
   tg-bot gateway** (separate repo, live Cloudflare Worker). Same for `/hh/*` HMAC
   bodies and generated ATS-editor HTML. A flag-day rename here breaks the live bot —
   the same two-repo trap as the `/persona` incident. Migrate with a **compat shim**:
   the agent accepts *both* names, the gateway switches later, the old name is dropped
   last.
3. **`USER_ID` env is the owner→spawned-Claude boundary**, read by ~20 MCP tools +
   runner spawn + already-created crons (`u${USER_ID}`). Migrate additively: export
   `PROFILE_ID` alongside `USER_ID`, move readers over, drop `USER_ID` last.

## Layered plan (each layer independently shippable + reversible)

- **L1 — internal + boundary keystone (DONE, this PR):**
  - `ownerChatId` → `liveChatId` across session-store / runner / gtd-controller, with
    read-fallback (`liveChatId ?? ownerChatId`) for pre-rename session files and lazy
    write-migration. `claimOwnerChatId` → `claimLiveChatId` (+ back-compat export alias).
  - Reject message reworded: «перешла в другой чат» → «сейчас закреплена за другим
    чатом; /sessions перенести» (attachment is current, not permanent ownership).
  - `/run` introduces `profileId` on the `user` object (`= payload.profileId ?? username`).
    Additive: the gateway need not change yet; internal code may start reading
    `user.profileId` as the canonical owner id.

- **L2 — internal reader sweep (agent-only, no wire/env change):** replace owner-meaning
  `user.username`/`user.userId` reads with `user.profileId` in internal modules
  (`runner.js`, `data-paths.js` param names, `session-store`, hh/*, mcp-skills that read
  the owner from the `user` object — NOT the snake_case `user_id` API params). Verify each
  file with `node -c` + tests; keep values identical.

- **L3 — env boundary:** `browser.js` spawn exports `PROFILE_ID` (= profileId) alongside
  `USER_ID`; MCP tools read `process.env.PROFILE_ID || process.env.USER_ID`. Drop
  `USER_ID` only after all tools migrated and one deploy cycle passes.

- **L4 — gateway wire cutover (cross-repo, coordinated):** tg-bot gateway starts sending
  `profileId` on `/run` and `/hh/*`. Agent already accepts it (L1). After both deploy and
  bake, drop the `username` alias from the agent boundary.

- **L5 — cleanup:** remove back-compat aliases (`claimOwnerChatId`, `ownerChatId`
  read-fallbacks, `username` boundary alias) once no reader/writer/caller remains.

## Explicitly out of scope (forever)
- On-disk `~/users/<username>/` directory names (irreversible, zero gain).
- Buckets B/C/D above.

## Verification discipline
`node -c` every changed file; run `test/*.cjs` + `tests/*` (vitest in CI). No layer merges
until green. Never push agent `main` from inside a live session — CI SSH-redeploys
`assist-agent.service` (shared cgroup) and SIGKILLs the session; land via PR + owner merge.
