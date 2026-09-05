#!/usr/bin/env bash
# Smoke test 2: send "публикуй страницу вакансии" to the tes-recruiter chat
# and verify the bot replies with a vacancy URL + missing-fields prompt.
# Requires: BOT_TOKEN, TEST_CHAT_ID (default: 5492935208)
set -euo pipefail

BOT_TOKEN="${BOT_TOKEN:?BOT_TOKEN required}"
CHAT_ID="${TEST_CHAT_ID:-5492935208}"
API="https://api.telegram.org/bot$BOT_TOKEN"

# Get current update offset so we only check NEW messages
OFFSET=$(curl -sf "$API/getUpdates?limit=1&timeout=0" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); us=d.get('result',[]); print(us[-1]['update_id']+1 if us else 0)")

echo "→ Sending test message to chat $CHAT_ID (offset $OFFSET)"
curl -sf -X POST "$API/sendMessage" \
  -d "chat_id=$CHAT_ID" \
  -d "text=публикуй страницу вакансии" > /dev/null

echo "→ Waiting 30s for bot to respond..."
sleep 30

# Fetch updates after our message
RESPONSE=$(curl -sf "$API/getUpdates?offset=$OFFSET&limit=10&timeout=5")
BOT_TEXT=$(echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = [u.get('message',{}) for u in d.get('result',[])]
bot_msgs = [m.get('text','') for m in msgs if m.get('from',{}).get('is_bot')]
print('\n'.join(bot_msgs))
")

echo "Bot replied:"
echo "$BOT_TEXT" | head -5

if echo "$BOT_TEXT" | grep -q "platform.recruiter-assistant.ru"; then
  echo "✅ Vacancy page URL found in response"
else
  echo "❌ No vacancy URL in bot response"
  exit 1
fi

if echo "$BOT_TEXT" | grep -qE "Уточни|зарплат|компании|этапы|контакт"; then
  echo "✅ Missing-fields prompt found in response"
else
  echo "⚠️  Missing-fields prompt not found — may already be filled"
fi
