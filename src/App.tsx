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
  Save,
  Download,
  AtSign,
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

const DEFAULT_CONFIG = (userPath: string): AppConfig => ({
  smartImport: {
    autoStart: false,
    sdPath: "H:/DCIM",
    destPath: `${userPath}/Desktop`,
    backupEnabled: false,
    backupPath: "D:/Backup"
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

// --- 主组件 ---

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ToolType>('dashboard');
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);

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
      <div className="flex items-center justify-center h-screen w-full bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-200 overflow-hidden relative">
        {/* 背景装饰 */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl"></div>
        
        <div className="text-center z-10 space-y-8">
          {/* ✅ 加载动画 */}
          <div className="flex justify-center">
            <div className="relative w-20 h-20">
              {/* 外圆 */}
              <div className="absolute inset-0 rounded-full border-4 border-slate-700/30"></div>
              
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
              摄影工具包
            </h2>
            <p className="text-sm text-slate-400 font-mono">初始化配置中...</p>
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
    <div className="flex h-screen w-full bg-slate-950 text-slate-200 font-sans selection:bg-blue-500/30">
      
      {/* Settings Modal */}
      {showSettings && config && (
        <SettingsModal 
          config={config} 
          onConfigChange={handleConfigUpdate} 
          onClose={() => setShowSettings(false)} 
        />
      )}

      {showAbout && config && (
        <AboutModal 
          onClose={() => setShowAbout(false)} 
        />
      )}

      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-800">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent cursor-default">
            摄影工具包
          </h1>
          <p className="text-xs text-slate-500 mt-1 font-mono">v25.12.6 by秋也寻</p>
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

        <div className="p-4 border-t border-slate-800">
          <div className="flex flex-col rounded-lg border border-slate-700/50 bg-slate-800/50 overflow-hidden divide-y divide-slate-700/50">
            <button 
              onClick={() => setShowAbout(true)}
              className="w-full flex items-center gap-3 p-3 hover:bg-slate-800 text-slate-400 hover:text-white transition-all group"
            >
              <AtSign size={18} className="group-hover:rotate-90 transition-transform duration-500 text-blue-400" />
              <span className="font-medium text-sm">关于</span>
            </button>
            <button 
              onClick={() => setShowSettings(true)}
              className="w-full flex items-center gap-3 p-3 hover:bg-slate-800 text-slate-400 hover:text-white transition-all group"
            >
              <Settings size={18} className="group-hover:rotate-90 transition-transform duration-500 text-blue-400" />
              <span className="font-medium text-sm">设置</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-slate-950 p-8 relative scrollbar-thin scrollbar-thumb-slate-700">
        {activeTab === 'dashboard' && <DashboardView config={config} />}
        {activeTab === 'converter' && <ConverterView />}
        {activeTab === 'research' && <ResearchView config={config.research} />}
        {activeTab === 'match' && <MatchView config={config.smartMatch} />}
        {activeTab === 'rename_tool' && <RenameView />}
      </main>
    </div>
  );
};

// --- Dashboard View ---
const ImportCard = ({ config }: { config?: AppConfig['smartImport'] }) => {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready_to_import' | 'importing' | 'decision' | 'processing' | 'finished'>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("等待连接...");
  const [decisionData, setDecisionData] = useState<any>(null);
  const [resultData, setResultData] = useState<any>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);  // ✅ 只在这个组件中使用

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      // ✅ 记录所有 Python 事件到日志
      if (event.message) {
        setLogs(prev => [...prev, {
          timestamp: new Date().toLocaleTimeString(),
          message: event.message,
          type: event.type as any
        }]);
      }

      switch (event.type) {
        case 'status':
          if (event.data?.connected) {
            setStatus('ready_to_import');
            setStatusMsg("SD Card Detected: " + event.data.path);
            setTimeout(() => startImport(), 500);
          } else {
            setStatus('idle');
            setStatusMsg("未检测到 SD 卡");
          }
          break;
        case 'progress':
          setProgress(event.progress || 0);
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
          setResultData(event.data);
          setStatusMsg("导入完成");
          break;
        case 'error':
          setStatusMsg("Error: " + event.message);
          break;
      }
    });
    return cleanup;
  }, []);

  // 自动检查
  useEffect(() => {
    if (config?.autoStart) {
      checkSD();
    }
  }, [config?.autoStart]);

  const runCmd = (stage: string, args: string[] = []) => {
    if(window.electronAPI) window.electronAPI.runScript('classify.py', ['--stage', stage, ...args]);
  };

  const checkSD = () => {
    setStatus('checking');
    setStatusMsg("正在扫描设备...");
    setLogs([]);  // ✅ 清空日志
    
    const args = [];
    if (config) {
      args.push('--sd_path', config.sdPath);
    }
    runCmd('check', args);

    setTimeout(() => {
      setStatus((prevStatus) => {
        if (prevStatus === 'checking') {
          setStatusMsg("未检测到 SD 卡");
          return 'idle';
        }
        return prevStatus;
      });
    }, 2000);
  };

  const startImport = () => {
    setStatus('importing');
    setProgress(0);
    setLogs([]);  // ✅ 清空日志
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
    runCmd('process', ['--split', split ? 'true' : 'false']);
  };

  // --- 渲染逻辑 ---

  if (status === 'idle' || status === 'checking') {
    return (
      <div className="w-full bg-slate-900/50 border border-slate-800 rounded-xl p-4 flex items-center justify-between animate-in fade-in">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${status === 'checking' ? 'bg-blue-500/10 text-blue-400' : 'bg-slate-800 text-slate-500'}`}>
            {status === 'checking' ? <Loader2 className="animate-spin" size={18} /> : <HardDrive size={18} />}
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-slate-300">从SD卡导入媒体</span>
            <span className="text-xs text-slate-500">{status === 'checking' ? '正在搜索 SD 卡...' : '未检测到 SD 卡连接'}</span>
          </div>
        </div>
        <button 
          onClick={checkSD}
          disabled={status === 'checking'}
          className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition disabled:opacity-50"
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
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-6 flex flex-col relative overflow-hidden min-h-[250px] animate-in slide-in-from-top-2">
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
              <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mb-4 text-blue-400">
                <Loader2 className="animate-spin" size={32} />
              </div>
              <p className="text-white font-bold text-lg mb-1">正在导入...</p>
              <p className="text-slate-400 text-sm mb-6">{statusMsg}</p>
            </div>
          )}

          {/* State: Progress */}
          {(status === 'importing' || status === 'processing') && (
            <div className="w-full max-w-sm space-y-3">
              <div className="flex justify-between text-xs text-slate-400 font-mono">
                <span>EXECUTING...</span>
                <span>{progress}%</span>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700/50">
                <div className="h-full bg-blue-500 transition-all duration-300 relative" style={{ width: `${progress}%` }}></div>
              </div>
              <p className="text-sm text-slate-300 mt-2 font-mono truncate">{statusMsg}</p>
            </div>
          )}

          {/* State: Decision */}
          {status === 'decision' && decisionData && (
            <div className="w-full bg-slate-950/80 p-5 rounded-xl border border-yellow-500/20 text-left">
              <h4 className="text-white font-bold mb-2 flex items-center gap-2">
                <AlertCircle className="text-yellow-400" size={20} />
                需确认操作
              </h4>
              <p className="text-slate-400 text-sm mb-6">
                {decisionData.need_split 
                  ? `检测到拍摄时间有 2 小时以上的断层，是否拆分文件夹？`
                  : `准备处理 ${decisionData.files_count} 个文件。`}
              </p>
              <div className="flex gap-3">
                <button onClick={() => handleDecision(true)} className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm">是，拆分</button>
                <button onClick={() => handleDecision(false)} className="flex-1 bg-slate-700 text-slate-200 py-2 rounded-lg text-sm">否，合并</button>
              </div>
            </div>
          )}

          {/* State: Finished */}
          {status === 'finished' && (
            <div className="w-full text-left">
              <div className="flex items-center gap-3 mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400">
                <CheckCircle2 size={24} />
                <div><h4 className="font-bold text-sm">导入完成</h4></div>
              </div>
              <button onClick={() => setStatus('idle')} className="w-full py-2 text-xs text-slate-500 hover:text-white bg-slate-900 rounded">关闭</button>
            </div>
          )}
        </div>
      </div>

      {/* ✅ 日志面板 - 只显示导入相关的日志 */}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0" onClick={onClose}></div>
      <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[80vh] relative z-10">
        <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-800/50 rounded-t-2xl">
          <div><h3 className="text-xl font-bold text-white">Birthday Database</h3></div>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition cursor-pointer"><X size={24} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-2">
          {loading ? <div className="text-center text-slate-500">Loading...</div> : 
           sortedBirthdays.map(([name, date]) => (
            <div key={name} className="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800 group">
               <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400"><User size={14} /></div>
                  <div><div className="font-medium text-slate-200">{name}</div><div className="text-xs text-slate-500">{date}</div></div>
               </div>
               <button onClick={() => handleDelete(name)} className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-red-400 transition"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <div className="p-6 border-t border-slate-800 bg-slate-900 rounded-b-2xl">
           <div className="flex gap-3">
              <input placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-4 py-2 text-white" />
              <input placeholder="M" type="number" value={newMonth} onChange={e => setNewMonth(e.target.value)} className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-center text-white" />
              <input placeholder="D" type="number" value={newDay} onChange={e => setNewDay(e.target.value)} className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-2 text-center text-white" />
              <button onClick={handleSave} className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2"><Plus size={16} /> Add</button>
           </div>
        </div>
      </div>
    </div>
  );
};

const DashboardView = ({ config }: { config?: AppConfig }) => {
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
        <ImportCard config={config?.smartImport} />
        <div className="w-full bg-gradient-to-br from-indigo-900/50 to-purple-900/50 border border-indigo-500/20 rounded-xl p-6 flex flex-col">
          <div className="flex justify-between items-start mb-6 z-10">
              <h3 className="text-lg font-semibold text-indigo-200 flex items-center gap-2">
                <span className="text-xl">🎂</span> 角色生日
              </h3>
          </div>
          
          <div className="flex-1 z-10">
              {loading ? (
                <div className="text-indigo-300/50 text-sm">Loading birthdays...</div>
              ) : upcomingBirthdays.length > 0 ? (
                // 这里的 grid 可以改成 grid-cols-2 让名字在内部并列，或者 grid-cols-1 纯列表
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pr-2">
                  {upcomingBirthdays.map((b, i) => (
                    <div key={i} className="flex items-center justify-between bg-slate-900/40 backdrop-blur-sm p-3 rounded-lg border border-indigo-500/10 hover:bg-slate-900/60 transition group">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 font-bold text-xs">{b.name.charAt(0)}</div>
                        <span className="font-medium text-white pr-3 leading-snug">{b.name}</span>
                      </div>
                      <span className="flex-shrink-0 text-indigo-200 font-mono text-xs bg-indigo-500/20 px-2 py-1 rounded border border-indigo-500/20">{b.date}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-40 text-indigo-300/60 text-sm italic">
                  <p>No birthdays coming up soon.</p>
                </div>
              )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-auto pt-4 border-t border-indigo-500/20 z-10">
              <p className="text-xs text-indigo-400/60">birthdays.json</p>
              <button onClick={() => setShowManager(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-200 text-xs font-bold transition-all border border-indigo-500/30">
                <Edit size={12} /> Manage
              </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- 其他视图 ---

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
      <h2 className="text-2xl font-bold text-white">PNG 转 JPG </h2>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
        
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
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-4 py-3 text-slate-200 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm"
                />
            </div>
            <p className="text-xs text-slate-600 flex items-center gap-1">
               <AlertCircle size={12}/> 
               输入路径，点击开始，路径里面的.png文件会被转为.jpg，原始的.png文件会移入回收站
            </p>
        </div>

        {/* Progress & Actions */}
        <div className="bg-slate-950 rounded-lg border border-slate-800 p-4 flex items-center gap-6">
             <div className="flex-1 flex flex-col gap-1">
                <div className="flex justify-between text-xs text-slate-400">
                    <span>进度</span>
                    <span className="font-mono text-blue-400">{progress}%</span>
                </div>
                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }}></div>
                </div>
             </div>
             
             <button 
                onClick={startConversion}
                disabled={!targetPath || isRunning}
                className={`px-8 py-2 rounded-lg font-bold text-white transition flex items-center gap-2 shadow-lg ${
                  isRunning ? 'bg-slate-700 cursor-not-allowed shadow-none' : 'bg-blue-600 hover:bg-blue-500 shadow-blue-900/20'
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

const ResearchView = ({ config }: { config: AppConfig['research'] }) => {
  // 使用传入的 config 初始化状态
  const [targetPath, setTargetPath] = useState(config.defaultDir);
  const [ssimThreshold, setSsimThreshold] = useState(config.ssimThreshold);
  const [minDuration, setMinDuration] = useState(config.minDuration);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("准备就绪");

  // 监听 config 变化 (如果用户在设置中修改了，这里也会同步更新)
  useEffect(() => {
    setTargetPath(config.defaultDir);
    setSsimThreshold(config.ssimThreshold);
    setMinDuration(config.minDuration);
  }, [config]);

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      switch (event.type) {
        case 'log':
        case 'warning':
          setLogs(prev => [...prev, {
            timestamp: new Date().toLocaleTimeString(),
            message: event.message,
            type: event.type as any
          }]);
          break;
        case 'progress':
          if (event.progress !== undefined) setProgress(event.progress);
          if (event.message) setStatusMsg(event.message);
          break;
        case 'success':
        case 'error':
          setLogs(prev => [...prev, {
            timestamp: new Date().toLocaleTimeString(),
            message: event.message,
            type: event.type as any
          }]);
          setIsRunning(false); 
          if (event.type === 'success') setProgress(100);
          break;
        case 'status':
          setStatusMsg(event.message);
          break;
      }
    });
    return cleanup;
  }, []);

  const runAnalysis = () => {
    if (isRunning) return;
    setLogs([]);
    setProgress(0);
    setIsRunning(true);
    setStatusMsg("正在初始化引擎...");

    if (window.electronAPI) {
      window.electronAPI.runScript('research.py', [
        '--path', targetPath,
        '--threshold', ssimThreshold.toString(),
        '--min_duration', minDuration.toString()
      ]);
    }
  };

  return (
    <div className="w-full space-y-6">
      <h2 className="text-2xl font-bold text-white">调研整理</h2>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
        <div className="space-y-2">
          <p className="mt-2 text-gray-600">这个功能会整理从小红书/抖音爬取下来的文件。这个程序会删除掉小红书的爬取可能会出现重复图片的情况，然后会对视频执行转场识别，把每一个分镜的视频帧截取一帧下来。</p>
        </div>
        {/* 路径设置 */}
        <div className="space-y-2">
           <label className="text-xs font-semibold text-slate-500 uppercase">工作目录</label>
           <input 
             type="text" 
             value={targetPath}
             onChange={(e) => setTargetPath(e.target.value)}
             className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-2 text-slate-200 font-mono text-sm focus:border-blue-500 outline-none"
           />
        </div>

        {/* 参数设置 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
                <div className="flex justify-between mb-2">
                    <label className="text-sm font-medium text-slate-400">SSIM 阈值</label>
                    <span className="text-sm font-mono text-blue-400">{ssimThreshold}</span>
                </div>
                <input 
                    type="range" min="0.5" max="1.0" step="0.01"
                    value={ssimThreshold}
                    onChange={(e) => setSsimThreshold(parseFloat(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <p className="text-xs text-slate-600 gap-6 flex items-center mt-1">
                    SSIM 相似度阈值，值越高表示越相似的两个片段会被识别为两个分镜
                </p>
            </div>
            <div>
                <div className="flex justify-between mb-2">
                    <label className="text-sm font-medium text-slate-400">最小片段时长 (秒)</label>
                    <span className="text-sm font-mono text-blue-400">{minDuration}s</span>
                </div>
                <input 
                    type="range" min="0.1" max="5.0" step="0.1"
                    value={minDuration}
                    onChange={(e) => setMinDuration(parseFloat(e.target.value))}
                    className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <p className="text-xs text-slate-600 gap-6 flex items-center mt-1">
                    识别的分镜区间最小持续时间
                </p>
            </div>
        </div>

        {/* 状态与进度 */}
        <div className="bg-slate-950 rounded-lg border border-slate-800 p-4">
            <div className="flex justify-between text-sm mb-2">
               <span className="text-slate-300">{statusMsg}</span>
               <span className="text-blue-400 font-mono">{progress.toFixed(1)}%</span>
            </div>
            <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
               <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }}/>
            </div>
        </div>

        <div className="flex justify-end">
             <button 
               onClick={runAnalysis} 
               disabled={isRunning}
               className={`px-6 py-2 rounded-lg font-bold text-white transition flex items-center gap-2 ${
                 isRunning ? 'bg-slate-700 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'
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

const MatchView = ({ config }: { config: AppConfig['smartMatch'] }) => {
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
            <h2 className="text-2xl font-bold text-white">选片</h2>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
                <div className="space-y-2">
                  <p className="mt-2 text-gray-600">逻辑是客户发来了文件名的选片，把文件名从RAW文件夹挑选出来。</p>
                </div>
                {/* Source Input */}
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
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-4 py-3 text-slate-200 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm"
                        />
                    </div>
                    <p className="text-xs text-slate-600">
                        会在原始文件夹外面创建一个<span className="text-blue-400 font-mono mx-1">"{config.destFolderName}"</span>文件夹用于提取选片
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
                        className="w-full h-24 bg-slate-950 border border-slate-700 rounded-lg p-4 text-slate-200 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm resize-none"
                    />
                </div>

                {/* Action Button */}
                <div className="flex justify-end">
                    <button 
                        onClick={runTask}
                        disabled={isRunning || !sourceDir || !keywords}
                        className={`px-8 py-2.5 rounded-lg font-bold text-white transition flex items-center gap-2 ${
                            isRunning || !sourceDir || !keywords
                                ? 'bg-slate-700 cursor-not-allowed text-slate-400' 
                                : 'bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-900/20'
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
            <h2 className="text-2xl font-bold text-white">整理前后期图片</h2>
            
            {/* --- 新增：可视化流程图 (替换了原来的纯文字说明) --- */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 relative overflow-hidden">
                <div className="space-y-2">
                  <p className="mt-2 text-gray-600">我会遇到这么个情况，返给客户很多图，然后客户修了一部分，但是又需要匹配到返给客户图的文件，所以这个功能可以匹配你返给客户的和客户修了再返给你的图，重命名和寻找客户没给你的图。</p>
                </div>
                {/* 背景光效 */}
                <div className="absolute top-0 left-1/2 -translate-x-1/2 p-32 bg-indigo-500/5 blur-3xl rounded-full pointer-events-none"></div>
                
                <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-4 md:gap-8">
                    
                    {/* 左侧：摄影师基准 */}
                    <div className="flex-1 w-full bg-slate-950/50 border border-blue-500/20 rounded-lg p-4 flex flex-col items-center text-center">
                        <div className="text-xs font-bold text-blue-400 uppercase mb-3 flex items-center gap-2">
                            <HardDrive size={14} /> 摄影师原图 (文件夹A)
                        </div>
                        <div className="bg-slate-900 p-2 rounded border border-slate-800 flex items-center gap-2 text-slate-300 w-full justify-center">
                            <ImageIcon size={16} className="text-blue-500" />
                            <span className="font-mono text-sm">IMG_8821.JPG</span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-2">作为命名的基准标准</p>
                    </div>

                    {/* 中间：处理逻辑 */}
                    <div className="flex flex-col items-center justify-center shrink-0">
                        <div className="text-[10px] text-slate-400 mb-1 font-mono">pHash 视觉指纹比对</div>
                        <div className="flex items-center gap-2">
                            <div className="h-[1px] w-8 md:w-16 bg-gradient-to-r from-blue-500/50 to-purple-500/50"></div>
                            <div className="bg-slate-800 p-2 rounded-full border border-purple-500/30 text-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.2)]">
                                <ScanSearch size={20} />
                            </div>
                            <div className="h-[1px] w-8 md:w-16 bg-gradient-to-r from-purple-500/50 to-green-500/50"></div>
                        </div>
                        <div className="text-[10px] text-purple-400 mt-1 font-bold">画面一致 = 匹配成功</div>
                    </div>

                    {/* 右侧：客户返图 */}
                    <div className="flex-1 w-full bg-slate-950/50 border border-green-500/20 rounded-lg p-4 flex flex-col items-center text-center relative overflow-hidden">
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
                            <div className="bg-slate-900 p-2 rounded border border-green-900/50 flex items-center gap-2 text-green-300 w-full justify-center shadow-[0_0_10px_rgba(34,197,94,0.1)]">
                                <CheckCircle2 size={16} />
                                <span className="font-mono text-sm font-bold">IMG_8821.JPG</span>
                            </div>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-2">文件名自动修正为原名</p>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col gap-3">
                    <label className="text-xs font-semibold text-blue-400 uppercase flex items-center gap-2">
                        <FolderInput size={14}/> 文件夹A (参照组/摄影师)
                    </label>
                    <input 
                        type="text" value={folderA}
                        onChange={(e) => setFolderA(e.target.value)}
                        onDrop={(e) => handleDrop(e, setFolderA)}
                        onDragOver={allowDrag}
                        placeholder="拖入摄影师发给客户的原图文件夹..."
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 text-sm font-mono"
                    />
                    <p className="text-xs text-slate-500">这里的文件名正确，但可能不包含客户的选择。</p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col gap-3">
                    <label className="text-xs font-semibold text-green-400 uppercase flex items-center gap-2">
                        <Edit size={14}/> 文件夹B (待重命名/客户返图)
                    </label>
                    <input 
                        type="text" value={folderB}
                        onChange={(e) => setFolderB(e.target.value)}
                        onDrop={(e) => handleDrop(e, setFolderB)}
                        onDragOver={allowDrag}
                        placeholder="拖入客户发回来的乱序文件夹..."
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 text-sm font-mono"
                    />
                    <p className="text-xs text-slate-500">这里的图片是客户想要的，但文件名是乱的。</p>
                </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <input 
                        type="checkbox" id="copyUnmatched"
                        checked={copyUnmatched}
                        onChange={(e) => setCopyUnmatched(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600"
                    />
                    <label htmlFor="copyUnmatched" className="text-sm text-slate-300 cursor-pointer select-none">
                        单独整理 文件夹A 中客户没返回的图片
                    </label>
                </div>
                <div className="flex items-center gap-4">
                    {isRunning && <span className="text-blue-400 font-mono text-sm">{progress}%</span>}
                    <button 
                        onClick={runRename}
                        disabled={isRunning || !folderA || !folderB}
                        className={`px-6 py-2 rounded-lg font-bold text-white transition flex items-center gap-2 ${
                            isRunning ? 'bg-slate-700 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'
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

// --- 小组件 ---

const SettingsModal = ({ 
  config, 
  onConfigChange, 
  onClose 
}: { 
  config: AppConfig, 
  onConfigChange: (newConfig: AppConfig) => void, 
  onClose: () => void 
}) => {
  const [localConfig, setLocalConfig] = useState<AppConfig>(config);

  const handleSave = () => {
    onConfigChange(localConfig);
    onClose();
  };

  const updateImport = (key: keyof AppConfig['smartImport'], val: any) => {
    setLocalConfig(prev => ({
      ...prev,
      smartImport: { ...prev.smartImport, [key]: val }
    }));
  };

  const updateResearch = (key: keyof AppConfig['research'], val: any) => {
    setLocalConfig(prev => ({
      ...prev,
      research: { ...prev.research, [key]: val }
    }));
  };

  const updateMatch = (val: string) => {
    setLocalConfig((prev: AppConfig) => ({
      ...prev,
      smartMatch: { ...prev.smartMatch, destFolderName: val }
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0" onClick={onClose}></div>
      <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[90vh] relative z-10 overflow-hidden">
        
        {/* Header */}
        <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-800/50">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Settings size={20} className="text-blue-400"/> 设置
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition">
            <X size={20} />
          </button>
        </div>
        
        {/* Body - 补全了之前缺失的设置项 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-thin scrollbar-thumb-slate-700">
          
          {/* 1. Smart Import 设置 */}
          <section className="space-y-4">
            <h4 className="text-blue-400 font-bold uppercase text-xs tracking-wider border-b border-slate-800 pb-2">
              从SD卡导入媒体
            </h4>
            
            <div className="flex items-center gap-3 p-2 rounded hover:bg-slate-800/30 transition">
               <input 
                 type="checkbox" 
                 id="autoStart"
                 checked={localConfig.smartImport.autoStart} 
                 onChange={e => updateImport('autoStart', e.target.checked)}
                 className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-offset-slate-900"
               />
               <label htmlFor="autoStart" className="text-sm text-slate-300 cursor-pointer select-none">
                 应用启动时自动开始读取SD卡文件
               </label>
            </div>
            <p className="text-xs text-slate-500">
              支持佳能（.cr2 .cr3）、索尼（.arw）、尼康（.nef）、奥林巴斯（.orf）、徕卡（.rwl .dng）、富士（.raf）、哈苏（.3fr .fff）、大疆（.dng）的RAW格式导入。
            </p>

            <InputField label="SD卡路径" value={localConfig.smartImport.sdPath} onChange={v => updateImport('sdPath', v)} icon={<FolderInput size={14}/>} />
            <InputField label="导入的默认路径" value={localConfig.smartImport.destPath} onChange={v => updateImport('destPath', v)} icon={<Download size={14}/>} />

            <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-3">
               <div className="flex items-center gap-3 mb-2">
                  <input 
                    type="checkbox" 
                    id="backupEnabled"
                    checked={localConfig.smartImport.backupEnabled} 
                    onChange={e => updateImport('backupEnabled', e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-green-500 focus:ring-offset-slate-900"
                  />
                  <label htmlFor="backupEnabled" className="text-sm text-slate-300 font-bold cursor-pointer select-none">
                    开启备份
                  </label>
               </div>
               {localConfig.smartImport.backupEnabled && (
                  <InputField label="备份目标路径" value={localConfig.smartImport.backupPath} onChange={v => updateImport('backupPath', v)} icon={<HardDrive size={14}/>} />
               )}
            </div>
          </section>

          {/* 2. Smart Match 设置 */}
          <section className="space-y-4">
            <h4 className="text-emerald-400 font-bold uppercase text-xs tracking-wider border-b border-slate-800 pb-2">
              选片
            </h4>
            <InputField 
                label="选片的文件夹名" 
                value={localConfig.smartMatch.destFolderName} 
                onChange={updateMatch} 
                icon={<FolderInput size={14}/>} 
            />
            <p className="text-xs text-slate-500">
                文件会被复制到这个文件夹，如果路径不存在会自动创建
            </p>
          </section>

          {/* 3. Research AI 设置 */}
          <section className="space-y-4">
            <h4 className="text-purple-400 font-bold uppercase text-xs tracking-wider border-b border-slate-800 pb-2">
              调研整理
            </h4>
            <InputField label="默认读取路径" value={localConfig.research.defaultDir} onChange={v => updateResearch('defaultDir', v)} icon={<FolderInput size={14}/>} />
            <div className="grid grid-cols-2 gap-4">
               <div>
                  <label className="text-xs text-slate-500 font-bold uppercase">默认SSIM阈值</label>
                  <input 
                    type="number" step="0.01" max="1" min="0"
                    value={localConfig.research.ssimThreshold}
                    onChange={e => updateResearch('ssimThreshold', parseFloat(e.target.value))}
                    className="w-full mt-2 bg-slate-950 border border-slate-700 rounded-lg p-2 text-white text-sm focus:border-blue-500 outline-none"
                  />
               </div>
               <div>
                  <label className="text-xs text-slate-500 font-bold uppercase">默认最小持续时间(秒)</label>
                  <input 
                    type="number" step="0.1"
                    value={localConfig.research.minDuration}
                    onChange={e => updateResearch('minDuration', parseFloat(e.target.value))}
                    className="w-full mt-2 bg-slate-950 border border-slate-700 rounded-lg p-2 text-white text-sm focus:border-blue-500 outline-none"
                  />
               </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-900 flex justify-end gap-3">
           <button onClick={onClose} className="px-4 py-2 text-slate-400 hover:text-white transition text-sm">取消</button>
           <button onClick={handleSave} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-lg font-bold flex items-center gap-2 text-sm shadow-lg shadow-blue-900/20">
              <Save size={16} /> 保存
           </button>
        </div>
      </div>
    </div>
  );
};

const AboutModal = ({ onClose }: { onClose: () => void }) => {
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0" onClick={onClose}></div>
      <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[90vh] relative z-10 overflow-hidden">
        <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-800/50">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <AtSign size={20} className="text-blue-400"/> 关于
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition">
            <X size={20} />
          </button>
        </div>
        
        {/* Body - 仅保留一行正文文字 */}
        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-slate-700 flex">
          <p className="text-slate-300 text-base leading-relaxed">
            @秋也寻
            <br/>
            版本 25.12.6
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
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ${
      active 
        ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' 
        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
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
        className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-slate-200 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm"
      />
    </div>
  </div>
);

export default App;