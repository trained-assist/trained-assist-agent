import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSession,
  appendUserMessage,
  appendReply,
  listSessions,
  getSession,
  buildContext,
} from '../src/session-store.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSession', () => {
  it('returns an id and writes session file + index', () => {
    const id = createSession(tmpDir, { task: 'Test task' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const sessionFile = path.join(tmpDir, 'sessions', `${id}.json`);
    expect(fs.existsSync(sessionFile)).toBe(true);

    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    expect(data.id).toBe(id);
    expect(data.topic).toBe('Test task');
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].role).toBe('user');
  });

  it('uses provided id if given', () => {
    const id = createSession(tmpDir, { task: 'hello', id: 's-custom-123' });
    expect(id).toBe('s-custom-123');
  });
});

describe('appendUserMessage', () => {
  it('adds user message to session', () => {
    const id = createSession(tmpDir, { task: 'first task' });
    appendUserMessage(tmpDir, id, 'second message');

    const session = getSession(tmpDir, id);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].role).toBe('user');
    expect(session.messages[1].content).toBe('second message');
  });
});

describe('appendReply', () => {
  it('saves full reply without truncation', () => {
    const id = createSession(tmpDir, { task: 'task' });
    const longReply = 'x'.repeat(5000); // well over 2000 chars
    appendReply(tmpDir, id, longReply);

    const session = getSession(tmpDir, id);
    const reply = session.messages.find(m => m.role === 'assistant');
    expect(reply).toBeDefined();
    expect(reply.content).toBe(longReply);
    expect(reply.content.length).toBe(5000);
  });

  it('adds assistant message with correct role', () => {
    const id = createSession(tmpDir, { task: 'task' });
    appendReply(tmpDir, id, 'Claude response here');

    const session = getSession(tmpDir, id);
    const reply = session.messages.find(m => m.role === 'assistant');
    expect(reply.content).toBe('Claude response here');
  });
});

describe('listSessions', () => {
  it('returns created session in list', () => {
    const id = createSession(tmpDir, { task: 'List test' });
    const list = listSessions(tmpDir, 10);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
    expect(list[0].topic).toBe('List test');
  });

  it('respects limit', () => {
    createSession(tmpDir, { task: 'A' });
    createSession(tmpDir, { task: 'B' });
    createSession(tmpDir, { task: 'C' });
    expect(listSessions(tmpDir, 2)).toHaveLength(2);
  });
});

describe('getSession', () => {
  it('returns full session with messages', () => {
    const id = createSession(tmpDir, { task: 'Full session test' });
    const session = getSession(tmpDir, id);
    expect(session.id).toBe(id);
    expect(Array.isArray(session.messages)).toBe(true);
  });

  it('returns null for non-existent session', () => {
    expect(getSession(tmpDir, 'nonexistent')).toBeNull();
  });
});

describe('buildContext', () => {
  it('returns string containing the session topic', () => {
    const id = createSession(tmpDir, { task: 'Build context task' });
    appendReply(tmpDir, id, 'assistant reply');

    const ctx = buildContext(tmpDir, id);
    expect(typeof ctx).toBe('string');
    expect(ctx).toContain('Build context task');
  });

  it('returns null for missing session', () => {
    expect(buildContext(tmpDir, 'no-such-id')).toBeNull();
  });
});
