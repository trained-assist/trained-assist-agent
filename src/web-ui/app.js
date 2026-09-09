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

// ─── View switching ─────────────────────────────────────────────────────────
const VIEWS = ['view-loading', 'view-sessions', 'view-session'];
const showView = id => VIEWS.forEach(v =>
  document.getElementById(v).classList.toggle('hidden', v !== id)
);

const $ = id => document.getElementById(id);

// ─── Sessions list ──────────────────────────────────────────────────────────
async function loadSessions() {
  showView('view-loading');
  try {
    const res = await api('/web/sessions');
    const sessions = await res.json();
    renderSessions(Array.isArray(sessions) ? sessions : []);
    showView('view-sessions');
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      showView('view-sessions');
      $('sessions-list').innerHTML =
        '<div class="empty"><h3>Failed to load</h3><p>Check connection and try refreshing</p></div>';
    }
  }
}

function renderSessions(sessions) {
  const el = $('sessions-list');
  if (!sessions.length) {
    el.innerHTML = '<div class="empty"><h3>No sessions yet</h3><p>Start a new session to begin</p></div>';
    return;
  }
  el.innerHTML = sessions.map(s => `
    <div class="session-item" data-id="${esc(s.id)}">
      <div class="session-info">
        <div class="session-path">${esc(s.path || s.id)}</div>
        <div class="session-meta">${timeAgo(s.createdAt)}</div>
      </div>
      ${statusBadge(s.status)}
    </div>
  `).join('');
  el.querySelectorAll('.session-item').forEach(item =>
    item.addEventListener('click', () => navigate(`/session/${item.dataset.id}`))
  );
}

// ─── Session detail ─────────────────────────────────────────────────────────
let currentSessionId = null;
let streamAbort = null;
let pollTimer = null;

async function loadSession(id) {
  currentSessionId = id;
  showView('view-session');
  $('session-title').textContent = id;
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
  $('session-title').textContent = session.path || id;

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
  const btnSend  = $('btn-send');
  const input    = $('reply-input');
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
              } else {
                // No id came back (e.g. task produced no session) — refresh the list
                await loadSessions();
              }
              return;
            } else if (msg.type === 'error') {
              streamEl.innerHTML = `<div class="err">${esc(msg.message || 'Error')}</div>`;
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

// ─── New session modal ──────────────────────────────────────────────────────
async function openNewModal() {
  const modal = $('modal-new');
  const sel   = $('folder-select');
  $('task-input').value = '';
  sel.innerHTML = '<option value="">Loading folders…</option>';
  sel.disabled  = true;
  modal.classList.remove('hidden');

  try {
    const res  = await api('/web/files/tree');
    const data = await res.json();
    const tree = data.tree || [];
    if (!tree.length) {
      sel.innerHTML = '<option value="">No folders available</option>';
    } else {
      sel.innerHTML = '<option value="">Select a folder…</option>' +
        tree.map(f => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('');
      sel.disabled = false;
    }
  } catch {
    sel.innerHTML = '<option value="">Failed to load folders</option>';
  }
}

async function submitNewSession() {
  const path    = $('folder-select').value;
  const message = $('task-input').value.trim();
  const btn     = $('btn-start-new');
  if (!message) { $('task-input').focus(); return; }

  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    // The backend creates the session implicitly inside /web/run — no separate
    // create step. We don't have an id yet; it arrives on the SSE `done` event.
    $('modal-new').classList.add('hidden');
    currentSessionId = null;
    showView('view-session');
    $('session-title').textContent = path || 'New session';
    $('messages-container').innerHTML = '';

    // MVP folder targeting: prepend the chosen folder to the task text.
    const task = path ? `[Work in folder: ${path}]\n\n${message}` : message;
    await startStream('/web/run', { task }, message);
  } catch (err) {
    alert('Error starting session: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start';
  }
}

// ─── Reply ──────────────────────────────────────────────────────────────────
async function sendReply() {
  const input   = $('reply-input');
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

// ─── Router ─────────────────────────────────────────────────────────────────
function navigate(path, pushState = true) {
  if (pushState) location.hash = path;
}

async function route() {
  if (!requireAuth()) return;
  clearInterval(pollTimer);
  if (streamAbort) { streamAbort.abort(); streamAbort = null; }

  const hash = location.hash.slice(1); // strip '#'
  if (hash.startsWith('/session/')) {
    const id = hash.slice('/session/'.length);
    if (id) await loadSession(id);
    else    await loadSessions();
  } else {
    await loadSessions();
  }
}

// ─── Event listeners ────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', openNewModal);

$('btn-logout').addEventListener('click', async () => {
  try { await fetch('/web/logout', { method: 'POST', credentials: 'include' }); } catch {}
  location.href = 'login.html';
});

$('btn-back').addEventListener('click', e => {
  e.preventDefault();
  if (streamAbort) streamAbort.abort();
  clearInterval(pollTimer);
  navigate('/');
});

$('btn-stop').addEventListener('click', stopSession);

$('btn-send').addEventListener('click', sendReply);
$('reply-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); }
});

$('btn-cancel-new').addEventListener('click', () => $('modal-new').classList.add('hidden'));
$('btn-start-new').addEventListener('click', submitNewSession);
$('modal-new').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

window.addEventListener('hashchange', route);

// ─── Boot ───────────────────────────────────────────────────────────────────
route();
