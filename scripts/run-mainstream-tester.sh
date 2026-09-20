#!/usr/bin/env bash
# Run the mainstream tester — simulates most-common user paths against the agent.
#
# Usage:
#   ./scripts/run-mainstream-tester.sh                # 1 run, 7 steps each path
#   MAINSTREAM_RUNS=5 ./scripts/run-mainstream-tester.sh
#   MAINSTREAM_STEPS=4 MAINSTREAM_RUNS=10 ./scripts/run-mainstream-tester.sh
#
# The tester spawns a fresh isolated agent instance (port 3099) with a fake Telegram
# server, runs through happy-path and alternative-path scenarios, and logs bugs to:
#   ~/agent-data/mainstream-test/bugs.jsonl
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

# Load secrets from env file if present and not already set
SECRETS_FILE="$HOME/secrets.env"
if [[ -f "$SECRETS_FILE" ]] && [[ -z "${AGENT_SECRET:-}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  set +a
fi

# Validate required env vars
: "${AGENT_SECRET:?AGENT_SECRET is required}"
: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY is required (for mainstream decider)}"

# Optional: ANTHROPIC_API_KEY for Claude spawned by test agent
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "[warn] ANTHROPIC_API_KEY not set — Claude Code tasks will fail in test agent"
fi

LOG_DIR="$HOME/agent-data/mainstream-test"
mkdir -p "$LOG_DIR"

LOG_FILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
echo "[mainstream] Starting. Logs: $LOG_FILE"
echo "[mainstream] MAINSTREAM_RUNS=${MAINSTREAM_RUNS:-1}, MAINSTREAM_STEPS=${MAINSTREAM_STEPS:-7}"

node "$ROOT/src/mainstream-tester/index.js" 2>&1 | tee "$LOG_FILE"

echo ""
echo "[mainstream] Bug log: $LOG_DIR/bugs.jsonl"
if [[ -f "$LOG_DIR/bugs.jsonl" ]]; then
  BUG_COUNT=$(wc -l < "$LOG_DIR/bugs.jsonl")
  echo "[mainstream] Total bug entries accumulated: $BUG_COUNT"
fi
