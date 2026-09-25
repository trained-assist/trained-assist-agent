// Deterministic scenario gate. No cloud deploy or production credentials.
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const suites = JSON.parse(readFileSync(new URL('./suites.json', import.meta.url)));
const root = resolve('.');
const output = resolve('staging-results');
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'staging-gate-'));
// Allowlist instead of forwarding a developer's or CI runner's secrets.
// Every data root (incl. HOME — many paths derive from os.homedir()) lives in
// the temp dir; isolation-guard.cjs is preloaded into every scenario process
// and fails fast on a root outside it, prod credentials, or non-loopback
// outbound (epic #1365 Phase 0 gate).
const guard = resolve('scripts/staging/isolation-guard.cjs');
const blockedLog = join(temporary, 'outbound-blocked.log');
const realHome = process.env.HOME || '';
const env = {
  PATH: process.env.PATH, CI: 'true', NODE_ENV: 'test',
  STAGING_ROOT: temporary, STAGING_ISOLATION: '1', STAGING_RUNNER_PID: String(process.pid), STAGING_BLOCKED_LOG: blockedLog,
  NODE_OPTIONS: `--require=${guard}`,
  HOME: join(temporary, 'home'),
  TMPDIR: join(temporary, 'tmp'),
  USERS_DIR: join(temporary, 'home', 'users'),
  AGENT_DATA_DIR: join(temporary, 'data'),
  AGENT_TOKENS_ROOT: join(temporary, 'tokens'),
  // Browser BINARIES only (read-only cache), never data.
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(realHome, '.cache', 'ms-playwright'),
};
for (const dir of [env.HOME, env.TMPDIR, env.USERS_DIR, env.AGENT_DATA_DIR, env.AGENT_TOKENS_ROOT]) mkdirSync(dir, { recursive: true });
// Hash the actual checkout, including tracked edits and nonignored new files.
const sourceFiles = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
const sourceHash = createHash('sha256');
for (const file of sourceFiles) {
  const bytes = existsSync(file) ? readFileSync(file) : Buffer.from('[deleted]');
  sourceHash.update(JSON.stringify([file, bytes.length]));
  sourceHash.update(bytes);
}
const manifest = {
  schema: 2, sourceSha256: sourceHash.digest('hex'),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  node: process.version, kind: 'deterministic-replay',
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  repository: process.env.GITHUB_REPOSITORY || null,
  run: process.env.GITHUB_RUN_ID || null,
  suites, startedAt: new Date().toISOString(), result: 'failure',
};
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, env, stdio: 'inherit', timeout: 300_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Scenario command failed (${result.status}): ${args.join(' ')}`);
}
try {
  // The guard itself must refuse a non-isolated setup, or the gate proves nothing.
  const probe = spawnSync(process.execPath, ['-e', '0'], { env: { ...env, HOME: realHome || '/' }, encoding: 'utf8' });
  if (probe.status === 0) throw new Error('isolation guard did not reject a HOME outside STAGING_ROOT');
  run(['-e', "require('os');"]);
  for (const file of [...suites.vitest, ...suites.node]) {
    if (!existsSync(file)) throw new Error(`Required scenario suite missing: ${file}`);
  }
  if (!suites.vitest.length) throw new Error('No mandatory scenarios configured');
  run(['node_modules/vitest/vitest.mjs', 'run', ...suites.vitest,
    '--reporter=default', '--reporter=json', `--outputFile=${join(output, 'vitest.json')}`]);
  const report = JSON.parse(readFileSync(join(output, 'vitest.json')));
  if (!report.success || report.numPassedTests < 1 || report.numPendingTests || report.numTodoTests) {
    throw new Error('Mandatory scenarios must pass; skipped/todo/empty runs cannot approve a release');
  }
  for (const file of suites.node) run([file]);
  manifest.result = 'success';
} catch (error) {
  manifest.error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  manifest.isolation = { guard: 'scripts/staging/isolation-guard.cjs', roots: ['HOME', 'TMPDIR', 'USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_ROOT'] };
  manifest.outboundBlocked = existsSync(blockedLog) ? readFileSync(blockedLog, 'utf8').split('\n').filter(Boolean) : [];
  manifest.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  rmSync(temporary, { recursive: true, force: true });
}
