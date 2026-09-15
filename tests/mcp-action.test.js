/**
 * mcp-action.js — the "command → tool" fast path that bypasses Claude Code.
 *
 * The critical property under test is tenant isolation: each call spawns a
 * fresh process rather than calling registry.callTool() in-process, because
 * tool modules cache USER_ID in a module-level const at require time
 * (src/mcp-skills/tools/90-hh.js:10). An in-process call would silently run
 * every request under whichever user's id happened to be set when the tool
 * module first loaded. These tests exercise that boundary against the real
 * context-store tool (credential-free, file-based, genuinely user-scoped) —
 * not a mock — so a regression back to in-process calling would fail here.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runMcpTool, listActionTools } = require('../src/mcp-action.js');

const root = mkdtempSync(join(tmpdir(), 'mcp-action-test-'));
const workDirA = join(root, 'alice');
const workDirB = join(root, 'bob');
mkdirSync(workDirA, { recursive: true });
mkdirSync(workDirB, { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('listActionTools', () => {
  it('includes real registered tools (e.g. list_skills, context_get)', () => {
    const names = listActionTools().map(t => t.name);
    expect(names).toContain('list_skills');
    expect(names).toContain('context_get');
    expect(names).toContain('context_set');
  });
});

describe('runMcpTool', () => {
  it('rejects an unknown tool name before spawning anything', async () => {
    await expect(runMcpTool({ tool: 'not_a_real_tool', params: {}, username: 'alice', workDir: workDirA }))
      .rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('Unknown tool') });
  });

  it('rejects a missing tool name', async () => {
    await expect(runMcpTool({ tool: '', params: {}, username: 'alice', workDir: workDirA }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('runs a real tool end-to-end through the subprocess and returns its result', async () => {
    const text = await runMcpTool({ tool: 'list_skills', params: {}, username: 'alice', workDir: workDirA });
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.skills)).toBe(true);
    expect(parsed.skills.length).toBeGreaterThan(0);
  });

  it('surfaces a missing-required-param tool error as a rejection, not a crash', async () => {
    await expect(runMcpTool({ tool: 'context_get', params: {}, username: 'alice', workDir: workDirA }))
      .rejects.toBeInstanceOf(Error);
  });

  it('isolates state per username+workDir — two profiles never see each other\'s context_set value', async () => {
    await runMcpTool({
      tool: 'context_set', username: 'alice', workDir: workDirA,
      params: { skill: 'test', key: 'k', value: 'alice-value' },
    });
    await runMcpTool({
      tool: 'context_set', username: 'bob', workDir: workDirB,
      params: { skill: 'test', key: 'k', value: 'bob-value' },
    });

    const aliceText = await runMcpTool({ tool: 'context_get', username: 'alice', workDir: workDirA, params: { skill: 'test', key: 'k' } });
    const bobText = await runMcpTool({ tool: 'context_get', username: 'bob', workDir: workDirB, params: { skill: 'test', key: 'k' } });

    expect(JSON.parse(aliceText).value).toBe('alice-value');
    expect(JSON.parse(bobText).value).toBe('bob-value');
  });

  it('rejects with a timeout code if the tool takes longer than timeoutMs', async () => {
    // list_skills is instant, so a near-zero timeout reliably fires before the
    // subprocess can respond — this proves the timeout path actually kills and rejects.
    await expect(runMcpTool({ tool: 'list_skills', params: {}, username: 'alice', workDir: workDirA, timeoutMs: 1 }))
      .rejects.toMatchObject({ code: 'timeout' });
  });
});
