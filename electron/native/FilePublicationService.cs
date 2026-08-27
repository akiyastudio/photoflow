using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using System.Linq;

internal static class FilePublicationService
{
    private sealed class OwnershipConflictException : IOException { public OwnershipConflictException(string message) : base(message) {} }
    private const uint MOVEFILE_WRITE_THROUGH = 0x8;
    private const uint GENERIC_READ = 0x80000000;
    private const uint DELETE = 0x00010000;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint FILE_SHARE_DELETE = 0x4;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const int FileDispositionInfo = 4;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
    private const uint FILE_ATTRIBUTE_READONLY = 0x1;
    private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)] private struct FILE_DISPOSITION_INFO { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
    [StructLayout(LayoutKind.Sequential)] private struct BY_HANDLE_FILE_INFORMATION { public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileEx(string existingName, string newName, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FILE_DISPOSITION_INFO info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFileAttributes(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool SetFileAttributes(string name, uint attributes);

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        try {
            if (args.Length < 1) throw new ArgumentException("缺少操作名称");
            var options = Parse(args);
            object result;
            if (args[0] == "move-no-replace") result = MoveNoReplace(Required(options, "source"), Required(options, "target"));
            else if (args[0] == "move-no-replace-batch") result = MoveNoReplaceBatch(Required(options, "manifest"));
            else if (args[0] == "inspect-path-batch") result = InspectPathBatch(Required(options, "manifest"));
            else if (args[0] == "delete-paths-batch") result = DeletePathsBatch(Required(options, "manifest"));
            else if (args[0] == "commit-cross-volume-file") result = CommitCrossVolume(Required(options, "source"), Required(options, "staged"), Required(options, "target"), Required(options, "sha256"), long.Parse(Required(options, "size")), Required(options, "source-identity"));
            else if (args[0] == "compare-delete-file") result = CompareDelete(Required(options, "target"), Required(options, "sha256"), long.Parse(Required(options, "size")), Required(options, "identity"));
            else if (args[0] == "inspect-path") result = Inspect(Required(options, "path"));
            else if (args[0] == "commit-tree-file") result = CommitTreeFile(Required(options, "source"), Required(options, "target"), Required(options, "sha256"), long.Parse(Required(options, "size")), Required(options, "identity"));
            else if (args[0] == "delete-empty-directory") result = DeleteEmptyDirectory(Required(options, "source"), Required(options, "identity"));
            else throw new ArgumentException("不支持的操作：" + args[0]);
            Write(result); return 0;
        } catch (Exception error) {
            var native = error as Win32Exception;
            var code = error is OwnershipConflictException ? "PUBLISH_OWNERSHIP_CONFLICT" : error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
            Write(new Dictionary<string, object> { { "success", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } });
            return 1;
        }
    }

    private static object MoveNoReplace(string sourceValue, string targetValue)
    {
        var source = Full(sourceValue); var target = Full(targetValue); EnsureDistinct(source, target);
        var sourceAttributes = GetFileAttributes(source); if (sourceAttributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((sourceAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
            MoveNoReplaceCore(source, target);
            using (var directoryHandle = OpenLocked(target, GENERIC_READ, true)) return new Dictionary<string, object> { { "success", true }, { "strategy", "win32-move-no-replace" }, { "identity", Identity(directoryHandle) } };
        }
        using (var handle = OpenLocked(source, GENERIC_READ, false, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) {
            var identity = Identity(handle);
            MoveNoReplaceCore(source, target);
            return new Dictionary<string, object> { { "success", true }, { "strategy", "win32-move-no-replace" }, { "identity", identity } };
        }
    }
    private static object MoveNoReplaceBatch(string manifestValue)
    {
        Full(manifestValue); var manifest = Path.GetFullPath(manifestValue);
        var results = new List<Dictionary<string, object>>();
        var utf8 = new UTF8Encoding(false, true);
        var lines = File.ReadAllLines(manifest, utf8);
        for (var expectedIndex = 0; expectedIndex < lines.Length; expectedIndex++) {
            var parts = lines[expectedIndex].Split('\t');
            if (parts.Length != 4) throw new ArgumentException("批量发布清单格式无效");
            int index; if (!Int32.TryParse(parts[0], out index) || index != expectedIndex) throw new ArgumentException("批量发布清单索引无效");
            string sourceValue; string targetValue; string expectedIdentity;
            try { sourceValue = utf8.GetString(Convert.FromBase64String(parts[1])); targetValue = utf8.GetString(Convert.FromBase64String(parts[2])); expectedIdentity = utf8.GetString(Convert.FromBase64String(parts[3])); }
            catch (Exception error) { throw new ArgumentException("批量发布清单路径编码无效", error); }
            try {
                var source = Full(sourceValue); var target = Full(targetValue); EnsureDistinct(source, target);
                using (var handle = OpenLocked(source, GENERIC_READ, Directory.Exists(source), FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) {
                    var identity = Identity(handle);
                    VerifyIdentity(handle, expectedIdentity, "批量发布源");
                    MoveNoReplaceCore(source, target);
                    using (var targetHandle = OpenLocked(target, GENERIC_READ)) VerifyIdentity(targetHandle, expectedIdentity, "批量发布目标");
                    results.Add(new Dictionary<string, object> { { "index", index }, { "success", true }, { "strategy", "win32-batch-move-no-replace" }, { "identity", identity } });
                }
            } catch (Exception error) {
                var native = error as Win32Exception;
                var code = error is OwnershipConflictException ? "PUBLISH_OWNERSHIP_CONFLICT" : error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } });
                break;
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "results", results } };
    }
    private static object InspectPathBatch(string manifestValue)
    {
        Full(manifestValue); var manifest = Path.GetFullPath(manifestValue); var results = new List<Dictionary<string, object>>(); var utf8 = new UTF8Encoding(false, true); var lines = File.ReadAllLines(manifest, utf8);
        for (var expectedIndex = 0; expectedIndex < lines.Length; expectedIndex++) {
            var parts = lines[expectedIndex].Split('\t'); if (parts.Length != 2) throw new ArgumentException("批量检查清单格式无效");
            int index; if (!Int32.TryParse(parts[0], out index) || index != expectedIndex) throw new ArgumentException("批量检查清单索引无效");
            string value; try { value = utf8.GetString(Convert.FromBase64String(parts[1])); } catch (Exception error) { throw new ArgumentException("批量检查路径编码无效", error); }
            try {
                var requested = Full(value); var attributes = GetFileAttributes(requested); if (attributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error()); var directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                using (var handle = OpenLocked(requested, GENERIC_READ, directory)) results.Add(new Dictionary<string, object> { { "index", index }, { "success", true }, { "identity", Identity(handle) }, { "directory", directory } });
            } catch (Exception error) {
                var native = error as Win32Exception; var code = error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } });
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "results", results } };
    }
    private static object DeletePathsBatch(string manifestValue)
    {
        Full(manifestValue); var manifest = Path.GetFullPath(manifestValue); var results = new List<Dictionary<string, object>>(); var utf8 = new UTF8Encoding(false, true); var lines = File.ReadAllLines(manifest, utf8);
        for (var expectedIndex = 0; expectedIndex < lines.Length; expectedIndex++) {
            var parts = lines[expectedIndex].Split('\t'); if (parts.Length != 3) throw new ArgumentException("批量清理清单格式无效");
            int index; if (!Int32.TryParse(parts[0], out index) || index != expectedIndex) throw new ArgumentException("批量清理清单索引无效");
            string value; string identity; try { value = utf8.GetString(Convert.FromBase64String(parts[1])); identity = utf8.GetString(Convert.FromBase64String(parts[2])); } catch (Exception error) { throw new ArgumentException("批量清理路径编码无效", error); }
            try {
                var requested = Full(value); var attributes = GetFileAttributes(requested); if (attributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error()); var directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                using (var handle = OpenLocked(requested, GENERIC_READ | DELETE, directory)) { VerifyIdentity(handle, identity, "批量清理目标"); if (!directory) ClearReadOnly(requested); MarkDelete(handle); }
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", true }, { "deleted", true } });
            } catch (Exception error) {
                var native = error as Win32Exception; var code = error is OwnershipConflictException ? "PUBLISH_OWNERSHIP_CONFLICT" : error is PathTooLongException ? "ENAMETOOLONG" : error is ArgumentException ? "EINVAL" : native == null ? "FILE_PUBLICATION_FAILED" : NativeCode(native.NativeErrorCode);
                results.Add(new Dictionary<string, object> { { "index", index }, { "success", false }, { "error", error.Message }, { "code", code }, { "nativeError", native == null ? 0 : native.NativeErrorCode } });
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "results", results } };
    }
    private static void MoveNoReplaceCore(string source, string target)
    {
        if (!MoveFileEx(source, target, MOVEFILE_WRITE_THROUGH)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static object CommitCrossVolume(string sourceValue, string stagedValue, string targetValue, string expectedHash, long expectedSize, string expectedSourceIdentity)
    {
        var source = Full(sourceValue); var staged = Full(stagedValue); var target = Full(targetValue);
        EnsureDistinct(source, target); EnsureDistinct(staged, target);
        using (var sourceHandle = OpenVerifiedDelete(source, expectedSourceIdentity, expectedHash, expectedSize, "源文件")) {
            using (var stagedHandle = OpenLocked(staged, GENERIC_READ, false, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)) {
                var stagedIdentity = Identity(stagedHandle);
                Verify(stagedHandle, expectedHash, expectedSize, "暂存文件");
                MoveNoReplaceCore(staged, target);
                using (var targetHandle = OpenLocked(target, GENERIC_READ)) {
                    VerifyIdentity(targetHandle, stagedIdentity, "目标文件");
                    Verify(targetHandle, expectedHash, expectedSize, "目标");
                }
                MarkDelete(sourceHandle);
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "strategy", "win32-cross-volume-locked-commit" } };
    }

    private static object CompareDelete(string targetValue, string expectedHash, long expectedSize, string expectedIdentity)
    {
        var target = Full(targetValue);
        using (var handle = OpenVerifiedDelete(target, expectedIdentity, expectedHash, expectedSize, "补偿目标")) MarkDelete(handle);
        return new Dictionary<string, object> { { "success", true }, { "deleted", true } };
    }
    private static object Inspect(string value)
    {
        var requested = Full(value); var attributes = GetFileAttributes(requested); if (attributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error()); var directory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        using (var handle = OpenLocked(requested, GENERIC_READ, directory)) return new Dictionary<string, object> { { "success", true }, { "identity", Identity(handle) }, { "directory", directory } };
    }
    private static object CommitTreeFile(string sourceValue, string targetValue, string hash, long size, string identity)
    {
        var source = Full(sourceValue); var target = Full(targetValue);
        using (var targetHandle = OpenLocked(target, GENERIC_READ)) {
            Verify(targetHandle, hash, size, "目标文件");
            using (var sourceHandle = OpenLocked(source, GENERIC_READ | DELETE)) {
                VerifyIdentity(sourceHandle, identity, "源文件");
                Verify(sourceHandle, hash, size, "源文件"); ClearReadOnly(source); MarkDelete(sourceHandle);
            }
        }
        return new Dictionary<string, object> { { "success", true }, { "deleted", true } };
    }
    private static object DeleteEmptyDirectory(string sourceValue, string identity)
    {
        var source = Full(sourceValue);
        using (var handle = OpenLocked(source, GENERIC_READ | DELETE, true)) {
            if (!String.Equals(Identity(handle), identity, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("源目录身份已变化");
            MarkDelete(handle);
        }
        return new Dictionary<string, object> { { "success", true }, { "deleted", true } };
    }

    private static SafeFileHandle OpenLocked(string filePath, uint access, bool directory = false, uint share = FILE_SHARE_READ)
    {
        var handle = CreateFile(filePath, access, share, IntPtr.Zero, OPEN_EXISTING, directory ? FILE_FLAG_BACKUP_SEMANTICS : 0, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    private static SafeFileHandle OpenVerifiedDelete(string filePath, string expectedIdentity, string expectedHash, long expectedSize, string label)
    {
        using (var guard = OpenLocked(filePath, GENERIC_READ)) {
            VerifyIdentity(guard, expectedIdentity, label);
            Verify(guard, expectedHash, expectedSize, label);
            ClearReadOnly(filePath);
        }
        var deletable = OpenLocked(filePath, GENERIC_READ | DELETE);
        try { VerifyIdentity(deletable, expectedIdentity, label); Verify(deletable, expectedHash, expectedSize, label); return deletable; }
        catch { deletable.Dispose(); throw; }
    }
    private static string Identity(SafeFileHandle handle) { BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error()); return info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + ":" + info.FileIndexLow.ToString("x8"); }
    private static void VerifyIdentity(SafeFileHandle handle, string expectedIdentity, string label) { if (!String.Equals(Identity(handle), expectedIdentity, StringComparison.OrdinalIgnoreCase)) throw new OwnershipConflictException(label + "身份已变化"); }
    private static void Verify(SafeFileHandle handle, string expectedHash, long expectedSize, string label)
    {
        var stream = new FileStream(handle, FileAccess.Read, 1024 * 1024, false);
        if (stream.Length != expectedSize) throw new InvalidDataException(label + "大小与预期不一致");
        using (var sha = SHA256.Create()) {
            var actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(actual, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException(label + "摘要与预期不一致");
        }
        GC.SuppressFinalize(stream);
    }
    private static void MarkDelete(SafeFileHandle handle)
    {
        var info = new FILE_DISPOSITION_INFO { DeleteFile = true };
        if (!SetFileInformationByHandle(handle, FileDispositionInfo, ref info, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    private static void ClearReadOnly(string filePath) { var attributes = GetFileAttributes(filePath); if (attributes == INVALID_FILE_ATTRIBUTES) throw new Win32Exception(Marshal.GetLastWin32Error()); if ((attributes & FILE_ATTRIBUTE_READONLY) != 0 && !SetFileAttributes(filePath, attributes & ~FILE_ATTRIBUTE_READONLY)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    private static string Full(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) throw new ArgumentException("路径为空");
        var input = value.Replace('/', '\\');
        if (input.StartsWith("\\\\?\\", StringComparison.Ordinal) || input.StartsWith("\\\\.\\", StringComparison.Ordinal) || input.StartsWith("\\??\\", StringComparison.Ordinal)) throw new ArgumentException("不接受设备或扩展路径输入");
        string root; string remainder;
        if (input.Length >= 3 && Char.IsLetter(input[0]) && input[1] == ':' && input[2] == '\\') { root = input.Substring(0, 3); remainder = input.Substring(3); }
        else if (input.StartsWith("\\\\", StringComparison.Ordinal)) {
            var parts = input.Substring(2).Split(new[] { '\\' }, StringSplitOptions.None);
            if (parts.Length < 2 || parts[0].Length == 0 || parts[1].Length == 0) throw new ArgumentException("UNC 路径缺少服务器或共享名");
            ValidateSegment(parts[0]); ValidateSegment(parts[1]);
            root = "\\\\" + parts[0] + "\\" + parts[1] + "\\"; remainder = String.Join("\\", parts.Skip(2).ToArray());
        } else throw new ArgumentException("路径必须是绝对驱动器路径或 UNC 路径");
        var segments = remainder.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (var segment in segments) ValidateSegment(segment);
        var normalized = root + String.Join("\\", segments);
        return normalized.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + normalized.Substring(2) : "\\\\?\\" + normalized;
    }
    private static void ValidateSegment(string segment) { if (segment == "." || segment == "..") throw new ArgumentException("路径不能包含相对段"); if (segment.EndsWith(" ", StringComparison.Ordinal) || segment.EndsWith(".", StringComparison.Ordinal)) throw new ArgumentException("路径段不能以空格或点结尾"); if (segment.IndexOfAny(new[] { '<', '>', '"', '|', '?', '*', ':' }) >= 0 || segment.Any(ch => ch < 32)) throw new ArgumentException("路径包含非法字符"); }
    private static void EnsureDistinct(string left, string right) { if (String.Equals(left, right, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("源和目标不能相同"); }
    private static string NativeCode(int code) { if (code == 17) return "EXDEV"; if (code == 80 || code == 183) return "EEXIST"; if (code == 2 || code == 3) return "ENOENT"; if (code == 5 || code == 32) return "EBUSY"; if (code == 123 || code == 206) return "ENAMETOOLONG"; return "WIN32_" + code; }
    private static Dictionary<string, string> Parse(string[] args) { var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); for (var i = 1; i + 1 < args.Length; i += 2) { if (!args[i].StartsWith("--")) throw new ArgumentException("参数格式无效"); result[args[i].Substring(2)] = args[i + 1]; } return result; }
    private static string Required(Dictionary<string, string> values, string key) { string value; if (!values.TryGetValue(key, out value) || String.IsNullOrWhiteSpace(value)) throw new ArgumentException("缺少参数：" + key); return value; }
    private static void Write(object value) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); }
}
