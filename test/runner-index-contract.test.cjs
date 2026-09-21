// Contract test for issue #942 P1.5: src/runner/index.js is the orchestrator
// re-exporting the runner's public API. This guards against a "clean extraction"
// silently dropping an export that server.js/web-routes.js/misha-bot.js depend on.
const runner = require('../src/runner');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const REQUIRED_EXPORTS = [
  'interruptForRestart',
  'runTask',
  'getQuickAnswer',
  'runQuickAnswer',
  'generateConnectLink',
  'getPendingTasks',
  'clearPendingTask',
  'ensureSkillDir',
  'isTaskRunning',
  'extendTaskTimeout',
  'stopTask',
  'stopUserTask',
  'killTaskByUsername',
  'clearPendingContinuation',
];

for (const name of REQUIRED_EXPORTS) {
  ok(typeof runner[name] === 'function', `runner.${name} must be exported as a function`);
}

// Sanity: this file must actually resolve to src/runner/index.js (the moved file),
// not a stale src/runner.js left behind by an incomplete migration.
const path = require('path');
const resolved = require.resolve('../src/runner');
ok(resolved === path.join(__dirname, '..', 'src', 'runner', 'index.js'),
  `require('../src/runner') must resolve to src/runner/index.js, got ${resolved}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
