# Operator recovery for uncertain external effects

An interrupted CLI or quick handler can have completed external actions before its
receipt was saved. User confirmation must not clear this uncertainty. The default
remains a hold, preserving the original context and media.

The host-only tool below permits a verified terminal report without re-running the
original prompt. It is not an HTTP endpoint or a user button and does not launch an
engine, call an external service, or deliver a message itself. Normal durable result
delivery sends the staged report to the original owner/session/topic.

1. Run `node scripts/reconcile-restart.cjs inspect /absolute/SYSTEM_ROOT/restart-intents.sqlite TASK_ID`
   on the instance that owns the task. Save the returned snapshot in a private file.
2. Check the saved transcript and actual external resources. Account for every
   uncertain action in the snapshot. If the outcome remains unknown, leave the task
   held; do not manufacture evidence. Partial work can be reported truthfully as a
   terminal interrupted result; any remaining work requires a new explicit request.
3. Write a mode-0600 JSON file containing `snapshot` exactly as inspected, `operator`
   (operator identity), `evidence` (specific observed receipts/resources and outcome),
   and `text` (the truthful terminal report for the task owner).
4. Run `node scripts/reconcile-restart.cjs settle /absolute/SYSTEM_ROOT/restart-intents.sqlite /private/request.json`.
   A stale snapshot, changed owner/state, cancellation or live execution is rejected.
   Reinspect and re-evaluate evidence after such a rejection. Exact retries return
   the same receipt, including after delivery and another boot.

The SQLite IMMEDIATE transaction checks the entire intent/action snapshot, marks
unknown actions reconciled and stages delivery atomically. It never transitions to
queued/running. Confirmation callbacks cannot revive the settled task. The tool
requires an existing DB, leaves maintenance/legacy queue untouched, and does not
create an execution authority or perform boot recovery. Run from the deployed v2
checkout, never against legacy production as a way to enable v2.

The operator is a trusted principal with host filesystem access. Evidence is an
auditable attestation, not automated proof of remote state. Misstating an external
outcome is still possible; automatic replay remains prohibited. No new LLM polling
or recurring cost. Stored evidence and retained attachments use disk space.

Executable coverage: `test/restart-settlement.test.cjs`, included in normal and
mandatory staging gates; wrong owner/stale snapshot/cancel, repeated boot, ACK-loss
retry, terminal tombstones and a separate CLI process are covered. Existing engine,
quick-handler, forced-deadline and transport integration tests remain required.
