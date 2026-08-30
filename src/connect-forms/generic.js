function connectFormHtml(service, meta, token) {
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
  label{display:block;font-size:13px;font-weight:500;color:#333;margin-bottom:6px}
  input{width:100%;border:1.5px solid #e0e0e0;border-radius:10px;padding:12px 14px;font-size:15px;font-family:monospace;outline:none;transition:border .15s}
  input:focus{border-color:#007aff}
  button{margin-top:16px;width:100%;background:#007aff;color:#fff;border:none;border-radius:10px;padding:13px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .15s}
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
  <p class="sub">Данные для входа поступают напрямую на сервер — в чат с ботом <b>не попадают</b>. Каждое обращение фиксируется, доступ можно отозвать через /secrets_list.<br><br>${meta.hint}</p>
  <label for="tok">Данные для авторизации</label>
  <input id="tok" type="password" placeholder="${meta.placeholder}" autocomplete="off" spellcheck="false">
  <button id="btn" onclick="submit()">Подключить</button>
  <div id="msg" class="msg"></div>
  <p class="lock">🔒 Данные авторизации изолированы от ИИ · Каждое обращение фиксируется · Отзыв: /secrets_list</p>
</div>
<script>
const T = '${token.replace(/'/g, "\\'")}';
const SERVICE = '${service}';
async function submit() {
  const v = document.getElementById('tok').value.trim();
  if (!v) { show('err', 'Введите данные для входа'); return; }
  const btn = document.getElementById('btn');
  btn.disabled = true; btn.textContent = 'Подключаю…';
  try {
    const r = await fetch(location.pathname, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({t: T, value: v})
    });
    const d = await r.json();
    if (d.ok) {
      show('ok', '✅ Готово! Можете закрыть страницу и вернуться в бот.');
      btn.style.display = 'none';
      document.getElementById('tok').disabled = true;
    } else {
      show('err', d.error || 'Ошибка');
      btn.disabled = false; btn.textContent = 'Подключить';
    }
  } catch(e) {
    show('err', 'Сетевая ошибка: ' + e.message);
    btn.disabled = false; btn.textContent = 'Подключить';
  }
}
function show(cls, text) {
  const el = document.getElementById('msg');
  el.className = 'msg ' + cls; el.textContent = text; el.style.display = 'block';
}
document.getElementById('tok').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
</script>
</body>
</html>`;
}

module.exports = { connectFormHtml };
