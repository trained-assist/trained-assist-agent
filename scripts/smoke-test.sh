#!/usr/bin/env bash
# Smoke tests — run after deploy to verify core functionality
# Usage: AGENT_SECRET=xxx AGENT_URL=http://host:port bash scripts/smoke-test.sh

set -e

AGENT_URL="${AGENT_URL:-http://localhost:3001}"
AGENT_SECRET="${AGENT_SECRET:-}"
PASS=0
FAIL=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "=== Smoke Tests: trained-assist-agent ==="
echo "URL: $AGENT_URL"
echo ""

# 1. Health check — unauthenticated should return 401
echo "[1] Health endpoint returns 401 without auth"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$AGENT_URL/health")
[ "$STATUS" = "401" ] && ok "401 without auth" || fail "Expected 401, got $STATUS"

# 2. Health check — authenticated should return 200
echo "[2] Health endpoint returns 200 with auth"
BODY=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $AGENT_SECRET" "$AGENT_URL/health")
STATUS=$(echo "$BODY" | tail -1)
[ "$STATUS" = "200" ] && ok "200 with auth" || fail "Expected 200, got $STATUS"

# 3. Health response contains status:alive
echo "[3] Health response has status:alive"
HEALTH=$(curl -s -H "Authorization: Bearer $AGENT_SECRET" "$AGENT_URL/health")
echo "$HEALTH" | grep -q '"status":"alive"' && ok "status:alive present" || fail "status:alive missing in: $HEALTH"

# 4. /run requires POST
echo "[4] GET /run returns 404 or 405"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $AGENT_SECRET" "$AGENT_URL/run")
{ [ "$STATUS" = "404" ] || [ "$STATUS" = "405" ]; } && ok "GET /run rejected" || fail "Expected 404/405, got $STATUS"

# 5. /run with missing fields returns 400
echo "[5] POST /run with empty body returns 400"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$AGENT_URL/run")
[ "$STATUS" = "400" ] && ok "400 on missing fields" || fail "Expected 400, got $STATUS"

# 6. /run with valid fields returns 202 (fire-and-forget)
echo "[6] POST /run with valid fields returns 202"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId":123456789,"username":"smoketest","task":"echo smoke"}' \
  "$AGENT_URL/run")
[ "$STATUS" = "202" ] && ok "202 accepted" || fail "Expected 202, got $STATUS"

# 7. /run with negative userId (Telegram group/channel) returns 202
echo "[7] POST /run with negative userId returns 202"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId":-5259894154,"username":"smoketest","task":"echo smoke"}' \
  "$AGENT_URL/run")
[ "$STATUS" = "202" ] && ok "202 accepted for negative userId" || fail "Expected 202, got $STATUS"

# 8. GET /connect/nalog — form renders (no auth needed)
echo "[8] GET /connect/nalog returns 200 (form)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$AGENT_URL/connect/nalog?t=abc")
[ "$STATUS" = "200" ] && ok "200 form rendered" || fail "Expected 200, got $STATUS"

# 9. POST /connect/nalog — missing fields → 400
echo "[9] POST /connect/nalog missing fields returns 400"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"t":"aabbccddeeff00112233445566778899"}' \
  "$AGENT_URL/connect/nalog")
[ "$STATUS" = "400" ] && ok "400 on missing fields" || fail "Expected 400, got $STATUS"

# 10. POST /connect/nalog — invalid token format → 400
echo "[10] POST /connect/nalog invalid token format returns 400"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"t":"INVALID","login":"a","password":"b"}' \
  "$AGENT_URL/connect/nalog")
[ "$STATUS" = "400" ] && ok "400 on invalid token" || fail "Expected 400, got $STATUS"

# 11. POST /connect/nalog — nonexistent pending token → 403
echo "[11] POST /connect/nalog nonexistent token returns 403"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"t":"aabbccddeeff00112233445566778899","login":"a","password":"b"}' \
  "$AGENT_URL/connect/nalog")
[ "$STATUS" = "403" ] && ok "403 on unknown token" || fail "Expected 403, got $STATUS"

# 12. POST /connect/nalog/code — missing fields → 400
echo "[12] POST /connect/nalog/code missing fields returns 400"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$AGENT_URL/connect/nalog/code")
[ "$STATUS" = "400" ] && ok "400 on missing session/code" || fail "Expected 400, got $STATUS"

# 13. POST /connect/nalog/code — invalid code format → 400
echo "[13] POST /connect/nalog/code invalid code format returns 400"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"session":"aabbccddeeff00112233445566778899","code":"abc"}' \
  "$AGENT_URL/connect/nalog/code")
[ "$STATUS" = "400" ] && ok "400 on non-numeric code" || fail "Expected 400, got $STATUS"

# 14. POST /connect/nalog/code — valid format but unknown session → 400
echo "[14] POST /connect/nalog/code unknown session returns 400"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"session":"aabbccddeeff00112233445566778899","code":"123456"}' \
  "$AGENT_URL/connect/nalog/code")
[ "$STATUS" = "400" ] && ok "400 on unknown session" || fail "Expected 400, got $STATUS"

echo ""
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && echo "✅ All tests passed" && exit 0 || echo "❌ Tests failed — check logs" && exit 1
