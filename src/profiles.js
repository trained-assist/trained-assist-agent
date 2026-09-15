const fs = require('fs');
const path = require('path');

// Per-user profile: about, preferences, etc.
// Stored in user's workDir as profile.json

function load(workDir) {
  try { return JSON.parse(fs.readFileSync(path.join(workDir, 'profile.json'), 'utf8')); }
  catch { return {}; }
}

function save(workDir, data) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'profile.json'), JSON.stringify(data, null, 2));
}

function toContext(profile, workDir) {
  const parts = [];
  if (profile.about) parts.push(`О пользователе: ${profile.about}`);
  if (profile.preferences) parts.push(`Предпочтения: ${profile.preferences}`);
  if (workDir) parts.push(`Рабочая директория: ${workDir}`);
  return parts.join('\n') || null;
}

// Which CLI (claude|codex) runs this profile's tasks. Two levels, same as projects.js's
// active-project-per-chat: a per-chat override (engineByChat[chatId], set via the
// /switch2klod, /switch2codex chat command) wins over the profile-wide default (`engine`,
// set via scripts/set-engine.mjs). chatId is optional — omit it to read/write the default.
function getEngine(workDir, chatId) {
  const p = load(workDir);
  const override = chatId != null ? p.engineByChat?.[String(chatId)] : null;
  return (override || p.engine) === 'codex' ? 'codex' : 'claude';
}

function setEngine(workDir, engine, chatId) {
  const clean = engine === 'codex' ? 'codex' : 'claude';
  const current = load(workDir);
  if (chatId != null) {
    save(workDir, { ...current, engineByChat: { ...current.engineByChat, [String(chatId)]: clean } });
  } else {
    save(workDir, { ...current, engine: clean });
  }
  return clean;
}

module.exports = { load, save, toContext, getEngine, setEngine };
