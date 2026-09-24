'use strict';
// Canonical source is trained-assist-hh-skill. Agent vendors this boundary until
// the independent domain-provider packaging migration removes local HH copies.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/hh/sync-evaluator.cjs /path/to/trained-assist-hh-skill [--check]');
const files = ['hh-evidence-evaluator.js', 'hh-recruitment-brief.js', 'hh-evaluation-trace.js'];
const manifest = { canonical: 'trained-assist/trained-assist-hh-skill', files: {} };
for (const name of files) {
  const data = fs.readFileSync(path.join(source, 'src', name));
  const target = path.join(__dirname, '../../src', name);
  if (process.argv.includes('--check')) {
    if (!data.equals(fs.readFileSync(target))) throw new Error(`Evaluator drift: ${name}`);
  } else fs.writeFileSync(target, data);
  manifest.files[name] = crypto.createHash('sha256').update(data).digest('hex');
}
if (!process.argv.includes('--check')) fs.writeFileSync(path.join(__dirname, '../../docs/hh/evaluator-source.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Shared evaluator parity verified');
