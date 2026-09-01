'use strict';

// GetCourse skill — two-level integration
// L1 (API key):  user management, orders           → /pl/api/*
// L2 (session):  course/lesson/block creation,     → /pl/teach/gcapi/* and /pl/lite/block/*
//                group listing (Playwright)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const USER_ID = process.env.USER_ID || '';
const AGENT_PUBLIC_URL = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '');

// ── Playwright helper ────────────────────────────────────────────────────
// Shared browser launch + cookie injection to avoid copy-paste across tools.
async function openBrowserPage(cfg) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ userAgent: cfg.sessionUserAgent || FALLBACK_UA });
  await context.addCookies((cfg.sessionCookies || []).map(c => ({
    name: c.name, value: c.value,
    domain: (c.domain || '').startsWith('.') ? c.domain : '.' + (c.domain || cfg.accountDomain),
    path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
  })));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  return { browser, page };
}

// ── Config ────────────────────────────────────────────────────────────────

function configPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'getcourse', 'config.json');
}

function readConfig(userId) {
  const file = configPath(userId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// ── Level guards ──────────────────────────────────────────────────────────

function requireL1(cfg) {
  if (!cfg.accountDomain) return { error: 'not_configured', message: 'GetCourse не подключён. Вызови gc_connect.' };
  if (!cfg.apiKey)        return { error: 'api_key_required', message: 'Нужен API ключ. Вызови gc_connect и введи API ключ из настроек GetCourse.' };
  return null;
}

function requireL2(cfg) {
  if (!cfg.accountDomain) return { error: 'not_configured', message: 'GetCourse не подключён. Вызови gc_connect.' };
  if (!cfg.sessionCookies || !cfg.sessionCookies.length)
    return { error: 'session_required', message: 'Для этой операции нужна авторизация через браузер. Вызови gc_connect и введи логин + пароль.' };
  return null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function buildCookieHeader(cfg) {
  return (cfg.sessionCookies || []).map(c => `${c.name}=${c.value}`).join('; ');
}

// L1: POST export  (users, groups, orders)
// GetCourse requires POST with form-encoded body — GET with query params returns "Пустой параметр action"
async function gcApiExport(cfg, endpoint, paramsObj) {
  const paramsB64 = Buffer.from(JSON.stringify(paramsObj)).toString('base64');
  const body = new URLSearchParams({ action: 'export', key: cfg.apiKey, params: paramsB64 });
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (json.error === 'Действие запрещено') {
      return { error: 'export_forbidden', message: 'API ключ не имеет прав на экспорт данных. В GetCourse: Настройки → API → включи "Экспорт пользователей" и "Экспорт заказов".' };
    }
    return json;
  } catch { return { error: 'non-json response', preview: text.slice(0, 500) }; }
}

// L1: POST import (users)
async function gcApiImport(cfg, endpoint, payload) {
  const paramsB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const body = new URLSearchParams({ action: 'add', key: cfg.apiKey, params: paramsB64 });
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: 'non-json response', preview: text.slice(0, 500) }; }
}

const FALLBACK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function l2Headers(cfg, extra = {}) {
  return {
    'User-Agent': cfg.sessionUserAgent || FALLBACK_UA,
    'Cookie': buildCookieHeader(cfg),
    'x-requested-with': 'XMLHttpRequest',
    'Origin': `https://${cfg.accountDomain}`,
    'Referer': `https://${cfg.accountDomain}/`,
    ...extra,
  };
}

// L2: JSON POST (createTraining, createLesson)
async function gcSessionJson(cfg, endpoint, payload) {
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: l2Headers(cfg, {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
    }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  if (res.redirected && res.url.includes('/login')) {
    return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
  }
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data && (data.accountUserId === -1 || data.user_id === -1)) {
      return { error: 'session_expired', message: 'Сессия истекла (accountUserId=-1). Вызови gc_connect чтобы войти заново.' };
    }
    if (data && data.success === false) return { error: data.error || 'request failed', raw: data };
    return data;
  } catch { return { error: 'non-json response', preview: text.slice(0, 500) }; }
}

// L2: FormData POST (lesson-constructor/add, block/update-param, block/save-sorting)
async function gcSessionForm(cfg, endpoint, fields) {
  const form = new FormData();
  const vars = cfg.sessionVars || {};
  if (vars.gcSession)     form.append('gcSession',     vars.gcSession);
  if (vars.gcVisit)       form.append('gcVisit',       vars.gcVisit);
  if (vars.gcVisitor)     form.append('gcVisitor',     vars.gcVisitor);
  if (vars.gcSessionHash) form.append('gcSessionHash', vars.gcSessionHash);
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v == null ? '' : String(v));
  }
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: l2Headers(cfg, {
      'Accept': 'application/json, text/plain, */*',
    }),
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (res.redirected && res.url.includes('/login')) {
    return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
  }
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data && (data.accountUserId === -1 || data.user_id === -1)) {
      return { error: 'session_expired', message: 'Сессия истекла (accountUserId=-1). Вызови gc_connect чтобы войти заново.' };
    }
    if (data && data.success === false) return { error: data.error || 'request failed', raw: data };
    return data;
  } catch { return { error: 'non-json response', preview: text.slice(0, 500) }; }
}

function parseCreatedId(result) {
  const url = result?.data?.redirectUrl || '';
  const m = url.match(/[?&]id=(\d+)/) || url.match(/\/id\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── Connect pending token ─────────────────────────────────────────────────

function generateConnectLink(userId) {
  const token = crypto.randomBytes(16).toString('hex');
  const dir = path.join(os.homedir(), 'connect-pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${token}.json`),
    JSON.stringify({ uid: String(userId), service: 'getcourse', expires: Date.now() + 30 * 60 * 1000 })
  );
  // Clean expired tokens
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (d.expires < now) fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
  return `${AGENT_PUBLIC_URL}/connect/getcourse?t=${token}`;
}

// ── Tools ─────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    gc_status: {
      description: 'Show GetCourse connection status: account domain, API key presence (L1), session presence and age (L2).',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const cfg = readConfig(ctx?.userId);
        if (!cfg.accountDomain) {
          return { status: 'not_configured', message: 'GetCourse не подключён. Вызови gc_connect.' };
        }
        const hasL1 = !!cfg.apiKey;
        const hasL2 = !!(cfg.sessionCookies && cfg.sessionCookies.length);
        return {
          accountDomain: cfg.accountDomain,
          level1_api_key: hasL1 ? 'configured' : 'not configured',
          level2_session: hasL2 ? `configured (${cfg.loginSavedAt || 'date unknown'})` : 'not configured',
          available: hasL2 ? 'L1 + L2 (full)' : hasL1 ? 'L1 only (user management)' : 'none — reconnect via gc_connect',
        };
      },
    },

    gc_connect: {
      description: 'Generate a one-time connection link for the user. The form lets them enter: account domain (required), API key (→ L1 user management), login + password (→ L2 course editing via browser session). They can fill any combination.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const userId = ctx?.userId || USER_ID;
        if (!userId) return { error: 'No user ID in context' };
        const url = generateConnectLink(String(userId));
        return {
          url,
          message: `Открой ссылку для подключения GetCourse:\n${url}\n\nФорма имеет 3 секции:\n• Домен аккаунта (обязательно)\n• API ключ — L1 (управление учениками)\n• Логин + Пароль — L2 (создание курсов через браузерную сессию)\n\nЛюбая комбинация полей допустима. Ссылка одноразовая, действует 30 минут.`,
        };
      },
    },

    // ── L1: User management ───────────────────────────────────────────────

    gc_user_add: {
      description: 'Add or update a GetCourse user and add them to access groups. Safe for existing users (refresh_if_exists). Use to grant course access.',
      inputSchema: {
        type: 'object',
        required: ['email'],
        properties: {
          email:      { type: 'string', description: 'User email' },
          first_name: { type: 'string', description: 'First name' },
          last_name:  { type: 'string', description: 'Last name' },
          phone:      { type: 'string', description: 'Phone number' },
          groups:     { type: 'array', items: { type: 'string' }, description: 'Group names to add the user to, e.g. ["Доступ | Курс X"]' },
          utm_source: { type: 'string', description: 'UTM source (default: agent)' },
        },
      },
      handler: async ({ email, first_name, last_name, phone, groups = [], utm_source = 'agent' }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL1(cfg);
        if (err) return err;

        const payload = {
          user: {
            email,
            ...(first_name && { first_name }),
            ...(last_name  && { last_name }),
            ...(phone      && { phone }),
            ...(groups.length && { group_name: groups }),
          },
          system: { refresh_if_exists: 1 },
          session: { utm_source, utm_medium: 'bot', utm_campaign: 'agent_action', referer: 'agent' },
        };
        return gcApiImport(cfg, '/pl/api/users', payload);
      },
    },

    gc_user_find: {
      description: 'Find a GetCourse user by email. Returns profile, groups, and order count.',
      inputSchema: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', description: 'User email to search' },
        },
      },
      handler: async ({ email }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL1(cfg);
        if (err) return err;
        return gcApiExport(cfg, '/pl/api/users', {
          page: 1, count: 10,
          rules: [{ field: 'email', condition: 'equal', value: email }],
        });
      },
    },

    gc_group_list: {
      description: 'List groups (группы доступа) in GetCourse via Playwright. Requires L2 (session). Use to find correct group_name before gc_user_add. Takes ~15s. Returns has_more:true if the account has more groups than fit on the first page.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional substring filter for group name' },
        },
      },
      handler: async ({ query }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          await page.goto(`https://${cfg.accountDomain}/pl/user/group/index`, { waitUntil: 'networkidle', timeout: 30000 });

          // Detect session expiry: GetCourse silently redirects to /login/
          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }

          await page.waitForTimeout(1500);

          const { groups, hasMore } = await page.evaluate(() => {
            const results = [];
            // Group rows with data-id attribute
            document.querySelectorAll('tr[data-id], tr[id^="group-"]').forEach(row => {
              const id = row.dataset.id || row.id.replace('group-', '');
              const nameEl = row.querySelector('td:first-child a') || row.querySelector('td.name') || row.querySelector('td:first-child');
              const name = nameEl?.textContent?.trim();
              if (id && name && name.length > 0) results.push({ id, name });
            });
            // Fallback: look for table links with /group/ in href
            if (results.length === 0) {
              document.querySelectorAll('a[href*="/group/"]').forEach(a => {
                const m = a.href.match(/\/group\/(?:view|edit)\/id\/(\d+)/);
                if (!m) return;
                const id = m[1];
                if (results.find(r => r.id === id)) return;
                const name = a.textContent.trim().slice(0, 100);
                if (!name) return; // skip icon-only anchors with no visible text
                results.push({ id, name });
              });
            }
            // Detect pagination: a next-page link/button that isn't disabled
            const nextEl = document.querySelector(
              'a[rel="next"], li.next:not(.disabled) a, .pagination .next:not(.disabled) a, a[aria-label="Next"]'
            );
            return { groups: results, hasMore: !!nextEl };
          });

          await browser.close();
          let filtered = groups;
          if (query) filtered = groups.filter(g => g.name.toLowerCase().includes(query.toLowerCase()));
          const result = { count: filtered.length, groups: filtered };
          if (hasMore) result.warning = 'has_more: только первая страница групп — на аккаунте их больше. Используй query для поиска по имени.';
          return result;
        } catch (e) {
          await browser?.close().catch(() => {});
          return { error: `Ошибка получения списка групп: ${e.message.slice(0, 200)}` };
        }
      },
    },

    gc_order_list: {
      description: 'List orders, optionally filtered by email or date range.',
      inputSchema: {
        type: 'object',
        properties: {
          email:     { type: 'string',  description: 'Filter by user email' },
          date_from: { type: 'string',  description: 'Start date YYYY-MM-DD' },
          date_to:   { type: 'string',  description: 'End date YYYY-MM-DD' },
          count:     { type: 'number',  description: 'Max records (default 20)' },
        },
      },
      handler: async ({ email, date_from, date_to, count = 20 }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL1(cfg);
        if (err) return err;
        const rules = [];
        if (email)     rules.push({ field: 'user_email', condition: 'equal',     value: email });
        if (date_from) rules.push({ field: 'created_at', condition: 'more_than', value: date_from });
        if (date_to)   rules.push({ field: 'created_at', condition: 'less_than', value: date_to });
        return gcApiExport(cfg, '/pl/api/deals', { page: 1, count, ...(rules.length && { rules }) });
      },
    },

    // ── L2: Course listing & creation ────────────────────────────────────────

    gc_course_list: {
      description: 'List all courses (trainings) in the GetCourse account. Returns id, title, url for each course. Uses Playwright to scrape the admin showcase page — takes 15–25s.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          await page.goto(`https://${cfg.accountDomain}/showcase/settings`, { waitUntil: 'networkidle', timeout: 30000 });

          // Detect session expiry: GetCourse silently redirects to /login/
          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }

          await page.waitForTimeout(2000);

          // Extract course rows: each row has a name + trainingId link
          const courses = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('a[href*="trainingId="]').forEach(a => {
              const m = a.href.match(/trainingId=(\d+)/);
              if (!m) return;
              const id = m[1];
              if (results.find(r => r.id === id)) return;
              // Walk up to find the row container and extract the course name
              let el = a.parentElement;
              for (let i = 0; i < 5; i++) {
                if (!el) break;
                const nameEl = el.querySelector('[class*="name"], [class*="title"], td:first-child, .name');
                if (nameEl && nameEl.textContent?.trim().length > 2) {
                  results.push({ id, title: nameEl.textContent.trim().slice(0, 120) });
                  return;
                }
                el = el.parentElement;
              }
              results.push({ id, title: '?' });
            });
            return results;
          });

          await browser.close();
          const withUrls = courses.map(c => ({
            ...c,
            url: `https://${cfg.accountDomain}/teach/control/stream/view?id=${c.id}`,
          }));
          return { count: withUrls.length, courses: withUrls };
        } catch (e) {
          await browser?.close().catch(() => {});
          return { error: `Ошибка получения списка курсов: ${e.message.slice(0, 200)}` };
        }
      },
    },

    gc_course_create: {
      description: 'Create a top-level training (course). Returns id and URL. Use the id in gc_section_create.',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          title:       { type: 'string', description: 'Course title (max 180 chars)' },
          description: { type: 'string', description: 'Short description (max 240 chars)' },
        },
      },
      handler: async ({ title, description = '' }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        const result = await gcSessionJson(cfg, '/pl/teach/gcapi/training/createTraining', {
          title: title.slice(0, 180),
          description: description.slice(0, 240),
          parentId: 0,
          orderPos: null,
          image: '',
        });
        if (result.error) return result;
        const id = parseCreatedId(result);
        return { ok: true, id, url: id ? `https://${cfg.accountDomain}/teach/control/stream/view?id=${id}` : null };
      },
    },

    gc_section_create: {
      description: 'Create a section (sub-training) inside a course. Returns id. Use the id in gc_lesson_create.',
      inputSchema: {
        type: 'object',
        required: ['course_id', 'title'],
        properties: {
          course_id:   { type: 'number', description: 'Parent course ID from gc_course_create' },
          title:       { type: 'string', description: 'Section title' },
          description: { type: 'string', description: 'Short description' },
        },
      },
      handler: async ({ course_id, title, description = '' }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        const result = await gcSessionJson(cfg, '/pl/teach/gcapi/training/createTraining', {
          title: title.slice(0, 180),
          description: description.slice(0, 240),
          parentId: course_id,
          orderPos: null,
          image: '',
        });
        if (result.error) return result;
        const id = parseCreatedId(result);
        return { ok: true, id, url: id ? `https://${cfg.accountDomain}/teach/control/stream/view?id=${id}` : null };
      },
    },

    gc_lesson_create: {
      description: 'Create a lesson inside a section. Returns id. Use the id in gc_lesson_add_video / gc_lesson_add_text.',
      inputSchema: {
        type: 'object',
        required: ['section_id', 'title'],
        properties: {
          section_id:  { type: 'number', description: 'Section ID from gc_section_create' },
          title:       { type: 'string', description: 'Lesson title' },
          description: { type: 'string', description: 'Short description shown under the title' },
        },
      },
      handler: async ({ section_id, title, description = '' }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        const result = await gcSessionJson(cfg, '/pl/teach/gcapi/lesson-admin/createLesson', {
          trainingId: section_id,
          type: 'visual_constructor',
          title: title.slice(0, 180),
          description: description.slice(0, 240),
        });
        if (result.error) return result;
        const id = parseCreatedId(result);
        return { ok: true, id, url: id ? `https://${cfg.accountDomain}/teach/control/lesson/view?id=${id}` : null };
      },
    },

    gc_lesson_add_video: {
      description: 'Add a Kinescope video block to a lesson. Pass the Kinescope iframe src / player URL. Returns blockId.',
      inputSchema: {
        type: 'object',
        required: ['lesson_id', 'video_url'],
        properties: {
          lesson_id: { type: 'number', description: 'Lesson ID from gc_lesson_create' },
          video_url: { type: 'string', description: 'Kinescope player URL (iframe src)' },
        },
      },
      handler: async ({ lesson_id, video_url }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        const addResult = await gcSessionForm(cfg, '/pl/api/teach/lesson-constructor/add', {
          ownerId: lesson_id, ownerTypeId: 161, presetId: 'lessonVid01',
        });
        if (addResult.error) return addResult;
        const blockId = addResult?.data?.id;
        if (!blockId) return { error: 'Could not get block id', raw: addResult };

        const updateResult = await gcSessionForm(cfg, `/pl/lite/block/update-param/?id=${blockId}&redesign=1`, {
          'params[source/src_video_link]':  video_url,
          'params[source][src_video_link]': video_url,
        });
        if (updateResult.error) return updateResult;

        return { ok: true, blockId: Number(blockId), lesson_id };
      },
    },

    gc_lesson_add_text: {
      description: 'Add a text/HTML block to a lesson. Returns blockId.',
      inputSchema: {
        type: 'object',
        required: ['lesson_id', 'html'],
        properties: {
          lesson_id: { type: 'number', description: 'Lesson ID from gc_lesson_create' },
          html:      { type: 'string', description: 'HTML content for the text block' },
        },
      },
      handler: async ({ lesson_id, html }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        const addResult = await gcSessionForm(cfg, '/pl/api/teach/lesson-constructor/add', {
          ownerId: lesson_id, ownerTypeId: 161, presetId: 'lessonTxt01',
        });
        if (addResult.error) return addResult;
        const blockId = addResult?.data?.id;
        if (!blockId) return { error: 'Could not get block id', raw: addResult };

        const updateResult = await gcSessionForm(cfg, `/pl/lite/block/update-param/?id=${blockId}&redesign=1`, {
          'params[text]': html,
          'params[items][parts][text1][inner][text]': html,
        });
        if (updateResult.error) return updateResult;

        return { ok: true, blockId: Number(blockId), lesson_id };
      },
    },

    gc_lesson_sort: {
      description: 'Set the display order of blocks inside a lesson. Pass block IDs in the desired order.',
      inputSchema: {
        type: 'object',
        required: ['block_ids'],
        properties: {
          block_ids: { type: 'array', items: { type: 'number' }, description: 'Block IDs in desired display order' },
        },
      },
      handler: async ({ block_ids }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        const form = new FormData();
        const vars = cfg.sessionVars || {};
        if (vars.gcSession)     form.append('gcSession',     vars.gcSession);
        if (vars.gcVisit)       form.append('gcVisit',       vars.gcVisit);
        if (vars.gcVisitor)     form.append('gcVisitor',     vars.gcVisitor);
        if (vars.gcSessionHash) form.append('gcSessionHash', vars.gcSessionHash);
        for (const id of block_ids) form.append('positions[]', String(id));

        const res = await fetch(`https://${cfg.accountDomain}/pl/lite/block/save-sorting`, {
          method: 'POST',
          headers: l2Headers(cfg, { 'Accept': 'application/json, text/plain, */*' }),
          body: form,
          signal: AbortSignal.timeout(10000),
        });
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { ok: res.ok, preview: text.slice(0, 200) }; }
      },
    },

  },
};
