'use strict';

// Headless browser login to lknpd.nalog.ru via Gosuslugi (ESIA).
// Manages in-process Playwright sessions between the credential step
// and the optional 2FA code step.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// sessionId → { browser, page, context, userId, expires }
const pendingSessions = new Map();

const SESSION_TTL_MS = 25 * 60 * 1000; // 25 min

setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of pendingSessions) {
    if (sess.expires < now) {
      sess.browser.close().catch(() => {});
      pendingSessions.delete(id);
      console.log(`[nalog-login] session ${id} expired`);
    }
  }
}, 5 * 60 * 1000);

/**
 * Phase 1: navigate to lknpd.nalog.ru, redirect through ESIA, fill credentials.
 * @returns {{ status:'ok', expires?:string }
 *          |{ status:'need_code', sessionId:string }
 *          |{ error:string }}
 */
async function startNalogLogin(userId, login, password) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  } catch (e) {
    return { error: `Не удалось запустить браузер: ${e.message}` };
  }

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
    });
    // Hide automation signals
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      window.chrome = { runtime: {} };
    });
    const page = await context.newPage();

    // Navigate; nalog.ru redirects to ESIA automatically
    console.log('[nalog-login] navigating to lknpd.nalog.ru');
    await page.goto('https://lknpd.nalog.ru/', { waitUntil: 'networkidle', timeout: 30000 });

    const onEsia = () => /gosuslugi\.ru|esia\./.test(page.url());

    if (!onEsia()) {
      // Try to find the "Войти через Госуслуги" button
      const btnSelectors = [
        'a[href*="gosuslugi"]',
        'a[href*="esia"]',
        'button:has-text("Госуслуги")',
        'a:has-text("Госуслуги")',
        '[class*="gosuslugi"]',
      ];
      let clicked = false;
      for (const sel of btnSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.click();
            clicked = true;
            break;
          }
        } catch { /* selector not found */ }
      }

      if (!clicked) {
        // Try the explicit auth URL
        await page.goto('https://lknpd.nalog.ru/auth/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
        for (const sel of btnSelectors) {
          try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 })) {
              await el.click();
              clicked = true;
              break;
            }
          } catch { /* ignore */ }
        }
      }

      if (clicked) {
        try {
          await page.waitForURL(/gosuslugi\.ru|esia\./, { timeout: 20000 });
        } catch {
          await browser.close();
          return { error: 'Не перешло на Госуслуги после клика — возможно, сайт заблокировал автоматизацию' };
        }
      }
    }

    if (!onEsia()) {
      await browser.close();
      return { error: 'Не удалось найти кнопку "Войти через Госуслуги"' };
    }

    console.log('[nalog-login] on ESIA, filling credentials, url=%s', page.url());

    // ESIA login is 2-step: first enter login, then password on next screen
    const loginInput = page.locator('#login, input[name="login"], input[autocomplete="username"]').first();
    await loginInput.waitFor({ state: 'visible', timeout: 15000 });
    await loginInput.fill(login);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(800);

    // Password (appears on same page or next page)
    const pwInput = page.locator('#password, input[name="password"], input[type="password"]').first();
    try {
      await pwInput.waitFor({ state: 'visible', timeout: 10000 });
      await pwInput.fill(password);
      await page.locator('button[type="submit"]').first().click();
    } catch {
      await browser.close();
      return { error: 'Не нашли поле для пароля — форма Госуслуг изменилась или запрос заблокирован' };
    }

    console.log('[nalog-login] credentials submitted, waiting for outcome');

    const outcome = await Promise.race([
      // Success: back on nalog.ru (not on /auth/ sub-path)
      page.waitForURL(u => /lknpd\.nalog\.ru/.test(u) && !/\/auth\//.test(u), { timeout: 30000 })
        .then(() => 'success'),
      // 2FA code input
      page.waitForSelector(
        '#otp, input[name="otp"], input[placeholder*="код"], input[placeholder*="sms"], input[maxlength="6"], .form-otp input',
        { timeout: 30000 },
      ).then(() => 'need_code'),
    ]).catch(() => 'timeout');

    if (outcome === 'success') {
      return extractAndSave(page, browser, userId);
    }

    if (outcome === 'need_code') {
      const sessionId = crypto.randomBytes(16).toString('hex');
      pendingSessions.set(sessionId, { browser, page, context, userId, expires: Date.now() + SESSION_TTL_MS });
      console.log('[nalog-login] 2FA required, sessionId=%s', sessionId);
      return { status: 'need_code', sessionId };
    }

    // Timeout — try to read an error message from the page
    const errEl = await page.$('.form__error, .error-text, [class*="error"]');
    const errText = errEl ? (await errEl.textContent() || '').trim().slice(0, 200) : '';
    await browser.close();
    return { error: errText || 'Тайм-аут при ожидании ответа Госуслуг — проверьте логин и пароль' };

  } catch (e) {
    browser.close().catch(() => {});
    console.error('[nalog-login] startNalogLogin error:', e.message);
    return { error: `Ошибка при входе: ${e.message.slice(0, 200)}` };
  }
}

/**
 * Phase 2: fill the 2FA code and complete login.
 * @returns {{ status:'ok', expires?:string }|{ error:string }}
 */
async function confirmNalogCode(sessionId, code) {
  const sess = pendingSessions.get(sessionId);
  if (!sess) return { error: 'Сессия не найдена или истекла — начните заново' };
  if (sess.expires < Date.now()) {
    pendingSessions.delete(sessionId);
    sess.browser.close().catch(() => {});
    return { error: 'Сессия истекла — начните заново' };
  }

  const { browser, page, userId } = sess;
  pendingSessions.delete(sessionId); // one-time

  try {
    const codeInput = page.locator('#otp, input[name="otp"], input[placeholder*="код"], input[maxlength="6"], .form-otp input').first();
    await codeInput.fill(code);
    await page.locator('button[type="submit"]:visible').first().click();

    await page.waitForURL(u => /lknpd\.nalog\.ru/.test(u) && !/\/auth\//.test(u), { timeout: 30000 });
    return extractAndSave(page, browser, userId);
  } catch (e) {
    browser.close().catch(() => {});
    return { error: `Ошибка при вводе кода: ${e.message.slice(0, 200)}` };
  }
}

async function extractAndSave(page, browser, userId) {
  try {
    // Wait for the SPA to write the token into sessionStorage
    await page.waitForFunction(() => !!sessionStorage.getItem('auth.token'), { timeout: 10000 });

    const tokens = await page.evaluate(() => ({
      auth_token: sessionStorage.getItem('auth.token'),
      refresh_token: sessionStorage.getItem('refresh.token'),
      expires: sessionStorage.getItem('auth.token.expires'),
    }));

    await browser.close();

    if (!tokens.auth_token) return { error: 'Вошли, но auth.token не появился в sessionStorage' };

    const dir = path.join(os.homedir(), 'agent-tokens', String(userId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nalog'), JSON.stringify(tokens, null, 2), { mode: 0o600 });
    console.log('[nalog-login] token saved, userId=%s, expires=%s', userId, tokens.expires);

    return { status: 'ok', expires: tokens.expires, userId };
  } catch (e) {
    browser.close().catch(() => {});
    return { error: `Не удалось извлечь токен: ${e.message}` };
  }
}

module.exports = { startNalogLogin, confirmNalogCode };
