#!/bin/sh
# Idempotently install the prod-box disk-hygiene crons.
#
# These scripts are the durable, version-controlled home of the disk safety net
# that was first built live on the box during the 2026-09-13 BrowserMetrics
# runaway incident (.pma telemetry filled 178G). Keeping them here + installing
# from deploy means a box reprovision re-creates them instead of silently
# dropping the guard.
#
#   disk-guard.sh        hourly   Tier1 age-guarded .pma reclaim + Tier2 emergency
#                                 reclaim when root fs crosses 85%.
#   dead-tenant-sweep.sh weekly   REPORT-ONLY tenant hygiene ledger (never deletes).
#
# Safe to run repeatedly: it rewrites only the block between the markers below,
# leaving any other user crontab entries untouched.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BEGIN="# >>> trained-assist disk-hygiene (managed by ops/cron/install.sh) >>>"
END="# <<< trained-assist disk-hygiene <<<"

chmod +x "$DIR/disk-guard.sh" "$DIR/dead-tenant-sweep.sh"

block() {
  echo "$BEGIN"
  echo "0 * * * * $DIR/disk-guard.sh"
  echo "30 6 * * 1 $DIR/dead-tenant-sweep.sh"
  echo "$END"
}

current=$(crontab -l 2>/dev/null || true)
# Strip (a) any existing managed block and (b) any legacy hand-installed line
# referencing these scripts by basename — so a box that was patched live before
# this was version-controlled migrates cleanly instead of running each cron twice.
stripped=$(printf '%s\n' "$current" | awk -v b="$BEGIN" -v e="$END" '
  $0==b {skip=1} skip && $0==e {skip=0; next} skip {next}
  /disk-guard\.sh/ {next} /dead-tenant-sweep\.sh/ {next}
  {print}')
{ printf '%s\n' "$stripped" | sed '/^$/d'; block; } | crontab -

echo "Installed disk-hygiene crons:"
crontab -l | sed -n "/$(printf '%s' "$BEGIN" | sed 's/[][\/.*^$]/\\&/g')/,/$(printf '%s' "$END" | sed 's/[][\/.*^$]/\\&/g')/p"
