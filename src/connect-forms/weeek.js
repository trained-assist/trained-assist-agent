// Weeek CRM connect form: L1 (API token) + optional L2 (login+password for deal comments)
// savedToken: existing token string or null
// savedLogin: { email, password } or null
function weeekFormHtml(token, savedToken, savedLogin) {
  savedLogin = savedLogin || {};
  const hasToken = !!savedToken;
  const hasLogin = !!(savedLogin.email);

  function jsStr(v) {
    return v ? JSON.stringify(String(v)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e') : 'null';
  }
  const savedTokenJs = jsStr(savedToken);
  const savedLoginJs = `{email:${jsStr(savedLogin.email)},password:${jsStr(savedLogin.password)}}`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить Weeek CRM</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:16px;padding:32px;max-width:480px;width:100%;box-shadow:0 2px 20px rgba(0,0,0,.08)}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  .sub{color:#666;font-size:14px;margin-bottom:24px;line-height:1.5}
  .saved-banner{background:#e8f5e9;color:#2e7d32;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  label{display:block;font-size:13px;font-weight:500;color:#333;margin-bottom:6px;margin-top:16px}
  label:first-of-type{margin-top:0}
  .level-badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px;vertical-align:middle;margin-left:6px}
  .l1{background:#dbeafe;color:#1d4ed8}
  .l2{background:#ede9fe;color:#6d28d9}
  input{width:100%;border:1.5px solid #e0e0e0;border-radius:10px;padding:12px 14px;font-size:15px;outline:none;transition:border .15s}
  input.mono{font-family:monospace}
  input.prefilled{border-color:#34c759;background:#f0faf3}
  input:focus{border-color:#007aff;background:#fff}
  .level-box{border:1.5px solid #e0e0e0;border-radius:12px;padding:16px;margin-top:20px}
  .level-box.l2-box{border-color:#ede9fe;background:#faf8ff}
  .level-title{font-size:13px;font-weight:600;color:#333;margin-bottom:4px}
  .level-desc{font-size:12px;color:#666;margin-bottom:12px;line-height:1.4}
  button{margin-top:20px;width:100%;background:#007aff;color:#fff;border:none;border-radius:10px;padding:13px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.88}
  button:disabled{opacity:.5;cursor:default}
  .msg{margin-top:16px;padding:12px 14px;border-radius:10px;font-size:14px;display:none}
  .msg.ok{background:#e8f5e9;color:#2e7d32}
  .msg.err{background:#fdecea;color:#c62828}
  .lock{font-size:13px;color:#999;margin-top:20px;text-align:center}
</style>
</head>
<body>
<div class="card">
  <h1>Подключить Weeek CRM</h1>
  <p class="sub">Данные поступают напрямую на сервер — в чат с ботом <b>не попадают</b>. Каждое обращение фиксируется, доступ можно отозвать через /secrets_list.</p>
  ${hasToken || hasLogin ? '<div class="saved-banner">✅ Данные сохранены с прошлого раза — можно обновить</div>' : ''}

  <div class="level-box">
    <div class="level-title">API токен <span class="level-badge l1">L1</span></div>
    <div class="level-desc">Создание сделок, контактов, задач через публичный API. Токен постоянный.<br>Weeek → Settings → Integrations → API → Generate token</div>
    <input id="tok" class="mono" type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" spellcheck="false">
  </div>

  <div class="level-box l2-box">
    <div class="level-title">Логин и пароль <span class="level-badge l2">L2</span> <span style="font-weight:400;font-size:12px;color:#666">— необязательно</span></div>
    <div class="level-desc">Нужны для добавления комментариев к сделкам через приватный API. Сессионный cookie обновляется автоматически каждые ~2 часа.</div>
    <label for="email">Email / логин</label>
    <input id="email" type="email" placeholder="you@example.com" autocomplete="username">
    <label for="password">Пароль</label>
    <input id="password" type="password" placeholder="Пароль от аккаунта Weeek" autocomplete="current-password">
  </div>

  <button id="btn" onclick="submit()">${hasToken ? 'Обновить' : 'Подключить'}</button>
  <div id="msg" class="msg"></div>
  <p class="lock">🔒 Данные изолированы от ИИ · Каждое обращение фиксируется · Отзыв: /secrets_list</p>
</div>
<script>
const T = '${token.replace(/'/g, "\\'")}';
const SAVED_TOKEN = ${savedTokenJs};
const SAVED_LOGIN = ${savedLoginJs};

window.addEventListener('DOMContentLoaded', () => {
  if (SAVED_TOKEN) {
    const el = document.getElementById('tok');
    el.value = SAVED_TOKEN;
    el.classList.add('prefilled');
    el.addEventListener('input', () => el.classList.remove('prefilled'));
  }
  if (SAVED_LOGIN && SAVED_LOGIN.email) {
    const em = document.getElementById('email');
    em.value = SAVED_LOGIN.email;
    em.classList.add('prefilled');
    em.addEventListener('input', () => em.classList.remove('prefilled'));
  }
  if (SAVED_LOGIN && SAVED_LOGIN.password) {
    const pw = document.getElementById('password');
    pw.value = SAVED_LOGIN.password;
    pw.classList.add('prefilled');
    pw.addEventListener('input', () => pw.classList.remove('prefilled'));
  }
});

async function submit() {
  const tok   = document.getElementById('tok').value.trim();
  const email = document.getElementById('email').value.trim();
  const pw    = document.getElementById('password').value;
  if (!tok) { show('err', 'Введите API токен (L1 — обязательно)'); return; }
  if ((email && !pw) || (!email && pw)) { show('err', 'Для L2 нужны оба поля: логин и пароль'); return; }
  const btn = document.getElementById('btn');
  btn.disabled = true; btn.textContent = 'Сохраняю…';
  try {
    const body = { t: T, token: tok };
    if (email && pw) { body.email = email; body.password = pw; }
    const r = await fetch(location.pathname, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) {
      const lvl = d.level || [];
      const lvlText = lvl.includes('L2') ? 'L1 + L2 (токен + комментарии)' : 'L1 (токен, создание сделок)';
      show('ok', '✅ Готово! Уровень доступа: ' + lvlText + '. Можете закрыть страницу.');
      btn.style.display = 'none';
      document.getElementById('tok').disabled = true;
      document.getElementById('email').disabled = true;
      document.getElementById('password').disabled = true;
    } else {
      show('err', d.error || 'Ошибка');
      btn.disabled = false; btn.textContent = '${hasToken ? 'Обновить' : 'Подключить'}';
    }
  } catch(e) {
    show('err', 'Сетевая ошибка: ' + e.message);
    btn.disabled = false; btn.textContent = '${hasToken ? 'Обновить' : 'Подключить'}';
  }
}
function show(cls, text) {
  const el = document.getElementById('msg');
  el.className = 'msg ' + cls; el.textContent = text; el.style.display = 'block';
}
document.getElementById('password').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
</script>
</body>
</html>`;
}

module.exports = { weeekFormHtml };
