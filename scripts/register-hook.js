const fs = require('fs'), os = require('os');
const p = os.homedir() + '/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
s.hooks = s.hooks || {};
s.hooks.PostToolUse = s.hooks.PostToolUse || [];
const cmd = 'node /home/vova/trained-assist-agent/src/hooks/post-tool-use-artifacts.js';
if (!s.hooks.PostToolUse.some(h => h.hooks?.[0]?.command === cmd)) {
  s.hooks.PostToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: cmd }] });
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
  console.log('Artifact hook registered');
} else {
  console.log('Artifact hook already registered');
}
