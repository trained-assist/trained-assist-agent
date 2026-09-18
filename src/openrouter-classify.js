'use strict';

// Shared helper for cheap LLM classification calls.
//
// Uses OpenRouter's native fallback routing (models array + route:'fallback'):
// tries the primary free model first; if it's rate-limited or unavailable,
// OpenRouter automatically retries with the next model in the list — no
// application-level retry loop needed.
//
// Default chain:
//   1. google/gemini-2.0-flash-exp:free  (free tier)
//   2. meta-llama/llama-3.3-70b-instruct:free  (backup free, different provider)
//   3. google/gemini-flash-1.5  (cheap paid fallback, ~$0.075/1M)
//
// Override via env: CLASSIFY_MODEL_PRIMARY / CLASSIFY_MODEL_SECONDARY / CLASSIFY_MODEL_PAID

const PRIMARY   = process.env.CLASSIFY_MODEL_PRIMARY   || 'google/gemini-2.0-flash-exp:free';
const SECONDARY = process.env.CLASSIFY_MODEL_SECONDARY || 'meta-llama/llama-3.3-70b-instruct:free';
const PAID      = process.env.CLASSIFY_MODEL_PAID      || 'google/gemini-flash-1.5';

const CLASSIFY_MODELS = [PRIMARY, SECONDARY, PAID];

/**
 * Run a cheap classification call via OpenRouter with automatic fallback.
 *
 * @param {object} opts
 * @param {string}   opts.orKey          - OpenRouter API key
 * @param {object[]} opts.messages       - chat messages array
 * @param {number}   [opts.maxTokens=40] - max tokens to generate
 * @param {number}   [opts.timeoutMs=10000]
 * @param {object}   [opts.responseFormat] - e.g. { type: 'json_object' }
 * @returns {Promise<string>} raw content string from the model
 */
async function openrouterClassify({ orKey, messages, maxTokens = 40, timeoutMs = 10000, responseFormat = null } = {}) {
  const body = {
    models: CLASSIFY_MODELS,
    route: 'fallback',
    temperature: 0,
    max_tokens: maxTokens,
    messages,
  };
  if (responseFormat) body.response_format = responseFormat;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenRouter classify ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

module.exports = { openrouterClassify, CLASSIFY_MODELS };
