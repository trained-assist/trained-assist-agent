#!/usr/bin/env node
/**
 * PostToolUse hook — auto-extracts artifacts from every Claude tool call.
 * Registered globally in ~/.claude/settings.json, runs for all sessions.
 * Skips non-agent sessions where AGENT_USER_ID is not set.
 *
 * Input (stdin): JSON from Claude Code
 * {
 *   hook_event_name: "PostToolUse",
 *   session_id: "...",
 *   tool_name: "Bash",
 *   tool_input: { command: "..." },
 *   tool_output: "...",
 *   tool_exit_code: 0
 * }
 */
'use strict';

const { storeArtifact } = require('../artifacts-store');

// ── Regex patterns ────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s"'<>)\]},]{4,}/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g;
const API_KEY_RE = /\b(AIza[A-Za-z0-9_-]{35}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|xoxb-[A-Za-z0-9-]+)\b/g;
const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

const EMAIL_SKIP = [
  'example.com', '@types', '@modelcontextprotocol', '@anthropic',
  'noreply', '@users.noreply',
];

const TICKET_SKIP = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
  'HTTP', 'UTF', 'SHA', 'RSA', 'AES',
]);

// ── Extractors ────────────────────────────────────────────────────────────────

function extractUrls(text) {
  const matches = text.match(URL_RE) || [];
  return [...new Set(matches.map(u => u.replace(/[.,;:!?)}\]]+$/, '')))].slice(0, 10);
}

function extractEmails(text) {
  const matches = text.match(EMAIL_RE) || [];
  return [...new Set(matches)].filter(e => !EMAIL_SKIP.some(s => e.includes(s))).slice(0, 5);
}

function extractIPs(text) {
  const matches = text.match(IP_RE) || [];
  return [...new Set(matches)].filter(ip =>
    !ip.startsWith('0.') && !ip.startsWith('127.0.0') && ip !== '0.0.0.0'
  ).slice(0, 5);
}

function extractApiKeys(text) {
  const matches = text.match(API_KEY_RE) || [];
  return [...new Set(matches)].map(key => {
    const prefix = key.slice(0, 8);
    const suffix = key.slice(-4);
    let service = 'unknown';
    if (key.startsWith('AIza')) service = 'google';
    else if (key.startsWith('sk-')) service = 'openai';
    else if (key.startsWith('ghp_')) service = 'github';
    else if (key.startsWith('xoxb-')) service = 'slack';
    return { masked: `${prefix}...${suffix}`, service };
  }).slice(0, 3);
}

function extractTickets(text) {
  const matches = text.match(TICKET_RE) || [];
  return [...new Set(matches)].filter(t => !TICKET_SKIP.has(t.split('-')[0]) && t.length < 20).slice(0, 5);
}

// ── Main extraction ───────────────────────────────────────────────────────────

function extractArtifacts(input) {
  const artifacts = [];
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const output = typeof input.tool_output === 'string' ? input.tool_output : '';
  const exitCode = input.tool_exit_code;
  const sessionId = input.session_id;

  const allText = [output, toolInput.command || '', toolInput.content || '', toolInput.description || ''].join(' ');

  // File paths from Write/Edit/Read/MultiEdit
  if (tool === 'Write' || tool === 'Edit' || tool === 'Read' || tool === 'MultiEdit') {
    const filePath = toolInput.file_path || toolInput.path || '';
    if (filePath) {
      artifacts.push({ type: 'document', content: filePath, metadata: { tool, ...(sessionId ? { session_id: sessionId } : {}) } });
    }
  }

  // Errors from failed Bash commands
  if (tool === 'Bash' && exitCode !== undefined && exitCode !== 0 && output) {
    const cmd = (toolInput.command || '').slice(0, 200);
    const errText = output.length > 2000 ? output.slice(-2000) : output;
    artifacts.push({
      type: 'error',
      content: `exit ${exitCode}: ${cmd}\n${errText}`.trim(),
      metadata: { exit_code: String(exitCode), tool, ...(sessionId ? { session_id: sessionId } : {}) },
    });
  }

  // URLs from output
  for (const url of extractUrls(output)) {
    if (url.length <= 500) {
      artifacts.push({ type: 'url', content: url, metadata: { source_tool: tool, ...(sessionId ? { session_id: sessionId } : {}) } });
    }
  }

  // Emails
  for (const email of extractEmails(allText)) {
    artifacts.push({ type: 'contact', content: email, metadata: { kind: 'email', source_tool: tool } });
  }

  // IP addresses
  for (const ip of extractIPs(allText)) {
    artifacts.push({ type: 'identifier', content: ip, metadata: { kind: 'ip_address', source_tool: tool } });
  }

  // API keys (masked — safe to store)
  for (const { masked, service } of extractApiKeys(allText)) {
    artifacts.push({ type: 'identifier', content: masked, metadata: { kind: 'api_key', service, source_tool: tool } });
  }

  // Ticket IDs
  for (const ticket of extractTickets(allText)) {
    artifacts.push({ type: 'identifier', content: ticket, metadata: { kind: 'ticket', source_tool: tool } });
  }

  return artifacts;
}

// ── Testable core (exported) ──────────────────────────────────────────────────

async function processHookInput(input, username) {
  if (input.hook_event_name !== 'PostToolUse') return;
  const artifacts = extractArtifacts(input);
  for (const a of artifacts) {
    storeArtifact({ username, type: a.type, content: a.content, metadata: a.metadata });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const username = process.env.AGENT_USER_ID;
  if (!username) process.exit(0);

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) process.exit(0);

  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  await processHookInput(input, username);
  process.exit(0);
}

module.exports = { extractArtifacts, processHookInput };

// Run as script when invoked directly
if (require.main === module) {
  main().catch(() => process.exit(0));
}
