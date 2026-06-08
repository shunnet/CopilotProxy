import "./polyfill.js";
import { error as logErr } from "./logger.js";

// 小米 MiMo API 基础地址（OpenAI 兼容）
const MIMO_BASE_URL = (typeof Bun !== "undefined" ? Bun.env.MIMO_BASE_URL : process.env.MIMO_BASE_URL) || "https://api.xiaomimimo.com/v1";

// 检查是否已配置 MiMo API Key
export function isMiMoAvailable() {
  const key = process.env.MIMO_API_KEY || Bun.env?.MIMO_API_KEY;
  return !!(key && key.trim());
}

// 获取 MiMo API Key
export function getMiMoApiKey() {
  return process.env.MIMO_API_KEY || Bun.env?.MIMO_API_KEY || "";
}

// 构建认证头（MiMo 支持两种方式）
function _authHeaders() {
  const key = getMiMoApiKey();
  return {
    Authorization: `Bearer ${key}`,
  };
}

// 缓存的模型列表
let _cachedModels = null;

// 模型上下文长度映射（MiMo API /models 可能不返回 context 字段，手动维护兜底）
const MIMO_CONTEXT_MAP = {
  "mimo-v2.5": 1048576,
  "mimo-v2.5-pro": 1048576,
};

// 从 MiMo API 获取可用模型列表
export async function getMiMoModels() {
  if (_cachedModels !== null) return _cachedModels;
  if (!isMiMoAvailable()) { _cachedModels = []; return []; }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try { timer.unref?.(); } catch {}
    const resp = await fetch(`${MIMO_BASE_URL}/models`, {
      headers: _authHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      logErr(`[mimo] /models 请求失败 ${resp.status}: ${body.slice(0, 200)}`);
      // Don't cache auth errors (401/403) — they may resolve when key is fixed.
      // Network errors and 5xx are also not cached; only cache on success.
      // Don't cache on error — leave empty so next call retries
      return [];
    }

    const json = await resp.json();
    const rawData = json.data || [];

    // 只保留 mimo-v2.5 和 mimo-v2.5-pro
    const ALLOWED_MODELS = new Set(["mimo-v2.5", "mimo-v2.5-pro"]);
    _cachedModels = rawData
      .filter(m => ALLOWED_MODELS.has(m.id))
      .map(m => {
      const prefixed = `mimo/${m.id}`;
      return {
        id: prefixed,
        name: m.name || m.id,
        family: prefixed,
        context_length: MIMO_CONTEXT_MAP[m.id] || MIMO_CONTEXT_MAP[m.id?.toLowerCase?.()] || m.context || m.context_length || 262144,
        tools: true,
        vision: true,
        _mimo: true,
        _apiModel: m.id,
      };
    });

    return _cachedModels;
  } catch (e) {
    logErr(`[mimo] /models 请求异常: ${e.message}`);
    // Don't cache errors — transient failures should not permanently block retry
    return [];
  }
}

// 清除模型缓存（用于刷新）
export function clearMiMoCache() {
  _cachedModels = null;
}
