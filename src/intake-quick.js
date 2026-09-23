const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const sessions = require('./session-store');

// Uses the same verified async handlers as /run, but never spawns an agent.
// Saved exchanges make qa_more replayable and retries idempotent.
function createIntakeQuick({ baseDir, answer, apiKey, recordActivity = () => {} }) {
  const inflight = new Map();
  return async payload => {
    const { username, userId, query, messageId, telegramUserId, projectId, audience } = payload;
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username || '') ||
        !/^-?\d{1,20}$/.test(String(userId)) || !Number.isSafeInteger(messageId) ||
        typeof query !== 'string' || !query.trim() || query.length > 50000) {
      return { status: 400, error: 'invalid intake request' };
    }
    const workDir = path.join(baseDir, username);
    if (!fs.existsSync(workDir)) return { status: 404, error: 'profile not found' };
    if (projectId && (!require('./valid-project-id').isValidProjectId(projectId) ||
        !fs.existsSync(path.join(workDir, 'projects', projectId, 'project.json')))) {
      return { status: 400, error: 'invalid project' };
    }
    const id = 'qa-' + crypto.createHash('sha256').update(`${username}:${userId}:${messageId}`).digest('hex').slice(0, 32);
    if (inflight.has(id)) return inflight.get(id);
    const pending = (async () => {
      const previous = sessions.getSession(workDir, id);
      const reply = previous?.messages?.find(m => m.role === 'assistant')?.content;
      if (reply) return { answer: reply, sessionId: id };
      const result = await answer(query, username, workDir, apiKey, false, userId, telegramUserId, null, audience || 'default');
      if (!result) return { answer: null };
      // Do not replace the chat's current deep session with this utility exchange.
      if (!previous) sessions.createSession(workDir, { task: query, id, projectId: projectId || null, audience });
      sessions.appendReply(workDir, id, result);
      recordActivity({username,chatId:Number(userId),sessionId:id});
      return { answer: result, sessionId: id };
    })();
    inflight.set(id, pending);
    try { return await pending; } finally { inflight.delete(id); }
  };
}
module.exports = { createIntakeQuick };
