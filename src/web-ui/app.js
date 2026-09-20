// ─── Auth ──────────────────────────────────────────────────────────────────
// The server issues a httpOnly cookie (`web_token`) that JS cannot read, so the
// client can't check auth up-front. We optimistically render and let the first
// API 401 bounce the user to the login page.
const requireAuth = () => true;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 401) {
    location.href = 'login.html';
    throw new Error('Unauthorized');
  }
  return res;
}

// ─── Utils ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusBadge(status) {
  const map = {
    running:   '<span class="badge badge-running">⟳ Running</span>',
    completed: '<span class="badge badge-completed">✓ Done</span>',
    failed:    '<span class="badge badge-failed">✕ Failed</span>',
  };
  return map[status] || (status ? `<span class="badge">${esc(status)}</span>` : '');
}

function md(text) {
  if (!text) return '';
  return marked.parse(text, { breaks: true, gfm: true });
}

const $ = id => document.getElementById(id);

// Durable confirmations are independent of the currently selected session.
async function loadRestartIntents() {
  const panel = $('restart-intents');
  if (!panel) return;
  try {
    const res = await api('/web/restart-intents');
    if (!res.ok) throw new Error('Не удалось загрузить отложенные задачи');
    const { intents } = await res.json();
    panel.replaceChildren();
    panel.classList.toggle('hidden', !intents.length);
    for (const intent of intents) {
      const row = document.createElement('div');
      row.dataset.testid = 'restart-intent';
      const label = document.createElement('p');
      label.textContent = `${intent.title} — ожидает подтверждения`;
      row.append(label);
      for (const [action, text] of [['confirm', '▶️ Запустить'], ['cancel', 'Отменить']]) {
        const button = document.createElement('button');
        button.className = 'btn'; button.textContent = text;
        button.dataset.testid = `restart-${action}`;
        button.addEventListener('click', async () => {
          const buttons = [...row.querySelectorAll('button')];
          buttons.forEach(b => { b.disabled = true; });
          try {
            const response = await api('/web/restart-intents', { method: 'POST',
              body: JSON.stringify({ handle: intent.handle, action }) });
            if (!response.ok) throw new Error('Не удалось сохранить решение. Повторите позже.');
            const result = await response.json();
            if (!result.decision) throw new Error('Подтверждение устарело. Обновите страницу.');
            label.setAttribute('role', 'status');
            label.textContent = `${intent.title} — ${result.decision === 'cancel' ? 'отменена' : 'подтверждена, ожидает запуска'}`;
            buttons.forEach(b => b.remove());
          } catch (error) {
            label.setAttribute('role', 'alert'); label.textContent = error.message;
            buttons.forEach(b => { b.disabled = false; });
          }
        });
        row.append(button);
      }
      panel.append(row);
    }
  } catch (error) {
    if (error.message !== 'Unauthorized') {
      panel.classList.remove('hidden'); panel.textContent = 'Не удалось загрузить отложенные задачи. Обновите страницу.';
      panel.setAttribute('role', 'alert');
    }
  }
}

// ─── Sidebar: session list ──────────────────────────────────────────────────
function highlightSession(id) {
  document.querySelectorAll('.session-item').forEach(el =>
    el.classList.toggle('active', el.dataset.id === id));
}

function renderSessions(sessions) {
  const el = $('sessions-list');
  if (!sessions.length) {
    el.innerHTML = '<div class="empty"><h3>No sessions yet</h3><p>Start a new session to begin</p></div>';
    return;
  }
  el.innerHTML = sessions.map(s => `
    <div class="session-item" data-id="${esc(s.id)}" data-testid="session-item">
      <div class="session-info">
        <div class="session-path">${esc(s.topic || s.lastUserMessage || s.id)}</div>
        <div class="session-meta">${timeAgo(s.lastAt || s.createdAt)}${s.messageCount ? ` · ${s.messageCount} msg` : ''}</div>
      </div>
      ${statusBadge(s.status)}
    </div>
  `).join('');
  el.querySelectorAll('.session-item').forEach(item =>
    item.addEventListener('click', () => navigate(`/session/${item.dataset.id}`))
  );
}

// Lightweight sidebar refresh — no full-page loading state.
async function refreshSidebar() {
  try {
    const res = await api('/web/sessions');
    const sessions = await res.json();
    renderSessions(Array.isArray(sessions) ? sessions : []);
    highlightSession(currentSessionId);
    await loadRestartIntents();
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      $('sessions-list').innerHTML = '<div class="empty"><h3>Failed to load</h3><p>Check connection and try refreshing</p></div>';
    }
  }
}

// ─── Composer: creates a session (state A) or replies in one (state B) ─────
function setComposerMode(mode) {
  const isNew = mode === 'new';
  $('composer-project-row').classList.toggle('hidden', !isNew);
  $('composer-input').placeholder = isNew ? 'Опиши задачу…' : 'Ответ Клоду…';
  $('btn-composer-submit').textContent = isNew ? 'Start' : 'Send';
}

async function loadFolderOptions() {
  const sel = $('folder-select');
  try {
    const res  = await api('/web/files/tree');
    const data = await res.json();
    const tree = data.tree || [];
    sel.innerHTML = tree.length
      ? '<option value="">Select a folder…</option>' + tree.map(f => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('')
      : '<option value="">No folders available</option>';
  } catch {
    sel.innerHTML = '<option value="">Failed to load folders</option>';
  }
}

// Reset the main panel + composer back to "new task" (state A).
function showNewState({ clearInput = false } = {}) {
  if (streamAbort) streamAbort.abort();
  clearInterval(pollTimer);
  currentSessionId = null;
  $('session-title').textContent = 'New session';
  $('btn-stop').classList.add('hidden');
  $('messages-container').classList.add('hidden');
  $('messages-container').innerHTML = '';
  $('empty-state').classList.remove('hidden');
  $('stream-area').classList.add('hidden');
  $('reconnect-notice').classList.add('hidden');
  if (clearInput) $('composer-input').value = '';
  setComposerMode('new');
  highlightSession(null);
}

async function onComposerSubmit() {
  if (currentSessionId) await sendReply();
  else await submitNewSession();
}

// ─── Session detail ─────────────────────────────────────────────────────────
let currentSessionId = null;
let streamAbort = null;
let pollTimer = null;

async function loadSession(id) {
  currentSessionId = id;
  setComposerMode('active');
  highlightSession(id);
  $('session-title').textContent = id;
  $('empty-state').classList.add('hidden');
  $('messages-container').classList.remove('hidden');
  $('messages-container').innerHTML =
    '<div class="loading" style="padding:24px;justify-content:center"><div class="spinner"></div> Loading…</div>';
  $('stream-area').classList.add('hidden');
  $('btn-stop').classList.add('hidden');
  clearInterval(pollTimer);

  try {
    const res = await api(`/web/session/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
    renderSession(session);
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      $('messages-container').innerHTML =
        '<div class="empty"><h3>Failed to load session</h3></div>';
    }
  }
}

function renderSession(session) {
  const { id, status, messages, lastMessage } = session;
  $('session-title').textContent = session.topic || session.path || id;

  const msgs = Array.isArray(messages) && messages.length
    ? messages
    : (lastMessage ? [{ role: 'assistant', content: lastMessage }] : []);

  const container = $('messages-container');
  if (!msgs.length) {
    container.innerHTML = '<div class="empty" style="padding:32px"><p>No messages yet</p></div>';
  } else {
    container.innerHTML = msgs.map(m => `
      <div class="message message-${esc(m.role)}">
        <div class="message-role">${m.role === 'user' ? 'You' : 'Claude'}</div>
        <div class="message-content${m.role === 'assistant' ? ' md-content' : ''}">${
          m.role === 'assistant' ? md(m.content) : esc(m.content)
        }</div>
      </div>
    `).join('');
  }

  if (status === 'running') {
    $('btn-stop').classList.remove('hidden');
    startPolling(id);
  } else {
    $('btn-stop').classList.add('hidden');
  }

  scrollBottom();
}

function scrollBottom() {
  const c = $('messages-container');
  c.scrollTop = c.scrollHeight;
}

// ─── Polling for running sessions ───────────────────────────────────────────
function startPolling(sessionId) {
  const streamEl = $('stream-area');
  streamEl.classList.remove('hidden');
  streamEl.innerHTML = '<div class="loading"><div class="spinner"></div> Waiting for output…</div>';

  pollTimer = setInterval(async () => {
    if (currentSessionId !== sessionId) { clearInterval(pollTimer); return; }
    try {
      const res = await api(`/web/session/${sessionId}`);
      const session = await res.json();
      if (session.status !== 'running') {
        clearInterval(pollTimer);
        renderSession(session);
        streamEl.classList.add('hidden');
      } else if (session.lastMessage) {
        streamEl.innerHTML = `<div class="md-content">${md(session.lastMessage)}</div>`;
        scrollBottom();
      }
    } catch {}
  }, 2500);
}

// ─── SSE streaming via POST ─────────────────────────────────────────────────
async function startStream(endpoint, body, appendUserMsg = null) {
  clearInterval(pollTimer);
  if (streamAbort) streamAbort.abort();
  streamAbort = new AbortController();

  const streamEl = $('stream-area');
  const btnStop  = $('btn-stop');
  const btnSend  = $('btn-composer-submit');
  const input    = $('composer-input');
  const notice   = $('reconnect-notice');

  if (appendUserMsg) {
    const c = $('messages-container');
    const empty = c.querySelector('.empty');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'message message-user';
    div.innerHTML = `<div class="message-role">You</div><div class="message-content">${esc(appendUserMsg)}</div>`;
    c.appendChild(div);
    scrollBottom();
  }

  streamEl.classList.remove('hidden');
  streamEl.className = 'stream-area active';
  streamEl.innerHTML = '';
  btnStop.classList.remove('hidden');
  btnSend.disabled = true;
  input.disabled = true;

  let buffer = '';

  const tryConnect = async (attempt = 0) => {
    if (attempt > 0) {
      notice.classList.remove('hidden');
      notice.textContent = `Reconnecting… (attempt ${attempt})`;
      await new Promise(r => setTimeout(r, 3000));
      if (streamAbort.signal.aborted) return;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: streamAbort.signal,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 401) { location.href = 'login.html'; return; }

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }

      notice.classList.add('hidden');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        if (streamAbort.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '{}') continue; // ping
          try {
            const msg = JSON.parse(raw);
            if (msg.type === 'chunk' && msg.text) {
              buffer += msg.text;
              streamEl.innerHTML = `<div class="md-content">${md(buffer)}</div>`;
              scrollBottom();
            } else if (msg.type === 'done') {
              const sid = msg.sessionId || currentSessionId;
              if (sid) {
                currentSessionId = sid;
                navigate(`/session/${sid}`, false); // reflect real id in the URL
                await loadSession(sid);
                await refreshSidebar();
              } else {
                // No id came back (e.g. task produced no session) — refresh the list
                await refreshSidebar();
                showNewState();
              }
              return;
            } else if (msg.type === 'error') {
              streamEl.innerHTML = `<div class="err">${esc(msg.error || msg.message || 'Error')}</div>`;
              finalise();
              return;
            }
          } catch {}
        }
      }

      // Stream ended without done event — try reconnect
      if (!streamAbort.signal.aborted && attempt < 3) {
        await tryConnect(attempt + 1);
      } else {
        finalise();
      }
    } catch (err) {
      if (streamAbort.signal.aborted || err.name === 'AbortError') { finalise(); return; }
      if (attempt < 3) {
        await tryConnect(attempt + 1);
      } else {
        streamEl.innerHTML = `<div class="err">Connection failed: ${esc(err.message)}</div>`;
        finalise();
      }
    }
  };

  function finalise() {
    btnStop.classList.add('hidden');
    btnSend.disabled = false;
    input.disabled = false;
    streamEl.className = 'stream-area';
    notice.classList.add('hidden');
  }

  await tryConnect();
  finalise();
}

// ─── New session (state A submit) ──────────────────────────────────────────
async function submitNewSession() {
  const path    = $('folder-select').value;
  const input   = $('composer-input');
  const message = input.value.trim();
  if (!message) { input.focus(); return; }

  currentSessionId = null;
  setComposerMode('active');
  highlightSession(null);
  $('session-title').textContent = path || 'New session';
  $('empty-state').classList.add('hidden');
  $('messages-container').classList.remove('hidden');
  $('messages-container').innerHTML = '';
  input.value = '';

  // The backend creates the session implicitly inside /web/run — no separate
  // create step. We don't have an id yet; it arrives on the SSE `done` event.
  // MVP folder targeting: prepend the chosen folder to the task text.
  const task = path ? `[Work in folder: ${path}]\n\n${message}` : message;
  try {
    await startStream('/web/run', { task }, message);
  } catch (err) {
    alert('Error starting session: ' + err.message);
  }
}

// ─── Reply (state B submit) ─────────────────────────────────────────────────
async function sendReply() {
  const input   = $('composer-input');
  const message = input.value.trim();
  if (!message || !currentSessionId) return;
  input.value = '';
  await startStream(`/web/reply/${encodeURIComponent(currentSessionId)}`, { message }, message);
}

// ─── Stop ───────────────────────────────────────────────────────────────────
async function stopSession() {
  if (!currentSessionId) return;
  if (streamAbort) streamAbort.abort();
  clearInterval(pollTimer);
  try {
    await api(`/web/stop/${encodeURIComponent(currentSessionId)}`, { method: 'POST' });
  } catch {}
  $('btn-stop').classList.add('hidden');
  $('stream-area').classList.add('hidden');
  await loadSession(currentSessionId);
}

// ─── Attachments — always land in the composer textarea ────────────────────
function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end   = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after  = textarea.value.slice(end);
  const sep = before && !before.endsWith('\n') ? '\n' : '';
  const insertion = `${sep}${text}`;
  textarea.value = `${before}${insertion}${after}`;
  const pos = (before + insertion).length;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
}

// No /web/upload endpoint exists — browsers also never expose a real local
// path for security reasons, so we insert a reference the task text can use.
function attachFiles(fileList) {
  const input = $('composer-input');
  for (const file of fileList) insertAtCursor(input, `[File: ${file.name}]`);
}

// ─── Voice input — client-side only (Web Speech API), no backend involved ──
function setupVoice() {
  const btn = $('btn-voice');
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) {
    btn.disabled = true;
    btn.title = 'Voice input not supported in this browser';
    return;
  }
  const recognizer = new Ctor();
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.lang = document.documentElement.lang || 'en-US';
  let recording = false;

  recognizer.onresult = e => {
    const text = Array.from(e.results).map(r => r[0].transcript).join(' ').trim();
    if (text) insertAtCursor($('composer-input'), text);
  };
  recognizer.onend = () => { recording = false; btn.classList.remove('recording'); };
  recognizer.onerror = () => { recording = false; btn.classList.remove('recording'); };

  btn.addEventListener('click', () => {
    if (recording) { recognizer.stop(); return; }
    try { recognizer.start(); recording = true; btn.classList.add('recording'); } catch {}
  });
}

// ─── Router ─────────────────────────────────────────────────────────────────
function navigate(path, pushState = true) {
  if (pushState) location.hash = path;
}

async function route() {
  if (!requireAuth()) return;
  const hash = location.hash.slice(1); // strip '#'
  if (hash.startsWith('/session/')) {
    const id = hash.slice('/session/'.length);
    if (id) { await loadSession(id); return; }
  }
  showNewState();
}

// ─── Event listeners ────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => {
  showNewState({ clearInput: true });
  navigate('/');
});

$('btn-logout').addEventListener('click', async () => {
  try { await fetch('/web/logout', { method: 'POST', credentials: 'include' }); } catch {}
  location.href = 'login.html';
});

$('btn-stop').addEventListener('click', stopSession);

$('btn-composer-submit').addEventListener('click', onComposerSubmit);
$('composer-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onComposerSubmit(); }
});

$('btn-attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => {
  if (e.target.files.length) attachFiles(e.target.files);
  e.target.value = '';
});

const composerEl = $('composer');
composerEl.addEventListener('dragover', e => { e.preventDefault(); composerEl.classList.add('dragover'); });
composerEl.addEventListener('dragleave', () => composerEl.classList.remove('dragover'));
composerEl.addEventListener('drop', e => {
  e.preventDefault();
  composerEl.classList.remove('dragover');
  if (e.dataTransfer?.files?.length) attachFiles(e.dataTransfer.files);
});

window.addEventListener('hashchange', route);

// ─── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  await Promise.all([loadFolderOptions(), refreshSidebar()]);
  $('view-loading').classList.add('hidden');
  $('shell').classList.remove('hidden');
  setupVoice();
  await route();
}

boot();
