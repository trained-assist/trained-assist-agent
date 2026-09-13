#!/bin/bash
# Idempotent installer for the box-hygiene crons that must survive a reimage.
#
# WHY THIS EXISTS: the disk-guard / dead-tenant-sweep scripts used to live only
# in /home/vova/*.sh with hand-edited crontab lines. That is a one-box fix — a
# fresh VM (or a wiped crontab) silently loses the disk safety net, which is
# exactly how the 2026-09-13 ENOSPC incident became possible. The scripts now
# live in the repo (ops/) and this installer wires the crontab from source on
# every deploy, so the guard is reproducible from GitHub, not from the box.
#
# Design: a single MANAGED BLOCK delimited by markers is rewritten each run.
# Any pre-existing lines that reference our scripts (including the superseded
# chrome-metrics-cap.sh) are stripped first, so re-running never duplicates and
# migration off the legacy hand-installed lines is automatic. User's own
# unrelated crontab lines are preserved untouched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OPS_DIR="$REPO_DIR/ops"

BEGIN='# >>> trained-assist managed crons (scripts/install-cron.sh) >>>'
END='# <<< trained-assist managed crons <<<'

DISK_GUARD="$OPS_DIR/disk-guard.sh"
DEAD_TENANT="$OPS_DIR/dead-tenant-sweep.sh"

if [ ! -x "$DISK_GUARD" ] || [ ! -x "$DEAD_TENANT" ]; then
  echo "==> ⚠️  install-cron: ops scripts missing/non-exec in $OPS_DIR — skipping"
  exit 0
fi

# Current crontab (empty if none), minus: our managed block, and any legacy
# lines referencing our script basenames or the superseded metrics-cap script.
current="$(crontab -l 2>/dev/null || true)"
cleaned="$(printf '%s\n' "$current" | awk -v b="$BEGIN" -v e="$END" '
  $0==b {skip=1; next}
  $0==e {skip=0; next}
  skip {next}
  /disk-guard\.sh/       {next}
  /dead-tenant-sweep\.sh/{next}
  /chrome-metrics-cap\.sh/{next}
  {print}
')"

# Rebuild: preserved lines, then a fresh managed block.
{
  # Strip trailing blank lines from the preserved section for tidiness.
  printf '%s\n' "$cleaned" | sed -e :a -e '/^\n*$/{$d;N;ba}' | sed '/^$/d'
  echo "$BEGIN"
  echo "# Tier1 hourly disk safety net + Tier2 emergency reclaim (see ops/disk-guard.sh)"
  echo "0 * * * * $DISK_GUARD"
  echo "# Weekly dead-tenant classification — REPORT ONLY, deletes nothing (see ops/dead-tenant-sweep.sh)"
  echo "30 6 * * 1 $DEAD_TENANT"
  echo "$END"
} | crontab -

echo "==> Managed crons installed (disk-guard hourly, dead-tenant-sweep weekly) from $OPS_DIR"
