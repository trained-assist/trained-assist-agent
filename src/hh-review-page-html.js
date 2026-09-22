'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildResumeText, resumeNotice } = require('./hh-resume');

const BASE_USERS_DIR = process.env.USERS_DIR ||
  path.join(process.env.HOME || '/home/vova', 'users');

// Generates the HH candidates review page HTML (moved from server.js, see issue #942 Phase 0).
function generateReviewPageHtml(negotiations, vacancyTitle, username, callbackBase, dataDir, opts = {}) {
  const { syncedAt, vacancyId, lastScoredAt, vacancies = [] } = opts;
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const candDir = path.join(dataDir || path.join(os.homedir(), 'agent-data'), 'hh', String(username), 'candidates');
  function readHistory(negId) {
    const file = path.join(candDir, `${negId}.json`);
    if (!fs.existsSync(file)) return { messages: [], ats_result: null };
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { messages: [], ats_result: null }; }
  }

  // Read ATS config version to validate cached drafts — must resolve the same way the
  // background scorer does (readAtsConfig: per-vacancy file first, legacy singleton
  // fallback), or a 2nd tracked vacancy's page would compare against vacancy A's
  // config version and wrongly invalidate every cached draft.
  let atsConfigVersion = null;
  try {
    const { readAtsConfig } = require('./hh-scoring');
    const workDir = path.join(BASE_USERS_DIR, String(username));
    const atsCfg = readAtsConfig(workDir, vacancyId);
    atsConfigVersion = atsCfg?.updated_at || null;
  } catch {}


  const candidates = negotiations.map(neg => {
    const r = neg.resume || {};
    const history = readHistory(neg.id);
    const ats = history.ats_result || null;
    const daysAgo = neg.updated_at ? Math.floor((Date.now() - new Date(neg.updated_at).getTime()) / 86400000) : null;
    return {
      negotiation_id: neg.id,
      neg_state: neg._state || 'response',
      first_name: r.first_name || '',
      name: [r.last_name, r.first_name].filter(Boolean).join(' ') || 'Кандидат',
      score: ats?.score ?? null,
      verdict: ats?.verdict ?? null,
      reasoning: ats?.reasoning ?? null,
      matched: ats?.matched || [],
      gaps: ats?.gaps || [],
      draft_message: (() => {
        const md = history.message_draft;
        if (md?.text && (!atsConfigVersion || md.config_version === atsConfigVersion)) return md.text;
        return ats?.draft_message ?? null;
      })(),
      days_since_activity: daysAgo,
      resume_text: buildResumeText(neg),
      resume_notice: resumeNotice(neg, ats),
      history_messages: history.messages || [],
      already_sent: (history.messages || []).some(m => m.role === 'employer'),
      needs_reply: (() => {
        // Use HH API as source of truth — local history can be out of sync
        // (messages written locally but not delivered via HH API)
        if (neg.counters?.unread_messages > 0) return true;
        if (neg.has_updates) return true;
        // ≤1 message in HH means only the candidate's cover letter, no reply from us
        if ((neg.counters?.messages || 0) <= 1) return true;
        // HH shows 2+ messages — check local history for last sender
        const msgs = history.messages || [];
        if (msgs.length > 0) {
          return msgs[msgs.length - 1].role !== 'employer';
        }
        return false;
      })(),
      alternate_url: r.alternate_url || null,
      salary: r.salary ? `${(r.salary.amount || '').toLocaleString?.() || r.salary.amount} ${r.salary.currency || ''}`.trim() : null,
      msg_from_candidate: (history.messages || []).filter(m => m.role === 'applicant').length,
      msg_from_us: (history.messages || []).filter(m => m.role === 'employer').length,
      last_msg_role: (() => {
        const msgs = history.messages || [];
        return msgs.length > 0 ? msgs[msgs.length - 1].role : null;
      })(),
    };
  });

  function sortCandidates(list) {
    return [...list].sort((a, b) => {
      if (a.score != null && b.score != null) return (b.score || 0) - (a.score || 0);
      if (a.score != null) return -1;
      if (b.score != null) return 1;
      return 0;
    });
  }

  const sorted = sortCandidates(candidates);
  const waitingCandidates = sortCandidates(candidates.filter(c => c.needs_reply));
  // We wrote, but the candidate has never replied
  const silentCandidates = sortCandidates(candidates.filter(c =>
    c.msg_from_us > 0 && c.msg_from_candidate === 0 && !c.needs_reply
  ));
  // No employer message at all — never initiated contact
  const noContactCandidates = sortCandidates(candidates.filter(c => c.msg_from_us === 0));
  // Both sides wrote; our reply is last and no action is pending
  const dialogCandidates = sortCandidates(candidates.filter(c =>
    c.msg_from_us > 0 && c.msg_from_candidate > 0 && c.last_msg_role === 'employer' && !c.needs_reply
  ));

  const colorMap = { 'ПРОПУСТИТЬ': '#16a34a', 'УТОЧНИТЬ': '#d97706', 'ОТКЛОНИТЬ': '#dc2626' };
  const bgMap = { 'ПРОПУСТИТЬ': '#f0fdf4', 'УТОЧНИТЬ': '#fffbeb', 'ОТКЛОНИТЬ': '#fef2f2' };
  const actionable = sorted.filter(c => c.verdict && c.verdict !== 'ОТКЛОНИТЬ').length;
  const agentSecret = process.env.AGENT_SECRET || '';
  const { createHmac } = require('crypto');
  const pageToken = agentSecret ? createHmac('sha256', agentSecret).update(String(username)).digest('hex').slice(0, 16) : '';

  const ageMin = syncedAt ? Math.round((Date.now() - syncedAt) / 60000) : null;
  const ageText = ageMin === null ? '' : ageMin === 0 ? 'только что' : `${ageMin} мин назад`;
  const scoredMin = lastScoredAt ? Math.round((Date.now() - lastScoredAt) / 60000) : null;
  const scoredText = scoredMin === null ? '' : scoredMin === 0 ? 'скоринг только что' : scoredMin < 60 ? `скоринг ${scoredMin} мин назад` : `скоринг ${Math.round(scoredMin/60)} ч назад`;

  let nextCardIndex = 0;
  function buildCardsHtml(list) {
    return list.map(c => {
      const i = nextCardIndex++;
    const hasScore = c.score != null;
    const col = colorMap[c.verdict] || '#94a3b8';
    const bg = bgMap[c.verdict] || '#fff';
    const scorePct = hasScore ? Math.round((c.score || 0) * 10) : 0;

    const matched = (c.matched || []).map(m => `<span class="tag tag-ok">${esc(m)}</span>`).join('');
    const gaps = (c.gaps || []).map(g => `<span class="tag tag-gap">${esc(g)}</span>`).join('');
    const daysNote = c.days_since_activity != null ? `<span class="meta"> · активность ${c.days_since_activity}д назад</span>` : '';

    const histMsgs = c.history_messages || [];
    const histSection = histMsgs.length === 0
      ? '<div class="hist-none">💬 Первое сообщение — переписки ещё не было</div>'
      : `<details class="hist-details"><summary class="hist-summary">📨 История диалога (${histMsgs.length} сообщ.)</summary>
           <div class="hist-thread">${histMsgs.map(m => `
             <div class="hist-msg hist-${esc(m.role || 'employer')}">
               <span class="hist-who">${m.role === 'employer' ? 'Рекрутер' : 'Кандидат'}</span>
               <span class="hist-time">${(m.timestamp || '').slice(0, 10)}</span>
               <div class="hist-text">${esc(m.text || '')}</div>
             </div>`).join('')}
           </div></details>`;

    const resumeSection = c.resume_text
      ? `<p class="resume-status">${esc(c.resume_notice)}</p><details class="resume-details"><summary class="resume-summary">📄 Резюме (текст)</summary>
           <pre class="resume-text">${esc(c.resume_text)}</pre>
         </details>`
      : '';

    const isActionable = c.verdict && c.verdict !== 'ОТКЛОНИТЬ';
    const isReject = c.verdict === 'ОТКЛОНИТЬ';

    const checkboxHtml = (isReject ? '' : `<label><input type="checkbox" class="card-cb" id="cb-${i}" data-idx="${i}" data-score="${(c.score || 0).toFixed(1)}" ${isActionable ? 'checked' : ''} onchange="onCheck()"> Отправить</label>`)
      + `<label><input type="checkbox" class="reject-cb" id="reject-cb-${i}" data-idx="${i}" data-score="${(c.score || 0).toFixed(1)}" onchange="onCheck()"> Отказать</label>`;

    const scoreHtml = hasScore
      ? `<div class="score-wrap">
           <div class="score-bar"><div class="score-fill" style="width:${scorePct}%;background:${col}"></div></div>
           <span class="score-num" style="color:${col}">${(c.score || 0).toFixed(1)}/10</span>
           <span class="verdict-badge" style="background:${col}">${esc(c.verdict)}</span>
         </div>`
      : '<span class="verdict-none">не оценён</span>';

    const hhBtn = c.alternate_url
      ? ` <a href="${esc(c.alternate_url)}" target="_blank" rel="noopener" class="hh-link-btn" title="Открыть резюме на HH">↗ HH</a>`
      : '';
    const profileToken = agentSecret
      ? require('crypto').createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16)
      : '';
    const profileBtn = ` <a href="${esc(callbackBase)}/hh/candidate?neg_id=${esc(c.negotiation_id)}&username=${esc(username)}&token=${profileToken}" target="_blank" class="hh-link-btn" title="Открыть профиль кандидата">👤 Профиль</a>`;
    const nameHtml = `${esc(c.name)}${hhBtn}${profileBtn}`;

    const hasDraft = !!c.draft_message;
    const msgLabel = c.already_sent ? 'Follow-up (уже писали)' : hasDraft ? 'Черновик сообщения' : 'Сообщение';
    const msgMeta = (c.msg_from_candidate || c.msg_from_us)
      ? `<div class="msg-meta">${c.msg_from_candidate} от кандидата · ${c.msg_from_us} от нас</div>`
      : '';
    const msgSection = isReject
      ? `<div class="msg-section">
           ${msgMeta}
           ${c.already_sent ? '<span class="meta">Контакт начат</span>' : ''}
           <div class="msg-label-row">
             <label class="msg-label" style="color:#dc2626">Сообщение об отказе</label>
             <button class="btn btn-gen" id="gen-${i}" onclick="generateRejection(${i},'${esc(c.negotiation_id)}','${esc(c.name)}')" title="Сгенерировать отказное сообщение">✦ Сгенерировать отказ</button>
           </div>
           <textarea class="msg-area" id="msg-${i}" rows="4">${hasDraft ? esc(c.draft_message) : ''}</textarea>
           <div class="btns">
             <button class="btn btn-send-reject" onclick="rejectWithMessage(${i},'${esc(c.negotiation_id)}')">✗ Отправить отказ</button>
             <button class="btn-copy" onclick="copyMsg(${i})">📋 Копировать</button>
             <button class="btn btn-skip" onclick="skipOne(${i})">Пропустить</button>
           </div>
         </div>`
      : `<div class="msg-section">
           ${msgMeta}
           ${c.already_sent ? '<span class="meta">Контакт начат</span>' : ''}
           <div class="msg-label-row">
             <label class="msg-label">${msgLabel}</label>
             <button class="btn btn-gen" id="gen-${i}" data-idx="${i}" data-negid="${esc(c.negotiation_id)}" data-name="${esc(c.name)}" data-sent="${c.already_sent ? '1' : '0'}" onclick="generateOne(${i},'${esc(c.negotiation_id)}','${esc(c.name)}',${!!c.already_sent})" title="Сгенерировать черновик">✦ Сгенерировать</button>
           </div>
           <textarea class="msg-area" id="msg-${i}" rows="5">${hasDraft ? esc(c.draft_message) : ''}</textarea>
           <div class="btns">
             <button class="btn btn-send" onclick="sendOne(${i},'${esc(c.negotiation_id)}')">✓ Отправить</button>
             <button class="btn-copy" onclick="copyMsg(${i})">📋 Копировать</button>
             <button class="btn btn-skip" onclick="skipOne(${i})">✗ Пропустить</button>
             <button class="btn btn-send-reject" onclick="rejectWithMessage(${i},'${esc(c.negotiation_id)}')">🚫 Отказать</button>
           </div>
         </div>`;

    const salaryNote = c.salary ? `<span class="meta"> · зп ${esc(c.salary)}</span>` : '';
    return `<div class="card" id="card-${i}" data-score="${hasScore ? (c.score || 0).toFixed(1) : '0'}" data-neg="${esc(c.negotiation_id)}" data-first-name="${esc(c.first_name)}" style="background:${bg};border-left:4px solid ${col}">
  <div class="card-header">
    <div class="card-header-left">
      ${checkboxHtml}
      <div>
        <span class="name">${nameHtml}</span>
        ${daysNote}${salaryNote}
      </div>
    </div>
    ${scoreHtml}
  </div>
  ${c.reasoning ? `<p class="reasoning">${esc(c.reasoning)}</p>` : ''}
  ${matched || gaps ? `<div class="tags">${matched}${gaps}</div>` : ''}
  ${histSection}
  ${resumeSection}
  ${msgSection}
</div>`;
    });
  }

  const waitingCardsHtml = buildCardsHtml(waitingCandidates);
  const silentCardsHtml = buildCardsHtml(silentCandidates);
  const noContactCardsHtml = buildCardsHtml(noContactCandidates);
  const dialogCardsHtml = buildCardsHtml(dialogCandidates);
  const allCardsHtml = buildCardsHtml(sorted);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ревью кандидатов — ${esc(vacancyTitle)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b;padding:24px 24px 96px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
.subtitle{color:#64748b;font-size:14px;margin-bottom:16px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.toolbar-label{font-size:13px;color:#64748b;margin-right:4px}
.tb-btn{padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;background:#fff;color:#475569;transition:background .15s,color .15s}
.tb-btn:hover,.tb-btn.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.tb-sep{width:1px;height:20px;background:#e2e8f0;margin:0 4px}
.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);transition:opacity .3s}
.card.done{opacity:.4;pointer-events:none}
.card.skipped{opacity:.35;pointer-events:none}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:10px}
.card-header-left{display:flex;align-items:flex-start;gap:10px}
.card-cb,.reject-cb{width:18px;height:18px;margin-top:2px;cursor:pointer;flex-shrink:0}
.card-cb{accent-color:#4f46e5}
.reject-cb{accent-color:#dc2626}
.name{font-size:17px;font-weight:600}
.resume-link{color:inherit;text-decoration:none}
.resume-link:hover{text-decoration:underline}
.hh-link-btn{display:inline-block;margin-left:8px;padding:2px 8px;font-size:12px;font-weight:600;color:#d6001c;border:1px solid #d6001c;border-radius:4px;text-decoration:none;vertical-align:middle;opacity:.85}
.hh-link-btn:hover{opacity:1;background:#fff5f5}
.meta{font-size:12px;color:#94a3b8}
.score-wrap{display:flex;align-items:center;gap:8px;flex-shrink:0}
.score-bar{width:80px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden}
.score-fill{height:100%;border-radius:3px;transition:width .4s}
.score-num{font-size:14px;font-weight:600;min-width:38px}
.verdict-badge{font-size:12px;font-weight:700;color:#fff;padding:3px 8px;border-radius:99px;white-space:nowrap}
.verdict-none{font-size:12px;color:#94a3b8;font-style:italic}
.reasoning{font-size:13px;color:#475569;line-height:1.5;margin-bottom:10px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.tag{font-size:12px;padding:2px 8px;border-radius:4px;font-weight:500}
.tag-ok{background:#dcfce7;color:#15803d}
.tag-gap{background:#fee2e2;color:#b91c1c}
.msg-section{border-top:1px solid #e2e8f0;padding-top:12px;margin-top:8px}
.msg-label-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.msg-label{font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em}
.btn-gen{font-size:11px;padding:3px 8px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;color:#475569;font-weight:500}
.btn-gen:hover:not(:disabled){background:#e2e8f0}
.btn-gen:disabled{opacity:.5;cursor:not-allowed}
.msg-area.generating{background:repeating-linear-gradient(90deg,#f1f5f9 0%,#e2e8f0 50%,#f1f5f9 100%);background-size:200% 100%;animation:shimmer 1.4s infinite linear;opacity:.7}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.msg-area{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:14px;line-height:1.5;font-family:inherit;resize:vertical;min-height:80px}
.msg-area:focus{outline:none;border-color:#6366f1}
.btns{display:flex;gap:8px;margin-top:8px}
.btn{padding:8px 18px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.85}
.btn-send{background:#16a34a;color:#fff}
.btn-send-reject{background:#dc2626;color:#fff}
.btn-skip{background:#e2e8f0;color:#475569}
.reject-note{font-size:13px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px;font-style:italic}
.hist-none{font-size:12px;color:#94a3b8;margin:8px 0 4px;font-style:italic}
.hist-details,.resume-details{margin:8px 0 4px}
.hist-summary,.resume-summary{font-size:12px;font-weight:600;color:#64748b;cursor:pointer;padding:4px 0;user-select:none}
.hist-thread{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.hist-msg{padding:8px 10px;border-radius:8px;font-size:13px}
.hist-employer{background:#eff6ff;border-left:3px solid #3b82f6}
.hist-applicant{background:#f0fdf4;border-left:3px solid #22c55e}
.hist-who{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-right:8px}
.hist-time{font-size:11px;color:#94a3b8}
.hist-text{margin-top:4px;white-space:pre-wrap;line-height:1.4}
.resume-text{font-size:12px;white-space:pre-wrap;font-family:inherit;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-top:8px;line-height:1.5;max-height:300px;overflow-y:auto;color:#334155}
.footer{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #e2e8f0;padding:12px 24px;display:flex;align-items:center;gap:16px;box-shadow:0 -2px 8px rgba(0,0,0,.08)}
.counter{font-size:14px;color:#475569;flex:1}
.counter strong{color:#1e293b}
.btn-send-all{background:#4f46e5;color:#fff;padding:9px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-send-all:disabled{opacity:.4;cursor:not-allowed}
.btn-send-all:not(:disabled):hover{opacity:.85}
.btn-reject-all{background:#dc2626;color:#fff;padding:9px 22px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-reject-all:disabled{opacity:.4;cursor:not-allowed}
.btn-reject-all:not(:disabled):hover{opacity:.85}
.toast{position:fixed;top:20px;right:20px;padding:10px 18px;border-radius:8px;background:#16a34a;color:#fff;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);animation:fadein .2s}
.toast-err{background:#dc2626}
@keyframes fadein{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
@media(max-width:640px){
body{padding:12px 12px 100px}
h1{font-size:18px}
.card{padding:14px}
.card-header{flex-direction:column;gap:8px}
.score-wrap{flex-direction:row;align-self:flex-start}
.footer{padding:10px 12px;flex-wrap:wrap;gap:8px}
.counter{width:100%;font-size:13px}
.btn-reject-all,.btn-send-all{flex:1;padding:10px 12px;font-size:13px}
.btns{flex-wrap:wrap}
.btn{flex:1;min-width:120px;text-align:center}
.toolbar{gap:5px}
.tb-btn{padding:5px 8px;font-size:12px}
.msg-area{font-size:13px}
}
.sync-btn{background:none;border:none;color:#6366f1;font-size:13px;cursor:pointer;font-weight:500;padding:0;text-decoration:underline;text-underline-offset:2px}
.sync-btn:hover{opacity:.75}
.sync-btn:disabled{opacity:.5;cursor:not-allowed;text-decoration:none}
.vacancy-tabs{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}
.vacancy-tab{padding:6px 14px;border:1px solid #c7d2fe;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none;color:#4f46e5;background:#eef2ff}
.vacancy-tab.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.tabs{display:flex;gap:4px;margin-bottom:20px}
.tab-btn{padding:6px 16px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;background:#fff;color:#64748b;transition:all .15s}
.tab-btn.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.tab-panel{display:none}
.tab-panel.active{display:block}
.msg-meta{font-size:12px;color:#94a3b8;margin-bottom:6px}
.btn-copy{background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;font-weight:500;padding:6px 12px;cursor:pointer}
.btn-copy:hover{background:#e2e8f0}
</style>
</head>
<body>
<h1>Кандидаты: ${esc(vacancyTitle)}</h1>
${vacancies.length > 1 ? `<div class="vacancy-tabs">${vacancies.map(v => {
  const href = `${esc(callbackBase)}/hh/review?username=${esc(username)}&token=${pageToken}&vacancy_id=${esc(v.id)}`;
  const isActive = String(v.id) === String(vacancyId);
  return `<a class="vacancy-tab${isActive ? ' active' : ''}" href="${href}">${esc(v.title || v.id)}</a>`;
}).join('')}</div>` : ''}
<p class="subtitle">${sorted.length} откликов · ${waitingCandidates.length} ждут ответа${ageText ? ` · обновлено ${ageText}` : ''}${scoredText ? ` · ${scoredText}` : ''} · <button class="sync-btn" id="syncBtn" onclick="syncNow()">↻ Обновить</button></p>
<div class="toolbar">
  <span class="toolbar-label">Балл:</span>
  <button class="tb-btn score-btn" data-bucket="10" onclick="toggleBucket(10)">10</button>
  <button class="tb-btn score-btn" data-bucket="9" onclick="toggleBucket(9)">9</button>
  <button class="tb-btn score-btn" data-bucket="8" onclick="toggleBucket(8)">8</button>
  <button class="tb-btn score-btn" data-bucket="7" onclick="toggleBucket(7)">7</button>
  <button class="tb-btn score-btn" data-bucket="6" onclick="toggleBucket(6)">6</button>
  <button class="tb-btn score-btn" data-bucket="5" onclick="toggleBucket(5)">5</button>
  <button class="tb-btn score-btn" data-bucket="4" onclick="toggleBucket(4)">4</button>
  <button class="tb-btn score-btn" data-bucket="3" onclick="toggleBucket(3)">3</button>
  <button class="tb-btn score-btn" data-bucket="2" onclick="toggleBucket(2)">2</button>
  <button class="tb-btn score-btn" data-bucket="1" onclick="toggleBucket(1)">1</button>
  <div class="tb-sep"></div>
  <button class="tb-btn" onclick="selectAll(true)">✓ Выбрать все</button>
  <button class="tb-btn" onclick="selectAll(false)">✗ Снять все</button>
</div>
<div class="tabs">
  <button class="tab-btn active" onclick="switchTab('waiting',this)">🔴 Неотвеченные (${waitingCandidates.length})</button>
  <button class="tab-btn" onclick="switchTab('silent',this)">😴 Молчат (${silentCandidates.length})</button>
  <button class="tab-btn" onclick="switchTab('nocontact',this)">📭 Ещё не писали (${noContactCandidates.length})</button>
  <button class="tab-btn" onclick="switchTab('dialog',this)">💬 Диалог (${dialogCandidates.length})</button>
  <button class="tab-btn" onclick="switchTab('all',this)">📨 Все (${sorted.length})</button>
</div>
<div id="tab-waiting" class="tab-panel active">
  ${waitingCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Все отвечено — нет кандидатов, ожидающих ответа.</p>' : waitingCardsHtml.join('')}
</div>
<div id="tab-silent" class="tab-panel">
  ${silentCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Нет кандидатов, которым написали но они не ответили.</p>' : silentCardsHtml.join('')}
</div>
<div id="tab-nocontact" class="tab-panel">
  ${noContactCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Всем кандидатам уже написали.</p>' : noContactCardsHtml.join('')}
</div>
<div id="tab-dialog" class="tab-panel">
  ${dialogCardsHtml.length === 0 ? '<p style="color:#94a3b8;padding:24px;text-align:center">Нет активных диалогов без ожидающих ответов.</p>' : dialogCardsHtml.join('')}
</div>
<div id="tab-all" class="tab-panel">
  ${allCardsHtml.join('')}
</div>
<div class="footer">
  <div class="counter">Отправить: <strong id="selCount">0</strong> · Отказать: <strong id="rejCount">0</strong> · Готово: <strong id="sentCount">0</strong></div>
  <button class="btn-reject-all" id="regenAllBtn" onclick="regenerateAll()">🔄 Перегенерировать все черновики</button>
  <button class="btn-reject-all" id="rejectAllBtn" onclick="rejectAll()" disabled>Отказать (0)</button>
  <button class="btn-send-all" id="sendAllBtn" onclick="sendAll()" disabled>Отправить (0)</button>
</div>
<script>
const CALLBACK_BASE = '${callbackBase}';
const HH_USER = '${esc(username)}';
const HH_SECRET = '${esc(agentSecret)}';
const HH_VACANCY_ID = '${esc(String(vacancyId || ''))}';
const done = new Set();

function switchTab(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  btn.classList.add('active');
  onCheck();
}

function copyMsg(i) {
  const ta = document.getElementById('msg-' + i);
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).then(() => showToast('📋 Скопировано')).catch(() => {
    ta.select(); document.execCommand('copy'); showToast('📋 Скопировано');
  });
}

async function syncNow() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true; btn.textContent = '↻ Обновляю…';
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/sync-negotiations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HH_USER, vacancy_id: HH_VACANCY_ID }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    location.reload();
  } catch(e) {
    showToast('❌ Ошибка обновления: ' + e.message, true);
    btn.disabled = false; btn.textContent = '↻ Обновить';
  }
}

function showToast(msg, isError) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' toast-err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

async function hhAction(endpoint, payload) {
  const controller = new AbortController();
  const timer = endpoint === '/hh/send-and-reject' ? setTimeout(() => controller.abort(), 60000) : null;
  try {
    const r = await fetch(CALLBACK_BASE + endpoint, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HH_SECRET },
      body: JSON.stringify({ username: HH_USER, ...payload }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  } catch(e) {
    if (e.name === 'AbortError' || e instanceof TypeError || e instanceof SyntaxError) {
      throw new Error('Не удалось получить подтверждение. Запрос мог выполниться — проверьте переписку и статус на HH перед повтором.');
    }
    throw e;
  } finally { clearTimeout(timer); }
}

function onCheck() {
  const ns = document.querySelectorAll('.tab-panel.active .card-cb:checked').length;
  const nr = document.querySelectorAll('.tab-panel.active .reject-cb:checked').length;
  document.getElementById('selCount').textContent = ns;
  document.getElementById('rejCount').textContent = nr;
  const sb = document.getElementById('sendAllBtn');
  sb.textContent = 'Отправить (' + ns + ')'; sb.disabled = ns === 0;
  const rb = document.getElementById('rejectAllBtn');
  rb.textContent = 'Отказать (' + nr + ')'; rb.disabled = nr === 0;
}

const activeBuckets = new Set();
function toggleBucket(n) {
  const btn = document.querySelector('.score-btn[data-bucket="'+n+'"]');
  if (activeBuckets.has(n)) { activeBuckets.delete(n); btn.classList.remove('active'); }
  else { activeBuckets.add(n); btn.classList.add('active'); }
  document.querySelectorAll('.tab-panel.active .card-cb').forEach(cb => {
    if (done.has(parseInt(cb.dataset.idx))) return;
    const bucket = Math.floor(parseFloat(cb.dataset.score || 0));
    cb.checked = activeBuckets.has(bucket);
  });
  onCheck();
}

function selectAll(checked) {
  document.querySelectorAll('.tab-panel.active .card-cb').forEach(cb => {
    if (!done.has(parseInt(cb.dataset.idx))) cb.checked = checked;
  });
  activeBuckets.clear();
  document.querySelectorAll('.score-btn').forEach(b => b.classList.remove('active'));
  onCheck();
}

function markDone(i) {
  const negId = document.getElementById('card-'+i).dataset.neg;
  document.querySelectorAll('.card').forEach(card => {
    if (card.dataset.neg !== negId) return;
    done.add(Number(card.id.slice(5)));
    card.classList.add('done');
    card.querySelectorAll('input[type=checkbox], button').forEach(el => { el.checked = false; el.disabled = true; });
  });
  document.getElementById('sentCount').textContent = new Set([...document.querySelectorAll('.card.done')].map(card => card.dataset.neg)).size;
}

async function regenerateAll() {
  const btn = document.getElementById('regenAllBtn');
  const targets = Array.from(document.querySelectorAll('.tab-panel.active .btn-gen[data-negid]'))
    .filter(b => !b.disabled && !done.has(parseInt(b.dataset.idx)));
  if (!targets.length) { showToast('Нечего перегенерировать'); return; }
  const total = targets.length;
  let finished = 0;
  btn.disabled = true;
  btn.textContent = '⏳ 0/' + total + '…';
  const CONCURRENCY = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const b = targets[cursor++];
      try {
        await generateOne(parseInt(b.dataset.idx), b.dataset.negid, b.dataset.name, b.dataset.sent === '1');
      } catch (e) { /* generateOne already surfaces its own error state */ }
      finished++;
      btn.textContent = '⏳ ' + finished + '/' + total + '…';
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  btn.disabled = false;
  btn.textContent = '🔄 Перегенерировать все черновики';
  showToast('✅ Перегенерировано: ' + finished + '/' + total);
}

async function generateOne(i, negId, candidateName, alreadySent) {
  const btn = document.getElementById('gen-'+i);
  const ta = document.getElementById('msg-'+i);
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  if (ta) { ta.classList.add('generating'); ta.placeholder = '⏳ Генерирую...'; }
  try {
    const resumeEl = document.querySelector('#card-'+i+' pre.resume-text');
    const resumeText = resumeEl?.textContent || '';
    const data = await hhAction('/hh/generate-message', {
      negotiation_id: negId,
      candidate_name: candidateName,
      resume_text: resumeText,
      already_sent: alreadySent,
    });
    if (ta) { ta.value = data.message || ''; ta.classList.remove('generating'); ta.placeholder = ''; }
    if (btn) { btn.disabled = false; btn.textContent = '✦ Переписать'; }
    if (data.guard_warning) showToast('⚠️ Черновик после перегенерации всё ещё под вопросом: ' + data.guard_warning, true);
  } catch(e) {
    if (ta) { ta.classList.remove('generating'); ta.placeholder = ''; }
    if (btn) { btn.disabled = false; btn.textContent = '✦ Сгенерировать'; }
  }
}

function generateRejection(i) {
  const ta = document.getElementById('msg-' + i);
  if (ta) ta.value = standardRejection(i);
}

const rejecting = new Set();
function rejectionStatus(negId, text, busy) {
  document.querySelectorAll('.card').forEach(card => {
    if (card.dataset.neg !== negId) return;
    let status = card.querySelector('.rejection-status');
    if (!status) {
      status = document.createElement('p');
      status.className = 'rejection-status';
      status.setAttribute('role', 'status');
      card.appendChild(status);
    }
    status.textContent = text;
    card.querySelectorAll('button, input[type=checkbox], textarea').forEach(el => {
      el.disabled = busy || card.classList.contains('done');
      if (busy && el.type === 'checkbox') el.checked = false;
    });
  });
}

async function sendAndRejectOne(i, negId, force) {
  if (done.has(i) || rejecting.has(negId)) return;
  const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
  if (!msg) return;
  rejecting.add(negId);
  rejectionStatus(negId, '⏳ Отправляем отказ. Дождитесь результата…', true);
  onCheck();
  try {
    const data = await hhAction('/hh/send-and-reject', { negotiation_id: negId, message: msg, force: !!force });
    if (data.blocked) {
      rejecting.delete(negId);
      rejectionStatus(negId, 'Отказ не отправлен: ' + (data.reason || 'сообщение заблокировано'), false);
      if (confirm('🚫 Guard: ' + (data.reason || 'сообщение заблокировано') + '\\n\\nВсё равно отправить?')) {
        return await sendAndRejectOne(i, negId, true);
      }
      return;
    }
    if (!data.ok) throw new Error(data.error || 'Результат отказа не подтверждён. Проверьте HH перед повтором.');
    markDone(i); onCheck();
    rejectionStatus(negId, '✅ Сообщение отправлено. Кандидат переведён в отказ на HH.', true);
  } catch(e) {
    rejectionStatus(negId, '⚠️ ' + e.message, false);
  } finally {
    rejecting.delete(negId);
  }
}

async function autoGenerate() {
  const allGenBtns = [...document.querySelectorAll('[id^="gen-"]')];
  const emptyBtns = allGenBtns.filter(btn => {
    const i = btn.id.replace('gen-', '');
    const ta = document.getElementById('msg-'+i);
    return ta && !ta.value.trim();
  });
  if (emptyBtns.length === 0) return;
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < emptyBtns.length) {
      const btn = emptyBtns[idx++];
      btn.click();
      await new Promise(r => setTimeout(r, 50));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, emptyBtns.length) }, worker));
}

async function sendOne(i, negId, force) {
  const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
  if (!msg) { showToast('Сообщение пустое', true); return; }
  const btn = event?.currentTarget;
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  try {
    const data = await hhAction('/hh/send', { negotiation_id: negId, message: msg, force: !!force });
    if (data.blocked) {
      if (btn) { btn.disabled = false; btn.textContent = '✓ Отправить'; }
      if (confirm('🚫 Guard: ' + (data.reason || 'сообщение заблокировано') + '\\n\\nЭто ты лично проверяешь и отправляешь — всё равно отправить?')) {
        return sendOne(i, negId, true);
      }
      return;
    }
    markDone(i); onCheck(); showToast('✅ Отправлено!');
  } catch(e) {
    showToast('❌ ' + e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '✓ Отправить'; }
  }
}

function skipOne(i) {
  done.add(i);
  document.getElementById('card-'+i).classList.add('skipped');
  document.querySelectorAll('#card-'+i+' input[type=checkbox]').forEach(cb => { cb.checked = false; cb.disabled = true; });
  onCheck();
}

async function sendAll() {
  const cbs = [...document.querySelectorAll('.tab-panel.active .card-cb:checked')];
  const sb = document.getElementById('sendAllBtn');
  sb.disabled = true; sb.textContent = '⏳ Отправляю...';
  let ok = 0;
  for (const cb of cbs) {
    const i = parseInt(cb.dataset.idx);
    const negId = document.getElementById('card-'+i)?.dataset.neg || '';
    const msg = document.getElementById('msg-'+i)?.value?.trim() || '';
    if (!msg) continue;
    try {
      const d = await hhAction('/hh/send', { negotiation_id: negId, message: msg });
      if (d.blocked) { showToast('🚫 Guard: ' + (d.reason || 'заблокировано'), true); continue; }
      markDone(i); ok++;
    } catch(e) { showToast('❌ ' + e.message, true); }
  }
  onCheck();
  if (ok > 0) showToast('✅ Отправлено ' + ok + ' сообщений');
}

function standardRejection(i) {
  const name = document.getElementById('card-' + i)?.dataset.firstName?.trim();
  return (name ? name + ', здравствуйте! ' : 'Здравствуйте! ') +
    'Спасибо за отклик и уделённое время. Мы изучили ваше резюме и решили продолжить с другими кандидатами. Желаем успехов в поиске работы!';
}

async function rejectWithMessage(i, negId) {
  if (done.has(i) || rejecting.has(negId)) return;
  const ta = document.getElementById('msg-' + i);
  if (!ta) return;
  ta.value = standardRejection(i);
  if (!confirm('Отправить отказ кандидату со следующим сообщением?\\n\\n' + ta.value)) return;
  return sendAndRejectOne(i, negId);
}

async function rejectAll() {
  const cbs = [...document.querySelectorAll('.tab-panel.active .reject-cb:checked')];
  const negIds = cbs.map(cb => document.getElementById('card-'+parseInt(cb.dataset.idx))?.dataset.neg || '').filter(Boolean);
  if (!negIds.length || !confirm('Отказать на HH без сообщения: ' + negIds.length + ' кандидатов?')) return;
  const rb = document.getElementById('rejectAllBtn');
  rb.disabled = true; rb.textContent = '⏳ Отклоняю...';
  try {
    const res = await hhAction('/hh/reject', { negotiation_ids: negIds });
    const succeeded = new Set((res.results || []).filter(r => r.ok).map(r => r.negotiation_id));
    cbs.forEach(cb => {
      const i = parseInt(cb.dataset.idx);
      if (succeeded.has(document.getElementById('card-'+i)?.dataset.neg)) markDone(i);
    });
    onCheck();
    const failed = negIds.filter(id => !succeeded.has(id)).length;
    showToast(failed ? '⚠️ ' + failed + ' ошибок из ' + negIds.length : '✅ Отклонено ' + negIds.length + ' кандидатов');
  } catch(e) {
    showToast('❌ ' + e.message, true);
    rb.disabled = false; rb.textContent = 'Отказать (' + negIds.length + ')';
  }
}

onCheck();
</script>
</body>
</html>`;
}

module.exports = { generateReviewPageHtml };
