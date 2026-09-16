// External coordinator survives the agent cgroup. Never mutate a live gate from another process.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { maintenance, atomicJson } = require('../src/maintenance');
const { SYSTEM_ROOT } = require('../src/data-paths');
const { createRestartNotifier } = require('../src/restart-notifications');
const state = maintenance.status();
if (state.id === process.argv[2] && state.phase === 'restarting') {
  const pid = Number(execFileSync('systemctl', ['show', 'assist-agent', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim());
  if (pid > 0) {
    atomicJson(path.join(SYSTEM_ROOT, 'restart-failure.json'), { id: state.id });
  } else {
    maintenance.fail('External restart/readiness failed');
    createRestartNotifier(maintenance, { token: process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN })
      .flush().catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
