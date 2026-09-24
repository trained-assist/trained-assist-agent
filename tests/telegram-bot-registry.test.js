import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const bots = require('../src/telegram-bot-registry');
const config = { version: 1, bots: [{ id: 'default', tokenSecret: 'BOT_TOKEN' }, { id: 'freelance', tokenSecret: 'FREELANCE_BOT_TOKEN' }] };
const secrets = { BOT_TOKEN: 'main', FREELANCE_BOT_TOKEN: 'jobs' };
describe('approved Telegram delivery identity', () => {
  it('resolves trusted secret names and never reuses a selected bot as the default', () => {
    const jobs = bots.resolveBotSecrets(secrets, { botId: 'freelance' }, config);
    expect(jobs.BOT_TOKEN).toBe('jobs');
    expect(jobs.TELEGRAM_BOT_TOKEN).toBe('jobs');
    expect(bots.resolveBotSecrets(jobs, {}, config).BOT_TOKEN).toBe('main');
    expect(secrets.BOT_TOKEN).toBe('main');
    expect(() => bots.resolveBotSecrets({ BOT_TOKEN: 'main' }, { botId: 'freelance' }, config)).toThrow('credential');
    expect(() => bots.resolveBotSecrets(secrets, { botId: 'unknown' }, config)).toThrow('registered');
    expect(() => bots.resolveBotSecrets(secrets, {}, {version:1,bots:[{id:'default',tokenSecret:'AGENT_SECRET'}]})).toThrow('registry');
  });
  it('separates same-chat queue/continuations by bot and audience; keeps internal work unqueued', () => {
    const user = { username: 'alice', id: 42 };
    const keys = [{}, { botId: 'freelance' }, { audience: 'jobs' }, { id: 43 }].map(over => bots.deliveryQueueKey({ ...user, ...over }));
    expect(new Set(keys).size).toBe(4);
    expect(bots.continuationKey(user)).not.toBe(bots.continuationKey({...user,botId:'freelance'}));
    expect(bots.deliveryQueueKey({...user,id:0})).toBeNull();
  });
  it('running/stop execute only within the requested bot, audience and chat', () => {
    const src = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
    const killed = [];
    const activeTimers = new Map([
      ['alice-main', { username: 'alice', chatId: 42, proc: { kill: () => killed.push('main') } }],
      ['alice-jobs', { username: 'alice', chatId: 42, botId: 'freelance', audience: 'jobs', proc: { kill: () => killed.push('jobs') } }],
      ['alice-child-task', { username: 'alice-child', chatId: 42, proc: { kill: () => killed.push('foreign-profile') } }],
      ['alice-other', { username: 'alice', chatId: 43, botId: 'freelance', audience: 'jobs', proc: { kill: () => killed.push('other') } }],
    ]);
    const sandbox = { activeTimers, matchesDelivery: bots.matchesDelivery, console };
    vm.createContext(sandbox);
    for (const [name, end] of [['isTaskRunning', '// True while'], ['killTaskByUsername', '/**\n * Runs']]) {
      const start = src.indexOf('function '+name+'(');
      vm.runInContext(src.slice(start, src.indexOf(end, start)), sandbox);
    }
    const scope = { chatId:42, botId:'freelance', audience:'jobs' };
    expect(sandbox.isTaskRunning('alice',scope)).toBe(true);
    expect(sandbox.isTaskRunning('alice',{...scope,audience:'wrong'})).toBe(false);
    expect(sandbox.killTaskByUsername('alice',scope)).toBe(1);
    expect(killed).toEqual(['jobs']);
  });
  it('GTD restores delivery identity from disk and does not fall back when a bot secret disappears', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-bots-'));
    const prevData = process.env.AGENT_DATA_DIR, prevBots = process.env.TELEGRAM_BOTS_JSON;
    process.env.AGENT_DATA_DIR = path.join(root, 'data');
    process.env.TELEGRAM_BOTS_JSON = JSON.stringify(config);
    delete require.cache[require.resolve('../src/data-paths')];
    delete require.cache[require.resolve('../src/gtd-controller')];
    const gtd = require('../src/gtd-controller');
    const urls = [], runs = [];
    vi.stubGlobal('fetch', async url => { urls.push(String(url)); return { ok: true }; });
    const userRoot = path.join(root, 'users'), workDir = path.join(userRoot, 'alice');
    fs.mkdirSync(workDir, { recursive: true });
    const record = { sessionId: 'jobs-session', chatId: '42', username: 'alice', botId: 'freelance', audience: 'jobs',
      status: 'open', dueAt: 1, etaMinutes: 5, iterations: 0, maxIterations: 5, originalTask: 'finish work' };
    try {
      gtd.writeGtd(workDir, record);
      const deps = { baseUsersDir: userRoot, now: 2, isTaskRunning: () => false,
        getSession: () => ({ liveChatId: '42' }), runTask: async opts => { runs.push(opts); return 'GTD: done'; } };
      await gtd.runDue({ ...deps, secrets: { BOT_TOKEN: 'main' } });
      expect(runs).toHaveLength(0); expect(urls).toHaveLength(0);
      expect(gtd.readGtd(workDir, 'jobs-session').status).toBe('open');
      await gtd.runDue({ ...deps, secrets });
      await new Promise(resolve => setImmediate(resolve));
      expect(runs).toHaveLength(1);
      expect(runs[0].user).toMatchObject({ botId: 'freelance', audience: 'jobs', id: '42' });
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every(url => url.includes('/botjobs/'))).toBe(true);
    } finally {
      gtd.durableStore().db.close();
      vi.unstubAllGlobals();
      if (prevData === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = prevData;
      if (prevBots === undefined) delete process.env.TELEGRAM_BOTS_JSON; else process.env.TELEGRAM_BOTS_JSON = prevBots;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

});
