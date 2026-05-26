import "./polyfill.js";
const _isDebug = () => { const v = Bun.env.DEBUG; return v === "1" || v === "true" || v === "yes"; };
if (_isDebug()) try { process.stderr.write(`[Snet] startup pid=${process.pid} argv=${JSON.stringify(process.argv)}\r\n`); } catch {}

// 1b. Crypto polyfill (Node.js < 19)
if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
  const nodeCrypto = await import("node:crypto");
  globalThis.crypto = globalThis.crypto || {};
  globalThis.crypto.randomUUID = nodeCrypto.randomUUID;
}

// 2. Fetch Polyfill (Try native, then undici)
if (typeof fetch === 'undefined') {
  try {
    const mod = await import('undici');
    globalThis.fetch = mod.fetch;
    globalThis.Request = mod.Request;
    globalThis.Response = mod.Response;
    globalThis.Headers = mod.Headers;
    if (!globalThis.TransformStream && mod.TransformStream) {
      globalThis.TransformStream = mod.TransformStream;
    }
    if (!globalThis.ReadableStream && mod.ReadableStream) {
      globalThis.ReadableStream = mod.ReadableStream;
    }
  } catch (e) {
    console.error("\n[FATAL] Missing 'undici' package. Please run: npm install undici\n");
    process.exit(1);
  }
}

// 2b. Stream polyfills (Node.js < 18)
if (typeof TransformStream === 'undefined') {
  try { const { TransformStream: TS } = await import("node:stream/web"); globalThis.TransformStream = TS; } catch {}
}
if (typeof ReadableStream === 'undefined') {
  try { const { ReadableStream: RS } = await import("node:stream/web"); globalThis.ReadableStream = RS; } catch {}
}

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { config, getModels, initModels, resolveModel, resolveModelMetadata, isKnownModel, chatCompletion, APIError, isSeparator, isDeepSeekModel, isMiMoModel, SEP_DEEPSEEK, SEP_MIMO, refreshModels, bgFetchDone, fetchWithAgent, getThinkingModes, parseThinkingMode } from "./snet-handle.js";
import { check as cacheCheck, store as cacheStore, cacheKey } from "./cache.js";
import { ModelConcurrencyManager, RateLimitError, truncateToolMessagesInPayload, checkRequestBodySize } from "./concurrency.js";
import { compactIdentity, compactToolInstructions, compactOllamaToolInstructions, compactCodeCompletionPrompt, compressMessages, compressHistory, buildToolRunSummary, condenseAfterTaskComplete } from "./token-optimizer.js";
import { trackSession, touchSession, stopSession as keepaliveStopSession, shutdown as keepaliveShutdown, stats as keepaliveStats } from "./session-keepalive.js";
import { handleServiceCommand, runAsService } from "./win-service.js";
import { log, error as logErr, debug, reqLog, enableDashboard, disableDashboard, onCommand, collapseBanner, expandBanner, redrawBanner, setBoxWidth } from "./logger.js";
import { isDeepSeekAvailable } from "./deepseek-client.js";
import { isMiMoAvailable } from "./mimo-client.js";
import { t, setLanguage, getLanguage } from "./i18n.js";

// ── Service command routing (early exit for install/uninstall) ──
{
  const svcCmd = await handleServiceCommand(process.argv);
  if (svcCmd.handled) process.exit(svcCmd.exitCode);
}

// ── Service mode detection ──
const _isServiceMode = process.argv.includes("--service") || process.env.SNET_SERVICE === "1";
const _isPlainMode = process.argv.includes("--plain") || Bun.env.SNET_PLAIN === "1";

// 构建日期文件（由构建脚本写入）
const VERSION_FILE = ".version";

// ── Logging ──
const logReq = (c) => {
  if (!config.requestLog) return;
  const path = new URL(c.req.url).pathname;
  const ua = (c.req.header("User-Agent") || "none").slice(0, 120);
  const baggage = (c.req.header("baggage") || "none").slice(0, 160);
  const accept = (c.req.header("Accept") || "none").slice(0, 80);
  const xEditor = (c.req.header("x-editor-version") || c.req.header("X-Editor-Version") || "").slice(0, 60);
  const xVSSession = (c.req.header("x-vss-session-id") || "").slice(0, 40);
  const extras = [ua, baggage ? `baggage=${baggage}` : "", accept ? `accept=${accept}` : "", xEditor ? `editor=${xEditor}` : "", xVSSession ? `vss=${xVSSession}` : ""].filter(Boolean).join(" ");
  log(`${c.req.method} ${path} ${extras ? `| ${extras}` : ""}`);
};
const err = (msg) => logErr(msg);

// Auto-create .env if missing
(async () => {
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(".env")) {
      fs.writeFileSync(".env", "# === 服务器配置 ===\n# 监听端口（默认 11434）\n# SERVER_PORT=11434\n# 默认模型\n# DEFAULT_MODEL=ds/deepseek-v4-pro\n\n# === DeepSeek API ===\n# API 地址（可改为转发 API 地址）\n# DEEPSEEK_BASE_URL=https://api.deepseek.com\n# 获取 API Key：https://platform.deepseek.com/api_keys\nDEEPSEEK_API_KEY=\n\n# === 小米 MiMo API ===\n# API 地址（可改为转发 API 地址）\n# MIMO_BASE_URL=https://api.xiaomimimo.com/v1\n# 获取 API Key：https://platform.xiaomimimo.com/#/console/api-keys\nMIMO_API_KEY=\n\n# === 日志 ===\n# REQUEST_LOG=true\n# DEBUG=false\n\n# === 提示词压缩 ===\n# COMPRESSION_LEVEL=auto\n\n# === 并发与速率限制 ===\n# CONCURRENCY_THINKING=1\n# CONCURRENCY_STANDARD=3\n# RETRY_MAX=3\n\n# === 模型元数据 ===\n# FORCE_ALL_CAPABILITIES=true\n# DEFAULT_CONTEXT_LENGTH=131072\n\n# === 会话保活 ===\n# SESSION_KEEPALIVE_ENABLED=true\n# SESSION_KEEPALIVE_IDLE_TIMEOUT_MS=600000\n");
      log("已创建 .env");
    }
  } catch { /* fs模块不可用，忽略 */ }
})();

// No API key needed — free tier works without

const app = new Hono();
function _stripAllToolCalls(messages) {
  if (!messages?.length) return messages || [];
  return messages.map(m => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return { ...m, content: m.content || "", tool_calls: undefined };
    }
    return m;
  });
}

// ── 辅助函数 ──

const callId = () => `call_${crypto.randomUUID().slice(0, 8)}`;

const apiErr = (e) => {
  const status = e instanceof APIError ? e.status : 500;
  const code = status === 401 ? "invalid_api_key" : status === 429 ? "rate_limit_exceeded" : status === 404 ? "model_not_found" : status === 504 ? "gateway_timeout" : "server_error";
  const type = status === 401 ? "invalid_request_error" : status >= 500 ? "server_error" : "invalid_request_error";
  const param = status === 404 ? "model" : null;
  return { status, body: { error: { message: e.message, type, code, ...(param ? { param } : {}) } } };
};

async function getBody(c) {
  try {
    const text = await c.req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// Pre-flight: strip orphaned tool_calls from assistant messages that have no
// matching tool results, AND strip orphaned tool messages that have no matching
// assistant with tool_calls. Prevents DeepSeek validation errors both directions.
function _stripOrphanedToolCalls(messages) {
  if (!messages?.length) return { messages, stripped: 0 };
  let stripped = 0;

  // First pass: strip orphaned tool_calls from assistant messages
  let result = messages.map(m => {
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;

    const callIds = m.tool_calls.map(tc => tc.id);
    const matched = new Set();
    // Scan forward from this assistant for matching tool results
    const asstIdx = messages.indexOf(m);
    for (let j = asstIdx + 1; j < messages.length; j++) {
      const t = messages[j];
      if (t.role === "tool" && t.tool_call_id && callIds.some(cid => cid === t.tool_call_id)) {
        matched.add(t.tool_call_id);
      }
    }

    if (matched.size === 0) {
      // All tool calls are orphaned — strip them entirely
      stripped++;
      const { tool_calls, ...rest } = m;
      return { ...rest, content: m.content || "" };
    } else if (matched.size < callIds.length) {
      // Some tool calls have results, some don't — keep only the matched ones
      stripped++;
      const names = m.tool_calls.filter(tc => !matched.has(tc.id)).map(tc => tc.function?.name || "?");
      log(`  [tool] stripping ${callIds.length - matched.size} orphaned tool calls: ${names.join(", ")}`);
      return { ...m, tool_calls: m.tool_calls.filter(tc => matched.has(tc.id)) };
    }

    return m;
  });

  // Second pass: strip orphaned tool messages that have no matching assistant with tool_calls
  const before = result.length;
  result = result.filter(m => {
    if (m.role !== "tool") return true;
    // Walk backwards to find a preceding assistant with matching tool_calls
    const idx = result.indexOf(m);
    for (let j = idx - 1; j >= 0; j--) {
      const prev = result[j];
      if (prev.role === "assistant" && prev.tool_calls?.length) {
        if (prev.tool_calls.some(tc => tc.id === m.tool_call_id)) return true;
      }
      if (prev.role !== "assistant" && prev.role !== "tool") break;
    }
    stripped++;
    return false;
  });
  const orphanedTools = before - result.length;
  if (orphanedTools) debug(`  [tool] stripped ${orphanedTools} orphaned tool message${orphanedTools !== 1 ? "s" : ""}`);

  if (stripped) debug(`  [tool] stripped orphaned tool calls/messages from ${stripped} total`);
  return { messages: result, stripped };
}

const oaiResp = (content, tool_calls, finish_reason, model, usage) => {
  const choice = { index: 0, message: { role: "assistant" }, finish_reason: finish_reason || "stop" };
  if (content != null) choice.message.content = content;
  if (tool_calls?.length) choice.message.tool_calls = tool_calls;
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: ~~(Date.now() / 1000),
    model,
    choices: [choice],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
};

let _forceClient = null; // debug: ?src=vscode|vs|vsi|sql
let _detectedClient = null; // resolved client for logging

const isVSCode = (c) => {
  if (_forceClient) return _forceClient === "vscode";
  const ua = c.req.header("User-Agent") || "";
  return /GitHubCopilotChat\//i.test(ua);
};

const isVS2026 = (c) => {
  if (_forceClient) return _forceClient === "vs";
  const baggage = c.req.header("baggage") || "";
  return /vs\.copilot\./i.test(baggage);
};

const isVSInsiders = (c) => {
  if (_forceClient) return _forceClient === "vsi";
  const baggage = c.req.header("baggage") || "";
  return /VirtualAgentModeResponder/i.test(baggage);
};

const isSqlStudio = (c) => {
  if (_forceClient) return _forceClient === "sql";
  const baggage = c.req.header("baggage") || "";
  return /SSMSAgent/i.test(baggage);
};

function resolveClient(c) {
  const envClient = Bun.env.DEFAULT_CLIENT || "";
  if (envClient && ["vscode","vs","vsi","sql"].includes(envClient)) return envClient;
  if (isVSCode(c)) return "vscode";
  if (isVSInsiders(c)) return "vsi";
  if (isVS2026(c)) return "vs";
  if (isSqlStudio(c)) return "sql";
  return Bun.env.DEFAULT_CLIENT || "vscode"; // fallback or env default
}

// ── Parameter normalization (camelCase → snake_case) ──
function normalizeOpenAIParams(body) {
  const n = { ...body };
  if (n.topP !== undefined && n.top_p === undefined) n.top_p = n.topP;
  if (n.frequencyPenalty !== undefined && n.frequency_penalty === undefined) n.frequency_penalty = n.frequencyPenalty;
  if (n.presencePenalty !== undefined && n.presence_penalty === undefined) n.presence_penalty = n.presencePenalty;
  if (n.maxOutputTokens !== undefined && n.max_tokens === undefined) n.max_tokens = n.maxOutputTokens;
  if (n.chatTemplateKwargs !== undefined && n.chat_template_kwargs === undefined) n.chat_template_kwargs = n.chatTemplateKwargs;
  if (n.thinkingTokenBudget !== undefined && n.thinking_token_budget === undefined) n.thinking_token_budget = n.thinkingTokenBudget;
  delete n.topP; delete n.frequencyPenalty; delete n.presencePenalty; delete n.maxOutputTokens;
  delete n.chatTemplateKwargs; delete n.thinkingTokenBudget;
  return n;
}

// ── Special token sanitization ──
function sanitizeContent(content) {
  if (typeof content !== "string") return content;
  return content
    .replace(/<\|im_start\|>[^\n]*/gi, "")
    .replace(/<\|im_end\|>/gi, "")
    .replace(/<\|endoftext\|>/gi, "")
    .replace(/<\|fim_prefix\|>/gi, "")
    .replace(/<\|fim_suffix\|>/gi, "")
    .replace(/<\|fim_middle\|>/gi, "")
    .trim();
}

// ── Think tag processor ──
function processThinkTags(text) {
  if (!text || typeof text !== "string") return { content: text || "", reasoning: null };
  const thinkRe = /<think>\s*([\s\S]*?)\s*<\/think>/gi;
  let reasoning = "";
  let clean = text;
  let match;
  while ((match = thinkRe.exec(text)) !== null) {
    reasoning += (reasoning ? "\n" : "") + match[1].trim();
    clean = clean.replace(match[0], "");
  }
  clean = clean.replace(/<\/?think>/gi, "").trim();
  return {
    content: sanitizeContent(clean),
    reasoning: reasoning ? sanitizeContent(reasoning) : null,
  };
}

// ── Reasoning field aliasing ──
function addReasoningAliases(delta, reasoningText) {
  if (!reasoningText) return delta;
  if (_displayReasoning) return delta; // reasoning already folded into content, don't double-expose
  delta.reasoning = reasoningText;
  delta.reasoning_content = reasoningText;
  delta.reasoning_text = reasoningText;
  delta.thinking = reasoningText;
  return delta;
}

async function _simStream(w, base, hasTools, toolCalls, text, reasoningContent) {
  if (reasoningContent) {
    // When display_reasoning is on, fold reasoning into content as first delta
    if (_displayReasoning) {
      const folded = _foldReasoningIntoContent(reasoningContent, "");
      await w({ ...base, choices: [{ index: 0, delta: { content: folded }, finish_reason: null }] });
    } else {
      let dr = { content: "" };
      addReasoningAliases(dr, reasoningContent);
      await w({ ...base, choices: [{ index: 0, delta: dr, finish_reason: null }] });
    }
  }
  if (hasTools) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      await w({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] });
    }
    await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  } else {
    const lines = (text || "").split("\n");
    let buffer = "";
    for (const line of lines) {
      if (buffer.length + line.length + 1 > 200 && buffer) {
        await w({ ...base, choices: [{ index: 0, delta: { content: buffer + "\n" }, finish_reason: null }] });
        buffer = line;
      } else {
        buffer += (buffer ? "\n" : "") + line;
      }
    }
    if (buffer) await w({ ...base, choices: [{ index: 0, delta: { content: buffer }, finish_reason: null }] });
    await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  }
}

// Reasoning content cache — bridges across requests within same session
// Keyed by conversation ID (first user msg + model + workspace) to prevent cross-session poisoning
// Also keyed by workspace root for cross-session continuity (new session in same workspace
// can read reasoning from a prior session — TaskSync-inspired conversation continuity)
const _crossReqReasoningCache = new Map(); // convId:contentHash → reasoningContent
const _reasoningCacheMaxEntries = 5000; // max entries before LRU eviction

// ── Thinking display: mirror reasoning into Cursor/VS-visible markdown blocks ──
const _displayReasoning = (process.env.DISPLAY_REASONING || "false").toLowerCase() === "true";

// 工具调用错误计数器：连续 3 次 400 错误后剥离 tool_calls 重试
let _tool400Streak = 0;
const _collapsibleReasoning = (process.env.COLLAPSIBLE_REASONING || "true").toLowerCase() !== "false";
const _THINKING_BLOCK_START = _collapsibleReasoning ? "<details>\n<summary>snet Thinking</summary>\n\n" : "<!-- snet-thinking -->\n";
const _THINKING_BLOCK_END = _collapsibleReasoning ? "\n</details>\n\n" : "\n<!-- /snet-thinking -->\n\n";

function _foldReasoningIntoContent(reasoningText, existingContent) {
  if (!reasoningText) return existingContent || "";
  return _THINKING_BLOCK_START + reasoningText + _THINKING_BLOCK_END + (existingContent || "");
}

// Strip previously-displayed thinking blocks from assistant content (echoed back by VS/Cursor)
const _THINKING_STRIP_RE = new RegExp(
  `<details\\b[^>]*>\\s*<summary\\b[^>]*>\\s*snet Thinking\\s*</summary>[\\s\\S]*?</details>\\s*|<!-- snet-thinking -->\\s*[\\s\\S]*?\\s*<!-- /snet-thinking -->\\s*`,
  "gi"
);
function _stripDisplayedThinking(content) {
  if (typeof content !== "string") return content;
  return content.replace(_THINKING_STRIP_RE, "").trimStart();
}

// Session tracking — detect and number distinct conversation contexts
const _sessionRegistry = new Map(); // convId → { id, clientTag, createdAt, workspaceRoot }
// Workspace continuity — track most recent session per workspace+model for cross-session context
const _workspaceSessions = new Map(); // `${workspaceRoot}|${model}` → { convId, sessionId, lastSeen, clientTag }
// Workspace summaries — compact task-completion summaries to inject into future sessions
const _workspaceSummaries = new Map(); // workspaceRoot → { summary: string, timestamp, sessionId, model }
const _taskCompletedSessions = new Map(); // convId → true (set when LLM finishes task_complete naturally)
const _recentlyCompleted = new Map(); // convId → timestamp (set after hard stop, drains next VS follow-up)
const _rateLimitedSessions = new Map();     // convId → { at: timestamp } (set when upstream returns 429)
let _sessionCounter = 0;

// 定期清理过期会话条目（24 小时 TTL），防止长期运行的服务器内存泄漏
const _SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - _SESSION_MAX_AGE_MS;
  for (const [k, v] of _sessionRegistry) {
    if (new Date(v.createdAt).getTime() < cutoff) _sessionRegistry.delete(k);
  }
  for (const [k, v] of _workspaceSessions) {
    if (new Date(v.lastSeen).getTime() < cutoff) _workspaceSessions.delete(k);
  }
  for (const [k, v] of _workspaceSummaries) {
    if (new Date(v.timestamp).getTime() < cutoff) _workspaceSummaries.delete(k);
  }
  for (const [k, v] of _recentlyCompleted) {
    if (v < cutoff) _recentlyCompleted.delete(k);
  }
  for (const [k, v] of _rateLimitedSessions) {
    if (v.at < cutoff) _rateLimitedSessions.delete(k);
  }
}, 10 * 60 * 1000).unref();

function _convId(messages, model, workspaceRoot) {
  const preAssistant = [];
  for (const m of messages) {
    const role = (m.role || "").toLowerCase().trim();
    if (role === "assistant" || role === "tool") break;
    if (role === "user") preAssistant.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  }
  const anchor = preAssistant.join("\n") + "|" + (workspaceRoot || "") + "|" + (model || "");
  let h = 5381;
  for (let i = 0; i < anchor.length; i++) h = ((h << 5) + h + anchor.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function _startPrompt(messages) {
  const preAssistant = [];
  for (const m of messages) {
    const role = (m.role || "").toLowerCase().trim();
    if (role === "assistant" || role === "tool") break;
    if (role === "user") preAssistant.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  }
  return preAssistant.join("\n");
}

// ── Task completion summary ──
// When LLM calls task_complete, boil down tool calls + results into a compact
// instructional summary. Strips raw code/tool output, keeps only findings and
// actions the LLM can parse as instructions.
function _summarizeCompletedTask(messages) {
  const findings = [];
  const filesModified = new Set();
  const filesRead = new Set();
  let lastAssistantText = "";

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      // Collect tool calls
      const tcs = m.tool_calls || [];
      for (const tc of tcs) {
        const fn = tc.function || {};
        const name = fn.name || "";
        let args = {};
        try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || {}); } catch {}
        if (name === "create_file" || name === "write_to_file" || name === "write_file") {
          if (args.filePath || args.path || args.filename) filesModified.add(args.filePath || args.path || args.filename);
        } else if (name === "replace_in_file" || name === "replace_string_in_file" || name === "multi_replace_string_in_file") {
          if (args.filePath || args.path) filesModified.add(args.filePath || args.path);
        } else if (name === "remove_file" || name === "delete_file") {
          if (args.filePath || args.path) filesModified.add(args.filePath || args.path);
        } else if (name === "read_file" || name === "get_file" || name === "open_file") {
          if (args.filePath || args.path || args.filename) filesRead.add(args.filePath || args.path || args.filename);
        } else if (name === "grep_search" || name === "search_content" || name === "file_search") {
          const q = args.query || args.pattern || args.search || "";
          if (q) findings.push(`searched for "${q.slice(0, 80)}"`);
        } else if (name === "find_symbol" || name === "search_symbol") {
          const sym = args.symbolName || args.name || "";
          if (sym) findings.push(`looked up symbol "${sym}"`);
        } else if (name === "run_command_in_terminal" || name === "execute_command") {
          const cmd = args.command || args.cmd || "";
          if (cmd) findings.push(`ran: ${cmd.slice(0, 100)}`);
        } else if (name === "task_complete" || name === "start_modernization") {
          // skip — this is the completion marker itself
        } else {
          findings.push(`used ${name}()`);
        }
      }
      // Capture assistant text for context
      if (typeof m.content === "string" && m.content.trim()) {
        lastAssistantText = m.content.trim().split("\n").filter(l => l.trim()).slice(0, 3).join(" ");
      }
    } else if (m.role === "tool") {
      // Boil down tool results to key findings
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) continue;
      // Extract file paths mentioned in results
      const pathRe = /([\w./\\-]+\.(?:js|ts|tsx|jsx|cs|py|java|go|rs|cpp|c|h|hpp|css|html|json|xml|yaml|yml|md|sql|sh|bat|cmd|ps1))/gi;
      let match;
      while ((match = pathRe.exec(content)) !== null) {
        filesRead.add(match[1]);
      }
      // Extract error mentions
      const errRe = /Error[:\s]+([^\n]{10,120})/g;
      while ((match = errRe.exec(content)) !== null) {
        findings.push(`error: ${match[1].trim().slice(0, 120)}`);
      }
    }
  }

  // Build compact summary
  const parts = [];
  if (filesModified.size > 0) parts.push(`Modified: ${[...filesModified].join(", ")}`);
  if (filesRead.size > 0) parts.push(`Read: ${[...filesRead].slice(0, 8).join(", ")}${filesRead.size > 8 ? ` (+${filesRead.size - 8} more)` : ""}`);
  if (findings.length > 0) parts.push(`Actions: ${findings.join("; ")}`);
  if (lastAssistantText) parts.push(`Conclusion: ${lastAssistantText.slice(0, 300)}`);

  return parts.length > 0 ? parts.join(". ") : "";
}

// ── Reasoning cache helpers (multi-tier key system, inspired by yxlao/deepseek-cursor-proxy) ──
function _sha256(data) {
  // Simple yet effective hash for cache key generation (not cryptographic)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < data.length; i++) {
    const ch = data.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  const combined = (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  return combined;
}

function _normalizeToolCallForSig(tc) {
  if (!tc || typeof tc !== "object") return null;
  const fn = tc.function || {};
  const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
  return { type: tc.type || "function", function: { name: fn.name || "", arguments: args } };
}

function _toolCallSignature(tc) {
  const n = _normalizeToolCallForSig(tc);
  if (!n) return "";
  return _sha256(JSON.stringify(n));
}

function _toolCallIds(msg) {
  const ids = [];
  for (const tc of msg?.tool_calls || []) {
    if (tc && tc.id) ids.push(String(tc.id));
  }
  return ids;
}

function _toolCallNames(msg) {
  const names = [];
  for (const tc of msg?.tool_calls || []) {
    const n = tc?.function?.name || tc?.name;
    if (n) names.push(String(n));
  }
  return names;
}

function _messageSignature(msg) {
  const toolCalls = (msg?.tool_calls || []).map(_normalizeToolCallForSig).filter(Boolean);
  const payload = {
    content: typeof msg?.content === "string" ? msg.content : (msg?.content != null ? JSON.stringify(msg.content) : ""),
    tool_calls: toolCalls,
  };
  return _sha256(JSON.stringify(payload));
}

function _assistantNeedsReasoning(msg, priorMessages) {
  if (msg?.tool_calls?.length) return true;
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const role = priorMessages[i]?.role;
    if (role === "tool") return true;
    if (role === "user" || role === "system") return false;
  }
  return false;
}

function _msgHash(msg) {
  if (msg.content != null) {
    const c = (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content))
      .replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+/g, " ").trim();
    return c.slice(0, 300);
  }
  if (msg.tool_calls?.length) {
    const tc = msg.tool_calls[0];
    return (tc.function?.name || tc.name || "") + ":" + ((tc.function?.arguments && typeof tc.function.arguments === "string") ? tc.function.arguments.replace(/\s+/g, "").slice(0, 100) : "");
  }
  return "";
}

// Create per-request reasoning context — isolates concurrent sessions
function createReasoningContext(messages, model, workspaceRoot, clientTag, provider, thinkingTag) {
  const conv = _convId(messages, model, workspaceRoot);
  const fifo = [];
  let cursor = 0;

  // ── Workspace continuity detection ──
  let effectiveWorkspace = workspaceRoot;
  // Fallback: if no workspace detected, inherit from the most recent session with same client family
  // No time limit — workspace persists across the server lifetime
  if (!effectiveWorkspace && clientTag) {
    const family = clientTag.replace(/_.*$/, ""); // "vsi_e-18.7.0" → "vsi"
    for (const [, entry] of [..._sessionRegistry].reverse()) {
      const entryFamily = (entry.clientTag || "").replace(/_.*$/, "");
      if (entryFamily === family && entry.workspaceRoot) {
        effectiveWorkspace = entry.workspaceRoot;
        debug(`[session] inherited workspace "${effectiveWorkspace}" from session ${entry.id}`);
        break;
      }
    }
  }
  const wsKey = effectiveWorkspace ? `${effectiveWorkspace}|${model}` : null;
  const wsPrev = wsKey ? _workspaceSessions.get(wsKey) : null;
  const curStartPrompt = _startPrompt(messages);
  const isContinuation = wsPrev && wsPrev.convId !== conv && wsPrev.startPrompt === curStartPrompt; // different conversation, same workspace+model+startPrompt

  let sessionEntry = _sessionRegistry.get(conv);
  let reusedExisting = false;
  const isNewSession = !sessionEntry;
  if (!sessionEntry) {
    if (isContinuation) {
      // Reuse the previous session ID — the old session is gone, so this session
      // continues as the same number instead of getting a new one.
      _sessionCounter = wsPrev.sessionId;
      sessionEntry = { id: _sessionCounter, clientTag, createdAt: new Date().toISOString(), workspaceRoot: effectiveWorkspace, lastRequestTime: 0, cacheHitStreak: 0, thinkFallbackStreak: 0, stopCount: 0 };
      _sessionRegistry.set(conv, sessionEntry);
      debug(`\x1b[36mcontinued session ${_sessionCounter} \x1b[90m(was session ${wsPrev.sessionId}, \x1b[0m${clientTag}\x1b[90m, \x1b[0m${provider}/${model}\x1b[90m, \x1b[0m${effectiveWorkspace || "?"}\x1b[90m)\x1b[0m`);
      debug(`[session] NEW convId=${conv} wsRoot=${effectiveWorkspace || "(empty)"}`);
    } else {
      _sessionCounter++;
      sessionEntry = { id: _sessionCounter, clientTag, createdAt: new Date().toISOString(), workspaceRoot: effectiveWorkspace, lastRequestTime: 0, cacheHitStreak: 0, thinkFallbackStreak: 0, stopCount: 0 };
      _sessionRegistry.set(conv, sessionEntry);
      log(`\x1b[36mnew session ${_sessionCounter} \x1b[90m(\x1b[0m${clientTag}\x1b[90m, \x1b[0m${provider}/${model}\x1b[90m, \x1b[0m${effectiveWorkspace || "?"}\x1b[90m)\x1b[0m`);
      debug(`[session] NEW convId=${conv} wsRoot=${effectiveWorkspace || "(empty)"}`);
    }
  } else if (!reusedExisting) {
    debug(`[session] REUSE convId=${conv} sessionId=${sessionEntry.id}`);
  } else {
    debug(`\x1b[36mcontinued session ${sessionEntry.id} \x1b[90m(same client, active session reused, \x1b[0m${clientTag}\x1b[90m, \x1b[0m${provider}/${model}\x1b[90m, \x1b[0m${effectiveWorkspace || "?"}\x1b[90m)\x1b[0m`);
  }

  // Update workspace registry (always — tracks the most recent session per workspace+model)
  if (wsKey) {
    _workspaceSessions.set(wsKey, { convId: conv, sessionId: sessionEntry.id, lastSeen: new Date().toISOString(), clientTag, startPrompt: curStartPrompt });
  }

  const sessionId = sessionEntry.id;
  const tagPrefix = `\x1b[35m${clientTag}\x1b[0m`;
  const sessionPrefix = `${tagPrefix}[\x1b[36m${sessionId}\x1b[0m]`;

  // Rapid-request loop detection: if requests come within 1500ms, count as rapid
  const now = Date.now();
  const rapidGap = now - (sessionEntry.lastRequestTime || 0);
  sessionEntry.lastRequestTime = now;
  const isRapid = rapidGap > 0 && rapidGap < 1500;

  const prefixedConv = (key) => `c:${conv}:${key}`;
  // Workspace-scoped cache key — allows reasoning lookup across sessions in same workspace
  const prefixedWs = wsKey ? (key) => `w:${wsKey}:${key}` : null;

  function seslog(msg) {
    log(`${sessionPrefix} ${msg}`);
  }

  return {
    conv,
    sessionId,
    isNew: isNewSession,
    sessionPrefix,
    seslog,
    workspaceContinuity: isContinuation ? { previousSessionId: wsPrev.sessionId, workspaceRoot } : null,
    reset() { cursor = 0; },
    cache(msg, mdl, reasoning) {
      if (!reasoning) return;
      fifo.push(reasoning);
      if (fifo.length > 50) fifo.shift();
      // Multi-tier key system (inspired by yxlao/deepseek-cursor-proxy):
      // Tier 1: Message signature (content + tool_calls canonicalized)
      // Tier 2: Tool call IDs (survives argument re-ordering)
      // Tier 3: Tool call signatures (survives ID changes)
      // Tier 4: Tool names (recovery of last resort — catches interrupted streams)
      const sig = _messageSignature(msg);
      if (sig) {
        _crossReqReasoningCache.set(prefixedConv(`sig:${sig}`), reasoning);
        if (prefixedWs) _crossReqReasoningCache.set(prefixedWs(`sig:${sig}`), reasoning);
        _crossReqReasoningCache.set(`g:${mdl}:sig:${sig}`, reasoning);
      }
      const ids = _toolCallIds(msg);
      for (const id of ids) {
        _crossReqReasoningCache.set(prefixedConv(`tc:${id}`), reasoning);
        if (prefixedWs) _crossReqReasoningCache.set(prefixedWs(`tc:${id}`), reasoning);
      }
      const tcs = msg.tool_calls || [];
      for (const tc of tcs) {
        const tcsig = _toolCallSignature(tc);
        if (tcsig) {
          _crossReqReasoningCache.set(prefixedConv(`tcs:${tcsig}`), reasoning);
          if (prefixedWs) _crossReqReasoningCache.set(prefixedWs(`tcs:${tcsig}`), reasoning);
        }
      }
      const names = _toolCallNames(msg);
      for (const name of names) {
        _crossReqReasoningCache.set(prefixedConv(`tn:${name}`), reasoning);
        if (prefixedWs) _crossReqReasoningCache.set(prefixedWs(`tn:${name}`), reasoning);
      }
      // Legacy keys for backward compatibility
      const h = _msgHash(msg);
      if (h) {
        _crossReqReasoningCache.set(prefixedConv(h), reasoning);
        if (prefixedWs) _crossReqReasoningCache.set(prefixedWs(h), reasoning);
        _crossReqReasoningCache.set(`g:${mdl}:${h}`, reasoning);
      }
      _crossReqReasoningCache.set(prefixedConv(`mdl:${mdl}`), reasoning);
      _crossReqReasoningCache.set(`g:${mdl}:last`, reasoning);
      // Smart memory eviction: when cache grows beyond limit, evict oldest entries
      if (_crossReqReasoningCache.size > _reasoningCacheMaxEntries) {
        const keys = _crossReqReasoningCache.keys();
        let toDelete = _crossReqReasoningCache.size - _reasoningCacheMaxEntries;
        // Skip permanent keys (last-reasoning fallbacks, per-model keys)
        const permanent = new Set();
        for (const k of _crossReqReasoningCache.keys()) {
          if (k.startsWith("g:") && k.endsWith(":last")) permanent.add(k);
          if (k.includes(":mdl:")) permanent.add(k);
        }
        for (const k of keys) {
          if (toDelete <= 0) break;
          if (permanent.has(k)) continue;
          _crossReqReasoningCache.delete(k);
          toDelete--;
        }
      }
    },
    get(msg, mdl) {
      // Multi-tier lookup order:
      // 1. Message signature (most precise)
      // 2. Tool call IDs (survives argument re-ordering)
      // 3. Tool call signatures (survives ID changes)
      // 4. Tool names (recovery of last resort)
      // 5. Legacy content hash
      // 6. FIFO fallback
      // 7. Per-model last-reasoning

      const sig = _messageSignature(msg);
      if (sig) {
        if (_crossReqReasoningCache.has(prefixedConv(`sig:${sig}`))) return _crossReqReasoningCache.get(prefixedConv(`sig:${sig}`));
        if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(`sig:${sig}`))) return _crossReqReasoningCache.get(prefixedWs(`sig:${sig}`));
        if (_crossReqReasoningCache.has(`g:${mdl}:sig:${sig}`)) return _crossReqReasoningCache.get(`g:${mdl}:sig:${sig}`);
      }
      const ids = _toolCallIds(msg);
      for (const id of ids) {
        if (_crossReqReasoningCache.has(prefixedConv(`tc:${id}`))) return _crossReqReasoningCache.get(prefixedConv(`tc:${id}`));
        if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(`tc:${id}`))) return _crossReqReasoningCache.get(prefixedWs(`tc:${id}`));
      }
      const tcs = msg.tool_calls || [];
      for (const tc of tcs) {
        const tcsig = _toolCallSignature(tc);
        if (tcsig) {
          if (_crossReqReasoningCache.has(prefixedConv(`tcs:${tcsig}`))) return _crossReqReasoningCache.get(prefixedConv(`tcs:${tcsig}`));
          if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(`tcs:${tcsig}`))) return _crossReqReasoningCache.get(prefixedWs(`tcs:${tcsig}`));
        }
      }
      const names = _toolCallNames(msg);
      for (const name of names) {
        if (_crossReqReasoningCache.has(prefixedConv(`tn:${name}`))) return _crossReqReasoningCache.get(prefixedConv(`tn:${name}`));
        if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(`tn:${name}`))) return _crossReqReasoningCache.get(prefixedWs(`tn:${name}`));
      }
      // Legacy lookup
      const h = _msgHash(msg);
      if (h) {
        if (_crossReqReasoningCache.has(prefixedConv(h))) return _crossReqReasoningCache.get(prefixedConv(h));
        if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(h))) return _crossReqReasoningCache.get(prefixedWs(h));
        if (_crossReqReasoningCache.has(`g:${mdl}:${h}`)) return _crossReqReasoningCache.get(`g:${mdl}:${h}`);
      }
      if (cursor < fifo.length) return fifo[cursor++];
      const perMdl = _crossReqReasoningCache.get(prefixedConv(`mdl:${mdl}`));
      if (perMdl) return perMdl;
      return _crossReqReasoningCache.get(`g:${mdl}:last`);
    },
    crossCacheSize() { return _crossReqReasoningCache.size; },
    isRapid,
    sessionEntry,
  };
}

// Ollama -> Go model mappings (what VS Copilot sends vs what Go API expects)
const MODEL_MAP = {};

function mapModel(name) {
  const parsed = parseThinkingMode(name);
  const raw = parsed.model.replace(/^\s*\[(?:DEEPSEEK|deepseek|MIMO|mimo)\]\s*/i, "").trim();
  let clean = raw.replace(/:latest$/i, "").split(":")[0].trim();
  const fullClean = raw.replace(/:latest$/i, "").trim();
  const mapped = MODEL_MAP[clean] || MODEL_MAP[clean.toLowerCase()] || MODEL_MAP[fullClean] || MODEL_MAP[fullClean.toLowerCase()];
  if (mapped) return mapped;
  // Try full name via resolveModel which handles display names with colons
  const resolved = resolveModel(fullClean);
  if (resolved && !resolved.unverified) return resolved.id;
  return resolveModel(clean).id;
}

function getWorkspaceRoot(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : "";
    // VS Code Copilot: "workspace root path is: ..."
    const m2 = c.match(/workspace root path is:\s*(\S+)/i);
    if (m2) return m2[1].replace(/\\+$/, "").replace(/\\/g, "/");
    // VS 2026 Copilot: "Path to the workspace root: ..."
    const m3 = c.match(/path to (the )?workspace root:?\s*(\S+)/i);
    if (m3) return (m3[2] || m3[1] || "").replace(/\\+$/, "").replace(/\\/g, "/");
    // VS 2026: <CurrentWorkingDirectory>...</CurrentWorkingDirectory>
    const m4 = c.match(/<CurrentWorkingDirectory>\s*([^<]+)\s*<\/CurrentWorkingDirectory>/i);
    if (m4) return m4[1].trim().replace(/\\/g, "/");
    // VS 2026: file path at start of user message
    const m5 = c.match(/^([A-Za-z]:[\\/][^\n]+?)(?:\n|$)/);
    if (m5 && (m5[1].includes("\\") || m5[1].includes("/"))) {
      const p = m5[1].replace(/\\/g, "/");
      const dir = p.lastIndexOf("/");
      if (dir > 0) return p.substring(0, dir);
    }
  }
  return "";
}

function getActiveFile(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : "";
    // VS 2026: currently opened file
    const m2 = c.match(/currently opened file:?\s*(\S+)/i);
    if (m2) return m2[1].replace(/\\/g, "/");
    // VS Code: active file
    const m3 = c.match(/active file:?\s*(\S+)/i);
    if (m3) return m3[1].replace(/\\/g, "/");
  }
  return "";
}

function getSelectedCode(messages) {
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : "";
    const m2 = c.match(/selected (?:code|text):?\s*\n?```[\w-]*\n?([\s\S]*?)```/i);
    if (m2) return m2[1].trim();
    const m3 = c.match(/<SelectedCode>([\s\S]*?)<\/SelectedCode>/i);
    if (m3) return m3[1].trim();
  }
  return "";
}

function extractVSContext(messages) {
  return {
    workspace_root: getWorkspaceRoot(messages),
    active_file: getActiveFile(messages),
    selected_code: getSelectedCode(messages),
  };
}

function _injectProjectUpdate(calls, messages, workspaceRoot) {
  // Reserved for future project file injection
}

const _schemaSeen = new Set();
function _dumpToolSchemas(tools) {
  if (!tools?.length) return;
  for (const t of tools) {
    const n = t.function?.name;
    if (!n || _schemaSeen.has(n)) continue;
    _schemaSeen.add(n);
    const summary = JSON.stringify({
      name: n,
      required: t.function?.parameters?.required,
      properties: t.function?.parameters?.properties ? Object.keys(t.function.parameters.properties) : undefined,
    });
    debug(`\x1b[33m[schema] ${summary}\x1b[0m`);
  }
}

const _normLog = (msg) => { debug(msg); };

// Fix JSON.parse damage on path fields: \n → \n (newline), \t → \t (tab), \r → \r (carriage return)
// AI writes Windows paths like "dir\ntl\file" but JSON.parse interprets \n as newline, \t as tab
function _fixPathEscapes(s) {
  return s.replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

function normalizeToolCall(tc) {
   const name = tc.function?.name || "";
  try {
    const raw = tc.function.arguments || "{}";
    // Pre-sanitize: fix common AI malformed JSON (unquoted identifiers in arrays/values)
    let json = raw;
    // Fix invalid escape sequences: \_ → \\_ (AI writes \_ but JSON only allows \\, \n, \t, \", etc.)
    // Use negative lookbehind to avoid matching \\_ (already valid: escaped backslash + _)
    json = json.replace(/(?<!\\)\\([^"\\\/bfnrtu])/g, '\\\\$1');
    // "queries": foo → "queries":["foo"]
    json = json.replace(/"queries"\s*:\s*([^\[",}\s][^,}]*)/, (_, v) => {
      const t = v.trim();
      if (/^(?:null|true|false|-?\d)/.test(t)) return `"queries":${t}`;
      return `"queries":["${t}"]`;
    });
    // "includePattern": *.cs → "includePattern":"*.cs"
    json = json.replace(/"includePattern"\s*:\s*([^",}\s]+)(?=\s*[,}]|$)/, (_, v) => {
      if (/^(?:null|true|false|-?\d)/.test(v)) return `"includePattern":${v}`;
      return `"includePattern":"${v}"`;
    });
    // "query": frontpage → "query":"frontpage" (any bare-identifier string field)
    json = json.replace(/"query"\s*:\s*([^",}\s]+)(?=\s*[,}]|$)/g, (_, v) => {
      if (/^(?:null|true|false|-?\d)/.test(v)) return `"query":${v}`;
      return `"query":"${v}"`;
    });
    // Multi-word unquoted string values: "summary": List ntl files → "summary":"List ntl files"
    json = json.replace(/"(summary|description|details|agentName|memory|reason|prompt)\s*"\s*:\s*([^,}]+?)(?=\s*,\s*"|\s*}$|$)/g, (_, field, val) => {
      const t = val.trim();
      if (!t || /^(?:null|true|false|-?\d)/.test(t)) return `"${field}":${val}`;
      return `"${field}":"${t}"`;
    });
    const args = JSON.parse(json);
    const safe = {};

    // ── Confirmed VS schemas (VS Insiders 18.7) ──
    if (/^get_file$/i.test(name)) {
      // VS: required ["filename","startLine","endLine"]  properties: filename,startLine,endLine,includeLineNumbers
      safe.filename = _fixPathEscapes(String(args.filename ?? args.filePath ?? args.path ?? args.uri ?? args.resource ?? ""));
      safe.startLine = (typeof args.startLine === "number" && args.startLine >= 1) ? args.startLine : 1;
      safe.endLine = (typeof args.endLine === "number" && args.endLine >= safe.startLine) ? args.endLine : 999999;
      if (typeof args.includeLineNumbers === "boolean") safe.includeLineNumbers = args.includeLineNumbers;
    } else if (/^read_file$/i.test(name)) {
      // VSCode: required ["filePath","startLine","endLine"]  properties: filePath,startLine,endLine
      safe.filePath = _fixPathEscapes(String(args.filePath ?? args.filename ?? args.path ?? args.uri ?? ""));
      safe.startLine = (typeof args.startLine === "number" && args.startLine >= 1) ? args.startLine : 1;
      safe.endLine = (typeof args.endLine === "number" && args.endLine >= safe.startLine) ? args.endLine : 999999;
    } else if (/^(grep_search|search_content|search_file)$/i.test(name)) {
      // required: ["query","isRegexp","includePattern","maxResults"]  properties: query,isRegexp,includePattern,maxResults
      safe.query = String(args.query ?? args.pattern ?? args.search ?? args.searchTerm ?? "");
      safe.isRegexp = (typeof args.isRegexp === "boolean") ? args.isRegexp : (typeof args.regex === "boolean" ? args.regex : false);
      safe.includePattern = args.includePattern ?? args.include ?? args.fileTypes ?? args.glob ?? null;
      if (safe.includePattern !== null) safe.includePattern = _fixPathEscapes(String(safe.includePattern));
      safe.maxResults = (typeof args.maxResults === "number" && args.maxResults >= 1) ? args.maxResults : 20;
    } else if (/^replace_string_in_file$/i.test(name)) {
      // required: ["filePath","oldString","newString"]  properties: filePath,oldString,newString
      safe.filePath = _fixPathEscapes(String(args.filePath ?? args.path ?? args.filename ?? args.file ?? ""));
      safe.oldString = String(args.oldString ?? args.old_string ?? args.old_str ?? args.search ?? args.old_text ?? "");
      safe.newString = String(args.newString ?? args.new_string ?? args.new_str ?? args.replace ?? args.new_text ?? "");
    } else if (/^multi_replace_string_in_file$/i.test(name)) {
      // required: ["replacements","explanation"]  properties: replacements,explanation
      const list = args.replacements ?? args.edits ?? args.changes ?? args.patches ?? args.operations ?? args.diffs;
      if (Array.isArray(list)) {
        safe.replacements = list.map(r => {
          const e = {};
          e.filePath = _fixPathEscapes(String(r.filePath ?? r.filepath ?? r.path ?? r.filename ?? r.file ?? ""));
          e.oldString = String(r.oldString ?? r.old_str ?? r.search ?? r.old_text ?? r.find ?? r.from ?? "");
          e.newString = String(r.newString ?? r.new_str ?? r.replace ?? r.new_text ?? r.to ?? "");
          return e;
        });
      } else {
        const so = String(args.oldString ?? args.old_str ?? args.search ?? args.old_text ?? "");
        const sn = String(args.newString ?? args.new_str ?? args.replace ?? args.new_text ?? "");
        if (so || sn) safe.replacements = [{ filePath: "", oldString: so, newString: sn }];
      }
      safe.explanation = String(args.explanation ?? "");
    } else if (/^create_file$/i.test(name)) {
      // required: ["filePath","content"]  properties: filePath,content
      safe.filePath = _fixPathEscapes(String(args.filePath ?? args.file_path ?? args.path ?? args.filename ?? "")).replace(/\\/g, "/");
      safe.content = String(args.content ?? args.contents ?? args.text ?? args.code ?? "");
      // Preserve any extra fields VS might require beyond the schema
      for (const k of Object.keys(args)) {
        if (!(k in safe)) safe[k] = args[k];
      }
    } else if (/^remove_file|delete_file(s)?$/i.test(name)) {
      // required: ["filePath"]  properties: filePath
      safe.filePath = _fixPathEscapes(String(args.filePath ?? args.path ?? args.filename ?? ""));
    } else if (/^run_command_in_terminal|execute_command$/i.test(name)) {
      // required: ["command","summary","background"]  properties: command,summary,background
      safe.command = String(args.command ?? args.cmd ?? "");
      safe.summary = String(args.summary ?? args.description ?? "");
      safe.background = (typeof args.background === "boolean") ? args.background : (typeof args.runInBackground === "boolean" ? args.runInBackground : false);
    } else if (/^get_background_terminal_output$/i.test(name)) {
      // required: ["terminal_id","headLines","tailLines","stop","waitMs"]  properties: terminal_id,headLines,tailLines,stop,waitMs
      safe.terminal_id = _fixPathEscapes(String(args.terminal_id ?? args.terminalId ?? args.terminal ?? ""));
      safe.headLines = (typeof args.headLines === "number") ? args.headLines : 0;
      safe.tailLines = (typeof args.tailLines === "number") ? args.tailLines : 0;
      safe.stop = (typeof args.stop === "boolean") ? args.stop : false;
      safe.waitMs = (typeof args.waitMs === "number") ? args.waitMs : (typeof args.timeout === "number" ? args.timeout : 0);
    } else if (/^run_command_in_terminal|execute_command$/i.test(name)) {
      // required: ["command","summary","background"]  properties: command,summary,background
      safe.command = _fixPathEscapes(String(args.command ?? args.cmd ?? ""));
      if (args.id != null) safe.id = String(args.id);
      if (args.explanation != null) safe.explanation = String(args.explanation);
      if (args.goal != null) safe.goal = String(args.goal);
      if (args.mode != null) safe.mode = String(args.mode);
      if (typeof args.isBackground === "boolean") safe.isBackground = args.isBackground;
      if (typeof args.timeout === "number") safe.timeout = args.timeout;
      if (typeof args.waitForOutput === "boolean") safe.waitForOutput = args.waitForOutput;
    } else if (/^get_terminal_output$/i.test(name)) {
      // required: ["id"]  properties: id
      safe.id = String(args.id ?? args.terminal_id ?? "");
    } else if (/^kill_terminal$/i.test(name)) {
      // required: ["id"]  properties: id
      safe.id = String(args.id ?? args.terminal_id ?? "");
    } else if (/^semantic_search$/i.test(name)) {
      // required: ["query"]  properties: query
      safe.query = String(args.query ?? args.search ?? "");
    } else if (/^fetch_webpage$/i.test(name)) {
      // required: ["urls","query"]  properties: urls,query
      safe.urls = args.urls ?? args.url ?? [];
      if (!Array.isArray(safe.urls)) safe.urls = [String(safe.urls ?? "")];
      safe.query = String(args.query ?? "");
    } else if (/^runSubagent$/i.test(name)) {
      // required: ["prompt","description"]  properties: prompt,description,agentName,model
      safe.prompt = String(args.prompt ?? args.task ?? "");
      safe.description = String(args.description ?? args.desc ?? "");
      if (args.agentName != null) safe.agentName = String(args.agentName);
      if (args.model != null) safe.model = String(args.model);
    } else if (/^manage_todo_list$/i.test(name)) {
      // required: ["todoList"]  properties: todoList
      safe.todoList = args.todoList ?? args.todos ?? [];
      if (!Array.isArray(safe.todoList)) safe.todoList = [safe.todoList];
    } else if (/^memory$/i.test(name)) {
      // required: ["command"]  properties: command,path,file_text,old_str,new_str,...
      safe.command = String(args.command ?? "");
      if (args.path != null) safe.path = _fixPathEscapes(String(args.path));
      if (args.file_text != null) safe.file_text = String(args.file_text);
      if (args.old_str != null) safe.old_str = String(args.old_str);
      if (args.new_str != null) safe.new_str = String(args.new_str);
      if (typeof args.insert_line === "number") safe.insert_line = args.insert_line;
      if (args.insert_text != null) safe.insert_text = String(args.insert_text);
      if (args.view_range != null) safe.view_range = args.view_range;
      if (args.old_path != null) safe.old_path = String(args.old_path);
      if (args.new_path != null) safe.new_path = String(args.new_path);
    } else if (/^vscode_listCodeUsages$/i.test(name)) {
      // required: ["symbol","lineContent"]  properties: symbol,uri,filePath,lineContent
      safe.symbol = String(args.symbol ?? args.symbolName ?? args.query ?? "");
      safe.lineContent = String(args.lineContent ?? args.line ?? "");
      if (args.filePath != null) safe.filePath = _fixPathEscapes(String(args.filePath));
      if (args.uri != null) safe.uri = String(args.uri);
    } else if (/^vscode_renameSymbol$/i.test(name)) {
      // required: ["symbol","newName","lineContent"]  properties: symbol,newName,uri,filePath,lineContent
      safe.symbol = String(args.symbol ?? "");
      safe.newName = String(args.newName ?? args.new_name ?? "");
      safe.lineContent = String(args.lineContent ?? args.line ?? "");
      if (args.filePath != null) safe.filePath = _fixPathEscapes(String(args.filePath));
      if (args.uri != null) safe.uri = String(args.uri);
    } else if (/^vscode_askQuestions$/i.test(name)) {
      // required: ["questions"]  properties: questions
      safe.questions = args.questions ?? args.question ?? [];
      if (!Array.isArray(safe.questions)) safe.questions = [String(safe.questions ?? "")];
    } else if (/^run_vscode_command$/i.test(name)) {
      // required: ["commandId","name"]  properties: commandId,name,args,skipCheck
      safe.commandId = String(args.commandId ?? args.command ?? "");
      safe.name = String(args.name ?? "");
      if (args.args != null) safe.args = args.args;
      if (typeof args.skipCheck === "boolean") safe.skipCheck = args.skipCheck;
    } else if (/^(create_and_run_task)$/i.test(name)) {
      // 保留 AI 生成的完整参数（steps, plan, task, workspaceFolder 等）
      for (const [k, v] of Object.entries(args)) {
        if (v != null) safe[k] = v;
      }
    } else if (/^github_text_search$/i.test(name)) {
      // required: ["scope","query"]  properties: scope,query,maxResults
      safe.scope = String(args.scope ?? "repo");
      safe.query = String(args.query ?? args.search ?? "");
      if (typeof args.maxResults === "number") safe.maxResults = args.maxResults;
    } else if (/^github_repo$/i.test(name)) {
      // required: ["repo","query"]  properties: repo,query
      safe.repo = String(args.repo ?? "");
      safe.query = String(args.query ?? "");
    } else if (/^(open_browser_page|read_page|navigate_page|click_element|type_in_page|hover_element|drag_element|handle_dialog|screenshot_page|run_playwright_code)$/i.test(name)) {
      // VSCode browser/Playwright tools — pass all known params through
      for (const [k, v] of Object.entries(args)) {
        if (v != null) safe[k] = v;
      }
    } else if (/^lookup_vs$/i.test(name)) {
      // required: ["terms"]  properties: terms
      const rawTerms = args.terms ?? args.query ?? args.queries ?? args.search ?? args.searchTerms ?? "";
      safe.terms = Array.isArray(rawTerms) ? rawTerms.map(String) : [String(rawTerms)];
    } else {
      return tc;
    }

    const fixed = JSON.stringify(safe);
    if (name) _normLog(`\x1b[35m[normalize] ${name} RAW: ${raw} → ${fixed}\x1b[0m`);
    return { ...tc, function: { ...tc.function, arguments: fixed } };
  } catch (e) {
    debug(`\x1b[33m[normalize] ${name} JSON parse failed: ${e.message?.slice(0, 100)}\x1b[0m`);
    const raw2 = tc.function?.arguments;
    if (!raw2) return null;
    // DeepSeek often truncates create_file content mid-string — salvage what we can
    if (/^create_file$/i.test(name)) {
      try {
        const safe = {};
        const fpMatch = raw2.match(/"(?:filePath|file_path|path|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/)
                     || raw2.match(/"(?:filePath|file_path|path|filename)"\s*:\s*`([^`]*)`/);
        safe.filePath = fpMatch ? fpMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
        let btContent = null;
        const btMatch = raw2.match(/"content"\s*:\s*`([\s\S]*?)`/);
        if (btMatch) { btContent = btMatch[1]; }
        const ctMatch = !btContent ? raw2.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)/) : null;
        safe.content = btContent || (ctMatch ? ctMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "");
        if (safe.filePath && safe.content.length > 0) {
          _normLog(`\x1b[33m[create_file] salvaged path=${safe.filePath} contentLen=${safe.content.length}\x1b[0m`);
          const fixed = JSON.stringify(safe);
          return { ...tc, function: { ...tc.function, arguments: fixed } };
        }
      } catch {}
    }
    if (/^get_file$/i.test(name)) {
      try {
        const safe = {};
        let fnMatch = raw2.match(/"filename"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (!fnMatch) fnMatch = raw2.match(/"filename"\s*:\s*"((?:[^"\\]|\\.)*)/);
        safe.filename = fnMatch ? fnMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
        const slMatch = raw2.match(/"startLine"\s*:\s*(\d+)/);
        safe.startLine = slMatch ? parseInt(slMatch[1], 10) : 1;
        const elMatch = raw2.match(/"endLine"\s*:\s*(\d+)/);
        safe.endLine = elMatch ? parseInt(elMatch[1], 10) : 999999;
        if (safe.filename) {
          _normLog(`\x1b[33m[get_file] salvaged filename=${safe.filename} startLine=${safe.startLine} endLine=${safe.endLine}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^replace_string_in_file$/i.test(name)) {
      try {
        const safe = {};
        const fpMatch = raw2.match(/"(?:filePath|filename|path|file)"\s*:\s*"((?:[^"\\]|\\.)*)/) || raw2.match(/"(?:filePath|filename|path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        safe.filePath = fpMatch ? fpMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
        const osMatch = raw2.match(/"(?:oldString|old_string|old_str|old|search)"\s*:\s*"((?:[^"\\]|\\.)*)/);
        safe.oldString = osMatch ? osMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
        const nsMatch = raw2.match(/"(?:newString|new_string|new_str|new|replace)"\s*:\s*"((?:[^"\\]|\\.)*)/);
        safe.newString = nsMatch ? nsMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
        if (safe.filePath && (safe.oldString || safe.newString)) {
          _normLog(`\x1b[33m[replace_string_in_file] salvaged path=${safe.filePath} oldLen=${safe.oldString.length} newLen=${safe.newString.length}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^multi_replace_string_in_file$/i.test(name)) {
      try {
        const fpMatch = raw2.match(/"(?:filePath|filename|path|file)"\s*:\s*"((?:[^"\\]|\\.)*)/) || raw2.match(/"(?:filePath|filename|path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const osMatch = raw2.match(/"(?:oldString|old_string|old_str|old|search)"\s*:\s*"((?:[^"\\]|\\.)*)/);
        const nsMatch = raw2.match(/"(?:newString|new_string|new_str|new|replace)"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (fpMatch) {
          const rep = {
            filePath: fpMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/"),
            oldString: osMatch ? osMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "",
            newString: nsMatch ? nsMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "",
          };
          _normLog(`\x1b[33m[multi_replace_string_in_file] salvaged 1 replacement path=${rep.filePath}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ replacements: [rep] }) } };
        }
      } catch {}
    }
    if (/^insert_edit_into_file$/i.test(name)) {
      try {
        const safe = {};
        const fpMatch = raw2.match(/"(?:filePath|filename|path|file)"\s*:\s*"((?:[^"\\]|\\.)*)/) || raw2.match(/"(?:filePath|filename|path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        safe.filePath = fpMatch ? fpMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
        const cdMatch = raw2.match(/"code"\s*:\s*"((?:[^"\\]|\\.)*)/);
        safe.code = cdMatch ? cdMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
        if (safe.filePath && safe.code.length > 0) {
          _normLog(`\x1b[33m[insert_edit_into_file] salvaged path=${safe.filePath} codeLen=${safe.code.length}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^(run_command_in_terminal|execute_command)$/i.test(name)) {
      try {
        const safe = {};
        const cmdMatch = raw2.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"command"\s*:\s*([^,}]+?)(?=\s*,\s*"|\s*}$|$)/);
        safe.command = cmdMatch ? cmdMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim() : "";
        const sumMatch = raw2.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"summary"\s*:\s*([^,}]+?)(?=\s*,\s*"|\s*}$|$)/);
        safe.summary = sumMatch ? sumMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim() : "";
        safe.background = /"background"\s*:\s*true/i.test(raw2);
        if (safe.command) {
          _normLog(`\x1b[33m[${name}] salvaged command="${safe.command.slice(0,60)}${safe.command.length > 60 ? "..." : ""}" summary="${safe.summary.slice(0,40)}${safe.summary.length > 40 ? "..." : ""}" background=${safe.background}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^(grep_search|search_content|search_file)$/i.test(name)) {
      try {
        const safe = {};
        const qMatch = raw2.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"query"\s*:\s*([^,}\s]+)/);
        safe.query = qMatch ? qMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/^"/, "") : "";
        safe.isRegexp = /"isRegexp"\s*:\s*true/i.test(raw2);
        const ipMatch = raw2.match(/"includePattern"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (ipMatch) {
          safe.includePattern = ipMatch[1];
        } else {
          const unq = raw2.match(/"includePattern"\s*:\s*([^,}\s]+)/);
          safe.includePattern = (unq && unq[1] !== 'null') ? unq[1] : null;
          if (!unq) {
            const truncated = raw2.match(/"includePattern"\s*:\s*"((?:[^"\\]|\\.)*)/);
            if (truncated) safe.includePattern = truncated[1].replace(/\\+/g, "\\");
          }
        }
        const mrMatch = raw2.match(/"maxResults"\s*:\s*(\d+)/);
        safe.maxResults = mrMatch ? parseInt(mrMatch[1], 10) : null;
        if (safe.query || safe.includePattern) {
          _normLog(`\x1b[33m[${name}] salvaged query="${safe.query}" isRegexp=${safe.isRegexp} includePattern=${safe.includePattern} maxResults=${safe.maxResults}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^(find_symbol|search_symbol)$/i.test(name)) {
      try {
        const safe = {};
        safe.symbolName = "";
        const smMatch = raw2.match(/"symbolName"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"symbolName"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (smMatch) safe.symbolName = smMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        if (!safe.symbolName) {
          const qMatch = raw2.match(/"(?:query|symbol|name)"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"(?:query|symbol|name)"\s*:\s*"((?:[^"\\]|\\.)*)/);
          if (qMatch) safe.symbolName = qMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        }
        const ntMatch = raw2.match(/"navigationType"\s*:\s*(\d+)/);
        safe.navigationType = ntMatch ? parseInt(ntMatch[1], 10) : 1;
        const fpMatch = raw2.match(/"(?:filepath|filePath|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"(?:filepath|filePath|filename)"\s*:\s*"((?:[^"\\]|\\.)*)/);
        safe.filepath = fpMatch ? fpMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
        const ltMatch = raw2.match(/"lineText"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"lineText"\s*:\s*"((?:[^"\\]|\\.)*)/);
        safe.lineText = ltMatch ? ltMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
        if (safe.symbolName) {
          _normLog(`\x1b[33m[${name}] salvaged symbolName="${safe.symbolName.slice(0,40)}" navigationType=${safe.navigationType} filepath=${safe.filepath}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^read_file$/i.test(name)) {
      try {
        const safe = {};
        const fpMatch = raw2.match(/"(?:filePath|filepath|filename|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"(?:filePath|filepath|filename|path)"\s*:\s*"((?:[^"\\]|\\.)*)/);
        safe.filePath = fpMatch ? fpMatch[1].replace(/\\+/g, "/").replace(/\/{2,}/g, "/") : "";
        const slMatch = raw2.match(/"startLine"\s*:\s*(\d+)/);
        safe.startLine = slMatch ? parseInt(slMatch[1], 10) : 1;
        const elMatch = raw2.match(/"endLine"\s*:\s*(\d+)/);
        safe.endLine = elMatch ? parseInt(elMatch[1], 10) : 999999;
        if (safe.filePath) {
          _normLog(`\x1b[33m[read_file] salvaged filePath=${safe.filePath} startLine=${safe.startLine} endLine=${safe.endLine}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^(run_tests|execute_tests)$/i.test(name)) {
      try {
        const safe = {};
        let ft = []; let fv = [];
        const ftArr = raw2.match(/"filterTypes"\s*:\s*\[(.*?)(?:\]|$)/s);
        if (ftArr) {
          const inner = ftArr[1];
          const sRe = /"((?:[^"\\]|\\.)*)"/g;
          let sm;
          while ((sm = sRe.exec(inner))) ft.push(sm[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        }
        if (!ft.length) {
          const single = raw2.match(/"filterTypes"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (single) ft = [single[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
        }
        const fvArr = raw2.match(/"filterValues"\s*:\s*\[(.*?)(?:\]|$)/s);
        if (fvArr) {
          const inner = fvArr[1];
          const sRe = /"((?:[^"\\]|\\.)*)"/g;
          let sm;
          while ((sm = sRe.exec(inner))) fv.push(sm[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        }
        if (!fv.length) {
          const single = raw2.match(/"filterValues"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (single) fv = [single[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
        }
        safe.filterTypes = ft;
        safe.filterValues = fv;
        if (ft.length || fv.length) {
          _normLog(`\x1b[33m[${name}] salvaged filterTypes=[${ft.join(",")}] filterValues=[${fv.join(",")}]\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^lookup_vs$/i.test(name)) {
      try {
        const safe = {};
        let terms = [];
        const tArr = raw2.match(/"terms"\s*:\s*\[(.*?)(?:\]|$)/s);
        if (tArr) {
          const inner = tArr[1];
          const sRe = /"((?:[^"\\]|\\.)*)"/g;
          let sm;
          while ((sm = sRe.exec(inner))) terms.push(sm[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        }
        if (!terms.length) {
          const single = raw2.match(/"terms"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (single) terms = [single[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
        }
        if (!terms.length) {
          const tailMatch = raw2.match(/"terms"\s*:\s*(.*?)\s*\}/);
          if (tailMatch) {
            let raw = tailMatch[1].trim().replace(/^"/, "").replace(/"?$/,"").replace(/"/g, "").trim();
            if (raw) terms = [raw];
          }
        }
        if (terms.length) {
          safe.terms = terms;
          _normLog(`\x1b[33m[lookup_vs] salvaged terms=[${terms.map(t => t.slice(0,40)).join(",")}]\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^(run_in_terminal|send_to_terminal)$/i.test(name)) {
      try {
        const safe = {};
        const cmdMatch = raw2.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)/);
        safe.command = cmdMatch ? cmdMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
        const idMatch = raw2.match(/"id"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"id"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (idMatch) safe.id = idMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        const expMatch = raw2.match(/"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"/) || raw2.match(/"explanation"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (expMatch) safe.explanation = expMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        if (safe.command) {
          _normLog(`\x1b[33m[${name}] salvaged command="${safe.command.slice(0,60)}${safe.command.length>60?"...":""}"\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^plan$/i.test(name)) {
      try {
        const pmMatch = raw2.match(/"planMarkdown"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (pmMatch) {
          const planMarkdown = pmMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          if (planMarkdown.length > 0) {
            _normLog(`\x1b[33m[plan] salvaged planLen=${planMarkdown.length}\x1b[0m`);
            return { ...tc, function: { ...tc.function, arguments: JSON.stringify({ planMarkdown }) } };
          }
        }
      } catch {}
    }
    if (/^(code_search|search_code|semantic_search)$/i.test(name)) {
      try {
        const safe = {};
        let queries = [];
        let sqMatch = raw2.match(/"searchQueries"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (sqMatch) {
          queries = [sqMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
        } else {
          const tailMatch = raw2.match(/"searchQueries"\s*:\s*(.*?)\s*\}/);
          if (tailMatch) {
            let raw = tailMatch[1].trim().replace(/^"/, "").replace(/"?$/,"").replace(/"/g, "").trim();
            if (raw) queries = [raw];
          }
        }
        if (!queries.length) {
          const qMatch = raw2.match(/"queries"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (qMatch) queries = [qMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")];
        }
        if (!queries.length) {
          const unq = raw2.match(/"searchQueries"\s*:\s*"?\s*([^"}]+)/);
          if (unq) queries = [unq[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim()];
        }
        if (queries.length) {
          safe.searchQueries = queries;
          _normLog(`\x1b[33m[${name}] salvaged queries=[${queries.map(q => q.slice(0,40)).join(",")}]\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
    if (/^(file_search|search_files|find_files|glob_search|list_files)$/i.test(name)) {
      try {
        const safe = {};
        const queries = [];
        const qArr = raw2.match(/"queries"\s*:\s*\[(.*?)(?:\]|$)/s);
        if (qArr) {
          const inner = qArr[1];
          const sqRe = /"((?:[^"\\]|\\.)*)"/g;
          let sq;
          while ((sq = sqRe.exec(inner))) queries.push(sq[1]);
        }
        if (!queries.length) {
          const unq = raw2.match(/"queries"\s*:\s*\[?\s*([^"\],]+)/);
          if (unq) {
            const vals = unq[1].split(/[\s,]+/).filter(v => v && v !== 'null');
            for (const v of vals) queries.push(v);
          }
        }
        safe.queries = queries;
        const mrMatch = raw2.match(/"maxResults"\s*:\s*(\d+)/);
        safe.maxResults = mrMatch ? parseInt(mrMatch[1], 10) : 20;
        if (safe.queries.length) {
          _normLog(`\x1b[33m[${name}] salvaged queries=[${safe.queries.join(",")}] maxResults=${safe.maxResults}\x1b[0m`);
          return { ...tc, function: { ...tc.function, arguments: JSON.stringify(safe) } };
        }
      } catch {}
    }
  }
  _normLog(`\x1b[31m[drop] ${name}: JSON parse failed, salvage unsuccessful — discarding\x1b[0m`);
  return null;
}

function extractToolCalls(text, workspaceRoot = "", messages = []) {
  if (!text) return { content: text || "", toolCalls: [] };
  const calls = [];
  let remaining = text;

  // 0. Detect VS context from messages for better path resolution
  const vsCtx = workspaceRoot ? { workspace_root: workspaceRoot } : extractVSContext(messages);

  // 1. Explicit ```tool blocks — brace-counted to handle nested { } in string content
  const toolBlockStartRe = /```tool\n\{/gi;
  let tb;
  while ((tb = toolBlockStartRe.exec(text)) !== null) {
    const jsonStart = tb.index + tb[0].length - 1; // position of {
    let depth = 1, endPos = -1, inStr = false, esc = false;
    for (let i = jsonStart + 1; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { endPos = i; break; } }
    }
    if (endPos < 0) continue;
    toolBlockStartRe.lastIndex = endPos + 1;
    const jsonStr = text.slice(jsonStart, endPos + 1);
    const fullMatch = text.slice(tb.index, endPos + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      const tc = normalizeToolCall({
        id: callId(), type: "function",
        function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
      });
      if (tc) calls.push(tc);
      remaining = remaining.replace(fullMatch, "");
    } catch {}
  }

  // 2. VS Copilot <function_calls> XML blocks
  const fcBlockRe = /<function_calls>\s*([\s\S]*?)\s*<\/function_calls>/g;
  let fc;
  while ((fc = fcBlockRe.exec(text)) !== null) {
    const inner = fc[1];
    const invokeRe = /<invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
    let inv;
    while ((inv = invokeRe.exec(inner)) !== null) {
      const fnName = inv[1];
      const fnBody = inv[2];
      const args = {};
      const paramRe = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
      let p;
      while ((p = paramRe.exec(fnBody)) !== null) {
        args[p[1]] = p[2];
      }
      const tc = normalizeToolCall({
        id: callId(), type: "function",
        function: { name: fnName, arguments: JSON.stringify(args) },
      });
      if (tc) calls.push(tc);
    }
    remaining = remaining.replace(fc[0], "");
  }

  // 2b. ```json tool call blocks — brace-counted to handle nested { } in string content
  const jsonBlockStartRe = /```json\s*\n\{/gi;
  let jb;
  while ((jb = jsonBlockStartRe.exec(text)) !== null) {
    const jsonStart = jb.index + jb[0].length - 1; // position of {
    let depth = 1, endPos = -1, inStr = false, esc = false;
    for (let i = jsonStart + 1; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { endPos = i; break; } }
    }
    if (endPos < 0) continue;
    jsonBlockStartRe.lastIndex = endPos + 1;
    const jsonStr = text.slice(jsonStart, endPos + 1);
    const fullMatch = text.slice(jb.index, endPos + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.name && parsed.arguments) {
        const tc = normalizeToolCall({
          id: callId(), type: "function",
          function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
        });
        if (tc) { calls.push(tc); remaining = remaining.replace(fullMatch, ""); }
      }
    } catch {}
  }

  // 2c. Inline JSON tool calls: {"name":"create_file","arguments":{...}} (standalone, no code fence)
  // Use brace-counting to handle content with nested { } — the old regex \{[\\s\\S]*?\}\\s*\\}
  // would incorrectly match }} inside string content (e.g. nested JS functions).
  const inlineJsonHeadRe = /\{\s*"name"\s*:\s*"(create_file|replace_string_in_file|multi_replace_string_in_file|remove_file|get_file|read_file|grep_search|file_search|find_symbol|search_symbol|run_command_in_terminal|execute_command|replace_in_file|task_complete|start_modernization)"\s*,\s*"arguments"\s*:\s*\{/gi;
  let ij;
  while ((ij = inlineJsonHeadRe.exec(text)) !== null) {
    const fnName = ij[1];
    const startPos = ij.index;
    const braceStart = ij.index + ij[0].length - 1; // position of the opening { before arguments
    let depth = 1;
    let endPos = -1;
    let inString = false;
    let escape = false;
    for (let i = braceStart + 1; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { endPos = i; break; }
      }
    }
    if (endPos < 0) continue;
    inlineJsonHeadRe.lastIndex = endPos + 1; // advance past brace-counted match so subsequent tool calls are found
    const fullJson = text.slice(startPos, endPos + 1);
    try {
      const parsed = JSON.parse(fullJson);
      if (parsed.name && parsed.arguments) {
        const tc = normalizeToolCall({
          id: callId(), type: "function",
          function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
        });
        if (tc) { calls.push(tc); remaining = remaining.replace(fullJson, ""); }
      }
    } catch (e) {
      if (fnName === "create_file") log(`\x1b[31m[extract-inline] create_file JSON parse failed: ${e.message}\x1b[0m`);
    }
  }

  // 3. Markdown file creation: ## `path` ```lang\ncontent\n```
  const createRe = /(?:^|\n)(?:##\s*)?`([^`\n]+\.\w+)`\s*\n```[\w-]*\n([\s\S]*?)```/gi;
  let m;
  while ((m = createRe.exec(text)) !== null) {
    let fp = m[1].replace(/\\/g, "/").trim();
    const codeContent = m[2].trim();
    if (!fp || codeContent.length < 3 || codeContent.length > 200000) continue;
    // Skip project files — VS 2026 handles these natively
    if (/\.(csproj|vbproj|fsproj|jsproj|sln|xproj|dcproj|vcxproj|wsproj|njsproj)$/i.test(fp)) continue;
    if (vsCtx.workspace_root && !/^[A-Za-z]:[/\\]/.test(fp)) {
      fp = vsCtx.workspace_root.replace(/\/$/, "") + "/" + fp;
    }
    const tc = normalizeToolCall({
      id: callId(), type: "function",
      function: { name: "create_file", arguments: JSON.stringify({ filePath: fp, content: codeContent }) },
    });
    if (tc) calls.push(tc);
  }

  // Auto-inject project file update for created files
  _injectProjectUpdate(calls, messages, vsCtx.workspace_root);

  if (calls.length === 0) return { content: text, toolCalls: [] };
  return { content: remaining.replace(/\n{3,}/g, "\n\n").trim(), toolCalls: calls };
}

// ── Debug client override (?src=vscode|vs|vsi|sql) ──
app.use("*", async (c, next) => {
  const src = c.req.query("src");
  if (src && ["vscode", "vs", "vsi", "sql"].includes(src)) {
    _forceClient = src;
    log(`\x1b[35m[debug]\x1b[0m src=${src}`);
  }
  await next();
  _forceClient = null;
});



// ── GET endpoints ──

app.get("/", c => c.json({ service: "Snet", status: "running" }));

app.get("/health", async c => {
  try {
    const models = await getModels();
    const real = models.filter(m => !isSeparator(m.model));
    const dsModels = real.filter(m => isDeepSeekModel(m.model));
    const mimoModels = real.filter(m => isMiMoModel(m.model));
    const modelNames = real.flatMap(m => {
      const rawId = (m.model || "").replace(":latest", "").split(":")[0].trim();
      const modes = getThinkingModes(rawId);
      if (modes.length > 0) return [m.name, ...modes.map(mode => `${m.name} [${mode}]`)];
      return [m.name];
    }).sort();

    let status = "healthy";
    let reason = null;

    if (!real.length) {
      status = "degraded";
      reason = "没有模型已加载 — 后台获取可能仍在进行中";
    } else if (!dsModels.length && !mimoModels.length) {
      status = "unhealthy";
      reason = "没有模型可用";
    }

    return c.json({
      status,
      ...(reason ? { reason } : {}),
      authenticated: true,
      models_supported: modelNames,
      models_total: real.length,
      models_deepseek: dsModels.length,
      models_mimo: mimoModels.length,
      proxy_version: "420.96.00",
    });
  } catch (e) {
    return c.json({
      status: "unhealthy",
      reason: `Health check failed: ${e.message}`,
    });
  }
});

// ── Language endpoint ──
app.post("/api/language", async c => {
  try {
    const body = await c.req.json();
    if (body && (body.language === "zh" || body.language === "en")) {
      setLanguage(body.language);
      log(`[i18n] language set to ${body.language === "zh" ? "中文" : "English"}`);
      return c.json({ ok: true, language: getLanguage() });
    }
    return c.json({ ok: false, error: "invalid language" }, 400);
  } catch {
    return c.json({ ok: false, error: "invalid request" }, 400);
  }
});

app.get("/api/language", c => c.json({ language: getLanguage() }));

app.get("/api/tags", handleTags);
app.get("/api/list", handleTags);
app.get("/api/models", handleTags);

async function handleTags(c) {
  await _checkDSRefresh();
  await _checkMiMoRefresh();
  if (Date.now() - _lastRefresh > 60000) {
    _lastRefresh = Date.now();
    await refreshModels();
  }
  
  const goModels = await getModels();
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const seen = new Set();
  const models = [];
  const vsc = isVSCode(c);
  const vs2026 = isVS2026(c);

  for (const m of goModels) {
    const sep = isSeparator(m.model);
    if (vsc && sep) continue;
    const id = m.model.replace(":latest", "");
    const rawId = id.split(":")[0].trim();
    if (seen.has(rawId)) continue;
    seen.add(rawId);

    const isDS = isDeepSeekModel(m.model);
    const isMiMo = isMiMoModel(m.model);
    const prefix = isDS ? "[DEEPSEEK] " : "[MIMO] ";
    const family = m.details?.family || rawId;
    const metadata = resolveModelMetadata(rawId);
    const caps = metadata.capabilities || [];
    const ctxLen = metadata.context_length || config.defaultContextLength;
    const thinkingModes = sep ? [] : getThinkingModes(rawId);

    function thin(name) {
      if (vsc) return name;
      return name.length > 20 ? name.replace(/ /g, "\u2009") : name;
    }

    const SHORT_TAG = { LOW: "LO", MEDIUM: "MD", HIGH: "HI", MAXIMUM: "MX", XHIGH: "X" };

    function vsTag(baseName, mode) {
      if (vsc) return ` [${mode}]`;
      const full = ` [${mode}]`;
      if ((baseName + full).length <= 20) return full;
      const short = SHORT_TAG[mode];
      if (short) return ` [${short}]`;
      return full;
    }

    const VSC_TAG = { LOW: "/1_(low)", MEDIUM: "/2_(medium)", HIGH: "/3_high", MAXIMUM: "/4_(maximum)", XHIGH: "/4_(xhigh)" };

    function pushModel(name, modelTag, digestSuffix, parentModel) {
      const displayFamily = family + (modelTag || "");
      models.push({
        name: thin(name),
        model: `${vsc ? id + modelTag : m.model + modelTag}`,
        modified_at: now,
        size: m.size || 0,
        digest: m.digest ? `${m.digest}${digestSuffix}` : `${rawId}${digestSuffix}`,
        maxParams: m.maxParams || 0,
        capabilities: caps,
        context_length: ctxLen,
        max_output_tokens: Math.min(Math.floor(ctxLen * 0.1), 32768),
        pricing: isDS ? "deepseek" : "mimo",
        details: {
          parent_model: parentModel || (m.details?.parent_model || ""),
          format: m.details?.format || "gguf",
          ...(sep ? {} : { family: displayFamily }),
          ...(sep ? {} : { families: [displayFamily] }),
          parameter_size: sep ? "" : (m.details?.parameter_size || ""),
          quantization_level: m.details?.quantization_level || "F16",
        },
      });
    }

    if (thinkingModes.length > 0) {
      const baseName = vsc ? prefix + m.name : m.name;
      pushModel(baseName, "", "", "");
      for (const mode of thinkingModes) {
        const tag = vsTag(baseName, mode);
        pushModel(
          `${baseName}${tag}`,
          vsc ? (VSC_TAG[mode] || `/${mode.toLowerCase()}`) : ` [${mode}]`,
          `-${mode.toLowerCase()}`,
          baseName,
        );
      }
    } else {
      pushModel(vsc ? prefix + m.name : m.name, "", "", "");
    }
  }

  const realCount = models.filter(m => !isSeparator(m.model)).length;
  const divCount = models.length - realCount;
  const clientTag = _forceClient || (isVSCode(c) ? "vscode" : isVS2026(c) ? "vs" : "generic");
  const srcTag = `[\x1b[35m${clientTag}\x1b[0m] `;
  log(`${srcTag}/api/tags → ${realCount} models${divCount > 0 ? ` (+${divCount} dividers)` : ""}`);
  return c.json({ models });
}

app.get("/api/version", c => c.json({ version: "420.96.00" }));

app.get("/version", async c => {
  const models = await getModels();
  const real = models.filter(m => !isSeparator(m.model)).flatMap(m => {
    const rawId = (m.model || "").replace(":latest", "").split(":")[0].trim();
    const modes = isSeparator(m.model) ? [] : getThinkingModes(rawId);
    if (modes.length > 0) return [m.name, ...modes.map(mode => `${m.name} [${mode}]`)];
    return [m.name];
  }).sort();
  return c.json({
    proxy_version: "420.96.00",
    ollama_compatibility: "0.6.4",
    proxy_name: "Snet",
    supported_models: real,
  });
});

let _lastRefresh = 0;

// DeepSeek API Key 变更检测 — 运行时自动刷新模型列表
let _lastDSAvail = null;
async function _checkDSRefresh() {
  const nowAvail = isDeepSeekAvailable();
  if (_lastDSAvail !== null && nowAvail !== _lastDSAvail) {
    log(`[deepseek] Key ${nowAvail ? "已设置" : "已移除"} — 刷新模型列表`);
    _lastDSAvail = nowAvail;
    if (Date.now() - _lastRefresh > 5000) { _lastRefresh = Date.now(); await refreshModels(); }
    return;
  }
  _lastDSAvail = nowAvail;
  if (nowAvail && _lastRefresh > 0) {
    const models = await getModels();
    if (!models.some(m => SEP_DEEPSEEK && (m.model || "").replace(":latest", "").startsWith(SEP_DEEPSEEK))) {
      log(`[deepseek] Key 已设置但无 DeepSeek 模型 — 刷新中`);
      if (Date.now() - _lastRefresh > 5000) { _lastRefresh = Date.now(); await refreshModels(); }
    }
  }
}

// MiMo API Key 变更检测 — 运行时自动刷新模型列表
let _lastMiMoAvail = null;
async function _checkMiMoRefresh() {
  const nowAvail = isMiMoAvailable();
  if (_lastMiMoAvail !== null && nowAvail !== _lastMiMoAvail) {
    log(`[mimo] Key ${nowAvail ? "已设置" : "已移除"} — 刷新模型列表`);
    _lastMiMoAvail = nowAvail;
    if (Date.now() - _lastRefresh > 5000) { _lastRefresh = Date.now(); await refreshModels(); }
    return;
  }
  _lastMiMoAvail = nowAvail;
  if (nowAvail && _lastRefresh > 0) {
    const models = await getModels();
    if (!models.some(m => SEP_MIMO && (m.model || "").replace(":latest", "").startsWith(SEP_MIMO))) {
      log(`[mimo] Key 已设置但无 MiMo 模型 — 刷新中`);
      if (Date.now() - _lastRefresh > 5000) { _lastRefresh = Date.now(); await refreshModels(); }
    }
  }
}

app.get("/api/ps", async c => {
  const vsc = isVSCode(c);
  const allModels = await getModels();
  const real = allModels.filter(m => !isSeparator(m.model));
  const models = [];
  for (const m of real) {
    const rawId = m.model.replace(":latest", "").split(":")[0].trim();
    const metadata = resolveModelMetadata(rawId);
    const thinkingModes = getThinkingModes(rawId);
    function psPush(name, suffix) {
      models.push({
        name: name + suffix,
        model: (m.model.replace(":latest", "") + suffix) || rawId,
        size: metadata.size || 0,
        digest: (m.digest || rawId) + (suffix ? suffix.toLowerCase() : ""),
        details: {
          parent_model: suffix ? name : "",
          format: "gguf",
          family: metadata.family + suffix,
          families: [(metadata.family + suffix)],
          parameter_size: metadata.parameter_size,
          quantization_level: metadata.quantization_level || "F16",
        },
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        size_vram: metadata.size_vram || 0,
        context_length: metadata.context_length,
      });
    }
    psPush(m.name, "");
    if (thinkingModes.length > 0) {
      for (const mode of thinkingModes) {
        psPush(m.name, ` [${mode}]`);
      }
    }
  }
  return c.json({ models });
});

// ── Stats endpoint ──
app.get("/api/stats", async c => {
  const cm = ModelConcurrencyManager.getInstance();
  const queueStats = cm.getStats();
  const models = (await getModels()).filter(m => !isSeparator(m.model));
  const dsModels = models.filter(m => isDeepSeekModel(m.model));
  const mimoModels = models.filter(m => isMiMoModel(m.model));
  return c.json({
    uptime: process.uptime(),
    models: { total: models.length, deepseek: dsModels.length, mimo: mimoModels.length },
    concurrency: queueStats,
    reasoning_cache: _crossReqReasoningCache.size,
    keepalive: keepaliveStats(),
  });
});

// ── Force model refresh endpoint (like wienans refreshModels command) ──
app.post("/api/refresh", async c => {
  log("已请求强制刷新模型");
  const start = Date.now();
  await refreshModels();
  const models = await getModels();
  const real = models.filter(m => !isSeparator(m.model));
  return c.json({
    status: "refreshed",
    elapsed_ms: Date.now() - start,
    model_count: real.length,
    models: real.map(m => m.name).sort(),
  });
});

// ── Diagnostics / self-test endpoint (like wienans selfTest command) ──
app.post("/api/diagnostics", async c => {
  const body = await getBody(c);
  const testModel = body.model || config.defaultModel;
  const testModelId = mapModel(testModel);
  const info = resolveModel(testModelId);
  const metadata = resolveModelMetadata(testModelId);

  const results = {
    proxy: "Snet",
    version: "420.96.00",
    timestamp: new Date().toISOString(),
    authenticated: isDeepSeekAvailable() || isMiMoAvailable(),
    concurrency_manager: ModelConcurrencyManager.getInstance().getStats(),
    models_cached: (await getModels()).filter(m => !isSeparator(m.model)).length,
  };

  const diagnostics = {
    connectivity: { status: "unknown", latency_ms: 0, error: null },
    streaming: { status: "unknown", chunks: 0, error: null },
    tool_calling: { status: "unknown", tool_calls: 0, error: null },
    model_info: {
      id: info.id,
      name: info.name,
      family: metadata.family,
      context_length: metadata.context_length,
      capabilities: metadata.capabilities,
      is_deepseek: isDeepSeekModel(testModelId),
      is_mimo: isMiMoModel(testModelId),
    },
  };

  // Step 1: Connectivity check
  try {
    const start = Date.now();
    const cm = ModelConcurrencyManager.getInstance();
    const toolDef = {
      type: "function",
      function: {
        name: "diagnostics_get_time",
        description: "Returns the current server time",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    };
    const req = {
      model: testModelId,
      messages: [
        { role: "system", content: compactIdentity(testModelId) + "\nRun a diagnostics check. Call the diagnostics_get_time tool exactly once." },
        { role: "user", content: "Run diagnostics: call the provided tool exactly once and respond with 'Diagnostics OK' plus the tool result." },
      ],
      tools: [toolDef],
      stream: true,
    };

    let fullText = "";
    let chunkCount = 0;
    let allToolCalls = [];
    let hasToolCalls = false;
    let reasoningContent = null;
    const tcBuilders = new Map();

    await cm.acquireModel(testModelId);
    try {
      for await (const chunk of chatCompletion(req)) {
        const msg = chunk.message;
        if (!msg) continue;
        chunkCount++;

        if (msg.content) fullText += msg.content;
        if (msg.reasoning_content) reasoningContent = msg.reasoning_content;
        if (msg.reasoning) reasoningContent = msg.reasoning;

        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            const idx = tc.index ?? 0;
            let b = tcBuilders.get(idx);
            if (!b) {
              b = { id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`, type: tc.type || "function", function: { name: "", arguments: "" } };
              tcBuilders.set(idx, b);
            }
            if (tc.id) b.id = tc.id;
            if (tc.type) b.type = tc.type;
            if (tc.function?.name) b.function.name = tc.function.name;
            if (tc.function?.arguments) b.function.arguments += tc.function.arguments;
          }
        }
      }
    } finally {
      cm.releaseModel(testModelId);
    }

    allToolCalls = [...tcBuilders.values()];
    hasToolCalls = allToolCalls.length > 0;

    diagnostics.connectivity = { status: "ok", latency_ms: Date.now() - start, error: null };
    diagnostics.streaming = { status: "ok", chunks: chunkCount, error: null };
    diagnostics.tool_calling = { status: hasToolCalls ? "ok" : "not_detected", tool_calls: allToolCalls.length, error: null };

    if (fullText) {
      diagnostics.response_sample = fullText.slice(0, 300);
    }
    if (reasoningContent) {
      diagnostics.reasoning = reasoningContent.slice(0, 300);
    }
    if (hasToolCalls) {
      diagnostics.tool_calling.tools_called = allToolCalls.map(tc => ({
        name: tc.function.name,
        call_id: tc.id,
        args_preview: (tc.function.arguments || "").slice(0, 200),
      }));
    }

    results.status = "ok";
    if (!hasToolCalls) {
      results.status = "degraded";
      diagnostics.tool_calling.error = "No tool calls detected — check model capabilities";
    }
  } catch (e) {
    diagnostics.connectivity = { status: "failed", latency_ms: 0, error: e.message };
    diagnostics.streaming = { status: "skipped", chunks: 0, error: "connectivity failed" };
    diagnostics.tool_calling = { status: "skipped", tool_calls: 0, error: "connectivity failed" };
    results.status = "failed";
    results.error = e.message;
  }

  results.diagnostics = diagnostics;
  return c.json(results);
});

// ── OpenAI-compatible v1 endpoints (VS Copilot uses these) ──

function inferPromptCaching(modelId) {
  const lower = (modelId || "").toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gpt-4") || lower.includes("gpt-5") || lower.includes("o3") || lower.includes("o4") || lower.includes("o1")) return "openai";
  if (lower.includes("gemini")) return "google";
  return "none";
}

function inferTokenizer(family) {
  const f = (family || "").toLowerCase();
  if (/gpt-4o|o3|o4|o1/i.test(f)) return "o200k_base";
  if (/gpt|claude/i.test(f)) return "cl100k_base";
  return "o200k_base";
}

function isPickerEnabled(modelId) {
  const c = (modelId || "").split(":")[0].trim().toLowerCase();
  if (c === config.defaultModel.split(":")[0].trim().toLowerCase()) return true;
  const pickerModels = ["gpt-4o", "gpt-4o-mini", "gpt-4", "claude-3.5-sonnet", "gemini-2.0-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner", "deepseek-coder", "big-pickle"];
  return pickerModels.some(p => c.includes(p));
}

app.get("/v1/models", async c => {
  const models = await getModels();
  const data = [];
  const nowTs = ~~(Date.now() / 1000);

  const vsc = isVSCode(c);
  const vs2026 = isVS2026(c);
  for (const m of models) {
    if (isSeparator(m.model)) continue;
    const rawId = m.model.replace(":latest", "").split(":")[0].trim();
    const isDS = isDeepSeekModel(m.model);
    const isMiMo = isMiMoModel(m.model);
    const prefix = isDS ? "[DS] " : "[MiMo] ";
    const id = vsc ? prefix + m.name : m.name;
    const metadata = resolveModelMetadata(rawId);
    const family = metadata.family;
    const caps = metadata.capabilities || [];
    const supportsTools = caps.includes("tools") || caps.includes("agent") || (m.supports_tools ?? true);
    const ctxLen = metadata.context_length || config.defaultContextLength;
    const maxPrompt = Math.min(ctxLen - 4096, ctxLen);
    const thinkingModes = getThinkingModes(rawId);

    function thin(name) {
      if (vsc) return name;
      return name.length > 20 ? name.replace(/ /g, "\u2009") : name;
    }

    const SHORT_TAG = { LOW: "LO", MEDIUM: "MD", HIGH: "HI", MAXIMUM: "MX", XHIGH: "X" };

    function vsTag(baseName, mode) {
      if (vsc) return ` [${mode}]`;
      const full = ` [${mode}]`;
      if ((baseName + full).length <= 20) return full;
      const short = SHORT_TAG[mode];
      if (short) return ` [${short}]`;
      return full;
    }

    function pushV1Model(name, idSuffix) {
      data.push({
        id: `${id}${idSuffix}`,
        object: "model",
        created: nowTs,
        owned_by: "OpenCode",
        name: thin(name),
        model_picker_enabled: isPickerEnabled(rawId),
        version: `${family.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}`,
        capabilities: {
          object: "model_capabilities",
          supports: {
            tool_calls: supportsTools,
            parallel_tool_calls: supportsTools,
            vision: caps.includes("vision"),
            agent: caps.includes("agent"),
            streaming: true,
            prompt_caching: caps.includes("tools") || caps.includes("agent"),
            prompt_caching_type: inferPromptCaching(rawId),
          },
          limits: {
            max_prompt_tokens: maxPrompt,
            max_context_window_tokens: ctxLen,
            max_output_tokens: Math.min(Math.floor(ctxLen * 0.1), 32768),
          },
          tokenizer: inferTokenizer(family),
          type: "chat",
          family,
        },
        pricing: isDS ? "deepseek" : "mimo",
        context_length: ctxLen,
        max_output_tokens: Math.min(Math.floor(ctxLen * 0.1), 32768),
      });
    }

    if (thinkingModes.length > 0) {
      pushV1Model(name, "");
      for (const mode of thinkingModes) {
        const tag = vsTag(name, mode);
        pushV1Model(`${name}${tag}`, ` [${mode}]`);
      }
    } else {
      pushV1Model(name, "");
    }
  }

  const realCount = data.filter(m => !isSeparator(m.id)).length;
  const clientTag = _forceClient || (isVSCode(c) ? "vscode" : isVS2026(c) ? "vs" : "generic");
  log(`[\x1b[35m${clientTag}\x1b[0m] /v1/models → ${realCount} models`);
  return c.json({ object: "list", data });
});

app.post("/v1/chat/completions", async c => {
  const rawBody = await getBody(c);
  await _checkDSRefresh();
  await _checkMiMoRefresh();
  const body = normalizeOpenAIParams(rawBody);
  const rawModel = body.model || config.defaultModel;
  const modelParse = parseThinkingMode(rawModel);
  const model = modelParse.model;
  const thinkingTag = modelParse.thinking;
  const messages = body.messages || [];
  const clientWantsStream = body.stream === true;
  const vsc = isVSCode(c);
  const vs2026 = isVS2026(c);
  const vsInsiders = isVSInsiders(c);
  const mea = isSqlStudio(c);
  let clientTag = "";
  if (messages?.length) {
    for (const m of messages) {
      let raw = typeof m.content === "string" ? m.content.trim() : "";
      if (Array.isArray(m.content)) raw = m.content.map(p => (p?.text || p?.content || "").trim()).join("\n");
      const c = raw.toLowerCase();
      if (c.startsWith("## [lp]") || c.startsWith("## [pilot]") || c.startsWith("## task") || c.includes("[lp]") || c.includes("</task_type>") || c.includes("</instruction>")) { clientTag = "lp"; break; }
      const vsEnv = raw.match(/visual\s+studio\s+(enterprise|professional|community)?\s*\d{4}\s*\((\d+\.\d+\.\d+)(-insiders)?\)/i);
      if (vsEnv) {
        const edition = vsEnv[1] ? `_${vsEnv[1].toLowerCase().slice(0, 1)}` : "";
        const version = vsEnv[2];
        clientTag = vsEnv[3] ? `vsi${edition}-${version}` : `vs${edition}-${version}`;
        break;
      }
    }
  }
  if (!clientTag) {
    clientTag = mea ? "sql" : (vsInsiders ? "vsi" : (vs2026 ? "vs" : (vsc ? "vscode" : "")));
  }
  const streamMode = (vs2026 || vsInsiders || (clientTag && clientTag !== "vscode" && /^vs/.test(clientTag))) ? false : clientWantsStream;
  const vsTools = body.tools;
  _dumpToolSchemas(vsTools);
  const startTime = Date.now();
  const chatId = `chatcmpl-${startTime}`;
  const created = ~~(startTime / 1000);

  collapseBanner();

  if (!messages.length) return c.json({ error: { message: "messages is required and must be non-empty", type: "invalid_request_error", code: "missing_messages" } }, 400);

  // ── Per-message validation (copilot-proxy pattern) ──
  const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") {
      return c.json({ error: { message: `message ${i} must be an object`, type: "invalid_request_error", code: "invalid_messages" } }, 400);
    }
    const role = ((m.role || "").toString()).toLowerCase().trim();
    if (!role) {
      return c.json({ error: { message: `message ${i} requires a role`, type: "invalid_request_error", code: "invalid_messages" } }, 400);
    }
    if (!VALID_ROLES.has(role)) {
      return c.json({ error: { message: `message ${i} has invalid role: ${role}`, type: "invalid_request_error", code: "invalid_messages" } }, 400);
    }
  }
  if (!isKnownModel(model)) {
    const available = (await getModels()).filter(m => !isSeparator(m.model)).map(m => m.name).sort();
    return c.json({ error: { message: `Unsupported model: ${model}. Available models: ${available.join(", ")}`, type: "invalid_request_error", code: "unsupported_model" } }, 400);
  }

  const systemFp = `fp_${crypto.randomUUID().slice(0, 12)}`;

  // ── Early model mapping & session context (before expensive body processing) ──
  const goModel = mapModel(model);
  const provider = isDeepSeekModel(goModel) ? "deepseek" : "mimo";
  const reasoningCtx = createReasoningContext(messages, goModel, getWorkspaceRoot(messages), clientTag, provider, thinkingTag);
  // DEBUG: log raw first user message (VS context block) on every request, hidden
  if (messages.length > 0) {
    const firstUser = messages.find(m => (m.role || "").toLowerCase() === "user");
    if (firstUser && typeof firstUser.content === "string") {
      const preview = firstUser.content.substring(0, 300);
      debug(`[context] ${firstUser.content.length}ch: ${preview}${firstUser.content.length > 300 ? "…" : ""}`);
    }
  }
  // Flood guard: if think-fallback streak persists across too many requests, 503
  if (reasoningCtx.sessionEntry.thinkFallbackStreak >= 2) {
    reasoningCtx.sessionEntry.stopCount = (reasoningCtx.sessionEntry.stopCount || 0) + 1;
    if (reasoningCtx.sessionEntry.stopCount >= 5) {
      reasoningCtx.seslog(`\x1b[31m[think-fallback] flood ${reasoningCtx.sessionEntry.stopCount} stops — returning 503\x1b[0m`);
      return c.json({ error: { message: "Service temporarily unavailable", type: "server_error", code: "rate_limit_exceeded" } }, 503);
    }
    // Allow request to proceed — taskCompleteOnly will be set downstream
  }
  reasoningCtx.sessionEntry.stopCount = 0;

  // Rate-limit gate: if this session already hit a 429 recently, return 429
  // immediately so VS stops retrying.
  const rlEntry = _rateLimitedSessions.get(reasoningCtx.conv);
  if (rlEntry && Date.now() - rlEntry.at < 30000) {
    reasoningCtx.seslog(`[rate-limit] session throttled, returning 429`);
    const errResp = apiErr(new APIError(429, "", "Rate limit exceeded for this session."));
    return c.json(errResp.body, errResp.status);
  }

  // Request body size guardrail (from antigravity-copilot enrichment)
  const sizeCheck = checkRequestBodySize(rawBody);
  if (sizeCheck.exceeds) {
    log(`  request body too large: ${sizeCheck.bytes} > ${sizeCheck.limit} bytes`);
    return c.json({ error: { message: sizeCheck.message, type: "invalid_request_error", code: "request_too_large" } }, 413);
  }

  // Tool output truncation (from antigravity-copilot enrichment)
  const truncResult = truncateToolMessagesInPayload(rawBody);
  if (truncResult.truncatedMessages > 0) {
    debug(`  tool output truncation: ${truncResult.truncatedMessages} messages, ${truncResult.originalTotalChars} → ${truncResult.finalTotalChars} chars`);
  }

  const cm = ModelConcurrencyManager.getInstance();
  cm.updateFromConfig();

  try {
    // Build system prompt with tool info for agent mode
    let systemMsg = "";
    const userMsgs = [];


    let toolFailStreak = 0;
    let toolLoopBroken = false;
    let filterNags = false;

    reasoningCtx.reset();
    for (const m of messages) {
      const role = (m.role || "").toLowerCase().trim();
      if (role === "system") {
        systemMsg += (systemMsg ? "\n" : "") + (typeof m.content === "string" ? m.content : "");
      } else if (role === "assistant") {
          // After 3+ consecutive tool errors, drop retry attempts
          if (toolLoopBroken && m.tool_calls?.length) continue;
          const hasTools = m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          const hasContent = m.content != null && (
            typeof m.content === "string" ? m.content.trim().length > 0 :
            Array.isArray(m.content) ? m.content.some(p => (p?.text || p?.content || "")?.trim?.()?.length > 0) :
            true
          );
          if (hasTools) {
            // Normalize tool_calls to OpenAI format (add id/type if missing)
            const normalizedCalls = m.tool_calls.map((tc, i) => ({
              id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
              type: tc.type || "function",
              function: {
                name: tc.function?.name || tc.name || "unknown",
                arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
              },
            }));
            const msg = { role: "assistant", content: null, tool_calls: normalizedCalls };
            if (m.reasoning_content) {
              msg.reasoning_content = m.reasoning_content;
            } else if (_assistantNeedsReasoning(msg, userMsgs)) {
              const rc = reasoningCtx.get(m, goModel);
              if (rc) msg.reasoning_content = rc;
            }
            userMsgs.push(msg);
          } else if (hasContent) {
            const strippedContent = _displayReasoning ? _stripDisplayedThinking(m.content) : m.content;
            const msg = { role: "assistant", content: strippedContent };
            if (m.reasoning_content) {
              msg.reasoning_content = m.reasoning_content;
              reasoningCtx.cache(m, goModel, m.reasoning_content);
            } else if (_assistantNeedsReasoning(msg, userMsgs)) {
              const rc = reasoningCtx.get(m, goModel);
              if (rc) msg.reasoning_content = rc;
            }
            userMsgs.push(msg);
          }
      } else if (role === "user") {
        userMsgs.push(m);
} else if (role === "tool") {
        // LocalPilot sends tool msgs without proper tool_calls predecessor — validate and drop orphans
        if (clientTag === "lp") {
          const hasPrevToolCalls = userMsgs.length > 0 && userMsgs[userMsgs.length - 1].role === "assistant" && userMsgs[userMsgs.length - 1].tool_calls?.length;
          if (!hasPrevToolCalls) {
            log("  [lp] dropping orphan tool message (no preceding tool_calls)");
            continue;
          }
        }
        let tc = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
        // Terminal fallback: execute commands server-side when VS terminal is unavailable
        if (config.terminalFallback !== false && /Failed to find a valid Visual Studio terminal/i.test(tc)) {
          const callId = m.tool_call_id;
          const lastMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : null;
          if (lastMsg?.role === "assistant" && lastMsg?.tool_calls) {
            const matchingCall = lastMsg.tool_calls.find(c => c.id === callId && /^(run_command_in_terminal|execute_command)$/i.test(c.function?.name));
            if (matchingCall) {
              try {
                const callArgs = typeof matchingCall.function.arguments === "string" ?
                  JSON.parse(matchingCall.function.arguments) : (matchingCall.function.arguments || {});
                const cmdRaw = String(callArgs.command || callArgs.cmd || "");
                let cmd = cmdRaw;
                if (cmd) {
                  // Auto-fix: replace pwsh with powershell (pwsh/PS Core may not be installed)
                  cmd = cmd.replace(/^pwsh(\.exe)?(\s+-)/i, "powershell$2");
                  const cwd = callArgs.cwd || process.cwd();
                  const { exec } = await import("node:child_process");
                  log(`[term] proxy-exec: ${cmd}`);
                  // Wrap in powershell -EncodedCommand to avoid quoting issues
                  const encoded = Buffer.from(cmd, "utf16le").toString("base64");
                  let result, exitCode;
                  try {
                    const outcome = await new Promise((resolve, reject) => {
                      exec(`powershell -NoProfile -EncodedCommand ${encoded}`, {
                        encoding: "utf8",
                        timeout: 60000,
                        cwd,
                        maxBuffer: 1024 * 1024,
                        windowsHide: true,
                      }, (error, stdout, stderr) => {
                        if (error) {
                          resolve({ text: ((stdout || "") + (stderr || "")).trim(), code: error.code || 1 });
                        } else {
                          resolve({ text: (stdout || "").trim(), code: 0 });
                        }
                      });
                    });
                    result = outcome.text;
                    exitCode = outcome.code;
                  } catch (execErr) {
                    result = execErr.message;
                    exitCode = 1;
                  }
                  // Truncate huge outputs so the AI can still parse the result
                  const maxLen = 6000;
                  if (result.length > maxLen) {
                    result = result.slice(0, maxLen) + `\n\n[truncated ${result.length - maxLen} chars]`;
                  }
                  tc = `Command output (exit ${exitCode}):\n${result}`;
                }
              } catch (execErr) {
                log(`[term] proxy-exec fail: ${execErr.message}`);
              }
            }
          }
        }
        if (toolLoopBroken) continue;
        if (/^(Error|Failed|Invalid|Timeout|\[Error\]|\[Fail\]|command not found|is not recognized|no such file)/i.test(tc.trim())) {
          toolFailStreak++;
          if (toolFailStreak > 3) { toolLoopBroken = true; log("  breaking tool retry loop (>3 consecutive errors)"); continue; }
        } else {
          toolFailStreak = 0;
        }
        userMsgs.push({
          role: "tool",
          tool_call_id: m.tool_call_id || "unknown",
          content: tc,
        });
      }
    }

    // ── Condense tool history after task_complete ──
    // Only fires at the start of a NEW request after the LLM finished a task
    // naturally (not cancelled). Replaces heavy tool messages with a compact
    // summary and returns task_complete so VS stops nagging.
    if (_taskCompletedSessions.get(reasoningCtx.conv)) {
      _taskCompletedSessions.delete(reasoningCtx.conv);
      // Mark as recently completed so the inevitable VS follow-up
      // ("Task marked as complete") is drained without another LLM call.
      _recentlyCompleted.set(reasoningCtx.conv, Date.now());
      const before = userMsgs.length;
      const condensed = condenseAfterTaskComplete(userMsgs);
      if (condensed.length < before) {
        const dropped = before - condensed.length;
        userMsgs.length = 0;
        userMsgs.push(...condensed);
        const summaryMsg = condensed.find(m => m.role === "system" && m.content?.includes("[Task Summary]"));
        reasoningCtx.seslog(`\x1b[35m[condensed] replaced ${dropped} tool messages with summary${summaryMsg ? " (" + summaryMsg.content.slice(0, 80) + "...)" : ""}\x1b[0m`);
      }
      // Task is done — return hard stop instead of forwarding to LLM
      reasoningCtx.seslog(`\x1b[33m[autopilot] task already done — returning hard stop after condensation\x1b[0m`);
      const hardTc = [{ id: callId(), type: "function", function: { name: "task_complete", arguments: "{}" } }];
      if (clientWantsStream) {
        return stream(c, async s => {
          const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
          const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
          await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
          await _simStream(w, base, true, hardTc, "", null);
          await s.write("data: [DONE]\n\n");
        });
      }
      return c.json(oaiResp(null, hardTc, "tool_calls", model));
    }

    // ── Drain VS follow-up after task_complete ──
    // VS sends "Task marked as complete" after receiving task_complete.
    // Drain it silently instead of forwarding to the LLM.
    {
      const rc = _recentlyCompleted.get(reasoningCtx.conv);
      if (rc && Date.now() - rc < 20000) {
        _recentlyCompleted.delete(reasoningCtx.conv);
        reasoningCtx.seslog(`\x1b[33m[autopilot] VS post-completion — draining silently\x1b[0m`);
        if (clientWantsStream) {
          return stream(c, async s => {
            const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
            const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
            await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
            await _simStream(w, base, false, [], "", null);
            await s.write("data: [DONE]\n\n");
          });
        }
        return c.json(oaiResp("", undefined, "stop", model));
      }
    }

    // ── VS nag detection ──
    // VS sends "you have not yet marked the task as complete" when the LLM
    // produces text without tool calls. If the LLM is still actively working
    // (has tool calls), filter the nags but let it continue.
    let vsTaskCompleteNags = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      const content = typeof messages[i].content === "string" ? messages[i].content : "";
      if (/\byou have not yet marked the task as complete\b/i.test(content)) {
        vsTaskCompleteNags++;
      } else {
        break;
      }
    }
    // Check if the LLM is still actively working (last assistant has tool_calls
    // OR markdown-based tool patterns for VS/VS Insiders where tool_calls come as markdown)
    let lastAssistantHasTools = false;
    let lastAssistantIsRateLimited = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        const content = typeof messages[i].content === "string" ? messages[i].content : "";
        lastAssistantHasTools = !!(
          messages[i].tool_calls?.length ||
          /```tool\n\{|```json\s*\n\{|<function_calls>|## `[^`]+`\n```/.test(content)
        );
        lastAssistantIsRateLimited = /rate limit( exceeded)?/i.test(content);
        break;
      }
    }
    const rlEntry2 = _rateLimitedSessions.get(reasoningCtx.conv);
    if ((lastAssistantIsRateLimited || rlEntry2) && vsTaskCompleteNags >= 1) {
      reasoningCtx.seslog(`\x1b[33m[LOOP-BREAK] VS nagged ${vsTaskCompleteNags}x after rate limit — returning 429\x1b[0m`);
      const errResp = apiErr(new APIError(429, "", "Rate limit exceeded for this session."));
      return c.json(errResp.body, errResp.status);
    } else if (vsTaskCompleteNags >= 3 && !lastAssistantHasTools) {
      reasoningCtx.seslog(`\x1b[33m[LOOP-BREAK] VS nagged ${vsTaskCompleteNags}x, LLM idle — cutting session\x1b[0m`);
      filterNags = true;
    } else if (vsTaskCompleteNags >= 3 && lastAssistantHasTools) {
      reasoningCtx.seslog(`\x1b[35m[nags] ignoring ${vsTaskCompleteNags} VS nags — LLM still has tool calls\x1b[0m`);
      filterNags = true;
    }

    // ── Autopilot stall detection ──
    // VS sends bare "continue" when the user clicks continue in autopilot mode.
    // If the LLM keeps responding with text-only (no tools) to repeated continues,
    // it's stalled — cut the session.
    let bareContinueCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      const t = typeof messages[i].content === "string" ? messages[i].content.trim().toLowerCase() : "";
      if (t === "continue" || t === "proceed" || t === "go on" || t === "go ahead") {
        bareContinueCount++;
      } else {
        break;
      }
    }
    // Also count our replaced version — if LLM keeps getting "Continue with your current task"
    // and responding with text-only, same stall pattern
    let replacedContinueCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      const t = typeof messages[i].content === "string" ? messages[i].content.trim() : "";
      if (/^continue with your current task/i.test(t)) {
        replacedContinueCount++;
      } else {
        break;
      }
    }
    const totalContinueCount = bareContinueCount + replacedContinueCount;
    if (totalContinueCount >= 3 && !lastAssistantHasTools) {
      reasoningCtx.seslog(`\x1b[33m[LOOP-BREAK] autopilot stall — ${totalContinueCount} continues with no tool output — cutting session\x1b[0m`);
      filterNags = true;
    }

    // Identity override — MUST be first system instruction to override VS built-in
    systemMsg = compactIdentity(goModel, thinkingTag) + (systemMsg ? "\n\n" : "") + systemMsg;

    // Workspace continuity — if this is a new chat in a previously active workspace,
    // enrich the system prompt with a compact summary of the last completed task,
    // stripped of raw tool output clutter. (TaskSync-inspired)
    if (reasoningCtx.workspaceContinuity) {
      const wsContinuity = reasoningCtx.workspaceContinuity;
      const wsSummary = _workspaceSummaries.get(wsContinuity.workspaceRoot);
      if (wsSummary) {
        systemMsg = `PREVIOUS TASK SUMMARY (workspace: ${wsContinuity.workspaceRoot}): ${wsSummary.summary}\n\n` + systemMsg;
        reasoningCtx.seslog(`\x1b[35m[continuity] injected workspace summary from session ${wsContinuity.previousSessionId} (${wsSummary.summary.slice(0, 80)}...)\x1b[0m`);
      } else {
        systemMsg = `CONTEXT: You previously worked on this project (workspace: ${wsContinuity.workspaceRoot}). Your prior knowledge of this codebase still applies. Continue where you left off.\n\n` + systemMsg;
        // [continuity] workspace continued from session ${wsContinuity.previousSessionId} (debug-only, removed from output)
      }
    }

    // Inject tool instructions into system prompt for agent mode (token-optimized)
    if (vsTools?.length) {
      systemMsg += (systemMsg ? "\n\n" : "") + compactToolInstructions(clientTag);
    }

    // ── Auto-resolve VS nags after text-only conversations ──
    // If the entire conversation has had ZERO tool activity (just text Q&A)
    // and VS is nagging about task completion, short-circuit with task_complete
    // instead of forwarding the nag to the LLM. For real tasks with tools,
    // the last assistant would have tool_calls and this won't fire.
    if (vsTaskCompleteNags > 0) {
      const hasToolActivity = messages.some(m =>
        m.role === "assistant" && (
          m.tool_calls?.length ||
          /```tool\n\{|## `[^`]+`\n```/.test(typeof m.content === "string" ? m.content : "")
        )
      );
      if (!hasToolActivity) {
        const lastUM = userMsgs[userMsgs.length - 1];
        const nagRe = /\byou have not yet marked the task as complete\b/i;
        const isLastMsgNag = lastUM?.role === "user" && typeof lastUM.content === "string" && nagRe.test(lastUM.content);
        if (isLastMsgNag) {
          reasoningCtx.seslog(`\x1b[33m[autopilot] auto task_complete after text-only conversation (${vsTaskCompleteNags} nag(s))\x1b[0m`);
          _recentlyCompleted.set(reasoningCtx.conv, Date.now());
          const tc = [{ id: callId(), type: "function", function: { name: "task_complete", arguments: "{}" } }];
          if (clientWantsStream) {
            return stream(c, async s => {
              const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
              const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
              await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
              await _simStream(w, base, true, tc, "", null);
              await s.write("data: [DONE]\n\n");
            });
          }
          return c.json(oaiResp(null, tc, "tool_calls", model));
        }
      }
    }

    // DeepSeek/MiMo 兼容性清理（参考 Camel-Prince/deepseek-copilot-proxy）:
    // 1. 删除 reasoning 字段（DeepSeek 仅接受 reasoning_content）
    // 2. 合并连续同角色消息（DeepSeek 拒绝连续 user/user 或 system/system）
    for (const m of userMsgs) {
      delete m.reasoning;
    }
    // 合并连续同角色 user/system 消息
    const mergedMsgs = [];
    for (const m of userMsgs) {
      const last = mergedMsgs.length > 0 ? mergedMsgs[mergedMsgs.length - 1] : null;
      if (last && last.role === m.role && (m.role === "user" || m.role === "system")) {
        const lastContent = typeof last.content === "string" ? last.content : "";
        const mContent = typeof m.content === "string" ? m.content : "";
        last.content = lastContent + "\n\n" + mContent;
      } else {
        mergedMsgs.push({ ...m });
      }
    }
    userMsgs.length = 0;
    userMsgs.push(...mergedMsgs);

    // Forward to Go API with native tool support
    const apiMessages = [];
    // Strip VS nag messages so they don't confuse the model
    if (filterNags) {
      const nagRe = /\byou have not yet marked the task as complete\b/i;
      const before = userMsgs.length;
      for (let i = userMsgs.length - 1; i >= 0; i--) {
        if (userMsgs[i].role === "user" && typeof userMsgs[i].content === "string" && nagRe.test(userMsgs[i].content)) {
          userMsgs.splice(i, 1);
        }
      }
      if (userMsgs.length < before) reasoningCtx.seslog(`\x1b[33m[nags] filtered ${before - userMsgs.length} nag messages\x1b[0m`);
    }
    // Replace bare "continue" from VS autopilot — the LLM already has full context,
    // so stripping it makes the model ask "what should I do?". Replace with a
    // contextual prompt to proceed with the current task.
    {
      const lastUM = userMsgs[userMsgs.length - 1];
      if (lastUM && lastUM.role === "user") {
        const t = typeof lastUM.content === "string" ? lastUM.content.trim() : "";
        const tl = t.toLowerCase();
        if (tl === "continue" || tl === "proceed" || tl === "go on" || tl === "go ahead") {
          if (_taskCompletedSessions.get(reasoningCtx.conv)) {
            reasoningCtx.seslog(`\x1b[33m[autopilot] task already done — returning hard stop for bare "${t}"\x1b[0m`);
            const hardTc = [{ id: callId(), type: "function", function: { name: "task_complete", arguments: "{}" } }];
            if (clientWantsStream) {
              return stream(c, async s => {
                const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
                const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
                await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
                await _simStream(w, base, true, hardTc, "", null);
                await s.write("data: [DONE]\n\n");
              });
            }
            return c.json(oaiResp(null, hardTc, "tool_calls", model));
          }
          reasoningCtx.seslog(`\x1b[35m[autopilot] replacing bare "${t}" → "Continue with your current task using the tools available."\x1b[0m`);
          userMsgs[userMsgs.length - 1] = { role: "user", content: "Continue with your current task using the tools available." };
        }
      }
    }

    // First-message greetings go straight to the LLM for a real response.
    // The auto-resolve block above handles any subsequent VS nags.

    if (systemMsg) apiMessages.push({ role: "system", content: systemMsg });
    apiMessages.push(...userMsgs);

    // Message paging: keep system messages + last N non-system messages to control context length
    const _paging = config.messagesPaging;
    if (_paging > 0 && apiMessages.length > _paging) {
      const sysMsgs = apiMessages.filter(m => m.role === "system");
      const nonSysMsgs = apiMessages.filter(m => m.role !== "system");
      if (nonSysMsgs.length > _paging) {
        const dropped = nonSysMsgs.length - _paging;
        const paged = [...sysMsgs, ...nonSysMsgs.slice(-_paging)];
        apiMessages.length = 0;
        apiMessages.push(...paged);
        debug(`  ${reasoningCtx.sessionPrefix} [paging] kept ${_paging} messages (dropped ${dropped})`);
      }
    }

    // Strip orphaned tool_calls before compression (prevents upstream 400)
    const { messages: validatedMessages, stripped: _strippedOrphaned } = _stripOrphanedToolCalls(apiMessages);

    // Delta compression (KitPilot): strip historical VS context blocks, compact consumed tool outputs.
    // Only for VS/VS Insiders clients where context blocks are 16KB+ per turn.
    const isVSClient = vs2026 || vsInsiders || (clientTag && (clientTag.startsWith("vs") || clientTag.startsWith("vsi")));
    let deltaMessages = isVSClient ? compressHistory(validatedMessages, true) : validatedMessages;

    // DeepSeek/MiMo 自动思考强度（不再依赖模型名标签 L/M/H/MX）
    let effectiveThinkingTag = null;
    if (isDeepSeekModel(goModel) || isMiMoModel(goModel)) {
      const lastUser = userMsgs.filter(m => m.role === "user").pop();
      const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
      const toolRounds = deltaMessages.filter(m => m.role === "assistant" && m.tool_calls?.length).length;

      if (toolRounds > 5) {
        // 超过 5 轮工具调用 → 关闭思考，提高稳定性
        effectiveThinkingTag = null;
      } else if (toolRounds > 0) {
        // 已有工具调用 → 继续保持中等思考
        effectiveThinkingTag = "MEDIUM";
      } else if (userText.length < 20 || /^(hi|hello|hey|你好|谢谢|ok|yes|no)$/i.test(userText.trim())) {
        // 简单闲聊 → 不思考
        effectiveThinkingTag = null;
      } else if (/\b(debug|bug|error|fix|refactor|optimize|architecture|design|explain|analyze|review|漏洞|修复|重构|优化|架构|分析|审查)\b/i.test(userText)) {
        // 复杂任务 → 高思考
        effectiveThinkingTag = "HIGH";
      } else {
        // 默认 → 中等思考
        effectiveThinkingTag = "MEDIUM";
      }

      // 为 DeepSeek 注入 reasoning_content
      if (isDeepSeekModel(goModel) && effectiveThinkingTag) {
        for (const m of deltaMessages) {
          if (m.role === "assistant" && m.tool_calls?.length && !m.reasoning_content) {
            m.reasoning_content = reasoningCtx.get(m, goModel) || "";
          }
        }
      }
      // MiMo 缺失 reasoning 时降级
      if (isMiMoModel(goModel) && effectiveThinkingTag) {
        let missing = false;
        for (const m of deltaMessages) {
          if (m.role === "assistant" && m.tool_calls?.length && !m.reasoning_content) {
            const rc = reasoningCtx.get(m, goModel);
            if (rc) { m.reasoning_content = rc; } else { missing = true; }
          }
        }
        if (missing) { reasoningCtx.seslog("[mimo] reasoning 缺失 — 禁用思考"); effectiveThinkingTag = null; }
      }
    }

    // Apply prompt compression
    let compLevel = config.compressionLevel;
    if (compLevel === "auto") {
      const msgCount = userMsgs.length;
      if (msgCount <= 3) compLevel = "off";
      else compLevel = "caveman";
    }
    const compressedMessages = compressMessages(deltaMessages, compLevel, true);

    // 确保压缩后 assistant 消息的 reasoning_content 不丢失
    if (effectiveThinkingTag && isDeepSeekModel(goModel)) {
      for (const cm of compressedMessages) {
        if (cm.role === "assistant" && cm.tool_calls?.length && !cm.reasoning_content) {
          const rc = reasoningCtx.get(cm, goModel);
          cm.reasoning_content = rc || "";
        }
      }
    }

    let upstreamTools = vsTools || undefined;
    const ollamaReq = { model: goModel, messages: compressedMessages, stream: streamMode, tools: upstreamTools, clientTag, sessionId: reasoningCtx.sessionId, thinkingTag: effectiveThinkingTag };
    if (body.chat_template_kwargs != null) ollamaReq.chat_template_kwargs = body.chat_template_kwargs;
    if (body.thinking_token_budget != null) ollamaReq.thinking_token_budget = body.thinking_token_budget;

    // Session keepalive — save compressed messages so background pings keep KV cache warm
    trackSession(reasoningCtx.sessionId, goModel, compressedMessages, clientTag);

    // Cache check (non-streaming only)
    const ck = streamMode ? null : cacheKey(ollamaReq, reasoningCtx.conv);
    const cached = ck ? cacheCheck(ck) : null;
    if (cached) {
      let { text, toolCalls, hasTools, reasoningContent } = cached.value;
      if (toolCalls?.length) reasoningCtx.seslog(`\x1b[35m[cache-hit] returning ${toolCalls.length} cached tool calls: ${toolCalls.map(tc => tc.function?.name).join(", ")}\x1b[0m`);

      // Bypass cache if all cached tool calls already have matching results in the current messages.
      // Prevents infinite loops where the cache keeps returning the same tool calls
      // even after VS has already fulfilled them.
      // Checks BOTH the original incoming messages (always have VS's real results)
      // AND compressedMessages (post-processing) for resilience.
      let cacheBypassed = false;
      // Cut session if cached task_complete is being replayed
      if (toolCalls?.some(tc => tc.function?.name === "task_complete")) {
        reasoningCtx.seslog(`\x1b[33m[cache] LOOP-BREAK: cached task_complete, cutting session\x1b[0m`);
        return c.json(oaiResp(text || "Task complete.", undefined, "stop", model));
      }
      if (toolCalls?.length) {
        const cachedIds = new Set(toolCalls.map(tc => tc.id));
        const cachedNames = new Set(toolCalls.map(tc => tc.function?.name).filter(Boolean));
        const matched = new Set();

        // Check original incoming messages first (VS's real tool results, never stripped)
        const checkSource = (source) => {
          for (const m of source) {
            if (m.role === "tool" && m.tool_call_id && cachedIds.has(m.tool_call_id)) {
              matched.add(m.tool_call_id);
            }
          }
        };
        checkSource(messages);              // original request body
        if (matched.size < cachedIds.size) checkSource(compressedMessages); // fallback to processed

        // Name-based fallback: if tool_call_id doesn't match but the tool name does
        // (e.g. get_projects_in_solution result exists under a different call_id)
        if (matched.size < cachedIds.size) {
          const unseenNames = [...cachedNames].filter(name => {
            const unseenId = [...cachedIds].find(id => {
              const tc = toolCalls.find(t => t.id === id);
              return tc?.function?.name === name && !matched.has(id);
            });
            return unseenId != null;
          });
          for (const name of unseenNames) {
            // Look for any tool result that follows an assistant with this tool name
            for (let i = 0; i < messages.length; i++) {
              if (messages[i].role === "assistant" && messages[i].tool_calls?.some(tc => tc.function?.name === name)) {
                for (let j = i + 1; j < messages.length; j++) {
                  if (messages[j].role === "tool" && messages[j].tool_call_id) {
                    const parentCall = messages[i].tool_calls?.find(tc => tc.id === messages[j].tool_call_id);
                    if (parentCall?.function?.name === name) {
                      const cachedTc = toolCalls.find(tc => tc.function?.name === name);
                      if (cachedTc) matched.add(cachedTc.id);
                      break;
                    }
                  }
                  if (messages[j].role !== "tool") break;
                }
              }
            }
          }
        }

        if (matched.size === cachedIds.size) {
          reasoningCtx.seslog(`\x1b[35m[cache] bypass — all ${cachedIds.size} cached tool calls already fulfilled\x1b[0m`);
          cacheBypassed = true;
        }
      }

      if (!cacheBypassed) {
        // Loop-break on cache hit: if AI text is telling itself to call task_complete, cut session
        if (!toolCalls?.length && text && /\b(?:task_complete|mark(?:ed)?\s+(?:the\s+)?task\s+as\s+complete|If\s+you\s+believe\s+the\s+task\s+is\s+done)\b/i.test(text)) {
            reasoningCtx.seslog(`\x1b[33m[cache] LOOP-BREAK: cutting session (AI telling itself to complete)\x1b[0m`);
            text = "";
            hasTools = false;
        }

        const hasTC = toolCalls?.length && toolCalls.some(tc => tc.function?.name === "task_complete");

        if (clientWantsStream) {
          return stream(c, async (s) => {
            const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
            const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
            await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
            await _simStream(w, base, hasTools, toolCalls, text, hasTC ? null : reasoningContent);
            await s.write("data: [DONE]\n\n");
          });
        }

        const resp = oaiResp(hasTools ? null : text, hasTools ? toolCalls : undefined, hasTools ? "tool_calls" : "stop", model);
        if (reasoningContent && !hasTC) {
          const choice = resp.choices[0];
          if (_displayReasoning) {
            choice.message.content = _foldReasoningIntoContent(reasoningContent, choice.message.content || "");
          } else {
            addReasoningAliases(choice.message, reasoningContent);
          }
        }
        return c.json(resp);
      }
    }

    // Cache bypassed or not cached — going to upstream.

    // ── Stream mode: pipe directly from upstream async generator ──
    if (streamMode) {
      await cm.acquireModel(goModel);
      return stream(c, async (s) => {
        let released = false;
        const release = () => { if (!released) { released = true; cm.releaseModel(goModel); } };
        try {
        const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };

        await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

        const deltas = [];
        let tokenCount = 0;
        let hasTools = false;
        let clientGone = false;
        let _reasoningOpen = false;

        try {
          for await (const chunk of chatCompletion(ollamaReq)) {
            if (clientGone) break;
            const msg = chunk.message;
            if (!msg) continue;
            deltas.push(msg);

            // Reasoning delta (DeepSeek thinking mode)
            if (msg.reasoning_content || msg.reasoning) {
              const rc = msg.reasoning_content || msg.reasoning;
              if (_displayReasoning) {
                // Fold reasoning into Cursor-visible content as collapsible markdown blocks
                const content = _reasoningOpen ? rc : (_THINKING_BLOCK_START + rc);
                _reasoningOpen = true;
                try { await w({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] }); }
                catch { clientGone = true; break; }
              } else {
                let dr = { content: "" };
                addReasoningAliases(dr, rc);
                try { await w({ ...base, choices: [{ index: 0, delta: dr, finish_reason: null }] }); }
                catch { clientGone = true; break; }
              }
              tokenCount++;
            }

            // Content delta
            if (msg.content != null) {
              let contentToSend = msg.content;
              // Close open thinking block when real content arrives
              if (_displayReasoning && _reasoningOpen) {
                contentToSend = _THINKING_BLOCK_END + contentToSend;
                _reasoningOpen = false;
              }
              try { await w({ ...base, choices: [{ index: 0, delta: { content: contentToSend }, finish_reason: null }] }); }
              catch { clientGone = true; break; }
              tokenCount++;
            }

            // Tool call deltas (pass through directly — upstream sends incremental OpenAI format)
            if (msg.tool_calls?.length) {
              // Close open thinking block when tool calls start
              if (_displayReasoning && _reasoningOpen) {
                try { await w({ ...base, choices: [{ index: 0, delta: { content: _THINKING_BLOCK_END }, finish_reason: null }] }); }
                catch { clientGone = true; break; }
                _reasoningOpen = false;
              }
              hasTools = true;
              try { await w({ ...base, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls }, finish_reason: null }] }); }
              catch { clientGone = true; break; }
              tokenCount++;
            }
          }
        } catch (e) {
          if (e instanceof APIError && e.status === 429) {
            _rateLimitedSessions.set(reasoningCtx.conv, { at: Date.now() });
            await w({ error: { message: "Rate limit exceeded for this session.", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } });
            await s.write("data: [DONE]\n\n");
            return;
          }
          if (e instanceof APIError && e.status === 400 && /reasoning_content.*must be passed back/i.test(e.message)) {
            err(`  stream reasoning error: stripping thinking mode for next request`);
          }
          if (e instanceof APIError && e.status === 400 && /tool|tool_call/i.test(e.message)) {
            err(`  stream tool error: ${_toolNames(ollamaReq.messages)} — ${e.message}`);
          }
          err(`  流错误: ${e.message}`);
          await s.write("data: [DONE]\n\n");
          return;
        }

        // Close open thinking block before finishing the stream
        if (_displayReasoning && _reasoningOpen) {
          await w({ ...base, choices: [{ index: 0, delta: { content: _THINKING_BLOCK_END }, finish_reason: null }] });
          _reasoningOpen = false;
        }
        const finishReason = hasTools ? "tool_calls" : "stop";
        await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        await s.write("data: [DONE]\n\n");

        // Reconstruct full output from deltas
        let fullText = "";
        let reasoningContent = null;
        const tcBuilders = new Map(); // index -> accumulated tool call
        for (const d of deltas) {
          if (d.content) fullText += d.content;
          if (d.reasoning_content) reasoningContent = d.reasoning_content;
          if (d.reasoning) reasoningContent = d.reasoning;
          if (d.tool_calls?.length) {
            for (const tc of d.tool_calls) {
              const idx = tc.index ?? 0;
              let b = tcBuilders.get(idx);
              if (!b) {
                b = { id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`, type: tc.type || "function", function: { name: "", arguments: "" } };
                tcBuilders.set(idx, b);
              }
              if (tc.id) b.id = tc.id;
              if (tc.type) b.type = tc.type;
              if (tc.function?.name) b.function.name = tc.function.name;
              if (tc.function?.arguments) b.function.arguments += tc.function.arguments;
            }
          }
        }
        let allToolCalls = [...tcBuilders.values()].map(normalizeToolCall).filter(Boolean);
        if (!allToolCalls.length && vsTools?.length && fullText) {
          const extracted = extractToolCalls(fullText, getWorkspaceRoot(messages), messages);
          if (extracted.toolCalls.length) {
            allToolCalls = extracted.toolCalls;
            fullText = extracted.content;
            hasTools = true;
          }
        }
    const rawFullText = fullText;
    const thinkResult = processThinkTags(fullText);
        if (!reasoningContent && thinkResult.reasoning) reasoningContent = thinkResult.reasoning;
        fullText = thinkResult.content;

        // Store reasoning keyed by content/tool hash (so each assistant msg gets its own)
        if (reasoningContent) {
          const virtualMsg = allToolCalls.length > 0
            ? { tool_calls: allToolCalls }
            : { content: rawFullText };
          reasoningCtx.cache(virtualMsg, goModel, reasoningContent);
        }

        // Cache collected output for future non-streaming hits
        if (ck) {
          cacheStore(ck, { text: fullText, toolCalls: allToolCalls, hasTools: hasTools || allToolCalls.length > 0, reasoningContent });
        }

        reasoningCtx.seslog(`stream done (${tokenCount} chunk${tokenCount !== 1 ? "s" : ""})`);
        } finally {
          release();
        }
      });
    }

    // ── Non-streaming: collect all chunks, then process ──
    const nonStreamReq = { ...ollamaReq, stream: false };
    let chunks;
    try {
      chunks = await cm.runRequest(goModel, async () => {
        const result = [];
        for await (const chunk of chatCompletion(nonStreamReq)) {
          result.push(chunk);
        }
        return result;
      }, false);
      _tool400Streak = 0;
    } catch (e) {
      if (e.name === "RateLimitError") {
        _rateLimitedSessions.set(reasoningCtx.conv, { at: Date.now() });
        const errResp = apiErr(new APIError(429, e.body, e.message));
        return c.json(errResp.body, errResp.status);
      }
      if (e instanceof APIError && e.status === 400 && /reasoning_content.*must be passed back/i.test(e.message)) {
        err(`  [reasoning] stripping thinking mode & retrying (reasoning_content missing in history)`);
        const noThinkingReq = { ...nonStreamReq, stream: false };
        delete noThinkingReq.reasoningEffort;
        delete noThinkingReq.thinking_token_budget;
        try {
          chunks = await cm.runRequest(goModel, async () => {
            const result = [];
            for await (const chunk of chatCompletion(noThinkingReq)) {
              result.push(chunk);
            }
            return result;
          }, true);
        } catch (retryErr) {
          if (retryErr instanceof APIError && retryErr.status === 400 && /reasoning_content.*must be passed back/i.test(retryErr.message)) {
            err(`  [reasoning] last-resort: stripping all assistant/tool history & retrying`);
            // Drop all assistant and tool messages — keep only system+user so there's no
            // historical assistant that DeepSeek would demand reasoning_content for.
            const bareMessages = nonStreamReq.messages.filter(m =>
              m.role === "system" || m.role === "user"
            );
            const bareReq = { ...nonStreamReq, messages: bareMessages, stream: false };
            delete bareReq.reasoningEffort;
            delete bareReq.thinking_token_budget;
            try {
              chunks = await cm.runRequest(goModel, async () => {
                const result = [];
                for await (const chunk of chatCompletion(bareReq)) {
                  result.push(chunk);
                }
                return result;
              }, true);
            } catch (lastErr) {
              err(`  [reasoning] last-resort also failed: ${lastErr.message}`);
              throw lastErr;
            }
          } else {
            err(`  [reasoning] retry without thinking also failed: ${retryErr.message}`);
            throw retryErr;
          }
        }
      } else if (e instanceof APIError && e.status === 400 && /tool|tool_call/i.test(e.message)) {
        _tool400Streak++;
        const tools = _toolNames(compressedMessages);
        err(`  [400] tool error (#${_tool400Streak}/3): ${tools} — ${e.message}`);
        if (_tool400Streak >= 3) {
          err(`  [tool] stripping all tool_calls & retrying without tools after ${_tool400Streak} consecutive failures`);
          _tool400Streak = 0;
          const stripped = _stripAllToolCalls(compressedMessages);
          const retryReq = { ...ollamaReq, messages: stripped, stream: false, tools: undefined };
          try {
            chunks = await cm.runRequest(goModel, async () => {
              const result = [];
              for await (const chunk of chatCompletion(retryReq)) {
                result.push(chunk);
              }
              return result;
            }, true);
          } catch (retryErr) {
            err(`  [tool] retry without tools also failed: ${retryErr.message}`);
            throw retryErr;
          }
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    let fullText = "";
    let nativeCalls = null;
    let apiReasoning = null;
    let usage = null;
    for (const ch of chunks) {
      fullText += (ch.message?.content || "");
      if (ch.message?.tool_calls?.length && !nativeCalls) {
        nativeCalls = ch.message.tool_calls;
      }
      if (ch.message?.reasoning_content) {
        apiReasoning = ch.message.reasoning_content;
      }
      if (ch.usage) usage = ch.usage;
    }

    if (/rate limit/i.test(fullText)) {
      _rateLimitedSessions.set(reasoningCtx.conv, { at: Date.now() });
    }

    const rawFullText = fullText;
    const thinkResult = processThinkTags(fullText);
    let cleanText = thinkResult.content;
    let reasoningContent = apiReasoning || thinkResult.reasoning;

    let allToolCalls = [];

    if (nativeCalls?.length) {
      const hasTaskComplete = nativeCalls.some(tc => tc.function?.name === "task_complete");
      allToolCalls = nativeCalls.map(normalizeToolCall).filter(Boolean);
      if (!hasTaskComplete) cleanText = "";
    } else if (vsTools?.length) {
      const extracted = extractToolCalls(fullText, getWorkspaceRoot(messages), messages);
      if (extracted.toolCalls.length) {
        allToolCalls = extracted.toolCalls;
        cleanText = extracted.content;
      }
    }
    if (!nativeCalls?.length && cleanText) {
      const postThink = processThinkTags(cleanText);
      cleanText = postThink.content;
      if (!reasoningContent && postThink.reasoning) reasoningContent = postThink.reasoning;
    }

    // Prevent infinite "call task_complete" loop:
    // When the AI's text-only response is telling itself to call task_complete
    // instead of actually calling it, cut the session.
    if (!allToolCalls.length && cleanText && /\b(?:task_complete|mark(?:ed)?\s+(?:the\s+)?task\s+as\s+complete|If\s+you\s+believe\s+the\s+task\s+is\s+done)\b/i.test(cleanText)) {
      reasoningCtx.seslog(`\x1b[33m[LOOP-BREAK] cutting session (AI telling itself to complete)\x1b[0m`);
      allToolCalls = [];
      cleanText = "";
    }

    // When task_complete is present, drop all other tool calls.
    // LLMs often emit task_complete alongside unnecessary tool calls (get_file,
    // grep_search, etc.) in the same response. VS would execute those too,
    // wasting round-trips on work that's already done.
    if (allToolCalls.length > 1) {
      const tcIdx = allToolCalls.findIndex(tc => tc.function?.name === "task_complete");
      if (tcIdx >= 0) {
        const dropped = allToolCalls.filter((_, i) => i !== tcIdx);
        reasoningCtx.seslog(`\x1b[35m[task_complete] dropping ${dropped.length} extra tool call${dropped.length !== 1 ? "s" : ""}: ${dropped.map(tc => tc.function?.name).join(", ")}\x1b[0m`);
        allToolCalls = [allToolCalls[tcIdx]];
      }
    }

    let hasTools = allToolCalls.length > 0;

    // Store reasoning keyed by content/tool hash
    if (reasoningContent) {
      const virtualMsg = hasTools
        ? { tool_calls: allToolCalls }
        : { content: rawFullText };
      reasoningCtx.cache(virtualMsg, goModel, reasoningContent);
    }

    if (ck) cacheStore(ck, { text: cleanText, toolCalls: allToolCalls, hasTools, reasoningContent });


    // DeepSeek thinking mode: when the model puts everything in <think> tags,
    // cleanText is empty but reasoning exists. Fall back smartly:
    //  1. Scan reasoning for tool calls (model may put them inside <think>)
    //  2. Track consecutive think-fallbacks and cut session if stuck
    //  3. Use a better fallback text than just the first line
    if (!hasTools && !cleanText && reasoningContent) {
      reasoningCtx.sessionEntry.thinkFallbackStreak = (reasoningCtx.sessionEntry.thinkFallbackStreak || 0) + 1;
      const streak = reasoningCtx.sessionEntry.thinkFallbackStreak;
      // First, try to extract tool calls from the reasoning content
      const reasonExtract = extractToolCalls(reasoningContent, getWorkspaceRoot(messages), messages);
      if (reasonExtract.toolCalls.length) {
        allToolCalls = reasonExtract.toolCalls;
        cleanText = reasonExtract.content;
        hasTools = true;
        reasoningCtx.seslog(`\x1b[36m[think-fallback] found ${allToolCalls.length} tool call(s) in reasoning\x1b[0m`);
        reasoningCtx.sessionEntry.thinkFallbackStreak = 0; // resolved
      } else if (streak >= 2) {
        // Model is stuck in analysis paralysis — cut the session.
        allToolCalls = [];
        hasTools = false;
        cleanText = "";
        reasoningCtx.sessionEntry.thinkFallbackStreak = 0;
        reasoningCtx.seslog(`\x1b[33m[think-fallback] streak ${streak} — cutting session (analysis paralysis)\x1b[0m`);
      } else {
        // Skip intro/blurb lines, then take a substantial chunk of reasoning
        const lines = reasoningContent.split("\n");
        const introRe = /^(let me|the user|the error|the issue|the problem|the task|i (?:need to|should|will|want|can|am|think|believe|see|notice|observe|note)|ok[,.!]?\s*$|right[,.!]?\s*$|first[,.]?\s|now[,.]?\s|so[,.]?\s|here'?s?\s|looking at|based on|from the|according to|to (?:understand|fix|debug|resolve|reproduce))/i;
        const boringRe = /^(the error trace is|the stack trace|the exception|the call stack|error occurs|the problem is|error details)[:.]?\s*$/i;
        // Strip leading intro/boring lines
        let startIdx = 0;
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i].trim();
          if (!t) { startIdx = i + 1; continue; }
          if (introRe.test(t) || boringRe.test(t)) { startIdx = i + 1; continue; }
          break;
        }
        // Take up to 8000 chars from the remaining substantial content
        let summary = "";
        if (startIdx < lines.length) {
          summary = lines.slice(startIdx).join("\n").trim().slice(0, 8000);
        }
        if (!summary) {
          // Absolute fallback: last non-empty line
          for (let i = lines.length - 1; i >= 0; i--) {
            const t = lines[i].trim();
            if (t) { summary = t.slice(0, 4000); break; }
          }
        }
        cleanText = summary || "(thinking)";
        reasoningCtx.seslog(`\x1b[35m[think-fallback] streak ${streak}: empty text, using reasoning summary\x1b[0m`);
      }
    } else if (hasTools || cleanText) {
      // Reset think-fallback streak when model produces a real response
      if (reasoningCtx.sessionEntry.thinkFallbackStreak > 0) {
        reasoningCtx.sessionEntry.thinkFallbackStreak = 0;
      }
    }

    const hasTaskComplete = allToolCalls.length && allToolCalls.some(tc => tc.function?.name === "task_complete");
    // When task_complete is present, suppress text content — only the tool call matters.
    // Previously cleanText was kept, giving VS three outputs (content + tool_calls + reasoning).
    const resp = oaiResp(hasTools ? null : cleanText, hasTools ? allToolCalls : undefined, hasTools ? "tool_calls" : "stop", model, usage);
    if (hasTools) debug(`${reasoningCtx.sessionPrefix} \x1b[35m[TOOLS-TO-VS] ${allToolCalls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join(" \u2502 ")}\x1b[0m`);
    else debug(`${reasoningCtx.sessionPrefix} \x1b[35m[TEXT-TO-VS] ${(cleanText || "").slice(0, 200).replace(/\n/g,"\\n")}\x1b[0m`);

    // When LLM calls task_complete, summarize the completed task's tool calls
    // + results into a compact instructional summary. Store per workspace so
    // future sessions inherit context without the full tool history clutter.
    const completedTask = hasTaskComplete || (hasTools && allToolCalls.some(tc => tc.function?.name === "task_complete"));
    if (completedTask) {
      // Mark session so the NEXT request condenses tool history
      _taskCompletedSessions.set(reasoningCtx.conv, true);
      const wsRoot = getWorkspaceRoot(messages);
      const summary = _summarizeCompletedTask(messages);
      if (summary && wsRoot) {
        _workspaceSummaries.set(wsRoot, { summary, timestamp: new Date().toISOString(), sessionId: reasoningCtx.sessionId, model: goModel });
        // Clear session-scoped reasoning cache entries (task done, no longer needed)
        const convPrefix = `c:${reasoningCtx.conv}:`;
        let cleared = 0;
        for (const k of _crossReqReasoningCache.keys()) {
          if (k.startsWith(convPrefix)) { _crossReqReasoningCache.delete(k); cleared++; }
        }
        reasoningCtx.seslog(`\x1b[35m[summary] stored workspace summary (${summary.slice(0, 100)})\x1b[0m\x1b[90m | cleared ${cleared} reasoning entries\x1b[0m`);
      }
    }

    if (reasoningContent && !hasTaskComplete) {
      const choice = resp.choices[0];
      if (_displayReasoning) {
        choice.message.content = _foldReasoningIntoContent(reasoningContent, choice.message.content || "");
      } else {
        addReasoningAliases(choice.message, reasoningContent);
      }
    }

    // Simulate SSE streaming for clients that requested it (e.g. VS 2026)
    if (clientWantsStream) {
      return stream(c, async s => {
        const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };
        await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        await _simStream(w, base, hasTools, allToolCalls, cleanText, hasTaskComplete ? null : reasoningContent);
        await s.write("data: [DONE]\n\n");
      });
    }

    return c.json(resp);
  } catch (e) {
    if (e instanceof APIError && e.status === 400 && /tool|tool_call/i.test(e.message)) {
      let tools = "?";
      try { tools = _toolNames(compressedMessages); } catch {}
      err(`  [400] tool error: ${tools} — ${e.message}`);
    }
    if (e instanceof APIError && e.status === 429) {
      _rateLimitedSessions.set(reasoningCtx.conv, { at: Date.now() });
      const errResp = apiErr(e);
      return c.json(errResp.body, errResp.status);
    }
    err(`  错误: ${e.message}`);
    const errResp = apiErr(e);
    return c.json(errResp.body, errResp.status);
  }
});

// ── Copilot inline code completions ──
// VS Code sends to /v1/engines/copilot-codex/completions for inline completions
app.post("/v1/engines/copilot-codex/completions", async c => {
  logReq(c);
  const raw = await getBody(c);
  const body = normalizeOpenAIParams(raw);
  const model = mapModel(body.model || config.defaultModel);
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const streamMode = body.stream === true;
  const maxTokens = body.max_tokens ?? body.maxOutputTokens ?? 500;
  const temperature = body.temperature ?? (body.top_p === 0 ? 0 : 0.2);
  const stop = body.stop;
  const n = Math.min(body.n || 1, 3);
  const startTime = Date.now();
  const cmplId = `cmpl-${startTime}`;
  const created = ~~(startTime / 1000);

  if (!prompt) return c.json({ error: { message: "No prompt", type: "invalid_request_error" } }, 400);


  try {
    const systemMsg = compactCodeCompletionPrompt();
    const req = {
      model,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: prompt },
      ],
      stream: false,
    };
    if (body.temperature != null) req.options = { temperature };
    if (body.top_p != null) { req.options ||= {}; req.options.top_p = body.top_p; }
    if (maxTokens != null) { req.options ??= {}; req.options.num_predict = maxTokens; }
    if (stop) { req.options ??= {}; req.options.stop = stop; }

    const cm = ModelConcurrencyManager.getInstance();
    const chunks = [];
    await cm.acquireModel(model);
    try {
      for await (const chunk of chatCompletion(req)) {
        chunks.push(chunk);
      }
    } finally {
      cm.releaseModel(model);
    }

    const fullText = chunks.map(c => c.message?.content || "").join("");
    const { content: cleanText } = processThinkTags(fullText);
    const sanitized = sanitizeContent(cleanText || fullText);

    const completion = (text) => ({
      id: cmplId,
      object: "text_completion",
      created,
      model: body.model || config.defaultModel,
      choices: Array.from({ length: n }, (_, i) => ({
        text,
        index: i,
        logprobs: null,
        finish_reason: "stop",
      })),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    if (streamMode) {
      return stream(c, async (s) => {
        const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: cmplId, object: "text_completion", created, model: body.model || config.defaultModel };
        const words = (sanitized || "").match(/.{1,20}/g) || [sanitized || ""];
        for (const w of words) {
          if (!w) continue;
          await w({ ...base, choices: Array.from({ length: n }, (_, i) => ({ text: w, index: i, logprobs: null, finish_reason: null })) });
        }
        await w({ ...base, choices: Array.from({ length: n }, (_, i) => ({ text: "", index: i, logprobs: null, finish_reason: "stop" })), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        await s.write("data: [DONE]\n\n");
        log(`completion done (${(sanitized || "").length} chars)`);
      });
    }

    return c.json(completion(sanitized));
  } catch (e) {
    err(`  完成错误: ${e.message}`);
    const errResp = apiErr(e);
    return c.json(errResp.body, errResp.status);
  }
});

// ── Ollama-native endpoints ──

app.post("/api/show", async c => {
  const b = await getBody(c);
  const raw = (b.model ?? b.name ?? "").split(":")[0].trim();
  if (isSeparator(raw)) {
    return c.json({
      license: "",
      modelfile: "",
      parameters: "",
      template: "",
      details: {
        parent_model: "",
        format: "",
        family: "",
        families: [],
        parameter_size: "",
        quantization_level: "",
      },
      model_info: {},
      capabilities: [],
      modified_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    });
  }
  const goId = mapModel(raw);
  const info = resolveModel(goId);
  const metadata = resolveModelMetadata(goId);
  const ctxLen = metadata.context_length || config.defaultContextLength;
  const caps = metadata.capabilities;
  const family = metadata.family;
  const paramSize = metadata.parameter_size || "";
  const vsc = isVSCode(c);
  const vs2026 = isVS2026(c);
  const isDS = isDeepSeekModel(goId);
  const isMiMo = isMiMoModel(goId);
  const prefix = isDS ? "[DEEPSEEK] " : "[MIMO] ";
  const thinkingMode = parseThinkingMode(b.model || b.name || "");
  const thinkingSuffix = thinkingMode.thinking ? ` [${thinkingMode.thinking}]` : "";
  const displayName = vsc ? prefix + info.name : info.name;
  return c.json({
    license: "See OpenAI license terms for this model.",
    modelfile: `# ${info.name} (via OpenCode Go)\nFROM ${goId}`,
    parameters: `num_ctx ${ctxLen}\nnum_predict 4096`,
    template: '{{ if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}{{ range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n',
    version: "1.0.0",
    billing: { multiplier: 1 },
    pricing: isDS ? "deepseek" : "mimo",
    context_length: ctxLen,
    max_output_tokens: Math.min(Math.floor(ctxLen * 0.1), 32768),
    capabilities: caps,
    details: {
      parent_model: "",
      format: "gguf",
      family,
      families: [family],
      parameter_size: paramSize,
      quantization_level: metadata.quantization_level || "F16",
    },
    model_info: {
      [goId + ".context_length"]: ctxLen,
      "general.basename": displayName + thinkingSuffix,
      "general.architecture": "opencode",
      "general.file_type": 15,
      "opencode.context_length": ctxLen,
      "opencode.capabilities": caps.join(", "),
    },
    modified_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  });
});

app.post("/api/pull", c => stream(c, async s => { const b = await getBody(c); await s.write(JSON.stringify({ status: `pulling ${b.model ?? b.name}` }) + "\n"); await s.write(JSON.stringify({ status: "success" }) + "\n"); }));

app.delete("/api/delete", async c => { const b = await getBody(c); return c.json({ status: "success" }); });
app.post("/api/copy", async c => { const b = await getBody(c); return c.json({ status: "success" }); });
app.post("/api/embed", async c => { const b = await getBody(c); return c.json({ model: b.model || "unknown", embeddings: [[0]], total_duration: 0, load_duration: 0, prompt_eval_count: 0 }); });
app.post("/api/embeddings", async c => { const b = await getBody(c); return c.json({ model: b.model || "unknown", embeddings: [[0]], total_duration: 0, load_duration: 0, prompt_eval_count: 0 }); });

app.post("/api/chat", async c => {
  logReq(c);
  const rawBody = await getBody(c);
  const body = normalizeOpenAIParams(rawBody);
  const startTime = Date.now();
  const messages = body.messages || [];

  // ── Client detection for /api/chat ──
  let clientTag = "";
  for (const m of messages) {
    let raw = typeof m.content === "string" ? m.content.trim() : "";
    if (Array.isArray(m.content)) raw = m.content.map(p => (p?.text || p?.content || "").trim()).join("\n");
    const c = raw.toLowerCase();
    if (c.startsWith("## [lp]") || c.startsWith("## [pilot]") || c.startsWith("## task") || c.includes("[lp]") || c.includes("</task_type>") || c.includes("</instruction>")) { clientTag = "lp"; break; }
  }
  if (!clientTag) {
    const mea = isSqlStudio(c);
    const vsInsiders = isVSInsiders(c);
    if (mea) clientTag = "sql";
    else if (vsInsiders) clientTag = "vsi";
    else if (isVS2026(c)) clientTag = "vs";
    else if (isVSCode(c)) clientTag = "vscode";
  }

  collapseBanner();

  return stream(c, async s => {
    try {
      const cm = ModelConcurrencyManager.getInstance();
      const model = mapModel(body.model);
      const apiThinking = parseThinkingMode(body.model).thinking;
  const vsTools = body.tools;
  _dumpToolSchemas(vsTools);
  const provider = isDeepSeekModel(model) ? "deepseek" : "mimo";
  const reasoningCtx = createReasoningContext(messages, model, getWorkspaceRoot(messages), clientTag, provider, apiThinking);
  // DEBUG: log raw first user message (VS context block) on every request, hidden
  if (messages.length > 0) {
    const firstUser = messages.find(m => (m.role || "").toLowerCase() === "user");
    if (firstUser && typeof firstUser.content === "string") {
      const preview = firstUser.content.substring(0, 300);
      debug(`[context] ${firstUser.content.length}ch: ${preview}${firstUser.content.length > 300 ? "…" : ""}`);
    }
  }
  reasoningCtx.reset();

      // Build messages with tool info in system prompt
      let systemMsg = "";
      const userMsgs = [];
      for (const m of messages) {
        const role = (m.role || "").toLowerCase().trim();
        if (role === "system") systemMsg += (systemMsg ? "\n" : "") + (typeof m.content === "string" ? m.content : "");
        else if (role === "assistant") {
          const hasTools = m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          const hasContent = m.content != null && (
            typeof m.content === "string" ? m.content.trim().length > 0 :
            Array.isArray(m.content) ? m.content.some(p => (p?.text || p?.content || "")?.trim?.()?.length > 0) :
            true
          );
          if (hasTools) {
            const msg = { role: "assistant", content: null, tool_calls: m.tool_calls };
            if (m.reasoning_content) {
              msg.reasoning_content = m.reasoning_content;
            } else if (_assistantNeedsReasoning(msg, userMsgs)) {
              const rc = reasoningCtx.get(m, model);
              if (rc) msg.reasoning_content = rc;
            }
            userMsgs.push(msg);
          } else if (hasContent) {
            const strippedContent = _displayReasoning ? _stripDisplayedThinking(m.content) : m.content;
            const msg = { role: "assistant", content: strippedContent };
            if (m.reasoning_content) {
              msg.reasoning_content = m.reasoning_content;
              reasoningCtx.cache(m, model, m.reasoning_content);
            } else if (_assistantNeedsReasoning(msg, userMsgs)) {
              const rc = reasoningCtx.get(m, model);
              if (rc) msg.reasoning_content = rc;
            }
            userMsgs.push(msg);
          }
        }
        else if (role === "tool") {
          if (clientTag === "lp") {
            const hasPrev = userMsgs.length > 0 && userMsgs[userMsgs.length - 1].role === "assistant" && userMsgs[userMsgs.length - 1].tool_calls?.length;
            if (!hasPrev) { log("  [lp] dropping orphan tool message (/api/chat)"); continue; }
          }
          userMsgs.push({ role: "tool", tool_call_id: m.tool_call_id || "unknown", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || "") });
        }
        else if (role === "user") userMsgs.push(m);
        // unknown roles are silently dropped
      }

      // Identity override — MUST be first system instruction
      systemMsg = compactIdentity(model, apiThinking) + (systemMsg ? "\n\n" : "") + systemMsg;

      if (vsTools?.length) {
        systemMsg += (systemMsg ? "\n\n" : "") + compactOllamaToolInstructions(vsTools, clientTag);
      }

      // Replace bare "continue" from VS autopilot with a contextual prompt
      // so the LLM knows to proceed with the current task instead of asking
      // "what should I do?" (which creates a stall loop).
      {
        const lastUM = userMsgs[userMsgs.length - 1];
        if (lastUM && lastUM.role === "user") {
          const t = typeof lastUM.content === "string" ? lastUM.content.trim() : "";
          const tl = t.toLowerCase();
          if (tl === "continue" || tl === "proceed" || tl === "go on" || tl === "go ahead") {
            if (_taskCompletedSessions.get(reasoningCtx.conv)) {
              reasoningCtx.seslog(`\x1b[33m[autopilot] task already done — returning hard stop for bare "${t}"\x1b[0m`);
              const createdAt = new Date().toISOString();
              await s.write(JSON.stringify({
                model, created_at: createdAt,
                message: { role: "assistant", content: "", tool_calls: [{ function: { name: "task_complete", arguments: {} } }] },
                done: true, done_reason: "tool_calls",
                total_duration: 0, load_duration: 0, prompt_eval_count: 0, prompt_eval_duration: 0, eval_count: 0, eval_duration: 0,
              }) + "\n");
              return;
            }
            reasoningCtx.seslog(`\x1b[35m[autopilot] replacing bare "${t}" → "Continue with your current task using the tools available."\x1b[0m`);
            userMsgs[userMsgs.length - 1] = { role: "user", content: "Continue with your current task using the tools available." };
          }
        }
      }

      const apiMessages = systemMsg ? [{ role: "system", content: systemMsg }, ...userMsgs] : userMsgs;

      // Message paging: keep system messages + last N non-system messages to control context length
      const _paging2 = config.messagesPaging;
      if (_paging2 > 0 && apiMessages.length > _paging2) {
        const sysMsgs = apiMessages.filter(m => m.role === "system");
        const nonSysMsgs = apiMessages.filter(m => m.role !== "system");
        if (nonSysMsgs.length > _paging2) {
          const dropped = nonSysMsgs.length - _paging2;
          const paged = [...sysMsgs, ...nonSysMsgs.slice(-_paging2)];
          apiMessages.length = 0;
          apiMessages.push(...paged);
          debug(`  ${reasoningCtx.sessionPrefix} [paging] kept ${_paging2} messages (dropped ${dropped})`);
        }
      }

      const { messages: validatedMessages, stripped: _strippedOrphaned2 } = _stripOrphanedToolCalls(apiMessages);

      // Delta compression (KitPilot): strip historical VS context blocks, compact consumed tool outputs
      const isVSClient = clientTag === "vs" || clientTag === "vsi" || (clientTag && clientTag.startsWith("vs"));
      let deltaMessages = isVSClient ? compressHistory(validatedMessages, true) : validatedMessages;

      let compLevel = config.compressionLevel;
      if (compLevel === "auto") {
        const msgCount = userMsgs.length;
        if (msgCount <= 3) compLevel = "off";
        else compLevel = "caveman";
      }
      const compressedMessages = compressMessages(deltaMessages, compLevel, true);
      const reqBody = { model, messages: compressedMessages, stream: false, options: body.options, format: body.format, clientTag, tools: vsTools || undefined };
      if (body.chat_template_kwargs != null) reqBody.chat_template_kwargs = body.chat_template_kwargs;
      if (body.thinking_token_budget != null) reqBody.thinking_token_budget = body.thinking_token_budget;

      const chunks = [];
      await cm.acquireModel(model);
      try {
        for await (const chunk of chatCompletion(reqBody)) {
          chunks.push(chunk);
        }
      } finally {
        cm.releaseModel(model);
      }


      const fullText = chunks.map(c => c.message?.content || "").join("");
      let chatUsage = null;
      let apiReasoning = null;
      for (const c of chunks) { if (c.usage) chatUsage = c.usage; if (c.message?.reasoning_content) apiReasoning = c.message.reasoning_content; }
      let { content: cleanText, toolCalls: rawCalls } = vsTools?.length ? extractToolCalls(fullText, getWorkspaceRoot(messages)) : { content: fullText, toolCalls: [] };
      const thinkResult = processThinkTags(cleanText);
      cleanText = thinkResult.content;
      const reasoningContent = apiReasoning || thinkResult.reasoning;
      // Cache reasoning for next turn via conversation-scoped cross-request cache
      if (reasoningContent) {
        const virtualMsg = rawCalls.length
          ? { tool_calls: rawCalls.map(tc => ({ function: { name: tc.function.name, arguments: tc.function.arguments } })) }
          : { content: fullText };
        reasoningCtx.cache(virtualMsg, model, reasoningContent);
      }
      // Session keepalive
      trackSession(reasoningCtx.sessionId, model, compressedMessages, clientTag);
      // Loop-break: if AI text is telling itself to call task_complete, cut session
      if (!rawCalls.length && cleanText && /\b(?:task_complete|mark(?:ed)?\s+(?:the\s+)?task\s+as\s+complete|If\s+you\s+believe\s+the\s+task\s+is\s+done)\b/i.test(cleanText)) {
          log(`\x1b[33m[LOOP-BREAK] cutting session (AI telling itself to complete)\x1b[0m`);
          rawCalls = [];
          cleanText = "";
      }
      // Convert OpenAI format to Ollama format (drop id/type, parse args to object)
      const toolCalls = rawCalls.map(tc => ({
        function: { name: tc.function.name, arguments: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })() },
      }));

      const createdAt = new Date().toISOString();
      const duration = Date.now() - startTime;

      if (body.stream === false) {
        const displayContent = (_displayReasoning && reasoningContent)
          ? _foldReasoningIntoContent(reasoningContent, cleanText)
          : cleanText;
        await s.write(JSON.stringify({
          model: body.model, created_at: createdAt,
          message: { role: "assistant", content: displayContent, ...(!_displayReasoning && reasoningContent ? { reasoning_content: reasoningContent } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          done: true, done_reason: "stop",
          total_duration: duration * 1e6, load_duration: 0, prompt_eval_count: chatUsage?.prompt_tokens || 0, prompt_eval_duration: 0, eval_count: chatUsage?.completion_tokens || 0, eval_duration: 0,
        }) + "\n");
        return;
      }

      // Streaming NDJSON
      let tokenCount = 0;
      if (toolCalls.length) {
        const tcMsg = { role: "assistant", content: "", tool_calls: toolCalls };
        if (reasoningContent) {
          if (_displayReasoning) tcMsg.content = _foldReasoningIntoContent(reasoningContent, "");
          else tcMsg.reasoning_content = reasoningContent;
        }
        await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: tcMsg, done: false }) + "\n");
      } else {
        const words = (cleanText || "").match(/.{1,20}/g) || [cleanText || ""];
        let firstWord = true;
        for (const w of words) {
          if (!w) continue;
          const msg = { role: "assistant", content: w };
          if (firstWord && reasoningContent) {
            if (_displayReasoning) msg.content = _foldReasoningIntoContent(reasoningContent, w);
            else msg.reasoning_content = reasoningContent;
            firstWord = false;
          }
          await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: msg, done: false }) + "\n");
          tokenCount++;
        }
      }
      log(`stream done (${tokenCount} chunk${tokenCount !== 1 ? "s" : ""})`);
      await s.write(JSON.stringify({ model: body.model, created_at: createdAt, message: { role: "assistant", content: "" }, done: true, done_reason: toolCalls.length ? "tool_calls" : "stop", total_duration: duration * 1e6, load_duration: 0, prompt_eval_count: chatUsage?.prompt_tokens || 0, prompt_eval_duration: 0, eval_count: chatUsage?.completion_tokens || 0, eval_duration: 0 }) + "\n");

    } catch (e) {
      err(`  错误: ${e.message}`);
      await s.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: "assistant", content: `Error: ${e.message}` }, done: true, done_reason: "error" }) + "\n");
    }
  });
});

app.post("/api/generate", async c => {
  logReq(c);
  const body = await getBody(c);
  const startTime = Date.now();
  collapseBanner();

  return stream(c, async s => {
    try {
      const req = { model: mapModel(body.model), messages: [...(body.system ? [{ role: "system", content: body.system }] : []), { role: "user", content: body.prompt, images: body.images }], options: body.options, stream: body.stream, format: body.format };
      if (body.chat_template_kwargs != null) req.chat_template_kwargs = body.chat_template_kwargs;
      if (body.thinking_token_budget != null) req.thinking_token_budget = body.thinking_token_budget;
      let full = "";
      let tokenCount = 0;
      const genModel = mapModel(body.model);
      const cm = ModelConcurrencyManager.getInstance();
      await cm.acquireModel(genModel);
      try {
        for await (const chunk of chatCompletion(req)) {
          full += chunk.message?.content || "";
          if (body.stream === false) continue;
          await s.write(JSON.stringify({ model: body.model, created_at: chunk.created_at, response: chunk.message?.content || "", done: false }) + "\n");
          tokenCount++;
        }
      } finally {
        cm.releaseModel(genModel);
      }
      log(`stream done (${tokenCount} chunk${tokenCount !== 1 ? "s" : ""})`);
      const duration = Date.now() - startTime;
      await s.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), response: body.stream === false ? full : "", done: true, done_reason: "stop", context: null, total_duration: duration * 1e6, load_duration: 0, prompt_eval_count: 0, prompt_eval_duration: 0, eval_count: 0, eval_duration: 0 }) + "\n");
    } catch (e) {
      err(`  错误: ${e.message}`);
      await s.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), response: `Error: ${e.message}`, done: true }) + "\n");
    }
  });
});

// ── Stop server ──

app.get("/stop", c => {
  log("已通过 /stop 请求关闭");
  keepaliveShutdown();
  setTimeout(() => process.exit(0), 100);
  return c.json({ status: "shutting down" });
});

// ── Passthrough proxy ──
// Forwards unmatched paths to a configurable upstream (e.g., OpenCode API)
// Controlled by PASSTHROUGH_BASE_URL env var

function isPassthroughPath(pathname) {
  if (!config.passthroughBaseUrl) return false;
  const prefixes = (Bun.env.PASSTHROUGH_PREFIXES || "/v1").split(",").map(p => p.trim()).filter(Boolean);
  return prefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function handlePassthrough(c) {
  const url = new URL(c.req.url);
  const method = c.req.method;
  let body = null;

  if (method !== "GET" && method !== "HEAD") {
    try { body = await c.req.text(); } catch {}
  }

  const incomingHeaders = {};
  for (const [k, v] of Object.entries(c.req.header())) {
    if (!k || ["host", "connection", "content-length"].includes(k.toLowerCase())) continue;
    incomingHeaders[k] = v;
  }

  const key = config.apiKey;
  if (key && !incomingHeaders["authorization"]) {
    incomingHeaders["authorization"] = `Bearer ${key}`;
  }

  if (body && !incomingHeaders["content-type"]) {
    incomingHeaders["content-type"] = "application/json";
  }

  try {
    const upstream = await fetchWithAgent(`${config.passthroughBaseUrl}${url.pathname}${url.search}`, {
      method,
      headers: incomingHeaders,
      ...(body ? { body } : {}),
    });

    const respHeaders = new Headers(upstream.headers);
    respHeaders.set("access-control-allow-origin", "*");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (e) {
    err(`  透传错误: ${e.message}`);
    return c.json({ error: { message: `Upstream unreachable: ${e.message}`, type: "server_error", code: "bad_gateway" } }, 502);
  }
}

// ── Catch-all for unknown routes — log to discover unmapped Copilot endpoints ──

app.all("*", c => {
  const url = new URL(c.req.url);
  if (isPassthroughPath(url.pathname)) {
    return handlePassthrough(c);
  }
  if (url.pathname === "/api/generate") return c.json({ error: `Not found: ${c.req.method} ${c.req.url}` }, 404);
  const ua = c.req.header("User-Agent") || "";
  const bag = c.req.header("baggage") || "";
  log(`\x1b[33m[404]\x1b[0m ${c.req.method} ${c.req.path}  UA=${ua.slice(0, 50)}  bag=${bag.slice(0, 50)}`);
  return c.json({ error: `Not found: ${c.req.method} ${c.req.url}` }, 404);
});

// ── Start ──

let serverRef = null;

// Port check: if taken (e.g. Ollama), try next
let port = config.port;
const host = config.host;

// IIFE wrapper — Node.js 26.1.0 doesn't support top-level await in bare blocks
(async () => {
  const net = await import("node:net");
  const isFree = await new Promise(r => {
    const s = net.createServer();
    s.once("error", () => r(false));
    s.listen(port, host, () => { s.close(() => r(true)); });
  });
  if (!isFree) {
    log(`端口 ${port} 已被占用，尝试使用端口 ${port + 1}…`);
    port++;
  }

  if (_isServiceMode) {
    try { process.stderr.write("[snet] entering service mode\r\n"); } catch {}
    try {
      await runAsService({
        onStart: _runServer,
        onStop: () => {
          log("服务正在停止…");
          if (serverRef?.stop) serverRef.stop(true);
          else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(); }
        }
      });
    } catch (e) {
      try { process.stderr.write(`[snet] runAsService error: ${e?.message || e}\r\n`); } catch {}
      process.exit(1);
    }
  } else {
    await _runServer();
  }
})().catch(e => { process.stderr.write(`[snet] fatal: ${e?.message || e}\r\n`); process.exit(1); });

// ── Server lifecycle ──
async function _runServer() {
  // Start HTTP server
  if (typeof Bun !== 'undefined' && typeof Bun.serve === 'function') {
  serverRef = Bun.serve({ port, hostname: host, fetch: app.fetch, idleTimeout: 120 });
  log(`${t("listening")} http://${host}:${serverRef.port}`);
} else if (typeof process !== 'undefined' && process.versions?.node) {
  const http = await import("http");
  serverRef = http.createServer({ noDelay: true, maxHeaderSize: 65536 }, (req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const url = `http://${req.headers.host || host}${req.url}`;
      const init = { method: req.method, headers };
      if (raw && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")) {
        init.body = raw;
      }
      const webReq = new Request(url, init);

      app.fetch(webReq).then(webRes => {
        res.statusCode = webRes.status;
        webRes.headers.forEach((v, k) => res.setHeader(k, v));
        if (webRes.body) {
          const reader = webRes.body.getReader();
          const pump = () => reader.read().then(({ done, value }) => {
            if (done) { res.end(); return; }
            res.write(value);
            pump();
          });
          pump();
        } else {
          res.end();
        }
      }).catch(err => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });
  serverRef.timeout = 120000;
  serverRef.headersTimeout = 65000;
  serverRef.requestTimeout = 120000;
  serverRef.keepAliveTimeout = 65000;
  serverRef.maxHeadersCount = 200;
  await new Promise((resolve) => {
    serverRef.listen(port, host, 1024, () => {
      log(`${t("listening")} http://${host}:${port}`);
      resolve();
    });
  });
}

// Load models & show banner in background
let models = await initModels();



// Wait for background paid-model fetch to complete, then refresh model list
await bgFetchDone();
models = await getModels();
_lastDSAvail = isDeepSeekAvailable();
_lastMiMoAvail = isMiMoAvailable();


function printSimple(list, label) {
  P(line(S + label + " (" + list.length + ")" + R));
  for (const m of list) {
    const name = m.name;
    const id = m.model.replace(":latest", "");
    const n = +m.maxParams;
    const ctx = n ? (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n)) : "-";
    P(line(S + name.padEnd(38) + " │ " + R + id.padEnd(22) + S + " │ " + R + ctx.padEnd(7)));
  }
  P("");
}

const B = "\x1b[1m";
const R = "\x1b[0m";
const C = "\x1b[36m";
const S = "\x1b[90m";
const W = "\x1b[37m";
const boxW = 78;
setBoxWidth(boxW);
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const V = "\u2502";   // │ vertical border
const H = "\u2500";   // ─ horizontal border
const line = (l) => {
  const pad = boxW - 4 - vis(l);
  return S + V + R + "  " + l + " ".repeat(Math.max(0, pad)) + S + V + R;
};
const hr = S + H.repeat(boxW - 2);

const hasDS = models.some(m => isDeepSeekModel(m.model));
const hasMiMo = models.some(m => isMiMoModel(m.model));
if (hasDS) log(`\x1b[32m${t("modelLoaded")}\x1b[0m`);
if (hasMiMo) log(`\x1b[35m${t("mimoLoaded")}\x1b[0m`);

let _buildDate = "";
try {
  const raw = require("fs").readFileSync(VERSION_FILE, "utf8").trim();
  const ts = Number(raw);
  if (ts > 0) _buildDate = new Date(ts).toISOString().slice(0, 10);
} catch {}

let _bannerLines = [];
const P = (s) => { _bannerLines.push(s); };
const _G = "\x1b[32m"; // green for active debug
const _cmdLine = () => {
  const dc = _isDebug() ? _G : C;
  return line(S + "Commands: " + C + "s" + R + W + "/" + R + C + "stop" + R + S + "  " + C + "r" + R + W + "/" + R + C + "restart" + R + S + "  " + C + "u" + R + W + "/" + R + C + "update" + R + S + "  " + dc + "d" + R + W + "/" + R + dc + "debug" + R + S + "  \u2190\u2192 collapse  \u2191\u2193PgUp/PgDn" + R);
};

P("");
P(W + "┌" + hr + W + "┐" + R);                                            // ┌───┐
P(line("[ Shunnet.top ] Copilot Proxy" + R));
const portLabel = port === 11434 ? `port: ${port} (default)` : `port: ${port}`;
P(line(S + portLabel + "  |  built " + C + _buildDate + R + S + "  |  models.dev" + R));
P(_cmdLine());
P("");

// Split models into sections by separator order (DeepSeek → MiMo)
	const dsStart = models.findIndex(m => m.model === `${SEP_DEEPSEEK}:latest`);
	const mimoStart = models.findIndex(m => m.model === `${SEP_MIMO}:latest`);

	// Each section: from its separator+1 to the next separator (or end)
	const dsEnd = [mimoStart, models.length].find(i => i >= 0);

	const dsModels = dsStart >= 0 ? models.slice(dsStart + 1, dsEnd) : [];
	const mimoModels = mimoStart >= 0 ? models.slice(mimoStart + 1) : [];

	// Build collapsed banner: header + category summaries + bottom border
	const _bannerCollapsed = [..._bannerLines];
	if (hasDS) _bannerCollapsed.push(line(S + C + "▶ " + R + S + "DeepSeek (" + dsModels.length + ")" + R));
	if (hasMiMo) _bannerCollapsed.push(line(S + C + "▶ " + R + S + "MiMo (" + mimoModels.length + ")" + R));
	_bannerCollapsed.push(W + "└" + hr + W + "┘" + R);
	_bannerCollapsed.push("");

	function printTable(list) {
	  for (const m of list) {
	    const modes = getThinkingModes(m.model.replace(":latest", ""));
	    const modeMap = { LOW: "L", MEDIUM: "M", HIGH: "H", MAXIMUM: "MX" };
	    const thinkLabel = modes.length ? " [37m" + modes.map(t => modeMap[t] || t[0]).join("[0m[90m,[0m[37m") + "[0m" : "";
	    const nameColor = S;
	    const nameReset = R;
	    const nameW = 38;
	    const rawName = m.name + thinkLabel;
	    const nameLen = rawName.replace(/[[0-9;]*m/g, "").length;
	    let name;
	    if (nameLen > nameW) {
	      let vis = 0;
	      let out = "";
	      const parts = rawName.split(/([[0-9;]*m)/);
	      for (const p of parts) {
	        if (p.startsWith("[")) { out += p; continue; }
	        const take = Math.min(p.length, nameW - 1 - vis);
	        out += p.slice(0, take);
	        vis += take;
	        if (vis >= nameW - 1) break;
	      }
	      name = out + "…";
	    } else {
	      name = rawName + " ".repeat(Math.max(0, nameW - nameLen));
	    }
	    const id = (m.model.replace(":latest", "")).length > 22
	      ? (m.model.replace(":latest", "")).slice(0, 21) + "…"
	      : (m.model.replace(":latest", "")).padEnd(22);
	    const n = +m.maxParams;
	    const params = n
	      ? (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n)).padEnd(7)
	      : "-".padEnd(7);
	    P(line(nameColor + name + nameReset + S + " │ " + R + id + S + " │ " + R + params + R));
	  }
	}

	if (hasDS) {
	  
	  P(line(S + "Name".padEnd(38) + " │ " + "ID".padEnd(22) + " │ " + "Context".padEnd(7) + R));
	  printSimple(dsModels, "DeepSeek");
	}

	if (hasMiMo) {
	  
	  P(line(S + "Name".padEnd(38) + " │ " + "ID".padEnd(22) + " │ " + "Context".padEnd(7) + R));
	  printSimple(mimoModels, "MiMo");
	}

P(W + "\u2514" + hr + W + "\u2518" + R);                                            // └───┘
P("");

// Print banner once (accumulated above) — avoids double-print from P() + _redraw()
const _isTTY = !!(process.stdout.isTTY ?? process.stdin.isTTY);
if (_isPlainMode) {
  log(`[Shunnet.top] Copilot Proxy  |  port: ${port}  |  models.dev`);
  if (hasDS) log(`DeepSeek (${dsModels.length}): ${dsModels.map(m => m.name).join(", ")}`);
  if (hasMiMo) log(`MiMo (${mimoModels.length}): ${mimoModels.map(m => m.name).join(", ")}`);
} else if (_isTTY) {
  // Print banner once, then enable dashboard for live updates
  for (const line of _bannerLines) process.stdout.write(line + "\n");
}

// Enable dashboard (sticky banner + scrollable log) — skip in plain mode (C# integration)
if (_isTTY && !_isPlainMode) {
  enableDashboard(_bannerCollapsed, _bannerLines);
  onCommand((cmd) => {
    if (cmd === "stop") {
      disableDashboard();
      log("正在关闭…");
      if (serverRef?.stop) serverRef.stop(true);
      else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => process.exit(0)); }
      setTimeout(() => process.exit(0), 2000);
    } else if (cmd === "restart") {
      disableDashboard();
      log("正在重启…");
      if (serverRef?.stop) { serverRef.stop(true); restartSelf(); }
      else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf()); }
      else { restartSelf(); }
      setTimeout(() => process.exit(42), 5000);
    } else if (cmd === "update") {
      disableDashboard();
      log("正在更新并重启…");
      if (serverRef?.stop) { serverRef.stop(true); restartSelf(43); }
      else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf(43)); }
      else { restartSelf(43); }
      setTimeout(() => process.exit(43), 5000);
    } else if (cmd === "debug") {
      Bun.env.DEBUG = _isDebug() ? "" : "1";
      const newLine = _cmdLine();
      _bannerLines[8] = newLine;
      _bannerCollapsed[8] = newLine;
      redrawBanner();
      log(`DEBUG ${_isDebug() ? "ON" : "OFF"}`);
    }
  });
}
// Console commands (non-TTY fallback)
if (!_isTTY) (async () => {
  let canUpdate = false;
  try {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    canUpdate = existsSync(join(process.cwd(), "update.cmd"));
  } catch {}
  if (process.stdin.isTTY && typeof process.stdin.on === "function") {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (data) => {
      const cmd = data.trim().toLowerCase();
      if (cmd === "stop" || cmd === "s" || cmd === "exit" || cmd === "e" || cmd === "quit" || cmd === "q") {
        log("正在关闭…");
        if (serverRef?.stop) serverRef.stop(true);
        else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => process.exit(0)); }
        setTimeout(() => process.exit(0), 2000);
      } else if (cmd === "restart" || cmd === "r") {
        log("正在重启…");
        if (serverRef?.stop) { serverRef.stop(true); restartSelf(); }
        else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf()); }
        else { restartSelf(); }
        setTimeout(() => process.exit(42), 5000);
      } else if (canUpdate && (cmd === "update" || cmd === "u")) {
        log("正在更新并重启…");
        if (serverRef?.stop) { serverRef.stop(true); restartSelf(43); }
        else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf(43)); }
        else { restartSelf(43); }
        setTimeout(() => process.exit(43), 5000);
      }
    });
    process.stdin.resume();
  }
})();

// ── Self-restart helper for standalone (.exe) runs ──
// Restart helper. When wrapped (SNET_WRAPPED=1), exit and let the wrapper loop restart.
// Standalone: spawn cmd /c start /D wd cmd /c exe — opens a new independent console.
// NOTE: paths passed without quotes because Bun wraps the entire cmd arg in quotes,
// and nested quotes would break CMD parsing.
async function restartSelf(exitCode = 42) {
  if (process.env.SNET_WRAPPED) {
    process.exit(exitCode);
    return;
  }
  try {
    const pathMod = await import("node:path");
    const exe = process.execPath;
    const wd = pathMod.dirname(exe);
    const args = process.argv.slice(1).join(" ");
    const cmd = `start /D ${wd} cmd /c ${exe} ${args}`.trim();

    if (typeof Bun !== 'undefined') {
      Bun.spawn(["cmd", "/c", cmd], {
        stdout: "ignore", stderr: "ignore", stdin: "ignore",
      }).unref();
    } else {
      const { spawn } = await import("node:child_process");
      spawn("cmd", ["/c", cmd], {
        detached: true, stdio: "ignore", windowsHide: true,
      }).unref();
    }
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    err("自重启启动失败: " + e.message);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.exit(exitCode);
}

// ── OS signal handling (copilot-proxy pattern) ──
let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log(`收到 ${signal} — 正在优雅关闭（30 秒超时）…`);
  _recentlyCompleted.clear();
  keepaliveShutdown();
  setTimeout(() => { err("强制退出：关闭超时"); process.exit(1); }, 30000);
  if (serverRef?.stop) {
    serverRef.stop(true);
  } else if (serverRef?.close) {
    serverRef.closeAllConnections?.();
    serverRef.close(() => process.exit(0));
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

}
