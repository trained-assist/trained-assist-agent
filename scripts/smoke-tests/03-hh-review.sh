#!/usr/bin/env bash
# Smoke test 3: HH review page, sync-log, and ATS config save
# Requires: AGENT_SECRET, BASE_URL (default https://recruiter-assistant.ru)
# Optional: HH_TEST_USER (default tes-recruiter)
set -euo pipefail

BASE_URL="${BASE_URL:-https://recruiter-assistant.ru}"
AGENT_SECRET="${AGENT_SECRET:?AGENT_SECRET required}"
TEST_USER="${HH_TEST_USER:-tes-recruiter}"

# Compute HMAC token (same as server: SHA256(AGENT_SECRET, username).slice(0,16))
PAGE_TOKEN=$(python3 -c "
import hmac, hashlib, sys
secret = '$AGENT_SECRET'.encode()
user = '$TEST_USER'.encode()
print(hmac.new(secret, user, hashlib.sha256).hexdigest()[:16])
")

echo "→ Testing /hh/review for $TEST_USER..."
STATUS=$(curl -s -o /tmp/hh-review.html -w "%{http_code}" --max-time 15 \
  "$BASE_URL/hh/review?username=$TEST_USER&token=$PAGE_TOKEN")
if [[ "$STATUS" != "200" ]]; then
  echo "❌ /hh/review returned HTTP $STATUS"
  exit 1
fi
if grep -q "Ссылка недействительна" /tmp/hh-review.html; then
  echo "❌ /hh/review: token invalid"
  exit 1
fi
if grep -q "HH не подключён" /tmp/hh-review.html; then
  echo "⚠️  /hh/review: HH not connected for $TEST_USER (token missing)"
else
  CAND_COUNT=$(grep -o "откликов" /tmp/hh-review.html | wc -l | tr -d ' ')
  echo "✅ /hh/review OK — candidates page renders (mentions откликов: $CAND_COUNT)"
fi

echo "→ Testing /hh/sync-log for $TEST_USER..."
STATUS=$(curl -s -o /tmp/hh-sync-log.html -w "%{http_code}" --max-time 10 \
  "$BASE_URL/hh/sync-log?username=$TEST_USER&token=$PAGE_TOKEN")
if [[ "$STATUS" != "200" ]]; then
  echo "❌ /hh/sync-log returned HTTP $STATUS"
  exit 1
fi
if grep -q "Ссылка недействительна" /tmp/hh-sync-log.html; then
  echo "❌ /hh/sync-log: token invalid"
  exit 1
fi
echo "✅ /hh/sync-log OK"

echo "→ Testing POST /hh/ats-config (save round-trip)..."
SAVE_RESP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST "$BASE_URL/hh/ats-config" \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d "{
    \"username\": \"$TEST_USER\",
    \"config\": {
      \"vacancy_id\": \"smoke-test\",
      \"title\": \"Smoke Test Vacancy\",
      \"knockout\": [],
      \"required_skills\": [{\"skill\": \"test\", \"weight\": 100}],
      \"preferred_skills\": [],
      \"experience_min_years\": 0,
      \"thresholds\": {\"strong\": 7, \"consider\": 5, \"reject\": 3},
      \"stale_days\": 14
    }
  }")
if [[ "$SAVE_RESP" != "200" ]]; then
  echo "❌ POST /hh/ats-config returned HTTP $SAVE_RESP"
  exit 1
fi
echo "✅ POST /hh/ats-config OK — config saved"

echo "→ Testing GET /hh/ats-editor (page renders)..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "$BASE_URL/hh/ats-editor?username=$TEST_USER&token=$PAGE_TOKEN")
if [[ "$STATUS" != "200" ]]; then
  echo "❌ /hh/ats-editor returned HTTP $STATUS"
  exit 1
fi
echo "✅ /hh/ats-editor OK"

echo ""
echo "✅ All HH review smoke tests passed"
