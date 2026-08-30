'use strict';

const { stripOpf } = require('./variants');

const OPF_TOKENS = new Set(['ооо', 'оао', 'зао', 'ао', 'пао', 'ип', 'гк', 'гуп', 'муп', 'нко', 'ано', 'нао']);

function tokenize(s) {
  return [...s.toLowerCase().matchAll(/[а-яёa-z0-9]{3,}/g)].map(m => m[0]);
}

/**
 * Fraction of query tokens found in candidate tokens (substring match).
 */
function wordOverlap(query, candidate) {
  const qWords = tokenize(query).filter(w => !OPF_TOKENS.has(w));
  const cWords = new Set(tokenize(candidate));
  if (!qWords.length) return 0;
  const matched = qWords.filter(w => [...cWords].some(cw => cw.includes(w) || w.includes(cw)));
  return matched.length / qWords.length;
}

/**
 * Score a BFO/Rusprofile candidate against the original query.
 * Higher = better match.
 */
function scoreName(query, candidate, extra = {}) {
  let score = 0;
  const qClean = stripOpf(query).toLowerCase();
  const cClean = stripOpf(candidate).toLowerCase();
  const qTokens = tokenize(qClean).filter(w => !OPF_TOKENS.has(w));
  const cTokens = new Set(tokenize(cClean));

  // per-word score
  for (const w of qTokens) {
    if ([...cTokens].some(cw => cw.includes(w) || w.includes(cw))) score += 24;
  }

  // exact keyword match
  if (qClean && cClean.includes(qClean)) score += 140;

  // query is substring of candidate
  if (qClean && cClean.includes(qClean)) score += 72;
  else if (qClean && qClean.includes(cClean)) score += 40;

  // first word match
  const qFirst = qTokens[0];
  if (qFirst && cClean.startsWith(qFirst)) score += 18;

  // penalty: single short word
  if (qTokens.length === 1 && qTokens[0].length <= 4) score -= 45;

  // catalog name exact
  if (extra.catalogName && stripOpf(extra.catalogName).toLowerCase() === cClean) score += 50;

  // active company bonus
  if (extra.active) score += 12;

  return score;
}

const CONFIDENCE = {
  verified: (score, gap, viaInn) => viaInn || (score >= 155 && gap >= 25),
  high:     (score) => score >= 120,
  medium:   (score) => score >= 80,
  low:      (score) => score >= 0,
};

function scoreToConfidence(score, gap = 999, viaInn = false) {
  if (CONFIDENCE.verified(score, gap, viaInn)) return 'verified';
  if (CONFIDENCE.high(score)) return 'high';
  if (CONFIDENCE.medium(score)) return 'medium';
  return 'low';
}

/**
 * Sanity check: returns true if the match looks bogus.
 */
function isBadMatch(result) {
  const { revenue_mln = 0, net_profit_mln = 0 } = result;
  if (revenue_mln > 5000) return true;
  if (net_profit_mln > revenue_mln && net_profit_mln > 100) return true;
  return false;
}

module.exports = { wordOverlap, scoreName, scoreToConfidence, isBadMatch, tokenize };
