Goal: 3-tier intake confidence gate (clear/likely/insufficient) so auto-launch of проработка never silently force-launches on insufficient context, and gives a grace period on "likely" (owner voice note 2026-09-22)

- [ ] CI green on https://github.com/trained-assist/trained-assist-agent/pull/1139
- [ ] Merged to main
- [ ] Deployed to prod — verified live

Companion PR (merge/deploy AFTER this one — tg-bot calls this repo's /intake-gate endpoint and needs the new `level` field): https://github.com/trained-assist/trained-assist-tg-bot/pull/205
