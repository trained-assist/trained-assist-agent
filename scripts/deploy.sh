#!/bin/bash
set -e

REPO_DIR="/home/vova/alesa-agent"
SERVICE="alesa-agent"

echo "==> Pulling latest code..."
cd "$REPO_DIR"
git pull origin main

echo "==> Installing dependencies..."
npm ci --omit=dev

echo "==> Restarting service..."
sudo systemctl restart "$SERVICE"
sudo systemctl status "$SERVICE" --no-pager

echo "==> Deploy complete"
