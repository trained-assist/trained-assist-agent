/**
 * resolveToolSource — the local-vs-hh-skills routing decision from src/mcp-action.js.
 *
 * Extracted as a pure function so the fallback branch (tool name that only exists in
 * the extracted hh-skills repo) can be exercised without deleting local code or waiting
 * for a live soak period. This is a regression test on the *decision logic*, not a live
 * end-to-end smoke test — issue #942 step 11b still needs a real call against the running
 * hh-skills MCP server before the extraction is considered proven in production.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveToolSource } = require('../src/mcp-action.js');

describe('resolveToolSource', () => {
  it('routes a local-only tool to local', () => {
    const local = new Set(['context_get', 'list_skills']);
    const hh = new Set(['hh_status']);
    expect(resolveToolSource('context_get', local, hh)).toBe('local');
  });

  it('prefers local when a tool name exists in both registries (today\'s reality — 9a found zero drift)', () => {
    const local = new Set(['hh_status', 'context_get']);
    const hh = new Set(['hh_status']);
    expect(resolveToolSource('hh_status', local, hh)).toBe('local');
  });

  it('falls through to hh-skills for a tool that only exists there (post-deletion state)', () => {
    const local = new Set(['context_get']);
    const hh = new Set(['hh_status']);
    expect(resolveToolSource('hh_status', local, hh)).toBe('hh');
  });

  it('defaults to local for an unknown tool', () => {
    const local = new Set(['context_get']);
    const hh = new Set(['hh_status']);
    expect(resolveToolSource('not_a_real_tool', local, hh)).toBe('local');
  });

  it('defaults to local when the hh registry is absent (sibling repo not cloned)', () => {
    const local = new Set(['context_get']);
    expect(resolveToolSource('hh_status', local, null)).toBe('local');
  });
});
