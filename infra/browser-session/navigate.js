'use strict';
// Navigate Chrome to a URL via CDP.
// Usage: node navigate.js <url>

const PLAYWRIGHT = require('/home/vova/trained-assist-agent/node_modules/playwright');

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('Usage: node navigate.js <url>'); process.exit(1); }

  const browser = await PLAYWRIGHT.chromium.connectOverCDP('http://127.0.0.1:9222');
  try {
    const context = browser.contexts()[0];
    const pages = context.pages();
    let page;
    if (pages.length === 0 || pages[0].url().startsWith('chrome://')) {
      page = await context.newPage();
      if (pages[0]) await pages[0].close();
    } else {
      page = pages[0];
    }
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
    console.log(`Navigated: ${url}`);
  } finally {
    try { browser._connection.close(); } catch {}
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
