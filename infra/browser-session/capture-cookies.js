'use strict';
// Capture Tilda session from the running Chrome via CDP.
// Saves two artifacts side by side:
//   <output_file>           — cookie string "name=val; ..." for HTTP Cookie header
//   <output_file>.state.json — full Playwright storageState (cookies + localStorage)
// Usage: node capture-cookies.js <domain> <output_file>

const PLAYWRIGHT = require('/home/vova/trained-assist-agent/node_modules/playwright');
const fs   = require('fs');
const path = require('path');

async function main() {
  const [domain, outputFile] = process.argv.slice(2);
  if (!domain || !outputFile) {
    console.error('Usage: node capture-cookies.js <domain> <output_file>');
    process.exit(1);
  }

  const browser = await PLAYWRIGHT.chromium.connectOverCDP('http://127.0.0.1:9224');
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('No browser context — Chrome not ready');

    const urls = [`https://${domain}`, `http://${domain}`];
    const cookies = await context.cookies(urls);

    if (cookies.length === 0) {
      console.error(`No cookies for ${domain} — are you logged in?`);
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });

    // Cookie string (backward compat — used as HTTP Cookie header)
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    fs.writeFileSync(outputFile, cookieStr, { mode: 0o600 });

    // Full storage state (cookies + localStorage) for Playwright-based scripts
    const stateFile = `${outputFile}.state.json`;
    await context.storageState({ path: stateFile });
    fs.chmodSync(stateFile, 0o600);

    console.log(`OK: ${cookies.length} cookies → ${outputFile} + ${stateFile}`);
  } finally {
    try { browser._connection.close(); } catch {}
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
