#!/usr/bin/env bash
# Cron wrapper — loads secrets and runs one mainstream test cycle.
# Crontab entry: 0 */4 * * * /home/vova/trained-assist-agent/scripts/mainstream-cron.sh
set -euo pipefail

LOG_DIR="$HOME/agent-data/mainstream-logs"
mkdir -p "$LOG_DIR"

# Keep only last 30 log files (|| true — glob may fail if no files yet)
ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +31 | xargs -r rm -- || true

LOGFILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"

{
  echo "[cron] mainstream test started $(date)"

  set -a
  source "$HOME/secrets.env"
  set +a

  ANTHROPIC_API_KEY=$(GOOGLE_APPLICATION_CREDENTIALS="" gcloud secrets versions access latest \
    --secret=ANTHROPIC_API_KEY --project=alesa-personal-assistent 2>/dev/null)
  export ANTHROPIC_API_KEY
  # GITHUB_ISSUES_TOKEN for bug-classifier issue creation (optional — skip if not in secrets.env)
  if [[ -z "${GITHUB_ISSUES_TOKEN:-}" ]]; then
    GITHUB_ISSUES_TOKEN=$(GOOGLE_APPLICATION_CREDENTIALS="" gcloud secrets versions access latest \
      --secret=GITHUB_ISSUES_TOKEN --project=alesa-personal-assistent 2>/dev/null || true)
    export GITHUB_ISSUES_TOKEN
  fi
  export SECRETS_SOURCE=env

  cd "$HOME/trained-assist-agent"
  MAINSTREAM_STEPS=7 MAINSTREAM_RUNS=1 \
    timeout 900 node src/mainstream-tester/index.js

  echo "[cron] done $(date)"
} >> "$LOGFILE" 2>&1

# Summarize bug count
LATEST_BUGS=$(ls -t "$HOME"/agent-data/mainstream-test-*/bugs.jsonl 2>/dev/null | head -1)
if [[ -f "$LATEST_BUGS" ]]; then
  BUG_COUNT=$(wc -l < "$LATEST_BUGS")
  echo "[cron] bugs in last run: $BUG_COUNT → $LATEST_BUGS" >> "$LOGFILE"
fi
