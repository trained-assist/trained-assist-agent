// Separate outbox survives bootstrap rollback (which removes maintenance.json).
const fs = require('fs');
const { createMaintenance } = require('../src/maintenance');
const { restartTarget, createRestartNotifier } = require('../src/restart-notifications');
async function main() {
  const [requestFile, phase] = process.argv.slice(2);
  if (requestFile === '--validate') {
    console.log(JSON.stringify(restartTarget(JSON.parse(fs.readFileSync(phase, 'utf8')))));
    return;
  }
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  if (!request.initiator) return;
  const gate = createMaintenance(requestFile + '.notifications.json');
  if (!gate.status().id) gate.request(restartTarget(request.initiator));
  if (phase === 'restarting' && gate.status().phase === 'draining') gate.claim(gate.status().id);
  if (phase === 'ready') gate.ready();
  if (phase === 'failed' && !['ready', 'failed'].includes(gate.status().phase)) gate.fail('Bootstrap failed; rollback attempted');
  if (!gate.pendingNotifications().length) return; // No secret-provider traffic after delivery.
  const secrets = await require('../src/secrets').loadSecrets();
  await createRestartNotifier(gate, { token: secrets.BOT_TOKEN }).flush();
}
main().catch(error => { console.error('[bootstrap-notification]', error.message); process.exitCode = 1; });
