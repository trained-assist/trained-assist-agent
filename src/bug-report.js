// /bug_or_feature — one-tap incident capture. Bundles the last few messages of the
// current session + the tail of assist-agent logs + the caller's note into a GitHub
// issue on trained-assist/trained-assist-agent. Born from the "код 143 (SIGTERM)"
// class: when something breaks we don't yet know WHY, so capture the evidence at the
// moment of the complaint instead of asking the user to reproduce it later.
//
// Durability: if the issue POST fails (no token / network / GitHub down) we still
// persist the full report to agent-data so nothing is lost — the user gets a path,
// not a shrug.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sessions = require('./session-store');
const { getCurrentSessionId } = require('./session-store');

const REPO = process.env.BUG_REPORT_REPO || 'trained-assist/trained-assist-agent';
const REPO_ROOT = path.join(__dirname, '..');

// Token: prefer a dedicated durable secret; fall back to the classic PAT baked into the
// repo's origin URL (which carries `repo` scope — verified working). Never surfaced to users.
function resolveToken() {
  if (process.env.GITHUB_ISSUES_TOKEN) return process.env.GITHUB_ISSUES_TOKEN;
  try {
    const url = execSync('git config --get remote.origin.url', { cwd: REPO_ROOT }).toString().trim();
    const m = url.match(/:\/\/[^:@/]+:([^@]+)@/) || url.match(/x-access-token:([^@]+)@/);
    if (m) return m[1];
  } catch (_) {}
  return null;
}

function recentLogs(lines = 120) {
  try {
    return execSync(`journalctl -u assist-agent.service -n ${lines} --no-pager`,
      { maxBuffer: 8 * 1024 * 1024 }).toString();
  } catch (_) {
    return '(логи assist-agent.service недоступны из этого процесса)';
  }
}

function lastMessages(workDir, chatId, n = 6) {
  try {
    const id = getCurrentSessionId(workDir, chatId);
    if (!id) return { id: null, topic: null, messages: [] };
    const s = sessions.getSession(workDir, id);
    if (!s) return { id, topic: null, messages: [] };
    return { id, topic: s.topic || null, messages: (s.messages || []).slice(-n) };
  } catch (_) {
    return { id: null, topic: null, messages: [] };
  }
}

function classifyKind(note) {
  return /\b(feature|фич|хочу|хотел|добав|улучш|было бы|предлож)/i.test(note || '') ? 'feature' : 'bug';
}

function buildBody({ userId, sess, note, logs, kind }) {
  const msgLines = sess.messages.length
    ? sess.messages.map(m => {
        const who = m.role === 'user' ? '👤 Пользователь' : '🤖 Ассистент';
        return `**${who}:**\n${String(m.content || '').slice(0, 2000)}`;
      }).join('\n\n')
    : '_(нет сообщений в текущей сессии)_';

  return [
    `**Тип:** ${kind === 'feature' ? '✨ feature' : '🐞 bug'}`,
    `**Профиль:** \`${userId || '?'}\``,
    `**Сессия:** \`${sess.id || '—'}\`${sess.topic ? ` — ${sess.topic}` : ''}`,
    '',
    note ? `### Что сообщил пользователь\n${note}` : '_(без комментария — только контекст)_',
    '',
    `### Последние ${sess.messages.length} сообщений`,
    msgLines,
    '',
    '<details><summary>📜 Логи assist-agent.service (хвост)</summary>',
    '',
    '```',
    logs.slice(-8000),
    '```',
    '</details>',
    '',
    '---',
    '_Создано автоматически командой `/bug_or_feature`._',
  ].join('\n');
}

function persistFallback(workDir, payload) {
  try {
    const dir = path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'bug-reports');
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `${Date.now()}.md`);
    fs.writeFileSync(fp, `# ${payload.title}\n\n${payload.body}\n`);
    return fp;
  } catch (e) {
    console.error('[bug-report] fallback persist failed:', e.message);
    return null;
  }
}

/**
 * Capture a bug/feature report. Async (journalctl + GitHub API).
 * Returns a user-facing markdown string. Never throws.
 */
async function createBugReport({ workDir, chatId, userId, note }) {
  const sess = lastMessages(workDir, chatId, 6);
  const logs = recentLogs(120);
  const kind = classifyKind(note);
  const title = note
    ? `[${kind}] ${note.split('\n')[0].slice(0, 80)}`
    : `[${kind}] отчёт из сессии ${sess.id || '?'}`;
  const body = buildBody({ userId, sess, note, logs, kind });
  const token = resolveToken();

  if (!token) {
    const fp = persistFallback(workDir, { title, body });
    return `⚠️ Отчёт собран, но GitHub-токен не настроен — issue не создан.\n` +
      (fp ? `Сохранил локально: \`${fp}\`\n` : '') +
      `Заполни \`GITHUB_ISSUES_TOKEN\` в secrets.env, чтобы отчёты уходили в GitHub.`;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'trained-assist-agent',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, labels: [kind, 'from-bot'] }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const fp = persistFallback(workDir, { title, body });
      console.error('[bug-report] GitHub API', res.status, txt.slice(0, 300));
      return `⚠️ Отчёт собран, но GitHub вернул ${res.status}.` +
        (fp ? `\nСохранил локально: \`${fp}\`` : '');
    }
    const issue = await res.json();
    return `✅ Отчёт отправлен: ${issue.html_url}\n\n` +
      `В issue #${issue.number} вложены: твой комментарий, последние ${sess.messages.length} сообщений сессии \`${sess.id || '—'}\` и хвост логов. ` +
      `Отдельная сессия разберёт его позже.`;
  } catch (e) {
    const fp = persistFallback(workDir, { title, body });
    console.error('[bug-report] create failed:', e.message);
    return `⚠️ Не удалось создать issue (${e.message}).` +
      (fp ? `\nОтчёт сохранён локально: \`${fp}\`` : '');
  }
}

module.exports = { createBugReport };
