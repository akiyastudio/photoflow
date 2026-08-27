using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class FileClipboardService
{
    private const string DropEffectFormat = "Preferred DropEffect";
    private const int RetryCount = 8;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [STAThread]
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length != 1) throw new ArgumentException("需要 write、read 或 clear-if-current 命令");
            object result;
            switch (args[0])
            {
                case "write": result = Write(ReadRequest()); break;
                case "read": result = Read(); break;
                case "clear-if-current": result = ClearIfCurrent(ReadRequest()); break;
                default: throw new ArgumentException("未知命令：" + args[0]);
            }
            Console.WriteLine(Json.Serialize(result));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            Console.WriteLine(Json.Serialize(new { success = false, code = "FILE_CLIPBOARD_FAILED", error = error.Message }));
            return 1;
        }
    }

    private static Dictionary<string, object> ReadRequest()
    {
        var input = Console.In.ReadToEnd();
        if (String.IsNullOrWhiteSpace(input)) return new Dictionary<string, object>();
        return Json.Deserialize<Dictionary<string, object>>(input);
    }

    private static T Retry<T>(Func<T> action)
    {
        Exception last = null;
        for (var attempt = 0; attempt < RetryCount; attempt++)
        {
            try { return action(); }
            catch (ExternalException error)
            {
                last = error;
                if (attempt + 1 < RetryCount) Thread.Sleep(35 + attempt * 20);
            }
        }
        throw new InvalidOperationException("Windows 剪贴板正忙，请稍后重试", last);
    }

    private static string[] Sources(Dictionary<string, object> request)
    {
        object raw;
        if (!request.TryGetValue("sources", out raw) || raw == null) return new string[0];
        var values = raw as object[];
        var list = raw as ArrayList;
        if (values == null && list != null) values = list.ToArray();
        if (values == null) values = new object[0];
        return values.Select(value => Path.GetFullPath(Convert.ToString(value)))
            .Where(value => !String.IsNullOrWhiteSpace(value)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static object Write(Dictionary<string, object> request)
    {
        var sources = Sources(request);
        if (sources.Length == 0) throw new ArgumentException("没有可写入剪贴板的文件");
        if (sources.Any(source => !File.Exists(source) && !Directory.Exists(source))) throw new FileNotFoundException("剪贴板源文件不存在");
        object rawOperation;
        var operation = request.TryGetValue("operation", out rawOperation) ? Convert.ToString(rawOperation) : "copy";
        if (operation != "copy" && operation != "cut") throw new ArgumentException("无效的剪贴板操作");
        Retry(() =>
        {
            var files = new StringCollection();
            files.AddRange(sources);
            var data = new DataObject();
            data.SetFileDropList(files);
            data.SetData(DropEffectFormat, false, new MemoryStream(BitConverter.GetBytes(operation == "cut" ? 2 : 1)));
            Clipboard.SetDataObject(data, true);
            return true;
        });
        var verified = (Dictionary<string, object>)Read();
        var verifiedSources = (string[])verified["sources"];
        if (!SameSources(sources, verifiedSources) || Convert.ToString(verified["operation"]) != operation)
            throw new InvalidOperationException("写入后回读验证失败");
        return new { success = true, sources = verifiedSources, operation, sequence = verified["sequence"] };
    }

    private static object Read()
    {
        return Retry<object>(() =>
        {
            var data = Clipboard.GetDataObject();
            var files = Clipboard.ContainsFileDropList() ? Clipboard.GetFileDropList().Cast<string>().Select(Path.GetFullPath).ToArray() : new string[0];
            var operation = "copy";
            if (data != null && data.GetDataPresent(DropEffectFormat))
            {
                var effect = ReadEffect(data.GetData(DropEffectFormat));
                if ((effect & 2) == 2) operation = "cut";
            }
            return new Dictionary<string, object> { { "success", true }, { "sources", files }, { "operation", operation }, { "sequence", GetClipboardSequenceNumber() } };
        });
    }

    private static int ReadEffect(object value)
    {
        var stream = value as Stream;
        if (stream != null)
        {
            stream.Position = 0;
            var bytes = new byte[4];
            return stream.Read(bytes, 0, bytes.Length) > 0 ? BitConverter.ToInt32(bytes, 0) : 0;
        }
        var raw = value as byte[];
        return raw != null && raw.Length >= 4 ? BitConverter.ToInt32(raw, 0) : 0;
    }

    private static object ClearIfCurrent(Dictionary<string, object> request)
    {
        object rawSequence;
        var expectedSequence = request.TryGetValue("sequence", out rawSequence) ? Convert.ToUInt32(rawSequence) : 0;
        var expectedSources = Sources(request);
        return Retry<object>(() =>
        {
            var current = (Dictionary<string, object>)Read();
            var matches = Convert.ToUInt32(current["sequence"]) == expectedSequence
                && Convert.ToString(current["operation"]) == "cut"
                && SameSources(expectedSources, (string[])current["sources"]);
            if (matches) Clipboard.Clear();
            return new { success = true, cleared = matches, sequence = GetClipboardSequenceNumber(), sources = matches ? new string[0] : (string[])current["sources"], operation = matches ? "copy" : Convert.ToString(current["operation"]) };
        });
    }

    private static bool SameSources(IEnumerable<string> left, IEnumerable<string> right)
    {
        var first = left.Select(Path.GetFullPath).OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToArray();
        var second = right.Select(Path.GetFullPath).OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToArray();
        return first.Length == second.Length && first.SequenceEqual(second, StringComparer.OrdinalIgnoreCase);
    }

}
