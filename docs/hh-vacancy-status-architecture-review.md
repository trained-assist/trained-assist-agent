# HH Vacancy Status — Architecture Review

**Date:** 2026-09-07  
**Trigger:** PR #404 fix — review page quick-answer now fires even with vacancy draft

---

## 1. How vacancy status is stored

There are **two separate local state stores**, both under `workDir/contexts/hh/`:

### 1a. `vacancy_draft.json` — local workflow state

Path: `workDir/contexts/hh/vacancy_draft.json`  
Written by: `writeVacancyState()` in `src/hh-vacancy.js`  
Read by: `readVacancyState()` in `src/hh-vacancy.js`, then used in `runner.js` for the `VACANCY_HH_PUBLISH_INTENT` block

Fields: `{ status, vacancy_id, messages, draft, landing_url, hh_vacancy_id, updated_at }`

**Status values (local workflow states — NOT HH states):**

| Value | Meaning |
|-------|---------|
| `collecting` | Dialog in progress, gathering info from recruiter |
| `draft_ready` | Claude generated a draft JSON, ready to push to HH |
| `hh_draft` | Draft pushed to `POST /vacancies/drafts` on HH, waiting for recruiter to publish on hh.ru |

**Critical gap:** After `hh_draft`, the recruiter manually goes to hh.ru and clicks "Publish". This transitions the HH vacancy from `draft` → `published` (or `review` if moderation is required), but **our local `status` is never updated past `hh_draft`**.

### 1b. `active_vacancy.json` — active vacancy pointer

Path: `workDir/contexts/hh/active_vacancy.json`  
Written by:
1. `hh_set_active_vacancy` MCP tool (90-hh.js:514) — when Claude or user selects a vacancy  
2. `hhMyVacancies()` quick-answer (hh-quick.js:52-57) — auto-set when recruiter has exactly 1 active vacancy

Fields: `{ id, title, set_at }` — **no status field at all**

This pointer is what `readActiveVacancy(workDir)` returns. It only says "which vacancy is the focus" — nothing about whether it's live on HH.

---

## 2. Can the agent update vacancy status?

**Short answer: No.**

There is no code path that calls `GET /vacancies/{id}` (or similar) to fetch the current live status from HH and write it back to local state.

What exists:
- `hhGet()` and `hhRequest()` helpers in 90-hh.js — capable of making any HH API call
- `hh_set_active_vacancy` tool calls `GET /vacancies/{vacancy_id}` but only to resolve the title, not status
- `hhMyVacancies()` calls `GET /employers/{id}/vacancies/active` — only returns currently-active vacancies (so if vacancy is still a draft, it won't appear here)

What's missing:
- A `hh_vacancy_sync_status` tool or any mechanism for Claude to call `GET /vacancies/{id}` and update local state with `{ hh_status: 'published' | 'archived' | 'closed' | 'draft' }`
- A hook in `HH_REVIEW_PAGE_INTENT` or `hhFunnelStats` to check live status before proceeding

---

## 3. Is the draft guard removal the right fix?

**Partial fix — correct for the specific UX case, wrong as the root-cause fix.**

PR #404 changed runner.js lines 822-827:
```js
if (HH_REVIEW_PAGE_INTENT.test(task)) {
  // Candidate review page — return immediately if active vacancy exists.
  // Vacancy draft existing is irrelevant: user explicitly asked for candidate review, not vacancy publish.
  const av = workDir ? readActiveVacancy(workDir) : null;
  if (av) return hhReviewPage(userId);
}
```

**Why it's correct:** The review page at `/hh/review?username=X` shows all ATS-scored candidates from the HH negotiations cache. It's independent of whether the vacancy is published or still in draft. The user explicitly asked to see candidates — the local draft state shouldn't block that.

**Why it's incomplete:** The real issue is that even if we *wanted* to gate on "is vacancy published", we can't — because we don't track that. Local `status` is `hh_draft` for vacancies pushed to HH, and we have no way to know if the recruiter clicked "Publish" on hh.ru.

**The right root-cause fix:** Add live status to `active_vacancy` context. When any HH quick-answer fires for a vacancy that has an `hh_vacancy_id`, optionally sync `GET /vacancies/{id}` → store `{ hh_status }` in context. Or at minimum, expose a `hh_vacancy_sync_status` tool Claude can call.

---

## 4. Correct pattern for external-state entities

For entities like "vacancy" that have both **external state (HH)** and **local state (workDir)**:

### Anti-pattern (current)
```
local_status: 'hh_draft'
→ recruiter publishes on hh.ru
→ hh.ru shows: status = 'published'
→ local_status: still 'hh_draft' forever
```

### Recommended pattern: lazy sync on access

```
On read:
  if (local.hh_vacancy_id && local.hh_status is stale):
    live = GET /vacancies/{id}
    update local.hh_status = live.status
    update local.last_synced_at = now()
```

Implementation options (cheapest to most complete):

**Option A — Sync on `hh_vacancy_get_draft` tool call** (low effort, Claude-driven)  
Add a `GET /vacancies/{id}` call inside `hh_vacancy_get_draft` handler. When Claude calls this tool (e.g. before deciding whether to show review page), it gets live status back. Claude can then update local state.

**Option B — Sync on `hh_set_active_vacancy`** (medium effort, automatic)  
When `hh_set_active_vacancy` resolves the vacancy, also fetch `status` from HH and store `hh_status` in `active_vacancy.json`. This happens once per session setup.

**Option C — Proactive sync in `HH_REVIEW_PAGE_INTENT` quick-answer** (medium effort, transparent)  
Before returning the review page link, check if `active_vacancy.hh_status !== 'published'` and if so, attempt a live sync. This gives the recruiter immediate feedback: "Your vacancy is still a draft on HH — candidates can't apply yet. Review page: [link]"

Option B is the best tradeoff: one sync at vacancy selection time, no latency on subsequent calls, and it catches the "just published" transition.

---

## 5. Similar stale-state risks

### 5a. HH negotiations cache — `_cache` in hh-quick.js

**Risk:** 4-minute TTL in-process cache for negotiations, funnel stats, and responses. If a recruiter scores candidates or candidates apply in another tab, `hhFunnelStats` and `hhNewResponses` will show stale counts for up to 4 minutes.

**Severity:** Low — acceptable for casual checking, annoying if recruiter is actively working the pipeline.

**Fix:** Cache TTL is already set; optionally expose a "refresh" command or note the cache age in output (similar to how the review page shows `ageText`).

### 5b. ATS config (`contexts/hh/ats_config.json`)

**Risk:** ATS config is stored locally. If a recruiter edits scoring criteria via the ATS editor UI (which writes back via the `/hh/ats-editor` POST endpoint), but their local agent session has the old config in a read call, they may score candidates against stale criteria.

**Current mitigation:** `hh_run_ats` in 90-hh.js reads config fresh from disk on each call (no in-memory caching). **Low risk.**

### 5c. HH OAuth token expiry check

**Risk:** `readHhToken()` reads the token file but does not validate expiry before passing to API calls. If the token expired mid-session, the first HH API call fails and falls through to Claude (returns `null`). Claude doesn't know why.

**Current mitigation:** HH access tokens are valid for several weeks. **Low risk for normal use**, but a recruiter using the system months after initial setup could hit this silently.

**Fix:** Check `token.expires_at` in `readHhToken()` and return `null` early if expired, triggering re-auth instead of a confusing API failure.

### 5d. Vacancy draft stale after HH-side edits

**Risk:** If a recruiter edits their vacancy directly on hh.ru after `publishToHH()` saved it as a draft, the local `draft` JSON in `vacancy_draft.json` no longer matches what's on HH. Any subsequent "update draft" tool call (`hh_vacancy_update_draft`) would overwrite HH's version with stale local data.

**Severity:** Medium — the `PUT /vacancies/drafts/{id}` endpoint would silently overwrite recruiter's hh.ru edits.

**Fix:** Before any `PUT /vacancies/drafts/{id}` call, fetch `GET /vacancies/drafts/{id}` and diff/merge with local. Or simply warn: "This will overwrite any changes you made on hh.ru."

---

## 6. Summary

| Issue | Severity | Fix |
|-------|----------|-----|
| `active_vacancy` has no `hh_status` field — no way to know if published | **High** | Sync `hh_status` on `hh_set_active_vacancy` (Option B above) |
| `vacancy_draft.status` stuck at `hh_draft` after recruiter publishes | **High** | Same fix — listen to live HH status |
| Stale negotiations cache (4-min TTL) | Low | Acceptable, note age in output |
| No token expiry pre-check | Low | Add expiry check to `readHhToken()` |
| Local draft can diverge from HH-side edits | Medium | Warn before `PUT /vacancies/drafts/{id}` |

**PR #404's draft guard removal is the correct short-term fix.** The review page is genuinely useful regardless of vacancy publish state. The medium-term fix is Option B: sync `hh_status` into `active_vacancy` context on vacancy selection, and expose that status in relevant quick-answer responses so recruiters know whether their vacancy is live.
