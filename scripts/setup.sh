#!/bin/bash
# Initial VM setup for trained-assist-agent (GCP)
set -e

REPO_URL="https://github.com/trained-assist/trained-assist-agent.git"
REPO_DIR="/home/vova/trained-assist-agent"
SERVICE="assist-agent"

echo "==> Cloning repo..."
git clone "$REPO_URL" "$REPO_DIR" || (cd "$REPO_DIR" && git pull)

echo "==> Installing Node.js dependencies..."
cd "$REPO_DIR"
npm ci --omit=dev

echo "==> Creating data directory..."
mkdir -p "$HOME/agent-data/sessions"

echo "==> Installing systemd service..."
sudo cp "$REPO_DIR/systemd/assist-agent.service" "/etc/systemd/system/$SERVICE.service"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
sudo systemctl start "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager

echo "==> Setup complete. Add secrets to GCP Secret Manager:"
echo "  TELEGRAM_BOT_TOKEN"
echo "  ANTHROPIC_API_KEY"
echo "  AGENT_SECRET"
echo "  DEEPGRAM_API_KEY (optional)"
echo "  BOT_SECRET (optional, for Chrome extension)"
