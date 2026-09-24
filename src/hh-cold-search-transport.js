'use strict';

// An absent geography is an error: silently widening a search is as misleading
// as silently restricting it to Moscow. null/[] explicitly means unrestricted.
function resolveSearchAreas(config, vacancy, options = {}) {
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
  let value;
  if (has(options, 'area')) value = options.area;
  else if (has(config?.filters, 'area')) value = config.filters.area;
  else if (has(config, 'area')) value = config.area;
  else if (has(vacancy, 'area')) value = vacancy.area;
  else throw new Error('Не задана география поиска. Укажи регион вакансии или area:null для поиска без ограничения.');
  if (value === null) return [];
  const areas = (Array.isArray(value) ? value : [value]).map(v => String(v?.id ?? v));
  if (areas.some(v => !/^\d+$/.test(v))) throw new Error('География поиска должна содержать ID региона HH.');
  return [...new Set(areas)];
}

async function searchResumes(query, token, username, options = {}) {
  const params = new URLSearchParams({ text: query, page: '0', per_page: '50', order_by: 'relevance' });
  for (const area of options.areas || []) params.append('area', area);
  if (options.relocation) {
    if (!['living', 'living_or_relocation'].includes(options.relocation)) throw new Error('Invalid relocation');
    params.set('relocation', options.relocation);
  }
  const base = process.env.HH_API_BASE_URL || 'https://api.hh.ru';
  const agent = `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let refreshed = false;
  let retries = 0;
  for (;;) {
    try {
      const res = await fetch(`${base}/resumes?${params}`, {
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': agent, 'HH-User-Agent': agent },
      });
      if ((res.status === 401 || res.status === 403) && !refreshed && options.refreshAccessToken) {
        refreshed = true;
        const fresh = await options.refreshAccessToken(username);
        if (fresh) { token.access_token = fresh; continue; }
      }
      if (!res.ok) {
        const error = new Error(`HH resumes ${res.status}`);
        error.status = res.status;
        error.retryable = res.status === 429 || res.status >= 500;
        throw error;
      }
      const data = await res.json();
      if (!Array.isArray(data.items)) throw new Error('HH resumes: invalid items payload');
      return data;
    } catch (error) {
      const transient = error.retryable || error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError;
      if (!transient || retries >= 2) throw error;
      await sleep(500 * 2 ** retries++);
    }
  }
}

module.exports = { resolveSearchAreas, searchResumes };
