'use strict';

// ConversationSessionIndex (epic #1365 §5, PR2b) — core view of
// "which session does this dialog continue", built over the EXISTING session
// store (current-session pointer files + session files). No new storage.
//
// Authority: until cutover the legacy path (gateway-sent sessionId, resolved by
// the runner) stays the single authority. This index runs in SHADOW mode:
// it only reads, compares and logs. It never writes a pointer, never starts
// work, never overrides the legacy choice — no KV↔core dual-write.
//
// Access rule (ACL): a session resolves for a dialog only if it exists and is
// not attached to a DIFFERENT chat (liveChatId). A ref is an address, not a
// proof of profile access — the caller passes the profile's workDir it
// already authorized.
const { BOTS } = require('../bot-registry');
const { makeConversationRef } = require('./conversation-ref');

function legacyLocator(ref, bots = BOTS) {
  const r = makeConversationRef(ref);
  if (r.channel !== 'telegram') return null;
  const bot = bots.find(b => b.botId === r.endpointId);
  if (!bot) return null;
  const threadId = r.threadId != null && /^\d+$/.test(r.threadId) ? Number(r.threadId) : null;
  return { chatId: r.conversationId, audience: bot.audience, threadId };
}

function createConversationSessionIndex({ store, bots = BOTS, log = console } = {}) {
  if (!store?.getCurrentSessionId || !store?.getSession) throw new TypeError('ConversationSessionIndex needs a session store');
  const stats = { compared: 0, match: 0, mismatch: 0 };

  function accessible(workDir, sessionId, chatId) {
    const s = sessionId ? store.getSession(workDir, sessionId) : null;
    if (!s) return false;
    const attached = s.liveChatId ?? s.ownerChatId;
    return !attached || String(attached) === String(chatId);
  }

  // → { sessionId|null, reason }
  function resolve({ workDir, ref }) {
    const loc = legacyLocator(ref, bots);
    if (!loc) return { sessionId: null, reason: 'unsupported_ref' };
    const id = store.getCurrentSessionId(workDir, loc.chatId, loc.audience, loc.threadId);
    if (!id) return { sessionId: null, reason: 'no_pointer' };
    if (!accessible(workDir, id, loc.chatId)) return { sessionId: null, reason: 'pointer_inaccessible' };
    return { sessionId: id, reason: 'pointer' };
  }

  // Shadow compare against the legacy authority's choice. Logs, never acts.
  // authoritySessionId null = legacy will pick/create itself (not a mismatch
  // by definition — the runner resolves the same pointer).
  function shadowCompare({ workDir, ref, authoritySessionId, taskId = '' }) {
    let resolved;
    try { resolved = resolve({ workDir, ref }); }
    catch (e) { log.warn?.(`[session-shadow] ${taskId} resolve error: ${e.message}`); return null; }
    if (!authoritySessionId) return { match: true, resolved };
    stats.compared++;
    const match = resolved.sessionId === authoritySessionId;
    if (match) stats.match++;
    else {
      stats.mismatch++;
      log.log?.(`[session-shadow] ${taskId} mismatch authority=${authoritySessionId} core=${resolved.sessionId} reason=${resolved.reason}`);
    }
    return { match, resolved };
  }

  return { resolve, shadowCompare, stats };
}

module.exports = { createConversationSessionIndex, legacyLocator };
