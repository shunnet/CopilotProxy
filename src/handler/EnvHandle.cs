using Snet.CopilotProxy.models;
using System.IO;

namespace Snet.CopilotProxy.handler;

/// <summary>
/// .env 配置文件读写处理器 — 负责将 EnvConfigModel 与 key=value 格式的 .env 文件之间转换
/// 支持布尔值、整数、字符串类型的解析与序列化
/// </summary>
public static class EnvHandle
{

    #region 加载配置

    /// <summary>
    /// 从 script/.env 文件反序列化为 EnvConfigModel 对象
    /// 始终读取 script/.env（与 Save 保持一致），文件不存在时返回默认值模型
    /// </summary>
    public static EnvConfigModel Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "script", ".env");
        var model = new EnvConfigModel();

        if (!File.Exists(path))
            return model;

        // 逐行解析 key=value 格式，支持注释（# 开头）和空行
        var envMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in File.ReadAllLines(path))
        {
            var trimmed = line.Trim();
            // 跳过空行和注释行
            if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith('#'))
                continue;

            var eq = trimmed.IndexOf('=');
            if (eq < 0) continue; // 非 key=value 格式，跳过

            var key = trimmed[..eq].Trim();
            var value = trimmed[(eq + 1)..].Trim();
            envMap[key] = value;
        }

        // 将解析出的键值对映射到模型的各个属性，未配置则使用默认值
        model.ServerPort = GetInt(envMap, "SERVER_PORT", 11434);
        model.DefaultModel = GetString(envMap, "DEFAULT_MODEL", "ds/deepseek-v4-pro");
        model.DeepSeekBaseUrl = GetString(envMap, "DEEPSEEK_BASE_URL", "https://api.deepseek.com");
        model.DeepSeekApiKey = GetString(envMap, "DEEPSEEK_API_KEY", "");
        model.MiMoBaseUrl = GetString(envMap, "MIMO_BASE_URL", "https://api.xiaomimimo.com/v1");
        model.MiMoApiKey = GetString(envMap, "MIMO_API_KEY", "");
        model.RequestLog = GetBool(envMap, "REQUEST_LOG", true);
        model.Debug = GetBool(envMap, "DEBUG", false);
        model.CompressionLevel = GetString(envMap, "COMPRESSION_LEVEL", "off");
        model.ConcurrencyThinking = GetInt(envMap, "CONCURRENCY_THINKING", 5);
        model.ConcurrencyStandard = GetInt(envMap, "CONCURRENCY_STANDARD", 15);
        model.RetryMax = GetInt(envMap, "RETRY_MAX", 6);
        model.TruncateToolOutput = GetBool(envMap, "TRUNCATE_TOOL_OUTPUT", true);
        model.ThinkingTimeoutMs = GetInt(envMap, "THINKING_TIMEOUT_MS", 300000);
        model.RequestTimeoutMs = GetInt(envMap, "REQUEST_TIMEOUT_MS", 300000);
        model.DefaultContextLength = GetInt(envMap, "DEFAULT_CONTEXT_LENGTH", 262144);
        model.DefaultTemperature = GetDouble(envMap, "DEFAULT_TEMPERATURE", 0.1);
        model.SessionKeepaliveEnabled = GetBool(envMap, "SESSION_KEEPALIVE_ENABLED", true);
        model.SessionKeepaliveIntervalMs = GetInt(envMap, "SESSION_KEEPALIVE_INTERVAL_MS", 60000);
        model.SessionKeepaliveIdleTimeoutMs = GetInt(envMap, "SESSION_KEEPALIVE_IDLE_TIMEOUT_MS", 1800000);
        model.ServerHost = GetString(envMap, "SERVER_HOST", "127.0.0.1");
        model.MaxToolOutputChars = GetInt(envMap, "MAX_TOOL_OUTPUT_CHARS", 12000);
        model.SnetLanguage = GetString(envMap, "SNET_LANGUAGE", "zh");
        model.ForceAllCapabilities = GetBool(envMap, "FORCE_ALL_CAPABILITIES", true);
        model.MessagesPaging = GetInt(envMap, "MESSAGES_PAGING", 0);
        model.RetryBaseDelayMs = GetInt(envMap, "RETRY_BASE_DELAY_MS", 100);
        model.MaxRequestBodyBytes = GetInt(envMap, "MAX_REQUEST_BODY_BYTES", 67108864);
        model.ToolOutputHeadChars = GetInt(envMap, "TOOL_OUTPUT_HEAD_CHARS", 6000);
        model.ToolOutputTailChars = GetInt(envMap, "TOOL_OUTPUT_TAIL_CHARS", 2000);

        return model;
    }

    #endregion

    #region 保存配置

    /// <summary>
    /// 将 EnvConfigModel 序列化并写入 script/.env（始终保存到源文件路径）
    /// </summary>
    public static void Save(EnvConfigModel model) => SaveTo(model, Path.Combine(AppContext.BaseDirectory, "script", ".env"));

    /// <summary>
    /// 将 EnvConfigModel 序列化并写入指定路径，目录不存在时自动创建
    /// 输出格式为标准 .env 文件：注释行以 # 开头，配置项为 KEY=VALUE
    /// </summary>
    public static void SaveTo(EnvConfigModel model, string path)
    {
        // 确保目标目录存在
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            Directory.CreateDirectory(dir);

        var lines = new List<string>
        {
            "# ============================================================",
            "#  Snet Copilot Proxy — Configuration",
            "#  所有配置均设有合理默认值，按需修改即可。",
            "#  All settings have sensible defaults. Only change what you need.",
            "# ============================================================",
            "",
            "# --- Model Selection ---",
            $"DEFAULT_MODEL={model.DefaultModel}",
            "",
            "# --- Server ---",
            $"SERVER_HOST={model.ServerHost}",
            $"SERVER_PORT={model.ServerPort}",
            "",
            "# --- DeepSeek API ---",
            $"DEEPSEEK_BASE_URL={model.DeepSeekBaseUrl}",
            $"DEEPSEEK_API_KEY={model.DeepSeekApiKey}",
            "",
            "# --- MiMo API ---",
            $"MIMO_BASE_URL={model.MiMoBaseUrl}",
            $"MIMO_API_KEY={model.MiMoApiKey}",
            "",
            "# --- Logging ---",
            $"REQUEST_LOG={model.RequestLog.ToString().ToLower()}",
            $"DEBUG={model.Debug.ToString().ToLower()}",
            "",
            "# --- Compression (off/lite/caveman/rtk/ultra/delta/stacked/aggressive/standard) ---",
            $"COMPRESSION_LEVEL={model.CompressionLevel}",
            "",
            "# --- Concurrency ---",
            $"CONCURRENCY_THINKING={model.ConcurrencyThinking}",
            $"CONCURRENCY_STANDARD={model.ConcurrencyStandard}",
            $"RETRY_MAX={model.RetryMax}",
            $"THINKING_TIMEOUT_MS={model.ThinkingTimeoutMs}",
            $"REQUEST_TIMEOUT_MS={model.RequestTimeoutMs}",
            "",
            "# --- Tool Output ---",
            $"TRUNCATE_TOOL_OUTPUT={model.TruncateToolOutput.ToString().ToLower()}",
            $"MAX_TOOL_OUTPUT_CHARS={model.MaxToolOutputChars}",
            "",
            "# --- Context ---",
            $"DEFAULT_CONTEXT_LENGTH={model.DefaultContextLength}",
            "# MESSAGES_PAGING=0",
            "",
            "# --- Model Capabilities ---",
            $"DEFAULT_TEMPERATURE={model.DefaultTemperature}",
            "",
            "# --- Session Keepalive ---",
            $"SESSION_KEEPALIVE_ENABLED={model.SessionKeepaliveEnabled.ToString().ToLower()}",
            $"SESSION_KEEPALIVE_INTERVAL_MS={model.SessionKeepaliveIntervalMs}",
            $"SESSION_KEEPALIVE_IDLE_TIMEOUT_MS={model.SessionKeepaliveIdleTimeoutMs}",
            "",
            "# --- Language (zh / en) ---",
            $"SNET_LANGUAGE={model.SnetLanguage}",
            "",
            "# --- Advanced (JS-side config, not exposed in WPF UI) ---",
            $"FORCE_ALL_CAPABILITIES={model.ForceAllCapabilities.ToString().ToLower()}",
            $"MESSAGES_PAGING={model.MessagesPaging}",
            $"RETRY_BASE_DELAY_MS={model.RetryBaseDelayMs}",
            $"MAX_REQUEST_BODY_BYTES={model.MaxRequestBodyBytes}",
            $"TOOL_OUTPUT_HEAD_CHARS={model.ToolOutputHeadChars}",
            $"TOOL_OUTPUT_TAIL_CHARS={model.ToolOutputTailChars}",
            "",
            // Preserve any extra keys that aren't part of the model
        };
        lines.AddRange(model.ExtraKeys.Select(kv => $"{kv.Key}={kv.Value}"));

        File.WriteAllText(path, string.Join("\n", lines));
    }

    #endregion

    #region 路径解析

    /// <summary>
    /// 获取服务端口读取优先查找的 .env 路径（不影响 Load/Save 的主路径）
    /// 如果 .dist 目录存在（已构建）则优先 .dist/.env，否则 script/.env
    /// </summary>
    public static string GetEnvPath()
    {
        var baseDir = AppContext.BaseDirectory;
        var distDir = Path.Combine(baseDir, "script", ".dist");
        var distEnv = Path.Combine(distDir, ".env");
        var scriptEnv = Path.Combine(baseDir, "script", ".env");
        // 检查目录而非文件：构建后 .dist 目录已存在但 .env 可能尚未创建
        return Directory.Exists(distDir) ? distEnv : scriptEnv;
    }

    #endregion

    #region 类型转换辅助方法

    /// <summary>
    /// 从字典中读取字符串值，不存在或为空时返回默认值
    /// </summary>
    private static string GetString(Dictionary<string, string> map, string key, string defaultValue)
        => map.TryGetValue(key, out var v) && !string.IsNullOrEmpty(v) ? v : defaultValue;

    /// <summary>
    /// 从字典中读取整数值，不存在或解析失败时返回默认值
    /// </summary>
    private static int GetInt(Dictionary<string, string> map, string key, int defaultValue)
        => map.TryGetValue(key, out var v) && int.TryParse(v, out var n) ? n : defaultValue;

    /// <summary>
    /// 从字典中读取布尔值，支持多种格式：true/false、1/0、yes/no、on/off、y/n
    /// 不存在或无法识别时返回默认值
    /// </summary>
    private static bool GetBool(Dictionary<string, string> map, string key, bool defaultValue)
    {
        if (!map.TryGetValue(key, out var v)) return defaultValue;
        return v.ToLowerInvariant() switch
        {
            "true" or "1" or "yes" or "on" or "y" => true,
            "false" or "0" or "no" or "off" or "n" => false,
            _ => defaultValue,
        };
    }

    /// <summary>
    /// 从字典中读取浮点值，不存在或解析失败时返回默认值（可为 null）
    /// </summary>
    private static double? GetDouble(Dictionary<string, string> map, string key, double? defaultValue)
    {
        if (!map.TryGetValue(key, out var v) || string.IsNullOrEmpty(v)) return defaultValue;
        return double.TryParse(v, out var n) ? n : defaultValue;
    }

    #endregion
}
