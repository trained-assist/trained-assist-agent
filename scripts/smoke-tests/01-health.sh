#!/usr/bin/env bash
# Smoke test 1: verify both VMs are up and running the expected git commit.
# Usage: AGENT_SECRET=xxx EXPECTED_COMMIT=abc1234 bash scripts/smoke-tests/01-health.sh
set -euo pipefail

AGENT_SECRET="${AGENT_SECRET:?AGENT_SECRET required}"
EXPECTED="${EXPECTED_COMMIT:-}"

check_vm() {
  local name="$1" url="$2"
  local body
  body=$(curl -sf --max-time 10 -H "Authorization: Bearer $AGENT_SECRET" "$url") \
    || { echo "❌ $name unreachable: $url"; return 1; }
  local commit
  commit=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('commit','?'))" 2>/dev/null || echo "?")
  local vm
  vm=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('vm','?'))" 2>/dev/null || echo "?")
  echo "✅ $name ($vm) — commit: $commit"
  if [[ -n "$EXPECTED" && "$commit" != "$EXPECTED"* ]]; then
    echo "❌ $name commit mismatch: expected $EXPECTED, got $commit"
    return 1
  fi
}

# GCP: nginx routes /agent/* to app (strips /agent prefix)
check_vm "GCP" "https://136-65-7-197.sslip.io/agent/health"

# RU VM: nginx routes / to app directly
check_vm "RU VM" "https://178-212-14-192.sslip.io/health"

echo "✅ Health check passed"
