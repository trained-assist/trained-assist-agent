#!/bin/bash
# Install and configure OpenCode CLI on the agent VM with OpenRouter/MiniMax M3.
# Prerequisite: OPENROUTER_API_KEY is set in secrets.env.
set -e

if [ -z "$OPENROUTER_API_KEY" ]; then
  echo "OPENROUTER_API_KEY is not set. Add it to ~/secrets.env first." >&2
  exit 1
fi

echo "==> Installing opencode-ai globally..."
sudo npm install -g opencode-ai

echo "==> Verifying installation..."
opencode --version

MODEL="${OPENCODE_MODEL:-openrouter/minimax/minimax-m3}"
echo "==> Testing with model: $MODEL"
echo "Скажи одно слово: привет" | OPENROUTER_API_KEY="$OPENROUTER_API_KEY" opencode run -m "$MODEL" "Скажи одно слово: привет"

echo "==> Done. opencode is ready. Model: $MODEL"
echo "    Switch via Telegram: /switch2opencode"
echo "    Override model: set OPENCODE_MODEL in ~/secrets.env"
