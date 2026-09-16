// Restart v2 intent ledger. No singleton, timers or launches on import.
// The coordinator must close admission before recover(), and the executor must
// claim immediately before launch. Kept separate until both clients speak v2.
const fs = require('fs');
const path = require('path');
const { randomUUID, timingSafeEqual } = require('crypto');
const Database = require('better-sqlite3');
const FRESH_MS = 5 * 60 * 1000;
const TERMINAL = new Set(['completed', 'cancelled']);
const STATES = new Set(['queued', 'claimed', 'running', 'interrupted_by_restart', 'waiting_confirmation', ...TERMINAL]);
function ownerKey(owner) {
  if (!owner || typeof owner.username !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(owner.username)) throw Error('Invalid owner');
  // All fields are required, including explicit nulls for absent bindings.
  const fields = ['profileId', 'telegramUserId', 'chatId', 'threadId', 'projectId', 'sessionId'];
  if (fields.some(key => !Object.hasOwn(owner, key) ||
      (owner[key] !== null && !['string', 'number'].includes(typeof owner[key])) ||
      (typeof owner[key] === 'number' && !Number.isSafeInteger(owner[key])))) throw Error('Incomplete owner binding');
  return JSON.stringify([owner.username, ...fields.map(key => owner[key])]);
}
function validTime(value) { return Number.isSafeInteger(value) && value >= 0; }
function isFresh(intent, now) {
  const at = intent.confirmedAt ?? intent.initiatedAt;
  return validTime(at) && at <= now && now - at < FRESH_MS;
}
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function createIntentStore(file, { now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Precreate with restricted permissions before SQLite creates WAL siblings.
  const fd = fs.openSync(file, 'a', 0o600); fs.closeSync(fd);
  const db = new Database(file, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  const version = db.pragma('user_version', { simple: true });
  if (![0, 1].includes(version)) { db.close(); throw Error('Unsupported intent schema'); }
  db.exec(`CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actions (intent_id TEXT NOT NULL, action_id TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(intent_id, action_id));
    PRAGMA user_version = 1;`);
  const read = id => {
    const row = db.prepare('SELECT data FROM intents WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const write = intent => {
    if (!STATES.has(intent.state)) throw Error('Invalid intent state');
    db.prepare('INSERT INTO intents VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(intent.id, ownerKey(intent.owner), JSON.stringify(intent));
    return intent;
  };
  const atomic = fn => (...args) => db.transaction(fn).immediate(...args);
  function owned(id, owner) {
    const intent = read(id);
    if (!intent || ownerKey(intent.owner) !== ownerKey(owner)) throw Error('Intent unavailable');
    return intent;
  }
  function claimed(id, claimToken, state) {
    const intent = read(id);
    if (!intent || !sameToken(intent.claimToken, claimToken) || (state && intent.state !== state)) throw Error('Claim unavailable');
    return intent;
  }
  function waiting(intent) {
    return write({ ...intent, state: 'waiting_confirmation', confirmationToken: randomUUID(),
      claimToken: null, claimedBy: null, updatedAt: now() });
  }
  const unresolved = id => db.prepare('SELECT data FROM actions WHERE intent_id=?').all(id)
    .some(row => JSON.parse(row.data).state === 'started');
  const store = {
    close() { db.close(); },
    enqueue: atomic(({ id, owner, payload, initiatedAt = null, state = 'queued' }) => {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw Error('Invalid intent id');
      ownerKey(owner);
      const previous = read(id);
      if (previous) {
        owned(id, owner);
        // Re-delivery cannot overwrite context, revive tombstones or refresh age.
        return previous;
      }
      if (!['queued', 'interrupted_by_restart', 'completed', 'cancelled'].includes(state)) throw Error('Invalid initial state');
      if (initiatedAt !== null && (!validTime(initiatedAt) || initiatedAt > now())) throw Error('Invalid intent time');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Invalid payload');
      return write({ version: 1, id, owner, payload, initiatedAt, confirmedAt: null, state,
        createdAt: now(), updatedAt: now(), confirmationToken: null, claimToken: null, claimedBy: null });
    }),
    get(id, owner) { return owned(id, owner); },
    list(owner) {
      return db.prepare('SELECT data FROM intents WHERE owner=?').all(ownerKey(owner)).map(row => JSON.parse(row.data));
    },
    // Recovery must be called under the external coordinator's exclusive boot
    // ownership. A worker cannot steal another live worker's lease by timing out.
    recover: atomic(bootId => {
      if (typeof bootId !== 'string' || !bootId) throw Error('Boot id required');
      return db.prepare('SELECT data FROM intents').all().map(row => {
        const intent = JSON.parse(row.data);
        if (['claimed', 'running'].includes(intent.state) && intent.claimedBy !== bootId) {
          return write({ ...intent, state: 'interrupted_by_restart', claimToken: null,
            claimedBy: null, interruptedAt: now(), updatedAt: now() });
        }
        return intent;
      });
    }),
    // Apply policy at readiness and again at claim (a fresh item can age in lane).
    evaluate: atomic((id, owner) => {
      const intent = owned(id, owner);
      if (!['queued', 'interrupted_by_restart'].includes(intent.state)) return intent;
      if (!isFresh(intent, now()) || unresolved(id)) return waiting(intent);
      return intent;
    }),
    claim: atomic((id, owner, bootId, admissionOpen) => {
      const intent = owned(id, owner);
      if (admissionOpen !== true || !['queued', 'interrupted_by_restart'].includes(intent.state)) return null;
      if (!isFresh(intent, now()) || unresolved(id)) { waiting(intent); return null; }
      if (typeof bootId !== 'string' || !bootId) throw Error('Boot id required');
      return write({ ...intent, state: 'claimed', claimToken: randomUUID(), claimedBy: bootId,
        claimedAt: now(), updatedAt: now() });
    }),
    start: atomic((id, token, admissionOpen) => {
      const intent = claimed(id, token, 'claimed');
      if (admissionOpen !== true) return write({ ...intent, state: 'queued', claimToken: null, claimedBy: null, updatedAt: now() });
      if (!isFresh(intent, now())) return waiting(intent);
      return write({ ...intent, state: 'running', updatedAt: now() });
    }),
    confirm: atomic((id, owner, token) => {
      const intent = owned(id, owner);
      if (intent.state !== 'waiting_confirmation' || !sameToken(token, intent.confirmationToken)) return { accepted: false, intent };
      // Confirmation authorizes continuation, never re-execution of an uncertain
      // external action. Executor must reconcile it before a claim can succeed.
      return { accepted: true, intent: write({ ...intent, state: 'queued', confirmedAt: now(),
        confirmationToken: null, updatedAt: now() }) };
    }),
    cancel: atomic((id, owner, token) => {
      const intent = owned(id, owner);
      if (intent.state !== 'waiting_confirmation' || !sameToken(token, intent.confirmationToken)) return { accepted: false, intent };
      return { accepted: true, intent: write({ ...intent, state: 'cancelled', confirmationToken: null, updatedAt: now() }) };
    }),
    complete: atomic((id, token) => {
      const intent = claimed(id, token);
      if (intent.state === 'completed') return intent;
      if (intent.state !== 'running' || unresolved(id)) throw Error('Intent cannot complete');
      return write({ ...intent, state: 'completed', completedAt: now(), updatedAt: now() });
    }),
    beginAction: atomic((id, token, actionId, request) => {
      claimed(id, token, 'running');
      if (typeof actionId !== 'string' || !actionId) throw Error('Action id required');
      const previous = db.prepare('SELECT data FROM actions WHERE intent_id=? AND action_id=?').get(id, actionId);
      if (previous) return { execute: false, action: JSON.parse(previous.data) };
      const action = { state: 'started', request, startedAt: now() };
      db.prepare('INSERT INTO actions VALUES (?, ?, ?)').run(id, actionId, JSON.stringify(action));
      return { execute: true, action };
    }),
    finishAction: atomic((id, token, actionId, result) => {
      claimed(id, token, 'running');
      const row = db.prepare('SELECT data FROM actions WHERE intent_id=? AND action_id=?').get(id, actionId);
      if (!row) throw Error('Action unavailable');
      const previous = JSON.parse(row.data);
      if (previous.state === 'completed') return previous;
      const action = { ...previous, state: 'completed', result, finishedAt: now() };
      db.prepare('UPDATE actions SET data=? WHERE intent_id=? AND action_id=?').run(JSON.stringify(action), id, actionId);
      return action;
    }),
    // A trusted reconciliation path must supply the observed external result.
    // This is deliberately not exposed as a user-confirmation operation.
    reconcileAction: atomic((id, owner, actionId, result) => {
      const intent = owned(id, owner);
      if (!['interrupted_by_restart', 'waiting_confirmation', 'queued'].includes(intent.state)) throw Error('Intent is not recovering');
      const row = db.prepare('SELECT data FROM actions WHERE intent_id=? AND action_id=?').get(id, actionId);
      if (!row || result === undefined) throw Error('Observed action result required');
      const previous = JSON.parse(row.data);
      if (previous.state === 'completed') return previous;
      const action = { ...previous, state: 'completed', result, reconciledAt: now() };
      db.prepare('UPDATE actions SET data=? WHERE intent_id=? AND action_id=?').run(JSON.stringify(action), id, actionId);
      return action;
    }),
    importLegacy: atomic(records => {
      // Import is all-or-nothing and idempotent; never delete the source journal.
      // startedAt was rewritten on retries, so absence of initiatedAt means unknown.
      if (!Array.isArray(records)) throw Error('Invalid legacy journal');
      return records.map(p => {
        if (!p || !p.taskId || !p.username || p.userId == null || (!p.task && !p.forceClaude)) throw Error('Invalid legacy intent');
        const phase = p.phase || 'queued';
        if (!['queued', 'running', 'interrupted_by_restart', 'waiting_confirmation', 'completed', 'cancelled'].includes(phase)) throw Error('Invalid legacy phase');
        const existed = read(p.taskId);
        const intent = store.enqueue({ id: p.taskId,
          owner: { username: p.username, profileId: p.profileId ?? p.username,
            telegramUserId: p.telegramUserId ?? null, chatId: p.userId,
            threadId: p.threadId ?? null, projectId: p.projectId ?? null, sessionId: p.sessionId ?? null },
          payload: p, initiatedAt: p.initiatedAt ?? null,
          state: phase === 'running' ? 'interrupted_by_restart' : phase === 'waiting_confirmation' ? 'queued' : phase });
        return !existed && phase === 'waiting_confirmation' && intent.state === 'queued' ? waiting(intent) : intent;
      });
    }),
    retainedPayloads() {
      return db.prepare('SELECT data FROM intents').all().map(row => JSON.parse(row.data))
        .filter(intent => !TERMINAL.has(intent.state)).map(intent => ({ owner: intent.owner, payload: intent.payload }));
    },
  };
  return store;
}
function retainedIntentPayloads(file) {
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    if (db.pragma('user_version', { simple: true }) !== 1) throw Error('Unsupported intent schema');
    return db.prepare('SELECT data FROM intents').all().map(row => JSON.parse(row.data))
      .filter(intent => {
        if (!STATES.has(intent.state)) throw Error('Invalid intent state');
        return !TERMINAL.has(intent.state);
      }).map(intent => ({ owner: intent.owner, payload: intent.payload }));
  } finally { db.close(); }
}
module.exports = { createIntentStore, retainedIntentPayloads, isFresh, FRESH_MS, ownerKey };
