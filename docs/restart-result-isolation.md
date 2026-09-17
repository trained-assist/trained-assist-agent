# Restart result recipient isolation

Presentation extras on a durable result must not override its saved owner,
Telegram topic, edit message ID, or text. The delivery adapter now allowlists
presentation options, including when replaying rows written by older code.
This also excludes Telegram alternate routing fields (inline message and
business connection IDs). Supported markup/formatting options remain available.

Three executable regressions in test/restart-results.test.cjs persist conflicting
extras, close the authority, reopen under a new boot, and check send, edit and
edit-to-send fallback. All three fail with the original delivery expression and
pass with the filter. They send only to an injected fake Telegram transport.

This is part of issue #675, not a release of restart v2. Generic engine external
effect interception/reconciliation and production acceptance remain blockers.
No extra services, schema changes or runtime dependencies. Rollback of this
filter is a git revert, but rollback of v2 authority as a whole still requires
the existing closed-admission guard against legacy automatic replay.
