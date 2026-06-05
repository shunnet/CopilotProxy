// ── Reasoning Cache ──
// Multi-tier cross-request reasoning content cache.
// Keyed by conversation ID + model + workspace for session isolation.
// Extracted from server.js.

import { log, debug } from "./logger.js";
import "./polyfill.js";

// Reasoning content cache — bridges across requests within same session
export const _crossReqReasoningCache = new Map();
// Periodic TTL cleanup — prevents unbounded growth of stale cache entries
const _REASONING_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
setInterval(function() {
  const cutoff = Date.now() - _REASONING_CACHE_MAX_AGE_MS;
  let cleared = 0;
  for (let _i = 0, _keys = Array.from(_crossReqReasoningCache.keys()); _i < _keys.length; _i++) {
    const k = _keys[_i];
    const v = _crossReqReasoningCache.get(k);
    if (v && typeof v === "object" && v._ts && v._ts < cutoff) {
      _crossReqReasoningCache.delete(k);
      cleared++;
    }
  }
}, 10 * 60 * 1000).unref();

export const _reasoningCacheMaxEntries = 5000;

// ── Hash helpers ──
// 64-bit DJB2 variant for cache key generation only (NOT cryptographic).
// Collision analysis: with 64-bit output and max 5000 entries, collision
// probability is ~2.7×10⁻¹² (negligible). Keys are also prefixed by domain
// (c: = conversation, w: = workspace, g: = global) for defense-in-depth.
// If cache size ever exceeds 100K entries, upgrade to crypto.createHash("sha256").
function _hash64(data) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < data.length; i++) {
    const ch = data.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
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
  return _hash64(JSON.stringify(n));
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
  return _hash64(JSON.stringify(payload));
}

export function _assistantNeedsReasoning(msg, priorMessages) {
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

export function _startPrompt(messages) {
  const preAssistant = [];
  for (const m of messages) {
    const role = (m.role || "").toLowerCase().trim();
    if (role === "assistant" || role === "tool") break;
    if (role === "user") preAssistant.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  }
  return preAssistant.join("\n");
}

// ── Main context factory ──
export function createReasoningContext(messages, model, workspaceRoot, clientTag, provider, thinkingTag, deps = {}) {
  const { _sessionRegistry, _workspaceSessions } = deps;
  const conv = _convId(messages, model, workspaceRoot);
  const fifo = [];
  let cursor = 0;

  // ── Workspace continuity detection ──
  let effectiveWorkspace = workspaceRoot;
  if (!effectiveWorkspace && clientTag) {
    const family = clientTag.replace(/_.*$/, "");
    const registry = _sessionRegistry ? [..._sessionRegistry].reverse() : [];
    for (const [, entry] of registry) {
      const entryFamily = (entry.clientTag || "").replace(/_.*$/, "");
      if (entryFamily === family && entry.workspaceRoot) {
        effectiveWorkspace = entry.workspaceRoot;
        break;
      }
    }
  }
  const wsKey = effectiveWorkspace ? `${effectiveWorkspace}|${model}` : null;
  const wsPrev = wsKey && _workspaceSessions ? _workspaceSessions.get(wsKey) : null;
  const curStartPrompt = _startPrompt(messages);

  // ── Session entry: always auto-create, never return null ──
  let sessionEntry = _sessionRegistry?.get(conv);
  if (!sessionEntry) {
    sessionEntry = {
      id: (_sessionRegistry?.size || 0) + 1,
      clientTag,
      createdAt: new Date().toISOString(),
      workspaceRoot: effectiveWorkspace,
      lastRequestTime: 0,
      cacheHitStreak: 0,
      thinkFallbackStreak: 0,
      stopCount: 0,
    };
    if (_sessionRegistry) _sessionRegistry.set(conv, sessionEntry);
    const modelLabel = (model || "").startsWith(`${provider}/`) ? model : `${provider}/${model}`;
    log(`\x1b[36mnew session ${sessionEntry.id} \x1b[90m(\x1b[0m${clientTag}\x1b[90m, \x1b[0m${modelLabel}\x1b[90m, \x1b[0m${effectiveWorkspace || "?"}\x1b[90m)\x1b[0m`);
  }

  // Update workspace registry
  if (wsKey && _workspaceSessions) {
    _workspaceSessions.set(wsKey, { convId: conv, sessionId: sessionEntry.id, lastSeen: new Date().toISOString(), clientTag, startPrompt: curStartPrompt });
  }

  // Rapid-request loop detection
  const now = Date.now();
  const rapidGap = now - (sessionEntry.lastRequestTime || 0);
  sessionEntry.lastRequestTime = now;
  const isRapid = rapidGap > 0 && rapidGap < 1500;

  const prefixedConv = (key) => `c:${conv}:${key}`;
  const prefixedWs = wsKey ? (key) => `w:${wsKey}:${key}` : null;

  const tagPrefix = `\x1b[35m${clientTag}\x1b[0m`;
  const sessionPrefix = `${tagPrefix}[\x1b[36m${sessionEntry.id}\x1b[0m]`;

  function seslog(msg) {
    log(`${sessionPrefix} ${msg}`);
  }

  return {
    conv,
    sessionEntry,
    isNew: !_sessionRegistry || !_sessionRegistry.get(conv) ? true : false,
    sessionPrefix,
    seslog,
    workspaceContinuity: wsPrev && wsPrev.convId !== conv && wsPrev.startPrompt === curStartPrompt
      ? { previousSessionId: wsPrev.sessionId, workspaceRoot: effectiveWorkspace }
      : null,
    wsKey,
    effectiveWorkspace,
    curStartPrompt: _startPrompt(messages),
    isContinuation: wsPrev && wsPrev.convId !== conv && wsPrev.startPrompt === _startPrompt(messages),
    reset() { cursor = 0; },
    cache(msg, mdl, reasoning) {
      if (!reasoning) return;
      fifo.push(reasoning);
      if (fifo.length > 50) fifo.shift();
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
      const h = _msgHash(msg);
      if (h) {
        _crossReqReasoningCache.set(prefixedConv(h), reasoning);
        if (prefixedWs) _crossReqReasoningCache.set(prefixedWs(h), reasoning);
        _crossReqReasoningCache.set(`g:${mdl}:${h}`, reasoning);
      }
      _crossReqReasoningCache.set(prefixedConv(`mdl:${mdl}`), reasoning);
      _crossReqReasoningCache.set(`g:${mdl}:last`, reasoning);
      // LRU eviction
      if (_crossReqReasoningCache.size > _reasoningCacheMaxEntries) {
        const toDelete = _crossReqReasoningCache.size - _reasoningCacheMaxEntries;
        const permanent = new Set();
        for (const k of _crossReqReasoningCache.keys()) {
          if (k.startsWith("g:") && k.endsWith(":last")) permanent.add(k);
          if (k.includes(":mdl:")) permanent.add(k);
        }
        let deleted = 0;
        for (const k of _crossReqReasoningCache.keys()) {
          if (deleted >= toDelete) break;
          if (permanent.has(k)) continue;
          _crossReqReasoningCache.delete(k);
          deleted++;
        }
      }
    },
    get(msg, mdl) {
      const sig = _messageSignature(msg);
      if (sig) {
        if (_crossReqReasoningCache.has(prefixedConv(`sig:${sig}`))) { const cached = _crossReqReasoningCache.get(prefixedConv(`sig:${sig}`)); return cached; }
        if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(`sig:${sig}`))) return _crossReqReasoningCache.get(prefixedWs(`sig:${sig}`));
        if (_crossReqReasoningCache.has(`g:${mdl}:sig:${sig}`)) return _crossReqReasoningCache.get(`g:${mdl}:sig:${sig}`);
      }
      const ids = _toolCallIds(msg);
      for (const id of ids) {
        if (_crossReqReasoningCache.has(prefixedConv(`tc:${id}`))) { const cached = _crossReqReasoningCache.get(prefixedConv(`tc:${id}`)); return cached; }
        if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(`tc:${id}`))) return _crossReqReasoningCache.get(prefixedWs(`tc:${id}`));
      }
      const tcs = msg.tool_calls || [];
      for (const tc of tcs) {
        const tcsig = _toolCallSignature(tc);
        if (tcsig) {
          if (_crossReqReasoningCache.has(prefixedConv(`tcs:${tcsig}`))) { const cached = _crossReqReasoningCache.get(prefixedConv(`tcs:${tcsig}`)); return cached; }
          if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(`tcs:${tcsig}`))) return _crossReqReasoningCache.get(prefixedWs(`tcs:${tcsig}`));
        }
      }
      const names = _toolCallNames(msg);
      for (const name of names) {
        if (_crossReqReasoningCache.has(prefixedConv(`tn:${name}`))) { const cached = _crossReqReasoningCache.get(prefixedConv(`tn:${name}`)); return cached; }
        if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(`tn:${name}`))) return _crossReqReasoningCache.get(prefixedWs(`tn:${name}`));
      }
      const h = _msgHash(msg);
      if (h) {
        if (_crossReqReasoningCache.has(prefixedConv(h))) { const cached = _crossReqReasoningCache.get(prefixedConv(h)); return cached; }
        if (prefixedWs && _crossReqReasoningCache.has(prefixedWs(h))) return _crossReqReasoningCache.get(prefixedWs(h));
        if (_crossReqReasoningCache.has(`g:${mdl}:${h}`)) return _crossReqReasoningCache.get(`g:${mdl}:${h}`);
      }
      if (cursor < fifo.length) return fifo[cursor++];
      const perMdl = (_crossReqReasoningCache.get(prefixedConv(`mdl:${mdl}`)));
      if (perMdl) return perMdl;
      return _crossReqReasoningCache.get(`g:${mdl}:last`);
    },
    crossCacheSize() { return _crossReqReasoningCache.size; },
  };
}

// Clear session-scoped cache entries
export function clearConvReasoning(conv) {
  const convPrefix = `c:${conv}:`;
  let cleared = 0;
  for (const k of _crossReqReasoningCache.keys()) {
    if (k.startsWith(convPrefix)) { _crossReqReasoningCache.delete(k); cleared++; }
  }
  return cleared;
}
