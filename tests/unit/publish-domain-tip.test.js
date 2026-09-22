// Regression test: publish_page must nudge the caller to configure a branded domain
// when falling back to a raw IP/sslip.io host — flagged during the Renovatio ТЗ session
// as unprofessional for links sent to a client/partner. set_publish_domain already lets
// a profile fix this once; publish_page should say so instead of staying silent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

describe('publish_page domain_tip', () => {
  let tmpDir, prevEnv, tools;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-test-'));
    prevEnv = { USER_ID: process.env.USER_ID, AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, AGENT_PUBLIC_URL: process.env.AGENT_PUBLIC_URL };
    process.env.USER_ID = 'tester';
    process.env.AGENT_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    process.env.USER_ID = prevEnv.USER_ID;
    process.env.AGENT_DATA_DIR = prevEnv.AGENT_DATA_DIR;
    process.env.AGENT_PUBLIC_URL = prevEnv.AGENT_PUBLIC_URL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshTools() {
    delete require.cache[require.resolve('../../src/mcp-skills/tools/97-publish.js')];
    return require('../../src/mcp-skills/tools/97-publish.js').tools;
  }

  it('nudges when falling back to a raw sslip.io host', async () => {
    process.env.AGENT_PUBLIC_URL = 'https://136-65-7-197.sslip.io/agent';
    tools = freshTools();
    const res = await tools.publish_page.handler({ content: 'hello', slug: 'test-page' });
    expect(res.url).toContain('sslip.io');
    expect(res.domain_tip).toMatch(/set_publish_domain/);
  });

  it('does not nudge on a branded domain', async () => {
    process.env.AGENT_PUBLIC_URL = 'https://report.recruiter-assistant.ru';
    tools = freshTools();
    const res = await tools.publish_page.handler({ content: 'hello', slug: 'test-page-2' });
    expect(res.domain_tip).toBeUndefined();
  });
});
