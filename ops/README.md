# ops/ — box-hygiene crons (reproducible from source)

These scripts are the systemic disk/tenant safety net for the prod VMs. They
used to live only as `/home/vova/*.sh` with hand-edited crontab lines — a
one-box fix that a reimage or a wiped crontab would silently lose. That gap is
what made the 2026-09-13 ENOSPC incident (Chrome `BrowserMetrics/*.pma` filled
178G) possible. They now live in the repo and are installed from source on every
deploy.

## Scripts

- **`disk-guard.sh`** (hourly) — supersedes the old `chrome-metrics-cap.sh`.
  - _Tier 1 (always):_ reclaim throwaway Chrome telemetry (`*.pma`) older than
    120 min, so a live browser's current file is never touched.
  - _Tier 2 (emergency, root fs ≥ 85%):_ reclaim the same throwaway classes
    ignoring age — a full disk breaks every command on the box.
  - Only ever touches known-throwaway paths (UMA `.pma`, Crashpad dumps,
    GPU/shader caches). Never tenant data, session stores, or profile prefs.
- **`dead-tenant-sweep.sh`** (weekly, Mon 06:30) — **REPORT ONLY, deletes
  nothing.** Classifies tenants (junk / stale / ambiguous / live) and appends a
  timestamped block to `/home/vova/dead-tenant-report.txt`. Actual archival is a
  separate, human/LLM-adjudicated step (see the report's footer for the
  reversible `tar`-then-`rm` recipe).

## Install / lifecycle

`scripts/install-cron.sh` writes a single marker-delimited managed block into
the `vova` crontab, pointing at these repo copies. It is idempotent, strips any
legacy hand-installed lines (including `chrome-metrics-cap.sh`), and preserves
unrelated crontab entries. `scripts/deploy.sh` invokes it on every deploy, so
the crontab is rebuilt from `origin/main` — reproducible from GitHub, not from
the box.

Logs: `/home/vova/disk-guard.log`, `/home/vova/dead-tenant-report.txt`.
