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

Goal: fix free-tier OpenCode model ladder — dead xiaomi/mimo-v2.5:free rung guaranteed-failed the first attempt of every /oc_free task, and the error classifier couldn't recognize model-unavailable/provider-overload errors to degrade the ladder (owner voice note 2026-09-23, asked "как сделать так, чтобы бесплатный никогда не умирал")

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1161
- [ ] Merged to main
- [ ] Deployed to prod — verified live (static config/JS files, live via systemd restart of assist-agent.service; no separate build step)
