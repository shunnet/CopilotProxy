using ICSharpCode.AvalonEdit;
using Snet.Utility;
using Snet.Windows.Controls.handler;
using Snet.Windows.Core;
using System.ComponentModel;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;

namespace Snet.CopilotProxy
{
    /// <summary>
    /// Interaction logic for MainWindow.xaml
    /// </summary>
    public partial class MainWindow : WindowBase
    {
        public MainWindow()
        {
            InitializeComponent();
            _ = new EditHandler(edit, App.EditModels, color: ("#414141", "#FFFFFF"));
        }

        /// <summary>
        /// 标记是否为强制关闭（由托盘"关闭"命令触发），为 true 时不拦截关闭事件
        /// </summary>
        public bool IsForceClose { get; set; }

        /// <summary>
        /// 拦截文本输入，防止用户手动编辑日志内容
        /// </summary>
        private void TextEditor_PreviewTextInput(object sender, TextCompositionEventArgs e)
        {
            e.Handled = true;
        }

        /// <summary>
        /// 拦截键盘按键，阻止粘贴（Ctrl+V）、删除和退格操作
        /// </summary>
        private void TextEditor_PreviewKeyDown(object sender, KeyEventArgs e)
        {
            if ((e.Key == Key.V && Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) || e.Key == Key.Delete || e.Key == Key.Back)
            {
                e.Handled = true;
            }
        }

        /// <summary>
        /// 文本内容变化时自动滚动到末尾，保持最新日志可见
        /// </summary>
        private void TextEditor_TextChanged(object sender, EventArgs e)
        {
            TextEditor text = sender.GetSource<TextEditor>();
            text.SelectionStart = text.Text.Length;
            text.SelectionLength = 0;
            text.ScrollToEnd();
        }

        /// <summary>
        /// 托盘图标左键点击事件：安全恢复窗口
        /// </summary>
        private void TrayIcon_LeftClick(Windows.Controls.tray.Controls.NotifyIcon sender, RoutedEventArgs e)
        {
            Dispatcher.BeginInvoke(() =>
            {
                ShowInTaskbar = true;

                if (!IsVisible)
                    Show();

                if (WindowState == WindowState.Minimized)
                    WindowState = WindowState.Normal;

                Focus();

            }, DispatcherPriority.ApplicationIdle);
        }

        /// <summary>
        /// 重写窗口关闭行为：非强制关闭时，将窗口隐藏到系统托盘而非真正关闭
        /// </summary>
        /// <param name="e">关闭事件参数，可通过 Cancel 属性取消关闭</param>
        protected override void OnClosing(CancelEventArgs e)
        {
            if (!IsForceClose)
            {
                e.Cancel = true;
                Hide();
                ShowInTaskbar = false;
                return;
            }
            base.OnClosing(e);
        }
    }
}