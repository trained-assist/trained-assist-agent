import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const Database = require('better-sqlite3');
const schema = require('../contracts/action-v1/contract.schema.json');
const snapshot = require('../contracts/action-v1/hh-tools.snapshot.json');
const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(schema);
const check = name => ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
const invocation = {
  version: 1, profileId: 'profile-a', projectId: 'recruiting-1',
  action: 'hh_sync_messages', arguments: { vacancy_id: '123' },
  trigger: 'user', idempotencyKey: 'request-1',
};
const cron = { name: 'Morning sync', schedule: '0 8 * * *', timezone: 'Europe/Moscow',
  action: 'hh_sync_messages', arguments: { vacancy_id: '123' } };

describe('versioned action/provider contracts', () => {
  it.each(['user', 'cron', 'durable_task', 'webhook', 'system'])('accepts the same action for %s', trigger => {
    expect(check('invocation')({ ...invocation, trigger })).toBe(true);
  });
  it.each(['profileId', 'projectId', 'arguments', 'trigger', 'idempotencyKey'])('requires explicit %s', key => {
    const request = { ...invocation }; delete request[key];
    expect(check('invocation')(request)).toBe(false);
  });
  it('rejects unsupported version, transport internals and path-like owner IDs', () => {
    for (const patch of [{ version: 2 }, { profileId: '../victim' }, { projectId: '' },
      { arguments: 'prompt' }, { trigger: 'scheduler' }, { token: 'secret' }, { cwd: '/tmp' }]) {
      expect(check('invocation')({ ...invocation, ...patch })).toBe(false);
    }
    expect(check('invocation')({ ...invocation, projectId: null })).toBe(true);
    expect(check('invocation')({ ...invocation, projectId: 'recruiting-финансовыи-советник' })).toBe(true);
  });
  it('preserves the existing project ID contract across Unicode and traversal cases', () => {
    const { isValidProjectId } = require('../src/valid-project-id');
    for (const projectId of ['generic-работает', '项目-1', 'project.v2', '_hidden', '.hidden', 'a..b', 'foo/bar', 'foo\\bar', 'x'.repeat(201)]) {
      expect(check('invocation')({ ...invocation, projectId })).toBe(isValidProjectId(projectId));
    }
  });
  it('distinguishes provider failure from success and unknown external outcomes', () => {
    const valid = check('result');
    expect(valid({ version: 1, executionId: 'exec-1', status: 'succeeded', output: { count: 2 } })).toBe(true);
    expect(valid({ version: 1, executionId: 'exec-1', status: 'unknown',
      error: { code: 'OUTCOME_UNKNOWN', message: 'Connection lost after submit', retryable: false } })).toBe(true);
    expect(valid({ version: 1, executionId: 'exec-1', status: 'failed', output: {} })).toBe(false);
    expect(valid({ version: 1, executionId: 'exec-1', status: 'succeeded',
      error: { code: 'ACTION_FAILED', message: 'failure', retryable: true } })).toBe(false);
  });
  it('requires declared effects, trigger permissions and retry safety', () => {
    const action = { name: 'hh_sync_messages', inputSchema: { type: 'object' },
      allowedTriggers: ['user', 'cron'], effect: 'read', requiresApproval: false, retrySafety: 'read_only' };
    const valid = check('provider');
    expect(valid({ version: 1, providerId: 'recruiting', actions: [action] })).toBe(true);
    for (const patch of [{ allowedTriggers: [] }, { allowedTriggers: ['cron', 'cron'] },
      { effect: 'unspecified' }, { retrySafety: 'always' }]) {
      expect(valid({ version: 1, providerId: 'recruiting', actions: [{ ...action, ...patch }] })).toBe(false);
    }
    const missing = { ...action }; delete missing.requiresApproval;
    expect(valid({ version: 1, providerId: 'recruiting', actions: [missing] })).toBe(false);
  });
});

describe('generic cron API input contracts', () => {
  it('accepts explicit action arguments; rejects legacy prompt and caller-supplied ownership', () => {
    expect(check('cron_create')(cron)).toBe(true);
    for (const patch of [{ profileId: 'victim' }, { project_id: 'other' }, { task: 'do something' },
      { schedule: '@hourly' }, { schedule: '0 0 8 * * *' }, { enabled: 'true' }]) {
      expect(check('cron_create')({ ...cron, ...patch })).toBe(false);
    }
  });
  it('updates only mutable fields; retries of run_now carry the same caller key', () => {
    expect(check('cron_update')({ id: 'job-1', patch: { enabled: false } })).toBe(true);
    for (const patch of [{}, { profile_id: 'victim' }, { last_status: 'succeeded' }]) {
      expect(check('cron_update')({ id: 'job-1', patch })).toBe(false);
    }
    expect(check('cron_run_now')({ id: 'job-1' })).toBe(false);
    expect(check('cron_run_now')({ id: 'job-1', idempotencyKey: 'manual-1' })).toBe(true);
    for (const name of ['cron_get', 'cron_delete']) {
      expect(check(name)({ id: '../job-1' })).toBe(false);
      expect(check(name)({ id: 'job-1' })).toBe(true);
    }
    expect(check('cron_list')({})).toBe(true);
    expect(check('cron_list')({ profileId: 'victim' })).toBe(false);
  });
});

function database() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(new URL('../contracts/action-v1/cron.sql', import.meta.url), 'utf8'));
  return db;
}
function insertExecution(db, id, profile = 'p1', project = null, key = 'request-1', cronId = null, scheduledAt = null) {
  return db.prepare(`INSERT INTO action_executions
    (id, profile_id, project_id, action, arguments_json, trigger, idempotency_key, cron_id, scheduled_at, status, created_at)
    VALUES (?, ?, ?, 'hh_sync_messages', '{}', 'cron', ?, ?, ?, 'claimed', 1000)`)
    .run(id, profile, project, key, cronId, scheduledAt);
}
function insertJob(db) {
  db.prepare(`INSERT INTO cron_jobs
    (id, profile_id, name, schedule, timezone, action, arguments_json, next_run_at, created_at, updated_at)
    VALUES ('job-1','p1','sync','0 * * * *','UTC','hh_sync_messages','{}',1000,0,0)`).run();
}

describe('SQLite contract constraints (not a runtime scheduler)', () => {
  it('deduplicates profile-level NULL scope and permits distinct profile/project keys', () => {
    const db = database();
    try {
      insertExecution(db, 'one');
      expect(() => insertExecution(db, 'duplicate')).toThrow(/UNIQUE/);
      insertExecution(db, 'other-profile', 'p2');
      insertExecution(db, 'other-project', 'p1', 'project-1');
      expect(db.prepare('SELECT count(*) AS n FROM action_executions').get().n).toBe(3);
    } finally { db.close(); }
  });
  it('deduplicates a scheduled occurrence even with different invocation keys', () => {
    const db = database();
    try {
      insertJob(db);
      insertExecution(db, 'one', 'p1', null, 'a', 'job-1', 1000);
      expect(() => insertExecution(db, 'two', 'p1', null, 'b', 'job-1', 1000)).toThrow(/UNIQUE/);
      insertExecution(db, 'later', 'p1', null, 'c', 'job-1', 2000);
      db.prepare("DELETE FROM cron_jobs WHERE id = 'job-1'").run();
      expect(db.prepare('SELECT id, cron_id FROM action_executions').all()).toEqual([
        { id: 'one', cron_id: null }, { id: 'later', cron_id: null },
      ]);
    } finally { db.close(); }
  });
  it('rejects corrupt JSON, invalid state and nonexistent job references', () => {
    const db = database();
    try {
      insertJob(db);
      for (const value of ['not-json', '[]', 'null']) {
        expect(() => db.prepare('UPDATE cron_jobs SET arguments_json = ?').run(value)).toThrow(/CHECK/);
      }
      insertExecution(db, 'one');
      expect(() => db.exec("UPDATE action_executions SET status = 'done'")).toThrow(/CHECK/);
      expect(() => insertExecution(db, 'bad', 'p1', null, 'new', 'missing', 1000)).toThrow(/FOREIGN KEY/);
    } finally { db.close(); }
  });
});

describe('existing HH provider schema snapshot', () => {
  it('captures every exported tool, including non-hh prefixed outreach tools', () => {
    expect(snapshot.tools).toHaveLength(37);
    expect(new Set(snapshot.tools.map(t => t.name)).size).toBe(37);
    expect(snapshot.tools.map(t => t.name)).toContain('cold_message_generate');
    for (const tool of snapshot.tools) expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
  });
  it('preserves required arguments for sending a message', () => {
    const tool = snapshot.tools.find(t => t.name === 'hh_send_message');
    const validate = ajv.compile(tool.inputSchema);
    expect(validate({})).toBe(false);
  });
});

// Every current core tool file has an explicit destination; new files require review.
describe('core/domain inventory coverage', () => {
  it('classifies every current tool file exactly once', () => {
    const inventory = require('../contracts/action-v1/core-tool-inventory.json');
    const actual = fs.readdirSync(new URL('../src/mcp-skills/tools/', import.meta.url)).filter(f => f.endsWith('.js')).sort();
    const classified = [...inventory.core, ...inventory.mixed, ...inventory.domain].sort();
    expect(classified).toEqual(actual);
    expect(new Set(classified).size).toBe(classified.length);
  });
});
