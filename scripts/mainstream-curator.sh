#!/usr/bin/env bash
# Curator cron wrapper — runs the mainstream bug curator agent.
# Reads accumulated bugs from all mainstream test runs, groups them with LLM,
# creates GitHub issues for real bugs (deduped, intelligently grouped).
#
# Crontab entry: */20 * * * * /home/vova/trained-assist-agent/scripts/mainstream-curator.sh
set -euo pipefail

LOG_DIR="$HOME/agent-data/mainstream-curator"
mkdir -p "$LOG_DIR"

# Keep only last 50 curator log files
ls -t "$LOG_DIR"/curator-run-*.log 2>/dev/null | tail -n +51 | xargs -r rm -- || true

LOGFILE="$LOG_DIR/curator-run-$(date +%Y%m%d-%H%M%S).log"

{
  echo "[cron] mainstream curator started $(date)"

  set -a
  source "$HOME/secrets.env"
  set +a

  # Fetch OPENROUTER_API_KEY if not in secrets.env
  if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    OPENROUTER_API_KEY=$(GOOGLE_APPLICATION_CREDENTIALS="" gcloud secrets versions access latest \
      --secret=OPENROUTER_API_KEY --project=alesa-personal-assistent 2>/dev/null || true)
    export OPENROUTER_API_KEY
  fi

  # Fetch GITHUB_ISSUES_TOKEN if not in secrets.env
  if [[ -z "${GITHUB_ISSUES_TOKEN:-}" ]]; then
    GITHUB_ISSUES_TOKEN=$(GOOGLE_APPLICATION_CREDENTIALS="" gcloud secrets versions access latest \
      --secret=GITHUB_ISSUES_TOKEN --project=alesa-personal-assistent 2>/dev/null || true)
    export GITHUB_ISSUES_TOKEN
  fi

  cd "$HOME/trained-assist-agent"
  timeout 120 node src/mainstream-tester/curator.js

  echo "[cron] curator done $(date)"
} >> "$LOGFILE" 2>&1

echo "Curator log: $LOGFILE"
