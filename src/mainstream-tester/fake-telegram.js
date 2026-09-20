'use strict';
// Fake Telegram Bot API server for isolated integration testing.
// Intercepts sendMessage / editMessageText and emits 'message_final'
// after a debounce period (agent streams many edits, we wait for silence).

const http = require('http');
const { EventEmitter } = require('events');

const DEBOUNCE_MS = 12_000; // 12s of no edits = message complete

class FakeTelegram extends EventEmitter {
  constructor() {
    super();
    this.messages = new Map(); // msgId → {chatId, text, replyMarkup}
    this.msgCounter = 1000;
    this.debounceTimers = new Map(); // chatId → timer
    this.server = null;
    this.port = null;
  }

  start(port = 0) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res).catch(err => {
        console.error('[fake-tg] handler error:', err.message);
        res.writeHead(500);
        res.end('{}');
      }));
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        console.log(`[fake-tg] listening on :${this.port}`);
        resolve(this.port);
      });
      this.server.once('error', reject);
    });
  }

  stop() {
    return new Promise(resolve => this.server?.close(() => resolve()));
  }

  reset() {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.messages.clear();
    this.msgCounter = 1000;
  }

  _ok(res, result) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  }

  async _readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
  }

  async _handle(req, res) {
    const body = await this._readBody(req);
    // URL format: /bot{token}/methodName or /bot{token}/methodName?...
    const method = (req.url || '').split('/').pop()?.split('?')[0] || '';

    switch (method) {
      case 'sendMessage': {
        const msgId = ++this.msgCounter;
        const chatId = body.chat_id;
        const text = body.text || '';
        const replyMarkup = body.reply_markup || null;
        this.messages.set(msgId, { chatId, text, replyMarkup });
        this._debounce(chatId, msgId, text, replyMarkup);
        this._ok(res, { message_id: msgId, chat: { id: chatId }, text });
        break;
      }
      case 'editMessageText': {
        const msgId = body.message_id;
        const chatId = body.chat_id;
        const text = body.text || '';
        const replyMarkup = body.reply_markup || null;
        this.messages.set(msgId, { chatId, text, replyMarkup });
        this._debounce(chatId, msgId, text, replyMarkup);
        this._ok(res, { message_id: msgId, chat: { id: chatId }, text });
        break;
      }
      case 'pinChatMessage':
      case 'unpinChatMessage':
        this._ok(res, true);
        break;
      case 'sendDocument':
      case 'sendPhoto':
      case 'sendAudio':
      case 'sendVideo': {
        const msgId = ++this.msgCounter;
        this._ok(res, { message_id: msgId, chat: { id: body.chat_id } });
        break;
      }
      case 'getMe':
        this._ok(res, { id: 9999, is_bot: true, first_name: 'TestBot', username: 'mainstream_test_bot' });
        break;
      default:
        this._ok(res, true);
    }
  }

  _debounce(chatId, msgId, text, replyMarkup) {
    if (this.debounceTimers.has(chatId)) clearTimeout(this.debounceTimers.get(chatId));
    const timer = setTimeout(() => {
      this.debounceTimers.delete(chatId);
      this.emit('message_final', { chatId, msgId, text, replyMarkup });
    }, DEBOUNCE_MS);
    this.debounceTimers.set(chatId, timer);
  }
}

module.exports = { FakeTelegram };
