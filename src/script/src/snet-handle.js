import "./polyfill.js";
import { t } from "./i18n.js";
import { ModelConcurrencyManager } from "./concurrency.js";
import { compressToolDefinitions } from "./token-optimizer.js";
import { normalizeToolType } from "./tool-schemas.js";
import { getDeepSeekModels, isDeepSeekAvailable, getDeepSeekApiKey, clearDeepSeekCache } from "./deepseek-client.js";
import { getMiMoModels, isMiMoAvailable, getMiMoApiKey, clearMiMoCache } from "./mimo-client.js";
import { log, error, reqLog, debug } from "./logger.js";

// ═══════════════════════════════════════════════════════════════
// DeepSeek / MiMo Copilot Compatibility Audit
// ═══════════════════════════════════════════════════════════════
//
// CRITICAL FIXES APPLIED:
//  1. Streaming finish_reason: The main streaming loop now captures
//     choice.finish_reason from the last delta chunk and emits it in the
//     final done:true yield. Previously hardcoded to "stop".
//  2. Streaming usage data: stream_options: { include_usage: true } is
//     set for both providers, but the usage chunk (empty choices[] + usage
//     field) was silently skipped by the !delta guard. Now captured in
//     streamUsage and emitted with done:true.
//  3. THINKING_TAG_PARAMS: MAXIMUM→"max", XHIGH→"xhigh", MAX→"max" are
//     invalid for DeepSeek API (only accepts low/medium/high). Clamped
//     to "high".
//  4. isMiMoModel: Added regex fallback /^mimo\//i (was modelMap-only).
//
// OPEN ISSUES:
//   A. MiMo thinking modes: getThinkingModes() only returns modes for
//      DeepSeek models. MiMo v2.5-pro supports thinking but gets no
//      thinking-mode tags in model listing.
//   B. Cross-provider reasoning cache: _lastReasoningContent and
//      _crossReqReasoningCache are shared across DeepSeek and MiMo. If
//      both providers are used in the same conversation, cached
//      reasoning_content from one provider may leak into requests for
//      the other.
//   C. No context window truncation beyond messagesPaging — VS sends
//      very long contexts (up to 1M tokens). The _compactContext()
//      deduplicates file reads and truncates tool results, but does not
//      enforce a hard context ceiling.
//   D. done_reason values from upstream (tool_calls, length) are now
//      passed through for streaming, but consumers may expect specific
//      casing/format.
//
// ═══════════════════════════════════════════════════════════════

// 根据模型能力清理消息中的 reasoning_content：
// - 推理模型：保留（API 要求后续轮次回传）
// - 非推理模型：移除（会导致 400 错误）
function _isReasoningModel(modelId) {
  if (!modelId) return false;
  // DeepSeek reasoning models
  if (/(?:reasoner|v4-pro|(?:^|[-/])r1(?:$|[-/]))/i.test(modelId)) return true;
  // MiMo: only v2.5 and v2.5-pro support thinking
  if (/mimo-v2\.5(?:-pro)?$/i.test(modelId)) return true;
  return false;
}

export function sanitizeMessagesForProvider(msgs, modelId) {
  if (!msgs?.length) return msgs;
  const isReasoning = _isReasoningModel(modelId);
  if (isReasoning) return msgs; // 推理模型保留 reasoning_content
  // 非推理模型：移除 reasoning_content 字段
  return msgs.map(m => {
    if (m.reasoning_content === undefined && m.reasoning === undefined) return m;
    const { reasoning_content, reasoning, ...rest } = m;
    return rest;
  });
}

// ── 分隔符 ──
let _globalAgent = null;

async function _getAgent() {
  if (_globalAgent) return _globalAgent;
  try {
    const undici = await import("undici");
    _globalAgent = new undici.Agent({
      connections: 50,
      keepAliveTimeout: 90_000,
      keepAliveMaxTimeout: 600_000,
      pipelining: 1,
      headersTimeout: 60_000,
      bodyTimeout: 120_000,
      connect: { keepAlive: true, keepAliveInitialDelay: 30_000 },
      tcpNoDelay: true,
    });
    return _globalAgent;
  } catch {
    return null;
  }
}

export async function fetchWithAgent(url, init = {}) {
  const agent = await _getAgent();
  if (agent) {
    try {
      return await fetch(url, { ...init, dispatcher: agent });
    } catch (e) {
      if (e.message === "fetch failed") {
        return fetch(url, init);
      }
      throw e;
    }
  }
  return fetch(url, init);
}

// ── 配置 ──
const SEP_DEEPSEEK = "(deepseek)";
const SEP_MIMO = "(mimo)";

function sepModel(id, label) {
  const now = new Date().toISOString().replace(/\s+/g, " ");
  return {
    name: label,
    model: `${id}:latest`,
    modified_at: now,
    size: 0, digest: id,
    details: { parent_model: "", format: "", family: "", families: null, parameter_size: "", quantization_level: "" },
    capabilities: {},
    supports_tools: false,
    supports_function_calling: false,
  };
}

export function isSeparator(id) {
  const clean = (id || "").split(":")[0].trim().toLowerCase();
  return clean === SEP_DEEPSEEK || clean === SEP_MIMO || clean === "== deepseek ==" || clean === "== mimo ==";
}

// ── 模型管理 ──
const config = {
  get baseUrlDeepSeek() { return Bun.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"; },
  get baseUrlMiMo() { return Bun.env.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1"; },
  get deepseekApiKey() { return Bun.env.DEEPSEEK_API_KEY || ""; },
  get mimoApiKey() { return Bun.env.MIMO_API_KEY || ""; },
  host: Bun.env.SERVER_HOST ?? "127.0.0.1",
  port: parseInt(Bun.env.SERVER_PORT ?? "11434", 10),
  defaultModel: Bun.env.DEFAULT_MODEL ?? "ds/deepseek-v4-pro",
  get defaultTemperature() {
    const t = parseFloat(Bun.env.DEFAULT_TEMPERATURE);
    return isNaN(t) ? null : t;
  },
  get requestLog() {
    const v = Bun.env.REQUEST_LOG;
    return v === undefined ? true : v === "true" || v === "1";
  },
  get compressionLevel() {
    return Bun.env.COMPRESSION_LEVEL ?? "caveman";
  },
  get forceAllCapabilities() {
    return (Bun.env.FORCE_ALL_CAPABILITIES ?? "true") !== "false";
  },
  get defaultContextLength() {
    return Number(Bun.env.DEFAULT_CONTEXT_LENGTH ?? "262144");
  },
  get maxRetries() {
    return Math.max(0, parseInt(Bun.env.RETRY_MAX || "3", 10));
  },
  get sessionKeepaliveEnabled() {
    const v = Bun.env.SESSION_KEEPALIVE_ENABLED;
    return v === undefined ? true : v === "true" || v === "1";
  },
  get sessionKeepaliveIntervalMs() {
    return Math.max(30000, parseInt(Bun.env.SESSION_KEEPALIVE_INTERVAL_MS || "60000", 10));
  },
  get sessionKeepaliveIdleTimeoutMs() {
    const interval = this.sessionKeepaliveIntervalMs;
    return Math.max(interval * 2, parseInt(Bun.env.SESSION_KEEPALIVE_IDLE_TIMEOUT_MS || "1800000", 10));
  },
  get sessionKeepaliveMaxLifetimeMs() {
    return Math.max(3600000, parseInt(Bun.env.SESSION_KEEPALIVE_MAX_LIFETIME_MS || "28800000", 10));
  },
  get messagesPaging() {
    const v = parseInt(Bun.env.MESSAGES_PAGING, 10);
    return isNaN(v) ? 0 : Math.max(0, v);
  },
};

// ── 模型列表 ──
let _models = null;
let _modelMap = {};
let _nameToId = {};
let _mdCache = null;
let _mdCachePromise = null;
let _diskCachePath = null;
let _fs = null;
let _crypto = null;

async function _loadFs() { if (!_fs) _fs = await import("node:fs"); return _fs; }
async function _loadCrypto() { if (!_crypto) _crypto = await import("node:crypto"); return _crypto; }

function cacheDir() {
  const base = Bun.env.OPENCODE_CACHE_DIR || (typeof process !== 'undefined' ? process.cwd() : ".");
  const dir = `${base}/.cache`;
  try { if (_fs) _fs.mkdirSync(dir, { recursive: true }); } catch (e) { debug(`[cache] mkdirSync failed: ${e.message?.slice(0, 80)}`); }
  return dir;
}

function getDiskPath() {
  if (_diskCachePath) return _diskCachePath;
  _diskCachePath = `${cacheDir()}/models.json`;
  return _diskCachePath;
}

function keyHash() {
  const keys = [Bun.env.DEEPSEEK_API_KEY, Bun.env.MIMO_API_KEY].filter(Boolean);
  if (!keys.length) return "no-key";
  const combined = keys.sort().join("");
  if (_crypto) return _crypto.createHash("sha256").update(combined).digest("hex");
  let h = 0;
  for (let i = 0; i < combined.length; i++) { h = ((h << 5) - h + combined.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

function getKeyHashPath() { return `${cacheDir()}/keyhash.json`; }

function loadKeyHashFromDisk() {
  try { if (_fs) return JSON.parse(_fs.readFileSync(getKeyHashPath(), "utf8")).h || null; } catch (e) { debug(`[cache] keyHash read failed: ${e.message?.slice(0, 80)}`); }
  return null;
}

function saveKeyHashToDisk(h) {
  if (!_fs) return;
  try {
    const prev = loadKeyHashFromDisk();
    if (prev === h) return;
    _fs.writeFileSync(getKeyHashPath(), JSON.stringify({ h }));
  } catch (e) { debug(`[cache] op failed: ${e.message?.slice(0, 80)}`); }
}

let _lastKeyHash = null;
async function checkKeyChanged() {
  await _loadCrypto();
  const h = keyHash();
  if (!_lastKeyHash) _lastKeyHash = loadKeyHashFromDisk();
  if (_lastKeyHash !== null && _lastKeyHash !== h) {
    _lastKeyHash = h;
    saveKeyHashToDisk(h);
    return true;
  }
  _lastKeyHash = h;
  return false;
}

function loadModelsFromDisk() {
  try {
    if (!_fs || !_fs.existsSync(getDiskPath())) return false;
    const data = JSON.parse(_fs.readFileSync(getDiskPath(), "utf8"));
    if (data._models?.length) {
      const cachedHasDS = data._models.some(m => (m.model || "").replace(":latest", "").startsWith(SEP_DEEPSEEK));
      if (isDeepSeekAvailable() !== cachedHasDS) return false;
      const cachedHasMiMo = data._models.some(m => (m.model || "").replace(":latest", "").startsWith(SEP_MIMO));
      if (isMiMoAvailable() !== cachedHasMiMo) return false;
      _models = data._models;
      _modelMap = data._modelMap || {};
      _nameToId = data._nameToId || {};
      return true;
    }
  } catch (e) { debug(`[cache] op failed: ${e.message?.slice(0, 80)}`); }
  return false;
}

async function saveModelsToDisk() {
  try {
    await _loadFs(); await _loadCrypto();
    if (!_models?.length) return;
    _fs.writeFileSync(getDiskPath(), JSON.stringify({ _models, _modelMap, _nameToId }));
  } catch (e) { debug(`[cache] op failed: ${e.message?.slice(0, 80)}`); }
}

async function fetchModelsDev() {
  if (_mdCache) return _mdCache;
  if (!_mdCachePromise) _mdCachePromise = (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch("https://models.dev/api.json", { signal: ctrl.signal });
      clearTimeout(t);
      if (!resp.ok) { _mdCache = {}; return _mdCache; }
      _mdCache = await resp.json();
      return _mdCache;
    } catch { _mdCache = {}; return _mdCache; }
  })();
  return _mdCachePromise;
}

function fmtParamSize(val) {
  if (!val) return "";
  const s = String(val).trim();
  if (/[MBK]/.test(s.toUpperCase())) return s;
  const n = parseFloat(s);
  if (isNaN(n)) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return s;
}

function inferFamily(modelId) {
  const c = (modelId || "").replace(/\s+/g, " ");
  if (/\bdeepseek/i.test(c)) return "DeepSeek";
  if (/\bmimo/i.test(c)) return "MiMo";
  return c;
}

function inferParameterSize(modelId) { const m = (modelId || "").match(/(\d+(?:\.\d+)?)\s*([bBmMkK])/); return m ? fmtParamSize(m[1] + m[2].toUpperCase()) : ""; }
function inferQuantization(modelId) { const m = (modelId || "").match(/(Q\d+[_.]\w+|F\d+|BF\d+|INT\d+|IQ\d+[\w_]*)/i); return m ? m[0] : "F16"; }

async function fetchModels() {
  const start = Date.now();
  await fetchModelsDev();
  const now = new Date().toISOString().replace(/\s+/g, " ");
  const models = [];

  let dsCount = 0;
  if (isDeepSeekAvailable()) {
    const dsModels = await getDeepSeekModels();
    for (const m of dsModels) {
      models.push({
        name: m.name, model: `${m.id}:latest`, modified_at: now, size: 0, digest: m.id,
        maxParams: m.context_length || 0,
        details: { parent_model: "", format: "gguf", family: m.family, families: [m.family], parameter_size: `${(m.context_length / 1000).toFixed(0)}K` || "", quantization_level: "F16", tools: true, vision: false, supports_tools: true, supports_function_calling: true, supports_vision: false },
        capabilities: { tools: true, vision: false, function_calling: true, tool_calling: true },
        supports_tools: true, supports_function_calling: true,
      });
      _modelMap[m.id.toLowerCase()] = { id: m.id, name: m.name, tools: true, vision: false, _ds: true, _apiModel: m._apiModel };
      _nameToId[m.name.toLowerCase()] = m.id;
      dsCount++;
    }
    if (dsCount) models.unshift(sepModel(SEP_DEEPSEEK, `DeepSeek (${dsCount})`));
  }

  let mimoCount = 0;
  if (isMiMoAvailable()) {
    const mimoModels = await getMiMoModels();
    for (const m of mimoModels) {
      models.push({
        name: m.name, model: `${m.id}:latest`, modified_at: now, size: 0, digest: m.id,
        maxParams: m.context_length || 0,
        details: { parent_model: "", format: "gguf", family: m.family, families: [m.family], parameter_size: `${(m.context_length / 1000).toFixed(0)}K` || "", quantization_level: "F16", tools: true, vision: false, supports_tools: true, supports_function_calling: true, supports_vision: false },
        capabilities: { tools: true, vision: false, function_calling: true, tool_calling: true },
        supports_tools: true, supports_function_calling: true,
      });
      _modelMap[m.id.toLowerCase()] = { id: m.id, name: m.name, tools: true, vision: false, _mimo: true, _apiModel: m._apiModel };
      _nameToId[m.name.toLowerCase()] = m.id;
      mimoCount++;
    }
    if (mimoCount) models.splice(models.length - mimoCount, 0, sepModel(SEP_MIMO, `MiMo (${mimoCount})`));
  }

  _models = models;
  const elapsed = Date.now() - start;
  log(`[model] Refreshed (${elapsed}ms)`);
  return _models;
}

let _fetchGate = Promise.resolve();

export async function initModels() {
  await _loadFs(); await _loadCrypto();
  await checkKeyChanged();
  if (loadModelsFromDisk()) {
    log("[model] Processing...");
  } else {
    log("[model] Processing...");
    await fetchModels();
    await saveModelsToDisk();
    saveKeyHashToDisk(keyHash());
  }
  _bgFetch = fetchModels().then(() => saveModelsToDisk()).catch(() => {});
  return _models;
}

let _bgFetch = null;
export function bgFetchDone() { return _bgFetch; }

export async function getModels() {
  if (_models) return [..._models];
  return fetchModels();
}

export async function refreshModels() {
  log("[model] Processing...");
  const start = Date.now();
  await checkKeyChanged();
  clearDeepSeekCache();
  clearMiMoCache();
  await fetchModels();
  await saveModelsToDisk();
  saveKeyHashToDisk(keyHash());
  log(`[model] Refreshed (${Date.now() - start}ms)`);
}

export function resolveModel(name) {
  const p = parseThinkingMode(name);
  const raw = p.model.replace(/\s+/g, " ");
  let clean = raw.split(":")[0].trim().toLowerCase().replace(/\s+/g, " ");
  const fullClean = raw.replace(/\s+/g, " ");
  if (isSeparator(clean)) return { id: clean, name: clean, tools: false, vision: false, separator: true };
  if (_modelMap[clean]) return _modelMap[clean];
  if (_nameToId[fullClean]) { const nmId = _nameToId[fullClean]; if (_modelMap[nmId.toLowerCase()]) return _modelMap[nmId.toLowerCase()]; }
  const nmId = _nameToId[clean];
  if (nmId && _modelMap[nmId.toLowerCase()]) return _modelMap[nmId.toLowerCase()];
  return { id: clean, name: clean, tools: true, vision: false, unverified: true };
}

export function isKnownModel(id) {
  if (!id) return false;
  const p = parseThinkingMode(id);
  const raw = p.model.replace(/\s+/g, " ");
  let clean = raw.split(":")[0].trim().toLowerCase().replace(/\s+/g, " ");
  const fullClean = raw.replace(/\s+/g, " ");
  if (isSeparator(clean)) return true;
  if (_modelMap[clean] || _nameToId[clean] || _nameToId[fullClean]) return true;
  return false;
}

export function isDeepSeekModel(id) {
  if (!id) return false;
  const clean = id.split(":")[0].trim().toLowerCase();
  const normalized = clean.replace(/^ds\//, "");
  return _modelMap[clean]?._ds === true || _modelMap[`ds/${normalized}`]?._ds === true || /^(deepseek-v4-|deepseek-|ds\/deepseek-)/i.test(clean);
}

export function isMiMoModel(id) {
  if (!id) return false;
  const clean = id.split(":")[0].trim().toLowerCase();
  return _modelMap[clean]?._mimo === true || /^mimo\//i.test(clean);
}

// ── 推理模式 ──
export function resolveModelMetadata(modelId) {
  const clean = (modelId || "").replace(/\s+/g, " ");
  const allModels = { ...((_mdCache && _mdCache["opencode-go"]?.models) || {}), ...((_mdCache && _mdCache["opencode"]?.models) || {}) };
  const mdModel = allModels[clean];
  return {
    context_length: mdModel?.limit?.context || (isDeepSeekModel(modelId) || isMiMoModel(modelId) ? 1048576 : config.defaultContextLength),
    capabilities: isMiMoModel(modelId) ? ["chat", "completion", "tools", "agent"] : ["chat", "completion", "tools", "agent"],
    family: mdModel?.name || inferFamily(clean),
    parameter_size: fmtParamSize(mdModel?.parameter_size || mdModel?.parameter_count || inferParameterSize(clean)) || "",
    quantization_level: inferQuantization(clean),
    size: 0, size_vram: 0,
  };
}

// ── 模型请求默认值 ──

// Thinking modes are resolved at runtime from the model metadata (models.dev API).
// This stub exists for API compatibility; actual mode detection happens in parseThinkingMode().
// TODO: Populate from mdCache when models.dev provides thinking_mode data per model.
export function getThinkingModes(modelId) {
  return [];
}

export function parseThinkingMode(modelName) {
  let clean = (modelName || "").replace(/\s+/g, " ");
  if (!clean) return { model: modelName, thinking: null };

  let m = clean.match(/^(.+?)\/(\d)_\(?(low|medium|high|maximum|xhigh)\)?$/i);
  if (m) return { model: `${m[1].trim()}:latest`, thinking: m[3].toUpperCase() === "MAXIMUM" ? "MAXIMUM" : m[3].toUpperCase() };

  m = clean.match(/^(.+?)\s+\[?(LOW|MEDIUM|HIGH|MAXIMUM|MED|MAX|XHIGH|MINIMAL|NONE|LO|MD|HI|MX|X)\]\s*$/i);
  if (m) {
    const SHORT = { LO: "LOW", MD: "MEDIUM", HI: "HIGH", MX: "MAXIMUM", X: "XHIGH", MED: "MEDIUM", MAX: "MAXIMUM" };
    return { model: `${m[1].trim()}:latest`, thinking: SHORT[m[2].toUpperCase()] || m[2].toUpperCase() };
  }
  return { model: modelName, thinking: null };
}

// NOTE: DeepSeek API only accepts "low", "medium", "high" for reasoning_effort.
// MAXIMUM/XHIGH are clamped to "high" (DeepSeek silently ignores unknown values).
const THINKING_TAG_PARAMS = {
  LOW: { reasoningEffort: "low" }, MEDIUM: { reasoningEffort: "medium" }, HIGH: { reasoningEffort: "high" },
  MAXIMUM: { reasoningEffort: "high" }, MED: { reasoningEffort: "medium" }, MAX: { reasoningEffort: "high" },
  XHIGH: { reasoningEffort: "high" }, MINIMAL: { reasoningEffort: "minimal" }, NONE: { reasoningEffort: "none" },
};

function applyThinkingMode(body, thinking, modelId) {
  if (!thinking) return;
  if (isDeepSeekModel(modelId)) {
    // DeepSeek: both reasoning_effort (snake_case) and thinking toggle required
    const p = THINKING_TAG_PARAMS[thinking];
    if (p) body.reasoning_effort = p.reasoningEffort;
    body.thinking = { type: "enabled" };
  } else if (isMiMoModel(modelId)) {
    // MiMo: thinking toggle only (no reasoning_effort)
    body.thinking = { type: "enabled" };
  }
  // Both DeepSeek and MiMo ignore temperature/top_p in thinking mode:
  // DeepSeek: "setting will not trigger an error but will have no effect"
  // MiMo: "forcibly overridden to 1.0"
  // Strip them to avoid misleading clients and reduce payload size
  delete body.temperature;
  delete body.top_p;
  delete body.presence_penalty;
  delete body.frequency_penalty;
}

const MODEL_REQUEST_DEFAULTS = [
  // DeepSeek: enable tool_stream (no unconditional max_tokens minimum)
  { pattern: /deepseek|deep-seek/i, overrides: {}, toolStream: true },
];

function _supportsToolStream(id) { return MODEL_REQUEST_DEFAULTS.some(d => d.pattern.test(id) && d.toolStream); }

function applyModelDefaults(modelId, body) {
  for (const def of MODEL_REQUEST_DEFAULTS) {
    if (def.pattern.test(modelId)) {
      for (const [k, v] of Object.entries(def.overrides)) {
        if (body[k] === undefined) body[k] = Array.isArray(v) ? [...v] : (typeof v === "object" && v !== null ? { ...v } : v);
      }
      // Reserved: set minMaxTokens in MODEL_REQUEST_DEFAULTS to enforce minimum output tokens
      if (def.minMaxTokens && (body.max_tokens == null || body.max_tokens < def.minMaxTokens)) body.max_tokens = def.minMaxTokens;
    }
  }
  if (body.tools?.length) {
    const meta = resolveModelMetadata(modelId);
    const minTokens = Math.min(Math.floor((meta.context_length || 131072) * 0.1), 32768);
    if (body.max_tokens == null || body.max_tokens < minTokens) body.max_tokens = minTokens;
  }
}

// ── 聊天补全 ──
export class APIError extends Error {
  constructor(status, body, message, retriesExhausted = false) {
    super(message || `API ${status}`);
    this.status = status; this.body = body; this.name = "APIError"; this._retriesExhausted = retriesExhausted;
  }
}

const ERROR_CODES = {
  400: "invalid_request", 401: "invalid_api_key", 402: "insufficient_quota",
  403: "permission_denied", 404: "not_found", 429: "rate_limit_exceeded",
  500: "server_error", 502: "bad_gateway", 503: "server_overloaded", 504: "gateway_timeout",
};

// ── 生成补全 ──
async function apiRequest(endpoint, body, opts = {}) {
  const isDS = isDeepSeekModel(body.model);
  const isMiMo = isMiMoModel(body.model);

  if (isSeparator(body.model)) throw new APIError(400, "", "This is a separator heading, not a model. Choose an actual model.");

  const base = isDS ? config.baseUrlDeepSeek : config.baseUrlMiMo;
  const url = `${base}${endpoint}`;

  const sendBody = { ...body };
  if (isDS) sendBody.model = body.model.replace(/^ds\//, "");
  if (isMiMo) sendBody.model = body.model.replace(/^mimo\//, "");

  const provider = isDS ? "deepseek" : "mimo";

  const headers = { "Content-Type": "application/json", "Accept-Encoding": "gzip, deflate, br" };

  if (isDS) {
    const key = getDeepSeekApiKey();
    if (key) headers["Authorization"] = `Bearer ${key}`;
    else throw new APIError(401, "", t("apiKeyNotConfig", "DeepSeek"));
  } else {
    const key = getMiMoApiKey();
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
      headers["api-key"] = key; // MiMo supports both auth methods
    }
    else throw new APIError(401, "", t("apiKeyNotConfig", "MiMo"));
  }

  const resp = await fetchWithAgent(url, { method: "POST", headers, body: JSON.stringify(sendBody), signal: opts?.signal });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    error(`[${provider}] ${resp.status}`);

    let upstreamMsg = t("apiError");
    let code = ERROR_CODES[resp.status] || "api_error";
    let mappedStatus = resp.status;
    try {
      const p = JSON.parse(txt);
      upstreamMsg = p.error?.message || p.error?.code || p.message || p.detail || upstreamMsg;
      if (p.error?.type === "AuthError") { code = "invalid_api_key"; mappedStatus = 401; }
      if (p.error?.type === "ModelError") { code = "model_not_found"; mappedStatus = 404; }
      if (p.error?.code) code = p.error.code;
    } catch (e) { debug(`[cache] op failed: ${e.message?.slice(0, 80)}`); }

    const retries = opts.retries || 0;
    const maxRetries = opts.maxRetries ?? config.maxRetries;

    if (upstreamMsg.includes("Service is too busy")) throw new APIError(mappedStatus, txt, upstreamMsg);

    if (resp.status === 429 && retries < maxRetries) {
      const delay = Math.min(5000 * Math.pow(2, retries), 60000);
      if (config.requestLog) log(`[model] 429 retry ${retries + 1}/${maxRetries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return apiRequest(endpoint, body, { ...opts, retries: retries + 1 });
    }

    if ((resp.status === 502 || resp.status === 503 || resp.status === 504) && retries < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, retries) + Math.random() * 1000, 30000);
      if (config.requestLog) log(`[model] ${resp.status} retry ${retries + 1}/${maxRetries} in ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
      return apiRequest(endpoint, body, { ...opts, retries: retries + 1 });
    }

    throw new APIError(mappedStatus, txt, upstreamMsg);
  }

  return resp;
}

// ── Context compaction ──
// Deduplicate repeated file reads (keep only last) + truncate oversized tool results.
// Based on DeepCopilot's autoCompactIfNeeded pattern — prevents token waste and
// keeps the model focused on current context.
const TOOL_TRUNCATE_THRESHOLD = 4000;  // chars
const TOOL_TRUNCATE_HEAD = 2000;
const TOOL_TRUNCATE_TAIL = 600;

function _compactContext(messages) {
  if (!messages?.length) return messages;
  // TODO: VS sends contexts up to 1M tokens. Add hard ceiling (e.g. 128K)/token-budget-based
  //       window truncation to prevent OOM on lower-end models. See Audit Issue C.

  // Step 1: deduplicate repeated file reads — keep only the LAST read of each file
  const fileReads = new Map(); // `${name}::${path}::${start}-${end}` → last index
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name || "";
      if (!/^(read_file|get_file)$/i.test(name)) continue;
      let args = {};
      let parseOk = true;
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { parseOk = false; }
      if (!parseOk) continue;
      const path = args.filePath || args.filename || args.path || "";
      const range = `${args.startLine || ""}-${args.endLine || ""}`;
      fileReads.set(`${name}::${path}::${range}`, i);
    }
  }

  let result = messages;
  if (fileReads.size > 0) {
    const lastIndices = new Set(fileReads.values());
    const toolResultIds = new Set();
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "assistant" || !m.tool_calls?.length) continue;
      for (const tc of m.tool_calls) {
        const name = tc.function?.name || "";
        if (!/^(read_file|get_file)$/i.test(name)) continue;
        let args = {};
        let parseOk = true;
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { parseOk = false; }
        if (!parseOk) continue;
        const path = args.filePath || args.filename || args.path || "";
        const range = `${args.startLine || ""}-${args.endLine || ""}`;
        const key = `${name}::${path}::${range}`;
        if (!lastIndices.has(i)) {
          // This is an older read — find and collapse its tool result
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role === "tool" && messages[j].tool_call_id === tc.id) {
              const content = typeof messages[j].content === "string" ? messages[j].content : "";
              if (content.length > 200) {
                result = result.map((rm, ri) => {
                  if (ri !== j) return rm;
                  return { ...rm, content: `<read_file path="${path}" read-collapsed="true" reason="re-read later in conversation; see the later tool result for current contents"/>` };
                });
              }
              break;
            }
          }
        }
      }
    }
  }

  // Step 2: truncate oversized tool results (head+tail strategy)
  result = result.map(m => {
    if (m.role !== "tool") return m;
    const content = typeof m.content === "string" ? m.content : "";
    if (content.length <= TOOL_TRUNCATE_THRESHOLD) return m;
    const head = content.slice(0, TOOL_TRUNCATE_HEAD);
    const tail = content.slice(-TOOL_TRUNCATE_TAIL);
    const omitted = content.length - TOOL_TRUNCATE_HEAD - TOOL_TRUNCATE_TAIL;
    return { ...m, content: `${head}\n...[${omitted} chars omitted]...\n${tail}` };
  });

  return result;
}


// ── Shared SSE streaming parser ──
async function* _parseSSEStream(reader, decoder, abortTimer) {
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) { clearTimeout(abortTimer); break; }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") { clearTimeout(abortTimer); return; }
      try { yield JSON.parse(data); } catch {}
    }
  }
}

// ── Shared SSE stream consumer (H6: extracted from duplicated streaming loops) ──
// Yields all delta chunks AND the final done:true chunk with usage/finish_reason.
// Callers simply do: for await (const c of _consumeSSEStream(...)) yield c;
async function* _consumeSSEStream(reader, decoder, abortTimer, model, created) {
  let streamUsage = null;
  let streamFinishReason = "stop";
  for await (const chunk of _parseSSEStream(reader, decoder, abortTimer)) {
    // Capture usage from final chunk (stream_options: include_usage)
    if (chunk.usage && (!chunk.choices || chunk.choices.length === 0 || !chunk.choices[0]?.delta)) {
      streamUsage = chunk.usage;
      continue;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (choice.finish_reason) streamFinishReason = choice.finish_reason;
    if (!delta) continue;
    const msg = { role: "assistant" };
    let hm = false;
    if (delta.content != null) { msg.content = delta.content; hm = true; }
    if (delta.tool_calls?.length) { msg.tool_calls = delta.tool_calls; hm = true; }
    if (delta.reasoning_content) { msg.reasoning_content = delta.reasoning_content; hm = true; }
    if (delta.reasoning) { msg.reasoning = delta.reasoning; hm = true; }
    if (hm) yield { model, created_at: created, message: msg, done: false };
  }
  // Yield final done:true chunk with accumulated usage and finish reason
  yield { model, created_at: created, message: { role: "assistant", content: "" }, done: true, done_reason: streamFinishReason, ...(streamUsage ? { usage: streamUsage } : {}) };
}

// ── 导出 ──
export async function* chatCompletion(req) {
  const thinkingTag = req._noThinking ? null : (req.thinkingTag !== undefined ? req.thinkingTag : parseThinkingMode(req.model).thinking);
  const p = parseThinkingMode(req.model);
  const model = p.model;
  const info = resolveModel(model);
  const created = new Date().toISOString();
  const isDS = isDeepSeekModel(info.id);
  const isMiMo = isMiMoModel(info.id);

  // Sanitize messages for the target provider (e.g. strip reasoning_content for non-reasoning models)
  let messages = sanitizeMessagesForProvider(req.messages, info.id);

  // Normalize VS custom type tool calls to standard function format
  messages = messages.map(m => {
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;
    const normalized = m.tool_calls.map(normalizeToolType);
    const changed = normalized.some((tc, i) => tc !== m.tool_calls[i]);
    return changed ? { ...m, tool_calls: normalized } : m;
  });

  // Context compaction: dedup re-reads + truncate oversized tool results
  messages = _compactContext(messages);

  // Inject system message if not present — sets coding agent behavior
  if (!messages.some(m => m.role === "system")) {
    const prov = isDS ? "DeepSeek" : "MiMo";
    const thinkNote = thinkingTag ? ` (${thinkingTag.toLowerCase()} reasoning)` : "";
    messages = [
      {
        role: "system",
        content: t("systemPrompt", prov, info.name || info.id, thinkNote),
      },
      ...messages,
    ];
  }

  const body = {
    model: info._apiModel || info.id?.replace(/^(ds|mimo)\//, ""),
    messages: messages.map(msg => {
      const out = { role: msg.role, content: msg.content };
      if (msg.tool_calls?.length) out.tool_calls = msg.tool_calls;
      if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
      // DeepSeek requires reasoning_content on EVERY assistant message in thinking mode,
      // even if empty string. Filtering out empty values breaks the chain.
      if (msg.reasoning_content !== undefined && thinkingTag) out.reasoning_content = msg.reasoning_content;
      if (msg.images?.length) {
        out.content = [{ type: "text", text: msg.content || "" }, ...msg.images.map(img => ({ type: "image_url", image_url: { url: `data:image/png;base64,${img}` } }))];
      }
      return out;
    }),
    stream: req.stream !== false,
  };

  if (req.tools?.length) body.tools = compressToolDefinitions(req.tools);
  if (req.options?.temperature != null) body.temperature = req.options.temperature;
  else if (config.defaultTemperature != null) body.temperature = config.defaultTemperature;
  if (req.options?.top_p != null) body.top_p = req.options.top_p;
  if (req.options?.seed != null) body.seed = req.options.seed;
  if (req.options?.num_predict != null && req.options.num_predict > 0) body.max_tokens = req.options.num_predict;
  if (req.options?.stop != null) body.stop = req.options.stop;
  if (req.chat_template_kwargs != null) body.chat_template_kwargs = req.chat_template_kwargs;
  if (req.thinking_token_budget != null) body.thinking_token_budget = req.thinking_token_budget;
  if (req.format === 'json') body.response_format = { type: 'json_object' };

  applyModelDefaults(info.id, body);
  if (isDS && thinkingTag && body.max_tokens < 1024 && !req._noDefaults) {
    body.max_tokens = 1024;
  }
  applyThinkingMode(body, thinkingTag, info.id);

  if (_supportsToolStream(info.id) && body.tools?.length && body.stream !== false) body.tool_stream = true;

  // DeepSeek: enable stream_options for token usage tracking and parallel tool calls
  if (isDS && body.stream !== false) {
    body.stream_options = { include_usage: true };
  }
  // FIXED: Enable stream_options for MiMo too (they support include_usage now)
  if (isMiMo && body.stream !== false) {
    body.stream_options = { include_usage: true };
  }
  if ((isDS || isMiMo) && body.tools?.length) {
    body.parallel_tool_calls = true;
  }

  // FIXED: Validate tool count against provider limits
  // NOTE: Static import at top of file to avoid dynamic import in Bun compiled binary
  if (body.tools?.length) {
    const MAX_TOOLS = 128; // both DeepSeek and MiMo support 128 tools
    if (body.tools.length > MAX_TOOLS) {
      throw new APIError(400, "", `Too many tools (${body.tools.length}). Provider supports a maximum of ${MAX_TOOLS} tools.`);
    }
  }

  let ac = null;
  let _abortTimer = null;
  if (!req._noTimeout) {
    const t = ModelConcurrencyManager.getInstance().getTimeoutMs(info.id);
    if (t > 0) { ac = new AbortController(); _abortTimer = setTimeout(() => { try { ac.abort(); } catch {} }, t); }
  }

  const lastMsg = body.messages?.[body.messages.length - 1];
  const preview = (typeof lastMsg?.content === "string" ? lastMsg.content : "").replace(/\s+/g, " ");
  const provider = isDeepSeekModel(info.id) ? "deepseek" : "mimo";

  try {
    const t0 = Date.now();
    const meta = resolveModelMetadata(info.id);
    const logDone = !req._noLog && config.requestLog ? reqLog({ tag: req.clientTag, sessionId: req.sessionId, provider, model, thinking: thinkingTag, preview, ctxLen: meta.context_length }) : null;
    const resp = await apiRequest("/chat/completions", body, { signal: ac?.signal, clientTag: req.clientTag });

    if (req.stream === false) {
      const data = await resp.json();
      const choice = data.choices[0];
      clearTimeout(_abortTimer);
      yield {
        model: req.model, created_at: created,
        message: { role: "assistant", content: choice.message.content, tool_calls: choice.message.tool_calls, reasoning_content: choice.message.reasoning_content },
        done: true, done_reason: choice.finish_reason ?? "stop", usage: data.usage,
      };
      logDone?.(Date.now() - t0, data.usage);
      return;
    }

    const reader = resp.body.getReader();
    const textDecoder = new TextDecoder();
    let _streamUsage = null;
    for await (const chunk of _consumeSSEStream(reader, textDecoder, _abortTimer, req.model, created)) {
      if (chunk.usage) _streamUsage = chunk.usage;
      yield chunk;
    }
    logDone?.(Date.now() - t0, _streamUsage);
  } catch (e) {
    if (_abortTimer) clearTimeout(_abortTimer);
    if (e instanceof APIError && e.status === 429) {
      yield { model: req.model, created_at: created, message: { role: "assistant", content: "Rate limit exceeded." }, done: true, done_reason: "stop" };
      return;
    }
    // reasoning_content retries are handled by server.js (last-resort stripping)
    if (e instanceof APIError) throw e;
    error(`[chat] ${e.message}`);
    yield { model: req.model, created_at: created, message: { role: "assistant", content: t("apiError") }, done: true, done_reason: "error" };
  }
}
export { config, SEP_DEEPSEEK, SEP_MIMO };
