'use strict';

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function hhSuccessHtml(displayName) {
  const accountLine = displayName
    ? `<p class="account">Аккаунт: <strong>${escHtml(displayName)}</strong></p>`
    : '';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HeadHunter подключён</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,.10); text-align: center; }
    .icon { font-size: 52px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 10px; }
    p { color: #666; font-size: 15px; line-height: 1.5; }
    .account { margin-top: 14px; font-size: 14px; color: #444; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>HeadHunter подключён!</h1>
    <p>Вернись в Telegram — ассистент готов работать с вакансиями и откликами.</p>
    ${accountLine}
  </div>
</body>
</html>`;
}

function hhErrorHtml(msg) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ошибка подключения HH</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,.10); text-align: center; }
    .icon { font-size: 52px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #d32f2f; margin-bottom: 10px; }
    p { color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Ошибка подключения</h1>
    <p>${escHtml(msg || 'Что-то пошло не так. Попробуй ещё раз через Telegram.')}</p>
  </div>
</body>
</html>`;
}

function hhLandingHtml() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recruiter Assistant — HH</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,.10); text-align: center; }
    .logo { font-size: 52px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 10px; }
    p { color: #666; font-size: 15px; line-height: 1.6; }
    .step { margin-top: 24px; padding: 16px; background: #f8f9fa; border-radius: 10px; text-align: left; }
    .step p { font-size: 14px; color: #555; }
    .step code { font-family: monospace; background: #e8eaed; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #333; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🤝</div>
    <h1>Recruiter Assistant</h1>
    <p>Эта страница используется для подключения HeadHunter к ассистенту. Ссылку для входа отправляет бот в Telegram.</p>
    <div class="step">
      <p>Напиши боту: <code>подключи HH</code> — и он пришлёт персональную ссылку для авторизации.</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { hhSuccessHtml, hhErrorHtml, hhLandingHtml };
