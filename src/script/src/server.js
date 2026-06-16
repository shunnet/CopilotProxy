import "./polyfill.js";
// ── Crash guards: catch unhandled errors so the process stays alive ──
process.on("uncaughtException", (e) => { try { process.stderr.write(`[Snet] FATAL uncaughtException: ${e?.message || e}\r\n${e?.stack?.slice(0,500)}\r\n`); } catch {} });
process.on("unhandledRejection", (reason) => { try { process.stderr.write(`[Snet] FATAL unhandledRejection: ${reason?.message || reason}\r\n`); } catch {} });
const _isDebug = () => { const v = process.env.DEBUG; return v === "1" || v === "true" || v === "yes"; };
if (_isDebug()) try { process.stderr.write(`[Snet] startup pid=${process.pid} argv=${JSON.stringify(process.argv)}\r\n`); } catch (e) { /* stderr may not be available early */ }

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
  try { const { TransformStream: TS } = await import("node:stream/web"); globalThis.TransformStream = TS; } catch (e) { /* TransformStream not available */ }
}
if (typeof ReadableStream === 'undefined') {
  try { const { ReadableStream: RS } = await import("node:stream/web"); globalThis.ReadableStream = RS; } catch (e) { /* ReadableStream not available */ }
}

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { config, getModels, initModels, resolveModel, resolveModelMetadata, isKnownModel, chatCompletion, APIError, isSeparator, isDeepSeekModel, isMiMoModel, SEP_DEEPSEEK, SEP_MIMO, refreshModels, bgFetchDone, getThinkingModes, parseThinkingMode } from "./snet-handle.js";

import { ModelConcurrencyManager, RateLimitError, truncateToolMessagesInPayload, checkRequestBodySize } from "./concurrency.js";
import { compactIdentity, compactToolInstructions, compactOllamaToolInstructions, compactCodeCompletionPrompt } from "./token-optimizer.js";
import { trackSession, stopSession, shutdown as keepaliveShutdown, stats as keepaliveStats } from "./session-keepalive.js";
import { handleServiceCommand, runAsService } from "./win-service.js";
import { log, error as logErr, debug, enableDashboard, disableDashboard, onCommand, collapseBanner, redrawBanner, setBoxWidth, setPlainMode } from "./logger.js";
import { isDeepSeekAvailable } from "./deepseek-client.js";
import { isMiMoAvailable } from "./mimo-client.js";
import { t, setLanguage, getLanguage } from "./i18n.js";
import { _stripOrphanedToolCalls, _toolNames, _stripAllToolCalls, checkOrphanToolMessage } from "./message-pipeline.js";
import { extractToolCalls, normalizeToolCall, getWorkspaceRoot, hasXMLToolCalls } from "./tool-extractor.js";
import { createReasoningContext, _assistantNeedsReasoning, _crossReqReasoningCache } from "./reasoning-cache.js";
import { _sessionRegistry, _workspaceSessions, _workspaceSummaries, _taskCompletedSessions, _recentlyCompleted, _rateLimitedSessions, _summarizeCompletedTask } from "./session-tracker.js";
import { _simStream, _foldReasoningIntoContent, addReasoningAliases, reconstructToolCalls } from "./stream-handler.js";
import { embedReasoning, extractReplayedReasoning } from "./reasoning-replay.js";

// ── Service command routing (early exit for install/uninstall) ──
{
  const svcCmd = await handleServiceCommand(process.argv);
  if (svcCmd.handled) process.exit(svcCmd.exitCode);
}

// ── Service mode detection ──
const _isServiceMode = process.argv.includes("--service") || process.env.SNET_SERVICE === "1";
const _isPlainMode = process.argv.includes("--plain") || process.env.SNET_PLAIN === "1";
if (_isPlainMode) setPlainMode(true);

// 构建日期文件（由构建脚本写入）
const VERSION_FILE = ".version";
// Version is set at build time by CI. The .version file (if present) overrides
// the displayed date; this string is the proxy's semantic version identifier.
const SNET_VERSION = "420.96.00";

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
await (async () => {
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(".env")) {
      fs.writeFileSync(".env", `# ============================================================
#  Snet Copilot Proxy — Configuration
# ============================================================
#  所有配置均设有合理默认值，按需修改即可。
#  All settings have sensible defaults. Only change what you need.
# ============================================================

# --- Model Selection ---
DEFAULT_MODEL=ds/deepseek-v4-pro

# --- Server ---
SERVER_HOST=127.0.0.1
SERVER_PORT=11434

# --- DeepSeek API ---
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=

# --- MiMo API ---
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
MIMO_API_KEY=

# --- Logging ---
REQUEST_LOG=true
DEBUG=false

# --- Compression (off/lite/caveman/rtk/ultra/delta/stacked/aggressive/standard) ---
COMPRESSION_LEVEL=caveman

# --- Concurrency ---
CONCURRENCY_THINKING=5
CONCURRENCY_STANDARD=15
RETRY_MAX=3
THINKING_TIMEOUT_MS=300000
REQUEST_TIMEOUT_MS=300000

# --- Context & Tool Output ---
DEFAULT_CONTEXT_LENGTH=262144
DEFAULT_TEMPERATURE=
MAX_TOOL_OUTPUT_CHARS=12000
MESSAGES_PAGING=0

# --- Session Keepalive ---
SESSION_KEEPALIVE_ENABLED=true
SESSION_KEEPALIVE_INTERVAL_MS=60000
SESSION_KEEPALIVE_IDLE_TIMEOUT_MS=1800000

# --- Language ---
SNET_LANGUAGE=zh
`);
      log(t("creatingEnv"));
    }
  } catch (e) { /* intentionally ignored */ }
})();

// ── Load .env into process.env (Node.js doesn't auto-load .env like Bun) ──
{
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const cwd = process.cwd();

    // Search for .env: parent (source dir) first, then cwd (build dir)
    const parentEnv = path.resolve(cwd, "..", ".env");
    const candidates = [parentEnv, ".env"];

    for (const envFile of candidates) {
      if (!fs.existsSync(envFile)) continue;
      const rawBuf = fs.readFileSync(envFile);
      const envContent = rawBuf[0] === 0xEF && rawBuf[1] === 0xBB && rawBuf[2] === 0xBF
        ? rawBuf.toString("utf8", 3) : rawBuf.toString("utf8");
      let loaded = 0;
      for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!val) continue;
        process.env[key] = val;
        loaded++;
      }
      if (loaded > 0) break;
    }
    globalThis.Bun = { env: { ...process.env } };
  } catch (e) { /* intentionally ignored */ }
}

// No API key needed — free tier works without

const app = new Hono();
// ── 辅助函数 ──

const callId = () => `call_${crypto.randomUUID().slice(0, 8)}`;

const apiErr = (e) => {
  const status = e instanceof APIError ? e.status : 500;
  const code = status === 401 ? "invalid_api_key" : status === 429 ? "rate_limit_exceeded" : status === 404 ? "model_not_found" : status === 504 ? "gateway_timeout" : "server_error";
  const type = status === 401 ? "invalid_request_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error";
  const param = status === 404 ? "model" : null;
  return { status, body: { error: { message: "Internal server error", type, code, ...(param ? { param } : {}) } } };
};

async function getBody(c) {
  try {
    const text = await c.req.text();
    return text ? JSON.parse(text) : {};
  } catch (e) {
      throw new Error("Invalid request body: " + e.message);
  }
}

// ── Shared display helpers (H23: extracted from duplicate inline definitions) ──
const SHORT_TAG = { LOW: "LO", MEDIUM: "MD", HIGH: "HI", MAXIMUM: "MX", XHIGH: "X" };
const VSC_THINK_TAG = { LOW: "/1_(low)", MEDIUM: "/2_(medium)", HIGH: "/3_high", MAXIMUM: "/4_(maximum)", XHIGH: "/4_(xhigh)" };

function _thin(name, vsc) {
  if (vsc) return name;
  return name.length > 20 ? name.replace(/ /g, " ") : name;
}

function _vsTag(baseName, mode, vsc) {
  if (vsc) return ` [${mode}]`;
  const full = ` [${mode}]`;
  if ((baseName + full).length <= 20) return full;
  const short = SHORT_TAG[mode];
  if (short) return ` [${short}]`;
  return full;
}

// ── OpenAI response builder ──

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
  const envClient = process.env.DEFAULT_CLIENT || "";
  if (envClient && ["vscode","vs","vsi","sql"].includes(envClient)) return envClient;
  if (isVSCode(c)) return "vscode";
  if (isVSInsiders(c)) return "vsi";
  if (isVS2026(c)) return "vs";
  if (isSqlStudio(c)) return "sql";
  return process.env.DEFAULT_CLIENT || "vscode"; // fallback or env default
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
  if (n.reasoningEffort !== undefined && n.reasoning_effort === undefined) n.reasoning_effort = n.reasoningEffort;
  delete n.topP; delete n.frequencyPenalty; delete n.presencePenalty; delete n.maxOutputTokens;
  delete n.chatTemplateKwargs; delete n.thinkingTokenBudget; delete n.reasoningEffort;
  return n;
}

// ── Think tag processor ──
function processThinkTags(text) {
  if (!text || typeof text !== "string") return { content: text || "", reasoning: null };
  // M10: Single-pass regex replace (was O(n²) with loop + replace)
  const thinkRe = /<think>\s*([\s\S]*?)\s*<\/think>/gi;
  let reasoning = "";
  let clean = text.replace(thinkRe, (match, content) => {
    reasoning += (reasoning ? "\n" : "") + content.trim();
    return "";
  });
  clean = clean.replace(/<\/?think>/gi, "").trim();
  return {
    content: sanitizeContent(clean),
    reasoning: reasoning ? sanitizeContent(reasoning) : null,
  };
}

const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);
const _displayReasoning = (process.env.DISPLAY_REASONING || "false").toLowerCase() === "true";
const _collapsibleReasoning = (process.env.COLLAPSIBLE_REASONING || "true").toLowerCase() !== "false";
const _THINKING_BLOCK_START = _collapsibleReasoning ? "<details>\n<summary>snet Thinking</summary>\n\n" : "<!-- snet-thinking -->\n";
const _THINKING_BLOCK_END = _collapsibleReasoning ? "\n</details>\n\n" : "\n<!-- /snet-thinking -->\n\n";
// CR-3: Bounded regex to prevent ReDoS — uses {0,200000}? instead of unbounded *
// to limit backtracking on malformed/missing closing tags.
const _THINKING_STRIP_RE = new RegExp(
  `<details\\b[^>]{0,100}>\\s*<summary\\b[^>]{0,100}>\\s*snet Thinking\\s*</summary>[\\s\\S]{0,200000}?</details>\\s*|<!-- snet-thinking -->\\s*[\\s\\S]{0,200000}?\\s*<!-- /snet-thinking -->\\s*`,
  "gi"
);
function _stripDisplayedThinking(content) {
  if (typeof content !== "string") return content;
  // Safety: if regex fails on malformed input (no closing tag), fall back to indexOf-based strip
  try {
    const safeContent = typeof content === "string" ? content.slice(0, 50000) : content;
    return safeContent.replace(_THINKING_STRIP_RE, "").trimStart();
  } catch (e) { /* intentionally ignored */
    // Fallback: manual strip for malformed thinking blocks
    let result = content;
    const startTag = /<details\b[^>]*>\s*<summary\b[^>]*>\s*snet Thinking\s*<\/summary>/gi;
    const endTag = /<\/details>/gi;
    // Remove complete pairs via indexOf
    let i = 0;
    while (i < result.length) {
      startTag.lastIndex = i;
      const sm = startTag.exec(result);
      if (!sm) break;
      endTag.lastIndex = sm.index + sm[0].length;
      const em = endTag.exec(result);
      if (!em) break;
      result = result.slice(0, sm.index) + result.slice(em.index + em[0].length);
      i = sm.index;
    }
    // Also strip comment-based markers
    result = result.replace(/<!-- snet-thinking -->[\s\S]*?<!-- \/snet-thinking -->/gi, "");
    return result.trimStart();
  }
}

// 定期清理过期会话条目（24 小时 TTL），防止长期运行的服务器内存泄漏
// NOTE: session-tracker.js also maintains its own cleanup — this one covers server.js registries
const _SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - _SESSION_MAX_AGE_MS;
  for (const [k, v] of _recentlyCompleted) {
    if (v < cutoff) _recentlyCompleted.delete(k);
  }
  for (const [k, v] of _rateLimitedSessions) {
    if (v.at < cutoff) _rateLimitedSessions.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ── Ollama -> Go model mappings (what VS Copilot sends vs what Go API expects)
function mapModel(name) {
  const parsed = parseThinkingMode(name);
  const raw = parsed.model.replace(/^\s*\[(?:DEEPSEEK|deepseek|MIMO|mimo)\]\s*/i, "").trim();
  let clean = raw.replace(/:latest$/i, "").split(":")[0].trim();
  const fullClean = raw.replace(/:latest$/i, "").trim();
  // Try full name via resolveModel which handles display names with colons
  const resolved = resolveModel(fullClean);
  if (resolved && !resolved.unverified) return resolved.id;
  return resolveModel(clean).id;
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

// ── Debug client override (?src=vscode|vs|vsi|sql) ──
app.use("*", async (c, next) => {
  const src = c.req.query("src");
  if (src && ["vscode", "vs", "vsi", "sql"].includes(src)) {
    _forceClient = src;
    log(`\x1b[35m[debug]\x1b[0m src=${src}`);
  }
  // M8: try/finally ensures _forceClient is always reset, even on request errors
  try { await next(); } finally { _forceClient = null; }
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
      reason = t("healthNoModels");
    } else if (!dsModels.length && !mimoModels.length) {
      status = "unhealthy";
      reason = t("healthNoAvailable");
    }

    return c.json({
      status,
      ...(reason ? { reason } : {}),
      authenticated: true,
      models_supported: modelNames,
      models_total: real.length,
      models_deepseek: dsModels.length,
      models_mimo: mimoModels.length,
      proxy_version: SNET_VERSION,
    });
  } catch (e) {
    return c.json({
      status: "unhealthy",
      reason: "Health check failed: internal server error",
    });
  }
});

// ── Language endpoint ──
app.post("/api/language", async c => {
  try {
    const body = await c.req.json();
    if (body && (body.language === "zh" || body.language === "en")) {
      setLanguage(body.language);
      log(t("i18nSet", body.language));
      return c.json({ ok: true, language: getLanguage() });
    }
    return c.json({ ok: false, error: "invalid language" }, 400);
  } catch (e) { /* intentionally ignored */
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

    function pushModel(name, modelTag, digestSuffix, parentModel) {
      const displayFamily = family + (modelTag || "");
      models.push({
        name: _thin(name, vsc),
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
        const tag = _vsTag(baseName, mode, vsc);
        pushModel(
          `${baseName}${tag}`,
          vsc ? (VSC_THINK_TAG[mode] || `/${mode.toLowerCase()}`) : ` [${mode}]`,
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

app.get("/api/version", c => c.json({ version: SNET_VERSION }));

app.get("/version", async c => {
  const models = await getModels();
  const real = models.filter(m => !isSeparator(m.model)).flatMap(m => {
    const rawId = (m.model || "").replace(":latest", "").split(":")[0].trim();
    const modes = isSeparator(m.model) ? [] : getThinkingModes(rawId);
    if (modes.length > 0) return [m.name, ...modes.map(mode => `${m.name} [${mode}]`)];
    return [m.name];
  }).sort();
  return c.json({
    proxy_version: SNET_VERSION,
    ollama_compatibility: "0.6.4",
    proxy_name: "Snet",
    supported_models: real,
  });
});

let _lastRefresh = 0;
let _refreshPromise = null; // M34: guard against concurrent refresh calls

// M34: Debounced refresh — prevents concurrent refreshModel calls
async function _debouncedRefresh(label, minGapMs = 5000) {
  if (Date.now() - _lastRefresh < minGapMs) return;
  if (_refreshPromise) return _refreshPromise; // reuse in-flight refresh
  _lastRefresh = Date.now();
  _refreshPromise = refreshModels().finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

// DeepSeek API Key 变更检测 — 运行时自动刷新模型列表
let _lastDSAvail = null;
async function _checkDSRefresh() {
  const nowAvail = isDeepSeekAvailable();
  if (_lastDSAvail !== null && nowAvail !== _lastDSAvail) {
    log(nowAvail ? t("dsKeySet") : t("dsKeyRemoved"));
    _lastDSAvail = nowAvail;
    await _debouncedRefresh("ds");
    return;
  }
  _lastDSAvail = nowAvail;
  if (nowAvail && _lastRefresh > 0) {
    const models = await getModels();
    if (!models.some(m => SEP_DEEPSEEK && (m.model || "").replace(":latest", "").startsWith(SEP_DEEPSEEK))) {
      log(t("dsKeyNoModels"));
      await _debouncedRefresh("ds-nomodel");
    }
  }
}

// MiMo API Key 变更检测 — 运行时自动刷新模型列表
let _lastMiMoAvail = null;
async function _checkMiMoRefresh() {
  const nowAvail = isMiMoAvailable();
  if (_lastMiMoAvail !== null && nowAvail !== _lastMiMoAvail) {
    log(nowAvail ? t("mimoKeySet") : t("mimoKeyRemoved"));
    _lastMiMoAvail = nowAvail;
    await _debouncedRefresh("mimo");
    return;
  }
  _lastMiMoAvail = nowAvail;
  if (nowAvail && _lastRefresh > 0) {
    const models = await getModels();
    if (!models.some(m => SEP_MIMO && (m.model || "").replace(":latest", "").startsWith(SEP_MIMO))) {
      log(t("mimoKeyNoModels"));
      await _debouncedRefresh("mimo-nomodel");
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
  log(t("modelRefreshing"));
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
    version: SNET_VERSION,
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
    diagnostics.connectivity = { status: "failed", latency_ms: 0, error: "Upstream API connection failed" };
    diagnostics.streaming = { status: "skipped", chunks: 0, error: "connectivity failed" };
    diagnostics.tool_calling = { status: "skipped", tool_calls: 0, error: "connectivity failed" };
    results.status = "failed";
    results.error = "Upstream API request failed";
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

    function pushV1Model(name, idSuffix) {
      data.push({
        id: `${id}${idSuffix}`,
        object: "model",
        created: nowTs,
        owned_by: "OpenCode",
        name: _thin(name, vsc),
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
        const tag = _vsTag(name, mode, vsc);
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
  const clientWantsStream = body.stream === true || body.stream === "true";
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
  let tool400Streak = 0;
  const chatId = `chatcmpl-${startTime}`;
  const created = ~~(startTime / 1000);

  collapseBanner();

  if (!messages.length) return c.json({ error: { message: "messages is required and must be non-empty", type: "invalid_request_error", code: "missing_messages" } }, 400);

  // ── Per-message validation (copilot-proxy pattern) ──
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
  const reasoningCtx = createReasoningContext(messages, goModel, getWorkspaceRoot(messages), clientTag, provider, thinkingTag, { _sessionRegistry, _workspaceSessions });
  // DEBUG: log raw first user message (VS context block) on every request, hidden
  if (messages.length > 0) {
    const firstUser = messages.find(m => (m.role || "").toLowerCase() === "user");
    if (firstUser && typeof firstUser.content === "string") {
      const preview = firstUser.content.substring(0, 300);
      debug(`[context] ${firstUser.content.length}ch: ${preview}${firstUser.content.length > 300 ? "…" : ""}`);
    }
  }
  // Flood guard: if think-fallback streak persists across too many requests, 503

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
      // ── Vizards-style replay: extract reasoning from assistant messages ──
      const replayResult = extractReplayedReasoning(messages);
      let replayedReasoning = replayResult.reasoning;


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
                arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
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
        // UNIVERSAL check: validate tool messages have matching preceding tool_calls
        // (was LP-only; now applies to ALL clients including DeepSeek/MiMo)
        const orphanCheck = checkOrphanToolMessage(userMsgs, m, clientTag);
        if (orphanCheck.drop) continue;
        let tc = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
        if (toolLoopBroken) continue;
        try { const p2 = userMsgs[userMsgs.length-1]; if(p2&&p2.role==="assistant"&&p2.tool_calls){ const mt = p2.tool_calls.find(t=>t.id===m.tool_call_id); if(mt&&mt.function&&mt.function.name&&mt.function.name.includes("read")&&tc.length>10&&!tc.startsWith("[trunc")){ tc += " [Read more: use startLine+endLine to continue.]"; } } } catch(e){}
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
      // Task is done — return hard stop instead of forwarding to LLM
      reasoningCtx.seslog(`\x1b[33m[autopilot] task already done — returning hard stop\x1b[0m`);
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
    userMsgs.splice(0, userMsgs.length, ...mergedMsgs);

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
        apiMessages.splice(0, apiMessages.length, ...paged);
        debug(`  ${reasoningCtx.sessionPrefix} [paging] kept ${_paging} messages (dropped ${dropped})`);
      }
    }

    // Strip orphaned tool_calls before compression (prevents upstream 400)
    const { messages: validatedMessages, stripped: _ } = _stripOrphanedToolCalls(apiMessages);

    // Delta compression DISABLED for DeepSeek/MiMo — collapsing tool outputs
    // makes the model think it hasn't read files, causing repeated reads.
    // Vizards and other OpenAI-compatible proxies pass full uncompressed history.
    let deltaMessages = validatedMessages;

    // DeepSeek: only low/medium/high valid. MAXIMUM→high. MiMo: toggle only.
    const effectiveThinkingTag = /v4-pro|v4\.5|mimo-v2\.5-pro/i.test(goModel) ? "MAXIMUM" : "LOW";

    if ((isDeepSeekModel(goModel) || isMiMoModel(goModel)) && effectiveThinkingTag) {
      deltaMessages = deltaMessages.map(m => {
        if (m.role === "assistant" && m.tool_calls?.length && !m.reasoning_content) {
          return { ...m, reasoning_content: replayedReasoning || reasoningCtx.get(m, goModel) || "" };
        }
        return m;
      });
    }

    const compressedMessages = deltaMessages;

    let upstreamTools = (vsTools && vsTools.length > 0) ? vsTools : undefined;
    const ollamaReq = { model: goModel, messages: compressedMessages, stream: streamMode, tools: upstreamTools, clientTag, sessionId: reasoningCtx.sessionId, thinkingTag: effectiveThinkingTag };
    if (body.chat_template_kwargs != null) ollamaReq.chat_template_kwargs = body.chat_template_kwargs;
    if (body.thinking_token_budget != null) ollamaReq.thinking_token_budget = body.thinking_token_budget;

    trackSession(reasoningCtx.sessionId, goModel, compressedMessages, clientTag);

    // ── Stream mode: pipe directly from upstream async generator ──
    if (streamMode) {
      await cm.acquireModel(goModel);
      // H4: Guard against synchronous stream() failure — ensures model slot is always released
      try {
        return stream(c, async (s) => {
          let released = false;
          const release = () => { if (!released) { released = true; cm.releaseModel(goModel); } };
          try {
        const w = (o) => s.write(`data: ${JSON.stringify(o)}\n\n`);
        const base = { id: chatId, object: "chat.completion.chunk", created, model, system_fingerprint: systemFp };

        await w({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

        const deltas = [];
        const tcBuilders = new Map(); // accumulate tool call deltas by index (Vizards pattern)
        let tokenCount = 0;
        let hasTools = false;
        let clientGone = false;
        let _reasoningOpen = false;
        let streamUsage = null;

        try {
          for await (const chunk of chatCompletion(ollamaReq)) {
            if (clientGone) break;
            if (chunk.usage) streamUsage = chunk.usage;
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

            // Tool call deltas — accumulate by index, only emit COMPLETE calls
            // VS 2026 crashes on null callId — we must never pass partial deltas
            if (msg.tool_calls?.length) {
              if (_displayReasoning && _reasoningOpen) {
                try { await w({ ...base, choices: [{ index: 0, delta: { content: _THINKING_BLOCK_END }, finish_reason: null }] }); }
                catch { clientGone = true; break; }
                _reasoningOpen = false;
              }
              hasTools = true;
              // Accumulate deltas into tcBuilders (same Map used post-stream)
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
              // Only emit fully-formed tool calls (those with name + id)
              const complete = [...tcBuilders.values()].filter(b => b.id && b.function?.name);
              if (complete.length) {
                try {
                  await w({ ...base, choices: [{ index: 0, delta: { tool_calls: complete.map((tc, i) => ({ index: i, id: tc.id || "call_" + crypto.randomUUID().slice(0, 8), type: tc.type || "function", function: { name: tc.function.name, arguments: tc.function.arguments } })) }, finish_reason: null }] });
                } catch { clientGone = true; break; }
              }
              tokenCount++;
            }
          }
        } catch (e) {
          if (e instanceof APIError && e.status === 429) {
            _rateLimitedSessions.set(reasoningCtx.conv, { at: Date.now() });
            log(t("tokenNoDataReason", "stream interrupted by rate limit"));
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
          log(t("tokenNoDataReason", "stream error"));
          err(t("streamError", e.message));
          await s.write("data: [DONE]\n\n");
          return;
        }

        // Close open thinking block before finishing the stream
        if (_displayReasoning && _reasoningOpen) {
          await w({ ...base, choices: [{ index: 0, delta: { content: _THINKING_BLOCK_END }, finish_reason: null }] });
          _reasoningOpen = false;
        }

        // ── FIXED: Post-stream XML tool call extraction BEFORE [DONE] ──
        // Reconstruct text/reasoning/tool calls from deltas (fresh map, no double-accumulation)
        let { fullText, reasoningContent, allToolCalls } = reconstructToolCalls(deltas);
        // Ensure all tool calls have id
        for (const tc of allToolCalls) {
          if (!tc.id) tc.id = callId();
          if (!tc.type) tc.type = "function";
        }

        // FIXED: Check for XML tool calls BEFORE deciding finish_reason
        // This prevents the "XML stream disconnect" where the model returns
        // XML-formatted tool calls in text content instead of structured deltas
        if (!allToolCalls.length && (vsTools?.length || hasXMLToolCalls(fullText)) && fullText) {
          const extracted = extractToolCalls(fullText, getWorkspaceRoot(messages), messages);
          if (extracted.toolCalls.length) {
            allToolCalls = extracted.toolCalls;
            fullText = extracted.content;
            hasTools = true;
          }
        }

        const finishReason = hasTools ? "tool_calls" : "stop";
        await w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        await s.write("data: [DONE]\n\n");
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


        reasoningCtx.seslog(`stream done (${tokenCount} chunk${tokenCount !== 1 ? "s" : ""})`);
        } finally {
          release();
        }
      });
      } catch (_streamSetupError) {
        // H4: Release model slot if stream() setup throws synchronously
        cm.releaseModel(goModel);
        throw _streamSetupError;
      }
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
      tool400Streak = 0;
    } catch (e) {
      if (e.name === "RateLimitError") {
        _rateLimitedSessions.set(reasoningCtx.conv, { at: Date.now() });
        const errResp = apiErr(new APIError(429, e.body, e.message));
        return c.json(errResp.body, errResp.status);
      }
      if (e instanceof APIError && e.status === 400 && /reasoning_content.*must be passed back/i.test(e.message)) {
        err(`  [reasoning] stripping thinking mode & retrying (reasoning_content missing in history)`);
        const noThinkingReq = { ...nonStreamReq, stream: false, _noThinking: true,
          messages: nonStreamReq.messages.map(m => {
            if (m.reasoning_content !== undefined) { const { reasoning_content, ...rest } = m; return rest; }
            return m;
          })
        };
        delete noThinkingReq.reasoning_effort;
        delete noThinkingReq.thinking;
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
            const bareReq = { ...nonStreamReq, messages: bareMessages, stream: false, _noThinking: true };
            delete bareReq.reasoning_effort;
            delete bareReq.thinking;
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
        tool400Streak++;
        const tools = _toolNames(compressedMessages);
        err(`  [400] tool error (#${tool400Streak}/3): ${tools} — ${e.message}`);
        if (tool400Streak >= 3) {
          err(`  [tool] stripping all tool_calls & retrying without tools after ${tool400Streak} consecutive failures`);
          tool400Streak = 0;
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

    // Token usage — already included in reqLog completion (logDone)
    if (!config.requestLog) {
      if (usage) log(t("tokenUsage", usage.prompt_tokens, usage.completion_tokens, usage.total_tokens));
      else log(t("tokenNoData"));
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
          // Ensure all tool calls have id (DeepSeek/MiMo may return null id in some cases)
          allToolCalls = allToolCalls.map(tc => ({
            ...tc,
            id: tc.id || callId(),
            type: tc.type || "function",
          }));
      // H7: Preserve assistant text even when task_complete is absent —
      // the text may contain useful explanation about tool calls.
      if (!hasTaskComplete && cleanText.length < 50) cleanText = "";
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



    // DeepSeek thinking mode: when the model puts everything in <think> tags,
    // cleanText is empty but reasoning exists. Fall back smartly:
    //  1. Scan reasoning for tool calls (model may put them inside <think>)
    //  2. Track consecutive think-fallbacks and cut session if stuck
    //  3. Use a better fallback text than just the first line
    if (!hasTools && !cleanText && reasoningContent && reasoningCtx.sessionEntry) {
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
    if (hasTaskComplete) {
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

    // ── Vizards-style replay: embed reasoning into response for next request ──
    if (reasoningContent && !hasTaskComplete) {
      const choice = resp.choices[0];
      if (_displayReasoning) {
        const foldedContent = _foldReasoningIntoContent(reasoningContent, choice.message.content || "");
        choice.message.content = embedReasoning(foldedContent, reasoningContent);
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
      try { tools = _toolNames(compressedMessages); } catch (e) { debug(`[_toolNames] failed in error handler: ${e.message?.slice(0, 80)}`); }
      err(`  [400] tool error: ${tools} — ${e.message}`);
    }
    if (e instanceof APIError && e.status === 429) {
      _rateLimitedSessions.set(reasoningCtx.conv, { at: Date.now() });
      log(t("tokenNoDataReason", "rate limited"));
      const errResp = apiErr(e);
      return c.json(errResp.body, errResp.status);
    }
    err(t("apiError") + ": " + e.message);
    log(t("tokenNoDataReason", "error"));
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
        for (const chunk of words) {
          if (!chunk) continue;
          await w({ ...base, choices: Array.from({ length: n }, (_, i) => ({ text: chunk, index: i, logprobs: null, finish_reason: null })) });
        }
        await w({ ...base, choices: Array.from({ length: n }, (_, i) => ({ text: "", index: i, logprobs: null, finish_reason: "stop" })), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        await s.write("data: [DONE]\n\n");
        log(`completion done (${(sanitized || "").length} chars)`);
      });
    }

    return c.json(completion(sanitized));
  } catch (e) {
    log(t("tokenNoDataReason", "completions error"));
    err(t("apiError") + ": " + e.message);
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
  const reasoningCtx = createReasoningContext(messages, model, getWorkspaceRoot(messages), clientTag, provider, apiThinking, { _sessionRegistry, _workspaceSessions });
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
          // UNIVERSAL check: validate tool messages have matching preceding tool_calls
          const orphanCheck = checkOrphanToolMessage(userMsgs, m, clientTag);
          if (orphanCheck.drop) continue;
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
                message: { role: "assistant", content: "", tool_calls: [{ id: callId(), type: "function", function: { name: "task_complete", arguments: "{}" } }] },
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
          apiMessages.splice(0, apiMessages.length, ...paged);
          debug(`  ${reasoningCtx.sessionPrefix} [paging] kept ${_paging2} messages (dropped ${dropped})`);
        }
      }

      const { messages: validatedMessages, stripped: _ } = _stripOrphanedToolCalls(apiMessages);

      // Delta compression (KitPilot): strip historical VS context blocks, compact consumed tool outputs
      const isVSClient = clientTag === "vs" || clientTag === "vsi" || (clientTag && clientTag.startsWith("vs"));
      // Compression DISABLED — sending full uncompressed history
      let deltaMessages = validatedMessages;

      const compressedMessages = deltaMessages;
      let chatTools = (vsTools && vsTools.length > 0) ? vsTools : undefined;
      const reqBody = { model, messages: compressedMessages, stream: false, options: body.options, format: body.format, clientTag, tools: chatTools };
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
      // Token usage — already included in reqLog completion (logDone)
      if (!config.requestLog) {
        if (chatUsage) log(t("tokenUsage", chatUsage.prompt_tokens, chatUsage.completion_tokens, chatUsage.total_tokens));
        else log(t("tokenNoData"));
      }
      // FIXED: Always check for XML tool calls, even without explicit vsTools
      const shouldExtract = vsTools?.length || isDeepSeekModel(model) || isMiMoModel(model) || hasXMLToolCalls(fullText);
      let { content: cleanText, toolCalls: rawCalls } = shouldExtract ? extractToolCalls(fullText, getWorkspaceRoot(messages)) : { content: fullText, toolCalls: [] };
      const thinkResult = processThinkTags(cleanText);
      cleanText = thinkResult.content;
      const reasoningContent = apiReasoning || thinkResult.reasoning;
      // Cache reasoning for next turn via conversation-scoped cross-request cache
      if (reasoningContent) {
        const virtualMsg = rawCalls.length
          ? { tool_calls: rawCalls.map(tc => ({ id: tc.id || callId(), type: tc.type || "function", function: { name: tc.function.name, arguments: tc.function.arguments } })) }
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
        id: tc.id || callId(),
        type: tc.type || "function",
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
          if (_displayReasoning) {
              const foldedContent = _foldReasoningIntoContent(reasoningContent, "");
              tcMsg.content = embedReasoning(foldedContent, reasoningContent);
            } else {
              tcMsg.reasoning_content = reasoningContent;
              tcMsg.content = embedReasoning(tcMsg.content || "", reasoningContent);
            }
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
      log(t("tokenNoDataReason", "api/chat error"));
      err(t("apiError") + ": " + e.message);
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
      log(t("tokenNoDataReason", "api/generate error"));
      err(t("apiError") + ": " + e.message);
      await s.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), response: `Error: ${e.message}`, done: true }) + "\n");
    }
  });
});

// ── Manual session stop ──
app.post("/api/session/stop", async c => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId = body.sessionId || body.session_id || body.id;
  if (!sessionId) return c.json({ ok: false, error: "sessionId is required" }, 400);
  const stopped = stopSession(String(sessionId));
  if (stopped) {
    log(t("serviceStopping"));
    return c.json({ ok: true, sessionId: String(sessionId), status: "stopped" });
  }
  return c.json({ ok: false, sessionId: String(sessionId), status: "not_found" }, 404);
});

// ── Stop server ──

app.get("/stop", c => {
  log(t("serviceStopping"));
  keepaliveShutdown();
  setTimeout(() => process.exit(0), 100);
  return c.json({ status: "shutting down" });
});

// ── Catch-all for unknown routes — log to discover unmapped Copilot endpoints ──

app.all("*", c => {
  const url = new URL(c.req.url);
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
    log(t("portInUse", port, port + 1));
    port++;
  }

  if (_isServiceMode) {
    try { process.stderr.write("[snet] entering service mode\r\n"); } catch {}
    try {
      await runAsService({
        onStart: _runServer,
        onStop: () => {
          log(t("serviceStopping"));
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
  serverRef = http.createServer({ noDelay: true, maxHeaderSize: 16384 }, (req, res) => {
    let raw = "";
    let _bodyTooLarge = false;
    const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
    req.on("data", chunk => {
      if (_bodyTooLarge) return;
      raw += chunk;
      if (raw.length > MAX_REQUEST_BODY_BYTES) {
        _bodyTooLarge = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Request too large", type: "invalid_request_error", code: "request_too_large" } }));
      }
    });
    req.on("end", () => {
      if (_bodyTooLarge) return;
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
  serverRef.keepAliveTimeout = 120000;
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
  // M11: Use async import instead of require("fs") (CJS-in-ESM anti-pattern)
  const fs = await import("node:fs");
  const raw = fs.readFileSync(VERSION_FILE, "utf8").trim();
  const ts = Number(raw);
  if (ts > 0) _buildDate = new Date(ts).toISOString().slice(0, 10);
} catch (e) { /* intentionally ignored */ }

let _bannerLines = [];
const P = (s) => { _bannerLines.push(s); };

P(W + "┌" + hr + W + "┐" + R);                                            // ┌───┐
P(line("[ Shunnet.top ] Copilot Proxy" + R));
const portLabel = port === 11434 ? `port: ${port} (default)` : `port: ${port}`;
P(line(S + portLabel + "  |  built " + C + _buildDate + R + S + "  |  models.dev" + R));

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

	if (hasDS) {
	  
	  P(line(S + "Name".padEnd(38) + " │ " + "ID".padEnd(22) + " │ " + "Context".padEnd(7) + R));
	  printSimple(dsModels, "DeepSeek");
	}

	if (hasMiMo) {
	  
	  P(line(S + "Name".padEnd(38) + " │ " + "ID".padEnd(22) + " │ " + "Context".padEnd(7) + R));
	  printSimple(mimoModels, "MiMo");
	}

P(W + "\u2514" + hr + W + "\u2518" + R);                                            // └───┘

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
      log(t("serviceStopping"));
      if (serverRef?.stop) serverRef.stop(true);
      else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => process.exit(0)); }
      setTimeout(() => process.exit(0), 2000);
    } else if (cmd === "restart") {
      disableDashboard();
      log(t("serviceRestarting"));
      if (serverRef?.stop) { serverRef.stop(true); restartSelf(); }
      else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf()); }
      else { restartSelf(); }
      setTimeout(() => process.exit(42), 5000);
    } else if (cmd === "update") {
      disableDashboard();
      log(t("serviceUpdating"));
      if (serverRef?.stop) { serverRef.stop(true); restartSelf(43); }
      else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf(43)); }
      else { restartSelf(43); }
      setTimeout(() => process.exit(43), 5000);
    } else if (cmd === "debug") {
      process.env.DEBUG = _isDebug() ? "" : "1";
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
  } catch (e) { /* intentionally ignored */ }
  if (process.stdin.isTTY && typeof process.stdin.on === "function") {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (data) => {
      const cmd = data.trim().toLowerCase();
      if (cmd === "stop" || cmd === "s" || cmd === "exit" || cmd === "e" || cmd === "quit" || cmd === "q") {
        log(t("serviceStopping"));
        if (serverRef?.stop) serverRef.stop(true);
        else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => process.exit(0)); }
        setTimeout(() => process.exit(0), 2000);
      } else if (cmd === "restart" || cmd === "r") {
        log(t("serviceRestarting"));
        if (serverRef?.stop) { serverRef.stop(true); restartSelf(); }
        else if (serverRef?.close) { serverRef.closeAllConnections?.(); serverRef.close(() => restartSelf()); }
        else { restartSelf(); }
        setTimeout(() => process.exit(42), 5000);
      } else if (canUpdate && (cmd === "update" || cmd === "u")) {
        log(t("serviceUpdating"));
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
    const args = process.argv.slice(1);


    if (typeof Bun !== 'undefined') {
      Bun.spawn(["cmd", "/c", "start", "/D", wd, "cmd", "/c", exe, ...args], {
        stdout: "ignore", stderr: "ignore", stdin: "ignore",
      }).unref();
    } else {
      const { spawn } = await import("node:child_process");
      spawn("cmd", ["/c", "start", "/D", wd, "cmd", "/c", exe, ...args], {
        detached: true, stdio: "ignore", windowsHide: true,
      }).unref();
    }
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    err(t("serviceRestarting") + " failed: " + e.message);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.exit(exitCode);
}

// ── OS signal handling (copilot-proxy pattern) ──
let _shuttingDown = false;
let _shutdownTimer = null;
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log(t("gracefulShutdown", signal));
  _recentlyCompleted.clear();
  keepaliveShutdown();

  // Single graceful timer — 10s max, force exit if hung
  _shutdownTimer = setTimeout(() => { err(t("shutdownTimeout")); process.exit(1); }, 10000);

  const done = () => {
    if (_shutdownTimer) { clearTimeout(_shutdownTimer); _shutdownTimer = null; }
    process.exit(0);
  };

  if (serverRef?.stop) {
    serverRef.stop(true);
    setTimeout(done, 2000);
  } else if (serverRef?.close) {
    serverRef.closeAllConnections?.();
    serverRef.close(() => done());
  } else {
    done();
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

}
