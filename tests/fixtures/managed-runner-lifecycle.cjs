'use strict';
// Isolated child harness: real runner/session files, fake engine and Telegram.
// Does not import server.js, contact a model or touch the live task journal.
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const crypto = require('crypto');
const root = process.argv[2];
process.env.USERS_DIR = path.join(root, 'users');
process.env.AGENT_DATA_DIR = path.join(root, 'data');
process.env.AGENT_TOKENS_ROOT = path.join(root, 'tokens');
process.env.TEST_MODE = '1';
const workDir = path.join(process.env.USERS_DIR, 'managed-test');
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(process.env.AGENT_TOKENS_ROOT, { recursive: true });
const captures = path.join(root, 'engine-captures.jsonl');
const engine = path.join(root, 'fake-claude');
fs.writeFileSync(engine, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (!args.includes('--strict-mcp-config')) process.exit(8);
const configPath = args[args.indexOf('--mcp-config') + 1];
const config = JSON.parse(fs.readFileSync(configPath));
fs.appendFileSync(${JSON.stringify(captures)}, JSON.stringify({configPath, grant: config.mcpServers.fixture.env.MANAGED_MCP_GRANT}) + '\\n');
const text = 'Completed the requested calculation: 42.';
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}));
console.log(JSON.stringify({type:'result',result:text,usage:{input_tokens:1,output_tokens:1}}));
`, { mode: 0o700 });
process.env.CLAUDE_BIN = engine;
const grants = new Set(), released = [];
const runtime = {
  invokeAction() { throw new Error('Unexpected action in lifecycle harness'); },
  async bindSession(scope) {
    assert.equal(scope.profileId, 'managed-test');
    assert.ok(scope.sessionId);
    const grant = crypto.randomBytes(32).toString('hex'); grants.add(grant);
    return { mcpServers: { fixture: { command: '/bin/false', env: { MANAGED_MCP_GRANT: grant } } },
      release() { grants.delete(grant); released.push(grant); } };
  },
  async listSkills() { return []; },
};
const server = http.createServer((req, res) => {
  req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { message_id: 12 } })); });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.TELEGRAM_API_URL = `http://127.0.0.1:${server.address().port}`;
  require('../../src/managed-mcp-control').installManagedRuntime(runtime);
  const { runTask } = require('../../src/runner');
  for (let i = 0; i < 2; i++) {
    await runTask({ taskId: 'managed-lifecycle-' + i, user: { id: 987654, username: 'managed-test', name: 'Test', workDir },
      task: 'вычисли значение выражения 40 плюс 2', context: null, forceNew: true, secrets: { BOT_TOKEN: 'fixture:token' } });
    assert.equal(grants.size, 0);
  }
  const attempts = fs.readFileSync(captures, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].grant, attempts[1].grant);
  assert.deepEqual(released, attempts.map(a => a.grant));
  for (const attempt of attempts) assert.equal(fs.existsSync(attempt.configPath), false);
  assert.equal(fs.existsSync(path.join(workDir, '.mcp.json')), false);
  console.log('MANAGED_RUNNER_LIFECYCLE_PASS');
  server.close(() => process.exit(0));
})().catch(err => { console.error(err.message); server.close(() => process.exit(1)); });
