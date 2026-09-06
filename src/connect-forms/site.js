function siteFormHtml(token) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить сайт</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:16px;padding:32px;max-width:480px;width:100%;box-shadow:0 2px 20px rgba(0,0,0,.08)}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  .sub{color:#666;font-size:14px;margin-bottom:24px;line-height:1.5}
  label{display:block;font-size:13px;font-weight:500;color:#333;margin-bottom:6px;margin-top:16px}
  label:first-of-type{margin-top:0}
  input{width:100%;border:1.5px solid #e0e0e0;border-radius:10px;padding:12px 14px;font-size:15px;outline:none;transition:border .15s}
  input:focus{border-color:#007aff}
  button{margin-top:20px;width:100%;background:#007aff;color:#fff;border:none;border-radius:10px;padding:13px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.88}
  button:disabled{opacity:.5;cursor:default}
  .msg{margin-top:16px;padding:12px 14px;border-radius:10px;font-size:14px;display:none;line-height:1.5}
  .msg.ok{background:#e8f5e9;color:#2e7d32}
  .msg.err{background:#fdecea;color:#c62828}
  .msg.info{background:#e3f2fd;color:#1565c0}
  .lock{font-size:13px;color:#999;margin-top:20px;text-align:center}
</style>
</head>
<body>
<div class="card">
  <h1>🌐 Подключить сайт</h1>
  <p class="sub">Введи адрес сайта и данные для входа. Пароль поступает напрямую на сервер — <b>в чат не попадает</b>. Я автоматически зайду на сайт и исследую его.</p>

  <label for="url">Адрес сайта</label>
  <input id="url" type="url" placeholder="https://myapp.example.com" autocomplete="url">

  <label for="login">Логин / Email</label>
  <input id="login" type="text" autocomplete="username" placeholder="user@example.com">

  <label for="password">Пароль</label>
  <input id="password" type="password" autocomplete="current-password" placeholder="Пароль">

  <button id="btn" onclick="submit()">Подключить</button>
  <div id="msg" class="msg"></div>
  <p class="lock">🔒 Данные авторизации изолированы от ИИ · Каждое обращение фиксируется · Отзыв: /secrets_list</p>
</div>
<script>
const T = '${token.replace(/'/g, "\\'")}';

async function submit() {
  const url = document.getElementById('url').value.trim();
  const login = document.getElementById('login').value.trim();
  const password = document.getElementById('password').value;

  if (!url) { show('err', 'Укажи адрес сайта'); return; }
  if (!login) { show('err', 'Укажи логин или email'); return; }
  if (!password) { show('err', 'Укажи пароль'); return; }

  const btn = document.getElementById('btn');
  btn.disabled = true;
  btn.textContent = '⏳ Захожу на сайт...';
  show('info', 'Открываю сайт и ищу форму входа. Это займёт 10–30 секунд...');

  try {
    const r = await fetch('/connect/site', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ t: T, url, login, password }),
      signal: AbortSignal.timeout(60000),
    });
    const d = await r.json();
    if (d.slug) {
      show('ok', '✅ Вошёл на сайт! Сейчас исследую страницы — пришлю уведомление в бот когда закончу (30–90 сек). Можно закрыть эту страницу.');
      btn.style.display = 'none';
      document.querySelectorAll('input').forEach(el => el.disabled = true);
    } else {
      show('err', d.error || 'Не удалось подключиться');
      btn.disabled = false; btn.textContent = 'Попробовать снова';
    }
  } catch(e) {
    show('err', 'Ошибка: ' + e.message);
    btn.disabled = false; btn.textContent = 'Попробовать снова';
  }
}

function show(cls, text) {
  const el = document.getElementById('msg');
  el.className = 'msg ' + cls; el.textContent = text; el.style.display = 'block';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter') submit();
});
</script>
</body>
</html>`;
}

module.exports = { siteFormHtml };
