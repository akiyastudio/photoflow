import React, { useState, useEffect } from 'react';
import { FolderInput, ScanSearch, HardDrive, Play, Trash2, AlertCircle, Edit, X, Plus, User, Loader2, RotateCcw, Download, Scissors, Video, ChevronDown, ChevronUp } from 'lucide-react';
import { TaskProgress } from '../../components/TaskStatus';
import { RequirePlugin } from '../../features/plugins/RequirePlugin';
import type { AppConfig, LogEntry } from '../../types';

const IMAGE_SELECTION_FOLDER_NAME = '图片选片';
const VIDEO_SELECTION_FOLDER_NAME = '视频选片';
interface PythonEvent {
  type: 'log' | 'error' | 'progress' | 'status' | 'ask_user' | 'success' | 'warning' | 'preview';
  message: string;
  data?: any;
  progress?: number;
  scriptName?: string;
  requestId?: string;
}

const ImportCard = ({ config, drives = [], destinationPath, active = true, onImportConfigChange, onImportComplete }: { config?: AppConfig['smartImport'], drives?: string[], destinationPath?: string | null, active?: boolean, onImportConfigChange?: (config: AppConfig['smartImport']) => void, onImportComplete?: (projectNames: string[]) => void }) => {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready_to_import' | 'importing' | 'decision' | 'processing' | 'finished'>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("等待连接...");
  const [decisionData, setDecisionData] = useState<any>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const selectedDrives = config?.sdPaths?.length ? config.sdPaths : config?.sdPath ? [config.sdPath] : [];
  const driveTypes = config?.sdDriveTypes || {};

  // 【关键修改】使用 Ref 来做“防抖”锁，防止 SD 卡接触不良导致多次触发 startImport
  const isBusyRef = React.useRef(false);
  const importQueueRef = React.useRef<Array<{ path: string; type: 'work' | 'broll' }>>([]);
  const currentDriveRef = React.useRef('');
  const currentDriveTypeRef = React.useRef<'work' | 'broll'>('work');
  const importRequestIdRef = React.useRef('');
  const importedProjectNamesRef = React.useRef<string[]>([]);
  const startImportRef = React.useRef<(sdPath?: string, type?: 'work' | 'broll') => void>(() => undefined);
  const startBatchRef = React.useRef<() => void>(() => undefined);
  const onImportCompleteRef = React.useRef(onImportComplete);
  useEffect(() => { onImportCompleteRef.current = onImportComplete; }, [onImportComplete]);
  const toggleDrive = (sdPath: string) => {
    if (!config || !onImportConfigChange) return;
    const sdPaths = selectedDrives.includes(sdPath) ? selectedDrives.filter(path => path !== sdPath) : [...selectedDrives, sdPath];
    onImportConfigChange({ ...config, sdPath: sdPaths[0] || '', sdPaths, sdDriveTypes: { ...driveTypes, [sdPath]: driveTypes[sdPath] || 'work' } });
  };
  const setDriveType = (sdPath: string, type: 'work' | 'broll') => {
    if (!config || !onImportConfigChange) return;
    onImportConfigChange({ ...config, sdDriveTypes: { ...driveTypes, [sdPath]: type } });
  };

  const runCmd = (stage: string, args: string[] = []) => {
    if(window.electronAPI) window.electronAPI.runScript('classify.py', ['--stage', stage, ...args], importRequestIdRef.current);
  };

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;

    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      if (!active && !isBusyRef.current) return;
      if (event.scriptName !== 'classify.py') return;
      if (!event.requestId || event.requestId !== importRequestIdRef.current) return;
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
                    startBatchRef.current();
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
          {
            const importedNames = Array.isArray(event.data?.projectNames) ? event.data.projectNames.map(String) : [];
            importedProjectNamesRef.current = Array.from(new Set([...importedProjectNamesRef.current, ...importedNames]));
            const nextDrive = importQueueRef.current.shift();
            if (nextDrive) {
              setStatusMsg(`${currentDriveRef.current} 导入完成，接下来导入 ${nextDrive.path}`);
              setTimeout(() => startImportRef.current(nextDrive.path, nextDrive.type), 500);
            } else {
              setStatus('finished');
              setStatusMsg("所选 SD 卡已全部导入完成");
              isBusyRef.current = false; // 【解锁】
              onImportCompleteRef.current?.(importedProjectNamesRef.current);
            }
          }
          break;

        case 'error':
          // 如果是普通的 warning 不打断流程
          if (event.message.includes("警告")) return;

          // 严重错误
          setStatusMsg("Error: " + event.message);
          setStatus('idle');
          importQueueRef.current = [];
          currentDriveRef.current = '';
          isBusyRef.current = false; // 【解锁】
          break;
      }
    });

    return cleanup;
  }, [active]);

  // 自动检查逻辑
  useEffect(() => {
    if (active && config?.autoStart && !isBusyRef.current) {
      checkSD();
    }
  }, [active, config?.autoStart]);

  const checkSD = () => {
    if (isBusyRef.current) return;

    importRequestIdRef.current = crypto.randomUUID();
    setStatus('checking');
    setStatusMsg("正在扫描设备...");
    setLogs([]);

    const args = [];
    if (config) {
      args.push('--sd_path', selectedDrives[0] || config.sdPath);
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

  const startImport = (sdPath = selectedDrives[0], type: 'work' | 'broll' = driveTypes[sdPath] || 'work') => {
    if (!destinationPath) {
      setStatusMsg('无法确定导入项目，请先设置工作目录。');
      return;
    }
    if (isBusyRef.current && !currentDriveRef.current) {
        console.log("Import already running, skipped.");
        return;
    }

    isBusyRef.current = true; // 【上锁】
    currentDriveRef.current = sdPath;
    currentDriveTypeRef.current = type;
    setStatus('importing');
    setProgress(0);
    setLogs([]); // 清空日志准备开始
    setStatusMsg(type === 'broll' ? `正在把 ${sdPath} 导入“花絮”` : `正在整理 ${sdPath} 的工作文件`);

    const args = [];
    if (config) {
      args.push('--sd_path', sdPath);
      args.push('--dest_path', destinationPath || '');
      if (type === 'work' && config.generateVideoPreview) {
        args.push('--generate_video_preview');
      }
      if (type === 'work' && config.splitLargeFiles) {
        args.push('--split_large_files');
      }
    }
    runCmd(type === 'broll' ? 'broll' : 'import', args);
  };
  startImportRef.current = startImport;

  const startBatchImport = () => {
    if (isBusyRef.current) return;
    const connected = selectedDrives.filter(drive => drives.includes(drive));
    if (!connected.length) {
      setStatusMsg('所选 SD 卡均未连接');
      return;
    }
    const queue = connected.map(path => ({ path, type: driveTypes[path] || 'work' as const }));
    importQueueRef.current = queue.slice(1);
    importedProjectNamesRef.current = [];
    currentDriveRef.current = '';
    startImport(queue[0].path, queue[0].type);
  };
  startBatchRef.current = startBatchImport;

  const handleDecision = (split: boolean) => {
    setStatus('processing');
    setProgress(0);
    const args = [];
    if (config) {
      args.push('--sd_path', currentDriveRef.current || selectedDrives[0] || config.sdPath);
      args.push('--dest_path', destinationPath || '');
      if (config.generateVideoPreview) {
        args.push('--generate_video_preview');
      }
      if (config.splitLargeFiles) {
        args.push('--split_large_files');
      }
      // 添加用户决定的参数
      args.push('--should_split', split ? 'true' : 'false');
    }

    // 重新启动导入流程（因为临时文件已经存在，所以会很快）
    runCmd(currentDriveTypeRef.current === 'broll' ? 'broll' : 'import', args);
  };

  // --- 渲染逻辑 (UI 部分) ---

  if (status === 'idle' || status === 'checking') {
    // 实时判断当前配置的盘符是否插在电脑上
    const connectedDrives = selectedDrives.filter(drive => drives.includes(drive));
    const isConnected = connectedDrives.length > 0;

    // 动态判断显示的副标题
    let displayMsg = statusMsg;
    if (status === 'idle') {
      if (statusMsg.startsWith('Error:')) {
        displayMsg = statusMsg;
      } else if (!selectedDrives.length) {
        displayMsg = "请选择 SD 卡盘符";
      } else if (isConnected) {
        displayMsg = `已连接 ${connectedDrives.length}/${selectedDrives.length} 张卡，点击右侧按钮批量导入`;
      } else {
        displayMsg = `等待 ${selectedDrives.join('、')} 接入...`;
      }
    } else if (status === 'checking') {
      displayMsg = `正在准备读取 ${selectedDrives[0] || ''}...`;
    }

    // 动态图标颜色 (扫描中是蓝色，已连接是绿色，未连接是灰色)
    const iconColorClass = status === 'checking'
        ? 'bg-blue-50 text-blue-600'
        : isConnected
            ? 'bg-emerald-50 text-emerald-600'
            : 'bg-slate-100 text-slate-500';

    return (
      <div className="w-full bg-white/50 border border-slate-200 rounded-xl p-4 flex items-center justify-between animate-in fade-in transition-all">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg transition-colors ${iconColorClass}`}>
            {status === 'checking' ? <Loader2 className="animate-spin" size={18} /> : <HardDrive size={18} />}
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold text-slate-800">从SD卡导入媒体</span>
            <span className="text-xs text-slate-500">{displayMsg}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <details className="relative" onClick={event => event.stopPropagation()}>
            <summary className="flex h-9 min-w-36 cursor-pointer list-none items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:border-blue-400"><span className="max-w-40 truncate">{selectedDrives.length ? `已选 ${selectedDrives.length} 个盘符` : '选择盘符'}</span><ChevronDown size={15}/></summary>
            <div className="mt-1 min-w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
              {[...new Set([...selectedDrives, ...drives])].map(drive => <div key={drive} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-slate-50"><label className="flex min-w-0 cursor-pointer items-center gap-2"><input type="checkbox" checked={selectedDrives.includes(drive)} onChange={() => toggleDrive(drive)}/><span className="font-mono">{drive}</span></label><select aria-label={`${drive} 导入类型`} value={driveTypes[drive] || 'work'} onChange={event => setDriveType(drive, event.target.value as 'work' | 'broll')} className="ml-auto rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600" disabled={!selectedDrives.includes(drive)}><option value="work">工作文件</option><option value="broll">花絮</option></select><span className={`text-xs ${drives.includes(drive) ? 'text-emerald-600' : 'text-slate-400'}`}>{drives.includes(drive) ? '已连接' : '未连接'}</span></div>)}
              {!drives.length && !selectedDrives.length && <p className="px-2 py-1 text-xs text-slate-500">未检测到可用盘符</p>}
            </div>
          </details>
          {isConnected && status === 'idle' ? (
            <button onClick={startBatchImport} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold flex items-center gap-2 shadow-md shadow-blue-500/20 transition-all animate-in zoom-in-95"><Download size={16} />{connectedDrives.length > 1 ? '批量导入' : '开始导入'}</button>
          ) : (
            <button disabled className={`p-2 rounded-lg transition ${status === 'checking' ? 'text-blue-500' : 'text-slate-300 bg-slate-50 cursor-not-allowed'}`}><RotateCcw size={18} className={status === 'checking' ? 'animate-spin' : ''} /></button>
          )}
        </div>
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
            从 SD 卡导入媒体
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
            <div className="w-full max-w-xl">
              <TaskProgress logs={logs} progress={progress} isRunning idleMessage={statusMsg} />
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
              <TaskProgress logs={logs} progress={100} isRunning={false} idleMessage="处理完成" />
            </div>
          )}
        </div>
      </div>

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

type HomePanelDragProps = Pick<React.ComponentProps<'button'>, 'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop'>;

const DashboardView = ({
  workspacePath,
  section = 'all',
  config,
  projectDestination,
  projectName,
  onImportConfigChange,
  onImportComplete,
  dragProps
}: {
  workspacePath: string;
  section?: 'all' | 'import' | 'birthday';
  config: AppConfig['smartImport'];
  projectDestination?: string | null;
  projectName?: string;
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onImportComplete?: (projectNames: string[]) => void | Promise<void>;
  dragProps?: HomePanelDragProps;
}) => {
  // 生日逻辑保持不变
  const [upcomingBirthdays, setUpcomingBirthdays] = useState<{name: string, date: string, sortKey: number}[]>([]);
  const [loading, setLoading] = useState(true);
  const [showManager, setShowManager] = useState(false);
  const [drives, setDrives] = useState<string[]>([]);

  // 挂载时获取系统盘符
  useEffect(() => {
    const fetchDrives = async () => {
      if (window.electronAPI?.getDrives) {
        const sysDrives = await window.electronAPI.getDrives();
        // 只有当盘符发生变化时才更新状态，避免 React 无意义的频繁重绘
        setDrives(prevDrives => {
          if (JSON.stringify(prevDrives) === JSON.stringify(sysDrives)) {
            return prevDrives;
          }
          return sysDrives;
        });
      }
    };

    fetchDrives(); // 首次立刻执行获取

    // 每 3 秒钟在后台静默检查一次新插入的设备
    const intervalId = setInterval(fetchDrives, 3000);

    // 组件卸载时清理定时器
    return () => clearInterval(intervalId);
  }, []);

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
      {projectDestination && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">当前项目：<strong>{projectName || projectDestination}</strong>{projectDestination.endsWith("花絮") ? " · 导入花絮" : " · 从 SD 卡导入"}</div>}
      {showManager && (
        <BirthdayManagerModal
          onClose={() => setShowManager(false)}
          onDataChanged={fetchBirthdays}
        />
      )}

      {section !== 'birthday' && <HomePanel title="从 SD 卡导入" initiallyOpen {...dragProps}>
        <div className="flex flex-col gap-6">
          <RequirePlugin embedded scriptName="classify.py" title="从 SD 卡导入" desc="需要该引擎来识别和导入 SD 卡中的媒体文件。">
            <ImportCard config={config} drives={drives} destinationPath={projectDestination ?? workspacePath} onImportConfigChange={onImportConfigChange} onImportComplete={projectDestination ? undefined : projectNames => { void onImportComplete?.(projectNames); }} />
          </RequirePlugin>
        </div>
      </HomePanel>}
      {section !== 'import' && <HomePanel title="角色生日" initiallyOpen tone="birthday" {...dragProps}>
        <div className="space-y-3">
          <div className="flex justify-between items-start">
              <h3 className="text-sm font-semibold text-slate-600 flex items-center gap-1.5">
                <span className="text-base">🎂</span> 角色生日
              </h3>
          </div>

          <div className="">
              {loading ? (
                <div className="text-indigo-400 text-sm">Loading birthdays...</div>
              ) : upcomingBirthdays.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pr-1">
                  {upcomingBirthdays.map((b, i) => (
                    // 内部小卡片改为白底，hover 时稍微加深
                    <div key={i} className="flex items-center justify-between bg-white/80 p-2.5 rounded-md border border-blue-100 hover:border-blue-200 transition group">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-[10px]">{b.name.charAt(0)}</div>
                        {/* 名字文字加深 */}
                        <span className="text-sm font-medium text-slate-700 pr-2 leading-snug">{b.name}</span>
                      </div>
                      <span className="flex-shrink-0 text-blue-600 font-mono text-[11px] bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">{b.date}</span>
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
          <div className="flex items-center justify-between pt-3 border-t border-blue-100">
              <p className="text-[11px] text-slate-500">只显示接下来两个月的角色生日</p>
              {/* 管理按钮变亮 */}
              <button onClick={() => setShowManager(true)} className="flex items-center gap-1 px-2 py-1 rounded-md bg-white hover:bg-blue-50 text-blue-600 text-[11px] font-bold transition-all border border-blue-100">
                <Edit size={12} /> Manage
              </button>
          </div>
        </div>
      </HomePanel>}
    </div>
  );
};

const HomePanel = ({ title, initiallyOpen = false, tone, children, ...dragProps }: { title: string; initiallyOpen?: boolean; tone?: 'birthday'; children: React.ReactNode } & HomePanelDragProps) => {
  const [open, setOpen] = useState(initiallyOpen);
  const storageKey = `photoflow:home-panel:${title}`;
  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved !== null) setOpen(saved === 'true');
  }, [storageKey]);
  useEffect(() => {
    window.localStorage.setItem(storageKey, String(open));
  }, [open, storageKey]);
  const isBirthday = tone === 'birthday';
  return <section className={`rounded-xl overflow-hidden ${isBirthday ? 'birthday-panel' : 'border border-slate-200 bg-white'}`}><button {...dragProps} onClick={() => setOpen(value => !value)} className={`flex w-full items-center justify-between px-5 py-4 text-left ${dragProps.draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${isBirthday ? 'birthday-panel-header' : ''}`}><span className={`text-base font-bold ${isBirthday ? 'birthday-panel-title' : 'text-slate-800'}`}>{title}</span><span className={isBirthday ? 'birthday-panel-icon' : 'text-slate-400'}>{open ? <ChevronUp size={18}/> : <ChevronDown size={18}/>}</span></button>{open && <div className={`border-t p-5 animate-in slide-in-from-top-1 duration-200 ${isBirthday ? 'birthday-panel-body' : 'border-slate-100'}`}>{children}</div>}</section>;
};

const ConverterView = ({ embedded = false, initialTargetPath = "", defaultQuality = 100 }: { embedded?: boolean; initialTargetPath?: string; defaultQuality?: number }) => {
  const [targetPath, setTargetPath] = useState(initialTargetPath);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [quality, setQuality] = useState(defaultQuality);

  useEffect(() => { setTargetPath(initialTargetPath); }, [initialTargetPath]);
  useEffect(() => { setQuality(defaultQuality); }, [defaultQuality]);

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      if (event.scriptName !== 'png_to_jpg.py') return;
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
      window.electronAPI.runScript('png_to_jpg.py', [targetPath, '--quality', quality.toString()]);
    }
  };

  return (
    <div className="w-full space-y-6">
      {!embedded && <h2 className="text-2xl font-bold text-slate-800">PNG 转 JPG </h2>}
      <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>

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

        <div className="flex items-center justify-between gap-4 rounded-lg bg-slate-50 p-3 border border-slate-200">
          <label className="text-sm font-medium text-slate-700">导出JPG 画质</label>
          <select value={quality} onChange={event => setQuality(Number(event.target.value))} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:border-blue-500">
            <option value={100}>最高（100）</option>
            <option value={95}>高（95）</option>
            <option value={85}>标准（85）</option>
            <option value={75}>节省空间（75）</option>
          </select>
        </div>
        {/* Progress & Actions */}
        <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          idleMessage={isRunning ? '正在转换…' : '进度'}
          action={<button
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
             </button>}
        />
      </div>

    </div>
  );
};

const ResearchView = ({
  embedded = false,
  config,
  onUpdateConfig
}: {
  embedded?: boolean;
  config: AppConfig['research'];
  onUpdateConfig: (newConfig: AppConfig['research']) => void;
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("准备就绪");

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;
    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      if (event.scriptName !== 'research.py') return;
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

          // 如果是成功或失败，停止运行状态
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
             // 将进度消息也记录到终端日志中
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

  const runAnalysis = () => {
    if (isRunning) return;
    setLogs([]);
    setProgress(0);
    setIsRunning(true);
    setStatusMsg("正在初始化引擎...");

    if (window.electronAPI) {
      window.electronAPI.runScript('research.py', [
        '--path', config.defaultDir,
        '--sensitivity', config.sensitivity,
        '--min_duration', config.minDuration.toString()
      ]);
    }
  };

  return (
    <div className="w-full space-y-6">
      {!embedded && <h2 className="text-2xl font-bold text-slate-800">调研整理</h2>}
      <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>
        <div className="space-y-2">
          <p className="mt-2 text-gray-600">这个功能会整理从小红书/抖音爬取下来的文件，对视频执行转场识别，把每一个分镜的视频帧截取一帧下来。</p>
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
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="form-label">检测灵敏度</label>
            <select value={config.sensitivity} onChange={event => onUpdateConfig({ ...config, sensitivity: event.target.value as AppConfig['research']['sensitivity'] })} className="form-input"><option value="low">低</option><option value="standard">标准</option><option value="high">高</option></select>
            <p className="mt-1 text-xs leading-5 text-slate-500">{{ low: '只保留明显硬切，截图最少。', standard: '兼顾硬切、渐变与误判率。', high: '识别更多轻微转场，截图更多。' }[config.sensitivity]}</p>
          </div>
          <div>
            <label className="form-label">最小片段时长（秒）</label>
            <input type="number" min="0.05" max="5" step="0.05" value={config.minDuration} onChange={event => onUpdateConfig({ ...config, minDuration: Math.min(5, Math.max(0.05, Number(event.target.value) || 0.05)) })} className="form-input"/>
            <p className="mt-1 text-xs leading-5 text-slate-500">数值越大，短暂画面会被过滤，最终导出的截图越少。</p>
          </div>
        </div>

        <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          idleMessage={statusMsg}
          action={<button
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
             </button>}
        />
      </div>
    </div>
  );
};

const MatchView = ({
        embedded = false,
        config,
        projectPath,
        onUpdateConfig,
        folderOptions = []
    }: {
        embedded?: boolean;
        config: AppConfig['smartMatch'];
        projectPath?: string;
        onUpdateConfig: (newMatchConfig: AppConfig['smartMatch']) => void;
        folderOptions?: Array<{ name: string; path: string }>;
    }) => {
    const [keywords, setKeywords] = useState("");
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        if (!window.electronAPI?.onPythonEvent) return;
        const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
            if (event.scriptName !== 'catch.py') return;
            if (event.type === 'log' || event.type === 'error' || event.type === 'success') {
                setLogs(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), message: event.message, type: event.type as any }]);
                if (event.type === 'success' || event.type === 'error') {
                    setIsRunning(false);
                    if (event.type === 'success') setProgress(100);
                }
            } else if (event.type === 'progress') {
                if (event.progress !== undefined) setProgress(event.progress);
                if (event.message) setLogs(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), message: event.message, type: 'info' }]);
            }
        });
        return cleanup;
    }, []);

    const runTask = () => {
        if (!projectPath || !keywords.trim() || isRunning) return;
        setIsRunning(true);
        setLogs([]);
        setProgress(0);
        window.electronAPI.runScript('catch.py', [
            '--source', projectPath,
            '--image_dest_name', IMAGE_SELECTION_FOLDER_NAME,
            '--video_dest_name', VIDEO_SELECTION_FOLDER_NAME,
            '--image_source_name', config.imageSourceFolderName || '',
            '--video_source_name', config.videoSourceFolderName || '',
            '--keywords', ...keywords.trim().split(/\s+/)
        ]);
    };

    return (
        <div className="w-full space-y-6">
            {!embedded && <h2 className="text-2xl font-bold text-slate-800">选片</h2>}
            <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="text-sm text-slate-600">从文件夹选择图片<select value={config.imageSourceFolderName ?? 'raw'} onChange={event => onUpdateConfig({ ...config, imageSourceFolderName: event.target.value || undefined })} className="form-input mt-1"><option value="">无</option>{folderOptions.map(folder => <option key={folder.path} value={folder.name}>{folder.name}</option>)}</select><span className="mt-1 block text-xs font-bold text-slate-500">选中的图片会存放到“{IMAGE_SELECTION_FOLDER_NAME}”文件夹</span></label><label className="text-sm text-slate-600">从文件夹选择视频<select value={config.videoSourceFolderName ?? 'mov'} onChange={event => onUpdateConfig({ ...config, videoSourceFolderName: event.target.value || undefined })} className="form-input mt-1"><option value="">无</option>{folderOptions.map(folder => <option key={folder.path} value={folder.name}>{folder.name}</option>)}</select><span className="mt-1 block text-xs font-bold text-slate-500">选中的视频会存放到“{VIDEO_SELECTION_FOLDER_NAME}”文件夹</span></label></div>
                <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 uppercase">文件名</label>
                    <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="文件名需要用空格分开，一个空格分开一个文件名" className="h-24 min-h-24 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm text-slate-900 transition-colors focus:border-blue-500 focus:outline-none"/>
                </div>
                <TaskProgress
                    logs={logs}
                    progress={progress}
                    isRunning={isRunning}
                    idleMessage={isRunning ? '正在选片…' : '进度'}
                    action={<button onClick={runTask} disabled={isRunning || !projectPath || !keywords.trim()} className={`px-8 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${isRunning || !projectPath || !keywords.trim() ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none' : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20'}`}>
                        {isRunning ? <Loader2 className="animate-spin" size={18}/> : <ScanSearch size={18}/>}
                        {isRunning ? '复制中...' : '开始选片'}
                    </button>}
                />
            </div>
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
      if (event.scriptName !== 'cut_video.py') return;
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
          <Scissors size={24} /> 视频切割
      </h2>
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">

        <div className="space-y-2">
          <p className="mt-2 text-gray-600">
            无损将视频切割分为4GB为一个的视频文件。用于处理过长的花絮/素材文件。
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
        <TaskProgress
          logs={logs}
          progress={progress}
          isRunning={isRunning}
          idleMessage={statusMsg}
          action={<button
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
            </button>}
        />
      </div>

    </div>
  );
};

// --- 组件 ---

export { DashboardView, HomePanel, ConverterView, ResearchView, MatchView, VideoSplitView };
