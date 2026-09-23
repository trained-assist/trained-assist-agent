'use strict';
// Engine process runner (issue #942 P1.3). Extracted from src/runner.js so the
// spawn → stream-json → timeout/close machinery is a self-contained, testable
// unit, independent of the task orchestration that lives in runner.js.
//
// Owns: building the engine argv (claude/codex/opencode), spawning the process,
// consuming stream-json stdout, progress editing (heartbeat/streaming/typing),
// and the 38min SIGTERM / 40min SIGKILL / 5min-inactivity lifecycle. Returns a
// structured result; runner.js decides retry/continuation/session policy on top.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STREAM_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 3000;
const STOP_BUTTON_AFTER_SECS = 5;
const MAX_MSG_LEN = 3500;
const CLAUDE_TIMEOUT_MS = 40 * 60 * 1000; // 40 min hard limit
const WARN_TIMEOUT_MS  = 38 * 60 * 1000; // 38 min — graceful SIGTERM + Telegram warning before hard kill
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min silence → kill + auto-restart (all engines)

const TG_API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

// Reads the per-user .mcp.json (written by writeMcpConfig) and returns its mcpServers map.
// Shared translation source for codex (-c overrides) and opencode (OPENCODE_CONFIG file) below.
function loadMcpServers(mcpConfig) {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpConfig, 'utf8'));
    return raw.mcpServers || {};
  } catch { return {}; }
}

// TOML inline-table literal, e.g. {FOO="bar",BAZ="qux"} — for codex's `-c key=value` overrides,
// where value is parsed as TOML. codex has no native --mcp-config flag (verified via `codex mcp
// list -c mcp_servers.<name>.{command,args,env}=...`); this stays per-invocation, not a
// persistent `codex mcp add`, so concurrent users never race on the shared ~/.codex/config.toml.
function tomlInlineTable(obj) {
  return '{' + Object.entries(obj).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(',') + '}';
}

function codexMcpArgs(mcpConfig) {
  const servers = loadMcpServers(mcpConfig);
  const args = [];
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.command) continue;
    args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(srv.command)}`);
    if (srv.args) args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(srv.args)}`);
    if (srv.env) args.push('-c', `mcp_servers.${name}.env=${tomlInlineTable(srv.env)}`);
  }
  return args;
}

// opencode has no per-invocation MCP flag either, but does merge config from the file at
// $OPENCODE_CONFIG on top of the global ~/.config/opencode/opencode.json (verified against
// opencode's own config docs), so a per-user file set via env var is the isolation-safe
// equivalent of claude's --mcp-config — no shared-file mutation, no cross-user race.
//
// ocProfileOverrides (optional): the {model, agent: {build|plan|explore|general|review: {model}}}
// shape from .opencode/profiles/<name>.json (see profiles.getOcProfile). Folding it in here —
// same per-invocation file, same deep-merge-on-top-of-global-file behaviour — replaces the old
// opencode-switch-profile.sh, which overwrote the one shared ~/.config/opencode/opencode.json
// for every profile on the VM. Deep merge means agent.review's base fields (prompt/permission/
// etc., only present in the global file) survive; only .model gets overridden per profile.
function writeOpencodeMcpConfig(cwd, mcpConfig, ocProfileOverrides) {
  const servers = loadMcpServers(mcpConfig);
  const mcp = {};
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.command) continue;
    mcp[name] = {
      type: 'local',
      command: [srv.command, ...(srv.args || [])],
      ...(srv.env ? { environment: srv.env } : {}),
    };
  }
  const configPath = path.join(cwd, '.opencode-mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcp, ...ocProfileOverrides }, null, 2));
  return configPath;
}

// Reads opencode.json and returns agent-name -> shortened model-id map (for footer breakdown).
function readOcAgentModels() {
  try {
    const cfgPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    if (!fs.existsSync(cfgPath)) return {};
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const shorten = m => (m || '').replace(/^openrouter\//, '').replace(/^gigachat\//, '');
    const defaultModel = shorten(cfg.model);
    const result = { _default: defaultModel };
    for (const [name, agent] of Object.entries(cfg.agent || {})) {
      result[name] = shorten(agent.model || cfg.model);
    }
    return result;
  } catch { return {}; }
}

// Build the argv for the selected engine (claude/codex/opencode).
// Returns [bin, args].
function buildEngineCommand({ engine, prompt, systemPromptText, ocSystemPrompt, opencodeModel, mcpConfig, systemPromptFile, user }) {
  const opencodeModelResolved = opencodeModel || process.env.OPENCODE_MODEL || null;
  if (engine === 'codex') {
    // Validated 2026-09-23: capping raw tool-output tokens cuts the *uncached* input
    // tokens a cat/grep/diff-heavy turn needs by ~40% (measured 18.7k -> 10.7k avg
    // over repeated codex exec trials on the same task) without breaking correctness
    // (codex appends a truncation notice with real counts, it doesn't blindly cut).
    // This is the confirmed root cause of Codex's outsized input-token growth — see
    // https://instant-publish.trainedassist.store/p/codex-input-token-breakdown.
    const toolOutputTokenLimit = process.env.CODEX_TOOL_OUTPUT_TOKEN_LIMIT || '4000';
    return [process.env.CODEX_BIN || 'codex', [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', user.cwd || user.workDir,
      '-c', `tool_output_token_limit=${toolOutputTokenLimit}`,
      ...codexMcpArgs(mcpConfig),
      systemPromptText ? `${systemPromptText}\n\n${prompt}` : prompt,
    ]];
  }
  if (engine === 'opencode') {
    return [process.env.OPENCODE_BIN || 'opencode', [
      'run',
      '--format', 'json',
      '--auto',
      ...(opencodeModelResolved ? ['-m', opencodeModelResolved] : []),
      ocSystemPrompt ? `${ocSystemPrompt}\n\n${prompt}` : prompt,
    ]];
  }
  return [process.env.CLAUDE_BIN || 'claude', [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', mcpConfig,
    ...(systemPromptFile && fs.existsSync(systemPromptFile) ? ['--append-system-prompt-file', systemPromptFile] : []),
    '--print', prompt,
  ]];
}

// One-line human label for a tool invocation, shown in the progress message.
function formatToolActivity(name, input = {}) {
  switch (name) {
    case 'Bash': {
      const cmd = (input.command || '').trim().replace(/\n/g, ' ').slice(0, 80);
      return `💻 ${cmd}`;
    }
    case 'Read':
      return `📖 Читаю ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'Write':
      return `✍️ Пишу ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'Edit':
      return `✏️ Редактирую ${(input.file_path || '').replace(/^.*\//, '').slice(0, 60)}`;
    case 'WebFetch':
      return `🌐 ${(input.url || '').slice(0, 60)}`;
    case 'WebSearch':
      return `🔍 ${(input.query || '').slice(0, 60)}`;
    case 'Agent':
      return `🤖 Запускаю агента…`;
    default: {
      // MCP tool names: strip "mcp__<server>__" prefix for display
      const shortName = name.replace(/^mcp__[^_]+__/, '');
      switch (shortName) {
        case 'illustrate_generate':  return `🎨 Генерирую иллюстрацию…`;
        case 'illustrate_refine':    return `🎨 Дорабатываю иллюстрацию…`;
        case 'illustrate_preview_prompt': return `🖊 Готовлю промпт…`;
        case 'image_label':          return `🏷 Добавляю подписи на изображение…`;
        case 'image_label_adjust':   return `🏷 Корректирую подписи…`;
        default:                     return `🔧 ${shortName}`;
      }
    }
  }
}

/**
 * Run the engine process to completion with streaming.
 *
 * opts (all fields required unless noted):
 *   engine, taskId, chatId, thinkingStart, msgId (may be null),
 *   BOT_TOKEN, secrets, user, cleanEnv, userTokens, sessionFilePath,
 *   sessionId (may be null for a brand-new session — stored on sessionState so
 *   runner.isSessionRunning(sessionId) can detect a live run for re-entrancy guards),
 *   restartShutdown: () => boolean,
 *   activeTimers: Map (register sessionState so /stop and /restart can reach the proc),
 *   tgEdit, tgSend, outputCallback,
 *   engineBin, engineArgs (already built), cwd, env, mcpConfig (path to the per-user .mcp.json;
 *   used to derive OPENCODE_CONFIG for opencode — codex gets its MCP wiring baked into
 *   engineArgs already, via codexMcpArgs in buildEngineCommand),
 *   ocProfileOverrides (optional, opencode only — {model, agent} from profiles.getOcProfile,
 *   folded into the same per-invocation OPENCODE_CONFIG file),
 *   formatToolActivity, readOcAgentModels
 *   onHeartbeat (optional, () => void — called on the existing 30s inactivity-check tick so the
 *   pending-task journal's lastHeartbeatAt stays fresh while the process is alive; issue #942 [011])
 *
 * Returns a plain result object — never throws for process-level failures:
 *   { fullOutput, lastAssistantMsg, claudeResult, terminalSuccess,
 *     claudeUsage, opencodeUsage, opencodeBreakdown, claudeModel,
 *     lastActivity, exitCode, processSignal, processError, timedOut,
 *     inactivityKill, outputPersistenceError, codexErrorMsg, sessionState }
 */
async function runEngineProcess(opts) {
  const {
    engine, taskId, chatId, thinkingStart, msgId, BOT_TOKEN, secrets, user,
    cleanEnv, userTokens, sessionFilePath, sessionId, restartShutdown, activeTimers,
    tgEdit, tgSend, outputCallback, engineBin, engineArgs, cwd, env, mcpConfig,
    ocProfileOverrides, onHeartbeat,
  } = opts;

  const proc = spawn(engineBin, engineArgs, {
    cwd,
    env: {
      ...cleanEnv,
      ...userTokens,
      AGENT_USER_ID: String(user.username),
      AGENT_CHAT_ID: String(chatId),
      ...(secrets.BOT_TOKEN      ? { AGENT_BOT_TOKEN:    secrets.BOT_TOKEN }      : {}),
      ...(secrets.DEEPGRAM_API_KEY ? { DEEPGRAM_API_KEY: secrets.DEEPGRAM_API_KEY } : {}),
      ...(secrets.OPENAI_API_KEY ? { OPENAI_API_KEY:     secrets.OPENAI_API_KEY } : {}),
      ...(secrets.FAL_KEY        ? { FAL_KEY:            secrets.FAL_KEY }        : {}),
      ...(secrets.IDEOGRAM_API_KEY ? { IDEOGRAM_API_KEY: secrets.IDEOGRAM_API_KEY } : {}),
      ...(secrets.RECRAFT_API_KEY  ? { RECRAFT_API_KEY:  secrets.RECRAFT_API_KEY }  : {}),
      ...(secrets.CF_API_TOKEN     ? { CLOUDFLARE_API_TOKEN: secrets.CF_API_TOKEN } : {}),
      ...(user.name     ? { AGENT_USER_NAME: user.name }         : {}),
      ...(user.username ? { AGENT_USER_HANDLE: user.username }   : {}),
      ...(sessionFilePath ? { AGENT_SESSION_FILE: sessionFilePath } : {}),
      AGENT_TASK_ID: taskId,
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0', // disable 600s background-task kill
      ...(engine === 'opencode' && mcpConfig ? { OPENCODE_CONFIG: writeOpencodeMcpConfig(cwd, mcpConfig, ocProfileOverrides) } : {}),
    },
    // codex exec and opencode run both block on open stdin — close it explicitly.
    // claude doesn't read stdin in --print mode.
    // opencode waits 3s for stdin data before proceeding — use 'pipe' + immediate .end()
    // so it sees EOF instantly rather than waiting the full 3-second timeout.
    ...(engine === 'codex' || engine === 'opencode' ? { stdio: ['pipe', 'pipe', 'pipe'] } : {}),
  });
  if (engine === 'codex' || engine === 'opencode') proc.stdin.end();

  let streamTimer = null;
  let heartbeatTimer = null;
  let typingTimer = null;   // periodic sendChatAction: typing during active streaming
  let outputStarted = false;
  let lastSent = '';
  let lineBuffer = '';
  let fullOutput = { text: '' };
  let claudeResult = null;  // text from result event
  let lastAssistantMsg = ''; // last complete assistant turn — clean fallback, not the whole scratchpad
  let terminalSuccess = false; // explicit engine completion, never inferred from narration
  let processSignal = null;
  let processError = null;
  let claudeUsage = null;   // usage from result event (Claude Code / Codex)
  let opencodeUsage = null; // accumulated totals from step_finish events (OpenCode)
  let opencodeBreakdown = []; // per-agent steps: [{agent, model, input, output, cacheRead, cacheWrite, cost}]
  let currentOcAgent = null; // last 'agent' event name, to label the next step_finish
  let ocAgentModels = {}; // lazily loaded from opencode.json
  let claudeModel = null;   // model name from assistant event
  let lastActivity = '';     // last tool name/cmd for heartbeat
  let exitCode = 0;
  let codexErrorMsg = null;  // last turn.failed / error message from codex/opencode
  let lastOutputAt = Date.now(); // updated on any raw stdout data for inactivity detection
  let inactivityKill = false;   // true when killed due to silence, not 40-min timeout
  let inactivityCheckTimer = null;

  // Drain in-flight progress edits before posting a terminal message.
  const progressEdits = new Set();
  let progressStopped = false;
  function progressEdit(...args) {
    if (progressStopped) return Promise.resolve();
    // Progress/status edits are cosmetic: best-effort (drop on 429 — a missed
    // "Думаю…" update is fine, a 5-44s block is not) and coalesced per chat so
    // concurrent sessions sharing a bot token can't flood editMessageText.
    const pending = tgEdit(...args, { bestEffort: true, coalesce: true }).catch(() => {});
    progressEdits.add(pending);
    pending.finally(() => progressEdits.delete(pending));
    return pending;
  }
  async function stopProgress() {
    progressStopped = true;
    clearInterval(streamTimer);
    clearInterval(heartbeatTimer);
    clearInterval(typingTimer); typingTimer = null;
    clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
    await Promise.allSettled([...progressEdits]);
  }

  // Heartbeat: show elapsed seconds while Claude hasn't produced output yet
  let stopButtonShown = false;
  if (msgId) {
    heartbeatTimer = setInterval(async () => {
      if (outputStarted) return;
      const secs = Math.round((Date.now() - thinkingStart) / 1000);
      const label = lastActivity || 'Думаю…';
      const extra = (!stopButtonShown && secs >= STOP_BUTTON_AFTER_SECS)
        ? (stopButtonShown = true, { reply_markup: { inline_keyboard: [[{ text: '⛔ Стоп', callback_data: `stop|${taskId}` }]] } })
        : {};
      await progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ${label} (${secs}с)`, extra).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleStream() {
    if (streamTimer || progressStopped) return;
    outputStarted = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    // sendChatAction: typing every 4s — keeps "typing..." indicator alive in Telegram
    // (indicator expires after ~5s, so refresh before it disappears)
    if (msgId && !typingTimer) {
      const sendTyping = () => fetch(`${TG_API}/bot${BOT_TOKEN}/sendChatAction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
      sendTyping();
      typingTimer = setInterval(sendTyping, 4_000);
    }
    let streamEditInProgress = false;
    streamTimer = setInterval(async () => {
      if (streamEditInProgress) return;
      streamEditInProgress = true;
      try {
        const snippet = fullOutput.text.slice(-MAX_MSG_LEN);
        const secs = Math.round((Date.now() - thinkingStart) / 1000);
        const stopExtra = (!stopButtonShown && secs >= STOP_BUTTON_AFTER_SECS)
          ? (stopButtonShown = true, { reply_markup: { inline_keyboard: [[{ text: '⛔ Стоп', callback_data: `stop|${taskId}` }]] } })
          : {};
        if (snippet) {
          // ⚡ suffix signals "actively writing" (distinct from ⏱ waiting or clean final message)
          const silentMins = Math.round((Date.now() - lastOutputAt) / 60000);
          const silentSuffix = silentMins >= 1 ? ` — молчит ${silentMins}мин` : '';
          const activitySuffix = lastActivity ? `\n\n⚡ ${lastActivity} (${secs}с)${silentSuffix}` : `\n\n⚡ Пишу… (${secs}с)${silentSuffix}`;
          const newText = `🧠 ${snippet}${activitySuffix}`;
          if (newText === lastSent && !stopExtra.reply_markup) return;
          lastSent = newText;
          if (msgId) await progressEdit(BOT_TOKEN, chatId, msgId, newText, stopExtra).catch(() => {});
        } else {
          // No text yet (e.g. Claude running tools) — show activity + elapsed
          const label = lastActivity || 'Думаю…';
          const newText = `🧠 ${label} (${secs}с)`;
          if (newText === lastSent && !stopExtra.reply_markup) return;
          lastSent = newText;
          if (msgId) await progressEdit(BOT_TOKEN, chatId, msgId, newText, stopExtra).catch(() => {});
        }
      } finally {
        streamEditInProgress = false;
      }
    }, STREAM_INTERVAL_MS);
  }

  let firstJsonEventSeen = false;
  let outputPersistenceError = null;
  proc.stdout.setEncoding('utf8'); // preserve Cyrillic split across byte chunks
  function consumeOutput(chunk, flush = false) {
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep trailing incomplete line
    if (flush && lineBuffer) { lines.push(lineBuffer); lineBuffer = ''; }

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        firstJsonEventSeen = true;
        if (engine === 'opencode') {
          if (event.type === 'text' && typeof event.part?.text === 'string') {
            fullOutput.text += event.part.text;
            lastAssistantMsg = fullOutput.text;
            scheduleStream();
          } else if (event.type === 'tool_use' && event.part) {
            // Progress visibility for opencode (issue: GLM sessions look frozen):
            // tool events arrive only AFTER completion in --format json, so also
            // track step_start as "model is thinking/working" to update lastActivity.
            const ocTool = event.part.tool || 'tool';
            const ocInput = event.part.state?.input || {};
            const ocLabel = formatToolActivity(ocTool === 'bash' ? 'Bash' : ocTool === 'read' ? 'Read' : ocTool === 'write' ? 'Write' : ocTool === 'edit' ? 'Edit' : ocTool === 'glob' || ocTool === 'grep' ? 'WebSearch' : ocTool, ocInput);
            lastActivity = ocLabel;
            lastOutputAt = Date.now();
            if (!outputStarted && msgId) {
              const secs = Math.round((Date.now() - thinkingStart) / 1000);
              progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ⚡ ${ocLabel} (${secs}с)`).catch(() => {});
            }
            scheduleStream();
          } else if (event.type === 'step_start') {
            lastOutputAt = Date.now();
            if (!lastActivity) lastActivity = 'Думаю…';
            scheduleStream();
          } else if (event.type === 'agent') {
            // Track which agent is about to run so we can label its step_finish
            currentOcAgent = event.part?.name || null;
          } else if (event.type === 'step_finish') {
            terminalSuccess = true;
            claudeResult = fullOutput.text.trim() || null;
            const usage = event.part?.tokens;
            if (usage) {
              if (!ocAgentModels || !Object.keys(ocAgentModels).length) ocAgentModels = readOcAgentModels();
              const agentModel = ocAgentModels[currentOcAgent] || ocAgentModels._default || null;
              const stepIn = usage.input || 0;
              const stepOut = usage.output || 0;
              const stepCR = usage.cache?.read || 0;
              const stepCW = usage.cache?.write || 0;
              const stepCost = event.part.cost || 0;
              opencodeBreakdown.push({ agent: currentOcAgent || 'run', model: agentModel, input: stepIn, output: stepOut, cacheRead: stepCR, cacheWrite: stepCW, cost: stepCost });
              if (!opencodeUsage) opencodeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
              opencodeUsage.input += stepIn; opencodeUsage.output += stepOut;
              opencodeUsage.cacheRead += stepCR; opencodeUsage.cacheWrite += stepCW;
              opencodeUsage.cost += stepCost;
              console.log(`[${taskId}] opencode step[${currentOcAgent}/${agentModel}]: in=${stepIn} out=${stepOut} cR=${stepCR} cW=${stepCW} cost=${stepCost}`);
            }
          } else if (event.type === 'error') {
            const errMsg = event.error?.data?.message || event.error?.message || JSON.stringify(event.error);
            console.warn(`[${taskId}] opencode error event:`, errMsg);
            codexErrorMsg = errMsg;
            const isRateLimit = /429|rate.?limit|too many requests/i.test(errMsg);
            const userErrMsg = isRateLimit
              ? `⚠️ OpenCode: превышен лимит запросов к модели. Переключись на Claude: /switch2klod`
              : `❌ OpenCode ошибка: ${errMsg}`;
            fullOutput.text += `\n${userErrMsg}`;
            lastAssistantMsg = fullOutput.text.trim();
            scheduleStream();
          }
          continue;
        }
        if (engine === 'codex') {
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
            fullOutput.text += event.item.text;
            lastAssistantMsg = event.item.text;
            // A message alone is not proof that the turn completed.
            if (outputCallback) try { outputCallback(event.item.text); } catch {}
            scheduleStream();
          } else if (event.type === 'item.started' && event.item?.type === 'command_execution') {
            lastAssistantMsg = '';
            lastActivity = formatToolActivity('Bash', { command: event.item.command });
            if (!outputStarted && msgId) {
              const secs = Math.round((Date.now() - thinkingStart) / 1000);
              progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ⚡ ${lastActivity} (${secs}с)`).catch(() => {});
            }
          } else if (event.type === 'turn.completed') {
            terminalSuccess = true;
            claudeResult = lastAssistantMsg;
            // Codex names its cache fields differently from Claude's `result` event
            // (cached_input_tokens/cache_write_input_tokens vs. cache_read_input_tokens/
            // cache_creation_input_tokens) — normalize here so every downstream consumer
            // (cost calc, footer, usage-store) can read the Claude-shaped field names
            // regardless of engine.
            claudeUsage = event.usage
              ? {
                  ...event.usage,
                  cache_read_input_tokens: event.usage.cached_input_tokens || 0,
                  cache_creation_input_tokens: event.usage.cache_write_input_tokens || 0,
                }
              : null;
            if (claudeUsage) {
              console.log(`[${taskId}] usage: in=${claudeUsage.input_tokens} out=${claudeUsage.output_tokens} cache_read=${claudeUsage.cache_read_input_tokens} cache_write=${claudeUsage.cache_creation_input_tokens}`);
            }
          } else if (event.type === 'turn.failed' || event.type === 'error') {
            console.warn(`[${taskId}] codex ${event.type}:`, JSON.stringify(event).slice(0, 500));
            codexErrorMsg = event.error?.message || event.message || codexErrorMsg;
          }
          continue;
        }
        if (event.type === 'result') {
          terminalSuccess = !event.is_error && (!event.subtype || event.subtype === 'success');
          claudeResult = typeof event.result === 'string' ? event.result : null;
          claudeUsage = event.usage || null;
          if (claudeUsage) {
            console.log(`[${taskId}] usage: in=${claudeUsage.input_tokens} out=${claudeUsage.output_tokens} cache_read=${claudeUsage.cache_read_input_tokens || 0} cache_write=${claudeUsage.cache_creation_input_tokens || 0}`);
          }
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          if (event.message?.model && !claudeModel) claudeModel = event.message.model;
          let turnText = '';
          for (const block of event.message.content) {
            if (block.type === 'text') {
              fullOutput.text += block.text;
              turnText += block.text;
              if (outputCallback) try { outputCallback(block.text); } catch {}
            } else if (block.type === 'tool_use') {
              lastActivity = formatToolActivity(block.name, block.input);
              if (!outputStarted && msgId) {
                const secs = Math.round((Date.now() - thinkingStart) / 1000);
                progressEdit(BOT_TOKEN, chatId, msgId, `🧠 ⚡ ${lastActivity} (${secs}с)`).catch(() => {});
              }
            }
          }
          // Only treat as a final-answer candidate if the turn has no tool calls.
          // Text + tool_use in the same event = narration ("Смотрю X:"), not a conclusion.
          const turnHasTool = event.message.content.some(b => b.type === 'tool_use');
          // Claude emits text and tool blocks separately, with stop_reason=tool_use
          // even on the text-only event. A later tool event also invalidates old text.
          if (turnHasTool || event.message.stop_reason === 'tool_use') lastAssistantMsg = '';
          else if (turnText.trim() && event.message.stop_reason === 'end_turn') lastAssistantMsg = turnText;
          scheduleStream();
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          outputPersistenceError = error;
          try { proc.kill('SIGTERM'); } catch {}
          continue;
        }
        if (!firstJsonEventSeen) {
          console.warn(`[${taskId}] pre-JSON stdout:`, line);
          continue;
        }
        // Non-JSON line after stream started — treat as plain text
        fullOutput.text += line + '\n';
        scheduleStream();
      }
    }
  }
  proc.stdout.on('data', chunk => { lastOutputAt = Date.now(); consumeOutput(chunk); });
  proc.stdout.on('end', () => consumeOutput('', true));

  proc.stderr.on('data', chunk => console.error(`[${taskId}] stderr:`, chunk.toString()));

  let timedOut = false;
  const sessionState = { killFn: null, killTimer: null, extendCount: 0, proc, userStopped: false, chatId, sessionId };
  activeTimers.set(taskId, sessionState);
  try {
    await new Promise((resolve, reject) => {
      // 38 min: graceful SIGTERM + warn user. Claude Code handles SIGTERM by finishing current step and exiting.
      // timedOut is set here so that if Claude exits voluntarily after SIGTERM, the close handler still
      // triggers auto-continuation (not just when SIGKILL fires at 40 min).
      const warnTimer = setTimeout(() => {
        timedOut = true;
        console.log(`[${taskId}] timeout warning — sending SIGTERM, 2 min left`);
        try { proc.kill('SIGTERM'); } catch {}
        const warnMin = Math.round(WARN_TIMEOUT_MS / 60000);
        const engineLabel = engine === 'codex' ? 'Кодекс' : engine === 'opencode' ? 'OpenCode' : 'Клод';
        tgSend(BOT_TOKEN, chatId,
          `⚠️ ${engineLabel} работает уже ${warnMin} минут — через 2 мин задача принудительно завершится.\n` +
          `Получил сигнал завершить текущий шаг и вывести итоги.`
        ).catch(() => {});
      }, WARN_TIMEOUT_MS);

      // 40 min: hard kill (SIGTERM already sent at 38 min, SIGKILL now)
      sessionState.killFn = () => {
        timedOut = true;
        clearTimeout(warnTimer);
        try { proc.kill('SIGKILL'); } catch (e) { console.warn('[runner] SIGKILL:', e.message); }
        reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
      };
      sessionState.killTimer = setTimeout(sessionState.killFn, CLAUDE_TIMEOUT_MS);

      // Inactivity check: if no stdout for 5 min, kill + auto-restart (works for all engines).
      // Checked every 30s; lastOutputAt updated on any raw stdout chunk before JSON parsing.
      // Same tick also heartbeats the pending-task journal (issue #942 [011] watchdog step 1a) —
      // piggybacking on this existing interval instead of adding a second timer.
      inactivityCheckTimer = setInterval(() => {
        if (onHeartbeat) { try { onHeartbeat(); } catch (e) { console.warn(`[${taskId}] heartbeat write failed:`, e.message); } }
        if (timedOut || sessionState.userStopped) return;
        const silentMs = Date.now() - lastOutputAt;
        if (silentMs >= INACTIVITY_TIMEOUT_MS) {
          clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
          inactivityKill = true;
          timedOut = true;
          const silentMins = Math.round(silentMs / 60000);
          console.warn(`[${taskId}] inactivity: no stdout for ${silentMins}min — SIGTERM`);
          try { proc.kill('SIGTERM'); } catch {}
          reject(new Error(`inactivity timeout: no output for ${silentMins}min`));
        }
      }, 30_000);

      proc.on('close', (code, signal) => {
        processSignal = signal;
        clearTimeout(sessionState.killTimer);
        clearTimeout(warnTimer);
        clearInterval(inactivityCheckTimer); inactivityCheckTimer = null;
        if (code !== null && code !== 0) {
          console.error(`[${taskId}] claude exited with code ${code}`);
          exitCode = code;
        }
        // If SIGTERM already fired (timedOut=true), reject so the caller runs auto-continuation
        if (timedOut && !restartShutdown()) {
          reject(new Error(`claude exited after SIGTERM (code ${code})`));
        } else {
          resolve(code);
        }
      });
      proc.on('error', (err) => {
        clearTimeout(sessionState.killTimer);
        clearTimeout(warnTimer);
        reject(err);
      });
    });
  } catch (err) {
    processError = err.message;
    await stopProgress();
    console.error(`[${taskId}] claude process error:`, err.message);
  } finally {
    activeTimers.delete(taskId);
    await stopProgress();
    heartbeatTimer = null;
  }

  return {
    fullOutput, lastAssistantMsg, claudeResult, terminalSuccess,
    claudeUsage, opencodeUsage, opencodeBreakdown, claudeModel,
    lastActivity, exitCode, processSignal, processError, timedOut,
    inactivityKill, outputPersistenceError, codexErrorMsg, sessionState,
  };
}

module.exports = {
  runEngineProcess,
  buildEngineCommand,
  formatToolActivity,
  readOcAgentModels,
  // exposed for tests — MCP translation helpers (codex/opencode wiring)
  codexMcpArgs,
  writeOpencodeMcpConfig,
  // constants exposed for tests
  _const: { STREAM_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, MAX_MSG_LEN, CLAUDE_TIMEOUT_MS, WARN_TIMEOUT_MS, INACTIVITY_TIMEOUT_MS },
};