#!/usr/bin/env bash
# Smoke tests — run after deploy to verify core functionality of the full
# Claude Code agent (GCP only since issue #1288 — nalog.ru/ESIA login,
# vacancy pages, and playwright-fetch live on the RU edge now, see
# scripts/smoke-test-ru-edge.sh).
# Usage: AGENT_SECRET=xxx AGENT_URL=http://host:port bash scripts/smoke-test.sh

AGENT_URL="${AGENT_URL:-http://localhost:3001}"
AGENT_SECRET="${AGENT_SECRET:-}"
PASS=0
FAIL=0

# curl wrapper: never propagates connection errors — returns "000" on failure
_curl() { curl -s --max-time 10 "$@" || echo "000"; }

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "=== Smoke Tests: trained-assist-agent ==="
echo "URL: $AGENT_URL"
echo ""

# 1. Health check — auth-free endpoint, should return 200 without auth
echo "[1] Health endpoint returns 200 without auth (auth-free per API docs)"
STATUS=$(_curl -o /dev/null -w "%{http_code}" "$AGENT_URL/health")
[ "$STATUS" = "200" ] && ok "200 without auth" || fail "Expected 200, got $STATUS"

# 2. Health check — authenticated should also return 200
echo "[2] Health endpoint returns 200 with auth"
BODY=$(_curl -w "\n%{http_code}" -H "Authorization: Bearer $AGENT_SECRET" "$AGENT_URL/health")
STATUS=$(echo "$BODY" | tail -1)
[ "$STATUS" = "200" ] && ok "200 with auth" || fail "Expected 200, got $STATUS"

# 3. Health response contains status:alive
echo "[3] Health response has status:alive"
HEALTH=$(_curl "$AGENT_URL/health")
echo "$HEALTH" | grep -q '"status":"alive"' && ok "status:alive present" || fail "status:alive missing in: $HEALTH"

# 4. /run requires POST
echo "[4] GET /run returns 404 or 405"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $AGENT_SECRET" "$AGENT_URL/run")
{ [ "$STATUS" = "404" ] || [ "$STATUS" = "405" ]; } && ok "GET /run rejected" || fail "Expected 404/405, got $STATUS"

# 5. /run with missing fields returns 400
echo "[5] POST /run with empty body returns 400"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$AGENT_URL/run")
[ "$STATUS" = "400" ] && ok "400 on missing fields" || fail "Expected 400, got $STATUS"

# 6. /run with valid fields returns 202 (fire-and-forget) — sandbox group "тестовая группа" (zemtest)
echo "[6] POST /run with valid fields returns 202"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId":5367135237,"username":"zemtest","task":"echo smoke"}' \
  "$AGENT_URL/run")
[ "$STATUS" = "202" ] && ok "202 accepted" || fail "Expected 202, got $STATUS"

echo ""
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && echo "✅ All tests passed" && exit 0 || echo "❌ Tests failed — check logs" && exit 1
