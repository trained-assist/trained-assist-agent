# Retire speculative continuation (2026-09-24)

A completed final response must not authorize another paid run merely because an LLM
labels its text unfinished. The owner explicitly requested either a reliable launch
or no promise; removing speculative continuation also respects the earlier request
not to start while the user is still composing input.

Incident: at 10:04:19 UTC the runner appended a three-minute promise. At 10:05:40
another restored task for the same profile entered _runTask and silently cancelled
its profile-wide timer; the Telegram footer remained. Cancellation was keyed by
username, not session or chat. The classifier also treated a delivered change report
mentioning a separate unresolved problem as still_working.

The final delivery path no longer calls classifyTaskCompleteness, writes a timer
record, appends a promise, or schedules a speculative run. Restart migration only
edits outstanding legacy announcements and archives their records; it never fires
or re-arms them. Failed edits remain retryable at next boot. Already-cancelled
historical messages have no journal record, so cannot be enumerated by this migration.

Explicit continuation, recovery of interrupted processes, GTD, and intake quiet
periods retain their own paths. The plan-button classifier is a separate issue.

Tradeoff: when a normally completed response leaves work unfinished, this heuristic
no longer retries it. Durable task tracking or an explicit user continuation must
own that work. No extra LLM cost; the old classification request is removed.
Rollback: revert this PR and redeploy; archived records are not automatically revived.

Tests: tests/unit/soft-continuation-journal.test.js replaces the old journal CRUD
contract with retirement behavior (future/overdue, repeat boot, failures, corrupt
records). tests/runner-e2e.test.js executes final delivery with an optimistic LLM
stub and asserts there is no classification request, timer journal, or promise.
Both suites are mandatory in scripts/staging/suites.json.

The API contract test test/runner-index-contract.test.cjs now requires the startup
retirement entry point instead of the removed, unused clearPendingContinuation.
No callers remain for that cancelled-timer API.
