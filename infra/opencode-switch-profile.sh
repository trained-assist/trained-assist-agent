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

# OpenCode has no env-var auth for its own Zen/Go providers (opencode/*, opencode-go/*) —
# only `opencode auth login` (interactive, browser OAuth) writes ~/.local/share/opencode/auth.json.
# For a headless VM, write the Go service-account key there directly instead, merging with
# whatever auth.json already has so we never drop other providers' credentials.
SECRETS="${SECRETS_ENV:-$HOME/secrets.env}"
if [[ -f "$SECRETS" ]]; then
  GO_KEY=$(grep '^OPENCODE_GO_API_KEY=' "$SECRETS" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  if [[ -n "${GO_KEY:-}" ]]; then
    AUTH_FILE="$HOME/.local/share/opencode/auth.json"
    mkdir -p "$(dirname "$AUTH_FILE")"
    EXISTING="{}"
    [[ -f "$AUTH_FILE" ]] && EXISTING=$(cat "$AUTH_FILE")
    echo "$EXISTING" | jq --arg key "$GO_KEY" '. * {"opencode-go": {"type": "api", "key": $key}}' > "$AUTH_FILE.tmp"
    mv "$AUTH_FILE.tmp" "$AUTH_FILE"
    chmod 600 "$AUTH_FILE"
    echo "opencode-go credential written ($AUTH_FILE)"
  fi
fi
