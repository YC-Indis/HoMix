using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class HoMixWindow : Form
{
    private const int TitleBarHeight = 50;
    private const int EAbort = unchecked((int)0x80004004);
    private const int WmNcLButtonDown = 0x00A1;
    private const int WmNcHitTest = 0x0084;
    private const int HtCaption = 2;
    private const int HtLeft = 10;
    private const int HtRight = 11;
    private const int HtTop = 12;
    private const int HtTopLeft = 13;
    private const int HtTopRight = 14;
    private const int HtBottom = 15;
    private const int HtBottomLeft = 16;
    private const int HtBottomRight = 17;
    private readonly WebView2 webView;
    private readonly Panel contentPanel;
    private readonly Panel titleBar;
    private readonly Button maximizeButton;
    private readonly Panel loadingPanel;
    private readonly Label loadingText;
    private readonly System.Windows.Forms.Timer readyTimer;
    private readonly EventWaitHandle openSignal;
    private Process server;
    private IntPtr serverJob = IntPtr.Zero;
    private string url;
    private int readyAttempts;
    private bool serverReady;
    private bool webViewReady;
    private bool navigated;
    private bool closing;

    public HoMixWindow(EventWaitHandle signal)
    {
        openSignal = signal;
        Text = "HoMix";
        Icon = CreateAppIcon();
        BackColor = Color.FromArgb(10, 13, 18);
        ForeColor = Color.White;
        FormBorderStyle = FormBorderStyle.None;
        Padding = new Padding(1);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1024, 680);
        Size = new Size(1440, 920);
        WindowState = FormWindowState.Maximized;
        KeyPreview = true;
        AllowDrop = true;

        webView = new WebView2
        {
            Dock = DockStyle.Fill,
            BackColor = BackColor,
            AllowExternalDrop = false
        };
        contentPanel = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty, BackColor = BackColor };
        contentPanel.Controls.Add(webView);

        loadingText = new Label
        {
            AutoSize = false,
            Dock = DockStyle.Fill,
            Text = "HoMix 正在启动…",
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Regular),
            ForeColor = Color.FromArgb(94, 234, 212)
        };
        loadingPanel = new Panel { Dock = DockStyle.Fill, BackColor = BackColor };
        loadingPanel.Controls.Add(loadingText);
        contentPanel.Controls.Add(loadingPanel);
        loadingPanel.BringToFront();

        titleBar = new Panel
        {
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
            BackColor = Color.FromArgb(24, 25, 27)
        };
        var titleText = new Label
        {
            AutoSize = false,
            Dock = DockStyle.Left,
            Width = 112,
            Text = "HoMix",
            TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(16, 0, 0, 1),
            Font = new Font("Segoe UI Semibold", 11F, FontStyle.Regular),
            ForeColor = Color.FromArgb(222, 224, 228),
            BackColor = Color.Transparent
        };
        var captionButtons = new Panel { Dock = DockStyle.Right, Width = 144, BackColor = Color.Transparent };
        var minimizeButton = CreateCaptionButton("—", 0, false);
        maximizeButton = CreateCaptionButton("□", 48, false);
        var closeButton = CreateCaptionButton("×", 96, true);
        minimizeButton.Click += (sender, e) => WindowState = FormWindowState.Minimized;
        maximizeButton.Click += (sender, e) => ToggleMaximize();
        closeButton.Click += (sender, e) => Close();
        captionButtons.Controls.Add(minimizeButton);
        captionButtons.Controls.Add(maximizeButton);
        captionButtons.Controls.Add(closeButton);
        titleBar.Controls.Add(titleText);
        titleBar.Controls.Add(captionButtons);
        titleBar.Paint += (sender, e) => e.Graphics.DrawLine(new Pen(Color.FromArgb(45, 47, 51)), 0, titleBar.Height - 1, titleBar.Width, titleBar.Height - 1);
        foreach (Control dragTarget in new Control[] { titleBar, titleText })
        {
            dragTarget.MouseDown += OnTitleBarMouseDown;
            dragTarget.DoubleClick += (sender, e) => ToggleMaximize();
        }

        var windowLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = BackColor
        };
        windowLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        windowLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, TitleBarHeight));
        windowLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        windowLayout.Controls.Add(titleBar, 0, 0);
        windowLayout.Controls.Add(contentPanel, 0, 1);
        Controls.Add(windowLayout);

        DragEnter += OnDragEnter;
        DragDrop += OnDragDrop;
        FormClosing += OnClosing;

        var port = FindAvailablePort(47821, 47920);
        if (port <= 0) throw new InvalidOperationException("没有可用的本地端口，请关闭占用 47821-47920 端口的程序后重试。");
        url = "http://127.0.0.1:" + port;
        StartServer(port);

        readyTimer = new System.Windows.Forms.Timer { Interval = 120 };
        readyTimer.Tick += CheckReady;
        readyTimer.Start();
        ThreadPool.QueueUserWorkItem(WaitForOpenRequests);
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        ActivateWindow();
        await InitializeWebView();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        MaximizedBounds = Screen.FromHandle(Handle).WorkingArea;
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (maximizeButton != null) maximizeButton.Text = WindowState == FormWindowState.Maximized ? "❐" : "□";
        Padding = WindowState == FormWindowState.Maximized ? Padding.Empty : new Padding(1);
    }

    protected override void WndProc(ref Message message)
    {
        base.WndProc(ref message);
        if (message.Msg != WmNcHitTest || WindowState == FormWindowState.Maximized || (int)message.Result != 1) return;
        var value = message.LParam.ToInt64();
        var screenPoint = new Point((short)(value & 0xffff), (short)((value >> 16) & 0xffff));
        var point = PointToClient(screenPoint);
        const int grip = 7;
        var left = point.X <= grip;
        var right = point.X >= ClientSize.Width - grip;
        var top = point.Y <= grip;
        var bottom = point.Y >= ClientSize.Height - grip;
        if (left && top) message.Result = (IntPtr)HtTopLeft;
        else if (right && top) message.Result = (IntPtr)HtTopRight;
        else if (left && bottom) message.Result = (IntPtr)HtBottomLeft;
        else if (right && bottom) message.Result = (IntPtr)HtBottomRight;
        else if (left) message.Result = (IntPtr)HtLeft;
        else if (right) message.Result = (IntPtr)HtRight;
        else if (top) message.Result = (IntPtr)HtTop;
        else if (bottom) message.Result = (IntPtr)HtBottom;
    }

    private static Button CreateCaptionButton(string text, int left, bool close)
    {
        var button = new Button
        {
            Text = text,
            Location = new Point(left, 0),
            Size = new Size(48, TitleBarHeight),
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.Transparent,
            ForeColor = Color.FromArgb(202, 204, 209),
            Font = new Font("Segoe UI", 12F, FontStyle.Regular),
            TabStop = false,
            UseVisualStyleBackColor = false
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseDownBackColor = close ? Color.FromArgb(176, 35, 45) : Color.FromArgb(56, 58, 62);
        button.FlatAppearance.MouseOverBackColor = close ? Color.FromArgb(196, 43, 52) : Color.FromArgb(47, 49, 53);
        return button;
    }

    private void ToggleMaximize()
    {
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
    }

    private void OnTitleBarMouseDown(object sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left || e.Clicks > 1) return;
        ReleaseCapture();
        SendMessage(Handle, WmNcLButtonDown, (IntPtr)HtCaption, IntPtr.Zero);
    }

    private static Icon CreateAppIcon()
    {
        using (var bitmap = new Bitmap(32, 32))
        using (var graphics = Graphics.FromImage(bitmap))
        using (var background = new SolidBrush(Color.FromArgb(31, 35, 39)))
        using (var mark = new SolidBrush(Color.FromArgb(91, 218, 226)))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);
            using (var shape = RoundedRectangle(new Rectangle(2, 2, 28, 28), 7)) graphics.FillPath(background, shape);
            graphics.FillPolygon(mark, new[] { new Point(8, 9), new Point(24, 9), new Point(18, 15), new Point(14, 15) });
            graphics.FillPolygon(mark, new[] { new Point(14, 17), new Point(18, 17), new Point(24, 23), new Point(8, 23) });
            var handle = bitmap.GetHicon();
            try { return (Icon)Icon.FromHandle(handle).Clone(); }
            finally { DestroyIcon(handle); }
        }
    }

    private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var diameter = radius * 2;
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private async Task InitializeWebView()
    {
        Exception lastError = null;
        for (var attempt = 1; attempt <= 5 && !closing; attempt++)
        {
            var retryDelay = 0;
            try
            {
                loadingText.Text = attempt == 1 ? "正在准备本地窗口…" : "正在等待桌面窗口释放资源…";
                var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HoMix", "WebView2");
                Directory.CreateDirectory(userData);
                var environment = await CoreWebView2Environment.CreateAsync(null, userData, null);
                if (closing) return;
                await webView.EnsureCoreWebView2Async(environment);
                if (closing) return;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                webView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
                webView.NavigationCompleted += OnNavigationCompleted;
                webViewReady = true;
                TryNavigate();
                return;
            }
            catch (Exception error)
            {
                lastError = error;
                if (closing) return;
                if (error.HResult != EAbort || attempt >= 5) break;
                retryDelay = 250 * attempt;
            }
            if (retryDelay > 0) await Task.Delay(retryDelay);
        }
        if (closing) return;
        var guidance = lastError != null && lastError.HResult == EAbort
            ? "桌面窗口资源仍被上一次运行占用。请稍等几秒后重新打开 HoMix。"
            : "无法初始化桌面窗口。请安装或修复 Microsoft Edge WebView2 Runtime。";
        MessageBox.Show(this, guidance + "\n\n" + (lastError == null ? "未知错误" : lastError.Message), "HoMix 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }

    private void CheckReady(object sender, EventArgs e)
    {
        if (closing) return;
        if (server != null && server.HasExited)
        {
            readyTimer.Stop();
            MessageBox.Show(this, "HoMix 后台服务意外退出，请查看本地数据目录中的 launcher.log。", "HoMix", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }
        if (!serverReady)
        {
            readyAttempts++;
            serverReady = IsReady(new Uri(url).Port);
            if (!serverReady)
            {
                loadingText.Text = readyAttempts < 25 ? "正在启动本地服务…" : "正在加载视频引擎…";
                if (readyAttempts > 180)
                {
                    readyTimer.Stop();
                    MessageBox.Show(this, "本地服务启动超时，请查看 launcher.log。", "HoMix 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                }
                return;
            }
        }
        TryNavigate();
    }

    private void TryNavigate()
    {
        if (closing || navigated || !serverReady || !webViewReady || webView.CoreWebView2 == null) return;
        navigated = true;
        loadingText.Text = "正在打开工作台…";
        webView.CoreWebView2.Navigate(url + "/?desktop=0.20.5&launch=" + DateTime.UtcNow.Ticks);
    }

    private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            navigated = false;
            loadingText.Text = "页面加载失败，正在重试…";
            return;
        }
        readyTimer.Interval = 1000;
        loadingPanel.Visible = false;
        webView.Focus();
    }

    private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { }
    }

    private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string command;
        try { command = e.TryGetWebMessageAsString(); }
        catch { return; }
        if (command == "pick-files") PickVideoFiles("files-picked");
        else if (command == "pick-hook-file") PickVideoFiles("hook-file-picked");
        else if (command == "pick-music-file") PickMusicFiles();
        else if (command == "pick-video-folder") PickFolder("video-folder-picked", "选择包含视频的文件夹");
        else if (command == "pick-output-folder") PickFolder("output-folder-picked", "选择输出文件夹");
    }

    private void PickVideoFiles(string messageType)
    {
        using (var dialog = new OpenFileDialog())
        {
            dialog.Title = messageType == "hook-file-picked" ? "选择钩子视频" : "选择视频";
            dialog.Multiselect = true;
            dialog.RestoreDirectory = true;
            dialog.Filter = "视频文件|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.mts;*.m2ts|所有文件|*.*";
            if (dialog.ShowDialog(this) == DialogResult.OK) PostPaths(messageType, dialog.FileNames);
        }
    }

    private void PickMusicFiles()
    {
        using (var dialog = new OpenFileDialog())
        {
            dialog.Title = "选择音乐";
            dialog.Multiselect = true;
            dialog.RestoreDirectory = true;
            dialog.Filter = "音频文件|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.wma;*.mp4|所有文件|*.*";
            if (dialog.ShowDialog(this) == DialogResult.OK) PostPaths("music-files-picked", dialog.FileNames);
        }
    }

    private void PickFolder(string messageType, string description)
    {
        using (var dialog = new FolderBrowserDialog())
        {
            dialog.Description = description;
            if (dialog.ShowDialog(this) == DialogResult.OK) PostPaths(messageType, new[] { dialog.SelectedPath });
        }
    }

    private void OnDragEnter(object sender, DragEventArgs e)
    {
        e.Effect = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
    }

    private void OnDragDrop(object sender, DragEventArgs e)
    {
        var paths = e.Data.GetData(DataFormats.FileDrop) as string[];
        if (paths == null || paths.Length == 0) return;
        if (paths.Length == 1 && Directory.Exists(paths[0])) PostPaths("video-folder-picked", paths);
        else PostPaths("files-dropped", paths);
    }

    private void PostPaths(string messageType, IEnumerable<string> paths)
    {
        if (webView.CoreWebView2 == null) return;
        var json = new StringBuilder();
        json.Append("{\"type\":\"").Append(JsonEscape(messageType)).Append("\",\"paths\":[");
        var first = true;
        foreach (var path in paths)
        {
            if (!first) json.Append(',');
            first = false;
            json.Append('"').Append(JsonEscape(path)).Append('"');
        }
        json.Append("]}");
        webView.CoreWebView2.PostWebMessageAsJson(json.ToString());
    }

    private static string JsonEscape(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private void WaitForOpenRequests(object state)
    {
        while (!closing)
        {
            if (!openSignal.WaitOne(500)) continue;
            if (!closing) ActivateWindow();
        }
    }

    private void ActivateWindow()
    {
        if (closing || IsDisposed) return;
        if (InvokeRequired)
        {
            try { BeginInvoke((MethodInvoker)ActivateWindow); } catch { }
            return;
        }
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        BringToFront();
        Activate();
    }

    private static bool IsReady(int port)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
            request.Timeout = 160;
            request.ReadWriteTimeout = 160;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    private static int FindAvailablePort(int first, int last)
    {
        for (var port = first; port <= last; port++)
        {
            TcpListener listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                return port;
            }
            catch { }
            finally { if (listener != null) listener.Stop(); }
        }
        return 0;
    }

    private void StartServer(int port)
    {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        var dataRoot = GetDataRoot();
        MigrateLegacyData(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SceneSift", "Data"), dataRoot);
        MigrateLegacyData(Path.Combine(root, "data"), dataRoot);
        var bundledNode = Path.Combine(root, "runtime", "node.exe");
        var node = File.Exists(bundledNode) ? bundledNode : "node.exe";
        var script = Path.Combine(root, "server.js");
        if (!File.Exists(script)) throw new FileNotFoundException("便携包缺少 server.js，请重新解压完整文件夹。", script);
        var info = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "\"" + script + "\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        info.EnvironmentVariables["HOMIX_NO_BROWSER"] = "1";
        info.EnvironmentVariables["HOMIX_DATA_DIR"] = dataRoot;
        info.EnvironmentVariables["HOMIX_PORT"] = port.ToString();
        info.EnvironmentVariables["HOMIX_PROCESS_RUNNER"] = Application.ExecutablePath;
        server = new Process { StartInfo = info, EnableRaisingEvents = true };
        server.OutputDataReceived += LogLine;
        server.ErrorDataReceived += LogLine;
        if (!server.Start()) throw new InvalidOperationException("Node 运行时无法启动。");
        serverJob = NativeJob.CreateForProcess(server);
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
    }

    private void LogLine(object sender, DataReceivedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(e.Data)) return;
        try
        {
            var data = GetDataRoot();
            Directory.CreateDirectory(data);
            File.AppendAllText(Path.Combine(data, "launcher.log"), DateTime.Now.ToString("s") + " " + e.Data + Environment.NewLine);
        }
        catch { }
    }

    private void OnClosing(object sender, FormClosingEventArgs e)
    {
        if (closing) return;
        closing = true;
        readyTimer.Stop();
        try { webView.Dispose(); } catch { }
        if (serverJob != IntPtr.Zero)
        {
            NativeJob.CloseHandle(serverJob);
            serverJob = IntPtr.Zero;
        }
        if (server != null)
        {
            try
            {
                if (!server.HasExited)
                {
                    server.Kill();
                    server.WaitForExit(600);
                }
            }
            catch { }
            server.Dispose();
            server = null;
        }
    }

    private static string GetDataRoot()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HoMix", "Data");
    }

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr wParam, IntPtr lParam);

    private static void MigrateLegacyData(string legacyRoot, string dataRoot)
    {
        try
        {
            Directory.CreateDirectory(dataRoot);
            var projects = Path.Combine(dataRoot, "projects");
            var hasData = File.Exists(Path.Combine(dataRoot, "ai-config.json")) || File.Exists(Path.Combine(dataRoot, "library.json")) || (Directory.Exists(projects) && Directory.GetFiles(projects, "*.json").Length > 0);
            if (!hasData && Directory.Exists(legacyRoot)) CopyDirectory(legacyRoot, dataRoot);
        }
        catch { }
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.GetFiles(source))
        {
            var destination = Path.Combine(target, Path.GetFileName(file));
            if (!File.Exists(destination)) File.Copy(file, destination);
        }
        foreach (var directory in Directory.GetDirectories(source)) CopyDirectory(directory, Path.Combine(target, Path.GetFileName(directory)));
    }
}

internal static class NativeJob
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public long Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    internal static extern bool CloseHandle(IntPtr handle);

    internal static IntPtr CreateForProcess(Process process)
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length) || !AssignProcessToJobObject(job, process.Handle))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }
}

internal static class HiddenProcessRunner
{
    internal static int Run(string[] args)
    {
        var relayInput = args.Length > 0 && args[0] == "--run-hidden-stdin";
        if (args.Length < 2) return 87;
        var executable = args[1];
        var childArgs = new string[Math.Max(0, args.Length - 2)];
        if (childArgs.Length > 0) Array.Copy(args, 2, childArgs, 0, childArgs.Length);
        var info = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = JoinArguments(childArgs),
            WorkingDirectory = Environment.CurrentDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = relayInput
        };
        Process child = null;
        IntPtr job = IntPtr.Zero;
        try
        {
            child = new Process { StartInfo = info };
            if (!child.Start()) return 1;
            job = NativeJob.CreateForProcess(child);
            var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            if (relayInput)
            {
                Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream);
                child.StandardInput.Close();
            }
            child.WaitForExit();
            Task.WaitAll(output, error);
            return child.ExitCode;
        }
        catch (Exception exception)
        {
            try { Console.Error.WriteLine(exception.Message); } catch { }
            return 1;
        }
        finally
        {
            if (job != IntPtr.Zero) NativeJob.CloseHandle(job);
            if (child != null) child.Dispose();
        }
    }

    private static string JoinArguments(IEnumerable<string> args)
    {
        var builder = new StringBuilder();
        foreach (var value in args)
        {
            if (builder.Length > 0) builder.Append(' ');
            builder.Append(QuoteArgument(value ?? ""));
        }
        return builder.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var builder = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                builder.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            if (slashes > 0) builder.Append('\\', slashes);
            slashes = 0;
            builder.Append(character);
        }
        if (slashes > 0) builder.Append('\\', slashes * 2);
        return builder.Append('"').ToString();
    }
}

internal static class Program
{
    private const string MutexName = "Local\\HoMix.Desktop.SingleInstance";
    private const string OpenEventName = "Local\\HoMix.Desktop.OpenWindow";

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length > 0 && (args[0] == "--run-hidden" || args[0] == "--run-hidden-stdin"))
        {
            Environment.ExitCode = HiddenProcessRunner.Run(args);
            return;
        }
        bool created;
        using (var mutex = new Mutex(true, MutexName, out created))
        using (var openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, OpenEventName))
        {
            var ownsMutex = created;
            var tookOverClosingInstance = false;
            if (!created)
            {
                openSignal.Set();
                try { ownsMutex = mutex.WaitOne(3000); }
                catch (AbandonedMutexException) { ownsMutex = true; }
                if (!ownsMutex) return;
                tookOverClosingInstance = true;
            }
            if (tookOverClosingInstance) Thread.Sleep(450);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { Application.Run(new HoMixWindow(openSignal)); }
            catch (Exception error) { MessageBox.Show(error.Message, "HoMix 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            finally { try { mutex.ReleaseMutex(); } catch { } }
        }
    }
}
