Goal: 3-tier intake confidence gate (clear/likely/insufficient) so auto-launch of проработка never silently force-launches on insufficient context, and gives a grace period on "likely" (owner voice note 2026-09-22)

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1139
- [x] Merged to main
- [x] Deployed to prod — verified via deploy-gcp/deploy-ru check-runs (success) on merge commit dfa2c31

Companion PR (merge/deploy AFTER this one — tg-bot calls this repo's /intake-gate endpoint and needs the new `level` field): https://github.com/trained-assist/trained-assist-tg-bot/pull/205 — status not re-checked here, verify separately.

Goal: add /oc_ds_or (/oc_deepseek_openrouter) and /oc_ds_go (/oc_deepseek_go) — per-profile pin to a concrete deepseek gateway, independent of the VM-wide /oc_go//oc_openrouter toggle

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1157
- [x] Merged to main
- [x] Deployed to prod — verified via deploy-gcp/deploy-ru check-runs (success) on merge commit dc48883

Goal: persist OpenCode per-step usage breakdown (agent/model/cache/cost per step) to usage.json — was computed but discarded after the chat footer, blocking future cost drill-down

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1159
- [x] Merged to main (PR #1160 tracked this to closure via GTD controller, also merged — main HEAD is 6232e18)
- [x] Deployed to prod — verified via deploy-gcp/deploy-ru check-runs (success, 2026-09-23T08:08:53Z) on merge commit
- [ ] Live data check pending: no usage.json on disk yet has a `breakdown` field — no OpenCode session has run since the 08:08:53Z deploy. Will confirm on the next real OpenCode run (per-step breakdown array in usage.json entries).

Goal: add a paid last-resort rung to every /oc_free role ladder — every rung ended in :free, so a retry storm where all free rungs are simultaneously rate-limited/dead had nowhere to fall back to (owner voice note 2026-09-23, follow-up ask "предложим все-таки не бесплатную, а платную недорогую модель")

- [x] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1163
- [x] Merged to main
- [x] Deployed to prod — verified via deploy-gcp/deploy-ru check-runs (success) on merge commit 79ce9e7

Goal: fix free-tier OpenCode model ladder — dead xiaomi/mimo-v2.5:free rung guaranteed-failed the first attempt of every /oc_free task, and the error classifier couldn't recognize model-unavailable/provider-overload errors to degrade the ladder (owner voice note 2026-09-23, asked "как сделать так, чтобы бесплатный никогда не умирал"). Originally PR #1161 — conflicted with #1163 (merged first, same free.json lines), went mergeable_state:dirty with failing CI; rebased cleanly onto main as PR #1164 (branch-immutability hook blocks pushing directly to a branch with an open PR, so #1161 was closed as superseded rather than force-pushed). #1164's CI then caught a stale test (`test/pin-context-card.test.cjs` hardcoded the old top rung `mimo-v2.5` in a regex, which the fix correctly removed) — same immutability hook blocked pushing the test fix to #1164, so it was closed as superseded and re-opened as PR #1166 with the fix included.

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1166
- [ ] Merged to main
- [ ] Deployed to prod — verified live (static config/JS files, live via systemd restart of assist-agent.service; no separate build step)

Unrelated, non-blocking finding while investigating #1164's CI: the `autofix` check-run fails on every PR in this repo (curl 404 fetching `pr-autofix`'s `scripts/autofix.mjs` at `refs/pull/<N>/merge` — that ref only exists in trained-assist-agent, not in the pr-autofix repo it's fetched from). Not a required status check (branch protection only requires `ci` + `staging-gate`), so it doesn't block merges — but it means autofix has likely never run successfully on this repo. Worth a follow-up issue if the `autofix` job is meant to do anything; not fixed here (out of scope for the ladder fix).

Goal: revert the "durable last-failure ledger" (recordLastFailure/readAndClearLastFailure + runner hooks + test) that squash-merged into main as part of PR #1172 alongside an unrelated, kept, tool-progress fix — owner voice decision 2026-09-23: catching/recording crashes and re-injecting them into the next run needs an architecture pass (fragile bespoke file+schema, unclear split between "explicit retryable error" (agent's job) vs "session went silent" (supervising runner's job, not agent's)) *before* it ships, and it shipped (merged + deployed to prod 2026-09-23T11:36:42Z) before that review happened.

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1173
- [ ] Merged to main
- [ ] Deployed to prod — verified via deploy-gcp/deploy-ru check-runs (success) on merge commit

Goal: /run accepts chatId as alias for userId — P1-A of naming-conventions refactor (issue #1177, plan generic-naming-conventions-refactoring/plan.md §4). userId in /run has always meant the Telegram chat to stream into, not a user identity; chatId is the forward-looking wire name for that same value. Dual-accept only (chatId wins if both sent), no behavior change for callers still sending only userId. Next steps after this lands: tg-bot starts sending chatId too (PR-B), observation period, then flip canonical field.

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1178
- [ ] Merged to main
- [ ] Deployed to prod — verified via deploy-gcp/deploy-ru check-runs (success) on merge commit
- [ ] Live smoke-check: /run still accepts old-style `userId`-only calls unchanged, and a `chatId`-only call is accepted too

Goal: wire failure-classifier.js/execution-history.js into runner/index.js's crash/retry maze — Phase A, observational only, no control-flow change (issue #1175 follow-up to #1179, owner voice note 2026-09-23 "подключаем с тобой мозг"). Every crash/retry branch (quick-crash, resume-after-restart, opencode ladder/quota/context/config, deepseek go-toggle, auth fallback, generic incomplete retry, timeout auto-continuation, user-stop) now classifies its error text and records a Failure Event via a new executionId threaded through every recursive runTask() retry, finalized at each real terminal point — but none of them changed which action they take; recovery-policy.js is deliberately NOT wired into any decision yet (separate, later PR once this phase has run against real traffic — the #1172/#1173 lesson: this hot path doesn't get a second unreviewed behavioral change).

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1181
- [ ] Merged to main
- [ ] Deployed to prod — verified via deploy-gcp/deploy-ru check-runs (success) on merge commit
- [ ] Live smoke-check: after a real production crash/retry (any engine), `~/agent-data/execution-history/<executionId>.json` exists with at least one recorded attempt and a non-null failureClass

Goal: fix ⛔ Стоп/➕ Дополнить buttons silently never appearing on a running-task progress message after one dropped Telegram edit (owner live-tested trained-assist-tg-bot#216/trained-assist-agent#1185 in Telegram, button never showed up despite waiting well past the 5s threshold; root cause confirmed via journalctl 429s on editMessageText during that exact session — stopButtonShown flipped before the edit was confirmed delivered, so a 429/coalesce drop permanently hid both buttons with no retry)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1189
- [ ] Merged to main
- [ ] Deployed to prod — verified live (static JS, systemd restart of assist-agent.service; no separate build step)
- [ ] Live Telegram verification (see "How to test ⛔/➕ buttons live in Telegram" below) — send a task that runs >8s, confirm the button row appears and survives a busy multi-session window (no silent drop)

## How to test ⛔ Стоп/➕ Дополнить buttons live in Telegram

The button JSON itself is never logged — `tgEdit` (src/runner/tg-stream.js) only
`console.warn`s on a 429, it doesn't log the payload. So "tail the tg-bot
Cloudflare Worker" (`wrangler tail`) does NOT show this — that worker only sees
inbound webhook updates and callback-query taps (i.e. what happens *after* a
button is tapped), not the agent's outbound editMessageText calls, which go
straight from the GCP VM to the Telegram Bot API and bypass the worker
entirely.

Correct procedure:
1. Send a task in Telegram that takes noticeably longer than 5s to respond
   (STOP_BUTTON_AFTER_SECS) — a real проработка/deep task, not a one-liner
   echo. Quick tasks finish before the button-eligibility gate and legitimately
   never show buttons — that's not a bug.
2. Watch the progress bubble in the Telegram app itself — after ~5-8s it
   should switch from a plain "🧠 Думаю…" edit to one with an inline row:
   ⛔ Стоп next to ➕ Дополнить.
3. To confirm delivery (not just eyeball it) or diagnose a no-show, tail the
   *agent's* systemd journal (this is on the GCP VM, not the tg-bot worker):
   `sudo journalctl -u assist-agent.service -f | grep -iE "429|editMessageText"`
   — a `[tg] 429 rate limit on editMessageText` line around the same time the
   button should have appeared means the edit got dropped that tick (pre-fix:
   permanent; post-fix: retries next tick 3s later).
4. To test the ➕ Дополнить round-trip once the button is visible: tap it in
   Telegram, confirm the bot replies "✏️ Напиши, что добавить", then send a
   plain-text message — the bot should reply "➕ Останавливаю и перезапускаю
   с дополнением…" and the original task restarts with that text folded in.
   Tapping ⛔ Стоп instead should just kill the task as before (unchanged
   behavior).
5. `wrangler tail` on trained-assist-tg-bot IS the right tool for step 4's
   *tap* (verifies the `sup|{taskId}` callback_data round-trips and
   `session.pendingSupplement` gets armed) — just not for step 2/3's button
   *rendering*, which is agent-side only.

Goal: stop duplicate token-save Telegram notices — a real group got flooded with byte-identical «✅ Данные для Github сохранены…» from automated/retried `POST /tokens` saves (testuser-* profiles whose `.chatid` pointed at the group); also fix broken token-path test isolation (`runner/index.js` hardcoded `~/agent-tokens`, `data-paths.js` ignored `AGENT_TOKENS_ROOT` → 12,549 test profiles leaked into prod). Adds `src/tg-notice-dedupe.js` (suppress identical notice to same chat within 10 min) + resolves token/`.chatid` paths via data-paths `TOKENS_ROOT`.

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1248
- [ ] Merged to main
- [ ] Deployed to prod — verified live (no more than one identical notice per chat per 10 min)

Goal: Не замораживать счётчик «Думаю… (Nс)» на 429 editMessageText — каденция 1-2-5-10-15→15с, flood-gate по retry_after, кап 60с.

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1282
- [ ] Merged to main
- [ ] Deployed to prod — verified live
