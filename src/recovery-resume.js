const path = require('path');

// The journal owns the task until runTask replaces it under the SAME id. Never
// delete first, never expire accepted work based on how long the process ran.
async function resumePending({ pending, runTask, clearPendingTask, notify, record,
  baseUsersDir, secrets, log = console }) {
  for (const p of [...pending].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
    if (!p.taskId || !p.username || p.userId == null || !p.task) {
      log.warn('[recovery] invalid pending record retained:', p.taskId);
      continue;
    }
    const retryCount = (p.retryCount || 0) + (p.phase === 'queued' ? 0 : 1);
    const exhausted = retryCount > 2;
    const notice = exhausted
      ? '⚠️ Восстановить сессию не удалось: сервер снова перезапустился. Выполнено попыток: 2/2. Автоповторы остановлены.'
      : p.phase === 'queued' && !retryCount
        ? '🔄 После перезапуска сервера запускаю сохранённую задачу из очереди.'
        : `🔄 После перезапуска сервера пробую восстановить сессию: попытка ${retryCount}/2.`;
    try {
      await notify(p, notice);
      if (exhausted) {
        record(p, notice);
        clearPendingTask(p.taskId);
        continue;
      }
    } catch (error) {
      log.warn(`[recovery] notification task=${p.taskId}: ${error.message}`);
      // Exhausted work remains as a notification outbox, never relaunched.
      if (exhausted) continue;
    }
    const workDir = p.workDir || path.join(baseUsersDir, p.username);
    runTask({ taskId: p.taskId, user: { id: p.userId, username: p.username, name: p.username, workDir },
      task: p.task, context: p.context || null, sessionId: p.sessionId || null,
      contextFromSession: p.contextFromSession || null, forceClaude: !!p.forceClaude,
      forceNew: !!p.forceNew, mode: p.mode || null, projectId: p.projectId || null,
      newProjectName: p.newProjectName || null, initialMsgId: p.initialMsgId || null,
      pinnedMsgId: p.pinnedMsgId || null, secrets, retryCount,
      continuationCount: p.continuationCount || 0,
    }).catch(error => log.error(`[recovery] task=${p.taskId}: ${error.message}`));
  }
}
module.exports = { resumePending };
