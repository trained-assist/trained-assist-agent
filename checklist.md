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
