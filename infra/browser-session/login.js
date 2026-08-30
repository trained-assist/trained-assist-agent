'use strict';
// Fill and submit a login form in the remote Chrome via CDP.
// Credentials passed via env vars LOGIN_EMAIL / LOGIN_PASSWORD (not CLI args).

const PLAYWRIGHT = require('/home/vova/trained-assist-agent/node_modules/playwright');

const email    = process.env.LOGIN_EMAIL;
const password = process.env.LOGIN_PASSWORD;
if (!email || !password) {
  console.log(JSON.stringify({ ok: false, error: 'LOGIN_EMAIL / LOGIN_PASSWORD env vars required' }));
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

    const urlBefore = page.url();

    // If already logged in (not on login page), skip form filling
    const isLoginPage = /login|signin|sign-in/i.test(urlBefore);
    if (!isLoginPage) {
      console.log(JSON.stringify({ ok: true, url_before: urlBefore, url_after: urlBefore, navigated: false, already_logged_in: true, captcha: false, two_factor: false, error_on_page: false }));
      try { browser._connection.close(); } catch {}
      process.exit(0);
    }

    // Fill email / username field
    const emailSel = 'input[type="email"], input[name="email"], input[name="login"], input[name="username"]';
    await page.fill(emailSel, email, { timeout: 8000 });

    // Fill password
    await page.fill('input[type="password"]', password, { timeout: 5000 });

    // Submit
    const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Войти"), button:has-text("Sign in")';
    await page.click(submitSel, { timeout: 5000 });

    // Wait up to 8s for navigation or page change
    await Promise.race([
      page.waitForNavigation({ timeout: 8000, waitUntil: 'commit' }).catch(() => {}),
      page.waitForTimeout(8000),
    ]);

    const urlAfter  = page.url();
    const pageText  = await page.innerText('body').catch(() => '');
    const hasCaptcha = /captcha|recaptcha|hcaptcha/i.test(pageText) ||
      (await page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').catch(() => null)) !== null;
    const has2fa     = /код|code|otp|two.factor|2fa|подтверд/i.test(pageText) && urlAfter === urlBefore;
    const hasError   = /неверн|invalid|incorrect|wrong|error|ошибк/i.test(pageText) && urlAfter === urlBefore;

    console.log(JSON.stringify({
      ok: !hasError,
      url_before: urlBefore,
      url_after:  urlAfter,
      navigated:  urlAfter !== urlBefore,
      captcha:    hasCaptcha,
      two_factor: has2fa,
      error_on_page: hasError,
    }));
  } finally {
    try { browser._connection.close(); } catch {}
  }
  process.exit(0);
})().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
