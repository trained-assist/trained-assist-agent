const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'AGENT_SECRET'];
const OPTIONAL = ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'BOT_SECRET'];

// GCP Secret Manager — used when running on GCP with ADC available
async function loadFromGcp() {
  const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const PROJECT = 'alesa-personal-assistent'; // GCP project name — cannot be renamed

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
    ANTHROPIC_API_KEY: values.ANTHROPIC_API_KEY,
    AGENT_SECRET: values.AGENT_SECRET,
    DEEPGRAM_API_KEY: values.DEEPGRAM_API_KEY,
    BOT_SECRET: values.BOT_SECRET,
  };
}

module.exports = { loadSecrets };
