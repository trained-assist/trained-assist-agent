const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { pbkdf2Sync, webcrypto } = require('node:crypto');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { chromium } = require('playwright');
const { providers } = require('./providers.cjs');

const repo = path.resolve(__dirname, '../..');
const gateway = path.resolve(process.env.RECRUITER_GATEWAY_DIR || '../recruiter-e2e-gateway');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiter-e2e-'));
const reportDir = path.resolve(process.env.RECRUITER_REPORT_DIR || 'artifacts/recruiter');
const uid = 'demo-recruiter', chatId = 900001, secret = 'isolated-demo-secret';
const results = [], boundary = [];
const checkpoint = () => write(reportDir + '/progress.json', { updatedAt: new Date().toISOString(), results });
let proc, browser, base, providerBase, provider, browserProxy, sequence = 100;
const revisions = {};
let logs = '';
const originalFetch = global.fetch;
global.crypto ||= webcrypto;
const delay = ms => new Promise(r => setTimeout(r, ms));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function memoryStore() {
  const values = new Map();
  return { async get(k, opts) { const v = values.get(k); return opts?.type === 'json' && v ? JSON.parse(v) : v ?? null; },
    async put(k, v) { values.set(k, v); }, async delete(k) { values.delete(k); }, async setAlarm() {}, async deleteAlarm() {},
    async list({ prefix = '' } = {}) { return { keys: [...values.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; } };
}
async function check(id, title, fn, dependencies = []) {
  if (dependencies.some(d => !results.find(r => r.id === d && r.status === 'passed'))) {
    results.push({ id, title, status: 'blocked', error: 'Prerequisite failed: ' + dependencies.join(', ') }); checkpoint(); return;
  }
  try { await fn(); results.push({ id, title, status: 'passed' }); console.log('PASS', id, title); }
  catch (e) { results.push({ id, title, status: 'failed', error: e.message }); console.log('FAIL', id, title, e.message.slice(0, 350)); }
  checkpoint();
}
async function main() {
  assert.ok(fs.existsSync(path.join(gateway, 'src/index.js')), 'Set RECRUITER_GATEWAY_DIR to the gateway checkout');
  revisions.agent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  revisions.gateway = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gateway, encoding: 'utf8' }).trim();
  provider = providers(); providerBase = await provider.start();
  const reservation = http.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r)); base = 'http://127.0.0.1:' + port;
  const workDir = path.join(root, 'users', uid);
  fs.mkdirSync(workDir, { recursive: true }); write(root + '/clock-offset', '0');
  write(root + '/agent-tokens/' + uid + '/.chatid', String(chatId));
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'test', SECRETS_SOURCE: 'env',
    PORT: String(port), USERS_DIR: root + '/users', AGENT_DATA_DIR: root + '/agent-data',
    AGENT_TOKENS_DIR: root + '/agent-tokens', AGENT_TOKENS_ROOT: root + '/agent-tokens',
    TELEGRAM_BOT_TOKEN: 'demo-bot', AGENT_SECRET: secret, OPENROUTER_API_KEY: 'demo-llm',
    HH_CLIENT_ID: 'demo-client', HH_CLIENT_SECRET: 'demo-client-secret', HH_REDIRECT_URI: base + '/hh-callback',
    AGENT_PUBLIC_URL: base, HH_API_BASE_URL: providerBase + '/hh', TELEGRAM_API_URL: providerBase + '/telegram',
    RECRUITER_E2E_ROOT: root, RECRUITER_E2E_PROVIDER: providerBase,
    RECRUITER_E2E_PORTS: port + ',' + new URL(providerBase).port,
  };
  proc = spawn(process.execPath, ['--require', path.join(__dirname, 'isolate.cjs'), 'src/server.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', b => { logs += b; }); proc.stderr.on('data', b => { logs += b; });
  for (let i = 0; i < 100 && !logs.includes('listening on'); i++) { if (proc.exitCode !== null) throw new Error(logs); await delay(100); }
  assert.ok(logs.includes('listening on'), 'Server did not start: ' + logs);
  await build({ entryPoints: [path.join(gateway, 'src/index.js')], bundle: true, platform: 'node', format: 'cjs', outfile: root + '/gateway.cjs', logLevel: 'silent' });
  const gatewayModule = require(root + '/gateway.cjs');
  const gatewayEnv = { BOT_TOKEN: 'demo-bot', BOT_USERNAME: 'demo_recruiter_bot', AGENT_URL: base, AGENT_SECRET: secret, SESSIONS: memoryStore(), USERS: memoryStore() };
  const intake = new gatewayModule.IntakeBuffer({ storage: memoryStore() }, gatewayEnv);
  gatewayEnv.INTAKE = { idFromName: x => x, get: () => ({ fetch: (url, init) => intake.fetch(new Request(url, init)) }) };
  const salt = '00112233445566778899aabbccddeeff';
  await gatewayEnv.USERS.put('user:' + uid, JSON.stringify({ name: 'Демо Рекрутер', salt, passwordHash: pbkdf2Sync('demo-password', Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex') }));
  global.fetch = (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url || input);
    if (u.hostname === 'api.telegram.org') return originalFetch(providerBase + '/telegram' + u.pathname, init);
    if (u.origin !== base && u.origin !== providerBase) { boundary.push('gateway:' + u.origin); throw new Error('External gateway request'); }
    return originalFetch(input, init);
  };
  async function telegram(text, messageId = ++sequence) {
    const start = provider.state.telegram.length;
    const pending = [];
    const response = await gatewayModule.default.fetch(new Request('http://gateway/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: messageId,
        message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: chatId }, text } }),
    }), gatewayEnv, { waitUntil: promise => pending.push(promise) });
    assert.equal(response.status, 200); await Promise.all(pending);
    // /run acknowledges asynchronously; await a delivered response without invoking an agent.
    for (let i = 0; i < 25 && provider.state.telegram.length === start; i++) await delay(100);
    return provider.state.telegram.slice(start).map(m => m.body.text || '').join('\n');
  }
  const post = async (url, body) => {
    const r = await fetch(base + url, { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  await check('J01', 'Telegram webhook login persists recruiter session', async () => {
    assert.match(await telegram('/login ' + uid + ' demo-password'), /Добро пожаловать/);
    assert.equal(JSON.parse(await gatewayEnv.SESSIONS.get(String(chatId))).username, uid);
  });
  let link;
  await check('J02', 'Quick Answer creates real single-use HH connect link', async () => {
    const answer = await telegram('подключи hh');
    link = answer.match(/http:\/\/127\.0\.0\.1:\d+\/connect\/hh\?t=[a-f0-9]+/)?.[0];
    assert.ok(link, answer);
  }, ['J01']);
  // Browser routes do not intercept every redirect hop. An HTTP proxy denies
  // external traffic as a second boundary, including HTTPS CONNECT tunnels.
  browserProxy = http.createServer((req, res) => { boundary.push('proxy:' + req.url); res.writeHead(403).end(); });
  browserProxy.on('connect', (req, socket) => { boundary.push('proxy-connect:' + req.url); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await new Promise(r => browserProxy.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], proxy: { server: 'http://127.0.0.1:' + browserProxy.address().port, bypass: '127.0.0.1,localhost' } });
  const page = await browser.newPage();
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  let callback;
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === base && u.pathname === '/connect/hh/authorize') {
      const response = await route.fetch({ maxRedirects: 0 });
      assert.equal(response.status(), 302);
      const u = new URL(response.headers().location);
      assert.equal(u.origin + u.pathname, 'https://hh.ru/oauth/authorize');
      assert.equal(u.searchParams.get('client_id'), 'demo-client');
      assert.equal(u.searchParams.get('redirect_uri'), base + '/hh-callback');
      provider.state.oauthCodes.add('demo-code');
      callback = base + '/hh-callback?code=demo-code&state=' + u.searchParams.get('state');
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<a href="' + callback.replaceAll('&', '&amp;') + '">Демо: разрешить доступ</a>' });
    }
    if (u.origin === base || u.origin === providerBase) return route.continue();
    boundary.push('browser:' + u.origin + u.pathname); return route.abort();
  });
  await check('J03', 'Browser OAuth redirect, token exchange and replay rejection', async () => {
    await page.goto(link);
    await page.locator('a[href*="/connect/hh/authorize"]').click();
    await page.getByText('Демо: разрешить доступ').click();
    await page.waitForURL('**/hh-callback?**');
    assert.equal(read(root + '/agent-tokens/' + uid + '/hh').employer_id, 'emp-1');
    assert.equal((await fetch(callback)).status, 403);
    assert.equal((await fetch(base + '/hh-callback?code=bad&state=bad')).status, 403);
  }, ['J02']);
  await check('J04', 'Telegram creates welding vacancy draft through Quick Answers', async () => {
    assert.match(await telegram('новая вакансия'), /ваканс|материал/i);
    assert.match(await telegram('Сварщик НАКС, вахта 60/30, Москва, 180–220 тысяч, 3 года опыта. Проживание и проезд оплачены.'), /Принял/);
    assert.match(await telegram('всё'), /Сварщик/);
    assert.match(await telegram('опубликуй черновик на HH'), /draft-1/);
    assert.equal(provider.state.drafts.length, 1);
    assert.equal(provider.state.vacancies.length, 0, 'Draft must not silently count as publication');
  }, ['J03']);
  await check('G01', 'Publish the application-created draft in the simulated HH employer UI', async () => {
    await page.goto(providerBase + '/demo/draft');
    await page.getByRole('button', { name: 'Опубликовать демо-вакансию' }).click();
    assert.match(await page.locator('body').textContent(), /Опубликовано: vac-1/);
    assert.equal(provider.state.vacancies.length, 1);
    assert.equal(provider.state.vacancies[0].name, provider.state.drafts[0].name);
  }, ['J04']);

  await check('J05', 'Published vacancy selected through Telegram with manager name', async () => {
    const answer = await telegram('мои вакансии'); assert.match(answer, /Демо Рекрутер/);
    assert.equal(read(workDir + '/contexts/hh/active_vacancy.json').value.id, 'vac-1');
  }, ['G01']);
  await check('J06', 'Two polling cycles observe new response after cache expiry', async () => {
    assert.match(await telegram('сколько откликов'), /Новых: 2/);
    provider.state.addResponse('3'); write(root + '/clock-offset', String(5 * 60 * 1000));
    assert.match(await telegram('сколько откликов'), /Новых: 3/);
  }, ['J05']);
  await check('J12', 'Save ATS criteria and score full resumes through the real MCP tool', async () => {
    const config = { vacancy_title: provider.state.vacancies[0].name, required: [{ name: 'Сварщик НАКС', weight: 10 }], preferred: [], knockout: [], pass_threshold: 7, review_threshold: 5,
      proactive_search_queries: ['Сварщик НАКС'], proactive_search_queries_for: provider.state.vacancies[0].name };
    assert.equal((await post('/hh/ats-config', { username: uid, config })).status, 200);
    const result = await post('/action', { username: uid, tool: 'hh_batch_evaluate', params: {} });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const history = read(root + '/agent-data/hh/' + uid + '/candidates/1.json');
    assert.equal(typeof history.ats_result.score, 'number');
    assert.equal(history.ats_result.resume_version, 1);
    const scoringCalls = () => provider.state.llmPrompts.filter(p => p.messages[0].content.includes('ATS-система'));
    for (const id of ['1', '2', '3']) assert.ok(scoringCalls().some(p => p.messages[1].content.includes('FULL-RESUME-END-' + id)));
    const count = scoringCalls().length;
    const repeat = await post('/action', { username: uid, tool: 'hh_batch_evaluate', params: {} });
    assert.equal(repeat.status, 200);
    assert.equal(scoringCalls().length, count, 'Unchanged full resumes reuse saved scores');
  }, ['J06']);
  let review;
  await check('J07', 'Review link opens real page with full earlier experience', async () => {
    review = (await telegram('страница ревью кандидатов')).match(/http:\/\/127\.0\.0\.1:\d+\/hh\/review\?[^\s]+/)?.[0];
    assert.ok(review); await page.goto(review);
    assert.match(await page.locator('body').textContent(), /FULL-RESUME-END-1/);
    assert.deepEqual(pageErrors, []);
  }, ['J05']);
  await check('J08', 'Browser invitation reaches HH and moves candidate to consider', async () => {
    await page.getByRole('button', { name: /Все \(/ }).click();
    const card = page.locator('#tab-all .card[data-neg="1"]');
    await card.locator('textarea').fill('Сергей, приглашаем на собеседование по вакансии сварщика.');
    page.on('dialog', d => d.accept());
    await card.locator('.btn-send').click();
    await page.waitForFunction(() => document.querySelector('#tab-all .card[data-neg="1"]').classList.contains('done'));
    assert.equal(provider.state.messages['1'].length, 1);
    assert.match(provider.state.messages['1'][0].text, /приглашаем/);
    assert.equal(provider.state.negotiations.find(n => n.id === '1').state.id, 'consider');
  }, ['J07']);
  await check('J09', 'Rejection partial failure/retry sends standard text exactly once', async () => {
    const card = page.locator('#tab-all .card[data-neg="2"]');
    await card.locator('textarea').fill('Все круто, давайте дальше работать!');
    provider.state.faults['PUT /hh/negotiations/discard_vacancy_closed/2'] = 503;
    await card.locator('.btn-send-reject').click();
    await page.waitForFunction(() => !document.querySelector('#tab-all .card[data-neg="2"] .btn-send-reject').disabled);
    assert.equal(provider.state.messages['2'].length, 1);
    assert.match(provider.state.messages['2'][0].text, /Иван/);
    assert.match(provider.state.messages['2'][0].text, /решили продолжить с другими кандидатами/);
    assert.doesNotMatch(provider.state.messages['2'][0].text, /давайте дальше работать/);
    assert.match(await card.locator('.rejection-status').textContent(), /сообщение|Сообщение/);
    assert.equal(provider.state.negotiations.find(n => n.id === '2').state.id, 'response');
    await page.reload();
    await page.getByRole('button', { name: /Все \(/ }).click();
    assert.match(await card.locator('.rejection-status').textContent(), /Сообщение отправлено, но перевод/);
    delete provider.state.faults['PUT /hh/negotiations/discard_vacancy_closed/2'];
    await card.locator('.btn-send-reject').click();
    await page.waitForFunction(() => document.querySelector('#tab-all .card[data-neg="2"]').classList.contains('done'));
    assert.equal(provider.state.messages['2'].length, 1);
    assert.equal(provider.state.negotiations.find(n => n.id === '2').state.id, 'discard');
    assert.match(await card.locator('.rejection-status').textContent(), /Кандидат переведён в отказ/);
    await page.reload();
    await page.getByRole('button', { name: /Все \(/ }).click();
    assert.match(await card.locator('.rejection-status').textContent(), /Кандидат переведён в отказ/);
    assert.equal(await card.locator('.btn-send-reject').isDisabled(), true);
    fs.mkdirSync(reportDir, { recursive: true });
    await page.screenshot({ path: reportDir + '/review.png', fullPage: true });
    assert.match(await page.locator('body').textContent(), /отказ|Отказ/);
  }, ['J07']);
  await check('G02', 'Cold-search tool returns candidates and a working browser page', async () => {
    const result = await post('/action', { username: uid, tool: 'hh_proactive_search', params: {} });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.result.count, 1, JSON.stringify(result.body));
    assert.ok(provider.state.calls.some(c => c.key === 'GET /hh/resumes'));
    await page.goto(result.body.result.url);
    assert.match(await page.locator('body').textContent(), /Сварщик/);
    const candidates = await fetch(base + '/api/hh/proactive/candidates?' + new URL(result.body.result.url).searchParams);
    assert.match(await candidates.text(), /resume-cold-1/);
    assert.equal(provider.state.messages['cold-1']?.length || 0, 0, 'Search must not contact candidates');
  }, ['J12']);
  await check('J10', 'Review mutation rejects missing authorization without side effects', async () => {
    const before = JSON.stringify({ messages: provider.state.messages, negotiations: provider.state.negotiations });
    const callCount = provider.state.calls.length;
    for (const endpoint of ['/hh/send', '/hh/reject', '/hh/send-and-reject']) {
      for (const authorization of ['', 'Bearer invalid']) {
        const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
          body: JSON.stringify({ username: uid, negotiation_id: '3', negotiation_ids: ['3'], message: 'unauthorized' }) });
        assert.equal(response.status, 403);
      }
    }
    assert.equal(provider.state.calls.length, callCount, 'Unauthorized requests must never reach a provider');
    assert.equal(JSON.stringify({ messages: provider.state.messages, negotiations: provider.state.negotiations }), before);
  });
  await check('J11', 'No unknown provider requests, external egress, or agent processes', async () => {
    assert.deepEqual(provider.state.unexpected, []);
    assert.deepEqual(boundary, []);
    assert.equal(fs.existsSync(root + '/violations.jsonl') ? fs.readFileSync(root + '/violations.jsonl', 'utf8') : '', '');
  });
  fs.mkdirSync(reportDir, { recursive: true });
  await page.screenshot({ path: reportDir + '/proactive.png', fullPage: true });
  write(reportDir + '/server.log', logs);
  write(reportDir + '/provider-journal.json', provider.state.calls);
}

let watchdog;
const stop = new Promise((_, reject) => {
  watchdog = setTimeout(() => reject(new Error('Recruiter journey exceeded 180 seconds')), 180000);
  process.once('SIGTERM', () => reject(new Error('Interrupted by SIGTERM; inspect progress.json')));
  process.once('SIGINT', () => reject(new Error('Interrupted by SIGINT; inspect progress.json')));
});
Promise.race([main(), stop]).catch(e => { results.push({ id: 'HARNESS', status: 'failed', error: e.stack }); console.error(e); }).finally(async () => {
  clearTimeout(watchdog);
  global.fetch = originalFetch;
  if (browser) await browser.close();
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM'); await Promise.race([new Promise(r => proc.once('exit', r)), delay(3000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  write(reportDir + '/server.log', logs);
  write(reportDir + '/boundary.json', boundary);
  if (provider) { write(reportDir + '/provider-journal.json', provider.state.calls); await provider.stop(); }
  if (browserProxy) { browserProxy.closeAllConnections(); await new Promise(r => browserProxy.close(r)); }
  const passed = results.filter(r => r.status === 'passed').length;
  const report = { revisions, passed, total: results.length, complete: results.length > 0 && passed === results.length, results,
    scope: 'Real gateway, agent, browser UI and MCP tools; simulated HH/OAuth/Telegram/LLM. Publication is a simulated HH employer action after draft creation. Cold search/scoring enter through /action, not a live LLM conversation. No live HH, delivery or model-quality claim.' };
  write(reportDir + '/report.json', report);
  write(reportDir + '/report.md', '# Recruiter acceptance run\n\n' + report.scope + '\n\n' + results.map(r => `- [${r.status === 'passed' ? 'x' : ' '}] ${r.id} ${r.title || 'Harness'} — ${r.status}${r.error ? ': ' + r.error : ''}`).join('\n'));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`${passed}/${results.length} passed; report: ${reportDir}/report.json`);
  process.exitCode = report.complete ? 0 : 1;
});
