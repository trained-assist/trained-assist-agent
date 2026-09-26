#!/usr/bin/env bash
# opencode-switch-profile.sh — merge base + profile → ~/.config/opencode/opencode.json
#
# Usage:
#   ./infra/opencode-switch-profile.sh [max|value|free|russian]
#
# Reads OPENCODE_PROFILE from secrets.env if no arg given.
# Writes result to ~/.config/opencode/opencode.json on this machine.
#
# This sets the machine-wide BASELINE only (first rung of each role's ladder, no state/TTL
# awareness) — real per-task invocations resolve the full ladder via src/opencode-ladder.js and
# override this per-invocation (see writeOpencodeMcpConfig in claude-runner.js). This script still
# matters for anything that talks to `opencode` outside the agent's task runner (e.g. manual
# `opencode auth login` sanity checks on the VM).

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
  PROFILE="${PROFILE:-max}"
fi

# Normalize aliases
case "$PROFILE" in
  ru|recruiter|rr|russian-recruiter) PROFILE="russian" ;;
  m|q|ll|mimo|quality|lavish-luna) echo "opencode-switch-profile: '$PROFILE' was retired in #1061 Фаза 1 (merged into max/value ladders) — pick max|value|free|russian" >&2; exit 1 ;;
  v)  PROFILE="value" ;;
  f)  PROFILE="free" ;;
  x)  PROFILE="max" ;;
esac

PROFILE_FILE="$PROFILES_DIR/$PROFILE.json"
if [[ ! -f "$PROFILE_FILE" ]]; then
  echo "opencode-switch-profile: unknown profile '$PROFILE'" >&2
  echo "Available: $(ls "$PROFILES_DIR" | sed 's/\.json//' | tr '\n' ' ')" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
# Profile files declare a `ladder` (per-role model preference list) instead of a flat model —
# flatten to first rung per role for this machine-wide baseline. `rolePrompts.<role>` (e.g.
# russian's strict-reviewer prompt) rides along unchanged, same as the old flat `agent.<role>.prompt`.
jq -s '
  (.[1]) as $p |
  ($p.model // $p.ladder.build[0]) as $topModel |
  (
    $p.agent //
    (($p.ladder // {}) | to_entries | map({
      key: .key,
      value: ({model: .value[0]} + (if $p.rolePrompts[.key] then {prompt: $p.rolePrompts[.key]} else {} end))
    }) | from_entries)
  ) as $agentCfg |
  .[0] * {model: $topModel, agent: $agentCfg}
' "$BASE" "$PROFILE_FILE" > "$OUT"

echo "opencode profile → $PROFILE ($OUT)"

# OpenCode has no env-var auth for its own Zen/Go providers (opencode/*, opencode-go/*) —
# only `opencode auth login` (interactive, browser OAuth) writes ~/.local/share/opencode/auth.json.
# For a headless VM, write the Go service-account key there directly instead, merging with
# whatever auth.json already has so we never drop other providers' credentials.
#
# Prefer the FIRST key of OPENCODE_GO_API_KEYS (the rotation pool; first = active/primary) and
# fall back to the legacy single OPENCODE_GO_API_KEY. Re-writing auth.json to the primary on every
# deploy is intended: src/opencode-go-keys.js re-derives the active key from auth.json, so a deploy
# resets rotation back to the primary, whose exhaustion TTL has by then long expired.
SECRETS="${SECRETS_ENV:-$HOME/secrets.env}"
if [[ -f "$SECRETS" ]]; then
  GO_KEY=$(grep '^OPENCODE_GO_API_KEYS=' "$SECRETS" 2>/dev/null | cut -d= -f2- | tr -d '"' | cut -d, -f1 | xargs || true)
  if [[ -z "${GO_KEY:-}" ]]; then
    GO_KEY=$(grep '^OPENCODE_GO_API_KEY=' "$SECRETS" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  fi
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
