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
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr LoadLibrary(string fileName);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool FreeLibrary(IntPtr module);

        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true)]
        internal static extern IntPtr GetProcAddress(IntPtr module, string name);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern bool SetDllDirectory(string path);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("kernel32.dll")] internal static extern uint GetCurrentProcessId();
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
        private const string Protocol = "media-playback-backend-v1";
        private const int MaxFrameBytes = 256 * 1024;
        private static readonly Dictionary<string, string> CommandNames = new Dictionary<string, string> {
            { "media.open", "open" }, { "playback.play", "play" }, { "playback.pause", "pause" }, { "playback.seek", "seek" }, { "audio.volume", "volume" }, { "audio.mute", "mute" }, { "playback.speed", "speed" }, { "playback.stop", "stop" },
            { "subtitles.select", "subtitle-select" }, { "subtitles.visible", "subtitle-visible" }, { "subtitles.delay", "subtitle-delay" }, { "subtitles.style", "subtitle-style" }, { "subtitles.add", "subtitle-add" },
            { "capture.stage", "screenshot" }, { "video.transform", "transform" }, { "video.hdr-mode", "hdr-mode" }, { "statistics.level", "statistics-level" }, { "display.output", "display-output" }
        };
        private static readonly Dictionary<string, string> EventNames = new Dictionary<string, string> {
            { "ready", "runtime.ready" }, { "surface-created", "surface.created" }, { "state", "state.changed" }, { "loading", "state.loading" }, { "file-loaded", "media.loaded" }, { "ended", "media.ended" }, { "subtitle-tracks", "tracks.changed" }, { "statistics", "statistics.changed" }, { "input", "input.raw" }, { "screenshot-result", "capture.completed" }, { "diagnostic", "diagnostic" }, { "fatal", "fatal" }, { "error", "error" }, { "stopped", "terminated" }
        };
        private readonly string sessionId;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly object outputLock = new object();
        private readonly object playerLock = new object();
        private volatile bool shuttingDown;
        private LibMpv player;
        private Thread inputThread;
        private Thread pollThread;
        private string lastState = string.Empty;
        private bool loading;
        private string lastSubtitleState = string.Empty;
        private int lastPointerActivityTick;
        private Point lastPointerLocation;
        private bool hasLastPointerLocation;
        private long eventSequence;
        private long commandSequence;
        private string statisticsLevel = "off";
        private DateTime lastStatisticsAt = DateTime.MinValue;
        private string requestedHdrMode = "auto";
        private bool hdrDisplayAvailable;

        internal DecoderHost(string sessionId)
        {
            this.sessionId = sessionId;
            serializer.MaxJsonLength = MaxFrameBytes;
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
                player = new LibMpv(handle);
                Emit(new Dictionary<string, object> { { "type", "surface-created" }, { "surfaceHandle", handle.ToInt64().ToString(CultureInfo.InvariantCulture) }, { "processId", NativeMethods.GetCurrentProcessId() } });
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
                    if (Encoding.UTF8.GetByteCount(line) > MaxFrameBytes) throw new InvalidOperationException("播放协议帧超过 256 KiB");
                    Dictionary<string, object> envelope = serializer.Deserialize<Dictionary<string, object>>(line);
                    if (ReadString(envelope, "protocol") != Protocol || ReadInt(envelope, "protocolVersion") != 1 || ReadString(envelope, "sessionId") != sessionId) throw new InvalidOperationException("播放协议会话不匹配");
                    long sequence = (long)ReadDouble(envelope, "sequence");
                    if (sequence <= commandSequence) throw new InvalidOperationException("播放协议命令顺序无效");
                    commandSequence = sequence;
                    string eventName = ReadString(envelope, "event");
                    if (!eventName.StartsWith("command.", StringComparison.Ordinal)) throw new InvalidOperationException("播放协议命令类型无效");
                    object rawPayload;
                    Dictionary<string, object> command = envelope.TryGetValue("payload", out rawPayload) ? rawPayload as Dictionary<string, object> : null;
                    if (command == null) command = new Dictionary<string, object>();
                    string semantic = eventName.Substring("command.".Length), legacyName;
                    if (!CommandNames.TryGetValue(semantic, out legacyName)) throw new InvalidOperationException("播放协议命令未知");
                    command["command"] = legacyName;
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
            if (name == "close")
            {
                BeginInvoke(new Action(Close));
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
                else if (name == "subtitle-style") ApplySubtitleStyle(player, ReadSubtitleFontSize(value), ReadString(value, "style"));
                else if (name == "transform")
                {
                    object raw; var transform = value.TryGetValue("transform", out raw) ? raw as Dictionary<string, object> : null;
                    string aspect = ReadString(transform, "aspectMode"); int rotation = ReadInt(transform, "rotation");
                    player.SetProperty("video-rotate", rotation.ToString(CultureInfo.InvariantCulture));
                    player.SetProperty("video-aspect-override", aspect == "16:9" ? "16:9" : aspect == "4:3" ? "4:3" : aspect == "1:1" ? "1:1" : "no");
                    player.SetProperty("panscan", aspect == "cover" ? "1" : "0");
                    bool horizontal = ReadBool(transform, "flipHorizontal"), vertical = ReadBool(transform, "flipVertical");
                    player.SetProperty("vf", horizontal && vertical ? "hflip,vflip" : horizontal ? "hflip" : vertical ? "vflip" : "");
                }
                else if (name == "hdr-mode")
                {
                    requestedHdrMode = ReadString(value, "hdrMode"); ApplyHdrMode(player);
                }
                else if (name == "display-output")
                {
                    object raw; var output = value.TryGetValue("output", out raw) ? raw as Dictionary<string, object> : null;
                    hdrDisplayAvailable = ReadBool(output, "hdrAvailable"); ApplyHdrMode(player);
                }
                else if (name == "statistics-level") statisticsLevel = ReadString(value, "statisticsLevel");
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
            if (eventArgs.Button == MouseButtons.Left || eventArgs.Button == MouseButtons.Right)
                Emit(new Dictionary<string, object> {
                    { "type", "input" },
                    { "input", new Dictionary<string, object> {
                        { "kind", "pointer-button" },
                        { "button", eventArgs.Button == MouseButtons.Left ? "left" : "right" },
                        { "x", eventArgs.X }, { "y", eventArgs.Y }, { "clickCount", eventArgs.Clicks },
                        { "ctrl", (Control.ModifierKeys & Keys.Control) != 0 }, { "alt", (Control.ModifierKeys & Keys.Alt) != 0 }, { "shift", (Control.ModifierKeys & Keys.Shift) != 0 }, { "meta", false }
                    } }
                });
        }

        private static int ReadSubtitleFontSize(Dictionary<string, object> value)
        {
            int fontSize = ReadInt(value, "fontSize");
            if (fontSize <= 0) fontSize = ReadString(value, "size") == "large" ? 74 : 55;
            return Math.Max(16, Math.Min(120, fontSize));
        }

        private static void ApplySubtitleStyle(LibMpv player, int fontSize, string style)
        {
            int normalized = Math.Max(16, Math.Min(120, fontSize));
            player.SetProperty("sub-font-size", "55");
            player.SetProperty("sub-scale", (normalized / 55.0).ToString("0.###", CultureInfo.InvariantCulture));
            player.SetProperty("sub-border-size", style == "high-contrast" ? "4" : "2.5");
            player.SetProperty("sub-shadow-offset", style == "high-contrast" ? "2" : "1");
        }

        protected override void OnMouseMove(MouseEventArgs eventArgs)
        {
            base.OnMouseMove(eventArgs);
            if (hasLastPointerLocation && eventArgs.Location == lastPointerLocation) return;
            lastPointerLocation = eventArgs.Location;
            hasLastPointerLocation = true;
            int now = Environment.TickCount;
            if (unchecked(now - lastPointerActivityTick) < 200) return;
            lastPointerActivityTick = now;
            Emit(new Dictionary<string, object> {
                { "type", "input" },
                { "input", new Dictionary<string, object> { { "kind", "pointer-move" }, { "x", eventArgs.X }, { "y", eventArgs.Y } } }
            });
        }

        protected override bool ProcessCmdKey(ref Message message, Keys keyData)
        {
            Keys key = keyData & Keys.KeyCode;
            if ((key == Keys.F4 && (keyData & Keys.Alt) != 0) || key == Keys.LWin || key == Keys.RWin) return base.ProcessCmdKey(ref message, keyData);
            string code = DomCode(key);
            if (!string.IsNullOrEmpty(code)) {
                string rawKey = key == Keys.Space ? " " : key == Keys.Escape ? "Escape" : key.ToString();
                Emit(new Dictionary<string, object> {
                    { "type", "input" },
                    { "input", new Dictionary<string, object> { { "kind", "key" }, { "key", rawKey }, { "code", code },
                        { "ctrl", (keyData & Keys.Control) != 0 }, { "alt", (keyData & Keys.Alt) != 0 }, { "shift", (keyData & Keys.Shift) != 0 }, { "meta", false },
                        { "repeat", (message.LParam.ToInt64() & (1L << 30)) != 0 } } }
                });
                return true;
            }
            return base.ProcessCmdKey(ref message, keyData);
        }

        private static string DomCode(Keys key)
        {
            if (key >= Keys.A && key <= Keys.Z) return "Key" + key.ToString();
            if (key >= Keys.D0 && key <= Keys.D9) return "Digit" + ((int)key - (int)Keys.D0).ToString(CultureInfo.InvariantCulture);
            if (key == Keys.Left) return "ArrowLeft"; if (key == Keys.Right) return "ArrowRight"; if (key == Keys.Up) return "ArrowUp"; if (key == Keys.Down) return "ArrowDown";
            if (key == Keys.Space) return "Space"; if (key == Keys.Escape) return "Escape"; if (key == Keys.PageUp) return "PageUp"; if (key == Keys.PageDown) return "PageDown";
            if (key == Keys.Oemcomma) return "Comma"; if (key == Keys.OemPeriod) return "Period"; if (key == Keys.OemOpenBrackets) return "BracketLeft"; if (key == Keys.OemCloseBrackets) return "BracketRight"; if (key == Keys.OemPipe) return "Backslash";
            return string.Empty;
        }

        private void ApplyHdrMode(LibMpv target)
        {
            bool passthrough = requestedHdrMode == "hdr-passthrough" && hdrDisplayAvailable;
            target.SetProperty("target-colorspace-hint", passthrough ? "yes" : "no");
            target.SetProperty("tone-mapping", requestedHdrMode == "sdr" ? "clip" : "auto");
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
                                }
                                Emit(eventValue);
                            }
                            IList<Dictionary<string, object>> subtitleTracks = player.SubtitleTracks();
                            var subtitleState = new Dictionary<string, object> {
                                { "type", "subtitle-tracks" }, { "subtitleTracks", subtitleTracks },
                                { "subtitleTrackId", player.GetProperty("sid") },
                                { "subtitleVisible", IsYes(player.GetProperty("sub-visibility")) },
                                { "subtitleDelay", ReadNumber(player.GetProperty("sub-delay")) }
                            };
                            string serializedSubtitleState = serializer.Serialize(subtitleState);
                            if (serializedSubtitleState != lastSubtitleState) { lastSubtitleState = serializedSubtitleState; Emit(subtitleState); }
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
                                Emit(state);
                            }
                            int statisticsInterval = statisticsLevel == "detailed" ? 250 : 1000;
                            if (statisticsLevel != "off" && (DateTime.UtcNow - lastStatisticsAt).TotalMilliseconds >= statisticsInterval)
                            {
                                lastStatisticsAt = DateTime.UtcNow;
                                Emit(new Dictionary<string, object> {
                                    { "type", "statistics" }, { "statistics", new Dictionary<string, object> {
                                        { "level", statisticsLevel == "detailed" ? "detailed" : "basic" },
                                        { "videoCodec", player.GetProperty("video-codec") ?? string.Empty },
                                        { "audioCodec", player.GetProperty("audio-codec-name") ?? string.Empty },
                                        { "decoder", player.GetProperty("video-dec-params/codec") ?? string.Empty },
                                        { "hardwareDecoding", !string.IsNullOrWhiteSpace(player.GetProperty("hwdec-current")) },
                                        { "droppedFrames", ReadNumber(player.GetProperty("decoder-frame-drop-count")) },
                                        { "fps", ReadNumber(player.GetProperty("estimated-vf-fps")) },
                                        { "avSyncMs", ReadNumber(player.GetProperty("avsync")) * 1000 },
                                        { "cacheSeconds", ReadNumber(player.GetProperty("demuxer-cache-duration")) },
                                        { "output", "D3D11/libmpv" }
                                    } }
                                });
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
            string eventName = ReadString(value, "type");
            var payload = new Dictionary<string, object>(value);
            payload.Remove("type");
            string semanticEvent;
            if (!EventNames.TryGetValue(eventName, out semanticEvent)) throw new InvalidOperationException("播放协议事件未知");
            var envelope = new Dictionary<string, object> {
                { "protocol", Protocol }, { "protocolVersion", 1 }, { "sessionId", sessionId }, { "sequence", Interlocked.Increment(ref eventSequence) },
                { "timestamp", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds },
                { "event", "event." + semanticEvent }, { "payload", payload }
            };
            string serialized = serializer.Serialize(envelope);
            if (Encoding.UTF8.GetByteCount(serialized) > MaxFrameBytes) throw new InvalidOperationException("播放协议事件帧超过 256 KiB");
            lock (outputLock)
            {
                Console.Out.WriteLine(serialized);
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
            string sessionId = string.Empty;
            bool probeOnly = false;
            foreach (string argument in args) if (argument == "--probe") probeOnly = true;
            for (int index = 0; index + 1 < args.Length; index++)
            {
                if (args[index] == "--session-id") sessionId = args[index + 1];
            }
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
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                Console.Error.WriteLine("缺少 PhotoFlow 宿主参数");
                return 2;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new DecoderHost(sessionId));
            return 0;
        }
    }
}
