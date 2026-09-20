#!/usr/bin/env bash
# opencode-switch-profile.sh — merge base + profile → ~/.config/opencode/opencode.json
#
# Usage:
#   ./infra/opencode-switch-profile.sh [value|quality|free|mimo|russian-recruiter|lavish-luna]
#
# Reads OPENCODE_PROFILE from secrets.env if no arg given.
# Writes result to ~/.config/opencode/opencode.json on this machine.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILES_DIR="$REPO_DIR/.opencode/profiles"
BASE="$REPO_DIR/.opencode/base.json"
OUT="${OPENCODE_CONFIG_OUT:-$HOME/.config/opencode/opencode.json}"

# Resolve profile name
if [[ -n "${1:-}" ]]; then
  PROFILE="$1"
else
  # Try reading from secrets.env
  SECRETS="${SECRETS_ENV:-$HOME/secrets.env}"
  if [[ -f "$SECRETS" ]]; then
    PROFILE=$(grep '^OPENCODE_PROFILE=' "$SECRETS" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
  fi
  PROFILE="${PROFILE:-value}"
fi

# Normalize aliases
case "$PROFILE" in
  ru|recruiter|rr) PROFILE="russian-recruiter" ;;
  q)  PROFILE="quality" ;;
  v)  PROFILE="value" ;;
  f)  PROFILE="free" ;;
  m)  PROFILE="mimo" ;;
  ll) PROFILE="lavish-luna" ;;
esac

PROFILE_FILE="$PROFILES_DIR/$PROFILE.json"
if [[ ! -f "$PROFILE_FILE" ]]; then
  echo "opencode-switch-profile: unknown profile '$PROFILE'" >&2
  echo "Available: $(ls "$PROFILES_DIR" | sed 's/\.json//' | tr '\n' ' ')" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
jq -s '.[0] * .[1]' "$BASE" "$PROFILE_FILE" > "$OUT"

echo "opencode profile → $PROFILE ($OUT)"
