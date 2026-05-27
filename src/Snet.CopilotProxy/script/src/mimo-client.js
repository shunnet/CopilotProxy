import "./polyfill.js";

// 小米 MiMo API 基础地址（OpenAI 兼容）
const MIMO_BASE_URL = (typeof Bun !== "undefined" ? Bun.env.MIMO_BASE_URL : process.env.MIMO_BASE_URL) || "https://api.xiaomimimo.com/v1";

// 检查是否已配置 MiMo API Key
export function isMiMoAvailable() {
  const key = Bun.env.MIMO_API_KEY;
  return !!(key && key.trim());
}

// 获取 MiMo API Key
export function getMiMoApiKey() {
  return Bun.env.MIMO_API_KEY || "";
}

// 构建认证头（MiMo 支持两种方式）
function _authHeaders() {
  const key = getMiMoApiKey();
  return {
    Authorization: `Bearer ${key}`,
    "api-key": key,
  };
}

// 缓存的模型列表
let _cachedModels = null;

// 模型上下文长度映射（MiMo API /models 可能不返回 context 字段，手动维护兜底）
const MIMO_CONTEXT_MAP = {
  "mimo-v2.5": 1048576,
  "mimo-v2.5-pro": 1048576,
  "mimo-v2.5-tts": 262144,
  "mimo-v2.5-tts-voiceclone": 262144,
  "mimo-v2.5-tts-voicedesign": 262144,
};

// 从 MiMo API 获取可用模型列表
export async function getMiMoModels() {
  if (_cachedModels !== null) return _cachedModels;
  if (!isMiMoAvailable()) { _cachedModels = []; return []; }

  try {
    const resp = await fetch(`${MIMO_BASE_URL}/models`, {
      headers: _authHeaders(),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`[mimo] /models 请求失败 ${resp.status}: ${body.slice(0, 200)}`);
      _cachedModels = [];
      return [];
    }

    const json = await resp.json();
    const rawData = json.data || [];

    // 不做过滤——返回所有可用模型
    _cachedModels = rawData.map(m => {
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
    console.error(`[mimo] /models 请求异常: ${e.message}`);
    _cachedModels = [];
    return [];
  }
}

// 清除模型缓存（用于刷新）
export function clearMiMoCache() {
  _cachedModels = null;
}
