#!/bin/bash
# Deploy script — run on the VM after git pull
set -e

SERVICE="assist-agent"
REPO_DIR="${REPO_DIR:-$(pwd)}"

echo "==> Installing dependencies..."
cd "$REPO_DIR"
rm -rf node_modules
npm ci --omit=dev

# Install Playwright Chromium if not already present (idempotent)
if ! ls "$HOME/.cache/ms-playwright/chromium"* 2>/dev/null | grep -q chromium; then
  echo "==> Installing Playwright Chromium..."
  npx playwright install chromium --with-deps 2>&1 | tail -5 || true
fi

echo "==> Restarting service..."
sudo systemctl restart "$SERVICE"
sleep 3
sudo systemctl status "$SERVICE" --no-pager --lines=5 || true

echo "==> Running smoke tests..."
AGENT_SECRET=$(gcloud secrets versions access latest --secret=AGENT_SECRET --project=alesa-personal-assistent 2>/dev/null || echo "$AGENT_SECRET")
if [ -z "$AGENT_SECRET" ]; then
  echo "  ⚠️  AGENT_SECRET not available — skipping smoke tests"
else
  AGENT_URL="http://localhost:8080" AGENT_SECRET="$AGENT_SECRET" bash "$REPO_DIR/scripts/smoke-test.sh"
fi

echo "==> Deploy complete"
