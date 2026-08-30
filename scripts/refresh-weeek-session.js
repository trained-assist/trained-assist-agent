#!/usr/bin/env node
'use strict';

// Refresh WEEEK_APP_COOKIE in the Cloudflare Worker secret.
//
// Flow:
//   1. Capture cookies for app.weeek.net from the running Chrome via CDP
//   2. Update the Cloudflare Worker secret via CF REST API
//   3. Send Telegram alert on failure (or success with --verbose)
//
// Env vars (loaded from GCP secrets by secrets.js or set manually):
//   TELEGRAM_BOT_TOKEN  — bot token for alert messages
//   CF_API_TOKEN        — Cloudflare API token with Workers:Edit scope
//   CF_ACCOUNT_ID       — Cloudflare account ID
//   CF_WORKER_NAME      — Worker script name (default: flexi-telegram-deal-bot)
//   OPERATOR_CHAT_ID    — Telegram chat ID to send alerts (default: 1714048)
//   BROWSER_SESSION_URL — noVNC URL shown in failure alerts
//
// Exit codes: 0 = success, 1 = failure (alert sent)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CF_ACCOUNT_ID  = process.env.CF_ACCOUNT_ID  || 'd740a05e9442c1d0feacae2dfc673e93';
const CF_WORKER_NAME = process.env.CF_WORKER_NAME  || 'flexi-telegram-deal-bot';
const OPERATOR_CHAT  = process.env.OPERATOR_CHAT_ID || '1714048';
const BROWSER_URL    = process.env.BROWSER_SESSION_URL || 'https://136-65-7-197.sslip.io/browser/';
const VERBOSE        = process.argv.includes('--verbose');

const CAPTURE_SCRIPT = path.join(os.homedir(), 'browser-session', 'capture-cookies.js');
const TMP_COOKIE_FILE = path.join(os.tmpdir(), `weeek-cookie-${Date.now()}.tmp`);

// ── Telegram ──────────────────────────────────────────────────────────────────

async function tgSend(token, chatId, text) {
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* best-effort */ }
}

// ── Cloudflare API ────────────────────────────────────────────────────────────

async function updateCfSecret(token, accountId, workerName, secretName, secretValue) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/secrets`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: secretName, text: secretValue, type: 'secret_text' }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`CF API ${res.status}: ${JSON.stringify(data.errors || data)}`);
  }
  return data;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const cfToken  = process.env.CF_API_TOKEN;

  if (!cfToken) {
    console.error('[refresh-weeek] CF_API_TOKEN not set — cannot update CF secret');
    await tgSend(botToken, OPERATOR_CHAT,
      '⚠️ <b>Weeek авторефреш не настроен</b>\n\n' +
      'CF_API_TOKEN не задан в GCP secrets.\n\n' +
      'Нужно один раз добавить:\n' +
      '<code>echo "TOKEN" | gcloud secrets create CF_API_TOKEN --data-file=-</code>\n\n' +
      'Токен создаётся на dash.cloudflare.com/profile/api-tokens → Create Token → Workers:Edit'
    );
    process.exit(1);
  }

  // Step 1: Capture cookies from Chrome
  console.log('[refresh-weeek] Capturing app.weeek.net cookies via CDP…');
  let cookieStr;
  try {
    execSync(`node "${CAPTURE_SCRIPT}" app.weeek.net "${TMP_COOKIE_FILE}"`, {
      timeout: 20000,
      stdio: 'inherit',
    });
    cookieStr = fs.readFileSync(TMP_COOKIE_FILE, 'utf8').trim();
    if (!cookieStr) throw new Error('Empty cookie string after capture');
    console.log(`[refresh-weeek] Captured ${cookieStr.split(';').length} cookies`);
  } catch (e) {
    console.error('[refresh-weeek] Cookie capture failed:', e.message);
    await tgSend(botToken, OPERATOR_CHAT,
      '⚠️ <b>Weeek сессия: авторефреш не удался</b>\n\n' +
      'Не удалось захватить куки из браузера на VM.\n\n' +
      '<b>Причина:</b> ' + e.message.slice(0, 200) + '\n\n' +
      '<b>Как починить:</b>\n' +
      `1. Открой браузер на VM: <a href="${BROWSER_URL}">${BROWSER_URL}</a>\n` +
      '2. Зайди на app.weeek.net и авторизуйся\n' +
      '3. Открой расширение Cloud Auth Bridge → Передать токен\n' +
      '   (или напиши боту <code>/refresh_weeek</code> после входа)\n\n' +
      '⏰ Следующая попытка авторефреша — через 6ч'
    );
    process.exit(1);
  } finally {
    try { fs.unlinkSync(TMP_COOKIE_FILE); } catch {}
  }

  // Step 2: Update Cloudflare secret
  console.log('[refresh-weeek] Updating CF secret WEEEK_APP_COOKIE…');
  try {
    await updateCfSecret(cfToken, CF_ACCOUNT_ID, CF_WORKER_NAME, 'WEEEK_APP_COOKIE', cookieStr);
    console.log('[refresh-weeek] ✅ CF secret updated successfully');
    if (VERBOSE) {
      await tgSend(botToken, OPERATOR_CHAT,
        '✅ <b>Weeek сессия обновлена</b>\n\nКуки захвачены и секрет в Cloudflare обновлён автоматически.'
      );
    }
  } catch (e) {
    console.error('[refresh-weeek] CF secret update failed:', e.message);
    await tgSend(botToken, OPERATOR_CHAT,
      '⚠️ <b>Weeek сессия: куки есть, но CF не обновился</b>\n\n' +
      'Куки захвачены успешно, но не удалось обновить секрет в Cloudflare.\n\n' +
      '<b>Причина:</b> ' + e.message.slice(0, 200) + '\n\n' +
      '<b>Как починить вручную:</b>\n' +
      '<code>wrangler secret put WEEEK_APP_COOKIE --config workers/telegram-deal-bot/wrangler.toml</code>\n' +
      '(запусти на своём Mac из flexi-crm-automation)'
    );
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[refresh-weeek] Unexpected error:', e.message);
  process.exit(1);
});
