// Creates a disposable fake `claude` binary for use as CLAUDE_BIN in tests.
// The binary is a bash script that outputs stream-json matching Claude's format.
//
// Usage:
//   const mc = createMockClaude();
//   process.env.CLAUDE_BIN = mc.binPath;
//   mc.setReply('Hello from mock');
//   // ... run task ...
//   mc.cleanup();

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export function createMockClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'mock-claude-'));
  const replyFile = join(dir, 'reply.txt');
  writeFileSync(replyFile, 'Mock reply');

  const script = `#!/bin/bash
REPLY=$(cat "${replyFile}" 2>/dev/null || echo "OK")
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$REPLY"'"}]}}'
printf '%s\\n' '{"type":"result","result":"'"$REPLY"'","usage":{"input_tokens":10,"output_tokens":5}}'
`;
  const binPath = join(dir, 'claude');
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);

  return {
    binPath,
    setReply: (text) => writeFileSync(replyFile, text),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
