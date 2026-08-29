const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const client = new SecretManagerServiceClient();
const PROJECT = 'alesa-personal-assistent';

async function getSecret(name) {
  const [version] = await client.accessSecretVersion({
    name: `projects/${PROJECT}/secrets/${name}/versions/latest`,
  });
  return version.payload.data.toString('utf8').trim();
}

const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'AGENT_SECRET'];
const OPTIONAL = ['DEEPGRAM_API_KEY', 'BOT_SECRET'];

async function loadSecrets() {
  const names = [...REQUIRED, ...OPTIONAL];
  const results = await Promise.allSettled(names.map(n => getSecret(n)));
  const values = Object.fromEntries(names.map((n, i) => [
    n,
    results[i].status === 'fulfilled' ? results[i].value : null,
  ]));

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
