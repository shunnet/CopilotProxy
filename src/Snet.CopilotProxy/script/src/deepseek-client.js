import "./polyfill.js";

// DeepSeek API base URL (configurable via DEEPSEEK_BASE_URL env var)
const DEEPSEEK_BASE_URL = (typeof Bun !== "undefined" ? Bun.env.DEEPSEEK_BASE_URL : process.env.DEEPSEEK_BASE_URL) || "https://api.deepseek.com";

function getDeepSeekDisplayName(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (id === "deepseek-v4-pro" || id === "deepseek-reasoner") return "DeepSeek V4 Pro";
  if (id === "deepseek-v4-flash" || id === "deepseek-chat") return "DeepSeek V4 Flash";
  return modelId;
}

// Check if DeepSeek API Key is configured
export function isDeepSeekAvailable() {
  const key = Bun.env.DEEPSEEK_API_KEY;
  return !!(key && key.trim());
}

// Get DeepSeek API Key
export function getDeepSeekApiKey() {
  return Bun.env.DEEPSEEK_API_KEY || "";
}

// Cached model list
let _cachedModels = null;

// Fetch available models from DeepSeek API
export async function getDeepSeekModels() {
  if (_cachedModels !== null) return _cachedModels;
  if (!isDeepSeekAvailable()) { _cachedModels = []; return []; }
  try {
    const resp = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${getDeepSeekApiKey()}` },
    });
    if (!resp.ok) { _cachedModels = []; return []; }
    const json = await resp.json();
    _cachedModels = (json.data || []).map(m => {
      const prefixed = `ds/${m.id}`;
      return {
        id: prefixed,
        name: getDeepSeekDisplayName(m.id) || m.name || m.id,
        family: prefixed,
        context_length: m.context || m.context_length || 1048576,
        tools: true,
        vision: false,
        _ds: true,
        _apiModel: m.id,
      };
    });
    return _cachedModels;
  } catch (e) {
    _cachedModels = [];
    return [];
  }
}

// Clear model cache (for refresh)
export function clearDeepSeekCache() {
  _cachedModels = null;
}
