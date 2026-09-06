'use strict';

// RU Browser skill
// Fetches web pages via headless Playwright running on the RU VM (178.212.14.192).
// Use this for sites geo-blocked from GCP: etm.ru, skills.etm.ru, hh.ru, nalog.ru, etc.
// Sessions on either VM can call this — it always routes through the Russian IP.

const RU_VM_BASE = 'https://platform.recruiter-assistant.ru';

const tools = [
  {
    name: 'ru_browser_fetch',
    description:
      'Fetch a web page using a browser with a Russian IP address (RU VM — 178.212.14.192). ' +
      'Use for sites geo-blocked from GCP: etm.ru, skills.etm.ru, госуслуги, ФНС, and any other ' +
      'Russian site that blocks foreign IPs. Returns the page text content. ' +
      'Supports CSS selector extraction and JavaScript evaluation.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL of the page to fetch, e.g. "https://skills.etm.ru/forum-msk-2026#participants"',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS selector — returns innerText of the matching element only. If omitted, returns full body text.',
        },
        wait_for: {
          type: 'string',
          description: 'When to consider page loaded: "domcontentloaded" (default, fast), "networkidle" (waits for no network activity), "load"',
          enum: ['domcontentloaded', 'networkidle', 'load'],
        },
        script: {
          type: 'string',
          description: 'Optional JavaScript expression to evaluate in the page context. Return value is included in the response. Example: "document.querySelectorAll(\'.company\').length"',
        },
      },
      required: ['url'],
    },
    handler: async ({ url, selector, wait_for, script }) => {
      const agentSecret = process.env.AGENT_SECRET;
      if (!agentSecret) {
        return { error: 'AGENT_SECRET not configured', hint: 'Check secrets.env on the VM' };
      }

      let response;
      try {
        response = await fetch(`${RU_VM_BASE}/playwright-fetch`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${agentSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url, selector, waitFor: wait_for || 'domcontentloaded', script }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        return { error: 'network_error', message: e.message, hint: 'RU VM may be down or unreachable' };
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { error: data.error || 'request_failed', message: data.message, status: response.status };
      }
      return data;
    },
  },

  {
    name: 'ru_browser_screenshot',
    description:
      'Take a screenshot of a web page using the RU VM browser (Russian IP). ' +
      'Returns a base64-encoded PNG. Useful for debugging geo-blocked pages.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to screenshot' },
        wait_for: {
          type: 'string',
          description: 'When to consider page loaded: "domcontentloaded" (default) or "networkidle"',
          enum: ['domcontentloaded', 'networkidle', 'load'],
        },
      },
      required: ['url'],
    },
    handler: async ({ url, wait_for }) => {
      const agentSecret = process.env.AGENT_SECRET;
      if (!agentSecret) return { error: 'AGENT_SECRET not configured' };

      let response;
      try {
        response = await fetch(`${RU_VM_BASE}/playwright-fetch`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${agentSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url, waitFor: wait_for || 'domcontentloaded', screenshot: true }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        return { error: 'network_error', message: e.message };
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { error: data.error || 'request_failed', message: data.message };
      return data;
    },
  },
];

module.exports = { tools: Object.fromEntries(tools.map(t => [t.name, t])) };
