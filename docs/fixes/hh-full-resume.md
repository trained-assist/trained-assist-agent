# HH review: full resume and scoring input

The negotiation list embeds only a resume summary. Both the review page and background scoring previously formatted that summary without fetching `/resumes/{id}`. The manual MCP formatter additionally cut experience to five jobs and descriptions to 300 characters; all formatters omitted `skills` (About me), and limited skill sets and education.

Source: https://api.hh.ru/openapi/en/redoc (Negotiation list of the collection / View a resume).

The shared `hh-resume.js` now retrieves full resumes, uses an authorization-scoped one-hour cache, and preserves professional text: all jobs and descriptions, About me, all skills, education/courses/attestations, languages, certificates, work preferences and cover letters. Both review/profile pages and manual/background evaluation use this formatter. Candidate replies are also included in background scoring without per-message truncation. Contact details and personal demographic fields are not part of the scoring input.

Incomplete/restricted/failed fetches are explicitly labelled and excluded from evaluation. Old negotiation caches are invalidated. Scores carry a formatter version and resume-content hash: background scoring replaces legacy or changed-resume scores on the next successful scheduled run. The previous score remains visible with a warning until replacement succeeds. Loading the review page does not itself run an LLM evaluation. No candidate messages or stage transitions are performed by the resume loader.

Regression coverage includes long job descriptions, eighth job, fortieth skill, second education, About me, courses and long cover letters; authorization-isolated cache and retry after 403; skip on incomplete data; one-time legacy score migration; actual HTTP candidate page using a full-resume fixture distinct from the negotiation summary; browser rendering and HTML escaping.

Live candidate data and production deployment are not part of the local test evidence. The first uncached review can be slower because full resumes are requested in batches of four. HH access limitations are reported, never represented as a complete resume.
