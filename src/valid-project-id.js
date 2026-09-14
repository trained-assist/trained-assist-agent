'use strict';

// Project ids are minted by projects.js `slugify`, which INTENTIONALLY keeps
// Cyrillic letters (`.replace(/[^a-z0-9а-я]+/gi,'-')`), producing folder ids like
// `generic-работает`. The /run validator must accept the same charset the minter
// produces — an ASCII-only regex here hard-400s every task bound to a Cyrillic
// project (root cause of "agent /run HTTP 400" / "sessions don't work"; #544 fallout).
//
// Charset: first char must be a Unicode letter/number; the rest may add `_ . -`.
// Path-traversal safety: the charset excludes `/` and `\`, and `..` is rejected
// outright, so the id is always a single safe path segment for path.join.
function isValidProjectId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 200) return false;
  if (id.includes('..')) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(id);
}

module.exports = { isValidProjectId };
