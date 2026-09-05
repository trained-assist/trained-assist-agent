'use strict';

// Scrape company website pages to find INN and logo

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

function resolveUrl(href, base) {
  if (!href || href.startsWith('data:')) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

function extractLogoUrl(html, baseUrl) {
  // og:image (content before or after property attr)
  const ogA = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const ogB = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const ogHref = (ogA || ogB)?.[1];
  if (ogHref) return resolveUrl(ogHref, baseUrl);

  // <link rel="icon"> / rel="shortcut icon"
  const icA = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i);
  const icB = html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i);
  const icHref = (icA || icB)?.[1];
  if (icHref) return resolveUrl(icHref, baseUrl);

  return null;
}

function normalizeBase(website) {
  if (!website) return null;
  let url = website.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

/**
 * Try to find INN and logo on the company's website by checking common pages.
 * Returns { inn: string|null, logo_url: string|null }.
 */
async function findInnOnSite(website, cache) {
  const base = normalizeBase(website);
  if (!base) return { inn: null, logo_url: null };

  let logo_url = null;

  // fetch pages with light parallelism (4 at a time)
  const BATCH = 4;
  for (let i = 0; i < PAGES.length; i += BATCH) {
    const batch = PAGES.slice(i, i + BATCH);
    const htmlPages = await Promise.all(batch.map(p => fetchPage(base + p, cache)));

    // extract logo from homepage (first page, path "/")
    if (i === 0 && htmlPages[0]) {
      logo_url = extractLogoUrl(htmlPages[0], base);
    }

    for (const html of htmlPages) {
      const inn = extractInn(html);
      if (inn) return { inn, logo_url };
    }
  }
  return { inn: null, logo_url };
}

module.exports = { findInnOnSite };
