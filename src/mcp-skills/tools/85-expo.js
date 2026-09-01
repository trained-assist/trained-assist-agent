'use strict';

// Expo Participants skill
// Finds the participants/exhibitors page of an exhibition site and extracts
// company names as a CSV list ready for INN enrichment.
//
// Two-step approach:
//   1. expo_find_participants_page(site_url) — crawl site, find & return participants HTML
//   2. expo_parse_participants(html, [source_url]) — parse raw HTML → CSV
//
// If step 1 fails (JS-rendered site), Claude should use WebFetch / browser tools
// to get the page HTML, then call expo_parse_participants with the result.

const PARTICIPANT_LINK_RE = /участник|экспонент|exhibitor|participant|company|compan|companies|visitor|посетител/i;
const PARTICIPANT_PATH_RE = /\/(?:participants?|exhibitors?|companies|visitors?|экспонент|участник|company)/i;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const FETCH_TIMEOUT_MS = 12000;

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.9', 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, url };

    // Detect charset from Content-Type header or meta tag
    const contentType = res.headers.get('content-type') || '';
    const ctCharset = (contentType.match(/charset=([^\s;]+)/i) || [])[1];
    const buf = await res.arrayBuffer();
    const raw = Buffer.from(buf);

    // Try to detect charset from first 1KB of meta tags
    const head = raw.slice(0, 1024).toString('latin1');
    const metaCharset = (head.match(/<meta[^>]+charset=["']?([^\s;"'>]+)/i) || [])[1];
    const charset = (ctCharset || metaCharset || 'utf-8').toLowerCase().replace(/[-_]/g, '');

    let text;
    if (charset === 'windows1251' || charset === 'cp1251' || charset === 'win1251') {
      // Decode windows-1251 manually via latin1 → remap
      text = decodeWindows1251(raw);
    } else {
      text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    }

    return { html: text, url: res.url };
  } catch (e) {
    return { error: e.message, url };
  } finally {
    clearTimeout(timer);
  }
}

function decodeWindows1251(buf) {
  // Windows-1251 → Unicode mapping for Cyrillic range
  const map = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,1026,1027,8218,1107,8222,8230,8224,8225,8364,8240,1033,8249,1034,1036,1035,1039,1106,8216,8217,8220,8221,8226,8211,8212,8250,8482,1113,8250,1114,1116,1115,1119,160,1038,1118,1032,164,1168,166,167,1025,169,1028,171,172,173,174,1031,176,177,1030,1110,1169,181,182,183,1105,8470,1108,187,1112,1029,1109,1111,1040,1041,1042,1043,1044,1045,1046,1047,1048,1049,1050,1051,1052,1053,1054,1055,1056,1057,1058,1059,1060,1061,1062,1063,1064,1065,1066,1067,1068,1069,1070,1071,1072,1073,1074,1075,1076,1077,1078,1079,1080,1081,1082,1083,1084,1085,1086,1087,1088,1089,1090,1091,1092,1093,1094,1095,1096,1097,1098,1099,1100,1101,1102,1103];
  const chars = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    chars[i] = String.fromCodePoint(map[buf[i]] ?? buf[i]);
  }
  return chars.join('');
}

function extractLinks(html, base) {
  const links = [];
  const re = /href=["']([^"'#?][^"']*)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], base).toString();
      const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      links.push({ url: abs, text });
    } catch {}
  }
  return links;
}

function scoreLink(link, siteOrigin) {
  let score = 0;
  try { if (new URL(link.url).origin !== siteOrigin) return -1; } catch { return -1; }
  if (PARTICIPANT_LINK_RE.test(link.text)) score += 10;
  if (PARTICIPANT_PATH_RE.test(link.url)) score += 8;
  if (/list|catalog|каталог|справочник|directory/i.test(link.text + link.url)) score += 3;
  return score;
}

// ── HTML → company name list ──────────────────────────────────────────────────

function parseParticipantsFromHtml(html, sourceUrl = '') {
  // Remove scripts/styles
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const companies = [];

  // Strategy 1: look for structured company cards (common exhibition CMS patterns)
  // Patterns: <div class="*exhibitor*|*participant*|*company*|*member*">...NAME...</div>
  const cardRe = /class="[^"]*(?:exhibitor|participant|company|member|экспонент|участник|booth|stand)[^"]*"[^>]*>([\s\S]{0,400}?)<\/(?:div|li|article|section)>/gi;
  let cm;
  while ((cm = cardRe.exec(clean)) !== null) {
    const inner = cm[1];
    // Prefer anchor text (company name link) over full card text (which may include booth info)
    const anchorMatch = inner.match(/<a[^>]*>([\s\S]{0,120}?)<\/a>/i);
    const text = anchorMatch
      ? anchorMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const name = extractCompanyName(text);
    if (name) companies.push(name);
  }

  // Strategy 2: table rows — look for table with company-looking rows
  if (companies.length < 5) {
    const tableRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tm;
    while ((tm = tableRe.exec(clean)) !== null) {
      const cells = tm[1].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
      if (cells.length < 1 || cells.length > 8) continue;
      const firstCell = (cells[0] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const name = extractCompanyName(firstCell);
      if (name && name.length > 3) companies.push(name);
    }
  }

  // Strategy 3: list items — <li> in a container with participant-ish parent
  if (companies.length < 5) {
    const listRe = /<li[^>]*>([\s\S]{0,200}?)<\/li>/gi;
    let lm;
    while ((lm = listRe.exec(clean)) !== null) {
      const text = lm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const name = extractCompanyName(text);
      if (name && name.length > 3) companies.push(name);
    }
  }

  // Deduplicate and filter junk
  const seen = new Set();
  const result = [];
  for (const c of companies) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isJunk(c)) continue;
    result.push(c);
  }
  return result;
}

function extractCompanyName(raw) {
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  // Remove booth numbers, stand IDs at start: "A12 ", "123 ", "Зал 1 "
  const cleaned = text.replace(/^(?:[A-ZА-Я]?\d{1,4}[\s.\-]+|(?:зал|hall|stand|стенд|pavilion|павильон)\s+\S+\s+)/i, '').trim();

  if (!cleaned || cleaned.length < 3 || cleaned.length > 100) return null;
  return cleaned;
}

function isJunk(name) {
  // Filter navigation items, headers, etc.
  if (/^(?:главная|home|контакты|contact|о нас|about|новости|news|программ|schedule|регистрац|register|войти|login|выставка|exposition|exhibition|форум|conference|семинар|\d+)$/i.test(name.trim())) return true;
  if (name.split(' ').length > 10) return true; // too long to be a company name
  if (/^[A-ZА-ЯЁ\s,.-]+$/.test(name) && name.length < 3) return true;
  return false;
}

function toCSV(companies) {
  const header = 'Название компании';
  return [header, ...companies].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  tools: {

    expo_find_participants: {
      description: 'Найти страницу участников/экспонентов выставки и вернуть список компаний. ' +
        'Передай URL сайта выставки — скил сам найдёт страницу участников и вернёт CSV со списком.\n\n' +
        'Если сайт рендерится через JS и список не парсится автоматически:\n' +
        '1. Используй browser_session_navigate (скил Browser Session) чтобы открыть страницу участников\n' +
        '   — или Playwright инструменты если подключены\n' +
        '2. Либо WebFetch для получения HTML\n' +
        '3. Затем вызови expo_parse_participants(html) с полученным HTML\n\n' +
        'Результат (CSV) можно сразу передавать в inn_enrich_batch для обогащения.',
      inputSchema: {
        type: 'object',
        required: ['site_url'],
        properties: {
          site_url: { type: 'string', description: 'URL главной страницы выставки (или прямо страницы участников)' },
          max_companies: { type: 'number', description: 'Максимум компаний вернуть (default 500)' },
        },
      },
      handler: async ({ site_url, max_companies = 500 }) => {
        if (!site_url?.startsWith('http')) return { error: 'site_url должен начинаться с http' };

        let origin;
        try { origin = new URL(site_url).origin; } catch { return { error: 'Невалидный URL' }; }

        // Step 1: fetch the given URL
        const main = await fetchHtml(site_url);
        if (main.error) return { error: `Не удалось загрузить сайт: ${main.error}`, url: site_url };

        // Step 2: try parsing participants right from the given page
        let companies = parseParticipantsFromHtml(main.html, site_url);

        // Step 3: if too few — look for participants link on the page
        if (companies.length < 5) {
          const links = extractLinks(main.html, main.url);
          const scored = links
            .map(l => ({ ...l, score: scoreLink(l, origin) }))
            .filter(l => l.score > 0)
            .sort((a, b) => b.score - a.score);

          for (const link of scored.slice(0, 5)) {
            const sub = await fetchHtml(link.url);
            if (sub.error || !sub.html) continue;
            const found = parseParticipantsFromHtml(sub.html, link.url);
            if (found.length > companies.length) {
              companies = found;
              if (companies.length >= 10) break;
            }
          }
        }

        if (companies.length === 0) {
          return {
            warning: 'Компании не найдены автоматически. Вероятно, сайт рендерится через JS.',
            hint: 'Используй WebFetch чтобы получить HTML страницы участников, потом вызови expo_parse_participants(html).',
            site_url,
          };
        }

        const limited = companies.slice(0, max_companies);
        return {
          found: limited.length,
          total_on_page: companies.length,
          csv: toCSV(limited),
          companies: limited,
        };
      },
    },

    expo_parse_participants: {
      description: 'Распарсить HTML страницы участников выставки и вернуть список компаний в CSV. ' +
        'Используй когда expo_find_participants не справился (JS-сайт):\n' +
        '— получи HTML через WebFetch, browser_session_navigate, или Playwright\n' +
        '— передай HTML сюда\n' +
        'CSV-результат готов для inn_enrich_batch.',
      inputSchema: {
        type: 'object',
        required: ['html'],
        properties: {
          html: { type: 'string', description: 'HTML страницы со списком участников' },
          source_url: { type: 'string', description: 'URL откуда взят HTML (для контекста)' },
          max_companies: { type: 'number', description: 'Максимум компаний (default 500)' },
        },
      },
      handler: async ({ html, source_url = '', max_companies = 500 }) => {
        if (!html || html.length < 100) return { error: 'HTML слишком короткий или пустой' };

        const companies = parseParticipantsFromHtml(html, source_url);
        if (companies.length === 0) {
          return {
            warning: 'Компании не найдены в HTML. Возможно страница не та, или нужен другой селектор.',
            hint: 'Попробуй найти другой URL страницы участников или передай другой HTML.',
          };
        }

        const limited = companies.slice(0, max_companies);
        return {
          found: limited.length,
          csv: toCSV(limited),
          companies: limited,
        };
      },
    },

  },
};
