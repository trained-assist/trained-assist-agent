const http = require('node:http');
const assert = require('node:assert/strict');

const draft = {
  name: 'Сварщик НАКС, вахта 60/30', description_md: 'Сварка металлоконструкций. НАКС. Вахта 60/30, проживание и проезд оплачены.',
  area_name: 'Москва', salary_from: 180000, salary_to: 220000, salary_currency: 'RUR', salary_gross: false,
  experience: 'between3And6', employment: 'full', schedule: 'flyInFlyOut',
  professional_role_name: 'Сварщик', key_skills: ['Сварка', 'НАКС'],
};

function providers() {
  const state = { calls: [], unexpected: [], messages: {}, telegram: [], vacancies: [], drafts: [], negotiations: [], faults: {}, oauthCodes: new Set(), llmPrompts: [] };
  const resume = id => ({
    id: 'resume-' + id, first_name: id === '1' ? 'Сергей' : 'Иван', last_name: 'Демо', title: 'Сварщик',
    alternate_url: 'https://hh.ru/resume/resume-' + id, total_experience: { months: 72 },
    skills: 'Полный текст: готовность к вахте 60/30.', skill_set: ['Сварка', 'НАКС'],
    experience: [{ company: 'Последний работодатель', position: 'Монтажник', start: '2024-01-01', end: null, description: 'Монтаж.' },
      { company: 'Ранний работодатель', position: 'Сварщик', start: '2019-01-01', end: '2023-12-01', description: 'НАКС подтвержден. FULL-RESUME-END-' + id }],
    education: { primary: [{ name: 'Колледж сварки', year: 2018 }] },
  });
  state.addResponse = id => {
    const full = resume(id);
    state.negotiations.push({ id, vacancy_id: 'vac-1', state: { id: 'response', name: 'Отклик' },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      resume: { ...full, skills: undefined, experience: full.experience.slice(0, 1) },
      counters: { messages: 0 }, actions: [] });
  };
  state.publishDraft = () => {
    assert.equal(state.drafts.length, 1, 'Publication requires the draft created by the application');
    state.vacancies = [{ id: 'vac-1', name: state.drafts[0].name, area: { id: '1', name: 'Москва' },
      description: draft.description_md, manager: { id: 'mgr-1', full_name: 'Демо Рекрутер' }, counters: { responses: 2 } }];
    state.addResponse('1'); state.addResponse('2');
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const u = new URL(req.url, 'http://local');
    // Some production HTTP clients accept an origin while fetch clients retain /hh.
    if (/^\/(me|resumes|vacancies|employers|negotiations|professional_roles)(\/|$)/.test(u.pathname)) u.pathname = '/hh' + u.pathname;
    let body = raw;
    if (raw) body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const key = req.method + ' ' + u.pathname;
    state.calls.push({ key, query: Object.fromEntries(u.searchParams), body });
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(code === 204 ? '' : JSON.stringify(data)); };
    const fail = detail => { state.unexpected.push({ key, detail }); send(500, { error: detail }); };
    const paginate = items => {
      const page = Number(u.searchParams.get('page') || 0), per_page = Number(u.searchParams.get('per_page') || 20);
      return { items: items.slice(page * per_page, (page + 1) * per_page), found: items.length, page, per_page, pages: Math.ceil(items.length / per_page) };
    };
    try {
      if (key === 'GET /demo/draft') {
        assert.equal(state.drafts.length, 1);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h1>Демо HH: ' + state.drafts[0].name + '</h1><form method="post" action="/demo/publish"><button>Опубликовать демо-вакансию</button></form>');
      }
      if (key === 'POST /demo/publish') {
        if (!state.vacancies.length) state.publishDraft();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h1>Опубликовано: vac-1</h1>');
      }
      if (u.pathname.startsWith('/telegram/')) {
        const method = u.pathname.split('/').pop();
        if (!['sendMessage', 'editMessageText', 'pinChatMessage', 'editMessageReplyMarkup', 'deleteMessage', 'sendChatAction', 'answerCallbackQuery'].includes(method)) return fail('Unknown Telegram method');
        state.telegram.push({ method, body });
        return send(200, { ok: true, result: { message_id: state.telegram.length, chat: { id: body.chat_id }, text: body.text } });
      }
      if (key === 'POST /oauth/oauth/token') {
        assert.equal(body.grant_type, 'authorization_code');
        assert.equal(body.client_id, 'demo-client');
        assert.equal(body.client_secret, 'demo-client-secret');
        if (!state.oauthCodes.delete(body.code)) return send(400, { error: 'invalid_grant' });
        return send(200, { access_token: 'demo-access', refresh_token: 'demo-refresh', token_type: 'bearer', expires_in: 3600 });
      }
      if (key === 'POST /llm/api/v1/chat/completions') {
        assert.ok(Array.isArray(body.messages));
        state.llmPrompts.push(body);
        const system = body.messages[0].content;
        let content;
        if (system.includes('verify chatbot auto-replies')) content = 'YES';
        else if (system.includes('Проверь новое сообщение рекрутера')) content = JSON.stringify({ repeated_question: false, repeated_intro: false, template_garbage: false, reason: null });
        else if (system.includes('ATS-система')) {
          assert.match(body.messages[1].content, /FULL-RESUME-END-/);
          content = JSON.stringify({ knockout_failed: [], filters_ok: {}, criteria: [{ name: 'Сварщик НАКС', score: body.messages[1].content.includes('FULL-RESUME-END-1') ? 3 : 1, evidence: 'FULL-RESUME-END' }], reasoning: 'Полный ранний опыт получен.' });
        }
        else if (system.includes('Поисковые запросы') || system.includes('поисков') && system.includes('JSON')) content = JSON.stringify(['Сварщик НАКС']);
        else if (system.includes('plus_tags')) content = JSON.stringify({ plus_tags: ['Опыт сварки'], yellow_tags: [], red_tags: [], summary_why: 'Сварщик с опытом.', summary_pitch: 'НАКС.' });
        else if (system.startsWith('Ты — рекрутер. ВСЕГДА')) content = 'Сергей, здравствуйте! Ваш опыт сварки подходит. Когда вам удобно обсудить вакансию?';
        else if (system.includes('Ты HR-эксперт')) content = JSON.stringify(draft);
        else if (system.includes('YES') && system.includes('NO')) content = 'NO';
        else return fail('Uncontracted LLM prompt: ' + system.slice(0, 90));
        return send(200, { id: 'demo-completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      if (!u.pathname.startsWith('/hh/')) return fail('Unknown provider');
      if (req.headers.authorization !== 'Bearer demo-access') return send(401, { errors: [{ type: 'oauth', value: 'bad_authorization' }] });
      const p = u.pathname.slice(3);
      if (state.faults[key]) return send(state.faults[key], { errors: [{ type: 'test_fault' }] });
      if (key === 'GET /hh/me') return send(200, { id: 'manager-1', first_name: 'Демо', last_name: 'Рекрутер', employer: { id: 'emp-1', name: 'ДемоСтрой' } });
      if (key === 'GET /hh/professional_roles') return send(200, { categories: [{ id: 'construction', roles: [{ id: '165', name: 'Сварщик' }] }] });
      if (key === 'POST /hh/vacancies/drafts') {
        assert.equal(body.name, draft.name); assert.equal(body.schedule.id, 'flyInFlyOut');
        assert.equal(body.professional_roles[0].id, '165');
        state.drafts.push(body); return send(201, { draft_id: 'draft-1', url: '/vacancies/drafts/draft-1' });
      }
      if (key === 'GET /hh/employers/emp-1/vacancies/active') return send(200, paginate(state.vacancies));
      if (key === 'GET /hh/vacancies/vac-1') return send(200, state.vacancies[0]);
      if (key === 'GET /hh/resumes') return send(200, paginate([resume('cold-1')]));
      const r = p.match(/^\/resumes\/resume-(.+)$/);
      if (req.method === 'GET' && r) return send(200, resume(r[1]));
      const states = new Set(['response', 'consider', 'phone_interview', 'assessment', 'interview', 'offer', 'hired', 'discard', 'with_applicant_new']);
      const list = p.match(/^\/negotiations\/([^/]+)$/);
      if (req.method === 'GET' && list && states.has(list[1])) {
        assert.equal(u.searchParams.get('vacancy_id'), 'vac-1');
        return send(200, paginate(state.negotiations.filter(n => n.state.id === list[1])));
      }
      if (req.method === 'GET' && list) {
        const n = state.negotiations.find(n => n.id === list[1]);
        return send(n ? 200 : 404, n || { errors: [{ type: 'not_found' }] });
      }
      const message = p.match(/^\/negotiations\/([^/]+)\/messages$/);
      if (message) {
        const n = state.negotiations.find(n => n.id === message[1]);
        if (!n) return send(404, { errors: [{ type: 'not_found' }] });
        const messages = state.messages[n.id] ||= [];
        if (req.method === 'GET') return send(200, paginate(messages));
        if (req.method === 'POST') {
          assert.equal(typeof body.message, 'string'); assert.ok(body.message.trim());
          messages.push({ id: 'message-' + n.id + '-' + messages.length, text: body.message, author: { participant_type: 'employer' }, created_at: new Date().toISOString() });
          n.counters.messages = messages.length;
          return send(201, { id: messages.at(-1).id });
        }
      }
      const action = p.match(/^\/negotiations\/(consider|discard_vacancy_closed)\/([^/]+)$/);
      if (req.method === 'PUT' && action) {
        const n = state.negotiations.find(n => n.id === action[2]);
        if (!n) return send(404, { errors: [{ type: 'not_found' }] });
        n.state = { id: action[1] === 'consider' ? 'consider' : 'discard' };
        return send(204);
      }
      return fail('No contract for method/path');
    } catch (error) { return fail(error.message); }
  });
  return { state, server, async start() { await new Promise(r => server.listen(0, '127.0.0.1', r)); return 'http://127.0.0.1:' + server.address().port; }, async stop() { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
module.exports = { providers, draft };
