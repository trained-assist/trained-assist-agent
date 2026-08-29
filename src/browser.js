const fs = require('fs');
const path = require('path');

/**
 * Writes a per-user .mcp.json that exposes exactly one Playwright MCP server
 * scoped to this user's Chrome profile. Claude Code cannot see any other
 * browser instance — isolation is enforced at the config level.
 */
function writeMcpConfig(workDir) {
  const chromeDir = path.join(workDir, 'chrome');
  fs.mkdirSync(chromeDir, { recursive: true });

  const config = {
    mcpServers: {
      playwright: {
        command: 'npx',
        args: [
          '@playwright/mcp',
          '--headless',
          '--no-sandbox',
          '--user-data-dir', chromeDir,
        ],
      },
    },
  };

  const configPath = path.join(workDir, '.mcp.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

module.exports = { writeMcpConfig };
