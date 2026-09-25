'use strict';
// Issue #1359 (audit L4/L5) regressions:
//  L4 — codex's `-C` and the spawned process cwd must come from ONE resolved value
//       (resolveEngineCwd), on the fresh AND resume paths. Before this, `-C` was
//       derived from user.cwd||user.workDir while spawn.cwd was derived separately;
//       they only matched by accident and would silently diverge once a distinct
//       per-run code cwd (workspace/A2) is introduced. On resume codex emits no `-C`,
//       so the process cwd is authoritative — it must be the same resolved value.
//  L5 — opencode's per-invocation config (`.opencode-mcp.json`) must NOT be written
//       into the code cwd (a git worktree): it is untracked runtime state carrying
//       env/secrets that could leak into a diff/commit/fast_verify.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildEngineCommand, runEngineProcess, resolveEngineCwd, writeOpencodeMcpConfig,
} = require('../src/runner/claude-runner');

const ENGINES = ['claude', 'codex', 'opencode'];

// macOS tmpdir is a symlink (/var → /private/var) — compare canonical paths.
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-1359-'));
  const workDir = path.join(root, 'profile');   // user.workDir — outside code
  const codeCwd = path.join(root, 'worktree');  // the git worktree / project dir
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(codeCwd, { recursive: true });
  return { root, workDir, codeCwd };
}

function writeFake(binPath) {
  // Emit engine-agnostic output; the only thing under test is the actual process cwd
  // (and, for opencode, the OPENCODE_CONFIG path opencode itself receives).
  fs.writeFileSync(binPath, `#!/usr/bin/env sh
pwd > "$CWD_OUT"
[ -n "$OPENCODE_CONFIG" ] && printf '%s' "$OPENCODE_CONFIG" > "$OC_OUT"
exit 0
`);
  fs.chmodSync(binPath, 0o755);
}

function buildArgs(engine, { user, cwd, mcpConfig = null, resumeSessionId = null }) {
  return buildEngineCommand({
    engine, prompt: 'do it', systemPromptText: null, ocSystemPrompt: null,
    opencodeModel: null, mcpConfig, systemPromptFile: null,
    user, cwd, resumeSessionId,
  });
}

async function runIn(engine, { user, cwd, bin, tag, mcpConfig = null, resumeSessionId = null }) {
  const cwdOut = path.join(user.workDir, `cwd-${tag}-${engine}.txt`);
  const ocOut = path.join(user.workDir, `oc-${tag}-${engine}.txt`);
  const [, engineArgs] = buildArgs(engine, { user, cwd, mcpConfig, resumeSessionId });
  const result = await runEngineProcess({
    engine, taskId: `t-${tag}-${engine}`, chatId: '1', thinkingStart: Date.now(),
    msgId: null, BOT_TOKEN: 'tok', secrets: {}, user, threadId: null,
    cleanEnv: { PATH: process.env.PATH, CWD_OUT: cwdOut, OC_OUT: ocOut },
    userTokens: {}, sessionFilePath: '', sessionId: null,
    restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }),
    outputCallback: null, engineBin: bin, engineArgs, cwd, mcpConfig,
  });
  return { result, cwdOut, ocOut, engineArgs };
}

test('resolveEngineCwd: project cwd wins, else workDir (non-coding tasks unchanged)', () => {
  assert.equal(resolveEngineCwd({ workDir: '/w', cwd: '/proj' }), '/proj');
  assert.equal(resolveEngineCwd({ workDir: '/w' }), '/w', 'no project → profile workDir as before');
  assert.equal(resolveEngineCwd({}), undefined);
});

test('buildEngineCommand: codex `-C` uses the passed single-source cwd, not user.cwd', () => {
  const user = { workDir: '/profile', cwd: '/stale-project' };
  const [, freshArgs] = buildArgs('codex', { user, cwd: '/resolved-code-cwd' });
  const i = freshArgs.indexOf('-C');
  assert.notEqual(i, -1, 'fresh codex keeps -C');
  assert.equal(freshArgs[i + 1], '/resolved-code-cwd', '-C must equal the resolved code cwd, not user.cwd');

  const [, resumeArgs] = buildArgs('codex', { user, cwd: '/resolved-code-cwd', resumeSessionId: 'thr-1' });
  assert.equal(resumeArgs.includes('-C'), false, 'codex exec resume rejects -C (process cwd is authoritative)');
});

test('actual process cwd == resolved code cwd for all engines, fresh and resume', async () => {
  const { workDir, codeCwd } = makeDirs();
  const bin = path.join(workDir, 'fake-engine');
  writeFake(bin);
  const user = { username: 'cwdtest', workDir, name: 'Cwd Test' };
  try {
    for (const engine of ENGINES) {
      const fresh = await runIn(engine, { user, cwd: codeCwd, bin, tag: 'fresh' });
      assert.equal(real(fs.readFileSync(fresh.cwdOut, 'utf8').trim()), real(codeCwd),
        `${engine} fresh: process cwd must be the resolved code cwd`);

      const resume = await runIn(engine, {
        user, cwd: codeCwd, bin, tag: 'resume', resumeSessionId: 'sid-1359',
      });
      assert.equal(real(fs.readFileSync(resume.cwdOut, 'utf8').trim()), real(codeCwd),
        `${engine} resume: process cwd must be the resolved code cwd`);
    }

    const [, codexResume] = buildArgs('codex', { user, cwd: codeCwd, resumeSessionId: 'sid-1359' });
    assert.ok(codexResume.includes('resume') && codexResume.includes('sid-1359'), 'codex resume args still emitted');
    const [, ocResume] = buildArgs('opencode', { user, cwd: codeCwd, resumeSessionId: 'sid-1359' });
    assert.ok(ocResume.includes('--session') && ocResume.includes('sid-1359'), 'opencode --session still emitted');
    const [, claudeResume] = buildArgs('claude', { user, cwd: codeCwd, resumeSessionId: 'sid-1359' });
    assert.ok(claudeResume.includes('--resume') && claudeResume.includes('sid-1359'), 'claude --resume still emitted');
  } finally {
    fs.rmSync(path.dirname(workDir), { recursive: true, force: true });
  }
});

test('opencode config lives in user.workDir, never in the code cwd', async () => {
  const { workDir, codeCwd } = makeDirs();
  const bin = path.join(workDir, 'fake-engine');
  writeFake(bin);
  const user = { username: 'cwdtest', workDir, name: 'Cwd Test' };
  const mcpConfig = path.join(workDir, '.mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: { 'trained-skills': { command: 'node', args: ['/opt/skills/index.js'], env: { USER_ID: '7' } } },
  }));
  try {
    const { cwdOut, ocOut } = await runIn('opencode', { user, cwd: codeCwd, bin, tag: 'oc', mcpConfig });

    assert.equal(real(fs.readFileSync(cwdOut, 'utf8').trim()), real(codeCwd), 'opencode still runs in the code cwd');
    assert.equal(fs.existsSync(path.join(codeCwd, '.opencode-mcp.json')), false,
      'runtime opencode config must NOT be created inside the code cwd (git worktree)');

    const configPath = path.join(workDir, '.opencode-mcp.json');
    assert.equal(fs.existsSync(configPath), true, 'config written to user.workDir (outside code)');
    assert.equal(fs.readFileSync(ocOut, 'utf8').trim(), configPath, 'OPENCODE_CONFIG points at the absolute out-of-code path');

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(cfg.mcp['trained-skills'].command, ['node', '/opt/skills/index.js'],
      'opencode still sees the MCP servers');
    assert.deepEqual(cfg.mcp['trained-skills'].environment, { USER_ID: '7' }, 'MCP env preserved');

    // claude/codex must not get an opencode config anywhere in the code cwd either.
    for (const engine of ['claude', 'codex']) {
      await runIn(engine, { user, cwd: codeCwd, bin, tag: 'nc', mcpConfig });
      assert.equal(fs.existsSync(path.join(codeCwd, '.opencode-mcp.json')), false,
        `${engine} must not write an opencode config into the code cwd`);
    }
  } finally {
    fs.rmSync(path.dirname(workDir), { recursive: true, force: true });
  }
});

test('writeOpencodeMcpConfig: writes under the given config dir and returns its absolute path', () => {
  const { workDir, codeCwd } = makeDirs();
  const mcpConfig = path.join(workDir, '.mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { s: { command: 'node' } } }));
  try {
    const p = writeOpencodeMcpConfig(workDir, mcpConfig);
    assert.equal(p, path.join(workDir, '.opencode-mcp.json'));
    assert.equal(fs.existsSync(path.join(codeCwd, '.opencode-mcp.json')), false);
  } finally {
    fs.rmSync(path.dirname(workDir), { recursive: true, force: true });
  }
});
