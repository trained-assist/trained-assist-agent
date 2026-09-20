'use strict';
// Bug classifier — called immediately when a bug is logged.
// Deduplicates by content hash. On 2nd+ occurrence creates a GitHub issue.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GITHUB_REPO = 'trained-assist/trained-assist-agent';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEDUP_FILE = 'bugs-dedup.json';
const MIN_OCCURRENCES_FOR_ISSUE = 2;

class BugClassifier {
  constructor({ stateDir, openrouterKey, githubToken }) {
    this.stateDir = stateDir;
    this.openrouterKey = openrouterKey;
    this.githubToken = githubToken;
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
    if (!this.openrouterKey) return { title: `[mainstream] ${bug.type}: ${(bug.detail || '').slice(0, 60)}`, category: bug.type, severity: 'medium' };

    const prompt = `You are a QA engineer classifying a bug found by an automated tester.

Bug type: ${bug.type}
Task that triggered it: ${bug.task || '—'}
Detail / response excerpt:
${(bug.detail || '').slice(0, 400)}

Reply with JSON only:
{
  "title": "short bug title for GitHub issue (max 80 chars)",
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

  async _createGithubIssue(hash, entry) {
    if (!this.githubToken) {
      console.warn('[bug-classifier] GITHUB_ISSUES_TOKEN not set — skipping issue creation');
      return null;
    }

    const { classification, occurrences, examples } = entry;
    const body = [
      `**Detected by:** mainstream tester (automated)`,
      `**Occurrences:** ${occurrences}`,
      `**Bug type:** ${examples[0]?.type || '?'}`,
      `**Category:** ${classification.category}`,
      `**Severity:** ${classification.severity}`,
      '',
      `## Description`,
      '',
      classification.description || '—',
      '',
      `## Examples`,
      '',
      ...examples.slice(0, 3).map((ex, i) => [
        `### Example ${i + 1} (run ${ex.runId || '?'}, step ${ex.step || '?'})`,
        `**Task:** ${ex.task || '—'}`,
        '**Response excerpt:**',
        '```',
        (ex.detail || '').slice(0, 500),
        '```',
      ].join('\n')),
      '',
      `**Dedup hash:** \`${hash}\``,
    ].join('\n');

    try {
      const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${this.githubToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'trained-assist-agent/mainstream-tester',
          'Accept': 'application/vnd.github+json',
        },
        body: JSON.stringify({
          title: classification.title,
          body,
          labels: ['mainstream-found'],
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const data = await resp.json();
      if (resp.status >= 400) {
        console.warn('[bug-classifier] GitHub issue creation failed:', data.message);
        return null;
      }

      console.log(`[bug-classifier] GitHub issue created: ${data.html_url}`);
      return data.html_url;
    } catch (e) {
      console.warn('[bug-classifier] GitHub request failed:', e.message);
      return null;
    }
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
        issueUrl: null,
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

    // Create GitHub issue on 2nd occurrence (if not already created)
    if (entry.occurrences >= MIN_OCCURRENCES_FOR_ISSUE && !entry.issueUrl) {
      const url = await this._createGithubIssue(hash, entry);
      if (url) {
        entry.issueUrl = url;
        this._saveDedup(index);
      }
    }
  }
}

module.exports = { BugClassifier };
