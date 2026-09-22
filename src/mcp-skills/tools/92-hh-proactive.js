'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHmac } = require('crypto');
const {
  runProactiveSearch,
  buildScoringPromptText,
  buildProactiveDigest,
  loadSchedule,
  saveSchedule,
  atsConfigHash,
  queriesStorePath,
  loadStoredQueries,
  saveStoredQueries,
  getSearchExclusions,
} = require('../../hh-proactive-search');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';

function proactiveHmac(username) {
  const secret = process.env.AGENT_SECRET || '';
  return createHmac('sha256', secret).update(username).digest('hex').slice(0, 16);
}

// `vacancyId` is a plain, non-HMAC'd query param appended alongside the token — same
// pattern as hhReviewUrl (src/hh-quick.js) — so the tab switcher can deep-link into
// the right tab. Omitted (falsy) → no param, unchanged for single-vacancy callers.
function proactiveUrl(username, vacancyId) {
  const base = (process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
  const token = proactiveHmac(username);
  const vacancyParam = vacancyId ? `&vacancy_id=${encodeURIComponent(vacancyId)}` : '';
  return `${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${token}${vacancyParam}`;
}

function latestProactiveFile(username) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const dir = path.join(dataDir, 'hh', username, 'proactive');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('search-results-') && f.endsWith('.json')).sort();
  if (!files.length) return null;
  return path.join(dir, files[files.length - 1]);
}

function readChatId(username) {
  try { return fs.readFileSync(path.join(os.homedir(), 'agent-tokens', String(username), '.chatid'), 'utf8').trim() || null; }
  catch { return null; }
}

function buildNotifyChat(username) {
  return async (info) => {
    const chatId = readChatId(username);
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!chatId || !botToken) return;
    const text = buildProactiveDigest({
      vacancyTitle: info.vacancyTitle,
      newCount: info.newCount,
      totalNewCount: info.totalNewCount,
      totalSeen: info.totalSeen,
      newCandidates: info.newCandidates,
      threshold: info.threshold,
      url: info.proactiveUrl,
    });
    const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
    await fetch(`${tgBase}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  };
}

module.exports = {
  isReady: () => USER_ID ? fs.existsSync(path.join(os.homedir(), 'agent-tokens', USER_ID, 'hh')) : false,
  setupTools: [],
  tools: {
    hh_proactive_search: {
      description: 'Запускает проактивный поиск кандидатов в открытой базе HH по критериям ATS. Ищет людей которые не откликались сами. Занимает ~30 секунд.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };
        const workDir = process.cwd();
        try {
          const result = await runProactiveSearch(userId, workDir, {
            proactiveUrl: proactiveUrl(userId),
            notifyChat: buildNotifyChat(userId),
          });
          // vacancy_id is only known after runProactiveSearch resolves it — rebuild
          // the URL with it so the chat-facing link opens directly on the right tab.
          const url = proactiveUrl(userId, result.vacancy_id);
          const digest = (result.new_count > 0)
            ? `\n🆕 Из них новых (не показывались ранее): ${result.new_count}.`
            : (result.first_run ? `\n(первый прогон — все ${result.count} считаются новыми)` : `\nНовых с прошлого прогона: 0.`);
          return {
            ok: true,
            url,
            count: result.count,
            pass_count: result.pass_count,
            review_count: result.review_count,
            vacancy_title: result.vacancy_title,
            searched_at: result.searched_at,
            new_count: result.new_count,
            total_seen: result.total_seen,
            first_run: result.first_run,
            message: `Найдено ${result.count} кандидатов (PASS: ${result.pass_count}, REVIEW: ${result.review_count}).${result.ai_enriched ? ' AI-теги и резюме добавлены.' : ''}${digest}\nСтраница с результатами: ${url}\n\nХотите узнать, по каким критериям мы отбирали и оценивали? Скажите «покажи промпт оценки кандидатов».`,
          };
        } catch (e) {
          return { error: e.message };
        }
      },
    },

    hh_proactive_scoring_prompt: {
      description: 'Показывает промпт и логику по которой оцениваются кандидаты при проактивном поиске. Вызывай когда рекрутер спрашивает "как вы подбирали", "покажи критерии", "почему этот кандидат" и т.п.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        return { text: buildScoringPromptText(userId) };
      },
    },

    hh_proactive_queries: {
      description: 'Показывает и редактирует поисковые фразы проактивного поиска для активной вакансии. action=view — показать текущие фразы и когда сгенерированы; action=update — заменить список (передай queries:[...]); action=reset — удалить сохранённые фразы (регенерация при следующем запуске).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['view', 'update', 'reset'], description: 'Действие: view | update | reset' },
          queries: { type: 'array', items: { type: 'string' }, description: 'Новый список фраз (только для action=update)' },
        },
        required: ['action'],
      },
      handler: async ({ action, queries: newQueries }) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };

        // Resolve vacancy_id from the current ATS config
        const workDir = process.cwd();
        let atsConfig = null;
        let vacancyId = null;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(workDir, 'contexts', 'hh', 'ats_config.json'), 'utf8'));
          atsConfig = raw?.value;
          vacancyId = atsConfig?.vacancy_id ? String(atsConfig.vacancy_id) : null;
        } catch {}
        if (!vacancyId) {
          try {
            const av = JSON.parse(fs.readFileSync(path.join(workDir, 'contexts', 'hh', 'active_vacancy.json'), 'utf8'))?.value;
            if (av?.id) vacancyId = String(av.id);
          } catch {}
        }
        if (!vacancyId) return { error: 'Не удалось определить ID вакансии. Вызови hh_set_active_vacancy или hh_extract_ats_config заново.' };

        // Must include current exclusions — same as runProactiveSearch — so stale check
        // doesn't false-positive when there are no config changes but comments exist.
        const exclusionsForHash = getSearchExclusions(userId);
        const configHash = atsConfig ? atsConfigHash(atsConfig, exclusionsForHash) : null;
        const storePath = queriesStorePath(userId, vacancyId);

        if (action === 'view') {
          try {
            const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            const stale = configHash && data.config_hash !== configHash;
            return {
              vacancy_id: vacancyId,
              queries: data.queries || [],
              generated_at: data.generated_at,
              stale,
              stale_reason: stale ? 'ATS конфиг изменился после генерации — запусти поиск или action=reset для регенерации' : null,
              message: `${(data.queries || []).length} фраз для вакансии ${vacancyId}${stale ? ' (устарели)' : ''}: ${(data.queries || []).map(q => `"${q}"`).join(', ')}`,
            };
          } catch (e) {
            if (e.code === 'ENOENT') return { vacancy_id: vacancyId, queries: [], message: 'Фразы ещё не сгенерированы. Запусти hh_proactive_search.' };
            return { error: e.message };
          }
        }

        if (action === 'update') {
          if (!Array.isArray(newQueries) || newQueries.length === 0) return { error: 'queries[] обязателен и не должен быть пустым для action=update' };
          const validQueries = newQueries.map(q => String(q).trim()).filter(Boolean);
          if (!validQueries.length) return { error: 'Все фразы пустые — ничего не сохранено' };
          saveStoredQueries(userId, vacancyId, validQueries, configHash || 'manual');
          return {
            ok: true,
            vacancy_id: vacancyId,
            queries: validQueries,
            message: `Сохранено ${validQueries.length} фраз для вакансии ${vacancyId}. Следующий запуск poactive поиска будет использовать этот список.`,
          };
        }

        if (action === 'reset') {
          try { fs.unlinkSync(storePath); } catch (e) { if (e.code !== 'ENOENT') return { error: e.message }; }
          return { ok: true, vacancy_id: vacancyId, message: `Фразы сброшены. При следующем запуске hh_proactive_search они будут сгенерированы заново через LLM.` };
        }

        return { error: `Неизвестный action: ${action}` };
      },
    },

    hh_proactive_view: {
      description: 'Открыть страницу с результатами проактивного поиска кандидатов. Возвращает ссылку на веб-страницу с пагинацией, скорингом и AI-оценкой.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };
        const file = latestProactiveFile(userId);
        if (!file) {
          return { error: 'Результатов поиска нет. Запусти поиск командой hh_proactive_search.' };
        }
        let meta = {};
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          meta = {
            vacancy_title: data.vacancy_title,
            searched_at: data.searched_at,
            count: (data.candidates || []).length,
            pass_count: (data.candidates || []).filter(c => c.tag === 'PASS').length,
            review_count: (data.candidates || []).filter(c => c.tag === 'REVIEW').length,
          };
        } catch {}
        const url = proactiveUrl(userId);
        return {
          url,
          ...meta,
          message: `Страница с ${meta.count || '?'} кандидатами (PASS: ${meta.pass_count || 0}, REVIEW: ${meta.review_count || 0}): ${url}`,
        };
      },
    },

    hh_proactive_schedule: {
      description: 'Настройка автоматического (периодического) проактивного поиска с Telegram-уведомлениями. action=status — текущие настройки; action=enable — включить (можно задать interval_hours, по умолчанию 24, и notify_threshold); action=disable — выключить. Чтобы просто поменять порог уведомлений без изменения интервала — вызови action=enable и передай только notify_threshold.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'enable', 'disable'], description: 'status | enable | disable' },
          interval_hours: { type: 'number', description: 'Интервал запуска в часах (для action=enable, по умолчанию 24)' },
          notify_threshold: { type: 'number', description: 'Минимальная оценка кандидата (0-100%, нормализовано под критерии вакансии) для попадания в Telegram-уведомление о новых кандидатах. 0 (по умолчанию) — уведомлять обо всех новых, без фильтра. Задаётся вместе с action=enable.' },
        },
        required: ['action'],
      },
      handler: async ({ action, interval_hours, notify_threshold }) => {
        const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
        if (!userId) return { error: 'USER_ID не задан' };

        const schedule = loadSchedule(userId) || {};

        if (action === 'status') {
          if (!schedule.enabled) {
            return {
              enabled: false,
              message: 'Автоматический проактивный поиск выключен. Запусти action=enable чтобы включить — агент будет сам искать новых кандидатов и присылать уведомления.',
            };
          }
          const hours = schedule.interval_hours || 24;
          const threshold = schedule.notify_threshold || 0;
          const nextRunTs = schedule.last_run
            ? new Date(new Date(schedule.last_run).getTime() + hours * 3600000).toISOString()
            : '~10 мин после старта сервера';
          return {
            enabled: true,
            interval_hours: hours,
            notify_threshold: threshold,
            last_run: schedule.last_run || null,
            next_run: nextRunTs,
            message: `Автопоиск включён. Интервал: каждые ${hours} ч.\n${threshold > 0 ? `Порог уведомлений: ≥${threshold}% — слабее не присылаем.` : 'Порог уведомлений не задан — уведомляем обо всех новых кандидатах.'}\nПоследний запуск: ${schedule.last_run || 'ещё не было'}.\nСледующий: ${nextRunTs}.`,
          };
        }

        if (action === 'enable') {
          const hours = interval_hours && interval_hours > 0 ? interval_hours : (schedule.interval_hours || 24);
          const threshold = (notify_threshold !== undefined && notify_threshold !== null)
            ? Math.max(0, Math.min(100, Number(notify_threshold) || 0))
            : (schedule.notify_threshold || 0);
          schedule.enabled = true;
          schedule.interval_hours = hours;
          schedule.notify_threshold = threshold;
          saveSchedule(userId, schedule);
          return {
            ok: true,
            enabled: true,
            interval_hours: hours,
            notify_threshold: threshold,
            message: `✅ Автопоиск включён — каждые ${hours} ч агент будет искать новых кандидатов и присылать уведомления в Telegram.${threshold > 0 ? ` В уведомление попадут только кандидаты с оценкой ≥${threshold}%.` : ''} Первый запуск в течение 30 мин.\n\n⚠️ Это встроенный планировщик агента — он НЕ появится в списке cron_list (там только внешние Cloud Scheduler задачи). Проверить статус: hh_proactive_schedule action=status.`,
          };
        }

        if (action === 'disable') {
          schedule.enabled = false;
          saveSchedule(userId, schedule);
          return {
            ok: true,
            enabled: false,
            message: 'Автопоиск выключен. Используй hh_proactive_search для ручного запуска.',
          };
        }

        return { error: `Неизвестный action: ${action}` };
      },
    },
  },
};
