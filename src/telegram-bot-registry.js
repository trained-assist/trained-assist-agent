'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ID = /^[A-Za-z0-9_-]{1,32}$/;
const originalSecrets = new WeakMap();
const failure = message => Object.assign(new Error(message), { code: 'BOT_UNAVAILABLE' });
function deliveryIdentity(value = {}) {
  const botId = value.botId ?? 'default', audience = value.audience ?? 'default';
  if (typeof botId !== 'string' || !ID.test(botId) || typeof audience !== 'string' || !ID.test(audience)) throw failure('Invalid bot or audience');
  return { botId, audience };
}
function approvedBotConfig(config) {
  const approved = config || JSON.parse(process.env.TELEGRAM_BOTS_JSON || fs.readFileSync(path.join(__dirname, '../config/telegram-bots.json'), 'utf8'));
  if (approved?.version !== 1 || !Array.isArray(approved.bots) || Object.keys(approved).some(k => !['version', 'bots'].includes(k))) throw failure('Invalid approved bot registry');
  const ids = new Set();
  for (const b of approved.bots) {
    if (!b || typeof b.id !== 'string' || !ID.test(b.id) || typeof b.tokenSecret !== 'string' || !/^(?:[A-Z][A-Z0-9_]*_)?BOT_TOKEN$/.test(b.tokenSecret) || ids.has(b.id) || Object.keys(b).some(k => !['id', 'tokenSecret'].includes(k))) throw failure('Invalid approved bot registry');
    ids.add(b.id);
  }
  return approved;
}
function botSecretNames() { return approvedBotConfig().bots.map(b => b.tokenSecret).filter(n => n !== 'BOT_TOKEN'); }
function resolveBotSecrets(secrets = {}, identity = {}, config) {
  const { botId } = deliveryIdentity(identity);
  const base = originalSecrets.get(secrets) || secrets;
  const approved = approvedBotConfig(config);
  const bot = approved.bots.find(b => b.id === botId);
  if (!bot) throw failure('Bot is not registered');
  const token = base[bot.tokenSecret] || (botId === 'default' && bot.tokenSecret === 'BOT_TOKEN' ? base.TELEGRAM_BOT_TOKEN : null);
  // Legacy local/Web tests can run without Telegram. An explicitly selected
  // additional bot always fails closed, including after restart/secret removal.
  if (!token && botId !== 'default') throw failure('Bot credential unavailable');
  const scoped = { ...base, BOT_TOKEN: token, TELEGRAM_BOT_TOKEN: token };
  originalSecrets.set(scoped, base);
  return scoped;
}
function deliveryQueueKey(user) {
  const { botId, audience } = deliveryIdentity(user);
  if (!user.id || String(user.id) === '0') return null;
  return JSON.stringify([user.username, String(user.id), audience, botId]);
}
function continuationKey(user) {
  return user.username + '-' + crypto.createHash('sha256').update(deliveryQueueKey(user)).digest('hex').slice(0, 32);
}
function matchesDelivery(state, { chatId = null, audience = 'default', botId = 'default' } = {}) {
  return (chatId == null || String(state.chatId) === String(chatId)) &&
    (state.audience || 'default') === audience && (state.botId || 'default') === botId;
}
module.exports = { botSecretNames, deliveryIdentity, resolveBotSecrets, deliveryQueueKey, continuationKey, matchesDelivery };
