#!/bin/bash
# Deploy preflight for the live checkout (issue #1391).
#
# The live directory is the *target of deploy*, never a working tree for agent
# sessions. This script refuses anything that would let a non-main revision or a
# dirty tree reach production:
#   1. the target commit must be an ancestor of origin/main;
#   2. HEAD must already point at the target commit (the caller checked it out
#      with `git checkout --detach` before invoking this).
#
# It runs AFTER the workflow has fetched and checked out the target, so on the
# very first hardened deploy the checked-out tree already contains this file.
set -Eeuo pipefail

TARGET="${1:-}"
REPO_DIR="${REPO_DIR:-$(pwd)}"

if [ -z "$TARGET" ]; then
  echo "deploy-preflight: FATAL: no target commit given" >&2
  exit 1
fi

cd "$REPO_DIR"

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy-preflight: FATAL: live checkout is dirty — refusing to deploy." >&2
  echo "deploy-preflight: a session was working in the deploy directory; production must stay a deploy target." >&2
  git status --porcelain | head -20 >&2
  exit 1
fi

# Always refresh: a stale origin/main on the VM (e.g. RU) makes every newly
# merged target look "not an ancestor" and blocks all deploys (#1406).
git fetch --quiet origin main

if ! git merge-base --is-ancestor "$TARGET" origin/main; then
  echo "deploy-preflight: FATAL: $TARGET is not an ancestor of origin/main — refusing to deploy." >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
if [ "$HEAD_SHA" != "$(git rev-parse "$TARGET")" ]; then
  echo "deploy-preflight: FATAL: HEAD ($HEAD_SHA) != target ($TARGET) — refusing to deploy." >&2
  exit 1
fi

echo "deploy-preflight: OK target=$HEAD_SHA (on origin/main, tree clean, detached)"
