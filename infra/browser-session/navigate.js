'use strict';
// Navigate Chrome to a URL via CDP.
// Usage: node navigate.js <url>

const PLAYWRIGHT = require('/home/vova/trained-assist-agent/node_modules/playwright');

const SKIP_URL = /^(chrome:|chrome-extension:|devtools:|about:)/;

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('Usage: node navigate.js <url>'); process.exit(1); }

  const browser = await PLAYWRIGHT.chromium.connectOverCDP('http://127.0.0.1:9222');
  try {
    const context = browser.contexts()[0];
    const pages = context.pages();

    // Pick the first real user-visible page; create one if none exist
    let page = pages.find(p => !SKIP_URL.test(p.url()));
    if (!page) {
      page = await context.newPage();
      // Close any leftover blank/internal tabs to keep one tab visible
      for (const p of pages) {
        try { await p.close(); } catch {}
      }
    }

    await page.bringToFront();
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
    console.log(`Navigated: ${url}`);
  } finally {
    try { browser._connection.close(); } catch {}
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
