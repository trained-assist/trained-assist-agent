/**
 * Proactive page HTML generation — unit tests for the usability features added on
 * top of the existing PASS/REVIEW/dark-mode/AI-modal page (spec items #1, #3, #4, #5).
 *
 *   1. discovery date badge — "Найден: ДД.ММ.ГГГГ" from found_at (or added_at
 *      fallback), omitted (no crash) when the candidate has neither
 *   2. manually-added candidates get a distinct "Добавлен вручную" badge
 *   3. score/tag/source/search-text are embedded as data-* attributes for the
 *      client-side composite filter (name search + score slider + source)
 *   4. the score slider's max reflects the highest observed score, floored at 10
 *   5. header markup includes the name-search input, slider, presets, source filter,
 *      and the manual-add form — and does NOT include the old pagination controls
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { generateProactivePageHtml } = require('../src/hh-proactive-page.js');

function baseResults(candidates) {
  return {
    vacancy_title: 'Тестовая вакансия',
    searched_at: '2026-09-20T12:00:00.000Z',
    total_collected: candidates.length,
    total_after_knockout: candidates.length,
    ai_enriched: true,
    candidates,
  };
}

function render(candidates) {
  return generateProactivePageHtml(baseResults(candidates), 'testuser', 'http://localhost:3001', 'tok123', {});
}

describe('discovery date badge (#1)', () => {
  it('renders Найден: ДД.ММ.ГГГГ from found_at', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', found_at: '2026-09-15T10:00:00.000Z', experience: [] }]);
    expect(html).toContain('Найден: 15.09.2026');
  });

  it('falls back to added_at for manually-added candidates without found_at set separately', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', source: 'manual', added_at: '2026-01-05T10:00:00.000Z', experience: [] }]);
    expect(html).toContain('Найден: 05.01.2026');
  });

  it('omits the badge entirely (no crash, no placeholder) when found_at/added_at are absent', () => {
    expect(() => render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', experience: [] }])).not.toThrow();
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', experience: [] }]);
    expect(html).not.toContain('Найден: undefined');
    expect(html).not.toContain('Найден: NaN');
    expect(html).not.toContain('Найден: Invalid');
  });

  it('does not crash on a garbage found_at value', () => {
    expect(() => render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', found_at: 'not-a-date', experience: [] }])).not.toThrow();
  });
});

describe('manual-add badge (#2)', () => {
  it('tags manually-added candidates with "Добавлен вручную"', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', source: 'manual', added_at: '2026-09-01T00:00:00.000Z', experience: [] }]);
    expect(html).toContain('Добавлен вручную');
  });

  it('does not tag search-discovered candidates as manual', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', source: 'search', found_at: '2026-09-01T00:00:00.000Z', experience: [] }]);
    expect(html).not.toContain('Добавлен вручную');
  });
});

describe('client-side filter data attributes (#3, #4, #5)', () => {
  it('embeds score/tag/source/search text for each candidate card', () => {
    const html = render([
      { id: 'r1', title: 'Аналитик Данных', first_name: 'Иван', last_name: 'Петров', score: 9.2, tag: 'PASS', source: 'search', found_at: '2026-09-15T00:00:00Z', experience: [] },
    ]);
    expect(html).toContain('data-score=\\"9.2\\"');
    expect(html).toContain('data-tag=\\"PASS\\"');
    expect(html).toContain('data-source=\\"search\\"');
    expect(html).toContain('иван петров аналитик данных');
  });

  it('lowercases Cyrillic search text correctly for case-insensitive matching', () => {
    const html = render([{ id: 'r1', title: 'ДИРЕКТОР', first_name: 'ИВАН', last_name: 'ПЕТРОВ', score: 1, tag: 'WEAK', experience: [] }]);
    expect(html).toContain('иван петров директор');
    expect(html).not.toContain('ИВАН ПЕТРОВ ДИРЕКТОР');
  });

  it('sizes the score slider max to the highest observed score, floored at 10', () => {
    const htmlLow = render([{ id: 'r1', title: 'X', score: 3, tag: 'WEAK', experience: [] }]);
    expect(htmlLow).toContain('id="scoreSlider" type="range" min="0" max="10"');

    const htmlHigh = render([{ id: 'r1', title: 'X', score: 14.3, tag: 'PASS', experience: [] }]);
    expect(htmlHigh).toContain('max="14.3"');
  });
});

describe('header markup (#3, #4, #5)', () => {
  const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', experience: [] }]);

  it('includes the name search input', () => {
    expect(html).toContain('id="nameSearch"');
    expect(html).toContain('Поиск по имени');
  });

  it('includes the score range slider and preset buttons matching existing PASS/REVIEW bands', () => {
    expect(html).toContain('id="scoreSlider"');
    expect(html).toContain('data-preset="all"');
    expect(html).toContain('data-preset="pass"');
    expect(html).toContain('data-preset="review"');
    expect(html).toContain('data-preset="top9"');
  });

  it('includes the source filter dropdown', () => {
    expect(html).toContain('id="sourceFilter"');
  });

  it('includes the live "показано N из M" counter element', () => {
    expect(html).toContain('id="filterCount"');
  });

  it('includes the manual-add form posting to /api/hh/proactive/add-manual', () => {
    expect(html).toContain('Добавить кандидата вручную');
    expect(html).toContain('id="manualInput"');
    expect(html).toContain('/api/hh/proactive/add-manual');
  });

  it('keeps the existing import-seen button and endpoint unchanged', () => {
    expect(html).toContain('Импорт просмотренных');
    expect(html).toContain('/api/hh/proactive/import-seen');
  });

  it('does not include the old fixed-page pagination controls', () => {
    expect(html).not.toContain('id="prevBtn"');
    expect(html).not.toContain('id="nextBtn"');
    expect(html).not.toContain('Страница');
  });
});

// The "persistent viewed flag" (#6) — a checkbox that only dimmed the card in place —
// was replaced by a three-state triage lifecycle (active/starred/archived): the owner
// asked for candidates to actually move out of the main feed into their own list
// (starred) or an out-of-the-way one (archived), with an explicit way back, rather
// than staying in the same list just visually muted. These tests replace the old
// read-toggle coverage above with the new state tabs + per-card move actions.
describe('candidate status tabs + actions', () => {
  it('renders state tabs with counts, marking the active tab', () => {
    const html = generateProactivePageHtml(
      baseResults([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', experience: [] }]),
      'testuser', 'http://localhost:3001', 'tok123', {},
      { listView: 'active', stateCounts: { active: 3, starred: 1, archived: 2 } },
    );
    expect(html).toContain('state-tab active');
    expect(html).toContain('Найдено (3)');
    expect(html).toContain('⭐ Выбрано (1)');
    expect(html).toContain('🗄 Архив (2)');
    expect(html).toContain('list=starred');
    expect(html).toContain('list=archived');
  });

  it('an active-status card offers star and archive actions', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', experience: [] }]);
    expect(html).toContain("setStatus('r1','starred',this)");
    expect(html).toContain("setStatus('r1','archived',this)");
    expect(html).not.toContain("setStatus('r1','active',this)");
  });

  it('a starred card offers unstar (back to active) and archive actions', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', status: 'starred', experience: [] }]);
    expect(html).toContain("setStatus('r1','active',this)");
    expect(html).toContain("setStatus('r1','archived',this)");
    expect(html).toContain('Убрать из выбранных');
  });

  it('an archived card offers only a restore-to-active action', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', status: 'archived', experience: [] }]);
    expect(html).toContain("setStatus('r1','active',this)");
    expect(html).not.toContain("setStatus('r1','archived',this)");
    expect(html).not.toContain("setStatus('r1','starred',this)");
    expect(html).toContain('Вернуть в список');
  });

  it('treats a missing status as active (legacy candidates default in)', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', experience: [] }]);
    expect(html).toContain('⭐ Выбрать');
  });

  it('posts to the set-status endpoint from the client script', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', experience: [] }]);
    expect(html).toContain('/api/hh/proactive/set-status');
    expect(html).toContain('candidate_id: candidateId, status');
  });

  it('no longer renders the retired read-toggle checkbox or hide-read filter', () => {
    const html = render([{ id: 'r1', title: 'X', score: 5, tag: 'REVIEW', experience: [] }]);
    expect(html).not.toContain('markRead(');
    expect(html).not.toContain('id="hideRead"');
    expect(html).not.toContain('/api/hh/proactive/mark-read');
  });
});

describe('unchanged behaviors', () => {
  it('still renders PASS/REVIEW badge colors from the existing tag field', () => {
    const html = render([{ id: 'r1', title: 'X', score: 9, tag: 'PASS', experience: [] }]);
    expect(html).toContain('#16a34a'); // PASS green, from tagBadgeBg — unchanged
  });

  it('still renders the AI-score modal trigger button', () => {
    const html = render([{ id: 'r1', title: 'X', score: 9, tag: 'PASS', experience: [] }]);
    expect(html).toContain('openAiModal(');
  });

  it('still renders comment box and save button', () => {
    const html = render([{ id: 'r1', title: 'X', score: 9, tag: 'PASS', experience: [] }]);
    expect(html).toContain('saveComment(');
  });
});
