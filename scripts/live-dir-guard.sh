#!/bin/bash
# Startup guard for the live checkout (issue #1391).
#
# The live directory is the *target of deploy*, never a working tree for agent
# sessions. deploy.sh records the revision it put here in a marker file; this
# guard (systemd ExecStartPre, before the server binds :8080) makes sure the
# process only ever serves exactly that revision:
#
#   * HEAD == marker            → ok;
#   * HEAD != marker, tree clean → a session switched branches/committed; restore
#                                  the deployed revision (loud warning, no data is
#                                  lost — the session's branch/commits stay);
#   * HEAD != marker, tree dirty → unknown code on disk; refuse to start;
#   * no marker yet             → bootstrap (first hardened deploy), skip.
#
# It never fetches: the deployed object is already in the local store.
set -uo pipefail

REPO_DIR="${REPO_DIR:-/home/vova/trained-assist-agent}"
MARKER="${LIVE_DIR_MARKER:-${AGENT_DATA_DIR:-/home/vova/agent-data}/deployed-sha}"
LOG="[live-dir-guard]"

if [ ! -f "$MARKER" ]; then
  echo "$LOG no deployed-sha marker yet ($MARKER) — bootstrap, skipping check"
  exit 0
fi
DEPLOYED="$(tr -d '[:space:]' < "$MARKER" 2>/dev/null || true)"
if [ -z "$DEPLOYED" ]; then
  echo "$LOG empty marker — skipping check"
  exit 0
fi

CUR="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
if [ -z "$CUR" ]; then
  echo "$LOG cannot read HEAD in $REPO_DIR — skipping check"
  exit 0
fi
if [ "$CUR" = "$DEPLOYED" ]; then
  exit 0
fi

if [ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null || true)" ]; then
  echo "$LOG FATAL: live dir at $CUR, expected $DEPLOYED, tree DIRTY — refusing to start (code not from deploy)" >&2
  exit 1
fi

if git -C "$REPO_DIR" cat-file -e "${DEPLOYED}^{commit}" 2>/dev/null; then
  echo "$LOG WARNING: live dir at $CUR, expected $DEPLOYED — restoring deployed revision (tree clean, no data lost)" >&2
  git -C "$REPO_DIR" checkout --detach "$DEPLOYED" >/dev/null 2>&1 &&
    git -C "$REPO_DIR" reset --hard "$DEPLOYED" >/dev/null 2>&1 && exit 0
  echo "$LOG FATAL: could not restore $DEPLOYED — refusing to start" >&2
  exit 1
fi

echo "$LOG FATAL: live dir at $CUR, expected $DEPLOYED (object missing) — refusing to start" >&2
exit 1
