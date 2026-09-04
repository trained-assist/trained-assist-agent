'use strict';

// Illustration generation skill — creates educational and medical illustrations.
// Supports multiple image providers: OpenAI DALL-E 3, fal.ai FLUX, Ideogram, Recraft.
// Sends generated image directly to Telegram as a document (full quality).
// Stores last prompt per user so Claude can iterate ("make it darker", "add detail").

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const USER_ID   = process.env.AGENT_USER_ID || '';
const BOT_TOKEN = process.env.AGENT_BOT_TOKEN || '';
const CHAT_ID   = process.env.AGENT_CHAT_ID  || '';
const TG_API    = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

// ── Style presets ────────────────────────────────────────────────────────────

const STYLES = {
  medical: [
    'scientific educational diagram, medical illustration style',
    'cross-section view, anatomical accuracy, clean outlines',
    'light blue or white background, professional medical textbook quality',
    'flat illustration with subtle depth, muted natural colors',
    'no photorealism, diagram aesthetic',
  ].join(', '),

  flat: [
    'flat design educational illustration, minimal and modern',
    'bold clean colors, geometric shapes, white background',
    'infographic style, clear visual hierarchy, icons and shapes',
    'Scandinavian design aesthetic, no gradients',
  ].join(', '),

  anatomical: [
    'detailed anatomical illustration, high medical accuracy',
    'cross-section diagram showing internal structure, layered detail',
    'textbook illustration style, warm ivory background',
    'watercolor-influenced soft shading, Netter\'s Atlas aesthetic',
  ].join(', '),

  infographic: [
    'modern educational infographic, vibrant professional colors',
    'clear step-by-step visual explanation, icons and labels',
    'clean layout, easy to read, health and science topic',
    'Instagram-friendly educational content style',
  ].join(', '),
};

const DEFAULT_STYLE = 'medical';

// ── Provider registry ────────────────────────────────────────────────────────

function availableProviders() {
  const list = [];
  if (process.env.OPENAI_API_KEY)    list.push('openai');
  if (process.env.FAL_KEY)           list.push('fal');
  if (process.env.IDEOGRAM_API_KEY)  list.push('ideogram');
  if (process.env.RECRAFT_API_KEY)   list.push('recraft');
  return list;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const body = options.body ? Buffer.from(options.body, 'utf8') : null;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch { reject(new Error(`Non-JSON response ${res.statusCode}: ${text.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
    }, (res) => {
      // Follow redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        fetchBuffer(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/png' }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Image generation per provider ────────────────────────────────────────────

async function generateOpenAI(prompt) {
  const res = await fetchJson('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      response_format: 'url',
    }),
  });
  if (res.status !== 200) throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(res.data)}`);
  const url = res.data?.data?.[0]?.url;
  if (!url) throw new Error('No URL in OpenAI response');
  return { url, provider: 'DALL-E 3 (OpenAI)', model: 'dall-e-3' };
}

async function generateFal(prompt) {
  // fal.ai FLUX.1 [dev] — high quality, $0.025/image
  const res = await fetchJson('https://fal.run/fal-ai/flux/dev', {
    method: 'POST',
    headers: { Authorization: `Key ${process.env.FAL_KEY}` },
    body: JSON.stringify({
      prompt,
      image_size: 'square_hd',  // 1024x1024
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      enable_safety_checker: true,
    }),
  });
  if (res.status !== 200) throw new Error(`fal.ai error ${res.status}: ${JSON.stringify(res.data)}`);
  const url = res.data?.images?.[0]?.url;
  if (!url) throw new Error('No image URL in fal.ai response');
  return { url, provider: 'FLUX.1 Dev (fal.ai)', model: 'fal-ai/flux/dev' };
}

async function generateIdeogram(prompt) {
  const res = await fetchJson('https://api.ideogram.ai/generate', {
    method: 'POST',
    headers: { 'Api-Key': process.env.IDEOGRAM_API_KEY },
    body: JSON.stringify({
      image_request: {
        prompt,
        model: 'V_2',
        aspect_ratio: 'ASPECT_1_1',
        style_type: 'DESIGN',
      },
    }),
  });
  if (res.status !== 200) throw new Error(`Ideogram error ${res.status}: ${JSON.stringify(res.data)}`);
  const url = res.data?.data?.[0]?.url;
  if (!url) throw new Error('No URL in Ideogram response');
  return { url, provider: 'Ideogram 2.0', model: 'V_2' };
}

async function generateRecraft(prompt) {
  const res = await fetchJson('https://external.api.recraft.ai/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RECRAFT_API_KEY}` },
    body: JSON.stringify({
      prompt,
      style: 'digital_illustration',
      size: '1024x1024',
    }),
  });
  if (res.status !== 200) throw new Error(`Recraft error ${res.status}: ${JSON.stringify(res.data)}`);
  const url = res.data?.data?.[0]?.url;
  if (!url) throw new Error('No URL in Recraft response');
  return { url, provider: 'Recraft v3', model: 'recraft-v3' };
}

const GENERATORS = {
  openai:  generateOpenAI,
  fal:     generateFal,
  ideogram: generateIdeogram,
  recraft: generateRecraft,
};

// ── Prompt building ──────────────────────────────────────────────────────────

const LANGUAGE_SUFFIXES = {
  ru: 'All text labels, captions and annotations inside the image must be in Russian (Cyrillic script).',
  en: 'All text labels, captions and annotations inside the image must be in English.',
};

const DEFAULT_LANGUAGE = 'ru';

function buildPrompt(description, style, language = DEFAULT_LANGUAGE) {
  const styleKey = STYLES[style] ? style : DEFAULT_STYLE;
  const styleText = STYLES[styleKey];
  const langSuffix = LANGUAGE_SUFFIXES[language] || `All text labels must be in ${language}.`;
  return `${description}. Style: ${styleText}. ${langSuffix}`;
}

// ── Telegram image sending ───────────────────────────────────────────────────

async function sendImageToTelegram(imageBuffer, filename, caption) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error('AGENT_BOT_TOKEN or AGENT_CHAT_ID not set — cannot send to Telegram');
  }

  // Build multipart/form-data manually (no external deps)
  const boundary = `----FormBoundary${Date.now().toString(16)}`;
  const parts = [];

  function addField(name, value) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  }

  addField('chat_id', CHAT_ID);
  if (caption) addField('caption', caption.slice(0, 1024));

  // Document part
  const docHeader = `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`;
  const docFooter = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(parts.join('') + docHeader, 'utf8');
  const footerBuf = Buffer.from(docFooter, 'utf8');
  const body = Buffer.concat([headerBuf, imageBuffer, footerBuf]);

  return new Promise((resolve, reject) => {
    const parsed = new URL(`${TG_API}/bot${BOT_TOKEN}/sendDocument`);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const data = JSON.parse(text);
          if (!data.ok) reject(new Error(`Telegram error: ${JSON.stringify(data)}`));
          else resolve(data);
        } catch { reject(new Error(`Non-JSON Telegram response: ${text.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Prompt history (disk-based per user) ─────────────────────────────────────

function historyPath() {
  return path.join(process.cwd(), 'contexts', 'illustrate', 'last_prompt.json');
}

function saveHistory(data) {
  const file = historyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadHistory() {
  const file = historyPath();
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ── Tools ────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    illustrate_providers: {
      description:
        'List available image generation providers and their capabilities. ' +
        'Call this to see which providers are configured (have API keys) before generating.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const available = availableProviders();
        const all = [
          { id: 'openai',   name: 'DALL-E 3 (OpenAI)',   price: '$0.04/img',  best: 'Medical diagrams, educational illustrations' },
          { id: 'fal',      name: 'FLUX.1 Dev (fal.ai)', price: '$0.025/img', best: 'Photorealistic, detailed anatomical art' },
          { id: 'ideogram', name: 'Ideogram 2.0',         price: '$0.06/img',  best: 'Illustrations with text labels inside image' },
          { id: 'recraft',  name: 'Recraft v3',           price: '$0.04/img',  best: 'Vector-style, flat design, clean diagrams' },
        ];
        const rows = all.map(p => ({
          ...p,
          status: available.includes(p.id) ? '✅ configured' : '❌ needs API key',
        }));
        return {
          configured: available,
          providers: rows,
          note: available.length === 0
            ? 'No image providers configured. Add OPENAI_API_KEY, FAL_KEY, IDEOGRAM_API_KEY, or RECRAFT_API_KEY to secrets.'
            : `Default provider: ${available[0]}`,
        };
      },
    },

    illustrate_styles: {
      description: 'List available illustration styles with descriptions. Show to user when they ask "what styles are available?"',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        styles: [
          { id: 'medical',    name: 'Medical Diagram',       description: 'Clean anatomical diagram, cross-sections, textbook quality, light background' },
          { id: 'flat',       name: 'Flat Design',           description: 'Minimal, bold colors, geometric shapes, modern infographic look' },
          { id: 'anatomical', name: 'Detailed Anatomical',   description: 'High-detail with watercolor shading, Netter\'s Atlas style, ivory background' },
          { id: 'infographic',name: 'Health Infographic',    description: 'Vibrant, step-by-step explanations, social-media friendly' },
        ],
        default: 'medical',
      }),
    },

    illustrate_preview_prompt: {
      description:
        'Generate and show the full image prompt WITHOUT actually creating an image. ' +
        'ALWAYS call this first before illustrate_generate — show the prompt to the user, ' +
        'ask for confirmation or changes, and only then proceed to generate.',
      inputSchema: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string', description: 'What to illustrate, in any language' },
          style:       { type: 'string', enum: Object.keys(STYLES), description: 'Visual style (default: medical)' },
          language:    { type: 'string', enum: ['ru', 'en'], description: 'Language for text labels inside the image. Default: ru (Russian).' },
        },
      },
      handler: async ({ description, style = DEFAULT_STYLE, language = DEFAULT_LANGUAGE }) => {
        const prompt = buildPrompt(description, style, language);
        return {
          preview_prompt: prompt,
          style_used: style,
          language_used: language,
          char_count: prompt.length,
          instruction: 'Show this prompt to the user. Ask: "Промт готов — подправить что-то или генерировать?" Then wait for their answer before calling illustrate_generate.',
        };
      },
    },

    illustrate_generate: {
      description: [
        'Generate an educational illustration and send it to the user in Telegram.',
        '',
        'MANDATORY WORKFLOW — always follow this order:',
        '  1. Call illustrate_preview_prompt first — build and show the prompt to the user',
        '  2. Present the prompt and ask: "Промт готов — подправить что-то или генерировать?"',
        '  3. Wait for user reply. If they want changes — revise description and preview again.',
        '  4. Only after user confirms — call illustrate_generate.',
        '',
        'NEVER skip step 1-3 and call illustrate_generate directly.',
        '',
        'After generation: tell which provider drew it, offer to try another provider or refine.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        required: ['description'],
        properties: {
          description: {
            type: 'string',
            description: 'Detailed description of what to illustrate. Be specific: what structure, what process, what perspective, what to highlight.',
          },
          style: {
            type: 'string',
            enum: Object.keys(STYLES),
            description: `Visual style preset. Default: ${DEFAULT_STYLE}. Use 'illustrate_styles' to see options.`,
          },
          language: {
            type: 'string',
            enum: ['ru', 'en'],
            description: 'Language for text labels inside the image. Default: ru (Russian).',
          },
          provider: {
            type: 'string',
            enum: ['openai', 'fal', 'ideogram', 'recraft'],
            description: 'Image generation provider. Defaults to first available configured provider.',
          },
        },
      },
      handler: async ({ description, style = DEFAULT_STYLE, language = DEFAULT_LANGUAGE, provider }) => {
        const available = availableProviders();
        if (available.length === 0) {
          return {
            error: 'no_provider',
            message: 'No image generation providers configured.',
            setup_needed: 'Add one of: OPENAI_API_KEY, FAL_KEY, IDEOGRAM_API_KEY, RECRAFT_API_KEY to secrets.',
          };
        }

        // Pick provider
        const chosenProvider = (provider && available.includes(provider)) ? provider : available[0];
        const generate = GENERATORS[chosenProvider];

        // Build prompt
        const fullPrompt = buildPrompt(description, style, language);

        // Generate image
        let result;
        try {
          result = await generate(fullPrompt);
        } catch (e) {
          return { error: 'generation_failed', provider: chosenProvider, message: e.message };
        }

        // Download image buffer
        let imgBuffer, contentType;
        try {
          const dl = await fetchBuffer(result.url);
          imgBuffer = dl.buffer;
          contentType = dl.contentType;
        } catch (e) {
          return { error: 'download_failed', url: result.url, message: e.message };
        }

        const ext = contentType?.includes('jpeg') ? 'jpg' : 'png';
        const filename = `illustration_${Date.now()}.${ext}`;

        // Send to Telegram as document (full quality)
        let telegramOk = false;
        let telegramError = null;
        if (BOT_TOKEN && CHAT_ID) {
          try {
            await sendImageToTelegram(imgBuffer, filename, `🎨 ${description.slice(0, 200)}`);
            telegramOk = true;
          } catch (e) {
            telegramError = e.message;
          }
        }

        // Save to workDir for reference
        const saveDir = path.join(process.cwd(), 'illustrations');
        try {
          fs.mkdirSync(saveDir, { recursive: true });
          fs.writeFileSync(path.join(saveDir, filename), imgBuffer);
        } catch {}

        // Store prompt history for iterations
        const historyEntry = {
          description,
          style,
          language,
          provider: chosenProvider,
          fullPrompt,
          url: result.url,
          filename,
          created_at: new Date().toISOString(),
        };
        saveHistory(historyEntry);

        // Build alternatives list
        const others = available.filter(p => p !== chosenProvider);
        const providerLabels = { openai: 'DALL-E 3', fal: 'FLUX.1 Dev', ideogram: 'Ideogram', recraft: 'Recraft v3' };

        return {
          ok: true,
          provider_used: result.provider,
          model: result.model,
          style_used: style,
          telegram_sent: telegramOk,
          telegram_error: telegramError || undefined,
          image_url: result.url,
          saved_as: filename,
          alternatives: others.length > 0
            ? `Other available providers: ${others.map(p => providerLabels[p] || p).join(', ')}. User can ask to regenerate with a specific one.`
            : 'This is the only configured provider.',
          iteration_tip: 'Prompt saved. User can say "make it darker", "add labels", "more detailed" — call illustrate_refine to iterate.',
        };
      },
    },

    illustrate_refine: {
      description: [
        'Refine the last generated illustration based on user feedback.',
        'Takes the previous prompt and applies the requested changes, then regenerates.',
        'Use when user says things like: "make it darker", "add more detail", "change the style",',
        '"add labels", "make it simpler", "different colors", etc.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        required: ['changes'],
        properties: {
          changes: {
            type: 'string',
            description: 'What to change compared to the last illustration. Be specific.',
          },
          provider: {
            type: 'string',
            enum: ['openai', 'fal', 'ideogram', 'recraft'],
            description: 'Override provider (optional — defaults to same as last time or first available).',
          },
        },
      },
      handler: async ({ changes, provider }) => {
        const last = loadHistory();
        if (!last) {
          return {
            error: 'no_history',
            message: 'No previous illustration found. Use illustrate_generate first.',
          };
        }

        // Append changes to description
        const newDescription = `${last.description}. Additional requirements: ${changes}`;

        // Use same style and provider unless overridden
        const available = availableProviders();
        const chosenProvider = (provider && available.includes(provider))
          ? provider
          : (available.includes(last.provider) ? last.provider : available[0]);

        if (!chosenProvider) {
          return { error: 'no_provider', message: 'No image providers configured.' };
        }

        const newPrompt = buildPrompt(newDescription, last.style, last.language || DEFAULT_LANGUAGE);
        const generate = GENERATORS[chosenProvider];

        let result;
        try {
          result = await generate(newPrompt);
        } catch (e) {
          return { error: 'generation_failed', provider: chosenProvider, message: e.message };
        }

        let imgBuffer, contentType;
        try {
          const dl = await fetchBuffer(result.url);
          imgBuffer = dl.buffer;
          contentType = dl.contentType;
        } catch (e) {
          return { error: 'download_failed', url: result.url, message: e.message };
        }

        const ext = contentType?.includes('jpeg') ? 'jpg' : 'png';
        const filename = `illustration_${Date.now()}.${ext}`;

        let telegramOk = false;
        if (BOT_TOKEN && CHAT_ID) {
          try {
            await sendImageToTelegram(imgBuffer, filename, `🎨 v2: ${newDescription.slice(0, 200)}`);
            telegramOk = true;
          } catch {}
        }

        // Save to disk
        try {
          const saveDir = path.join(process.cwd(), 'illustrations');
          fs.mkdirSync(saveDir, { recursive: true });
          fs.writeFileSync(path.join(saveDir, filename), imgBuffer);
        } catch {}

        // Update history
        saveHistory({
          description: newDescription,
          style: last.style,
          language: last.language || DEFAULT_LANGUAGE,
          provider: chosenProvider,
          fullPrompt: newPrompt,
          url: result.url,
          filename,
          created_at: new Date().toISOString(),
          refined_from: last.filename,
        });

        const others = available.filter(p => p !== chosenProvider);
        const providerLabels = { openai: 'DALL-E 3', fal: 'FLUX.1 Dev', ideogram: 'Ideogram', recraft: 'Recraft v3' };

        return {
          ok: true,
          provider_used: result.provider,
          changes_applied: changes,
          telegram_sent: telegramOk,
          image_url: result.url,
          saved_as: filename,
          alternatives: others.length > 0
            ? `Other providers: ${others.map(p => providerLabels[p] || p).join(', ')}`
            : undefined,
        };
      },
    },

  },
};
