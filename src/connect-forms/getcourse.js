// saved: { domain, apiKey, login, password, hasSession } — all optional
function getcourseFormHtml(token, saved) {
  saved = saved || {};
  const hasSaved = !!(saved.domain || saved.apiKey || saved.login);
  function jsStr(v) { return v ? JSON.stringify(String(v)) : 'null'; }
  const savedJs = `{domain:${jsStr(saved.domain)},apiKey:${jsStr(saved.apiKey)},login:${jsStr(saved.login)},password:${jsStr(saved.password)},hasSession:${!!saved.hasSession}}`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить GetCourse</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:16px;padding:32px;max-width:480px;width:100%;box-shadow:0 2px 20px rgba(0,0,0,.08)}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  .sub{color:#666;font-size:14px;margin-bottom:24px;line-height:1.5}
  .saved-banner{background:#e8f5e9;color:#2e7d32;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  label{display:block;font-size:13px;font-weight:500;color:#333;margin-bottom:6px;margin-top:16px}
  label:first-of-type{margin-top:0}
  input{width:100%;border:1.5px solid #e0e0e0;border-radius:10px;padding:12px 14px;font-size:15px;outline:none;transition:border .15s}
  input.prefilled{border-color:#34c759;background:#f0faf3}
  input:focus{border-color:#007aff;background:#fff}
  .divider{display:flex;align-items:center;gap:10px;margin:20px 0 4px}
  .divider-line{flex:1;height:1px;background:#e0e0e0}
  .divider-label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;padding:0 4px}
  .l1-label{color:#1db87a}
  .l2-label{color:#8b5cf6}
  .opt{font-size:11px;color:#999;font-weight:400;margin-left:4px}
  .session-badge{display:inline-block;background:#e8f5e9;color:#2e7d32;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:600;margin-left:6px}
  button{margin-top:20px;width:100%;background:#007aff;color:#fff;border:none;border-radius:10px;padding:13px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.88}
  button:disabled{opacity:.5;cursor:default}
  .msg{margin-top:16px;padding:12px 14px;border-radius:10px;font-size:14px;display:none}
  .msg.ok{background:#e8f5e9;color:#2e7d32}
  .msg.err{background:#fdecea;color:#c62828}
  .msg.info{background:#e3f2fd;color:#1565c0}
  .hint{font-size:12px;color:#999;margin-top:6px;line-height:1.4}
  .lock{font-size:13px;color:#999;margin-top:20px;text-align:center}
  #done{display:none;text-align:center}
  #done .icon{font-size:48px;margin-bottom:12px}
</style>
</head>
<body>
<div class="card">
  <div id="form-view">
    <h1>Подключить GetCourse</h1>
    <p class="sub">Данные не попадают в чат — форма отправляет их напрямую на сервер.</p>

    ${hasSaved ? '<div class="saved-banner">✅ Данные сохранены с прошлого раза — можно переподключить или изменить</div>' : ''}

    <label for="domain">Домен аккаунта</label>
    <input id="domain" type="text" placeholder="myschool.getcourse.ru" autocomplete="off" spellcheck="false">

    <div class="divider">
      <div class="divider-line"></div>
      <div class="divider-label l1-label">Уровень 1 — API</div>
      <div class="divider-line"></div>
    </div>

    <label for="apiKey">API ключ <span class="opt">— необязательно</span></label>
    <input id="apiKey" type="text" placeholder="Из настроек GetCourse → Интеграции → API" autocomplete="off" spellcheck="false">
    <div class="hint">Даёт доступ к управлению учениками, группами и заказами</div>

    <div class="divider">
      <div class="divider-line"></div>
      <div class="divider-label l2-label">Уровень 2 — Сессия${hasSaved && saved.hasSession ? '<span class="session-badge">активна</span>' : ''}</div>
      <div class="divider-line"></div>
    </div>

    <label for="login">Логин <span class="opt">— необязательно</span></label>
    <input id="login" type="email" placeholder="admin@myschool.ru" autocomplete="username">
    <label for="password">Пароль <span class="opt">— необязательно</span></label>
    <input id="password" type="password" autocomplete="current-password" placeholder="Пароль от аккаунта">
    <div class="hint">Даёт доступ к созданию курсов, уроков, загрузке видео. Вход занимает 15–30 сек.</div>

    <button id="btn" onclick="submit()">${hasSaved ? 'Переподключить' : 'Подключить'}</button>
    <div id="msg" class="msg"></div>
  </div>

  <div id="done">
    <div class="icon">✅</div>
    <h1>GetCourse подключён!</h1>
    <p class="sub" id="done-text">Настройки сохранены. Можете закрыть страницу и вернуться в бот.</p>
  </div>

  <p class="lock">🔒 Соединение защищено · Ссылка одноразовая</p>
</div>
<script>
const T = '${token.replace(/'/g, "\\'")}';
const SAVED = ${savedJs};

window.addEventListener('DOMContentLoaded', () => {
  if (!SAVED) return;
  const fields = [
    {id: 'domain',   key: 'domain'},
    {id: 'apiKey',   key: 'apiKey'},
    {id: 'login',    key: 'login'},
    {id: 'password', key: 'password'},
  ];
  for (const {id, key} of fields) {
    if (!SAVED[key]) continue;
    const el = document.getElementById(id);
    el.value = SAVED[key];
    el.classList.add('prefilled');
    el.addEventListener('input', () => el.classList.remove('prefilled'));
  }
});

function showMsg(cls, text) {
  const el = document.getElementById('msg');
  el.className = 'msg ' + cls; el.textContent = text; el.style.display = 'block';
}

async function submit() {
  const domain   = document.getElementById('domain').value.trim();
  const apiKey   = document.getElementById('apiKey').value.trim();
  const login    = document.getElementById('login').value.trim();
  const password = document.getElementById('password').value;

  if (!domain) { showMsg('err', 'Введите домен аккаунта'); return; }
  if (!apiKey && !(login && password)) { showMsg('err', 'Заполните хотя бы одно поле: API ключ или логин + пароль'); return; }
  if (login && !password) { showMsg('err', 'Введите пароль (вместе с логином)'); return; }

  const btn = document.getElementById('btn');
  btn.disabled = true;
  btn.textContent = login ? 'Подключаюсь… (до 30 сек)' : 'Сохраняю…';
  showMsg('info', login ? '⏳ Открываю браузер и вхожу в аккаунт…' : '⏳ Сохраняю настройки…');

  try {
    const r = await fetch(location.pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: T, domain: domain, apiKey: apiKey || undefined, login: login || undefined, password: password || undefined }),
      signal: AbortSignal.timeout(95000),
    });
    const d = await r.json();
    if (d.error) {
      showMsg('err', d.error);
      btn.disabled = false; btn.textContent = 'Переподключить';
      return;
    }
    const levelText = { 'L1+L2': 'API + сессия (полный доступ)', 'L1': 'API (управление учениками)', 'L2': 'Сессия (создание курсов)' }[d.level] || d.level;
    document.getElementById('done-text').textContent = 'Настройки сохранены (' + levelText + '). Можете закрыть страницу.';
    document.getElementById('form-view').style.display = 'none';
    document.getElementById('done').style.display = 'block';
  } catch(e) {
    showMsg('err', e.name === 'TimeoutError' ? 'Превышено время ожидания — попробуйте ещё раз' : 'Ошибка: ' + e.message);
    btn.disabled = false; btn.textContent = 'Переподключить';
  }
}

document.getElementById('password').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
</script>
</body>
</html>`;
}

module.exports = { getcourseFormHtml };
