#!/usr/bin/env bash
# Cron wrapper — runs one bugs-collector scan across all profiles.
# Crontab entry: 0 */6 * * * /home/vova/trained-assist-agent/scripts/bugs-collector-cron.sh
# STUB (issue #1120): read-only, logs open reports. No dedup/triage/mark-processed yet.
set -euo pipefail

LOG_DIR="$HOME/agent-data/bugs-collector-logs"
mkdir -p "$LOG_DIR"

# Keep only last 30 log files
ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +31 | xargs -r rm --

LOGFILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"

{
  echo "[cron] bugs-collector started $(date)"
  cd "$HOME/trained-assist-agent"
  node src/bugs-collector.js
  echo "[cron] done $(date)"
} >> "$LOGFILE" 2>&1
