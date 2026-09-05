/**
 * Unit tests for the 90-artifacts.js MCP tool module.
 * Tests store_artifact, query_artifacts, get_knowledge_summary with per-user isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// We need to reset the module so DATA_DIR picks up the updated env var.
// Both 90-artifacts.js and artifacts-store.js must be cleared together.
function loadModule() {
  const storePath = require.resolve('../src/artifacts-store.js');
  const toolPath = require.resolve('../src/mcp-skills/tools/90-artifacts.js');
  delete require.cache[storePath];
  delete require.cache[toolPath];
  return require('../src/mcp-skills/tools/90-artifacts.js');
}

let tmpDir;
let mod;
let handlers;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'artifacts-test-'));
  process.env.AGENT_DATA_DIR = tmpDir;
  process.env.AGENT_USER_ID = 'alice';
  delete process.env.AGENT_SESSION_FILE;
  mod = loadModule();
  handlers = {
    store: mod.tools.store_artifact.handler,
    query: mod.tools.query_artifacts.handler,
    summary: mod.tools.get_knowledge_summary.handler,
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
  delete process.env.AGENT_USER_ID;
});

// ── store_artifact ────────────────────────────────────────────────────────────

describe('store_artifact', () => {
  it('stores an artifact and returns stored: true', async () => {
    const result = await handlers.store({ type: 'contact', content: 'John Doe <john@example.com>' });
    expect(result.stored).toBe(true);
    expect(result.total).toBe(1);
    expect(result.id).toBeDefined();
  });

  it('increments total on subsequent stores', async () => {
    await handlers.store({ type: 'contact', content: 'Alice <alice@example.com>' });
    const r2 = await handlers.store({ type: 'decision', content: 'Use Postgres' });
    expect(r2.stored).toBe(true);
    expect(r2.total).toBe(2);
  });

  it('returns stored: false for duplicate within 60s', async () => {
    await handlers.store({ type: 'config', content: 'API_KEY=abc123' });
    const r2 = await handlers.store({ type: 'config', content: 'API_KEY=abc123' });
    expect(r2.stored).toBe(false);
    expect(r2.reason).toBe('duplicate');
  });

  it('allows duplicate after type differs', async () => {
    await handlers.store({ type: 'config', content: 'same content' });
    const r2 = await handlers.store({ type: 'snippet', content: 'same content' });
    expect(r2.stored).toBe(true);
  });

  it('stores metadata alongside content', async () => {
    const result = await handlers.store({
      type: 'contact',
      content: 'Bob Smith',
      metadata: { email: 'bob@example.com', role: 'client' },
    });
    expect(result.stored).toBe(true);
  });

  it('returns error when AGENT_USER_ID is not set', async () => {
    delete process.env.AGENT_USER_ID;
    const result = await handlers.store({ type: 'contact', content: 'X' });
    expect(result.error).toBeDefined();
  });

  it('returns error for invalid type', async () => {
    const result = await handlers.store({ type: 'unknown_type', content: 'X' });
    expect(result.error).toBeDefined();
  });

  it('returns error for empty content', async () => {
    const result = await handlers.store({ type: 'contact', content: '' });
    expect(result.error).toBeDefined();
  });
});

// ── query_artifacts ───────────────────────────────────────────────────────────

describe('query_artifacts', () => {
  beforeEach(async () => {
    await handlers.store({ type: 'contact', content: 'Alice email: alice@example.com', metadata: { email: 'alice@example.com' } });
    await handlers.store({ type: 'decision', content: 'Use Postgres for relational data' });
    await handlers.store({ type: 'config', content: 'DEEPGRAM_KEY=dg-abc' });
  });

  it('returns all artifacts when no filter', async () => {
    const result = await handlers.query({});
    expect(result.found).toBe(3);
  });

  it('filters by type', async () => {
    const result = await handlers.query({ type: 'contact' });
    expect(result.found).toBe(1);
    expect(result.results).toContain('alice@example.com');
  });

  it('filters by query text in content', async () => {
    const result = await handlers.query({ query: 'postgres' });
    expect(result.found).toBe(1);
    expect(result.results).toContain('Postgres');
  });

  it('filters by query text in metadata', async () => {
    const result = await handlers.query({ query: 'email' });
    expect(result.found).toBeGreaterThanOrEqual(1);
  });

  it('respects limit parameter', async () => {
    const result = await handlers.query({ limit: 2 });
    expect(result.found).toBe(2);
  });

  it('returns error when AGENT_USER_ID not set', async () => {
    delete process.env.AGENT_USER_ID;
    const result = await handlers.query({});
    expect(result.error).toBeDefined();
  });

  it('returns found: 0 message when nothing matches', async () => {
    const result = await handlers.query({ query: 'zzznomatch' });
    expect(result.found).toBe(0);
  });
});

// ── get_knowledge_summary ─────────────────────────────────────────────────────

describe('get_knowledge_summary', () => {
  it('returns total: 0 when store is empty', async () => {
    const result = await handlers.summary();
    expect(result.total).toBe(0);
  });

  it('returns correct counts per type', async () => {
    await handlers.store({ type: 'contact', content: 'Person A' });
    await handlers.store({ type: 'contact', content: 'Person B' });
    await handlers.store({ type: 'decision', content: 'Use Redis' });

    const result = await handlers.summary();
    expect(result.total).toBe(3);
    expect(result.by_type.contact).toBe(2);
    expect(result.by_type.decision).toBe(1);
  });

  it('includes content previews in summary', async () => {
    await handlers.store({ type: 'config', content: 'Some important config value' });
    const result = await handlers.summary();
    expect(result.summary).toContain('Some important config value');
  });

  it('returns error when AGENT_USER_ID not set', async () => {
    delete process.env.AGENT_USER_ID;
    const result = await handlers.summary();
    expect(result.error).toBeDefined();
  });
});

// ── Isolation ─────────────────────────────────────────────────────────────────

describe('user isolation', () => {
  it('user B does not see artifacts stored by user A', async () => {
    // Store as Alice
    process.env.AGENT_USER_ID = 'alice';
    const aliceMod = loadModule();
    await aliceMod.tools.store_artifact.handler({ type: 'contact', content: 'Alice secret' });

    // Query as Bob
    process.env.AGENT_USER_ID = 'bob';
    const bobMod = loadModule();
    const result = await bobMod.tools.query_artifacts.handler({ query: 'Alice secret' });
    expect(result.found).toBe(0);
  });

  it('each user has independent artifact count', async () => {
    const anyMod = loadModule();
    const store = anyMod.tools.store_artifact.handler;
    const summary = anyMod.tools.get_knowledge_summary.handler;

    process.env.AGENT_USER_ID = 'alice';
    await store({ type: 'config', content: 'alice-config' });
    await store({ type: 'config', content: 'alice-config-2' });

    process.env.AGENT_USER_ID = 'bob';
    await store({ type: 'config', content: 'bob-config' });

    process.env.AGENT_USER_ID = 'alice';
    const aliceSummary = await summary();
    process.env.AGENT_USER_ID = 'bob';
    const bobSummary = await summary();

    expect(aliceSummary.total).toBe(2);
    expect(bobSummary.total).toBe(1);
  });
});
