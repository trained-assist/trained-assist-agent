'use strict';

// Scrape company website pages to find INN

const PAGES = ['/', '/contacts/', '/contact/', '/kontakty/', '/rekvizity/',
                '/requisites/', '/company/contacts/', '/about/contacts/', '/about/'];
const INN_LABELED = /(?:ИНН|inn)\D{0,45}(\d{10}|\d{12})/i;
const INN_ANY     = /\b(\d{10}|\d{12})\b/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function decodeContent(buf) {
  // try utf-8 first, fallback to windows-1251
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return text;
  } catch {
    try { return new TextDecoder('windows-1251').decode(buf); } catch { return ''; }
  }
}

async function fetchPage(url, cache) {
  const cached = cache.get('site_pages', url);
  if (cached !== null) return cached;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(7_000),
    });
    if (!res.ok) { cache.set('site_pages', url, ''); return ''; }

    const buf = await res.arrayBuffer();
    const text = decodeContent(new Uint8Array(buf)).slice(0, 700_000);
    cache.set('site_pages', url, text);
    return text;
  } catch {
    cache.set('site_pages', url, '');
    return '';
  }
}

function extractInn(html) {
  const labeled = html.match(INN_LABELED);
  if (labeled) return labeled[1];
  // fallback: any 10/12 digit sequence (less reliable)
  const any = html.match(INN_ANY);
  return any ? any[1] : null;
}

function normalizeBase(website) {
  if (!website) return null;
  let url = website.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

/**
 * Try to find INN on the company's website by checking common pages.
 * Returns INN string or null.
 */
async function findInnOnSite(website, cache) {
  const base = normalizeBase(website);
  if (!base) return null;

  // fetch pages with light parallelism (4 at a time)
  const BATCH = 4;
  for (let i = 0; i < PAGES.length; i += BATCH) {
    const batch = PAGES.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(p => fetchPage(base + p, cache)));
    for (const html of results) {
      const inn = extractInn(html);
      if (inn) return inn;
    }
  }
  return null;
}

module.exports = { findInnOnSite };
