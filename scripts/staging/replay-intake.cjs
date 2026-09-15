#!/usr/bin/env node
// Export a private fixture by receipt ID, then exercise the real HTTP lifecycle
// against local Telegram/engine fixtures. Never invokes a live model or bot.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readTaskRecord } = require('../../src/intake-contract');
const [taskId, output, action] = process.argv.slice(2);
if (!taskId || !output || (action && action !== '--replay')) {
  console.error('Usage: node scripts/staging/replay-intake.cjs TASK_ID OUTPUT.json [--replay]');
  process.exit(2);
}
try {
  const record = readTaskRecord(taskId);
  if (!record.execution) throw new Error('No durable execution for this ID; older conversations cannot be reconstructed from receipts alone');
  const workDir = record.execution.user.workDir;
  const uploads = path.join(workDir, 'uploads', taskId);
  const files = fs.existsSync(uploads) ? fs.readdirSync(uploads).sort((a, b) => parseInt(a) - parseInt(b)).map(name => ({
    fileName: name.replace(/^\d+-/, ''), fileBase64: fs.readFileSync(path.join(uploads, name)).toString('base64'),
  })) : [];
  const task = record.execution.task.split('\n').filter(line => !line.startsWith('[Файл сохранён: ')).join('\n').trim();
  const fixture = { schema: 1, sourceTaskId: taskId, traceId: record.traceId, events: record.events,
    payload: { task, files, mode: record.execution.mode || 'deep', forceClaude: true } };
  fs.writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Private fixture written: ${path.resolve(output)}`);
  if (action === '--replay') {
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/intake-http-restart.test.js'], {
      cwd: path.resolve(__dirname, '../..'), stdio: 'inherit',
      env: { PATH: process.env.PATH, HOME: os.homedir(), INTAKE_REPLAY_FILE: path.resolve(output) },
      timeout: 60000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
