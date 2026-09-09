const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'AGENT_SECRET'];
const OPTIONAL = ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'BOT_SECRET', 'CF_API_TOKEN', 'OPERATOR_CHAT_ID', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'HH_CLIENT_ID', 'HH_CLIENT_SECRET', 'OPENAI_API_KEY', 'FAL_KEY', 'IDEOGRAM_API_KEY', 'RECRAFT_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_ISSUES_TOKEN', 'WEB_JWT_SECRET'];

// GCP Secret Manager — used when running on GCP with ADC available
async function loadFromGcp() {
  // GOOGLE_APPLICATION_CREDENTIALS may point to a Drive-only SA (no Secret Manager access).
  // Unset it for the entire duration so the SDK uses the Compute Engine metadata server
  // (which has SM access). Restored in finally after all API calls complete.
  const savedCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const PROJECT = process.env.GCP_PROJECT || 'alesa-personal-assistent'; // GCP project name — cannot be renamed

    async function getSecret(name) {
      const [version] = await client.accessSecretVersion({
        name: `projects/${PROJECT}/secrets/${name}/versions/latest`,
      });
      return version.payload.data.toString('utf8').trim();
    }

    const names = [...REQUIRED, ...OPTIONAL];
    const results = await Promise.allSettled(names.map(n => getSecret(n)));
    return Object.fromEntries(names.map((n, i) => [
      n,
      results[i].status === 'fulfilled' ? results[i].value : null,
    ]));
  } finally {
    if (savedCreds !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = savedCreds;
  }
}

// Env-var fallback — used on non-GCP VMs (e.g. Hostland RU VM)
function loadFromEnv() {
  const names = [...REQUIRED, ...OPTIONAL];
  return Object.fromEntries(names.map(n => [n, process.env[n] || null]));
}

async function loadSecrets() {
  let values;

  if (process.env.SECRETS_SOURCE === 'env') {
    values = loadFromEnv();
  } else {
    // Try GCP first, fall back to env vars
    try {
      values = await loadFromGcp();
      // Fill missing with env vars
      for (const n of [...REQUIRED, ...OPTIONAL]) {
        if (!values[n] && process.env[n]) values[n] = process.env[n];
      }
    } catch {
      values = loadFromEnv();
    }
  }

  for (const name of REQUIRED) {
    if (!values[name]) throw new Error(`Required secret missing: ${name}`);
  }

  return {
    BOT_TOKEN: values.TELEGRAM_BOT_TOKEN,
    ANTHROPIC_API_KEY: values.ANTHROPIC_API_KEY, // not used for direct API calls — Claude Code uses OAuth; OpenRouter for LLM calls
    AGENT_SECRET: values.AGENT_SECRET,
    DEEPGRAM_API_KEY: values.DEEPGRAM_API_KEY,
    BOT_SECRET: values.BOT_SECRET,
    CF_API_TOKEN: values.CF_API_TOKEN,
    OPERATOR_CHAT_ID: values.OPERATOR_CHAT_ID,
    GOOGLE_OAUTH_CLIENT_ID: values.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: values.GOOGLE_OAUTH_CLIENT_SECRET,
    HH_CLIENT_ID: values.HH_CLIENT_ID,
    HH_CLIENT_SECRET: values.HH_CLIENT_SECRET,
    OPENAI_API_KEY: values.OPENAI_API_KEY,
    FAL_KEY: values.FAL_KEY,
    IDEOGRAM_API_KEY: values.IDEOGRAM_API_KEY,
    RECRAFT_API_KEY: values.RECRAFT_API_KEY,
    OPENROUTER_API_KEY: values.OPENROUTER_API_KEY,
    GITHUB_ISSUES_TOKEN: values.GITHUB_ISSUES_TOKEN,
    WEB_JWT_SECRET: values.WEB_JWT_SECRET,
  };
}

module.exports = { loadSecrets };
