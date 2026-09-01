'use strict';

// Headless Playwright login to GetCourse (standard email/password form).
// Captures session cookies + localStorage GC tokens needed for UI API calls.

const fs = require('fs');
const path = require('path');
const os = require('os');

function configPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId), 'getcourse', 'config.json');
}

function readConfig(userId) {
  const file = configPath(userId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function mergeConfig(userId, patch) {
  const file = configPath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readConfig(userId);
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2), { mode: 0o600 });
}

/**
 * Log in to GetCourse with email + password.
 * Writes sessionCookies + sessionVars into config.json (merging with existing fields).
 * @returns {{ status:'ok', cookiesCount:number }|{ error:string }}
 */
async function startGetcourseLogin(userId, domain, login, password) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    return { error: `Не удалось запустить браузер: ${e.message}` };
  }

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ru-RU',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    const baseUrl = `https://${domain}`;
    console.log('[getcourse-login] navigating to %s/cms/system/login', baseUrl);
    await page.goto(`${baseUrl}/cms/system/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const emailInput = page.locator('input[name="email"], input[type="email"], input[name="login"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(login);

    const pwInput = page.locator('input[type="password"]').first();
    await pwInput.waitFor({ state: 'visible' });
    await pwInput.fill(password);

    await page.locator('button[type="submit"], input[type="submit"]').first().click();

    const outcome = await Promise.race([
      page.waitForURL(u => !u.includes('/cms/system/login') && !u.includes('/login'), { timeout: 25000 })
        .then(() => 'success'),
      page.waitForSelector('.form-error, .alert-danger, [class*="error-message"]', { timeout: 25000 })
        .then(() => 'login_error'),
    ]).catch(() => 'timeout');

    if (outcome === 'login_error') {
      const errEl = await page.$('.form-error, .alert-danger, [class*="error-message"]');
      const errText = errEl ? (await errEl.textContent() || '').trim().slice(0, 200) : 'Неверный логин или пароль';
      await browser.close();
      return { error: errText || 'Неверный логин или пароль' };
    }

    if (outcome === 'timeout') {
      const screenshotPath = path.join(os.tmpdir(), `gc-login-fail-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      const currentUrl = page.url();
      console.error('[getcourse-login] timeout, url=%s, screenshot=%s', currentUrl, screenshotPath);
      await browser.close();
      return { error: `Тайм-аут — проверьте домен, логин и пароль (url: ${currentUrl})` };
    }

    // Grab cookies (filter to the account domain)
    const allCookies = await context.cookies();
    const sessionCookies = allCookies.filter(c =>
      c.domain.includes(domain) || c.domain.includes('getcourse.ru')
    );

    // Grab GetCourse session tokens from localStorage (needed for form-based UI API calls)
    const sessionVars = await page.evaluate(() => ({
      gcSession:     localStorage.getItem('gcSession'),
      gcVisit:       localStorage.getItem('gcVisit'),
      gcVisitor:     localStorage.getItem('gcVisitor'),
      gcSessionHash: localStorage.getItem('gcSessionHash'),
    })).catch(() => ({}));

    await browser.close();

    mergeConfig(userId, {
      sessionCookies,
      sessionVars,
      loginSavedAt: new Date().toISOString(),
    });

    console.log('[getcourse-login] session saved, userId=%s, domain=%s, cookies=%d', userId, domain, sessionCookies.length);
    return { status: 'ok', cookiesCount: sessionCookies.length };
  } catch (e) {
    browser.close().catch(() => {});
    console.error('[getcourse-login] error:', e.message);
    return { error: `Ошибка при входе: ${e.message.slice(0, 200)}` };
  }
}

module.exports = { startGetcourseLogin, mergeConfig };
