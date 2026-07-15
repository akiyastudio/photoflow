import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  FolderInput,
  FolderPlus,
  Folder,
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
  Puzzle,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { TaskStatus } from './components/Terminal';
import { ProjectNavigator } from './components/ProjectNavigator';
import type { LogEntry, ToolType, WorkspaceProject } from './types';

type Theme = 'light' | 'dark' | 'system';
type HomeCardId = 'birthday' | 'import' | 'research' | 'converter';
const DEFAULT_HOME_ORDER: HomeCardId[] = ['birthday', 'import', 'research', 'converter'];

// --- 类型定义 ---

interface AppConfig {
  theme: Theme;
  workspacePath: string;
  homeOrder: HomeCardId[];
  smartImport: {
    autoStart: boolean;
    sdPath: string;
    destPath: string;
    backupEnabled: boolean;
    backupPath: string;
    generateVideoPreview: boolean;
  };
  brollImport: {
    splitLargeFiles: boolean;
    clearSource: boolean;
  };
  smartMatch: {
    imageDestFolderName: string;
    videoDestFolderName: string;
    destFolderName?: string;
  };
  research: {
    defaultDir: string;
    ssimThreshold: number;
    minDuration: number;
  };
}

const isMac = window.navigator.userAgent.includes('Mac');

const DEFAULT_CONFIG = (userPath: string): AppConfig => ({
  theme: 'system',
  workspacePath: '',
  homeOrder: DEFAULT_HOME_ORDER,
  smartImport: {
    autoStart: false,
    sdPath: isMac ? "/Volumes" : "H:/DCIM",
    destPath: `${userPath}/Desktop`,
    backupEnabled: false,
    generateVideoPreview: false,
    backupPath: isMac ? `${userPath}/Pictures/Backup` : "D:/Backup"
  },
  brollImport: {
    splitLargeFiles: false,
    clearSource: true
  },
  smartMatch: {
    imageDestFolderName: "\u56fe\u7247\u9009\u7247",
    videoDestFolderName: "\u89c6\u9891\u9009\u7247"
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
  const [activeTab, setActiveTab] = useState<ToolType>('home');
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showWorkspaceSetup, setShowWorkspaceSetup] = useState(false);

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{version: string, url: string, notes: string} | null>(null);
  const [selectedProject, setSelectedProject] = useState<WorkspaceProject | null>(null);
  const [projectDestination, setProjectDestination] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState('');
  const [homeOrder, setHomeOrder] = useState<HomeCardId[]>(DEFAULT_HOME_ORDER);
  const [draggedHomeCard, setDraggedHomeCard] = useState<HomeCardId | null>(null);
  const [projectOperation, setProjectOperation] = useState<'import' | 'broll' | 'match' | null>(null);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        if (window.electronAPI?.loadConfig) {
          const fileConfig = await window.electronAPI.loadConfig();
          if (fileConfig) {
            let normalizedConfig = { ...fileConfig, theme: fileConfig.theme ?? 'system', workspacePath: fileConfig.workspacePath?.trim() ?? '', homeOrder: Array.isArray(fileConfig.homeOrder) ? fileConfig.homeOrder : DEFAULT_HOME_ORDER, smartImport: { ...fileConfig.smartImport, backupEnabled: false, generateVideoPreview: fileConfig.smartImport?.generateVideoPreview ?? false }, brollImport: { splitLargeFiles: fileConfig.brollImport?.splitLargeFiles ?? false, clearSource: fileConfig.brollImport?.clearSource ?? true }, smartMatch: { imageDestFolderName: fileConfig.smartMatch?.imageDestFolderName ?? fileConfig.smartMatch?.destFolderName ?? '\u56fe\u7247\u9009\u7247', videoDestFolderName: fileConfig.smartMatch?.videoDestFolderName ?? '\u89c6\u9891\u9009\u7247' } } as AppConfig;
            if (normalizedConfig.workspacePath) {
              const workspace = await window.electronAPI.getWorkspaceProjects(normalizedConfig.workspacePath);
              if (workspace.success && workspace.root) normalizedConfig = { ...normalizedConfig, workspacePath: workspace.root };
            } else {
              setShowWorkspaceSetup(true);
            }
            setConfig(normalizedConfig);
            if ((fileConfig.workspacePath !== normalizedConfig.workspacePath || fileConfig.smartImport.backupEnabled || !fileConfig.brollImport || !fileConfig.smartMatch?.imageDestFolderName || !fileConfig.smartMatch?.videoDestFolderName) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
            console.log('📋 Configuration loaded from file');
          } else {
            if (window.electronAPI?.getUserPath) {
              const userPath = await window.electronAPI.getUserPath();
              if (userPath) {
                let defaultConfig = DEFAULT_CONFIG(userPath);
                setConfig(defaultConfig);
                if (window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(defaultConfig);
                setShowWorkspaceSetup(true);
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
    if (!config) return;

    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const isDark = config.theme === 'dark' || (config.theme === 'system' && systemTheme.matches);
      document.documentElement.classList.toggle('dark', isDark);
      window.electronAPI?.setTheme?.(isDark ? 'dark' : 'light');
    };

    applyTheme();
    systemTheme.addEventListener('change', applyTheme);
    return () => systemTheme.removeEventListener('change', applyTheme);
  }, [config?.theme]);
  useEffect(() => {
    if (window.electronAPI?.onUpdateAvailable) {
      const cleanup = window.electronAPI.onUpdateAvailable((info: any) => {
        console.log("Update available:", info);
        setUpdateInfo(info);
      });
      return cleanup;
    }
  }, []);

  useEffect(() => {
    if (config?.homeOrder?.length) setHomeOrder(config.homeOrder);
  }, [config?.homeOrder]);

  useEffect(() => {
    let noticeTimer: number | undefined;
    const onKeyDown = async (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      const result = await window.electronAPI.undoLastRename();
      setUndoNotice(result.success ? (result.message || '\u5df2\u64a4\u9500\u4e0a\u4e00\u6b21\u91cd\u547d\u540d') : (result.error || '\u6682\u65e0\u53ef\u64a4\u9500\u7684\u91cd\u547d\u540d'));
      if (result.success) {
        if (result.project) {
          setSelectedProject(result.project);
          setProjectDestination(result.project.path);
        }
        window.dispatchEvent(new Event('workspace-projects-changed'));
      }
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setUndoNotice(''), 2000);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); window.clearTimeout(noticeTimer); };
  }, []);

  const reorderHomeCards = (target: HomeCardId) => {
    if (!draggedHomeCard || draggedHomeCard === target) return;
    const next = [...homeOrder];
    const from = next.indexOf(draggedHomeCard);
    const to = next.indexOf(target);
    next.splice(from, 1);
    next.splice(to, 0, draggedHomeCard);
    setHomeOrder(next);
    if (config) handleConfigUpdate({ ...config, homeOrder: next });
  };
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

  const handleWorkspaceSetup = async (newConfig: AppConfig) => {
    await handleConfigUpdate(newConfig);
    setShowWorkspaceSetup(false);
  };
  const handleHomeImportComplete = async () => {
    const result = await window.electronAPI.archiveImportedProjects(config.workspacePath);
    if (!result.success) return;
    if (result.projects.length === 1) {
      setSelectedProject(result.projects[0]);
      setProjectDestination(result.projects[0].path);
      setProjectOperation(null);
      setActiveTab('project');
    }
    window.dispatchEvent(new Event('workspace-projects-changed'));
  };
  // 等待配置加载完成再渲染主界面
  const handleProjectAction = (action: 'import' | 'broll' | 'match', project: WorkspaceProject) => {
    setSelectedProject(project);
    setProjectDestination(project.path);
    setProjectOperation(action);
    setActiveTab('project');
  };
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
            <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-800 to-indigo-800 bg-clip-text text-transparent">
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
      {undoNotice && <div className="fixed left-1/2 top-10 z-[400] -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white shadow-xl animate-in fade-in slide-in-from-top-2">{undoNotice}</div>}

      {updateInfo && (
        <UpdateModal
          version={updateInfo.version}
          url={updateInfo.url}
          notes={updateInfo.notes}
          onClose={() => setUpdateInfo(null)}
        />
      )}

      {showSettings && config && <SettingsModal config={config} onSave={handleConfigUpdate} onClose={() => setShowSettings(false)} />}
      {showWorkspaceSetup && config && <SettingsModal config={config} onSave={handleWorkspaceSetup} onClose={() => undefined} requireWorkspace />}

      {showAbout && config && (
        <AboutModal
          theme={config.theme}
          onThemeChange={(theme: Theme) => handleConfigUpdate({...config, theme})}
          onClose={() => setShowAbout(false)}
        />
      )}

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-200">
          <button onClick={() => { setSelectedProject(null); setProjectDestination(null); setActiveTab('home'); }} className="text-left text-2xl font-bold bg-gradient-to-r from-blue-800 to-indigo-800 bg-clip-text text-transparent cursor-pointer">
            照片流
          </button>
          <p className="text-xs text-slate-500 mt-1 font-mono">v26.7.15</p>
        </div>

        <ProjectNavigator
          workspacePath={config.workspacePath}
          selectedProject={selectedProject}
          onSelectProject={project => { setSelectedProject(project); setProjectDestination(project.path); setProjectOperation(null); setActiveTab('project'); }}
          onProjectAction={handleProjectAction}
          onWorkspaceResolved={workspacePath => { if (workspacePath !== config.workspacePath) handleConfigUpdate({ ...config, workspacePath }); }}

        />
        <div className="p-4 border-t border-slate-200">
          <div className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
            <button onClick={() => setShowSettings(true)} className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition-all group"><Settings size={18} className="text-slate-400"/><span className="font-medium text-sm">设置</span></button>
            <button
              onClick={() => setShowAbout(true)}
              className="w-full flex items-center gap-3 border-t border-slate-200 p-3 hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition-all group"
            >
              <AtSign size={18} className="group-hover:rotate-90 transition-transform duration-500 text-slate-400" />
              <span className="font-medium text-sm">关于</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-slate-50 p-8 relative">
        {activeTab === 'home' && <div className="mx-auto max-w-6xl space-y-4">{homeOrder.map(card => {
          const content = card === 'birthday'
            ? <DashboardView section="birthday" workspacePath={config.workspacePath} config={config.smartImport} onUpdateConfig={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })}/>
            : card === 'import'
              ? <DashboardView section="import" workspacePath={config.workspacePath} config={config.smartImport} onImportComplete={handleHomeImportComplete} onUpdateConfig={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })}/>
              : card === 'research'
                ? <HomePanel title="调研整理"><ResearchView embedded config={config.research} onUpdateConfig={(research: AppConfig['research']) => handleConfigUpdate({ ...config, research })}/></HomePanel>
                : <HomePanel title="PNG 转 JPG"><ConverterView embedded /></HomePanel>;
          return <div key={card} draggable onDragStart={() => setDraggedHomeCard(card)} onDragEnd={() => setDraggedHomeCard(null)} onDragOver={event => event.preventDefault()} onDrop={() => { reorderHomeCards(card); setDraggedHomeCard(null); }} className={draggedHomeCard === card ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'}>{content}</div>;
        })}</div>}
        {activeTab === 'project' && selectedProject && <ProjectWorkspace project={selectedProject} workspacePath={config.workspacePath} initialPanel={projectOperation} importConfig={config.smartImport} brollConfig={config.brollImport} matchConfig={config.smartMatch} onMatchConfigChange={(smartMatch: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch })} onProjectMoved={nextProject => { setSelectedProject(nextProject); setProjectDestination(nextProject.path); window.dispatchEvent(new Event('workspace-projects-changed')); }} onDeleted={() => { setSelectedProject(null); setProjectDestination(null); setProjectOperation(null); setActiveTab('home'); window.dispatchEvent(new Event('workspace-projects-changed')); }} />}

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
            <MatchView config={config.smartMatch} projectPath={selectedProject?.path} onUpdateConfig={(newConfig: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch: newConfig })} />
          </RequirePlugin>
        )}

        {activeTab === 'rename_tool' && (
          <RequirePlugin scriptName="rename.py" title="对比图片" desc="需要该引擎进行 pHash 视觉图像指纹比对。">
            <RenameView />
          </RequirePlugin>
        )}

        {activeTab === 'video_split' && (
          <RequirePlugin scriptName="cut_video.py" title="视频切割" desc="需要调用底层引擎进行极速无损视频切割。">
            <VideoSplitView />
          </RequirePlugin>
        )}
      </main>
    </div>
  );
};

// --- 主功能 ---
const ImportCard = ({ config, drives = [], destinationPath, onImportComplete }: { config?: AppConfig['smartImport'], drives?: string[], destinationPath?: string | null, onImportComplete?: () => void }) => {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready_to_import' | 'importing' | 'decision' | 'processing' | 'finished'>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("等待连接...");
  const [decisionData, setDecisionData] = useState<any>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // 【关键修改】使用 Ref 来做“防抖”锁，防止 SD 卡接触不良导致多次触发 startImport
  const isBusyRef = React.useRef(false);
  const onImportCompleteRef = React.useRef(onImportComplete);
  useEffect(() => { onImportCompleteRef.current = onImportComplete; }, [onImportComplete]);

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
          onImportCompleteRef.current?.();
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
    if (!destinationPath) {
      setStatusMsg('无法确定导入项目，请先设置工作目录。');
      return;
    }
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
      args.push('--dest_path', destinationPath || '');
      if (config.generateVideoPreview) {
        args.push('--generate_video_preview');
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
      args.push('--dest_path', destinationPath || '');
      if (config.generateVideoPreview) {
        args.push('--generate_video_preview');
      }
      // 添加用户决定的参数
      args.push('--should_split', split ? 'true' : 'false');
    }

    // 重新启动导入流程（因为临时文件已经存在，所以会很快）
    runCmd('import', args);
  };

  // --- 渲染逻辑 (UI 部分) ---

  if (status === 'idle' || status === 'checking') {
    // 实时判断当前配置的盘符是否插在电脑上
    const isConnected = config?.sdPath && drives.includes(config.sdPath);

    // 动态判断显示的副标题
    let displayMsg = statusMsg;
    if (status === 'idle') {
      if (!config?.sdPath) {
        displayMsg = "请先在下方设置中选择 SD 卡盘符";
      } else if (isConnected) {
        // 👇 这里的文案改成了“点击右侧按钮导入”
        displayMsg = `已连接 ${config?.sdPath}，点击右侧按钮导入`;
      } else {
        displayMsg = `等待 ${config?.sdPath} 接入...`;
      }
    } else if (status === 'checking') {
      displayMsg = `正在准备读取 ${config?.sdPath}...`;
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

        {/* 👇 动态切换右侧按钮 */}
        {isConnected && status === 'idle' ? (
          <button
            onClick={startImport} // 直接调用导入，无需再 check
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold flex items-center gap-2 shadow-md shadow-blue-500/20 transition-all animate-in zoom-in-95"
          >
            <Download size={16} />
            开始导入
          </button>
        ) : (
          <button
            disabled
            className={`p-2 rounded-lg transition ${
              status === 'checking'
                ? 'text-blue-500'
                : 'text-slate-300 bg-slate-50 cursor-not-allowed'
            }`}
          >
            <RotateCcw size={18} className={status === 'checking' ? 'animate-spin' : ''} />
          </button>
        )}
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
      <TaskStatus logs={logs} />
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
  workspacePath,
  section = 'all',
  config,
  projectDestination,
  projectName,
  onImportComplete,
  onUpdateConfig
}: {
  workspacePath: string;
  section?: 'all' | 'import' | 'birthday';
  config: AppConfig['smartImport'];
  projectDestination?: string | null;
  projectName?: string;
  onImportComplete?: () => void | Promise<void>;
  onUpdateConfig: (c: AppConfig['smartImport']) => void;
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

      {section !== 'birthday' && <HomePanel title="从 SD 卡导入" initiallyOpen>
        <div className="flex flex-col gap-6">
          <ImportCard config={config} drives={drives} destinationPath={projectDestination ?? workspacePath} onImportComplete={projectDestination ? undefined : () => { void onImportComplete?.(); }} />
        </div>
      </HomePanel>}
      {section !== 'import' && <HomePanel title="角色生日" initiallyOpen tone="birthday">
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

const HomePanel = ({ title, initiallyOpen = false, tone, children }: { title: string; initiallyOpen?: boolean; tone?: 'birthday'; children: React.ReactNode }) => {
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
  return <section className={`rounded-xl overflow-hidden ${isBirthday ? 'birthday-panel' : 'border border-slate-200 bg-white'}`}><button onClick={() => setOpen(value => !value)} className={`flex w-full items-center justify-between px-5 py-4 text-left ${isBirthday ? 'birthday-panel-header' : ''}`}><span className={`text-base font-bold ${isBirthday ? 'birthday-panel-title' : 'text-slate-800'}`}>{title}</span><span className={isBirthday ? 'birthday-panel-icon' : 'text-slate-400'}>{open ? <ChevronUp size={18}/> : <ChevronDown size={18}/>}</span></button>{open && <div className={`border-t p-5 animate-in slide-in-from-top-1 duration-200 ${isBirthday ? 'birthday-panel-body' : 'border-slate-100'}`}>{children}</div>}</section>;
};

const ConverterView = ({ embedded = false }: { embedded?: boolean }) => {
  const [targetPath, setTargetPath] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [quality, setQuality] = useState(100);

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

      <TaskStatus logs={logs} />
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
        '--threshold', config.ssimThreshold.toString(),
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

        <TaskStatus logs={logs} />
      </div>
    </div>
  );
};

const MatchView = ({
        embedded = false,
        config,
        projectPath,
        onUpdateConfig: _onUpdateConfig
    }: {
        embedded?: boolean;
        config: AppConfig['smartMatch'];
        projectPath?: string;
        onUpdateConfig: (newMatchConfig: AppConfig['smartMatch']) => void;
    }) => {
    const [keywords, setKeywords] = useState("");
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isRunning, setIsRunning] = useState(false);

    useEffect(() => {
        if (!window.electronAPI?.onPythonEvent) return;
        const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
            if (event.type === 'log' || event.type === 'error' || event.type === 'success') {
                setLogs(prev => [...prev, { timestamp: new Date().toLocaleTimeString(), message: event.message, type: event.type as any }]);
                if (event.type === 'success' || event.type === 'error') setIsRunning(false);
            }
        });
        return cleanup;
    }, []);

    const runTask = () => {
        if (!projectPath || !keywords.trim() || isRunning) return;
        setIsRunning(true);
        setLogs([]);
        window.electronAPI.runScript('catch.py', [
            '--source', projectPath,
            '--image_dest_name', config.imageDestFolderName,
            '--video_dest_name', config.videoDestFolderName,
            '--keywords', ...keywords.trim().split(/\s+/)
        ]);
    };

    return (
        <div className="w-full space-y-6">
            {!embedded && <h2 className="text-2xl font-bold text-slate-800">选片</h2>}
            <div className={embedded ? 'space-y-6' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-6'}>
                <p className="text-gray-600">默认先在当前项目的 RAW 文件夹查找，未找到的文件名再到 MOV 文件夹查找。</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-700">图片存放到：<strong>{config.imageDestFolderName}</strong></div>
                    <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-700">视频存放到：<strong>{config.videoDestFolderName}</strong></div>
                </div>
                <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-500 uppercase">文件名</label>
                    <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="文件名需要用空格分开，一个空格分开一个文件名" className="w-full h-24 bg-slate-50 border border-slate-200 rounded-lg p-4 text-slate-900 focus:outline-none focus:border-blue-500 transition-colors font-mono text-sm resize-none"/>
                </div>
                <div className="flex justify-end">
                    <button onClick={runTask} disabled={isRunning || !projectPath || !keywords.trim()} className={`px-8 py-2.5 rounded-lg font-bold transition flex items-center gap-2 ${isRunning || !projectPath || !keywords.trim() ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed shadow-none' : 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20'}`}>
                        {isRunning ? <Loader2 className="animate-spin" size={18}/> : <ScanSearch size={18}/>}
                        {isRunning ? '复制中...' : '开始选片'}
                    </button>
                </div>
            </div>
            <TaskStatus logs={logs}/>
        </div>
    );
};
const RenameView = ({ embedded = false, folderOptions = [] }: { embedded?: boolean; folderOptions?: Array<{ name: string; path: string }> }) => {
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
            {!embedded && <h2 className="text-2xl font-bold text-slate-800">对比图片</h2>}

            <div className="bg-white border border-slate-200 rounded-xl p-6 relative overflow-hidden">
                <div className="space-y-2">
                  <p className="mt-2 text-gray-600">通常用于团片后期中。每一个人后期之后文件名会乱序，为了方便整理和溯源，这个组件可以把类似的图片重命名到初始版本。</p>
                </div>
                <div className="absolute top-0 left-1/2 -translate-x-1/2 p-32 bg-indigo-500/5 blur-3xl rounded-full pointer-events-none"></div>

                <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-4 md:gap-8">

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
                        <FolderInput size={14}/> 对比图片（对照组 A）
                    </label>
                    <input
                        type="text" list="compare-folder-a" value={folderA}
                        onChange={(e) => setFolderA(e.target.value)}
                        onDrop={(e) => handleDrop(e, setFolderA)}
                        onDragOver={allowDrag}
                        placeholder="拖入摄影师发给客户的原图文件夹..."
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm font-mono"
                    />
                    <datalist id="compare-folder-a">{folderOptions.map(folder => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</datalist>
                    <p className="text-xs text-slate-500">选择对照图片所在的项目文件夹（对照组 A）。</p>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col gap-3">
                    <label className="text-xs font-semibold text-green-400 uppercase flex items-center gap-2">
                        <Edit size={14}/> 最新图片（对照组 B）
                    </label>
                    <input
                        type="text" list="compare-folder-b" value={folderB}
                        onChange={(e) => setFolderB(e.target.value)}
                        onDrop={(e) => handleDrop(e, setFolderB)}
                        onDragOver={allowDrag}
                        placeholder="拖入客户发回来的乱序文件夹..."
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-sm font-mono"
                    />
                    <datalist id="compare-folder-b">{folderOptions.map(folder => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</datalist>
                    <p className="text-xs text-slate-500">选择最新图片所在的项目文件夹（对照组 B）。</p>
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
                        {isRunning ? '对比中...' : '开始对比'}
                    </button>
                </div>
            </div>
            <TaskStatus logs={logs} />
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

      <TaskStatus logs={logs} />
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

const SettingsModal = ({ config, onSave, onClose, requireWorkspace = false }: { config: AppConfig; onSave: (config: AppConfig) => void | Promise<void>; onClose: () => void; requireWorkspace?: boolean }) => {
  const [draft, setDraft] = useState(config);
  const [drives, setDrives] = useState<string[]>([]);
  useEffect(() => { window.electronAPI?.getDrives?.().then(setDrives); }, []);
  const updateImport = (changes: Partial<AppConfig['smartImport']>) => setDraft(current => ({ ...current, smartImport: { ...current.smartImport, ...changes } }));
  const updateBroll = (changes: Partial<AppConfig['brollImport']>) => setDraft(current => ({ ...current, brollImport: { ...current.brollImport, ...changes } }));
  const updateMatch = (changes: Partial<AppConfig['smartMatch']>) => setDraft(current => ({ ...current, smartMatch: { ...current.smartMatch, ...changes } }));
  const save = async () => { const workspacePath = draft.workspacePath.trim(); if (!workspacePath) return; await onSave({ ...draft, workspacePath }); if (!requireWorkspace) onClose(); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"><div className="absolute inset-0" onClick={requireWorkspace ? undefined : onClose}/><div className="relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"><div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 p-5"><h3 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Settings size={20} className="text-blue-600"/>{requireWorkspace ? '设置工作目录' : '设置'}</h3>{requireWorkspace && <p className="mt-1 text-sm text-slate-500">首次使用前，请先选择一个用于存放项目的工作目录。</p>}{!requireWorkspace && <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-200"><X size={20}/></button>}</div><div className="min-h-0 flex-1 space-y-7 overflow-y-auto p-6"><section><h4 className="text-sm font-bold text-slate-800">界面配色</h4><p className="mt-1 text-sm text-slate-500">默认适应系统，也可固定为浅色或深色。</p><div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => setDraft(current => ({ ...current, theme }))} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">工作目录</h4><p className="mt-1 text-sm text-slate-500">选择磁盘根目录时，会使用根目录下的“照片流”文件夹。</p><input value={draft.workspacePath} onChange={event => setDraft(current => ({ ...current, workspacePath: event.target.value }))} placeholder="例如：D:/照片流" className="mt-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-800 focus:border-blue-500 focus:outline-none"/></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">从 SD 卡导入</h4><p className="mt-1 text-sm text-slate-500">导入位置由当前项目或工作目录决定。</p><p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-700">支持佳能（.cr2、.cr3）、索尼（.arw）、尼康（.nef）、奥林巴斯（.orf）、徕卡（.rwl、.dng）、富士（.raf）、哈苏（.3fr、.fff）、大疆（.dng）的 RAW 格式，以及常见图片和视频导入。</p><label className="settings-check"><input type="checkbox" checked={draft.smartImport.autoStart} onChange={event => updateImport({ autoStart: event.target.checked })}/>应用启动时自动读取 SD 卡</label><label className="form-label">SD 卡盘符</label><select value={draft.smartImport.sdPath} onChange={event => updateImport({ sdPath: event.target.value })} className="form-input">{draft.smartImport.sdPath && !drives.includes(draft.smartImport.sdPath) && <option value={draft.smartImport.sdPath}>{draft.smartImport.sdPath}（当前未连接）</option>}<option value="">请选择设备盘符</option>{drives.map(drive => <option key={drive} value={drive}>{drive}</option>)}</select><label className="settings-check"><input type="checkbox" checked={draft.smartImport.generateVideoPreview} onChange={event => updateImport({ generateVideoPreview: event.target.checked })}/>生成视频预览（储存至 mov_压缩）</label></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">导入花絮</h4><p className="mt-1 text-sm text-slate-500">文件会复制到当前项目的“花絮”文件夹。</p><label className="settings-check"><input type="checkbox" checked={draft.brollImport.splitLargeFiles} onChange={event => updateBroll({ splitLargeFiles: event.target.checked })}/>超过 4GB 的单个视频自动分割为约 4GB 的文件</label><label className="settings-check"><input type="checkbox" checked={draft.brollImport.clearSource} onChange={event => updateBroll({ clearSource: event.target.checked })}/>导入后清空原始文件</label></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">{"\u9009\u7247"}</h4><p className="mt-1 text-sm text-slate-500">{"\u6311\u9009\u51fa\u7684\u56fe\u7247\u548c\u89c6\u9891\u4f1a\u5206\u522b\u5b58\u653e\u5230\u5f53\u524d\u9879\u76ee\u4e2d\u7684\u4ee5\u4e0b\u6587\u4ef6\u5939\u3002"}</p><label className="form-label">{"\u56fe\u7247\u9009\u7247\u6587\u4ef6\u5939\u540d\u79f0"}</label><input value={draft.smartMatch.imageDestFolderName} onChange={event => updateMatch({ imageDestFolderName: event.target.value })} placeholder={"\u56fe\u7247\u9009\u7247"} className="form-input"/><label className="form-label">{"\u89c6\u9891\u9009\u7247\u6587\u4ef6\u5939\u540d\u79f0"}</label><input value={draft.smartMatch.videoDestFolderName} onChange={event => updateMatch({ videoDestFolderName: event.target.value })} placeholder={"\u89c6\u9891\u9009\u7247"} className="form-input"/></section></div><div className="flex justify-end gap-3 border-t border-slate-100 bg-white p-5">{!requireWorkspace && <button onClick={onClose} className="dialog-secondary">取消</button>}<button onClick={save} disabled={!draft.workspacePath.trim()} className="dialog-primary">{requireWorkspace ? '确认工作目录' : '保存设置'}</button></div></div></div>;
};
type ProjectPanel = 'import' | 'broll' | 'match' | 'compare' | 'create' | 'trash' | null;
const PROJECT_STATUSES: Array<WorkspaceProject['status']> = ['未策划', '已策划', '进行中', '已归档'];

const ProjectWorkspace = ({ project, workspacePath, initialPanel, importConfig, brollConfig, matchConfig, onMatchConfigChange, onProjectMoved, onDeleted }: {
  project: WorkspaceProject;
  workspacePath: string;
  initialPanel: 'import' | 'broll' | 'match' | null;
  importConfig: AppConfig['smartImport'];
  brollConfig: AppConfig['brollImport'];
  matchConfig: AppConfig['smartMatch'];
  onMatchConfigChange: (config: AppConfig['smartMatch']) => void;
  onProjectMoved: (project: WorkspaceProject) => void;
  onDeleted: () => void;
}) => {
  const [folders, setFolders] = useState<Array<{ name: string; path: string; updatedAt: number }>>([]);
  const [panel, setPanel] = useState<ProjectPanel>(initialPanel);
  const [message, setMessage] = useState('');
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [folderMenu, setFolderMenu] = useState<{ folder: { name: string; path: string; updatedAt: number }; x: number; y: number } | null>(null);
  const [renameFolder, setRenameFolder] = useState<{ name: string; path: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [progressName, setProgressName] = useState('');

  const refresh = async () => {
    const result = await window.electronAPI.getProjectContents(workspacePath, project.status, project.name);
    if (result.success) setFolders(result.folders);
    else setMessage(result.error || '无法读取项目文件夹');
  };

  useEffect(() => {
    setPanel(initialPanel);
    setMessage('');
    refresh();
  }, [project.path, project.status, initialPanel]);
  useEffect(() => window.electronAPI.onWorkspaceFilesChanged(() => refresh()), [workspacePath, project.path]);
  useEffect(() => {
    const closeMenus = () => { setFolderMenu(null); setShowStatusMenu(false); };
    window.addEventListener('click', closeMenus);
    return () => window.removeEventListener('click', closeMenus);
  }, []);

  const togglePanel = (next: Exclude<ProjectPanel, null>) => setPanel(current => current === next ? null : next);
  const openFolder = async (folderName?: string) => {
    const result = await window.electronAPI.openWorkspaceProject(workspacePath, project.status, project.name, folderName);
    if (!result.success) setMessage(result.error || '无法打开文件夹');
  };
  const moveStatus = async (status: WorkspaceProject['status']) => {
    setShowStatusMenu(false);
    if (status === project.status) return;
    const result = await window.electronAPI.moveWorkspaceProject(workspacePath, project.status, project.name, status);
    if (!result.success || !result.project) { setMessage(result.error || '更改状态失败'); return; }
    onProjectMoved(result.project);
  };
  const importBroll = async () => {
    setMessage('正在选择花絮文件…');
    const result = await window.electronAPI.importBroll(workspacePath, project.status, project.name, brollConfig);
    if (!result.success) { setMessage(result.error || '导入花絮失败'); return; }
    if (result.cancelled) { setMessage('已取消选择花絮文件。'); return; }
    setMessage(`已导入 ${result.count || 0} 个花絮文件。`);
    refresh();
  };
  const markInProgress = async () => {
    if (project.status === '进行中') return;
    const result = await window.electronAPI.moveWorkspaceProject(workspacePath, project.status, project.name, '进行中');
    if (!result.success || !result.project) { setMessage(result.error || '项目状态更新失败'); return; }
    setMessage('导入完成，项目已移入“进行中”。');
    onProjectMoved(result.project);
  };
  const createProgress = async () => {
    const name = progressName.trim();
    if (!name) return;
    const result = await window.electronAPI.createProjectFolder(workspacePath, project.status, project.name, name);
    if (!result.success) { setMessage(result.error || '创建进度文件夹失败'); return; }
    setMessage(`已创建进度文件夹“${result.folder?.name || name}”。`);
    setProgressName('');
    setPanel(null);
    refresh();
  };
  const renameProjectFolder = async () => {
    if (!renameFolder || !renameValue.trim()) return;
    const result = await window.electronAPI.renameProjectFolder(workspacePath, project.status, project.name, renameFolder.name, renameValue.trim());
    if (!result.success) { setMessage(result.error || '重命名文件夹失败'); return; }
    setMessage(`已将“${renameFolder.name}”重命名为“${result.folder?.name || renameValue.trim()}”。按 Ctrl+Z 可撤销。`);
    setRenameFolder(null);
    setRenameValue('');
    refresh();
  };
  const moveToTrash = async () => {
    const result = await window.electronAPI.trashWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) { setMessage(result.error || '移入回收站失败'); return; }
    onDeleted();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-bold text-slate-800">{project.name}</h2>
          <div className="relative" onClick={event => event.stopPropagation()}>
            <button onClick={() => setShowStatusMenu(value => !value)} className="flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-600 hover:bg-blue-100">{project.status} <ChevronDown size={14}/></button>
            {showStatusMenu && <div className="absolute left-0 top-full z-30 mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{PROJECT_STATUSES.map(status => <button key={status} onClick={() => moveStatus(status)} className={`project-menu-item ${status === project.status ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{status}{status === project.status ? '（当前）' : ''}</button>)}</div>}
          </div>
        </div>
        <button onClick={() => openFolder()} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><ExternalLink size={16}/>打开项目文件夹</button>
      </div>

      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap gap-3">
          <button onClick={() => togglePanel('import')} className="project-action-button"><Download size={16}/>从 SD 卡导入</button>
          <button onClick={() => togglePanel('broll')} className="project-action-button"><Video size={16}/>导入花絮</button>
          <button onClick={() => togglePanel('match')} className="project-action-button"><ScanSearch size={16}/>选片</button>
          <button onClick={() => togglePanel('trash')} className="project-action-button project-action-danger"><Trash2 size={16}/>移入回收站</button>
        </div>
        <div className="flex flex-wrap gap-3 border-t border-slate-100 pt-3">
          <button onClick={() => togglePanel('create')} className="project-action-button"><FolderPlus size={16}/>创建进度</button>
          <button onClick={() => togglePanel('compare')} className="project-action-button"><FileDiff size={16}/>对比图片</button>
        </div>
      </div>

      {message && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">{message}</div>}
      {panel === 'import' && <CollapsiblePanel title="从 SD 卡导入" onClose={() => setPanel(null)}><p className="mb-4 text-sm text-slate-500">导入的文件会直接整理到当前项目“{project.name}”中。</p><ImportCard config={importConfig} destinationPath={project.path} onImportComplete={markInProgress}/></CollapsiblePanel>}
      {panel === 'broll' && <CollapsiblePanel title="导入花絮" onClose={() => setPanel(null)}><p className="text-sm text-slate-500">选择要保留的花絮媒体，软件会复制到当前项目的“花絮”文件夹。</p><button onClick={importBroll} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">选择花絮文件</button></CollapsiblePanel>}
      {panel === 'match' && <CollapsiblePanel title="选片" onClose={() => setPanel(null)}><MatchView embedded config={matchConfig} projectPath={project.path} onUpdateConfig={onMatchConfigChange}/></CollapsiblePanel>}
      {panel === 'create' && <div className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/40 p-4"><div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-4 flex items-center justify-between"><h3 className="font-bold text-slate-800">创建进度</h3><button onClick={() => { setPanel(null); setProgressName(''); }}><X size={18}/></button></div><p className="mb-3 text-sm text-slate-500">输入进度名称后，会在当前项目中新建同名文件夹。</p><input autoFocus value={progressName} onChange={event => setProgressName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') createProgress(); }} placeholder="例如：初修、精修、交付" className="form-input"/><div className="mt-4 flex justify-end gap-2"><button onClick={() => { setPanel(null); setProgressName(''); }} className="dialog-secondary">取消</button><button onClick={createProgress} disabled={!progressName.trim()} className="dialog-primary">创建文件夹</button></div></div></div>}
      {panel === 'compare' && <CollapsiblePanel title="对比图片" onClose={() => setPanel(null)}><RenameView embedded folderOptions={folders}/></CollapsiblePanel>}
      {panel === 'trash' && <CollapsiblePanel title="移入回收站" onClose={() => setPanel(null)}><p className="text-sm text-slate-500">项目“{project.name}”及其全部内容将移入系统回收站。</p><button onClick={moveToTrash} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">确认移入回收站</button></CollapsiblePanel>}

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-slate-800">项目文件夹</h3><span className="text-sm text-slate-500">{folders.length} 个</span></div>
        {folders.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{folders.map(folder => <button key={folder.path} onClick={() => openFolder(folder.name)} onContextMenu={event => { event.preventDefault(); setFolderMenu({ folder, x: event.clientX, y: event.clientY }); }} title={`打开 ${folder.name}`} className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-blue-50"><Folder size={64} strokeWidth={1.5} fill="currentColor" className="text-blue-500 drop-shadow-sm transition-transform group-hover:scale-105"/><span className="max-w-full truncate text-sm font-medium text-slate-700">{folder.name}</span></button>)}</div> : <p className="py-8 text-center text-sm text-slate-400">当前项目还没有子文件夹。</p>}
      </section>

      {folderMenu && <div className="fixed z-[300] w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-xl" style={{ left: Math.min(folderMenu.x, window.innerWidth - 160), top: Math.min(folderMenu.y, window.innerHeight - 100) }} onClick={event => event.stopPropagation()}><button className="project-menu-item" onClick={() => { setRenameFolder(folderMenu.folder); setRenameValue(folderMenu.folder.name); setFolderMenu(null); }}>重命名</button></div>}
      {renameFolder && <div className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/40 p-4"><div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-4 flex items-center justify-between"><h3 className="font-bold text-slate-800">重命名文件夹</h3><button onClick={() => setRenameFolder(null)}><X size={18}/></button></div><input autoFocus value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') renameProjectFolder(); }} className="form-input"/><div className="mt-4 flex justify-end gap-2"><button onClick={() => setRenameFolder(null)} className="dialog-secondary">取消</button><button onClick={renameProjectFolder} disabled={!renameValue.trim() || renameValue.trim() === renameFolder.name} className="dialog-primary">确认重命名</button></div></div></div>}
    </div>
  );
};
const CollapsiblePanel = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => (
  <section className="rounded-xl border border-slate-200 bg-white p-6 animate-in slide-in-from-top-2 duration-200">
    <div className="mb-5 flex items-center justify-between border-b border-slate-100 pb-4"><h3 className="text-lg font-bold text-slate-800">{title}</h3><button onClick={onClose} className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-50">收起 <ChevronUp size={16}/></button></div>
    {children}
  </section>
);
const AboutModal = ({ onClose }: { onClose: () => void }) => {
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'latest' | 'error'>('idle');
  const checkForUpdates = async () => {
    setUpdateStatus('checking');
    const result = await window.electronAPI.checkForUpdates();
    setUpdateStatus(result.success && !result.updateAvailable ? 'latest' : result.success ? 'idle' : 'error');
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm animate-in fade-in duration-200">
    <div className="absolute inset-0" onClick={onClose}/>
    <section role="dialog" aria-modal="true" aria-labelledby="about-title" className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-6 py-5"><h3 id="about-title" className="flex items-center gap-2 text-xl font-bold text-slate-800"><AtSign size={20} className="text-blue-600"/>关于</h3><button onClick={onClose} aria-label="关闭" className="rounded-full p-2 text-slate-500 transition hover:bg-slate-200 hover:text-slate-800"><X size={20}/></button></header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6 text-sm leading-7 text-slate-600">
        <div><p className="text-lg font-bold text-slate-800">by秋也寻</p><div className="mt-1 flex flex-wrap items-center gap-3"><p className="text-blue-600">版本 26.7.15</p><button onClick={checkForUpdates} disabled={updateStatus === 'checking'} className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-bold leading-5 text-blue-700 transition hover:bg-blue-100 disabled:cursor-wait disabled:opacity-60">{updateStatus === 'checking' ? '正在检查…' : '检查更新'}</button>{updateStatus === 'latest' && <span className="text-xs text-emerald-600">已是最新版本</span>}{updateStatus === 'error' && <span className="text-xs text-red-500">检查失败，请稍后重试</span>}</div></div>
        <section><h4 className="text-base font-bold text-slate-800">软件简介</h4><p className="mt-1">照片流是一款为摄影师设计的项目管理与素材整理工具，帮助你跟进拍摄进度，并自动从 SD 卡导入和整理照片、视频。</p></section>
        <section><h4 className="text-base font-bold text-slate-800">功能说明</h4><p className="mt-1">调研整理功能可配合脚本整理下载的图片与视频、截取视频帧，并汇总调研资料信息。<br/>团片管理功能可将高像素大图裁切为便于修图的小图，后续再拼接回完整大图；也支持对比、对比图片并交接给下一位修图人员。</p></section>
        <section><h4 className="text-base font-bold text-slate-800">制作说明</h4><p className="mt-1">早期版本的大部分代码由 Google Gemini 与 Copilot 生成；当前版本主要使用 Codex 制作。</p></section>
        <section className="border-t border-slate-200 pt-5"><h4 className="text-base font-bold text-slate-800">使用提示</h4><p className="mt-1">软件尚未经过充分测试。使用前请备份重要数据；作者不对使用本软件造成的损失负责。</p></section>
      </div>
    </section>
  </div>;
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