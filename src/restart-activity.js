// Durable activity for restart audiences. Only intake and task lifecycle call record;
// delivery receipts and service notices must never renew the activity window.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { SYSTEM_ROOT, USERS_ROOT } = require('./data-paths');
const WINDOW_MS = 15 * 60 * 1000;
const safeId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]+$/.test(x);
function normalizeTarget(target) {
  if (!target || !safeId(target.username)) throw Error('Invalid activity profile');
  const { username } = target;
  const chatId = target.chatId == null || target.chatId === 0 ? null : Number(target.chatId);
  const threadId = target.threadId == null ? null : Number(target.threadId);
  const sessionId = target.sessionId || null;
  if (chatId != null && !Number.isSafeInteger(chatId)) throw Error('Invalid activity chat');
  if (threadId != null && (!Number.isSafeInteger(threadId) || threadId < 1 || chatId == null)) throw Error('Invalid activity topic');
  if (sessionId != null && !safeId(sessionId)) throw Error('Invalid activity session');
  if (chatId == null && !sessionId) throw Error('Activity recipient required');
  return { username, chatId, threadId, sessionId };
}
function targetKey(target) { return createHash('sha256').update(JSON.stringify(normalizeTarget(target))).digest('hex'); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function jsonFiles(dir) {
  try { return fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort(); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function createActivityStore({ dataRoot = SYSTEM_ROOT, usersRoot = USERS_ROOT, now = Date.now } = {}) {
  const dir = path.join(dataRoot, 'restart-activity');
  function record(target, at = now()) {
    target = normalizeTarget(target);
    if (!Number.isFinite(at) || at < 0) throw Error('Invalid activity timestamp');
    const file = path.join(dir, targetKey(target) + '.json');
    const previous = readJson(file, null);
    require('./maintenance').atomicJson(file, { target, at: Math.max(previous?.at || 0, at) });
    return target;
  }
  function snapshot(at = now()) {
    const result = new Map();
    const recent = time => Number.isFinite(time) && time <= at && time >= at - WINDOW_MS;
    function add(target) {
      target = normalizeTarget(target);
      // Never append into a session absent from this profile. Chat delivery can
      // still survive session deletion; no lookup of a replacement active session.
      if (target.sessionId && !fs.existsSync(path.join(usersRoot, target.username, 'sessions', target.sessionId + '.json'))) target.sessionId = null;
      if (target.chatId == null && !target.sessionId) return;
      result.set(targetKey(target), target);
    }
    const recordedSessions = new Set();
    for (const file of jsonFiles(dir)) {
      const entry = readJson(path.join(dir, file));
      if (entry.target.sessionId) recordedSessions.add(JSON.stringify([entry.target.username, entry.target.sessionId]));
      if (recent(entry.at)) add(entry.target);
    }
    // Active tasks qualify even if their start time is old or unknown. Queued
    // work qualifies through its recorded user activity, not through polling.
    const pendingDir = path.join(dataRoot, 'pending-tasks');
    const execution = require('./restart-execution').currentExecution();
    if (execution) {
      for (const intent of execution.store.all()) {
        if (intent.state === 'completed' && recent(intent.completedAt)) add({username:intent.owner.username,chatId:intent.owner.chatId,threadId:intent.owner.threadId,sessionId:intent.owner.sessionId});
      }
    }
    const pending = execution ? execution.pending() : jsonFiles(pendingDir).map(file => readJson(path.join(pendingDir, file)));
    for (const p of pending) {
      if (['running', 'delivering'].includes(p.phase) || recent(Object.hasOwn(p, 'initiatedAt') ? p.initiatedAt : p.startedAt)) {
        if (p.username && (p.userId || p.sessionId)) add({ username: p.username, chatId: p.userId, sessionId: p.sessionId, threadId: p.threadId });
      }
    }
    // Upgrade bridge: work completed before the activity journal was installed.
    // lastAt is only a prefilter; restart/service notices never count as activity.
    let profiles;
    try { profiles = fs.readdirSync(usersRoot, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return [...result.values()]; throw e; }
    for (const profile of profiles) {
      if (!profile.isDirectory() || !safeId(profile.name)) continue;
      const root = path.join(usersRoot, profile.name);
      const index = readJson(path.join(root, 'sessions.json'), []);
      for (const meta of index) {
        if (!safeId(meta.id) || !recent(meta.lastAt) || recordedSessions.has(JSON.stringify([profile.name, meta.id]))) continue;
        const full = readJson(path.join(root, 'sessions', meta.id + '.json'), null);
        if (!full || !full.messages?.some(m => recent(m.at) && !m.restartEventId && !m.serviceEventId && ['user', 'assistant'].includes(m.role))) continue;
        add({ username: profile.name, chatId: full.liveChatId ?? full.ownerChatId, sessionId: meta.id, threadId: full.threadId });
      }
    }
    return [...result.values()];
  }
  return { record, snapshot };
}
const activity = createActivityStore();
module.exports = { activity, createActivityStore, normalizeTarget, targetKey, WINDOW_MS };
