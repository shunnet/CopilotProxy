import "./polyfill.js";
import { t } from "./i18n.js";

// 会话保活 — 定期 ping 活跃的上游会话，防止 KV 缓存在空闲时被驱逐
// （灵感来自 TaskSync 会话预热）。
//
// 设计：
//   - 每次真实请求完成后，保存压缩后的消息摘要（非完整消息）
//   - 在 KEEPALIVE_INTERVAL_MS 空闲后，发送最小编译 ping (max_tokens:1)
//     到上游 API，使用相同的对话前缀
//   - 在 KEEPALIVE_IDLE_TIMEOUT_MS 连续空闲后，输出日志并停止心跳
//   - 新的真实请求到来时重置空闲计时器

import { isDeepSeekModel, isMiMoModel } from "./snet-handle.js";
import { log } from "./logger.js";

const _env = (k, d) => (typeof Bun !== "undefined" ? Bun.env[k] : typeof process !== "undefined" ? process.env[k] : undefined) ?? d;
const KEEPALIVE_ENABLED = (_env("SESSION_KEEPALIVE_ENABLED", "true")) !== "false";
const KEEPALIVE_INTERVAL_MS = Math.max(30000, parseInt(_env("SESSION_KEEPALIVE_INTERVAL_MS", "60000"), 10));
const KEEPALIVE_IDLE_TIMEOUT_MS = Math.max(KEEPALIVE_INTERVAL_MS * 2, parseInt(_env("SESSION_KEEPALIVE_IDLE_TIMEOUT_MS", "1800000"), 10));

const _sessions = new Map();
let _totalPings = 0;


function getProvider(model) {
  if (isDeepSeekModel(model)) return "deepseek";
  if (isMiMoModel(model)) return "mimo";
  return "unknown";
}

// 从消息数组提取最小 ping 上下文（仅前几条 user 消息，去重）
function _pingMessages(messages) {
  if (!messages?.length) return [];
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
  if (entry._timer) return;

  entry._timer = setInterval(() => {
    try {
      const e = _sessions.get(sessionId);
      if (!e) { clearInterval(entry._timer); return; }

      const m = (e.model || "?").replace(/^(ds|mimo)\//, "").replace(/:latest$/, "");
      log(`\x1b[35m[${e.clientTag || "?"}]\x1b[0m > \x1b[90m[ session ]\x1b[0m ( \x1b[36m${sessionId}\x1b[0m ) \x1b[90m[ keepalive ]\x1b[0m → \x1b[0m${m}`);

      const idleMs = Date.now() - e.lastActivity;
      if (idleMs >= KEEPALIVE_IDLE_TIMEOUT_MS) {
        log(`\x1b[35m[${e.clientTag || "?"}]\x1b[0m > \x1b[90m[ session ]\x1b[0m ( \x1b[36m${sessionId}\x1b[0m ) \x1b[90m[ idle ]\x1b[0m → \x1b[0m${m} \x1b[90m(${Math.round(idleMs / 1000)}s, pings=${e.pingCount || 0})\x1b[0m`);
        clearInterval(entry._timer);
        _sessions.delete(sessionId);
        return;
      }

    } catch (ex) { log(`[keepalive] heartbeat error: ${ex.message}\r\n`); }
  }, KEEPALIVE_INTERVAL_MS);
}

export function trackSession(sessionId, model, messages, clientTag) {
  if (!KEEPALIVE_ENABLED) return;
  if (!sessionId || !model) return;
  if (!messages?.length) return;

  const provider = getProvider(model);
  const existing = _sessions.get(sessionId);
  const pingMsgs = _pingMessages(messages);

  _sessions.set(sessionId, {
    model,
    pingMsgs,
    clientTag,
    provider,
    lastActivity: Date.now(),
    _timer: existing?._timer || null,
    pingCount: existing?.pingCount || 0,
  });

  scheduleKeepalive(sessionId);
}

// 手动停止指定会话
export function stopSession(sessionId) {
  const entry = _sessions.get(sessionId);
  if (!entry) return false;
  if (entry._timer) clearInterval(entry._timer);
  _sessions.delete(sessionId);
  return true;
}

export function shutdown() {
  let count = 0;
  for (const [sessionId, entry] of _sessions) {
    if (entry._timer) clearInterval(entry._timer);
    count++;
  }
  _sessions.clear();
  if (count > 0) {
    log(`${t("keepaliveShutdown", count, _totalPings)}`);
  }
}

export function stats() {
  return {
    sessions: _sessions.size,
    enabled: KEEPALIVE_ENABLED,
    intervalMs: KEEPALIVE_INTERVAL_MS,
    idleTimeoutMs: KEEPALIVE_IDLE_TIMEOUT_MS,
    totalPings: _totalPings,
  };
}

