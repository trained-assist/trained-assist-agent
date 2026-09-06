'use strict';

// Site Connector MCP skill — Phase 2 of 98-api-from-website.js
// Uses Playwright storage-state (cookies) to make authenticated calls to sites
// connected via POST /connect/site (auto-login + crawl).
//
// Storage: ~/agent-data/sessions/{userId}/sites/{slug}/
//   config.json, crawl.json, intents.json, storage-state.json

const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_ID = process.env.USER_ID || '';

function dataDir() {
  return process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
}

function sitesRoot(username) {
  return path.join(dataDir(), 'sessions', username, 'sites');
}

function listSites(username) {
  const root = sitesRoot(username);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(f => {
      try { return fs.statSync(path.join(root, f)).isDirectory(); } catch { return false; }
    })
    .map(slug => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, slug, 'config.json'), 'utf8'));
        return { slug, ...cfg };
      } catch { return null; }
    })
    .filter(Boolean);
}

function readSite(username, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sitesRoot(username), slug, 'config.json'), 'utf8'));
  } catch { return null; }
}

function readCrawlReport(username, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sitesRoot(username), slug, 'crawl.json'), 'utf8'));
  } catch { return null; }
}

function readStorageState(username, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sitesRoot(username), slug, 'storage-state.json'), 'utf8'));
  } catch { return null; }
}

// Extract cookies for a given origin from Playwright storage state
function cookiesForOrigin(storageState, siteUrl) {
  if (!storageState?.cookies) return '';
  let origin;
  try { origin = new URL(siteUrl).hostname; } catch { origin = siteUrl; }
  const matching = storageState.cookies.filter(c => {
    return c.domain && (c.domain === origin || c.domain === `.${origin}` || origin.endsWith(c.domain.replace(/^\./, '')));
  });
  return matching.map(c => `${c.name}=${c.value}`).join('; ');
}

const hasSites = () => listSites(USER_ID).filter(s => s.status === 'connected').length > 0;

module.exports = {
  isReady: () => hasSites(),
  setupTools: ['site_list'],

  tools: {

    site_list: {
      description: 'List all websites the user has connected via the site connector (auto-login + crawl). Shows what pages and API endpoints were discovered.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const sites = listSites(USER_ID);
        if (sites.length === 0) {
          return {
            sites: [],
            hint: 'No sites connected yet. Ask the user to say "подключи сайт https://example.com".',
          };
        }
        return {
          sites: sites.map(s => ({
            slug: s.slug,
            name: s.name,
            url: s.url,
            status: s.status,
            pagesFound: s.pagesFound || 0,
            apiEndpointsFound: s.apiEndpointsFound || 0,
            lastCrawled: s.lastCrawled,
          })),
        };
      },
    },

    site_discover: {
      description: 'Show what was discovered during the crawl of a connected site: pages, API endpoints, forms. Use this to understand what you can do on the site before making requests.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Site slug from site_list' },
        },
        required: ['slug'],
      },
      handler: async ({ slug }) => {
        const site = readSite(USER_ID, slug);
        if (!site) return { error: `Site "${slug}" not found. Use site_list to see available sites.` };
        const crawl = readCrawlReport(USER_ID, slug);
        if (!crawl) return { error: `No crawl report for "${slug}". Site may still be crawling.` };
        return {
          site: { slug, name: site.name, url: site.url },
          pages: (crawl.pages || []).slice(0, 40).map(p => ({ url: p.url, title: p.title })),
          apiEndpoints: (crawl.apiEndpoints || []).slice(0, 50).map(e => ({ url: e.url, method: e.method })),
          forms: (crawl.forms || []).slice(0, 10),
          crawledAt: crawl.crawledAt,
          hint: 'Use site_request to call API endpoints with the user\'s session cookies.',
        };
      },
    },

    site_request: {
      description: 'Make an authenticated HTTP request to a connected site using the user\'s saved browser session (cookies from auto-login). Use for API calls discovered during crawl.',
      inputSchema: {
        type: 'object',
        properties: {
          slug:    { type: 'string',  description: 'Site slug from site_list' },
          path:    { type: 'string',  description: 'URL path or full URL, e.g. "/api/v1/projects" or "https://app.example.com/api/v1/projects"' },
          method:  { type: 'string',  enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method (default GET)' },
          body:    { type: 'object',  description: 'Request body for POST/PUT/PATCH (sent as JSON)' },
          headers: { type: 'object',  description: 'Extra headers to include' },
        },
        required: ['slug', 'path'],
      },
      handler: async ({ slug, path: urlPath, method = 'GET', body, headers: extraHeaders = {} }) => {
        const site = readSite(USER_ID, slug);
        if (!site) return { error: `Site "${slug}" not found. Use site_list to see available sites.` };

        const storageState = readStorageState(USER_ID, slug);
        const cookieHeader = storageState ? cookiesForOrigin(storageState, site.url) : '';

        const url = urlPath.startsWith('http') ? urlPath : `${site.url.replace(/\/$/, '')}${urlPath}`;

        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...extraHeaders,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20000),
          redirect: 'follow',
        });

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text.slice(0, 3000); }

        return {
          status: res.status,
          ok: res.ok,
          url,
          content_type: res.headers.get('content-type') || '',
          body: data,
          cookie_sent: cookieHeader ? `${cookieHeader.split(';').length} cookies` : 'none',
        };
      },
    },

    site_recrawl: {
      description: 'Trigger a fresh crawl of a connected site to update discovered pages and API endpoints. Useful if the site content has changed significantly.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Site slug from site_list' },
        },
        required: ['slug'],
      },
      handler: async ({ slug }) => {
        const site = readSite(USER_ID, slug);
        if (!site) return { error: `Site "${slug}" not found.` };

        // Read stored creds
        const credsPath = path.join(sitesRoot(USER_ID), slug, 'creds.json');
        let creds;
        try { creds = JSON.parse(fs.readFileSync(credsPath, 'utf8')); } catch {
          return { error: 'Credentials not found. Re-connect the site via "подключи сайт".' };
        }

        const { connectSite } = require('../../site-connector');
        const result = await connectSite(USER_ID, {
          url: site.url,
          login: creds.login,
          password: creds.password,
        });

        if (result.error) return { error: result.error };
        return {
          ok: true,
          slug: result.slug,
          status: result.status,
          message: 'Recrawl started. Telegram notification when done.',
        };
      },
    },

  },
};
