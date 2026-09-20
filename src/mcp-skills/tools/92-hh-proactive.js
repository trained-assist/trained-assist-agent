'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHmac } = require('crypto');
const { runProactiveSearch, buildScoringPromptText, buildProactiveDigest, loadSchedule, saveSchedule } = require('../../hh-proactive-search');

function proactiveHmac(username) {
  const secret = process.env.AGENT_SECRET || '';
  return createHmac('sha256', secret).update(username).digest('hex').slice(0, 16);
}

function proactiveUrl(username) {
  const base = (process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
  const token = proactiveHmac(username);
  return `${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${token}`;
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
      totalSeen: info.totalSeen,
      newCandidates: info.newCandidates,
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
          const url = proactiveUrl(userId);
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
      description: 'Настройка автоматического (периодического) проактивного поиска с Telegram-уведомлениями. action=status — текущие настройки; action=enable — включить (можно задать interval_hours, по умолчанию 24); action=disable — выключить.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'enable', 'disable'], description: 'status | enable | disable' },
          interval_hours: { type: 'number', description: 'Интервал запуска в часах (для action=enable, по умолчанию 24)' },
        },
        required: ['action'],
      },
      handler: async ({ action, interval_hours }) => {
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
          const nextRunTs = schedule.last_run
            ? new Date(new Date(schedule.last_run).getTime() + hours * 3600000).toISOString()
            : '~10 мин после старта сервера';
          return {
            enabled: true,
            interval_hours: hours,
            last_run: schedule.last_run || null,
            next_run: nextRunTs,
            message: `Автопоиск включён. Интервал: каждые ${hours} ч.\nПоследний запуск: ${schedule.last_run || 'ещё не было'}.\nСледующий: ${nextRunTs}.`,
          };
        }

        if (action === 'enable') {
          const hours = interval_hours && interval_hours > 0 ? interval_hours : (schedule.interval_hours || 24);
          schedule.enabled = true;
          schedule.interval_hours = hours;
          saveSchedule(userId, schedule);
          return {
            ok: true,
            enabled: true,
            interval_hours: hours,
            message: `✅ Автопоиск включён — каждые ${hours} ч агент будет искать новых кандидатов и присылать уведомления в Telegram. Первый запуск в течение 30 мин (при следующей плановой проверке).`,
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
