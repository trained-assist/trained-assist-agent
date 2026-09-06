/**
 * Unit tests for src/hooks/post-tool-use-artifacts.js
 * Tests the extraction logic and integration with the artifacts store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadHook() {
  // Clear both modules so AGENT_DATA_DIR is re-read on each test
  const storePath = require.resolve('../src/artifacts-store.js');
  const hookPath = require.resolve('../src/hooks/post-tool-use-artifacts.js');
  delete require.cache[storePath];
  delete require.cache[hookPath];
  return require('../src/hooks/post-tool-use-artifacts.js');
}

function loadStore() {
  const storePath = require.resolve('../src/artifacts-store.js');
  delete require.cache[storePath];
  return require('../src/artifacts-store.js');
}

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hook-test-'));
  process.env.AGENT_DATA_DIR = tmpDir;
  process.env.AGENT_USER_ID = 'alice';
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
  delete process.env.AGENT_USER_ID;
});

// ── extractArtifacts ──────────────────────────────────────────────────────────

describe('extractArtifacts', () => {
  it('extracts URLs from tool_output', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: { command: 'curl https://api.example.com/v1' },
      tool_output: 'Connected to https://api.example.com/v1 successfully',
      tool_exit_code: 0,
    });
    const urls = result.filter(a => a.type === 'url');
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls[0].content).toContain('https://api.example.com');
  });

  it('extracts emails from tool_output', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_output: 'Contact: john.doe@company.com for details',
      tool_exit_code: 0,
    });
    const contacts = result.filter(a => a.type === 'contact');
    expect(contacts.length).toBeGreaterThanOrEqual(1);
    expect(contacts[0].content).toBe('john.doe@company.com');
    expect(contacts[0].metadata.kind).toBe('email');
  });

  it('extracts IP addresses from tool_output', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: { command: 'ping 10.0.0.5' },
      tool_output: 'PING 10.0.0.5: 56 data bytes',
      tool_exit_code: 0,
    });
    const ips = result.filter(a => a.type === 'identifier' && a.metadata.kind === 'ip_address');
    expect(ips.length).toBeGreaterThanOrEqual(1);
    expect(ips[0].content).toBe('10.0.0.5');
  });

  it('extracts masked API keys from tool_output', () => {
    const hook = loadHook();
    // ghp_ requires exactly 36 alphanumeric chars (GitHub PAT format)
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: {},
      tool_output: 'Using key: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      tool_exit_code: 0,
    });
    const keys = result.filter(a => a.type === 'identifier' && a.metadata.kind === 'api_key');
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys[0].content).toMatch(/ghp_ABCD\.\.\.6789/);
    expect(keys[0].metadata.service).toBe('github');
  });

  it('extracts ticket IDs from tool_output', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: {},
      tool_output: 'Working on PROJ-123 and FEAT-456',
      tool_exit_code: 0,
    });
    const tickets = result.filter(a => a.type === 'identifier' && a.metadata.kind === 'ticket');
    expect(tickets.map(t => t.content)).toContain('PROJ-123');
    expect(tickets.map(t => t.content)).toContain('FEAT-456');
  });

  it('extracts file_path from Write tool_input', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Write',
      tool_input: { file_path: '/home/vova/project/config.json', content: '{}' },
      tool_output: '',
      tool_exit_code: 0,
    });
    const docs = result.filter(a => a.type === 'document');
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0].content).toBe('/home/vova/project/config.json');
  });

  it('extracts file_path from Edit tool_input', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Edit',
      tool_input: { file_path: '/src/app.js', old_string: 'a', new_string: 'b' },
      tool_output: '',
      tool_exit_code: 0,
    });
    const docs = result.filter(a => a.type === 'document');
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0].content).toBe('/src/app.js');
  });

  it('captures Bash error as error artifact', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_output: 'Error: Cannot find module "webpack"',
      tool_exit_code: 1,
    });
    const errors = result.filter(a => a.type === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].content).toContain('exit 1');
    expect(errors[0].metadata.exit_code).toBe('1');
  });

  it('does NOT capture error when exit code is 0', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: { command: 'echo done' },
      tool_output: 'done',
      tool_exit_code: 0,
    });
    const errors = result.filter(a => a.type === 'error');
    expect(errors.length).toBe(0);
  });

  it('skips localhost and 127.0.0.x IPs', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: {},
      tool_output: 'Listening on 127.0.0.1:3000',
      tool_exit_code: 0,
    });
    const ips = result.filter(a => a.type === 'identifier' && a.metadata.kind === 'ip_address');
    expect(ips.length).toBe(0);
  });

  it('skips known false-positive emails', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: {},
      tool_output: 'See @anthropic or noreply@github.com for info',
      tool_exit_code: 0,
    });
    const emails = result.filter(a => a.type === 'contact');
    expect(emails.length).toBe(0);
  });

  it('returns empty array for tool_output with no extractable data', () => {
    const hook = loadHook();
    const result = hook.extractArtifacts({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_output: 'hello world',
      tool_exit_code: 0,
    });
    expect(result).toHaveLength(0);
  });
});

// ── Integration: hook writes to JSONL ────────────────────────────────────────

describe('hook integration with artifacts store', () => {
  it('processHookInput stores a URL artifact to JSONL', async () => {
    const hook = loadHook();
    await hook.processHookInput(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {},
        tool_output: 'API at https://api.myservice.com/v2',
        tool_exit_code: 0,
      },
      'alice',
    );

    const store = loadStore();
    const artifacts = store.readAll('alice');
    const urls = artifacts.filter(a => a.type === 'url');
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls[0].content).toContain('https://api.myservice.com');
  });

  it('skips when hook_event_name is not PostToolUse', async () => {
    const hook = loadHook();
    await hook.processHookInput(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_output: 'https://example.com' },
      'alice',
    );

    const store = loadStore();
    const artifacts = store.readAll('alice');
    expect(artifacts.length).toBe(0);
  });

  it('deduplication: same URL within 60s is not stored twice', async () => {
    const hook = loadHook();
    const input = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {},
      tool_output: 'https://api.myservice.com/v2 connected',
      tool_exit_code: 0,
    };

    await hook.processHookInput(input, 'alice');
    await hook.processHookInput(input, 'alice');

    const store = loadStore();
    const artifacts = store.readAll('alice');
    const urls = artifacts.filter(a => a.content === 'https://api.myservice.com/v2');
    expect(urls.length).toBe(1);
  });
});
