#!/usr/bin/env bash
# Daily live canary for every extracted domain skill source (#1463, rules §7).
# Runs scripts/staging/mcp-source-canary.js for each spec in
# scripts/staging/canaries/*.json against the REAL control plane (prepare →
# activate → registry → leased copy → MCP child → one read-only call).
# Evidence: ~/agent-data/mcp-canary/<id>-latest.json (+ timestamped history).
# Failure is loud: one open GitHub issue per canary ("[canary] <id> mount
# failed"), commented on repeat failures instead of duplicated.
set -uo pipefail
if [ -f "$HOME/secrets.env" ]; then set -a; . "$HOME/secrets.env"; set +a; fi
export GITHUB_TOKEN="${GITHUB_TOKEN:-${GITHUB_ISSUES_TOKEN:-}}"
export CANARY_TOKENS_DIR="${CANARY_TOKENS_DIR:-$HOME/agent-tokens}"
REPO="${CANARY_ISSUE_REPO:-trained-assist/trained-assist-agent}"
LOG="$HOME/agent-data/mcp-canary/cron.log"
BASE=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$(dirname "$LOG")"
cd "$BASE" || exit 1

gh_api() { curl -sS -H "Authorization: Bearer $GITHUB_ISSUES_TOKEN" -H 'Accept: application/vnd.github+json' "$@"; }

alert() {  # $1 canary id, $2 evidence json
  [ -n "${GITHUB_ISSUES_TOKEN:-}" ] || { echo "no GITHUB_ISSUES_TOKEN, cannot alert" >> "$LOG"; return; }
  local title="[canary] $1 mount failed" body num
  body=$(printf 'Daily MCP source canary failed on %s.\n\n```json\n%s\n```\n\nRerun: `node scripts/staging/mcp-source-canary.js scripts/staging/canaries/%s.json`' "$(hostname)" "$2" "$1" \
    | python3 -c 'import json,sys; print(json.dumps({"body": sys.stdin.read()}))')
  num=$(gh_api "https://api.github.com/repos/$REPO/issues?state=open&per_page=100" \
    | python3 -c "import json,sys; t=sys.argv[1]; print(next((str(i['number']) for i in json.load(sys.stdin) if i.get('title')==t), ''))" "$title")
  if [ -n "$num" ]; then
    gh_api -X POST "https://api.github.com/repos/$REPO/issues/$num/comments" -d "$body" > /dev/null
  else
    gh_api -X POST "https://api.github.com/repos/$REPO/issues" \
      -d "$(printf '%s' "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); d['title']=sys.argv[1]; print(json.dumps(d))" "$title")" > /dev/null
  fi
}

rc=0
for spec in scripts/staging/canaries/*.json; do
  id=$(basename "$spec" .json)
  if out=$(timeout 900 node scripts/staging/mcp-source-canary.js "$spec" 2>/dev/null); then
    echo "$(date -Is) $id OK" >> "$LOG"
  else
    rc=1
    echo "$(date -Is) $id FAILED: $(printf '%s' "$out" | tr -d '\n' | cut -c1-400)" >> "$LOG"
    alert "$id" "${out:-no output (timeout or crash)}"
  fi
done
exit $rc
