'use strict';

// ConversationRef — channel-neutral address of a dialog (epic #1365 §2.2).
// A ref is an ADDRESS, not an ACL: it never proves who may use a profile.
// All ids are opaque non-empty strings; threadId is optional (forum topic).
//
// Canonical key is versioned and collision-safe: every component is
// percent-encoded (so the '|' separator can never appear inside one) and an
// absent thread is an explicit empty segment (empty ids are rejected, so ''
// can only mean "no thread").
const { BOTS } = require('../bot-registry');

const KEY_PREFIX = 'cref1';
const FIELDS = ['channel', 'endpointId', 'conversationId', 'threadId'];

function assertId(name, v, optional = false) {
  if (v == null && optional) return;
  if (typeof v !== 'string' || v.length === 0) throw new TypeError(`ConversationRef.${name} must be a non-empty string`);
}

function makeConversationRef({ channel, endpointId, conversationId, threadId } = {}) {
  assertId('channel', channel);
  assertId('endpointId', endpointId);
  assertId('conversationId', conversationId);
  assertId('threadId', threadId, true);
  const ref = { channel, endpointId, conversationId };
  if (threadId != null) ref.threadId = threadId;
  return Object.freeze(ref);
}

function conversationKey(ref) {
  const r = makeConversationRef(ref);
  return [KEY_PREFIX, ...FIELDS.map(f => encodeURIComponent(r[f] ?? ''))].join('|');
}

function parseConversationKey(key) {
  const parts = typeof key === 'string' ? key.split('|') : [];
  if (parts.length !== FIELDS.length + 1 || parts[0] !== KEY_PREFIX) throw new TypeError(`not a ${KEY_PREFIX} conversation key`);
  const [channel, endpointId, conversationId, threadId] = parts.slice(1).map(decodeURIComponent);
  return makeConversationRef({ channel, endpointId, conversationId, threadId: threadId === '' ? undefined : threadId });
}

function sameConversation(a, b) {
  return conversationKey(a) === conversationKey(b);
}

// Legacy /run(chatId, audience, threadId) → ConversationRef. The Telegram
// endpoint is the registry botId (#1342); audience stays a compatibility alias.
// chatId 0/absent is the legacy web/internal caller: there is no Telegram
// dialog, so we return null instead of fabricating one.
function fromLegacyTelegram({ chatId, audience, threadId } = {}, bots = BOTS) {
  if (chatId == null || chatId === 0 || chatId === '0' || chatId === '') return null;
  const bot = bots.find(b => b.audience === (audience || 'default'));
  if (!bot) throw new TypeError(`unknown audience "${audience}" — not in bot registry`);
  return makeConversationRef({
    channel: 'telegram',
    endpointId: bot.botId,
    conversationId: String(chatId),
    threadId: threadId == null || threadId === 0 ? undefined : String(threadId),
  });
}

module.exports = { makeConversationRef, conversationKey, parseConversationKey, sameConversation, fromLegacyTelegram, KEY_PREFIX };
