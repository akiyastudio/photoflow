using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

internal static class ShellThumbnailCache
{
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSize
    {
        public int Width;
        public int Height;
    }

    [Flags]
    private enum ShellImageFlags
    {
        ThumbnailOnly = 0x00000008,
        InCacheOnly = 0x00000010
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    private interface IShellItemImageFactory
    {
        [PreserveSig]
        int GetImage(NativeSize size, ShellImageFlags flags, out IntPtr bitmapHandle);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory imageFactory);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr objectHandle);

    private static string Decode(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static string Encode(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? String.Empty));
    }

    private static void SaveJpegFromCache(string sourcePath, string targetPath, int requestedSize)
    {
        var interfaceId = typeof(IShellItemImageFactory).GUID;
        IShellItemImageFactory factory = null;
        IntPtr bitmapHandle = IntPtr.Zero;

        try
        {
            SHCreateItemFromParsingName(sourcePath, IntPtr.Zero, ref interfaceId, out factory);
            var size = Math.Max(160, Math.Min(1024, requestedSize));
            var result = factory.GetImage(
                new NativeSize { Width = size, Height = size },
                ShellImageFlags.ThumbnailOnly | ShellImageFlags.InCacheOnly,
                out bitmapHandle);
            if (result < 0 || bitmapHandle == IntPtr.Zero)
                Marshal.ThrowExceptionForHR(result);

            var directory = Path.GetDirectoryName(targetPath);
            if (!String.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            var temporaryPath = targetPath + ".tmp-" + Guid.NewGuid().ToString("N");

            try
            {
                using (var bitmap = Image.FromHbitmap(bitmapHandle))
                {
                    var encoder = ImageCodecInfo.GetImageEncoders().First(item => item.FormatID == ImageFormat.Jpeg.Guid);
                    using (var parameters = new EncoderParameters(1))
                    {
                        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                        bitmap.Save(temporaryPath, encoder, parameters);
                    }
                }

                if (File.Exists(targetPath)) File.Delete(temporaryPath);
                else File.Move(temporaryPath, targetPath);
            }
            finally
            {
                if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
        }
        finally
        {
            if (bitmapHandle != IntPtr.Zero) DeleteObject(bitmapHandle);
            if (factory != null && Marshal.IsComObject(factory)) Marshal.FinalReleaseComObject(factory);
        }
    }

    [STAThread]
    private static void Main()
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            var fields = line.Split('\t');
            if (fields.Length != 4) continue;
            var requestId = fields[0];
            try
            {
                var requestedSize = Int32.Parse(fields[1]);
                SaveJpegFromCache(Decode(fields[2]), Decode(fields[3]), requestedSize);
                Console.WriteLine(requestId + "\t1\t");
            }
            catch (Exception error)
            {
                // A cache miss is expected and intentionally stays on stdout so
                // the Node client can fall back without treating it as a crash.
                Console.WriteLine(requestId + "\t0\t" + Encode(error.Message));
            }
            Console.Out.Flush();
        }
    }
}
