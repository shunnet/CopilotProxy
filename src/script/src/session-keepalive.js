import "./polyfill.js";
import { t } from "./i18n.js";

// 会话保活 — 定期 ping 活跃的上游会话，防止 KV 缓存在空闲时被驱逐
// （灵感来自 TaskSync 会话预热）。
//
// 设计：
//   - 每次真实请求完成后，保存压缩后的消息摘要（非完整消息）
//   - 在 KEEPALIVE_INTERVAL_MS 空闲后，发送最小编译 ping (max_tokens:1)
//     到上游 API，使用相同的对话前缀
//   - 在 KEEPALIVE_IDLE_TIMEOUT_MS 总空闲后，停止 ping 并清理
//   - 在 KEEPALIVE_MAX_LIFETIME_MS 后无条件停止
//   - 定期清理孤立 session（防止内存泄漏）
//   - 新的真实请求到来时重置空闲计时器

import { chatCompletion, isDeepSeekModel, isMiMoModel } from "./snet-handle.js";
import { log } from "./logger.js";

const _env = (k, d) => (typeof Bun !== "undefined" ? Bun.env[k] : typeof process !== "undefined" ? process.env[k] : undefined) ?? d;
const KEEPALIVE_ENABLED = (_env("SESSION_KEEPALIVE_ENABLED", "true")) !== "false";
const KEEPALIVE_INTERVAL_MS = Math.max(30000, parseInt(_env("SESSION_KEEPALIVE_INTERVAL_MS", "60000"), 10));
const KEEPALIVE_IDLE_TIMEOUT_MS = Math.max(KEEPALIVE_INTERVAL_MS * 2, parseInt(_env("SESSION_KEEPALIVE_IDLE_TIMEOUT_MS", "300000"), 10));
const KEEPALIVE_MAX_LIFETIME_MS = Math.max(3600000, parseInt(_env("SESSION_KEEPALIVE_MAX_LIFETIME_MS", "86400000"), 10));
const _GR = ""; // keepalive log prefix
const _GRST = "";

const _sessions = new Map();
let _totalPings = 0;
if (KEEPALIVE_ENABLED) {
  log("[keepalive] ENABLED — interval:" + Math.round(KEEPALIVE_INTERVAL_MS/1000) + "s idle_timeout:" + Math.round(KEEPALIVE_IDLE_TIMEOUT_MS/1000) + "s max_lifetime:" + Math.round(KEEPALIVE_MAX_LIFETIME_MS/3600000) + "h");
}

function getProvider(model) {
  if (isDeepSeekModel(model)) return "deepseek";
  if (isMiMoModel(model)) return "mimo";
  return "unknown";
}

// 从消息数组提取最小 ping 上下文（仅前几条 user 消息，去重）
function _pingMessages(messages) {
  if (!messages?.length) return [];
  // 只取前 3 条 user/assistant 消息作为对话上下文
  const result = [];
  for (const m of messages) {
    if (result.length >= 4) break;
    if (m.role === "user" || m.role === "assistant") {
      const content = typeof m.content === "string" ? m.content : "";
      result.push({ role: m.role, content: content.slice(0, 500) });
    }
  }
  return result;
}

function scheduleKeepalive(sessionId) {
  const entry = _sessions.get(sessionId);
  if (!entry) return;

  if (entry.timer) clearTimeout(entry.timer);

  entry.timer = setTimeout(() => doKeepalive(sessionId), KEEPALIVE_INTERVAL_MS);
  entry.timer.unref?.();
}

async function doKeepalive(sessionId) {
  const entry = _sessions.get(sessionId);
  if (!entry) return;

  const idleMs = Date.now() - entry.lastActivity;
  if (idleMs >= KEEPALIVE_IDLE_TIMEOUT_MS) {
    log(`${_GR}${t("keepaliveIdle", sessionId, Math.round(idleMs / 1000), entry.pingCount || 0)}${_GRST}`);
    if (entry.timer) clearTimeout(entry.timer);
    _sessions.delete(sessionId);
    return;
  }

  const ageMs = Date.now() - (entry.createdAt || Date.now());
  if (ageMs >= KEEPALIVE_MAX_LIFETIME_MS) {
    log(`${_GR}${t("keepaliveLifetime", sessionId, Math.round(ageMs / 3600000))}${_GRST}`);
    entry.createdAt = Date.now();
    entry.pingCount = 0;
  }

  try {
    const gen = chatCompletion({
      model: entry.model,
      messages: entry.pingMsgs,
      stream: false,
      tools: undefined,
      options: { num_predict: 1 },
      _noTimeout: true,
      _noDefaults: true,
    });

    for await (const chunk of gen) {
      if (chunk.done && chunk.done_reason !== "error") {
        entry.pingCount = (entry.pingCount || 0) + 1;
        _totalPings++;
        log(`${_GR}${t("keepalivePingOk", sessionId, entry.pingCount, entry.provider, entry.model, Math.round(idleMs / 1000))}${_GRST}`);
      }
    }
  } catch (e) {
    log(`${_GR}${t("keepalivePingFail", sessionId, e.message)}${_GRST}`);
    if (entry.timer) clearTimeout(entry.timer);
    _sessions.delete(sessionId);
    return;
  }

  if (_sessions.has(sessionId)) {
    scheduleKeepalive(sessionId);
  }
}

// 定期清理孤立 session（防止 timer 失败导致内存泄漏）
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of _sessions) {
    const idleMs = now - entry.lastActivity;
    if (idleMs > KEEPALIVE_IDLE_TIMEOUT_MS * 2) {
      if (entry.timer) clearTimeout(entry.timer);
      _sessions.delete(sid);
      log(`${_GR}[keepalive] cleaned orphaned session ${sid} (idle ${Math.round(idleMs / 1000)}s)${_GRST}`);
    }
  }
}, 300_000); // 每 5 分钟检查一次
_cleanupTimer.unref?.();

export function trackSession(sessionId, model, messages, clientTag) {
  if (!KEEPALIVE_ENABLED) return;
  if (!sessionId || !model) return;
  if (!messages?.length) return;

  const provider = getProvider(model);
  const existing = _sessions.get(sessionId);
  const pingMsgs = _pingMessages(messages);

  _sessions.set(sessionId, {
    model,
    pingMsgs,           // 压缩后的 ping 消息（仅前几条）
    clientTag,
    provider,
    lastActivity: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
    timer: existing?.timer || null,
    pingCount: existing?.pingCount || 0,
  });

  scheduleKeepalive(sessionId);
}

export function touchSession(sessionId) {
  const entry = _sessions.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
    scheduleKeepalive(sessionId);
  }
}

export function stopSession(sessionId) {
  const entry = _sessions.get(sessionId);
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer);
    _sessions.delete(sessionId);
  }
}

export function shutdown() {
  let count = 0;
  clearInterval(_cleanupTimer);
  for (const [sessionId, entry] of _sessions) {
    if (entry.timer) clearTimeout(entry.timer);
    count++;
  }
  _sessions.clear();
  if (count > 0) {
    log(`${_GR}${t("keepaliveShutdown", count, _totalPings)}${_GRST}`);
  }
}

export function stats() {
  return {
    sessions: _sessions.size,
    enabled: KEEPALIVE_ENABLED,
    intervalMs: KEEPALIVE_INTERVAL_MS,
    idleTimeoutMs: KEEPALIVE_IDLE_TIMEOUT_MS,
    maxLifetimeMs: KEEPALIVE_MAX_LIFETIME_MS,
    totalPings: _totalPings,
  };
}

export { KEEPALIVE_ENABLED, KEEPALIVE_INTERVAL_MS, KEEPALIVE_IDLE_TIMEOUT_MS, KEEPALIVE_MAX_LIFETIME_MS };
