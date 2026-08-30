'use strict';

// Generate query variants for a company in priority order
// Stops at first high-confidence match (caller's responsibility)

function stripOpf(name) {
  return name
    .replace(/\b(ООО|ОАО|ЗАО|АО|ПАО|ИП|ГК|ГУП|МУП|НКО|АНО|НАО)\b/gi, '')
    .replace(/["«»'']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function domainWords(url) {
  if (!url) return null;
  const m = url.match(/(?:https?:\/\/)?(?:www\.)?([^/]+)/);
  if (!m) return null;
  const host = m[1].replace(/\.(ru|com|рф|net|org|biz|info|online)$/, '');
  return host.replace(/[^а-яёa-z0-9]/gi, ' ').trim();
}

function emailDomain(email) {
  if (!email) return null;
  const m = email.match(/@([^.]+)/);
  if (!m) return null;
  return m[1].replace(/[^а-яёa-z0-9]/gi, ' ').trim();
}

function firstNWords(name, n) {
  const words = name.split(/\s+/);
  return words.slice(0, n).join(' ');
}

/**
 * Returns ordered array of {query, label} objects.
 * site_inn / verified_inn go first if present (caller should handle them separately).
 */
function queryVariants(company) {
  const { name = '', city = '', website = '', email = '' } = company;
  const variants = [];

  const nameClean = stripOpf(name);
  const nameNoQuotes = name.replace(/["«»''()]/g, '').replace(/\s+/g, ' ').trim();

  if (city) variants.push({ query: `${nameClean} ${city}`, label: 'name+city' });
  variants.push({ query: nameClean, label: 'name_no_opf' });
  if (nameNoQuotes !== nameClean) variants.push({ query: nameNoQuotes, label: 'name_no_quotes' });
  if (name.split(/\s+/).length > 2) variants.push({ query: firstNWords(nameClean, 2), label: 'name_2words' });

  const domain = domainWords(website);
  if (domain) variants.push({ query: domain, label: 'domain' });

  const edomain = emailDomain(email);
  if (edomain && edomain !== domain) variants.push({ query: edomain, label: 'email_domain' });

  // deduplicate while preserving order
  const seen = new Set();
  return variants.filter(v => {
    const k = v.query.toLowerCase();
    if (seen.has(k) || !k) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { queryVariants, stripOpf, domainWords, emailDomain };
