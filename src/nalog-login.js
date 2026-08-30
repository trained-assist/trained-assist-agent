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
      extraHTTPHeaders: {
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        // Override Client Hints to hide "HeadlessChrome"
        'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not-A.Brand";v="99"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Linux"',
      },
    });
    // Hide automation signals
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    });
    const page = await context.newPage();

    // Navigate; nalog.ru redirects to ESIA automatically
    console.log('[nalog-login] navigating to lknpd.nalog.ru');
    await page.goto('https://lknpd.nalog.ru/', { waitUntil: 'networkidle', timeout: 30000 });

    const onEsia = () => /gosuslugi\.ru|esia\./.test(page.url());

    if (!onEsia()) {
      // Ensure we're on the login page
      if (!/auth\/login/.test(page.url())) {
        await page.goto('https://lknpd.nalog.ru/auth/login', { waitUntil: 'networkidle', timeout: 15000 });
      }

      // nalog.ru has 3 login tabs: "ИНН и пароль" | "Номер телефона" | "Госуслуги"
      // Step 1: click the Госуслуги tab to switch to ESIA mode
      const tabEl = page.locator('button, [role="tab"]', { hasText: 'Госуслуги' }).first();
      try {
        await tabEl.waitFor({ state: 'visible', timeout: 8000 });
        const box = await tabEl.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(200);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await tabEl.click();
        }
        console.log('[nalog-login] clicked Госуслуги tab');
        await page.waitForTimeout(600);
      } catch {
        await browser.close();
        return { error: 'Не нашли вкладку "Госуслуги" на странице входа' };
      }

      // Step 2: click "ВОЙТИ" to start the ESIA OAuth redirect
      const submitBtn = page.locator('button', { hasText: /войти/i }).first();
      try {
        await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
        const box = await submitBtn.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(200);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await submitBtn.click();
        }
        console.log('[nalog-login] clicked ВОЙТИ, awaiting ESIA redirect');
      } catch {
        await browser.close();
        return { error: 'Не нашли кнопку "ВОЙТИ" после выбора вкладки Госуслуги' };
      }

      try {
        await page.waitForURL(/gosuslugi\.ru|esia\./, { timeout: 20000 });
      } catch {
        await browser.close();
        return { error: 'Не перешло на Госуслуги — сайт заблокировал переход или изменил структуру страницы' };
      }
    }

    if (!onEsia()) {
      await browser.close();
      return { error: 'Не удалось найти кнопку "Войти через Госуслуги"' };
    }

    console.log('[nalog-login] on ESIA, filling credentials, url=%s', page.url());

    // Wait for the form to fully render before touching anything
    const loginInput = page.locator('#login, input[name="login"], input[autocomplete="username"]').first();
    await loginInput.waitFor({ state: 'visible', timeout: 25000 });

    const pwInput = page.locator('#password, input[name="password"], input[type="password"]').first();
    // Check if password field is also visible right now (single-step form)
    const pwAlreadyVisible = await pwInput.isVisible({ timeout: 3000 }).catch(() => false);

    // Log what's on the page for debugging
    const pageState = await page.evaluate(() => ({
      buttons: Array.from(document.querySelectorAll('button'))
        .map(b => `${b.type}:"${b.textContent.trim().slice(0, 25)}"[${b.className.slice(0, 40)}]`)
        .join(' | '),
    }));
    console.log('[nalog-login] ESIA buttons: %s', pageState.buttons);

    await loginInput.fill(login);
    await page.waitForTimeout(300);

    if (!pwAlreadyVisible) {
      // Two-step form: click next to reveal password field.
      // Use page.evaluate to bypass Playwright actionability and skip the lang-switcher button.
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b =>
          b.offsetParent !== null &&
          !b.classList.contains('header__lang-button') &&
          (/войти|далее|продолжить/i.test(b.textContent) || b.type === 'submit')
        );
        if (btn) { btn.click(); return btn.textContent.trim().slice(0, 30); }
        return null;
      });
      console.log('[nalog-login] ESIA two-step next clicked: %s', clicked);
      try {
        await pwInput.waitFor({ state: 'visible', timeout: 15000 });
      } catch {
        await browser.close();
        return { error: 'Не нашли поле для пароля — Госуслуги заблокировали вход или изменили форму' };
      }
    }

    await pwInput.fill(password);
    await page.waitForTimeout(300);

    // Click the final "Войти" button via evaluate to avoid selector issues
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b =>
        b.offsetParent !== null &&
        !b.classList.contains('header__lang-button') &&
        (/войти/i.test(b.textContent) || b.type === 'submit')
      );
      if (btn) btn.click();
    });

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
