'use strict';

function fmtSalary(salary) {
  if (!salary) return null;
  const from = salary.from ? salary.from.toLocaleString('ru-RU') : null;
  const to = salary.to ? salary.to.toLocaleString('ru-RU') : null;
  const cur = salary.currency === 'RUR' ? '₽' : (salary.currency || '');
  if (from && to) return `${from}–${to} ${cur}/мес`;
  if (from) return `от ${from} ${cur}/мес`;
  if (to) return `до ${to} ${cur}/мес`;
  return null;
}

function fmtDate(iso) {
  if (!iso) return '…';
  return iso.slice(0, 7).replace('-', '.');
}

function tagColor(tag) {
  if (tag === 'PASS') return '#16a34a';
  if (tag === 'REVIEW') return '#ca8a04';
  return '#6b7280';
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function candidateCard(c, idx) {
  const salary = fmtSalary(c.salary);
  const companies = c.recent_companies.slice(0, 3).join(', ');
  const signals = (c.score_signals || []).map(s => `<span class="signal">${escHtml(s)}</span>`).join('');
  const expRows = (c.experience || []).map(e =>
    `<li>${escHtml(e.position)} — ${escHtml(e.company)} (${fmtDate(e.start)}–${fmtDate(e.end)})</li>`
  ).join('');

  return `<div class="card" data-idx="${idx}" data-id="${escHtml(c.id)}">
  <div class="card-header">
    <div class="card-left">
      <a class="card-title" href="${escHtml(c.hh_url)}" target="_blank" rel="noopener">${escHtml(c.title)}</a>
      <div class="card-meta">
        ${c.age ? `${c.age} лет · ` : ''}${c.total_exp_years} лет опыта · ${escHtml(c.area)}
        ${salary ? ` · <span class="salary">${escHtml(salary)}</span>` : ''}
      </div>
      ${companies ? `<div class="card-companies">${escHtml(companies)}</div>` : ''}
    </div>
    <div class="card-right">
      <span class="badge" style="background:${tagColor(c.tag)}">${escHtml(c.tag)} ${c.score.toFixed(1)}</span>
    </div>
  </div>
  ${signals ? `<div class="signals">${signals}</div>` : ''}
  ${expRows ? `<ul class="exp-list">${expRows}</ul>` : ''}
  <button class="btn-ai" onclick="openAiModal('${escHtml(c.id)}','${escHtml(c.title)}')">AI оценить</button>
</div>`;
}

function generateProactivePageHtml(results, username, callbackBase, token) {
  const candidates = results.candidates || [];
  const PER_PAGE = 10;
  const totalPages = Math.max(1, Math.ceil(candidates.length / PER_PAGE));
  const searchedAt = results.searched_at ? new Date(results.searched_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—';
  const passCount = candidates.filter(c => c.tag === 'PASS').length;
  const reviewCount = candidates.filter(c => c.tag === 'REVIEW').length;

  // Pre-render all cards as JSON-safe HTML chunks
  const cardChunks = candidates.map((c, i) => candidateCard(c, i));
  const cardsJson = JSON.stringify(cardChunks);
  const candidatesJson = JSON.stringify(candidates.map(c => ({ id: c.id, title: c.title })));

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проактивный поиск — ${escHtml(results.vacancy_title || 'Вакансия')}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f8fafc;color:#1e293b;min-height:100vh}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}
.header{background:#fff;border-bottom:1px solid #e2e8f0;padding:16px 24px;position:sticky;top:0;z-index:10}
.header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.vacancy-title{font-size:1.1rem;font-weight:600;color:#1e293b}
.searched-at{font-size:.8rem;color:#94a3b8;margin-top:2px}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px}
.stat{background:#f1f5f9;border-radius:6px;padding:4px 10px;font-size:.82rem;color:#475569}
.stat strong{color:#1e293b}
.btn-search{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:.85rem;cursor:pointer;white-space:nowrap}
.btn-search:hover{background:#1d4ed8}
.btn-search:disabled{opacity:.6;cursor:not-allowed}
.main{max-width:900px;margin:0 auto;padding:20px 16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:12px}
.card-header{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.card-left{flex:1;min-width:0}
.card-title{font-size:1rem;font-weight:600;display:block;margin-bottom:4px}
.card-meta{font-size:.82rem;color:#64748b;margin-bottom:4px}
.salary{color:#16a34a;font-weight:500}
.card-companies{font-size:.8rem;color:#94a3b8;margin-bottom:6px}
.card-right{flex-shrink:0}
.badge{display:inline-block;color:#fff;border-radius:5px;padding:3px 8px;font-size:.78rem;font-weight:700;letter-spacing:.03em}
.signals{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;margin-bottom:8px}
.signal{background:#f1f5f9;color:#475569;border-radius:4px;padding:2px 7px;font-size:.75rem}
.exp-list{margin:6px 0 8px 18px;font-size:.8rem;color:#64748b;line-height:1.5}
.btn-ai{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:5px 12px;font-size:.8rem;cursor:pointer;color:#1e293b;margin-top:4px}
.btn-ai:hover{background:#e2e8f0}
.pagination{display:flex;align-items:center;justify-content:center;gap:12px;margin:20px 0}
.btn-page{background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:7px 16px;font-size:.85rem;cursor:pointer}
.btn-page:hover:not(:disabled){background:#f1f5f9}
.btn-page:disabled{opacity:.4;cursor:not-allowed}
.page-info{font-size:.85rem;color:#64748b}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:#fff;border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;position:relative}
.modal-close{position:absolute;top:12px;right:12px;background:none;border:none;font-size:1.2rem;cursor:pointer;color:#64748b;line-height:1}
.modal-title{font-size:1rem;font-weight:600;margin-bottom:4px}
.modal-subtitle{font-size:.8rem;color:#94a3b8;margin-bottom:16px}
.modal-body{font-size:.9rem;line-height:1.6;color:#1e293b}
.modal-score{margin-top:12px;padding:10px;background:#f1f5f9;border-radius:6px;font-size:.85rem}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:60px;color:#94a3b8}
@media(max-width:600px){.card-header{flex-direction:column}.card-right{align-self:flex-end}.header-top{flex-direction:column}}
@media(prefers-color-scheme:dark){
  body{background:#0f172a;color:#e2e8f0}
  .header{background:#1e293b;border-color:#334155}
  .card{background:#1e293b;border-color:#334155}
  .btn-search{background:#3b82f6}
  .stat{background:#0f172a}
  .stat strong,.card-left,.vacancy-title{color:#e2e8f0}
  .card-meta,.page-info{color:#94a3b8}
  .btn-page{background:#1e293b;border-color:#334155;color:#e2e8f0}
  .btn-page:hover:not(:disabled){background:#334155}
  .signal{background:#334155;color:#94a3b8}
  .btn-ai{background:#334155;border-color:#475569;color:#e2e8f0}
  .btn-ai:hover{background:#475569}
  .modal{background:#1e293b;color:#e2e8f0}
  .modal-score{background:#0f172a}
}
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div>
      <div class="vacancy-title">${escHtml(results.vacancy_title || 'Проактивный поиск')}</div>
      <div class="searched-at">Поиск: ${escHtml(searchedAt)}</div>
    </div>
    <button class="btn-search" id="searchBtn" onclick="runSearch()">🔍 Новый поиск</button>
  </div>
  <div class="stats">
    <div class="stat">Собрано: <strong>${results.total_collected || 0}</strong></div>
    <div class="stat">После фильтра: <strong>${results.total_after_knockout || 0}</strong></div>
    <div class="stat">PASS: <strong style="color:#16a34a">${passCount}</strong></div>
    <div class="stat">REVIEW: <strong style="color:#ca8a04">${reviewCount}</strong></div>
  </div>
</div>

<div class="main">
  <div id="cards"></div>
  <div class="pagination">
    <button class="btn-page" id="prevBtn" onclick="changePage(-1)" disabled>← Назад</button>
    <span class="page-info" id="pageInfo"></span>
    <button class="btn-page" id="nextBtn" onclick="changePage(1)">Вперёд →</button>
  </div>
</div>

<div class="modal-overlay" id="modal">
  <div class="modal">
    <button class="modal-close" onclick="closeModal()" title="Закрыть">✕</button>
    <div class="modal-title" id="modalTitle"></div>
    <div class="modal-subtitle" id="modalSubtitle"></div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-score" id="modalScore" style="display:none"></div>
  </div>
</div>

<script>
const CARDS = ${cardsJson};
const PER_PAGE = 10;
const TOTAL = CARDS.length;
const TOTAL_PAGES = Math.max(1, Math.ceil(TOTAL / PER_PAGE));
const USERNAME = ${JSON.stringify(username)};
const TOKEN = ${JSON.stringify(token)};
const CALLBACK_BASE = ${JSON.stringify(callbackBase)};
let currentPage = 1;

function renderPage() {
  const start = (currentPage - 1) * PER_PAGE;
  const end = Math.min(start + PER_PAGE, TOTAL);
  const slice = CARDS.slice(start, end);
  document.getElementById('cards').innerHTML = slice.length
    ? slice.join('')
    : '<div class="empty">Нет кандидатов</div>';
  document.getElementById('pageInfo').textContent = 'Страница ' + currentPage + ' из ' + TOTAL_PAGES + ' (' + TOTAL + ' кандидатов)';
  document.getElementById('prevBtn').disabled = currentPage <= 1;
  document.getElementById('nextBtn').disabled = currentPage >= TOTAL_PAGES;
  window.scrollTo(0, 0);
}

function changePage(delta) {
  const next = currentPage + delta;
  if (next < 1 || next > TOTAL_PAGES) return;
  currentPage = next;
  renderPage();
}

document.addEventListener('keydown', e => {
  if (document.getElementById('modal').classList.contains('open')) return;
  if (e.key === 'ArrowRight') changePage(1);
  if (e.key === 'ArrowLeft') changePage(-1);
});

function openAiModal(candidateId, title) {
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSubtitle').textContent = 'AI-оценка кандидата';
  document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:24px"><div class="spinner"></div><div style="margin-top:8px;color:#94a3b8">Загрузка…</div></div>';
  document.getElementById('modalScore').style.display = 'none';
  modal.classList.add('open');

  fetch(CALLBACK_BASE + '/api/hh/proactive/ai-score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, candidate_id: candidateId, token: TOKEN }),
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) {
      document.getElementById('modalBody').innerHTML = '<span style="color:#dc2626">Ошибка: ' + escHtml(data.error) + '</span>';
      return;
    }
    const evalHtml = renderMarkdown(data.evaluation || '');
    document.getElementById('modalBody').innerHTML = evalHtml;
    const scoreEl = document.getElementById('modalScore');
    const tagColor = data.tag === 'PASS' ? '#16a34a' : data.tag === 'REVIEW' ? '#ca8a04' : '#6b7280';
    scoreEl.innerHTML = 'AI оценка: <span style="background:' + tagColor + ';color:#fff;border-radius:4px;padding:2px 8px;font-weight:700">' + escHtml(data.tag) + ' ' + (data.score || 0) + '</span>';
    scoreEl.style.display = 'block';
  })
  .catch(e => {
    document.getElementById('modalBody').innerHTML = '<span style="color:#dc2626">Ошибка запроса: ' + escHtml(e.message) + '</span>';
  });
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}
document.getElementById('modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

function renderMarkdown(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g,'<em>$1</em>')
    .replace(/\\n/g,'<br>');
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function runSearch() {
  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Идёт поиск…';
  try {
    const res = await fetch(CALLBACK_BASE + '/api/hh/proactive/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, token: TOKEN }),
    });
    const data = await res.json();
    if (data.error) {
      alert('Ошибка: ' + data.error);
      btn.disabled = false;
      btn.textContent = '🔍 Новый поиск';
    } else {
      btn.textContent = '✅ Готово! Обновляем…';
      setTimeout(() => location.reload(), 1200);
    }
  } catch (e) {
    alert('Ошибка: ' + e.message);
    btn.disabled = false;
    btn.textContent = '🔍 Новый поиск';
  }
}

renderPage();
</script>
</body>
</html>`;
}

module.exports = { generateProactivePageHtml };
