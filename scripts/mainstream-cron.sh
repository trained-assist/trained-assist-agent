#!/usr/bin/env bash
# Cron wrapper — loads secrets and runs one mainstream test cycle.
# Crontab entry: 0 */4 * * * /home/vova/trained-assist-agent/scripts/mainstream-cron.sh
set -euo pipefail

LOG_DIR="$HOME/agent-data/mainstream-logs"
mkdir -p "$LOG_DIR"

# Keep only last 30 log files
ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +31 | xargs -r rm --

LOGFILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"

{
  echo "[cron] mainstream test started $(date)"

  set -a
  source "$HOME/secrets.env"
  set +a

  ANTHROPIC_API_KEY=$(GOOGLE_APPLICATION_CREDENTIALS="" gcloud secrets versions access latest \
    --secret=ANTHROPIC_API_KEY --project=alesa-personal-assistent 2>/dev/null)
  export ANTHROPIC_API_KEY
  export SECRETS_SOURCE=env

  cd "$HOME/trained-assist-agent"
  MAINSTREAM_STEPS=7 MAINSTREAM_RUNS=1 \
    timeout 900 node src/mainstream-tester/index.js

  echo "[cron] done $(date)"
} >> "$LOGFILE" 2>&1

# Summarize accumulated bug count (durable cross-run log, not per-invocation dir)
GLOBAL_BUGS="$HOME/agent-data/mainstream-test/bugs.jsonl"
if [[ -f "$GLOBAL_BUGS" ]]; then
  BUG_COUNT=$(wc -l < "$GLOBAL_BUGS")
  echo "[cron] total accumulated bugs: $BUG_COUNT → $GLOBAL_BUGS" >> "$LOGFILE"
fi
