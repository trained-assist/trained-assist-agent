const fs = require('fs');
const path = require('path');

const LOG_FILE = 'requirements-log.md';

const INIT_CONTENT = `# Requirements Log
Updated: {DATE}

Лог требований пользователя к ассистенту — что хочет, как часто упоминает, насколько важно.
Claude поддерживает этот файл автоматически.

<!--
Формат записи:
**[NNN]** Описание требования
Status: planned|in-progress|implemented|rejected: причина | Count: N | Intensity: 0-3 | First: YYYY-MM-DD | Last: YYYY-MM-DD

Intensity: 0=вскользь, 1=чёткая просьба, 2=акцентировал/!, 3=голос+эмоции или многократное повторение
-->

`;

function logPath(workDir) {
  return path.join(workDir, LOG_FILE);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Create an empty requirements log if it doesn't exist yet */
function initLog(workDir) {
  const fp = logPath(workDir);
  if (fs.existsSync(fp)) return;
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(fp, INIT_CONTENT.replace('{DATE}', today()));
}

/** Read the current requirements log, returns null if not found */
function readLog(workDir) {
  try {
    const fp = logPath(workDir);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp, 'utf8');
  } catch { return null; }
}

module.exports = { initLog, readLog };
