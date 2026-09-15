#!/bin/bash
# Install and authorize OpenAI Codex CLI on the agent VM, by analogy to Claude Code.
# Prerequisite: OPENAI_API_KEY is set in the environment (same var already used
# for image generation / OCR fallbacks — see systemd/assist-agent.service).
set -e

if [ -z "$OPENAI_API_KEY" ]; then
  echo "OPENAI_API_KEY is not set in the environment. Export it or add it to the service env file first." >&2
  exit 1
fi

echo "==> Installing @openai/codex globally..."
sudo npm install -g @openai/codex

echo "==> Logging in with OPENAI_API_KEY..."
printenv OPENAI_API_KEY | codex login --with-api-key

echo "==> Verifying with a test prompt..."
codex exec --skip-git-repo-check "Скажи одно слово: привет"

echo "==> Done. codex login status:"
codex login status
