// Restart v2 intent ledger. No singleton, timers or launches on import.
// The coordinator must close admission before recover(), and the executor must
// claim immediately before launch. Kept separate until both clients speak v2.
const fs = require('fs');
const path = require('path');
const { randomUUID, timingSafeEqual, createHash } = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const Database = require('better-sqlite3');
const FRESH_MS = 5 * 60 * 1000;
const TERMINAL = new Set(['completed', 'cancelled']);
const STATES = new Set(['queued', 'claimed', 'running', 'interrupted_by_restart', 'waiting_confirmation', 'delivering', ...TERMINAL]);
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
  if (![0, 1, 2].includes(version)) { db.close(); throw Error('Unsupported intent schema'); }
  db.exec(`CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actions (intent_id TEXT NOT NULL, action_id TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(intent_id, action_id));
    CREATE TABLE IF NOT EXISTS confirmations (handle TEXT PRIMARY KEY, intent_id TEXT NOT NULL, data TEXT NOT NULL);
    PRAGMA user_version = 2;`);
  const read = id => {
    const row = db.prepare('SELECT data FROM intents WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const write = intent => {
    if (!STATES.has(intent.state)) throw Error('Invalid intent state');
    db.prepare('INSERT INTO intents VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, data=excluded.data')
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
    const result = write({ ...intent, state: 'waiting_confirmation', confirmationToken: randomUUID(),
      claimToken: null, claimedBy: null, updatedAt: now() });
    registerConfirmation(result);
    return result;
  }
  function registerConfirmation(intent) {
    const event = { handle: intent.confirmationToken, intentId: intent.id, createdAt: now(),
      delivered: {}, decision: null };
    db.prepare('INSERT OR IGNORE INTO confirmations VALUES (?, ?, ?)')
      .run(event.handle, intent.id, JSON.stringify(event));
  }
  function writeConfirmation(event) {
    db.prepare('UPDATE confirmations SET data=? WHERE handle=?').run(JSON.stringify(event), event.handle);
  }
  function accessible(intent, principal) {
    if (!principal || principal.username !== intent.owner.username) return false;
    if (principal.channel === 'web') return true; // verified profile cookie/delegation
    if (principal.channel !== 'telegram') return false;
    const o = intent.owner;
    // Legacy private chats can prove the sender from the chat ID. Never infer an
    // owner from a group chat, or from a currently selected project/session.
    const actor = o.telegramUserId ?? (Number(o.chatId) > 0 ? o.chatId : null);
    return actor != null && principal.telegramUserId != null &&
      String(actor) === String(principal.telegramUserId) &&
      String(o.chatId) === String(principal.chatId) &&
      (o.threadId == null ? principal.threadId == null : String(o.threadId) === String(principal.threadId));
  }
  // Upgrade waiting rows atomically; preserve any already issued v1 token.
  db.transaction(() => {
    for (const row of db.prepare('SELECT data FROM intents').all()) {
      const intent = JSON.parse(row.data);
      if (intent.state === 'waiting_confirmation') registerConfirmation(intent);
    }
  }).immediate();
  const unresolved = id => db.prepare('SELECT data FROM actions WHERE intent_id=?').all(id)
    .some(row => JSON.parse(row.data).state === 'started');
  const recoverySnapshot = (id, owner) => {
    const intent = owned(id, owner);
    const actions = db.prepare('SELECT action_id, data FROM actions WHERE intent_id=? ORDER BY action_id').all(id)
      .map(row => ({ id: row.action_id, ...JSON.parse(row.data) }));
    const digest = createHash('sha256').update(JSON.stringify({ intent, actions })).digest('hex');
    return { id, owner: intent.owner, digest, actions };
  };
  const store = {
    // Host-operator interface only. Never expose as a Telegram/web confirmation.
    recoverySnapshot: atomic(recoverySnapshot),
    settleRecovery: atomic(request => {
      const { snapshot, operator, evidence, text } = request || {};
      for (const value of [operator, evidence, text]) {
        if (typeof value !== 'string' || !value.trim()) throw Error('Operator, evidence and terminal text required');
      }
      if (!snapshot || typeof snapshot.digest !== 'string') throw Error('Recovery snapshot required');
      const intent = owned(snapshot.id, snapshot.owner);
      const receipt = { snapshot, operator, evidence, text };
      if (intent.recoverySettlement) {
        if (!isDeepStrictEqual(intent.recoverySettlement.request, receipt)) throw Error('Settlement retry mismatch');
        return intent; // ACK loss, including after delivery or another boot
      }
      if (!['waiting_confirmation', 'interrupted_by_restart', 'queued'].includes(intent.state)) throw Error('Intent is not recovering');
      if (!isDeepStrictEqual(recoverySnapshot(intent.id, intent.owner), snapshot)) throw Error('Stale recovery snapshot');
      if (!unresolved(intent.id)) throw Error('No unresolved external action');
      // The operator has checked the entire outcome. Atomically settle all unknown
      // actions AND stage the final report; never make the original prompt runnable.
      for (const action of snapshot.actions.filter(action => action.state === 'started')) {
        const { id, ...previous } = action;
        const settled = { ...previous, state: 'completed', reconciledAt: now(),
          result: { kind: 'operator-settlement', operator, evidence } };
        db.prepare('UPDATE actions SET data=? WHERE intent_id=? AND action_id=?')
          .run(JSON.stringify(settled), intent.id, id);
      }
      return write({ ...intent, state: 'delivering', claimToken: null, claimedBy: null,
        confirmationToken: null, result: { text }, resultReceipts: {}, updatedAt: now(),
        recoverySettlement: { request: receipt, settledAt: now() } });
    }),
    close() { db.close(); },
    find(id) { return read(id); },
    all() { return db.prepare('SELECT data FROM intents').all().map(row => JSON.parse(row.data)); },
    bindContext: atomic((id, token, context) => {
      const intent = claimed(id, token, 'running');
      const owner = { ...intent.owner, sessionId: context.sessionId, projectId: context.projectId ?? intent.owner.projectId };
      ownerKey(owner);
      return write({ ...intent, owner, payload: { ...intent.payload, sessionId: owner.sessionId,
        activitySessionId: owner.sessionId, projectId: owner.projectId }, updatedAt: now() });
    }),
    resultForDelivery(id) {
      const intent = read(id);
      if (intent?.state === 'delivering' && unresolved(id)) throw Error('Unresolved external action');
      return intent;
    },
    stageResult: atomic((id, token, result) => {
      const intent = claimed(id, token);
      if (!['running', 'delivering'].includes(intent.state)) throw Error('Result cannot be staged');
      if (unresolved(id)) throw Error('Unresolved external action');
      if (intent.result) return intent;
      if (!result || typeof result.text !== 'string' || !result.text.trim()) throw Error('Empty terminal result');
      return write({ ...intent, state: 'delivering', result, resultReceipts: {}, updatedAt: now() });
    }),
    presentResult: atomic((id, token, extra) => {
      const intent = claimed(id, token, 'delivering');
      return write({ ...intent, result: { ...intent.result, extra } });
    }),
    acknowledgeResult: atomic((id, channel) => {
      const intent = read(id);
      if (!intent || intent.state !== 'delivering') return;
      return write({ ...intent, resultReceipts: { ...intent.resultReceipts, [channel]: now() } });
    }),
    finishResult: atomic(id => {
      const intent = read(id);
      if (!intent || intent.state !== 'delivering') return;
      if (unresolved(id)) throw Error('Unresolved external action');
      if (!intent.resultReceipts?.session || !intent.resultReceipts?.telegram) throw Error('Result not delivered');
      return write({ ...intent, state: 'completed', completedAt: now(), updatedAt: now() });
    }),
    interrupt: atomic((id, token) => {
      const intent = claimed(id, token);
      if (!['claimed', 'running'].includes(intent.state)) return intent;
      return write({ ...intent, state: 'interrupted_by_restart', claimToken: null,
        claimedBy: null, interruptedAt: now(), updatedAt: now() });
    }),
    hold: atomic((id, owner) => {
      const intent = owned(id, owner);
      if (!['queued', 'interrupted_by_restart'].includes(intent.state)) return intent;
      return waiting(intent);
    }),
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
    // The CLI may execute tools before emitting stdout. Persist one conservative
    // uncertainty boundary for the entire process BEFORE spawning either engine.
    // A terminal engine event and its deliverable result commit together; a crash
    // anywhere before that commit cannot make an already-started run replayable.
    beginEngine: atomic((id, token, engine) => {
      if (!['claude', 'codex'].includes(engine)) throw Error('Unknown engine');
      const result = store.beginAction(id, token, `engine-run:${token}`, { kind: 'engine-run', engine });
      if (!result.execute) throw Error('Engine attempt already dispatched');
      return result;
    }),
    stageEngineResult: atomic((id, token, result) => {
      if (claimed(id, token).state === 'delivering') return store.stageResult(id, token, result);
      store.finishAction(id, token, `engine-run:${token}`, { kind: 'engine-terminal', result });
      return store.stageResult(id, token, result);
    }),
    beginAction: atomic((id, token, actionId, request) => {
      claimed(id, token, 'running');
      if (typeof actionId !== 'string' || !actionId) throw Error('Action id required');
      const encoded = JSON.stringify(request);
      if (encoded === undefined) throw Error('Action request required');
      const persistedRequest = JSON.parse(encoded);
      const previous = db.prepare('SELECT data FROM actions WHERE intent_id=? AND action_id=?').get(id, actionId);
      if (previous) {
        const action = JSON.parse(previous.data);
        if (!isDeepStrictEqual(action.request, persistedRequest)) throw Error('Action request mismatch');
        return { execute: false, action };
      }
      const action = { state: 'started', request, startedAt: now() };
      db.prepare('INSERT INTO actions VALUES (?, ?, ?)').run(id, actionId, JSON.stringify(action));
      return { execute: true, action };
    }),
    finishAction: atomic((id, token, actionId, result) => {
      claimed(id, token, 'running');
      if (JSON.stringify(result) === undefined) throw Error('Observed action result required');
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
    // Transport adapters authenticate the principal; callers never supply owner,
    // payload, task ID, project, or confirmation time as launch authority.
    confirmations(principal) {
      return db.prepare('SELECT data FROM confirmations').all().map(row => JSON.parse(row.data))
        .flatMap(event => {
          const intent = read(event.intentId);
          return intent && accessible(intent, principal) && intent.state === 'waiting_confirmation' &&
            intent.confirmationToken === event.handle ? [{ event, intent }] : [];
        });
    },
    decide: atomic((handle, principal, action) => {
      if (!['confirm', 'cancel'].includes(action)) throw Error('Invalid decision');
      const row = db.prepare('SELECT data FROM confirmations WHERE handle=?').get(handle);
      const event = row && JSON.parse(row.data);
      const intent = event && read(event.intentId);
      if (!intent || !accessible(intent, principal)) throw Error('Confirmation unavailable');
      // An ACK lost after commit returns the SAME recorded result. Never refresh
      // confirmedAt on retry, and never consume the next generation's button.
      if (event.decision) return { accepted: false, replay: true, decision: event.decision, state: intent.state };
      const result = store[action](intent.id, intent.owner, handle);
      if (!result.accepted) return { accepted: false, replay: false, decision: null, state: intent.state };
      event.decision = action; event.decidedAt = now(); writeConfirmation(event);
      return { accepted: true, replay: false, decision: action, state: result.intent.state };
    }),
    pendingConfirmationNotices() {
      return db.prepare('SELECT data FROM confirmations').all().map(row => JSON.parse(row.data))
        .flatMap(event => {
          const intent = read(event.intentId);
          return intent?.state === 'waiting_confirmation' && intent.confirmationToken === event.handle
            ? [{ event, intent }] : [];
        });
    },
    acknowledgeConfirmation: atomic((handle, channel) => {
      if (!['telegram', 'session'].includes(channel)) throw Error('Invalid delivery channel');
      const row = db.prepare('SELECT data FROM confirmations WHERE handle=?').get(handle);
      if (!row) throw Error('Confirmation unavailable');
      const event = JSON.parse(row.data);
      event.delivered[channel] ??= now(); writeConfirmation(event);
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
    if (![1, 2].includes(db.pragma('user_version', { simple: true }))) throw Error('Unsupported intent schema');
    return db.prepare('SELECT data FROM intents').all().map(row => JSON.parse(row.data))
      .filter(intent => {
        if (!STATES.has(intent.state)) throw Error('Invalid intent state');
        return !TERMINAL.has(intent.state);
      }).map(intent => ({ owner: intent.owner, payload: intent.payload }));
  } finally { db.close(); }
}
module.exports = { createIntentStore, retainedIntentPayloads, isFresh, FRESH_MS, ownerKey };
