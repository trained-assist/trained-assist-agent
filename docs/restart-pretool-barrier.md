# Durable pre-spawn barrier (#675)

Before launching either Claude or Codex, the runner writes a FULL-synchronous
SQLite action with the current execution claim. A failed write prevents spawn.
Stdout tool events cannot provide this guarantee: an external action may have
already happened before stdout arrives.

Only an explicit successful engine terminal event with a nonempty answer commits
the engine receipt and durable deliverable result in one transaction. Invalid
results roll back the receipt. Delivery can then retry without launching the CLI.
Crash, deadline interruption, timeout and early exit leave the action unresolved.
Normal internal timeout continuation and quick-crash retry cannot bypass it.
Partial timeout progress remains in the session. Confirmation alone never clears
uncertainty; the existing trusted reconcileAction interface requires evidence of
the observed outcome. This does not implement per-tool exactly-once semantics.

Operational cost: interrupted read-only runs are also held; an operator must
reconcile before resumption. Automatic continuation is deliberately unavailable
while effects are unknown. Production acceptance remains open until safe operator
reconciliation and the full live lifecycle have been verified.

Changed test requirement: tests/planned-restart-http.test.js, the forced deadline
scenario previously expected confirmation to rerun an interrupted child. It now
asserts the child runs exactly once, media is retained and no success is sent;
confirmation cannot prove the prior effects safe to repeat. Fresh/stale requests
that never launched retain normal confirmation behavior. New real-process tests
cover SIGKILL plus two boots and confirmation for both engines, quick failures for
both engines, and successful Codex terminal completion. Existing suite preserved.
