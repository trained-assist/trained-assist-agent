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
const env = {
  PATH: process.env.PATH, CI: 'true', NODE_ENV: 'test',
  AGENT_DATA_DIR: join(temporary, 'data'),
  AGENT_TOKENS_ROOT: join(temporary, 'tokens'),
};
mkdirSync(env.AGENT_DATA_DIR, { recursive: true });
mkdirSync(env.AGENT_TOKENS_ROOT, { recursive: true });
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
  manifest.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  rmSync(temporary, { recursive: true, force: true });
}
