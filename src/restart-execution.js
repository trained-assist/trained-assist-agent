// Single execution authority after startup cutover. Import alone is inert.
const fs = require('fs');
const path = require('path');
const { createIntentStore } = require('./restart-intents');
const { atomicJson } = require('./maintenance');
function createExecution({ dataRoot, gate, bootId, now = Date.now, deliveryOptions = {} }) {
  if (!gate.paused()) throw Error('Execution recovery requires closed admission');
  const file = path.join(dataRoot, 'restart-intents.sqlite');
  const authorityFile = path.join(dataRoot, 'execution-authority.json');
  const authority = fs.existsSync(authorityFile) ? JSON.parse(fs.readFileSync(authorityFile, 'utf8')) : null;
  if (authority && (authority.version !== 2 || authority.store !== 'restart-intents.sqlite' || !fs.existsSync(file))) throw Error('Invalid execution authority; keep admission closed');
  const store = createIntentStore(file, { now });
  try {
    const legacyDir = path.join(dataRoot, 'pending-tasks');
    const records = !authority && fs.existsSync(legacyDir) ? fs.readdirSync(legacyDir).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(legacyDir, f), 'utf8'))) : [];
    if (!authority) store.importLegacy(records); // atomic; originals retained only as rollback evidence
    store.recover(bootId);
    for (const intent of store.all()) store.evaluate(intent.id, intent.owner);
    atomicJson(path.join(dataRoot, 'execution-authority.json'), { version: 2, store: 'restart-intents.sqlite', bootId });
  } catch (error) { store.close(); throw error; }
  const claims = new Map();
  const delivery = require('./restart-results').createResultDelivery(store, deliveryOptions);
  return {
    store,
    deliver: id => delivery.deliver(id),
    flushResults: () => delivery.flush(id => claims.has(id)),
    presentResult(id, extra) { store.presentResult(id, claims.get(id), extra); },
    stageResult(id, result) { return store.stageResult(id, claims.get(id), result); },
    beginEngine(id, engine) { return store.beginEngine(id, claims.get(id), engine); },
    stageEngineResult(id, result) { return store.stageEngineResult(id, claims.get(id), result); },
    // External-effect action ledger, scoped to the current claim. No-op (never
    // silently swallowed) when there is no active claim for id — callers must
    // not begin/finish actions outside a running claim.
    beginAction(id, actionId, request) {
      const token = claims.get(id);
      if (!token) throw Error('No active claim for action');
      return store.beginAction(id, token, actionId, request);
    },
    finishAction(id, actionId, result) {
      const token = claims.get(id);
      if (!token) throw Error('No active claim for action');
      return store.finishAction(id, token, actionId, result);
    },
    pending() { return store.all().filter(i => !['completed', 'cancelled'].includes(i.state))
      .map(i => ({ ...i.payload, phase: i.state, initiatedAt: i.initiatedAt })); },
    get(id) { return store.find(id); },
    save(id, p) {
      const previous = this.get(id);
      if (previous) return previous; // immutable request, terminal tombstones included
      return store.enqueue({ id, owner: { username: p.username, profileId: p.profileId ?? p.username,
        telegramUserId: p.telegramUserId ?? null, chatId: p.userId, threadId: p.threadId ?? null,
        projectId: p.projectId ?? null, sessionId: p.sessionId ?? p.activitySessionId ?? null },
        payload: p, initiatedAt: p.initiatedAt ?? null });
    },
    eligible(id) {
      const intent = this.get(id);
      if (!intent) throw Error('Unknown execution intent');
      return ['queued', 'interrupted_by_restart'].includes(store.evaluate(id, intent.owner).state);
    },
    start(id) {
      const intent = this.get(id);
      const claimed = store.claim(id, intent.owner, bootId, !gate.paused());
      if (!claimed) return false;
      const started = store.start(id, claimed.claimToken, !gate.paused());
      if (started.state !== 'running') return false;
      claims.set(id, started.claimToken);
      return true;
    },
    async runQuick(id, handler) {
      // Persist before invoking even synchronous handlers: they can mutate external state.
      const token = claims.get(id);
      const entry = store.beginAction(id, token, 'quick-dispatch-v1', { kind: 'quick-dispatch', version: 1 });
      if (!entry.execute) {
        if (entry.action.state !== 'completed') throw Error('Unresolved quick dispatch');
        return entry.action.result.reply;
      }
      const reply = await handler();
      // Null means no quick match. Persist it too, so engine recovery cannot re-run dispatch.
      if (reply !== null && typeof reply !== 'string') throw Error('Invalid quick reply');
      store.finishAction(id, token, 'quick-dispatch-v1', { reply });
      return reply;
    },
    bind(id, sessionId, projectId) {
      return store.bindContext(id, claims.get(id), { sessionId, projectId });
    },
    complete(id) {
      const token = claims.get(id);
      if (!token) return;
      if (this.get(id).state !== 'completed') store.complete(id, token);
      claims.delete(id);
    },
    interrupt(id, hold = false) {
      const token = claims.get(id);
      if (!token) return;
      const intent = store.interrupt(id, token); claims.delete(id);
      if (hold) store.hold(id, intent.owner);
    },
    interruptAll() { for (const id of [...claims.keys()]) this.interrupt(id); },
    canRunSession(username, sessionId) {
      const rows = store.all().reverse().filter(i => i.owner.username === username && i.owner.sessionId === sessionId)
        .sort((a,b) => b.createdAt - a.createdAt);
      return !rows.length || rows[0].state === 'completed';
    },
    candidates() { return store.all().filter(i => ['queued', 'interrupted_by_restart'].includes(i.state)); },
    close() { store.close(); },
  };
}
let execution = null;
function initializeExecution(options) {
  if (execution) throw Error('Execution authority already initialized');
  execution = createExecution(options);
  return execution;
}
module.exports = { createExecution, initializeExecution, currentExecution: () => execution };
