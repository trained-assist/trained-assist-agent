'use strict';
// Regression / degradation guards for #1234 Sub-2: native Claude resume.
// A future refactor of buildEngineCommand must not silently drop `--resume` — the failure is
// invisible (resume quietly degrades to a lossy context rebuild, the exact #1234 symptom).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEngineCommand } = require('../src/runner/claude-runner');

const base = {
  engine: 'claude', prompt: 'continue please',
  systemPromptText: null, ocSystemPrompt: null, opencodeModel: null,
  mcpConfig: '/tmp/mcp.json', systemPromptFile: null, user: { cwd: '/tmp' },
};

test('claude: --resume <id> is passed when a native session id is present', () => {
  const [bin, args] = buildEngineCommand({ ...base, resumeSessionId: 'sid-abc-123' });
  assert.equal(bin, process.env.CLAUDE_BIN || 'claude');
  const i = args.indexOf('--resume');
  assert.notEqual(i, -1, '--resume present');
  assert.equal(args[i + 1], 'sid-abc-123', '--resume takes the id');
  assert.equal(args[args.length - 1], 'continue please', 'prompt stays last');
  // stream-json/mcp-config must survive alongside resume (we are resuming, not reconfiguring away).
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--mcp-config'));
});

test('degradation guard: no resumeSessionId → no --resume (fresh session as before)', () => {
  for (const v of [undefined, null, '']) {
    const [, args] = buildEngineCommand({ ...base, resumeSessionId: v });
    assert.equal(args.includes('--resume'), false, `--resume must be absent for ${JSON.stringify(v)}`);
  }
});

test('codex/opencode are untouched by the claude resume flag (Sub-3/Sub-4 own them)', () => {
  const [, codexArgs] = buildEngineCommand({ ...base, engine: 'codex', resumeSessionId: 'x' });
  assert.equal(codexArgs.includes('--resume'), false, 'codex must not receive claude --resume');
  const [, ocArgs] = buildEngineCommand({ ...base, engine: 'opencode', resumeSessionId: 'x' });
  assert.equal(ocArgs.includes('--resume'), false, 'opencode must not receive claude --resume');
});
