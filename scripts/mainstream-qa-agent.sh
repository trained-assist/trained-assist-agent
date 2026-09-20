#!/usr/bin/env bash
# QA Agent — Claude Code session that picks and executes the most impactful QA action.
# Each run: reads all accumulated bugs + GitHub state, acts on highest priority item.
# Replaces curator.js — Claude has full judgment + tools (gh CLI, git, file system).
#
# Crontab: */20 * * * * /home/vova/trained-assist-agent/scripts/mainstream-qa-agent.sh
set -euo pipefail

LOG_DIR="$HOME/agent-data/mainstream-qa-logs"
mkdir -p "$LOG_DIR"

# Keep last 50 log files
ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +51 | xargs -r rm -- || true

LOGFILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"

{
  echo "[qa-agent] started $(date)"

  set -a
  source "$HOME/secrets.env"
  set +a

  ANTHROPIC_API_KEY=$(GOOGLE_APPLICATION_CREDENTIALS="" gcloud secrets versions access latest \
    --secret=ANTHROPIC_API_KEY --project=alesa-personal-assistent 2>/dev/null)
  export ANTHROPIC_API_KEY

  cd "$HOME/trained-assist-agent"

  # Build context: current bugs + GitHub issues/PRs state
  echo "[qa-agent] building context..."
  CONTEXT=$(timeout 30 node src/mainstream-tester/build-qa-context.js)

  echo "[qa-agent] context built ($(echo "$CONTEXT" | wc -c) bytes)"
  echo "[qa-agent] launching claude..."

  # Spawn Claude Code — it picks the action and executes it
  timeout 600 claude --dangerously-skip-permissions --print "$CONTEXT"

  echo "[qa-agent] done $(date)"
} >> "$LOGFILE" 2>&1
