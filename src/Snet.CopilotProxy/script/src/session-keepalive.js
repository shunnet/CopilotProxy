import "./polyfill.js";
import { t } from "./i18n.js";

// 会话保活 — 定期 ping 活跃的上游会话，防止 KV 缓存在空闲时被驱逐
// （灵感来自 TaskSync 会话预热）。
//
// 设计：
//   - 每次真实请求完成后，保存压缩后的消息列表
//   - 在 KEEPALIVE_INTERVAL_MS 空闲后，发送最小编译 ping (max_tokens:1)
//     到上游 API，使用相同的对话前缀
//   - 在 KEEPALIVE_IDLE_TIMEOUT_MS 总空闲后，停止 ping 并清理
//   - 在 KEEPALIVE_MAX_LIFETIME_MS 后无条件停止
//     （上游 KV 缓存通常在约 24 小时后过期 — ping 已失效的缓存是浪费资源）
//   - 新的真实请求到来时重置空闲计时器

import { chatCompletion, isDeepSeekModel, isMiMoModel } from "./snet-handle.js";
import { log } from "./logger.js";

const KEEPALIVE_ENABLED = (Bun.env.SESSION_KEEPALIVE_ENABLED || "false") !== "false";
const KEEPALIVE_INTERVAL_MS = Math.max(30000, parseInt(Bun.env.SESSION_KEEPALIVE_INTERVAL_MS || "120000", 10)); // 2分钟，最少30秒
const KEEPALIVE_IDLE_TIMEOUT_MS = Math.max(KEEPALIVE_INTERVAL_MS * 2, parseInt(Bun.env.SESSION_KEEPALIVE_IDLE_TIMEOUT_MS || "600000", 10)); // 10分钟
const KEEPALIVE_MAX_LIFETIME_MS = Math.max(3600000, parseInt(Bun.env.SESSION_KEEPALIVE_MAX_LIFETIME_MS || "86400000", 10)); // 24小时，最少1小时

const _sessions = new Map();
let _totalPings = 0;

function getProvider(model) {
  if (isDeepSeekModel(model)) return "deepseek";
  if (isMiMoModel(model)) return "mimo";
  return "unknown";
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
    log(`\x1b[90m[保活] 会话 ${sessionId} 空闲 ${Math.round(idleMs / 1000)}秒 — 正在停止（已 ping ${entry.pingCount || 0} 次）\x1b[0m`);
    if (entry.timer) clearTimeout(entry.timer);
    _sessions.delete(sessionId);
    return;
  }

  const ageMs = Date.now() - (entry.createdAt || Date.now());
  if (ageMs >= KEEPALIVE_MAX_LIFETIME_MS) {
    log(`\x1b[90m[保活] 会话 ${sessionId} 生命周期 ${Math.round(ageMs / 3600000)}小时已超 — 正在重置上游缓存\x1b[0m`);
    entry.createdAt = Date.now();
    entry.pingCount = 0;
  }

  try {
    const gen = chatCompletion({
      model: entry.model,
      messages: entry.messages,
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
        log(`\x1b[90m[保活] 会话 ${sessionId} ping #${entry.pingCount} 成功 (${entry.provider}/${entry.model}，空闲 ${Math.round(idleMs / 1000)}秒)\x1b[0m`);
      }
    }
  } catch (e) {
    log(`\x1b[90m[保活] 会话 ${sessionId} ping 失败: ${e.message} — 正在清理\x1b[0m`);
    if (entry.timer) clearTimeout(entry.timer);
    _sessions.delete(sessionId);
    return;
  }

  if (_sessions.has(sessionId)) {
    scheduleKeepalive(sessionId);
  }
}

export function trackSession(sessionId, model, messages, clientTag) {
  if (!KEEPALIVE_ENABLED) return;
  if (!sessionId || !model) return;
  if (!messages?.length) return;

  const provider = getProvider(model);
  const existing = _sessions.get(sessionId);

  _sessions.set(sessionId, {
    model,
    messages: messages.slice(),
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
  for (const [sessionId, entry] of _sessions) {
    if (entry.timer) clearTimeout(entry.timer);
    count++;
  }
  _sessions.clear();
  if (count > 0) {
    log(`\x1b[90m[保活] 关闭 — 清理了 ${count} 个会话，共 ${_totalPings} 次 ping\x1b[0m`);
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
