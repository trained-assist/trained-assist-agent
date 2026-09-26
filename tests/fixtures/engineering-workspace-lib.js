'use strict';

// Stand-in for the sibling trained-assist-engineering workspace library, used via
// the ENGINEERING_WORKSPACE_LIB test seam in src/mcp-skills/tools/61-dev.js.
// Records each spawn call (plus the ephemeral git credential env it saw) and
// returns a minimal engineering-shaped result pointing at a real (git-init'd) dir
// so installGitHooks/config calls in the redirect path don't fail.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function record(deps) {
  const out = process.env.FAKE_ENGINEERING_CALLS;
  if (!out) return;
  const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
  prev.push({
    principal: deps.principal,
    repositoryUrl: deps.repositoryUrl,
    rootTaskId: deps.rootTaskId,
    workspaceRoot: deps.workspaceRoot || null,
    mirrorsRoot: deps.mirrorsRoot || null,
    gitToken: process.env.AGENT_GIT_TOKEN || null,
    credentialHelper: process.env.GIT_CONFIG_VALUE_1 || null,
  });
  fs.writeFileSync(out, JSON.stringify(prev));
}

module.exports = {
  spawnWorkspaceForTask(deps = {}) {
    record(deps);
    const root = deps.workspaceRoot || path.join(os.tmpdir(), 'fake-engineering');
    const dir = path.join(root, String(deps.rootTaskId), 'code');
    fs.mkdirSync(dir, { recursive: true });
    try { execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' }); } catch { /* best effort */ }
    return {
      status: 'code_ready',
      workspaceId: `ws-fake-${deps.rootTaskId}`,
      codePath: dir,
      branch: `eng/${deps.principal}-${deps.rootTaskId}`,
    };
  },
};
