'use strict';
// Misha bot handler — direct Telegram webhook for @cmr_management_bot.
// Handles text, voice (Deepgram transcription), photos, /new_deal command.
// Extracted from server.js — pure code movement, no behaviour changes.

const fs = require('fs');
const path = require('path');
const { USERS_ROOT } = require('./data-paths');

// @cmr_management_bot delegates into the flexi-consult profile — same data,
// same sessions, same MCP skills. Config-driven so future narrow bots just add an entry.
const NARROW_BOTS = {
  misha: { profile: process.env.MISHA_PROFILE || 'flexi-consult' },
};

async function processMishaUpdate(update, botToken, secrets) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  // Delegate into the owning profile (flexi-consult), NOT a standalone "misha" profile.
  const username = NARROW_BOTS.misha.profile;
  const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

  async function tgSend(text) {
    return fetch(`${tgBase}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    }).then(r => r.json()).catch(() => null);
  }

  async function tgAction(action = 'typing') {
    return fetch(`${tgBase}/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
  }

  async function tgGetFile(fileId) {
    const r = await fetch(`${tgBase}/bot${botToken}/getFile?file_id=${fileId}`,
      { signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    return d.result?.file_path || null;
  }

  async function downloadTgFile(filePath, dest) {
    const url = `${tgBase}/file/bot${botToken}/${filePath}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`TG file download ${r.status}`);
    const buf = await r.arrayBuffer();
    fs.writeFileSync(dest, Buffer.from(buf), { mode: 0o600 });
    return dest;
  }

  async function deepgramTranscribe(audioPath) {
    if (!secrets.DEEPGRAM_API_KEY) return null;
    try {
      const audio = fs.readFileSync(audioPath);
      const r = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${secrets.DEEPGRAM_API_KEY}`,
            'Content-Type': 'audio/ogg',
          },
          body: audio,
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!r.ok) return null;
      const d = await r.json();
      return d.results?.channels?.[0]?.alternatives?.[0]?.transcript || null;
    } catch { return null; }
  }

  const workDir = path.join(USERS_ROOT, username);
  fs.mkdirSync(workDir, { recursive: true });
  const uploadsDir = path.join(workDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const text = msg.text || msg.caption || '';
  const cmd = text.split(/\s+/)[0]?.toLowerCase();

  let taskParts = [];
  let forceNewSession = false;
  let bindEventKey = null; // expo eventKey from a deep link → bind session to that project

  // /start — check for exhibition deep link parameter
  if (cmd === '/start') {
    const startParam = text.split(/\s+/)[1]; // e.g. "huntingexpo2026_deal_7603045501"
    if (startParam && startParam.includes('_deal_')) {
      const delimIdx = startParam.indexOf('_deal_');
      const eventKey = startParam.slice(0, delimIdx);
      const companyId = startParam.slice(delimIdx + 6);
      const isInn = /^\d{10,12}$/.test(companyId);
      bindEventKey = eventKey;
      forceNewSession = true;
      taskParts.push(`КОМАНДА: Выставочная сделка (deep link)
Выставка (eventKey): ${eventKey}
${isInn ? `ИНН компании: ${companyId}` : `ID/стенд компании: ${companyId}`}

Пользователь нажал "✈ Создать сделку" на выставочном сайте.

ВАЖНО: НЕ создавай сделку сразу! Сначала:
1. ${isInn ? `Найди компанию по ИНН ${companyId} через MCP tools.` : `Определи компанию по стенду "${companyId}" выставки "${eventKey}".`}
2. Покажи пользователю что нашёл: название компании, город, основную инфу.
3. Спроси: "Есть ли ещё информация? Визитка контакта, голосовое, имя менеджера?"
4. Подожди ответа пользователя. Когда скажет "Готово" или "Создавай" — тогда создай сделку в WEEEK с типом "3 Выставки" и источником на основе eventKey "${eventKey}".`);
    } else {
      await tgSend('Привет! Создаю сделки в WEEEK.\n\n/new_deal — новая сделка\n\nОтправь текст, визитку или голосовое.');
      return;
    }
  }

  // /help — Misha-specific help
  if (cmd === '/help') {
    await tgSend([
      '🤖 Команды:',
      '',
      '/new_deal — создать новую сделку',
      '   Отправь визитку, голосовое, текст — всё в одном потоке',
      '',
      '/sessions — мои диалоги',
      '/usage — расход токенов',
      '/secrets_list — подключённые сервисы',
      '/secrets_log — история обращений к данным',
      '/target_company_prompt — шаблон целевой компании',
      '/company_showcase_spec — спецификация карточки компании',
      '',
      'Или просто напиши что нужно сделать.',
    ].join('\n'));
    return;
  }

  // /target_company_prompt — Flexi target company classification rules
  if (cmd === '/target_company_prompt') {
    // Priority: new path > backward compat old path > flexi-consult shared > hardcoded
    const paths = [
      path.join(workDir, 'contexts', 'prompts', 'target_company_prompt.txt'),
      path.join(workDir, 'contexts', 'target_company_prompt.txt'),
      path.join(USERS_ROOT, 'flexi-consult', 'site-requirements-target.md'),
    ];
    let promptText = paths.reduce((acc, p) => acc || (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null), null);
    if (!promptText) {
      promptText = '⚡️ Flexi target rule:\nЦЕЛЕВАЯ (t:1): российский ПРОИЗВОДИТЕЛЬ И выручка 150млн–1млрд (любая прибыль) ИЛИ 1–5млрд при прибыли ≤100млн.\nПОЧТИ-ЦЕЛЕВАЯ (nt:1): производитель РФ, но выручка неизвестна / <150 / >5 млрд.';
    }
    await tgSend(promptText);
    return;
  }

  // /company_showcase_spec — how to display/present company cards
  if (cmd === '/company_showcase_spec') {
    const paths = [
      path.join(workDir, 'contexts', 'prompts', 'company_showcase_spec.txt'),
      path.join(workDir, 'contexts', 'company_showcase_spec.txt'),
      path.join(USERS_ROOT, 'flexi-consult', 'site-requirements-display.md'),
    ];
    let specText = paths.reduce((acc, p) => acc || (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null), null);
    if (!specText) {
      specText = '🏢 Карточка компании: название, город, выручка, прибыль, директор, сайт, ИНН. Пропускать пустые поля.';
    }
    await tgSend(specText);
    return;
  }

  // Generic slash commands (/sessions, /usage, /project, /persona, /get_webpass,
  // /secrets_list …) — the "narrow bot falls back to the ordinary agent" contract.
  // Route them through the same quick-answer engine the main bot uses so the narrow
  // bot answers them identically instead of forwarding raw "/sessions" text to Claude.
  if (cmd && cmd.startsWith('/') && cmd !== '/new_deal' && cmd !== '/start') {
    try {
      const { runQuickAnswer } = require('./runner');
      const reply = await runQuickAnswer(
        text, username, workDir, secrets.OPENROUTER_API_KEY || null,
        false, chatId, msg.from?.id || null
      );
      if (reply !== null && reply !== undefined) {
        await tgSend(typeof reply === 'string' ? reply : JSON.stringify(reply));
        return;
      }
    } catch (e) {
      console.error('[misha] quick-answer proxy error:', e.message);
    }
  }

  // /new_deal — clear session and start deal creation
  if (cmd === '/new_deal') {
    forceNewSession = true;
    taskParts.push('КОМАНДА: /new_deal\nНачни создание новой сделки. Попроси Мишу прислать всю информацию: визитку (фото), голосовое, текст с деталями компании. Скажи что он может присылать всё сразу, когда закончит — написать "Готово".');
  }

  // Voice message — transcribe with Deepgram
  if (msg.voice || msg.audio) {
    const fileId = (msg.voice || msg.audio).file_id;
    await tgAction('typing');
    try {
      const tgFilePath = await tgGetFile(fileId);
      if (tgFilePath) {
        const ext = tgFilePath.split('.').pop() || 'ogg';
        const localPath = path.join(uploadsDir, `voice_${Date.now()}.${ext}`);
        await downloadTgFile(tgFilePath, localPath);
        const transcript = await deepgramTranscribe(localPath);
        if (transcript) {
          taskParts.push(`[Голосовое сообщение]\n${transcript}`);
        } else {
          taskParts.push(`[Голосовое сообщение сохранено: ${localPath}]`);
        }
      }
    } catch (e) {
      console.error('[misha] voice download error:', e.message);
      taskParts.push('[Голосовое сообщение — ошибка скачивания]');
    }
  }

  // Photos — download highest resolution
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    await tgAction('upload_photo');
    try {
      const tgFilePath = await tgGetFile(photo.file_id);
      if (tgFilePath) {
        const ext = tgFilePath.split('.').pop() || 'jpg';
        const localPath = path.join(uploadsDir, `photo_${Date.now()}.${ext}`);
        await downloadTgFile(tgFilePath, localPath);
        taskParts.push(`[Фото сохранено: ${localPath}]`);
        if (text) taskParts.push(`Подпись: ${text}`);
      }
    } catch (e) {
      console.error('[misha] photo download error:', e.message);
    }
  }

  // Document
  if (msg.document) {
    try {
      const tgFilePath = await tgGetFile(msg.document.file_id);
      if (tgFilePath) {
        const fname = msg.document.file_name || `doc_${Date.now()}`;
        const localPath = path.join(uploadsDir, fname.replace(/[^a-zA-Z0-9._-]/g, '_'));
        await downloadTgFile(tgFilePath, localPath);
        taskParts.push(`[Документ сохранён: ${localPath}]`);
      }
    } catch (e) {
      console.error('[misha] document download error:', e.message);
    }
  }

  // Plain text
  if (text && cmd !== '/new_deal' && !msg.photo) {
    taskParts.push(text);
  }

  if (taskParts.length === 0) {
    await tgSend('Не понял формат. Попробуй /new_deal или отправь текст, голосовое или фото визитки.');
    return;
  }

  const task = taskParts.join('\n\n');
  const taskId = `misha-${Date.now()}`;

  const sentMsg = await tgSend('⏳ Думаю…');
  const initialMsgId = sentMsg?.result?.message_id || null;

  // Bind the session to the expo project matching the deep-link eventKey
  // (huntingexpo2026 → projects/expo-huntingexpo2026). Pre-setting the active project
  // makes the runner's project-binding block resolve cwd + PROFILE.md deterministically
  // to that exhibition instead of falling back to the most-recent project.
  let cwd = workDir;
  if (bindEventKey) {
    try {
      const projects = require('./projects');
      const projId = `expo-${bindEventKey}`;
      const dir = projects.projectDir(workDir, projId);
      if (fs.existsSync(dir)) {
        projects.setActiveProjectId(workDir, projId, chatId);
        cwd = dir;
      } else {
        console.warn(`[misha] no project for eventKey ${bindEventKey} (${projId})`);
      }
    } catch (e) {
      console.error('[misha] project bind error:', e.message);
    }
  }

  const user = {
    id: Number(chatId),
    name: username,
    username,
    workDir,
    cwd,
    telegramUserId: msg.from?.id || null,
  };
  const mishaSecrets = { ...secrets, BOT_TOKEN: botToken };

  const { runTask } = require('./runner');
  runTask({
    taskId,
    user,
    task,
    sessionId: forceNewSession ? `misha-deal-${Date.now()}` : null,
    forceClaude: false,
    initialMsgId,
    pinnedMsgId: null,
    secrets: mishaSecrets,
  }).catch(e => console.error(`[misha/${taskId}] runTask error:`, e.message));
}

module.exports = { processMishaUpdate };
