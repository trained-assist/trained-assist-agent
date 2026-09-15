#!/bin/bash
# Switch Codex CLI from the shared OPENAI_API_KEY to a personal ChatGPT account,
# using device-code authorization (no localhost callback, no manual key copying —
# same shape as Claude Code's browser login). Companion to setup-codex.sh, which
# does the initial install + shared-key login.
#
# Usage: ./scripts/codex-login-device.sh
# Prints a URL + one-time code (valid ~15 min). Open the URL on any device, sign
# in with your ChatGPT account, enter the code. This script then polls until the
# CLI process exits and reports the new login status.
set -e

echo "==> Starting device-code login. Open the link below and enter the code shown."
echo "    (Code expires in ~15 minutes.)"
echo ""

codex login --device-auth &
PID=$!

wait "$PID"

echo ""
echo "==> Login flow finished. Status:"
codex login status

echo ""
echo "==> Verifying with a test prompt on the now-active account:"
codex exec --skip-git-repo-check "Скажи одно слово: привет"

echo ""
echo "To switch back to the shared API key: printenv OPENAI_API_KEY | codex login --with-api-key"
