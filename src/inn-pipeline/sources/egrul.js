'use strict';

// ЕГРЮЛ ФНС — director lookup by INN
// MUST serialize all requests through a single mutex (see spec)

let _lock = Promise.resolve();
const DELAY_PRE = 450;
const DELAY_JITTER = 150;
const DELAY_GET = 350;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function serialFetch(fn) {
  const result = _lock.then(fn);
  _lock = result.catch(() => {});
  return result;
}

async function egrulLookup(inn, cache) {
  if (!inn) return null;
  const cached = cache.get('egrul', inn);
  if (cached !== null) return cached;

  return serialFetch(async () => {
    await sleep(DELAY_PRE + Math.random() * DELAY_JITTER);

    const formData = new URLSearchParams({
      vyp3CaptchaToken: '',
      page: '',
      query: inn,
      region: '',
      PreventChromeAutocomplete: '',
    });

    let token;
    try {
      const res = await fetch('https://egrul.nalog.ru/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://egrul.nalog.ru/index.html',
          'User-Agent': 'Mozilla/5.0',
        },
        body: formData.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) { cache.set('egrul', inn, null); return null; }
      const data = await res.json();
      token = data.t;
    } catch { return null; }

    if (!token) { cache.set('egrul', inn, null); return null; }

    await sleep(DELAY_GET);
    try {
      const res2 = await fetch(`https://egrul.nalog.ru/search-result/${token}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res2.ok) { cache.set('egrul', inn, null); return null; }
      const data2 = await res2.json();
      const rows = data2.rows ?? [];
      if (!rows.length) { cache.set('egrul', inn, null); return null; }

      const row = rows[0];
      // g field: "Генеральный директор: Иванов Иван Иванович"
      let director_name = null;
      let director_position = null;
      if (row.g) {
        const m = row.g.match(/^(.+?):\s*(.+)$/);
        if (m) { director_position = m[1].trim(); director_name = m[2].trim(); }
        else director_name = row.g.trim();
      }

      const result = {
        inn: row.i || inn,
        ogrn: row.o || null,
        legal: row.n || null,
        director_name,
        director_position,
      };
      cache.set('egrul', inn, result);
      return result;
    } catch { return null; }
  });
}

module.exports = { egrulLookup };
