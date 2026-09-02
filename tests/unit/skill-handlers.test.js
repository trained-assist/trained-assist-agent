// Tests testservice skill handlers directly (no MCP subprocess overhead).
// External HTTP calls are intercepted by nock — no real network.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';

const require = createRequire(import.meta.url);

const TEST_UID = 'ts-handlers-test-00002';
let tokensDir;
let tokenDir;
let tokenFile;

// Module is loaded after we set the env vars so TOKEN_BASE is resolved dynamically.
function tools() {
  // Clear cache so AGENT_TOKENS_DIR changes are always picked up.
  const key = require.resolve('../fixtures/99-testservice.js');
  delete require.cache[key];
  return require('../fixtures/99-testservice.js').tools;
}

beforeAll(() => {
  tokensDir = mkdtempSync(join(tmpdir(), 'ts-handlers-tokens-'));
  tokenDir  = join(tokensDir, TEST_UID);
  tokenFile = join(tokenDir, 'testservice');
  process.env.USER_ID           = TEST_UID;
  process.env.AGENT_TOKENS_DIR  = tokensDir;
  nock.disableNetConnect();
});

afterAll(() => {
  delete process.env.USER_ID;
  delete process.env.AGENT_TOKENS_DIR;
  nock.enableNetConnect();
  nock.cleanAll();
  try { rmSync(tokensDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  nock.cleanAll();
  try { rmSync(tokenFile); } catch {}
});

const ctx = { userId: TEST_UID };

// ── ts_status ──────────────────────────────────────────────────────────────────

describe('ts_status', () => {
  it('without token → { connected: false }', async () => {
    const r = await tools().ts_status.handler({}, ctx);
    expect(r).toEqual({ connected: false });
  });

  it('with token → { connected: true, token_prefix }', async () => {
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(tokenFile, JSON.stringify({ token: 'abcd-efgh' }), { mode: 0o600 });
    const r = await tools().ts_status.handler({}, ctx);
    expect(r.connected).toBe(true);
    expect(r.token_prefix).toBe('abcd...');
  });
});

// ── ts_get_items ───────────────────────────────────────────────────────────────

describe('ts_get_items', () => {
  it('without token → { error: "Token not set." }', async () => {
    const r = await tools().ts_get_items.handler({}, ctx);
    expect(r).toEqual({ error: 'Token not set.' });
  });

  it('with token → mocked GET /api/items → returns items array', async () => {
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(tokenFile, JSON.stringify({ token: 'test-token' }), { mode: 0o600 });

    nock('https://testservice.example.com')
      .get('/api/items')
      .reply(200, { items: [{ id: 1, name: 'Widget' }] });

    const r = await tools().ts_get_items.handler({}, ctx);
    expect(r.items).toEqual([{ id: 1, name: 'Widget' }]);
    expect(nock.isDone()).toBe(true);
  });
});

// ── ts_create_item ─────────────────────────────────────────────────────────────

describe('ts_create_item', () => {
  it('with token → mocked POST /api/items → returns created item', async () => {
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(tokenFile, JSON.stringify({ token: 'test-token' }), { mode: 0o600 });

    nock('https://testservice.example.com')
      .post('/api/items', { name: 'Gadget' })
      .reply(201, { id: 2, name: 'Gadget' });

    const r = await tools().ts_create_item.handler({ name: 'Gadget' }, ctx);
    expect(r.id).toBe(2);
    expect(r.name).toBe('Gadget');
    expect(nock.isDone()).toBe(true);
  });
});
