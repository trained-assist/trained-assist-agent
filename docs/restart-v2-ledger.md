# Current integration status (continuation #675)

The release worktree now makes SQLite the runner/recovery authority under closed
admission, stores terminal results before transport delivery, supports deadline
interruption and retains late HTTP arrivals after a forced claim. This supersedes
the preparatory implementation status in the historical sections below. Not yet
released: production remains on c3b347c. Do not merge this draft until all release
acceptance items are verified.

Validation: 593 Vitest tests, CJS and Python suites pass locally. Four isolated
real-server scenarios cover fresh resume, stale confirmation, forced
40-minute interruption, and implicit/explicit same-session serialization; the forced cycle also verifies durable acceptance between
claim and HTTP shutdown. Gateway: 282 tests. Separate web: authenticated worker and
Playwright suites pass. Current-head remote CI/staging still required.

Changed requirement and test replacement: in test/admission-status.test.cjs,
`restart restores queued work older than 15 minutes in acceptance order with deep/project binding`
asserted unconditional legacy recovery. The owner now requires >=5-minute work to
wait for confirmation. Replaced by test/restart-execution.test.cjs and
`stale HTTP queue survives boot, requires owner confirmation and preserves media`
in tests/planned-restart-http.test.js. No suite-wide skip or continue-on-error.

Remaining release risks: arbitrary model/MCP external actions do not yet use the
action ledger interface; the conservative policy for uncertain external effects awaits owner decision;
production bootstrap remains guarded. The real gateway confirmation adapter was
bundled and exercised against the restarted server in all four HTTP scenarios. Buffered media identity was verified
to include chat and message ID; independent messages do not share retention pins. These must not be described as exactly-once side effects or
fully verified retention. Production bootstrap remains subject to the active-work
guard. Rollback to the legacy unconditional resumer is prohibited once the v2
execution-authority marker exists; keep admission closed for operator recovery.

---

# Restart v2: durable intent ledger (issue #664)

This is a preparatory implementation, **not a v2 production rollout**. The existing
JSON pending journal and launch path remain authoritative until the coordinator,
runner, gateway and web confirmation routes are wired and jointly tested. Importing
`restart-intents` creates no database and starts no background work. Retention reads
an existing ledger without creating or migrating it.

## Contract

`createIntentStore(file)` uses the already installed better-sqlite3 dependency,
WAL, FULL synchronous durability and IMMEDIATE transactions. All concurrent
confirmation, cancellation and execution claims serialize at the database boundary.
Files are created mode 0600. A newer schema fails closed. No new polling/LLM cost.
The eventual file is `SYSTEM_ROOT/restart-intents.sqlite`.

- `enqueue` preserves the first payload, intent time and owner binding on retries.
  Completed/cancelled rows remain tombstones: duplicate receipt cannot revive work.
- Owner binding includes username, profile, Telegram user, chat, topic, project and
  session. Missing fields are rejected; absent fields must be explicit nulls.
  HTTP adapters must derive the owner from authenticated context, not client input.
- `evaluate` at readiness and `claim` immediately before execution apply strict
  age <300000ms. Unknown/future times are never considered fresh. `start` rechecks
  both the age and admission after a claim. A closed gate releases the claim to
  queued; an aged claim becomes waiting_confirmation.
- `confirm` atomically consumes the current random token and records confirmedAt
  separately from initiatedAt. Replay and stale tokens do nothing; owner mismatch
  fails. `cancel` uses the same token; only one decision can win. A later wait has a
  new token. Telegram callback payload should use a short opaque lookup identifier
  (do not concatenate the potentially 200-character task ID and UUID into 64 bytes).
- `recover(newBootId)` invalidates claimed/running work from the previous boot and
  marks it interrupted_by_restart. **Call only under exclusive external boot
  ownership after old workers are stopped.** This is not a heartbeat lease-stealer.
  Waiting and terminal records survive every boot.
- `beginAction` records an external-effect intent before execution; retry of the
  same action ID is denied. An unfinished action prevents claim/completion even
  after user confirmation. A trusted `reconcileAction` must record the observed
  external result. This is an integration interface, not a claim that existing
  arbitrary MCP/LLM side effects already use a ledger or are exactly-once.
- `importLegacy(records)` is atomic and idempotent, retains context/media and does
  not remove the original files. Legacy startedAt is not a reliable intent time:
  missing initiatedAt becomes null. A legacy running row becomes interrupted;
  replay of migration must not revoke a later confirmation or cancellation.

## Connected fixes

The existing media sweeper now retains intake-store fileRefs by profile as well as
copied attachment paths, and reads nonterminal intent payloads. Broken/unknown
ledger state stops deletion. Waiting files have no TTL until an explicit terminal
transition; disk usage can grow while users defer a decision. Gateway-only buffered
attachments still need their durable pin/ownership integration before enabling v2.

Runner activity captures the original session at enqueue and preserves it across
pending rewrites/recovery. Completion no longer follows a later mutable active
session pointer (including explicit absence of a session).

## Required integration before release

1. Choose one authoritative store at cutover. Under closed admission, import every
   legacy pending record, keep backup and preserve the existing maintenance ID and
   receipts. Do not dual-write two competing execution states. Runner, activity
   snapshots, bootstrap and media retention must agree on the authoritative source.
2. Journal all ingress before ACK, including attachments, immutable ownership/routing,
   and a stable request ID. Bind the actual execution session/project explicitly
   before showing confirmation; never use a later active pointer.
3. Recover boot ownership, evaluate every task before readiness, retain waiting
   records without occupying lane/slot leases, and claim immediately before launch.
   Finish after durable output delivery; shutdown must not complete/delete pending
   work through the current runner `finally` cleanup.
4. Add durable owner-bound notification receipts and authenticated list/confirm/cancel
   routes; wire real Telegram and web buttons. Confirmation must reuse task identity
   and payload, and queue while admission is closed. Clients cannot provide owner
   identity, confirmedAt or unrestricted launch payloads.
5. Wire fixed T0+40-minute deadline and controlled interruption only after the above;
   no extra 90-second grace or hidden retry during shutdown. Integrate external
   action reconciliation; user confirmation alone cannot establish idempotence.
6. Full isolated gateway/agent/restart/readiness/callback staging, then compatible
   release with green current-head CI/staging and live evidence. No rollback to the
   legacy unconditional resumer while v2 pending work exists: leave admission closed.

## Executable evidence

`test/restart-intents.test.cjs` covers 4:59/5:00/5:01, missing timestamps, lane aging,
closed admission, owner fields, stale/double callbacks, tombstones, repeated boots,
external-effect uncertainty, atomic migration and attachments. Two independent
Node processes race confirmation+claim; SIGKILL before/after SQLite commit checks
rollback and durable claims. Included in both normal CJS tests and mandatory staging.

`test/intake-media-retention.test.cjs` covers long-lived waiting media, isolation by
profile, cancellation releasing retention and corrupt ledger fail-closed behavior.
`test/restart-audience.test.cjs` checks immutable completion routing.

## Confirmation transports (continuation #670)

SQLite schema 2 adds a durable confirmation-event outbox and decision receipts.
UUID handles stay under Telegram's 64-byte callback limit (`ri:m:y:<uuid>` or
`ri:r:n:<uuid>`). The gateway uses the issuing VM, the callback's actual sender,
chat/topic and authenticated profile. It never reads a new task/project/session
from the button or a later selected session. No navigation TTL applies.

`restart-confirmation-http.js` exposes Telegram bearer, web cookie and trusted web
worker delegation adapters. `/web/restart-intents-bearer` accepts the authenticated
worker's profile, not a browser-supplied profile; the worker allowlists handle and
action. Server decisions preserve payload, owner and initiatedAt. Replaying an ACK
lost after commit returns the original decision without refreshing confirmedAt.

Notification receipts survive boot; session append and Telegram delivery retry
independently. Telegram ACK loss may duplicate a notice, never consume twice.
No LLM polling. Waiting files and event receipts continue using disk until resolved.

Both the vendored web UI and the separate trained-assist-web worker/UI implement
real confirm/cancel controls and error/retry states. Browser tests use isolated
storage and fake authentication; no second production server is started.

**Still preparatory:** existing JSON remains the execution authority. Routes and
notification polling create no ledger when absent. Confirm saves a queued decision;
it does NOT yet wake the legacy runner. Do not expose these controls in production
by populating the SQLite file before the single-authority runner/recovery cutover.
Deadline and forced shutdown remain disabled. The draft release must not merge until
that cutover, all-ingress/media/GTD checks and the full restart cycle are complete.

Validation: normal and mandatory staging include restart-intents,
restart-confirmations and restart-confirmation-http suites. The HTTP fixture tests
actual cookie/bearer auth across SIGKILL and a new process. Local browser smoke:
`node scripts/staging/restart-confirmation-browser.cjs`. Gateway tests exercise the
real callback adapter; the public web repository runs worker delegation and real
Playwright controls in both CI and mandatory staging.


Continuation #675: a regression experiment removed the lane fix and reproduced
two simultaneous child launches against one transcript; restoring the fix passes.
For the combined gateway/agent run, bundle the real gateway callback module with
esbuild --bundle --platform=node --format=esm, then set RESTART_GATEWAY_ADAPTER to
its absolute path when running tests/planned-restart-http.test.js. Only Telegram
transport is redirected to the isolated fixture; owner rejection, VM routing,
confirmation/replay and task execution use the real HTTP agent and gateway code.


## Main integration and test isolation (2026-09-16, #675)

Merged main bf92965, retaining the kernel execution-owner lock and R2 reader.
Legacy intake-store originals now follow main's stronger retention rule: no TTL
deletion until reference-aware retirement exists. Waiting tasks still retain their
materialized intake copies, scoped to the owner; cancellation releases those copies.
In test/intake-media-retention.test.cjs the old assertions that cancellation/pin
release deletes legacy originals were replaced by executable assertions that
originals survive and only unreferenced materialized copies expire. This follows
main #683; both modified tests and the full retention suite pass.

Vitest setup now assigns temporary system/user roots BEFORE imports, so tests do
not read the live maintenance gate or write fixture tasks into the production
queue. The previous full run was interrupted when this leak was discovered; its
fixture-only pending/activity records were quarantined reversibly in the task
workspace. A subsequent full run passed 593 Vitest tests plus CJS/Python checks;
mandatory local staging passed against merged code. Token-specific fixtures retain
their existing independent setup. Deployment rollback fixtures use main's isolated
lock-file override, never the live deployment mutex.

Release remains blocked on the unresolved external-effects recovery policy and
its implementation. The owner was asked whether an uncertain external action must
hold the task for result reconciliation even inside the five-minute fresh window.
No answer is assumed; forced restart must not be released ahead of this decision.
