'use strict';
// Navigate Chrome to a URL via CDP.
// Usage: node navigate.js <url>

const PLAYWRIGHT = require('/home/vova/trained-assist-agent/node_modules/playwright');

const url = process.argv[2];
if (!url) { console.error('Usage: node navigate.js <url>'); process.exit(1); }

(async () => {
  const browser = await PLAYWRIGHT.chromium.connectOverCDP('http://127.0.0.1:9224');
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    if (!pages.length) { console.error('No pages found'); process.exit(1); }
    const page = pages[0];
    await page.bringToFront();
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
    console.log('Navigated:', url);
  } finally {
    try { browser._connection.close(); } catch {}
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
