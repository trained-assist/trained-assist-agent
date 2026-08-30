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
    dadataToken:      process.env.INN_DADATA_TOKEN       || null,
    dadataSecret:     process.env.INN_DADATA_SECRET      || null,
    checkoKey:        process.env.INN_CHECKO_KEY         || null,
    rusprofileCookie: process.env.INN_RUSPROFILE_COOKIE  || null,
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
            bfo_nalog:  { status: 'ready', note: 'Free, no auth. Main source.' },
            egrul:      { status: 'ready', note: 'Free, no auth. Director lookup.' },
            dadata:     { ...credStatus('dadataToken'),        note: 'Paid. Faster fallback.' },
            checko:     { ...credStatus('checkoKey'),          note: 'Paid. Financial data.' },
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
Input: path to exhibitors.json (array of {id, name, city?, website?, email?, country?}).
Output: writes requisites_enrichment.json and requisites_report.json in the same directory.
Estimated time: 10–15 min for 300 companies.`,
      inputSchema: {
        type: 'object',
        required: ['file'],
        properties: {
          file: {
            type: 'string',
            description: 'Path to exhibitors.json (absolute or relative to cwd)',
          },
          workers: {
            type: 'number',
            description: 'Parallel workers (default: 8, max: 16)',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Limit to specific sources: ["bfo","dadata","egrul","checko","site"]. Default: all.',
          },
        },
      },
      handler: async ({ file, workers = 8, sources }, ctx) => {
        const filePath = path.resolve(file);
        if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };

        let exhibitors;
        try {
          exhibitors = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (!Array.isArray(exhibitors)) return { error: 'exhibitors.json must be a JSON array' };
        } catch (e) {
          return { error: `Failed to parse ${filePath}: ${e.message}` };
        }

        const cfg = readConfig(ctx?.userId);
        const outDir = path.dirname(filePath);
        const cacheDir = path.join(outDir, '.inn-cache');

        const config = {
          dadataToken: cfg.dadataToken || null,
          dadataSecret: cfg.dadataSecret || null,
          checkoKey: cfg.checkoKey || null,
          cacheDir,
          workers: Math.min(workers, 16),
        };

        const log = [];
        const started = Date.now();

        const { enriched, report } = await enrich(exhibitors, config, ({ done, total, company, result }) => {
          if (result?.inn) {
            log.push(`✓ ${company.name} → ${result.inn} [${result.requisites_confidence}]`);
          } else if (done % 20 === 0) {
            log.push(`… ${done}/${total} done`);
          }
        });

        // write outputs
        const enrichedPath = path.join(outDir, 'requisites_enrichment.json');
        const reportPath   = path.join(outDir, 'requisites_report.json');
        fs.writeFileSync(enrichedPath, JSON.stringify(enriched, null, 2), 'utf8');
        fs.writeFileSync(reportPath,   JSON.stringify(report, null, 2), 'utf8');

        const elapsed = Math.round((Date.now() - started) / 1000);

        return {
          ok: true,
          elapsed_sec: elapsed,
          output: { enrichedPath, reportPath },
          report,
          log: log.slice(-30),
        };
      },
    },

  },
};
