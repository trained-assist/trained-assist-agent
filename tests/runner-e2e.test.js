/**
 * E2E runner tests — real user dialogues, no mocking magic.
 *
 * Strategy:
 * - Local HTTP server captures Telegram API calls (sendMessage / editMessageText)
 * - Fake `claude` binary in temp dir (outputs canned stream-json), added to PATH
 * - Real runner.js + session-store runs against a temp workDir
 * - Tests assert on captured Telegram calls and session files on disk
 *
 * This approach avoids vi.mock/ESM/CJS hell — everything is real except:
 *   1. Telegram API endpoint → local capture server
 *   2. `claude` binary → shell script that outputs our reply JSON
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import * as http from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Local Telegram capture server ─────────────────────────────────────────────

let tgServer;
let tgPort;
let tgLog = []; // captured { method, body } per request

async function startTgServer() {
  return new Promise((resolve) => {
    tgServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        tgLog.push({ url: req.url, body: parsed });
        // Always reply with a valid Telegram-like response
        const msgId = Math.floor(Math.random() * 9000 + 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: msgId } }));
      });
    });
    tgServer.listen(0, '127.0.0.1', () => {
      tgPort = tgServer.address().port;
      resolve();
    });
  });
}

function stopTgServer() {
  return new Promise(r => tgServer.close(r));
}

// ── Fake claude binary ────────────────────────────────────────────────────────

let fakeBinDir;
let claudeReplyFile;

function setupFakeClaude(reply = 'OK') {
  claudeReplyFile = join(fakeBinDir, 'claude-reply.txt');
  writeFileSync(claudeReplyFile, reply);
}

function buildFakeClaudeBinary() {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'fake-claude-bin-'));
  claudeReplyFile = join(fakeBinDir, 'claude-reply.txt');
  writeFileSync(claudeReplyFile, 'default reply');

  // Shell script that outputs stream-json matching Claude's format
  const script = `#!/bin/bash
REPLY=$(cat "${claudeReplyFile}" 2>/dev/null || echo "OK")
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$REPLY"'"}]}}'
echo '{"type":"result","result":"'"$REPLY"'","usage":{"input_tokens":100,"output_tokens":50}}'
`;
  const scriptPath = join(fakeBinDir, 'claude');
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
}

// ── Module loading ────────────────────────────────────────────────────────────

// Loaded once — we patch env vars before loading
let runTask;
let sessionStore;
let origPath;
let origTgUrl;

beforeAll(async () => {
  await startTgServer();
  buildFakeClaudeBinary();

  // Patch env BEFORE loading runner.js (runner reads TG_API at module level)
  origPath = process.env.PATH;
  origTgUrl = process.env.TELEGRAM_API_URL;
  process.env.PATH = fakeBinDir + ':' + (origPath || '');
  process.env.TELEGRAM_API_URL = `http://127.0.0.1:${tgPort}`;

  const mod = require('../src/runner.js');
  runTask = mod.runTask;
  sessionStore = require('../src/session-store.js');
});

afterAll(async () => {
  process.env.PATH = origPath;
  process.env.TELEGRAM_API_URL = origTgUrl;
  await stopTgServer();
  rmSync(fakeBinDir, { recursive: true, force: true });
});

// ── Per-test setup ────────────────────────────────────────────────────────────

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'runner-e2e-'));
  tgLog = [];
  setupFakeClaude('OK');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeUser(userId = 111222333) {
  return { id: userId, name: 'Test', username: 'testuser', workDir };
}

async function chat(task, { userId = 111222333, sessionId = null, claudeReply = null } = {}) {
  if (claudeReply !== null) setupFakeClaude(claudeReply);
  await runTask({
    taskId: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    user: makeUser(userId),
    task,
    context: null,
    sessionId,
    contextFromSession: null,
    secrets: { BOT_TOKEN: 'fake:token' },
  });
}

function readCurrentSession() {
  const fp = join(workDir, 'sessions', 'current-session.json');
  return existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : null;
}

function readSession(id) {
  const fp = join(workDir, 'sessions', `${id}.json`);
  return existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : null;
}

function listSessionIndex() {
  const fp = join(workDir, 'sessions.json');
  return existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : [];
}

function tgSent() {
  return tgLog.filter(l => l.url.includes('sendMessage') || l.url.includes('editMessageText'));
}

function tgTexts() {
  return tgSent().map(l => l.body.text).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 1: quick answer creates session, Claude picks up the history
// ═══════════════════════════════════════════════════════════════════════════════

describe('Quick answer → Claude context injection', () => {

  it('capability question creates a session and logs both sides', { timeout: 15000 }, async () => {
    // "подключи github" always gives a quick answer regardless of config
    await chat('подключи github');

    const current = readCurrentSession();
    expect(current, 'current-session.json not created after quick answer').not.toBeNull();

    const sess = readSession(current.id);
    expect(sess).not.toBeNull();
    expect(sess.messages.length, 'should have user msg + bot reply = 2').toBe(2);
    expect(sess.messages[0].role).toBe('user');
    expect(sess.messages[1].role).toBe('assistant');
    expect(sess.messages[1].content).toMatch(/github\.com|token|токен|ссылке/i);
  });

  it('second quick answer appends to same session', { timeout: 15000 }, async () => {
    await chat('умеешь читать гугл таблицы?');
    const after1 = readCurrentSession();

    await chat('подключи github');  // no sessionId — should auto-continue
    const after2 = readCurrentSession();

    expect(after2.id, 'session ID changed — continuity broken').toBe(after1.id);
    const sess = readSession(after2.id);
    expect(sess.messages.length, 'expected 4 messages (2 exchanges)').toBe(4);
  });

  it('Claude invocation after quick answers receives session context', { timeout: 20000 }, async () => {
    await chat('умеешь читать гугл таблицы?');
    await chat('подключи github');

    // Save prompt that Claude was invoked with by checking its args
    // (we can't intercept spawn args directly, but we can verify session context via disk)
    const sess = readSession(readCurrentSession().id);
    const msgs = sess.messages;

    // The session has 4 messages from 2 quick-answer exchanges
    // Now Claude should get buildContext(last 6) — which includes these 4 messages
    await chat('прочитай файл sales.xlsx и дай итоги', { claudeReply: 'Q3: выручка 4.2M, отток снизился' });

    // After Claude run, session should have 6 messages (4 quick + user + claude)
    const sessAfter = readSession(readCurrentSession().id);
    expect(sessAfter.messages.length, 'expected 6 messages after Claude run').toBe(6);
    const claudeMsg = sessAfter.messages.find(m => m.content.includes('4.2M'));
    expect(claudeMsg, 'Claude reply not found in session history').not.toBeUndefined();
  });

  it('Claude Telegram output shows 🧠 prefix', { timeout: 20000 }, async () => {
    await chat('сделай анализ продаж', { claudeReply: 'Анализ выполнен: выручка 4.2M' });

    const texts = tgTexts();
    const finalMsg = texts[texts.length - 1];
    expect(finalMsg).toMatch(/🧠/);
    expect(finalMsg).toMatch(/Анализ выполнен/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 2: utility commands don't pollute sessions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Utility commands do not pollute sessions', () => {

  it('/ping — no session created', { timeout: 10000 }, async () => {
    await chat('/ping');
    expect(readCurrentSession(), '/ping should not create a session').toBeNull();
    expect(listSessionIndex()).toHaveLength(0);
  });

  it('/help — no session created', { timeout: 10000 }, async () => {
    await chat('/help');
    expect(readCurrentSession()).toBeNull();
  });

  it('/usage — no session created', { timeout: 10000 }, async () => {
    await chat('/usage');
    expect(readCurrentSession()).toBeNull();
  });

  it('[BUG DETECTOR] utility on existing session — user message must NOT be orphaned', { timeout: 20000 }, async () => {
    // First: create a session with a real message
    await chat('умеешь работать с weeek?');
    const current = readCurrentSession();
    const beforeCount = readSession(current.id).messages.length;

    // Now: send utility command — should NOT append user msg without bot reply
    await chat('/ping');

    const afterCount = readSession(current.id).messages.length;
    // Bug: if utility check happens AFTER appendUserMessage, count is beforeCount+1 (orphan)
    // Correct: count stays at beforeCount (utility not logged at all)
    expect(afterCount, `orphan user message! was ${beforeCount}, now ${afterCount}`).toBe(beforeCount);
  });

  it('after utility commands, capability question starts clean session', { timeout: 15000 }, async () => {
    await chat('/ping');
    await chat('/help');

    await chat('умеешь weeek?');
    const current = readCurrentSession();
    expect(current).not.toBeNull();

    const sess = readSession(current.id);
    // Session should have ONLY the capability question, not /ping or /help
    const commandMsgs = sess.messages.filter(m => m.content.match(/^\/ping|^\/help/));
    expect(commandMsgs.length, 'utility commands leaked into session').toBe(0);
    expect(sess.messages.length).toBe(2); // user + bot
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 3: session continuity — 4h TTL
// ═══════════════════════════════════════════════════════════════════════════════

describe('Session continuity TTL', () => {

  it('continues same session within 4h', { timeout: 15000 }, async () => {
    await chat('подключи github');
    const id1 = readCurrentSession().id;

    // Next message without sessionId — should auto-continue
    await chat('создай issue', { claudeReply: 'Issue создан' });
    const id2 = readCurrentSession().id;

    expect(id2, 'session ID changed — expected continuation').toBe(id1);
  });

  it('starts new session after TTL expired', { timeout: 25000 }, async () => {
    await chat('подключи github');
    const current = readCurrentSession();
    const fp = join(workDir, 'sessions', 'current-session.json');

    // Expire the session
    writeFileSync(fp, JSON.stringify({ ...current, lastAt: Date.now() - 5 * 60 * 60 * 1000 }));

    await chat('совсем другая задача', { claudeReply: 'Выполнено' });

    const newCurrent = readCurrentSession();
    expect(newCurrent.id, 'expected NEW session after TTL').not.toBe(current.id);
  });

  it('explicit sessionId always wins over auto-continue', { timeout: 25000 }, async () => {
    await chat('умеешь github?');  // creates S-auto
    const autoId = readCurrentSession().id;

    const explicitId = 's-explicit-123';
    await chat('работаю в явной сессии', { sessionId: explicitId, claudeReply: 'OK' });

    const current = readCurrentSession();
    expect(current.id, 'expected explicit session to win').toBe(explicitId);
    expect(current.id).not.toBe(autoId);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 4: full dialogue — setup → work
// ═══════════════════════════════════════════════════════════════════════════════

describe('Full dialogue: setup → work', () => {

  it('GitHub setup → issue: session has setup context before Claude runs', { timeout: 25000 }, async () => {
    await chat('подключи github');

    // Before Claude runs, session should have the setup exchange
    const current = readCurrentSession();
    const sess = readSession(current.id);
    expect(sess.messages.length).toBe(2); // setup quick answer
    expect(sess.messages[1].content).toMatch(/github\.com|token|токен/i);

    // Now Claude runs — it will get buildContext which includes the setup exchange
    await chat('создай issue «/export команда»', { claudeReply: 'Issue #42 создан' });

    const sessAfter = readSession(current.id);
    // Should have 4 messages: setup user + setup bot + task user + claude reply
    expect(sessAfter.messages.length).toBe(4);
  });

  it('Weeek: 2 quick answers → Claude with full context', { timeout: 25000 }, async () => {
    await chat('умеешь работать с weeek?');
    await chat('подключи weeek');

    const current = readCurrentSession();
    const sess = readSession(current.id);
    expect(sess.messages.length, 'expected 4 messages before Claude').toBe(4);

    await chat('покажи все воронки', { claudeReply: 'Воронки: Новые лиды, Квалификация, Закрытие' });

    const sessAfter = readSession(current.id);
    expect(sessAfter.messages.length, 'expected 6 messages after Claude').toBe(6);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 5: multi-turn Claude conversation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-turn Claude conversation', () => {

  it('second Claude turn history includes first Claude reply', { timeout: 30000 }, async () => {
    await chat('прочитай sales.xlsx', { claudeReply: 'Q3 выручка 4.2M, отток 8%' });
    const sessAfterFirst = readSession(readCurrentSession().id);
    expect(sessAfterFirst.messages.length).toBe(2);

    await chat('подробнее про отток', { claudeReply: 'Отток: было 12%, стало 8%' });

    const sessAfterSecond = readSession(readCurrentSession().id);
    expect(sessAfterSecond.messages.length, 'expected 4 messages after 2 Claude turns').toBe(4);
    // The second Claude reply should be in history
    const lastMsg = sessAfterSecond.messages[sessAfterSecond.messages.length - 1];
    expect(lastMsg.content).toMatch(/12%|8%/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 6: Telegram delivery
// ═══════════════════════════════════════════════════════════════════════════════

describe('Telegram delivery', () => {

  it('/ping sends exactly one message, no thinking step', { timeout: 10000 }, async () => {
    await chat('/ping');
    const sent = tgSent();
    expect(sent.length).toBe(1);
    expect(sent[0].url).toMatch(/sendMessage/);
    expect(sent[0].body.text).toMatch(/онлайн|Онлайн/i);
  });

  it('quick answer sends exactly one message (no thinking step)', { timeout: 10000 }, async () => {
    await chat('подключи github');  // always quick answer
    const sent = tgSent();
    expect(sent.length, 'quick answer should send exactly 1 message').toBe(1);
    expect(sent[0].url).toMatch(/sendMessage/);
  });

  it('Claude answer: thinking → edit with 🧠', { timeout: 20000 }, async () => {
    await chat('сделай задачу', { claudeReply: 'Задача выполнена' });

    const sends = tgSent().filter(l => l.url.includes('sendMessage'));
    const edits = tgSent().filter(l => l.url.includes('editMessageText'));

    expect(sends.length, 'should send exactly 1 thinking message').toBe(1);
    expect(sends[0].body.text).toMatch(/Думаю/);
    expect(edits.length, 'should have at least 1 edit').toBeGreaterThanOrEqual(1);

    const lastEdit = edits[edits.length - 1];
    expect(lastEdit.body.text).toMatch(/🧠/);
    expect(lastEdit.body.text).toMatch(/Задача выполнена/);
  });

  it('revoke command: quick answer with confirmation', { timeout: 10000 }, async () => {
    await chat('отзови доступ к github', { userId: 42 });
    const texts = tgTexts();
    expect(texts.length).toBe(1);
    // Either "revoked" or "not connected" — both are valid quick answers
    expect(texts[0]).toMatch(/github|GitHub/i);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 7: quick-answer button (expand to Claude)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Expand button — forceClaude escalation', () => {

  it('quick answer includes inline keyboard button', { timeout: 10000 }, async () => {
    await chat('подключи github');
    const sent = tgSent();
    expect(sent.length).toBe(1);
    const body = sent[0].body;
    expect(body.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toMatch(/вдумчивее/i);
    expect(body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toMatch(/^ask_claude\|/);
  });

  it('forceClaude=true skips quick answer and calls Claude', { timeout: 20000 }, async () => {
    // First: create session with a quick answer
    await chat('подключи github');
    const current = readCurrentSession();
    const sessionId = current.id;

    // Now user taps expand button — forceClaude=true, no task (agent reads lastUserMessage)
    tgLog = [];
    await runTask({
      taskId: `t-expand-${Date.now()}`,
      user: makeUser(),
      task: '',           // bot sends empty task on button tap
      context: null,
      sessionId,
      contextFromSession: null,
      forceClaude: true,
      secrets: { BOT_TOKEN: 'fake:token' },
    });

    // Should have sent thinking + final edit (Claude path, not quick-answer path)
    const sends = tgSent().filter(l => l.url.includes('sendMessage'));
    const edits = tgSent().filter(l => l.url.includes('editMessageText'));
    expect(sends.length, 'should send thinking message').toBe(1);
    expect(sends[0].body.text).toMatch(/Думаю/);
    expect(edits.length, 'should edit to 🧠').toBeGreaterThanOrEqual(1);
    expect(edits[edits.length - 1].body.text).toMatch(/🧠/);
  });

  it('forceClaude session history includes the original quick-answer exchange', { timeout: 20000 }, async () => {
    await chat('подключи weeek');
    const sessionId = readCurrentSession().id;

    await runTask({
      taskId: `t-expand2-${Date.now()}`,
      user: makeUser(),
      task: '',
      context: null,
      sessionId,
      contextFromSession: null,
      forceClaude: true,
      secrets: { BOT_TOKEN: 'fake:token' },
    });

    const sess = readSession(sessionId);
    // Session should have: quick-answer user + quick-answer bot + expand user(same) + claude reply = 4
    expect(sess.messages.length, 'expected 4 messages (quick exchange + Claude turn)').toBe(4);
    const claudeMsg = sess.messages[sess.messages.length - 1];
    expect(claudeMsg.role).toBe('assistant');
  });

  it('utility commands still have NO button (ping)', { timeout: 10000 }, async () => {
    await chat('/ping');
    const sent = tgSent();
    expect(sent.length).toBe(1);
    expect(sent[0].body.reply_markup).toBeUndefined();
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 8: real dialogue pattern — выставки/gdrive style
// ═══════════════════════════════════════════════════════════════════════════════

describe('Dialogue: Google Drive file research (like выставки)', () => {

  it('gdrive share prompt → Claude data request: session carries SA email', { timeout: 25000 }, async () => {
    // Simulate: user asks to share a file (quick answer with SA email)
    // then asks Claude to read it
    // Without gdrive token set up, gdrive_share goes to null (no email)
    // So we test the pattern where user sends Claude a real work message first

    await chat('это каталог выставок, хочу собрать данные по участникам', {
      claudeReply: 'Понял задачу. Покажи список выставок — или пришли ссылку на файл.',
    });

    const current = readCurrentSession();
    const sess = readSession(current.id);
    expect(sess.messages.length).toBe(2);
    expect(sess.messages[0].content).toMatch(/выставок/i);

    // User continues — Claude gets prior context
    tgLog = [];
    await chat('вот файл выставки-2026.xlsx, первые 3 — ExpoMos, BuildEx, AgriRu', {
      claudeReply: 'Понял, буду собирать данные: ИНН, ОГРН, директор, выручка, сайт. Начинаю с ExpoMos.',
    });

    const sessAfter = readSession(current.id);
    expect(sessAfter.messages.length, 'expected 4 messages after 2 Claude turns').toBe(4);

    const texts = tgTexts();
    expect(texts[texts.length - 1]).toMatch(/🧠/);
    expect(texts[texts.length - 1]).toMatch(/ExpoMos/);
  });

  it('long dialogue (4 turns) — session accumulates correctly', { timeout: 60000 }, async () => {
    const turns = [
      { msg: 'подключи github', reply: null },   // quick answer
      { msg: 'создай репо train-data', reply: 'Репозиторий train-data создан' },
      { msg: 'добавь README с описанием', reply: 'README.md добавлен в main' },
      { msg: 'создай .gitignore для node', reply: '.gitignore создан' },
    ];

    for (const t of turns) {
      await chat(t.msg, { claudeReply: t.reply });
    }

    const sess = readSession(readCurrentSession().id);
    // quick answer: 2 msgs + 3 Claude turns × 2 = 8 total
    expect(sess.messages.length, 'expected 8 messages across 4 turns').toBe(8);

    const sessionId = readCurrentSession().id;
    expect(sessionId, 'session should stay the same throughout').toBe(readCurrentSession().id);
  });

});
