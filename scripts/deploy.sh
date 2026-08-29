#!/bin/bash
set -e

REPO_DIR="/home/vova/trained-assist-agent"
SERVICE="trained-assist-agent"

echo "==> Pulling latest code..."
cd "$REPO_DIR"
git pull origin main

echo "==> Installing dependencies..."
npm ci --omit=dev

echo "==> Restarting service..."
sudo systemctl restart "$SERVICE"
sleep 3
sudo systemctl status "$SERVICE" --no-pager --lines=5

echo "==> Running smoke tests..."
AGENT_SECRET=$(gcloud secrets versions access latest --secret=AGENT_SECRET --project=alesa-personal-assistent)
AGENT_URL="http://localhost:3001" AGENT_SECRET="$AGENT_SECRET" bash scripts/smoke-test.sh

echo "==> Deploy complete"
