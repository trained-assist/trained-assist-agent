import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isZeroCredsPreflight } = require('../../src/zerocreds-preflight.js');

describe('zerocreds preflight detection', () => {
  it('detects the top-level flag', () => {
    expect(isZeroCredsPreflight({ _zerocreds_preflight: true }, {})).toBe(true);
  });

  it('detects the flag nested inside a string `value` (agent connect-link shape)', () => {
    const payload = { value: JSON.stringify({ _zerocreds_preflight: true }) };
    expect(isZeroCredsPreflight(payload, {})).toBe(true);
  });

  it('detects the flag nested inside an object `value`', () => {
    expect(isZeroCredsPreflight({ value: { _zerocreds_preflight: true } }, {})).toBe(true);
  });

  it('detects the X-ZeroCreds-Preflight header', () => {
    expect(isZeroCredsPreflight({}, { 'x-zerocreds-preflight': 'true' })).toBe(true);
    expect(isZeroCredsPreflight({}, { 'x-zerocreds-preflight': 'True' })).toBe(true);
  });

  it('does NOT flag a real github token payload', () => {
    expect(isZeroCredsPreflight({ value: 'ghp_abcdef1234567890' }, {})).toBe(false);
    expect(isZeroCredsPreflight({ value: { value: 'ghp_abc' } }, {})).toBe(false);
    expect(isZeroCredsPreflight({ value: '{"value":"ghp_abc"}' }, {})).toBe(false);
    expect(isZeroCredsPreflight({}, {})).toBe(false);
    expect(isZeroCredsPreflight(null, null)).toBe(false);
  });

  it('does NOT flag a value that merely mentions the string but is not the flag', () => {
    expect(isZeroCredsPreflight({ value: '{"_zerocreds_preflight":false}' }, {})).toBe(false);
    expect(isZeroCredsPreflight({ value: 'note: _zerocreds_preflight here' }, {})).toBe(false);
  });
});
