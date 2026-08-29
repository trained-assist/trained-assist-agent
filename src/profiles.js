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

module.exports = { load, save, toContext };
