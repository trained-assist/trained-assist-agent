// Unit tests for the universal connect tool (22-connect.js).
// All ZeroCreds API calls are intercepted by nock — no real network.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import nock from 'nock';

const require = createRequire(import.meta.url);

const TEST_UID    = 'connect-test-001';
const ZC_URL      = 'https://zerocreds.test';
const AGENT_URL   = 'https://agent.test';
const ZC_TOKEN    = 'test-zc-admin-token';
const ZC_SESSION_URL = `${ZC_URL}/u_abc123/github/form`;

function loadConnectTool() {
  // Clear module cache so env-var changes are always picked up
  for (const key of Object.keys(require.cache)) {
    if (key.includes('22-connect') || key.includes('user-tokens')) {
      delete require.cache[key];
    }
  }
  return require('../../src/mcp-skills/tools/22-connect.js').tools.connect;
}

const ctx = { userId: TEST_UID };

beforeAll(() => {
  process.env.USER_ID              = TEST_UID;
  process.env.ZEROCREDS_URL        = ZC_URL;
  process.env.ZEROCREDS_ADMIN_TOKEN = ZC_TOKEN;
  process.env.AGENT_PUBLIC_URL     = AGENT_URL;
  nock.disableNetConnect();
});

afterAll(() => {
  delete process.env.USER_ID;
  delete process.env.ZEROCREDS_URL;
  delete process.env.ZEROCREDS_ADMIN_TOKEN;
  delete process.env.AGENT_PUBLIC_URL;
  nock.enableNetConnect();
  nock.cleanAll();
});

beforeEach(() => {
  nock.cleanAll();
});

// ── Test 1: Case A — pre-registered service (github) ──────────────────────────

describe('connect({ service: "github" }) — Case A', () => {
  it('calls ZeroCreds, returns url with github connect message', async () => {
    nock(ZC_URL)
      .post('/api/session/create', body => body.service === 'github' && body.uid === TEST_UID)
      .reply(200, { url: ZC_SESSION_URL, reused: false });

    const tool = loadConnectTool();
    const result = await tool.handler({ service: 'github' }, ctx);

    expect(result.url).toBe(ZC_SESSION_URL);
    expect(result.service).toBe('github');
    expect(result.message).toContain(ZC_SESSION_URL);
    expect(nock.isDone()).toBe(true);
  });
});

// ── Test 2: Case B — ad-hoc service with inline schema ────────────────────────

describe('connect({ key, title, fields }) — Case B', () => {
  it('creates ZeroCreds session with inline schema, returns url', async () => {
    const kinescope_url = `${ZC_URL}/u_abc123/kinescope/form`;

    nock(ZC_URL)
      .post('/api/session/create', body =>
        body.service === 'kinescope' &&
        body.uid === TEST_UID &&
        body.title === 'Kinescope' &&
        Array.isArray(body.fields)
      )
      .reply(200, { url: kinescope_url, reused: false });

    const tool = loadConnectTool();
    const result = await tool.handler({
      key: 'kinescope',
      title: 'Kinescope',
      fields: [
        { name: 'email',    label: 'Email',  type: 'email',    required: true },
        { name: 'password', label: 'Пароль', type: 'password', required: true },
      ],
    }, ctx);

    expect(result.url).toBe(kinescope_url);
    expect(result.service).toBe('kinescope');
    expect(result.message).toContain(kinescope_url);
    expect(nock.isDone()).toBe(true);
  });

  it('uses default email+password fields when fields omitted', async () => {
    const bitrix_url = `${ZC_URL}/u_abc123/bitrix24/form`;

    nock(ZC_URL)
      .post('/api/session/create', body =>
        body.service === 'bitrix24' &&
        body.fields.some(f => f.name === 'email') &&
        body.fields.some(f => f.name === 'password')
      )
      .reply(200, { url: bitrix_url, reused: false });

    const tool = loadConnectTool();
    const result = await tool.handler({ key: 'bitrix24', title: 'Bitrix24' }, ctx);

    expect(result.url).toBe(bitrix_url);
    expect(nock.isDone()).toBe(true);
  });
});

// ── Test 3: Case C — OAuth2 service (gdrive) ──────────────────────────────────

describe('connect({ service: "gdrive" }) — Case C', () => {
  it('returns delegation message without calling ZeroCreds', async () => {
    const tool = loadConnectTool();
    const result = await tool.handler({ service: 'gdrive' }, ctx);

    expect(result.delegated).toBe(true);
    expect(result.service).toBe('gdrive');
    expect(result.message).toContain('gdrive_setup');
    // No HTTP calls should have been made
    expect(nock.pendingMocks().length).toBe(0);
  });

  it('hh also returns delegation message', async () => {
    const tool = loadConnectTool();
    const result = await tool.handler({ service: 'hh' }, ctx);

    expect(result.delegated).toBe(true);
    expect(result.message).toContain('hh_connect');
  });
});

// ── Test 4: connect({}) — no service or key → error listing available ─────────

describe('connect({}) — missing service', () => {
  it('returns error with available_services list', async () => {
    const tool = loadConnectTool();
    const result = await tool.handler({}, ctx);

    expect(result.error).toBe('missing_service');
    expect(Array.isArray(result.available_services)).toBe(true);
    expect(result.available_services).toContain('github');
    expect(result.available_services).toContain('figma');
    expect(result.available_services).toContain('notion');
    expect(result.message).toBeTruthy();
  });
});

// ── Test 5: unknown service falls through to error ────────────────────────────

describe('connect({ service: "nonexistent" }) — unknown service', () => {
  it('falls through to error (not in schema, not OAuth, no key)', async () => {
    const tool = loadConnectTool();
    const result = await tool.handler({ service: 'nonexistent-service' }, ctx);

    expect(result.error).toBe('missing_service');
    expect(result.available_services).not.toContain('nonexistent-service');
  });
});
