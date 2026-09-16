# Planned restart protocol

The hidden `/restart` command is available to every logged-in profile. It closes
admission, waits for execution leases (including completion delivery), then an
external systemd timer claims the operation and restarts the service. Status and
cancel bypass admission. Cancellation is only safe before the claim; failed
recovery and claimed operations cannot be reopened by cancel.

Pending tasks and intake attachments are written before acknowledgement. The
same request identity is retained across retry and startup recovery, including
web chat ID 0, project, mode, and continuation metadata. Recovery registers all
accepted work without TTL expiry. Startup does not open a claimed gate: the
external coordinator confirms a different boot with completed recovery first.
For deployments it also checks the running revision against the checkout.

The gateway RunOutbox owns tasks during agent downtime. Attachments are chunked
in transactional Durable Object storage. It negotiates `durableIngress: 1`
BEFORE submitting to an agent, then requires a matching durable ACK. This avoids
repeated execution on an old agent during mixed-version rollout. Queue ordering
uses a durable sequence. 400/413/422 payload rejection retains failed payloads;
network, auth, and server errors retain retryable work. Stable Telegram/batch and
callback identities prevent replay after a lost outbox ACK. Completion receipts
remain stored (no automatic receipt compaction in this release).

CI/manual deployment holds a VM lock, drains before checkout mutation, stages
new dependencies while the old server remains up, and preserves old dependencies
for rollback without a network reinstall. A failure cannot print deployment
success. This adds DO storage/requests and retry traffic (15-second retry), disk
journals, and an external timer; it adds no LLM calls.

## Rollout constraint

This change is not a bootstrap installer for a legacy running process. The live
process must already understand `/maintenance` before the new CI deploy path
can drain it. First installation therefore requires a verified quiet maintenance
window; never merge expecting the old automatic deploy to install it safely.
Both repositories remain draft until that window and end-to-end validation.
Deploy the compatible agent and timer before switching production gateway
traffic to the outbox. Rolling back to pre-protocol code makes the new gateway
hold tasks, rather than repeatedly submitting to an incompatible agent.

The existing rule remains in force: an ordinary restart is postponed if any
active session is older than 60 seconds or its age is unknown. The planned
protocol is stricter and requires zero execution leases, regardless of age.

## Verification and limits

Tests exercise actual admission/recovery functions, /run handler with isolated
filesystem, runner subprocess fixtures, outbox persistence and lost ACK,
coordinator failures, and the real deploy shell with mocked OS commands.
Coverage includes corrupt state, disk-full media/journal/receipt writes, old
queued web tasks, FIFO ties, duplicate restart, cancellation, failed recovery,
coordinator interruption, incompatible agents, rollback dependency restoration,
and revision mismatch. No second production server or test user task is started.

These tests are not a production restart demonstration. A live end-to-end cycle
and real systemd/cloud failure injection remain release checks. Request
idempotency is not an exactly-once guarantee for arbitrary external tool effects
after an unrelated process crash. Permanent payload failures need operator
repair; failed readiness deliberately leaves admission closed. An interrupted
CI deployment after claim also needs recovery; the restart timer does not guess
which release a failed deployment intended to install.

Cloudflare documents the 30-second `blockConcurrencyWhile` timeout:
https://developers.cloudflare.com/durable-objects/api/state/
The outbox processes one delivery per alarm, with bounded HTTP timeouts, rather
than putting an unbounded batch of network requests inside that block.

## Initiator notifications

A user restart captures `{username, chatId, sessionId, threadId}` at request time.
Telegram chat identity and web session identity are distinct: multiple sessions
can share one chat. The captured session does not follow later active-session
changes. The authenticated gateway supplies the actual Telegram chat/topic;
web `/restart` creates a history session if necessary and never sends to chat 0.
Automation may pass the same object to POST `/maintenance` with action `request`.
Legacy string initiators (including unattended CI deploy) remain compatible but
have no recipient and cannot receive a user notification.

Phase transitions and notification outbox entries share one atomic journal
write. Claim attempts delivery before its HTTP acknowledgement; ready is only
announced after the new boot has completed recovery and the coordinator releases
the gate. Cancellation/failure also generate persisted outcomes. Startup and a
15-second timer retry unacknowledged deliveries. Session history deduplicates by
event ID; Telegram delivery is at least once, so a crash after Telegram accepts a
message but before the receipt is persisted can duplicate that message.

The external coordinator reports a systemctl/readiness failure. If the agent is
down it uses the same journal and delivery code outside the agent cgroup. If the
agent is running but HTTP cannot answer, it leaves a separate failure report for
the server, avoiding a competing writer to a live gate. A late failure cannot
turn a completed operation back into failed. If the entire VM is unavailable,
no local component can send a message until it returns.

No LLM calls or new cloud service are added. Costs are small disk journal writes,
Telegram calls, and retained delivery receipts (no automatic pruning yet).
Rollback is revert + redeploy; preserve the maintenance journal. Bootstrap from
legacy production still requires a quiet window and green revision-bound CI and
staging, as above. Local replay is not evidence of a production restart.

`test/restart-notifications.test.cjs` is mandatory in staging. It exercises the
real HTTP handler over a local socket, session storage, web runner command,
process reconstruction, network failure, event ordering, and recipient isolation.
`test/restart-coordinator.test.py::test_broken_recovery_remains_paused_without_restart_loop`
and `::test_failed_systemctl_does_not_open_gate` now expect durable `failed`
instead of silently remaining `restarting`: the changed requirement is an explicit
failure outcome for the initiating user. Both still assert admission stays closed.


## Updated rollout (2026-09-16)

`bootstrap-restart.py` is a one-time external installer, with a durable request
and a prebuilt immutable release. It waits for an empty legacy pending journal
and a service cgroup containing only the main process for at least 20 seconds.
It suspends the main process and checks both again before stopping the service.
Unknown state blocks installation. A task racing the freeze resumes the old
process instead of installing. systemd sends SIGCONT after SIGTERM as documented
in systemd.kill(5), allowing shutdown of the suspended idle server.

The installer preserves previous dependencies and commit for rollback, creates a
closed maintenance state, starts the new process, checks revision/recovery, then
enables the ordinary external coordinator. A failed installation is recorded and
is not blindly retried. A crash during installation requires operator recovery;
it must not be interpreted as success. Bootstrap backups are retained for review.

Mandatory staging now includes `tests/planned-restart-http.test.js`, using two
real isolated server boots, a local fake Telegram endpoint, and a fixture engine.
It checks queued ACK, claim, closed gate on startup, matching request deduplication,
explicit readiness, one execution and empty pending journal after delivery.
`test/deploy-safety.test.cjs` now provides DEPLOY_ENV and a stub nginx deployment,
matching the new environment-specific deploy contract; both rollback scenarios
remain executable. No test has been skipped or removed from this release.
Gateway live fake-user webhook probes are replaced with deterministic handler
scenarios and a Worker build; live health remains a deployment check.

First legacy installation uses the same addressing: pass a validated initiator
JSON file as the second argument to `schedule-bootstrap.sh TESTED_SHA FILE`.
The bootstrap coordinator sends the start message after the final idle check and
before stopping the old service, then reports readiness or rollback failure.
Its separate notification journal survives rollback; terminal timer ticks retry
undelivered outcomes. The external sender loads the normal secret provider
(including GCP Secret Manager); it never persists tokens in the operation file.
Existing requests without an initiator remain silent for compatibility and must
not be described as notification-enabled.

A newer, fully tested release can replace a bootstrap that is still `waiting`:
`schedule-bootstrap.sh TESTED_SHA INITIATOR_FILE --replace-waiting`. The shared
deploy lock protects preparation and replacement; installing/failed operations
are rejected. Existing initiator and original requestedAt are preserved. This is
an explicit release operation, never an automatic choice of an untested SHA.
