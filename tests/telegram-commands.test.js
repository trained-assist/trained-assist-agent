/**
 * Registry ↔ implementation sync check for src/telegram-commands.js.
 *
 * Every command (and alias) listed in the registry must actually be matched by one
 * of the `*_INTENT` regexes in src/runner.js's getQuickAnswer — otherwise the registry
 * is lying about what the agent can do, and the Telegram gateway would be told to
 * forward a command nothing handles.
 *
 * This does NOT execute getQuickAnswer (many intents have side effects — killing
 * tasks, hitting GitHub/HH APIs, writing settings files). It extracts the intent
 * regexes as data and tests them directly, which is side-effect-free.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TELEGRAM_COMMANDS } = require('../src/telegram-commands.js');

function parseIntentRegexes(source) {
  const regexes = [];
  const lineStartRe = /^const\s+\w+_INTENT\s*=\s*\//;
  for (const line of source.split('\n')) {
    if (!lineStartRe.test(line)) continue;
    const start = line.indexOf('= /') + 3;
    let i = start;
    let body = '';
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\\') { body += ch + line[i + 1]; i += 2; continue; }
      if (ch === '/') break;
      body += ch;
      i++;
    }
    i++; // skip closing slash
    let flags = '';
    while (i < line.length && /[a-z]/.test(line[i])) { flags += line[i]; i++; }
    try { regexes.push(new RegExp(body, flags)); } catch { /* not a plain intent literal, skip */ }
  }
  return regexes;
}

let intentRegexes;

beforeAll(() => {
  const source = readFileSync(join(__dirname, '../src/runner.js'), 'utf8');
  intentRegexes = parseIntentRegexes(source);
  // Sanity floor — if this drops near zero, the parser broke against a runner.js
  // reformat and every case below would pass vacuously.
  expect(intentRegexes.length).toBeGreaterThan(20);
});

describe('telegram-commands registry matches a real getQuickAnswer intent', () => {
  for (const entry of TELEGRAM_COMMANDS) {
    for (const cmd of [entry.command, ...entry.aliases]) {
      it(`${cmd} is matched by some *_INTENT regex in runner.js`, () => {
        const matched = intentRegexes.some((re) => re.test(cmd));
        expect(matched, `no *_INTENT regex in runner.js matches "${cmd}"`).toBe(true);
      });
    }
  }
});
