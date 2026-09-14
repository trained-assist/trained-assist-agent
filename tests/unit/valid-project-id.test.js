'use strict';
const assert = require('assert');
const { isValidProjectId } = require('../../src/valid-project-id');

// Regression for the live "agent /run HTTP 400 → invalid projectId" incident:
// project auto-naming (#544) mints Cyrillic folder ids via slugify (keeps а-я),
// but the /run validator was ASCII-only → every task in a chat bound to such a
// project hard-400ed. These are REAL ids taken from disk under users/*/projects/.
const REAL_CYRILLIC_IDS = [
  'generic-работает',
  'generic-qr-коды-оплат',
  'generic-веб-сессия-менеджер-и-applylink-разработ',
  'recruiting-финансовыи-советник-атон',
  'expo-flowersexpo2026',                 // ASCII ids must still pass
  'generic-https-github-com-kobzevvv-trained-assist',
];

// Must reject: path traversal and separators (projectId is a path segment).
const MUST_REJECT = [
  '../etc/passwd',
  '..',
  'a/../b',
  'foo/bar',
  'foo\\bar',
  '.hidden',        // leading dot
  '',
  'x'.repeat(201),  // over length cap
  null,
  undefined,
  42,
];

let failed = 0;
for (const id of REAL_CYRILLIC_IDS) {
  try { assert.strictEqual(isValidProjectId(id), true, `expected VALID: ${id}`); }
  catch (e) { failed++; console.error('✗', e.message); }
}
for (const id of MUST_REJECT) {
  try { assert.strictEqual(isValidProjectId(id), false, `expected REJECT: ${JSON.stringify(id)}`); }
  catch (e) { failed++; console.error('✗', e.message); }
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log(`valid-project-id: ${REAL_CYRILLIC_IDS.length + MUST_REJECT.length} assertions passed`);
