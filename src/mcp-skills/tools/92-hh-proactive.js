'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHmac } = require('crypto');
const { runProactiveSearch, buildScoringPromptText, buildProactiveDigest } = require('../../hh-proactive-search');

const USER_ID = process.env.USER_ID || process.env.AGENT_USER_ID || '';

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
  },
};
