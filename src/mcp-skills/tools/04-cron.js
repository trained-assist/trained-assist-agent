'use strict';

// Cron skill — schedules recurring tasks via Google Cloud Scheduler.
//
// Each cron = one Cloud Scheduler HTTP job → POST /run on this agent.
// The task prompt is stored in the GCP job body AND in {workDir}/crons/{id}.json.
// GCP handles retries, survives agent restarts, proper cron scheduling.
//
// Auth: GCP Metadata Server (VM service account) to manage Scheduler jobs.
// Runtime: Cloud Scheduler → POST /run with AGENT_SECRET Bearer header.

const fs = require('fs');
const path = require('path');

const USER_ID     = process.env.USER_ID || '';
const USER_HANDLE = process.env.AGENT_USER_HANDLE || '';
const AGENT_URL   = process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const GCP_PROJECT = process.env.GCP_PROJECT || 'alesa-personal-assistent';
const GCP_REGION  = process.env.GCP_REGION  || 'us-central1';

// ── GCP helpers ───────────────────────────────────────────────────────────────

async function getGcpToken() {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error('GCP metadata server unavailable (not on GCP VM?)');
  return (await res.json()).access_token;
}

async function schedulerRequest(method, jobSuffix, body) {
  const token = await getGcpToken();
  const base = `https://cloudscheduler.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}/jobs`;
  const url = jobSuffix ? `${base}/${jobSuffix}` : base;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`GCP Scheduler ${res.status}: ${data.error?.message || text.slice(0, 200)}`);
  return data;
}

// ── Local cron store ──────────────────────────────────────────────────────────

function cronsDir() {
  return path.join(process.cwd(), 'crons');
}

function cronFilePath(id) {
  return path.join(cronsDir(), `${id}.json`);
}

function saveCronRecord(record) {
  fs.mkdirSync(cronsDir(), { recursive: true });
  fs.writeFileSync(cronFilePath(record.id), JSON.stringify(record, null, 2));
}

function loadCronRecord(id) {
  const file = cronFilePath(id);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listCronRecords() {
  const dir = cronsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => loadCronRecord(f.replace('.json', '')))
    .filter(Boolean);
}

function deleteCronRecord(id) {
  const file = cronFilePath(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ── ID generation ─────────────────────────────────────────────────────────────

function makeCronId(label) {
  const slug = (label || 'cron')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  const ts = Date.now().toString(36);
  const prefix = USER_HANDLE || `u${USER_ID}`;
  return `${prefix}-${slug}-${ts}`.replace(/[^a-z0-9-]/g, '-');
}

// ── GCP job body ──────────────────────────────────────────────────────────────

function makeGcpJob(id, schedule, timezone, task) {
  const runBody = JSON.stringify({
    userId: parseInt(USER_ID) || USER_ID,
    username: USER_HANDLE,
    task,
    context: `cron:${id}`,
  });
  return {
    name: `projects/${GCP_PROJECT}/locations/${GCP_REGION}/jobs/${id}`,
    schedule,
    timeZone: timezone,
    httpTarget: {
      uri: `${AGENT_URL}/run`,
      httpMethod: 'POST',
      headers: {
        'Authorization': `Bearer ${AGENT_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: Buffer.from(runBody).toString('base64'),
    },
    retryConfig: { retryCount: 1 },
  };
}

// ── HH digest task template ───────────────────────────────────────────────────
// Claude reads active_vacancy + ats_config from context store at runtime.

const HH_DIGEST_TASK = `SCHEDULED: HH мониторинг — быстрый дайджест состояния воронки. Выполни автоматически без вопросов.

1. context_get('hh', 'active_vacancy') → если found=false → отправь «⏸ HH: нет активной вакансии.» и завершай.
2. hh_funnel_stats() — без аргументов, читает активную вакансию из контекста автоматически.
3. Сформируй дайджест и отправь сообщение в Telegram:

Формат сообщения:
📊 HH | {название вакансии}
Новых откликов: {new_responses}
Непрочитанных: {unread_messages ?? 'н/д'}
Активных всего: {active_total}

По этапам:
• Отклик: {response}
• Рассмотрение: {consider}
• Тел. интервью: {phone_interview}
• Тест: {assessment}
• Интервью: {interview}
• Оффер: {offer}
• Принят: {hired}
(Отклонено за всё время: {discard})

Если new_responses > 0 — добавь в конце: «Есть {N} новых откликов — запусти hh_batch_evaluate для оценки.»`.trim();

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  tools: {

    cron_create: {
      description:
        'Create a recurring scheduled task via Google Cloud Scheduler. ' +
        'The task runs automatically on schedule, with full access to all connected skills. ' +
        'schedule: standard cron syntax (e.g. "*/30 * * * *" = every 30 min, "0 9 * * *" = daily at 9:00). ' +
        'label: short name shown in cron_list (e.g. "hh-digest", "weekly-report").',
      inputSchema: {
        type: 'object',
        required: ['schedule', 'task'],
        properties: {
          schedule: { type: 'string', description: 'Cron expression: "*/30 * * * *" (every 30 min), "0 9 * * 1-5" (weekdays 9am)' },
          task:     { type: 'string', description: 'Full task description — what Claude should do on each run' },
          label:    { type: 'string', description: 'Short human-readable name for this cron (default: cron)' },
          timezone: { type: 'string', description: 'Timezone for schedule (default: Europe/Moscow)', default: 'Europe/Moscow' },
        },
      },
      handler: async ({ schedule, task, label, timezone = 'Europe/Moscow' }) => {
        if (!AGENT_SECRET) return { error: 'AGENT_SECRET not configured — cannot create cron job.' };

        const id = makeCronId(label || 'cron');
        const gcpJob = makeGcpJob(id, schedule, timezone, task);

        let gcpResult;
        try {
          gcpResult = await schedulerRequest('POST', null, gcpJob);
        } catch (err) {
          return { error: err.message };
        }

        const record = {
          id,
          gcp_job: gcpResult.name,
          schedule,
          timezone,
          label: label || 'cron',
          task,
          enabled: true,
          created_at: new Date().toISOString(),
        };
        saveCronRecord(record);

        return {
          ok: true,
          id,
          schedule,
          timezone,
          label: record.label,
          gcp_job: gcpResult.name,
          next_run: gcpResult.scheduleTime,
        };
      },
    },

    cron_hh_digest: {
      description:
        'Convenience: create an HH recruiting digest cron — evaluates new responses for the active vacancy and sends a summary to Telegram. ' +
        'Uses context_get("hh", "active_vacancy") and context_get("hh", "ats_config") at runtime. ' +
        'Set the active vacancy first with context_set before enabling this cron.',
      inputSchema: {
        type: 'object',
        required: ['schedule'],
        properties: {
          schedule: { type: 'string', description: 'Cron expression (e.g. "*/30 * * * *" = every 30 min, "0 10,15 * * 1-5" = Mon-Fri at 10:00 and 15:00)' },
          timezone: { type: 'string', description: 'Timezone (default: Europe/Moscow)', default: 'Europe/Moscow' },
        },
      },
      handler: async ({ schedule, timezone = 'Europe/Moscow' }) => {
        if (!AGENT_SECRET) return { error: 'AGENT_SECRET not configured — cannot create cron job.' };

        const id = makeCronId('hh-digest');
        const gcpJob = makeGcpJob(id, schedule, timezone, HH_DIGEST_TASK);

        let gcpResult;
        try {
          gcpResult = await schedulerRequest('POST', null, gcpJob);
        } catch (err) {
          return { error: err.message };
        }

        const record = {
          id,
          gcp_job: gcpResult.name,
          schedule,
          timezone,
          label: 'hh-digest',
          task: HH_DIGEST_TASK,
          enabled: true,
          created_at: new Date().toISOString(),
        };
        saveCronRecord(record);

        return {
          ok: true,
          id,
          schedule,
          timezone,
          gcp_job: gcpResult.name,
          next_run: gcpResult.scheduleTime,
          note: 'Дайджест будет читать active_vacancy и ats_config из context store при каждом запуске.',
        };
      },
    },

    cron_list: {
      description: 'List all scheduled cron jobs for this user.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const records = listCronRecords();
        return {
          count: records.length,
          crons: records.map(r => ({
            id: r.id,
            label: r.label,
            schedule: r.schedule,
            timezone: r.timezone,
            enabled: r.enabled,
            created_at: r.created_at,
            task_preview: r.task.slice(0, 100) + (r.task.length > 100 ? '…' : ''),
          })),
        };
      },
    },

    cron_delete: {
      description: 'Delete a scheduled cron job (stops it permanently).',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Cron ID from cron_list' },
        },
      },
      handler: async ({ id }) => {
        const record = loadCronRecord(id);
        if (!record) return { error: `Cron ${id} not found.` };

        try {
          await schedulerRequest('DELETE', id);
        } catch (err) {
          if (!err.message.includes('404')) return { error: err.message };
          // 404 = already gone from GCP, still clean up local
        }

        deleteCronRecord(id);
        return { ok: true, deleted: id };
      },
    },

    cron_pause: {
      description: 'Pause a cron job (keeps it configured, stops firing).',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Cron ID from cron_list' },
        },
      },
      handler: async ({ id }) => {
        const record = loadCronRecord(id);
        if (!record) return { error: `Cron ${id} not found.` };

        try {
          await schedulerRequest('POST', `${id}:pause`);
        } catch (err) {
          return { error: err.message };
        }

        record.enabled = false;
        saveCronRecord(record);
        return { ok: true, id, status: 'paused' };
      },
    },

    cron_resume: {
      description: 'Resume a paused cron job.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Cron ID from cron_list' },
        },
      },
      handler: async ({ id }) => {
        const record = loadCronRecord(id);
        if (!record) return { error: `Cron ${id} not found.` };

        try {
          await schedulerRequest('POST', `${id}:resume`);
        } catch (err) {
          return { error: err.message };
        }

        record.enabled = true;
        saveCronRecord(record);
        return { ok: true, id, status: 'active' };
      },
    },

    cron_run_now: {
      description: 'Trigger a cron job immediately (manual run, regardless of schedule).',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Cron ID from cron_list' },
        },
      },
      handler: async ({ id }) => {
        const record = loadCronRecord(id);
        if (!record) return { error: `Cron ${id} not found.` };

        try {
          await schedulerRequest('POST', `${id}:run`);
        } catch (err) {
          return { error: err.message };
        }

        return { ok: true, id, triggered: new Date().toISOString() };
      },
    },

  },
};
