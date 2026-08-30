import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildNalogOrigins } from '../src/browser.js';

let tmpDir;
let tokenFile;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalog-'));
  tokenFile = path.join(tmpDir, 'nalog');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildNalogOrigins', () => {
  it('returns one origin with sessionStorage for valid auth_token', () => {
    fs.writeFileSync(tokenFile, JSON.stringify({
      auth_token: 'jwt.token.here',
      refresh_token: 'refresh.here',
      expires: '2026-09-01T00:00:00Z',
    }));

    const origins = buildNalogOrigins(tokenFile);
    expect(origins).toHaveLength(1);
    expect(origins[0].origin).toBe('https://lknpd.nalog.ru');
    expect(Array.isArray(origins[0].sessionStorage)).toBe(true);

    const names = origins[0].sessionStorage.map(i => i.name);
    expect(names).toContain('auth.token');
    expect(names).toContain('refresh.token');

    const authItem = origins[0].sessionStorage.find(i => i.name === 'auth.token');
    expect(authItem.value).toBe('jwt.token.here');
  });

  it('includes refresh.token when present', () => {
    fs.writeFileSync(tokenFile, JSON.stringify({
      auth_token: 'tok',
      refresh_token: 'ref',
    }));

    const origins = buildNalogOrigins(tokenFile);
    const names = origins[0].sessionStorage.map(i => i.name);
    expect(names).toContain('refresh.token');
  });

  it('returns [] for invalid JSON', () => {
    fs.writeFileSync(tokenFile, 'not valid json {{{');
    expect(buildNalogOrigins(tokenFile)).toEqual([]);
  });

  it('returns [] when auth_token is missing', () => {
    fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'only-refresh' }));
    expect(buildNalogOrigins(tokenFile)).toEqual([]);
  });

  it('returns [] for non-existent file', () => {
    expect(buildNalogOrigins('/nonexistent/path/nalog')).toEqual([]);
  });
});
