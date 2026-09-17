#!/usr/bin/env node
// Privileged host-only recovery. No server, engine, network or dispatch is started.
const fs = require('node:fs');
const { createIntentStore } = require('../src/restart-intents');
function main(args) {
  const [command, file, input] = args;
  if (args.length !== 3 || !['inspect', 'settle'].includes(command)) {
    throw Error('Usage: reconcile-restart.cjs inspect DATABASE TASK | settle DATABASE REQUEST.json');
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Error('Existing database required');
  const store = createIntentStore(file);
  try {
    if (command === 'inspect') {
      const intent = store.find(input);
      if (!intent) throw Error('Intent unavailable');
      return { snapshot: store.recoverySnapshot(input, intent.owner), intent };
    }
    const result = store.settleRecovery(JSON.parse(fs.readFileSync(input, 'utf8')));
    return { id: result.id, state: result.state, settledAt: result.recoverySettlement.settledAt };
  } finally { store.close(); }
}
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
