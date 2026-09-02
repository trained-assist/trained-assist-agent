'use strict';

// Flexi-specific exhibition tools
//
// expo_classify_targets  — classify a list of companies as target/near-target/not-target
//                          using Flexi's criteria (Russian manufacturer + revenue range)
// expo_generate_ex_array — turn classified+enriched companies into EX array JSON
//                          ready to drop into the HTML catalog template

// ── Revenue classification ────────────────────────────────────────────────────

// Returns 'target' | 'near' | 'not'
// rev and prof in millions RUB (as stored in EX array)
function classifyRevenue(rev, prof) {
  if (rev == null) return 'near';          // unknown revenue → near-target
  if (rev < 150) return 'near';            // below minimum threshold
  if (rev <= 1000) return 'target';        // 150–1000 млн, any profit
  if (rev <= 5000) {
    if (prof == null || prof <= 100) return 'target'; // 1–5 млрд, low/unknown profit (Skolkovo)
    return 'near';                         // 1–5 млрд but high profit → near
  }
  return 'near';                           // >5 млрд, too large
}

// ── OKVED classification ──────────────────────────────────────────────────────

const PRODUCTION_OKVED = ['13.', '14.'];    // textile + garment manufacturing
const TRADE_OKVED      = ['46.', '47.', '52.', '73.', '74.', '63.', '68.'];

function okvedIsProduction(okved) {
  if (!okved) return null;  // unknown
  if (PRODUCTION_OKVED.some(p => okved.startsWith(p))) return true;
  if (TRADE_OKVED.some(p => okved.startsWith(p))) return false;
  return null;  // unclear
}

// ── Name heuristics ───────────────────────────────────────────────────────────

const DISTRIBUTOR_WORDS = ['ДИСТРИБЬЮТОР', 'ДИСТРИБУТОР', 'ИМПОРТ', 'ТОРГОВЫЙ ДОМ', ' ТД ', 'АГЕНТ '];
const FOREIGN_HINTS = ['БЕЛАРУСЬ', 'КАЗАХСТАН', 'УКРАИНА', 'РБ '];

function nameIsDistributor(name) {
  const up = (name || '').toUpperCase();
  return DISTRIBUTOR_WORDS.some(w => up.includes(w));
}

function nameIsForeign(name) {
  const up = (name || '').toUpperCase();
  return FOREIGN_HINTS.some(w => up.includes(w));
}

// ── Main classify function ────────────────────────────────────────────────────

function classifyCompany(c) {
  // Step 1: country filter
  const country = (c.country || '').trim();
  const ru = c.ru === 1 || c.ru === true || country === 'Россия' || !country;
  if (!ru || nameIsForeign(c.name)) {
    return { t: 0, nt: 0, reason: `не РФ (${country || 'неизвестно'})` };
  }

  // Step 2: production check via OKVED
  const okvedResult = okvedIsProduction(c.okved);
  if (okvedResult === false) {
    return { t: 0, nt: 0, reason: `ОКВЭД ${c.okved} = торговля/услуги` };
  }

  // Step 3: distributor name check
  if (nameIsDistributor(c.name)) {
    return { t: 0, nt: 0, reason: 'дистрибьютор по названию' };
  }

  // Step 4: NO INN = NO t:1 (cannot verify revenue without confirmed INN)
  if (!c.inn) {
    return { t: 0, nt: 1, reason: 'нет ИНН — нельзя подтвердить выручку → почти целевая' };
  }

  // Step 5: revenue classification (only for confirmed/likely producers with INN)
  const revClass = classifyRevenue(c.rev, c.prof);
  const okvedNote = okvedResult === true ? `ОКВЭД ${c.okved}` : 'ОКВЭД неизвестен';

  if (revClass === 'target') {
    return { t: 1, nt: 0, reason: `производитель РФ, ${okvedNote}, выручка ${c.rev} млн` };
  }

  if (revClass === 'near') {
    const why = c.rev == null ? 'выручка неизвестна' :
                c.rev < 150  ? `выручка ${c.rev} млн < 150 млн` :
                c.rev > 5000 ? `выручка ${c.rev} млн > 5 млрд` :
                               `выручка ${c.rev} млн, прибыль ${c.prof} млн > 100 млн`;
    return { t: 0, nt: 1, reason: `производитель РФ, ${okvedNote}, ${why}` };
  }

  return { t: 0, nt: 0, reason: 'не попало в критерии' };
}

// ── EX array generation ───────────────────────────────────────────────────────

function toExEntry(c, idx, prefix) {
  const cls = classifyCompany(c);
  return {
    id: c.id || `${prefix}${String(idx + 1).padStart(3, '0')}`,
    n: c.name || c.n || '',
    s: c.stand || c.s || '',
    t: cls.t,
    nt: cls.nt,
    b: c.b || c.description || '',
    inn: c.inn || null,
    ogrn: c.ogrn || null,   // CRITICAL: needed for checko.ru/company/{ogrn} URL (not INN)
    w: c.w || c.website || null,
    e: c.e || c.email || null,
    p: c.p || c.phone || null,
    href: c.href || null,
    ru: (c.ru === 1 || c.ru === true || (c.country || '') === 'Россия' || !(c.country)) ? 1 : 0,
    rev: c.rev || null,
    ry: c.ry || c.rev_year || null,
    prof: c.prof || null,
    py: c.py || c.prof_year || null,
    dir: c.dir || null,
    dirpos: c.dirpos || null,
    // extra fields for lingerie-style exhibitions
    ...(c.country && c.country !== 'Россия' ? { country: c.country } : {}),
    ...(c.cat ? { cat: c.cat } : {}),
    ...(c.seg ? { seg: c.seg } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    expo_classify_targets: {
      description:
        'Классифицировать список компаний выставки как ЦЕЛЕВАЯ / ПОЧТИ ЦЕЛЕВАЯ / не целевая.\n\n' +
        'Критерии Flexi:\n' +
        '• Целевая (t:1): производитель РФ (ОКВЭД 13.x/14.x) + выручка 150–1000 млн (любая прибыль) или 1–5 млрд (прибыль ≤100 млн)\n' +
        '• Почти целевая (nt:1): производитель РФ + выручка неизвестна, или <150 млн, или >5 млрд (прибыль >100 млн)\n' +
        '• Не целевая: дистрибьютор, торговля (ОКВЭД 46.x+), иностранная компания\n\n' +
        'Входные данные: массив компаний. Каждая компания: {name, inn?, okved?, rev?, prof?, country?, ru?, stand?}\n' +
        'rev и prof в млн руб.',
      inputSchema: {
        type: 'object',
        required: ['companies'],
        properties: {
          companies: {
            type: 'array',
            description: 'Массив компаний для классификации',
            items: {
              type: 'object',
              properties: {
                name:    { type: 'string' },
                inn:     { type: 'string' },
                okved:   { type: 'string', description: 'Код ОКВЭД, например 14.14' },
                rev:     { type: 'number', description: 'Выручка в млн руб' },
                prof:    { type: 'number', description: 'Прибыль в млн руб' },
                country: { type: 'string', description: 'Страна, например Россия' },
                ru:      { type: 'number', description: '1=Россия, 0=другая страна' },
                stand:   { type: 'string' },
              },
            },
          },
        },
      },
      handler: async ({ companies }) => {
        if (!Array.isArray(companies)) return { error: 'companies должен быть массивом' };

        const results = companies.map((c, i) => {
          const cls = classifyCompany(c);
          return { ...c, ...cls, _idx: i };
        });

        const targets  = results.filter(c => c.t === 1);
        const near     = results.filter(c => c.nt === 1);
        const rejected = results.filter(c => c.t === 0 && c.nt === 0);

        return {
          total: companies.length,
          targets: targets.length,
          near_targets: near.length,
          not_targets: rejected.length,
          companies: results.map(c => ({
            name: c.name || c.n,
            inn: c.inn,
            okved: c.okved,
            rev: c.rev,
            prof: c.prof,
            country: c.country,
            t: c.t,
            nt: c.nt,
            reason: c.reason,
          })),
          targets_list:  targets.map(c => `${c.name} — ${c.reason}`),
          near_list:     near.map(c => `${c.name} — ${c.reason}`),
        };
      },
    },

    expo_generate_ex_array: {
      description:
        'Сгенерировать EX-массив для HTML-каталога выставки из списка обогащённых компаний.\n\n' +
        'EX-массив — это JS-переменная в index.html каждого сайта каталога. ' +
        'Инструмент применяет классификацию целевых (expo_classify_targets) и форматирует данные.\n\n' +
        'Результат: JSON-строка готова для вставки в шаблон HTML между `EX = ` и `;`.\n\n' +
        'ВАЖНО: после вставки проверь что в HTML стоит `];` а не `]];`.',
      inputSchema: {
        type: 'object',
        required: ['companies'],
        properties: {
          companies: {
            type: 'array',
            description: 'Массив обогащённых компаний (после inn_enrich_batch + финансы)',
            items: { type: 'object' },
          },
          id_prefix: {
            type: 'string',
            description: 'Префикс для генерации ID, если у компании нет id (напр. LNG, CPM, OL)',
            default: 'EX',
          },
          sort_by_stand: {
            type: 'boolean',
            description: 'Сортировать по номеру стенда (default: true)',
            default: true,
          },
        },
      },
      handler: async ({ companies, id_prefix = 'EX', sort_by_stand = true }) => {
        if (!Array.isArray(companies)) return { error: 'companies должен быть массивом' };

        let entries = companies.map((c, i) => toExEntry(c, i, id_prefix));

        if (sort_by_stand) {
          entries.sort((a, b) => {
            const sa = String(a.s || ''), sb = String(b.s || '');
            return sa.localeCompare(sb, 'ru', { numeric: true });
          });
        }

        const targets  = entries.filter(e => e.t === 1);
        const near     = entries.filter(e => e.nt === 1);
        const withRev  = entries.filter(e => e.rev != null);
        const withInn  = entries.filter(e => e.inn != null);

        const json = JSON.stringify(entries, null, 0);

        return {
          total: entries.length,
          targets: targets.length,
          near_targets: near.length,
          with_inn: withInn.length,
          with_revenue: withRev.length,
          ex_json: json,
          targets_preview: targets.slice(0, 10).map(e => `${e.n} (${e.inn || 'нет ИНН'}, ${e.rev != null ? e.rev + ' млн' : 'выручка ?'})`),
          note: 'Вставить в HTML: EX = ' + json.slice(0, 40) + '...;   Проверить: не должно быть ]]; в конце',
        };
      },
    },

    expo_check_target_revenue: {
      description:
        'Проверить одну компанию по критериям выручки Flexi. ' +
        'Возвращает статус и объяснение. Удобно для ручной проверки конкретной компании.',
      inputSchema: {
        type: 'object',
        required: ['rev'],
        properties: {
          name: { type: 'string' },
          rev:  { type: 'number', description: 'Выручка млн руб (null если неизвестна)' },
          prof: { type: 'number', description: 'Прибыль млн руб (null если неизвестна)' },
          okved: { type: 'string' },
          country: { type: 'string', default: 'Россия' },
        },
      },
      handler: async ({ name, rev, prof, okved, country = 'Россия' }) => {
        const c = { name: name || '?', rev, prof, okved, country, ru: country === 'Россия' ? 1 : 0 };
        const cls = classifyCompany(c);
        const revClass = rev != null ? classifyRevenue(rev, prof) : 'near';
        return {
          name: c.name,
          status: cls.t ? 'ЦЕЛЕВАЯ' : cls.nt ? 'ПОЧТИ ЦЕЛЕВАЯ' : 'не целевая',
          t: cls.t,
          nt: cls.nt,
          reason: cls.reason,
          revenue_check: {
            rev_mlns: rev,
            prof_mlns: prof,
            result: revClass,
            criteria: rev == null ? 'выручка неизвестна → почти целевая' :
              rev < 150    ? `${rev} < 150 млн → ниже порога` :
              rev <= 1000  ? `150 ≤ ${rev} ≤ 1000 млн → в диапазоне` :
              rev <= 5000  ? `1000 < ${rev} ≤ 5000 млн, прибыль ${prof ?? '?'} ${prof != null && prof <= 100 ? '≤' : '>'} 100 млн` :
                             `${rev} > 5000 млн → выше потолка`,
          },
        };
      },
    },

  },
};
