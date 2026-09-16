# Session-scoped stop protocol

`/stop` fences the selected chat/session, journals accepted pending input, kills the engine process group (TERM, then KILL after two seconds), and prevents admission, timeout continuation, restart recovery and GTD reopening. Another chat using the same profile remains independent. `/skip` cancels only the running task and allows queued work. `/fresh` archives the held input and starts a new session without it.

The gateway calls the new `/tasks/control` endpoint: old agent versions return 404 rather than silently interpreting the request as a profile-wide kill. The legacy `/tasks/stop` endpoint now rejects requests without chatId. Stop increments a persisted epoch. Explicit resume must name that epoch; stale requests cannot undo a later stop. `/run` checks it before acceptance, and the runner rechecks after admission/preparation. Retained input is cleared only after the gateway confirms durable handoff. Intake attachments are copied into project artifacts before their 48h expiry; fresh preserves that archive. No credentials are journaled.

Validation: real runner with a local Telegram server and fake executable, two chats of one profile, queued admission, skip, persisted pause and process-group descendants; durable state/epoch/handoff and media-expiry tests; existing full suite. A dedicated staging-regressions CI job runs against the PR head, and automatic merge/deploy require success. This is an isolated real-runner harness, not a live production-server run.

Rollout: agent on both configured VMs first, then the companion gateway PR. Do not restart while any active session is older than 60 seconds or has unknown age. Draft status is intentional while that condition holds. Gateway deployment must also have its required staging checks green. Revert both PRs together if rollback is necessary; retained input files remain on disk.

Cost: small durable JSON journals and retained attachment copies, with no automatic archive eviction; bounded process-termination timers, no extra LLM calls. Archive cleanup is a separate user-visible retention decision.
