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
