// ── Concurrency Queue & Retry System ──
// Enriched from https://github.com/punal100/antigravity-copilot
//
// Semaphore-based concurrency limiter with separate queues for
// thinking vs standard models. Retry with exponential backoff
// matching Antigravity IDE's aggressive retry approach.

import "./polyfill.js";
import { t } from "./i18n.js";
import { log as modLog } from "./logger.js";
const log = (msg) => modLog(`[queue] ${msg}`);

// ── Config helpers ──
function getConfig() {
  return {
    thinkingConcurrency: Math.max(1, parseInt(Bun.env.CONCURRENCY_THINKING || "1", 10)),
    standardConcurrency: Math.max(1, parseInt(Bun.env.CONCURRENCY_STANDARD || "3", 10)),
    maxRetries: Math.max(0, parseInt(Bun.env.RETRY_MAX || "3", 10)),
    retryBaseDelayMs: Math.max(50, parseInt(Bun.env.RETRY_BASE_DELAY_MS || "100", 10)),
    thinkingTimeoutMs: Math.max(10000, parseInt(Bun.env.THINKING_TIMEOUT_MS || "120000", 10)),
    requestTimeoutMs: Math.max(10000, parseInt(Bun.env.REQUEST_TIMEOUT_MS || "120000", 10)),
    maxRequestBodyBytes: Math.max(262144, parseInt(Bun.env.MAX_REQUEST_BODY_BYTES || "67108864", 10)),
    truncateToolOutput: Bun.env.TRUNCATE_TOOL_OUTPUT !== "false",
    maxToolOutputChars: Math.max(1000, parseInt(Bun.env.MAX_TOOL_OUTPUT_CHARS || "12000", 10)),
    toolOutputHeadChars: Math.max(0, parseInt(Bun.env.TOOL_OUTPUT_HEAD_CHARS || "6000", 10)),
    toolOutputTailChars: Math.max(0, parseInt(Bun.env.TOOL_OUTPUT_TAIL_CHARS || "2000", 10)),
  };
}

// ── ConcurrencyQueue ──

export class ConcurrencyQueue {
  constructor(maxConcurrency = 2, name = "default") {
    this.maxConcurrency = maxConcurrency;
    this.name = name;
    this.running = 0;
    this.queue = [];
    this._totalQueued = 0;
    this._totalProcessed = 0;
  }

  getStats() {
    return {
      name: this.name,
      running: this.running,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      totalQueued: this._totalQueued,
      totalProcessed: this._totalProcessed,
    };
  }

  setMaxConcurrency(max) {
    this.maxConcurrency = Math.max(1, max);
    this._releaseNext();
  }

  async run(fn, priority = 0) {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  async acquire(priority = 0) {
    this._totalQueued++;
    if (this.running >= this.maxConcurrency) {
      // H3: Add configurable timeout to prevent indefinite deadlock
      const cfg = getConfig();
      const timeoutMs = Math.max(30000, cfg.requestTimeoutMs || 120000);
      let timer = null;
      await new Promise((resolve, reject) => {
        const item = { resolve, reject, priority };
        let inserted = false;
        let settled = false; // prevent double-settle from timeout + release
        for (let i = 0; i < this.queue.length; i++) {
          if (priority > this.queue[i].priority) {
            this.queue.splice(i, 0, item);
            inserted = true;
            break;
          }
        }
        if (!inserted) this.queue.push(item);
        // Wrap resolve/reject to track settlement
        const origResolve = item.resolve;
        const origReject = item.reject;
        item.resolve = () => { if (!settled) { settled = true; origResolve(); } };
        item.reject = (err) => { if (!settled) { settled = true; origReject(err); } };
        // Timeout guard: reject if queued too long
        timer = setTimeout(() => {
          const idx = this.queue.indexOf(item);
          if (idx >= 0) { this.queue.splice(idx, 1); item.reject(new Error("Queue acquire timeout")); }
        }, timeoutMs);
      }).finally(() => { if (timer) clearTimeout(timer); });
    }
    this.running++;
  }

  release() {
    this.running--;
    this._totalProcessed++;
    this._releaseNext();
  }

  // H1: Use 'if' not 'while' — each release() vacates exactly one slot.
  // 'while' causes concurrency limit violation because running++ happens
  // in the microtask after resolve(), not synchronously.
  _releaseNext() {
    if (this.running < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next.resolve();
    }
  }

  // H2: Reject all queued items instead of resolving — resolving creates
  // a stampede that bypasses the concurrency limit entirely.
  clearQueue() {
    const err = new Error("Queue cleared");
    err.name = "QueueClearedError";
    for (const item of this.queue) item.reject(err);
    this.queue = [];
  }
}

// ── Retry with Exponential Backoff ──

export class RateLimitError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "RateLimitError";
    this.status = status;
    this.body = body;
  }
}

export async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 30000,
    jitterFactor = 0.3,
    onRetry,
  } = options;

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!_shouldRetry(err) || attempt >= maxRetries) {
        throw err;
      }

      attempt++;
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = (1 - jitterFactor / 2 + Math.random() * jitterFactor);
      const delay = Math.min(Math.floor(exponentialDelay * jitter), maxDelayMs);

      if (onRetry) onRetry(attempt, delay, err);

      log(t("retryAttempt", attempt, maxRetries, delay, err.message?.slice(0, 80) ?? "unknown"));
      await _sleep(delay);
    }
  }
}

function _shouldRetry(err) {
  // zenRequest handles its own 429 retries — don't double-retry
  if (err?._retriesExhausted) return false;
  // M12: RateLimitError with status 429 should not retry (already handled by upstream)
  if (err instanceof RateLimitError && err.status === 429) return false;
  const status = err?.response?.status ?? err?.status ?? err?.statusCode;
  if (status === 429) return false;
  const msg = err?.message?.toLowerCase() || "";
  if (/429|rate limit|too many requests|quota exceeded|resource_exhausted/i.test(msg)) return false;
  // Retry on server errors (502/503/504) and network errors
  if (status >= 500 && status < 600) return true;
  if (err instanceof Error && /econnrefused|econnreset|enotfound|etimedout|socket|network/i.test(msg)) return true;
  return false;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── ModelConcurrencyManager ──

let _instance = null;

export class ModelConcurrencyManager {
  constructor() {
    if (_instance) return _instance;
    const cfg = getConfig();
    this.thinkingQueue = new ConcurrencyQueue(cfg.thinkingConcurrency, "thinking");
    this.standardQueue = new ConcurrencyQueue(cfg.standardConcurrency, "standard");
    _instance = this;
  }

  static getInstance() {
    if (!_instance) new ModelConcurrencyManager();
    return _instance;
  }

  async runRequest(modelName, fn, enableRetry = true) {
    const isThinking = this._isThinkingModel(modelName);
    const queue = isThinking ? this.thinkingQueue : this.standardQueue;
    const cfg = getConfig();

    const executeWithRetry = async () => {
      if (!enableRetry || cfg.maxRetries <= 0) return fn();

      return retryWithBackoff(fn, {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.retryBaseDelayMs,
        onRetry: (attempt, delayMs, err) => {
          log(t("retryAttempt", attempt, cfg.maxRetries, delayMs, modelName || "?"));
        },
      });
    };

    const priority = isThinking ? 0 : 1;
    return queue.run(executeWithRetry, priority);
  }

  async acquireModel(modelName) {
    const isThinking = this._isThinkingModel(modelName);
    const queue = isThinking ? this.thinkingQueue : this.standardQueue;
    const priority = isThinking ? 0 : 1;
    await queue.acquire(priority);
  }

  releaseModel(modelName) {
    const isThinking = this._isThinkingModel(modelName);
    const queue = isThinking ? this.thinkingQueue : this.standardQueue;
    if (queue.running <= 0) return; // underflow guard — prevents negative concurrency
    queue.release();
  }

  _isThinkingModel(modelName) {
    if (!modelName) return false;
    return /thinking|reasoning|deep.?seek.*r1|o1|o3/i.test(modelName);
  }

  updateFromConfig() {
    const cfg = getConfig();
    this.thinkingQueue.setMaxConcurrency(cfg.thinkingConcurrency);
    this.standardQueue.setMaxConcurrency(cfg.standardConcurrency);
  }

  getStats() {
    return {
      thinking: this.thinkingQueue.getStats(),
      standard: this.standardQueue.getStats(),
    };
  }

  getTimeoutMs(modelName) {
    const cfg = getConfig();
    return this._isThinkingModel(modelName) ? cfg.thinkingTimeoutMs : cfg.requestTimeoutMs;
  }

  clearQueues() {
    this.thinkingQueue.clearQueue();
    this.standardQueue.clearQueue();
  }
}

// ── Tool Output Truncation ──

export function truncateToolMessagesInPayload(payload, opts = {}) {
  const cfg = getConfig();

  const maxChars = opts.maxChars ?? cfg.maxToolOutputChars;
  let headChars = opts.headChars ?? cfg.toolOutputHeadChars;
  let tailChars = opts.tailChars ?? cfg.toolOutputTailChars;

  if (maxChars <= 0 || !cfg.truncateToolOutput) return { truncatedMessages: 0, originalTotalChars: 0, finalTotalChars: 0 };

  if (headChars + tailChars > maxChars) {
    headChars = Math.min(headChars, maxChars);
    tailChars = Math.max(0, maxChars - headChars);
  }

  let truncatedMessages = 0;
  let originalTotalChars = 0;
  let finalTotalChars = 0;

  const messages = payload?.messages;
  if (!Array.isArray(messages)) return { truncatedMessages, originalTotalChars, finalTotalChars };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "tool") continue;
    if (typeof msg.content !== "string") continue;

    const original = msg.content;
    originalTotalChars += original.length;

    if (original.length <= maxChars) {
      finalTotalChars += original.length;
      continue;
    }

    const head = original.slice(0, headChars);
    const tail = tailChars > 0 ? original.slice(-tailChars) : "";
    const omitted = original.length - head.length - tail.length;
    const marker = `\n\n...[tool output truncated: ${omitted} chars omitted]...\n\n`;
    const newContent = head + marker + tail;
    // Create new object instead of mutating msg in-place
    const idx = messages.indexOf(msg);
    messages[idx] = { ...msg, content: newContent };
    truncatedMessages++;
    finalTotalChars += newContent.length;
  }

  return { truncatedMessages, originalTotalChars, finalTotalChars };
}

// ── Request Body Size Check ──

export function checkRequestBodySize(bodyJson, maxBytes) {
  const cfg = getConfig();
  const limit = maxBytes ?? cfg.maxRequestBodyBytes;
  const bodyStr = JSON.stringify(bodyJson);
  const bytes = Buffer.byteLength(bodyStr, "utf8");
  if (bytes > limit) {
    return {
      exceeds: true,
      bytes,
      limit,
      message: `Request body (${bytes} bytes) exceeds proxy limit (${limit} bytes). Consider reducing tool output/context or enabling tool output truncation.`,
    };
  }
  return { exceeds: false, bytes, limit };
}

export { getConfig };
