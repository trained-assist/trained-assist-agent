'use strict';

// Generates the ATS Template Editor HTML page.
// opts: { callbackBase, username, agentSecret }
// currentConfig: the saved ats_config value (may be null)

const TEMPLATES = {
  webinar: {
    label: 'Вебинарный специалист',
    stages: ['Скрининг резюме', 'Тестовое задание', 'Интервью с тимлидом', 'Оффер'],
    config: {
      vacancy_title: 'Вебинарный специалист / Webinar Manager',
      vacancy_context: 'Проведение обучающих и продающих вебинаров, взаимодействие с аудиторией, работа с платформами (Zoom, Bizon365, Webinar.ru).',
      knockout: [
        'Нет опыта проведения онлайн-мероприятий / вебинаров',
        'Нет навыков публичных выступлений',
      ],
      required: [
        { name: 'Опыт проведения вебинаров / онлайн-мероприятий', weight: 3.0 },
        { name: 'Работа с вебинарными платформами (Zoom, Bizon365, Webinar.ru)', weight: 2.5 },
        { name: 'Навыки презентации и публичных выступлений', weight: 2.5 },
      ],
      preferred: [
        { name: 'Опыт в EdTech или онлайн-образовании', weight: 1.5 },
        { name: 'Продающие вебинары / конверсия', weight: 1.5 },
        { name: 'Работа с чатами и модерация аудитории', weight: 1.0 },
        { name: 'Базовая работа с видео и стримингом (OBS, Restream)', weight: 1.0 },
      ],
      filters: { min_experience_years: 1, remote_ok: true, salary_max_rub: null },
      pass_threshold: 7.0,
      review_threshold: 4.5,
    },
  },
  marketing: {
    label: 'Маркетолог',
    stages: ['Первичный скрининг', 'Тестовое задание', 'Интервью с CMO', 'Оффер'],
    config: {
      vacancy_title: 'Маркетолог / Marketing Manager',
      vacancy_context: 'Продвижение B2C/B2B продуктов. Работа с рекламными каналами, аналитика, контент.',
      knockout: [
        'Нет опыта в digital-маркетинге от 1 года',
        'Незнание базовых метрик (CTR, CPC, ROI, ROAS)',
      ],
      required: [
        { name: 'Digital marketing (SEO/SEM/SMM)', weight: 2.5 },
        { name: 'Аналитика (Google Analytics, Яндекс.Метрика)', weight: 2.0 },
        { name: 'Работа с рекламными кабинетами', weight: 2.0 },
      ],
      preferred: [
        { name: 'CRM-системы', weight: 1.0 },
        { name: 'A/B тестирование', weight: 1.0 },
        { name: 'Автоматизация маркетинга', weight: 1.0 },
      ],
      filters: { min_experience_years: 2, remote_ok: true, salary_max_rub: null },
      pass_threshold: 6.0,
      review_threshold: 4.0,
    },
  },
  cpp3d: {
    label: 'C++ / 3D Программист',
    stages: ['Просмотр портфолио', 'Технический тест', 'Техническое интервью', 'Интервью с лидом', 'Оффер'],
    config: {
      vacancy_title: 'C++ / 3D Программист',
      vacancy_context: 'Разработка рендеринга реального времени, симуляций или игровых систем.',
      knockout: [
        'Нет коммерческого C++ от 2 лет',
        'Нет портфолио с 3D-проектами',
        'Незнание линейной алгебры (матрицы, кватернионы)',
      ],
      required: [
        { name: 'C++ (STL, C++17/20)', weight: 3.0 },
        { name: '3D-математика (матрицы, кватернионы, трансформации)', weight: 2.5 },
        { name: 'OpenGL / DirectX / Vulkan / Metal', weight: 2.5 },
      ],
      preferred: [
        { name: 'Unreal Engine или Unity (C++/C#)', weight: 1.5 },
        { name: 'Оптимизация / профилирование', weight: 1.5 },
        { name: 'Gamedev или симуляции', weight: 1.0 },
      ],
      filters: { min_experience_years: 2, remote_ok: true, salary_max_rub: null },
      pass_threshold: 7.0,
      review_threshold: 5.0,
    },
  },
  office: {
    label: 'Офисный сотрудник',
    stages: ['Скрининг резюме', 'Собеседование HR', 'Тестовое задание', 'Оффер'],
    config: {
      vacancy_title: 'Офисный сотрудник / административная роль',
      vacancy_context: 'Работа с документами, координация, взаимодействие с клиентами и партнёрами.',
      knockout: [
        'Нет опыта офисной работы от 1 года',
        'Нет навыков MS Office / Google Workspace',
      ],
      required: [
        { name: 'MS Office / Google Workspace', weight: 2.0 },
        { name: 'Деловая коммуникация', weight: 2.0 },
        { name: 'Организация и тайм-менеджмент', weight: 2.0 },
      ],
      preferred: [
        { name: 'CRM / ERP системы', weight: 1.0 },
        { name: 'Английский язык (B1+)', weight: 1.0 },
      ],
      filters: { min_experience_years: 1, remote_ok: false, salary_max_rub: null },
      pass_threshold: 5.5,
      review_threshold: 3.5,
    },
  },
  backend: {
    label: 'Backend Developer',
    stages: ['Проверка резюме', 'Тестовое задание', 'Техническое интервью', 'Финальное интервью', 'Оффер'],
    config: {
      vacancy_title: 'Backend Developer (Node.js / Python / Go)',
      vacancy_context: 'Разработка серверных приложений, REST/gRPC API, микросервисы.',
      knockout: [
        'Нет коммерческого backend-опыта от 2 лет',
        'Незнание SQL / реляционных БД',
      ],
      required: [
        { name: 'Node.js / Python / Go / Java (хотя бы один)', weight: 3.0 },
        { name: 'REST API + HTTP протокол', weight: 2.0 },
        { name: 'SQL (PostgreSQL / MySQL)', weight: 2.0 },
      ],
      preferred: [
        { name: 'Docker / Kubernetes', weight: 1.5 },
        { name: 'Очереди сообщений (Kafka, RabbitMQ)', weight: 1.0 },
        { name: 'Опыт с облачными платформами (GCP/AWS/Azure)', weight: 1.0 },
      ],
      filters: { min_experience_years: 2, remote_ok: true, salary_max_rub: null },
      pass_threshold: 6.5,
      review_threshold: 4.5,
    },
  },
};

function atsEditorHtml(currentConfig, currentStages, opts = {}) {
  const { callbackBase = '', username = '', agentSecret = '' } = opts;
  const templatesJson = JSON.stringify(TEMPLATES);
  const initConfigJson = JSON.stringify(currentConfig || null);
  const initStagesJson = JSON.stringify(currentStages || null);
  const isLive = Boolean(callbackBase);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ATS Template Editor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1117;color:#e8e9ed;min-height:100vh}
:root{
  --bg:#0f1117;--panel:#1a1d27;--border:#2e3347;--accent:#4f8ef7;--accent2:#7c5ce4;
  --green:#27c97b;--red:#ff6b6b;--yellow:#f0b429;--text:#e8e9ed;--muted:#8b8fa8;
  --radius:10px;--shadow:0 4px 20px rgba(0,0,0,.4)
}
/* Layout */
header{background:var(--panel);border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100}
.logo{font-size:17px;font-weight:700;color:var(--accent);letter-spacing:-.3px}
.badge{font-size:11px;padding:3px 8px;border-radius:20px;font-weight:600}
.badge.live{background:rgba(39,201,123,.15);color:var(--green);border:1px solid rgba(39,201,123,.3)}
.badge.offline{background:rgba(139,143,168,.1);color:var(--muted);border:1px solid var(--border)}
.spacer{flex:1}
select#tplSelect{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 12px;font-size:13px;cursor:pointer;outline:none}
select#tplSelect:focus{border-color:var(--accent)}
.btn{padding:8px 18px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{filter:brightness(1.1)}
.btn-secondary{background:var(--panel);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{border-color:var(--accent)}
.btn-danger{background:rgba(255,107,107,.15);color:var(--red);border:1px solid rgba(255,107,107,.2)}.btn-danger:hover{background:rgba(255,107,107,.25)}
.btn-sm{padding:4px 10px;font-size:12px;border-radius:5px}
.btn:disabled{opacity:.45;cursor:default}
main{max-width:960px;margin:0 auto;padding:28px 20px;display:flex;flex-direction:column;gap:24px}

/* Stages */
.section-title{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px}
.stages-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.stage-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;display:flex;flex-direction:column;gap:6px;min-width:130px;max-width:180px;position:relative;flex:1}
.stage-num{font-size:10px;font-weight:700;color:var(--accent);letter-spacing:.5px}
.stage-name{font-size:13px;font-weight:600;color:var(--text);border:none;background:transparent;outline:none;width:100%;padding:0}
.stage-name:focus{color:var(--accent)}
.stage-remove{position:absolute;top:6px;right:8px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;opacity:.5}.stage-remove:hover{opacity:1;color:var(--red)}
.stage-arrow{color:var(--muted);font-size:18px;flex-shrink:0;user-select:none}
.add-stage-btn{background:none;border:2px dashed var(--border);color:var(--muted);border-radius:var(--radius);padding:12px 16px;cursor:pointer;font-size:12px;transition:all .15s;min-width:80px}
.add-stage-btn:hover{border-color:var(--accent);color:var(--accent)}

/* Config card */
.config-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px;display:flex;flex-direction:column;gap:16px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.field input[type=text],.field input[type=number],.field textarea{background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:13px;outline:none;font-family:inherit;width:100%}
.field input:focus,.field textarea:focus{border-color:var(--accent)}
.field textarea{resize:vertical;min-height:60px}
.field input[type=number]{width:90px}

/* Criteria list */
.criteria-section{display:flex;flex-direction:column;gap:8px}
.criteria-label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;display:flex;align-items:center;justify-content:space-between}
.criteria-item{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 10px}
.criteria-item input[type=text]{flex:1;background:transparent;border:none;color:var(--text);font-size:13px;outline:none}
.criteria-item .weight-label{font-size:11px;color:var(--muted);white-space:nowrap}
.criteria-item input[type=number]{width:60px;background:var(--panel);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:3px 6px;font-size:12px;text-align:center;outline:none}
.criteria-item .del-btn{background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;flex-shrink:0}.del-btn:hover{color:var(--red)}

/* Thresholds */
.thresholds{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.threshold-field{display:flex;flex-direction:column;gap:5px}
.threshold-field label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.threshold-field input{width:80px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:14px;font-weight:700;outline:none;text-align:center}
.threshold-field input:focus{border-color:var(--accent)}
.threshold-bar{height:6px;background:var(--bg);border:1px solid var(--border);border-radius:3px;margin-top:4px;position:relative;width:200px}
.threshold-bar-fill{position:absolute;height:100%;border-radius:3px;transition:width .2s}

/* Filters */
.filters-row{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap}
.filter-field{display:flex;flex-direction:column;gap:5px}
.filter-field label{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.filter-field input[type=number]{width:90px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:7px 10px;font-size:13px;outline:none}
.filter-field input[type=number]:focus{border-color:var(--accent)}
.toggle-wrap{display:flex;align-items:center;gap:8px;margin-top:4px}
.toggle{position:relative;width:38px;height:20px}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:var(--border);border-radius:10px;cursor:pointer;transition:.2s}
.toggle input:checked+.toggle-slider{background:var(--accent)}
.toggle-slider:before{content:"";position:absolute;height:14px;width:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked+.toggle-slider:before{transform:translateX(18px)}

/* Validation / Toast */
.validation-box{border-radius:8px;padding:12px 16px;font-size:13px;line-height:1.6;display:none}
.validation-box.ok{background:rgba(39,201,123,.1);border:1px solid rgba(39,201,123,.25);color:var(--green)}
.validation-box.err{background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.25);color:var(--red)}
.toast{position:fixed;bottom:24px;right:24px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 18px;font-size:13px;box-shadow:var(--shadow);transition:opacity .3s;z-index:200;max-width:300px}
.toast.hidden{opacity:0;pointer-events:none}
.toast.success{border-color:rgba(39,201,123,.4);color:var(--green)}
.toast.error{border-color:rgba(255,107,107,.4);color:var(--red)}

/* JSON preview */
details summary{cursor:pointer;font-size:12px;color:var(--muted);padding:6px 0;user-select:none}
details summary:hover{color:var(--accent)}
pre.json-preview{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;font-size:11px;overflow-x:auto;color:#a8b5d0;margin-top:8px;white-space:pre-wrap;word-break:break-word}
</style>
</head>
<body>

<header>
  <span class="logo">ATS Template Editor</span>
  ${isLive ? '<span class="badge live">● Live</span>' : '<span class="badge offline">○ Offline</span>'}
  <div class="spacer"></div>
  <label for="tplSelect" style="font-size:12px;color:var(--muted);margin-right:4px">Шаблон:</label>
  <select id="tplSelect">
    <option value="">— выбрать шаблон —</option>
    <option value="webinar">Вебинарный специалист</option>
    <option value="marketing">Маркетолог</option>
    <option value="cpp3d">C++ / 3D Программист</option>
    <option value="office">Офисный сотрудник</option>
    <option value="backend">Backend Developer</option>
  </select>
  &nbsp;
  <button class="btn btn-secondary btn-sm" id="validateBtn">Проверить</button>
  &nbsp;
  <button class="btn btn-secondary btn-sm" id="exportBtn">↓ JSON</button>
  &nbsp;
  <button class="btn btn-primary" id="saveBtn" ${isLive ? '' : 'disabled title="Сохранение недоступно в offline-режиме"'}>Сохранить в контекст</button>
  &nbsp;
  <button class="btn btn-danger" id="resetAtsBtn" ${isLive ? '' : 'disabled title="Недоступно в offline-режиме"'} title="Сбросить ats_result у всех кандидатов — они будут переоценены при следующем batch review">↺ Пересмотреть кандидатов</button>
</header>

<main>

  <!-- Stages -->
  <section>
    <div class="section-title">Этапы подбора</div>
    <div class="stages-wrap" id="stagesWrap"></div>
  </section>

  <!-- Vacancy meta -->
  <div class="config-card">
    <div class="section-title" style="margin-bottom:0">Вакансия</div>
    <div class="row2">
      <div class="field">
        <label>Название вакансии</label>
        <input type="text" id="fTitle" placeholder="Backend Developer / Маркетолог ...">
      </div>
      <div class="thresholds">
        <div class="threshold-field">
          <label>Pass ≥</label>
          <input type="number" id="fPass" step="0.5" min="0" max="10" value="6.5">
        </div>
        <div class="threshold-field">
          <label>Review ≥</label>
          <input type="number" id="fReview" step="0.5" min="0" max="10" value="4.0">
        </div>
      </div>
    </div>
    <div class="field">
      <label>Контекст вакансии</label>
      <textarea id="fContext" rows="2" placeholder="Краткое описание: продукт, команда, задачи..."></textarea>
    </div>
  </div>

  <!-- Knockout -->
  <div class="config-card">
    <div class="criteria-section">
      <div class="criteria-label">
        <span style="color:var(--red)">✕ Нокаут-критерии</span>
        <button class="btn btn-sm btn-danger" onclick="addKnockout()">+ добавить</button>
      </div>
      <div id="knockoutList"></div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">Провал любого → немедленное отклонение. Макс. 3.</div>
    </div>
  </div>

  <!-- Required + Preferred -->
  <div class="config-card">
    <div class="criteria-section">
      <div class="criteria-label">
        <span style="color:var(--accent)">★ Обязательные навыки</span>
        <button class="btn btn-sm btn-secondary" onclick="addRequired()">+ добавить</button>
      </div>
      <div id="requiredList"></div>
    </div>
    <div class="criteria-section" style="margin-top:16px">
      <div class="criteria-label">
        <span style="color:var(--accent2)">◆ Желательные навыки</span>
        <button class="btn btn-sm btn-secondary" onclick="addPreferred()">+ добавить</button>
      </div>
      <div id="preferredList"></div>
    </div>
  </div>

  <!-- Filters -->
  <div class="config-card">
    <div class="section-title" style="margin-bottom:8px">Фильтры</div>
    <div class="filters-row">
      <div class="filter-field">
        <label>Мин. опыт (лет)</label>
        <input type="number" id="fMinExp" min="0" max="20" value="2" placeholder="0">
      </div>
      <div class="filter-field">
        <label>Макс. зарплата (₽)</label>
        <input type="number" id="fMaxSalary" min="0" step="10000" placeholder="не ограничено">
      </div>
      <div class="filter-field">
        <label>Удалённая работа</label>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="fRemote" checked><span class="toggle-slider"></span></label>
          <span id="fRemoteLabel" style="font-size:13px;color:var(--text)">Да</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Validation output -->
  <div class="validation-box" id="validationBox"></div>

  <!-- JSON preview -->
  <details>
    <summary>JSON (raw config)</summary>
    <pre class="json-preview" id="jsonPreview"></pre>
  </details>

</main>

<div class="toast hidden" id="toast"></div>

<script>
const TEMPLATES = ${templatesJson};
const CALLBACK_BASE = '${callbackBase}';
const HH_USER = '${username}';
const HH_SECRET = '${agentSecret}';

let initConfig = ${initConfigJson};
let initStages = ${initStagesJson};

// ── State ─────────────────────────────────────────────────────────────────────

let stages = [];
let knockout = [];
let required = [];
let preferred = [];

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  if (initConfig) {
    loadFromConfig(initConfig, initStages || []);
  } else {
    stages = ['Скрининг резюме', 'Техническое интервью', 'Финальное интервью', 'Оффер'];
    knockout = [''];
    required = [{ name: '', weight: 2.0 }];
    preferred = [{ name: '', weight: 1.0 }];
    renderAll();
  }
}

// ── Template selector ─────────────────────────────────────────────────────────

document.getElementById('tplSelect').addEventListener('change', e => {
  const key = e.target.value;
  if (!key) return;
  const t = TEMPLATES[key];
  if (!t) return;
  loadFromConfig(t.config, t.stages);
  e.target.value = '';
});

function loadFromConfig(config, stagesArr) {
  document.getElementById('fTitle').value = config.vacancy_title || '';
  document.getElementById('fContext').value = config.vacancy_context || '';
  document.getElementById('fPass').value = config.pass_threshold ?? 6.5;
  document.getElementById('fReview').value = config.review_threshold ?? 4.0;
  const f = config.filters || {};
  document.getElementById('fMinExp').value = f.min_experience_years ?? '';
  document.getElementById('fMaxSalary').value = f.salary_max_rub || '';
  document.getElementById('fRemote').checked = f.remote_ok !== false;
  updateRemoteLabel();
  stages = (stagesArr && stagesArr.length) ? [...stagesArr] : ['Скрининг', 'Интервью', 'Оффер'];
  knockout = config.knockout && config.knockout.length ? [...config.knockout] : [''];
  required = config.required && config.required.length ? config.required.map(x => ({ ...x })) : [{ name: '', weight: 2.0 }];
  preferred = config.preferred && config.preferred.length ? config.preferred.map(x => ({ ...x })) : [{ name: '', weight: 1.0 }];
  renderAll();
}

// ── Stages ────────────────────────────────────────────────────────────────────

function renderStages() {
  const wrap = document.getElementById('stagesWrap');
  wrap.innerHTML = '';
  stages.forEach((s, i) => {
    if (i > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'stage-arrow';
      arrow.textContent = '→';
      wrap.appendChild(arrow);
    }
    const card = document.createElement('div');
    card.className = 'stage-card';
    card.innerHTML = \`
      <span class="stage-num">ЭТАП \${i + 1}</span>
      <input class="stage-name" type="text" value="\${escHtml(s)}" data-idx="\${i}" placeholder="Название этапа">
      \${stages.length > 1 ? \`<button class="stage-remove" data-idx="\${i}" title="Удалить этап">×</button>\` : ''}
    \`;
    wrap.appendChild(card);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'add-stage-btn';
  addBtn.textContent = '+ этап';
  addBtn.onclick = () => { stages.push('Новый этап'); renderStages(); };
  wrap.appendChild(addBtn);
  // Events
  wrap.querySelectorAll('.stage-name').forEach(inp => {
    inp.addEventListener('input', e => {
      stages[+e.target.dataset.idx] = e.target.value;
      updateJsonPreview();
    });
  });
  wrap.querySelectorAll('.stage-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      stages.splice(+e.target.dataset.idx, 1);
      renderStages();
      updateJsonPreview();
    });
  });
}

// ── Knockout ──────────────────────────────────────────────────────────────────

function addKnockout() { knockout.push(''); renderKnockout(); }

function renderKnockout() {
  const list = document.getElementById('knockoutList');
  list.innerHTML = '';
  knockout.forEach((k, i) => {
    const item = document.createElement('div');
    item.className = 'criteria-item';
    item.innerHTML = \`
      <span style="color:var(--red);font-size:14px;flex-shrink:0">✕</span>
      <input type="text" value="\${escHtml(k)}" data-idx="\${i}" placeholder="Нокаут-критерий...">
      <button class="del-btn" data-idx="\${i}">×</button>
    \`;
    list.appendChild(item);
  });
  list.querySelectorAll('input[type=text]').forEach(inp => {
    inp.addEventListener('input', e => { knockout[+e.target.dataset.idx] = e.target.value; updateJsonPreview(); });
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      knockout.splice(+e.target.dataset.idx, 1);
      if (knockout.length === 0) knockout.push('');
      renderKnockout();
      updateJsonPreview();
    });
  });
}

// ── Required ──────────────────────────────────────────────────────────────────

function addRequired() { required.push({ name: '', weight: 2.0 }); renderRequired(); }

function renderRequired() {
  const list = document.getElementById('requiredList');
  list.innerHTML = '';
  required.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'criteria-item';
    item.innerHTML = \`
      <span style="color:var(--accent);font-size:14px;flex-shrink:0">★</span>
      <input type="text" value="\${escHtml(r.name)}" data-idx="\${i}" data-field="name" placeholder="Навык / технология...">
      <span class="weight-label">вес</span>
      <input type="number" value="\${r.weight}" data-idx="\${i}" data-field="weight" step="0.5" min="0.5" max="5" style="width:60px">
      <button class="del-btn" data-idx="\${i}">×</button>
    \`;
    list.appendChild(item);
  });
  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      required[idx][field] = field === 'weight' ? +e.target.value : e.target.value;
      updateJsonPreview();
    });
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      required.splice(+e.target.dataset.idx, 1);
      if (required.length === 0) required.push({ name: '', weight: 2.0 });
      renderRequired();
      updateJsonPreview();
    });
  });
}

// ── Preferred ─────────────────────────────────────────────────────────────────

function addPreferred() { preferred.push({ name: '', weight: 1.0 }); renderPreferred(); }

function renderPreferred() {
  const list = document.getElementById('preferredList');
  list.innerHTML = '';
  preferred.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'criteria-item';
    item.innerHTML = \`
      <span style="color:var(--accent2);font-size:14px;flex-shrink:0">◆</span>
      <input type="text" value="\${escHtml(p.name)}" data-idx="\${i}" data-field="name" placeholder="Желательный навык...">
      <span class="weight-label">вес</span>
      <input type="number" value="\${p.weight}" data-idx="\${i}" data-field="weight" step="0.5" min="0.5" max="5" style="width:60px">
      <button class="del-btn" data-idx="\${i}">×</button>
    \`;
    list.appendChild(item);
  });
  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      preferred[idx][field] = field === 'weight' ? +e.target.value : e.target.value;
      updateJsonPreview();
    });
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      preferred.splice(+e.target.dataset.idx, 1);
      if (preferred.length === 0) preferred.push({ name: '', weight: 1.0 });
      renderPreferred();
      updateJsonPreview();
    });
  });
}

// ── Field events ──────────────────────────────────────────────────────────────

['fTitle','fContext','fPass','fReview','fMinExp','fMaxSalary'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateJsonPreview);
});
document.getElementById('fRemote').addEventListener('change', () => { updateRemoteLabel(); updateJsonPreview(); });

function updateRemoteLabel() {
  document.getElementById('fRemoteLabel').textContent = document.getElementById('fRemote').checked ? 'Да' : 'Нет';
}

// ── Build config object ───────────────────────────────────────────────────────

function buildConfig() {
  const pass = +document.getElementById('fPass').value;
  const review = +document.getElementById('fReview').value;
  const minExp = document.getElementById('fMinExp').value;
  const maxSal = document.getElementById('fMaxSalary').value;
  return {
    vacancy_title: document.getElementById('fTitle').value.trim(),
    vacancy_context: document.getElementById('fContext').value.trim(),
    knockout: knockout.filter(k => k.trim()),
    required: required.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), weight: +r.weight })),
    preferred: preferred.filter(p => p.name.trim()).map(p => ({ name: p.name.trim(), weight: +p.weight })),
    filters: {
      min_experience_years: minExp ? +minExp : null,
      remote_ok: document.getElementById('fRemote').checked,
      salary_max_rub: maxSal ? +maxSal : null,
    },
    pass_threshold: isNaN(pass) ? 6.5 : pass,
    review_threshold: isNaN(review) ? 4.0 : review,
  };
}

function updateJsonPreview() {
  const preview = document.getElementById('jsonPreview');
  if (!preview.parentElement.open) return;
  const full = { config: buildConfig(), stages };
  preview.textContent = JSON.stringify(full, null, 2);
}

document.querySelector('details').addEventListener('toggle', updateJsonPreview);

// ── Validate ──────────────────────────────────────────────────────────────────

document.getElementById('validateBtn').addEventListener('click', validate);

function validate() {
  const config = buildConfig();
  const errors = [];
  if (!config.vacancy_title) errors.push('Укажи название вакансии.');
  if (!config.vacancy_context) errors.push('Укажи контекст вакансии.');
  if (config.knockout.length === 0) errors.push('Нужен хотя бы один нокаут-критерий.');
  if (config.knockout.length > 3) errors.push('Нокаут-критериев не должно быть больше 3.');
  if (config.required.length === 0) errors.push('Нужен хотя бы один обязательный навык.');
  if (config.pass_threshold <= config.review_threshold) errors.push('Pass threshold должен быть выше review threshold.');
  if (config.pass_threshold < 1 || config.pass_threshold > 10) errors.push('Pass threshold: от 1 до 10.');
  if (config.review_threshold < 0 || config.review_threshold >= config.pass_threshold) errors.push('Review threshold: от 0 до pass threshold.');
  if (stages.length < 2) errors.push('Нужно минимум 2 этапа подбора.');
  if (stages.some(s => !s.trim())) errors.push('Есть пустые этапы — заполни или удали.');

  const box = document.getElementById('validationBox');
  box.style.display = 'block';
  if (errors.length === 0) {
    box.className = 'validation-box ok';
    box.textContent = '✓ Конфиг валиден. Всё готово для сохранения.';
  } else {
    box.className = 'validation-box err';
    box.innerHTML = errors.map(e => '• ' + e).join('<br>');
  }
  return errors.length === 0;
}

// ── Save to context ───────────────────────────────────────────────────────────

document.getElementById('saveBtn').addEventListener('click', async () => {
  if (!CALLBACK_BASE) return;
  if (!validate()) return;
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Сохраняю...';
  try {
    const payload = { username: HH_USER, config: buildConfig(), stages };
    const r = await fetch(CALLBACK_BASE + '/hh/ats-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HH_SECRET },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (r.ok && data.ok) {
      toast('Конфиг сохранён в контекст ✓', 'success');
    } else {
      toast('Ошибка: ' + (data.error || r.status), 'error');
    }
  } catch(e) {
    toast('Ошибка сети: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сохранить в контекст';
  }
});

// ── Reset ATS results ─────────────────────────────────────────────────────────

document.getElementById('resetAtsBtn').addEventListener('click', async () => {
  if (!CALLBACK_BASE) return;
  if (!confirm('Сбросить ats_result у всех кандидатов? Они будут переоценены с текущим конфигом при следующем hh_batch_review.')) return;
  const btn = document.getElementById('resetAtsBtn');
  btn.disabled = true;
  btn.textContent = 'Сбрасываю...';
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/reset-ats-results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HH_SECRET },
      body: JSON.stringify({ username: HH_USER }),
    });
    const data = await r.json();
    if (r.ok && data.ok) {
      toast(\`Сброшено: \${data.reset} кандидатов. Запусти hh_batch_review для переоценки.\`, 'success');
    } else {
      toast('Ошибка: ' + (data.error || r.status), 'error');
    }
  } catch(e) {
    toast('Ошибка сети: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '↺ Пересмотреть кандидатов';
  }
});

// ── Export JSON ───────────────────────────────────────────────────────────────

document.getElementById('exportBtn').addEventListener('click', () => {
  const full = { config: buildConfig(), stages };
  const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ats-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.className = 'toast hidden', 3500);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderAll() {
  renderStages();
  renderKnockout();
  renderRequired();
  renderPreferred();
  updateJsonPreview();
}

init();
</script>
</body>
</html>`;
}

module.exports = { atsEditorHtml, TEMPLATES };
