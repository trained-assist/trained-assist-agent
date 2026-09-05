'use strict';

// instant-publish MCP tool — lets any user session publish content as a shareable link.
// Backend: Cloudflare Worker at https://instant-publish.skillset-apply.workers.dev
// Per-user API keys stored in ~/agent-tokens/{USER_ID}/instant-publish-key

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomBytes, createHash } = require('crypto');

const API_BASE = 'https://instant-publish.skillset-apply.workers.dev/api';
const USER_ID = process.env.USER_ID || '';

function keyFilePath(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID), 'instant-publish-key');
}

function loadApiKey(userId) {
  const file = keyFilePath(userId);
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

async function ensureApiKey(userId) {
  let key = loadApiKey(userId);
  if (key) return key;

  key = randomBytes(24).toString('base64url');
  const res = await fetch(`${API_BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Registration failed: ${res.status}`);

  const dir = path.dirname(keyFilePath(userId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFilePath(userId), key, { mode: 0o600 });
  return key;
}

async function apiCall(method, endpoint, body, apiKey) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${endpoint}`, opts);
  return res.json();
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    || 'page';
}

function detectFormat(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<')) return 'html';
  return 'markdown';
}

function renderMarkdown(source, title) {
  // Simple inline render without dependencies — pass raw content as html wrapped in prose styles
  // The backend stores this as-is; for real markdown rendering use the CLI which has marked.js
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.7;color:#24292f;background:#fff;max-width:820px;margin:0 auto;padding:48px 32px 80px}
h1,h2,h3,h4{color:#1a1a2e;font-weight:700;line-height:1.3;margin-top:1.8em;margin-bottom:.6em}
h1{font-size:2.1em;padding-bottom:.35em;border-bottom:2px solid #e8e8e8;margin-top:0}
h2{font-size:1.6em;border-bottom:1px solid #eaecef;padding-bottom:.25em}
p{margin:0 0 1.1em} code{background:#f0f3f6;padding:.15em .4em;border-radius:4px;font-size:.88em}
pre{background:#f6f8fa;border:1px solid #d8dee4;border-radius:8px;padding:18px 20px;overflow-x:auto}
pre code{background:none;padding:0}
ul,ol{padding-left:2em;margin:0 0 1.1em} li{margin:.3em 0}
blockquote{border-left:4px solid #d0d7de;padding:.5em 1em;color:#57606a;background:#f8f9fa;margin:0 0 1.2em}
table{border-collapse:collapse;width:100%;margin-bottom:1.2em}
th,td{border:1px solid #d8dee4;padding:10px 14px;text-align:left}
th{background:#f0f3f6;font-weight:600}
a{color:#0969da;text-decoration:none}
.toolbar{position:fixed;top:12px;right:16px;display:flex;gap:6px;z-index:100}
.toolbar a{font-size:12px;color:#656d76;background:#f6f8fa;padding:5px 12px;border-radius:6px;border:1px solid #d8dee4;text-decoration:none}
@media print{.toolbar{display:none}}
</style></head><body>
<div class="toolbar"><a href="?raw">raw</a><a href="javascript:window.print()">print</a></div>
<article><pre style="white-space:pre-wrap;background:none;border:none;padding:0;font-family:inherit;font-size:1em">${source.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></article>
</body></html>`;
}

module.exports = {
  tools: {
    publish_page: {
      description:
        'Publish a document (HTML, Markdown, or text) as a shareable link. ' +
        'Returns a URL the user can open or share. ' +
        'Use for: reports, plans, invoices, articles, documents — anything that should be viewable in a browser. ' +
        'With no password the page is public; with a password it shows a lock form. ' +
        'Pass is_public=true to skip password even when one is provided.',
      inputSchema: {
        type: 'object',
        required: ['content', 'slug'],
        properties: {
          content: {
            type: 'string',
            description: 'Page content — HTML string, Markdown text, or plain text.',
          },
          slug: {
            type: 'string',
            description: 'URL slug (lowercase, hyphens only). Becomes: /p/{slug}. ' +
              'Example: "invoice-september-2026". Used to republish over the same URL.',
          },
          title: {
            type: 'string',
            description: 'Page title shown in browser tab. Defaults to slug.',
          },
          password: {
            type: 'string',
            description: 'If provided, page is password-protected. Visitor sees a lock form until they enter it. ' +
              'Share the URL as: {url}?password={password}',
          },
          is_public: {
            type: 'boolean',
            description: 'If true, page is public (no password). Default: true when no password given, false when password given.',
          },
          format: {
            type: 'string',
            enum: ['html', 'markdown', 'text'],
            description: 'Content format. Auto-detected from content if omitted.',
          },
        },
      },
      handler: async ({ content, slug, title, password, is_public, format } = {}) => {
        if (!content) return { error: 'content required' };
        if (!slug) return { error: 'slug required' };

        const userId = USER_ID;
        let apiKey;
        try {
          apiKey = await ensureApiKey(userId);
        } catch (e) {
          return { error: `API key setup failed: ${e.message}` };
        }

        const cleanSlug = slugify(slug);
        const pageTitle = title || cleanSlug;
        const detectedFormat = format || detectFormat(content);

        let htmlContent = content;
        let rawSource = undefined;

        if (detectedFormat === 'markdown' || detectedFormat === 'text') {
          rawSource = content;
          htmlContent = renderMarkdown(content, pageTitle);
        }

        const body = {
          content: htmlContent,
          slug: cleanSlug,
          title: pageTitle,
          format: detectedFormat,
        };
        if (rawSource) body.source = rawSource;
        if (password) body.password = password;
        if (is_public !== undefined) body.is_public = is_public;

        let data;
        try {
          data = await apiCall('POST', '/publish', body, apiKey);
        } catch (e) {
          return { error: `Publish failed: ${e.message}` };
        }

        if (!data.ok) return { error: data.error || 'publish failed' };

        const url = data.url;
        const result = {
          url: password ? `${url}?password=${password}` : url,
          slug: data.slug,
          is_protected: !!password,
        };
        if (rawSource) result.raw_url = `${url}?raw`;

        return result;
      },
    },

    list_pages: {
      description:
        'List all pages published by this user. ' +
        'Returns slug, title, creation date, format, and whether the page is protected.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const userId = USER_ID;
        let apiKey;
        try {
          apiKey = await ensureApiKey(userId);
        } catch (e) {
          return { error: `API key setup failed: ${e.message}` };
        }

        let data;
        try {
          data = await apiCall('GET', '/pages', null, apiKey);
        } catch (e) {
          return { error: `List failed: ${e.message}` };
        }

        if (data.error) return { error: data.error };
        const base = 'https://instant-publish.skillset-apply.workers.dev/p';
        return {
          pages: (data.pages || []).map(p => ({
            slug: p.slug,
            title: p.title,
            url: `${base}/${p.slug}`,
            format: p.format,
            is_protected: !p.is_public,
            created: p.created,
          })),
        };
      },
    },

    delete_page: {
      description: 'Delete a published page by slug. Permanent.',
      inputSchema: {
        type: 'object',
        required: ['slug'],
        properties: {
          slug: { type: 'string', description: 'The slug of the page to delete.' },
        },
      },
      handler: async ({ slug } = {}) => {
        if (!slug) return { error: 'slug required' };
        const userId = USER_ID;
        let apiKey;
        try {
          apiKey = await ensureApiKey(userId);
        } catch (e) {
          return { error: `API key setup failed: ${e.message}` };
        }

        let data;
        try {
          data = await apiCall('DELETE', '/publish', { slug }, apiKey);
        } catch (e) {
          return { error: `Delete failed: ${e.message}` };
        }

        return data.ok ? { ok: true, deleted: slug } : { error: data.error || 'delete failed' };
      },
    },
  },
};
