'use strict';
// Bug classifier — called immediately when a bug is logged.
// Deduplicates by content hash, classifies with LLM on first occurrence.
// Does NOT create GitHub issues — that's the curator's job.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEDUP_FILE = 'bugs-dedup.json';

class BugClassifier {
  constructor({ stateDir, openrouterKey }) {
    this.stateDir = stateDir;
    this.openrouterKey = openrouterKey;
    this.dedupPath = path.join(stateDir, DEDUP_FILE);
  }

  _hash(bug) {
    const raw = (bug.type || '') + (bug.task || '').slice(0, 30) + (bug.detail || '').slice(0, 50);
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  }

  _loadDedup() {
    try { return JSON.parse(fs.readFileSync(this.dedupPath, 'utf8')); } catch { return {}; }
  }

  _saveDedup(index) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.dedupPath, JSON.stringify(index, null, 2));
  }

  async _classify(bug) {
    if (!this.openrouterKey) {
      return {
        title: `[mainstream] ${bug.type}: ${(bug.detail || '').slice(0, 60)}`,
        category: bug.type,
        severity: 'medium',
        description: bug.detail || '',
      };
    }

    const prompt = `You are a QA engineer classifying a bug found by an automated tester.

Bug type: ${bug.type}
Task that triggered it: ${bug.task || '—'}
Detail / response excerpt:
${(bug.detail || '').slice(0, 400)}

Reply with JSON only:
{
  "title": "short bug title (max 80 chars)",
  "category": "one of: crash, wrong_answer, timeout, empty_response, loop, ui_error, other",
  "severity": "one of: low, medium, high, critical",
  "description": "1-2 sentence description of what went wrong"
}`;

    try {
      const resp = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://recruiter-assistant.ru',
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 200,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[bug-classifier] classify failed:', e.message);
    }

    return {
      title: `[mainstream] ${bug.type}: ${(bug.detail || '').slice(0, 60)}`,
      category: bug.type,
      severity: 'medium',
      description: bug.detail || '',
    };
  }

  async process(bug) {
    const hash = this._hash(bug);
    const index = this._loadDedup();

    if (!index[hash]) {
      // First occurrence — classify and save
      const classification = await this._classify(bug);
      index[hash] = {
        hash,
        occurrences: 1,
        firstSeenAt: new Date().toISOString(),
        classification,
        examples: [bug],
        issueUrl: null,   // curator will fill this
        curatorSeen: false,
      };
      this._saveDedup(index);
      console.log(`[bug-classifier] New bug hash=${hash} category=${classification.category} severity=${classification.severity}`);
      return;
    }

    // Repeated occurrence
    const entry = index[hash];
    entry.occurrences += 1;
    entry.lastSeenAt = new Date().toISOString();
    if (entry.examples.length < 5) entry.examples.push(bug);
    this._saveDedup(index);
    console.log(`[bug-classifier] Repeated bug hash=${hash} occurrences=${entry.occurrences}`);
  }
}

module.exports = { BugClassifier };
