#!/bin/bash
# Deploy script — run on the VM after git pull
set -Eeuo pipefail

case "${DEPLOY_ENV:-}" in
  gcp) UNIT_VARIANT="" ;;
  ru) UNIT_VARIANT="-ru" ;;
  *) echo "DEPLOY_ENV must be gcp or ru" >&2; exit 1 ;;
esac

SERVICE="assist-agent"
REPO_DIR="${REPO_DIR:-$(pwd)}"
if [ "${ASSIST_DEPLOY_LOCKED:-}" != 1 ]; then
  exec 9>"${ASSIST_DEPLOY_LOCK_FILE:-/tmp/assist-agent-deploy.lock}"
  flock -n 9 || { echo "Another deploy owns the lock"; exit 1; }
  export ASSIST_DEPLOY_LOCKED=1
fi

# Save current commit so we can roll back if smoke tests fail
PREV_COMMIT=${PREV_COMMIT:-$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")}
# First installation needs a quiescent bootstrap; legacy code cannot maintain a
# closed gate through rollback. Refuse before stopping or changing dependencies.
git -C "$REPO_DIR" cat-file -e "$PREV_COMMIT:src/maintenance.js" || {
  echo "Legacy runtime: install the drain-aware baseline in a quiet bootstrap window first"
  exit 1
}

export PREV_COMMIT
DEPS_STAGE=""
OLD_DEPS=""
DEPS_SWAPPED=0
rollback() {
  if [ -z "$PREV_COMMIT" ]; then
    echo "No previous commit recorded; queue remains paused"
    return 1
  fi
  if [ -f "${AGENT_DATA_DIR:-$HOME/agent-data}/execution-authority.json" ] &&
     ! git -C "$REPO_DIR" cat-file -e "$PREV_COMMIT:src/restart-execution.js"; then
    echo "Rollback refused: legacy runtime cannot safely read v2 execution authority; admission stays closed"
    return 1
  fi
  echo "==> Rolling back to $PREV_COMMIT with the saved dependencies..."
  if [ "$(systemctl show "$SERVICE" -p MainPID --value)" != 0 ]; then
    python3 "$REPO_DIR/scripts/restart-coordinator.py" --rollback || return 1
  fi
  sudo systemctl stop "$SERVICE" || return 1
  python3 "$REPO_DIR/scripts/prepare-deploy-journal.py" --rollback || return 1
  git -C "$REPO_DIR" reset --hard "$PREV_COMMIT" || return 1
  if [ "$DEPS_SWAPPED" = "1" ]; then
    sudo systemctl stop "$SERVICE" || return 1
    rm -rf "$REPO_DIR/node_modules" || return 1
    mv "$OLD_DEPS" "$REPO_DIR/node_modules" || return 1
  fi
  sudo systemctl restart "$SERVICE" || return 1
  python3 "$REPO_DIR/scripts/restart-coordinator.py" --ready || return 1
  echo "==> Rolled back to previous version. Deploy failed."
}

# Any failure after the gate is claimed attempts recovery; never reports success.
# Rollback failure leaves the queue paused for an operator, not silently dropped.
on_deploy_error() {
  local code=$?
  trap - ERR
  echo "Deploy failed (exit $code); attempting rollback with admission closed"
  rollback || echo "ROLLBACK FAILED: queue retained; operator recovery required"
  exit "$code"
}

echo "==> Validating and applying nginx config ($DEPLOY_ENV)..."
bash "$REPO_DIR/scripts/deploy-nginx.sh"

# The CI caller also drains before git reset; direct invocations still must drain.
python3 "$REPO_DIR/scripts/drain-for-deploy.py"
trap on_deploy_error ERR
# Prepare dependencies while the old process is still healthy and gated. Network
# or npm failures must not leave a stopped service with its dependencies deleted.
echo "==> Preparing dependencies in an isolated directory..."
DEPS_STAGE=$(mktemp -d "$REPO_DIR/../.agent-deps.XXXXXX")
cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$DEPS_STAGE/"
npm ci --prefix "$DEPS_STAGE" --omit=dev

echo "==> Stopping drained service and swapping dependencies..."
sudo systemctl stop "$SERVICE"
python3 "$REPO_DIR/scripts/prepare-deploy-journal.py"
OLD_DEPS="$DEPS_STAGE/previous-node_modules"
if [ -d "$REPO_DIR/node_modules" ]; then
  mv "$REPO_DIR/node_modules" "$OLD_DEPS"
else
  mkdir "$OLD_DEPS"
fi
DEPS_SWAPPED=1
mv "$DEPS_STAGE/node_modules" "$REPO_DIR/node_modules"
cd "$REPO_DIR"

# Install Playwright Chromium if not already present (idempotent)
if ! ls "$HOME/.cache/ms-playwright/chromium"* 2>/dev/null | grep -q chromium; then
  echo "==> Installing Playwright Chromium..."
  npx playwright install chromium --with-deps 2>&1 | tail -5 || true
fi

echo "==> Installing systemd unit file..."
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

echo "==> Migrating data directory (alesa-data → agent-data) if needed..."
if [ -d "/home/vova/alesa-data" ] && [ ! -d "/home/vova/agent-data" ]; then
  mv /home/vova/alesa-data /home/vova/agent-data
  echo "  Migrated: alesa-data → agent-data"
else
  echo "  No migration needed"
fi

echo "==> Ensuring data directories exist..."
DATA_DIR="${AGENT_DATA_DIR:-/home/vova/agent-data}"
mkdir -p "$DATA_DIR/system-flags"
chown -R vova:vova "$DATA_DIR" 2>/dev/null || true

sudo cp "$REPO_DIR/systemd/assist-agent-restart.service" /etc/systemd/system/
sudo cp "$REPO_DIR/systemd/assist-agent-restart.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now assist-agent-restart.timer

echo "==> Applying OpenCode profile..."
bash "$REPO_DIR/infra/opencode-switch-profile.sh" || echo "opencode-switch-profile: skipped (jq missing or no profile set)"

echo "==> Restarting service..."
sudo systemctl restart "$SERVICE"

echo "==> Waiting for service to be healthy (up to 60s)..."
for i in $(seq 1 12); do
  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8080/health 2>/dev/null || echo 000)
  echo "  attempt $i: HTTP $STATUS_CODE"
  [ "$STATUS_CODE" = "200" ] && break
  sleep 5
done
sudo systemctl status "$SERVICE" --no-pager --lines=10 || true
echo "==> Service journal (last 20 lines)..."
sudo journalctl -u "$SERVICE" --no-pager -n 20 || true

echo "==> Installing disk-hygiene crons..."
if [ -x "$REPO_DIR/ops/cron/install.sh" ]; then
  if sh "$REPO_DIR/ops/cron/install.sh"; then
    echo "  disk-hygiene crons installed"
  else
    echo "  ⚠️  cron install failed — disk guard may be stale"
  fi
fi

# Check the new boot without spawning an LLM task or messaging a test account.
echo "==> Verifying new process and recovered queue..."
python3 "$REPO_DIR/scripts/restart-coordinator.py" --ready
trap - ERR
rm -rf "$DEPS_STAGE"
echo "==> Deploy complete ✅"
