'use strict';
// Execute JavaScript in the current page of the remote Chrome via CDP.
// EVAL_SCRIPT env var: JS expression or IIFE to run in page context
// EVAL_URL env var: optional — navigate to this URL before evaluating

const PLAYWRIGHT = require('/home/vova/trained-assist-agent/node_modules/playwright');

const script = process.env.EVAL_SCRIPT;
const evalUrl = process.env.EVAL_URL || null;

if (!script) {
  console.log(JSON.stringify({ ok: false, error: 'EVAL_SCRIPT env var required' }));
  process.exit(1);
}

(async () => {
  const browser = await PLAYWRIGHT.chromium.connectOverCDP('http://127.0.0.1:9224');
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    if (!pages.length) throw new Error('No pages in browser');
    const page = pages[0];
    await page.bringToFront();
    page.setDefaultTimeout(40000);

    if (evalUrl) {
      await page.goto(evalUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Wrap multi-statement scripts in an async IIFE if they look like statements, not expressions
    const evalScript = script.trim().startsWith('(') ? script : `(async () => { ${script} })()`;
    const result = await page.evaluate(evalScript);
    console.log(JSON.stringify({ ok: true, result, url: page.url() }));
  } finally {
    try { browser._connection.close(); } catch {}
  }
  process.exit(0);
})().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
