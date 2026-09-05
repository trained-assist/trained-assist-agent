#!/usr/bin/env bash
# Smoke test 1: verify both VMs are up and running the expected git commit.
# Usage: EXPECTED_COMMIT=abc1234 bash scripts/smoke-tests/01-health.sh
# If EXPECTED_COMMIT is not set, just checks that VMs respond.
set -euo pipefail

GCP_URL="https://recruiter-assistant.ru"
RU_URL="https://platform.recruiter-assistant.ru"
EXPECTED="${EXPECTED_COMMIT:-}"

check_vm() {
  local name="$1" url="$2"
  local body
  body=$(curl -sf --max-time 10 "$url/health") || { echo "❌ $name unreachable"; return 1; }
  local commit
  commit=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('commit','?'))" 2>/dev/null || echo "?")
  echo "✅ $name — commit: $commit"
  if [[ -n "$EXPECTED" && "$commit" != "$EXPECTED"* ]]; then
    echo "❌ $name commit mismatch: expected $EXPECTED, got $commit"
    return 1
  fi
}

check_vm "GCP" "$GCP_URL"
check_vm "RU VM" "$RU_URL"
echo "✅ Health check passed"
