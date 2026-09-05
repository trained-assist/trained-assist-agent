#!/usr/bin/env bash
# Smoke test 2: send "публикуй страницу вакансии" to the tes-recruiter chat.
# Verifies the message was delivered; bot response goes directly to the chat
# via webhook (can't intercept with getUpdates when webhook is active).
# Requires: BOT_TOKEN, TEST_CHAT_ID (default: 5492935208)
set -euo pipefail

BOT_TOKEN="${BOT_TOKEN:?BOT_TOKEN required}"
CHAT_ID="${TEST_CHAT_ID:-5492935208}"
API="https://api.telegram.org/bot$BOT_TOKEN"

echo "→ Sending test message to chat $CHAT_ID"
SEND=$(curl -s --max-time 10 -X POST "$API/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\": $CHAT_ID, \"text\": \"публикуй страницу вакансии\"}")

MSG_ID=$(echo "$SEND" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('message_id','?'))" 2>/dev/null || echo "?")

if [[ "$MSG_ID" == "?" || -z "$MSG_ID" ]]; then
  echo "❌ Failed to send message to Telegram"
  echo "   Response: $(echo "$SEND" | head -c 200)"
  exit 1
fi

echo "✅ Message sent (id=$MSG_ID) — bot will respond via webhook in ~10s"
echo "   Check chat $CHAT_ID in Telegram to verify bot replied with:"
echo "   - vacancy URL (platform.recruiter-assistant.ru/vacancy/...)"
echo "   - 📋 Уточни, чтобы дополнить страницу: ..."
