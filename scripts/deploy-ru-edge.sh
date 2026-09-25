#!/bin/bash
# Deploy script for the RU-IP edge service (src/ru-edge.js, issue #1288).
#
# Unlike scripts/deploy.sh (the full Claude Code agent), ru-edge has no
# task-queue, no Claude sessions, no MCP, no workspace migration, and no HH
# skill sibling checkout to maintain — restart is a plain stop/start, no drain.
set -Eeuo pipefail

SERVICE="ru-edge"
REPO_DIR="${REPO_DIR:-$(pwd)}"
# Same live-dir guard contract as scripts/deploy.sh (issue #1391): the exact
# revision this deploy put in the live directory, read by the systemd
# ExecStartPre guard. Kept outside the repo tree so it never dirties the checkout.
MARKER="${LIVE_DIR_MARKER:-${AGENT_DATA_DIR:-/home/vova/agent-data}/deployed-sha}"
export MARKER
if [ "${ASSIST_DEPLOY_LOCKED:-}" != 1 ]; then
  exec 9>"${ASSIST_DEPLOY_LOCK_FILE:-$HOME/.assist-deploy.lock}"
  flock -n 9 || { echo "Another deploy owns the lock"; exit 1; }
  export ASSIST_DEPLOY_LOCKED=1
fi

PREV_COMMIT=${PREV_COMMIT:-$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")}
export PREV_COMMIT
DEPS_STAGE=""
OLD_DEPS=""
DEPS_SWAPPED=0

rollback() {
  if [ -z "$PREV_COMMIT" ]; then
    echo "No previous commit recorded; cannot roll back"
    return 1
  fi
  echo "==> Rolling back to $PREV_COMMIT..."
  sudo systemctl stop "$SERVICE" || return 1
  git -C "$REPO_DIR" checkout --detach "$PREV_COMMIT" || return 1
  git -C "$REPO_DIR" reset --hard "$PREV_COMMIT" || return 1
  printf '%s\n' "$PREV_COMMIT" > "$MARKER" 2>/dev/null || true
  if [ "$DEPS_SWAPPED" = "1" ]; then
    rm -rf "$REPO_DIR/node_modules" || return 1
    mv "$OLD_DEPS" "$REPO_DIR/node_modules" || return 1
  fi
  sudo systemctl reset-failed "$SERVICE" 2>/dev/null || true
  sudo systemctl start "$SERVICE" || return 1
  echo "==> Rolled back to previous version. Deploy failed."
}

on_deploy_error() {
  local code=$?
  trap - ERR
  echo "Deploy failed (exit $code); attempting rollback"
  rollback || echo "ROLLBACK FAILED: operator recovery required"
  exit "$code"
}

echo "==> Validating and applying nginx config (ru)..."
DEPLOY_ENV=ru bash "$REPO_DIR/scripts/deploy-nginx.sh"

trap on_deploy_error ERR

# ── Everything below until "Stopping service" runs while the old process keeps serving ──

if [ -d "$REPO_DIR/node_modules" ] && [ -n "$PREV_COMMIT" ] &&
   git -C "$REPO_DIR" diff --quiet "$PREV_COMMIT" HEAD -- package.json package-lock.json &&
   npm ls --prefix "$REPO_DIR" --omit=dev --depth=0 >/dev/null 2>&1; then
  echo "==> package.json / package-lock.json unchanged and node_modules verified intact — keeping it"
else
  echo "==> Preparing dependencies in an isolated directory..."
  DEPS_STAGE=$(mktemp -d "$REPO_DIR/../.ru-edge-deps.XXXXXX")
  cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$DEPS_STAGE/"
  npm ci --prefix "$DEPS_STAGE" --omit=dev
fi

# ru-edge still needs Playwright Chromium (nalog.ru/ESIA login + /playwright-fetch).
if ! ls "$HOME/.cache/ms-playwright/chromium"* 2>/dev/null | grep -q chromium; then
  echo "==> Installing Playwright Chromium..."
  (cd "$REPO_DIR" && npx playwright install chromium --with-deps 2>&1 | tail -5) || true
fi

# Install the live-dir guard OUTSIDE the repo tree (#1391) — see scripts/deploy.sh
# for the rationale. systemd's ExecStartPre runs this root-owned copy, so a session
# editing the repo tree cannot change the check that gates serving that tree.
GUARD_SRC="$REPO_DIR/scripts/live-dir-guard.sh"
GUARD_DST="/usr/local/lib/assist/live-dir-guard.sh"
echo "==> Installing live-dir guard outside the repo tree ($GUARD_DST)..."
sudo mkdir -p "$(dirname "$GUARD_DST")"
sudo cp "$GUARD_SRC" "$GUARD_DST"
sudo chown root:root "$GUARD_DST"
sudo chmod 0755 "$GUARD_DST"

echo "==> Installing systemd unit file..."
UNIT_SRC="$REPO_DIR/systemd/${SERVICE}.service"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
NOTIFY_SRC="$REPO_DIR/systemd/assist-agent-notify-failure.service"
NOTIFY_DST="/etc/systemd/system/assist-agent-notify-failure.service"
CHANGED=0
if ! diff -q "$UNIT_SRC" "$UNIT_DST" >/dev/null 2>&1; then
  sudo cp "$UNIT_SRC" "$UNIT_DST"
  CHANGED=1
  echo "  Unit file updated"
else
  echo "  Unit file unchanged"
fi
if [ -f "$NOTIFY_SRC" ] && ! diff -q "$NOTIFY_SRC" "$NOTIFY_DST" >/dev/null 2>&1; then
  sudo cp "$NOTIFY_SRC" "$NOTIFY_DST"
  CHANGED=1
  echo "  Notify-failure unit updated"
fi

# Retired: the old assist-agent-ru.service (Claude Code + task-queue on RU).
if [ -f /etc/systemd/system/assist-agent.service ] && systemctl list-unit-files | grep -q '^assist-agent.service'; then
  UNIT_TEXT=$(cat /etc/systemd/system/assist-agent.service 2>/dev/null || true)
  if echo "$UNIT_TEXT" | grep -q 'VM_NAME=ru-vm'; then
    echo "==> Retiring old assist-agent.service (RU Claude instance)..."
    sudo systemctl disable --now assist-agent.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/assist-agent.service
    CHANGED=1
  fi
fi

if [ "$CHANGED" = "1" ]; then
  sudo systemctl daemon-reload
  echo "  daemon reloaded"
fi

echo "==> Ensuring data directories exist..."
sudo -u vova mkdir -p /home/vova/agent-tokens /home/vova/users
mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
printf '%s\n' "$(git -C "$REPO_DIR" rev-parse HEAD)" > "$MARKER"

# ── Downtime window starts here ──────────────────────────────────────────────

echo "==> Stopping service..."
sudo systemctl stop "$SERVICE" 2>/dev/null || true

if [ -n "$DEPS_STAGE" ]; then
  echo "==> Swapping dependencies..."
  OLD_DEPS="$DEPS_STAGE/previous-node_modules"
  if [ -d "$REPO_DIR/node_modules" ]; then
    mv "$REPO_DIR/node_modules" "$OLD_DEPS"
  else
    mkdir "$OLD_DEPS"
  fi
  DEPS_SWAPPED=1
  mv "$DEPS_STAGE/node_modules" "$REPO_DIR/node_modules"
fi
cd "$REPO_DIR"

sudo fuser -k 8080/tcp 2>/dev/null || true

echo "==> Starting service..."
sudo systemctl reset-failed "$SERVICE" 2>/dev/null || true
sudo systemctl enable --now "$SERVICE"

echo "==> Waiting for service to be healthy (up to 60s)..."
HEALTHY=0
for i in $(seq 1 60); do
  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:8080/health 2>/dev/null || echo 000)
  if [ "$STATUS_CODE" = "200" ]; then HEALTHY=1; echo "  healthy after ${i}s"; break; fi
  sleep 1
done
sudo systemctl status "$SERVICE" --no-pager --lines=10 || true
echo "==> Service journal (last 20 lines)..."
sudo journalctl -u "$SERVICE" --no-pager -n 20 || true

if [ "$HEALTHY" = "0" ]; then
  echo "ERROR: service did not respond on /health after 60s — failing deploy to trigger rollback"
  false
fi
trap - ERR

[ -n "$DEPS_STAGE" ] && rm -rf "$DEPS_STAGE"
echo "==> Deploy complete ✅"
