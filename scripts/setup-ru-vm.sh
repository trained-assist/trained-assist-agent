#!/bin/bash
# Setup script for RU VM (Hostland or any non-GCP Linux)
# Run as root. Sets up ru-edge (src/ru-edge.js) — the thin RU-IP edge service:
# nalog.ru/ESIA login, RU-geo-blocked page fetch, vacancy pages. No Claude Code,
# no runner, no task-queue, no MCP on this box any more (issue #1288) — all
# Claude sessions run on GCP.
set -e

REPO_URL="https://github.com/trained-assist/trained-assist-agent.git"
REPO_DIR="/home/vova/trained-assist-agent"
SERVICE="ru-edge"
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

echo "==> Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node --version)" < "v20" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
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
cp "$REPO_DIR/systemd/ru-edge.service" "/etc/systemd/system/$SERVICE.service"
# The service runs from the release symlink; point it at the repo until the
# first release deploy repoints it (scripts/deploy-ru-edge.sh does this too).
ln -sfn "$REPO_DIR" "/home/$USER/agent-master"
systemctl daemon-reload
systemctl enable "$SERVICE"

echo ""
echo "==> DONE. Before starting service, edit /etc/systemd/system/$SERVICE.service"
echo "    and fill in the Environment= secrets, then:"
echo "      systemctl daemon-reload"
echo "      systemctl start $SERVICE"
echo "      systemctl status $SERVICE"

echo ""
echo "==> Setting up HH vacancy watcher cron..."
# Copy HH token from GCP VM (recruiter profile) for crawling
# Run this ONCE manually after setup:
#   ssh vova@136.65.7.197 "cat ~/agent-tokens/recruiter/hh" > ~/agent-tokens/hh-watch/hh
#   chmod 600 ~/agent-tokens/hh-watch/hh
#
# Then add to crontab (crontab -e):
#   0 7 * * * cd /home/vova/trained-assist-agent && node scripts/hh-vacancy-watch.js >> /home/vova/hh-watch/watch.log 2>&1
echo "    Copy HH token: ssh vova@136.65.7.197 'cat ~/agent-tokens/recruiter/hh' > ~/agent-tokens/hh-watch/hh && chmod 600 ~/agent-tokens/hh-watch/hh"
echo "    Add cron: 0 7 * * * cd /home/vova/trained-assist-agent && node scripts/hh-vacancy-watch.js >> ~/hh-watch/watch.log 2>&1"
echo "    Set ALERT_CHAT_ID in ~/secrets.env (your Telegram chat ID for alerts)"
