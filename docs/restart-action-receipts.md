# Restart v2 action receipt invariants

A durable action ID identifies one persisted request. Reusing it for a different
recipient or payload now fails; equivalent object property order still replays the
original receipt. Missing request/receipt values fail before changing the ledger.

Unresolved actions prevent both staging a final result and completing result
delivery. The delivery adapter checks before any external send, including for a
persisted delivering row from the previous implementation. Such a row and its media
remain retained for reconciliation; a misleading success notification is not sent.

Executable regression: test/restart-intents.test.cjs (four new scenarios). The first
three failed before the fix. Existing tests are preserved. Includes database reopen,
boot recovery, changed request identity, media retention and zero-send assertions.

This only hardens the existing action ledger. Engine-side pre-execution barriers
and external reconciliation are still NOT integrated. Therefore this PR must remain
draft; it is not sufficient to release forced restart v2. No production changes.
