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
  if (process.env.IDEOGRAM_API_KEY)  list.push('ideogram');
  if (process.env.FAL_KEY)           list.push('fal');
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
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'high',
    }),
  });
  if (res.status === 429 || res.status === 402 ||
      res.data?.error?.code === 'insufficient_quota' ||
      res.data?.error?.type === 'insufficient_quota') {
    throw new Error('BILLING_LIMIT: На аккаунте OpenAI закончились деньги. Попробуй другой провайдер или пополни баланс на platform.openai.com');
  }
  if (res.status !== 200) throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(res.data)}`);
  // gpt-image-1 returns base64; save to agent-data/images/ and serve via /images/ route
  const b64 = res.data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image data in OpenAI response');
  const imgDir = path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const fname = `gptimage_${Date.now()}.png`;
  fs.writeFileSync(path.join(imgDir, fname), Buffer.from(b64, 'base64'));
  const publicBase = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io/agent').replace(/\/$/, '');
  return { url: `${publicBase}/images/${fname}`, provider: 'GPT-Image-1 (OpenAI)', model: 'gpt-image-1' };
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

// Map our style presets to Ideogram style_type.
// DESIGN = graphic design / posters / typography — wrong for medical content.
// ILLUSTRATION = drawings, diagrams, educational art — correct default.
const IDEOGRAM_STYLE_TYPE = {
  medical:     'ILLUSTRATION',
  anatomical:  'ILLUSTRATION',
  flat:        'DESIGN',
  infographic: 'DESIGN',
};

async function generateIdeogram(prompt, style = DEFAULT_STYLE) {
  const styleType = IDEOGRAM_STYLE_TYPE[style] || 'ILLUSTRATION';
  const res = await fetchJson('https://api.ideogram.ai/generate', {
    method: 'POST',
    headers: { 'Api-Key': process.env.IDEOGRAM_API_KEY },
    body: JSON.stringify({
      image_request: {
        prompt,
        model: 'V_2',
        aspect_ratio: 'ASPECT_1_1',
        style_type: styleType,
      },
    }),
  });
  if (res.status !== 200) throw new Error(`Ideogram error ${res.status}: ${JSON.stringify(res.data)}`);
  const url = res.data?.data?.[0]?.url;
  if (!url) throw new Error('No URL in Ideogram response');
  return { url, provider: 'Ideogram 2.0', model: 'V_2', ideogram_style_type: styleType };
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

function makeGenerators(style) {
  return {
    openai:   (prompt) => generateOpenAI(prompt),
    fal:      (prompt) => generateFal(prompt),
    ideogram: (prompt) => generateIdeogram(prompt, style),
    recraft:  (prompt) => generateRecraft(prompt),
  };
}

// ── Prompt building ──────────────────────────────────────────────────────────

const LANGUAGE_SUFFIXES = {
  ru: 'All text labels, captions and annotations inside the image must be in Russian (Cyrillic script).',
  en: 'All text labels, captions and annotations inside the image must be in English.',
};

// labels_mode: where to place structure labels
//   'embedded' — text rendered inside the image (default, works best with Ideogram)
//   'caption'  — clean image, labels listed as text message below image
//   'none'     — pure illustration, no labels at all
const DEFAULT_LANGUAGE   = 'ru';
const DEFAULT_LABELS_MODE = 'embedded';

function buildPrompt(description, style, language = DEFAULT_LANGUAGE, labelsMode = DEFAULT_LABELS_MODE) {
  const styleKey = STYLES[style] ? style : DEFAULT_STYLE;
  const styleText = STYLES[styleKey];

  if (labelsMode === 'none') {
    return `${description}. Style: ${styleText}. No text, no labels, no annotations — pure illustration only.`;
  }
  if (labelsMode === 'caption') {
    return `${description}. Style: ${styleText}. Clean illustration without any text, numbers or labels inside the image — labels will be provided separately as text.`;
  }
  // embedded (default)
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

// ── Opt-in flag ──────────────────────────────────────────────────────────────

function enabledFlagPath() {
  return path.join(process.cwd(), 'contexts', 'illustrate', '.enabled');
}

function isEnabled() {
  return fs.existsSync(enabledFlagPath());
}

function enableSkill() {
  const p = enabledFlagPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ enabled_at: new Date().toISOString() }));
}

// ── Tools ────────────────────────────────────────────────────────────────────

module.exports = {
  isReady: isEnabled,
  setupTools: ['illustrate_setup'],

  tools: {

    illustrate_setup: {
      description: [
        'Enable or check status of the illustration generation skill.',
        'Call this when the user asks about drawing, illustrations, or image generation.',
        'If not yet enabled — explain what the skill does and enable it.',
        'After enabling, tell the user the tools will be available on the next message.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const available = availableProviders();
        if (isEnabled()) {
          return {
            status: 'already_enabled',
            providers: available,
            message: 'Скил иллюстраций уже включён. Доступны: illustrate_preview_prompt, illustrate_generate, illustrate_refine, image_label.',
          };
        }
        if (available.length === 0) {
          return {
            status: 'no_providers',
            message: 'Нет настроенных провайдеров генерации изображений. Нужен OPENAI_API_KEY или IDEOGRAM_API_KEY.',
          };
        }
        enableSkill();
        return {
          status: 'enabled',
          providers: available,
          default_provider: available[0],
          message: 'Скил иллюстраций включён! На следующем сообщении появятся все инструменты: illustrate_preview_prompt (показывает промпт перед генерацией), illustrate_generate (генерация), illustrate_refine (доработка), image_label (наложение подписей).',
          next_step: 'Скажи пользователю: "Готово, теперь я умею рисовать медицинские иллюстрации. Напиши что нарисовать — и начнём!"',
        };
      },
    },

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
            : `Default provider: ${available[0]}. After generating with DALL-E 3, tell the user they can also try Ideogram (better at text labels inside the image) by saying "попробуй Ideogram".`,
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
          description:  { type: 'string', description: 'What to illustrate. If the user has a medical specialty, enrich with domain-specific anatomy: for podology add nail plate, nail bed, nail matrix, lateral nail fold, plantar skin layers, heel pad as relevant; for dermatology add epidermis layers, dermis, follicles; etc. The user will see and can correct this description.' },
          style:        { type: 'string', enum: Object.keys(STYLES), description: 'Visual style (default: medical)' },
          language:     { type: 'string', enum: ['ru', 'en'], description: 'Language for embedded labels. Default: ru. Only applies when labels_mode is "embedded".' },
          labels_mode:  { type: 'string', enum: ['embedded', 'caption', 'none'], description: 'Where labels go: "embedded" = text in image (default), "caption" = clean image + labels as text below, "none" = pure illustration, no labels.' },
        },
      },
      handler: async ({ description, style = DEFAULT_STYLE, language = DEFAULT_LANGUAGE, labels_mode = DEFAULT_LABELS_MODE }) => {
        const prompt = buildPrompt(description, style, language, labels_mode);
        return {
          preview_prompt: prompt,
          style_used: style,
          language_used: labels_mode === 'embedded' ? language : 'n/a',
          labels_mode,
          char_count: prompt.length,
          labels_question: labels_mode === DEFAULT_LABELS_MODE
            ? 'After showing the prompt, ask the user: "Подписи прямо на картинке или сначала нарисую чистую, потом наложим отдельно?" (embedded = подписи в картинке, caption/none = чистая картинка, потом image_label). Wait for their answer and set labels_mode accordingly before calling illustrate_generate.'
            : null,
          instruction: 'Show this prompt to the user. If labels_question is set — ask it too. Wait for confirmation and labels preference before calling illustrate_generate.',
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
            description: [
              'Detailed description of what to illustrate. Be specific: what structure, what process, what perspective, what to highlight.',
              'If the user is a medical specialist, enrich with their domain anatomy — for podology: nail plate, nail bed, nail matrix, cuticle/eponychium, lunula, hyponychium, lateral nail fold, phalanx bone, plantar skin layers, heel fat pad, plantar fascia; for dermatology: epidermis layers (stratum corneum/granulosum/spinosum/basale), dermis, hair follicles, sebaceous glands.',
              'For Ideogram/DALL-E (default providers): write in English, be anatomically precise, list every structure to show.',
              'Example (podology — nail cross-section): "Medical cross-section diagram of human fingernail, lateral view.',
              'Shows nail plate, nail bed, nail matrix, cuticle (eponychium), lunula, hyponychium, lateral nail fold, bone phalanx.',
              'Clean Netter\'s Atlas style, white background, no text, no labels."',
            ].join(' '),
          },
          style: {
            type: 'string',
            enum: Object.keys(STYLES),
            description: `Visual style preset. Default: ${DEFAULT_STYLE}. Use 'illustrate_styles' to see options.`,
          },
          language: {
            type: 'string',
            enum: ['ru', 'en'],
            description: 'Language for embedded labels. Default: ru. Only applies when labels_mode is "embedded".',
          },
          labels_mode: {
            type: 'string',
            enum: ['embedded', 'caption', 'none'],
            description: '"embedded" = labels rendered inside image (default). "caption" = clean image + labels sent as text message below. "none" = pure illustration, no labels.',
          },
          provider: {
            type: 'string',
            enum: ['openai', 'fal', 'ideogram', 'recraft'],
            description: 'Image generation provider. Defaults to first available configured provider.',
          },
        },
      },
      handler: async ({ description, style = DEFAULT_STYLE, language = DEFAULT_LANGUAGE, labels_mode = DEFAULT_LABELS_MODE, provider }) => {
        const available = availableProviders();
        if (available.length === 0) {
          return {
            error: 'no_provider',
            message: 'No image generation providers configured.',
            setup_needed: 'Add one of: OPENAI_API_KEY, FAL_KEY, IDEOGRAM_API_KEY, RECRAFT_API_KEY to secrets.',
          };
        }

        // Pick provider (explicit or first available)
        const preferredProvider = (provider && available.includes(provider)) ? provider : available[0];

        // Build prompt
        const fullPrompt = buildPrompt(description, style, language, labels_mode);

        // Generate with auto-fallback: if billing/quota error → try next provider automatically
        const BILLING_ERRORS = /billing|payment|quota|insufficient|credit|balance|funds|limit exceeded/i;
        const candidateProviders = [preferredProvider, ...available.filter(p => p !== preferredProvider)];
        const generators = makeGenerators(style);

        let result;
        let chosenProvider;
        const attemptErrors = [];
        for (const p of candidateProviders) {
          try {
            result = await generators[p](fullPrompt);
            chosenProvider = p;
            break;
          } catch (e) {
            if (BILLING_ERRORS.test(e.message) && p !== candidateProviders[candidateProviders.length - 1]) {
              attemptErrors.push({ provider: p, error: e.message });
              continue; // try next
            }
            return { error: 'generation_failed', provider: p, attempted: attemptErrors, message: e.message };
          }
        }
        if (!result) {
          return { error: 'all_providers_failed', attempted: attemptErrors };
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
          labels_mode,
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

        const response = {
          ok: true,
          provider_used: result.provider,
          model: result.model,
          style_used: style,
          labels_mode,
          telegram_sent: telegramOk,
          ...(attemptErrors.length > 0 ? { fallback_used: true, skipped_providers: attemptErrors.map(a => a.provider) } : {}),
          telegram_error: telegramError || undefined,
          image_url: result.url,
          saved_as: filename,
          alternatives: others.length > 0
            ? `Other available providers: ${others.map(p => providerLabels[p] || p).join(', ')}. After showing the image, tell the user they can also try Ideogram — it handles text labels inside the image better. Say: "Также можно попробовать Ideogram — он лучше рисует подписи прямо на иллюстрации. Написать \\"попробуй Ideogram\\"?"`
            : 'This is the only configured provider.',
          iteration_tip: 'Prompt saved. User can say "make it darker", "add labels", "more detailed" — call illustrate_refine to iterate.',
        };

        // For caption mode: Claude must send a text message after the image listing labeled elements
        if (labels_mode === 'caption') {
          response.caption_instruction =
            'Image was generated WITHOUT embedded labels. ' +
            'Now write a text message to the user listing the labeled elements from the illustration, ' +
            `in ${language === 'ru' ? 'Russian' : 'English'}, using numbered list or arrows (→). ` +
            'Format: "Обозначения к иллюстрации:" followed by the list.';
        }

        return response;
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

        const newPrompt = buildPrompt(newDescription, last.style, last.language || DEFAULT_LANGUAGE, last.labels_mode || DEFAULT_LABELS_MODE);
        const generate = makeGenerators(last.style)[chosenProvider];

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
          labels_mode: last.labels_mode || DEFAULT_LABELS_MODE,
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

    illustrate_tips: {
      description: [
        'Return a playbook of workarounds and tips for image generation quality issues.',
        'Call this when:',
        '  - the generated image looks wrong, garbled, or off-topic',
        '  - text labels inside the image are unreadable or wrong',
        '  - user says "плохо нарисовал", "чепуха", "не то", "подписи кривые"',
        '  - you want to suggest a better strategy before retrying',
        'Optionally pass the current provider and style to get targeted advice.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['openai', 'fal', 'ideogram', 'recraft'], description: 'Current provider (optional — for targeted tips)' },
          style:    { type: 'string', enum: ['medical', 'flat', 'anatomical', 'infographic'], description: 'Current style (optional)' },
          problem:  { type: 'string', description: 'Short description of what went wrong (optional)' },
        },
      },
      handler: async ({ provider, style, problem } = {}) => ({
        playbook: {
          providers: {
            openai: {
              strengths: ['Medical and educational diagrams', 'Clean anatomical cross-sections', 'Consistent style adherence', 'Handles complex multi-element prompts well'],
              weaknesses: ['Text labels inside image often garbled or misplaced', 'Expensive ($0.04/image with gpt-image-1 high quality)', 'Slower than others'],
              best_for: ['medical', 'anatomical', 'flat styles'],
              tips: [
                'For text labels — use labels_mode:"caption" (clean image + labels as text below) instead of embedded',
                'More specific anatomy terms = better: list every structure explicitly',
                'Add "white background, no decorative borders, no watermarks" to avoid visual noise',
                'If result has wrong structures — add "NOT [wrong thing]" to prompt',
              ],
            },
            ideogram: {
              strengths: ['Best at readable text INSIDE the image (letters, cyrillic, numbers)', 'Great for infographics and design with typography', 'Fast and reliable'],
              weaknesses: ['Medical realism varies — may produce stylized/poster look', 'DESIGN style_type is wrong for anatomy (now fixed: medical→ILLUSTRATION)', 'Less precise for complex anatomical cross-sections'],
              best_for: ['infographic', 'flat styles', 'any case with labels_mode:"embedded"'],
              tips: [
                'Use labels_mode:"embedded" — this is where Ideogram genuinely beats everyone',
                'If result looks like a poster — style was wrong (now fixed via IDEOGRAM_STYLE_TYPE map)',
                'For anatomical work, be very explicit: "cross-section, cutaway view, showing layers" etc.',
                'Prompt in English works better than Russian for anatomy terms',
              ],
            },
            fal: {
              strengths: ['Best photorealism and artistic depth', 'Detailed textures', 'Good price/quality ratio ($0.025/img)'],
              weaknesses: ['Clean diagram/educational style harder to achieve', 'Text labels essentially never work', 'Tends toward artistic rather than technical look'],
              best_for: ['Photorealistic anatomical art, not schematic diagrams', 'When user wants a "beautiful" illustration vs a technical one'],
              tips: [
                'Always use labels_mode:"caption" or "none" — text in image will be garbage',
                'Add "medical illustration, textbook quality, clinical diagram" to steer away from artistic',
                'For anatomical art (not diagrams): FLUX is excellent — Netter\'s Atlas watercolor style',
              ],
            },
            recraft: {
              strengths: ['Vector-like clean lines', 'Flat design and icons', 'Consistent color palettes', 'Good for UI/infographic elements'],
              weaknesses: ['Less anatomical knowledge than OpenAI', 'Text quality inconsistent'],
              best_for: ['flat', 'infographic styles', 'icon-heavy diagrams'],
              tips: [
                'Use style: "flat" — that\'s where Recraft shines',
                'Prompt with color names explicitly: "blue, white, light gray"',
                'Good for process diagrams (step 1 → step 2 → ...) with clean arrows',
              ],
            },
          },
          labels_mode_guide: {
            embedded: 'Text rendered inside image. BEST with Ideogram. Risky with OpenAI/FLUX (garbled). Use for: simple diagrams with few labels, when user will screenshot and share.',
            caption:  'Clean image generated, then Claude sends a numbered label list as a separate text message. Works with ALL providers. Use when: text quality is uncertain, many labels needed, or user wants to add labels themselves.',
            none:     'Pure illustration, no labels. Use for: artistic renders, when labels will be added externally (e.g. in Canva), or when user just wants the picture.',
          },
          retry_strategies: [
            { problem: 'Текст/подписи нечитаемые или кривые', fix: 'Switch to labels_mode:"caption" (clean image) or switch provider to Ideogram (best at cyrillic text)' },
            { problem: 'Результат выглядит как плакат/постер, а не схема', fix: 'Was Ideogram with DESIGN style_type — now fixed. If still happens: add "technical diagram, no decorative elements, clinical illustration" to prompt' },
            { problem: 'Не те структуры нарисованы / путается анатомия', fix: 'List every structure explicitly. Add "showing ONLY: [list]". Add "NOT showing: [wrong things]". Switch to OpenAI — it has better medical anatomy training.' },
            { problem: 'Слишком художественно, не как учебник', fix: 'Add to prompt: "schematic diagram, textbook illustration, not artistic". Switch style to medical or anatomical.' },
            { problem: 'Фон грязный / лишние элементы', fix: 'Add: "white background, clean background, no texture, no shadows, no decorative borders, no watermark"' },
            { problem: 'Пропорции неправильные', fix: 'Add explicit size cues: "to scale", "proportional", "anatomically accurate proportions"' },
            { problem: 'Нужно больше деталей', fix: 'Call illustrate_refine with changes:"add more detail to [specific area], show [specific structures]". Or switch to fal (FLUX) for maximum detail.' },
          ],
          prompt_engineering: {
            rules: [
              'Describe what TO show, not what NOT to show (negatives work poorly)',
              'Exception: "no text", "no labels", "no watermarks" — these negative phrases work reliably',
              'Anatomy: list structures by their medical names, not lay terms',
              'Perspective: always specify (cross-section, lateral view, anterior view, top-down)',
              'Style anchors that work: "Netter\'s Atlas style", "Gray\'s Anatomy illustration", "medical textbook diagram", "clinical illustration"',
              'For Ideogram specifically: shorter, punchier prompts often beat long ones',
            ],
          },
        },
        targeted_advice: provider ? (() => {
          const ideogramStyleType = IDEOGRAM_STYLE_TYPE[style] || 'ILLUSTRATION';
          const tips = {
            openai:   'OpenAI selected. For embedded text labels — consider switching to Ideogram. Otherwise solid choice for medical diagrams.',
            ideogram: `Ideogram with ${ideogramStyleType} style_type${style ? ` (style=${style})` : ' (default)'}. `
              + (ideogramStyleType === 'ILLUSTRATION'
                ? 'If result still looks wrong — try adding "anatomical diagram, educational illustration, clinical" to description.'
                : 'Correct for flat/infographic content. If image looks too clinical — this style_type is right, adjust prompt instead.'),
            fal:      'FLUX selected — great for artistic depth, but use labels_mode:"caption" or "none" as text in image will not render correctly.',
            recraft:  'Recraft selected — use style:"flat" for best results. For anatomy, OpenAI will be more accurate.',
          };
          const base = tips[provider] || null;
          if (!base) return null;
          return problem ? `${base}\n\nFor reported problem "${problem}": see retry_strategies above for a matching fix.` : base;
        })() : null,
      }),
    },

  },
};
