// The revision the running code came from.
//
// In production the agent runs from an immutable release dir
// (~/agent-releases/<sha>, issue #1391), which deliberately has no .git —
// deploy writes a `.release-sha` file at the release root. Fall back to git for
// dev checkouts, tests and any non-release run.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getReleaseSha() {
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', '.release-sha'), 'utf8').trim();
    if (v) return v;
  } catch {
    // not a release build
  }
  try {
    return execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
  } catch {
    return '';
  }
}

module.exports = { getReleaseSha };
