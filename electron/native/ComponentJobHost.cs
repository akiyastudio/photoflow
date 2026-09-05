using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class ComponentJobHost
{
    private const uint CREATE_SUSPENDED=4,CREATE_UNICODE_ENVIRONMENT=0x400,STARTF_USESTDHANDLES=0x100,JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000,SYNCHRONIZE=0x00100000,WAIT_OBJECT_0=0;
    private const int JobObjectBasicAccountingInformation=1,JobObjectExtendedLimitInformation=9,MaxConfigBytes=1024*1024;
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct STARTUPINFO{public int cb;public string lpReserved,lpDesktop,lpTitle;public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute;public uint dwFlags;public short wShowWindow,cbReserved2;public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;}
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION{public IntPtr hProcess,hThread;public uint dwProcessId,dwThreadId;}
    [StructLayout(LayoutKind.Sequential)] private struct BASIC_LIMIT{public long a,b;public uint LimitFlags;public UIntPtr c,d;public uint e;public UIntPtr f;public uint g,h;}
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS{public ulong a,b,c,d,e,f;}
    [StructLayout(LayoutKind.Sequential)] private struct EXTENDED_LIMIT{public BASIC_LIMIT BasicLimitInformation;public IO_COUNTERS IoInfo;public UIntPtr a,b,c,d;}
    [StructLayout(LayoutKind.Sequential)] private struct ACCOUNTING{public long a,b,c,d;public uint e,f,ActiveProcesses,h;}
    private sealed class LaunchConfig{public string command{get;set;}public string[] args{get;set;}public string cwd{get;set;}public Dictionary<string,string> env{get;set;}}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]private static extern IntPtr CreateJobObject(IntPtr a,string n);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool QueryInformationJobObject(IntPtr j,int c,out ACCOUNTING i,uint l,IntPtr r);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool TerminateJobObject(IntPtr j,uint c);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]private static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern uint WaitForSingleObject(IntPtr h,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool GetExitCodeProcess(IntPtr p,out uint c);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern uint GetProcessId(IntPtr p);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern bool TerminateProcess(IntPtr p,uint c);
    [DllImport("kernel32.dll")]private static extern void ExitProcess(uint c);
    [DllImport("kernel32.dll",SetLastError=true)]private static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll")]private static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")]private static extern bool CloseHandle(IntPtr h);
    private static IntPtr job,parentHandle,targetHandle,targetThread;private static volatile bool terminating,controlClosed,launched;private static readonly object writerLock=new object();private static StreamWriter writer;
    private static string Quote(string value){if(!String.IsNullOrEmpty(value)&&value.IndexOfAny(new[]{' ','\t','"'})<0)return value;var r=new StringBuilder("\"");int s=0;foreach(char ch in value??""){if(ch=='\\'){s++;continue;}if(ch=='"'){r.Append('\\',s*2+1).Append(ch);s=0;continue;}r.Append('\\',s).Append(ch);s=0;}r.Append('\\',s*2).Append('"');return r.ToString();}
    private static uint ActiveCount(){ACCOUNTING i;if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,out i,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());return i.ActiveProcesses;}
    private static void Send(string json){lock(writerLock){if(writer==null)return;try{writer.WriteLine(json);writer.Flush();}catch{FailClosed();}}}
    private static bool WaitEmpty(int ms){var end=DateTime.UtcNow.AddMilliseconds(ms);do{if(ActiveCount()==0)return true;Thread.Sleep(15);}while(DateTime.UtcNow<end);return ActiveCount()==0;}
    private static byte[] ReadExact(Stream stream,int count){var data=new byte[count];int offset=0;while(offset<count){int n=stream.Read(data,offset,count-offset);if(n<=0)throw new EndOfStreamException();offset+=n;}return data;}
    private static IntPtr EnvironmentBlock(Dictionary<string,string> env){if(env==null)return IntPtr.Zero;var keys=new List<string>(env.Keys);keys.Sort(StringComparer.OrdinalIgnoreCase);var b=new StringBuilder();foreach(var key in keys){if(String.IsNullOrEmpty(key)||key.IndexOf('\0')>=0||key.IndexOf('=')>=0)throw new InvalidDataException("invalid environment key");var value=env[key]??"";if(value.IndexOf('\0')>=0)throw new InvalidDataException("invalid environment value");b.Append(key).Append('=').Append(value).Append('\0');}b.Append('\0');return Marshal.StringToHGlobalUni(b.ToString());}
    private static void FailClosed(){terminating=true;if(job!=IntPtr.Zero&&launched)TerminateJobObject(job,0xC000013A);else if(targetHandle!=IntPtr.Zero)TerminateProcess(targetHandle,0xC000013A);}
    private static void MonitorTree()
    {
        try
        {
            while(WaitForSingleObject(targetHandle,25)!=WAIT_OBJECT_0){if(terminating||controlClosed){if(ActiveCount()==0){Send("{\"event\":\"empty\",\"active\":0}");ExitProcess(0);}}}
            uint code=239;if(!GetExitCodeProcess(targetHandle,out code))code=239;
            var accountingSettle=DateTime.UtcNow.AddMilliseconds(150);uint remaining=ActiveCount();while(remaining>0&&DateTime.UtcNow<accountingSettle){Thread.Sleep(5);remaining=ActiveCount();}bool orphaned=remaining>0;
            if(orphaned){terminating=true;if(!TerminateJobObject(job,0xC000013A)||!WaitEmpty(10000)){Send("{\"event\":\"error\",\"message\":\"orphan-descendant-termination-failed\"}");ExitProcess(248);}}
            Send("{\"event\":\"empty\",\"active\":0,\"orphanDescendants\":"+(orphaned?"true":"false")+"}");
            ExitProcess((uint)(orphaned&&code==0?250:(code>239?239:(int)code)));
        }
        catch{FailClosed();ExitProcess(249);}
    }
    private static void ControlLoop(string pipeName,ManualResetEvent configured,Action<LaunchConfig> launch)
    {
        try
        {
            using(var commandPipe=new NamedPipeServerStream(pipeName+"-in",PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous))
            using(var eventPipe=new NamedPipeServerStream(pipeName+"-out",PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.WriteThrough))
            {
                commandPipe.WaitForConnection();eventPipe.WaitForConnection();
                writer=new StreamWriter(eventPipe,new UTF8Encoding(false),1024,true);
                int size=BitConverter.ToInt32(ReadExact(commandPipe,4),0);
                if(size<=0||size>MaxConfigBytes)throw new InvalidDataException("launch config size");
                var json=Encoding.UTF8.GetString(ReadExact(commandPipe,size));
                var serializer=new JavaScriptSerializer{MaxJsonLength=MaxConfigBytes,RecursionLimit=16};
                launch(serializer.Deserialize<LaunchConfig>(json));
                configured.Set();
                Send("{\"event\":\"ready\",\"active\":"+ActiveCount()+",\"targetPid\":"+GetProcessId(targetHandle)+"}");
                new Thread(MonitorTree){IsBackground=true,Name="ComponentJobMonitor"}.Start();
                using(var reader=new StreamReader(commandPipe,Encoding.UTF8,false,1024,true))
                {
                    string line;
                    while((line=reader.ReadLine())!=null)
                    {
                        if(line=="status")Send("{\"event\":\"status\",\"active\":"+ActiveCount()+"}");
                        else if(line.StartsWith("terminate "))
                        {
                            terminating=true;
                            if(!TerminateJobObject(job,0xC000013A)){Send("{\"event\":\"error\",\"code\":"+Marshal.GetLastWin32Error()+"}");continue;}
                            int remaining;if(!Int32.TryParse(line.Substring(10),out remaining))remaining=1;bool empty=WaitEmpty(Math.Max(1,Math.Min(10000,remaining)));
                            Send("{\"event\":\"terminated\",\"active\":"+ActiveCount()+",\"confirmed\":"+(empty?"true":"false")+"}");
                            if(!empty)return;
                        }
                    }
                }
                controlClosed=true;FailClosed();
                if(WaitEmpty(10000)){Send("{\"event\":\"empty\",\"active\":0}");ExitProcess(0);}
                Send("{\"event\":\"error\",\"message\":\"control-loss-termination-timeout\"}");ExitProcess(248);
            }
        }
        catch(Exception error){FailClosed();bool empty=false;try{empty=WaitEmpty(10000);}catch{}Send("{\"event\":\"error\",\"message\":\""+error.GetType().Name+"\",\"treeConfirmed\":"+(empty?"true":"false")+",\"active\":"+(empty?"0":"-1")+"}");}
        finally{controlClosed=true;FailClosed();configured.Set();}
    }
    private static int Main(string[] args)
    {
        uint parentPid;
        if(args.Length!=4||args[0]!="--pipe"||args[2]!="--parent"||!UInt32.TryParse(args[3],out parentPid))return 240;
        parentHandle=OpenProcess(SYNCHRONIZE,false,parentPid);if(parentHandle==IntPtr.Zero)return 241;
        job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)return 242;
        var limits=new EXTENDED_LIMIT();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var ptr=Marshal.AllocHGlobal(Marshal.SizeOf(limits));
        try{Marshal.StructureToPtr(limits,ptr,false);if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,ptr,(uint)Marshal.SizeOf(limits)))return 243;}finally{Marshal.FreeHGlobal(ptr);}
        var configured=new ManualResetEvent(false);int launchError=0;
        Action<LaunchConfig> launch=config=>{try{
            if(config==null||String.IsNullOrWhiteSpace(config.command)||config.args==null||config.command.IndexOf('\0')>=0||(config.cwd??"").IndexOf('\0')>=0)throw new InvalidDataException("launch config");
            var cmd=new StringBuilder(Quote(config.command));foreach(var arg in config.args){if(arg==null||arg.IndexOf('\0')>=0)throw new InvalidDataException("launch argument");cmd.Append(' ').Append(Quote(arg));}
            var si=new STARTUPINFO{cb=Marshal.SizeOf(typeof(STARTUPINFO)),dwFlags=STARTF_USESTDHANDLES,hStdInput=GetStdHandle(-10),hStdOutput=GetStdHandle(-11),hStdError=GetStdHandle(-12)};
            var env=EnvironmentBlock(config.env);PROCESS_INFORMATION pi;
            try{if(!CreateProcess(null,cmd,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,env,String.IsNullOrEmpty(config.cwd)?Environment.CurrentDirectory:config.cwd,ref si,out pi))throw new Win32Exception(Marshal.GetLastWin32Error());}finally{if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);}
            targetHandle=pi.hProcess;targetThread=pi.hThread;
            if(!AssignProcessToJobObject(job,targetHandle)){int nativeError=Marshal.GetLastWin32Error();TerminateProcess(targetHandle,0xC000013A);WaitForSingleObject(targetHandle,10000);throw new Win32Exception(nativeError);}
            launched=true;if(ResumeThread(targetThread)==0xFFFFFFFF){TerminateJobObject(job,0xC000013A);throw new Win32Exception(Marshal.GetLastWin32Error());}
        }catch(Exception){launchError=244;FailClosed();throw;}};
        var control=new Thread(()=>ControlLoop(args[1],configured,launch)){IsBackground=true,Name="ComponentJobControl"};control.Start();
        var handshakeDeadline=DateTime.UtcNow.AddSeconds(10);
        while(!configured.WaitOne(25)){if(WaitForSingleObject(parentHandle,0)==WAIT_OBJECT_0||DateTime.UtcNow>=handshakeDeadline){FailClosed();return 245;}}
        if(launchError!=0||!launched){control.Join(2000);return launchError!=0?launchError:246;}
        var shutdownDeadline=DateTime.MaxValue;
        while(true){
            if(WaitForSingleObject(parentHandle,0)==WAIT_OBJECT_0||controlClosed||terminating){if(shutdownDeadline==DateTime.MaxValue){FailClosed();shutdownDeadline=DateTime.UtcNow.AddSeconds(10);}}
            if(shutdownDeadline!=DateTime.MaxValue&&DateTime.UtcNow>=shutdownDeadline){if(job!=IntPtr.Zero)CloseHandle(job);ExitProcess(248);return 248;}
            Thread.Sleep(25);
        }
    }
}
