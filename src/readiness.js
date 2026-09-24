'use strict';
// Readiness — "can this server accept work?", distinct from liveness (/health = process alive)
// and from per-engine state (engine_health). Spec §13: one unavailable engine must NOT make the
// whole agent unready while a fallback engine is still usable.
//
// Checks:
//   data_dir        — SYSTEM_ROOT is writable (we can persist state at all)
//   execution_owner — this process holds the data-dir ownership lock (file present; the lock
//                     itself is held for the process lifetime — see execution-owner-lock.js)
//   engine_health   — at least one engine is not 'unavailable' (fallback exists)

const fs = require('fs');
const path = require('path');
const dataPaths = require('./data-paths');

function computeReadiness({ systemRoot, engineHealth } = {}) {
  const root = systemRoot || dataPaths.SYSTEM_ROOT;
  const healthFn = engineHealth || (() => require('./engine-health').getAllEngineHealth());
  const checks = {};
  const add = (name, fn) => {
    try { checks[name] = { ok: true, ...(fn() || {}) }; }
    catch (e) { checks[name] = { ok: false, error: e.message }; }
  };

  add('data_dir', () => {
    fs.accessSync(root, fs.constants.W_OK);
  });

  add('execution_owner', () => {
    if (!fs.existsSync(path.join(root, 'execution-owner.sqlite'))) {
      throw new Error('execution-owner.sqlite missing');
    }
  });

  add('engine_health', () => {
    const health = healthFn() || {};
    const engines = Object.keys(health);
    const unavailable = engines.filter(e => health[e] && health[e].status === 'unavailable');
    if (engines.length > 0 && unavailable.length === engines.length) {
      throw new Error('all engines unavailable');
    }
    return { unavailable };
  });

  const ready = Object.values(checks).every(c => c.ok);
  return { ready, checks };
}

module.exports = { computeReadiness };
