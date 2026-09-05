#!/usr/bin/env bash
# Smoke test 2: verify the Telegram bot token is valid and optionally
# send a test message to the tes-recruiter chat.
# Requires: BOT_TOKEN
# Optional: TEST_CHAT_ID (default: 5492935208) — if the bot hasn't interacted
#           with this chat yet, sendMessage will fail with "chat not found".
#           In that case the test warns but does NOT fail — the bot token check
#           is the primary assertion.
set -euo pipefail

BOT_TOKEN="${BOT_TOKEN:?BOT_TOKEN required}"
CHAT_ID="${TEST_CHAT_ID:-5492935208}"
API="https://api.telegram.org/bot$BOT_TOKEN"

echo "→ Verifying bot token with getMe..."
ME=$(curl -s --max-time 10 "$API/getMe")
BOT_OK=$(echo "$ME" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','false'))" 2>/dev/null || echo "false")
BOT_NAME=$(echo "$ME" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('username','?'))" 2>/dev/null || echo "?")

if [[ "$BOT_OK" != "True" ]]; then
  echo "❌ Bot token invalid — getMe returned: $(echo "$ME" | head -c 150)"
  exit 1
fi
echo "✅ Bot token valid — @$BOT_NAME"

echo "→ Sending test message to chat $CHAT_ID"
SEND=$(curl -s --max-time 10 -X POST "$API/sendMessage" \
  -H 'Content-Type: application/json' \
  -d "{\"chat_id\": $CHAT_ID, \"text\": \"публикуй страницу вакансии\"}")

SEND_OK=$(echo "$SEND" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok','false'))" 2>/dev/null || echo "false")
SEND_ERR=$(echo "$SEND" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description','unknown'))" 2>/dev/null || echo "unknown")

if [[ "$SEND_OK" == "True" ]]; then
  MSG_ID=$(echo "$SEND" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('message_id','?'))" 2>/dev/null || echo "?")
  echo "✅ Message sent (id=$MSG_ID) — bot will respond via webhook in ~10s"
  echo "   Check chat $CHAT_ID in Telegram to verify bot replied with:"
  echo "   - vacancy URL (platform.recruiter-assistant.ru/vacancy/...)"
  echo "   - 📋 Уточни, чтобы дополнить страницу: ..."
else
  echo "⚠️  sendMessage failed: $SEND_ERR"
  echo "   (Bot token is valid — this chat may not have started a conversation with the bot)"
  echo "   To fix: open Telegram, find @$BOT_NAME, and send /start from account $CHAT_ID"
fi
