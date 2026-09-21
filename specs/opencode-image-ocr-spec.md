# OpenCode Image OCR — image attachments for the vision-blind engine

## What

Photo/screenshot attachments (Telegram or web) are saved to `media/intake/` and
referenced in the task by a `[Файл сохранён: <path> (<mime>)…]` note — that's all
either engine sees at intake time. Claude Code doesn't need more: its own `Read`
tool is multimodal, so the model opens the path and sees the image directly.

OpenCode does need more. Its configured models (minimax-m3, GigaChat, DeepSeek —
see `scripts/setup-opencode.sh` / `.opencode/base.json`) are text-only. A photo
sent while running the OpenCode engine was previously invisible: the model got a
file path and a mime type and nothing else, with no way to open or read it.

This adds a vision OCR/description pass for image attachments, but **only** when
the resolved engine for that chat is `opencode` — so the fix lands exactly where
the gap is, without spending an extra model call on every photo Claude already
handles natively.

## Behavior

- Trigger: `mimeType` starts with `image/` AND `profiles.getEngine(workDir, userId) === 'opencode'` AND `secrets.OPENROUTER_API_KEY` is set.
- Model: `google/gemini-2.5-flash` via OpenRouter, image sent as a base64 `image_url` data URL — the same OpenRouter+Gemini pattern already proven for resume OCR in `applylink/worker.js` (`geminiPdf`/`imageToText`), not reinvented.
- Prompt asks for (in order of priority): (1) verbatim transcription of any readable text — mandatory per the original ask ("текст обязательно"); (2) if there's little/no text, a one-to-two sentence description of the scene instead.
- Result folds into the existing file note as an extra block, right under it:
  ```
  [Файл сохранён: /path/to/photo.jpg (image/jpeg). Временное медиа: TTL 48 часов. …]
  [Распознано на изображении:
  <OCR text or scene description>]
  ```
  No new note format, no new intake path — OpenCode's model reads the same task text it already reads.
- Failure modes all degrade to "no recognition block, base note only" — never an error to the user, never a silent stand-in "content": missing key, unreadable file, network/HTTP error, empty model response, and model **refusals** (a model that can't/won't read an image often answers with a prose refusal sentence like "Извините, я не могу…" — that's real text, not an error, and would otherwise leak into the task as if it were the transcription; guarded the same way `applylink/worker.js`'s `isRefusal()` already does for resumes).
- `buildOcCapabilitiesBlock()` (OpenCode's system-prompt addendum, `src/runner/index.js`) now tells the model the recognition block exists and where to look for it — mirroring how it already documents Deepgram audio transcription.

## Explicitly out of scope (this pass)

- **Codex engine**: not addressed. GPT-4o-family models are natively multimodal, so Codex likely doesn't have this gap at all — unverified, left for a follow-up if a concrete report says otherwise. Gating is exact (`engine === 'opencode'`), not "any non-Claude engine", so this doesn't need to be revisited to extend later.
- **A stable/public URL for the image**: the file path already flows through in the note, and every existing downstream consumer (gdrive upload, tg_send_file, etc.) already works from a local path, not a URL. No concrete downstream user needs a public URL today — adding one now would be speculative. Revisit if a real skill needs to hand the image to an external HTTP API.
- **Non-mandatory scene description quality**: the prompt covers it as a fallback, but per the original ask text extraction is the priority; no separate captioning/analytics pipeline was built.

## Implementation

- `src/media-vision.js` — `extractImageText({ filePath, mimeType, openrouterKey, fetchImpl?, timeoutMs? })`, `isRefusal(text)`. Standalone, no dependency on server.js/runner — same OpenRouter base-URL override convention as `HH_API_BASE_URL` in `src/hh-utils.js` (`OPENROUTER_BASE_URL`, test-mocking only).
- `src/server.js` `/run` handler — `buildFileNote(filePath, mimeType)` replaces the duplicated note-building logic in the `fileBase64` and `fileRefs` branches; resolves `runEngine` once via `profiles.getEngine(workDir, userId)` and calls `mediaVision.extractImageText` when gated in.
- `src/runner/index.js` `buildOcCapabilitiesBlock()` — added the recognition-block description, gated on `secrets.OPENROUTER_API_KEY` being present.

## Tests

- `tests/unit/media-vision.test.js` — `extractImageText`/`isRefusal` unit coverage: success, no key, unreadable file, refusal, non-OK HTTP, network error, request shape (base64 data URL + mime type).
- `tests/unit/opencode-image-ocr.test.js` — integration, real spawned `server.js`:
  - No `OPENROUTER_API_KEY`: OpenCode engine and Claude engine both get the base note only, no crash (proves gating doesn't regress the existing no-key path).
  - `OPENROUTER_API_KEY` set + `OPENROUTER_BASE_URL` pointed at a local mock: OpenCode engine gets the recognition block folded into the task text end-to-end.
