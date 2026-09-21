'use strict';

// Candidate-for-client HTML profile with a persistent requirements log (issue #982).
//
// The recruiter regenerates a profile 5–10 times («от первого лица», «убери фразу про удалёнку»).
// Those edits live in <candidate>-report-notes.md and are applied automatically on every run:
//   candidate_report_context → read notes + last data   (ALWAYS first, on every generate/regenerate)
//   candidate_report_add_note → «добавь в требования: …»
//   candidate_report_render  → fixed HTML template (A4 print CSS), rejects banned phrases, publishes
// Deterministic — no LLM call here: the wording is written by the session model, the template
// and the notes enforcement are code.

const { userWorkDir } = require('../../data-paths');
const report = require('../../candidate-report');

const USER_ID = process.env.USER_ID || '';

// Same directory the quick answers use (user.workDir = ~/users/<profile>), NOT process.cwd():
// cwd becomes the project folder when the session is bound to a project.
const workDir = () => userWorkDir(USER_ID);

// → { slug, created } | { error }
function pickCandidate(candidate, { create }) {
  const r = report.resolveCandidate(workDir(), candidate);
  if (r.slug) return { slug: r.slug };
  if (r.ambiguous) return { error: `Под «${candidate}» подходит несколько кандидатов: ${r.ambiguous.join(', ')}. Уточни имя.` };
  if (!create || !String(candidate || '').trim()) {
    return { error: 'Не знаю, о каком кандидате речь — передай candidate (ФИО).' };
  }
  return { slug: report.slugify(candidate), created: true };
}

const TEMPLATE_HELP = {
  candidate: '{name, age, position, contacts:[str], badges:[str] (напр. «план 115%», «max сделка 42 млн»), photo_url}',
  client: '{company, vacancy}',
  summary: '3–5 предложений от ПЕРВОГО лица кандидата (из транскрипта интервью)',
  matrix: '[{requirement, status: "yes"|"partial"|"no", comment}] — ключевые требования вакансии',
  experience: '[{period, company, role, details:[str]}] — резюме + дополнения из интервью',
  conclusion: 'Вывод рекрутера от ПЕРВОГО лица, честно про нюансы (абзацы через пустую строку)',
  video_url: 'ссылка на видео скрининга',
};

module.exports = {
  isReady: () => true,

  tools: {
    candidate_report_context: {
      description:
        'ВЫЗЫВАЙ ПЕРВЫМ при любом «сделай профиль кандидата [имя] для клиента [компания]», ' +
        '«перегенерируй профиль [имя]», «обнови профиль», «покажи требования к профилю». ' +
        'Возвращает требования рекрутера к профилю (report-notes.md: что включать, что НЕ включать/формулировки, ' +
        'история правок) и предыдущую версию данных профиля. Требования — обязательные ограничения: применяй их ' +
        'все, рекрутер не должен повторяться. При перегенерации бери previous_data и меняй только то, о чём попросили. ' +
        'Для нового кандидата создаёт пустой файл требований.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate: { type: 'string', description: 'Имя кандидата (можно фамилию). Пусто = последний, с кем работали.' },
        },
      },
      handler: async ({ candidate } = {}) => {
        if (!USER_ID) return { error: 'USER_ID not set — not running inside agent session' };
        const pick = pickCandidate(candidate, { create: true });
        if (pick.error) return { error: pick.error };
        const notes = report.ensureNotes(workDir(), pick.slug, candidate);
        report.setLastCandidate(workDir(), pick.slug);
        return {
          slug: pick.slug,
          is_new_candidate: !!pick.created,
          notes_markdown: report.renderNotes(notes),
          must_include: notes.include,
          must_not_include_or_wording: notes.exclude,
          banned_phrases: report.forbiddenPhrases(notes),
          previous_data: report.loadReportData(workDir(), pick.slug),
          template_schema: TEMPLATE_HELP,
          how_to: 'Собери data по template_schema с учётом ВСЕХ требований выше → candidate_report_render. ' +
            'Если рекрутер в этом сообщении дал новую правку — сначала candidate_report_add_note.',
        };
      },
    },

    candidate_report_add_note: {
      description:
        'Записать требование рекрутера к профилю кандидата в report-notes.md («добавь в требования: не упоминать ' +
        'удалёнку», «писать от первого лица», «нюансы подавать честно»). Требование будет применяться при каждой ' +
        'следующей регенерации. Цитируй запрещённые фразы в «ёлочках» — тогда render автоматически откажется их пропускать. ' +
        'Не переспрашивай рекрутера — просто запиши.',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Формулировка требования, как сказал рекрутер.' },
          candidate: { type: 'string', description: 'Имя кандидата. Пусто = последний, с кем работали.' },
        },
      },
      handler: async ({ text, candidate } = {}) => {
        if (!USER_ID) return { error: 'USER_ID not set — not running inside agent session' };
        if (!String(text || '').trim()) return { error: 'text required' };
        const pick = pickCandidate(candidate, { create: true });
        if (pick.error) return { error: pick.error };
        const r = report.addNote(workDir(), pick.slug, text, { nameForNew: candidate });
        return { ...r, notes_markdown: report.renderNotes(report.readNotes(workDir(), pick.slug)) };
      },
    },

    candidate_report_render: {
      description:
        'Собрать HTML-профиль кандидата для клиента по фиксированному шаблону (шапка + бейджи, кратко о себе, ' +
        'матрица соответствия ✓/~/✗, опыт, вывод рекрутера, видео; печать A4 без колонтитулов). ' +
        'Сверяет текст с запретными фразами из report-notes.md — если нашёл, НЕ публикует и возвращает violations: ' +
        'перепиши эти места и вызови снова. С publish=true публикует через publish_page и возвращает ссылку. ' +
        'Профиль содержит персональные данные — по умолчанию передавай password.',
      inputSchema: {
        type: 'object',
        required: ['candidate', 'data'],
        properties: {
          candidate: { type: 'string', description: 'Имя кандидата (то же, что в candidate_report_context).' },
          data: {
            type: 'object',
            description: 'Содержимое профиля, см. template_schema из candidate_report_context.',
            properties: {
              candidate: { type: 'object' },
              client: { type: 'object' },
              summary: { type: 'string' },
              matrix: { type: 'array', items: { type: 'object' } },
              experience: { type: 'array', items: { type: 'object' } },
              conclusion: { type: 'string' },
              video_url: { type: 'string' },
            },
          },
          publish: { type: 'boolean', description: 'Опубликовать и вернуть ссылку. По умолчанию true.' },
          password: { type: 'string', description: 'Пароль на страницу (рекомендуется — персональные данные).' },
        },
      },
      handler: async ({ candidate, data, publish = true, password } = {}) => {
        if (!USER_ID) return { error: 'USER_ID not set — not running inside agent session' };
        const pick = pickCandidate(candidate, { create: true });
        if (pick.error) return { error: pick.error };
        const notes = report.ensureNotes(workDir(), pick.slug, candidate);

        const violations = report.findViolations(data, notes);
        if (violations.length) {
          return {
            ok: false,
            violations,
            error: 'В тексте есть фразы, которые рекрутер запретил в report-notes.md. Перепиши их и вызови снова.',
          };
        }

        let rendered;
        try { rendered = report.renderProfileHtml(data); }
        catch (e) { return { ok: false, error: e.message }; }

        report.saveReport(workDir(), pick.slug, data, rendered.html);
        report.setLastCandidate(workDir(), pick.slug);
        report.logHistory(workDir(), pick.slug, 'профиль перегенерирован');

        const out = { ok: true, slug: pick.slug, html_file: report.htmlPath(workDir(), pick.slug), warnings: rendered.warnings };
        if (publish === false) return out;

        const { tools } = require('./97-publish');
        const pub = await tools.publish_page.handler({
          content: rendered.html,
          slug: report.publishSlug(USER_ID, pick.slug),
          title: data.candidate.name,
          format: 'html',
          ...(password ? { password } : {}),
        });
        if (pub.error) return { ...out, publish_error: pub.error };
        return { ...out, url: pub.url, is_protected: pub.is_protected };
      },
    },
  },
};
