import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
it('vendored evaluator matches its canonical content manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../docs/hh/evaluator-source.json', import.meta.url)));
  for (const [name, expected] of Object.entries(manifest.files)) {
    expect(createHash('sha256').update(readFileSync(new URL('../src/' + name, import.meta.url))).digest('hex')).toBe(expected);
  }
});
