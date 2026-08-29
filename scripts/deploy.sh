#!/bin/bash
set -e

SERVICE="trained-assist-agent"

# CI already cd-s into the repo dir before calling this script.
# Use REPO_DIR as override if set, otherwise use CWD.
REPO_DIR="${REPO_DIR:-$(pwd)}"

echo "==> Pulling latest code..."
git -C "$REPO_DIR" pull origin main

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
