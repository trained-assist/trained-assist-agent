'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Regression guard for the "quick command sat behind the running task" class.
// A pure-info / sync quick command must bypass the per-dialog admission queue and
// answer instantly (runner/index.js runTask() gates on isPreQueueQuickIntent).
// 2026-09-24: /switch2codex was missed. 2026-09-26: /oc_go was missed — it returned
// «↪️ Ожидаю завершения предыдущей работы…» instead of flipping the toggle instantly.
const { isPreQueueQuickIntent } = require('../src/runner/intent-engine');

test('pre-queue whitelist: sync quick commands answer before the admission queue', () => {
  for (const cmd of ['/ping', '/help', '/agent_info', '/switch2klod', '/oc_go', '/oc_openrouter', '/oc_deepseek', '/oc_max', '/settings']) {
    assert.equal(isPreQueueQuickIntent(cmd), true, `${cmd} must be a pre-queue quick intent`);
  }
});

test('pre-queue whitelist: a normal task still goes through the queue', () => {
  for (const t of ['сделай ревью кандидатов', 'запусти холодный поиск', 'почини баг в intake']) {
    assert.equal(isPreQueueQuickIntent(t), false, `${t} must NOT bypass the queue`);
  }
});
