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
        model.DeepSeekBaseUrl = GetString(envMap, "DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1");
        model.DeepSeekApiKey = GetString(envMap, "DEEPSEEK_API_KEY", "");
        model.MiMoBaseUrl = GetString(envMap, "MIMO_BASE_URL", "https://api.xiaomimimo.com/v1");
        model.MiMoApiKey = GetString(envMap, "MIMO_API_KEY", "");
        model.RequestLog = GetBool(envMap, "REQUEST_LOG", true);
        model.Debug = GetBool(envMap, "DEBUG", false);
        model.CompressionLevel = GetString(envMap, "COMPRESSION_LEVEL", "auto");
        model.ConcurrencyThinking = GetInt(envMap, "CONCURRENCY_THINKING", 1);
        model.ConcurrencyStandard = GetInt(envMap, "CONCURRENCY_STANDARD", 3);
        model.RetryMax = GetInt(envMap, "RETRY_MAX", 3);
        model.ForceAllCapabilities = GetBool(envMap, "FORCE_ALL_CAPABILITIES", true);
        model.DefaultContextLength = GetInt(envMap, "DEFAULT_CONTEXT_LENGTH", 131072);
        model.SessionKeepaliveEnabled = GetBool(envMap, "SESSION_KEEPALIVE_ENABLED", true);
        model.SessionKeepaliveIdleTimeoutMs = GetInt(envMap, "SESSION_KEEPALIVE_IDLE_TIMEOUT_MS", 600000);

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
            "# === 服务器配置 ===",
            $"# 监听端口（默认 11434）",
            $"SERVER_PORT={model.ServerPort}",
            $"# 默认模型",
            $"DEFAULT_MODEL={model.DefaultModel}",
            "",
            "# === DeepSeek API ===",
            "# API 地址（可改为转发 API 地址）",
            $"DEEPSEEK_BASE_URL={model.DeepSeekBaseUrl}",
            "# 获取 API Key：https://platform.deepseek.com/api_keys",
            $"DEEPSEEK_API_KEY={model.DeepSeekApiKey}",
            "",
            "# === 小米 MiMo API ===",
            "# API 地址（可改为转发 API 地址）",
            $"MIMO_BASE_URL={model.MiMoBaseUrl}",
            "# 获取 API Key：https://platform.xiaomimimo.com/#/console/api-keys",
            $"MIMO_API_KEY={model.MiMoApiKey}",
            "",
            "# === 日志 ===",
            $"REQUEST_LOG={model.RequestLog.ToString().ToLower()}",
            $"DEBUG={model.Debug.ToString().ToLower()}",
            "",
            "# === 提示词压缩 ===",
            $"COMPRESSION_LEVEL={model.CompressionLevel}",
            "",
            "# === 并发与速率限制 ===",
            $"CONCURRENCY_THINKING={model.ConcurrencyThinking}",
            $"CONCURRENCY_STANDARD={model.ConcurrencyStandard}",
            $"RETRY_MAX={model.RetryMax}",
            "",
            "# === 模型元数据 ===",
            $"FORCE_ALL_CAPABILITIES={model.ForceAllCapabilities.ToString().ToLower()}",
            $"DEFAULT_CONTEXT_LENGTH={model.DefaultContextLength}",
            "",
            "# === 会话保活 ===",
            $"SESSION_KEEPALIVE_ENABLED={model.SessionKeepaliveEnabled.ToString().ToLower()}",
            $"SESSION_KEEPALIVE_IDLE_TIMEOUT_MS={model.SessionKeepaliveIdleTimeoutMs}",
            "",
        };

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

    #endregion
}
