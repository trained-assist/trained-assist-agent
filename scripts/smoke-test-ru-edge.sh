#!/usr/bin/env bash
# Smoke tests for the RU-IP edge service (src/ru-edge.js, issue #1288) — run
# after deploying to the RU VM. Covers nalog.ru login routes, health, and the
# authenticated-route gate. Does NOT cover /run — ru-edge has no task-queue.
# Usage: AGENT_SECRET=xxx AGENT_URL=http://host:port bash scripts/smoke-test-ru-edge.sh

AGENT_URL="${AGENT_URL:-http://localhost:8080}"
AGENT_SECRET="${AGENT_SECRET:-}"
PASS=0
FAIL=0

_curl() { curl -s --max-time 10 "$@" || echo "000"; }

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "=== Smoke Tests: ru-edge ==="
echo "URL: $AGENT_URL"
echo ""

# 1. Health check — auth-free
echo "[1] GET /health returns 200 without auth"
STATUS=$(_curl -o /dev/null -w "%{http_code}" "$AGENT_URL/health")
[ "$STATUS" = "200" ] && ok "200 without auth" || fail "Expected 200, got $STATUS"

# 2. Health response has status:alive and service:ru-edge
echo "[2] Health response has status:alive and service:ru-edge"
HEALTH=$(_curl "$AGENT_URL/health")
echo "$HEALTH" | grep -q '"status":"alive"' && echo "$HEALTH" | grep -q '"service":"ru-edge"' \
  && ok "status:alive, service:ru-edge present" || fail "Missing fields in: $HEALTH"

# 3. GET /connect/nalog — legacy form renders (no auth needed)
echo "[3] GET /connect/nalog returns 200 (form)"
STATUS=$(_curl -o /dev/null -w "%{http_code}" "$AGENT_URL/connect/nalog?t=abc")
[ "$STATUS" = "200" ] && ok "200 form rendered" || fail "Expected 200, got $STATUS"

# 4. POST /connect/nalog — missing fields → 400
echo "[4] POST /connect/nalog missing fields returns 400"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"t":"aabbccddeeff00112233445566778899"}' \
  "$AGENT_URL/connect/nalog")
[ "$STATUS" = "400" ] && ok "400 on missing fields" || fail "Expected 400, got $STATUS"

# 5. POST /connect/nalog — invalid token format → 400
echo "[5] POST /connect/nalog invalid token format returns 400"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"t":"INVALID","login":"a","password":"b"}' \
  "$AGENT_URL/connect/nalog")
[ "$STATUS" = "400" ] && ok "400 on invalid token" || fail "Expected 400, got $STATUS"

# 6. POST /connect/nalog — nonexistent pending token → 403
echo "[6] POST /connect/nalog nonexistent token returns 403"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"t":"aabbccddeeff00112233445566778899","login":"a","password":"b"}' \
  "$AGENT_URL/connect/nalog")
[ "$STATUS" = "403" ] && ok "403 on unknown token" || fail "Expected 403, got $STATUS"

# 7. POST /connect/nalog/code — missing fields → 400
echo "[7] POST /connect/nalog/code missing fields returns 400"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$AGENT_URL/connect/nalog/code")
[ "$STATUS" = "400" ] && ok "400 on missing session/code" || fail "Expected 400, got $STATUS"

# 8. POST /connect/nalog/code — invalid code format → 400
echo "[8] POST /connect/nalog/code invalid code format returns 400"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"session":"aabbccddeeff00112233445566778899","code":"abc"}' \
  "$AGENT_URL/connect/nalog/code")
[ "$STATUS" = "400" ] && ok "400 on non-numeric code" || fail "Expected 400, got $STATUS"

# 9. POST /connect/nalog/code — valid format but unknown session → 400
echo "[9] POST /connect/nalog/code unknown session returns 400"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"session":"aabbccddeeff00112233445566778899","code":"123456"}' \
  "$AGENT_URL/connect/nalog/code")
[ "$STATUS" = "400" ] && ok "400 on unknown session" || fail "Expected 400, got $STATUS"

# 10. GET /vacancy/:user/:id — 404 for unknown vacancy (no auth needed)
echo "[10] GET /vacancy/nosuchuser/vac-1 returns 404"
STATUS=$(_curl -o /dev/null -w "%{http_code}" "$AGENT_URL/vacancy/nosuchuser/vac-1")
[ "$STATUS" = "404" ] && ok "404 for unknown vacancy" || fail "Expected 404, got $STATUS"

# 11. POST /apply/:user/:id — missing email/phone → 400 (no auth needed)
echo "[11] POST /apply/testuser/vac-1 missing fields returns 400"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$AGENT_URL/apply/testuser/vac-1")
[ "$STATUS" = "400" ] && ok "400 on missing email/phone" || fail "Expected 400, got $STATUS"

# 12. Authenticated routes reject requests without AGENT_SECRET
echo "[12] GET /capabilities without auth returns 401"
STATUS=$(_curl -o /dev/null -w "%{http_code}" "$AGENT_URL/capabilities?userId=zemtest")
[ "$STATUS" = "401" ] && ok "401 without auth" || fail "Expected 401, got $STATUS"

# 13. GET /capabilities with auth returns 200 (always empty — no per-user state here)
echo "[13] GET /capabilities with auth returns 200"
STATUS=$(_curl -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $AGENT_SECRET" "$AGENT_URL/capabilities?userId=zemtest")
[ "$STATUS" = "200" ] && ok "200 with auth" || fail "Expected 200, got $STATUS"

echo ""
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && echo "✅ All tests passed" && exit 0 || echo "❌ Tests failed — check logs" && exit 1
