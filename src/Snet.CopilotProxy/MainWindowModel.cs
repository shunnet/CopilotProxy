using CommunityToolkit.Mvvm.Input;
using MaterialDesignThemes.Wpf;
using Snet.CopilotProxy.handler;
using Snet.CopilotProxy.models;
using Snet.Core.handler;
using Snet.Log;
using Snet.Model.data;
using Snet.Utility;
using Snet.Windows.Controls.handler;
using Snet.Windows.Core.mvvm;
using System.IO;
using System.Net.Http;
using System.Text.RegularExpressions;

namespace Snet.CopilotProxy
{
    /// <summary>
    /// 主窗口 ViewModel，负责日志展示、构建、配置、启停控制等核心业务逻辑
    /// 继承 BindNotify 实现 MVVM 双向绑定
    /// </summary>
    public partial class MainWindowModel : BindNotify
    {

        #region 构造函数与初始化

        public MainWindowModel()
        {
            InitAsync().ContinueWith(t =>
            {
                if (t.IsFaulted && t.Exception != null)
                    LogHelper.Error(string.Format(App.LanguageOperate.GetLanguageValue("Error_InitFailed"), t.Exception.InnerException?.Message ?? ""), "Snet.CopilotProxy", t.Exception);
            }, TaskContinuationOptions.NotOnRanToCompletion);
        }

        private async Task InitAsync()
        {
            try
            {
                uiMessage.OnInfoEventAsync += async (object? sender, EventInfoResult e) => Log = e.Message;
                await uiMessage.StartAsync();

                // 监听 WPF 语言切换，同步通知脚本切换语言
                LanguageHandler.OnLanguageEventAsync += async (object? sender, EventLanguageResult e) =>
                {
                    await SyncLanguageToScriptAsync(e.Language.Value);
                };

                // 初始化时先同步一次当前语言设置
                await SyncLanguageToScriptAsync(LanguageHandler.GetLanguage());

                _ = ShowAsync(App.LanguageOperate.GetLanguageValue("Welcome"));

                await CheckNodeJsAsync();

                if (File.Exists(EnvHandle.GetEnvPath()))
                {
                    SettingsIsEnabled = true;
                    StartIsEnabled = Directory.Exists(App.DistPath);
                    BuildIsEnabled = !StartIsEnabled;
                }
                else
                {
                    BuildIsEnabled = true;
                }
            }
            catch (Exception ex)
            {
                _ = ShowAsync(string.Format(App.LanguageOperate.GetLanguageValue("Error_InitFailed"), ex.Message));
            }
        }

        #endregion

        #region 属性（BindNotify 双向绑定）

        public string Log
        {
            get => GetProperty(() => Log);
            set => SetProperty(() => Log, value);
        }

        public bool BuildIsEnabled
        {
            get => GetProperty(() => BuildIsEnabled);
            set => SetProperty(() => BuildIsEnabled, value);
        }

        public bool SettingsIsEnabled
        {
            get => GetProperty(() => SettingsIsEnabled);
            set => SetProperty(() => SettingsIsEnabled, value);
        }

        public bool StartIsEnabled
        {
            get => GetProperty(() => StartIsEnabled);
            set => SetProperty(() => StartIsEnabled, value);
        }

        public bool StopIsEnabled
        {
            get => GetProperty(() => StopIsEnabled);
            set => SetProperty(() => StopIsEnabled, value);
        }

        public bool RestartIsEnabled
        {
            get => GetProperty(() => RestartIsEnabled);
            set => SetProperty(() => RestartIsEnabled, value);
        }

        #endregion

        #region 字段

        private UiMessageHandler uiMessage = UiMessageHandler.Instance("Snet");
        private CancellationTokenSource? _buildCts;
        private CancellationTokenSource? _startCts;
        private System.Diagnostics.Process? _runningProcess;
        private System.Diagnostics.Process? _buildProcess;

        #endregion

        #region 日志显示

        [GeneratedRegex(@"(?<!\s)\[")]
        private static partial Regex BracketOpenRegex();

        [GeneratedRegex(@"\](?!\s)")]
        private static partial Regex BracketCloseRegex();

        private async Task ShowAsync(string msg)
        {
            msg = BracketCloseRegex().Replace(BracketOpenRegex().Replace(msg, " ["), "] ");
            await uiMessage.ShowAsync(msg, null, false);
        }

        #endregion

        #region Node.js 环境检查

        private async Task CheckNodeJsAsync()
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo("node", "--version")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using var process = System.Diagnostics.Process.Start(psi);
                if (process == null)
                {
                    await ShowAsync(App.LanguageOperate.GetLanguageValue("Error_NodeJsNotFound"));
                    return;
                }
                var version = (await process.StandardOutput.ReadToEndAsync()).Trim();
                await process.WaitForExitAsync();
                if (process.ExitCode != 0)
                {
                    await ShowAsync(App.LanguageOperate.GetLanguageValue("Error_NodeJsNotFound"));
                    return;
                }
                await ShowAsync(string.Format(App.LanguageOperate.GetLanguageValue("Info_NodeJs"), version));
            }
            catch
            {
                await ShowAsync(App.LanguageOperate.GetLanguageValue("Error_NodeJsNotFound"));
            }
        }

        #endregion

        #region 构建

        public IAsyncRelayCommand Build => p_Build ??= new AsyncRelayCommand(BuildAsync);
        private IAsyncRelayCommand? p_Build;

        public async Task BuildAsync()
        {
            if (!File.Exists(App.BuildPath))
            {
                await ShowAsync(App.LanguageOperate.GetLanguageValue("Error_BuildScriptNotFound"));
                return;
            }

            BuildIsEnabled = false;
            StopIsEnabled = true;
            await ShowAsync(App.LanguageOperate.GetLanguageValue("Info_BuildStarting"));
            await ShowAsync($"[ Console ] {App.BuildPath}");

            var currentEnv = EnvHandle.Load();
            EnvHandle.Save(currentEnv);

            var cts = new CancellationTokenSource();
            _buildCts = cts;

            var exitCode = await CmdHandle.RunAsync(App.BuildPath, msg =>
            {
                _ = ShowAsync(msg);
            }, cts.Token, p => _buildProcess = p);

            await ShowAsync(exitCode == 0
                ? App.LanguageOperate.GetLanguageValue("Info_BuildCompleted")
                : string.Format(App.LanguageOperate.GetLanguageValue("Error_BuildFailed"), exitCode));

            if (exitCode == 0 && Directory.Exists(App.DistPath))
            {
                var distEnvPath = Path.Combine(App.DistPath, ".env");
                if (!File.Exists(distEnvPath))
                    await ShowAsync(App.LanguageOperate.GetLanguageValue("Info_DistNoConfig"));
                EnvHandle.SaveTo(currentEnv, distEnvPath);
                await ShowAsync(App.LanguageOperate.GetLanguageValue("Info_ConfigSynced"));
                SettingsIsEnabled = true;
                StartIsEnabled = true;
            }
            StopIsEnabled = false;
            BuildIsEnabled = false;
            _buildCts = null;
        }

        #endregion

        #region 设置

        public IAsyncRelayCommand Settings => p_Settings ??= new AsyncRelayCommand(SettingsAsync);
        private IAsyncRelayCommand? p_Settings;

        public async Task SettingsAsync()
        {
            var config = File.Exists(EnvHandle.GetEnvPath())
                ? EnvHandle.Load()
                : new EnvConfigModel();

            App.Param.SetBasics(config);
            if ((await DialogHost.Show(App.Param, App.DialogHostTag)).ToBool())
            {
                var model = App.Param.GetBasics().GetSource<EnvConfigModel>();
                var scriptEnv = Path.Combine(App.ScriptPath, ".env");
                var distEnv = Path.Combine(App.DistPath, ".env");
                EnvHandle.SaveTo(model, scriptEnv);
                if (Directory.Exists(App.DistPath))
                    EnvHandle.SaveTo(model, distEnv);

                if (StopIsEnabled)
                {
                    await ShowAsync(App.LanguageOperate.GetLanguageValue("Info_ConfigSavedRestarting"));
                    await RestartAsync();
                }
            }
        }

        #endregion

        #region 启动

        public IAsyncRelayCommand Start => p_Start ??= new AsyncRelayCommand(StartAsync);
        private IAsyncRelayCommand? p_Start;

        public async Task StartAsync()
        {
            if (!File.Exists(App.StartPath))
            {
                await ShowAsync(App.LanguageOperate.GetLanguageValue("Error_StartScriptNotFound"));
                return;
            }

            StartIsEnabled = false;
            StopIsEnabled = true;
            RestartIsEnabled = true;
            await ShowAsync(App.LanguageOperate.GetLanguageValue("Info_ServiceStarting"));

            var cts = new CancellationTokenSource();
            _startCts = cts;

            var lang = LanguageHandler.GetLanguage() == Model.@enum.LanguageType.en ? "en" : "zh";
            _ = CmdHandle.RunAsync(App.StartPath, msg =>
            {
                _ = ShowAsync(msg);
            }, cts.Token, p => _runningProcess = p, "--plain", new Dictionary<string, string> { ["SNET_PLAIN"] = "1", ["SNET_LANGUAGE"] = lang });

            // 等待服务就绪后同步语言（重试最多 10 次，每次间隔递增）
            _ = SyncLanguageWhenReadyAsync(LanguageHandler.GetLanguage(), cts.Token);
        }

        /// <summary>
        /// 轮询等待脚本服务启动完成后同步语言设置
        /// </summary>
        private static async Task SyncLanguageWhenReadyAsync(Model.@enum.LanguageType language, CancellationToken ct)
        {
            for (var i = 0; i < 10; i++)
            {
                await Task.Delay(1000 + i * 500, ct);
                try
                {
                    var port = 11434;
                    try { port = EnvHandle.Load().ServerPort; } catch { }
                    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
                    var resp = await http.GetAsync($"http://127.0.0.1:{port}/health", ct);
                    if (resp.IsSuccessStatusCode)
                    {
                        await SyncLanguageToScriptAsync(language);
                        return;
                    }
                }
                catch { }
            }
        }

        #endregion

        #region 停止

        public IAsyncRelayCommand Stop => p_Stop ??= new AsyncRelayCommand(StopAsync);
        private IAsyncRelayCommand? p_Stop;

        public async Task StopAsync()
        {
            _buildCts?.Cancel();
            _startCts?.Cancel();
            _buildProcess?.Dispose();
            _buildProcess = null;

            await ShowAsync(App.LanguageOperate.GetLanguageValue("Info_ServiceStopping"));

            var port = EnvHandle.Load().ServerPort;
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                await http.GetAsync($"http://127.0.0.1:{port}/stop");
                await ShowAsync(App.LanguageOperate.GetLanguageValue("Info_ServiceStopped"));
            }
            catch
            {
                KillRunningProcess();
            }

            StopIsEnabled = false;
            RestartIsEnabled = false;
            StartIsEnabled = Directory.Exists(App.DistPath);
            BuildIsEnabled = true;
        }

        #endregion

        #region 重启

        public IAsyncRelayCommand Restart => p_Restart ??= new AsyncRelayCommand(RestartAsync);
        private IAsyncRelayCommand? p_Restart;

        public async Task RestartAsync()
        {
            if (!File.Exists(App.StartPath))
            {
                await ShowAsync(App.LanguageOperate.GetLanguageValue("Error_StartScriptNotFound"));
                return;
            }

            await ShowAsync(App.LanguageOperate.GetLanguageValue("Info_ServiceRestarting"));
            await StopAsync();
            await Task.Delay(1500);
            await StartAsync();
        }

        #endregion

        #region 进程管理

        private void KillRunningProcess()
        {
            try
            {
                if (_runningProcess is { HasExited: false })
                {
                    _runningProcess.Kill(entireProcessTree: true);
                    _ = ShowAsync(App.LanguageOperate.GetLanguageValue("Info_ProcessTerminated"));
                }
                else
                {
                    _ = ShowAsync(App.LanguageOperate.GetLanguageValue("Error_StopFailedManual"));
                }
            }
            catch (Exception ex)
            {
                _ = ShowAsync(string.Format(App.LanguageOperate.GetLanguageValue("Error_StopFailed"), ex.Message));
            }
            finally
            {
                _runningProcess?.Dispose();
                _runningProcess = null;
            }
        }

        #endregion

        #region 清空日志

        public IAsyncRelayCommand Clear => p_Clear ??= new AsyncRelayCommand(ClearAsync);
        private IAsyncRelayCommand? p_Clear;

        public async Task ClearAsync()
        {
            await uiMessage.ClearAsync();
        }

        #endregion

        #region 语言同步

        /// <summary>
        /// 将 WPF 语言切换同步到脚本服务，使脚本日志也跟随语言设置
        /// </summary>
        /// <param name="languageType">WPF 语言类型（zh / en）</param>
        private static async Task SyncLanguageToScriptAsync(Model.@enum.LanguageType languageType)
        {
            try
            {
                var lang = languageType == Model.@enum.LanguageType.en ? "en" : "zh";
                var port = 11434;
                try { port = EnvHandle.Load().ServerPort; } catch { }
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
                var content = new StringContent($"{{\"language\":\"{lang}\"}}", System.Text.Encoding.UTF8, "application/json");
                await http.PostAsync($"http://127.0.0.1:{port}/api/language", content);
            }
            catch
            {
                // 脚本可能未启动，忽略同步失败
            }
        }

        #endregion
    }
}
