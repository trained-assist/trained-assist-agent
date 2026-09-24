# Fix plan: bot/audience token confusion causing frozen Telegram progress

Date: 2026-09-24
Status: research complete, fixes not yet implemented (this session was research-only)

## Symptoms investigated

1. Group chat `-5496844108` (audience `default`, bot `super_personal_assistant_bot`,
   id `8843910332`): placeholder froze at «Думаю… (2с)».
2. Freelance chat `1714048` (audience `freelance`, bot `freelance_spec_bot`, id
   `8912732465`): same class of freeze.

Both were reported as: the backend tried to edit the progress message but the edit
silently failed, with no visible error to the user or operator.

## What I verified is NOT the cause (ruling out the stated hypothesis)

The original hypothesis was "wrong bot token used for the audience, or no token
resolved." I traced the whole audience→token path end to end and it is **fail-closed
by design**, already hardened under issue #1302:

- `src/bot-delivery.js` `deliverySecrets(secrets, audience)` — an explicitly unknown
  audience throws; a known audience with a missing/empty token throws
  `"<audience> Telegram delivery is not configured"`. `default` never swaps in another
  bot's token.
- `src/runner/index.js:450-451` — `runTask(opts)` calls `taskDelivery(opts)` as its
  **very first statement**, before anything else runs. That's where `opts.secrets.BOT_TOKEN`
  gets swapped to the audience-correct token. Everything downstream, including the
  `BOT_TOKEN` destructured at `src/runner/index.js:1268` and passed into
  `runEngineProcess()` (and from there into `progressEdit`), already carries the
  correct per-audience token.
- `src/server.js:1310-1311` — `POST /run` independently validates
  `deliverySecrets(secrets, audience)` at admission time and returns `503`
  (`.../not configured/`) or `400` before a task is even queued.
- `resumePendingTasks()` (`src/server.js:287-308`) resolves the resume-notification
  token the same way (`taskDelivery(...).secrets.BOT_TOKEN`), and logs
  `[resume] delivery unavailable: <msg>` on failure — this path is not silent.
- I confirmed live which bot is actually a member of each affected chat
  (`getChat` probe with each token):
  - `-5496844108`: only the default bot (`BOT_TOKEN`) is a member — freelance token
    gets `400 chat not found`. So the default-audience session there could not have
    used the wrong token; there's only one bot that could possibly have sent/edited
    that message.
  - `1714048`: **both** the default bot and the freelance bot are members (it's
    Vladimir's personal chat with multiple bots added). This is the one place a
    cross-audience mix-up would be *symptom-compatible* (Telegram would reject an
    edit attempted by the "wrong" member bot with a non-429 error rather than a
    security error) — but tracing the code path above shows the token actually used
    is already the correct one by construction, not something that can drift mid-task.
- On tg-bot's side (`trained-assist-tg-bot`, `origin/main`, confirmed via
  `git show origin/main:...`, not a possibly-stale local checkout): audience
  resolution is **not** missing or 2-way as I initially assumed from a stale local
  clone. `src/lib/audience.js` (landed in #235, "PR-A2 of #1302") already implements
  a 1:1 Worker-env→audience model (`resolveAudience(env) = env.SESSION_NAMESPACE || 'default'`),
  used uniformly by `agent-client.js`, and `wrangler.toml` already has
  `[env.freelance]` alongside `[env.recruiter]` and the default env. So there is no
  missing per-chat/group mapping on the gateway side either.

**Conclusion: the audience→bot-token resolution mechanism itself is correct and
fail-closed.** The bug is not "wrong token used" — it's "a real edit failure (of
whatever origin) is made invisible," plus a separate, currently-live silent
secret-loading gap. Both are detailed below with evidence.

## Root cause 1 (primary — explains the frozen counter): `progressEdit` swallows ALL errors, not just 429

`src/runner/claude-runner.js:294-305`:

```js
const progressEdits = new Set();
let progressStopped = false;
function progressEdit(...args) {
  if (progressStopped) return Promise.resolve();
  // Progress/status edits are cosmetic: best-effort (drop on 429 — a missed
  // "Думаю…" update is fine, a 5-44s block is not) and coalesced per chat so
  // concurrent sessions sharing a bot token can't flood editMessageText.
  const pending = tgEdit(...args, { bestEffort: true, coalesce: true }).catch(() => {});
  ...
}
```

The comment says the intent is to drop **429s**. The implementation
(`.catch(() => {})`) drops **everything** — any non-429 failure from
`tgEdit()` (`src/runner/tg-stream.js:138-204`), e.g.:

- `400 message to edit not found` (message deleted, or edited by a different bot
  than the one that sent it — exactly what would happen in a chat like `1714048`
  where two bots are members, if a stale/legacy pending-task record without a
  correctly-threaded audience ever surfaces),
- a fetch timeout (`AbortSignal.timeout(10_000)` throwing),
- any other Telegram 4xx/5xx (`res.ok`/`data.ok` false branch at
  `tg-stream.js:189-196`, which `throw`s an `Error`).

None of this is logged anywhere. `progressEdit` is the **only** call site that
edits the "Думаю… (Nс)" heartbeat (`src/runner/claude-runner.js:301` is the sole
`tgEdit` invocation in that file); every other `tgEdit` call in the codebase
(`src/runner/index.js`, terminal replies) has a `.catch(() => tgSend(...))`
fallback that at least attempts to deliver the message a different way. The
heartbeat has no such fallback — a failed edit just vanishes, and the user is
left staring at a stale "(2с)" forever, with zero trace in the logs for an
operator to diagnose.

This is the mechanism that turns *any* transient Telegram-side hiccup (message
deleted, network blip, the two-bots-in-one-chat edit-ownership conflict above,
etc.) into an indefinitely frozen, silent, undiagnosable progress message —
regardless of what actually caused the underlying edit to fail. Fixing this is
the highest-leverage change: it makes the *class* of bug visible instead of
guessing at each specific transient trigger.

## Root cause 2 (live, currently reproducible — same failure class): optional bot-token secrets can silently resolve to `null` forever, with zero logging

`src/secrets.js:16-32` (`loadFromGcp`):

```js
async function getSecret(name) {
  const [version] = await client.accessSecretVersion({ ... });
  return version.payload.data.toString('utf8').trim();
}
const names = [...REQUIRED, ...OPTIONAL];
const results = await Promise.allSettled(names.map(n => getSecret(n)));
return Object.fromEntries(names.map((n, i) => [
  n,
  results[i].status === 'fulfilled' ? results[i].value : null,
]));
```

Every secret fetch is wrapped in `Promise.allSettled` — a rejection for any
**individual** secret is silently turned into `null`, with the rejection reason
(`e.message`, `e.code`) discarded entirely. `loadSecrets()` is called exactly
**once**, at process boot (`src/server.js:409`, inside `main()`), and the
resulting `secrets` object is then threaded through every request for the rest
of that process's life — there is no retry, no refresh, no periodic re-check.

I reproduced this live on the GCP VM right now:

```
$ node -e "require('./src/secrets').loadSecrets().then(s => ...)"
BOT_TOKEN = 8843910332          (OK)
RECRUITER_BOT_TOKEN = null      (BROKEN)
FREELANCE_BOT_TOKEN = 8912732465 (OK)
```

Consistent across 5 repeated runs (not a transient flake). Bypassing the
`Promise.allSettled` swallow and calling `accessSecretVersion` directly for
`RECRUITER_BOT_TOKEN`:

```
REJECTED: 5 NOT_FOUND: Secret [projects/731388616698/secrets/RECRUITER_BOT_TOKEN] not found or has no versions.
```

So `RECRUITER_BOT_TOKEN` genuinely does not exist (or has no versions) in GCP
Secret Manager project `alesa-personal-assistent` right now. This means:

- Every `audience: 'recruiter'` `/run` call currently gets a `503` at admission
  (`deliverySecrets` throws `"recruiter Telegram delivery is not configured"` —
  this part **is** visible to the caller), so recruiter delivery is fully broken
  right now.
- Nothing paged an operator about it. `RECRUITER_BOT_TOKEN` is classified in
  `infra/env-manifest.json` under `gcp_secret_manager_only` (manually created via
  `gcloud secrets create`, never written by CI) and is **not referenced anywhere**
  in `.github/workflows/ci.yml`, `.github/workflows/deploy-manual.yml`, or
  `scripts/check-env-sync.js` (all three greps returned zero matches) — so there
  is no automated check anywhere in the pipeline that would have caught the
  secret being missing or deleted.

This doesn't explain the two specific reported freezes (both `BOT_TOKEN` and
`FREELANCE_BOT_TOKEN` resolved correctly at the time I tested), but it is the
exact same failure class — a secret silently resolving to `null` with zero
operator-facing signal — and it is live in production today. It needs to be
fixed in the same pass since the fix (make secret-load failures loud) is the
same fix.

## Contributing operational factor (not a code bug, but inflates how often the symptom appears): very frequent deploy-triggered restarts

`journalctl -u assist-agent` for just the last ~90 minutes today showed **7
restarts** (19:04, 19:07, 20:17, 20:19, 20:27, 20:29, 20:32 UTC), each one
triggered by a deploy (multiple PRs — #1330 through #1335 — merged and
auto-deployed back to back during this active session). Every restart
interrupts in-flight tasks; `resumePendingTasks()` correctly re-fires them
(confirmed in logs — e.g. session `s-5496844108-1790281116568` was resumed at
20:19:31, 20:27:25, 20:29:48, and 20:32:42, i.e. on every single restart in that
window). The resume mechanism itself is fail-closed and audience-correct (see
above), but when restarts arrive faster than a resumed task can finish, the
user-visible effect is a progress message that appears to make no progress
across several silent hand-offs, compounding whatever the real per-edit failure
is. Flagging this for awareness; no code change proposed for it here since it's
a byproduct of legitimate rapid shipping, not a defect — worth revisiting only
if it keeps happening outside of active development bursts.

## Fix plan

### Fail-closed rule (already true for audience→token resolution; extend it to secret loading and to delivery attempts)

- An audience must never silently use another bot's token — **already enforced**
  by `deliverySecrets`/`taskDelivery`. No change needed here; this plan does not
  touch `src/bot-delivery.js`.
- Extend the same philosophy to secret **loading**: a missing/unfetchable secret
  must never look identical to "optional and intentionally unset" — the two need
  to be distinguishable in logs/monitoring, and a genuine fetch failure (network,
  IAM, NOT_FOUND) must be logged loudly, not folded into the same `null` as "not
  configured."
- Extend it to delivery **attempts**: a failed progress/status edit must never be
  a silent no-op. It must be logged (so an operator can grep it) and, ideally,
  self-heal by falling back to `sendMessage` after N consecutive failures on the
  same message — mirroring the existing terminal-message fallback pattern
  already used everywhere else in `runner/index.js`.

### Change 1 — make `progressEdit` failures visible (`src/runner/claude-runner.js`)

File: `src/runner/claude-runner.js`, function `progressEdit` (currently lines
296-305 inside `runEngineProcess`).

- Replace the blanket `.catch(() => {})` with a handler that:
  - Distinguishes the `{ok:false, flooded:true}` / `{ok:true, skipped:true}`
    **resolved** results (already-intentional drops — no change needed there)
    from a **thrown** error (a genuine non-429 failure) — those are two
    different code paths today (`tgEdit` resolves for flood/coalesce drops, but
    `throw`s for real failures per `tg-stream.js:195`/`203`).
  - On a thrown error: `console.error` it with enough context to grep
    (`taskId`, `chatId`, `msgId`, error message) — no token value, per this
    task's instruction not to print secrets.
  - Tracks a per-message consecutive-failure counter (in-memory, scoped to the
    `runEngineProcess` closure — no new global state needed) and, after a small
    threshold (e.g. 2-3, mirroring `MAX_STARVE_STREAK` in `tg-stream.js:38`),
    falls back to `tgSend` for a fresh message so the user gets *something*
    live instead of a frozen edit — same pattern already used for terminal
    messages throughout `runner/index.js` (e.g. lines 475-476, 1818-1819, etc.).
- This is a localized, low-risk change: it only touches the cosmetic heartbeat
  path: the terminal-message paths already do the right thing and are untouched.

### Change 2 — make secret-load failures visible and distinguishable (`src/secrets.js`)

File: `src/secrets.js`, `loadFromGcp()` (lines 5-32).

- When building the `Object.fromEntries(...)` result, also log a `console.error`
  (once, at boot) for every name in `results` whose `status === 'rejected'`,
  including `results[i].reason?.code` and `.message` — this alone would have
  surfaced `RECRUITER_BOT_TOKEN`'s `NOT_FOUND` on every single boot since
  whenever the secret disappeared, instead of it being invisible for however
  long it's been gone.
- Do this for **both** `REQUIRED` and `OPTIONAL` names — today a `REQUIRED`
  secret's failure surfaces (loudly) via the `throw new Error('Required secret
  missing: ...')` in `loadSecrets()` (line 59), but an `OPTIONAL` secret's
  failure is currently indistinguishable from "not configured, as designed" —
  both end up as `null` with no log line at all.
- Optional, not required for this fix: consider a lightweight periodic re-check
  (e.g. on next audience-scoped `/run` admission, if `deliverySecrets` throws
  "not configured" for an OPTIONAL bot token, attempt exactly one fresh
  `accessSecretVersion` call before giving up) so that a transient SM blip at
  boot self-heals without waiting for the next deploy/restart. This is a nice-to-have
  — the logging in the first bullet is the load-bearing fix, since restarts are
  frequent enough in this project (7 in 90 minutes observed) that the "wait for
  next restart" self-heal already mostly happens; what's missing is *knowing*
  it happened.

### Change 3 — restore `RECRUITER_BOT_TOKEN` in GCP Secret Manager (infra, not code)

Immediate operational fix, independent of the two code changes above:

```bash
echo -n '<the actual recruiter bot token>' | gcloud secrets create RECRUITER_BOT_TOKEN \
  --data-file=- --project=alesa-personal-assistent
# or, if the secret shell still exists but has no versions:
echo -n '<the actual recruiter bot token>' | gcloud secrets versions add RECRUITER_BOT_TOKEN \
  --data-file=- --project=alesa-personal-assistent
```

Then verify with the same one-liner used during this investigation:

```bash
ssh vova@136.65.7.197 "cd ~/trained-assist-agent && node -e \"require('./src/secrets').loadSecrets().then(s => console.log('RECRUITER_BOT_TOKEN =', s.RECRUITER_BOT_TOKEN ? s.RECRUITER_BOT_TOKEN.split(':')[0] : null))\""
```

should print the bot's numeric id, not `null`. This does not require a code
deploy, only an IAM-side action against Secret Manager, and can happen
independently of/before the code changes above.

### Deploy / verification steps for the code changes

1. Implement Change 1 and Change 2 on a fresh feature branch off `main` (not
   this docs branch — this branch is for the writeup only).
2. `npm run check` (syntax) + existing test suite; add/extend unit coverage for
   `progressEdit`'s new failure-visibility branch and for `loadFromGcp`'s new
   per-secret rejection logging (both are pure/mockable — no live GCP or
   Telegram calls needed to unit-test the branching logic).
3. `gh pr create --fill` → wait for CI green → auto-merge (repo policy: PRs are
   immutable, no direct pushes to `main`, no amending — see repo root
   `CLAUDE.md` → "Development workflow").
4. After deploy, confirm via `journalctl -u assist-agent -f` that a forced
   progress-edit failure (e.g. temporarily point `TELEGRAM_API_URL` at an
   unreachable host for a manual local repro, or wait for a natural transient
   Telegram hiccup) now produces a `console.error` line instead of silence.
5. Apply Change 3 (recreate `RECRUITER_BOT_TOKEN` in Secret Manager) and confirm
   with the one-liner above; then confirm a real `audience: 'recruiter'` `/run`
   call no longer 503s.
6. Re-run the `getChat` probe used in this investigation for both
   `-5496844108` and `1714048` to confirm nothing regressed.

## Evidence summary (for the GitHub Issue and future readers)

- `src/bot-delivery.js`, `src/runner/index.js:450-451,1268`,
  `src/server.js:1310-1311`, `src/server.js:287-308` — audience→token
  resolution is fail-closed by design (issue #1302); ruled out as the cause.
- `src/runner/claude-runner.js:294-305` — `progressEdit`'s blanket
  `.catch(() => {})` swallows all non-429 `tgEdit` failures; this is the
  primary fix target.
- `src/runner/tg-stream.js:138-204` — confirms `tgEdit` `throw`s on any non-429
  failure that isn't a "message is not modified" 400.
- `src/secrets.js:16-32` — `Promise.allSettled` in `loadFromGcp` discards
  per-secret rejection reasons; secrets loaded once at boot, never refreshed.
- Live on GCP VM (`136.65.7.197`, 2026-09-24): `RECRUITER_BOT_TOKEN` resolves
  to `null` on 5/5 repeated `loadSecrets()` calls; direct
  `accessSecretVersion` call confirms `NOT_FOUND: Secret ... not found or has
  no versions` in project `alesa-personal-assistent`.
- `infra/env-manifest.json` — `RECRUITER_BOT_TOKEN` / `FREELANCE_BOT_TOKEN` are
  `gcp_secret_manager_only`, not covered by `scripts/check-env-sync.js` or any
  CI workflow (confirmed zero grep matches in `ci.yml`, `deploy-manual.yml`,
  `check-env-sync.js`).
- `journalctl -u assist-agent` (GCP VM, 2026-09-24 19:00-20:33 UTC): 7 restarts,
  no "secret"/"error" log lines around secret loading at all (confirms zero
  existing visibility into secret-load outcomes), and repeated resumes of the
  same session across consecutive restarts (contributing operational factor).
- `getChat` probes (GCP VM, live): `-5496844108` has only the default bot as a
  member; `1714048` has both the default bot and the freelance bot as members —
  the one place a hypothetical cross-audience edit would fail with a non-429
  Telegram error rather than succeed silently, which is exactly the error class
  Change 1 makes visible.
- `trained-assist-tg-bot` `origin/main` (`src/lib/audience.js`, commit
  `2399807`, PR #235 "PR-A2 of #1302") and `wrangler.toml` `[env.freelance]` —
  confirms the gateway's audience resolution is already a complete 1:1
  Worker-env→audience model, not missing a per-chat mapping as originally
  hypothesized.
