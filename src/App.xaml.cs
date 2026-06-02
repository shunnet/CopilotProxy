using Microsoft.Extensions.DependencyInjection;
using Snet.CopilotProxy.handler;
using Snet.Core.handler;
using Snet.Log;
using Snet.Model.data;
using Snet.Windows.Controls.data;
using Snet.Windows.Controls.property;
using Snet.Windows.Core.handler;
using System.IO;
using System.Net.Http;
using System.Windows;

namespace Snet.CopilotProxy
{
    /// <summary>
    /// 应用程序入口，负责启动时初始化、全局异常捕获、应用退出时的资源清理
    /// </summary>
    public partial class App : Application
    {

        #region 静态路径与资源

        /// <summary>
        /// 单实例管理器实例
        /// 需要在整个应用程序生命周期内保持存活
        /// （持有 Mutex 的所有权，释放后其他实例就能成为首实例）
        /// </summary>
        private SingleInstanceHandle _singleInstance;

        /// <summary>
        /// 脚本目录路径（相对于应用程序基目录的 script 子目录）
        /// </summary>
        public static readonly string ScriptPath = System.IO.Path.Combine(AppContext.BaseDirectory, "script");

        /// <summary>
        /// 构建输出目录路径（script/.dist），用于存放编译后的可独立部署文件
        /// </summary>
        public static readonly string DistPath = System.IO.Path.Combine(ScriptPath, ".dist");

        /// <summary>
        /// 构建入口脚本路径（script/build.cmd）
        /// </summary>
        public static readonly string BuildPath = System.IO.Path.Combine(ScriptPath, "build.cmd");

        /// <summary>
        /// 启动入口路径，优先使用构建产物 service.exe，否则回退到 start.cmd
        /// </summary>
        public static string StartPath =>
            File.Exists(Path.Combine(DistPath, "service.exe"))
                ? Path.Combine(DistPath, "service.exe")
                : Path.Combine(ScriptPath, "start.cmd");

        /// <summary>
        /// MaterialDesign 弹窗的 DialogHost 标识符
        /// </summary>
        public static readonly string DialogHostTag = "DialogHost";

        /// <summary>
        /// 缓存的参数设置控件（懒加载，首次访问时从 DI 容器获取）
        /// </summary>
        private static PropertyControl? _param;
        public static PropertyControl Param => _param ??= InjectionWpf.GetService<PropertyControl>();

        /// <summary>
        /// 多语言操作实例，提供界面文本的国际化支持
        /// </summary>
        public readonly static LanguageModel LanguageOperate = new LanguageModel("Snet.CopilotProxy", "Language", "Snet.CopilotProxy.dll");

        /// <summary>
        /// 日志颜色高亮规则集合，定义不同标签的显示颜色
        /// </summary>
        public readonly static List<EditModel> EditModels = GetEditModels();

        /// <summary>
        /// 构建日志高亮规则：Info 类用绿色，Error 类用红色，Console 用黄色，品牌标识用蓝色
        /// </summary>
        private static List<EditModel> GetEditModels() =>
        [
            new() { Name = "[ Info ]",                Color = "#4CAF50" },
            new() { Name = "[INFO]",                Color = "#4CAF50" },
            new() { Name = "[model]",                  Color = "#4CAF50" },
            new() { Name = "[i18n]",                  Color = "#4CAF50" },
            new() { Name = "[status]",                  Color = "#4CAF50" },
            new() { Name = "[skills]",                  Color = "#4CAF50" },
            new() { Name = "[token]",                  Color = "#4CAF50" },
            new() { Name = "[ Error ]",               Color = "#F44336" },
            new() { Name = "错误",               Color = "#F44336" },
            new() { Name = "Error",               Color = "#F44336" },
            new() { Name = "异常",                    Color = "#F44336" },
            new() { Name = "Exception",               Color = "#F44336" },
            new() { Name = "TRUE",                    Color = "#4CAF50" },
            new() { Name = "Build successful",        Color = "#4CAF50" },
            new() { Name = "FALSE",                   Color = "#F44336" },
            new() { Name = "[ Console ]",             Color = "#FBC31D" },
            new() { Name = "[ Shunnet.top ]",         Color = "#459DBA" },
            new() { Name = "[Shunnet.top]",         Color = "#459DBA" },
            new() { Name = "[MEDIUM]",         Color = "#459DBA" },
            new() { Name = "DeepSeek",         Color = "#14B8FF" },
            new() { Name = "MiMo",         Color = "#30C5C7" },
             new() { Name = "new session",         Color = "#FAC21E" },
        ];

        #endregion

        #region 应用生命周期事件

        /// <summary>
        /// 应用退出时：先通过 HTTP /stop 通知代理服务优雅关闭，再释放 DI 容器
        /// </summary>
        private async void OnExit(object sender, ExitEventArgs e)
        {
            _singleInstance?.Dispose();
            await StopServiceAsync();
            InjectionWpf.ClearService();
        }

        /// <summary>
        /// 应用启动时：清理残留服务 → 注入参数设置控件 → 注册全局异常捕获 → 打开主窗口
        /// </summary>
        private async void OnStartup(object sender, StartupEventArgs e)
        {
            //判断是不是唯一打开
            SingleInstance(e);

            // 尝试优雅关闭可能残留的旧代理服务（上次异常退出遗留）
            await StopStaleServiceAsync();

            // 注入参数设置控件到 DI 容器
            PropertyControl control = new PropertyControl();
            control.ButtonVisibility = Visibility.Visible;
            InjectionWpf.AddService(s =>
            {
                s.AddSingleton(control);
            });

            // 注册全局未处理异常事件
            RegisterEvents();

            // 打开主窗口
            MainWindow window = InjectionWpf.Window<MainWindow, MainWindowModel>(true);
            window.Show();

            // Show() 之后窗口的 HWND 才真正创建
            // 此时立即缓存句柄，后续即使窗口 Hide 到托盘也能唤醒
            _singleInstance.RegisterMainWindow(window);
        }

        /// <summary>
        /// 唯一实例处理流程
        /// </summary>
        /// <param name="e"></param>
        private void SingleInstance(StartupEventArgs e)
        {
            _singleInstance = new SingleInstanceHandle("Snet.CopilotProxy", out bool isFirst);      // 输出：是否是首实例

            if (!isFirst)
            {
                _singleInstance.SignalFirstInstance(e.Args);
                _singleInstance.Dispose();
                Shutdown(0);
                return;
            }
            _singleInstance.SignalReceived += OnWakeup;
        }

        /// <summary>
        /// 被新实例唤醒时的回调
        /// </summary>
        private void OnWakeup(string[] args)
        {
            _singleInstance.BringToFront();
        }

        #endregion

        #region 全局异常捕获

        /// <summary>
        /// 注册三类全局异常捕获：Task 线程异常、UI 主线程异常、非 UI 子线程异常
        /// 确保任何未处理的异常都能被捕获并展示给用户
        /// </summary>
        private void RegisterEvents()
        {
            // Task 线程内未捕获异常（如 async void、Task.Run 中的异常）
            TaskScheduler.UnobservedTaskException += TaskScheduler_UnobservedTaskException;

            // UI 主线程未捕获异常（WPF Dispatcher 线程）
            this.DispatcherUnhandledException += App_DispatcherUnhandledException;

            // 非 UI 线程未捕获异常（自行创建的 Thread / ThreadPool 线程）
            AppDomain.CurrentDomain.UnhandledException += CurrentDomain_UnhandledException;
        }

        /// <summary>
        /// Task 线程未捕获异常处理 — 过滤 ExternalException 避免误报，其余弹窗并记录日志
        /// </summary>
        private async void TaskScheduler_UnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
        {
            try
            {
                var exception = e.Exception as Exception;
                if (exception == null) return;

                // ExternalException 通常为正常取消或可忽略的系统级异常，不弹窗处理
                if (exception is System.Runtime.InteropServices.ExternalException) return;

                await HandleException(exception);
            }
            catch (Exception ex)
            {
                await HandleException(ex);
            }
            finally
            {
                // 标记异常已被观察到，防止进程崩溃
                e.SetObserved();
            }
        }

        /// <summary>
        /// 非 UI 线程未捕获异常处理（例如自行创建的子线程中抛出的异常）
        /// </summary>
        private async void CurrentDomain_UnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            try
            {
                var exception = e.ExceptionObject as Exception;
                if (exception != null)
                    await HandleException(exception);
            }
            catch (Exception ex)
            {
                await HandleException(ex);
            }
        }

        /// <summary>
        /// UI 线程未捕获异常处理 — 先标记已处理避免 WPF 重复触发，再弹窗记录
        /// </summary>
        private async void App_DispatcherUnhandledException(object sender, System.Windows.Threading.DispatcherUnhandledExceptionEventArgs e)
        {
            // 先标记已处理，避免 WPF 在 await 后重复触发异常事件
            e.Handled = true;
            try
            {
                await HandleException(e.Exception);
            }
            catch (Exception ex)
            {
                await HandleException(ex);
            }
        }

        /// <summary>
        /// 将异常信息格式化后在界面弹窗显示，同时写入本地日志文件
        /// </summary>
        /// <param name="e">未处理的异常对象</param>
        private async Task HandleException(Exception e)
        {
            string exceptionSource = e.Source ?? string.Empty;
            string message = e.Message ?? string.Empty;
            string stackTrace = e.StackTrace ?? string.Empty;
            string msg;

            // 按优先级组合异常信息：Source > Message > StackTrace
            if (!string.IsNullOrEmpty(exceptionSource))
            {
                msg = exceptionSource;
                if (!string.IsNullOrEmpty(message)) msg += $"\r\n{message}";
                if (!string.IsNullOrEmpty(stackTrace)) msg += $"\r\n\r\n{stackTrace}";
            }
            else if (!string.IsNullOrEmpty(message))
            {
                msg = message;
                if (!string.IsNullOrEmpty(stackTrace)) msg += $"\r\n\r\n{stackTrace}";
            }
            else if (!string.IsNullOrEmpty(stackTrace))
                msg = stackTrace;
            else
                msg = App.LanguageOperate.GetLanguageValue("UnknownException");

            if (Application.Current == null) return;

            // 在 UI 线程弹出异常消息框
            await Application.Current.Dispatcher.InvokeAsync(async () =>
            {
                await Snet.Windows.Controls.message.MessageBox.Show(
                    msg,
                    App.LanguageOperate.GetLanguageValue("GlobalException"),
                    Snet.Windows.Controls.@enum.MessageBoxButton.OK,
                    Snet.Windows.Controls.@enum.MessageBoxImage.Exclamation);
            }, System.Windows.Threading.DispatcherPriority.Loaded);

            // 同时写入本地错误日志
            LogHelper.Error(msg, "Snet.CopilotProxy.log", e);
        }

        #endregion

        #region 服务清理

        /// <summary>
        /// 从配置文件中读取服务端口，失败时返回默认端口 11434
        /// </summary>
        private static int GetServicePort()
        {
            try
            {
                var envPath = handler.EnvHandle.GetEnvPath();
                if (File.Exists(envPath))
                    return handler.EnvHandle.Load().ServerPort;
            }
            catch { }
            return 11434;
        }

        /// <summary>
        /// 启动时尝试优雅关闭可能残留的旧代理服务进程（上次异常退出遗留）
        /// 使用 HTTP /stop 端点通知服务退出，超时 3 秒后忽略
        /// </summary>
        private static async Task StopStaleServiceAsync()
        {
            try
            {
                var port = GetServicePort();
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
                await http.GetAsync($"http://127.0.0.1:{port}/stop");
            }
            catch (Exception ex)
            {
                // 清理失败通常是因为没有残留服务，记录日志即可
                LogHelper.Error(string.Format(App.LanguageOperate.GetLanguageValue("Error_StopStaleServiceFailed"), ex.Message), "Snet.CopilotProxy.log", ex);
            }
        }

        /// <summary>
        /// 应用退出时优雅关闭代理服务，使用 HTTP /stop 端点通知服务退出
        /// </summary>
        private static async Task StopServiceAsync()
        {
            try
            {
                var port = GetServicePort();
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
                await http.GetAsync($"http://127.0.0.1:{port}/stop");
            }
            catch (Exception ex)
            {
                LogHelper.Error(string.Format(App.LanguageOperate.GetLanguageValue("Error_StopServiceFailed"), ex.Message), "Snet.CopilotProxy.log", ex);
            }
        }

        #endregion
    }

}
