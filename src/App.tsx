import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  FolderInput,
  FolderPlus,
  Folder,
  Image as ImageIcon,
  ScanSearch,
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
  ChevronUp,
  File,
  FileImage,
  RefreshCw,
  Eraser,
  MemoryStick,
  LayoutList,
  Grid2X2,
  FileText,
  Copy,
  Scissors as Cut,
  ClipboardPaste,
  CheckSquare,
  ArrowLeft,
  ArrowRight
} from 'lucide-react';
import { TaskProgress } from './components/TaskStatus';
import { ProjectNavigator } from './components/ProjectNavigator';
import { PROJECT_STATUS_LABELS } from './types';
import type { AppConfig, HomeCardId, LogEntry, ProjectFileEntry, ProjectFileOperationProgress, ToolType, WorkspaceProject } from './types';

const DEFAULT_HOME_ORDER: HomeCardId[] = ['birthday', 'import', 'research', 'converter'];
const IMAGE_SELECTION_FOLDER_NAME = '图片选片';
const VIDEO_SELECTION_FOLDER_NAME = '视频选片';

// Native thumbnail creation can be expensive for camera files. Limit requests
// from the scrolling grid so a large folder never floods the main process.
const thumbnailQueue: Array<() => void> = [];
let activeThumbnailRequests = 0;
const requestThumbnail = <T,>(task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
  const run = () => {
    activeThumbnailRequests += 1;
    task().then(resolve, reject).finally(() => {
      activeThumbnailRequests -= 1;
      thumbnailQueue.shift()?.();
    });
  };
  if (activeThumbnailRequests < 3) run();
  else thumbnailQueue.push(run);
});

// --- 类型定义 ---

const isMac = window.navigator.userAgent.includes('Mac');

const DEFAULT_CONFIG = (userPath: string): AppConfig => ({
  theme: 'system',
  workspacePath: '',
  homeOrder: DEFAULT_HOME_ORDER,
  mediaCache: {
    maxSizeGB: 10,
    directory: ''
  },
  smartImport: {
    autoStart: false,
    sdPath: isMac ? "/Volumes" : "H:/DCIM",
    destPath: `${userPath}/Desktop`,
    backupEnabled: false,
    generateVideoPreview: false,
    splitLargeFiles: false,
    backupPath: isMac ? `${userPath}/Pictures/Backup` : "D:/Backup"
  },
  brollImport: {
    splitLargeFiles: false,
    clearSource: true
  },
  imageConversion: {
    jpgQuality: 100
  },
  smartMatch: {
    imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME,
    videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME,
    imageSourceFolderName: 'raw',
    videoSourceFolderName: 'mov'
  },
  research: {
    defaultDir: `${userPath}/Downloads`,
    sensitivity: 'standard',
    minDuration: 0.2
  }
});

interface PythonEvent {
  type: 'log' | 'error' | 'progress' | 'status' | 'ask_user' | 'success' | 'warning';
  message: string;
  data?: any;
  progress?: number;
  scriptName?: string;
}

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message || '界面渲染失败' }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    window.electronAPI?.reportRendererError?.('React 界面渲染失败', `${error.stack || error.message}\n${info.componentStack}`);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="flex h-screen w-full items-center justify-center bg-slate-50 p-6 text-slate-900"><div className="w-full max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-xl"><h1 className="text-lg font-bold text-red-600">界面遇到错误</h1><p className="mt-2 break-words text-sm text-slate-600">{this.state.error}</p><p className="mt-2 text-xs text-slate-500">错误详情已写入应用日志。你可以重新载入界面，未完成的后台文件操作不会被强制中断。</p><button type="button" onClick={() => window.location.reload()} className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">重新载入</button></div></div>;
  }
}

const RequirePlugin = ({ scriptName, title, desc, children, embedded = false }: { scriptName: string, title: string, desc: string, children: React.ReactNode, embedded?: boolean }) => {
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      // 如果后端提供了 checkScript 方法，则调用它检测文件是否存在
      if (window.electronAPI && 'checkScript' in window.electronAPI) {
        try {
          // @ts-ignore
          const exists = await window.electronAPI.checkScript(scriptName);
          setIsInstalled(exists);
        } catch {
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
        {!embedded && <h2 className="text-2xl font-bold text-slate-800">{title}</h2>}
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
  const [, setProjectDestination] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState('');
  const [fileOperationProgress, setFileOperationProgress] = useState<ProjectFileOperationProgress | null>(null);
  const [isCancellingFileOperation, setIsCancellingFileOperation] = useState(false);
  const noticeTimerRef = useRef<number>();
  const lastNoticeRef = useRef({ message: '', shownAt: 0 });
  const [homeOrder, setHomeOrder] = useState<HomeCardId[]>(DEFAULT_HOME_ORDER);
  const [draggedHomeCard, setDraggedHomeCard] = useState<HomeCardId | null>(null);
  const [projectOperation, setProjectOperation] = useState<'import' | 'broll' | 'match' | null>(null);

  const showNotice = useCallback((message: string, duration = 3500) => {
    const cleanMessage = message.trim() || '发生未知错误';
    const isFailure = /失败|错误|异常|无法/.test(cleanMessage);
    const now = Date.now();
    if (lastNoticeRef.current.message === cleanMessage && now - lastNoticeRef.current.shownAt < 800) return;
    lastNoticeRef.current = { message: cleanMessage, shownAt: now };
    setUndoNotice(cleanMessage);
    window.clearTimeout(noticeTimerRef.current);
    if (!isFailure) noticeTimerRef.current = window.setTimeout(() => setUndoNotice(''), duration);
  }, []);

  useEffect(() => {
    const report = (message: string, details?: string) => {
      showNotice(`发生错误：${message}`, 5000);
      window.electronAPI?.reportRendererError?.(message, details);
    };
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => {
      originalConsoleError(...values);
      const message = values.map(value => value instanceof Error ? value.message : String(value)).join(' ');
      report(message || '界面操作失败', values.map(value => value instanceof Error ? value.stack : String(value)).join('\n'));
    };
    const handleWindowError = (event: ErrorEvent) => report(event.message || '界面运行异常', event.error?.stack);
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      report(reason instanceof Error ? reason.message : String(reason || '异步操作失败'), reason instanceof Error ? reason.stack : undefined);
    };
    const removePythonListener = window.electronAPI?.onPythonEvent?.((event: PythonEvent) => {
      if (event.type === 'error') report(event.message || `${event.scriptName || '后台任务'}执行失败`);
    });
    const removeMainErrorListener = window.electronAPI?.onAppError?.(message => showNotice(`发生错误：${message}`, 5000));
    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      console.error = originalConsoleError;
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      removePythonListener?.();
      removeMainErrorListener?.();
      window.clearTimeout(noticeTimerRef.current);
    };
  }, [showNotice]);

  useEffect(() => window.electronAPI.onProjectFileOperationProgress(progress => {
    if (progress.phase === 'complete' || progress.phase === 'cancelled' || progress.phase === 'failed') {
      setFileOperationProgress(null);
      setIsCancellingFileOperation(false);
      return;
    }
    setFileOperationProgress(progress);
  }), []);

  const cancelFileOperation = async () => {
    if (!fileOperationProgress || isCancellingFileOperation || fileOperationProgress.phase === 'finishing') return;
    setIsCancellingFileOperation(true);
    const result = await window.electronAPI.cancelProjectFileOperation(fileOperationProgress.operationId);
    if (!result.success) {
      setIsCancellingFileOperation(false);
      showNotice(`取消粘贴失败：${result.error || '无法取消粘贴'}`);
    }
  };

  useEffect(() => {
    const loadConfig = async () => {
      try {
        if (window.electronAPI?.loadConfig) {
          const fileConfig = await window.electronAPI.loadConfig();
          if (fileConfig) {
            const userPath = await window.electronAPI.getUserPath();
            const downloadPath = userPath ? `${userPath}/Downloads` : fileConfig.research?.defaultDir;
            const legacyThreshold = fileConfig.research?.ssimThreshold;
            const researchSensitivity = fileConfig.research?.sensitivity ?? (legacyThreshold !== undefined && legacyThreshold >= 0.98 ? 'high' : legacyThreshold !== undefined && legacyThreshold <= 0.85 ? 'low' : 'standard');
            const configuredImageSource = fileConfig.smartMatch?.imageSourceFolderName;
            const configuredVideoSource = fileConfig.smartMatch?.videoSourceFolderName;
            let normalizedConfig = { ...fileConfig, theme: fileConfig.theme ?? 'system', workspacePath: fileConfig.workspacePath?.trim() ?? '', homeOrder: Array.isArray(fileConfig.homeOrder) ? fileConfig.homeOrder : DEFAULT_HOME_ORDER, mediaCache: { maxSizeGB: fileConfig.mediaCache?.maxSizeGB ?? 10, directory: fileConfig.mediaCache?.directory ?? '' }, smartImport: { ...fileConfig.smartImport, backupEnabled: false, generateVideoPreview: fileConfig.smartImport?.generateVideoPreview ?? false, splitLargeFiles: fileConfig.smartImport?.splitLargeFiles ?? false }, brollImport: { splitLargeFiles: fileConfig.brollImport?.splitLargeFiles ?? false, clearSource: fileConfig.brollImport?.clearSource ?? true }, imageConversion: { jpgQuality: fileConfig.imageConversion?.jpgQuality ?? 100 }, smartMatch: { imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME, videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME, imageSourceFolderName: !configuredImageSource || configuredImageSource.toLowerCase() === 'raw' ? 'raw' : configuredImageSource, videoSourceFolderName: !configuredVideoSource || configuredVideoSource.toLowerCase() === 'mov' ? 'mov' : configuredVideoSource }, research: { ...fileConfig.research, defaultDir: downloadPath, sensitivity: researchSensitivity, minDuration: fileConfig.research?.minDuration ?? 0.2 } } as AppConfig;
            if (normalizedConfig.workspacePath) {
              const workspace = await window.electronAPI.getWorkspaceProjects(normalizedConfig.workspacePath);
              if (workspace.success && workspace.root) normalizedConfig = { ...normalizedConfig, workspacePath: workspace.root };
            } else {
              setShowWorkspaceSetup(true);
            }
            setConfig(normalizedConfig);
            if ((fileConfig.workspacePath !== normalizedConfig.workspacePath || fileConfig.smartImport.backupEnabled || fileConfig.smartImport?.splitLargeFiles === undefined || !fileConfig.brollImport || !fileConfig.imageConversion || fileConfig.smartMatch?.imageDestFolderName !== IMAGE_SELECTION_FOLDER_NAME || fileConfig.smartMatch?.videoDestFolderName !== VIDEO_SELECTION_FOLDER_NAME || configuredImageSource !== normalizedConfig.smartMatch.imageSourceFolderName || configuredVideoSource !== normalizedConfig.smartMatch.videoSourceFolderName || !fileConfig.research?.sensitivity) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
            console.log('📋 Configuration loaded from file');
          } else {
            if (window.electronAPI?.getUserPath) {
              const userPath = await window.electronAPI.getUserPath();
              if (userPath) {
                const defaultConfig = DEFAULT_CONFIG(userPath);
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
        const fallbackUserPath = await window.electronAPI?.getUserPath?.().catch(() => '') || '';
        setConfig(DEFAULT_CONFIG(fallbackUserPath));
        setShowWorkspaceSetup(true);
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
    const onKeyDown = async (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      const result = await window.electronAPI.undoLastRename();
      showNotice(result.success ? (result.message || '\u5df2\u64a4\u9500\u4e0a\u4e00\u6b21\u91cd\u547d\u540d') : (result.error || '\u6682\u65e0\u53ef\u64a4\u9500\u7684\u91cd\u547d\u540d'));
      if (result.success) {
        if (result.project) {
          setSelectedProject(result.project);
          setProjectDestination(result.project.path);
        }
        window.dispatchEvent(new Event('workspace-projects-changed'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showNotice]);

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
          window.electronAPI.reportRendererError('保存设置失败', result.error);
          showNotice(`保存设置失败：${result.error || '未知错误'}`, 5000);
        }
      }
    } catch (error) {
      window.electronAPI.reportRendererError('保存设置异常', error instanceof Error ? error.stack : String(error));
      showNotice(`保存设置失败：${error instanceof Error ? error.message : String(error)}`, 5000);
    }
  };

  const handleWorkspaceSetup = async (newConfig: AppConfig) => {
    await handleConfigUpdate(newConfig);
    setShowWorkspaceSetup(false);
  };
  const handleHomeImportComplete = async () => {
    if (!config) return;
    const result = await window.electronAPI.archiveImportedProjects(config.workspacePath);
    if (!result.success) { showNotice(`整理导入项目失败：${result.error || '未知错误'}`, 5000); return; }
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
      <div className="flex h-screen w-full items-center justify-center overflow-hidden bg-slate-950 text-white">
        <div className="flex flex-col items-center gap-6 text-center">
          <img src="./app-logo-dark.svg" className="brand-logo brand-logo-dark h-20 w-20" alt="照片流" />
          <div className="space-y-2">
            <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-500 to-indigo-400 bg-clip-text text-transparent">照片流</h2>
            <p className="text-sm text-slate-400">正在启动…</p>
          </div>
          <span className="win11-spinner" aria-label="正在加载" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-slate-50 text-slate-900 font-sans selection:bg-blue-500/30">
      {fileOperationProgress && <div className="fixed left-1/2 top-10 z-[410] w-[min(92vw,460px)] -translate-x-1/2 rounded-xl bg-slate-900 p-4 text-white shadow-2xl animate-in fade-in slide-in-from-top-2">
        <div className="flex items-start gap-3">
          {fileOperationProgress.operation === 'trash' ? <Trash2 size={19} className="mt-0.5 shrink-0 text-red-300"/> : <Loader2 size={19} className="mt-0.5 shrink-0 animate-spin text-blue-300"/>}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3"><p className="text-sm font-bold">{fileOperationProgress.operation === 'trash' ? '正在移入回收站…' : isCancellingFileOperation ? '正在取消粘贴…' : fileOperationProgress.phase === 'scanning' ? '正在准备粘贴…' : fileOperationProgress.phase === 'finishing' ? '正在完成剪切…' : '正在粘贴文件'}</p><span className="font-mono text-xs text-slate-300">{fileOperationProgress.operation === 'trash' && fileOperationProgress.totalCount === 1 ? '处理中' : `${fileOperationProgress.progress}%`}</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/15"><div className={`h-full rounded-full transition-[width] duration-150 ${fileOperationProgress.operation === 'trash' ? 'bg-red-400' : 'bg-blue-400'} ${fileOperationProgress.operation === 'trash' && fileOperationProgress.totalCount === 1 ? 'animate-pulse' : ''}`} style={{ width: fileOperationProgress.operation === 'trash' && fileOperationProgress.totalCount === 1 ? '100%' : `${fileOperationProgress.progress}%` }}/></div>
            <p className="mt-2 truncate text-xs text-slate-300">{fileOperationProgress.currentName || (fileOperationProgress.phase === 'scanning' ? '正在统计文件大小和数量' : '正在处理文件')}{fileOperationProgress.operation === 'trash' && (fileOperationProgress.totalCount || 0) > 1 ? ` · ${fileOperationProgress.processedCount || 0}/${fileOperationProgress.totalCount}` : ''}</p>
          </div>
          {fileOperationProgress.operation === 'paste' && <button type="button" onClick={cancelFileOperation} disabled={isCancellingFileOperation || fileOperationProgress.phase === 'finishing'} className="shrink-0 rounded-md border border-white/20 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45">取消</button>}
        </div>
      </div>}
      {undoNotice && <div className="fixed left-1/2 top-10 z-[400] flex -translate-x-1/2 items-center gap-3 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white shadow-xl animate-in fade-in slide-in-from-top-2"><span>{undoNotice}</span><button onClick={() => setUndoNotice('')} aria-label="关闭提示" className="rounded p-0.5 text-slate-300 hover:bg-white/15 hover:text-white"><X size={15}/></button></div>}

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

      {showAbout && (
        <AboutModal
          onClose={() => setShowAbout(false)}
        />
      )}

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-200">
          <button onClick={() => { setSelectedProject(null); setProjectDestination(null); setActiveTab('home'); }} className="flex items-center gap-2 text-left text-2xl font-bold bg-gradient-to-r from-blue-800 to-indigo-800 bg-clip-text text-transparent cursor-pointer">
            <img src="./app-logo.svg" className="brand-logo brand-logo-light-only h-7 w-7" alt="" />
            <img src="./app-logo-dark.svg" className="brand-logo brand-logo-dark-only h-7 w-7" alt="" />
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
          const dragProps = {
            draggable: true,
            onDragStart: () => setDraggedHomeCard(card),
            onDragEnd: () => setDraggedHomeCard(null),
            onDragOver: (event: React.DragEvent<HTMLButtonElement>) => event.preventDefault(),
            onDrop: (event: React.DragEvent<HTMLButtonElement>) => {
              event.preventDefault();
              reorderHomeCards(card);
              setDraggedHomeCard(null);
            }
          };
          const content = card === 'birthday'
            ? <DashboardView section="birthday" workspacePath={config.workspacePath} config={config.smartImport} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} dragProps={dragProps}/>
            : card === 'import'
              ? <DashboardView section="import" workspacePath={config.workspacePath} config={config.smartImport} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} onImportComplete={handleHomeImportComplete} dragProps={dragProps}/>
              : card === 'research'
                ? <HomePanel title="调研整理" {...dragProps}><RequirePlugin embedded scriptName="research.py" title="调研整理" desc="需要该引擎来执行视频分镜识别和图片去重。"><ResearchView embedded config={config.research} onUpdateConfig={(research: AppConfig['research']) => handleConfigUpdate({ ...config, research })}/></RequirePlugin></HomePanel>
                : <HomePanel title="PNG 转 JPG" {...dragProps}><RequirePlugin embedded scriptName="png_to_jpg.py" title="PNG 转 JPG" desc="需要该引擎来执行图片格式的批量转换。"><ConverterView embedded defaultQuality={config.imageConversion.jpgQuality} /></RequirePlugin></HomePanel>;
          return <div key={card} className={draggedHomeCard === card ? 'opacity-40' : undefined}>{content}</div>;
        })}</div>}
        {activeTab === 'project' && selectedProject && <ProjectWorkspace project={selectedProject} workspacePath={config.workspacePath} initialPanel={projectOperation} importConfig={config.smartImport} brollConfig={config.brollImport} conversionConfig={config.imageConversion} matchConfig={config.smartMatch} mediaCacheConfig={config.mediaCache} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} onMatchConfigChange={(smartMatch: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch })} onMediaCacheConfigChange={(mediaCache: AppConfig['mediaCache']) => handleConfigUpdate({ ...config, mediaCache })} onNotice={showNotice} onProjectMoved={nextProject => { setSelectedProject(nextProject); setProjectDestination(nextProject.path); window.dispatchEvent(new Event('workspace-projects-changed')); }} onDeleted={() => { setSelectedProject(null); setProjectDestination(null); setProjectOperation(null); setActiveTab('home'); window.dispatchEvent(new Event('workspace-projects-changed')); }} />}

        {activeTab === 'converter' && (
          <RequirePlugin scriptName="png_to_jpg.py" title="PNG 转 JPG" desc="需要该引擎来执行图片格式的批量转换。">
            <ConverterView defaultQuality={config.imageConversion.jpgQuality} />
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
const ImportCard = ({ config, drives = [], destinationPath, onImportConfigChange, onImportComplete }: { config?: AppConfig['smartImport'], drives?: string[], destinationPath?: string | null, onImportConfigChange?: (config: AppConfig['smartImport']) => void, onImportComplete?: () => void }) => {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready_to_import' | 'importing' | 'decision' | 'processing' | 'finished'>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("等待连接...");
  const [decisionData, setDecisionData] = useState<any>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // 【关键修改】使用 Ref 来做“防抖”锁，防止 SD 卡接触不良导致多次触发 startImport
  const isBusyRef = React.useRef(false);
  const onImportCompleteRef = React.useRef(onImportComplete);
  useEffect(() => { onImportCompleteRef.current = onImportComplete; }, [onImportComplete]);
  const selectDrive = (sdPath: string) => {
    if (!config || !onImportConfigChange) return;
    onImportConfigChange({ ...config, sdPath });
  };

  const runCmd = (stage: string, args: string[] = []) => {
    if(window.electronAPI) window.electronAPI.runScript('classify.py', ['--stage', stage, ...args]);
  };

  useEffect(() => {
    if (!window.electronAPI?.onPythonEvent) return;

    const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
      if (event.scriptName !== 'classify.py') return;
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
      if (config.splitLargeFiles) {
        args.push('--split_large_files');
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
      if (config.splitLargeFiles) {
        args.push('--split_large_files');
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
        displayMsg = "请选择 SD 卡盘符";
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

        <div className="flex items-center gap-2">
          <select aria-label="SD 卡盘符" value={config?.sdPath || ''} onChange={event => selectDrive(event.target.value)} disabled={status === 'checking'} className="h-9 max-w-40 rounded-lg border border-slate-200 bg-white px-2 text-sm font-medium text-slate-700 outline-none focus:border-blue-500 disabled:cursor-wait disabled:opacity-60">
            {config?.sdPath && !drives.includes(config.sdPath) && <option value={config.sdPath}>{config.sdPath}（未连接）</option>}
            <option value="">选择盘符</option>
            {drives.map(drive => <option key={drive} value={drive}>{drive}</option>)}
          </select>
          {isConnected && status === 'idle' ? (
            <button onClick={startImport} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-bold flex items-center gap-2 shadow-md shadow-blue-500/20 transition-all animate-in zoom-in-95"><Download size={16} />开始导入</button>
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
  onImportComplete?: () => void | Promise<void>;
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
            <ImportCard config={config} drives={drives} destinationPath={projectDestination ?? workspacePath} onImportConfigChange={onImportConfigChange} onImportComplete={projectDestination ? undefined : () => { void onImportComplete?.(); }} />
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
            if (event.scriptName !== 'rename.py') return;
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

    const runRename = async () => {
        if (!folderA || !folderB || isRunning) return;
        const formatCheck = await window.electronAPI.checkCompareFolders([folderA, folderB]);
        if (!formatCheck.success) {
            setLogs([{ timestamp: new Date().toLocaleTimeString(), message: formatCheck.error || '无法检查图片格式', type: 'error' }]);
            return;
        }
        if (formatCheck.invalidFolders?.length) {
            const invalidCount = formatCheck.invalidFolders.reduce((count, folder) => count + folder.files.length, 0);
            setLogs([{ timestamp: new Date().toLocaleTimeString(), message: `检测到 ${invalidCount} 张非 JPG/JPEG 图片，请先在项目文件夹中右键选择“PNG 转 JPG”完成转换。`, type: 'warning' }]);
            return;
        }
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
                        className="hidden"
                    />
                    <select value={folderA} onChange={event => setFolderA(event.target.value)} className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"><option value="">请选择项目文件夹</option>{folderOptions.map(folder => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</select>
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
                        className="hidden"
                    />
                    <select value={folderB} onChange={event => setFolderB(event.target.value)} className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-green-500 focus:outline-none"><option value="">请选择项目文件夹</option>{folderOptions.map(folder => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</select>
                    <datalist id="compare-folder-b">{folderOptions.map(folder => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</datalist>
                    <p className="text-xs text-slate-500">选择最新图片所在的项目文件夹（对照组 B）。</p>
                </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col gap-4">
                <div className="flex items-center gap-2">
                    <input type="checkbox" id="copyUnmatched" checked={copyUnmatched} onChange={(e) => setCopyUnmatched(e.target.checked)} className="w-4 h-4 rounded border-slate-300 bg-white text-blue-600" />
                    <label htmlFor="copyUnmatched" className="text-sm text-slate-800 cursor-pointer select-none">
                        单独整理 文件夹A 中客户没返回的图片
                    </label>
                </div>
                <div className="hidden">
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
            <TaskProgress
                logs={logs}
                progress={progress}
                isRunning={isRunning}
                idleMessage={isRunning ? '正在对比…' : '进度'}
                action={<button onClick={runRename} disabled={isRunning || !folderA || !folderB} className={`project-action-button ${isRunning || !folderA || !folderB ? 'cursor-not-allowed opacity-50' : ''}`}>{isRunning ? <Loader2 className="animate-spin" size={16}/> : <FileDiff size={16}/>} {isRunning ? '对比中...' : '开始对比'}</button>}
            />
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

const _LegacySettingsModal = ({ config, onSave, onClose, requireWorkspace = false }: { config: AppConfig; onSave: (config: AppConfig) => void | Promise<void>; onClose: () => void; requireWorkspace?: boolean }) => {
  const [draft, setDraft] = useState(config);
  const [drives, setDrives] = useState<string[]>([]);
  useEffect(() => { window.electronAPI?.getDrives?.().then(setDrives); }, []);
  const updateImport = (changes: Partial<AppConfig['smartImport']>) => setDraft(current => ({ ...current, smartImport: { ...current.smartImport, ...changes } }));
  const updateBroll = (changes: Partial<AppConfig['brollImport']>) => setDraft(current => ({ ...current, brollImport: { ...current.brollImport, ...changes } }));
  const updateImageConversion = (changes: Partial<AppConfig['imageConversion']>) => setDraft(current => ({ ...current, imageConversion: { ...current.imageConversion, ...changes } }));
  const updateMatch = (changes: Partial<AppConfig['smartMatch']>) => setDraft(current => ({ ...current, smartMatch: { ...current.smartMatch, ...changes } }));
  const save = async () => { const workspacePath = draft.workspacePath.trim(); if (!workspacePath) return; await onSave({ ...draft, workspacePath }); if (!requireWorkspace) onClose(); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"><div className="absolute inset-0" onClick={requireWorkspace ? undefined : onClose}/><div className="relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-slate-200 bg-slate-100 p-5"><h3 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Settings size={20} className="text-blue-600"/>{requireWorkspace ? '设置工作目录' : '设置'}</h3>{!requireWorkspace && <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-200"><X size={20}/></button>}</header><div className="min-h-0 flex-1 space-y-7 overflow-y-auto p-6"><section><h4 className="text-sm font-bold text-slate-800">界面配色</h4><div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => setDraft(current => ({ ...current, theme }))} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">工作目录</h4><input value={draft.workspacePath} onChange={event => setDraft(current => ({ ...current, workspacePath: event.target.value }))} placeholder="例如：D:/照片流" className="mt-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-800 focus:border-blue-500 focus:outline-none"/></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">PNG 转 JPG</h4><p className="mt-1 text-sm text-slate-500">批量转换默认使用此导出画质。</p><label className="form-label">默认导出 JPG 画质</label><select value={draft.imageConversion.jpgQuality} onChange={event => updateImageConversion({ jpgQuality: Number(event.target.value) })} className="form-input"><option value={100}>最高（100）</option><option value={95}>高（95）</option><option value={85}>标准（85）</option><option value={75}>节省空间（75）</option></select></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">从 SD 卡导入</h4><label className="settings-check"><input type="checkbox" checked={draft.smartImport.autoStart} onChange={event => updateImport({ autoStart: event.target.checked })}/>应用启动时自动读取 SD 卡</label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.generateVideoPreview} onChange={event => updateImport({ generateVideoPreview: event.target.checked })}/>生成视频预览</label></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">导入花絮</h4><label className="settings-check"><input type="checkbox" checked={draft.brollImport.splitLargeFiles} onChange={event => updateBroll({ splitLargeFiles: event.target.checked })}/>超过 4GB 的视频自动分割</label><label className="settings-check"><input type="checkbox" checked={draft.brollImport.clearSource} onChange={event => updateBroll({ clearSource: event.target.checked })}/>导入后清空原始文件</label></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">选片</h4><label className="form-label">图片选片文件夹名称</label><input value={draft.smartMatch.imageDestFolderName} onChange={event => updateMatch({ imageDestFolderName: event.target.value })} className="form-input"/><label className="form-label">视频选片文件夹名称</label><input value={draft.smartMatch.videoDestFolderName} onChange={event => updateMatch({ videoDestFolderName: event.target.value })} className="form-input"/></section></div><footer className="flex justify-end gap-3 border-t border-slate-100 bg-white p-5">{!requireWorkspace && <button onClick={onClose} className="dialog-secondary">取消</button>}<button onClick={save} disabled={!draft.workspacePath.trim()} className="dialog-primary">{requireWorkspace ? '确认工作目录' : '保存设置'}</button></footer></div></div>;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"><div className="absolute inset-0" onClick={requireWorkspace ? undefined : onClose}/><div className="relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"><div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 p-5"><h3 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Settings size={20} className="text-blue-600"/>{requireWorkspace ? '设置工作目录' : '设置'}</h3>{requireWorkspace && <p className="mt-1 text-sm text-slate-500">首次使用前，请先选择一个用于存放项目的工作目录。</p>}{!requireWorkspace && <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-200"><X size={20}/></button>}</div><div className="min-h-0 flex-1 space-y-7 overflow-y-auto p-6"><section><h4 className="text-sm font-bold text-slate-800">界面配色</h4><p className="mt-1 text-sm text-slate-500">默认适应系统，也可固定为浅色或深色。</p><div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => setDraft(current => ({ ...current, theme }))} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">工作目录</h4><p className="mt-1 text-sm text-slate-500">选择磁盘根目录时，会使用根目录下的“照片流”文件夹。</p><input value={draft.workspacePath} onChange={event => setDraft(current => ({ ...current, workspacePath: event.target.value }))} placeholder="例如：D:/照片流" className="mt-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-800 focus:border-blue-500 focus:outline-none"/></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">从 SD 卡导入</h4><p className="mt-1 text-sm text-slate-500">导入位置由当前项目或工作目录决定。</p><p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-700">支持佳能（.cr2、.cr3）、索尼（.arw）、尼康（.nef）、奥林巴斯（.orf）、徕卡（.rwl、.dng）、富士（.raf）、哈苏（.3fr、.fff）、大疆（.dng）的 RAW 格式，以及常见图片和视频导入。</p><label className="settings-check"><input type="checkbox" checked={draft.smartImport.autoStart} onChange={event => updateImport({ autoStart: event.target.checked })}/>应用启动时自动读取 SD 卡</label><label className="form-label">SD 卡盘符</label><select value={draft.smartImport.sdPath} onChange={event => updateImport({ sdPath: event.target.value })} className="form-input">{draft.smartImport.sdPath && !drives.includes(draft.smartImport.sdPath) && <option value={draft.smartImport.sdPath}>{draft.smartImport.sdPath}（当前未连接）</option>}<option value="">请选择设备盘符</option>{drives.map(drive => <option key={drive} value={drive}>{drive}</option>)}</select><label className="settings-check"><input type="checkbox" checked={draft.smartImport.generateVideoPreview} onChange={event => updateImport({ generateVideoPreview: event.target.checked })}/>生成视频预览（储存至 mov_压缩）</label></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">导入花絮</h4><p className="mt-1 text-sm text-slate-500">文件会复制到当前项目的“花絮”文件夹。</p><label className="settings-check"><input type="checkbox" checked={draft.brollImport.splitLargeFiles} onChange={event => updateBroll({ splitLargeFiles: event.target.checked })}/>超过 4GB 的单个视频自动分割为约 4GB 的文件</label><label className="settings-check"><input type="checkbox" checked={draft.brollImport.clearSource} onChange={event => updateBroll({ clearSource: event.target.checked })}/>导入后清空原始文件</label></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">{"\u9009\u7247"}</h4><p className="mt-1 text-sm text-slate-500">{"\u6311\u9009\u51fa\u7684\u56fe\u7247\u548c\u89c6\u9891\u4f1a\u5206\u522b\u5b58\u653e\u5230\u5f53\u524d\u9879\u76ee\u4e2d\u7684\u4ee5\u4e0b\u6587\u4ef6\u5939\u3002"}</p><label className="form-label">{"\u56fe\u7247\u9009\u7247\u6587\u4ef6\u5939\u540d\u79f0"}</label><input value={draft.smartMatch.imageDestFolderName} onChange={event => updateMatch({ imageDestFolderName: event.target.value })} placeholder={"\u56fe\u7247\u9009\u7247"} className="form-input"/><label className="form-label">{"\u89c6\u9891\u9009\u7247\u6587\u4ef6\u5939\u540d\u79f0"}</label><input value={draft.smartMatch.videoDestFolderName} onChange={event => updateMatch({ videoDestFolderName: event.target.value })} placeholder={"\u89c6\u9891\u9009\u7247"} className="form-input"/></section></div><div className="flex justify-end gap-3 border-t border-slate-100 bg-white p-5">{!requireWorkspace && <button onClick={onClose} className="dialog-secondary">取消</button>}<button onClick={save} disabled={!draft.workspacePath.trim()} className="dialog-primary">{requireWorkspace ? '确认工作目录' : '保存设置'}</button></div></div></div>;
};

const _LegacyCurrentSettingsModal = ({ config, onSave, onClose, requireWorkspace = false }: { config: AppConfig; onSave: (config: AppConfig) => void | Promise<void>; onClose: () => void; requireWorkspace?: boolean }) => {
  const [draft, setDraft] = useState(config);
  const updateImport = (changes: Partial<AppConfig['smartImport']>) => setDraft(current => ({ ...current, smartImport: { ...current.smartImport, ...changes } }));
  const updateBroll = (changes: Partial<AppConfig['brollImport']>) => setDraft(current => ({ ...current, brollImport: { ...current.brollImport, ...changes } }));
  const updateImageConversion = (changes: Partial<AppConfig['imageConversion']>) => setDraft(current => ({ ...current, imageConversion: { ...current.imageConversion, ...changes } }));
  const updateMatch = (changes: Partial<AppConfig['smartMatch']>) => setDraft(current => ({ ...current, smartMatch: { ...current.smartMatch, ...changes } }));
  const save = async () => { const workspacePath = draft.workspacePath.trim(); if (!workspacePath) return; await onSave({ ...draft, workspacePath }); if (!requireWorkspace) onClose(); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"><div className="absolute inset-0" onClick={requireWorkspace ? undefined : onClose}/><div className="relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-slate-200 bg-slate-100 p-5"><h3 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Settings size={20} className="text-blue-600"/>{requireWorkspace ? '设置工作目录' : '设置'}</h3>{!requireWorkspace && <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-200"><X size={20}/></button>}</header><div className="min-h-0 flex-1 space-y-7 overflow-y-auto p-6"><section><h4 className="text-sm font-bold text-slate-800">界面配色</h4><div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => setDraft(current => ({ ...current, theme }))} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">工作目录</h4><input value={draft.workspacePath} onChange={event => setDraft(current => ({ ...current, workspacePath: event.target.value }))} placeholder="例如：D:/照片流" className="mt-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-800 focus:border-blue-500 focus:outline-none"/></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">PNG 转 JPG</h4><label className="form-label">默认导出 JPG 画质</label><select value={draft.imageConversion.jpgQuality} onChange={event => updateImageConversion({ jpgQuality: Number(event.target.value) })} className="form-input"><option value={100}>最高（100）</option><option value={95}>高（95）</option><option value={85}>标准（85）</option><option value={75}>节省空间（75）</option></select></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">从 SD 卡导入</h4><p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-700">支持佳能（.cr2、.cr3）、索尼（.arw）、尼康（.nef）、奥林巴斯（.orf）、徕卡（.rwl、.dng）、富士（.raf）、哈苏（.3fr、.fff）、大疆（.dng）的 RAW 格式，以及常见图片和视频导入。</p><label className="settings-check"><input type="checkbox" checked={draft.smartImport.autoStart} onChange={event => updateImport({ autoStart: event.target.checked })}/>应用启动时自动读取 SD 卡</label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.generateVideoPreview} onChange={event => updateImport({ generateVideoPreview: event.target.checked })}/>生成视频预览</label></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">导入花絮</h4><label className="settings-check"><input type="checkbox" checked={draft.brollImport.splitLargeFiles} onChange={event => updateBroll({ splitLargeFiles: event.target.checked })}/>超过 4GB 的视频自动分割</label><label className="settings-check"><input type="checkbox" checked={draft.brollImport.clearSource} onChange={event => updateBroll({ clearSource: event.target.checked })}/>导入后清空原始文件</label></section><section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">选片</h4><label className="form-label">图片选片文件夹名称</label><input value={draft.smartMatch.imageDestFolderName} onChange={event => updateMatch({ imageDestFolderName: event.target.value })} className="form-input"/><label className="form-label">视频选片文件夹名称</label><input value={draft.smartMatch.videoDestFolderName} onChange={event => updateMatch({ videoDestFolderName: event.target.value })} className="form-input"/></section></div><footer className="flex justify-end gap-3 border-t border-slate-100 bg-white p-5">{!requireWorkspace && <button onClick={onClose} className="dialog-secondary">取消</button>}<button onClick={save} disabled={!draft.workspacePath.trim()} className="dialog-primary">{requireWorkspace ? '确认工作目录' : '保存设置'}</button></footer></div></div>;
};

const SettingsModal = ({ config, onSave, onClose, requireWorkspace = false }: { config: AppConfig; onSave: (config: AppConfig) => void | Promise<void>; onClose: () => void; requireWorkspace?: boolean }) => {
  const [draft, setDraft] = useState(config);
  const update = <K extends keyof AppConfig,>(key: K, value: AppConfig[K]) => setDraft(current => ({ ...current, [key]: value }));
  const save = async () => {
    const workspacePath = draft.workspacePath.trim();
    if (!workspacePath) return;
    await onSave({ ...draft, workspacePath });
    if (!requireWorkspace) onClose();
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm"><div className="absolute inset-0" onClick={requireWorkspace ? undefined : onClose}/><div className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-slate-200 bg-slate-100 p-5"><h3 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Settings size={20} className="text-blue-600"/>{requireWorkspace ? '设置工作目录' : '设置'}</h3>{!requireWorkspace && <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-200"><X size={20}/></button>}</header><div className="min-h-0 flex-1 space-y-7 overflow-y-auto p-6">
    <section><h4 className="text-sm font-bold text-slate-800">界面配色</h4><div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => update('theme', theme)} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">工作目录</h4><input value={draft.workspacePath} onChange={event => update('workspacePath', event.target.value)} placeholder="例如：D:/照片流" className="mt-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-800 focus:border-blue-500 focus:outline-none"/></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">缩略图缓存</h4><p className="mt-1 text-sm text-slate-500">设置 RAW 预览缓存的容量、位置，并可随时清理。</p><div className="mt-4"><MediaCacheSettings config={draft.mediaCache} onChange={mediaCache => update('mediaCache', mediaCache)}/></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">PNG 转 JPG</h4><label className="form-label">默认导出 JPG 画质</label><select value={draft.imageConversion.jpgQuality} onChange={event => update('imageConversion', { jpgQuality: Number(event.target.value) })} className="form-input"><option value={100}>最高（100）</option><option value={95}>高（95）</option><option value={85}>标准（85）</option><option value={75}>节省空间（75）</option></select></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">调研整理</h4><label className="form-label">检测灵敏度</label><select value={draft.research.sensitivity} onChange={event => update('research', { ...draft.research, sensitivity: event.target.value as AppConfig['research']['sensitivity'] })} className="form-input"><option value="low">低</option><option value="standard">标准</option><option value="high">高</option></select><p className="mt-1 text-xs leading-5 text-slate-500">{{ low: '减少快速运动、闪光等造成的误判，但可能漏掉轻微或渐变转场。', standard: '在转场识别数量和误判率之间保持平衡，适合大多数素材。', high: '会识别更多轻微或渐变转场，但也更容易把快速运动识别为转场。' }[draft.research.sensitivity]}</p><label className="form-label">最小片段时长（秒）</label><input type="number" min="0.05" max="5" step="0.05" value={draft.research.minDuration} onChange={event => update('research', { ...draft.research, minDuration: Math.min(5, Math.max(0.05, Number(event.target.value) || 0.05)) })} className="form-input"/><p className="mt-1 text-xs leading-5 text-slate-500">数值越大，越能过滤闪光、抖动造成的极短误判，但可能合并真实的快速剪辑。如果应用主要处理常规影视素材，可以考虑提高到 0.3–0.5 秒。</p></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">从 SD 卡导入</h4><label className="settings-check"><input type="checkbox" checked={draft.smartImport.autoStart} onChange={event => update('smartImport', { ...draft.smartImport, autoStart: event.target.checked })}/>应用启动时自动读取 SD 卡</label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.splitLargeFiles} onChange={event => update('smartImport', { ...draft.smartImport, splitLargeFiles: event.target.checked })}/><span><span className="block">超过 4GB 的视频自动分割</span><span className="mt-1 block text-xs leading-5 text-slate-500">用于兼容部分老旧 U 盘的 FAT32 单文件大小限制，以及某些云盘的单文件上传限制。</span></span></label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.generateVideoPreview} onChange={event => update('smartImport', { ...draft.smartImport, generateVideoPreview: event.target.checked })}/><span><span className="block">生成视频预览</span><span className="mt-1 block text-xs leading-5 text-slate-500">生成 H.264 中码率视频以便快速预览，预览文件会储存在“mov_预览”文件夹。</span></span></label></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">导入花絮</h4><label className="settings-check"><input type="checkbox" checked={draft.brollImport.splitLargeFiles} onChange={event => update('brollImport', { ...draft.brollImport, splitLargeFiles: event.target.checked })}/><span><span className="block">超过 4GB 的视频自动分割</span><span className="mt-1 block text-xs leading-5 text-slate-500">用于兼容部分老旧 U 盘的 FAT32 单文件大小限制，以及某些云盘的单文件上传限制。</span></span></label><label className="settings-check"><input type="checkbox" checked={draft.brollImport.clearSource} onChange={event => update('brollImport', { ...draft.brollImport, clearSource: event.target.checked })}/>导入后清空原始文件</label></section>
  </div><footer className="flex justify-end gap-3 border-t border-slate-100 bg-white p-5">{!requireWorkspace && <button onClick={onClose} className="dialog-secondary">取消</button>}<button onClick={save} disabled={!draft.workspacePath.trim()} className="dialog-primary">{requireWorkspace ? '确认工作目录' : '保存设置'}</button></footer></div></div>;
};

type ProjectPanel = 'import' | 'broll' | 'match' | 'compare' | 'converter' | 'create' | 'trash' | 'cache' | null;
const PROJECT_STATUSES: Array<WorkspaceProject['status']> = ['策划中', '待拍摄', '后期中', '已归档'];

const ProjectWorkspace = ({ project, workspacePath, initialPanel, importConfig, brollConfig, conversionConfig, matchConfig, mediaCacheConfig, onImportConfigChange, onMatchConfigChange, onMediaCacheConfigChange, onNotice, onProjectMoved, onDeleted }: {
  project: WorkspaceProject;
  workspacePath: string;
  initialPanel: 'import' | 'broll' | 'match' | null;
  importConfig: AppConfig['smartImport'];
  brollConfig: AppConfig['brollImport'];
  conversionConfig: AppConfig['imageConversion'];
  matchConfig: AppConfig['smartMatch'];
  mediaCacheConfig: AppConfig['mediaCache'];
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onMatchConfigChange: (config: AppConfig['smartMatch']) => void;
  onMediaCacheConfigChange: (config: AppConfig['mediaCache']) => void;
  onNotice: (message: string) => void;
  onProjectMoved: (project: WorkspaceProject) => void;
  onDeleted: () => void;
}) => {
  const [folders, setFolders] = useState<Array<{ name: string; path: string; updatedAt: number }>>([]);
  const [fileEntries, setFileEntries] = useState<ProjectFileEntry[]>([]);
  const [renderedEntryCount, setRenderedEntryCount] = useState(120);
  const [currentRelativePath, setCurrentRelativePath] = useState('');
  const [directoryHistory, setDirectoryHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');
  const [gridIconSize, setGridIconSize] = useState(18);
  const projectWorkspaceRef = useRef<HTMLDivElement>(null);
  const filesSurfaceRef = useRef<HTMLDivElement>(null);
  const loadMoreEntriesRef = useRef<HTMLDivElement>(null);
  const didInitializePathRefreshRef = useRef(false);
  const skipNextPathRefreshRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const directoryEntriesCacheRef = useRef(new Map<string, ProjectFileEntry[]>());
  const selectionDragRef = useRef<{ startX: number; startY: number; initialPaths: string[]; additive: boolean } | null>(null);
  const renameCommitRef = useRef(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [inlineRenamePath, setInlineRenamePath] = useState('');
  const [inlineRenameValue, setInlineRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [panel, setPanel] = useState<ProjectPanel>(initialPanel);
  const [message, setMessage] = useState('');
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ entry: ProjectFileEntry; x: number; y: number } | null>(null);
  const [progressName, setProgressName] = useState('');
  const [conversionTarget, setConversionTarget] = useState('');
  const [drives, setDrives] = useState<string[]>([]);

  useEffect(() => {
    const fetchDrives = () => window.electronAPI?.getDrives?.().then(setDrives);
    fetchDrives();
    const intervalId = window.setInterval(fetchDrives, 3000);
    return () => window.clearInterval(intervalId);
  }, []);

  const refresh = async (relativePath = currentRelativePath) => {
    const refreshSequence = ++refreshSequenceRef.current;
    const cachedEntries = directoryEntriesCacheRef.current.get(relativePath);
    if (cachedEntries) setFileEntries(cachedEntries);
    const contentsPromise = window.electronAPI.getProjectContents(workspacePath, project.status, project.name);
    const browseResult = await window.electronAPI.browseProjectFiles(workspacePath, project.status, project.name, relativePath, mediaCacheConfig);
    if (refreshSequence !== refreshSequenceRef.current) return;
    if (browseResult.success) {
      const cachedByPath = new Map((cachedEntries || []).map(entry => [entry.relativePath, entry]));
      const entries = browseResult.entries.map(entry => {
        const cached = cachedByPath.get(entry.relativePath);
        return cached && cached.updatedAt ? { ...entry, size: cached.size, updatedAt: cached.updatedAt } : entry;
      });
      directoryEntriesCacheRef.current.set(relativePath, entries);
      setFileEntries(entries);
    } else {
      // Never leave entries from the previous directory under a new breadcrumb.
      setFileEntries([]);
      onNotice(`读取目录失败：${browseResult.error || '无法读取文件'}`);
    }
    const result = await contentsPromise;
    if (refreshSequence !== refreshSequenceRef.current) return;
    if (result.success) setFolders(result.folders);
    else onNotice(`读取项目失败：${result.error || '无法读取项目文件夹'}`);
  };

  useEffect(() => {
    directoryEntriesCacheRef.current.clear();
    setFileEntries([]);
    setDirectoryHistory({ back: [], forward: [] });
    setPanel(initialPanel);
    setMessage('');
    if (currentRelativePath) skipNextPathRefreshRef.current = true;
    setCurrentRelativePath('');
    refresh('');
  }, [project.path, project.status, initialPanel]);
  useEffect(() => {
    if (!didInitializePathRefreshRef.current) {
      didInitializePathRefreshRef.current = true;
      return;
    }
    if (skipNextPathRefreshRef.current) {
      skipNextPathRefreshRef.current = false;
      return;
    }
    setSelectedPaths([]);
    setInlineRenamePath('');
    setInlineRenameValue('');
    setFileMenu(null);
    refresh();
  }, [currentRelativePath]);
  useEffect(() => {
    let timer: number | undefined;
    const projectPrefix = `${project.status}/${project.name}`.replace(/\\/g, '/');
    return window.electronAPI.onWorkspaceFilesChanged(change => {
      const changedPath = (change.fileName || '').replace(/\\/g, '/');
      // A change in another project should never make a photo-heavy folder redraw.
      if (changedPath && !changedPath.startsWith(projectPrefix)) return;
      directoryEntriesCacheRef.current.clear();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refresh(currentRelativePath), 500);
    });
  }, [workspacePath, project.path, currentRelativePath, mediaCacheConfig]);
  useEffect(() => {
    const closeMenus = () => { setFileMenu(null); setShowStatusMenu(false); setShowCreateMenu(false); };
    window.addEventListener('click', closeMenus);
    return () => window.removeEventListener('click', closeMenus);
  }, []);

  const renderedFileEntries = fileEntries.slice(0, renderedEntryCount);
  const pathSegments = currentRelativePath.split(/[\\/]/).filter(Boolean);
  const breadcrumbs = [{ label: project.name, relativePath: '' }, ...pathSegments.map((label, index) => ({ label, relativePath: pathSegments.slice(0, index + 1).join('/') }))];
  useEffect(() => { setRenderedEntryCount(120); }, [currentRelativePath]);
  useEffect(() => {
    const target = loadMoreEntriesRef.current;
    if (!target || renderedEntryCount >= fileEntries.length) return;
    const observer = new IntersectionObserver(([item]) => {
      if (item.isIntersecting) setRenderedEntryCount(count => Math.min(count + 120, fileEntries.length));
    }, { rootMargin: '600px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [renderedEntryCount, fileEntries.length, viewMode]);
  useEffect(() => {
    const missingDetails = renderedFileEntries.filter(entry => entry.updatedAt === 0).map(entry => entry.relativePath);
    if (!missingDetails.length) return;
    let active = true;
    const directoryPath = currentRelativePath;
    window.electronAPI.getProjectFileDetails(workspacePath, project.status, project.name, missingDetails).then(result => {
      if (!active || !result.success || !result.details.length) return;
      const detailsByPath = new Map(result.details.map(detail => [detail.relativePath, detail]));
      setFileEntries(current => {
        const next = current.map(entry => {
          const detail = detailsByPath.get(entry.relativePath);
          return detail ? { ...entry, size: detail.size, updatedAt: detail.updatedAt } : entry;
        });
        directoryEntriesCacheRef.current.set(directoryPath, next);
        return next;
      });
    });
    return () => { active = false; };
  }, [currentRelativePath, renderedEntryCount, fileEntries]);

  const prefetchDirectory = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'folder' || directoryEntriesCacheRef.current.has(entry.relativePath)) return;
    window.electronAPI.browseProjectFiles(workspacePath, project.status, project.name, entry.relativePath, mediaCacheConfig).then(result => {
      if (result.success) directoryEntriesCacheRef.current.set(entry.relativePath, result.entries);
    });
  };

  const togglePanel = (next: Exclude<ProjectPanel, null>) => setPanel(current => current === next ? null : next);
  const formatFileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : size < 1024 * 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
  const openFolder = async (folderName?: string) => {
    const result = await window.electronAPI.openWorkspaceProject(workspacePath, project.status, project.name, folderName);
    if (!result.success) onNotice(`打开文件夹失败：${result.error || '未知错误'}`);
  };
  const moveStatus = async (status: WorkspaceProject['status']) => {
    setShowStatusMenu(false);
    if (status === project.status) return;
    const result = await window.electronAPI.moveWorkspaceProject(workspacePath, project.status, project.name, status);
    if (!result.success || !result.project) { onNotice(`更改状态失败：${result.error || '未知错误'}`); return; }
    onProjectMoved(result.project);
  };
  const importBroll = async () => {
    setMessage('正在选择花絮文件…');
    const result = await window.electronAPI.importBroll(workspacePath, project.status, project.name, brollConfig);
    if (!result.success) { onNotice(`导入花絮失败：${result.error || '未知错误'}`); return; }
    if (result.cancelled) { setMessage('已取消选择花絮文件。'); return; }
    setMessage(`已导入 ${result.count || 0} 个花絮文件。`);
    refresh();
  };
  const markInProgress = async () => {
    if (project.status === '后期中') return;
    const result = await window.electronAPI.moveWorkspaceProject(workspacePath, project.status, project.name, '后期中');
    if (!result.success || !result.project) { onNotice(`项目状态更新失败：${result.error || '未知错误'}`); return; }
    setMessage('导入完成，项目已移入“后期中”。');
    onProjectMoved(result.project);
  };
  const createFolder = async () => {
    const name = progressName.trim();
    if (!name) return;
    const result = await window.electronAPI.createProjectFolder(workspacePath, project.status, project.name, name);
    if (!result.success) { onNotice(`新建文件夹失败：${result.error || '未知错误'}`); return; }
    setMessage(`已新建文件夹“${result.folder?.name || name}”。`);
    setProgressName('');
    setPanel(null);
    refresh();
  };
  const createNumberedProgress = async (prefix: '图片后期' | '视频后期') => {
    setShowCreateMenu(false);
    const latestContents = await window.electronAPI.getProjectContents(workspacePath, project.status, project.name);
    const existingFolders = latestContents.success ? latestContents.folders : folders;
    const matcher = new RegExp(`^${prefix}_(\\d+)$`);
    const highestIndex = existingFolders.reduce((highest, folder) => {
      const match = folder.name.match(matcher);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
    const name = `${prefix}_${highestIndex + 1}`;
    const result = await window.electronAPI.createProjectFolder(workspacePath, project.status, project.name, name);
    if (!result.success) { onNotice(`创建失败：${result.error || `无法创建“${name}”`}`); return; }
    setMessage(`已创建“${result.folder?.name || name}”。`);
    refresh();
  };
  const moveToTrash = async () => {
    const result = await window.electronAPI.trashWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) { onNotice(`删除项目失败：${result.error || '未知错误'}`); return; }
    onDeleted();
  };
  const openPngConverter = async (folderPath: string) => {
    const result = await window.electronAPI.folderHasPng(folderPath);
    if (!result.success) { onNotice(`检查 PNG 文件失败：${result.error || '未知错误'}`); return; }
    if (!result.hasPng) { setMessage('文件夹中没有 PNG 文件。'); return; }
    setConversionTarget(folderPath);
    setPanel('converter');
  };
  const toggleSelected = (relativePath: string) => setSelectedPaths(current => current.includes(relativePath) ? current.filter(path => path !== relativePath) : [...current, relativePath]);
  const beginInlineRename = (relativePath: string) => {
    const entry = fileEntries.find(candidate => candidate.relativePath === relativePath);
    if (!entry) return;
    setSelectedPaths([relativePath]);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(entry.name);
  };
  const cancelInlineRename = () => {
    setInlineRenamePath('');
    setInlineRenameValue('');
  };
  const commitInlineRename = async () => {
    if (!inlineRenamePath || renameCommitRef.current) return;
    const entry = fileEntries.find(candidate => candidate.relativePath === inlineRenamePath);
    const nextName = inlineRenameValue.trim();
    if (!entry || !nextName || nextName === entry.name) { cancelInlineRename(); return; }
    renameCommitRef.current = true;
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'rename', [inlineRenamePath], currentRelativePath, nextName);
    renameCommitRef.current = false;
    if (!result.success) { onNotice(`重命名失败：${result.error || '未知错误'}`); return; }
    cancelInlineRename();
    setSelectedPaths([]);
    onNotice(`已重命名为“${nextName}”`);
    refresh();
  };
  const openFileMenu = (event: React.MouseEvent, entry: ProjectFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPaths(current => current.includes(entry.relativePath) ? current : [entry.relativePath]);
    setFileMenu({ entry, x: event.clientX, y: event.clientY });
  };
  const showDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const cachedEntries = directoryEntriesCacheRef.current.get(normalizedPath);
    if (cachedEntries) setFileEntries(cachedEntries);
    else setFileEntries([]);
    setMessage('');
    setCurrentRelativePath(normalizedPath);
  };
  const navigateToDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (normalizedPath === currentRelativePath) return;
    setDirectoryHistory(current => ({ back: [...current.back, currentRelativePath], forward: [] }));
    showDirectory(normalizedPath);
  };
  const navigateBack = () => {
    const target = directoryHistory.back[directoryHistory.back.length - 1];
    if (target === undefined) return;
    setDirectoryHistory(current => ({ back: current.back.slice(0, -1), forward: [currentRelativePath, ...current.forward] }));
    showDirectory(target);
  };
  const navigateForward = () => {
    const target = directoryHistory.forward[0];
    if (target === undefined) return;
    setDirectoryHistory(current => ({ back: [...current.back, currentRelativePath], forward: current.forward.slice(1) }));
    showDirectory(target);
  };
  const openProjectEntry = async (entry: ProjectFileEntry) => {
    if (entry.kind === 'folder') { navigateToDirectory(entry.relativePath); return; }
    if (entry.kind !== 'file') return;
    const result = await window.electronAPI.openProjectEntry(workspacePath, project.status, project.name, entry.relativePath);
    if (!result.success) onNotice(`打开文件失败：${result.error || '无法打开文件'}`);
  };
  const copyEntryPath = async (entry: ProjectFileEntry) => {
    const result = await window.electronAPI.copyProjectEntryPath(workspacePath, project.status, project.name, entry.relativePath);
    const typeLabel = entry.kind === 'folder' ? '文件夹' : '文件';
    onNotice(result.success ? `已复制${typeLabel}地址` : `复制${typeLabel}地址失败：${result.error || '未知错误'}`);
  };
  const startSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-entry-path], button, input, select, textarea')) return;
    const surface = filesSurfaceRef.current;
    if (!surface) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const additive = event.ctrlKey || event.metaKey;
    selectionDragRef.current = { startX: event.clientX, startY: event.clientY, initialPaths: additive ? selectedPaths : [], additive };
    if (!additive) setSelectedPaths([]);
    const rect = surface.getBoundingClientRect();
    setSelectionBox({ left: event.clientX - rect.left, top: event.clientY - rect.top, width: 0, height: 0 });
  };
  const updateSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    const surface = filesSurfaceRef.current;
    if (!drag || !surface) return;
    event.preventDefault();
    const leftClient = Math.min(drag.startX, event.clientX);
    const topClient = Math.min(drag.startY, event.clientY);
    const rightClient = Math.max(drag.startX, event.clientX);
    const bottomClient = Math.max(drag.startY, event.clientY);
    const surfaceRect = surface.getBoundingClientRect();
    setSelectionBox({ left: leftClient - surfaceRect.left, top: topClient - surfaceRect.top, width: rightClient - leftClient, height: bottomClient - topClient });
    const hits = Array.from(surface.querySelectorAll<HTMLElement>('[data-entry-path]')).filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.right >= leftClient && rect.left <= rightClient && rect.bottom >= topClient && rect.top <= bottomClient;
    }).map(node => node.dataset.entryPath).filter((path): path is string => Boolean(path));
    setSelectedPaths(Array.from(new Set([...drag.initialPaths, ...hits])));
  };
  const finishSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!selectionDragRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    selectionDragRef.current = null;
    setSelectionBox(null);
  };
  const runFileOperation = async (operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename', nextName?: string) => {
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, operation, selectedPaths, currentRelativePath, nextName);
    if (result.cancelled) { onNotice('粘贴已取消'); refresh(); return; }
    if (!result.success) { onNotice(`操作失败：${result.error || '未知错误'}`); return; }
    if (operation === 'copy' || operation === 'cut') onNotice(`${operation === 'copy' ? '已复制' : '已剪切'} ${result.count} 个项目`);
    else { onNotice(operation === 'trash' ? `已移入回收站 ${result.count} 个项目` : operation === 'paste' ? `已粘贴 ${result.count} 个项目` : '操作完成'); setSelectedPaths([]); refresh(); }
  };
  useEffect(() => {
    const handleFileShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      let handled = false;

      if (commandKey && key === 'a') {
        setSelectedPaths(fileEntries.map(entry => entry.relativePath));
        onNotice(`已选择 ${fileEntries.length} 个项目`);
        handled = true;
      } else if (commandKey && key === 'c' && selectedPaths.length) {
        void runFileOperation('copy');
        handled = true;
      } else if (commandKey && key === 'x' && selectedPaths.length) {
        void runFileOperation('cut');
        handled = true;
      } else if (commandKey && key === 'v') {
        void runFileOperation('paste');
        handled = true;
      } else if (event.key === 'Delete' && selectedPaths.length) {
        void runFileOperation('trash');
        handled = true;
      } else if (event.key === 'F2' && selectedPaths.length === 1) {
        beginInlineRename(selectedPaths[0]);
        handled = true;
      } else if (event.key === 'Escape' && selectedPaths.length) {
        setSelectedPaths([]);
        onNotice('已退出选择');
        handled = true;
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', handleFileShortcut);
    return () => window.removeEventListener('keydown', handleFileShortcut);
  });
  const selectedEntries = fileEntries.filter(entry => selectedPaths.includes(entry.relativePath));
  const canSelectMedia = selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
  const selectMediaFiles = async () => {
    if (!canSelectMedia) { onNotice(selectedPaths.length ? '只能选择媒体文件' : '请先选择媒体文件'); return; }
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'select', selectedPaths);
    if (!result.success) { onNotice(`选片失败：${result.error || '未知错误'}`); return; }
    onNotice(`已将 ${result.count || 0} 个媒体文件放入选片文件夹`);
    setSelectedPaths([]);
    refresh();
  };
  const handleEntryClick = (entry: ProjectFileEntry) => {
    if (inlineRenamePath === entry.relativePath) return;
    if (selectedPaths.length) toggleSelected(entry.relativePath);
    else openProjectEntry(entry);
  };
  const renderEntryName = (entry: ProjectFileEntry, grid = false) => inlineRenamePath === entry.relativePath ? <input
    autoFocus
    value={inlineRenameValue}
    onFocus={event => event.currentTarget.select()}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onChange={event => setInlineRenameValue(event.target.value)}
    onBlur={commitInlineRename}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') commitInlineRename();
      if (event.key === 'Escape') cancelInlineRename();
    }}
    className={`${grid ? 'mt-2 w-full text-xs' : 'min-w-0 flex-1 text-sm'} rounded border border-blue-500 bg-white px-1.5 py-0.5 text-slate-800 outline-none ring-2 ring-blue-200`}
  /> : grid ? <p className="mt-2 truncate text-xs font-medium text-slate-700">{entry.name}</p> : <span className="truncate font-medium text-slate-700">{entry.name}</span>;
  const gridColumnCount = Math.max(1, Math.floor(100 / gridIconSize));
  const gridThumbnailSize = gridColumnCount === 1 ? 1600 : gridColumnCount === 2 ? 1200 : gridColumnCount <= 4 ? 960 : gridColumnCount <= 6 ? 640 : 320;
  const renderEntryIcon = (entry: ProjectFileEntry, large = false) => entry.kind === 'folder'
    ? <Folder size={large ? 58 : 27} strokeWidth={1.5} fill="currentColor" className="text-blue-500"/>
    : entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'
      ? <><MediaThumbnail entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? gridThumbnailSize : 160} large={large}/>{entry.kind === 'video' && <Play size={large ? 25 : 15} fill="currentColor" className="pointer-events-none absolute text-white drop-shadow-[0_1px_4px_rgba(0,0,0,.8)]"/>}</>
      : <SystemFileIcon filePath={entry.path} size={large ? 48 : 28}/>;
  useEffect(() => {
    const workspace = projectWorkspaceRef.current;
    if (!workspace || viewMode !== 'grid') return;
    const zoomSurface = workspace.closest('main') || workspace;
    const zoomWithWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[role="dialog"], .fixed')) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.deltaY < 0 ? 1 : -1;
      const intensity = Math.max(2, Math.min(8, Math.abs(event.deltaY) / 20));
      setGridIconSize(current => Math.max(10, Math.min(100, Math.round(current + direction * intensity))));
    };
    zoomSurface.addEventListener('wheel', zoomWithWheel, { capture: true, passive: false });
    return () => {
      zoomSurface.removeEventListener('wheel', zoomWithWheel, true);
    };
  }, [viewMode]);

  return (
    <div ref={projectWorkspaceRef} className="flex min-h-full w-full min-w-0 flex-col gap-3 animate-in fade-in duration-300">
      {panel === 'converter' && <CollapsiblePanel title="PNG 转 JPG" onClose={() => setPanel(null)}><ConverterView embedded initialTargetPath={conversionTarget} defaultQuality={conversionConfig.jpgQuality}/></CollapsiblePanel>}
      {fileMenu && createPortal(<div className="project-context-menu fixed z-[301] max-h-[calc(100vh-1rem)] w-52 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl" style={{ left: Math.max(8, Math.min(fileMenu.x, window.innerWidth - 220)), top: Math.max(8, Math.min(fileMenu.y, window.innerHeight - 490)) }} onClick={event => event.stopPropagation()}>
        <button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; setFileMenu(null); beginInlineRename(path); }}><Edit size={14}/>重命名</button>
        <button className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('cut'); }}><Cut size={14}/>剪切</button>
        <button className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('copy'); }}><Copy size={14}/>复制</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); copyEntryPath(entry); }}><FileText size={14}/>{fileMenu.entry.kind === 'folder' ? '复制文件夹地址' : '复制文件地址'}</button>
        <button className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('paste'); }}><ClipboardPaste size={14}/>粘贴</button>
        <button className="project-menu-item project-menu-danger" onClick={() => { setFileMenu(null); runFileOperation('trash'); }}><Trash2 size={14}/>删除</button>
        <button className="project-menu-item" onClick={() => { setSelectedPaths([]); setFileMenu(null); }}><X size={14}/>退出选择</button>
        <div className="my-1 border-t border-slate-100"/>
        <button disabled={!canSelectMedia} className="project-menu-item" onClick={() => { setFileMenu(null); selectMediaFiles(); }}><CheckCircle2 size={14}/>选片</button>
        <button className="project-menu-item" onClick={() => { setFileMenu(null); togglePanel('compare'); }}><FileDiff size={14}/>对比图片</button>
        {fileMenu.entry.kind === 'folder' && <><div className="my-1 border-t border-slate-100"/><button className="project-menu-item" onClick={() => { setFileMenu(null); openPngConverter(fileMenu.entry.path); }}><ImageIcon size={14}/>PNG 转 JPG</button></>}
      </div>, document.body)}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-bold text-slate-800">{project.name}</h2>
          <div className="relative" onClick={event => event.stopPropagation()}>
            <button onClick={() => setShowStatusMenu(value => !value)} className="flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-600 hover:bg-blue-100">{PROJECT_STATUS_LABELS[project.status]} <ChevronDown size={14}/></button>
            {showStatusMenu && <div className="absolute left-0 top-full z-30 mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{PROJECT_STATUSES.map(status => <button key={status} onClick={() => moveStatus(status)} className={`project-menu-item ${status === project.status ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{PROJECT_STATUS_LABELS[status]}{status === project.status ? '（当前）' : ''}</button>)}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2"><button onClick={() => openFolder()} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><ExternalLink size={16}/>打开项目文件夹</button><button onClick={() => setConfirmDelete(true)} title="删除项目" className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-500 hover:bg-red-50"><Trash2 size={16}/></button></div>
      </div>

      <div className="project-toolbar flex flex-wrap items-center border-b border-slate-200 py-1">
        <div className="relative" onClick={event => event.stopPropagation()}>
          <button onClick={() => setShowCreateMenu(value => !value)} title="创建进度" aria-label="创建进度" aria-haspopup="menu" aria-expanded={showCreateMenu} className="project-action-button"><FolderPlus size={16}/>创建进度</button>
          {showCreateMenu && <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            <button className="project-menu-item" onClick={() => createNumberedProgress('图片后期')}>创建图片进度</button>
            <button className="project-menu-item" onClick={() => createNumberedProgress('视频后期')}>创建视频进度</button>
            <div className="my-1 border-t border-slate-100"/>
            <button className="project-menu-item" onClick={() => { setShowCreateMenu(false); setPanel('create'); }}>新建文件夹</button>
          </div>}
        </div>
        <span aria-hidden className="toolbar-divider"/>
        {selectedPaths.length > 0 && <span className="mr-1 self-center text-xs text-slate-500">已选 {selectedPaths.length}</span>}
        <button disabled={selectedPaths.length !== 1} title={selectedPaths.length === 1 ? '重命名' : '请选择一个文件或文件夹'} onClick={() => beginInlineRename(selectedPaths[0])} className="project-action-button"><Edit size={16}/>重命名</button>
        <button disabled={!selectedPaths.length} title={selectedPaths.length ? '剪切' : '请先选择文件'} onClick={() => runFileOperation('cut')} className="project-action-button"><Cut size={16}/>剪切</button>
        <button disabled={!selectedPaths.length} title={selectedPaths.length ? '复制' : '请先选择文件'} onClick={() => runFileOperation('copy')} className="project-action-button"><Copy size={16}/>复制</button>
        <button title="粘贴到当前文件夹" onClick={() => runFileOperation('paste')} className="project-action-button"><ClipboardPaste size={16}/>粘贴</button>
        <button disabled={!selectedPaths.length} title={selectedPaths.length ? '删除（移入回收站）' : '请先选择文件'} onClick={() => runFileOperation('trash')} className="project-action-button project-action-danger"><Trash2 size={16}/>删除</button>
        <button disabled={!selectedPaths.length} title="退出选择模式" onClick={() => setSelectedPaths([])} className="project-action-button"><X size={16}/>退出选择</button>
        <span aria-hidden className="toolbar-divider"/>
        <div className="contents">
          <button onClick={() => togglePanel('import')} title="从 SD 卡导入" aria-label="从 SD 卡导入" className="project-action-button"><MemoryStick size={16}/>从 SD 卡导入</button>
          <button onClick={() => togglePanel('broll')} title="导入花絮" aria-label="导入花絮" className="project-action-button"><FolderInput size={16}/>导入花絮</button>
          <button onClick={() => togglePanel('match')} title="从文件名选片" aria-label="从文件名选片" className="project-action-button"><FileText size={16}/>从文件名选片</button>
          <button aria-disabled={!canSelectMedia} title={canSelectMedia ? '选片' : selectedPaths.length ? '只能选择媒体文件' : '请先选择媒体文件'} onClick={selectMediaFiles} className={`project-action-button ${canSelectMedia ? '' : 'cursor-not-allowed opacity-50'}`}><CheckCircle2 size={16}/>选片</button>
        </div>
        <div className="contents">
          <button onClick={() => togglePanel('compare')} title="对比图片" aria-label="对比图片" className="project-action-button"><FileDiff size={16}/>对比图片</button>
        </div>
      </div>

      {message && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">{message}</div>}
      {panel === 'import' && <CollapsiblePanel title="从 SD 卡导入" onClose={() => setPanel(null)}><p className="mb-4 text-sm text-slate-500">导入的文件会直接整理到当前项目“{project.name}”中。</p><ImportCard config={importConfig} drives={drives} destinationPath={project.path} onImportConfigChange={onImportConfigChange} onImportComplete={markInProgress}/></CollapsiblePanel>}
      {panel === 'broll' && <CollapsiblePanel title="导入花絮" onClose={() => setPanel(null)}><p className="text-sm text-slate-500">选择要保留的花絮媒体，软件会复制到当前项目的“花絮”文件夹。</p><button onClick={importBroll} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">选择花絮文件</button></CollapsiblePanel>}
      {panel === 'match' && <CollapsiblePanel title="从文件名选片" onClose={() => setPanel(null)}><MatchView embedded config={matchConfig} projectPath={project.path} folderOptions={folders} onUpdateConfig={onMatchConfigChange}/></CollapsiblePanel>}
      {panel === 'cache' && <CollapsiblePanel title="缩略图缓存" onClose={() => setPanel(null)}><MediaCacheSettings config={mediaCacheConfig} onChange={onMediaCacheConfigChange}/></CollapsiblePanel>}
      {panel === 'create' && <div className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/40 p-4"><div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-4 flex items-center justify-between"><h3 className="font-bold text-slate-800">新建文件夹</h3><button onClick={() => { setPanel(null); setProgressName(''); }}><X size={18}/></button></div><p className="mb-3 text-sm text-slate-500">输入文件夹名称后，会在当前项目中新建同名文件夹。</p><input autoFocus value={progressName} onChange={event => setProgressName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') createFolder(); }} placeholder="文件夹名称" className="form-input"/><div className="mt-4 flex justify-end gap-2"><button onClick={() => { setPanel(null); setProgressName(''); }} className="dialog-secondary">取消</button><button onClick={createFolder} disabled={!progressName.trim()} className="dialog-primary">创建文件夹</button></div></div></div>}
      {panel === 'compare' && <CollapsiblePanel title="对比图片" onClose={() => setPanel(null)}><RenameView embedded folderOptions={folders}/></CollapsiblePanel>}
      {panel === 'trash' && <CollapsiblePanel title="移入回收站" onClose={() => setPanel(null)}><p className="text-sm text-slate-500">项目“{project.name}”及其全部内容将移入系统回收站。</p><button onClick={moveToTrash} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">确认移入回收站</button></CollapsiblePanel>}

      <section className="flex min-h-[220px] min-w-0 flex-1 flex-col">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-sm text-slate-500">
            <button type="button" onClick={navigateBack} disabled={!directoryHistory.back.length} title="后退" aria-label="后退" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowLeft size={17}/></button>
            <button type="button" onClick={navigateForward} disabled={!directoryHistory.forward.length} title="前进" aria-label="前进" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowRight size={17}/></button>
            <span className="mr-1 inline-flex h-8 shrink-0 items-center font-bold leading-none text-slate-800">项目</span>
            {breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.relativePath || 'root'}><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><button onClick={() => navigateToDirectory(crumb.relativePath)} title={`进入 ${crumb.label}`} className={`inline-flex h-8 min-w-0 items-center truncate rounded border border-transparent px-1.5 text-sm leading-none transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 ${index === breadcrumbs.length - 1 ? 'font-bold text-slate-700' : ''}`}>{crumb.label}</button></React.Fragment>)}
          </div>
          <div className="flex items-center gap-1"><button onClick={() => setViewMode('grid')} title="图标模式" className={`rounded-md p-1.5 ${viewMode === 'grid' ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}><Grid2X2 size={17}/></button><button onClick={() => setViewMode('list')} title="列表模式" className={`rounded-md p-1.5 ${viewMode === 'list' ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}><LayoutList size={17}/></button>{viewMode === 'grid' && <input aria-label="图标大小" title="图标大小（最大为当前窗口宽度）" type="range" min="10" max="100" step="2" value={gridIconSize} onChange={event => setGridIconSize(Number(event.target.value))} className="ml-2 w-24 accent-blue-600"/>}<button onClick={refresh} title="刷新" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><RefreshCw size={17}/></button></div>
        </div>
        <div ref={filesSurfaceRef} onPointerDown={startSelectionDrag} onPointerMove={updateSelectionDrag} onPointerUp={finishSelectionDrag} onPointerCancel={finishSelectionDrag} className="relative min-h-[220px] flex-1 select-none">
          {selectionBox && <div className="pointer-events-none absolute z-20 border border-blue-500 bg-blue-400/15" style={selectionBox}/>}
          {fileEntries.length ? viewMode === 'list' ? <div className="min-w-[620px] border-y border-slate-200 text-sm">
            <div className="file-list-row file-list-heading text-xs font-medium text-slate-500"><span>名称</span><span>修改日期</span><span>类型</span><span>大小</span></div>
            {renderedFileEntries.map(entry => <div role="button" tabIndex={0} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={() => handleEntryClick(entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`file-list-row group w-full cursor-default border-t border-slate-200 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) ? 'bg-blue-50' : ''}`}>
              <span className="flex min-w-0 items-center gap-2.5"><span onClick={event => { event.stopPropagation(); toggleSelected(entry.relativePath); }} className={`file-select-box ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-transparent'} flex h-4 w-4 shrink-0 items-center justify-center rounded border`}><CheckSquare size={12}/></span><span className="relative flex h-9 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-100">{renderEntryIcon(entry)}</span>{renderEntryName(entry)}</span>
              <span className="text-slate-500">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '…'}</span>
              <span className="uppercase text-slate-500">{entry.kind === 'folder' ? '文件夹' : entry.kind === 'raw' ? `RAW · ${entry.extension.slice(1)}` : entry.kind === 'video' ? `视频 · ${entry.extension.slice(1)}` : entry.extension.slice(1) || '文件'}</span>
              <span className="text-slate-500">{entry.kind === 'folder' ? '' : entry.size >= 0 ? formatFileSize(entry.size) : '…'}</span>
            </div>)}
          </div> : <div className="grid w-full gap-3" style={{ gridTemplateColumns: `repeat(${gridColumnCount}, minmax(0, 1fr))` }}>{renderedFileEntries.map(entry => <div role="button" tabIndex={0} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={() => handleEntryClick(entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) ? 'bg-blue-50 ring-1 ring-blue-400' : ''}`}><span onClick={event => { event.stopPropagation(); toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span><div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-slate-100">{renderEntryIcon(entry, true)}</div>{renderEntryName(entry, true)}<p className="mt-0.5 text-[10px] uppercase text-slate-400">{entry.kind === 'folder' ? '文件夹' : entry.extension.slice(1) || '文件'}</p></div>)}</div> : <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">当前文件夹为空。</p>}
          {renderedEntryCount < fileEntries.length && <div ref={loadMoreEntriesRef} className="h-8 py-2 text-center text-xs text-slate-400">正在加载更多文件…</div>}
        </div>
      </section>

      <section className="hidden rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-slate-800">项目文件夹</h3><span className="text-sm text-slate-500">{folders.length} 个</span></div>
        {folders.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{folders.map(folder => <button key={folder.path} onClick={() => openFolder(folder.name)} title={`打开 ${folder.name}`} className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-blue-50"><Folder size={64} strokeWidth={1.5} fill="currentColor" className="text-blue-500 drop-shadow-sm transition-transform group-hover:scale-105"/><span className="max-w-full truncate text-sm font-medium text-slate-700">{folder.name}</span></button>)}</div> : <p className="py-8 text-center text-sm text-slate-400">当前项目还没有子文件夹。</p>}
      </section>

      {confirmDelete && <div className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/40 p-4"><div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-800">确定要删除项目吗？</h3><button onClick={() => setConfirmDelete(false)}><X size={18}/></button></div><p className="text-sm text-slate-500">删除项目会将项目文件夹“{project.name}”移入回收站。</p><div className="mt-5 flex justify-end gap-2"><button onClick={() => setConfirmDelete(false)} className="dialog-secondary">取消</button><button onClick={async () => { setConfirmDelete(false); await moveToTrash(); }} className="rounded-md bg-red-600 px-3 py-2 text-sm font-bold text-white hover:bg-red-500">删除项目</button></div></div></div>}
    </div>
  );
};
const systemFileIconCache = new Map<string, Promise<string | undefined>>();
const SystemFileIcon = ({ filePath, size }: { filePath: string; size: number }) => {
  const [dataUrl, setDataUrl] = useState<string>();
  useEffect(() => {
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const extension = fileName.includes('.') ? `.${fileName.split('.').pop()?.toLowerCase()}` : fileName.toLowerCase();
    let request = systemFileIconCache.get(extension);
    if (!request) {
      request = window.electronAPI.getFileIcon(filePath).then(result => result.success ? result.dataUrl : undefined);
      systemFileIconCache.set(extension, request);
    }
    let active = true;
    request.then(icon => { if (active) setDataUrl(icon); });
    return () => { active = false; };
  }, [filePath]);
  return dataUrl ? <img src={dataUrl} alt="" draggable={false} style={{ width: size, height: size }} className="object-contain"/> : <File size={size} className="text-slate-400"/>;
};
const MediaThumbnail = ({ entry, cacheConfig, requestedSize, large = false }: { entry: ProjectFileEntry; cacheConfig: AppConfig['mediaCache']; requestedSize: number; large?: boolean }) => {
  const videoPreviewSize = Math.max(320, Math.min(1600, requestedSize));
  const [preview, setPreview] = useState<{ url?: string; size: number }>({ url: entry.previewUrl, size: entry.previewUrl ? 320 : 0 });
  const [videoFrames, setVideoFrames] = useState<string[]>([]);
  const [videoPreviewComplete, setVideoPreviewComplete] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (entry.kind === 'video' || preview.size >= requestedSize || !container.current) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      setLoading(true);
      requestThumbnail(() => window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw', cacheConfig, requestedSize))
        .then(result => { if (active && result.success) setPreview(current => ({ url: result.previewUrl || current.url, size: requestedSize })); })
        .finally(() => { if (active) setLoading(false); });
    }, { rootMargin: '240px' });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [entry.path, entry.kind, preview.url, preview.size, cacheConfig, requestedSize]);
  useEffect(() => {
    if (entry.kind !== 'video' || !container.current) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      const loadCover = async () => {
        setLoading(true);
        let hasShellPreview = false;
        try {
          const shellResult = await requestThumbnail(() => window.electronAPI.getMediaThumbnail(entry.path, 'video', cacheConfig, videoPreviewSize));
          hasShellPreview = Boolean(shellResult.success && shellResult.previewUrl);
          if (active && shellResult.previewUrl) {
            setPreview({ url: shellResult.previewUrl, size: videoPreviewSize });
            // Explorer's cached frame is ready; do not cover it with a spinner
            // while the low-priority FFmpeg metadata/cover task catches up.
            setLoading(false);
          }
        } catch (error) {
          console.error(`Windows 视频缩略图缓存读取失败：${entry.name}`, error);
        }
        if (!active) return;
        const cached = await window.electronAPI.getVideoHoverPreview(entry.path, cacheConfig, videoPreviewSize, true, false);
        const result = cached.cached ? cached : await window.electronAPI.getVideoHoverPreview(entry.path, cacheConfig, videoPreviewSize, false, false);
        if (!active) return;
        if (result.success && result.frameUrls.length) { setVideoFrames(result.frameUrls); setVideoDuration(result.duration); setVideoPreviewComplete(result.complete); }
        else if (!result.success && !hasShellPreview) console.error(`视频预览图生成失败：${entry.name}`, result.error || '未知错误');
        setLoading(false);
      };
      void loadCover();
    }, { rootMargin: '1200px' });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [entry.kind, entry.path, entry.name, cacheConfig, videoPreviewSize]);
  useEffect(() => {
    if (!hovering || entry.kind !== 'video' || videoPreviewComplete) return;
    let active = true;
    let retryTimer: number | undefined;
    const requestHoverFrames = () => {
      if (!videoFrames.length) setLoading(true);
      window.electronAPI.getVideoHoverPreview(entry.path, cacheConfig, videoPreviewSize, false, true).then(result => {
        if (!active) return;
        if (result.success) { setVideoFrames(result.frameUrls); setVideoDuration(result.duration); setVideoPreviewComplete(result.complete); }
        else console.error(`视频抽样预览失败：${entry.name}`, result.error || '未知错误');
        if (result.success && !result.complete) retryTimer = window.setTimeout(requestHoverFrames, 300);
      }).finally(() => { if (active) setLoading(false); });
    };
    const timer = window.setTimeout(requestHoverFrames, 180);
    return () => { active = false; window.clearTimeout(timer); window.clearTimeout(retryTimer); };
  }, [entry.kind, entry.path, entry.name, hovering, videoFrames.length, videoPreviewComplete, cacheConfig]);
  useEffect(() => {
    if (entry.kind !== 'video' || !videoFrames.length || videoPreviewComplete) return;
    let active = true;
    const refreshProgress = () => window.electronAPI.getVideoHoverPreview(entry.path, cacheConfig, videoPreviewSize, true, false).then(result => {
      if (!active || !result.success || !result.cached) return;
      setVideoFrames(current => result.frameUrls.length >= current.length ? result.frameUrls : current);
      setVideoDuration(result.duration);
      setVideoPreviewComplete(result.complete);
    });
    const timer = window.setInterval(refreshProgress, 250);
    return () => { active = false; window.clearInterval(timer); };
  }, [entry.kind, entry.path, videoFrames.length, videoPreviewComplete, cacheConfig]);
  useEffect(() => {
    if (!hovering || videoFrames.length < 2) { setFrameIndex(0); return; }
    const timer = window.setInterval(() => setFrameIndex(index => (index + 1) % videoFrames.length), 700);
    return () => window.clearInterval(timer);
  }, [hovering, videoFrames.length]);
  const durationLabel = videoDuration > 0 ? `${Math.floor(videoDuration / 3600) ? `${Math.floor(videoDuration / 3600)}:` : ''}${String(Math.floor(videoDuration % 3600 / 60)).padStart(2, '0')}:${String(Math.floor(videoDuration % 60)).padStart(2, '0')}` : '';
  const displayedUrl = entry.kind === 'video' && videoFrames.length ? videoFrames[hovering ? frameIndex : 0] : preview.url;
  return <span ref={container} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)} className="relative flex h-full w-full items-center justify-center">{displayedUrl ? <img src={displayedUrl} alt="" className="h-full w-full object-cover"/> : <FileImage size={large ? 42 : 23} className="text-slate-400"/>}{loading && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-900/25"><Loader2 size={large ? 24 : 16} className="animate-spin text-white drop-shadow"/><span className="sr-only">正在加载预览</span></span>}{entry.kind === 'video' && durationLabel && <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-bold leading-4 text-white shadow">{durationLabel}</span>}</span>;
};

const MediaCacheSettings = ({ config, onChange }: { config: AppConfig['mediaCache']; onChange: (config: AppConfig['mediaCache']) => void }) => {
  const [info, setInfo] = useState({ path: '', sizeBytes: 0, fileCount: 0 });
  const [busy, setBusy] = useState(false);
  const refreshInfo = async (nextConfig = config) => {
    const result = await window.electronAPI.getMediaCacheInfo(nextConfig);
    if (result.success) setInfo(result);
  };
  useEffect(() => { refreshInfo(); }, [config.directory, config.maxSizeGB]);
  const chooseDirectory = async () => {
    const result = await window.electronAPI.chooseCacheDirectory();
    if (!result.path) return;
    const next = { ...config, directory: result.path };
    onChange(next);
    refreshInfo(next);
  };
  const clear = async () => {
    setBusy(true);
    await window.electronAPI.clearMediaCache(config);
    await refreshInfo();
    setBusy(false);
  };
  const sizeText = info.sizeBytes >= 1024 * 1024 * 1024 ? `${(info.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB` : `${Math.round(info.sizeBytes / 1024 / 1024)} MB`;
  return <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-end"><div className="space-y-4"><div><label className="form-label">最大缓存容量</label><select value={config.maxSizeGB} onChange={event => onChange({ ...config, maxSizeGB: Number(event.target.value) })} className="form-input max-w-xs"><option value={1}>1 GB</option><option value={5}>5 GB</option><option value={10}>10 GB</option><option value={20}>20 GB</option></select><p className="mt-2 text-xs text-slate-500">超过上限时，会自动清理最久未使用的 RAW 预览缩略图。</p></div><div><label className="form-label">缓存目录</label><div className="flex gap-2"><input readOnly value={info.path || config.directory || '默认应用缓存目录'} className="form-input min-w-0 font-mono text-xs"/><button onClick={chooseDirectory} className="dialog-secondary shrink-0">选择目录</button></div></div></div><div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm"><p className="font-bold text-slate-800">当前缓存：{sizeText}</p><p className="mt-1 text-xs text-slate-500">{info.fileCount} 个预览文件</p><button onClick={clear} disabled={busy} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Eraser size={14}/>{busy ? '正在清理…' : '清理缓存'}</button></div></div>;
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
        <section className="rounded-xl border border-blue-100 bg-blue-50 p-4"><h4 className="text-base font-bold text-slate-800">项目与联系</h4><p className="mt-1">如果你有任何建议或遇到问题，欢迎通过邮箱联系我，也可以前往项目仓库反馈。</p><div className="mt-3 flex flex-col items-start gap-2 leading-5"><button type="button" onClick={() => window.electronAPI.openExternal('https://github.com/akiyastudio/photoflow')} className="inline-flex items-center gap-1.5 break-all text-left font-medium text-blue-600 hover:underline">https://github.com/akiyastudio/photoflow <ExternalLink size={13} className="shrink-0"/></button><button type="button" onClick={() => window.electronAPI.openExternal('mailto:akiyastudio@qq.com')} className="inline-flex items-center gap-1.5 font-medium text-blue-600 hover:underline">akiyastudio@qq.com <ExternalLink size={13}/></button></div></section>
        <section className="border-t border-slate-200 pt-5"><h4 className="text-base font-bold text-slate-800">使用提示</h4><p className="mt-1">软件尚未经过充分测试。使用前请备份重要数据；作者不对使用本软件造成的损失负责。</p></section>
      </div>
    </section>
  </div>;
};

const RootApp = () => <AppErrorBoundary><App/></AppErrorBoundary>;
export default RootApp;
