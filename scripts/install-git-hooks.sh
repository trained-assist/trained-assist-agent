#!/usr/bin/env bash
# One-time (per clone) setup: point git at the tracked .githooks/ dir so the
# branch-hygiene + immutable-PR hooks are active. Safe to re-run.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push
echo "✓ git hooks installed (core.hooksPath=.githooks)"
