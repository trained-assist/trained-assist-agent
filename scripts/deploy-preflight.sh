#!/bin/bash
# Deploy preflight for the release-dir model (issue #1391).
#
# The live/prod version is selected by the ~/agent-master symlink, not by a git
# working tree — so a dirty session worktree no longer blocks (or affects) a
# deploy. The only thing that must hold is that we never build a release from a
# commit that is not on origin/main.
set -Eeuo pipefail

TARGET="${1:-}"
REPO_DIR="${REPO_DIR:-$(pwd)}"

if [ -z "$TARGET" ]; then
  echo "deploy-preflight: FATAL: no target commit given" >&2
  exit 1
fi

cd "$REPO_DIR"

# Always refresh: a stale origin/main on the VM (e.g. RU) makes every newly
# merged target look "not an ancestor" and blocks all deploys (#1406).
git fetch --quiet origin main

if ! git merge-base --is-ancestor "$TARGET" origin/main; then
  echo "deploy-preflight: FATAL: $TARGET is not an ancestor of origin/main — refusing to deploy." >&2
  exit 1
fi

echo "deploy-preflight: OK target=$TARGET (on origin/main)"
