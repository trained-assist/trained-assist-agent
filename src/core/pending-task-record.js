'use strict';

// Versioned reader/translator for the pending-task journal (epic #1365 PR1c).
// The journal (agent-data/pending-tasks/<taskId>.json) is written by the runner
// in the legacy flat shape — we do NOT change that writer here. This module
// gives the new core a lossless, typed view of old AND new records so a
// restart/rollback across the cutover never drops identity, target session,
// lane, project, principal, attachments or reply route.
//
//   v1 (legacy, no `v`): flat { taskId, userId(=chatId), audience, threadId, ... }
//   v2 (future writer):  same flat fields + `v: 2` + optional `sourceRef`
//
// Unknown future versions are reported `unsupported` — callers must KEEP the
// file (never delete what they cannot read) so a rollback cannot lose work.
const { BOTS } = require('../bot-registry');
const { makeConversationRef, fromLegacyTelegram } = require('./conversation-ref');

const CURRENT_VERSION = 2;

function readPendingRecord(raw, bots = BOTS) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'malformed' };
  const v = raw.v == null ? 1 : raw.v;
  if (v !== 1 && v !== 2) return { ok: false, reason: 'unsupported', version: v };
  if (typeof raw.taskId !== 'string' || !raw.taskId) return { ok: false, reason: 'malformed' };

  let sourceRef = null;
  try {
    sourceRef = raw.sourceRef ? makeConversationRef(raw.sourceRef)
      : fromLegacyTelegram({ chatId: raw.userId, audience: raw.audience, threadId: raw.threadId }, bots);
  } catch (e) { return { ok: false, reason: 'unroutable', detail: e.message }; }

  return {
    ok: true,
    record: Object.freeze({
      v: CURRENT_VERSION,
      identity: Object.freeze({
        taskId: raw.taskId,
        // Recovery must never mint a new identity: rootTaskId is the FIRST taskId
        // of this request, requestId the client's idempotency key (may be absent).
        rootTaskId: raw.rootTaskId || raw.taskId,
        requestId: raw.requestId || null,
      }),
      principal: Object.freeze({ profileId: raw.profileId || raw.username || null, username: raw.username || null }),
      actor: raw.telegramUserId != null && sourceRef ? Object.freeze({ channel: sourceRef.channel, endpointId: sourceRef.endpointId, actorId: String(raw.telegramUserId) }) : null,
      sourceRef,
      // Legacy runs always answered into the dialog they came from.
      replyToRef: sourceRef,
      sessionId: raw.sessionId || null,
      projectId: raw.projectId || null,
      phase: raw.phase || null,
      queuedAt: raw.startedAt || null,
      initiatedAt: Number.isFinite(raw.initiatedAt) ? raw.initiatedAt : null,
      fileRefs: Array.isArray(raw.fileRefs) ? raw.fileRefs.slice() : [],
      internalGtd: raw.internalGtd === true,
    }),
  };
}

// Rollback bridge: can this record be handed to the legacy /run-shaped runner?
// Telegram refs downconvert losslessly; any other channel has no legacy
// representation (chatId=0 would silently lose the reply route) → explicit
// block, the record is kept, not dropped.
function toLegacyRoute(record, bots = BOTS) {
  const ref = record.sourceRef;
  if (!ref) return { ok: true, route: { userId: 0, audience: 'default', threadId: null } };
  if (ref.channel !== 'telegram') return { ok: false, reason: 'no_legacy_representation', channel: ref.channel };
  const bot = bots.find(b => b.botId === ref.endpointId);
  if (!bot) return { ok: false, reason: 'unknown_endpoint', endpointId: ref.endpointId };
  const chat = Number(ref.conversationId);
  if (!Number.isSafeInteger(chat)) return { ok: false, reason: 'non_numeric_chat' };
  return { ok: true, route: { userId: chat, audience: bot.audience, threadId: ref.threadId == null ? null : Number(ref.threadId) } };
}

module.exports = { readPendingRecord, toLegacyRoute, CURRENT_VERSION };
