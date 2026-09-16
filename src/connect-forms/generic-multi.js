// Generic N-field form for services created via credentials_form_create / any
// legacy service that isn't one of the specially-handled ones below in server.js.
// Renders whatever `schema.fields` the caller asked for and stores the submitted
// values as JSON in ~/agent-tokens/{userId}/{service} — same storage contract as
// the ZeroCreds-backed path, so this is a drop-in fallback when ZeroCreds is
// unreachable (not just a 404).

const LEVEL_ICON = { secret: '🔒', pii: '👤', attribute: '📋', credential: '⏱' };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// saved: plain object keyed by field name — optional, pre-fills from a prior submission
function genericMultiFormHtml(service, schema, token, saved) {
  saved = saved || {};
  const fields = Array.isArray(schema.fields) && schema.fields.length ? schema.fields : [
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'password', label: 'Пароль', type: 'password', required: true },
  ];
  const hasSaved = fields.some(f => saved[f.name]);

  const fieldsHtml = fields.map(f => {
    const icon = f.level ? (LEVEL_ICON[f.level] || '') : '';
    const inputTag = f.type === 'textarea'
      ? `<textarea id="f_${esc(f.name)}" rows="3" placeholder="${esc(f.placeholder || '')}"></textarea>`
      : `<input id="f_${esc(f.name)}" type="${esc(f.type || 'text')}" placeholder="${esc(f.placeholder || '')}" autocomplete="${f.type === 'password' ? 'current-password' : 'off'}">`;
    return `<label for="f_${esc(f.name)}">${icon ? icon + ' ' : ''}${esc(f.label || f.name)}${f.required ? '' : ' <span class="opt">(необязательно)</span>'}</label>\n  ${inputTag}`;
  }).join('\n  ');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(schema.title || service)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:16px;padding:32px;max-width:480px;width:100%;box-shadow:0 2px 20px rgba(0,0,0,.08)}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  .sub{color:#666;font-size:14px;margin-bottom:24px;line-height:1.5}
  .isolation-note{background:#f0f4ff;color:#3b5bdb;border-radius:10px;padding:10px 14px;font-size:12px;margin-bottom:20px;line-height:1.5}
  .saved-banner{background:#e8f5e9;color:#2e7d32;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
  label{display:block;font-size:13px;font-weight:500;color:#333;margin-bottom:6px;margin-top:16px}
  label:first-of-type{margin-top:0}
  .opt{font-weight:400;color:#999}
  input,textarea{width:100%;border:1.5px solid #e0e0e0;border-radius:10px;padding:12px 14px;font-size:15px;outline:none;transition:border .15s;font-family:inherit}
  input.prefilled,textarea.prefilled{border-color:#34c759;background:#f0faf3}
  input:focus,textarea:focus{border-color:#007aff;background:#fff}
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
  <h1>${esc(schema.title || service)}</h1>
  ${schema.description ? `<p class="sub">${esc(schema.description)}</p>` : ''}
  <div class="isolation-note">🔐 Данные сохраняются в изолированном хранилище — ИИ-ассистент не видит их в тексте. Он может использовать их только через специальный инструмент входа.</div>
  ${hasSaved ? '<div class="saved-banner">✅ Данные сохранены с прошлого раза — можно обновить</div>' : ''}
  ${fieldsHtml}
  <button id="btn" onclick="submit()">${hasSaved ? 'Обновить' : 'Сохранить'}</button>
  <div id="msg" class="msg"></div>
  <p class="lock">🔒 Данные изолированы от ИИ · Каждое обращение фиксируется · Отзыв: /secrets_list</p>
</div>
<script>
const T = ${JSON.stringify(token)};
const FIELDS = ${JSON.stringify(fields.map(f => ({ name: f.name, required: !!f.required })))};
const SAVED = ${JSON.stringify(saved)};

window.addEventListener('DOMContentLoaded', () => {
  FIELDS.forEach(f => {
    const v = SAVED[f.name];
    if (!v) return;
    const el = document.getElementById('f_' + f.name);
    if (!el) return;
    el.value = v;
    el.classList.add('prefilled');
    el.addEventListener('input', () => el.classList.remove('prefilled'));
  });
});

async function submit() {
  const values = {};
  for (const f of FIELDS) {
    const el = document.getElementById('f_' + f.name);
    const v = el ? el.value.trim() : '';
    if (f.required && !v) { show('err', 'Заполните обязательные поля'); return; }
    if (v) values[f.name] = v;
  }
  const btn = document.getElementById('btn');
  btn.disabled = true; btn.textContent = 'Сохраняю…';
  try {
    const r = await fetch(location.pathname, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({t: T, fields: values})
    });
    const d = await r.json();
    if (d.ok) {
      show('ok', '✅ Готово! Данные сохранены. Можете закрыть страницу.');
      btn.style.display = 'none';
      document.querySelectorAll('input,textarea').forEach(el => el.disabled = true);
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
</script>
</body>
</html>`;
}

module.exports = { genericMultiFormHtml };
