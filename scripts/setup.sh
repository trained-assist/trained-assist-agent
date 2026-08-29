#!/bin/bash
# Initial VM setup for alesa-agent
set -e

REPO_URL="https://github.com/trained-assist/alesa-agent.git"
REPO_DIR="/home/vova/alesa-agent"
SERVICE="alesa-agent"

echo "==> Cloning repo..."
git clone "$REPO_URL" "$REPO_DIR" || (cd "$REPO_DIR" && git pull)

echo "==> Installing Node.js dependencies..."
cd "$REPO_DIR"
npm ci --omit=dev

echo "==> Creating data directory..."
mkdir -p "$HOME/alesa-data/sessions"

echo "==> Installing systemd service..."
sudo cp "$REPO_DIR/systemd/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
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
