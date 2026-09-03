#!/bin/bash
# Setup script for RU VM (Hostland or any non-GCP Linux)
# Run as root. Sets up assist-agent with Playwright browsers.
set -e

REPO_URL="https://github.com/trained-assist/trained-assist-agent.git"
REPO_DIR="/home/vova/trained-assist-agent"
SERVICE="assist-agent"
USER="vova"

echo "==> Creating user if needed..."
id "$USER" &>/dev/null || useradd -m -s /bin/bash "$USER"

echo "==> Installing system deps..."
apt-get update -qq
apt-get install -y -qq \
  git curl wget gnupg ca-certificates \
  xvfb \
  libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libdbus-1-3 libxcb1 libxkbcommon0 libx11-6 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0

echo "==> Installing Node.js 22..."
if ! command -v node &>/dev/null || [[ "$(node --version)" < "v22" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node --version && npm --version

echo "==> Cloning/updating repo..."
if [ -d "$REPO_DIR/.git" ]; then
  cd "$REPO_DIR" && git pull
else
  git clone "$REPO_URL" "$REPO_DIR"
fi
chown -R "$USER:$USER" "$REPO_DIR"

echo "==> Installing Node dependencies..."
cd "$REPO_DIR"
npm ci

echo "==> Installing Playwright Chromium browser..."
# Installs into ~/.cache/ms-playwright for the service user
sudo -u "$USER" npx playwright install chromium
sudo -u "$USER" npx playwright install-deps chromium

echo "==> Setting up directories..."
sudo -u "$USER" mkdir -p "/home/$USER/agent-tokens"
sudo -u "$USER" mkdir -p "/home/$USER/users"

echo "==> Installing systemd service..."
# Copy template and let operator fill in secrets
cp "$REPO_DIR/systemd/assist-agent-ru.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE"

echo ""
echo "==> DONE. Before starting service, edit /etc/systemd/system/$SERVICE.service"
echo "    and fill in the Environment= secrets, then:"
echo "      systemctl daemon-reload"
echo "      systemctl start $SERVICE"
echo "      systemctl status $SERVICE"
