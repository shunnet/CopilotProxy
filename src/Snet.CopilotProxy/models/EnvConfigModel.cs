using System.ComponentModel;
using System.ComponentModel.DataAnnotations;

namespace Snet.CopilotProxy.models;

/// <summary>
/// .env 配置文件对应的数据模型 — 包含代理服务的所有可配置参数
/// 属性通过 [Description] 特性提供 UI 显示名称，通过 [Range] 等特性提供输入验证
/// </summary>
public class EnvConfigModel
{
    #region 服务器配置

    /// <summary>
    /// 监听端口，默认 11434（Ollama 兼容端口），范围 1-65535
    /// </summary>
    [Description("监听端口（默认 11434）")]
    [Range(1, 65535, ErrorMessage = "端口必须在 1-65535 之间")]
    public int ServerPort { get; set; } = 11434;

    /// <summary>
    /// 默认模型标识符，当客户端未指定模型时使用
    /// </summary>
    [Description("默认模型")]
    [Required(AllowEmptyStrings = false, ErrorMessage = "默认模型不能为空")]
    public string DefaultModel { get; set; } = "ds/deepseek-v4-pro";

    #endregion

    #region DeepSeek API 配置

    /// <summary>
    /// DeepSeek API 基础地址，可配置为转发/代理地址
    /// </summary>
    [Description("DeepSeek API 地址（可改为转发 API 地址）")]
    [Url(ErrorMessage = "请输入有效的 URL")]
    public string DeepSeekBaseUrl { get; set; } = "https://api.deepseek.com/v1";

    /// <summary>
    /// DeepSeek API 密钥，从 https://platform.deepseek.com/api_keys 获取
    /// </summary>
    [Description("DeepSeek API Key")]
    public string DeepSeekApiKey { get; set; } = "";

    #endregion

    #region 小米 MiMo API 配置

    /// <summary>
    /// 小米 MiMo API 基础地址，可配置为转发/代理地址
    /// </summary>
    [Description("MiMo API 地址（可改为转发 API 地址）")]
    [Url(ErrorMessage = "请输入有效的 URL")]
    public string MiMoBaseUrl { get; set; } = "https://api.xiaomimimo.com/v1";

    /// <summary>
    /// 小米 MiMo API 密钥，从 https://platform.xiaomimimo.com 获取
    /// </summary>
    [Description("MiMo API Key")]
    public string MiMoApiKey { get; set; } = "";

    #endregion

    #region 日志配置

    /// <summary>
    /// 是否记录请求日志到控制台，默认开启
    /// </summary>
    [Description("记录请求日志（默认 true）")]
    public bool RequestLog { get; set; } = true;

    /// <summary>
    /// 是否启用调试日志（显示启动详情、模型加载过程等），默认关闭
    /// </summary>
    [Description("调试日志 — 显示启动详情等（默认 false）")]
    public bool Debug { get; set; } = false;

    #endregion

    #region 提示词压缩配置

    /// <summary>
    /// 提示词压缩级别，可选值：auto / off / lite / caveman / aggressive / ultra / rtk / stacked
    /// 不同级别对应不同的压缩策略和 Token 节省率
    /// </summary>
    [Description("提示词压缩级别：auto / off / lite / caveman / aggressive / ultra / rtk / stacked（默认 auto）")]
    public string CompressionLevel { get; set; } = "auto";

    #endregion

    #region 并发与速率限制

    /// <summary>
    /// 推理模型（Thinking）的最大并发请求数，建议保持较低以避免上游 429 限流
    /// </summary>
    [Description("推理模型最大并发数（保持较低以避免上游 429）")]
    [Range(1, 100, ErrorMessage = "并发数必须在 1-100 之间")]
    public int ConcurrencyThinking { get; set; } = 1;

    /// <summary>
    /// 标准模型的最大并发请求数
    /// </summary>
    [Description("标准模型最大并发数")]
    [Range(1, 100, ErrorMessage = "并发数必须在 1-100 之间")]
    public int ConcurrencyStandard { get; set; } = 3;

    /// <summary>
    /// 遇到 429（频率限制）错误时的最大重试次数，设为 0 禁用重试
    /// </summary>
    [Description("429 错误重试次数（0 禁用）")]
    [Range(0, 100, ErrorMessage = "重试次数必须在 0-100 之间")]
    public int RetryMax { get; set; } = 3;

    #endregion

    #region 模型元数据

    /// <summary>
    /// 是否强制所有模型报告完整能力（工具调用、视觉等），默认开启
    /// </summary>
    [Description("强制所有模型报告完整能力")]
    public bool ForceAllCapabilities { get; set; } = true;

    /// <summary>
    /// 默认上下文窗口长度（Token 数），用于在 Ollama 模型列表中展示
    /// </summary>
    [Description("默认上下文长度")]
    [Range(1024, int.MaxValue, ErrorMessage = "上下文长度必须 >= 1024")]
    public int DefaultContextLength { get; set; } = 131072;

    #endregion

    #region 会话保活配置

    /// <summary>
    /// 是否启用会话保活（定期 Ping 上游 API 维持 KV Cache），默认开启
    /// 开启后可享受更低的 Cache Hit 定价
    /// </summary>
    [Description("会话保活开关（默认 true）")]
    public bool SessionKeepaliveEnabled { get; set; } = true;

    /// <summary>
    /// 保活最大空闲时间（毫秒），超过此时间无请求则停止 Ping
    /// </summary>
    [Description("保活最大空闲时间，毫秒")]
    [Range(1000, int.MaxValue, ErrorMessage = "保活空闲时间必须 >= 1000ms")]
    public int SessionKeepaliveIdleTimeoutMs { get; set; } = 600000;

    #endregion
}
