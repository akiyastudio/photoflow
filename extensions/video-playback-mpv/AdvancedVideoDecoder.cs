using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace PhotoFlow.AdvancedVideoDecoder
{
    internal static class NativeMethods
    {
        internal const int GWL_STYLE = -16;
        internal const long WS_CHILD = 0x40000000L;
        internal const long WS_POPUP = 0x80000000L;
        internal const long WS_CAPTION = 0x00C00000L;
        internal const uint SWP_NOACTIVATE = 0x0010;
        internal const uint SWP_SHOWWINDOW = 0x0040;
        internal const int SW_HIDE = 0;
        internal const int SW_SHOWNOACTIVATE = 4;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr LoadLibrary(string fileName);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool FreeLibrary(IntPtr module);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true)]
        internal static extern IntPtr GetProcAddress(IntPtr module, string name);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern bool SetDllDirectory(string path);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
        internal static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
        internal static extern IntPtr GetWindowLongPtr32(IntPtr window, int index);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
        internal static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong", SetLastError = true)]
        internal static extern IntPtr SetWindowLongPtr32(IntPtr window, int index, IntPtr value);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

        [DllImport("user32.dll")]
        internal static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        internal static IntPtr GetWindowStyle(IntPtr window)
        {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(window, GWL_STYLE) : GetWindowLongPtr32(window, GWL_STYLE);
        }

        internal static void SetWindowStyle(IntPtr window, IntPtr value)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(window, GWL_STYLE, value);
            else SetWindowLongPtr32(window, GWL_STYLE, value);
        }
    }

    internal sealed class LibMpv : IDisposable
    {
        private const int MpvErrorOptionNotFound = -5;

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr MpvCreate();
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int MpvInitialize(IntPtr context);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int MpvSetOptionString(IntPtr context, [MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPStr)] string value);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int MpvSetPropertyString(IntPtr context, [MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.LPStr)] string value);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr MpvGetPropertyString(IntPtr context, [MarshalAs(UnmanagedType.LPStr)] string name);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int MpvCommand(IntPtr context, IntPtr arguments);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr MpvWaitEvent(IntPtr context, double timeout);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr MpvErrorString(int error);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void MpvFree(IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void MpvTerminateDestroy(IntPtr context);

        [StructLayout(LayoutKind.Sequential)]
        private struct MpvEvent
        {
            internal int EventId;
            internal int Error;
            internal ulong ReplyUserdata;
            internal IntPtr Data;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MpvEventEndFile
        {
            internal int Reason;
            internal int Error;
            internal long PlaylistEntryId;
            internal long PlaylistInsertId;
            internal int PlaylistInsertCount;
        }

        private readonly IntPtr library;
        private readonly MpvCreate create;
        private readonly MpvInitialize initialize;
        private readonly MpvSetOptionString setOptionString;
        private readonly MpvSetPropertyString setPropertyString;
        private readonly MpvGetPropertyString getPropertyString;
        private readonly MpvCommand command;
        private readonly MpvWaitEvent waitEvent;
        private readonly MpvErrorString errorString;
        private readonly MpvFree free;
        private readonly MpvTerminateDestroy terminateDestroy;
        private IntPtr context;
        private string[] pendingSidecars = new string[0];
        private string pendingVideoPath = string.Empty;

        internal LibMpv(IntPtr videoWindow, bool probeOnly = false)
        {
            string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            NativeMethods.SetDllDirectory(baseDirectory);
            string[] names = { "libmpv-2.dll", "mpv-2.dll" };
            foreach (string name in names)
            {
                string candidate = Path.Combine(baseDirectory, name);
                if (File.Exists(candidate))
                {
                    library = NativeMethods.LoadLibrary(candidate);
                    if (library != IntPtr.Zero) break;
                }
            }
            if (library == IntPtr.Zero) throw new InvalidOperationException("无法加载 libmpv-2.dll，请在组件管理中修复或重新安装“视频播放器”运行时");

            create = Load<MpvCreate>("mpv_create");
            initialize = Load<MpvInitialize>("mpv_initialize");
            setOptionString = Load<MpvSetOptionString>("mpv_set_option_string");
            setPropertyString = Load<MpvSetPropertyString>("mpv_set_property_string");
            getPropertyString = Load<MpvGetPropertyString>("mpv_get_property_string");
            command = Load<MpvCommand>("mpv_command");
            waitEvent = Load<MpvWaitEvent>("mpv_wait_event");
            errorString = Load<MpvErrorString>("mpv_error_string");
            free = Load<MpvFree>("mpv_free");
            terminateDestroy = Load<MpvTerminateDestroy>("mpv_terminate_destroy");

            context = create();
            if (context == IntPtr.Zero) throw new InvalidOperationException("libmpv 初始化内存失败");
            if (videoWindow != IntPtr.Zero) SetOption("wid", videoWindow.ToInt64().ToString(CultureInfo.InvariantCulture));
            SetOption("vo", probeOnly ? "null" : "gpu");
            if (probeOnly) SetOption("audio", "no");
            else
            {
                SetOption("gpu-api", "d3d11");
                SetOption("hwdec", "auto-safe");
                SetOption("hwdec-codecs", "all");
            }
            SetOption("cache", "yes");
            SetOption("demuxer-readahead-secs", "5");
            SetOption("demuxer-max-bytes", "256MiB");
            SetOption("keep-open", "yes");
            SetOption("idle", "yes");
            // Discovery is explicit so camera telemetry and sidecars never become visible automatically.
            SetOption("sub-auto", "no");
            SetOption("sub-codepage", "auto");
            SetOption("sid", "no");
            SetOption("sub-visibility", "no");
            SetOptionalOption("osc", "no");
            SetOption("input-default-bindings", "no");
            SetOption("input-cursor", "no");
            SetOption("pause", "yes");
            Check(initialize(context), "初始化 libmpv");
        }

        private T Load<T>(string name) where T : class
        {
            IntPtr address = NativeMethods.GetProcAddress(library, name);
            if (address == IntPtr.Zero) throw new MissingMethodException("libmpv 缺少接口：" + name);
            return Marshal.GetDelegateForFunctionPointer(address, typeof(T)) as T;
        }

        private string ErrorText(int code)
        {
            IntPtr pointer = errorString(code);
            return pointer == IntPtr.Zero ? "错误 " + code : Utf8(pointer);
        }

        private void Check(int result, string operation)
        {
            if (result < 0) throw new InvalidOperationException(operation + "失败：" + ErrorText(result));
        }

        private void SetOption(string name, string value)
        {
            Check(setOptionString(context, name, value), "设置 " + name);
        }

        private void SetOptionalOption(string name, string value)
        {
            int result = setOptionString(context, name, value);
            if (result < 0 && result != MpvErrorOptionNotFound) Check(result, "设置 " + name);
        }

        internal void SetProperty(string name, string value)
        {
            Check(setPropertyString(context, name, value), "设置 " + name);
        }

        internal string GetProperty(string name)
        {
            if (context == IntPtr.Zero) return null;
            IntPtr pointer = getPropertyString(context, name);
            if (pointer == IntPtr.Zero) return null;
            try { return Utf8(pointer); }
            finally { free(pointer); }
        }

        internal int Run(params string[] values)
        {
            IntPtr array = IntPtr.Zero;
            var strings = new List<IntPtr>();
            try
            {
                foreach (string value in values) strings.Add(ToUtf8(value));
                array = Marshal.AllocHGlobal(IntPtr.Size * (strings.Count + 1));
                for (int index = 0; index < strings.Count; index++) Marshal.WriteIntPtr(array, index * IntPtr.Size, strings[index]);
                Marshal.WriteIntPtr(array, strings.Count * IntPtr.Size, IntPtr.Zero);
                return command(context, array);
            }
            finally
            {
                if (array != IntPtr.Zero) Marshal.FreeHGlobal(array);
                foreach (IntPtr pointer in strings) Marshal.FreeHGlobal(pointer);
            }
        }

        internal void Open(string filePath)
        {
            pendingVideoPath = Path.GetFullPath(filePath);
            pendingSidecars = DiscoverSidecars(filePath);
            Check(Run("loadfile", filePath, "replace"), "打开视频");
        }

        private static string[] DiscoverSidecars(string filePath)
        {
            var result = new List<string>();
            string directory = Path.GetDirectoryName(filePath);
            string baseName = Path.GetFileNameWithoutExtension(filePath);
            if (string.IsNullOrWhiteSpace(directory) || string.IsNullOrWhiteSpace(baseName) || !Directory.Exists(directory)) return result.ToArray();
            try
            {
                foreach (string sidecar in Directory.GetFiles(directory))
                {
                    string extension = Path.GetExtension(sidecar).ToLowerInvariant();
                    string stem = Path.GetFileNameWithoutExtension(sidecar);
                    if ((extension == ".srt" || extension == ".ass" || extension == ".ssa" || extension == ".vtt")
                        && (string.Equals(stem, baseName, StringComparison.OrdinalIgnoreCase) || stem.StartsWith(baseName + ".", StringComparison.OrdinalIgnoreCase)))
                        result.Add(sidecar);
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            result.Sort(StringComparer.OrdinalIgnoreCase);
            return result.ToArray();
        }

        internal bool LoadPendingSidecars()
        {
            string loadedPath = GetProperty("path");
            try
            {
                if (string.IsNullOrWhiteSpace(loadedPath)
                    || !string.Equals(Path.GetFullPath(loadedPath), pendingVideoPath, StringComparison.OrdinalIgnoreCase)) return false;
            }
            catch (Exception) { return false; }
            string[] sidecars = pendingSidecars;
            pendingSidecars = new string[0];
            foreach (string sidecar in sidecars)
            {
                if (!File.Exists(sidecar)) continue;
                Check(Run("sub-add", sidecar, "auto"), "发现外挂字幕");
            }
            return true;
        }

        internal IList<Dictionary<string, object>> SubtitleTracks()
        {
            var result = new List<Dictionary<string, object>>();
            int count;
            if (!int.TryParse(GetProperty("track-list/count"), NumberStyles.Integer, CultureInfo.InvariantCulture, out count) || count <= 0) return result;
            var identityOccurrences = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < count; index++)
            {
                string prefix = "track-list/" + index.ToString(CultureInfo.InvariantCulture) + "/";
                if (!string.Equals(GetProperty(prefix + "type"), "sub", StringComparison.OrdinalIgnoreCase)) continue;
                string id = GetProperty(prefix + "id") ?? string.Empty;
                string path = GetProperty(prefix + "external-filename") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(path)) path = GetProperty(prefix + "filename") ?? string.Empty;
                bool external = !string.IsNullOrWhiteSpace(path) || IsYesValue(GetProperty(prefix + "external"));
                string language = GetProperty(prefix + "lang") ?? string.Empty;
                string title = GetProperty(prefix + "title") ?? string.Empty;
                string format = GetProperty(prefix + "codec") ?? string.Empty;
                string externalName = string.IsNullOrWhiteSpace(path) ? title : Path.GetFileName(path);
                string identityBase = external
                    ? "external:" + externalName.Replace('\\', '/').ToLowerInvariant()
                    : "embedded:" + language.ToLowerInvariant() + ":" + title.ToLowerInvariant() + ":" + format.ToLowerInvariant();
                int occurrence;
                identityOccurrences.TryGetValue(identityBase, out occurrence);
                identityOccurrences[identityBase] = occurrence + 1;
                string identity = identityBase + ":" + occurrence.ToString(CultureInfo.InvariantCulture);
                var value = new Dictionary<string, object> {
                    { "id", id }, { "stableId", identity }, { "source", external ? "external" : "embedded" },
                    { "language", language }, { "title", title }, { "format", format },
                    { "selected", IsYesValue(GetProperty(prefix + "selected")) }
                };
                if (external) value["path"] = path;
                result.Add(value);
            }
            return result;
        }

        internal void TogglePause()
        {
            if (IsAtEnd())
            {
                Play();
                return;
            }
            SetProperty("pause", IsYesValue(GetProperty("pause")) ? "no" : "yes");
        }

        internal void Play()
        {
            if (IsAtEnd()) Check(Run("seek", "0", "absolute+exact"), "重新播放视频");
            SetProperty("pause", "no");
        }

        internal void Pause()
        {
            SetProperty("pause", "yes");
        }

        internal void SeekAbsolute(double seconds)
        {
            if (IsAtEnd()) SetProperty("pause", "yes");
            Check(Run("seek", Math.Max(0, seconds).ToString(CultureInfo.InvariantCulture), "absolute+exact"), "跳转视频");
        }

        internal void SeekRelative(double seconds)
        {
            if (IsAtEnd())
            {
                double duration;
                if (!double.TryParse(GetProperty("duration"), NumberStyles.Float, CultureInfo.InvariantCulture, out duration)) duration = 0;
                SeekAbsolute(duration + seconds);
                return;
            }
            Check(Run("seek", seconds.ToString(CultureInfo.InvariantCulture), "relative+exact"), "跳转视频");
        }

        internal bool IsAtEnd()
        {
            return IsYesValue(GetProperty("eof-reached"));
        }

        internal void Screenshot(string filePath)
        {
            Check(Run("screenshot-to-file", filePath, "video"), "保存当前视频帧");
        }

        private static bool IsYesValue(string value)
        {
            return string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase) || value == "true";
        }

        internal IList<Dictionary<string, object>> DrainEvents()
        {
            var result = new List<Dictionary<string, object>>();
            if (context == IntPtr.Zero) return result;
            while (true)
            {
                IntPtr pointer = waitEvent(context, 0);
                if (pointer == IntPtr.Zero) break;
                MpvEvent current = (MpvEvent)Marshal.PtrToStructure(pointer, typeof(MpvEvent));
                if (current.EventId == 0) break;
                if (current.EventId == 6) result.Add(new Dictionary<string, object> { { "type", "loading" } });
                else if (current.EventId == 8) result.Add(new Dictionary<string, object> { { "type", "file-loaded" } });
                else if (current.EventId == 7 && current.Data != IntPtr.Zero)
                {
                    MpvEventEndFile ended = (MpvEventEndFile)Marshal.PtrToStructure(current.Data, typeof(MpvEventEndFile));
                    if (ended.Reason == 4)
                    {
                        result.Add(new Dictionary<string, object> {
                            { "type", "error" },
                            { "error", "libmpv 无法播放此视频：" + ErrorText(ended.Error) }
                        });
                    }
                    else if (ended.Reason == 0) result.Add(new Dictionary<string, object> { { "type", "ended" } });
                }
            }
            return result;
        }

        private static IntPtr ToUtf8(string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes((value ?? string.Empty) + "\0");
            IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            return pointer;
        }

        private static string Utf8(IntPtr pointer)
        {
            int length = 0;
            while (Marshal.ReadByte(pointer, length) != 0) length++;
            byte[] bytes = new byte[length];
            Marshal.Copy(pointer, bytes, 0, length);
            return Encoding.UTF8.GetString(bytes);
        }

        public void Dispose()
        {
            IntPtr current = Interlocked.Exchange(ref context, IntPtr.Zero);
            if (current != IntPtr.Zero) terminateDestroy(current);
            if (library != IntPtr.Zero) NativeMethods.FreeLibrary(library);
        }
    }

    internal sealed class DecoderHost : Form
    {
        private readonly IntPtr parentWindow;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly object outputLock = new object();
        private readonly object playerLock = new object();
        private volatile bool shuttingDown;
        private LibMpv player;
        private Thread inputThread;
        private Thread pollThread;
        private string lastState = string.Empty;
        private bool loading;
        private bool arrowKeysNavigate;
        private bool subtitleDefaultEnabled;
        private string[] subtitlePreferredLanguages = new string[0];
        private bool subtitleDefaultsPending;
        private string lastSubtitleState = string.Empty;
        private int lastPointerActivityTick;

        internal DecoderHost(IntPtr parentWindow)
        {
            this.parentWindow = parentWindow;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Left = -32000;
            Top = -32000;
            Width = 1;
            Height = 1;
            BackColor = System.Drawing.Color.Black;
        }

        protected override void OnShown(EventArgs eventArgs)
        {
            base.OnShown(eventArgs);
            try
            {
                IntPtr handle = Handle;
                long style = NativeMethods.GetWindowStyle(handle).ToInt64();
                style = (style | NativeMethods.WS_CHILD) & ~NativeMethods.WS_POPUP & ~NativeMethods.WS_CAPTION;
                NativeMethods.SetWindowStyle(handle, new IntPtr(style));
                if (NativeMethods.SetParent(handle, parentWindow) == IntPtr.Zero && Marshal.GetLastWin32Error() != 0)
                    throw new InvalidOperationException("无法把视频画面附着到 PhotoFlow 窗口");
                NativeMethods.MoveWindow(handle, 0, 0, 1, 1, true);
                player = new LibMpv(handle);
                Emit(new Dictionary<string, object> { { "type", "ready" } });
                inputThread = new Thread(ReadCommands) { IsBackground = true, Name = "PhotoFlow video command reader" };
                pollThread = new Thread(PollState) { IsBackground = true, Name = "PhotoFlow video state poller" };
                inputThread.Start();
                pollThread.Start();
            }
            catch (Exception error)
            {
                Emit(new Dictionary<string, object> { { "type", "fatal" }, { "error", error.Message } });
                BeginInvoke(new Action(Close));
            }
        }

        private void ReadCommands()
        {
            try
            {
                string line;
                while (!shuttingDown && (line = Console.In.ReadLine()) != null)
                {
                    Dictionary<string, object> command = serializer.Deserialize<Dictionary<string, object>>(line);
                    HandleCommand(command);
                }
            }
            catch (Exception error)
            {
                if (!shuttingDown) Emit(new Dictionary<string, object> { { "type", "error" }, { "error", error.Message } });
            }
            finally
            {
                if (!shuttingDown && IsHandleCreated) BeginInvoke(new Action(Close));
            }
        }

        private void HandleCommand(Dictionary<string, object> value)
        {
            string name = ReadString(value, "command");
            if (name == "set-bounds")
            {
                int x = ReadInt(value, "x");
                int y = ReadInt(value, "y");
                int width = Math.Max(1, ReadInt(value, "width"));
                int height = Math.Max(1, ReadInt(value, "height"));
                int holeX = ReadInt(value, "holeX");
                int holeY = ReadInt(value, "holeY");
                int holeWidth = ReadInt(value, "holeWidth");
                int holeHeight = ReadInt(value, "holeHeight");
                int cornerHoleX = ReadInt(value, "cornerHoleX");
                int cornerHoleY = ReadInt(value, "cornerHoleY");
                int cornerHoleWidth = ReadInt(value, "cornerHoleWidth");
                int cornerHoleHeight = ReadInt(value, "cornerHoleHeight");
                bool visible = ReadBool(value, "visible") && ReadInt(value, "width") > 0 && ReadInt(value, "height") > 0;
                BeginInvoke(new Action(() => {
                    if (shuttingDown) return;
                    NativeMethods.MoveWindow(Handle, x, y, width, height, true);
                    ApplyOverlayHoles(
                        width, height,
                        holeX, holeY, holeWidth, holeHeight,
                        cornerHoleX, cornerHoleY, cornerHoleWidth, cornerHoleHeight);
                    if (visible)
                    {
                        NativeMethods.ShowWindow(Handle, NativeMethods.SW_SHOWNOACTIVATE);
                        NativeMethods.SetWindowPos(Handle, IntPtr.Zero, x, y, width, height, NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW);
                    }
                    else NativeMethods.ShowWindow(Handle, NativeMethods.SW_HIDE);
                }));
                return;
            }
            if (name == "close")
            {
                BeginInvoke(new Action(Close));
                return;
            }
            if (name == "set-keyboard-mode")
            {
                arrowKeysNavigate = ReadString(value, "value") == "navigate";
                return;
            }
            if (name == "set-subtitle-defaults")
            {
                subtitleDefaultEnabled = ReadBool(value, "enabled");
                object languages;
                var list = new List<string>();
                if (value.TryGetValue("preferredLanguages", out languages) && languages is object[])
                    foreach (object language in (object[])languages) if (language != null) list.Add(language.ToString().Trim().ToLowerInvariant());
                subtitlePreferredLanguages = list.ToArray();
                subtitleDefaultsPending = true;
                lock (playerLock)
                {
                    if (player != null) ApplySubtitleStyle(player, ReadString(value, "size"), ReadString(value, "style"));
                }
                return;
            }
            lock (playerLock)
            {
                if (player == null) return;
                if (name == "open")
                {
                    string path = ReadString(value, "path");
                    if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("视频路径为空");
                    loading = true;
                    subtitleDefaultsPending = true;
                    player.Open(path);
                }
                else if (name == "play") player.Play();
                else if (name == "pause") player.Pause();
                else if (name == "seek") player.SeekAbsolute(ReadDouble(value, "value"));
                else if (name == "volume") player.SetProperty("volume", Math.Max(0, Math.Min(100, ReadDouble(value, "value"))).ToString(CultureInfo.InvariantCulture));
                else if (name == "mute") player.SetProperty("mute", ReadBool(value, "value") ? "yes" : "no");
                else if (name == "speed") player.SetProperty("speed", Math.Max(0.25, Math.Min(4, ReadDouble(value, "value"))).ToString(CultureInfo.InvariantCulture));
                else if (name == "subtitle-select")
                {
                    string id = ReadString(value, "value");
                    player.SetProperty("sid", string.IsNullOrWhiteSpace(id) ? "no" : id);
                    player.SetProperty("sub-visibility", string.IsNullOrWhiteSpace(id) ? "no" : "yes");
                }
                else if (name == "subtitle-visible") player.SetProperty("sub-visibility", ReadBool(value, "value") ? "yes" : "no");
                else if (name == "subtitle-delay") player.SetProperty("sub-delay", Math.Max(-30, Math.Min(30, ReadDouble(value, "value"))).ToString(CultureInfo.InvariantCulture));
                else if (name == "subtitle-style") ApplySubtitleStyle(player, ReadString(value, "size"), ReadString(value, "style"));
                else if (name == "subtitle-add")
                {
                    string subtitlePath = ReadString(value, "path");
                    if (!Path.IsPathRooted(subtitlePath) || !File.Exists(subtitlePath)) throw new FileNotFoundException("字幕文件不存在", subtitlePath);
                    string extension = Path.GetExtension(subtitlePath).ToLowerInvariant();
                    if (extension != ".srt" && extension != ".ass" && extension != ".ssa" && extension != ".vtt") throw new InvalidOperationException("字幕格式不受支持");
                    int result = player.Run("sub-add", subtitlePath, "select");
                    if (result < 0) throw new InvalidOperationException("字幕文件损坏或无法加载");
                    player.SetProperty("sub-visibility", "yes");
                }
                else if (name == "screenshot")
                {
                    string requestId = ReadString(value, "requestId");
                    string targetPath = ReadString(value, "path");
                    try
                    {
                        if (string.IsNullOrWhiteSpace(targetPath) || !Path.IsPathRooted(targetPath))
                            throw new InvalidOperationException("截图保存路径无效");
                        player.Screenshot(targetPath);
                        if (!WaitForCompletePng(targetPath, 7000))
                            throw new IOException("视频截图文件在超时前未完整写入");
                        Emit(new Dictionary<string, object> {
                            { "type", "screenshot-result" }, { "requestId", requestId },
                            { "success", true }, { "path", targetPath }
                        });
                    }
                    catch (Exception error)
                    {
                        try { if (File.Exists(targetPath)) File.Delete(targetPath); } catch { }
                        Emit(new Dictionary<string, object> {
                            { "type", "screenshot-result" }, { "requestId", requestId },
                            { "success", false }, { "error", error.Message }
                        });
                    }
                }
                else if (name == "stop") player.Run("stop");
            }
        }

        protected override void OnMouseClick(MouseEventArgs eventArgs)
        {
            base.OnMouseClick(eventArgs);
            if (shuttingDown) return;
            if (eventArgs.Button == MouseButtons.Left)
            {
                lock (playerLock)
                {
                    if (player != null) player.TogglePause();
                }
            }
            else if (eventArgs.Button == MouseButtons.Right)
                Emit(new Dictionary<string, object> {
                    { "type", "context-menu" }, { "x", eventArgs.X }, { "y", eventArgs.Y }
                });
        }

        private static void ApplySubtitleStyle(LibMpv player, string size, string style)
        {
            player.SetProperty("sub-scale", size == "large" ? "1.35" : "1.0");
            player.SetProperty("sub-border-size", style == "high-contrast" ? "4" : "2.5");
            player.SetProperty("sub-shadow-offset", style == "high-contrast" ? "2" : "1");
        }

        private static bool SubtitleLanguageMatches(string trackLanguage, string preferredLanguage)
        {
            string track = (trackLanguage ?? string.Empty).Trim().Replace('_', '-');
            string preferred = (preferredLanguage ?? string.Empty).Trim().Replace('_', '-');
            return string.Equals(track, preferred, StringComparison.OrdinalIgnoreCase)
                || track.StartsWith(preferred + "-", StringComparison.OrdinalIgnoreCase)
                || preferred.StartsWith(track + "-", StringComparison.OrdinalIgnoreCase);
        }

        private static void ExcludeOverlayHole(System.Drawing.Region region, int width, int height, int holeX, int holeY, int holeWidth, int holeHeight)
        {
            if (holeWidth <= 0 || holeHeight <= 0) return;
            int left = Math.Max(0, Math.Min(width, holeX));
            int top = Math.Max(0, Math.Min(height, holeY));
            int clippedWidth = Math.Max(0, Math.Min(width - left, holeWidth));
            int clippedHeight = Math.Max(0, Math.Min(height - top, holeHeight));
            if (clippedWidth > 0 && clippedHeight > 0)
                region.Exclude(new Rectangle(left, top, clippedWidth, clippedHeight));
        }

        private void ApplyOverlayHoles(
            int width, int height,
            int holeX, int holeY, int holeWidth, int holeHeight,
            int cornerHoleX, int cornerHoleY, int cornerHoleWidth, int cornerHoleHeight)
        {
            System.Drawing.Region previous = Region;
            bool hasPanelHole = holeWidth > 0 && holeHeight > 0;
            bool hasCornerHole = cornerHoleWidth > 0 && cornerHoleHeight > 0;
            if (hasPanelHole || hasCornerHole)
            {
                var next = new System.Drawing.Region(new Rectangle(0, 0, width, height));
                ExcludeOverlayHole(next, width, height, holeX, holeY, holeWidth, holeHeight);
                ExcludeOverlayHole(next, width, height, cornerHoleX, cornerHoleY, cornerHoleWidth, cornerHoleHeight);
                Region = next;
            }
            else Region = null;
            if (previous != null) previous.Dispose();
        }

        protected override void OnMouseMove(MouseEventArgs eventArgs)
        {
            base.OnMouseMove(eventArgs);
            int now = Environment.TickCount;
            if (unchecked(now - lastPointerActivityTick) < 200) return;
            lastPointerActivityTick = now;
            Emit(new Dictionary<string, object> { { "type", "pointer-activity" } });
        }

        protected override bool ProcessCmdKey(ref Message message, Keys keyData)
        {
            Keys key = keyData & Keys.KeyCode;
            if (key == Keys.Escape)
            {
                Emit(new Dictionary<string, object> { { "type", "escape" } });
                return base.ProcessCmdKey(ref message, keyData);
            }
            if (key == Keys.Left || key == Keys.Right)
            {
                HandleArrowKeyInput(key == Keys.Right ? 1 : -1);
                return true;
            }
            return base.ProcessCmdKey(ref message, keyData);
        }

        private void HandleArrowKeyInput(int direction)
        {
            if (arrowKeysNavigate)
            {
                Emit(new Dictionary<string, object> { { "type", "navigate" }, { "direction", direction } });
                return;
            }
            lock (playerLock)
            {
                if (player != null) player.SeekRelative(direction * 5);
            }
        }

        private static bool WaitForCompletePng(string filePath, int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    using (FileStream stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    {
                        if (stream.Length >= 20)
                        {
                            byte[] header = new byte[8];
                            byte[] trailer = new byte[12];
                            if (stream.Read(header, 0, header.Length) == header.Length)
                            {
                                stream.Seek(-trailer.Length, SeekOrigin.End);
                                if (stream.Read(trailer, 0, trailer.Length) == trailer.Length)
                                {
                                    bool valid = header[0] == 137 && header[1] == 80 && header[2] == 78 && header[3] == 71
                                        && header[4] == 13 && header[5] == 10 && header[6] == 26 && header[7] == 10;
                                    if (valid && trailer[0] == 0 && trailer[1] == 0 && trailer[2] == 0 && trailer[3] == 0
                                        && trailer[4] == (byte)'I' && trailer[5] == (byte)'E' && trailer[6] == (byte)'N' && trailer[7] == (byte)'D')
                                        return true;
                                }
                            }
                        }
                    }
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                Thread.Sleep(40);
            }
            return false;
        }

        private void PollState()
        {
            while (!shuttingDown)
            {
                try
                {
                    lock (playerLock)
                    {
                        if (player != null)
                        {
                            foreach (Dictionary<string, object> eventValue in player.DrainEvents())
                            {
                                string type = ReadString(eventValue, "type");
                                if (type == "file-loaded")
                                {
                                    // Ignore a stale event from a superseded loadfile command.
                                    if (!player.LoadPendingSidecars()) continue;
                                    loading = false;
                                    subtitleDefaultsPending = true;
                                }
                                Emit(eventValue);
                            }
                            IList<Dictionary<string, object>> subtitleTracks = player.SubtitleTracks();
                            if (subtitleDefaultsPending && !loading)
                            {
                                subtitleDefaultsPending = false;
                                string selectedId = null;
                                if (subtitleDefaultEnabled)
                                {
                                    foreach (string language in subtitlePreferredLanguages)
                                    {
                                        foreach (Dictionary<string, object> track in subtitleTracks)
                                        {
                                            if (!SubtitleLanguageMatches(Convert.ToString(track["language"]), language)) continue;
                                            selectedId = Convert.ToString(track["id"]);
                                            break;
                                        }
                                        if (selectedId != null) break;
                                    }
                                    if (selectedId == null && subtitleTracks.Count > 0) selectedId = Convert.ToString(subtitleTracks[0]["id"]);
                                }
                                player.SetProperty("sid", selectedId ?? "no");
                                player.SetProperty("sub-visibility", selectedId == null ? "no" : "yes");
                            }
                            var subtitleState = new Dictionary<string, object> {
                                { "type", "subtitle-tracks" }, { "subtitleTracks", subtitleTracks },
                                { "subtitleTrackId", player.GetProperty("sid") },
                                { "subtitleVisible", IsYes(player.GetProperty("sub-visibility")) },
                                { "subtitleDelay", ReadNumber(player.GetProperty("sub-delay")) }
                            };
                            string serializedSubtitleState = serializer.Serialize(subtitleState);
                            if (serializedSubtitleState != lastSubtitleState) { lastSubtitleState = serializedSubtitleState; EmitSerialized(serializedSubtitleState); }
                            var state = new Dictionary<string, object> {
                                { "type", "state" },
                                { "time", ReadNumber(player.GetProperty("time-pos")) },
                                { "duration", ReadNumber(player.GetProperty("duration")) },
                                { "paused", player.IsAtEnd() || IsYes(player.GetProperty("pause")) },
                                { "buffering", loading || IsYes(player.GetProperty("paused-for-cache")) },
                                { "muted", IsYes(player.GetProperty("mute")) },
                                { "volume", ReadNumber(player.GetProperty("volume"), 100) },
                                { "speed", ReadNumber(player.GetProperty("speed"), 1) },
                                { "width", ReadNumber(player.GetProperty("width")) },
                                { "height", ReadNumber(player.GetProperty("height")) }
                            };
                            string serialized = serializer.Serialize(state);
                            if (serialized != lastState)
                            {
                                lastState = serialized;
                                EmitSerialized(serialized);
                            }
                        }
                    }
                }
                catch (Exception error)
                {
                    if (!shuttingDown) Emit(new Dictionary<string, object> { { "type", "error" }, { "error", error.Message } });
                }
                Thread.Sleep(150);
            }
        }

        private void Emit(Dictionary<string, object> value)
        {
            EmitSerialized(serializer.Serialize(value));
        }

        private void EmitSerialized(string value)
        {
            lock (outputLock)
            {
                Console.Out.WriteLine(value);
                Console.Out.Flush();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs eventArgs)
        {
            shuttingDown = true;
            lock (playerLock)
            {
                if (player != null)
                {
                    player.Dispose();
                    player = null;
                }
            }
            base.OnFormClosing(eventArgs);
        }

        private static string ReadString(Dictionary<string, object> source, string name)
        {
            object value;
            return source != null && source.TryGetValue(name, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : string.Empty;
        }

        private static int ReadInt(Dictionary<string, object> source, string name)
        {
            return (int)Math.Round(ReadDouble(source, name));
        }

        private static double ReadDouble(Dictionary<string, object> source, string name)
        {
            object value;
            if (source == null || !source.TryGetValue(name, out value) || value == null) return 0;
            double number;
            return double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out number) ? number : 0;
        }

        private static bool ReadBool(Dictionary<string, object> source, string name)
        {
            object value;
            if (source == null || !source.TryGetValue(name, out value) || value == null) return false;
            if (value is bool) return (bool)value;
            bool result;
            return bool.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out result) && result;
        }

        private static bool IsYes(string value)
        {
            return string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase) || value == "true";
        }

        private static double ReadNumber(string value, double fallback = 0)
        {
            double number;
            return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number) && !double.IsNaN(number) && !double.IsInfinity(number) ? number : fallback;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            try { NativeMethods.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            long parent = 0;
            bool probeOnly = false;
            foreach (string argument in args) if (argument == "--probe") probeOnly = true;
            for (int index = 0; index + 1 < args.Length; index++)
                if (args[index] == "--parent-hwnd") long.TryParse(args[index + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out parent);
            if (probeOnly)
            {
                try
                {
                    using (var player = new LibMpv(IntPtr.Zero, true))
                    {
                        var serializer = new JavaScriptSerializer();
                        Console.Out.WriteLine(serializer.Serialize(new Dictionary<string, object> {
                            { "type", "probe" },
                            { "success", true },
                            { "version", player.GetProperty("mpv-version") ?? string.Empty }
                        }));
                        Console.Out.Flush();
                    }
                    return 0;
                }
                catch (Exception error)
                {
                    var serializer = new JavaScriptSerializer();
                    Console.Out.WriteLine(serializer.Serialize(new Dictionary<string, object> {
                        { "type", "probe" }, { "success", false }, { "error", error.Message }
                    }));
                    Console.Out.Flush();
                    return 3;
                }
            }
            if (parent == 0)
            {
                Console.Out.WriteLine("{\"type\":\"fatal\",\"error\":\"缺少 PhotoFlow 父窗口句柄\"}");
                return 2;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new DecoderHost(new IntPtr(parent)));
            return 0;
        }
    }
}
