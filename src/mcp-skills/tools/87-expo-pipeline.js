'use strict';

const fs = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

function pipelineDir(workDir) {
  return path.join(workDir, 'expo-pipeline');
}

function expoDir(workDir, expoId) {
  return path.join(pipelineDir(workDir), expoId);
}

function criteriaPath(workDir) {
  return path.join(pipelineDir(workDir), 'criteria.json');
}

const DEFAULT_CRITERIA = {
  version: 1,
  revenue_min: null,
  revenue_max: null,
  employees_min: null,
  employees_max: null,
  okved_include: [],
  okved_exclude: [],
  regions_include: [],
  regions_exclude: [],
  must_have_inn: false,
  notes: '',
};

function readCriteria(workDir) {
  const file = criteriaPath(workDir);
  if (!fs.existsSync(file)) return { ...DEFAULT_CRITERIA };
  try { return { ...DEFAULT_CRITERIA, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { ...DEFAULT_CRITERIA }; }
}

function writeCriteria(workDir, criteria) {
  fs.mkdirSync(pipelineDir(workDir), { recursive: true });
  fs.writeFileSync(criteriaPath(workDir), JSON.stringify(criteria, null, 2));
}

function slugify(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .replace(/^www\./, '')
      .replace(/[^a-zA-Z0-9а-яёА-ЯЁ]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64)
      .toLowerCase();
  } catch {
    return url.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 64).toLowerCase();
  }
}

function rubles(n) {
  if (!n) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.0', '')} млрд`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} млн`;
  return `${n.toLocaleString('ru-RU')}`;
}

// Qualify a single company against criteria
function qualifies(company, criteria) {
  if (criteria.must_have_inn && !company.inn) return { pass: false, reason: 'нет ИНН' };

  const rev = company.revenue || company.выручка || 0;
  if (criteria.revenue_min && rev < criteria.revenue_min)
    return { pass: false, reason: `выручка ${rubles(rev)} < ${rubles(criteria.revenue_min)}` };
  if (criteria.revenue_max && rev > criteria.revenue_max)
    return { pass: false, reason: `выручка ${rubles(rev)} > ${rubles(criteria.revenue_max)}` };

  const emp = company.employees || company.сотрудники || 0;
  if (criteria.employees_min && emp < criteria.employees_min)
    return { pass: false, reason: `сотрудников ${emp} < ${criteria.employees_min}` };
  if (criteria.employees_max && emp > criteria.employees_max)
    return { pass: false, reason: `сотрудников ${emp} > ${criteria.employees_max}` };

  const okvedText = ((company.okved_code || '') + ' ' + (company.okved_name || '')).toLowerCase();
  if (criteria.okved_include?.length) {
    const hit = criteria.okved_include.some(kw => okvedText.includes(kw.toLowerCase()));
    if (!hit) return { pass: false, reason: `ОКВЭД не входит в список: ${criteria.okved_include.join(', ')}` };
  }
  if (criteria.okved_exclude?.length) {
    const hit = criteria.okved_exclude.some(kw => okvedText.includes(kw.toLowerCase()));
    if (hit) return { pass: false, reason: `ОКВЭД в стоп-списке` };
  }

  const region = (company.region || company.город || '').toLowerCase();
  if (criteria.regions_include?.length) {
    const hit = criteria.regions_include.some(r => region.includes(r.toLowerCase()));
    if (!hit) return { pass: false, reason: `регион "${region}" не в списке` };
  }
  if (criteria.regions_exclude?.length) {
    const hit = criteria.regions_exclude.some(r => region.includes(r.toLowerCase()));
    if (hit) return { pass: false, reason: `регион "${region}" в стоп-списке` };
  }

  return { pass: true };
}

function formatCriteriaText(criteria) {
  const lines = ['📋 Требования к целевым компаниям:\n'];
  if (criteria.revenue_min || criteria.revenue_max) {
    const from = criteria.revenue_min ? `от ${rubles(criteria.revenue_min)}` : '';
    const to   = criteria.revenue_max ? `до ${rubles(criteria.revenue_max)}` : '';
    lines.push(`💰 Выручка: ${[from, to].filter(Boolean).join(' ')}`);
  } else {
    lines.push('💰 Выручка: любая');
  }
  if (criteria.employees_min || criteria.employees_max) {
    const from = criteria.employees_min ? `от ${criteria.employees_min}` : '';
    const to   = criteria.employees_max ? `до ${criteria.employees_max}` : '';
    lines.push(`👥 Сотрудники: ${[from, to].filter(Boolean).join(' ')} чел.`);
  } else {
    lines.push('👥 Сотрудники: без ограничений');
  }
  if (criteria.okved_include?.length)
    lines.push(`🏭 ОКВЭД включить: ${criteria.okved_include.join(', ')}`);
  if (criteria.okved_exclude?.length)
    lines.push(`🚫 ОКВЭД исключить: ${criteria.okved_exclude.join(', ')}`);
  if (criteria.regions_include?.length)
    lines.push(`🌍 Регионы: ${criteria.regions_include.join(', ')}`);
  if (criteria.regions_exclude?.length)
    lines.push(`🚫 Регионы-исключения: ${criteria.regions_exclude.join(', ')}`);
  lines.push(`✅ ИНН обязателен: ${criteria.must_have_inn ? 'да' : 'нет'}`);
  if (criteria.notes) lines.push(`\n📝 ${criteria.notes}`);
  return lines.join('\n');
}

// ── Module ───────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    expo_pipeline_get_criteria: {
      description: `Get the current target company qualification criteria.
Returns both the raw criteria object and a human-readable text summary.
Criteria are stored per-user in expo-pipeline/criteria.json.
Call this before qualifying or to show the user their current settings.`,
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const workDir = ctx?.workDir || process.cwd();
        const criteria = readCriteria(workDir);
        return {
          criteria,
          summary: formatCriteriaText(criteria),
          file: criteriaPath(workDir),
        };
      },
    },

    expo_pipeline_set_criteria: {
      description: `Update target company qualification criteria (merged with current, not replaced).
Use when user says things like "убери порог по выручке", "поставь минимум 50 сотрудников",
"добавь машиностроение в ОКВЭД", "интересны только Москва и Питер".

Pass only the fields to change. To clear a filter, pass null (for numbers) or [] (for arrays).

Fields:
- revenue_min / revenue_max: number in RUB (e.g. 100000000 = 100M)
- employees_min / employees_max: headcount
- okved_include: array of OKVED codes or keywords (e.g. ["28.", "машиностроение"])
- okved_exclude: array of OKVED codes or keywords to block
- regions_include: region names (e.g. ["Москва", "Санкт-Петербург"])
- regions_exclude: regions to exclude
- must_have_inn: true/false — skip companies where INN not found
- notes: free-form text describing intent (used by LLM for context)`,
      inputSchema: {
        type: 'object',
        properties: {
          revenue_min:      { type: ['number', 'null'] },
          revenue_max:      { type: ['number', 'null'] },
          employees_min:    { type: ['number', 'null'] },
          employees_max:    { type: ['number', 'null'] },
          okved_include:    { type: 'array', items: { type: 'string' } },
          okved_exclude:    { type: 'array', items: { type: 'string' } },
          regions_include:  { type: 'array', items: { type: 'string' } },
          regions_exclude:  { type: 'array', items: { type: 'string' } },
          must_have_inn:    { type: 'boolean' },
          notes:            { type: 'string' },
        },
      },
      handler: async (updates, ctx) => {
        const workDir = ctx?.workDir || process.cwd();
        const current = readCriteria(workDir);
        const merged = { ...current, ...updates, version: (current.version || 1), updated_at: new Date().toISOString() };
        writeCriteria(workDir, merged);
        return {
          ok: true,
          criteria: merged,
          summary: formatCriteriaText(merged),
          message: 'Критерии обновлены. Запусти expo_pipeline_qualify чтобы пересчитать целевых.',
        };
      },
    },

    expo_pipeline_qualify: {
      description: `Apply the current target criteria to an enriched companies list and produce targets.json.

Reads: {workDir}/expo-pipeline/{expo_id}/enriched.json (output of inn_enrich_batch)
Writes: {workDir}/expo-pipeline/{expo_id}/targets.json

Returns summary: total companies, qualified count, rejection reasons breakdown.
Run after inn_enrich_batch completes. Re-run any time criteria change — it's instant.

expo_id: the slug shown by expo_pipeline_status, or derive from expo URL with slugify.`,
      inputSchema: {
        type: 'object',
        required: ['expo_id'],
        properties: {
          expo_id: {
            type: 'string',
            description: 'Pipeline ID (shown by expo_pipeline_status, or pass the expo URL to auto-slug)',
          },
          criteria_override: {
            type: 'object',
            description: 'Optional one-off criteria override (not saved). Useful for "what if" scenarios.',
          },
        },
      },
      handler: async ({ expo_id, criteria_override }, ctx) => {
        const workDir = ctx?.workDir || process.cwd();

        // Accept raw URL as expo_id
        const id = expo_id.startsWith('http') ? slugify(expo_id) : expo_id;
        const dir = expoDir(workDir, id);
        // Support both filenames: enriched.json (new) and requisites_enrichment.json (legacy)
        const enrichedPath = fs.existsSync(path.join(dir, 'enriched.json'))
          ? path.join(dir, 'enriched.json')
          : path.join(dir, 'requisites_enrichment.json');

        if (!fs.existsSync(enrichedPath)) {
          return {
            error: `enriched.json not found at ${path.join(dir, 'enriched.json')}`,
            hint: 'Run inn_enrich_batch first with out_dir pointing to the expo pipeline directory.',
            expo_id: id,
          };
        }

        let enriched;
        try { enriched = JSON.parse(fs.readFileSync(enrichedPath, 'utf8')); }
        catch (e) { return { error: `Failed to parse ${path.basename(enrichedPath)}: ${e.message}` }; }

        // Normalize: inn_enrich_batch outputs { companies: [...] } or plain array
        const companies = Array.isArray(enriched) ? enriched
          : enriched.companies || enriched.results || [];

        const criteria = { ...readCriteria(workDir), ...(criteria_override || {}) };
        const targets = [];
        const rejected = [];
        const rejectionReasons = {};

        for (const company of companies) {
          const result = qualifies(company, criteria);
          if (result.pass) {
            targets.push(company);
          } else {
            rejected.push({ ...company, _reject_reason: result.reason });
            const key = result.reason.split(' ')[0]; // first word as bucket
            rejectionReasons[result.reason] = (rejectionReasons[result.reason] || 0) + 1;
          }
        }

        // Write targets
        fs.mkdirSync(dir, { recursive: true });
        const targetsPath = path.join(dir, 'targets.json');
        fs.writeFileSync(targetsPath, JSON.stringify(targets, null, 2));

        // Update pipeline status
        const pipelinePath = path.join(dir, 'pipeline.json');
        let pipeline = {};
        try { pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf8')); } catch {}
        pipeline.steps = pipeline.steps || {};
        pipeline.steps.qualify = { done: true, targets: targets.length, rejected: rejected.length, at: new Date().toISOString() };
        fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));

        // Top rejection reasons
        const topReasons = Object.entries(rejectionReasons)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([reason, count]) => `  • ${count}x ${reason}`);

        return {
          expo_id: id,
          total: companies.length,
          qualified: targets.length,
          rejected: rejected.length,
          targets_file: targetsPath,
          top_rejection_reasons: topReasons,
          summary: [
            `✅ Целевых: ${targets.length} из ${companies.length}`,
            `❌ Отсеяно: ${rejected.length}`,
            topReasons.length ? `\nТоп причин отсева:\n${topReasons.join('\n')}` : '',
          ].filter(Boolean).join('\n'),
          criteria_applied: criteria,
        };
      },
    },

    expo_pipeline_status: {
      description: `Show the status of all expo pipelines (or one specific expo_id).
Lists each pipeline directory with counts: companies collected, enriched, targets qualified.
Use to check progress and find expo_ids for qualify/targets commands.`,
      inputSchema: {
        type: 'object',
        properties: {
          expo_id: { type: 'string', description: 'Optional: show status for one pipeline only' },
        },
      },
      handler: async ({ expo_id } = {}, ctx) => {
        const workDir = ctx?.workDir || process.cwd();
        const baseDir = pipelineDir(workDir);

        if (!fs.existsSync(baseDir)) {
          return { pipelines: [], message: 'Нет активных pipeline. Запусти expo_find_participants для начала.' };
        }

        function readPipelineStatus(id) {
          const dir = expoDir(workDir, id);
          const pipelinePath = path.join(dir, 'pipeline.json');
          let meta = {};
          try { meta = JSON.parse(fs.readFileSync(pipelinePath, 'utf8')); } catch {}

          const companiesFile = path.join(dir, 'companies.json');
          const enrichedFile  = path.join(dir, 'enriched.json');
          const targetsFile   = path.join(dir, 'targets.json');

          function countFile(f, key) {
            if (!fs.existsSync(f)) return null;
            try {
              const data = JSON.parse(fs.readFileSync(f, 'utf8'));
              const arr = Array.isArray(data) ? data : (data[key] || data.companies || data.results || []);
              return arr.length;
            } catch { return '?'; }
          }

          return {
            expo_id: id,
            source_url: meta.source_url || null,
            companies:  countFile(companiesFile, 'companies'),
            enriched:   countFile(enrichedFile, 'companies'),
            targets:    countFile(targetsFile, 'companies'),
            steps:      meta.steps || {},
          };
        }

        if (expo_id) {
          const id = expo_id.startsWith('http') ? slugify(expo_id) : expo_id;
          return readPipelineStatus(id);
        }

        // List all pipelines
        const entries = fs.readdirSync(baseDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => readPipelineStatus(e.name));

        if (entries.length === 0) {
          return { pipelines: [], message: 'Нет pipeline директорий.' };
        }

        const lines = entries.map(p => {
          const parts = [`📁 ${p.expo_id}`];
          if (p.source_url) parts.push(`   URL: ${p.source_url}`);
          parts.push(`   📋 Компаний: ${p.companies ?? '—'} | 🔍 Обогащено: ${p.enriched ?? '—'} | ✅ Целевых: ${p.targets ?? '—'}`);
          return parts.join('\n');
        });

        return {
          pipelines: entries,
          summary: lines.join('\n\n'),
        };
      },
    },

  },
};

// Export formatCriteriaText and readCriteria for quick-answer use in runner.js
module.exports.formatCriteriaText = formatCriteriaText;
module.exports.readCriteria = readCriteria;
module.exports.DEFAULT_CRITERIA = DEFAULT_CRITERIA;
