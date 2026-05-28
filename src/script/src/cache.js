import "./polyfill.js";

// ── Prompt Response Cache — LRU + TTL ──
// Inspired by https://github.com/anomalyco/opencode/pull/25997

const cache = new Map();

let maxSize = parseInt(Bun.env.CACHE_MAX_SIZE ?? "64", 10);
let ttlMs = parseInt(Bun.env.CACHE_TTL_SEC ?? "300", 10) * 1000;
let enabled = Bun.env.CACHE_ENABLED !== "false";

// djb2 — fast string hash
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

// Normalize messages for stable cache key
function normMessages(msgs) {
  return msgs.map(m => {
    let content = "";
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map(p => p.text || p.content || "").join("\n");
    return `${m.role}:${content}`;
  }).join("\n").replace(/\s+/g, " ").trim();
}

export function cacheKey(req, sessionId) {
  const parts = [
    req.model,
    String(req.options?.temperature ?? 1),
    String(req.tools?.length ?? 0),
    sessionId || "",
    normMessages(req.messages || []),
  ];
  return hash(parts.join("|")).toString(36);
}

export function check(key) {
  if (!enabled) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  entry.lastAccessed = Date.now();
  entry.hits++;
  return entry;
}

export function store(key, value) {
  if (!enabled) return;
  if (cache.size >= maxSize) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [k, v] of cache) {
      if (v.lastAccessed < oldestTime) { oldestTime = v.lastAccessed; oldestKey = k; }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, {
    value,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    hits: 0,
  });
}

export function invalidate() {
  cache.clear();
}

export function stats() {
  return {
    entries: cache.size,
    maxSize,
    ttlSeconds: Math.round(ttlMs / 1000),
    enabled,
  };
}
