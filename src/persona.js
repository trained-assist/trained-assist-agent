// Per-profile "personality" / role — a couple of paragraphs describing what role the
// assistant plays for this user (recruiter-analyst, software architect, construction
// business analyst, …). Stored per-user in workDir/persona.md and appended to the
// system prompt of EVERY session. Editable from the bot via the /persona command.

const fs = require('fs');
const path = require('path');

const FILE = 'persona.md';
const MAX_LEN = 8000; // guard against pasting a whole book into the system prompt

function personaPath(workDir) {
  return path.join(workDir, FILE);
}

// Returns the persona text, or null if none set.
function load(workDir) {
  if (!workDir) return null;
  try {
    const t = fs.readFileSync(personaPath(workDir), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function save(workDir, text) {
  fs.mkdirSync(workDir, { recursive: true });
  const clean = String(text).trim().slice(0, MAX_LEN);
  fs.writeFileSync(personaPath(workDir), clean + '\n', { mode: 0o600 });
  return clean;
}

function clear(workDir) {
  try {
    fs.unlinkSync(personaPath(workDir));
    return true;
  } catch {
    return false;
  }
}

// Build the system-prompt file to hand to the CLI. If a persona is set, merge the
// global base prompt + persona into a per-user file and return its path; otherwise
// return the base file path unchanged. Never throws — falls back to the base file.
function buildSystemPromptFile(workDir, basePromptFile) {
  const base = basePromptFile && fs.existsSync(basePromptFile) ? basePromptFile : '';
  const text = load(workDir);
  if (!text || !workDir) return base;
  try {
    const baseContent = base ? fs.readFileSync(base, 'utf8') : '';
    const merged =
      baseContent +
      '\n\n# РОЛЬ И ЛИЧНОСТЬ АССИСТЕНТА (задано пользователем — соблюдай в каждом ответе)\n' +
      text + '\n';
    const out = path.join(workDir, '.system-prompt.txt');
    fs.writeFileSync(out, merged, { mode: 0o600 });
    return out;
  } catch (e) {
    console.warn('[persona] merge failed:', e.message);
    return base;
  }
}

module.exports = { load, save, clear, personaPath, buildSystemPromptFile };
