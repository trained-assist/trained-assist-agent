#!/bin/bash
# Deploy script — run on the VM after the checkout was reset to the target commit.
#
# Restart is instant: no drain, no admission gate, no waiting for active work. Everything
# slow (nginx, npm ci, unit files) happens BEFORE the service is touched; the downtime is
# just stop → swap deps (only if package-lock changed) → start → health check. Tasks cut
# off by the stop stay in the pending-task journal and the new process resumes them silently.
set -Eeuo pipefail

case "${DEPLOY_ENV:-}" in
  gcp) UNIT_VARIANT="" ;;
  ru) UNIT_VARIANT="-ru" ;;
  *) echo "DEPLOY_ENV must be gcp or ru" >&2; exit 1 ;;
esac

SERVICE="assist-agent"
REPO_DIR="${REPO_DIR:-$(pwd)}"
if [ "${ASSIST_DEPLOY_LOCKED:-}" != 1 ]; then
  exec 9>"${ASSIST_DEPLOY_LOCK_FILE:-$HOME/.assist-deploy.lock}"
  flock -n 9 || { echo "Another deploy owns the lock"; exit 1; }
  export ASSIST_DEPLOY_LOCKED=1
fi

# Save current commit so we can roll back if the new process never gets healthy
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
  git -C "$REPO_DIR" reset --hard "$PREV_COMMIT" || return 1
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

echo "==> Validating and applying nginx config ($DEPLOY_ENV)..."
bash "$REPO_DIR/scripts/deploy-nginx.sh"

trap on_deploy_error ERR

# ── Everything below until "Stopping service" runs while the old process keeps serving ──

# Dependencies: only reinstall when they actually changed. Staged in a side directory so a
# network/npm failure never leaves the live node_modules half-deleted.
if [ -d "$REPO_DIR/node_modules" ] && [ -n "$PREV_COMMIT" ] &&
   git -C "$REPO_DIR" diff --quiet "$PREV_COMMIT" HEAD -- package.json package-lock.json; then
  echo "==> package.json / package-lock.json unchanged — keeping node_modules"
else
  echo "==> Preparing dependencies in an isolated directory..."
  DEPS_STAGE=$(mktemp -d "$REPO_DIR/../.agent-deps.XXXXXX")
  cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$DEPS_STAGE/"
  npm ci --prefix "$DEPS_STAGE" --omit=dev
fi

# Install Playwright Chromium if not already present (idempotent)
if ! ls "$HOME/.cache/ms-playwright/chromium"* 2>/dev/null | grep -q chromium; then
  echo "==> Installing Playwright Chromium..."
  (cd "$REPO_DIR" && npx playwright install chromium --with-deps 2>&1 | tail -5) || true
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

# The drain-aware restart coordinator (timer + service) is gone: restarts are instant now.
# A leftover timer would fail every 10s because its script no longer exists.
if [ -f /etc/systemd/system/assist-agent-restart.timer ] || [ -f /etc/systemd/system/assist-agent-restart.service ]; then
  echo "==> Removing retired restart coordinator timer..."
  sudo systemctl disable --now assist-agent-restart.timer 2>/dev/null || true
  sudo systemctl stop assist-agent-restart.service 2>/dev/null || true
  sudo rm -f /etc/systemd/system/assist-agent-restart.timer /etc/systemd/system/assist-agent-restart.service
  CHANGED=1
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
# Leftovers of the retired drain gate — nothing reads them any more.
rm -f "$DATA_DIR/maintenance.json.drain" "$DATA_DIR/maintenance.json.recipients" 2>/dev/null || true

echo "==> Ensuring trained-assist-hh-skill sibling checkout exists (feeds the HH skill fallback in src/mcp-action.js)..."
HH_SKILL_DIR="$(dirname "$REPO_DIR")/trained-assist-hh-skill"
if [ ! -d "$HH_SKILL_DIR/.git" ]; then
  HH_SKILL_URL=$(git -C "$REPO_DIR" remote get-url origin | sed 's#/trained-assist-agent\(\.git\)\?$#/trained-assist-hh-skill.git#')
  echo "  Cloning $HH_SKILL_DIR..."
  git clone --quiet "$HH_SKILL_URL" "$HH_SKILL_DIR" || echo "  ⚠️  clone failed — hh skill fallback will be unavailable until fixed"
else
  git -C "$HH_SKILL_DIR" fetch --quiet origin main 2>/dev/null &&
    git -C "$HH_SKILL_DIR" reset --quiet --hard origin/main 2>/dev/null ||
    echo "  ⚠️  update failed — keeping existing checkout"
fi

echo "==> Applying OpenCode profile..."
bash "$REPO_DIR/infra/opencode-switch-profile.sh" || echo "opencode-switch-profile: skipped (jq missing or no profile set)"

# ── Downtime window starts here ──────────────────────────────────────────────────────

echo "==> Stopping service..."
sudo systemctl stop "$SERVICE"

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

# Orphan processes (started outside systemd) stay alive on port 8080 and serve stale code.
sudo fuser -k 8080/tcp 2>/dev/null || true

# ── Workspace storage migration (legacy AGENT_DATA_DIR/sessions → USERS_DIR) ──────
# Idempotent + ledgered. Runs while the service is stopped so the new code starts
# with data already in the canonical root (identity ≠ location). Never blocks the
# deploy — a partial run is reported and can be re-run; the ledger enables rollback.
echo "==> Migrating legacy per-profile workspaces (agent-data/sessions → users)..."
USERS_DIR="${USERS_DIR:-$HOME/users}" AGENT_DATA_DIR="${AGENT_DATA_DIR:-$HOME/agent-data}" \
  node "$REPO_DIR/scripts/migrate-workspaces.mjs" --apply --quiet \
  || echo "  ⚠️  workspace migration reported issues — re-run scripts/migrate-workspaces.mjs (see ledger)"

echo "==> Starting service..."
# Clear any failed state (e.g. StartLimitBurst exhausted from crash loops) so
# systemd accepts the start request even if the previous run ended badly.
sudo systemctl reset-failed "$SERVICE" 2>/dev/null || true
sudo systemctl start "$SERVICE"

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

# Fail hard if service never came up — triggers on_deploy_error → rollback.
# Must use `false` (a failing command) not `exit 1` — bash's ERR trap fires only
# on non-zero command exits, not on an explicit `exit` statement.
if [ "$HEALTHY" = "0" ]; then
  echo "ERROR: service did not respond on /health after 60s — failing deploy to trigger rollback"
  false
fi
trap - ERR

echo "==> HH skill extraction parity smoke test (informational, does not block deploy)..."
node "$REPO_DIR/scripts/hh-extraction-parity-smoke.js" || echo "  ⚠️  parity smoke test failed — see output above; HH skill fallback may be degraded"

echo "==> Installing disk-hygiene crons..."
if [ -x "$REPO_DIR/ops/cron/install.sh" ]; then
  if sh "$REPO_DIR/ops/cron/install.sh"; then
    echo "  disk-hygiene crons installed"
  else
    echo "  ⚠️  cron install failed — disk guard may be stale"
  fi
fi

[ -n "$DEPS_STAGE" ] && rm -rf "$DEPS_STAGE"
echo "==> Deploy complete ✅"
