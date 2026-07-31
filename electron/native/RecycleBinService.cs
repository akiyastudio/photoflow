using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class RecycleBinService
{
    private const uint FOF_SILENT = 0x0004;
    private const uint FOF_NOCONFIRMATION = 0x0010;
    private const uint FOF_ALLOWUNDO = 0x0040;
    private const uint FOF_NOERRORUI = 0x0400;
    private const uint FOF_WANTNUKEWARNING = 0x4000;
    private const uint FOFX_RECYCLEONDELETE = 0x00080000;
    private const uint FOFX_ADDUNDORECORD = 0x20000000;
    private const uint SIGDN_NORMALDISPLAY = 0;

    [STAThread]
    private static int Main(string[] args)
    {
        // Node writes batch JSON as UTF-8.  On Chinese Windows a redirected
        // console otherwise defaults to the legacy system code page, which can
        // consume one byte of a JSON path escape and produce an "unrecognized
        // escape sequence" error for Chinese file names.
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        try
        {
            if (args.Length < 1) throw new ArgumentException("缺少操作名称");
            var options = ParseOptions(args);
            object result;
            if (args[0] == "trash") result = Trash(Required(options, "path"));
            else if (args[0] == "trash-many") result = TrashMany(ReadPaths());
            else if (args[0] == "restore") result = Restore(Required(options, "pidl"), Required(options, "target"));
            else if (args[0] == "probe") result = Probe(Required(options, "pidl"));
            else if (args[0] == "check") result = Check(Required(options, "directory"));
            else throw new ArgumentException("不支持的操作：" + args[0]);
            WriteJson(result);
            return 0;
        }
        catch (Exception error)
        {
            WriteJson(new Dictionary<string, object> {
                { "success", false },
                { "error", error.Message },
                { "hresult", error.HResult }
            });
            return 1;
        }
    }

    private static object Check(string requestedDirectory)
    {
        var directory = Path.GetFullPath(requestedDirectory);
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("检测目录不存在");
        var canary = Path.Combine(directory, ".photoflow-recycle-check-" + Guid.NewGuid().ToString("N") + ".tmp");
        File.WriteAllText(canary, "Photoflow recycle capability check");
        try
        {
            Dictionary<string, object> recycled;
            try { recycled = (Dictionary<string, object>)Trash(canary); }
            catch (Exception error)
            {
                return new Dictionary<string, object> { { "success", true }, { "supported", false }, { "reason", error.Message } };
            }
            var pidl = Convert.ToString(recycled["recyclePidl"]);
            try { Restore(pidl, canary); }
            catch (Exception error)
            {
                return new Dictionary<string, object> { { "success", true }, { "supported", false }, { "reason", "回收站项目无法还原：" + error.Message } };
            }
            return new Dictionary<string, object> { { "success", true }, { "supported", true } };
        }
        finally
        {
            if (File.Exists(canary)) File.Delete(canary);
        }
    }

    private static object Trash(string requestedPath)
    {
        var sourcePath = Path.GetFullPath(requestedPath);
        if (!File.Exists(sourcePath) && !Directory.Exists(sourcePath)) throw new FileNotFoundException("文件或文件夹不存在", sourcePath);

        IShellItem source;
        ThrowIfFailed(SHCreateItemFromParsingName(sourcePath, IntPtr.Zero, typeof(IShellItem).GUID, out source));
        var operation = (IFileOperation)new FileOperation();
        var sink = new ProgressSink();
        uint cookie;
        ThrowIfFailed(operation.Advise(sink, out cookie));
        try
        {
            // Skip the routine second confirmation after PhotoFlow's own dialog,
            // but let Windows show its standard warning when recycling is not
            // possible and the item would be deleted permanently.
            ThrowIfFailed(operation.SetOperationFlags(FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING | FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD));
            ThrowIfFailed(operation.DeleteItem(source, null));
            ThrowIfFailed(operation.PerformOperations());
            bool aborted;
            ThrowIfFailed(operation.GetAnyOperationsAborted(out aborted));
            if (aborted) throw new OperationCanceledException("系统取消了删除操作");
            if (sink.DeleteResult < 0) Marshal.ThrowExceptionForHR(sink.DeleteResult);
            var permanent = sink.RecycledPidl == null || sink.RecycledPidl.Length == 0;
            if (permanent && (File.Exists(sourcePath) || Directory.Exists(sourcePath)))
                throw new InvalidOperationException("Windows 未能删除该文件或文件夹");
            return new Dictionary<string, object> {
                { "success", true },
                { "originalPath", sourcePath },
                { "recyclePidl", permanent ? "" : Convert.ToBase64String(sink.RecycledPidl) },
                { "preciseRestore", !permanent },
                { "permanent", permanent }
            };
        }
        finally
        {
            operation.Unadvise(cookie);
            Release(source);
            Release(operation);
        }
    }

    private static string[] ReadPaths()
    {
        var input = Console.In.ReadToEnd();
        var paths = new JavaScriptSerializer().Deserialize<string[]>(input);
        if (paths == null || paths.Length == 0) throw new ArgumentException("没有要删除的文件或文件夹");
        if (paths.Length > 500) throw new ArgumentException("单次最多删除 500 个项目");
        return paths;
    }

    private static object TrashMany(string[] requestedPaths)
    {
        var sourcePaths = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var requestedPath in requestedPaths)
        {
            var sourcePath = Path.GetFullPath(requestedPath);
            if (!File.Exists(sourcePath) && !Directory.Exists(sourcePath)) throw new FileNotFoundException("文件或文件夹不存在", sourcePath);
            if (seen.Add(sourcePath)) sourcePaths.Add(sourcePath);
        }

        var operation = (IFileOperation)new FileOperation();
        var sources = new List<IShellItem>();
        var sinks = new List<ProgressSink>();
        try
        {
            ThrowIfFailed(operation.SetOperationFlags(FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING | FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD));
            foreach (var sourcePath in sourcePaths)
            {
                IShellItem source;
                ThrowIfFailed(SHCreateItemFromParsingName(sourcePath, IntPtr.Zero, typeof(IShellItem).GUID, out source));
                var sink = new ProgressSink();
                sources.Add(source);
                sinks.Add(sink);
                ThrowIfFailed(operation.DeleteItem(source, sink));
            }

            var operationResult = operation.PerformOperations();
            bool aborted = false;
            if (operationResult >= 0) ThrowIfFailed(operation.GetAnyOperationsAborted(out aborted));
            var items = new List<Dictionary<string, object>>();
            for (var index = 0; index < sourcePaths.Count; index++)
            {
                var sourcePath = sourcePaths[index];
                var sink = sinks[index];
                var itemResult = sink.DeleteCompleted ? sink.DeleteResult : operationResult;
                if (!sink.DeleteCompleted || itemResult < 0)
                {
                    items.Add(new Dictionary<string, object> {
                        { "success", false },
                        { "originalPath", sourcePath },
                        { "error", itemResult < 0 ? ErrorMessage(itemResult) : aborted ? "系统取消了删除操作" : "Windows 未能删除该文件或文件夹" },
                        { "hresult", itemResult }
                    });
                    continue;
                }
                var permanent = sink.RecycledPidl == null || sink.RecycledPidl.Length == 0;
                var stillExists = File.Exists(sourcePath) || Directory.Exists(sourcePath);
                if (permanent && stillExists)
                {
                    items.Add(new Dictionary<string, object> {
                        { "success", false },
                        { "originalPath", sourcePath },
                        { "error", "Windows 未能删除该文件或文件夹" }
                    });
                    continue;
                }
                items.Add(new Dictionary<string, object> {
                    { "success", true },
                    { "originalPath", sourcePath },
                    { "recyclePidl", permanent ? "" : Convert.ToBase64String(sink.RecycledPidl) },
                    { "preciseRestore", !permanent },
                    { "permanent", permanent }
                });
            }
            return new Dictionary<string, object> {
                { "success", true },
                { "aborted", aborted },
                { "items", items }
            };
        }
        finally
        {
            foreach (var source in sources) Release(source);
            Release(operation);
        }
    }

    private static string ErrorMessage(int result)
    {
        try { Marshal.ThrowExceptionForHR(result); }
        catch (Exception error) { return error.Message; }
        return "Windows 回收站操作失败";
    }

    private static object Restore(string encodedPidl, string requestedTarget)
    {
        var targetPath = Path.GetFullPath(requestedTarget);
        if (File.Exists(targetPath) || Directory.Exists(targetPath))
            return new Dictionary<string, object> { { "success", false }, { "code", "DESTINATION_EXISTS" }, { "error", "原位置已有同名文件或文件夹" } };
        var parentPath = Path.GetDirectoryName(targetPath);
        if (String.IsNullOrEmpty(parentPath)) throw new InvalidOperationException("无法确定恢复目录");
        Directory.CreateDirectory(parentPath);

        var pidl = DecodePidl(encodedPidl);
        IShellItem recycled = null;
        IShellItem destination = null;
        try
        {
            ThrowIfFailed(SHCreateItemFromIDList(pidl, typeof(IShellItem).GUID, out recycled));
            ThrowIfFailed(SHCreateItemFromParsingName(parentPath, IntPtr.Zero, typeof(IShellItem).GUID, out destination));
            var operation = (IFileOperation)new FileOperation();
            try
            {
                ThrowIfFailed(operation.SetOperationFlags(FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOFX_ADDUNDORECORD));
                ThrowIfFailed(operation.MoveItem(recycled, destination, Path.GetFileName(targetPath), null));
                ThrowIfFailed(operation.PerformOperations());
                bool aborted;
                ThrowIfFailed(operation.GetAnyOperationsAborted(out aborted));
                if (aborted) throw new OperationCanceledException("系统取消了还原操作");
            }
            finally { Release(operation); }
        }
        finally
        {
            Marshal.FreeCoTaskMem(pidl);
            Release(recycled);
            Release(destination);
        }
        if (!File.Exists(targetPath) && !Directory.Exists(targetPath)) throw new IOException("Windows 未能把项目恢复到原位置");
        return new Dictionary<string, object> { { "success", true }, { "restoredPath", targetPath } };
    }

    private static object Probe(string encodedPidl)
    {
        var pidl = DecodePidl(encodedPidl);
        IShellItem item = null;
        try
        {
            var hr = SHCreateItemFromIDList(pidl, typeof(IShellItem).GUID, out item);
            if (hr < 0 || item == null) return new Dictionary<string, object> { { "success", true }, { "exists", false } };
            IntPtr displayName;
            hr = item.GetDisplayName(SIGDN_NORMALDISPLAY, out displayName);
            var name = hr >= 0 && displayName != IntPtr.Zero ? Marshal.PtrToStringUni(displayName) : "";
            if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
            return new Dictionary<string, object> { { "success", true }, { "exists", true }, { "name", name ?? "" } };
        }
        catch
        {
            return new Dictionary<string, object> { { "success", true }, { "exists", false } };
        }
        finally
        {
            Marshal.FreeCoTaskMem(pidl);
            Release(item);
        }
    }

    private static IntPtr DecodePidl(string encoded)
    {
        var bytes = Convert.FromBase64String(encoded);
        if (bytes.Length < 2 || bytes.Length > 1024 * 1024) throw new ArgumentException("无效的回收站项目标识");
        var pointer = Marshal.AllocCoTaskMem(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index < args.Length; index += 2)
        {
            if (!args[index].StartsWith("--") || index + 1 >= args.Length) throw new ArgumentException("无效的参数");
            options[args[index].Substring(2)] = args[index + 1];
        }
        return options;
    }

    private static string Required(Dictionary<string, string> options, string name)
    {
        string value;
        if (!options.TryGetValue(name, out value) || String.IsNullOrWhiteSpace(value)) throw new ArgumentException("缺少参数：--" + name);
        return value;
    }

    private static void WriteJson(object value)
    {
        Console.WriteLine(new JavaScriptSerializer().Serialize(value));
    }

    private static void ThrowIfFailed(int hr)
    {
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    private static void Release(object value)
    {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHCreateItemFromIDList(IntPtr pidl, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object value, out IntPtr pidl);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern uint ILGetSize(IntPtr pidl);

    [ComImport, Guid("3AD05575-8857-4850-9277-11B85BDB8E09")]
    private class FileOperation { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr result);
        [PreserveSig] int GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare([MarshalAs(UnmanagedType.Interface)] IShellItem other, uint hint, out int order);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8")]
    private interface IFileOperation
    {
        [PreserveSig] int Advise([MarshalAs(UnmanagedType.Interface)] IFileOperationProgressSink sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog([MarshalAs(UnmanagedType.IUnknown)] object dialog);
        [PreserveSig] int SetProperties([MarshalAs(UnmanagedType.IUnknown)] object properties);
        [PreserveSig] int SetOwnerWindow(uint owner);
        [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
        [PreserveSig] int ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
        [PreserveSig] int RenameItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int MoveItem(IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
        [PreserveSig] int MoveItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destinationFolder);
        [PreserveSig] int CopyItem(IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string copyName, IFileOperationProgressSink sink);
        [PreserveSig] int CopyItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destinationFolder);
        [PreserveSig] int DeleteItem(IShellItem item, IFileOperationProgressSink sink);
        [PreserveSig] int DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        [PreserveSig] int NewItem(IShellItem destinationFolder, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string templateName, IFileOperationProgressSink sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [ComVisible(true), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2")]
    private interface IFileOperationProgressSink
    {
        [PreserveSig] int StartOperations();
        [PreserveSig] int FinishOperations(int result);
        [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, int result, IShellItem newItem);
        [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, int result, IShellItem newItem);
        [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, int result, IShellItem newItem);
        [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
        [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem newItem);
        [PreserveSig] int PreNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
        [PreserveSig] int PostNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, [MarshalAs(UnmanagedType.LPWStr)] string templateName, uint attributes, int result, IShellItem newItem);
        [PreserveSig] int UpdateProgress(uint totalWork, uint workSoFar);
        [PreserveSig] int ResetTimer();
        [PreserveSig] int PauseTimer();
        [PreserveSig] int ResumeTimer();
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    private sealed class ProgressSink : IFileOperationProgressSink
    {
        internal byte[] RecycledPidl;
        internal int DeleteResult;
        internal bool DeleteCompleted;
        public int StartOperations() { return 0; }
        public int FinishOperations(int result) { return 0; }
        public int PreRenameItem(uint flags, IShellItem item, string newName) { return 0; }
        public int PostRenameItem(uint flags, IShellItem item, string newName, int result, IShellItem newItem) { return 0; }
        public int PreMoveItem(uint flags, IShellItem item, IShellItem destination, string newName) { return 0; }
        public int PostMoveItem(uint flags, IShellItem item, IShellItem destination, string newName, int result, IShellItem newItem) { return 0; }
        public int PreCopyItem(uint flags, IShellItem item, IShellItem destination, string newName) { return 0; }
        public int PostCopyItem(uint flags, IShellItem item, IShellItem destination, string newName, int result, IShellItem newItem) { return 0; }
        public int PreDeleteItem(uint flags, IShellItem item) { return 0; }
        public int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem newItem)
        {
            DeleteCompleted = true;
            DeleteResult = result;
            if (result >= 0 && newItem != null)
            {
                IntPtr pidl;
                if (SHGetIDListFromObject(newItem, out pidl) >= 0 && pidl != IntPtr.Zero)
                {
                    try
                    {
                        var size = checked((int)ILGetSize(pidl));
                        if (size > 0 && size <= 1024 * 1024)
                        {
                            RecycledPidl = new byte[size];
                            Marshal.Copy(pidl, RecycledPidl, 0, size);
                        }
                    }
                    finally { Marshal.FreeCoTaskMem(pidl); }
                }
            }
            return 0;
        }
        public int PreNewItem(uint flags, IShellItem destination, string newName) { return 0; }
        public int PostNewItem(uint flags, IShellItem destination, string newName, string templateName, uint attributes, int result, IShellItem newItem) { return 0; }
        public int UpdateProgress(uint totalWork, uint workSoFar) { return 0; }
        public int ResetTimer() { return 0; }
        public int PauseTimer() { return 0; }
        public int ResumeTimer() { return 0; }
    }
}
