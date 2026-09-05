#!/usr/bin/env bash
# Smoke test 1: verify both VMs are up and running the expected git commit.
# /health is auth-free (moved before auth gate in server.js)
# Usage: EXPECTED_COMMIT=abc1234 bash scripts/smoke-tests/01-health.sh
set -euo pipefail

EXPECTED="${EXPECTED_COMMIT:-}"

check_vm() {
  local name="$1" url="$2"
  local http_code raw body
  raw=$(curl -s --max-time 10 -w "\n__HTTP_CODE__:%{http_code}" "$url" 2>&1) || true
  http_code=$(echo "$raw" | grep '__HTTP_CODE__:' | cut -d: -f2)
  body=$(echo "$raw" | grep -v '__HTTP_CODE__:')

  if [[ "$http_code" != "200" ]]; then
    echo "❌ $name — HTTP ${http_code:-0} at $url"
    echo "   Response: $(echo "$body" | head -1)"
    return 1
  fi

  local commit vm
  commit=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('commit','?'))" 2>/dev/null || echo "?")
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
