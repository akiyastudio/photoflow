using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class Native
{
    internal const int GWL_STYLE = -16; internal const long WS_CHILD = 0x40000000L; internal const long WS_POPUP = 0x80000000L; internal const long WS_CAPTION = 0x00C00000L;
    internal const uint SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040; internal const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, RGN_DIFF = 4;
    [DllImport("user32.dll", SetLastError=true)] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", SetLastError=true)] internal static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtr", SetLastError=true)] internal static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="GetWindowLong", SetLastError=true)] internal static extern IntPtr GetWindowLongPtr32(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtr", SetLastError=true)] internal static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint="SetWindowLong", SetLastError=true)] internal static extern IntPtr SetWindowLongPtr32(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll", SetLastError=true)] internal static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateEllipticRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] internal static extern int CombineRgn(IntPtr destination, IntPtr source1, IntPtr source2, int mode);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr value);
    internal static IntPtr GetStyle(IntPtr window) { return IntPtr.Size == 8 ? GetWindowLongPtr64(window, GWL_STYLE) : GetWindowLongPtr32(window, GWL_STYLE); }
    internal static void SetStyle(IntPtr window, IntPtr style) { if (IntPtr.Size == 8) SetWindowLongPtr64(window, GWL_STYLE, style); else SetWindowLongPtr32(window, GWL_STYLE, style); }
}

internal static class Program
{
    private static int ReadInt(Dictionary<string, object> value, string key) { object raw; double number; return value.TryGetValue(key, out raw) && double.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out number) ? (int)Math.Round(number) : 0; }
    private static void Cut(IntPtr region, Dictionary<string, object> value, string prefix, bool ellipse)
    {
        int x=ReadInt(value,prefix+"X"), y=ReadInt(value,prefix+"Y"), w=ReadInt(value,prefix+"Width"), h=ReadInt(value,prefix+"Height"); if(w<=0||h<=0)return;
        IntPtr hole=ellipse?Native.CreateEllipticRgn(x,y,x+w,y+h):Native.CreateRectRgn(x,y,x+w,y+h); Native.CombineRgn(region,region,hole,Native.RGN_DIFF); Native.DeleteObject(hole);
    }
    private static void Bounds(IntPtr child, Dictionary<string, object> value)
    {
        int x=ReadInt(value,"x"),y=ReadInt(value,"y"),w=Math.Max(1,ReadInt(value,"width")),h=Math.Max(1,ReadInt(value,"height"));
        IntPtr region=Native.CreateRectRgn(0,0,w,h); Cut(region,value,"hole",false); Cut(region,value,"controlsHole",false); Cut(region,value,"cornerHole",true); Native.SetWindowRgn(child,region,true);
        bool visible=value.ContainsKey("visible")&&Convert.ToBoolean(value["visible"])&&ReadInt(value,"width")>0&&ReadInt(value,"height")>0;
        if(visible){Native.ShowWindow(child,Native.SW_SHOWNOACTIVATE);Native.SetWindowPos(child,IntPtr.Zero,x,y,w,h,Native.SWP_NOACTIVATE|Native.SWP_SHOWWINDOW);}else Native.ShowWindow(child,Native.SW_HIDE);
    }
    private static long Arg(string[] args,string name){for(int i=0;i+1<args.Length;i++)if(args[i]==name){long value;return long.TryParse(args[i+1],out value)?value:0;}return 0;}
    private static string TextArg(string[] args,string name){for(int i=0;i+1<args.Length;i++)if(args[i]==name)return args[i+1];return string.Empty;}
    private static int Main(string[] args)
    {
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);var serializer=new JavaScriptSerializer{MaxJsonLength=256*1024};
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        IntPtr parent=new IntPtr(Arg(args,"--parent-hwnd")),child=new IntPtr(Arg(args,"--child-hwnd"));uint expected=(uint)Arg(args,"--expected-pid"),actual;string sessionId=TextArg(args,"--session-id");
        if(parent==IntPtr.Zero||child==IntPtr.Zero||expected==0||string.IsNullOrWhiteSpace(sessionId)||Native.GetWindowThreadProcessId(child,out actual)==0||actual!=expected){Console.Error.WriteLine("surface ownership validation failed");return 2;}
        long style=Native.GetStyle(child).ToInt64();Native.SetStyle(child,new IntPtr((style|Native.WS_CHILD)&~Native.WS_POPUP&~Native.WS_CAPTION));
        if(Native.SetParent(child,parent)==IntPtr.Zero&&Marshal.GetLastWin32Error()!=0){Console.Error.WriteLine("surface attach failed");return 3;}Native.ShowWindow(child,Native.SW_HIDE);Console.Out.WriteLine(serializer.Serialize(new Dictionary<string,object>{{"type","ready"},{"sessionId",sessionId}}));Console.Out.Flush();
        try{string line;while((line=Console.In.ReadLine())!=null){if(Encoding.UTF8.GetByteCount(line)>256*1024)throw new InvalidOperationException("frame too large");var value=serializer.Deserialize<Dictionary<string,object>>(line);object command;if(!value.TryGetValue("command",out command))continue;string name=Convert.ToString(command);if(name=="close")break;if(name=="bounds")Bounds(child,value);}}
        finally{Native.ShowWindow(child,Native.SW_HIDE);Native.SetWindowRgn(child,IntPtr.Zero,true);Native.SetParent(child,IntPtr.Zero);}return 0;
    }
}
