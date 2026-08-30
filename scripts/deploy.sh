#!/bin/bash
# Deploy script — run on the VM after git pull
set -e

SERVICE="assist-agent"
REPO_DIR="${REPO_DIR:-$(pwd)}"

echo "==> Installing dependencies..."
cd "$REPO_DIR"
npm ci --omit=dev

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
