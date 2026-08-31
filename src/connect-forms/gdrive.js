'use strict';

function gdriveFormHtml(t) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Подключить Google Drive</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.10); text-align: center; }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 10px; }
    p { color: #666; font-size: 15px; line-height: 1.5; margin-bottom: 28px; }
    .btn { display: inline-flex; align-items: center; gap: 10px; background: #4285F4; color: #fff; font-size: 15px; font-weight: 600; border: none; border-radius: 8px; padding: 14px 24px; cursor: pointer; text-decoration: none; transition: background 0.15s; }
    .btn:hover { background: #3367d6; }
    .btn svg { width: 20px; height: 20px; flex-shrink: 0; }
    .note { margin-top: 20px; font-size: 12px; color: #999; }
    .error { color: #d32f2f; font-size: 14px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">📂</div>
    <h1>Подключить Google Drive</h1>
    <p>Нажми кнопку ниже, чтобы разрешить ассистенту читать и создавать файлы в твоём Google Drive.</p>
    <a class="btn" href="/connect/gdrive/start?t=${encodeURIComponent(t)}">
      <svg viewBox="0 0 24 24" fill="white"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Войти через Google
    </a>
    <p class="note">Ассистент получит доступ только к файлам и папкам, которые ты явно откроешь.</p>
  </div>
</body>
</html>`;
}

function gdriveSuccessHtml(email) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Google Drive подключён</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.10); text-align: center; }
    .icon { font-size: 52px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 10px; }
    p { color: #666; font-size: 15px; line-height: 1.5; }
    .email { margin-top: 12px; font-size: 14px; color: #444; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Google Drive подключён!</h1>
    <p>Вернись в Telegram — ассистент уже может работать с твоим Drive.</p>
    ${email ? `<p class="email">Аккаунт: ${email}</p>` : ''}
  </div>
</body>
</html>`;
}

function gdriveErrorHtml(msg) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ошибка</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.10); text-align: center; }
    .icon { font-size: 52px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 700; color: #d32f2f; margin-bottom: 10px; }
    p { color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Ошибка</h1>
    <p>${msg || 'Что-то пошло не так. Попробуй ещё раз через Telegram.'}</p>
  </div>
</body>
</html>`;
}

module.exports = { gdriveFormHtml, gdriveSuccessHtml, gdriveErrorHtml };
