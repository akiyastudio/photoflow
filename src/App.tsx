import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  FolderInput, 
  Image as ImageIcon, 
  ScanSearch, 
  ArrowRightLeft, 
  HardDrive,
  Play,
  Trash2,
  AlertCircle,
  Edit,
  X,
  Plus,
  User,
  Loader2, 
  CheckCircle2, 
  RotateCcw,
  FileDiff,
  Settings,
  Download,
  AtSign,
  ExternalLink,
  Gift,
  Scissors,
  Video,
  Puzzle
} from 'lucide-react';
import { Terminal } from './components/Terminal';
import type { LogEntry, ToolType } from './types';

// --- 类型定义 ---

interface AppConfig {
  smartImport: {
    autoStart: boolean;
    sdPath: string;
    destPath: string;
    backupEnabled: boolean;
    backupPath: string;
  };
  smartMatch: {
    destFolderName: string;
  };
  research: {
    defaultDir: string;
    ssimThreshold: number;
    minDuration: number;
  };
}

const isMac = window.navigator.userAgent.includes('Mac');

const DEFAULT_CONFIG = (userPath: string): AppConfig => ({
  smartImport: {
    autoStart: false,
    sdPath: isMac ? "/Volumes" : "H:/DCIM",
    destPath: `${userPath}/Desktop`,
    backupEnabled: false,
    backupPath: isMac ? `${userPath}/Pictures/Backup` : "D:/Backup"
  },
  smartMatch: {
    destFolderName: "1" 
  },
  research: {
    defaultDir: `${userPath}/Downloads`,
    ssimThreshold: 0.95,
    minDuration: 0.2
  }
});

interface PythonEvent {
  type: 'log' | 'error' | 'progress' | 'status' | 'ask_user' | 'success' | 'warning';
  message: string;
  data?: any;
  progress?: number;
}

const RequirePlugin = ({ scriptName, title, desc, children }: { scriptName: string, title: string, desc: string, children: React.ReactNode }) => {
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      // 如果后端提供了 checkScript 方法，则调用它检测文件是否存在
      if (window.electronAPI && 'checkScript' in window.electronAPI) {
        try {
          // @ts-ignore
          const exists = await window.electronAPI.checkScript(scriptName);
          setIsInstalled(exists);
        } catch (e) {
          setIsInstalled(false);
        }
      } else {
        // 如果你的 Electron 后端还没写这个 API，默认放行，并在控制台提示
        console.warn(`[插件系统] 未检测到 electronAPI.checkScript，跳过验证: ${scriptName}`);
        setIsInstalled(true); 
      }
    };
    check();
  }, [scriptName]);

  if (isInstalled === null) {
    return <div className="p-8 flex items-center gap-3 text-slate-500"><Loader2 className="animate-spin" size={18}/> 检测组件状态...</div>;
  }

  if (!isInstalled) {
    return (
      <div className="w-full space-y-6">
        <h2 className="text-2xl font-bold text-slate-800">{title}</h2>
        <div className="bg-white border border-slate-200 rounded-xl p-12 flex flex-col items-center justify-center text-center space-y-4 shadow-sm">
            <div className="w-16 h-16 bg-slate-50 border border-slate-100 rounded-2xl flex items-center justify-center text-slate-400 mb-2">
                <Puzzle size={32} />
            </div>
            <h3 className="text-xl font-bold text-slate-800">未安装此功能组件</h3>
            <p className="text-slate-500 text-sm max-w-md">
                没有文件 <strong className="text-blue-600">{scriptName}</strong>。<br/>
                {desc}
            </p>
            <button disabled className="mt-4 px-6 py-2 bg-slate-100 text-slate-400 rounded-lg font-bold border border-slate-200 cursor-not-allowed">
                组件缺失
            </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

// --- 主组件 ---

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ToolType>('dashboard');
  const [showAbout, setShowAbout] = useState(false);
  
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{version: string, url: string, notes: string} | null>(null);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        if (window.electronAPI?.loadConfig) {
          const fileConfig = await window.electronAPI.loadConfig();
          if (fileConfig) {
            setConfig(fileConfig);
            console.log('📋 Configuration loaded from file');
          } else {
            if (window.electronAPI?.getUserPath) {
              const userPath = await window.electronAPI.getUserPath();
              if (userPath) {
                const defaultConfig = DEFAULT_CONFIG(userPath);
                setConfig(defaultConfig);
                console.log('📋 Configuration created with user path:', userPath);
              } else {
                console.error('❌ Failed to get user path');
              }
            }
          }
        }
      } catch (error) {
        console.error('Failed to load config:', error);
      } finally {
        setConfigLoaded(true);
      }
    };

    loadConfig();
  }, []);

  useEffect(() => {
    if (window.electronAPI?.onUpdateAvailable) {
      const cleanup = window.electronAPI.onUpdateAvailable((info: any) => {
        console.log("Update available:", info);
        setUpdateInfo(info);
      });
      return cleanup;
    }
  }, []);

  const handleConfigUpdate = async (newConfig: AppConfig) => {
    setConfig(newConfig);
    try {
      if (window.electronAPI?.saveConfig) {
        const result = await window.electronAPI.saveConfig(newConfig);
        if (result.success) {
          console.log('✅ Configuration saved successfully');
        } else {
          console.error('Failed to save config:', result.error);
        }
      }
    } catch (error) {
      console.error('Error saving config:', error);
    }
  };

  // 等待配置加载完成再渲染主界面
  if (!configLoaded || !config) {
    return (
      <div className="flex items-center justify-center h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-900 overflow-hidden relative">
        {/* 背景装饰 */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-50 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl"></div>
        
        <div className="text-center z-10 space-y-8">
          {/* ✅ 加载动画 */}
          <div className="flex justify-center">
            <div className="relative w-20 h-20">
              {/* 外圆 */}
              <div className="absolute inset-0 rounded-full border-4 border-slate-200/30"></div>
              
              {/* 旋转动画 */}
              <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-400 border-r-blue-300 animate-spin"></div>
              
              {/* 内圆脉冲 */}
              <div className="absolute inset-4 rounded-full border-2 border-blue-500/30 animate-pulse"></div>
              
              {/* 中心点 */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
              </div>
            </div>
          </div>
          
          {/* 文字 */}
          <div className="space-y-2">
            <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
              照片流
            </h2>
            <p className="text-sm text-slate-500 font-mono">初始化配置中...</p>
          </div>
          
          {/* 加载进度条 */}
          <div className="w-48 h-1 bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full animate-pulse" style={{
              width: '60%',
              animation: 'loadingBar 1.5s ease-in-out infinite'
            }}></div>
          </div>
        </div>
        
        {/* ✅ CSS 动画 */}
        <style>{`
          @keyframes loadingBar {
            0% { width: 10%; }
            50% { width: 80%; }
            100% { width: 10%; }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900 font-sans selection:bg-blue-500/30">

      {updateInfo && (
        <UpdateModal 
          version={updateInfo.version}
          url={updateInfo.url}
          notes={updateInfo.notes}
          onClose={() => setUpdateInfo(null)}
        />
      )}

      {showAbout && config && (
        <AboutModal 
          onClose={() => setShowAbout(false)} 
        />
      )}

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-200">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent cursor-default">
            照片流
          </h1>
          <p className="text-xs text-slate-500 mt-1 font-mono">v26.5.10 by秋也寻</p>
        </div>

        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          <SidebarItem 
            active={activeTab === 'dashboard'} 
            onClick={() => setActiveTab('dashboard')} 
            icon={<LayoutDashboard size={20} />} 
            label="从SD卡导入" 
          />
          <div className="pt-4 pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            处理
          </div>
          <SidebarItem 
            active={activeTab === 'converter'} 
            onClick={() => setActiveTab('converter')} 
            icon={<ImageIcon size={20} />} 
            label="PNG 转 JPG" 
          />
          <SidebarItem 
            active={activeTab === 'match'} 
            onClick={() => setActiveTab('match')} 
            icon={<ArrowRightLeft size={20} />} 
            label="选片" 
          />
          <SidebarItem 
            active={activeTab === 'rename_tool'} 
            onClick={() => setActiveTab('rename_tool')} 
            icon={<FileDiff size={20} />} 
            label="整理前后期图片" 
          />
          <SidebarItem 
            active={activeTab === 'video_split'} 
            onClick={() => setActiveTab('video_split')} 
            icon={<Scissors size={20} />} 
            label="视频对半切割" 
          />
          <div className="pt-4 pb-2 px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            分析
          </div>
          <SidebarItem 
            active={activeTab === 'research'} 
            onClick={() => setActiveTab('research')} 
            icon={<ScanSearch size={20} />} 
            label="调研整理" 
          />
        </nav>

        <div className="p-4 border-t border-slate-200">
          <div className="flex flex-col rounded-lg border border-slate-200 bg-white overflow-hidden divide-y divide-slate-50">
            <button 
              onClick={() => setShowAbout(true)}
              className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition-all group"
            >
              <AtSign size={18} className="group-hover:rotate-90 transition-transform duration-500 text-slate-400" />
              <span className="font-medium text-sm">关于</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-slate-50 p-8 relative">
        {activeTab === 'dashboard' && (
          <DashboardView config={config.smartImport} onUpdateConfig={(newConfig: AppConfig['smartImport']) => handleConfigUpdate({...config, smartImport: newConfig})} />
        )}
        
        {activeTab === 'converter' && (
          <RequirePlugin scriptName="png_to_jpg.py" title="PNG 转 JPG" desc="需要该引擎来执行图片格式的批量转换。">
            <ConverterView />
          </RequirePlugin>
        )}
        
        {activeTab === 'research' && (
          <RequirePlugin scriptName="research.py" title="调研整理" desc="需要该引擎来执行视频分镜识别和图片去重。">
            <ResearchView config={config.research} onUpdateConfig={(newConfig: AppConfig['research']) => handleConfigUpdate({ ...config, research: newConfig })}/>
          </RequirePlugin>
        )}
        
        {activeTab === 'match' && (
          <RequirePlugin scriptName="catch.py" title="选片" desc="需要该引擎来根据关键词提取对应的 RAW 照片。">
            <MatchView config={config.smartMatch} onUpdateConfig={(newConfig: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch: newConfig })} />
          </RequirePlugin>
        )}
        
        {activeTab === 'rename_tool' && (
          <RequirePlugin scriptName="rename.py" title="整理前后期图片" desc="需要该引擎进行 pHash 视觉图像指纹比对。">
            <RenameView />
          </RequirePlugin>
        )}
        
        {activeTab === 'video_split' && (
          <RequirePlugin scriptName="cut_video.py" title="视频对半切割" desc="需要调用底层引擎进行极速无损视频切割。">
            <VideoSplitView />
          </RequirePlugin>
        )}
      </main>
    </div>
  );
};

// --- 主功能 ---
const ImportCard = ({ config }: { config?: AppConfig['smartImport'] }) => {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready_to_import' | 'importing' | 'decision' | 'processing' | 'finished'>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("等待连接...");
  const [decisionData, setDecisionData] = useState<any>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  
  // 【关键修改】使用 Ref 来做“防抖”锁，防止 SD 卡接触不良导致多次触发 startImport
  const isBusyRef = React.useRef(false);

  const runCmd = (stage: string, args: string[] = []) => {
    if(window.electronAPI) window.electronAPI.runScript('classify.py', ['--stage', stage, ...args]);
  };

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    
    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      // 1. 记录日志
      if (event.message) {
        setLogs(prev => {
           // 简单的去重逻辑，防止同样的日志刷屏
           const last = prev[prev.length - 1];
           if (last && last.message === event.message && event.type === 'progress') return prev;
           
           return [...prev, {
            timestamp: new Date().toLocaleTimeString(),
            message: event.message,
            type: event.type as any
           }];
        });
      }

      // 2. 处理事件
      switch (event.type) {
        case 'status':
          // 只有当状态是 idle 或 checking 时，才允许响应连接信号
          if (event.data?.connected) {
            // 【关键判断】如果当前正在忙（正在导入或处理），直接忽略这次信号
            if (isBusyRef.current) return;

            setStatus('ready_to_import');
            setStatusMsg("检测到设备: " + event.data.path);
            
            // 延迟一点启动，给 UI 一个反应时间
            setTimeout(() => {
                if (!isBusyRef.current) {
                    startImport();
                }
            }, 500);
          } else {
             // 只有在非运行状态下才重置为 idle，防止导入过程中拔卡导致界面重置
             if (!isBusyRef.current) {
                setStatus('idle');
                setStatusMsg("未检测到 SD 卡");
             }
          }
          break;

        case 'progress':
          setProgress(event.progress || 0);
          // Python 那边现在发过来的是 "正在导入: IMG_001.JPG"，这里直接显示
          setStatusMsg(event.message);
          break;

        case 'ask_user':
          if (event.data?.need_split) { 
            setStatus('decision');
            setDecisionData(event.data);
            setStatusMsg(event.message);
          }
          break;

        case 'success':
          setStatus('finished');
          setStatusMsg("处理完成");
          isBusyRef.current = false; // 【解锁】
          break;

        case 'error':
          // 如果是普通的 warning 不打断流程
          if (event.message.includes("警告")) return;
          
          // 严重错误
          setStatusMsg("Error: " + event.message);
          isBusyRef.current = false; // 【解锁】
          break;
      }
    });

    return cleanup;
  }, []); // 依赖为空，确保监听器只绑定一次

  // 自动检查逻辑
  useEffect(() => {
    if (config?.autoStart && !isBusyRef.current) {
      checkSD();
    }
  }, [config?.autoStart]);

  const checkSD = () => {
    if (isBusyRef.current) return;

    setStatus('checking');
    setStatusMsg("正在扫描设备...");
    setLogs([]); 
    
    const args = [];
    if (config) {
      args.push('--sd_path', config.sdPath);
    }
    runCmd('check', args);

    // 超时重置
    setTimeout(() => {
      setStatus((prevStatus) => {
        if (prevStatus === 'checking') {
          setStatusMsg("未检测到 SD 卡");
          return 'idle';
        }
        return prevStatus;
      });
    }, 30000);
  };

  const startImport = () => {
    if (isBusyRef.current) {
        console.log("Import already running, skipped.");
        return;
    }
    
    isBusyRef.current = true; // 【上锁】
    setStatus('importing');
    setProgress(0);
    setLogs([]); // 清空日志准备开始
    
    const args = [];
    if (config) {
      args.push('--sd_path', config.sdPath);
      args.push('--dest_path', config.destPath);
      if (config.backupEnabled && config.backupPath) {
        args.push('--backup_path', config.backupPath);
      }
    }
    runCmd('import', args);
  };

  const handleDecision = (split: boolean) => {
    setStatus('processing');
    setProgress(0);
    const args = [];
    if (config) {
      args.push('--sd_path', config.sdPath);
      args.push('--dest_path', config.destPath);
      if (config.backupEnabled && config.backupPath) {
        args.push('--backup_path', config.backupPath);
      }
      // 添加用户决定的参数
      args.push('--should_split', split ? 'true' : 'false');
    }
    
    // 重新启动导入流程（因为临时文件已经存在，所以会很快）
    runCmd('import', args);
  };

  // --- 渲染逻辑 (UI 部分) ---

  if (status === 'idle' || status === 'checking') {
    return (
      <div className="w-full bg-white/50 border border-slate-200 rounded-xl p-4 flex items-center justify-between animate-in fade-in">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${status === 'checking' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>
            {status === 'checking' ? <Loader2 className="animate-spin" size={18} /> : <HardDrive size={18} />}
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold text-slate-800">从SD卡导入媒体</span>
            <span className="text-xs text-slate-500">{status === 'checking' ? '正在搜索 SD 卡...' : '未检测到 SD 卡连接'}</span>
          </div>
        </div>
        <button 
          onClick={checkSD}
          disabled={status === 'checking'}
          className="p-2 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-slate-800 transition disabled:opacity-50"
          title="重新扫描"
        >
          <RotateCcw size={18} className={status === 'checking' ? 'animate-spin' : ''} />
        </button>
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      {/* 主卡片 */}
      <div className="bg-white/50 border border-slate-200 rounded-xl p-6 flex flex-col relative overflow-hidden min-h-[250px] animate-in slide-in-from-top-2">
        {/* 顶部标题栏 */}
        <div className="flex justify-between items-center mb-6 z-10">
          <h3 className="text-lg font-semibold text-blue-200 flex items-center gap-2">
            <FolderInput size={20} /> 
            从SD卡导入图片
          </h3>
          <span className="text-xs px-2 py-1 rounded border font-mono bg-blue-500/20 text-blue-300 border-blue-500/30">
            {status.toUpperCase().replace('_', ' ')}
          </span>
        </div>

        {/* 背景装饰 */}
        <div className="absolute top-0 left-0 p-24 bg-blue-500/5 blur-3xl rounded-full pointer-events-none"></div>

        {/* 内容区域 */}
        <div className="flex-1 flex flex-col justify-center items-center text-center space-y-4 z-10 w-full">
          
          {/* State: Ready */}
          {status === 'ready_to_import' && (
            <div className="flex flex-col items-center w-full">
              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4 text-blue-600">
                <Loader2 className="animate-spin" size={32} />
              </div>
              <p className="text-slate-800 font-bold text-lg mb-1">准备导入...</p>
              <p className="text-slate-500 text-sm mb-6">{statusMsg}</p>
            </div>
          )}

          {/* State: Progress (Importing or Processing) */}
          {(status === 'importing' || status === 'processing') && (
            <div className="w-full max-w-sm space-y-3">
              <div className="flex justify-between text-xs text-slate-500 font-mono">
                <span>{status === 'importing' ? 'COPYING...' : 'ORGANIZING...'}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-200/50">
                <div className="h-full bg-blue-500 transition-all duration-300 relative" style={{ width: `${progress}%` }}></div>
              </div>
              {/* 文件名显示区域 */}
              <p className="text-sm text-slate-800 mt-2 font-mono truncate w-full px-4">
                {statusMsg}
              </p>
            </div>
          )}

          {/* State: Decision */}
          {status === 'decision' && decisionData && (
            <div className="w-full bg-slate-50/80 p-5 rounded-xl border border-yellow-500/20 text-left animate-in zoom-in-95">
              <h4 className="text-slate-800 font-bold mb-2 flex items-center gap-2">
                <AlertCircle className="text-yellow-400" size={20} />
                需确认操作
              </h4>
              <p className="text-slate-500 text-sm mb-6">
                检测到拍摄时间有 2 小时以上的断层，是否需要拆分成不同日期的文件夹？
              </p>
              <div className="flex gap-3">
                <button 
                    onClick={() => handleDecision(true)} 
                    className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-slate-800 py-2 rounded-lg text-sm transition-colors"
                >
                    是，拆分文件夹
                </button>
                <button 
                    onClick={() => handleDecision(false)} 
                    className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-900 py-2 rounded-lg text-sm transition-colors"
                >
                    否，合并在一起
                </button>
              </div>
            </div>
          )}

          {/* State: Finished */}
          {status === 'finished' && (
            <div className="w-full text-left animate-in zoom-in-95">
              <div className="flex items-center gap-3 mb-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400">
                <CheckCircle2 size={28} />
                <div>
                    <h4 className="font-bold text-base">导入完成</h4>
                    <p className="text-xs text-emerald-500/70 mt-1">所有照片已导入</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 日志面板 */}
      <Terminal logs={logs} />
    </div>
  );
};

const BirthdayManagerModal = ({ onClose, onDataChanged }: { onClose: () => void, onDataChanged: () => void }) => {
  const [birthdays, setBirthdays] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newMonth, setNewMonth] = useState('');
  const [newDay, setNewDay] = useState('');
  
  useEffect(() => {
    const load = async () => {
      if (window.electronAPI) {
        const data = await window.electronAPI.getBirthdays();
        setBirthdays(data || {});
        setLoading(false);
      }
    };
    load();
  }, []);

  const sortedBirthdays = Object.entries(birthdays).sort(([, dateA], [, dateB]) => {
    const parse = (d: string) => {
       const clean = d.replace('月', '.').replace('日', '');
       const parts = clean.split('.');
       return { m: parseInt(parts[0]) || 0, d: parseInt(parts[1]) || 0 };
    };
    const a = parse(dateA);
    const b = parse(dateB);
    if (a.m !== b.m) return a.m - b.m;
    return a.d - b.d;
  });

  const handleSave = async () => {
    if (!newName.trim() || !newMonth || !newDay) return;
    const m = parseInt(newMonth).toString();
    const d = parseInt(newDay).toString();
    const dateStr = `${m}月.${d}日`;
    const newData = { ...birthdays, [newName]: dateStr };
    
    if (window.electronAPI) {
      await window.electronAPI.saveBirthdays(newData);
      setBirthdays(newData);
      setNewName('');
      setNewMonth('');
      setNewDay('');
      onDataChanged(); 
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`确定要删除 ${name} 吗？`)) return;
    const newData = { ...birthdays };
    delete newData[name];
    if (window.electronAPI) {
      await window.electronAPI.saveBirthdays(newData);
      setBirthdays(newData);
      onDataChanged();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0" onClick={onClose}></div>
      <div className="bg-white border border-slate-200 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[80vh] relative z-10">
        <div className="p-6 border-b border-slate-200 flex justify-between items-center bg-slate-200 rounded-t-2xl">
          <div><h3 className="text-xl font-bold text-slate-800">生日列表</h3></div>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-full text-slate-500 hover:text-slate-800 transition cursor-pointer"><X size={24} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-2">
          {loading ? <div className="text-center text-slate-500">Loading...</div> : 
           sortedBirthdays.map(([name, date]) => (
            <div key={name} className="flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200 group">
               <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400"><User size={14} /></div>
                  <div><div className="font-medium text-slate-900">{name}</div><div className="text-xs text-slate-500">{date}</div></div>
               </div>
               <button onClick={() => handleDelete(name)} className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-red-400 transition"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <div className="p-6 border-t border-slate-200 bg-white rounded-b-2xl">
           <div className="flex gap-3">
              <input placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-slate-800" />
              <input placeholder="M" type="number" value={newMonth} onChange={e => setNewMonth(e.target.value)} className="w-16 bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-center text-slate-800" />
              <input placeholder="D" type="number" value={newDay} onChange={e => setNewDay(e.target.value)} className="w-16 bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-center text-slate-800" />
              <button onClick={handleSave} className="bg-blue-500 text-slate-800 px-4 py-2 rounded-lg flex items-center gap-2"><Plus size={16} /> Add</button>
           </div>
        </div>
      </div>
    </div>
  );
};

const DashboardView = ({ 
  config, 
  onUpdateConfig 
}: { 
  config: AppConfig['smartImport']; 
  onUpdateConfig: (c: AppConfig['smartImport']) => void;
}) => {
  // 生日逻辑保持不变
  const [upcomingBirthdays, setUpcomingBirthdays] = useState<{name: string, date: string, sortKey: number}[]>([]);
  const [loading, setLoading] = useState(true);
  const [showManager, setShowManager] = useState(false);

  // 解析 "M月.D日" 格式
  const parseBirthday = (dateStr: string) => {
    const cleanStr = dateStr.replace('月', '.').replace('日', '');
    const parts = cleanStr.split('.');
    return {
      month: parseInt(parts[0]) || 0,
      day: parseInt(parts[1]) || 0
    };
  };

  const fetchBirthdays = async () => {
    if (!window.electronAPI) return;
    try {
      setLoading(true);
      const data = await window.electronAPI.getBirthdays();
      const today = new Date();
      const todayZero = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const currentMonth = today.getMonth() + 1;
      const nextMonth = (currentMonth % 12) + 1;
      const results: {name: string, date: string, sortKey: number}[] = [];

      Object.entries(data).forEach(([name, dateStr]) => {
        const { month, day } = parseBirthday(dateStr);
        if (month === currentMonth || month === nextMonth) {
          let targetYear = today.getFullYear();
          if (currentMonth === 12 && month === 1) targetYear += 1;
          const birthdayDate = new Date(targetYear, month - 1, day);
          if (birthdayDate < todayZero) return;
          results.push({ 
            name, 
            date: `${month}月${day}日`,
            sortKey: birthdayDate.getTime() 
          });
        }
      });
      results.sort((a, b) => a.sortKey - b.sortKey);
      setUpcomingBirthdays(results);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBirthdays();
  }, []);

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {showManager && (
        <BirthdayManagerModal 
          onClose={() => setShowManager(false)} 
          onDataChanged={fetchBirthdays} 
        />
      )}

      <div className="flex flex-col gap-6">
        <ImportCard config={config} />
        <div className="w-full bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-bold text-blue-400 uppercase tracking-wider flex items-center gap-2 mb-4">
            <Settings size={16} /> 导入偏好设置
          </h3>
          
          <div className="flex items-center gap-3 p-2 rounded hover:bg-slate-800/30 transition">
             <input 
               type="checkbox" 
               id="autoStart"
               checked={config.autoStart} 
               onChange={e => onUpdateConfig({...config, autoStart: e.target.checked})}
               className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500"
             />
             <label htmlFor="autoStart" className="text-sm text-slate-800 cursor-pointer select-none">
               应用启动时自动开始读取SD卡文件
             </label>
          </div>
          <p className="text-xs text-slate-500">
            支持佳能（.cr2 .cr3）、索尼（.arw）、尼康（.nef）、奥林巴斯（.orf）、徕卡（.rwl .dng）、富士（.raf）、哈苏（.3fr .fff）、大疆（.dng）的RAW格式导入。
          </p>
          
          <InputField 
            label="SD卡读取路径" 
            value={config.sdPath} 
            onChange={v => onUpdateConfig({...config, sdPath: v})} 
            icon={<FolderInput size={14}/>} 
          />
          <InputField 
            label="默认导入目标路径" 
            value={config.destPath} 
            onChange={v => onUpdateConfig({...config, destPath: v})} 
            icon={<Download size={14}/>} 
          />

          <div className="bg-white p-4 rounded-lg border border-slate-200 space-y-3">
             <div className="flex items-center gap-3 mb-2">
                <input 
                  type="checkbox" 
                  id="backupEnabled"
                  checked={config.backupEnabled} 
                  onChange={e => onUpdateConfig({...config, backupEnabled: e.target.checked})}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-green-500"
                />
                <label htmlFor="backupEnabled" className="text-sm text-slate-800 font-bold cursor-pointer select-none">
                  开启备份
                </label>
             </div>
             {config.backupEnabled && (
                <InputField 
                  label="备份目标路径" 
                  value={config.backupPath} 
                  onChange={v => onUpdateConfig({...config, backupPath: v})} 
                  icon={<HardDrive size={14}/>} 
                />
             )}
          </div>
        </div>

        <div className="w-full bg-gradient-to-br from-indigo-900/50 to-purple-900/50 border border-indigo-500/20 rounded-xl p-6 flex flex-col">
          <div className="flex justify-between items-start mb-6 z-10">
              <h3 className="text-lg font-semibold text-indigo-900 flex items-center gap-2">
                <span className="text-xl">🎂</span> 角色生日
              </h3>
          </div>
          
          <div className="flex-1 z-10">
              {loading ? (
                <div className="text-indigo-400 text-sm">Loading birthdays...</div>
              ) : upcomingBirthdays.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pr-2">
                  {upcomingBirthdays.map((b, i) => (
                    // 内部小卡片改为白底，hover 时稍微加深
                    <div key={i} className="flex items-center justify-between bg-white shadow-sm p-3 rounded-lg border border-indigo-50 hover:border-indigo-200 transition group">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-xs">{b.name.charAt(0)}</div>
                        {/* 名字文字加深 */}
                        <span className="font-bold text-slate-700 pr-3 leading-snug">{b.name}</span>
                      </div>
                      <span className="flex-shrink-0 text-indigo-600 font-mono text-xs bg-indigo-50 px-2 py-1 rounded border border-indigo-100">{b.date}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-40 text-indigo-400/60 text-sm italic">
                  <p>近期没有角色过生日哦。</p>
                </div>
              )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-auto pt-4 border-t border-indigo-100 z-10">
              <p className="text-xs text-indigo-900">只显示接下来两个月的角色生日</p>
              {/* 管理按钮变亮 */}
              <button onClick={() => setShowManager(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-indigo-50 text-indigo-600 text-xs font-bold transition-all border border-indigo-200 shadow-sm">
                <Edit size={12} /> Manage
              </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const ConverterView = () => {
  const [targetPath, setTargetPath] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      switch (event.type) {
        case 'log':
        case 'error':
        case 'warning':
        case 'success':
          setLogs(prev => [...prev, {
            timestamp: new Date().toLocaleTimeString(),
            message: event.message,
            type: event.type as any
          }]);
          if (event.type === 'success' || event.type === 'error') {
            setIsRunning(false);
            if (event.type === 'success') setProgress(100);
          }
          break;
        case 'progress':
          if (event.progress !== undefined) setProgress(event.progress);
          if (event.message) {
             setLogs(prev => [...prev, {
               timestamp: new Date().toLocaleTimeString(),
               message: event.message,
               type: 'info'
             }]);
          }
          break;
      }
    });
    return cleanup;
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // 获取拖入的路径 (Electron环境)
      // @ts-ignore
      const path = e.dataTransfer.files[0].path;
      if (path) {
        setTargetPath(path);
      }
    }
  };

  const startConversion = () => {
    if (!targetPath.trim()) return;
    if (isRunning) return;

    setLogs([]);
    setProgress(0);
    setIsRunning(true);

    if (window.electronAPI) {
      window.electronAPI.runScript('png_to_jpg.py', [targetPath]);
    }
  };

  return (
    <div className="w-full space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">PNG 转 JPG </h2>
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        
        {/* Path Input with Drag & Drop */}
        <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-500 uppercase">目标文件夹</label>
            <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                    <FolderInput size={18} />
                </div>
                <input 
                  type="text" 
                  value={targetPath}
                  onChange={(e) => setTargetPath(e.target.value)}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  placeholder="粘贴路径或者拖入文件夹"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-10 pr-4 py-3 text-slate-900 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm"
                />
            </div>
            <p className="text-xs text-slate-600 flex items-center gap-1">
               <AlertCircle size={12}/> 
               输入路径，点击开始，路径里面的.png文件会被转为.jpg，原始的.png文件会移入回收站
            </p>
        </div>

        {/* Progress & Actions */}
        <div className="bg-slate-50 rounded-lg border border-slate-200 p-4 flex items-center gap-6">
             <div className="flex-1 flex flex-col gap-1">
                <div className="flex justify-between text-xs text-slate-500">
                    <span>进度</span>
                    <span className="font-mono text-blue-600">{progress}%</span>
                </div>
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }}></div>
                </div>
             </div>
             
             <button 
                onClick={startConversion}
                disabled={!targetPath || isRunning}
                className={`px-8 py-2 rounded-lg font-bold transition flex items-center gap-2 ${
                  isRunning || !targetPath 
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200 shadow-none' 
                    : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20'
                }`}
             >
                {isRunning ? <Loader2 className="animate-spin" size={18} /> : <Play size={18} fill="currentColor" />} 
                {isRunning ? '转换中...' : '开始转换'}
             </button>
        </div>
      </div>

      <Terminal logs={logs} />
    </div>
  );
};

const ResearchView = ({ 
  config,
  onUpdateConfig
}: { 
  config: AppConfig['research'];
  onUpdateConfig: (newConfig: AppConfig['research']) => void;
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("准备就绪");

  const runAnalysis = () => {
    if (isRunning) return;
    setLogs([]);
    setProgress(0);
    setIsRunning(true);
    setStatusMsg("正在初始化引擎...");

    if (window.electronAPI) {
      window.electronAPI.runScript('research.py', [
        '--path', config.defaultDir,
        '--threshold', config.ssimThreshold.toString(),
        '--min_duration', config.minDuration.toString()
      ]);
    }
  };

  return (
    <div className="w-full space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">调研整理</h2>
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        <div className="space-y-2">
          <p className="mt-2 text-gray-600">这个功能会整理从小红书/抖音爬取下来的文件。这个程序会删除掉小红书的爬取可能会出现重复图片的情况，然后会对视频执行转场识别，把每一个分镜的视频帧截取一帧下来。</p>
        </div>
        {/* 路径设置 */}
        <div className="space-y-2">
           <label className="text-xs font-semibold text-slate-500 uppercase">读取目录</label>
           <input 
             type="text" 
             value={config.defaultDir}
             onChange={(e) => onUpdateConfig({...config, defaultDir: e.target.value})}
             className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-slate-900 font-mono text-sm focus:border-blue-500 outline-none"
           />
        </div>

        {/* 参数设置 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
                <div className="flex justify-between mb-2">
                    <label className="text-sm font-medium text-slate-500">SSIM 阈值</label>
                    <span className="text-sm font-mono text-blue-600">{config.ssimThreshold}</span>
                </div>
                <input 
                    type="range" min="0.5" max="1.0" step="0.01"
                    value={config.ssimThreshold}
                    onChange={(e) => onUpdateConfig({...config, ssimThreshold: parseFloat(e.target.value)})}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <p className="text-xs text-slate-600 gap-6 flex items-center mt-1">
                    SSIM 相似度阈值，值越高表示越相似的两个片段会被识别为两个分镜
                </p>
            </div>
            <div>
                <div className="flex justify-between mb-2">
                    <label className="text-sm font-medium text-slate-500">最小片段时长 (秒)</label>
                    <span className="text-sm font-mono text-blue-600">{config.minDuration}s</span>
                </div>
                <input 
                    type="range" min="0.1" max="5.0" step="0.1"
                    value={config.minDuration}
                    onChange={(e) => onUpdateConfig({...config, minDuration: parseFloat(e.target.value)})}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <p className="text-xs text-slate-600 gap-6 flex items-center mt-1">
                    识别的分镜区间最小持续时间
                </p>
            </div>
        </div>

        {/* 状态与进度 */}
        <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
            <div className="flex justify-between text-sm mb-2">
               <span className="text-slate-800">{statusMsg}</span>
               <span className="text-blue-600 font-mono">{progress.toFixed(1)}%</span>
            </div>
            <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
               <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }}/>
            </div>
        </div>

        <div className="flex justify-end">
             <button 
               onClick={runAnalysis} 
               disabled={isRunning}
               className={`px-6 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${
                 isRunning 
                  ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none' 
                  : 'bg-blue-600 text-white hover:bg-blue-500 shadow-md shadow-blue-500/20'
               }`}
             >
                {isRunning ? <Loader2 className="animate-spin" size={18}/> : <Play size={18} fill="currentColor" />}
                {isRunning ? '处理中' : '开始处理'}
             </button>
        </div>
      </div>

      <Terminal logs={logs} />
    </div>
  );
};

const MatchView = ({ 
        config, 
        onUpdateConfig 
    }: { 
        config: AppConfig['smartMatch']; 
        onUpdateConfig: (newMatchConfig: AppConfig['smartMatch']) => void; 
    }) => {
      
    const [sourceDir, setSourceDir] = useState("");
    const [keywords, setKeywords] = useState("");
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isRunning, setIsRunning] = useState(false);

    useEffect(() => {
        if (!window.electronAPI?.onPythonEvent) return;
        const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
            switch (event.type) {
                case 'log':
                case 'error':
                case 'success':
                    setLogs(prev => [...prev, {
                        timestamp: new Date().toLocaleTimeString(),
                        message: event.message,
                        type: event.type as any
                    }]);
                    if (event.type === 'success' || event.type === 'error') {
                        setIsRunning(false);
                    }
                    break;
            }
        });
        return cleanup;
    }, []);

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            // @ts-ignore
            const path = e.dataTransfer.files[0].path;
            if (path) {
                setSourceDir(path);
            }
        }
    };

    const runTask = () => {
        if (!sourceDir.trim() || !keywords.trim()) return;
        
        setIsRunning(true);
        setLogs([]);
        
        const keywordList = keywords.trim().split(/\s+/);
        
        if (window.electronAPI) {
            window.electronAPI.runScript('catch.py', [
                '--source', sourceDir,
                '--dest_name', config.destFolderName,
                '--keywords', ...keywordList
            ]);
        }
    };

    return (
        <div className="w-full space-y-6">
            <h2 className="text-2xl font-bold text-slate-800">选片</h2>
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
                <div className="space-y-2">
                  <p className="mt-2 text-gray-600">逻辑是客户发来了文件名的选片，把文件名从RAW文件夹挑选出来。</p>
                </div>
                <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 uppercase">生成选片文件夹的名称</label>
                    <input 
                        type="text" 
                        value={config.destFolderName}
                        onChange={(e) => onUpdateConfig({...config, destFolderName: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2 text-slate-800 focus:border-blue-500"
                    />
                </div>
                <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 uppercase">包含RAW文件的原始文件夹路径</label>
                    <div className="relative">
                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                            <FolderInput size={18} />
                        </div>
                        <input 
                            type="text" 
                            value={sourceDir} 
                            onChange={(e) => setSourceDir(e.target.value)}
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            placeholder="粘贴路径或者拖入文件夹"
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-10 pr-4 py-3 text-slate-900 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm"
                        />
                    </div>
                    <p className="text-xs text-slate-600">
                        会在原始文件夹外面创建一个<span className="text-blue-600 font-mono mx-1">"{config.destFolderName}"</span>文件夹用于提取选片
                        <p className="text-xs text-slate-600 flex items-center gap-1">
                          <AlertCircle size={12}/> 
                          文件夹名称可以在设置中更改
                        </p>
                    </p>
                </div>

                {/* Keywords Input */}
                <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 uppercase">关键词</label>
                    <textarea 
                        value={keywords}
                        onChange={(e) => setKeywords(e.target.value)}
                        placeholder="关键词需要用空格分开，一个空格分开一个文件名"
                        className="w-full h-24 bg-slate-50 border border-slate-200 rounded-lg p-4 text-slate-900 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm resize-none"
                    />
                </div>

                {/* Action Button */}
                <div className="flex justify-end">
                    <button 
                        onClick={runTask}
                        disabled={isRunning || !sourceDir || !keywords}
                        className={`px-8 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${
                            isRunning || !sourceDir || !keywords
                                ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none' 
                                : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20'
                        }`}
                    >
                        {isRunning ? <Loader2 className="animate-spin" size={18}/> : <ScanSearch size={18} />}
                        {isRunning ? '复制中...' : '开始选片'}
                    </button>
                </div>
            </div>
            <Terminal logs={logs} />
        </div>
    )
};

const RenameView = () => {
    const [folderA, setFolderA] = useState("");
    const [folderB, setFolderB] = useState("");
    const [copyUnmatched, setCopyUnmatched] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [progress, setProgress] = useState(0);

    // Python 事件监听
    useEffect(() => {
        if (!window.electronAPI?.onPythonEvent) return;
        const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
            switch (event.type) {
                case 'log': case 'error': case 'success': 
                    setLogs(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), message: event.message, type: event.type as any }]); 
                    if (event.type === 'success' || event.type === 'error') { setIsRunning(false); if (event.type === 'success') setProgress(100); } 
                    break;
                case 'progress': if (event.progress !== undefined) setProgress(event.progress); if (event.message) setLogs(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), message: event.message, type: 'info' }]); break;
            }
        });
        return cleanup;
    }, []);

    const handleDrop = (e: React.DragEvent, setPath: (s: string) => void) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length > 0) setPath((e.dataTransfer.files[0] as any).path); };
    const allowDrag = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };

    const runRename = () => {
        if (!folderA || !folderB || isRunning) return;
        setLogs([]); setProgress(0); setIsRunning(true);
        const args = ['--folder_a', folderA, '--folder_b', folderB];
        if (copyUnmatched) args.push('--copy_unmatched');
        if (window.electronAPI) window.electronAPI.runScript('rename.py', args);
    };

    return (
        <div className="w-full space-y-6">
            <h2 className="text-2xl font-bold text-slate-800">整理前后期图片</h2>
            
            {/* --- 新增：可视化流程图 (替换了原来的纯文字说明) --- */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 relative overflow-hidden">
                <div className="space-y-2">
                  <p className="mt-2 text-gray-600">我会遇到这么个情况，返给客户很多图，然后客户修了一部分，但是又需要匹配到返给客户图的文件，所以这个功能可以匹配你返给客户的和客户修了再返给你的图，重命名和寻找客户没给你的图。</p>
                </div>
                {/* 背景光效 */}
                <div className="absolute top-0 left-1/2 -translate-x-1/2 p-32 bg-indigo-500/5 blur-3xl rounded-full pointer-events-none"></div>
                
                <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-4 md:gap-8">
                    
                    {/* 左侧：摄影师基准 */}
                    <div className="flex-1 w-full bg-slate-50/50 border border-blue-500/20 rounded-lg p-4 flex flex-col items-center text-center">
                        <div className="text-xs font-bold text-blue-600 uppercase mb-3 flex items-center gap-2">
                            <HardDrive size={14} /> 摄影师原图 (文件夹A)
                        </div>
                        <div className="bg-white p-2 rounded border border-slate-200 flex items-center gap-2 text-slate-800 w-full justify-center">
                            <ImageIcon size={16} className="text-blue-500" />
                            <span className="font-mono text-sm">IMG_8821.JPG</span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-2">作为命名的基准标准</p>
                    </div>

                    {/* 中间：处理逻辑 */}
                    <div className="flex flex-col items-center justify-center shrink-0">
                        <div className="text-[10px] text-slate-500 mb-1 font-mono">pHash 视觉指纹比对</div>
                        <div className="flex items-center gap-2">
                            <div className="h-[1px] w-8 md:w-16 bg-gradient-to-r from-blue-500/50 to-purple-500/50"></div>
                            <div className="bg-purple-50 p-2 rounded-full border border-purple-200 text-purple-600 shadow-sm">
                                <ScanSearch size={20} />
                            </div>
                            <div className="h-[1px] w-8 md:w-16 bg-gradient-to-r from-purple-500/50 to-green-500/50"></div>
                        </div>
                        <div className="text-[10px] text-purple-400 mt-1 font-bold">画面一致 = 匹配成功</div>
                    </div>

                    {/* 右侧：客户返图 */}
                    <div className="flex-1 w-full bg-slate-50/50 border border-green-500/20 rounded-lg p-4 flex flex-col items-center text-center relative overflow-hidden">
                        <div className="text-xs font-bold text-green-400 uppercase mb-3 flex items-center gap-2">
                            <User size={14} /> 客户选修返图 (文件夹B)
                        </div>
                        <div className="space-y-1 w-full flex flex-col items-center">
                            {/* 变化前 */}
                            <div className="flex items-center gap-2 text-slate-500 opacity-50 line-through text-xs">
                                <ImageIcon size={14} />
                                <span className="font-mono">wx_file_9932.jpg</span>
                            </div>
                            <div className="text-slate-600"><RotateCcw size={10} className="rotate-180"/></div>
                            {/* 变化后 */}
                            <div className="bg-white p-2 rounded border border-green-900/50 flex items-center gap-2 text-green-300 w-full justify-center shadow-[0_0_10px_rgba(34,197,94,0.1)]">
                                <CheckCircle2 size={16} />
                                <span className="font-mono text-sm font-bold">IMG_8821.JPG</span>
                            </div>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-2">文件名自动修正为原名</p>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col gap-3">
                    <label className="text-xs font-semibold text-blue-600 uppercase flex items-center gap-2">
                        <FolderInput size={14}/> 文件夹A (参照组/摄影师)
                    </label>
                    <input 
                        type="text" value={folderA}
                        onChange={(e) => setFolderA(e.target.value)}
                        onDrop={(e) => handleDrop(e, setFolderA)}
                        onDragOver={allowDrag}
                        placeholder="拖入摄影师发给客户的原图文件夹..."
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm font-mono"
                    />
                    <p className="text-xs text-slate-500">这里的文件名正确，但可能不包含客户的选择。</p>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col gap-3">
                    <label className="text-xs font-semibold text-green-400 uppercase flex items-center gap-2">
                        <Edit size={14}/> 文件夹B (待重命名/客户返图)
                    </label>
                    <input 
                        type="text" value={folderB}
                        onChange={(e) => setFolderB(e.target.value)}
                        onDrop={(e) => handleDrop(e, setFolderB)}
                        onDragOver={allowDrag}
                        placeholder="拖入客户发回来的乱序文件夹..."
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm font-mono"
                    />
                    <p className="text-xs text-slate-500">这里的图片是客户想要的，但文件名是乱的。</p>
                </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <input type="checkbox" id="copyUnmatched" checked={copyUnmatched} onChange={(e) => setCopyUnmatched(e.target.checked)} className="w-4 h-4 rounded border-slate-300 bg-white text-blue-600" />
                    <label htmlFor="copyUnmatched" className="text-sm text-slate-800 cursor-pointer select-none">
                        单独整理 文件夹A 中客户没返回的图片
                    </label>
                </div>
                <div className="flex items-center gap-4">
                    {isRunning && <span className="text-blue-600 font-mono text-sm">{progress}%</span>}
                    <button 
                        onClick={runRename}
                        disabled={isRunning || !folderA || !folderB}
                        className={`px-6 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${
                            isRunning || !folderA || !folderB
                                ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none' 
                                : 'bg-blue-600 text-white hover:bg-blue-500 shadow-md shadow-blue-500/20'
                        }`}
                    >
                        {isRunning ? <Loader2 className="animate-spin" size={18}/> : <FileDiff size={18} />}
                        {isRunning ? '整理中...' : '开始整理'}
                    </button>
                </div>
            </div>
            <Terminal logs={logs} />
        </div>
    );
};

const VideoSplitView = () => {
  const [videoPath, setVideoPath] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("等待输入...");

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      switch (event.type) {
        case 'log':
        case 'error':
        case 'warning':
        case 'success':
          setLogs(prev => [...prev, {
            timestamp: new Date().toLocaleTimeString(),
            message: event.message,
            type: event.type as any
          }]);
          if (event.type === 'success' || event.type === 'error') {
            setIsRunning(false);
            if (event.type === 'success') {
                setProgress(100);
                setStatusMsg("处理完成");
            } else {
                setStatusMsg("发生错误");
            }
          }
          break;
        case 'progress':
          if (event.progress !== undefined) setProgress(event.progress);
          if (event.message) {
             setStatusMsg(event.message);
             setLogs(prev => [...prev, {
               timestamp: new Date().toLocaleTimeString(),
               message: event.message,
               type: 'info'
             }]);
          }
          break;
      }
    });
    return cleanup;
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // @ts-ignore
      const path = e.dataTransfer.files[0].path;
      if (path) {
        setVideoPath(path);
      }
    }
  };

  const startSplit = () => {
    if (!videoPath.trim()) return;
    if (isRunning) return;

    setLogs([]);
    setProgress(0);
    setIsRunning(true);
    setStatusMsg("正在启动处理...");

    if (window.electronAPI) {
      window.electronAPI.runScript('cut_video.py', [videoPath]);
    }
  };

  return (
    <div className="w-full space-y-6">
      <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <Scissors size={24} /> 视频对半切割
      </h2>
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        
        <div className="space-y-2">
          <p className="mt-2 text-gray-600">
            无损将视频对半切割分为两个视频文件。用于处理过长的花絮/素材文件。
          </p>
        </div>

        {/* Path Input */}
        <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-500 uppercase">目标视频文件</label>
            <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                    <Video size={18} />
                </div>
                <input 
                  type="text" 
                  value={videoPath}
                  onChange={(e) => setVideoPath(e.target.value)}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  placeholder="将 .mov / .mp4 视频文件拖入此处，或粘贴绝对路径"
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-10 pr-4 py-3 text-slate-900 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm"
                />
            </div>
        </div>

        {/* Progress & Actions */}
        <div className="bg-slate-50 rounded-lg border border-slate-200 p-4 flex items-center gap-6">
              <div className="flex-1 flex flex-col gap-1">
                <div className="flex justify-between text-xs text-slate-500">
                    <span>{statusMsg}</span>
                    <span className="font-mono text-blue-600">{progress}%</span>
                </div>
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }}></div>
                </div>
              </div>
             
            <button 
              onClick={startSplit}
              disabled={!videoPath || isRunning}
              className={`px-8 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${
                isRunning || !videoPath 
                  ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none' 
                  : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
              }`}
            >
              {isRunning ? <Loader2 className="animate-spin" size={18} /> : <Scissors size={18} fill="currentColor" />}
              {isRunning ? '切割中...' : '开始切割'}
            </button>
        </div>
      </div>

      <Terminal logs={logs} />
    </div>
  );
};

// --- 组件 ---
const UpdateModal = ({ 
  version, 
  notes, 
  url, 
  onClose 
}: { 
  version: string, 
  notes: string, 
  url: string, 
  onClose: () => void 
}) => {
  const handleUpdate = () => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-50/80 backdrop-blur-sm p-4 animate-in fade-in duration-300">
      <div className="bg-white border border-blue-500/30 w-full max-w-md rounded-2xl shadow-2xl flex flex-col relative overflow-hidden">
        {/* 装饰背景 */}
        <div className="absolute top-0 right-0 p-16 bg-blue-500/20 blur-3xl rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>
        
        <div className="p-6 pb-0 z-10">
          <div className="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center text-blue-600 mb-4 border border-blue-500/20">
            <Gift size={24} />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">发现新版本 {version}</h3>
          <p className="text-slate-500 text-sm">
            一个新的更新已准备就绪。下载安装包以体验最新功能。
          </p>
        </div>

        <div className="p-6 z-10">
          <div className="bg-slate-50/50 rounded-lg p-4 border border-slate-200 max-h-40 overflow-y-auto">
            <p className="text-xs font-bold text-slate-500 uppercase mb-2">更新日志</p>
            <p className="text-sm text-slate-800 whitespace-pre-wrap">{notes}</p>
          </div>
        </div>

        <div className="p-6 pt-2 flex gap-3 z-10">
          <button 
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-800 transition font-medium text-sm"
          >
            以后再说
          </button>
          <button 
            onClick={handleUpdate}
            className="flex-1 py-2.5 rounded-lg bg-blue-500 hover:bg-blue-500 text-slate-800 shadow-lg shadow-blue-900/20 transition font-bold text-sm flex items-center justify-center gap-2"
          >
            去下载 <ExternalLink size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

const AboutModal = ({ onClose }: { onClose: () => void }) => {
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0" onClick={onClose}></div>
      <div className="bg-white border border-slate-200 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[90vh] relative z-10 overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex justify-between items-center bg-slate-200">
          <h3 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <AtSign size={20} className="text-blue-600"/> 关于
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-full text-slate-500 hover:text-slate-800 transition">
            <X size={20} />
          </button>
        </div>
        
        {/* Body - 仅保留一行正文文字 */}
        <div className="flex-1 overflow-y-auto p-6 flex">
          <p className="text-slate-800 text-base leading-relaxed">
            @秋也寻
            <br/>
            版本 26.5.10
            <br/>
            大部分代码为Google Gemini和Copilot生成。
            <br />
            软件没有经过充分测试。使用前请备份重要数据。作者不对因使用本软件造成的任何损失负责。
          </p>
        </div>
      </div>
    </div>
  );
};

const SidebarItem = ({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
      active 
        ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20 font-bold' 
        : 'text-slate-500 hover:bg-slate-100 hover:text-blue-600 font-medium'
    }`}
  >
    {icon}
    <span className="font-medium">{label}</span>
  </button>
);

const InputField = ({ label, value, onChange, icon }: { label: string, value: string, onChange: (v: string) => void, icon: React.ReactNode }) => (
  <div className="space-y-1">
    <label className="text-xs font-bold text-slate-500 uppercase">{label}</label>
    <div className="relative">
      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
        {icon}
      </div>
      <input 
        type="text" 
        value={value} 
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-white border border-slate-200 rounded-lg pl-10 pr-4 py-2 text-slate-800 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors font-mono text-sm"
      />
    </div>
  </div>
);

export default App;