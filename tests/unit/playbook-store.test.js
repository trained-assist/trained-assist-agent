// Unit tests for the Playbook v1 registry (issue #1372, slice P0):
// schema validation, profile→sibling→system resolution, version pinning,
// prompt render, and the read-only MCP surface (playbook_list/playbook_get).
//
// data-paths.js reads USERS_DIR at module load, so each test sets a fresh tmp
// root and clears the require cache before loading the store (same pattern as
// tests/unit/durable-tasks-mcp.test.js).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let root;
let prevUsers;

const STORE = '../../src/playbook-store.js';
const PATHS = '../../src/data-paths.js';
const TOOL = '../../src/mcp-skills/tools/102-playbooks.js';

// data-paths captures USERS_DIR at load time — always reload it after setting env.
function loadStore() {
  delete require.cache[require.resolve(STORE)];
  delete require.cache[require.resolve(PATHS)];
  return require(STORE);
}

function loadTools() {
  delete require.cache[require.resolve(TOOL)];
  return loadStore(), require(TOOL).tools;
}

function profileDir(profile) { return join(root, 'users', profile, 'playbooks'); }
function siblingDir(name) { return join(root, 'siblings', name); }
function systemDir() { return join(root, 'system'); }

function validPlaybook(over = {}) {
  return {
    id: 'sample', version: 1, scope: 'system', title: 'Sample',
    goal_template: 'Do {goal}',
    stages: [{
      id: 'stage-one', title: 'Stage one',
      steps: [{
        title: 'Step one', execution_kind: 'agent', executor_role: 'researcher',
        minimum_model_level: 'bachelor', context_budget: 'small',
        validation: { done: true },
      }],
    }],
    ...over,
  };
}

function writePlaybook(dir, id, obj) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  prevUsers = process.env.USERS_DIR;
  root = mkdtempSync(join(tmpdir(), 'playbook-store-'));
  process.env.USERS_DIR = join(root, 'users');
});

afterEach(() => {
  if (prevUsers === undefined) delete process.env.USERS_DIR;
  else process.env.USERS_DIR = prevUsers;
  rmSync(root, { recursive: true, force: true });
});

describe('validatePlaybook', () => {
  it('accepts a valid v1 playbook', () => {
    const { validatePlaybook } = loadStore();
    expect(validatePlaybook(validPlaybook())).toBe(true);
  });

  it('rejects an agent step without machine-checkable validation', () => {
    const { validatePlaybook } = loadStore();
    const pb = validPlaybook();
    delete pb.stages[0].steps[0].validation;
    expect(() => validatePlaybook(pb)).toThrow(/INVALID_PLAYBOOK|validation/);
    try { validatePlaybook(pb); } catch (e) { expect(e.code).toBe('INVALID_PLAYBOOK'); }
  });

  it('rejects an invalid execution_kind and a bad version', () => {
    const { validatePlaybook } = loadStore();
    expect(() => validatePlaybook(validPlaybook({ stages: [{ id: 's', title: 'S', steps: [{ title: 'x', execution_kind: 'magic', validation: { v: true } }] }] }))).toThrow(/INVALID_PLAYBOOK/);
    expect(() => validatePlaybook(validPlaybook({ version: 0 }))).toThrow(/INVALID_PLAYBOOK/);
  });

  it('rejects unknown top-level fields (schema is closed)', () => {
    const { validatePlaybook } = loadStore();
    expect(() => validatePlaybook(validPlaybook({ surprise: true }))).toThrow(/INVALID_PLAYBOOK/);
  });
});

describe('resolution: profile → sibling → system', () => {
  it('higher precedence wins, and falls through as levels are removed', () => {
    const { PlaybookStore } = loadStore();
    writePlaybook(systemDir(), 'sample', validPlaybook({ scope: 'system', title: 'System' }));
    writePlaybook(join(siblingDir('trained-assist-freelance-skill'), 'playbooks'), 'sample', validPlaybook({ scope: 'system', title: 'Sibling' }));
    writePlaybook(profileDir('alice'), 'sample', validPlaybook({ scope: 'profile', title: 'Profile' }));

    const store = new PlaybookStore({ profileId: 'alice', systemDir: systemDir(), siblingRoots: [siblingDir('trained-assist-freelance-skill')] });
    expect(store.resolve('sample').title).toBe('Profile');
    expect(store.resolve('sample').source).toBe('profile');

    rmSync(profileDir('alice'), { recursive: true, force: true });
    expect(store.resolve('sample').title).toBe('Sibling');
    expect(store.resolve('sample').source).toBe('sibling');

    rmSync(siblingDir('trained-assist-freelance-skill'), { recursive: true, force: true });
    expect(store.resolve('sample').title).toBe('System');
    expect(store.resolve('sample').source).toBe('system');
  });

  it('profile files must declare scope "profile"; a mismatch is a config error', () => {
    const { PlaybookStore } = loadStore();
    writePlaybook(profileDir('alice'), 'sample', validPlaybook({ scope: 'system' }));
    const store = new PlaybookStore({ profileId: 'alice', systemDir: systemDir(), siblingRoots: [] });
    expect(() => store.resolve('sample')).toThrow(/SCOPE_MISMATCH/);
  });

  it('unknown id resolves to null; invalid id is not a filesystem read', () => {
    const { PlaybookStore } = loadStore();
    const store = new PlaybookStore({ profileId: 'alice', systemDir: systemDir(), siblingRoots: [] });
    expect(store.resolve('nope')).toBeNull();
    expect(store.resolve('../etc/passwd')).toBeNull();
  });

  it('version pinning returns the exact version or VERSION_NOT_FOUND', () => {
    const { PlaybookStore } = loadStore();
    writePlaybook(systemDir(), 'sample', validPlaybook({ version: 3 }));
    const store = new PlaybookStore({ profileId: 'alice', systemDir: systemDir(), siblingRoots: [] });
    expect(store.get('sample', 3).version).toBe(3);
    expect(() => store.get('sample', 2)).toThrow(/VERSION_NOT_FOUND/);
  });
});

describe('list', () => {
  it('merges levels, annotates source, and reports no diagnostics when clean', () => {
    const { PlaybookStore } = loadStore();
    writePlaybook(systemDir(), 'sample', validPlaybook({ id: 'sample', scope: 'system' }));
    writePlaybook(systemDir(), 'other', validPlaybook({ id: 'other', scope: 'system', title: 'Other' }));
    writePlaybook(profileDir('alice'), 'sample', validPlaybook({ id: 'sample', scope: 'profile', title: 'Profile override' }));

    const { playbooks, diagnostics } = new PlaybookStore({ profileId: 'alice', systemDir: systemDir(), siblingRoots: [] }).list();
    expect(diagnostics).toEqual([]);
    expect(playbooks.map(p => p.id)).toEqual(['other', 'sample']);
    expect(playbooks.find(p => p.id === 'sample').source).toBe('profile');
    expect(playbooks.find(p => p.id === 'other').source).toBe('system');
  });

  it('a malformed override yields a diagnostic and does not crash the list', () => {
    const { PlaybookStore } = loadStore();
    writePlaybook(systemDir(), 'sample', validPlaybook({ scope: 'system', title: 'System' }));
    mkdirSync(profileDir('alice'), { recursive: true });
    writeFileSync(join(profileDir('alice'), 'sample.json'), '{ not json');

    const { playbooks, diagnostics } = new PlaybookStore({ profileId: 'alice', systemDir: systemDir(), siblingRoots: [] }).list();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('INVALID_JSON');
    // resolve() refuses to mask the broken override …
    expect(() => new PlaybookStore({ profileId: 'alice', systemDir: systemDir(), siblingRoots: [] }).resolve('sample')).toThrow(/INVALID_JSON/);
    // … while list() still surfaces the system fallback, visibly flagged.
    expect(playbooks.find(p => p.id === 'sample').source).toBe('system');
  });
});

describe('renderPlaybook', () => {
  it('renders stages/steps/contract and substitutes known vars only', () => {
    const { renderPlaybook } = loadStore();
    const pb = validPlaybook();
    pb.stages[0].on_enter = [{ type: 'notify', to: 'owner', text: 'Starting {goal}' }];
    const text = renderPlaybook(pb, { goal: 'ship it' });
    expect(text).toContain('Sample (sample v1, system)');
    expect(text).toContain('Goal: Do ship it');
    expect(text).toContain('## 1. Stage one [stage-one]');
    expect(text).toContain('[researcher/bachelor/small] Step one');
    expect(text).toContain('validation: done');
    expect(text).toContain('on_enter: notify to=owner "Starting ship it"');
    expect(renderPlaybook(pb)).toContain('{goal}'); // unknown var left verbatim
  });
});

describe('system playbook: playbooks/development.json', () => {
  it('is valid and preserves all 16 engineering stages from development-playbook.js', () => {
    const { validatePlaybook } = loadStore();
    const system = require('../../playbooks/development.json');
    expect(() => validatePlaybook(system)).not.toThrow();

    const legacy = require('../../src/development-playbook.js');
    const titles = new Set(system.stages.flatMap(s => s.steps.map(step => step.title)));
    for (const { title } of legacy.stages) expect(titles.has(title)).toBe(true);
    expect(legacy.stages).toHaveLength(16);
  });

  it('ba_development_playbook behavior is unchanged (still returns the legacy object)', async () => {
    const legacy = require('../../src/mcp-skills/tools/62-business-analyst.js');
    const before = require('../../src/development-playbook.js');
    const out = await legacy.tools.ba_development_playbook.handler({});
    expect(out).toBe(before);
    expect(out.stages).toHaveLength(16);
  });
});

describe('MCP surface: playbook_list / playbook_get', () => {
  it('lists and fetches the system development playbook for a profile', async () => {
    const { playbook_list, playbook_get } = loadTools();
    const ctx = { userId: 'alice' };
    const list = await playbook_list.handler({}, ctx);
    expect(list.diagnostics).toEqual([]);
    expect(list.playbooks.map(p => p.id)).toContain('development');

    const got = await playbook_get.handler({ id: 'development', vars: { goal: 'close #1372' } }, ctx);
    expect(got.playbook.id).toBe('development');
    expect(got.render).toContain('Engineering development');
    expect(got.render).toContain('close #1372');
  });

  it('returns an error for an unknown id rather than throwing', async () => {
    const { playbook_get } = loadTools();
    const got = await playbook_get.handler({ id: 'does-not-exist' }, { userId: 'alice' });
    expect(got.error).toMatch(/not found/);
  });
});
