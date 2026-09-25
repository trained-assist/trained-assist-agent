# Core 01 — Channel concurrency

Normative rule: `docs/architecture/channel-execution-concurrency.md` (epic #1365).
Automated tests must use a fake engine with barriers/latches and observe active
intervals (not sleeps, not an LLM judge), go through real entrypoints/admission, and
fix capacity high enough; resource wait is tested separately (CH-11).

Status legend: `contract` = covered by `test/core-contracts.test.cjs` at the
contract level only; `planned` = runtime test lands in the named slice.

| ID | Story → value | Validation (machine-checkable) | Does NOT forbid | Status |
| --- | --- | --- | --- | --- |
| CH-01 | One TG dialog, runs A and B in different sessions → one clear control stream | max active interactive executions = 1; B queued; A keeps output/Stop/Дополнить; new session does not bypass lane | keeping many sessions in the chat | contract (lane key); runtime PR2 |
| CH-02 | Different TG chats, same profile+project+workDir → independent work | capacity ≥2 ⇒ both running with overlapping intervals; no profile/folder mutex | — | planned PR2 |
| CH-03 | Five Web sessions, same profile+folder → separate tabs | capacity ≥5 ⇒ all five running concurrently; outputs/Stop separate; queued-only success does not count | — | contract (no web lane); runtime PR3 |
| CH-04 | Web + TG, different sessions, same profile/project | overlapping intervals; Stop of one does not touch the other | — | planned PR3 |
| CH-05 | Two tabs / Web+TG on the SAME session → intact history | one writer; second request stored and visibly waits; other sessions not blocked | reading the session from both | contract (session scope); runtime PR2 |
| CH-06 | Bot endpoints and forum topics → preserved isolation (tg-bot#255) | one run per topic/endpoint; topics independent; DMs/non-forum chats keep the rule | parallel topics | contract (key includes endpoint+thread); runtime PR4 |
| CH-07 | Group, two actors → clear ownership, no race | actor ≠ principal; one lane per dialog regardless of actor/profile; unconfirmed binding does not run | — | contract (lane ignores actor/profile); runtime PR4 |
| CH-08 | Queue + Stop + restart + retry/GTD → no lost or doubled task | stable request/session/project/reply/lane across old→new and rollback; clearChat/timeout never release a second owner | — | planned PR1c/PR2 |
| CH-09 | Web continues a TG session → no invisible context switch | TG pointer unchanged; marker + choice on return to TG; files only to Web replyToRef; ACL | Web continuation itself | planned PR3 |
| CH-10 | New session/project choice while input is accepted+queued | message stays with its pinned target; ambiguous input stays intake; supplements never become a second run | — | planned PR2/PR6 |
| CH-11 | Resource queue and shared-file conflict | capacity wait is explicit; tasks start after release; one resource conflict does not stop the whole profile/project | — | planned PR2 |
