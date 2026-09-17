# Maintenance recovery and deployment revisions

A different boot ID is necessary but insufficient proof of deploy completion.
Deploy requests persist a full targetCommit and previousCommit. The server captures
its full revision once at startup. After pending-task recovery, ready() opens admission
only on a different boot and the exact journal target. Unknown, short, mismatched,
and missing revisions stay closed. The external timer applies the same checks and
never restarts a deploy operation. Ordinary restarts auto-complete after recovery.

Explicit rollback preserves targetCommit, records rollbackCommit and reports
rolled_back separately from deployed. A running service must authorize rollback
before stopping; a ready service cannot be rolled back by a stale deploy caller.
If the service already stopped, the offline journal validator permits only a claimed
or failed deploy. Dependencies are restored from the saved directory.

First upgrade from protocol 1: the old server ignores HTTP target fields. After
claim and systemctl stop, prepare-deploy-journal.py atomically adds target metadata,
then the new process starts. The writer refuses a running service, another target,
a restart operation, or an unclaimed drain. It retains operation ID and notifications.
A crash before this step leaves admission closed; it cannot manufacture success.

CI passes the fetched commit before changing the checkout and executes the new drain
client. Local changes block deployment before drain/reset to preserve ongoing work.

Changed executable tests:
- tests/planned-restart-http.test.js previously required a manual ready call after
  reboot. That contradicts automatic recovery. Replaced with three real HTTP/process
  scenarios: ordinary restart, exact deployment target, wrong deployment target.
  Successful recovery executes the accepted task exactly once; wrong revision
  retains it on disk and cannot be bypassed by POST ready.
- test/deploy-safety.test.cjs previously forbade an explicit stop after dependency
  download failure. Journal migration/rollback now requires a stopped service.
  Replacement verifies preserved dependencies and stop-before-journal-update order.
- test/maintenance.test.cjs covers same boot, incomplete recovery, exact/full/unknown
  revisions, legacy journals, conflicting targets, and explicit rollback.
- Python coordinator and offline migration suites cover the equivalent external paths.

Required validation: npm test, npm run test:staging, npm run check,
node scripts/check-env-sync.js. No required check is skipped or allowed to fail.
