'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { enrich } = require('../../inn-pipeline/index');

const USER_ID = process.env.USER_ID || '';

const CREDENTIAL_KEYS = ['dadataToken', 'dadataSecret', 'checkoKey', 'rusprofileCookie'];

function userConfigPath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'inn', 'config.json');
}

function readRawConfig(userId) {
  const file = userConfigPath(userId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Platform credentials from env vars (set via secrets.env / GCP Secret Manager)
function platformConfig() {
  return {
    dadataToken:      process.env.INN_DADATA_TOKEN   || null,
    dadataSecret:     process.env.INN_DADATA_SECRET  || null,
    checkoKey:        process.env.INN_CHECKO_KEY      || null,
    rusprofileCookie: process.env.INN_RUSPROFILE_COOKIE || null,
  };
}

// Merge: user overrides platform. Track source per key.
function readConfig(userId) {
  const platform = platformConfig();
  const user = readRawConfig(userId);
  const _sources = {};
  for (const k of CREDENTIAL_KEYS) {
    if (user[k])          _sources[k] = 'user';
    else if (platform[k]) _sources[k] = 'platform';
  }
  return { ...platform, ...user, _sources };
}

function writeConfig(userId, patch) {
  const file = userConfigPath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readRawConfig(userId);
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
}

module.exports = {
  tools: {

    inn_status: {
      description: 'Show INN enrichment skill status: which API keys are configured, cache location, and a brief description of data sources.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const src = cfg._sources || {};
        function credStatus(key, freeDefault) {
          if (cfg[key]) return { status: 'configured', origin: src[key] || 'user' };
          return { status: freeDefault ? 'ready' : 'not_configured' };
        }
        return {
          sources: {
            bfo_nalog:  { status: 'ready',  note: 'Free, no auth. Main source.' },
            egrul:      { status: 'ready',  note: 'Free, no auth. Director lookup.' },
            dadata:     { ...credStatus('dadataToken'), note: 'Paid. Faster fallback.' },
            checko:     { ...credStatus('checkoKey'),  note: 'Paid. Financial data.' },
            rusprofile: { ...credStatus('rusprofileCookie', true), note: 'Free scraping. Set cookie if blocked.' },
          },
          cache_dir: path.join(process.cwd(), '.inn-cache'),
        };
      },
    },

    inn_set_dadata_token: {
      description: 'Save DaData API credentials for INN enrichment. Get them at dadata.ru → Profile → API keys.',
      inputSchema: {
        type: 'object',
        required: ['token', 'secret'],
        properties: {
          token:  { type: 'string', description: 'DaData API token (Authorization: Token ...)' },
          secret: { type: 'string', description: 'DaData secret key (X-Secret header)' },
        },
      },
      handler: async ({ token, secret }, ctx) => {
        writeConfig(ctx?.userId, { dadataToken: token, dadataSecret: secret });
        return { ok: true, message: 'DaData credentials saved.' };
      },
    },

    inn_set_checko_key: {
      description: 'Save Checko API key for financial data (revenue, profit by INN). Get it at checko.ru.',
      inputSchema: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string', description: 'Checko API key' } },
      },
      handler: async ({ key }, ctx) => {
        writeConfig(ctx?.userId, { checkoKey: key });
        return { ok: true, message: 'Checko API key saved.' };
      },
    },

    inn_set_rusprofile_cookie: {
      description: 'Save Rusprofile session cookie (needed if rusprofile starts masking data with ░ symbols). Get from browser DevTools → Application → Cookies → rusprofile.ru.',
      inputSchema: {
        type: 'object',
        required: ['cookie'],
        properties: { cookie: { type: 'string', description: 'Raw Cookie header value from browser' } },
      },
      handler: async ({ cookie }, ctx) => {
        writeConfig(ctx?.userId, { rusprofileCookie: cookie });
        return { ok: true, message: 'Rusprofile cookie saved.' };
      },
    },

    inn_enrich_batch: {
      description: `Enrich a list of Russian companies with INN, OGRN, director, revenue, and profit.
Sources (in priority order): BFO ФНС (free), company websites, DaData, ЕГРЮЛ, Checko.
Input: EITHER a path to exhibitors.json OR inline companies array.
Output: writes enriched.json (and requisites_enrichment.json alias) + requisites_report.json to out_dir.

BATCH MODE (default): processes batch_size companies at a time, saves after each batch.
Safe to run multiple times — already-enriched companies are skipped (resume=true by default).
For 300 companies run in batches of 20: call repeatedly, each call takes ~2 min, saves progress.

Progress is always written to disk after each batch — a timeout never loses more than one batch.

NOTE: Works well for Russian legal entity names. Brand names (Latin, foreign) → poor match rate.`,
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Path to exhibitors.json (array of {id, name, ...}). Use this OR companies.',
          },
          companies: {
            type: 'array',
            items: { type: 'object' },
            description: 'Inline array of {id, name, city?, website?}.',
          },
          out_dir: {
            type: 'string',
            description: 'Directory for output files (default: input file dir, or cwd for inline companies).',
          },
          batch_size: {
            type: 'number',
            description: 'Companies per batch before saving checkpoint (default: 20, min: 1, max: 50).',
          },
          resume: {
            type: 'boolean',
            description: 'Skip already-enriched companies from a previous run (default: true). Set false to re-enrich all.',
          },
          workers: {
            type: 'number',
            description: 'Parallel workers within a batch (default: 5, max: 10)',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Limit to specific sources: ["bfo","dadata","egrul","checko","site"]. Default: all.',
          },
        },
      },
      handler: async ({ file, companies, out_dir, batch_size = 20, resume = true, workers = 5, sources }, ctx) => {
        let exhibitors;
        let outDir;

        if (companies && Array.isArray(companies) && companies.length > 0) {
          exhibitors = companies.map((c, i) => ({ id: c.id ?? i + 1, name: c.name ?? c, ...c }));
          outDir = out_dir ? path.resolve(out_dir) : process.cwd();
        } else if (file) {
          const filePath = path.resolve(file);
          if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
          try {
            exhibitors = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!Array.isArray(exhibitors)) return { error: 'exhibitors.json must be a JSON array' };
          } catch (e) {
            return { error: `Failed to parse ${filePath}: ${e.message}` };
          }
          outDir = out_dir ? path.resolve(out_dir) : path.dirname(filePath);
        } else {
          return { error: 'Нужен file (путь) или companies (массив объектов {name, ...})' };
        }

        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        const enrichedPath = path.join(outDir, 'enriched.json');
        const enrichedAliasPath = path.join(outDir, 'requisites_enrichment.json');
        const reportPath = path.join(outDir, 'requisites_report.json');

        // Load existing results for resume
        let alreadyDone = {};
        if (resume) {
          for (const p of [enrichedPath, enrichedAliasPath]) {
            if (fs.existsSync(p)) {
              try {
                const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
                const arr = Array.isArray(saved) ? saved : (saved.companies || []);
                for (const c of arr) {
                  const key = String(c.id ?? c.name ?? '').toLowerCase();
                  if (key) alreadyDone[key] = c;
                }
              } catch {}
              break;
            }
          }
        }

        const remaining = exhibitors.filter(c => {
          const key = String(c.id ?? c.name ?? '').toLowerCase();
          return !alreadyDone[key];
        });

        const skipped = exhibitors.length - remaining.length;
        if (remaining.length === 0) {
          const all = Object.values(alreadyDone);
          return {
            ok: true,
            total: exhibitors.length,
            done: all.length,
            remaining: 0,
            skipped,
            message: `Все ${all.length} компаний уже обогащены. Запусти expo_pipeline_qualify для фильтрации.`,
            enrichedPath,
          };
        }

        const cfg = readConfig(ctx?.userId);
        const cacheDir = path.join(outDir, '.inn-cache');
        const config = {
          dadataToken: cfg.dadataToken || null,
          dadataSecret: cfg.dadataSecret || null,
          checkoKey: cfg.checkoKey || null,
          cacheDir,
          workers: Math.min(workers, 10),
        };

        const batchSz = Math.max(1, Math.min(batch_size, 50));
        const batch = remaining.slice(0, batchSz);
        const started = Date.now();
        const log = [];

        const enrichResult = await enrich(batch, config, ({ done, total, company, result }) => {
          if (result?.inn) log.push(`✓ ${company.name} → ${result.inn}`);
          else log.push(`✗ ${company.name}`);
        });
        const batchResults = Array.isArray(enrichResult?.enriched) ? enrichResult.enriched
          : Array.isArray(enrichResult) ? enrichResult : [];

        // Merge batch results into alreadyDone map
        for (const c of batchResults) {
          const key = String(c.id ?? c.name ?? '').toLowerCase();
          if (key) alreadyDone[key] = c;
        }

        // Also add back any original company that wasn't enriched (keep raw data)
        for (const orig of exhibitors) {
          const key = String(orig.id ?? orig.name ?? '').toLowerCase();
          if (!alreadyDone[key]) alreadyDone[key] = orig;
        }

        const allResults = Object.values(alreadyDone);
        const elapsed = Math.round((Date.now() - started) / 1000);

        // Save checkpoint — both filenames for compatibility
        const json = JSON.stringify(allResults, null, 2);
        fs.writeFileSync(enrichedPath, json, 'utf8');
        fs.writeFileSync(enrichedAliasPath, json, 'utf8');

        // Save simple report
        const withInn = allResults.filter(c => c.inn);
        const report = {
          total: exhibitors.length,
          enriched: allResults.length,
          with_inn: withInn.length,
          without_inn: allResults.length - withInn.length,
          generated_at: new Date().toISOString(),
        };
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

        const totalDone = allResults.length;
        const stillRemaining = exhibitors.length - totalDone;

        return {
          ok: true,
          batch_processed: batch.length,
          elapsed_sec: elapsed,
          total: exhibitors.length,
          done: totalDone,
          remaining: stillRemaining,
          skipped,
          progress_pct: Math.round(totalDone / exhibitors.length * 100),
          with_inn: withInn.length,
          enrichedPath,
          log: log.slice(-30),
          next_step: stillRemaining > 0
            ? `Ещё ${stillRemaining} компаний. Вызови inn_enrich_batch снова с теми же параметрами — продолжит с места остановки.`
            : `Все компании обогащены. Запусти expo_pipeline_qualify для фильтрации.`,
        };
      },
    },

  },
};
