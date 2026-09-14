// Regression for the live "agent /run HTTP 400 → invalid projectId" incident:
// project auto-naming (#544) mints Cyrillic folder ids via slugify (keeps а-я),
// but the /run validator was ASCII-only → every task in a chat bound to such a
// project hard-400ed. The VALID ids below are REAL, taken from disk under
// users/*/projects/. Run under vitest (`describe/it/expect`), like the rest of
// tests/unit — a bare node-assert script fails vitest with "No test suite found".
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isValidProjectId } = require('../../src/valid-project-id');

// Must accept: the exact charset the minter (projects.js slugify) produces.
const REAL_CYRILLIC_IDS = [
  'generic-работает',
  'generic-qr-коды-оплат',
  'generic-веб-сессия-менеджер-и-applylink-разработ',
  'recruiting-финансовыи-советник-атон',
  'expo-flowersexpo2026',                 // ASCII ids must still pass
  'generic-https-github-com-kobzevvv-trained-assist',
];

// Must reject: path traversal / separators (projectId is a single path segment),
// leading dot, empty, over-length, and non-strings.
const MUST_REJECT = [
  '../etc/passwd',
  '..',
  'a/../b',
  'foo/bar',
  'foo\\bar',
  '.hidden',
  '',
  'x'.repeat(201),
  null,
  undefined,
  42,
];

describe('isValidProjectId', () => {
  it.each(REAL_CYRILLIC_IDS)('accepts real minted id %s', (id) => {
    expect(isValidProjectId(id)).toBe(true);
  });

  it.each(MUST_REJECT.map((v) => [v]))('rejects unsafe/invalid id %j', (id) => {
    expect(isValidProjectId(id)).toBe(false);
  });
});
