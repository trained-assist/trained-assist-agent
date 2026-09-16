# Session recovery after process/server failure

An unexpected exit 143 or early process crash gets at most two visible retries. Retry calls the internal executor inside the current session lane; awaiting the public queue previously deadlocked behind the task that was waiting for it. Real SIGTERM is normalized to 143. Explicit user stop remains outside automatic recovery.

Before starting the child, the journal stores the resolved session and project. Atomic replacement prevents partial JSON. On shutdown, retry intent is persisted and kept after lane cleanup. Startup reuses the same task ID and retry budget; queued work does not spend a retry twice. Accepted work is no longer silently deleted because it is older than 15 minutes. Web chat ID 0 is valid. Exhausted retries produce an explicit reason and session-history entry; if the terminal notification fails, its pending record stays for the next startup.

The gateway separately owns downtime dispatch recovery (tg-bot PR #111). Server acceptance does not mean model completion. The gateway does not need this agent deployment to improve dispatch visibility.

Validation: runner E2E launches an isolated fake executable, deliberately exits/crashes by signal, checks exact launch counts, preserved session, final Telegram output and deferred shutdown journal. recovery-resume.test.js covers old records, crash budgets, queued handoff, failed terminal delivery and userId=0. The admission-status restart test now loads the extracted recovery module rather than stubbing every require with the runner mock; its FIFO/deep/project assertions are unchanged. Existing one-retry expectations were updated to the owner's requested two attempts. No tests were skipped.

Recovery staging is a deterministic isolated process replay, not a deployment of the full server. The workflow checks out the PR head and stores its SHA and executable scenario report; skips/todos/empty runs fail. Before production merge also require ordinary CI and obey the owner restart rule on both VMs: defer when any active session is older than 60 seconds or its age cannot be established.

Costs: up to two extra model runs for recoverable crashes; journal/session disk writes, no new classifier calls. Application operations performed before a crash can still need task-level idempotency. Rollback is a code revert/redeploy; keep pending journals.
