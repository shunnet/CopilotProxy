using Snet.Core.handler;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Snet.CopilotProxy.handler;

/// <summary>
/// CMD 命令执行器 — 异步运行 .cmd/.bat 脚本，实时捕获 stdout/stderr 输出
/// 支持传递额外参数、设置环境变量、超时取消、ANSI 转义码过滤
/// </summary>
public static partial class CmdHandle
{

    #region 核心执行方法

    /// <summary>
    /// 默认命令执行超时（10 分钟），防止脚本卡死导致进程无法退出
    /// </summary>
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(10);

    /// <summary>
    /// 异步执行 CMD 脚本文件，实时回调每行输出
    /// </summary>
    /// <param name="scriptPath">脚本文件路径（.cmd / .bat）</param>
    /// <param name="onOutput">每行输出的回调（已去除 ANSI 转义码）</param>
    /// <param name="cancellationToken">外部取消令牌</param>
    /// <param name="onProcessStarted">进程启动后的回调，用于上层跟踪进程引用</param>
    /// <param name="extraArgs">传递给脚本的额外命令行参数</param>
    /// <param name="env">额外的环境变量字典</param>
    /// <returns>脚本退出码，0 表示成功</returns>
    public static async Task<int> RunAsync(string scriptPath, Action<string> onOutput, CancellationToken cancellationToken = default, Action<Process>? onProcessStarted = null, string? extraArgs = null, Dictionary<string, string>? env = null)
    {
        if (!File.Exists(scriptPath))
        {
            onOutput(string.Format(App.LanguageOperate.GetLanguageValue("Error_ScriptNotFound"), scriptPath));
            return -1;
        }

        // 分离目录与文件名，WorkingDirectory 设为脚本所在目录
        var dir = Path.GetDirectoryName(scriptPath) ?? "";
        var file = Path.GetFileName(scriptPath);

        // 构建 CMD 命令行：chcp 65001 设置 UTF-8 编码，call 调用脚本
        var extra = extraArgs != null ? " " + extraArgs : "";
        var psi = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = "/c \"chcp 65001 >nul 2>&1 & call \"" + file + "\"" + extra + "\"",
            WorkingDirectory = dir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,    // 不使用 ShellExecute 才能重定向输出
            CreateNoWindow = true,      // 不弹出控制台窗口
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        // 注入额外的环境变量（如 SNET_PLAIN）
        if (env != null)
        {
            foreach (var kv in env)
                psi.Environment[kv.Key] = kv.Value;
        }

        // 组合超时保护：调用方传入的令牌 + 默认 10 分钟超时
        using var timeoutCts = new CancellationTokenSource(DefaultTimeout);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);
        var ct = linkedCts.Token;

        using var process = new Process { StartInfo = psi };
        process.Start();
        // 通知上层进程已启动，便于后续精准终止
        onProcessStarted?.Invoke(process);

        // 并行读取 stdout 和 stderr，stderr 输出自动添加 [ Error ] 前缀
        var stdoutTask = ReadStreamAsync(process.StandardOutput, onOutput, ct);
        var stderrTask = ReadStreamAsync(process.StandardError, line => onOutput("[ Error ] " + line), ct);

        await Task.WhenAll(stdoutTask, stderrTask);
        await process.WaitForExitAsync(ct);

        return process.ExitCode;
    }

    #endregion

    #region 流读取与 ANSI 过滤

    /// <summary>
    /// 从 StreamReader 中逐行读取，过滤 ANSI 转义码后回调
    /// </summary>
    /// <param name="reader">进程的标准输出或标准错误流</param>
    /// <param name="onLine">每行文本的回调</param>
    /// <param name="ct">取消令牌</param>
    private static async Task ReadStreamAsync(StreamReader reader, Action<string> onLine, CancellationToken ct)
    {
        try
        {
            while (true)
            {
                var line = await reader.ReadLineAsync(ct);
                if (line == null) break; // 流已关闭

                if (line.Length > 0)
                    onLine(StripAnsi(line));
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (IOException ex)
        {
            onLine(string.Format(App.LanguageOperate.GetLanguageValue("Error_ReadStreamFailed"), ex.Message));
        }
    }

    /// <summary>
    /// ANSI 转义序列过滤正则：匹配 CSI 控制码（光标移动、清屏、颜色等）和 OSC 码（终端标题等）
    /// CSI：ESC [ 参数 字母 — 如 \x1b[H、\x1b[J、\x1b[90m
    /// OSC：ESC ] 内容 终止符 — 如 \x1b]2;标题\x1b\
    /// </summary>
    [GeneratedRegex(@"\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")]
    private static partial Regex AnsiRegex();

    /// <summary>
    /// 去除文本中的所有 ANSI 转义序列，返回干净的纯文本
    /// </summary>
    private static string StripAnsi(string text) => AnsiRegex().Replace(text, "");

    #endregion
}
