const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Migration only: never re-arm legacy speculative timers, even when overdue.
// Keep failed Telegram edits retryable on the next boot, without scheduling work.
async function retireSoftContinuations({
  dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  editMessage,
  warn = console.warn,
} = {}) {
  const dir = path.join(dataDir, 'soft-continuations');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const file = path.join(dir, name);
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!record.chatId || !record.msgId || typeof record.finalText !== 'string') {
        throw new Error('invalid legacy continuation record');
      }
      const text = `🧠 ${record.finalText}\n\nАвтопродолжение по предположению отключено. Для продолжения напишите «продолжай».`;
      try {
        await editMessage(record, text);
      } catch (error) {
        // Telegram rejects identical edits; that means the notice already landed.
        if (!String(error.message).includes('message is not modified')) throw error;
      }
      // Archive rather than delete: rollback and incident audit retain the record.
      fs.renameSync(file, `${file}.retired`);
    } catch (error) {
      warn(`[soft-continuation-retirement] ${name}: ${error.message}`);
    }
  }
}

module.exports = { retireSoftContinuations };
