using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class RecycleBinService
{
    private sealed class RecoveryFailureException : IOException
    {
        internal readonly string CodeValue; internal readonly string RecoveryPathValue; internal readonly string PhaseValue; internal readonly bool OriginalMissingValue; internal readonly bool PublishedValue; internal readonly bool OutcomeUnknownValue;
        internal RecoveryFailureException(string message, string code, string recoveryPath, bool originalMissing, bool published, bool outcomeUnknown, Exception inner, string phase = null) : base(message, inner) { CodeValue = code; RecoveryPathValue = recoveryPath; PhaseValue = phase; OriginalMissingValue = originalMissing; PublishedValue = published; OutcomeUnknownValue = outcomeUnknown; }
    }
    private const uint FOF_SILENT = 0x0004;
    private const uint FOF_NOCONFIRMATION = 0x0010;
    private const uint FOF_ALLOWUNDO = 0x0040;
    private const uint FOF_NOERRORUI = 0x0400;
    private const uint FOF_WANTNUKEWARNING = 0x4000;
    private const uint FOFX_RECYCLEONDELETE = 0x00080000;
    private const uint FOFX_ADDUNDORECORD = 0x20000000;
    private const uint SIGDN_NORMALDISPLAY = 0;
    private const uint SICHINT_CANONICAL = 0x10000000;
    private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
    private static Guid RecycleBinFolderId = new Guid("B7534046-3ECB-4C18-BE4E-64CD4CB7D6AC");

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
            else if (args[0] == "restore") result = Restore(Required(options, "pidl"), Required(options, "target"), Optional(options, "staging"));
            else if (args[0] == "probe") result = Probe(Required(options, "pidl"));
            else if (args[0] == "probe-many") result = ProbeMany(ReadValues(5000));
            else if (args[0] == "check") result = Check(Required(options, "directory"));
            else throw new ArgumentException("不支持的操作：" + args[0]);
            WriteJson(result);
            return 0;
        }
        catch (Exception error)
        {
            var failure = new Dictionary<string, object> {
                { "success", false },
                { "error", error.Message },
                { "hresult", error.HResult }
            };
            var recovery = error as RecoveryFailureException;
            if (recovery != null) { var recoveryExists = File.Exists(recovery.RecoveryPathValue) || Directory.Exists(recovery.RecoveryPathValue); failure["code"] = recovery.CodeValue; if (!String.IsNullOrEmpty(recovery.PhaseValue)) failure["phase"] = recovery.PhaseValue; if (recoveryExists) failure["recoveryPath"] = recovery.RecoveryPathValue; else failure["attemptedStagingPath"] = recovery.RecoveryPathValue; failure["recoveryAvailable"] = recoveryExists; failure["staged"] = recoveryExists; failure["originalMissing"] = recovery.OriginalMissingValue; failure["published"] = recovery.PublishedValue; failure["publishedConfirmed"] = true; failure["publicationState"] = recovery.PublishedValue ? "published" : "not-published"; failure["outcomeUnknown"] = recovery.OutcomeUnknownValue; }
            WriteJson(failure);
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
            try {
                var restored = Restore(pidl, canary) as Dictionary<string, object>;
                if (restored == null || !restored.ContainsKey("success") || !Convert.ToBoolean(restored["success"])) { var restoreError = restored != null && restored.ContainsKey("error") ? restored["error"] : "回收站项目无法还原"; return new Dictionary<string, object> { { "success", true }, { "supported", false }, { "code", restored != null && restored.ContainsKey("code") ? restored["code"] : "RECYCLE_RESTORE_FAILED" }, { "error", restoreError }, { "reason", restoreError } }; }
            }
            catch (Exception error)
            {
                var recovery = error as RecoveryFailureException;
                return new Dictionary<string, object> { { "success", true }, { "supported", false }, { "code", recovery == null ? "RECYCLE_RESTORE_FAILED" : recovery.CodeValue }, { "error", error.Message }, { "reason", "回收站项目无法还原：" + error.Message } };
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
        try
        {
            // Skip the routine second confirmation after PhotoFlow's own dialog,
            // but let Windows show its standard warning when recycling is not
            // possible and the item would be deleted permanently.
            ThrowIfFailed(operation.SetOperationFlags(FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING | FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD));
            ThrowIfFailed(operation.DeleteItem(source, sink));
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
            Release(source);
            Release(operation);
        }
    }

    private static string[] ReadPaths()
    {
        var paths = ReadValues(500);
        if (paths == null || paths.Length == 0) throw new ArgumentException("没有要删除的文件或文件夹");
        return paths;
    }

    private static string[] ReadValues(int maximum)
    {
        var input = Console.In.ReadToEnd();
        var values = new JavaScriptSerializer().Deserialize<string[]>(input);
        if (values == null || values.Length == 0) throw new ArgumentException("没有输入项目");
        if (values.Length > maximum) throw new ArgumentException("输入项目数量过多");
        return values;
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

    private static object Restore(string encodedPidl, string requestedTarget, string requestedStaging = null)
    {
        var targetPath = Path.GetFullPath(requestedTarget);
        var temporaryPath = ApprovedStaging(targetPath, requestedStaging);
        if (File.Exists(targetPath) || Directory.Exists(targetPath))
            return new Dictionary<string, object> { { "success", false }, { "code", "DESTINATION_EXISTS" }, { "error", "原位置已有同名文件或文件夹" }, { "phase", "preflight" }, { "attemptedStagingPath", temporaryPath }, { "recoveryAvailable", false }, { "staged", false }, { "originalMissing", false }, { "published", false }, { "publishedConfirmed", true }, { "publicationState", "not-published" }, { "outcomeUnknown", false } };
        var parentPath = Path.GetDirectoryName(targetPath);
        if (String.IsNullOrEmpty(parentPath)) throw new InvalidOperationException("无法确定恢复目录");
        Directory.CreateDirectory(parentPath);

        IntPtr pidl = IntPtr.Zero;
        IShellItem recycled = null;
        IShellItem destination = null;
        IShellItem restoredItem = null;
        var phase = "resolve-recycle-item";
        try
        {
            pidl = DecodePidl(encodedPidl);
            ThrowIfFailed(SHCreateItemFromIDList(pidl, typeof(IShellItem).GUID, out recycled));
            EnsureRecycleItem(recycled);
            ThrowIfFailed(SHCreateItemFromParsingName(parentPath, IntPtr.Zero, typeof(IShellItem).GUID, out destination));
            var operation = (IFileOperation)new FileOperation();
            var sink = new ProgressSink();
            try
            {
                phase = "move-to-staging";
                ThrowIfFailed(operation.SetOperationFlags(FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOFX_ADDUNDORECORD));
                ThrowIfFailed(operation.MoveItem(recycled, destination, Path.GetFileName(temporaryPath), sink));
                ThrowIfFailed(operation.PerformOperations());
                bool aborted;
                ThrowIfFailed(operation.GetAnyOperationsAborted(out aborted));
                if (aborted) throw new OperationCanceledException("系统取消了还原操作");
                if (!sink.MoveCompleted) throw new IOException("Windows 未报告还原项目结果");
                if (sink.MoveResult < 0) Marshal.ThrowExceptionForHR(sink.MoveResult);
                if (sink.MovedItem == null) throw new IOException("Windows 未返回已恢复对象身份");
                phase = "verify-staging";
                ThrowIfFailed(SHCreateItemFromParsingName(temporaryPath, IntPtr.Zero, typeof(IShellItem).GUID, out restoredItem));
                int order;
                ThrowIfFailed(sink.MovedItem.Compare(restoredItem, SICHINT_CANONICAL, out order));
                if (order != 0) throw new IOException("恢复对象身份与目标临时路径不匹配");
            }
            catch (Exception error)
            {
                if (File.Exists(temporaryPath) || Directory.Exists(temporaryPath))
                    throw new RecoveryFailureException(error.Message, "RECYCLE_RESTORE_VERIFY_FAILED", temporaryPath, true, false, false, error, phase);
                throw;
            }
            finally { sink.ReleaseMovedItem(); Release(operation); }

            try
            {
                phase = "commit-target";
                if (!MoveFileEx(temporaryPath, targetPath, MOVEFILE_WRITE_THROUGH))
                {
                    var nativeError = Marshal.GetLastWin32Error();
                    return new Dictionary<string, object> {
                        { "success", false }, { "code", File.Exists(targetPath) || Directory.Exists(targetPath) ? "DESTINATION_EXISTS" : "RECYCLE_RESTORE_COMMIT_FAILED" },
                        { "error", "恢复对象已安全保留在临时路径，无法无覆盖提交到原位置" }, { "nativeError", nativeError }, { "phase", "commit-target" },
                        { "recoveryPath", temporaryPath }, { "recoveryAvailable", true }, { "staged", true }, { "originalMissing", !File.Exists(targetPath) && !Directory.Exists(targetPath) }, { "published", false }, { "publishedConfirmed", true }, { "publicationState", "not-published" }, { "outcomeUnknown", false }, { "identityVerified", true }
                    };
                }
            }
            catch (Exception error) { throw new RecoveryFailureException(error.Message, "RECYCLE_RESTORE_COMMIT_FAILED", temporaryPath, !File.Exists(targetPath) && !Directory.Exists(targetPath), false, false, error, phase); }
        }
        catch (RecoveryFailureException) { throw; }
        catch (Exception error)
        {
            throw new RecoveryFailureException(error.Message, "RECYCLE_RESTORE_FAILED", temporaryPath, !File.Exists(targetPath) && !Directory.Exists(targetPath), false, true, error, phase);
        }
        finally
        {
            if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
            Release(recycled);
            Release(destination);
            Release(restoredItem);
        }
        if (!File.Exists(targetPath) && !Directory.Exists(targetPath)) throw new IOException("Windows 未能把项目恢复到原位置");
        return new Dictionary<string, object> { { "success", true }, { "restoredPath", targetPath }, { "identityVerified", true } };
    }

    private static object Probe(string encodedPidl)
    {
        IntPtr pidl;
        try { pidl = DecodePidl(encodedPidl); }
        catch (FormatException error) { return new Dictionary<string, object> { { "success", true }, { "exists", false }, { "invalidPidl", true }, { "error", error.Message } }; }
        catch (ArgumentException error) { return new Dictionary<string, object> { { "success", true }, { "exists", false }, { "invalidPidl", true }, { "error", error.Message } }; }
        IShellItem item = null;
        try
        {
            var hr = SHCreateItemFromIDList(pidl, typeof(IShellItem).GUID, out item);
            if (hr < 0 || item == null) return IsNotFound(hr)
                ? new Dictionary<string, object> { { "success", true }, { "exists", false } }
                : ProbeFailure(hr, "Windows 无法探测回收站项目");
            try { EnsureRecycleItem(item); }
            catch (ArgumentException error) { return new Dictionary<string, object> { { "success", true }, { "exists", false }, { "invalidPidl", true }, { "error", error.Message } }; }
            IntPtr displayName;
            hr = item.GetDisplayName(SIGDN_NORMALDISPLAY, out displayName);
            if (hr < 0) { if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName); return IsNotFound(hr) ? new Dictionary<string, object> { { "success", true }, { "exists", false } } : ProbeFailure(hr, "Windows 无法读取回收站项目"); }
            var name = hr >= 0 && displayName != IntPtr.Zero ? Marshal.PtrToStringUni(displayName) : "";
            if (displayName != IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
            return new Dictionary<string, object> { { "success", true }, { "exists", true }, { "name", name ?? "" } };
        }
        catch (COMException error)
        {
            return IsNotFound(error.HResult) ? new Dictionary<string, object> { { "success", true }, { "exists", false } } : ProbeFailure(error.HResult, error.Message);
        }
        finally
        {
            Marshal.FreeCoTaskMem(pidl);
            Release(item);
        }
    }

    private static object ProbeMany(string[] encodedPidls)
    {
        var items = new List<Dictionary<string, object>>();
        foreach (var encodedPidl in encodedPidls)
        {
            try
            {
                var result = (Dictionary<string, object>)Probe(encodedPidl);
                result["pidl"] = encodedPidl;
                items.Add(result);
            }
            catch (Exception error)
            {
                items.Add(new Dictionary<string, object> {
                    { "success", false }, { "exists", false }, { "pidl", encodedPidl },
                    { "error", error.Message }, { "hresult", error.HResult }
                });
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "items", items } };
    }

    private static IntPtr DecodePidl(string encoded)
    {
        var bytes = Convert.FromBase64String(encoded);
        if (bytes.Length < 2 || bytes.Length > 1024 * 1024) throw new ArgumentException("无效的回收站项目标识");
        var offset = 0;
        var terminated = false;
        while (offset + 2 <= bytes.Length)
        {
            var itemSize = bytes[offset] | (bytes[offset + 1] << 8);
            if (itemSize == 0) { terminated = offset + 2 == bytes.Length; break; }
            if (itemSize < 2 || itemSize > bytes.Length - offset) throw new ArgumentException("回收站 ITEMIDLIST 边界无效");
            offset += itemSize;
        }
        if (!terminated) throw new ArgumentException("回收站 ITEMIDLIST 未正确终止");
        var pointer = Marshal.AllocCoTaskMem(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    private static string ApprovedStaging(string targetPath, string requested)
    {
        var targetParent = Path.GetDirectoryName(targetPath); var targetName = Path.GetFileName(targetPath);
        var staging = String.IsNullOrWhiteSpace(requested) ? Path.Combine(targetParent, ".photoflow-restore-" + Guid.NewGuid().ToString("N") + "-" + targetName) : Path.GetFullPath(requested);
        var stagingName = Path.GetFileName(staging); const string prefix = ".photoflow-restore-"; var suffix = "-" + targetName; Guid stagingId;
        var tokenLength = stagingName.Length - prefix.Length - suffix.Length;
        var token = tokenLength > 0 ? stagingName.Substring(prefix.Length, tokenLength) : "";
        if (!String.Equals(Path.GetDirectoryName(staging), targetParent, StringComparison.OrdinalIgnoreCase) || !stagingName.StartsWith(prefix, StringComparison.Ordinal) || !stagingName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) || !Guid.TryParse(token, out stagingId) || String.Equals(staging, targetPath, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("恢复暂存路径未获批准");
        if (File.Exists(staging) || Directory.Exists(staging)) throw new IOException("恢复暂存路径已被占用");
        return staging;
    }

    private static Dictionary<string, object> ProbeFailure(int hr, string message) { return new Dictionary<string, object> { { "success", false }, { "exists", false }, { "code", "RECYCLE_PROBE_FAILED" }, { "error", message }, { "hresult", hr }, { "transient", true } }; }
    private static bool IsNotFound(int hr) { return hr == unchecked((int)0x80070002) || hr == unchecked((int)0x80070003) || hr == unchecked((int)0x800401E5); }

    private static void EnsureRecycleItem(IShellItem item)
    {
        IShellItem recycleRoot = null;
        IShellItem current = null;
        try
        {
            var iid = typeof(IShellItem).GUID;
            ThrowIfFailed(SHGetKnownFolderItem(ref RecycleBinFolderId, 0, IntPtr.Zero, ref iid, out recycleRoot));
            ThrowIfFailed(item.GetParent(out current));
            for (var depth = 0; current != null && depth < 32; depth++)
            {
                int order;
                if (current.Compare(recycleRoot, SICHINT_CANONICAL, out order) >= 0 && order == 0) return;
                IShellItem parent;
                if (current.GetParent(out parent) < 0 || parent == null) break;
                Release(current);
                current = parent;
            }
            throw new ArgumentException("项目标识不属于 Windows 回收站");
        }
        finally { Release(current); Release(recycleRoot); }
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

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHGetKnownFolderItem(ref Guid folderId, uint flags, IntPtr token, [MarshalAs(UnmanagedType.LPStruct)] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string existingName, string newName, uint flags);

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
        internal IShellItem MovedItem;
        internal int MoveResult;
        internal bool MoveCompleted;
        public int StartOperations() { return 0; }
        public int FinishOperations(int result) { return 0; }
        public int PreRenameItem(uint flags, IShellItem item, string newName) { return 0; }
        public int PostRenameItem(uint flags, IShellItem item, string newName, int result, IShellItem newItem) { return 0; }
        public int PreMoveItem(uint flags, IShellItem item, IShellItem destination, string newName) { return 0; }
        public int PostMoveItem(uint flags, IShellItem item, IShellItem destination, string newName, int result, IShellItem newItem) { MoveCompleted = true; MoveResult = result; if (result >= 0 && newItem != null) MovedItem = newItem; return 0; }
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
        internal void ReleaseMovedItem() { MovedItem = null; }
    }

    private static string Optional(Dictionary<string, string> options, string name) { string value; return options.TryGetValue(name, out value) ? value : null; }
}
