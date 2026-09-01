'use strict';

// Exhibition enrichment pipeline
//
// Full flow for exhibition intelligence:
//   1. expo_find_participants / expo_parse_participants → raw company list
//   2. expo_fetch_company_contacts                     → +website, +email (CPM-style catalogs)
//   3. expo_find_inn                                   → +inn (website regex → DaData 4-pass)
//   4. expo_enrich_finances                            → +ogrn, +director, +revenue, +profit, +Целевая?
//   5. gdrive_write_sheet                              → Google Sheet
//
// Reference implementations:
//   /home/vova/users/flexi-consult/participants/find-inn-cpm.js
//   /home/vova/users/flexi-consult/participants/enrich-finances.js
//   github:flexi-consulting/exhibitions/scripts/enrich_dadata.py

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (compatible; expo-enrich/1.0)';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchText(url, timeoutMs = 10000) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!r.ok) return '';
    return await r.text();
  } catch { return ''; }
}

// ── INN helpers ─────────────────────────────────────────────────────────────

function validInn(s) {
  if (!/^\d{10}$/.test(s) && !/^\d{12}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const cs = (arr, w) => arr.reduce((a, x, i) => a + x * w[i], 0) % 11 % 10;
  if (s.length === 10) return cs(d.slice(0, 9), [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return cs(d.slice(0, 10), [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] &&
         cs(d.slice(0, 11), [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}

function innFromText(html) {
  const text = html.replace(/<[^>]+>/g, ' ');
  const re = /(?:ИНН|INN|инн)\D{0,15}(\d{10}|\d{12})/g;
  let m;
  while ((m = re.exec(text))) { if (validInn(m[1])) return m[1]; }
  return null;
}

// ── DaData helpers (ported from enrich_dadata.py) ───────────────────────────

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function stripOpf(name) {
  return String(name || '').replace(/^(ООО|ОАО|ЗАО|ПАО|АО|НАО|ГУП|МУП|ИП|АНО)\s*["']?\s*/i, '');
}
function wordOverlap(q, candidate) {
  const words = s => (s.toLowerCase().match(/[а-яёa-z0-9]{3,}/g) || []);
  const qw = [...new Set(words(q))], cw = [...new Set(words(candidate))];
  if (!qw.length) return 0;
  return qw.filter(w => cw.some(c => c.includes(w) || w.includes(c))).length / qw.length;
}
function emailDomainQuery(email) {
  if (!email || !email.includes('@')) return null;
  const parts = email.split('@').pop().toLowerCase().split('.');
  if (parts.length < 2) return null;
  const name = parts[parts.length - 2];
  if (name.length < 4) return null;
  return name.replace(/[-_]/g, ' ');
}

async function dadataRaw(query, token, secret, city = '') {
  try {
    const payload = { query, count: 5 };
    if (city) payload.locations = [{ city }];
    const r = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Token ' + token, 'X-Secret': secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    return (await r.json()).suggestions || [];
  } catch { return []; }
}

// 4-pass matching from enrich_dadata.py — no blind first-result guessing
async function dadataSearch(name, token, secret, email = '', city = '') {
  let query = clean(stripOpf(name));
  if (query.length < 3) query = (name || '').slice(0, 40);

  let sugg = await dadataRaw(query, token, secret, city);
  if (!sugg.length && city) sugg = await dadataRaw(query, token, secret);

  const q = query.toLowerCase();

  // Pass 1: exact
  for (const s of sugg) {
    const val = clean(stripOpf(s.value)).toLowerCase();
    if (q === val || val.includes(q)) {
      const inn = s.data?.inn;
      if (inn && validInn(inn)) return { inn, ogrn: s.data?.ogrn, director: s.data?.management?.name, matched: s.value, via: 'exact' };
    }
  }
  // Pass 2: all words present
  for (const s of sugg) {
    const val = clean(stripOpf(s.value)).toLowerCase();
    if (wordOverlap(q, val) >= 1.0) {
      const inn = s.data?.inn;
      if (inn && validInn(inn)) return { inn, ogrn: s.data?.ogrn, director: s.data?.management?.name, matched: s.value, via: 'word-match' };
    }
  }
  // Pass 3: city + partial overlap
  if (city) {
    for (const s of sugg) {
      const val = clean(stripOpf(s.value)).toLowerCase();
      const addr = (s.data?.address?.unrestricted_value || '').toLowerCase();
      if (addr.includes(city.toLowerCase()) && wordOverlap(q, val) >= 0.7) {
        const inn = s.data?.inn;
        if (inn && validInn(inn)) return { inn, ogrn: s.data?.ogrn, director: s.data?.management?.name, matched: s.value, via: 'city+words' };
      }
    }
  }
  // Pass 4: email domain fallback
  const domQ = emailDomainQuery(email);
  if (domQ && domQ !== q) {
    let dom = await dadataRaw(domQ, token, secret, city);
    if (!dom.length) dom = await dadataRaw(domQ, token, secret);
    for (const s of dom) {
      const val = clean(stripOpf(s.value)).toLowerCase();
      if (wordOverlap(domQ, val) >= 0.7) {
        const inn = s.data?.inn;
        if (inn && validInn(inn)) return { inn, ogrn: s.data?.ogrn, director: s.data?.management?.name, matched: s.value, via: 'email-domain:' + domQ };
      }
    }
  }
  return null;
}

// ── Checko finances ──────────────────────────────────────────────────────────

async function checkoFinances(inn, key) {
  try {
    const r = await fetch(`https://api.checko.ru/v2/finances?key=${key}&inn=${inn}`, {
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    if (d.meta?.status !== 'ok') return null;
    for (const year of Object.keys(d.data || {}).sort().reverse()) {
      const rev = d.data[year]['2110'];
      if (rev && rev > 0) {
        const prof = d.data[year]['2400'];
        return {
          revenue_mln: Math.round(rev / 1e6 * 10) / 10,
          profit_mln: prof != null ? Math.round(prof / 1e6 * 10) / 10 : null,
          revenue_year: parseInt(year),
        };
      }
    }
    return null;
  } catch { return null; }
}

// ── Target scoring ───────────────────────────────────────────────────────────

function isTarget(rev, profit, criteria) {
  if (rev == null) return '';
  // Custom criteria object: { min1, max1, min2, max2, max_profit2 }
  if (criteria) {
    const { min1 = 150, max1 = 1000, min2 = 1000, max2 = 5000, max_profit2 = 100 } = criteria;
    if (rev >= min1 && rev <= max1) return 'Да';
    if (rev > min2 && rev <= max2 && (profit == null || profit <= max_profit2)) return 'Да';
    return 'Нет';
  }
  // Default Skolkovo criteria
  if (rev >= 150 && rev <= 1000) return 'Да';
  if (rev > 1000 && rev <= 5000 && (profit == null || profit <= 100)) return 'Да';
  return 'Нет';
}

// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  tools: {

    expo_fetch_company_contacts: {
      description:
        'Для CPM-style каталогов (cpm-digital.ru, catalog.textile-salon.ru, catalog.tourismexpo.ru и подобных): ' +
        'обходит карточки компаний и извлекает сайт + email каждой.\n\n' +
        'Используй после expo_find_participants когда нужны контакты (сайты, email) — ' +
        'они есть на отдельных страницах компаний, а не в общем списке.\n\n' +
        'Алгоритм: для каждой company.url (путь карточки) делает fetch → ищет внешние ссылки (не хост каталога) и mailto: ' +
        'Параллельно, 20 потоков. Сохраняет в out_file.\n\n' +
        'Пример: catalog_base="https://cpm-digital.ru", companies=[{name, url:"/companies/company/123-name.html"}]',
      inputSchema: {
        type: 'object',
        required: ['catalog_base', 'companies'],
        properties: {
          catalog_base: {
            type: 'string',
            description: 'Базовый URL каталога (протокол + хост), например https://cpm-digital.ru',
          },
          companies: {
            type: 'array',
            description: 'Массив {name, url} где url — путь карточки компании в каталоге',
            items: { type: 'object' },
          },
          bad_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Домены-исключения для сайтов (по умолчанию: соцсети, сам каталог)',
          },
          out_file: {
            type: 'string',
            description: 'Путь для сохранения результата JSON. Если не указан — возвращает inline.',
          },
          concurrency: {
            type: 'number',
            description: 'Параллельных запросов (default 20)',
          },
        },
      },
      handler: async ({ catalog_base, companies, bad_domains = [], out_file, concurrency = 20 }) => {
        if (!Array.isArray(companies) || !companies.length) return { error: 'companies обязателен — массив {name, url}' };

        const catalogHost = (() => { try { return new URL(catalog_base).hostname; } catch { return ''; } })();
        const DEFAULT_BAD = ['vk.com', 'instagram.com', 't.me', 'facebook.com', 'ok.ru', 'youtube.com', 'tiktok.com', 'linkedin.com', 'twitter.com', 'wa.me'];
        const allBad = [...DEFAULT_BAD, ...bad_domains];
        const isBadHost = h => allBad.some(b => h === b || h.endsWith('.' + b)) || h === catalogHost;

        const results = [...companies];
        let ptr = 0;
        let found = 0;

        async function worker() {
          while (ptr < results.length) {
            const i = ptr++;
            const c = results[i];
            if (!c.url) continue;
            const fullUrl = c.url.startsWith('http') ? c.url : catalog_base.replace(/\/$/, '') + '/' + c.url.replace(/^\//, '');
            const html = await fetchText(fullUrl, 8000);
            if (!html) continue;

            // External website links
            const linkRe = /href=["'](https?:\/\/([^/"']+)[^"']*)["']/gi;
            let m;
            while ((m = linkRe.exec(html)) !== null) {
              const host = m[2].toLowerCase();
              if (!isBadHost(host)) { results[i].website = m[1]; break; }
            }
            // Email
            const emailRe = /href=["']mailto:([^"'?]+)["']|([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
            while ((m = emailRe.exec(html)) !== null) {
              const em = (m[1] || m[2] || '').toLowerCase();
              if (em && !em.includes('expo-fusion') && !em.includes('cpm-digital')) {
                results[i].email = em; break;
              }
            }
            if (results[i].website || results[i].email) found++;
          }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, results.length) }, worker));

        if (out_file) {
          fs.mkdirSync(path.dirname(path.resolve(out_file)), { recursive: true });
          fs.writeFileSync(path.resolve(out_file), JSON.stringify(results, null, 1));
        }

        return {
          ok: true,
          total: results.length,
          with_website: results.filter(c => c.website).length,
          with_email: results.filter(c => c.email).length,
          ...(out_file ? { saved_to: out_file } : { companies: results }),
        };
      },
    },

    expo_find_inn: {
      description:
        'Находит ИНН для списка компаний. Источники в порядке приоритета:\n' +
        '1. Сайт компании — парсим regex /ИНН\\D{0,15}(\\d{10}|\\d{12})/ на главной + /about/contacts/rekvizity (бесплатно)\n' +
        '2. DaData suggest/party по названию — алгоритм из enrich_dadata.py: 4 прохода (exact → word_overlap≥1.0 → city+0.7 → домен email) (бесплатно, квота 10k/день)\n\n' +
        'Важно: работает только для российских юрлиц. Иностранные бренды с латинскими названиями — ИНН не найдёт.\n' +
        'Типичное покрытие: 30–60% для выставочных каталогов (большинство участников — торговые марки, не юрлица).\n\n' +
        'DaData ключи берёт из платформенных переменных (INN_DADATA_TOKEN / INN_DADATA_SECRET) или явных параметров.\n' +
        'Результат сохраняет в out_file (прогресс каждые 20 компаний) и возвращает статистику.',
      inputSchema: {
        type: 'object',
        properties: {
          companies: {
            type: 'array',
            description: 'Массив {name, website?, email?, booth?, ...} — можно передать всё что есть',
            items: { type: 'object' },
          },
          file: {
            type: 'string',
            description: 'Путь к JSON-файлу с массивом компаний (альтернатива companies)',
          },
          out_file: {
            type: 'string',
            description: 'Куда сохранить результат (default: {file}_inn.json или cwd/inn_results.json)',
          },
          dadata_token: { type: 'string', description: 'DaData API token (если не задан в env)' },
          dadata_secret: { type: 'string', description: 'DaData secret (если не задан в env)' },
          concurrency: { type: 'number', description: 'Параллельных запросов (default 8)' },
          resume: { type: 'boolean', description: 'Пропустить компании где уже есть inn в out_file (default true)' },
        },
      },
      handler: async ({ companies, file, out_file, dadata_token, dadata_secret, concurrency = 8, resume = true }) => {
        const token = dadata_token || process.env.INN_DADATA_TOKEN || 'a353466f84c8971ce2332bcb30598eacd1ea76b0';
        const secret = dadata_secret || process.env.INN_DADATA_SECRET || '1d657733fcab3d3ca613a76d9332d46c4f712d34';

        let all;
        let defaultOut;
        if (companies && Array.isArray(companies) && companies.length) {
          all = companies.map((c, i) => ({ id: i + 1, ...c }));
          defaultOut = path.join(process.cwd(), 'inn_results.json');
        } else if (file) {
          const fp = path.resolve(file);
          if (!fs.existsSync(fp)) return { error: `File not found: ${fp}` };
          all = JSON.parse(fs.readFileSync(fp, 'utf8'));
          defaultOut = fp.replace(/\.json$/, '') + '_inn.json';
        } else {
          return { error: 'Нужен companies (массив) или file (путь к JSON)' };
        }

        const outPath = out_file ? path.resolve(out_file) : defaultOut;

        // Resume: load existing progress
        if (resume && fs.existsSync(outPath)) {
          const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
          const found = {};
          existing.forEach(c => { if (c.inn) found[c.name] = c; });
          all = all.map(c => found[c.name] ? { ...c, ...found[c.name] } : c);
        }

        const SUBPAGES = ['/about', '/contacts', '/contact', '/rekvizity', '/kontakty', '/about-us'];
        const todo = all.filter(c => !c.inn);

        let ptr = 0, done = 0, newFound = 0;

        async function worker() {
          while (ptr < todo.length) {
            const c = todo[ptr++];

            // Step 1: website
            if (c.website) {
              const html = await fetchText(c.website, 8000);
              let inn = innFromText(html);
              if (!inn) {
                for (const p of SUBPAGES) {
                  try {
                    const sub = new URL(p, c.website).href;
                    const sh = await fetchText(sub, 5000);
                    inn = innFromText(sh);
                    if (inn) { c.inn_source = 'website' + p; break; }
                  } catch {}
                }
              } else {
                c.inn_source = 'website';
              }
              if (inn) { c.inn = inn; }
            }

            // Step 2: DaData
            if (!c.inn && token) {
              await sleep(150);
              const d = await dadataSearch(c.name, token, secret, c.email || '');
              if (d) {
                c.inn = d.inn;
                c.inn_source = d.via.startsWith('email-domain') ? 'dadata:domain' : 'dadata:name';
                if (!c.ogrn && d.ogrn) c.ogrn = d.ogrn;
                if (!c.director && d.director) c.director = d.director;
              }
            }

            if (c.inn) newFound++;
            done++;

            // Save progress every 20
            if (done % 20 === 0) {
              fs.writeFileSync(outPath, JSON.stringify(all, null, 1));
            }
          }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, todo.length || 1) }, worker));
        fs.writeFileSync(outPath, JSON.stringify(all, null, 1));

        const bySource = {};
        all.filter(c => c.inn).forEach(c => { bySource[c.inn_source || 'unknown'] = (bySource[c.inn_source || 'unknown'] || 0) + 1; });

        return {
          ok: true,
          total: all.length,
          with_inn: all.filter(c => c.inn).length,
          new_found: newFound,
          by_source: bySource,
          saved_to: outPath,
        };
      },
    },

    expo_enrich_finances: {
      description:
        'Обогащает компании с ИНН финансовыми данными и рассчитывает "Целевая?".\n\n' +
        'Источники:\n' +
        '- DaData suggest/party по ИНН → ОГРН, ФИО директора (бесплатно)\n' +
        '- Checko API GET /v2/finances?inn=... → выручка (код 2110), прибыль (код 2400) (платно, нужен API ключ)\n\n' +
        'Критерий "Целевая?" по умолчанию (Сколково):\n' +
        '- Выручка 150–1000 млн, любая прибыль → Да\n' +
        '- Выручка 1000–5000 млн + прибыль ≤100 млн → Да\n' +
        'Можно задать кастомный criteria {min1, max1, min2, max2, max_profit2} в млн.\n\n' +
        'Checko ключ берёт из платформенной переменной INN_CHECKO_KEY или параметра.\n' +
        'Пауза между Checko запросами 400мс. Прогресс сохраняется каждые 10 компаний.',
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'JSON-файл с компаниями (должен иметь поле inn). Результат перезаписывает файл.',
          },
          companies: {
            type: 'array',
            description: 'Inline массив компаний с полем inn',
            items: { type: 'object' },
          },
          out_file: {
            type: 'string',
            description: 'Куда сохранить (default: тот же файл или cwd/finances_enriched.json)',
          },
          checko_key: { type: 'string', description: 'Checko API ключ (если не задан в env)' },
          dadata_token: { type: 'string', description: 'DaData token (для ОГРН+директор)' },
          dadata_secret: { type: 'string', description: 'DaData secret' },
          criteria: {
            type: 'object',
            description: 'Кастомный критерий целевой. Поля (в млн): min1, max1, min2, max2, max_profit2',
          },
          resume: {
            type: 'boolean',
            description: 'Пропустить компании где уже есть revenue_mln (default true)',
          },
        },
      },
      handler: async ({ file, companies, out_file, checko_key, dadata_token, dadata_secret, criteria, resume = true }) => {
        const checkoK = checko_key || process.env.INN_CHECKO_KEY || 'BcCm6AGdVBx9j0MC';
        const token = dadata_token || process.env.INN_DADATA_TOKEN || 'a353466f84c8971ce2332bcb30598eacd1ea76b0';
        const secret = dadata_secret || process.env.INN_DADATA_SECRET || '1d657733fcab3d3ca613a76d9332d46c4f712d34';

        let all;
        let outPath;
        if (companies && Array.isArray(companies) && companies.length) {
          all = companies;
          outPath = out_file ? path.resolve(out_file) : path.join(process.cwd(), 'finances_enriched.json');
        } else if (file) {
          const fp = path.resolve(file);
          if (!fs.existsSync(fp)) return { error: `File not found: ${fp}` };
          all = JSON.parse(fs.readFileSync(fp, 'utf8'));
          outPath = out_file ? path.resolve(out_file) : fp;
        } else {
          return { error: 'Нужен file или companies' };
        }

        const withInn = all.filter(c => c.inn);
        const todo = resume ? withInn.filter(c => c.revenue_mln == null) : withInn;

        let done = 0, checkoHits = 0, dadataHits = 0;

        for (const c of todo) {
          // DaData by INN → ogrn + director (if missing)
          if ((!c.ogrn || !c.director) && token) {
            await sleep(150);
            const sugg = await dadataRaw(c.inn, token, secret);
            const s = sugg[0];
            if (s) {
              if (!c.ogrn && s.data?.ogrn) { c.ogrn = s.data.ogrn; dadataHits++; }
              if (!c.director && s.data?.management?.name) c.director = s.data.management.name;
            }
          }

          // Checko → finances
          await sleep(400);
          const fin = await checkoFinances(c.inn, checkoK);
          if (fin) {
            c.revenue_mln = fin.revenue_mln;
            c.profit_mln = fin.profit_mln;
            c.revenue_year = fin.revenue_year;
            checkoHits++;
          }

          c.target = isTarget(c.revenue_mln, c.profit_mln, criteria);

          done++;
          if (done % 10 === 0) {
            fs.writeFileSync(outPath, JSON.stringify(all, null, 1));
          }
        }

        fs.writeFileSync(outPath, JSON.stringify(all, null, 1));

        const targets = all.filter(c => c.target === 'Да');
        return {
          ok: true,
          total: all.length,
          processed: done,
          with_finances: all.filter(c => c.revenue_mln != null).length,
          targets: targets.length,
          target_companies: targets.map(c => ({ name: c.name, inn: c.inn, revenue_mln: c.revenue_mln, profit_mln: c.profit_mln })),
          saved_to: outPath,
        };
      },
    },

  },
};
