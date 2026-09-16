# Restart v2 — implementation checkpoint (issue #664)

This is a partial implementation, not a production release. Keep the PR draft until the full acceptance contract in issue #664 is met.

## Implemented in this checkpoint

- Durable activity journal for accepted requests and completed runner tasks. Running tasks count even with an unknown/old timestamp. Legacy session history bridges the first upgrade; restart notices do not refresh activity.
- Inclusive 15-minute recipient snapshot at operation creation; immutable original routes and channel-level deduplication (one Telegram notice per profile/chat/topic, separate receipts for original transcripts).
- Durable start/phase/result events for the snapshot, late arrivals, per-recipient failure isolation and retry receipts across processes. Existing maintenance operations retain their IDs, initiator, queue and receipts.
- Agent-side `initiatedAt` survives running-state rewrites, retry/continuation propagation and recovery; unknown age remains unknown. Gateway receipt time still needs transmission, so age is not yet enforced end-to-end. Topic metadata accepted by `/run` and retained by the task journal.
- New boundary, isolation, migration, two-process receipt and timestamp tests required by CI and deterministic staging. Existing admission tests retain their assertions; their isolated harness now supplies the new activity dependency.

## Not yet implemented — do not merge/deploy as the finished v2

- Gateway activity at intake/quick-command time and topic propagation through ALL run/outbox paths. Current gateway only sends topic to `/maintenance`, not normal `/run`. Web/buffered activity coverage still needs end-to-end validation. Therefore top-level checklist item 1 is not complete yet.
- A nonmoving 40-minute deadline, forced interruption journal, suppression of retry while shutting down, and revision/readiness verification for the complete v2 lifecycle.
- Age check at readiness AND immediately before execution; waiting_confirmation with attachment retention and no resurrection of completed/cancelled work.
- Owner-bound atomic confirmation/cancellation endpoint, real Telegram and web controls, GTD/cron admission audit.
- Full isolated gateway→agent→restart→confirmation integration, green current-head CI/staging for both sides, compatible production rollout, live smoke and rollback evidence.

## Review constraints

Activity journal contains routing and timestamps only, not task contents. It is local per configured instance data/users roots. Writes use fsync+rename, with one per-process writer like the existing maintenance journal. New event IDs are channel-specific; old IDs remain untouched. Telegram transport remains at-least-once (ACK loss can cause a repeated notice, never a repeated task from this module). Activity records currently accumulate per route/session; bounded retention/compaction remains to be designed without dropping the upgrade bridge.

Never roll back a future waiting_confirmation release to an auto-resuming binary with admission open. This checkpoint does not introduce that task state. Do not run a second full server against production storage.
