// Two-field form (email + password) for services that need browser-based autologin.
// Credentials are stored as JSON {email, password} in ~/agent-tokens/{userId}/{service}
// so Claude can call autologin tools without seeing the raw credentials.

// saved: { email, password } — optional, pre-fills from prior submission
function loginCredsFormHtml(service, meta, token, saved) {
  saved = saved || {};
  const hasSaved = !!(saved.email);
  function jsStr(v) { return v ? JSON.stringify(String(v)) : 'null'; }
  const savedJs = `{email:${jsStr(saved.email)},password:${jsStr(saved.password)}}`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить ${meta.name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:16px;padding:32px;max-width:480px;width:100%;box-shadow:0 2px 20px rgba(0,0,0,.08)}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  .sub{color:#666;font-size:14px;margin-bottom:24px;line-height:1.5}
  .sub a{color:#007aff;text-decoration:none}
  .saved-banner{background:#e8f5e9;color:#2e7d32;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  .isolation-note{background:#f0f4ff;color:#3b5bdb;border-radius:10px;padding:10px 14px;font-size:12px;margin-bottom:20px;line-height:1.5}
  label{display:block;font-size:13px;font-weight:500;color:#333;margin-bottom:6px;margin-top:16px}
  label:first-of-type{margin-top:0}
  input{width:100%;border:1.5px solid #e0e0e0;border-radius:10px;padding:12px 14px;font-size:15px;outline:none;transition:border .15s}
  input.prefilled{border-color:#34c759;background:#f0faf3}
  input:focus{border-color:#007aff;background:#fff}
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
  <h1>Подключить ${meta.name}</h1>
  <p class="sub">${meta.hint}</p>
  <div class="isolation-note">🔐 Данные сохраняются в изолированном хранилище — ИИ-ассистент не видит их в тексте. Он может использовать их только через специальный инструмент входа.</div>
  ${hasSaved ? '<div class="saved-banner">✅ Данные сохранены с прошлого раза — можно обновить</div>' : ''}
  <label for="email">${meta.emailLabel || 'Email / логин'}</label>
  <input id="email" type="email" placeholder="${meta.emailPlaceholder || 'you@example.com'}" autocomplete="username">
  <label for="password">Пароль</label>
  <input id="password" type="password" placeholder="Пароль от аккаунта" autocomplete="current-password">
  <button id="btn" onclick="submit()">${hasSaved ? 'Обновить' : 'Сохранить'}</button>
  <div id="msg" class="msg"></div>
  <p class="lock">🔒 Данные изолированы от ИИ · Каждое обращение фиксируется · Отзыв: /secrets_list</p>
</div>
<script>
const T = '${token.replace(/'/g, "\\'")}';
const SAVED = ${savedJs};

window.addEventListener('DOMContentLoaded', () => {
  if (!SAVED) return;
  if (SAVED.email) {
    const el = document.getElementById('email');
    el.value = SAVED.email;
    el.classList.add('prefilled');
    el.addEventListener('input', () => el.classList.remove('prefilled'));
  }
  if (SAVED.password) {
    const el = document.getElementById('password');
    el.value = SAVED.password;
    el.classList.add('prefilled');
    el.addEventListener('input', () => el.classList.remove('prefilled'));
  }
});

async function submit() {
  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!email)    { show('err', 'Введите email'); return; }
  if (!password) { show('err', 'Введите пароль'); return; }
  const btn = document.getElementById('btn');
  btn.disabled = true; btn.textContent = 'Сохраняю…';
  try {
    const r = await fetch(location.pathname, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({t: T, email, password})
    });
    const d = await r.json();
    if (d.ok) {
      show('ok', '✅ Готово! Данные сохранены. Можете закрыть страницу.');
      btn.style.display = 'none';
      document.getElementById('email').disabled = true;
      document.getElementById('password').disabled = true;
    } else {
      show('err', d.error || 'Ошибка');
      btn.disabled = false; btn.textContent = '${hasSaved ? 'Обновить' : 'Сохранить'}';
    }
  } catch(e) {
    show('err', 'Сетевая ошибка: ' + e.message);
    btn.disabled = false; btn.textContent = '${hasSaved ? 'Обновить' : 'Сохранить'}';
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

module.exports = { loginCredsFormHtml };
