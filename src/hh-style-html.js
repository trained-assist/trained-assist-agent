'use strict';

// Generates the HH style-update page HTML.
// opts: { username, rulesValue, baseValue, hasBaseOverride, callbackBase, hmacToken }

function hhStylePageHtml(opts = {}) {
  const { username = '', rulesValue = '', baseValue = '', hasBaseOverride = false, callbackBase = '', hmacToken = '' } = opts;

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Стиль общения — ${username}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0;padding:24px;background:#f8fafc;color:#1e293b;max-width:720px;margin:0 auto}
h1{font-size:1.4rem;margin-bottom:4px}
p.sub{color:#64748b;margin:0 0 16px;font-size:.9rem}
h2{font-size:1rem;margin:24px 0 6px;color:#1e293b}
textarea{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font-size:.9rem;line-height:1.5;resize:vertical;background:#fff;color:#1e293b}
textarea::placeholder{color:#94a3b8}
.hint{color:#64748b;font-size:.82rem;margin:6px 0 12px}
button{border:none;padding:10px 24px;border-radius:8px;font-size:.95rem;cursor:pointer;font-weight:600}
.btn-primary{background:#2563eb;color:#fff}
.btn-primary:hover{background:#1d4ed8}
.btn-secondary{background:#e2e8f0;color:#334155}
.btn-secondary:hover{background:#cbd5e1}
button:disabled{opacity:.5;cursor:not-allowed}
.sep{border:none;border-top:1px solid #e2e8f0;margin:28px 0}
.status{margin-top:12px;padding:10px 14px;border-radius:8px;font-size:.9rem;display:none}
.status.ok{background:#dcfce7;color:#166534;display:block}
.status.err{background:#fee2e2;color:#991b1b;display:block}
.status.loading{background:#fef9c3;color:#713f12;display:block}
</style>
</head><body>
<h1>✍️ Стиль общения с кандидатами</h1>
<p class="sub">Правила применяются при генерации сообщений. Отредактируй напрямую или загрузи из примеров диалогов.</p>

<h2>Правила стиля</h2>
<textarea id="rules" rows="10" placeholder="- Тон: ...\n- Приветствие: ...\n- Структура: ...">${rulesValue}</textarea>
<div class="hint">Можно писать в свободной форме — список правил, описание тона, любые инструкции.</div>
<button class="btn-primary" id="btnSave" onclick="saveRules()">Сохранить правила</button>
<div class="status" id="statusSave"></div>

<hr class="sep">

<h2>Или загрузить из примеров / диалогов</h2>
<p class="sub" style="margin-bottom:10px">Можно кидать прямо диалоги целиком — поймём где вы, где кандидат. AI извлечёт правила стиля и заполнит поле выше.</p>
<textarea id="examples" rows="8" placeholder="Рекрутер: Добрый день, Иван! Посмотрела ваше резюме...
Кандидат: Здравствуйте! Да, интересно узнать подробности.
Рекрутер: Отлично! Расскажите, есть ли у вас опыт..."></textarea>
<div class="hint">Примеры используются только для извлечения стиля и не сохраняются.</div>
<button class="btn-secondary" id="btnExtract" onclick="extractStyle()">Извлечь стиль из примеров</button>
<div class="status" id="statusExtract"></div>

<hr class="sep">

<h2>Базовый сценарий сообщений (продвинутое)</h2>
<p class="sub" style="margin-bottom:10px">Это сама инструкция ИИ — что писать в первом сообщении, follow-up, ответе, отказе, как обращаться со временем звонка. Правила стиля выше добавляются поверх неё. Меняй только если понимаешь, на что влияет.</p>
<textarea id="basePrompt" rows="14">${baseValue}</textarea>
<div class="hint">${hasBaseOverride ? '⚙️ Сейчас используется твоя версия (переопределяет умолчание).' : 'Сейчас используется версия по умолчанию — правки ниже создадут переопределение.'}</div>
<button class="btn-primary" id="btnSaveBase" onclick="saveBasePrompt()">Сохранить сценарий</button>
<button class="btn-secondary" id="btnResetBase" onclick="resetBasePrompt()">Сбросить к умолчанию</button>
<div class="status" id="statusBase"></div>

<script>
async function saveRules() {
  const text = document.getElementById('rules').value.trim();
  if (!text || text.length < 10) { show('statusSave', 'err', 'Правила не могут быть пустыми.'); return; }
  document.getElementById('btnSave').disabled = true;
  show('statusSave', 'loading', 'Сохраняю...');
  try {
    const r = await fetch('${callbackBase}/hh/update-style', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: '${username}', token: '${hmacToken}', examples: text, direct: true}),
    });
    const d = await r.json();
    if (d.ok) show('statusSave', 'ok', '✅ Правила сохранены! Применятся при следующей генерации сообщений.');
    else show('statusSave', 'err', 'Ошибка: ' + (d.error || 'неизвестная'));
  } catch(e) { show('statusSave', 'err', 'Сетевая ошибка: ' + e.message); }
  document.getElementById('btnSave').disabled = false;
}
async function extractStyle() {
  const text = document.getElementById('examples').value.trim();
  if (!text || text.length < 50) { show('statusExtract', 'err', 'Вставь хотя бы пару примеров (мин. 50 символов).'); return; }
  document.getElementById('btnExtract').disabled = true;
  show('statusExtract', 'loading', 'Анализирую примеры... 5–15 секунд...');
  try {
    const r = await fetch('${callbackBase}/hh/update-style', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: '${username}', token: '${hmacToken}', examples: text, direct: false, save: false}),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('rules').value = d.style;
      show('statusExtract', 'ok', '✅ Стиль извлечён — проверь поле «Правила стиля» выше и нажми «Сохранить».');
    } else {
      show('statusExtract', 'err', 'Ошибка: ' + (d.error || 'неизвестная'));
    }
  } catch(e) { show('statusExtract', 'err', 'Сетевая ошибка: ' + e.message); }
  document.getElementById('btnExtract').disabled = false;
}
async function saveBasePrompt() {
  const text = document.getElementById('basePrompt').value.trim();
  if (!text || text.length < 50) { show('statusBase', 'err', 'Сценарий подозрительно короткий — проверь текст.'); return; }
  document.getElementById('btnSaveBase').disabled = true;
  show('statusBase', 'loading', 'Сохраняю...');
  try {
    const r = await fetch('${callbackBase}/hh/update-base-prompt', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: '${username}', token: '${hmacToken}', text}),
    });
    const d = await r.json();
    if (d.ok) show('statusBase', 'ok', '✅ Сценарий сохранён! Применится при следующей генерации сообщений.');
    else show('statusBase', 'err', 'Ошибка: ' + (d.error || 'неизвестная'));
  } catch(e) { show('statusBase', 'err', 'Сетевая ошибка: ' + e.message); }
  document.getElementById('btnSaveBase').disabled = false;
}
async function resetBasePrompt() {
  if (!confirm('Вернуть сценарий по умолчанию? Твои правки к нему будут удалены.')) return;
  document.getElementById('btnResetBase').disabled = true;
  show('statusBase', 'loading', 'Сбрасываю...');
  try {
    const r = await fetch('${callbackBase}/hh/update-base-prompt', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: '${username}', token: '${hmacToken}', reset: true}),
    });
    const d = await r.json();
    if (d.ok) { document.getElementById('basePrompt').value = d.text; show('statusBase', 'ok', '✅ Сброшено к умолчанию.'); }
    else show('statusBase', 'err', 'Ошибка: ' + (d.error || 'неизвестная'));
  } catch(e) { show('statusBase', 'err', 'Сетевая ошибка: ' + e.message); }
  document.getElementById('btnResetBase').disabled = false;
}
function show(id, type, msg) {
  const s = document.getElementById(id);
  s.className = 'status ' + type; s.textContent = msg;
}
</script>
</body></html>`;
}

module.exports = { hhStylePageHtml };
