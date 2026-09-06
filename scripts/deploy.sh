#!/bin/bash
# Deploy script — run on the VM after git pull
set -e

SERVICE="assist-agent"
REPO_DIR="${REPO_DIR:-$(pwd)}"

echo "==> Stopping service before dependency install..."
sudo systemctl stop "$SERVICE" 2>/dev/null || true

echo "==> Installing dependencies..."
cd "$REPO_DIR"
rm -rf node_modules
npm ci --omit=dev

# Install Playwright Chromium if not already present (idempotent)
if ! ls "$HOME/.cache/ms-playwright/chromium"* 2>/dev/null | grep -q chromium; then
  echo "==> Installing Playwright Chromium..."
  npx playwright install chromium --with-deps 2>&1 | tail -5 || true
fi

echo "==> Installing systemd unit file..."
# Use the RU-specific unit file on non-GCP VMs (Hostland has no GCP metadata)
if curl -sf -m 2 http://metadata.google.internal/computeMetadata/v1/instance/id \
     -H "Metadata-Flavor: Google" >/dev/null 2>&1; then
  UNIT_VARIANT=""
  echo "  Detected: GCP VM"
else
  UNIT_VARIANT="-ru"
  echo "  Detected: non-GCP VM (using assist-agent-ru.service)"
fi
UNIT_SRC="$REPO_DIR/systemd/${SERVICE}${UNIT_VARIANT}.service"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
NOTIFY_SRC="$REPO_DIR/systemd/assist-agent-notify-failure.service"
NOTIFY_DST="/etc/systemd/system/assist-agent-notify-failure.service"
CHANGED=0
if [ -f "$UNIT_SRC" ]; then
  if ! diff -q "$UNIT_SRC" "$UNIT_DST" >/dev/null 2>&1; then
    sudo cp "$UNIT_SRC" "$UNIT_DST"
    CHANGED=1
    echo "  Unit file updated"
  else
    echo "  Unit file unchanged"
  fi
fi
if [ -f "$NOTIFY_SRC" ]; then
  if ! diff -q "$NOTIFY_SRC" "$NOTIFY_DST" >/dev/null 2>&1; then
    sudo cp "$NOTIFY_SRC" "$NOTIFY_DST"
    CHANGED=1
    echo "  Notify-failure unit updated"
  fi
fi
if [ "$CHANGED" = "1" ]; then
  sudo systemctl daemon-reload
  echo "  daemon reloaded"
fi

echo "==> Stopping legacy conflicting services (alesa-agent, trained-assist-agent)..."
for OLD_SVC in alesa-agent trained-assist-agent; do
  if systemctl list-unit-files | grep -q "^${OLD_SVC}.service"; then
    sudo systemctl stop "$OLD_SVC" 2>/dev/null || true
    sudo systemctl disable "$OLD_SVC" 2>/dev/null || true
    echo "  Stopped and disabled $OLD_SVC"
  fi
done

echo "==> Killing any orphan node processes on port 8080..."
# systemctl restart only kills the tracked PID; orphan processes (started outside systemd)
# stay alive on port 8080 and serve stale code — kill them before the restart.
sudo fuser -k 8080/tcp 2>/dev/null || true
sleep 1

echo "==> Ensuring data directories exist..."
DATA_DIR="${AGENT_DATA_DIR:-/home/vova/alesa-data}"
mkdir -p "$DATA_DIR/system-flags"
chown -R vova:vova "$DATA_DIR" 2>/dev/null || true

echo "==> Restarting service..."
sudo systemctl restart "$SERVICE"

echo "==> Waiting for service to be healthy (up to 60s)..."
for i in $(seq 1 12); do
  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8080/health 2>/dev/null || echo 000)
  echo "  attempt $i: HTTP $STATUS_CODE"
  [ "$STATUS_CODE" = "401" ] && break
  sleep 5
done
sudo systemctl status "$SERVICE" --no-pager --lines=10 || true
echo "==> Service journal (last 20 lines)..."
sudo journalctl -u "$SERVICE" --no-pager -n 20 || true

echo "==> Running smoke tests..."
AGENT_SECRET=$(gcloud secrets versions access latest --secret=AGENT_SECRET --project=alesa-personal-assistent 2>/dev/null || echo "$AGENT_SECRET")
if [ -z "$AGENT_SECRET" ]; then
  echo "  ⚠️  AGENT_SECRET not available — skipping smoke tests"
else
  AGENT_URL="http://localhost:8080" AGENT_SECRET="$AGENT_SECRET" bash "$REPO_DIR/scripts/smoke-test.sh"
fi

echo "==> Deploy complete"
