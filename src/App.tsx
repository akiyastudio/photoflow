import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  FolderInput,
  FolderPlus,
  Folder,
  FolderOpen,
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
  MemoryStick,
  LayoutList,
  Grid2X2,
  FileText,
  Copy,
  Scissors as Cut,
  ClipboardPaste,
  CheckSquare,
  ArrowLeft,
  ArrowRight,
  Camera,
  Aperture,
  Timer,
  Gauge,
  Ruler,
  Calendar,
  Activity,
  Volume2,
  PanelLeftClose,
  PanelLeftOpen,
  Home,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  GripVertical
} from 'lucide-react';
import { TaskProgress } from './components/TaskStatus';
import { ProjectNavigator } from './components/ProjectNavigator';
import { PROJECT_STATUS_LABELS } from './types';
import type { AppConfig, HomeCardId, LogEntry, MediaMetadataField, ProjectFileEntry, ProjectFileOperationProgress, ToolType, WorkspaceProject } from './types';

const DEFAULT_HOME_ORDER: HomeCardId[] = ['birthday', 'import', 'research', 'converter'];
const IMAGE_SELECTION_FOLDER_NAME = '图片选片';
const VIDEO_SELECTION_FOLDER_NAME = '视频选片';

// Source decoding is scheduled in the Electron main process. Renderer calls
// only probe the memory/disk layers and enqueue or reprioritize a task.
const requestThumbnail = <T,>(task: () => Promise<T>) => task();
const normalizeMediaCacheSize = (value: unknown, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};

const METADATA_GROUP_PRIORITY = ['ExifIFD', 'ExifIFD1', 'IFD0', 'Composite', 'QuickTime', 'Track1', 'XMP', 'File', 'System', '其他'];
const pickMetadataValue = (fields: MediaMetadataField[], ...names: string[]) => {
  for (const name of names) {
    const matches = fields.filter(field => field.name === name);
    const preferred = [...matches].sort((left, right) => {
      const leftRank = METADATA_GROUP_PRIORITY.indexOf(left.group);
      const rightRank = METADATA_GROUP_PRIORITY.indexOf(right.group);
      return (leftRank < 0 ? 999 : leftRank) - (rightRank < 0 ? 999 : rightRank);
    })[0];
    if (preferred?.value) return preferred.value;
  }
  return undefined;
};
const formatCaptureDate = (value?: string) => value
  ? value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(/([+-]\d{2}):?(\d{2})$/, ' $1:$2')
  : undefined;
const formatShutterSpeed = (value?: string) => {
  if (!value) return undefined;
  if (/\//.test(value)) return value;
  const seconds = Number(value.replace(/\s*s(?:ec(?:onds?)?)?$/i, '').trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return value;
  if (seconds < 1) return `1/${Math.max(1, Math.round(1 / seconds))} 秒`;
  return `${Number(seconds.toFixed(3))} 秒`;
};

const captureDateTimeRequestCache = new Map<string, Promise<string | undefined>>();
const requestCaptureDateTime = (entry: ProjectFileEntry) => {
  const cacheKey = `${entry.path}|${entry.updatedAt}`;
  const cached = captureDateTimeRequestCache.get(cacheKey);
  if (cached) return cached;
  const request = window.electronAPI.getMediaMetadata(entry.path).then(result => {
    if (!result.success) return undefined;
    return formatCaptureDate(pickMetadataValue(result.fields, 'DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate', 'CreationDate'));
  });
  if (captureDateTimeRequestCache.size >= 256) captureDateTimeRequestCache.delete(captureDateTimeRequestCache.keys().next().value as string);
  captureDateTimeRequestCache.set(cacheKey, request);
  return request;
};

const clampNumber = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
type ProjectColumnWidths = { files: number; preview: number; metadata: number };
const fitProjectColumnWidths = (preferred: ProjectColumnWidths, containerWidth: number, previewOpen: boolean, metadataOpen: boolean) => {
  const handleCount = Number(previewOpen) + Number(metadataOpen);
  const available = Math.max(0, containerWidth - handleCount);
  const preferredTotal = preferred.files + (previewOpen ? preferred.preview : 0) + (metadataOpen ? preferred.metadata : 0);
  if (!previewOpen && !metadataOpen) return { ...preferred, files: available };
  if (preferredTotal <= 0) return preferred;
  if (available >= preferredTotal) {
    // Side panes keep their preferred positions. Any newly available room is
    // assigned to the file browser first.
    return { ...preferred, files: preferred.files + available - preferredTotal };
  }
  const scale = available / preferredTotal;
  return {
    files: preferred.files * scale,
    preview: previewOpen ? preferred.preview * scale : preferred.preview,
    metadata: metadataOpen ? preferred.metadata * scale : preferred.metadata
  };
};
const readStoredNumber = (key: string, fallback: number) => {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

const ColumnResizeHandle = ({ onDrag, label }: { onDrag: (deltaX: number) => void; label: string }) => {
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    let previousX = event.clientX;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - previousX;
      previousX = moveEvent.clientX;
      onDrag(deltaX);
    };
    const finish = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onDrag(event.key === 'ArrowLeft' ? -16 : 16);
  };
  return <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} className="column-resize-handle"/>;
};

// --- 类型定义 ---

const isMac = window.navigator.userAgent.includes('Mac');

const DEFAULT_CONFIG = (userPath: string): AppConfig => ({
  theme: 'system',
  workspacePath: '',
  homeOrder: DEFAULT_HOME_ORDER,
  birthdayEnabled: true,
  mediaCache: {
    maxSizeGB: 50,
    directory: '',
    autoCleanup30Days: false
  },
  smartImport: {
    autoStart: false,
    sdPath: isMac ? "/Volumes" : "H:/",
    sdPaths: [isMac ? "/Volumes" : "H:/"],
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
  type: 'log' | 'error' | 'progress' | 'status' | 'ask_user' | 'success' | 'warning' | 'preview';
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
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [aboutTabOpen, setAboutTabOpen] = useState(false);
  const [showWorkspaceSetup, setShowWorkspaceSetup] = useState(false);

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{version: string, url: string, notes: string} | null>(null);
  const [selectedProject, setSelectedProject] = useState<WorkspaceProject | null>(null);
  const [openProjects, setOpenProjects] = useState<WorkspaceProject[]>([]);
  const [projectOperations, setProjectOperations] = useState<Record<string, 'import' | 'broll' | 'match' | null>>({});
  const [, setProjectDestination] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState('');
  const [fileOperationProgress, setFileOperationProgress] = useState<ProjectFileOperationProgress | null>(null);
  const [isCancellingFileOperation, setIsCancellingFileOperation] = useState(false);
  const noticeTimerRef = useRef<number>();
  const lastNoticeRef = useRef({ message: '', shownAt: 0 });
  const [homeOrder, setHomeOrder] = useState<HomeCardId[]>(DEFAULT_HOME_ORDER);
  const [draggedHomeCard, setDraggedHomeCard] = useState<HomeCardId | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber('photoflow:sidebar-width', 256));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('photoflow:sidebar-collapsed') === 'true');
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-width', String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    window.electronAPI.isWindowMaximized().then(setWindowMaximized);
    return window.electronAPI.onWindowMaximizedChange(setWindowMaximized);
  }, []);

  useEffect(() => {
    const measureViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', measureViewport);
    return () => window.removeEventListener('resize', measureViewport);
  }, []);

  useEffect(() => {
    if (!config?.mediaCache.autoCleanup30Days) return;
    let active = true;
    const storageKey = `photoflow:auto-cache-cleanup:${config.mediaCache.directory || 'default'}`;
    const cleanExpiredCache = async () => {
      const lastRun = Number(window.localStorage.getItem(storageKey)) || 0;
      if (Date.now() - lastRun < 24 * 60 * 60 * 1000) return;
      const result = await window.electronAPI.clearMediaCache(config.mediaCache, 30);
      if (active && result.success) window.localStorage.setItem(storageKey, String(Date.now()));
    };
    void cleanExpiredCache();
    const timer = window.setInterval(() => void cleanExpiredCache(), 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [config?.mediaCache.autoCleanup30Days, config?.mediaCache.directory, config?.mediaCache.maxSizeGB]);
  // Keep the user's preferred width untouched while the window is compact.
  // The rendered width may shrink temporarily and returns automatically when
  // the window is enlarged again.
  const renderedSidebarWidth = clampNumber(sidebarWidth, 128, Math.min(420, Math.max(128, viewportWidth - 700)));

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
            const savedSdPaths = (Array.isArray(fileConfig.smartImport?.sdPaths) && fileConfig.smartImport.sdPaths.length ? fileConfig.smartImport.sdPaths : fileConfig.smartImport?.sdPath ? [fileConfig.smartImport.sdPath] : []).map((drive: string) => isMac ? drive : drive.replace(/\\/g, '/').replace(/\/DCIM\/?$/i, '/'));
            let normalizedConfig = { ...fileConfig, theme: fileConfig.theme ?? 'system', workspacePath: fileConfig.workspacePath?.trim() ?? '', homeOrder: Array.isArray(fileConfig.homeOrder) ? fileConfig.homeOrder : DEFAULT_HOME_ORDER, birthdayEnabled: fileConfig.birthdayEnabled ?? true, mediaCache: { maxSizeGB: normalizeMediaCacheSize(fileConfig.mediaCache?.maxSizeGB), directory: fileConfig.mediaCache?.directory ?? '', autoCleanup30Days: fileConfig.mediaCache?.autoCleanup30Days ?? false }, smartImport: { ...fileConfig.smartImport, sdPath: savedSdPaths[0] || '', sdPaths: savedSdPaths, backupEnabled: false, generateVideoPreview: fileConfig.smartImport?.generateVideoPreview ?? false, splitLargeFiles: fileConfig.smartImport?.splitLargeFiles ?? false }, brollImport: { splitLargeFiles: fileConfig.brollImport?.splitLargeFiles ?? false, clearSource: fileConfig.brollImport?.clearSource ?? true }, imageConversion: { jpgQuality: fileConfig.imageConversion?.jpgQuality ?? 100 }, smartMatch: { imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME, videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME, imageSourceFolderName: !configuredImageSource || configuredImageSource.toLowerCase() === 'raw' ? 'raw' : configuredImageSource, videoSourceFolderName: !configuredVideoSource || configuredVideoSource.toLowerCase() === 'mov' ? 'mov' : configuredVideoSource }, research: { ...fileConfig.research, defaultDir: downloadPath, sensitivity: researchSensitivity, minDuration: fileConfig.research?.minDuration ?? 0.2 } } as AppConfig;
            if (normalizedConfig.workspacePath) {
              const workspace = await window.electronAPI.getWorkspaceProjects(normalizedConfig.workspacePath);
              if (workspace.success && workspace.root) normalizedConfig = { ...normalizedConfig, workspacePath: workspace.root };
            } else {
              setShowWorkspaceSetup(true);
            }
            setConfig(normalizedConfig);
            if ((fileConfig.workspacePath !== normalizedConfig.workspacePath || fileConfig.birthdayEnabled === undefined || !Array.isArray(fileConfig.smartImport?.sdPaths) || fileConfig.mediaCache?.maxSizeGB !== normalizedConfig.mediaCache.maxSizeGB || fileConfig.mediaCache?.autoCleanup30Days === undefined || fileConfig.smartImport.backupEnabled || fileConfig.smartImport?.splitLargeFiles === undefined || !fileConfig.brollImport || !fileConfig.imageConversion || fileConfig.smartMatch?.imageDestFolderName !== IMAGE_SELECTION_FOLDER_NAME || fileConfig.smartMatch?.videoDestFolderName !== VIDEO_SELECTION_FOLDER_NAME || configuredImageSource !== normalizedConfig.smartMatch.imageSourceFolderName || configuredVideoSource !== normalizedConfig.smartMatch.videoSourceFolderName || !fileConfig.research?.sensitivity) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
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
          openProjectTab(result.project, null, selectedProject?.path);
        }
        window.dispatchEvent(new Event('workspace-projects-changed'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showNotice, selectedProject?.path]);

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
          return true;
        } else {
          window.electronAPI.reportRendererError('保存设置失败', result.error);
          showNotice(`保存设置失败：${result.error || '未知错误'}`, 5000);
          return false;
        }
      }
      return true;
    } catch (error) {
      window.electronAPI.reportRendererError('保存设置异常', error instanceof Error ? error.stack : String(error));
      showNotice(`保存设置失败：${error instanceof Error ? error.message : String(error)}`, 5000);
      return false;
    }
  };

  const handleWorkspaceSetup = async (newConfig: AppConfig) => {
    await handleConfigUpdate(newConfig);
    setShowWorkspaceSetup(false);
  };
  const openProjectTab = (project: WorkspaceProject, operation: 'import' | 'broll' | 'match' | null = null, replacePath?: string) => {
    setOpenProjects(current => {
      const prepared = replacePath && replacePath !== project.path ? current.filter(item => item.path !== replacePath) : current;
      return prepared.some(item => item.path === project.path) ? prepared.map(item => item.path === project.path ? project : item) : [...prepared, project];
    });
    setProjectOperations(current => {
      const next = { ...current };
      const preservedOperation = replacePath ? next[replacePath] ?? null : operation;
      if (replacePath && replacePath !== project.path) delete next[replacePath];
      next[project.path] = operation ?? preservedOperation;
      return next;
    });
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project');
  };
  const showHomeTab = () => {
    setSelectedProject(null);
    setProjectDestination(null);
    setActiveTab('home');
  };
  const openUtilityTab = (tab: 'settings' | 'about') => {
    if (tab === 'settings') setSettingsTabOpen(true);
    else setAboutTabOpen(true);
    setActiveTab(tab);
  };
  const closeUtilityTab = (tab: 'settings' | 'about') => {
    if (tab === 'settings') setSettingsTabOpen(false);
    else setAboutTabOpen(false);
    if (activeTab === tab) showHomeTab();
  };
  const closeProjectTab = (projectPath: string) => {
    const closingIndex = openProjects.findIndex(project => project.path === projectPath);
    const remaining = openProjects.filter(project => project.path !== projectPath);
    setOpenProjects(remaining);
    setProjectOperations(current => {
      const next = { ...current };
      delete next[projectPath];
      return next;
    });
    if (selectedProject?.path !== projectPath) return;
    const nextProject = remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)];
    if (nextProject) openProjectTab(nextProject, projectOperations[nextProject.path] ?? null);
    else showHomeTab();
  };
  const handleHomeImportComplete = async () => {
    if (!config) return;
    const result = await window.electronAPI.archiveImportedProjects(config.workspacePath);
    if (!result.success) { showNotice(`整理导入项目失败：${result.error || '未知错误'}`, 5000); return; }
    if (result.projects.length === 1) {
      openProjectTab(result.projects[0]);
    }
    window.dispatchEvent(new Event('workspace-projects-changed'));
  };
  // 等待配置加载完成再渲染主界面
  const handleProjectAction = (action: 'import' | 'broll' | 'match', project: WorkspaceProject) => {
    openProjectTab(project, action);
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
    <div className="flex h-screen w-full flex-col overflow-hidden bg-slate-50 text-slate-900 font-sans selection:bg-blue-500/30">
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

      <header className="app-titlebar relative z-50 flex h-10 shrink-0 items-stretch border-b border-slate-200 bg-white">
        <div style={{ width: sidebarCollapsed ? 48 : renderedSidebarWidth + 1 }} className="app-titlebar-brand-region flex shrink-0 items-center border-r border-slate-200 px-2 transition-[width] duration-200">
          <button type="button" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开项目栏' : '折叠项目栏'} title={sidebarCollapsed ? '展开项目栏' : '折叠项目栏'} className="app-titlebar-control mr-1 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            {sidebarCollapsed ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}
          </button>
          <div title="拖动窗口" className={`flex min-w-0 items-center gap-2 px-1.5 py-1 ${sidebarCollapsed || renderedSidebarWidth < 190 ? 'hidden' : ''}`}>
            <img src="./app-logo.svg" className="brand-logo brand-logo-light-only h-5 w-5 shrink-0" alt="" />
            <img src="./app-logo-dark.svg" className="brand-logo brand-logo-dark-only h-5 w-5 shrink-0" alt="" />
            <span className="truncate text-sm font-bold text-slate-800">照片流</span>
            <span className="shrink-0 font-mono text-[10px] text-slate-400">v26.7.19</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1">
          <div className="scrollbar-hide flex min-w-0 shrink items-end gap-0 overflow-x-auto px-2 pt-1.5">
            <button type="button" onClick={showHomeTab} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[92px] max-w-[180px] items-center gap-2 rounded-t-lg border px-3 text-xs font-medium transition ${activeTab === 'home' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
              <Home size={14} className="shrink-0"/><span className="truncate">主页</span>
            </button>
            {openProjects.map(project => <div key={project.path} title={project.name} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[120px] max-w-[220px] items-center rounded-t-lg border text-xs font-medium transition ${selectedProject?.path === project.path && activeTab === 'project' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
              <button type="button" onClick={() => openProjectTab(project, projectOperations[project.path] ?? null)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Folder size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{project.name}</span></button>
              <button type="button" aria-label={`关闭 ${project.name}`} title={`关闭 ${project.name}`} onClick={() => closeProjectTab(project.path)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
            </div>)}
            {settingsTabOpen && <div className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[108px] max-w-[180px] items-center rounded-t-lg border text-xs font-medium transition ${activeTab === 'settings' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={() => openUtilityTab('settings')} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Settings size={14} className="shrink-0"/><span className="truncate">设置</span></button><button type="button" aria-label="关闭设置" title="关闭设置" onClick={() => closeUtilityTab('settings')} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button></div>}
            {aboutTabOpen && <div className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[108px] max-w-[180px] items-center rounded-t-lg border text-xs font-medium transition ${activeTab === 'about' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={() => openUtilityTab('about')} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><AtSign size={14} className="shrink-0"/><span className="truncate">关于</span></button><button type="button" aria-label="关闭关于" title="关闭关于" onClick={() => closeUtilityTab('about')} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button></div>}
          </div>
          <div aria-label="拖动窗口" className="app-window-drag-region min-w-8 flex-1"/>
        </div>
        <div className="app-titlebar-control flex h-10 w-[138px] shrink-0 items-stretch">
          <button type="button" onClick={() => window.electronAPI.minimizeWindow()} aria-label="最小化" title="最小化" className="window-control-button"><span className="window-glyph window-glyph-minimize"/></button>
          <button type="button" onClick={async () => setWindowMaximized(await window.electronAPI.toggleMaximizeWindow())} aria-label={windowMaximized ? '还原' : '最大化'} title={windowMaximized ? '还原' : '最大化'} className="window-control-button">{windowMaximized ? <span className="window-glyph window-glyph-restore"/> : <span className="window-glyph window-glyph-maximize"/>}</button>
          <button type="button" onClick={() => window.electronAPI.closeWindow()} aria-label="关闭" title="关闭" className="window-control-button window-control-close"><span className="window-glyph window-glyph-close"/></button>
        </div>
      </header>

      {showWorkspaceSetup ? <WorkspaceSetupPage config={config} onSave={handleWorkspaceSetup}/> : <div className="flex min-h-0 flex-1">
      {/* Sidebar */}
      <aside style={{ width: sidebarCollapsed ? 0 : renderedSidebarWidth }} className="relative z-30 flex min-w-0 shrink-0 flex-col overflow-hidden bg-white transition-[width] duration-200">
        <ProjectNavigator
          workspacePath={config.workspacePath}
          selectedProject={selectedProject}
          onSelectProject={(project, replacePath) => openProjectTab(project, null, replacePath)}
          onProjectAction={handleProjectAction}
          onWorkspaceResolved={workspacePath => { if (config.workspacePath.trim() && workspacePath !== config.workspacePath) handleConfigUpdate({ ...config, workspacePath }); }}

        />
        <div className="p-4 border-t border-slate-200">
          <div className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
            <button onClick={() => openUtilityTab('settings')} className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition-all group"><Settings size={18} className="text-slate-400"/><span className="font-medium text-sm">设置</span></button>
            <button
              onClick={() => openUtilityTab('about')}
              className="w-full flex items-center gap-3 border-t border-slate-200 p-3 hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition-all group"
            >
              <AtSign size={18} className="group-hover:rotate-90 transition-transform duration-500 text-slate-400" />
              <span className="font-medium text-sm">关于</span>
            </button>
          </div>
        </div>
      </aside>
      {!sidebarCollapsed && <ColumnResizeHandle label="调整项目栏宽度" onDrag={deltaX => setSidebarWidth(width => clampNumber(width + deltaX, 128, 420))}/>}

      {/* Main Content */}
      <main className={`relative min-w-0 flex-1 bg-slate-50 ${activeTab === 'project' ? 'overflow-hidden p-0' : activeTab === 'settings' || activeTab === 'about' ? 'overflow-auto p-0' : 'overflow-auto p-8'}`}>
        {activeTab === 'home' && <div className="mx-auto max-w-6xl space-y-4">{homeOrder.filter(card => card !== 'birthday' || config.birthdayEnabled).map(card => {
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
        {activeTab === 'settings' && <SettingsPage config={config} onSave={handleConfigUpdate} onNotice={showNotice}/>}
        {activeTab === 'about' && <AboutPage/>}
        {openProjects.map(project => { const active = activeTab === 'project' && selectedProject?.path === project.path; return <div key={project.path} className={active ? 'h-full w-full' : 'hidden'}><ProjectWorkspace active={active} project={project} workspacePath={config.workspacePath} initialPanel={projectOperations[project.path] ?? null} importConfig={config.smartImport} brollConfig={config.brollImport} conversionConfig={config.imageConversion} matchConfig={config.smartMatch} mediaCacheConfig={config.mediaCache} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} onMatchConfigChange={(smartMatch: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch })} onMediaCacheConfigChange={(mediaCache: AppConfig['mediaCache']) => handleConfigUpdate({ ...config, mediaCache })} onNotice={showNotice} onProjectMoved={nextProject => { setOpenProjects(current => current.map(item => item.path === project.path ? nextProject : item)); setProjectOperations(current => { if (nextProject.path === project.path) return current; const next = { ...current, [nextProject.path]: current[project.path] ?? null }; delete next[project.path]; return next; }); setSelectedProject(nextProject); setProjectDestination(nextProject.path); window.dispatchEvent(new Event('workspace-projects-changed')); }} onDeleted={() => { closeProjectTab(project.path); window.dispatchEvent(new Event('workspace-projects-changed')); }} /></div>; })}

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
      </div>}
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
  const selectedDrives = config?.sdPaths?.length ? config.sdPaths : config?.sdPath ? [config.sdPath] : [];

  // 【关键修改】使用 Ref 来做“防抖”锁，防止 SD 卡接触不良导致多次触发 startImport
  const isBusyRef = React.useRef(false);
  const importQueueRef = React.useRef<string[]>([]);
  const currentDriveRef = React.useRef('');
  const startImportRef = React.useRef<(sdPath?: string) => void>(() => undefined);
  const startBatchRef = React.useRef<() => void>(() => undefined);
  const onImportCompleteRef = React.useRef(onImportComplete);
  useEffect(() => { onImportCompleteRef.current = onImportComplete; }, [onImportComplete]);
  const toggleDrive = (sdPath: string) => {
    if (!config || !onImportConfigChange) return;
    const sdPaths = selectedDrives.includes(sdPath) ? selectedDrives.filter(path => path !== sdPath) : [...selectedDrives, sdPath];
    onImportConfigChange({ ...config, sdPath: sdPaths[0] || '', sdPaths });
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
            const nextDrive = importQueueRef.current.shift();
            if (nextDrive) {
              setStatusMsg(`${currentDriveRef.current} 导入完成，接下来导入 ${nextDrive}`);
              setTimeout(() => startImportRef.current(nextDrive), 500);
            } else {
              setStatus('finished');
              setStatusMsg("所选 SD 卡已全部导入完成");
              isBusyRef.current = false; // 【解锁】
              onImportCompleteRef.current?.();
            }
          }
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

  const startImport = (sdPath = selectedDrives[0]) => {
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
    setStatus('importing');
    setProgress(0);
    setLogs([]); // 清空日志准备开始

    const args = [];
    if (config) {
      args.push('--sd_path', sdPath);
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
  startImportRef.current = startImport;

  const startBatchImport = () => {
    if (isBusyRef.current) return;
    const connected = selectedDrives.filter(drive => drives.includes(drive));
    if (!connected.length) {
      setStatusMsg('所选 SD 卡均未连接');
      return;
    }
    importQueueRef.current = connected.slice(1);
    currentDriveRef.current = '';
    startImport(connected[0]);
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
    runCmd('import', args);
  };

  // --- 渲染逻辑 (UI 部分) ---

  if (status === 'idle' || status === 'checking') {
    // 实时判断当前配置的盘符是否插在电脑上
    const connectedDrives = selectedDrives.filter(drive => drives.includes(drive));
    const isConnected = connectedDrives.length > 0;

    // 动态判断显示的副标题
    let displayMsg = statusMsg;
    if (status === 'idle') {
      if (!selectedDrives.length) {
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
              {[...new Set([...selectedDrives, ...drives])].map(drive => <label key={drive} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-slate-50"><input type="checkbox" checked={selectedDrives.includes(drive)} onChange={() => toggleDrive(drive)}/><span className="font-mono">{drive}</span><span className={`ml-auto text-xs ${drives.includes(drive) ? 'text-emerald-600' : 'text-slate-400'}`}>{drives.includes(drive) ? '已连接' : '未连接'}</span></label>)}
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
    const [comparePreview, setComparePreview] = useState<Array<{ source: string; reference: string; target: string; confidence: string; distance: number }>>([]);

    // Python 事件监听
    useEffect(() => {
        if (!window.electronAPI?.onPythonEvent) return;
        const cleanup = window.electronAPI.onPythonEvent((event: PythonEvent) => {
            if (event.scriptName !== 'rename.py') return;
            switch (event.type) {
                case 'preview':
                    setComparePreview(Array.isArray(event.data?.matches) ? event.data.matches : []);
                    break;
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

    const runRename = async (previewOnly = true) => {
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
        if (!previewOnly) setComparePreview([]);
        const args = ['--folder_a', folderA, '--folder_b', folderB];
        if (copyUnmatched) args.push('--copy_unmatched');
        if (previewOnly) args.push('--preview');
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
                        onClick={() => void runRename(true)}
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
            {comparePreview.length > 0 && <section className="rounded-xl border border-blue-200 bg-blue-50 p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-slate-800">匹配预览</h3><p className="mt-1 text-xs text-slate-500">尚未修改文件。请先检查下面的原文件名和目标文件名。</p></div><button type="button" onClick={() => void runRename(false)} disabled={isRunning} className="dialog-primary shrink-0">确认并重命名</button></div><div className="max-h-64 overflow-y-auto rounded-lg border border-blue-100 bg-white">{comparePreview.map((match, index) => <div key={`${match.source}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-0"><span className="truncate text-slate-500" title={match.source}>{match.source}</span><ArrowRight size={13} className="text-slate-300"/><span className="truncate font-medium text-slate-700" title={match.target}>{match.target}</span><span className={`rounded-full px-2 py-0.5 font-bold ${match.confidence === '高' ? 'bg-emerald-50 text-emerald-600' : match.confidence === '中' ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-500'}`}>{match.confidence}</span></div>)}</div></section>}
            <TaskProgress
                logs={logs}
                progress={progress}
                isRunning={isRunning}
                idleMessage={isRunning ? '正在对比…' : '进度'}
                action={<button onClick={() => void runRename(true)} disabled={isRunning || !folderA || !folderB} className={`project-action-button ${isRunning || !folderA || !folderB ? 'cursor-not-allowed opacity-50' : ''}`}>{isRunning ? <Loader2 className="animate-spin" size={16}/> : <FileDiff size={16}/>} {isRunning ? '对比中...' : '预览匹配'}</button>}
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

const WorkspaceFolderPicker = ({ value, onChange }: { value: string; onChange: (path: string) => void }) => {
  const choose = async () => {
    const result = await window.electronAPI.chooseWorkspaceDirectory(value);
    if (!result.cancelled && result.path) onChange(result.path);
  };
  return <div className="flex gap-2"><div title={value || '需选择工作文件夹'} className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-700">{value || '需选择工作文件夹'}</div><button type="button" onClick={() => void choose()} className="dialog-secondary inline-flex shrink-0 items-center gap-2"><FolderOpen size={16}/>选择文件夹</button></div>;
};

const WorkspaceSetupPage = ({ config, onSave }: { config: AppConfig; onSave: (config: AppConfig) => void | Promise<void> }) => {
  const [workspacePath, setWorkspacePath] = useState(config.workspacePath);
  const confirm = async () => {
    const selectedPath = workspacePath.trim();
    if (selectedPath) await onSave({ ...config, workspacePath: selectedPath });
  };
  return <main className="fixed inset-x-0 bottom-0 top-10 z-40 flex items-center justify-center overflow-auto bg-slate-50 p-8"><section className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><FolderOpen size={28}/></div><div className="mt-5 text-center"><h1 className="text-2xl font-bold text-slate-900">选择工作文件夹</h1><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">请选择工作文件夹。选择磁盘根目录时，会在磁盘下创建“照片流”文件夹作为工作目录。</p></div><div className="mt-7"><WorkspaceFolderPicker value={workspacePath} onChange={setWorkspacePath}/></div><div className="mt-7 flex justify-end"><button type="button" onClick={() => void confirm()} disabled={!workspacePath.trim()} className="dialog-primary disabled:cursor-not-allowed disabled:opacity-45">开始使用</button></div></section></main>;
};

const SettingsPage = ({ config, onSave, onNotice }: { config: AppConfig; onSave: (config: AppConfig) => boolean | Promise<boolean>; onNotice: (message: string, duration?: number) => void }) => {
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof AppConfig,>(key: K, value: AppConfig[K]) => setDraft(current => ({ ...current, [key]: value }));
  const save = async () => {
    const workspacePath = draft.workspacePath.trim();
    if (!workspacePath || saving) return;
    setSaving(true);
    try {
      if (await onSave({ ...draft, workspacePath })) onNotice('已保存');
    } finally {
      setSaving(false);
    }
  };
  return <section className="flex min-h-full w-full flex-col bg-white"><header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-100 p-5"><h3 className="flex items-center gap-2 text-xl font-bold text-slate-800"><Settings size={20} className="text-blue-600"/>设置</h3><button type="button" onClick={() => void save()} disabled={!draft.workspacePath.trim() || saving} className="dialog-primary disabled:cursor-not-allowed disabled:opacity-45">{saving ? '保存中…' : '保存设置'}</button></header><div className="mx-auto w-full max-w-4xl space-y-7 p-6">
    <section><h4 className="text-sm font-bold text-slate-800">界面配色</h4><div className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">{([['system', '适应系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([theme, label]) => <button key={theme} onClick={() => update('theme', theme)} className={`rounded-md px-4 py-2 text-sm font-bold transition ${draft.theme === theme ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">工作目录</h4><p className="mt-1 text-sm leading-6 text-slate-500">项目会直接放在选中的客户文件夹中；只有选择磁盘根目录时，才会使用根目录下的“照片流”文件夹。</p><div className="mt-4"><WorkspaceFolderPicker value={draft.workspacePath} onChange={workspacePath => update('workspacePath', workspacePath)}/></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">角色生日</h4><label className="settings-check"><input type="checkbox" checked={draft.birthdayEnabled} onChange={event => update('birthdayEnabled', event.target.checked)}/>在首页显示角色生日</label></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">缩略图缓存</h4><p className="mt-1 text-sm text-slate-500">设置图片、RAW 和视频缩略图缓存的容量与位置，并可按时间清理。</p><div className="mt-4"><MediaCacheSettings config={draft.mediaCache} onChange={mediaCache => update('mediaCache', mediaCache)}/></div></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">PNG 转 JPG</h4><label className="form-label">默认导出 JPG 画质</label><select value={draft.imageConversion.jpgQuality} onChange={event => update('imageConversion', { jpgQuality: Number(event.target.value) })} className="form-input"><option value={100}>最高（100）</option><option value={95}>高（95）</option><option value={85}>标准（85）</option><option value={75}>节省空间（75）</option></select></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">调研整理</h4><label className="form-label">检测灵敏度</label><select value={draft.research.sensitivity} onChange={event => update('research', { ...draft.research, sensitivity: event.target.value as AppConfig['research']['sensitivity'] })} className="form-input"><option value="low">低</option><option value="standard">标准</option><option value="high">高</option></select><p className="mt-1 text-xs leading-5 text-slate-500">{{ low: '只保留明显硬切，并过滤快速运动、闪光及短暂抖动；适合“一分镜一张图”。', standard: '识别硬切和较明确的渐变转场，在数量和误判率之间保持平衡。', high: '识别更多轻微或渐变转场，但也更容易把快速运动识别为转场。' }[draft.research.sensitivity]}</p><label className="form-label">最小片段时长（秒）</label><input type="number" min="0.05" max="5" step="0.05" value={draft.research.minDuration} onChange={event => update('research', { ...draft.research, minDuration: Math.min(5, Math.max(0.05, Number(event.target.value) || 0.05)) })} className="form-input"/><p className="mt-1 text-xs leading-5 text-slate-500">每个灵敏度已有防误判下限：低 1.25 秒、标准 0.65 秒、高 0.3 秒。这里可设置更长的最短分镜时长；数值越大，导出的截图越少。</p></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">从 SD 卡导入</h4><label className="settings-check"><input type="checkbox" checked={draft.smartImport.autoStart} onChange={event => update('smartImport', { ...draft.smartImport, autoStart: event.target.checked })}/>应用启动时自动读取 SD 卡</label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.splitLargeFiles} onChange={event => update('smartImport', { ...draft.smartImport, splitLargeFiles: event.target.checked })}/><span><span className="block">超过 4GB 的视频自动分割</span><span className="mt-1 block text-xs leading-5 text-slate-500">用于兼容部分老旧 U 盘的 FAT32 单文件大小限制，以及某些云盘的单文件上传限制。</span></span></label><label className="settings-check"><input type="checkbox" checked={draft.smartImport.generateVideoPreview} onChange={event => update('smartImport', { ...draft.smartImport, generateVideoPreview: event.target.checked })}/><span><span className="block">生成视频预览</span><span className="mt-1 block text-xs leading-5 text-slate-500">为导入到“mov”的大型视频生成 H.264 中码率文件，储存在“mov_预览”并作为软件内快速播放源。关闭后不会在浏览时临时转码这些导入视频；其他普通视频仍可照常预览。</span></span></label></section>
    <section className="border-t border-slate-100 pt-6"><h4 className="text-sm font-bold text-slate-800">导入花絮</h4><label className="settings-check"><input type="checkbox" checked={draft.brollImport.splitLargeFiles} onChange={event => update('brollImport', { ...draft.brollImport, splitLargeFiles: event.target.checked })}/><span><span className="block">超过 4GB 的视频自动分割</span><span className="mt-1 block text-xs leading-5 text-slate-500">用于兼容部分老旧 U 盘的 FAT32 单文件大小限制，以及某些云盘的单文件上传限制。</span></span></label><label className="settings-check"><input type="checkbox" checked={draft.brollImport.clearSource} onChange={event => update('brollImport', { ...draft.brollImport, clearSource: event.target.checked })}/>导入后清空原始文件</label></section>
  </div></section>;
};

type ProjectPanel = 'import' | 'broll' | 'match' | 'compare' | 'converter' | 'trash' | 'cache' | null;
type PreviewTechnicalMetadata = { width?: number; height?: number; duration?: number; unavailable?: boolean };
type BatchRenameToken = 'text' | 'original' | 'sequence' | 'letter' | 'datetime' | 'replace';
type BatchRenamePart = {
  id: string;
  type: BatchRenameToken;
  value: string;
  caseMode: 'preserve' | 'upper' | 'lower';
  sequenceStart: number;
  sequenceDigits: number;
  letterCase: 'upper' | 'lower';
  dateSource: 'created' | 'modified';
  dateFormat: string;
  find: string;
  replace: string;
};
const createBatchRenamePart = (type: BatchRenameToken = 'text'): BatchRenamePart => ({
  id: `rename-part-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  type,
  value: '',
  caseMode: 'preserve',
  sequenceStart: 1,
  sequenceDigits: 2,
  letterCase: 'upper',
  dateSource: 'modified',
  dateFormat: 'YYYYMMDD_HHmmss',
  find: '',
  replace: ''
});
const formatBatchRenameDate = (date: Date, pattern: string) => {
  const values: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    DD: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0')
  };
  return pattern.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, token => values[token]);
};
const formatBatchRenameLetter = (index: number, letterCase: 'upper' | 'lower') => {
  let value = Math.max(0, index) + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return letterCase === 'lower' ? result.toLocaleLowerCase() : result;
};
const PROJECT_STATUSES: Array<WorkspaceProject['status']> = ['策划中', '待拍摄', '后期中', '已归档'];

const ProjectWorkspace = ({ active, project, workspacePath, initialPanel, importConfig, brollConfig, conversionConfig, matchConfig, mediaCacheConfig, onImportConfigChange, onMatchConfigChange, onMediaCacheConfigChange, onNotice, onProjectMoved, onDeleted }: {
  active: boolean;
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
  const [virtualWindow, setVirtualWindow] = useState({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 });
  const [currentRelativePath, setCurrentRelativePath] = useState('');
  const [directoryHistory, setDirectoryHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');
  const [gridIconSize, setGridIconSize] = useState(132);
  const [sortField, setSortField] = useState<'name' | 'date' | 'size'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const projectWorkspaceRef = useRef<HTMLDivElement>(null);
  const projectColumnLayoutRef = useRef<HTMLDivElement>(null);
  const filesColumnRef = useRef<HTMLDivElement>(null);
  const filesSurfaceRef = useRef<HTMLDivElement>(null);
  const didInitializePathRefreshRef = useRef(false);
  const wasActiveRef = useRef(active);
  const skipNextPathRefreshRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const currentRelativePathRef = useRef('');
  const projectPathRef = useRef(project.path);
  const directoryEntriesCacheRef = useRef(new Map<string, ProjectFileEntry[]>());
  const selectionDragRef = useRef<{ startX: number; startY: number; initialPaths: string[]; additive: boolean } | null>(null);
  const internalDragPathsRef = useRef<string[]>([]);
  const internalDropHandledRef = useRef(false);
  const renameCommitRef = useRef(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const [dragTargetPath, setDragTargetPath] = useState('');
  const [surfaceDropActive, setSurfaceDropActive] = useState(false);
  const [previewPath, setPreviewPath] = useState('');
  const [previewTechnicalMetadata, setPreviewTechnicalMetadata] = useState<PreviewTechnicalMetadata>({});
  const [previewMetadataFields, setPreviewMetadataFields] = useState<MediaMetadataField[]>([]);
  const [previewMetadataResolvedPath, setPreviewMetadataResolvedPath] = useState('');
  const [previewMetadataLoading, setPreviewMetadataLoading] = useState(false);
  const [previewMetadataError, setPreviewMetadataError] = useState('');
  const [viewportCurrentPath, setViewportCurrentPath] = useState('');
  const [viewportStatus, setViewportStatus] = useState<{ path: string; fileNumber: number; total: number; captureDateTime?: string } | null>(null);
  const [previewPaneOpen, setPreviewPaneOpen] = useState(false);
  const [metadataPaneOpen, setMetadataPaneOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState(() => ({
    files: readStoredNumber('photoflow:files-column-width', 560),
    preview: readStoredNumber('photoflow:preview-column-width', 340),
    metadata: readStoredNumber('photoflow:metadata-column-width', 320)
  }));
  const [projectLayoutWidth, setProjectLayoutWidth] = useState(0);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [inlineRenamePath, setInlineRenamePath] = useState('');
  const [inlineRenameValue, setInlineRenameValue] = useState('');
  const [batchRenameOpen, setBatchRenameOpen] = useState(false);
  const [batchRenameParts, setBatchRenameParts] = useState<BatchRenamePart[]>([]);
  const [batchExtensionMode, setBatchExtensionMode] = useState<'preserve' | 'replace'>('preserve');
  const [batchExtensionValue, setBatchExtensionValue] = useState('');
  const [draggedBatchRenamePartId, setDraggedBatchRenamePartId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [panel, setPanel] = useState<ProjectPanel>(initialPanel);
  const [message, setMessage] = useState('');
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ entry: ProjectFileEntry; x: number; y: number } | null>(null);
  const [surfaceMenu, setSurfaceMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipboardHasFiles, setClipboardHasFiles] = useState(false);
  const [photoshopAvailable, setPhotoshopAvailable] = useState(false);
  const [conversionTarget, setConversionTarget] = useState('');
  const [drives, setDrives] = useState<string[]>([]);

  useEffect(() => {
    void window.electronAPI.getPhotoshopStatus().then(result => setPhotoshopAvailable(result.available));
  }, []);

  useEffect(() => {
    window.localStorage.setItem('photoflow:files-column-width', String(Math.round(columnWidths.files)));
    window.localStorage.setItem('photoflow:preview-column-width', String(Math.round(columnWidths.preview)));
    window.localStorage.setItem('photoflow:metadata-column-width', String(Math.round(columnWidths.metadata)));
  }, [columnWidths]);

  useEffect(() => {
    const layout = projectColumnLayoutRef.current;
    if (!layout) return;
    const measure = () => setProjectLayoutWidth(layout.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active) return;
    const fetchDrives = () => window.electronAPI?.getDrives?.().then(setDrives);
    fetchDrives();
    const intervalId = window.setInterval(fetchDrives, 3000);
    return () => window.clearInterval(intervalId);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const refreshClipboardStatus = () => window.electronAPI.getProjectFileClipboardStatus().then(result => setClipboardHasFiles(result.success && result.hasFiles));
    void refreshClipboardStatus();
    window.addEventListener('focus', refreshClipboardStatus);
    return () => window.removeEventListener('focus', refreshClipboardStatus);
  }, [active]);

  const refresh = async (relativePath?: string) => {
    const safeRelativePath = typeof relativePath === 'string' ? relativePath : currentRelativePathRef.current;
    const requestedPath = safeRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const requestedProjectPath = project.path;
    const refreshSequence = ++refreshSequenceRef.current;
    const cachedEntries = directoryEntriesCacheRef.current.get(requestedPath);
    if (cachedEntries && requestedPath === currentRelativePathRef.current && requestedProjectPath === projectPathRef.current) setFileEntries(cachedEntries);
    const contentsPromise = window.electronAPI.getProjectContents(workspacePath, project.status, project.name);
    const browseResult = await window.electronAPI.browseProjectFiles(workspacePath, project.status, project.name, requestedPath, mediaCacheConfig);
    if (refreshSequence !== refreshSequenceRef.current || requestedPath !== currentRelativePathRef.current || requestedProjectPath !== projectPathRef.current) return;
    if (browseResult.success) {
      const cachedByPath = new Map((cachedEntries || []).map(entry => [entry.relativePath, entry]));
      const entries = browseResult.entries.map(entry => {
        const cached = cachedByPath.get(entry.relativePath);
        return cached && cached.updatedAt ? { ...entry, size: cached.size, createdAt: cached.createdAt, updatedAt: cached.updatedAt } : entry;
      });
      directoryEntriesCacheRef.current.set(requestedPath, entries);
      setFileEntries(entries);
    } else {
      // Never leave entries from the previous directory under a new breadcrumb.
      setFileEntries([]);
      onNotice(`读取目录失败：${browseResult.error || '无法读取文件'}`);
    }
    const result = await contentsPromise;
    if (refreshSequence !== refreshSequenceRef.current || requestedPath !== currentRelativePathRef.current || requestedProjectPath !== projectPathRef.current) return;
    if (result.success) setFolders(result.folders);
    else onNotice(`读取项目失败：${result.error || '无法读取项目文件夹'}`);
  };

  useEffect(() => {
    projectPathRef.current = project.path;
    currentRelativePathRef.current = '';
    refreshSequenceRef.current += 1;
    directoryEntriesCacheRef.current.clear();
    setFileEntries([]);
    setDirectoryHistory({ back: [], forward: [] });
    setPreviewPath('');
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(false);
    setPanel(initialPanel);
    setMessage('');
    if (currentRelativePath) skipNextPathRefreshRef.current = true;
    setCurrentRelativePath('');
    if (active) refresh('');
  }, [project.path, project.status, initialPanel]);
  useEffect(() => {
    if (active && !wasActiveRef.current) refresh(currentRelativePathRef.current);
    wasActiveRef.current = active;
  }, [active]);
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
    setPreviewPath('');
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(false);
    setInlineRenamePath('');
    setInlineRenameValue('');
    setFileMenu(null);
    refresh();
  }, [currentRelativePath]);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const projectPrefix = project.name.replace(/\\/g, '/');
    const unsubscribe = window.electronAPI.onWorkspaceFilesChanged(change => {
      const changedPath = (change.fileName || '').replace(/\\/g, '/');
      // A change in another project should never make a photo-heavy folder redraw.
      if (changedPath && changedPath !== projectPrefix && !changedPath.startsWith(`${projectPrefix}/`)) return;
      directoryEntriesCacheRef.current.clear();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refresh(currentRelativePathRef.current), 500);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [active, workspacePath, project.path, project.status, project.name, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB]);
  useEffect(() => {
    const closeMenus = () => { setFileMenu(null); setSurfaceMenu(null); setShowStatusMenu(false); setShowCreateMenu(false); setShowSortMenu(false); setSearchOpen(false); };
    window.addEventListener('click', closeMenus);
    window.addEventListener('photoflow-menu-open', closeMenus);
    return () => { window.removeEventListener('click', closeMenus); window.removeEventListener('photoflow-menu-open', closeMenus); };
  }, []);

  const displayedFileEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('zh-CN');
    const filtered = normalizedQuery ? fileEntries.filter(entry => entry.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) : fileEntries;
    const direction = sortDirection === 'asc' ? 1 : -1;
    return [...filtered].sort((left, right) => {
      if (left.kind === 'folder' && right.kind !== 'folder') return -1;
      if (left.kind !== 'folder' && right.kind === 'folder') return 1;
      let comparison = 0;
      if (sortField === 'date') comparison = left.updatedAt - right.updatedAt;
      else if (sortField === 'size') comparison = left.size - right.size;
      else comparison = left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      return comparison === 0
        ? left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
        : comparison * direction;
    });
  }, [fileEntries, searchQuery, sortDirection, sortField]);
  const renderedFileEntries = displayedFileEntries.slice(virtualWindow.start, virtualWindow.end);
  const pathSegments = currentRelativePath.split(/[\\/]/).filter(Boolean);
  const breadcrumbs = [{ label: project.name, relativePath: '' }, ...pathSegments.map((label, index) => ({ label, relativePath: pathSegments.slice(0, index + 1).join('/') }))];
  useEffect(() => { setVirtualWindow({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 }); }, [currentRelativePath, sortField, sortDirection, searchQuery]);
  useEffect(() => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return;
    let frameId = 0;
    const update = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const containerRect = container.getBoundingClientRect();
        const surfaceRect = surface.getBoundingClientRect();
        const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
        const visibleTop = Math.max(0, container.scrollTop - surfaceTop - (viewMode === 'list' ? 32 : 0));
        const width = Math.max(1, surface.clientWidth);
        const columns = viewMode === 'list' ? 1 : Math.max(1, Math.floor((width + 12) / (gridIconSize + 12)));
        const cellWidth = viewMode === 'list' ? width : (width - (columns - 1) * 12) / columns;
        const measuredItem = surface.querySelector<HTMLElement>('[data-entry-path]');
        const measuredGridPitch = measuredItem && viewMode === 'grid' ? measuredItem.getBoundingClientRect().height + 12 : 0;
        const rowHeight = viewMode === 'list' ? 48 : measuredGridPitch || cellWidth + 68;
        const rowCount = Math.ceil(displayedFileEntries.length / columns);
        const firstRow = Math.max(0, Math.floor(visibleTop / rowHeight) - 4);
        const lastRow = Math.min(rowCount, Math.ceil((visibleTop + container.clientHeight) / rowHeight) + 4);
        const next = {
          start: firstRow * columns,
          end: Math.min(displayedFileEntries.length, lastRow * columns),
          top: firstRow * rowHeight,
          bottom: Math.max(0, (rowCount - lastRow) * rowHeight),
          rowHeight,
          columns,
        };
        setVirtualWindow(current => current.start === next.start && current.end === next.end && Math.abs(current.top - next.top) < 1 && Math.abs(current.bottom - next.bottom) < 1 && current.columns === next.columns ? current : next);
      });
    };
    update();
    container.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(surface);
    return () => {
      window.cancelAnimationFrame(frameId);
      container.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [currentRelativePath, displayedFileEntries.length, viewMode, gridIconSize, previewPaneOpen, metadataPaneOpen, sortField, sortDirection, searchQuery]);
  useEffect(() => {
    if (sortField === 'name') return;
    const missingPaths = fileEntries.filter(entry => entry.updatedAt === 0 || entry.size < 0).map(entry => entry.relativePath);
    if (!missingPaths.length) return;
    let active = true;
    const directoryPath = currentRelativePath;
    const chunks = Array.from({ length: Math.ceil(missingPaths.length / 500) }, (_value, index) => missingPaths.slice(index * 500, (index + 1) * 500));
    Promise.all(chunks.map(paths => window.electronAPI.getProjectFileDetails(workspacePath, project.status, project.name, paths))).then(results => {
      if (!active || directoryPath !== currentRelativePathRef.current) return;
      const detailsByPath = new Map(results.flatMap(result => result.success ? result.details : []).map(detail => [detail.relativePath, detail]));
      if (!detailsByPath.size) return;
      setFileEntries(current => {
        const next = current.map(entry => {
          const detail = detailsByPath.get(entry.relativePath);
          return detail ? { ...entry, size: detail.size, createdAt: detail.createdAt, updatedAt: detail.updatedAt } : entry;
        });
        directoryEntriesCacheRef.current.set(directoryPath, next);
        return next;
      });
    });
    return () => { active = false; };
  }, [sortField, fileEntries, currentRelativePath, workspacePath, project.status, project.name]);
  useEffect(() => {
    const missingDetails = renderedFileEntries.filter(entry => entry.updatedAt === 0).map(entry => entry.relativePath);
    if (!missingDetails.length) return;
    let active = true;
    const directoryPath = currentRelativePath;
    window.electronAPI.getProjectFileDetails(workspacePath, project.status, project.name, missingDetails).then(result => {
      if (!active || directoryPath !== currentRelativePathRef.current || !result.success || !result.details.length) return;
      const detailsByPath = new Map(result.details.map(detail => [detail.relativePath, detail]));
      setFileEntries(current => {
        const next = current.map(entry => {
          const detail = detailsByPath.get(entry.relativePath);
          return detail ? { ...entry, size: detail.size, createdAt: detail.createdAt, updatedAt: detail.updatedAt } : entry;
        });
        directoryEntriesCacheRef.current.set(directoryPath, next);
        return next;
      });
    });
    return () => { active = false; };
  }, [currentRelativePath, virtualWindow.start, virtualWindow.end, fileEntries]);

  useEffect(() => {
    const scrollContainer = filesColumnRef.current;
    const filesSurface = filesSurfaceRef.current;
    if (!scrollContainer || !filesSurface) return;
    let frameId = 0;
    const updateCurrentVisibleFile = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const containerRect = scrollContainer.getBoundingClientRect();
        const entriesByPath = new Map(fileEntries.map(entry => [entry.relativePath, entry]));
        let currentPath = '';
        let currentScore = Number.NEGATIVE_INFINITY;
        for (const node of filesSurface.querySelectorAll<HTMLElement>('[data-entry-path]')) {
          const path = node.dataset.entryPath || '';
          if (!path || entriesByPath.get(path)?.kind === 'folder') continue;
          const rect = node.getBoundingClientRect();
          if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom || rect.right <= containerRect.left || rect.left >= containerRect.right) continue;
          // The last row wins; within that row, use the rightmost file.
          const score = rect.top * 100000 + rect.left;
          if (score > currentScore) {
            currentScore = score;
            currentPath = path;
          }
        }
        setViewportCurrentPath(current => current === currentPath ? current : currentPath);
      });
    };
    updateCurrentVisibleFile();
    scrollContainer.addEventListener('scroll', updateCurrentVisibleFile, { passive: true });
    const resizeObserver = new ResizeObserver(updateCurrentVisibleFile);
    resizeObserver.observe(scrollContainer);
    return () => {
      window.cancelAnimationFrame(frameId);
      scrollContainer.removeEventListener('scroll', updateCurrentVisibleFile);
      resizeObserver.disconnect();
    };
  }, [fileEntries, virtualWindow.start, virtualWindow.end, viewMode, gridIconSize, previewPaneOpen, metadataPaneOpen]);

  const prefetchDirectory = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'folder' || directoryEntriesCacheRef.current.has(entry.relativePath)) return;
    const requestedProjectPath = project.path;
    window.electronAPI.browseProjectFiles(workspacePath, project.status, project.name, entry.relativePath, mediaCacheConfig).then(result => {
      if (result.success && requestedProjectPath === projectPathRef.current) directoryEntriesCacheRef.current.set(entry.relativePath, result.entries);
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
    setShowCreateMenu(false);
    const result = await window.electronAPI.createProjectFolder(workspacePath, project.status, project.name, '新建文件夹', currentRelativePath, true);
    if (!result.success) { onNotice(`新建文件夹失败：${result.error || '未知错误'}`); return; }
    directoryEntriesCacheRef.current.delete(currentRelativePath);
    await refresh();
    const relativePath = result.folder?.relativePath || [...[currentRelativePath, result.folder?.name || '新建文件夹'].filter(Boolean)].join('/');
    setSelectedPaths([relativePath]);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(result.folder?.name || '新建文件夹');
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
    onNotice(`已创建“${result.folder?.name || name}”`);
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
  const beginRename = () => {
    if (!selectedPaths.length) return;
    if (selectedPaths.length === 1) {
      beginInlineRename(selectedPaths[0]);
      return;
    }
    setBatchRenameParts([
      createBatchRenamePart('text'),
      createBatchRenamePart('sequence')
    ]);
    setBatchExtensionMode('preserve');
    setBatchExtensionValue('');
    setBatchRenameOpen(true);
  };
  const batchRenameEntries = selectedPaths.map(relativePath => fileEntries.find(entry => entry.relativePath === relativePath)).filter((entry): entry is ProjectFileEntry => Boolean(entry));
  const buildBatchRenameNames = () => batchRenameEntries.map((entry, index) => {
    const extension = entry.kind === 'folder' || !entry.extension ? '' : entry.name.slice(-entry.extension.length);
    const originalName = extension && entry.name.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase()) ? entry.name.slice(0, -extension.length) : entry.name;
    let name = '';
    for (const part of batchRenameParts) {
      if (part.type === 'text') name += part.value;
      if (part.type === 'original') {
        name += part.caseMode === 'upper' ? originalName.toLocaleUpperCase() : part.caseMode === 'lower' ? originalName.toLocaleLowerCase() : originalName;
      }
      if (part.type === 'sequence') name += String(part.sequenceStart + index).padStart(part.sequenceDigits, '0');
      if (part.type === 'letter') name += formatBatchRenameLetter(index, part.letterCase);
      if (part.type === 'datetime') {
        const timestamp = part.dateSource === 'created' ? entry.createdAt || entry.updatedAt : entry.updatedAt;
        name += formatBatchRenameDate(timestamp ? new Date(timestamp) : new Date(), part.dateFormat);
      }
      if (part.type === 'replace') name += part.find ? originalName.split(part.find).join(part.replace) : originalName;
    }
    if (entry.kind !== 'folder') {
      const replacementExtension = batchExtensionValue.trim();
      name += batchExtensionMode === 'preserve' ? extension : replacementExtension ? `${replacementExtension.startsWith('.') ? '' : '.'}${replacementExtension}` : '';
    }
    return name.trim();
  });
  const updateBatchRenamePart = (id: string, changes: Partial<BatchRenamePart>) => {
    setBatchRenameParts(parts => parts.map(part => part.id === id ? { ...part, ...changes } : part));
  };
  const insertBatchRenamePart = (index: number) => {
    setBatchRenameParts(parts => {
      const next = [...parts];
      next.splice(index + 1, 0, createBatchRenamePart());
      return next;
    });
  };
  const moveDraggedBatchRenamePart = (targetId: string) => {
    if (!draggedBatchRenamePartId || draggedBatchRenamePartId === targetId) return;
    setBatchRenameParts(parts => {
      const sourceIndex = parts.findIndex(part => part.id === draggedBatchRenamePartId);
      const targetIndex = parts.findIndex(part => part.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return parts;
      const next = [...parts];
      const [dragged] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, dragged);
      return next;
    });
  };
  const batchRenameNames = buildBatchRenameNames();
  const commitBatchRename = async () => {
    if (!batchRenameNames.length || batchRenameNames.some(name => !name) || selectedPaths.length < 2 || renameCommitRef.current) return;
    renameCommitRef.current = true;
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'rename', selectedPaths, currentRelativePath, '批量重命名', { renameNames: batchRenameNames });
    renameCommitRef.current = false;
    if (!result.success) { onNotice(`批量重命名失败：${result.error || '未知错误'}`); return; }
    const count = selectedPaths.length;
    setBatchRenameOpen(false);
    setBatchRenameParts([]);
    setSelectedPaths([]);
    onNotice(`已批量重命名 ${count} 个项目`);
    refresh();
  };
  const openFileMenu = (event: React.MouseEvent, entry: ProjectFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setSurfaceMenu(null);
    setSelectedPaths(current => current.includes(entry.relativePath) ? current : [entry.relativePath]);
    setFileMenu({ entry, x: event.clientX, y: event.clientY });
    setClipboardHasFiles(false);
    void window.electronAPI.getProjectFileClipboardStatus().then(result => setClipboardHasFiles(result.success && result.hasFiles));
  };
  const openSurfaceMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-entry-path]')) return;
    event.preventDefault();
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setFileMenu(null);
    setSurfaceMenu({ x: event.clientX, y: event.clientY });
    setClipboardHasFiles(false);
    void window.electronAPI.getProjectFileClipboardStatus().then(result => setClipboardHasFiles(result.success && result.hasFiles));
  };
  const showDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    // Invalidate the directory that is still loading before React commits the
    // breadcrumb change, so its late result cannot replace the new folder.
    refreshSequenceRef.current += 1;
    currentRelativePathRef.current = normalizedPath;
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
    const result = await window.electronAPI.openProjectEntry(workspacePath, project.status, project.name, entry.relativePath);
    if (!result.success) onNotice(`打开文件失败：${result.error || '无法打开文件'}`);
  };
  const openProjectEntryInPhotoshop = async (entry: ProjectFileEntry) => {
    const result = await window.electronAPI.openProjectEntryInPhotoshop(workspacePath, project.status, project.name, entry.relativePath);
    if (!result.success) onNotice(`用 Photoshop 打开失败：${result.error || '无法打开文件'}`);
  };
  const copyEntryPath = async (entry: ProjectFileEntry) => {
    const result = await window.electronAPI.copyProjectEntryPath(workspacePath, project.status, project.name, entry.relativePath);
    const typeLabel = entry.kind === 'folder' ? '文件夹' : '文件';
    onNotice(result.success ? `已复制${typeLabel}地址` : `复制${typeLabel}地址失败：${result.error || '未知错误'}`);
  };
  const copyCurrentDirectoryPath = async () => {
    const result = await window.electronAPI.copyProjectEntryPath(workspacePath, project.status, project.name, currentRelativePath);
    onNotice(result.success ? '已复制当前文件夹地址' : `复制文件夹地址失败：${result.error || '未知错误'}`);
  };
  const startSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-entry-path], button, input, select, textarea')) return;
    const surface = filesSurfaceRef.current;
    if (!surface) return;
    cancelInlineRename();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const additive = event.ctrlKey || event.metaKey;
    selectionDragRef.current = { startX: event.clientX, startY: event.clientY, initialPaths: additive ? selectedPaths : [], additive };
    if (!additive) {
      setSelectedPaths([]);
      setPreviewPath('');
      setViewportCurrentPath('');
      setPreviewPaneOpen(false);
      setMetadataPaneOpen(false);
    }
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
    if (operation === 'copy' || operation === 'cut') {
      setCutPaths(operation === 'cut' ? [...selectedPaths] : []);
      setClipboardHasFiles(true);
      onNotice(`${operation === 'copy' ? '已复制' : '已剪切'} ${result.count} 个项目`);
    } else {
      if (operation === 'paste') setCutPaths([]);
      if (operation === 'trash') setCutPaths(current => current.filter(path => !selectedPaths.includes(path)));
      onNotice(operation === 'trash' ? `已移入回收站 ${result.count} 个项目` : operation === 'paste' ? `已粘贴 ${result.count} 个项目` : '操作完成');
      setSelectedPaths([]);
      refresh();
    }
  };
  useEffect(() => {
    const handleFileShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      let handled = false;

      if (commandKey && key === 'a') {
        setSelectedPaths(displayedFileEntries.map(entry => entry.relativePath));
        onNotice(`已选择 ${displayedFileEntries.length} 个项目`);
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
  const previewEntry = fileEntries.find(entry => entry.relativePath === previewPath && (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'));
  const filesInCurrentDirectory = fileEntries.filter(entry => entry.kind !== 'folder');
  const viewportCurrentEntry = filesInCurrentDirectory.find(entry => entry.relativePath === viewportCurrentPath);
  const viewportCurrentFileNumber = viewportCurrentEntry ? filesInCurrentDirectory.findIndex(entry => entry.relativePath === viewportCurrentEntry.relativePath) + 1 : 0;
  const currentPreviewMetadataFields = previewEntry && previewMetadataResolvedPath === previewEntry.path ? previewMetadataFields : [];
  const currentPreviewMetadataLoading = Boolean(previewEntry && (previewMetadataLoading || previewMetadataResolvedPath !== previewEntry.path));
  const currentPreviewMetadataError = previewEntry && previewMetadataResolvedPath === previewEntry.path ? previewMetadataError : '';
  const previewImageEntries = displayedFileEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw');
  useEffect(() => {
    let active = true;
    if (!viewportCurrentEntry || viewportCurrentFileNumber <= 0) {
      setViewportStatus(null);
      return () => { active = false; };
    }
    const nextStatus = { path: viewportCurrentEntry.relativePath, fileNumber: viewportCurrentFileNumber, total: filesInCurrentDirectory.length };
    if (!['image', 'raw', 'video'].includes(viewportCurrentEntry.kind)) {
      setViewportStatus(nextStatus);
      return () => { active = false; };
    }
    const timer = window.setTimeout(() => {
      requestCaptureDateTime(viewportCurrentEntry).then(captureDateTime => {
        if (!active) return;
        setViewportStatus(captureDateTime ? { ...nextStatus, captureDateTime } : nextStatus);
      });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [viewportCurrentEntry?.path, viewportCurrentEntry?.updatedAt, viewportCurrentFileNumber, filesInCurrentDirectory.length]);
  useEffect(() => {
    let active = true;
    setPreviewMetadataFields([]);
    setPreviewMetadataResolvedPath('');
    setPreviewMetadataError('');
    if (!previewEntry) {
      setPreviewMetadataLoading(false);
      return () => { active = false; };
    }
    setPreviewMetadataLoading(true);
    window.electronAPI.getMediaMetadata(previewEntry.path).then(result => {
      if (!active) return;
      if (!result.success) {
        setPreviewMetadataError(result.error || '无法读取完整元数据');
        setPreviewMetadataResolvedPath(previewEntry.path);
        return;
      }
      setPreviewMetadataFields(result.fields);
      setPreviewMetadataResolvedPath(previewEntry.path);
    }).finally(() => { if (active) setPreviewMetadataLoading(false); });
    return () => { active = false; };
  }, [previewEntry?.path]);
  useEffect(() => {
    const switchPreviewImage = (event: KeyboardEvent) => {
      if (!previewPaneOpen || !previewEntry || (previewEntry.kind !== 'image' && previewEntry.kind !== 'raw') || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const currentIndex = previewImageEntries.findIndex(entry => entry.relativePath === previewEntry.relativePath);
      if (currentIndex < 0) return;
      const nextIndex = clampNumber(currentIndex + (event.key === 'ArrowRight' ? 1 : -1), 0, previewImageEntries.length - 1);
      if (nextIndex === currentIndex) return;
      const nextEntry = previewImageEntries[nextIndex];
      event.preventDefault();
      event.stopPropagation();
      setPreviewPath(nextEntry.relativePath);
      setPreviewTechnicalMetadata({});
      const fileIndex = displayedFileEntries.findIndex(entry => entry.relativePath === nextEntry.relativePath);
      setVirtualWindow(current => ({ ...current, start: Math.min(current.start, fileIndex), end: Math.max(current.end, fileIndex + 1) }));
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const node = Array.from(filesSurfaceRef.current?.querySelectorAll<HTMLElement>('[data-entry-path]') || []).find(item => item.dataset.entryPath === nextEntry.relativePath);
        node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }));
    };
    window.addEventListener('keydown', switchPreviewImage);
    return () => window.removeEventListener('keydown', switchPreviewImage);
  }, [previewPaneOpen, previewEntry?.relativePath, previewEntry?.kind, previewImageEntries, displayedFileEntries]);
  const displayedColumnWidths = fitProjectColumnWidths(columnWidths, projectLayoutWidth, previewPaneOpen, metadataPaneOpen);
  const visiblePreferredTotal = columnWidths.files + (previewPaneOpen ? columnWidths.preview : 0) + (metadataPaneOpen ? columnWidths.metadata : 0);
  const visibleAvailableWidth = Math.max(1, projectLayoutWidth - Number(previewPaneOpen) - Number(metadataPaneOpen));
  const columnCompressionScale = Math.min(1, visibleAvailableWidth / Math.max(1, visiblePreferredTotal));
  const preferredDragDelta = (deltaX: number) => deltaX / Math.max(0.35, columnCompressionScale);
  const resizeFilesAndPreview = (deltaX: number) => setColumnWidths(current => {
    const total = current.files + current.preview;
    const files = clampNumber(current.files + preferredDragDelta(deltaX), 320, total - 220);
    return { ...current, files, preview: total - files };
  });
  const resizePreviewAndMetadata = (deltaX: number) => setColumnWidths(current => {
    const total = current.preview + current.metadata;
    const preview = clampNumber(current.preview + preferredDragDelta(deltaX), 220, total - 180);
    return { ...current, preview, metadata: total - preview };
  });
  const resizeFilesAndMetadata = (deltaX: number) => setColumnWidths(current => {
    const total = current.files + current.metadata;
    const files = clampNumber(current.files + preferredDragDelta(deltaX), 320, total - 180);
    return { ...current, files, metadata: total - files };
  });
  const canSelectMedia = selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
  const selectMediaFiles = async () => {
    if (!canSelectMedia) { onNotice(selectedPaths.length ? '只能选择媒体文件' : '请先选择媒体文件'); return; }
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'select', selectedPaths);
    if (!result.success) { onNotice(`选片失败：${result.error || '未知错误'}`); return; }
    onNotice(`已将 ${result.count || 0} 个媒体文件放入选片文件夹`);
    setSelectedPaths([]);
    refresh();
  };
  const openPreviewAndMetadata = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video') return;
    setPreviewPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(true);
    setMetadataPaneOpen(true);
  };
  const handleEntryClick = (entry: ProjectFileEntry) => {
    if (inlineRenamePath === entry.relativePath) return;
    if (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') {
      openPreviewAndMetadata(entry);
      if (selectedPaths.length) toggleSelected(entry.relativePath);
      return;
    }
    if (selectedPaths.length) toggleSelected(entry.relativePath);
    else openProjectEntry(entry);
  };
  const handleEntryDoubleClick = (event: React.MouseEvent, entry: ProjectFileEntry) => {
    if (entry.kind === 'folder' || inlineRenamePath === entry.relativePath) return;
    event.preventDefault();
    event.stopPropagation();
    void openProjectEntry(entry);
  };
  const renderEntryName = (entry: ProjectFileEntry, grid = false) => inlineRenamePath === entry.relativePath ? <input
    autoFocus
    value={inlineRenameValue}
    onFocus={event => event.currentTarget.select()}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onChange={event => setInlineRenameValue(event.target.value)}
    onBlur={cancelInlineRename}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') commitInlineRename();
      if (event.key === 'Escape') cancelInlineRename();
    }}
    className={`${grid ? 'mt-2 w-full text-xs' : 'min-w-0 flex-1 text-sm'} rounded border border-blue-500 bg-white px-1.5 py-0.5 text-slate-800 outline-none ring-2 ring-blue-200`}
  /> : grid ? <p className="mt-2 truncate text-xs font-medium text-slate-700">{entry.name}</p> : <span className="truncate font-medium text-slate-700">{entry.name}</span>;
  const gridThumbnailSize = gridIconSize <= 112 ? 320 : gridIconSize <= 184 ? 640 : gridIconSize <= 264 ? 960 : 1200;
  const renderEntryIcon = (entry: ProjectFileEntry, large = false, queueOrder = displayedFileEntries.findIndex(candidate => candidate.path === entry.path)) => entry.kind === 'folder'
    ? <Folder size={large ? 58 : 27} strokeWidth={1.5} fill="currentColor" className="text-blue-500"/>
    : entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'
      ? <><MediaThumbnail entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? gridThumbnailSize : 160} queueOrder={queueOrder} large={large}/>{entry.kind === 'video' && <Play size={large ? 25 : 15} fill="currentColor" className="pointer-events-none absolute text-white drop-shadow-[0_1px_4px_rgba(0,0,0,.8)]"/>}</>
      : <SystemFileIcon filePath={entry.path} size={large ? 48 : 28}/>;
  const startEntryDrag = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const dragPaths = selectedPaths.includes(entry.relativePath) ? selectedPaths : [entry.relativePath];
    internalDragPathsRef.current = dragPaths;
    internalDropHandledRef.current = false;
    if (!selectedPaths.includes(entry.relativePath)) setSelectedPaths([entry.relativePath]);
    window.electronAPI.startProjectFileDrag(workspacePath, project.status, project.name, dragPaths);
  };
  const finishEntryDrag = () => {
    internalDragPathsRef.current = [];
    setDragTargetPath('');
  };
  const hasExternalFiles = (event: React.DragEvent<HTMLElement>) => internalDragPathsRef.current.length === 0 && Array.from(event.dataTransfer.types).includes('Files');
  const getExternalFilePaths = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.files)
    .map(file => (file as File & { path?: string }).path || '')
    .filter(Boolean);
  const canDropInternalIntoFolder = (entry: ProjectFileEntry) => internalDragPathsRef.current.length > 0 && !internalDragPathsRef.current.some(source => entry.relativePath === source || entry.relativePath.startsWith(`${source}\\`) || entry.relativePath.startsWith(`${source}/`));
  const handleEntryDragOver = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (entry.kind !== 'folder' || (!canDropInternalIntoFolder(entry) && !hasExternalFiles(event))) return;
    event.preventDefault();
    event.stopPropagation();
    // Electron's native file drag advertises copy support to Windows. Accept it
    // as copy here so the cursor is not shown as forbidden; an internal drop is
    // still completed as a move by the main process.
    event.dataTransfer.dropEffect = 'copy';
    setSurfaceDropActive(false);
    if (dragTargetPath !== entry.relativePath) setDragTargetPath(entry.relativePath);
  };
  const handleEntryDragLeave = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (dragTargetPath === entry.relativePath) setDragTargetPath('');
  };
  const handleEntryDrop = async (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (entry.kind !== 'folder') return;
    const internalPaths = [...internalDragPathsRef.current];
    const externalPaths = internalPaths.length ? [] : getExternalFilePaths(event);
    if ((!internalPaths.length || !canDropInternalIntoFolder(entry)) && !externalPaths.length) return;
    event.preventDefault();
    event.stopPropagation();
    internalDropHandledRef.current = internalPaths.length > 0;
    finishEntryDrag();
    setSurfaceDropActive(false);
    const operation = internalPaths.length ? 'move' : 'import';
    const paths = internalPaths.length ? internalPaths : externalPaths;
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, operation, paths, entry.relativePath);
    if (!result.success) { onNotice(`${operation === 'move' ? '移动' : '导入'}失败：${result.error || '未知错误'}`); return; }
    if (operation === 'move') setCutPaths(current => current.filter(path => !paths.includes(path)));
    setSelectedPaths([]);
    onNotice(`已${operation === 'move' ? '移动' : '导入'} ${result.count} 个项目到 ${entry.name}`);
    refresh();
  };
  useEffect(() => {
    const acceptInternalFolderDrag = (event: DragEvent) => {
      if (!internalDragPathsRef.current.length) return;
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-entry-kind="folder"][data-entry-path]');
      const targetRelativePath = target?.dataset.entryPath;
      if (!targetRelativePath || internalDragPathsRef.current.some(source => targetRelativePath === source || targetRelativePath.startsWith(`${source}\\`) || targetRelativePath.startsWith(`${source}/`))) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setDragTargetPath(targetRelativePath);
    };
    window.addEventListener('dragover', acceptInternalFolderDrag, true);
    return () => window.removeEventListener('dragover', acceptInternalFolderDrag, true);
  }, []);
  useEffect(() => window.electronAPI.onProjectFileDragEnd(result => {
    const dragPaths = result.paths?.length ? result.paths : [...internalDragPathsRef.current];
    internalDragPathsRef.current = [];
    setDragTargetPath('');
    setSurfaceDropActive(false);
    if (internalDropHandledRef.current) {
      internalDropHandledRef.current = false;
      return;
    }
    if (!result.insideWindow || !dragPaths.length) return;
    const target = document.elementFromPoint(result.clientX, result.clientY)?.closest<HTMLElement>('[data-entry-kind="folder"][data-entry-path]');
    const targetRelativePath = target?.dataset.entryPath;
    if (!targetRelativePath || dragPaths.some(source => targetRelativePath === source || targetRelativePath.startsWith(`${source}\\`) || targetRelativePath.startsWith(`${source}/`))) return;
    const targetName = target.title || targetRelativePath.split(/[\\/]/).pop() || '文件夹';
    void window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'move', dragPaths, targetRelativePath).then(moveResult => {
      if (!moveResult.success) { onNotice(`移动失败：${moveResult.error || '未知错误'}`); return; }
      setCutPaths(current => current.filter(path => !dragPaths.includes(path)));
      setSelectedPaths([]);
      onNotice(`已移动 ${moveResult.count} 个项目到 ${targetName}`);
      refresh();
    });
  }), [workspacePath, project.status, project.name]);
  const handleSurfaceDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!surfaceDropActive) setSurfaceDropActive(true);
  };
  const handleSurfaceDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setSurfaceDropActive(false);
  };
  const handleSurfaceDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFiles(event)) return;
    const externalPaths = getExternalFilePaths(event);
    if (!externalPaths.length) return;
    event.preventDefault();
    event.stopPropagation();
    setSurfaceDropActive(false);
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'import', externalPaths, currentRelativePath);
    if (!result.success) { onNotice(`导入失败：${result.error || '未知错误'}`); return; }
    onNotice(`已导入 ${result.count} 个项目`);
    refresh();
  };
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
      const intensity = Math.max(8, Math.min(32, Math.abs(event.deltaY) / 3));
      setGridIconSize(current => Math.max(80, Math.min(360, Math.round((current + direction * intensity) / 4) * 4)));
    };
    zoomSurface.addEventListener('wheel', zoomWithWheel, { capture: true, passive: false });
    return () => {
      zoomSurface.removeEventListener('wheel', zoomWithWheel, true);
    };
  }, [viewMode]);

  return (
    <div ref={projectWorkspaceRef} className="flex h-full w-full min-w-0 flex-col animate-in fade-in duration-300">
      {panel === 'converter' && <CollapsiblePanel title="PNG 转 JPG" onClose={() => setPanel(null)}><ConverterView embedded initialTargetPath={conversionTarget} defaultQuality={conversionConfig.jpgQuality}/></CollapsiblePanel>}
      {fileMenu && createPortal(<div className="project-context-menu fixed z-[301] max-h-[calc(100vh-1rem)] w-52 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl" style={{ left: Math.max(8, Math.min(fileMenu.x, window.innerWidth - 220)), top: Math.max(8, Math.min(fileMenu.y, window.innerHeight - 490)) }} onClick={event => event.stopPropagation()}>
        {(fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openPreviewAndMetadata(entry); }}><PanelLeftOpen size={14}/>打开预览和元数据</button>}
        {fileMenu.entry.kind !== 'folder' && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openProjectEntry(entry); }}><ExternalLink size={14}/>用默认方式打开</button>}
        {photoshopAvailable && fileMenu.entry.kind === 'image' && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openProjectEntryInPhotoshop(entry); }}><ImageIcon size={14}/>用 Photoshop 打开</button>}
        {fileMenu.entry.kind !== 'folder' && <div className="my-1 border-t border-slate-100"/>}
        <button className="project-menu-item" onClick={() => { setFileMenu(null); beginRename(); }}><Edit size={14}/>{selectedPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('cut'); }}><Cut size={14}/>剪切</button>
        <button className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('copy'); }}><Copy size={14}/>复制</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); copyEntryPath(entry); }}><FileText size={14}/>{fileMenu.entry.kind === 'folder' ? '复制文件夹地址' : '复制文件地址'}</button>
        <button disabled={!clipboardHasFiles} title={clipboardHasFiles ? '粘贴到当前文件夹' : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('paste'); }}><ClipboardPaste size={14}/>粘贴</button>
        <button className="project-menu-item project-menu-danger" onClick={() => { setFileMenu(null); runFileOperation('trash'); }}><Trash2 size={14}/>删除</button>
        <button className="project-menu-item" onClick={() => { setSelectedPaths([]); setFileMenu(null); }}><X size={14}/>退出选择</button>
        {fileMenu.entry.kind !== 'folder' && <><div className="my-1 border-t border-slate-100"/>{(fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button disabled={!canSelectMedia} className="project-menu-item" onClick={() => { setFileMenu(null); selectMediaFiles(); }}><CheckCircle2 size={14}/>选片</button>}</>}
        {fileMenu.entry.kind === 'folder' && <><div className="my-1 border-t border-slate-100"/><button className="project-menu-item" onClick={() => { setFileMenu(null); togglePanel('compare'); }}><FileDiff size={14}/>对比图片</button><button className="project-menu-item" onClick={() => { setFileMenu(null); openPngConverter(fileMenu.entry.path); }}><ImageIcon size={14}/>PNG 转 JPG</button></>}
      </div>, document.body)}
      {surfaceMenu && createPortal(<div className="project-context-menu fixed z-[301] w-56 rounded-lg border border-slate-200 bg-white p-1 shadow-xl" style={{ left: Math.max(8, Math.min(surfaceMenu.x, window.innerWidth - 236)), top: Math.max(8, Math.min(surfaceMenu.y, window.innerHeight - 112)) }} onClick={event => event.stopPropagation()}>
        <button disabled={!clipboardHasFiles} title={clipboardHasFiles ? '粘贴到当前文件夹' : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { setSurfaceMenu(null); void runFileOperation('paste'); }}><ClipboardPaste size={14}/>粘贴</button>
        <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void copyCurrentDirectoryPath(); }}><FileText size={14}/>复制当前文件夹地址</button>
      </div>, document.body)}
      <div ref={projectColumnLayoutRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div ref={filesColumnRef} style={previewPaneOpen || metadataPaneOpen ? { width: displayedColumnWidths.files } : undefined} className={`flex min-h-0 flex-col gap-3 overflow-auto px-6 pb-6 ${previewPaneOpen || metadataPaneOpen ? 'shrink-0' : 'flex-1'}`}>
      {viewportStatus && createPortal(<div role="status" className="pointer-events-none fixed bottom-5 z-[400] flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-lg border border-white/10 bg-slate-950/80 px-3.5 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md" style={{ right: Math.max(20, projectLayoutWidth - displayedColumnWidths.files + 20) }}>
        {viewportStatus.captureDateTime && <>
          <span className="truncate" title={viewportStatus.captureDateTime}>{viewportStatus.captureDateTime}</span>
          <span aria-hidden className="h-3 w-px shrink-0 bg-white/25"/>
        </>}
        <span className="shrink-0 font-mono font-bold tabular-nums">{viewportStatus.fileNumber}/{viewportStatus.total}</span>
      </div>, document.body)}
      <div className="flex flex-wrap items-start justify-between gap-3 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-bold text-slate-800">{project.name}</h2>
          <div className="relative" onClick={event => event.stopPropagation()}>
            <button onClick={() => { const next = !showStatusMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowStatusMenu(next); }} className="flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-600 hover:bg-blue-100">{PROJECT_STATUS_LABELS[project.status]} <ChevronDown size={14}/></button>
            {showStatusMenu && <div className="absolute left-0 top-full z-[60] mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{PROJECT_STATUSES.map(status => <button key={status} onClick={() => moveStatus(status)} className={`project-menu-item ${status === project.status ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{PROJECT_STATUS_LABELS[status]}{status === project.status ? '（当前）' : ''}</button>)}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2"><button onClick={() => openFolder()} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><ExternalLink size={16}/>打开项目文件夹</button><button onClick={() => setConfirmDelete(true)} title="删除项目" className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-500 hover:bg-red-50"><Trash2 size={16}/></button></div>
      </div>

      <div className="sticky top-0 z-30 bg-slate-50">
      <div className="project-toolbar flex flex-wrap items-center border-b border-slate-200 py-1">
        <div className="relative" onClick={event => event.stopPropagation()}>
          <button onClick={() => { const next = !showCreateMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowCreateMenu(next); }} title="创建进度" aria-label="创建进度" aria-haspopup="menu" aria-expanded={showCreateMenu} className="project-action-button"><FolderPlus size={16}/>创建进度</button>
          {showCreateMenu && <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            <button className="project-menu-item" onClick={() => createNumberedProgress('图片后期')}>创建图片进度</button>
            <button className="project-menu-item" onClick={() => createNumberedProgress('视频后期')}>创建视频进度</button>
            <div className="my-1 border-t border-slate-100"/>
            <button className="project-menu-item" onClick={() => void createFolder()}>新建文件夹</button>
          </div>}
        </div>
        <span aria-hidden className="toolbar-divider"/>
        {selectedPaths.length > 0 && <span className="mr-1 self-center text-xs text-slate-500">已选 {selectedPaths.length}</span>}
        <button disabled={!selectedPaths.length} title={selectedPaths.length > 1 ? '批量重命名' : selectedPaths.length === 1 ? '重命名' : '请先选择文件或文件夹'} onClick={beginRename} className="project-action-button"><Edit size={16}/>{selectedPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button disabled={!selectedPaths.length} title={selectedPaths.length ? '剪切' : '请先选择文件'} onClick={() => runFileOperation('cut')} className="project-action-button"><Cut size={16}/>剪切</button>
        <button disabled={!selectedPaths.length} title={selectedPaths.length ? '复制' : '请先选择文件'} onClick={() => runFileOperation('copy')} className="project-action-button"><Copy size={16}/>复制</button>
        <button disabled={!clipboardHasFiles} title={clipboardHasFiles ? '粘贴到当前文件夹' : '剪贴板中没有文件'} onClick={() => runFileOperation('paste')} className="project-action-button"><ClipboardPaste size={16}/>粘贴</button>
        <button disabled={!selectedPaths.length} title={selectedPaths.length ? '删除（移入回收站）' : '请先选择文件'} onClick={() => runFileOperation('trash')} className="project-action-button project-action-danger"><Trash2 size={16}/>删除</button>
        <button disabled={!selectedPaths.length} title="取消选择" onClick={() => setSelectedPaths([])} className="project-action-button"><X size={16}/>取消选择</button>
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
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-3"><button onClick={() => setViewMode('grid')} title="图标模式" className={`rounded-md p-1.5 ${viewMode === 'grid' ? 'bg-slate-200 text-slate-800' : 'text-slate-500 hover:bg-slate-200'}`}><Grid2X2 size={17}/></button><button onClick={() => setViewMode('list')} title="列表模式" className={`rounded-md p-1.5 ${viewMode === 'list' ? 'bg-slate-200 text-slate-800' : 'text-slate-500 hover:bg-slate-200'}`}><LayoutList size={17}/></button>{viewMode === 'grid' && <input aria-label="图标大小" title="图标大小" type="range" min="80" max="360" step="4" value={gridIconSize} onChange={event => setGridIconSize(Number(event.target.value))} className="ml-2 w-24 accent-blue-600"/>}<span aria-hidden className="mx-1 h-5 w-px bg-slate-200"/><div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !showSortMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowSortMenu(next); }} title="排序" aria-label="排序" aria-haspopup="menu" aria-expanded={showSortMenu} className="project-action-button"><ArrowUpDown size={16}/>排序</button>{showSortMenu && <div className="sort-menu absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{([['name', '文件名'], ['date', '修改日期'], ['size', '大小']] as const).map(([field, label]) => <button key={field} type="button" onClick={() => setSortField(field)} className={`project-menu-item ${sortField === field ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{label}</button>)}<div className="my-1 border-t border-slate-100"/><button type="button" onClick={() => setSortDirection('asc')} className={`project-menu-item ${sortDirection === 'asc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowUp size={14}/><span>递增</span></button><button type="button" onClick={() => setSortDirection('desc')} className={`project-menu-item ${sortDirection === 'desc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowDown size={14}/><span>递减</span></button></div>}</div><div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !searchOpen; window.dispatchEvent(new Event('photoflow-menu-open')); setSearchOpen(next); }} title="查找文件" aria-label="查找文件" aria-expanded={searchOpen} className={`project-action-button ${searchOpen || searchQuery ? 'bg-blue-50 text-blue-600' : ''}`}><Search size={16}/>查找文件</button>{searchOpen && <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"><div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2"><Search size={15} className="shrink-0 text-slate-400"/><input autoFocus value={searchQuery} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); } }} placeholder="输入文件名" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-slate-800 outline-none"/>{searchQuery && <button type="button" onClick={() => setSearchQuery('')} title="清除查找" className="rounded p-0.5 text-slate-400 hover:bg-slate-200"><X size={14}/></button>}</div></div>}</div></div>
      </div>
      <div className="flex min-w-0 items-center py-2">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-sm text-slate-500">
          <button type="button" onClick={navigateBack} disabled={!directoryHistory.back.length} title="后退" aria-label="后退" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowLeft size={17}/></button>
          <button type="button" onClick={navigateForward} disabled={!directoryHistory.forward.length} title="前进" aria-label="前进" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowRight size={17}/></button>
          <span className="mr-1 inline-flex h-8 shrink-0 items-center font-bold leading-none text-slate-800">项目</span>
          {breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.relativePath || 'root'}><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><button onClick={() => navigateToDirectory(crumb.relativePath)} title={`进入 ${crumb.label}`} className={`inline-flex h-8 min-w-0 items-center truncate rounded border border-transparent px-1.5 text-sm leading-none transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 ${index === breadcrumbs.length - 1 ? 'font-bold text-slate-700' : ''}`}>{crumb.label}</button></React.Fragment>)}
        </div>
      </div>
      </div>

      {message && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">{message}</div>}
      {panel === 'import' && <CollapsiblePanel title="从 SD 卡导入" onClose={() => setPanel(null)}><p className="mb-4 text-sm text-slate-500">导入的文件会直接整理到当前项目“{project.name}”中。</p><ImportCard config={importConfig} drives={drives} destinationPath={project.path} onImportConfigChange={onImportConfigChange} onImportComplete={markInProgress}/></CollapsiblePanel>}
      {panel === 'broll' && <CollapsiblePanel title="导入花絮" onClose={() => setPanel(null)}><p className="text-sm text-slate-500">选择要保留的花絮媒体，软件会复制到当前项目的“花絮”文件夹。</p><button onClick={importBroll} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">选择花絮文件</button></CollapsiblePanel>}
      {panel === 'match' && <CollapsiblePanel title="从文件名选片" onClose={() => setPanel(null)}><MatchView embedded config={matchConfig} projectPath={project.path} folderOptions={folders} onUpdateConfig={onMatchConfigChange}/></CollapsiblePanel>}
      {panel === 'cache' && <CollapsiblePanel title="缩略图缓存" onClose={() => setPanel(null)}><MediaCacheSettings config={mediaCacheConfig} onChange={onMediaCacheConfigChange}/></CollapsiblePanel>}
      {panel === 'compare' && <CollapsiblePanel title="对比图片" onClose={() => setPanel(null)}><RenameView embedded folderOptions={folders}/></CollapsiblePanel>}
      {panel === 'trash' && <CollapsiblePanel title="移入回收站" onClose={() => setPanel(null)}><p className="text-sm text-slate-500">项目“{project.name}”及其全部内容将移入系统回收站。</p><button onClick={moveToTrash} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">确认移入回收站</button></CollapsiblePanel>}
      {batchRenameOpen && <div role="dialog" aria-modal="true" aria-label="批量重命名" className="fixed inset-0 z-[330] flex items-center justify-center bg-slate-950/40 p-4"><div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h3 className="font-bold text-slate-800">批量重命名 {selectedPaths.length} 个项目</h3><p className="mt-1 text-xs text-slate-500">每一行生成或处理一段名称；拖动左侧手柄可以调整执行顺序。</p></div><button onClick={() => setBatchRenameOpen(false)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100"><X size={18}/></button></header><div className="min-h-0 flex-1 overflow-y-auto p-5">
        <section>
          <h4 className="mb-2 text-sm font-bold text-slate-700">新文件名规则</h4>
          <div className="space-y-2">{batchRenameParts.map((part, index) => <div key={part.id} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); moveDraggedBatchRenamePart(part.id); setDraggedBatchRenamePartId(''); }} className={`flex items-center gap-2 rounded-lg border bg-slate-50 p-2 ${draggedBatchRenamePartId === part.id ? 'border-blue-400 opacity-60' : 'border-slate-200'}`}>
            <button type="button" draggable onDragStart={event => { setDraggedBatchRenamePartId(part.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDraggedBatchRenamePartId('')} title="拖动调整顺序" className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-200 active:cursor-grabbing"><GripVertical size={17}/></button>
            <select value={part.type} onChange={event => updateBatchRenamePart(part.id, { type: event.target.value as BatchRenameToken })} className="w-32 shrink-0 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-700"><option value="text">文本</option><option value="original">当前文件名</option><option value="sequence">序列数字</option><option value="letter">序列字母</option><option value="datetime">日期时间</option><option value="replace">文本替换</option></select>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {part.type === 'text' && <input autoFocus={index === 0} value={part.value} onChange={event => updateBatchRenamePart(part.id, { value: event.target.value })} placeholder="输入文本或分隔符" className="min-w-[180px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"/>}
              {part.type === 'original' && <><span className="text-xs text-slate-500">大小写</span><select value={part.caseMode} onChange={event => updateBatchRenamePart(part.id, { caseMode: event.target.value as BatchRenamePart['caseMode'] })} className="min-w-[150px] flex-1 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"><option value="preserve">保留原始大小写</option><option value="upper">全部大写</option><option value="lower">全部小写</option></select></>}
              {part.type === 'sequence' && <><span className="text-xs text-slate-500">第一位</span><input type="number" min="0" value={part.sequenceStart} onChange={event => updateBatchRenamePart(part.id, { sequenceStart: Math.max(0, Number(event.target.value) || 0) })} className="w-24 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"/><span className="text-xs text-slate-500">位数</span><select value={part.sequenceDigits} onChange={event => updateBatchRenamePart(part.id, { sequenceDigits: Number(event.target.value) })} className="w-24 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm">{[1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{value} 位</option>)}</select></>}
              {part.type === 'letter' && <><span className="text-xs text-slate-500">字母大小写</span><select value={part.letterCase} onChange={event => updateBatchRenamePart(part.id, { letterCase: event.target.value as BatchRenamePart['letterCase'] })} className="min-w-[130px] flex-1 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"><option value="upper">大写（A, B…）</option><option value="lower">小写（a, b…）</option></select></>}
              {part.type === 'datetime' && <><select value={part.dateSource} onChange={event => updateBatchRenamePart(part.id, { dateSource: event.target.value as BatchRenamePart['dateSource'] })} className="w-28 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"><option value="created">创建日期</option><option value="modified">修改日期</option></select><select value={part.dateFormat} onChange={event => updateBatchRenamePart(part.id, { dateFormat: event.target.value })} className="min-w-[220px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm"><option value="YYYYMMDD_HHmmss">YYYYMMDD_HHmmss</option><option value="YYYYMMDD">YYYYMMDD</option><option value="HHmmss">HHmmss</option><option value="DDMMYYYY_HHmmss">DDMMYYYY_HHmmss</option><option value="DDMMYYYY">DDMMYYYY</option></select></>}
              {part.type === 'replace' && <><input value={part.find} onChange={event => updateBatchRenamePart(part.id, { find: event.target.value })} placeholder="将…" className="min-w-[120px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"/><ArrowRight size={14} className="text-slate-400"/><input value={part.replace} onChange={event => updateBatchRenamePart(part.id, { replace: event.target.value })} placeholder="替换为…（留空则删除）" className="min-w-[160px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"/></>}
            </div>
            <button type="button" onClick={() => insertBatchRenamePart(index)} title="在下方增加一行" className="rounded-md p-2 text-blue-600 hover:bg-blue-50"><Plus size={16}/></button>
            <button type="button" disabled={batchRenameParts.length === 1} onClick={() => setBatchRenameParts(parts => parts.filter(item => item.id !== part.id))} title="删除这一行" className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30"><X size={16}/></button>
          </div>)}</div>
        </section>
        <section className="mt-5 border-t border-slate-200 pt-5"><h4 className="mb-2 text-sm font-bold text-slate-700">扩展名</h4><div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><select value={batchExtensionMode} onChange={event => setBatchExtensionMode(event.target.value as 'preserve' | 'replace')} className="w-40 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"><option value="preserve">不修改扩展名</option><option value="replace">修改扩展名</option></select>{batchExtensionMode === 'replace' && <input autoFocus value={batchExtensionValue} onChange={event => setBatchExtensionValue(event.target.value.replace(/^\.+/, ''))} placeholder="例如 jpg" className="min-w-[180px] flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"/>}<span className="text-xs text-slate-400">文件夹不受此设置影响</span></div></section>
        <section className="mt-5 border-t border-slate-200 pt-5"><h4 className="mb-2 text-sm font-bold text-slate-700">预览</h4><div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50">{batchRenameEntries.slice(0, 20).map((entry, index) => <div key={entry.path} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-3 py-2 text-xs last:border-0"><span className="truncate text-slate-500" title={entry.name}>{entry.name}</span><ArrowRight size={13} className="text-slate-300"/><span className="truncate font-medium text-slate-700" title={batchRenameNames[index]}>{batchRenameNames[index] || '（空文件名）'}</span></div>)}{batchRenameEntries.length > 20 && <p className="px-3 py-2 text-center text-xs text-slate-400">另有 {batchRenameEntries.length - 20} 个项目</p>}</div></section>
      </div><footer className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-4"><p className="text-xs text-slate-500">重命名使用临时文件过渡，不会因名称互换产生冲突。</p><div className="flex gap-2"><button onClick={() => setBatchRenameOpen(false)} className="dialog-secondary">取消</button><button onClick={commitBatchRename} disabled={!batchRenameNames.length || batchRenameNames.some(name => !name) || batchExtensionMode === 'replace' && !batchExtensionValue.trim() || new Set(batchRenameNames.map(name => name.toLocaleLowerCase())).size !== batchRenameNames.length || renameCommitRef.current} className="dialog-primary">批量重命名</button></div></footer></div></div>}

      <section className="flex min-h-[220px] min-w-0 flex-1 flex-col">
        <div ref={filesSurfaceRef} onContextMenu={openSurfaceMenu} onPointerDown={startSelectionDrag} onPointerMove={updateSelectionDrag} onPointerUp={finishSelectionDrag} onPointerCancel={finishSelectionDrag} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} className={`relative -mx-6 min-h-[220px] flex-1 select-none px-6 transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {selectionBox && <div className="pointer-events-none absolute z-20 border border-blue-500 bg-blue-400/15" style={selectionBox}/>}
          {displayedFileEntries.length ? viewMode === 'list' ? <div className="min-w-[620px] border-y border-slate-200 text-sm">
            <div className="file-list-row file-list-heading text-xs font-medium text-slate-500"><span>名称</span><span>修改日期</span><span>类型</span><span>大小</span></div>
            {virtualWindow.top > 0 && <div aria-hidden style={{ height: virtualWindow.top }} />}
            {renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={() => handleEntryClick(entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`file-list-row group w-full cursor-default border-t border-slate-200 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-inset ring-blue-500' : ''}`}>
              <span className="flex min-w-0 items-center gap-2.5"><span onClick={event => { event.stopPropagation(); toggleSelected(entry.relativePath); }} className={`file-select-box ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-transparent'} flex h-4 w-4 shrink-0 items-center justify-center rounded border`}><CheckSquare size={12}/></span><span className="relative flex h-9 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-slate-100">{renderEntryIcon(entry)}</span>{renderEntryName(entry)}</span>
              <span className="text-slate-500">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '…'}</span>
              <span className="uppercase text-slate-500">{entry.kind === 'folder' ? '文件夹' : entry.kind === 'raw' ? `RAW · ${entry.extension.slice(1)}` : entry.kind === 'video' ? `视频 · ${entry.extension.slice(1)}` : entry.extension.slice(1) || '文件'}</span>
              <span className="text-slate-500">{entry.kind === 'folder' ? '' : entry.size >= 0 ? formatFileSize(entry.size) : '…'}</span>
            </div>)}
            {virtualWindow.bottom > 0 && <div aria-hidden style={{ height: virtualWindow.bottom }} />}
          </div> : <><div aria-hidden style={{ height: virtualWindow.top }}/><div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={() => handleEntryClick(entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50 ring-1 ring-blue-400' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-blue-500' : ''}`}><span onClick={event => { event.stopPropagation(); toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span><div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-slate-100">{renderEntryIcon(entry, true)}</div>{renderEntryName(entry, true)}<p className="mt-0.5 text-[10px] uppercase text-slate-400">{entry.kind === 'folder' ? '文件夹' : entry.extension.slice(1) || '文件'}</p></div>)}</div><div aria-hidden style={{ height: virtualWindow.bottom }}/></> : <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">{searchQuery ? `没有找到包含“${searchQuery}”的文件。` : '当前文件夹为空。'}</p>}
        </div>
      </section>

      <section className="hidden rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-slate-800">项目文件夹</h3><span className="text-sm text-slate-500">{folders.length} 个</span></div>
        {folders.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{folders.map(folder => <button key={folder.path} onClick={() => openFolder(folder.name)} title={`打开 ${folder.name}`} className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-blue-50"><Folder size={64} strokeWidth={1.5} fill="currentColor" className="text-blue-500 drop-shadow-sm transition-transform group-hover:scale-105"/><span className="max-w-full truncate text-sm font-medium text-slate-700">{folder.name}</span></button>)}</div> : <p className="py-8 text-center text-sm text-slate-400">当前项目还没有子文件夹。</p>}
      </section>

      </div>
      {previewPaneOpen && <><ColumnResizeHandle label="调整文件区和预览区宽度" onDrag={resizeFilesAndPreview}/><MediaPreviewPane entry={previewEntry} cacheConfig={mediaCacheConfig} width={displayedColumnWidths.preview} onTechnicalMetadata={setPreviewTechnicalMetadata} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onClose={() => setPreviewPaneOpen(false)}/></>}
      {metadataPaneOpen && <><ColumnResizeHandle label={previewPaneOpen ? '调整预览区和元数据区宽度' : '调整文件区和元数据区宽度'} onDrag={previewPaneOpen ? resizePreviewAndMetadata : resizeFilesAndMetadata}/><FileMetadataPane entry={previewEntry} metadataFields={currentPreviewMetadataFields} metadataLoading={currentPreviewMetadataLoading} metadataError={currentPreviewMetadataError} technicalMetadata={previewTechnicalMetadata} formatFileSize={formatFileSize} width={displayedColumnWidths.metadata} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onCopyPath={() => previewEntry && copyEntryPath(previewEntry)} onClose={() => setMetadataPaneOpen(false)}/></>}
      </div>

      {confirmDelete && <div className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/40 p-4"><div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-800">确定要删除项目吗？</h3><button onClick={() => setConfirmDelete(false)}><X size={18}/></button></div><p className="text-sm text-slate-500">删除项目会将项目文件夹“{project.name}”移入回收站。</p><div className="mt-5 flex justify-end gap-2"><button onClick={() => setConfirmDelete(false)} className="dialog-secondary">取消</button><button onClick={async () => { setConfirmDelete(false); await moveToTrash(); }} className="rounded-md bg-red-600 px-3 py-2 text-sm font-bold text-white hover:bg-red-500">删除项目</button></div></div></div>}
    </div>
  );
};

const formatMediaDuration = (seconds?: number) => {
  if (!seconds || !Number.isFinite(seconds)) return '—';
  const wholeSeconds = Math.round(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
};

const MediaPreviewPane = ({ entry, cacheConfig, width, onTechnicalMetadata, onOpen, onClose }: {
  entry?: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  width: number;
  onTechnicalMetadata: (metadata: PreviewTechnicalMetadata) => void;
  onOpen: () => void;
  onClose: () => void;
}) => {
  const [resource, setResource] = useState<{ previewUrl?: string; originalUrl?: string; mediaUrl?: string; usingImportedPreview?: boolean; importedVideoWithoutPreview?: boolean; orientationMatrix?: number[]; orientationSwapsAxes?: boolean }>({});
  const [loading, setLoading] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalLoadError, setOriginalLoadError] = useState('');
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [imageZoom, setImageZoom] = useState(1);
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const [imageNaturalSize, setImageNaturalSize] = useState({ width: 0, height: 0 });
  const [imageSurfaceSize, setImageSurfaceSize] = useState({ width: 0, height: 0 });
  const [imageDragging, setImageDragging] = useState(false);
  const imageSurfaceRef = useRef<HTMLDivElement>(null);
  const imageDragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    let active = true;
    setPlaybackFailed(false);
    setImageZoom(1);
    setImagePan({ x: 0, y: 0 });
    setImageNaturalSize({ width: 0, height: 0 });
    setImageDragging(false);
    imageDragRef.current = null;
    setResource({ previewUrl: entry?.previewUrl });
    onTechnicalMetadata({});
    if (!entry) return () => { active = false; };
    const unsubscribe = window.electronAPI.onThumbnailStateChanged(update => {
      if (update.filePath.toLocaleLowerCase() !== entry.path.toLocaleLowerCase() || update.state !== 'READY') return;
      const previewUrl = update.previewUrls?.large;
      if (previewUrl) setResource(current => ({ ...current, previewUrl }));
      setLoading(false);
    });
    setLoading(true);
    requestThumbnail(() => window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, 1600, 0, -1))
      .then(result => {
        if (!active) return;
        if (result.success) setResource(current => ({ ...current, previewUrl: result.previewUrl || entry.previewUrl, mediaUrl: result.mediaUrl, usingImportedPreview: result.usingImportedPreview, importedVideoWithoutPreview: result.importedVideoWithoutPreview }));
        else onTechnicalMetadata({ unavailable: true });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); void window.electronAPI.cancelMediaThumbnail(entry.path, 1600); };
  }, [entry?.path, cacheConfig.directory, cacheConfig.maxSizeGB]);

  useEffect(() => {
    let active = true;
    let originalImage: HTMLImageElement | undefined;
    let imageLoadTimer: number | undefined;
    setOriginalLoading(false);
    setOriginalLoadError('');
    if (!entry || (entry.kind !== 'image' && entry.kind !== 'raw')) return () => { active = false; };

    // Avoid flashing the toast for images that are already in the OS/browser
    // cache, while keeping it visible for genuinely slow originals.
    const loadingTimer = window.setTimeout(() => {
      if (active) setOriginalLoading(true);
    }, 180);
    const requestTimer = window.setTimeout(() => {
      if (!active) return;
      setOriginalLoading(false);
      setOriginalLoadError('原图提取排队超时，当前显示预览图');
    }, 15000);
    window.electronAPI.getMediaOriginal(entry.path, entry.kind, cacheConfig).then(result => {
      if (!active) return;
      window.clearTimeout(requestTimer);
      if (!result.success || !result.mediaUrl) {
        window.clearTimeout(loadingTimer);
        setOriginalLoading(false);
        setOriginalLoadError(result.error || '原图加载失败，当前显示预览图');
        window.electronAPI.reportRendererError('Original image preview failed', `${entry.path}: ${result.error || 'unknown error'}`);
        return;
      }
      originalImage = new Image();
      imageLoadTimer = window.setTimeout(() => {
        if (!active) return;
        setOriginalLoading(false);
        setOriginalLoadError('原图加载超时，当前显示预览图');
      }, 15000);
      originalImage.onload = () => {
        if (!active) return;
        window.clearTimeout(loadingTimer);
        if (imageLoadTimer) window.clearTimeout(imageLoadTimer);
        setImageNaturalSize({ width: originalImage?.naturalWidth || 0, height: originalImage?.naturalHeight || 0 });
        setResource(current => ({
          ...current,
          originalUrl: result.mediaUrl,
          orientationMatrix: result.orientation?.matrix,
          orientationSwapsAxes: result.orientation?.swapsAxes
        }));
        setOriginalLoading(false);
        setOriginalLoadError('');
      };
      originalImage.onerror = () => {
        if (!active) return;
        window.clearTimeout(loadingTimer);
        if (imageLoadTimer) window.clearTimeout(imageLoadTimer);
        setOriginalLoading(false);
        setOriginalLoadError('原图解码失败，当前显示预览图');
      };
      originalImage.src = result.mediaUrl;
    }).catch(error => {
      window.clearTimeout(loadingTimer);
      window.clearTimeout(requestTimer);
      if (active) {
        setOriginalLoading(false);
        setOriginalLoadError('原图加载失败，当前显示预览图');
        window.electronAPI.reportRendererError('Original image preview request failed', `${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return () => {
      active = false;
      window.clearTimeout(loadingTimer);
      window.clearTimeout(requestTimer);
      if (imageLoadTimer) window.clearTimeout(imageLoadTimer);
      if (originalImage) {
        originalImage.onload = null;
        originalImage.onerror = null;
        originalImage.src = '';
      }
    };
  }, [entry?.path, entry?.kind, cacheConfig.directory, cacheConfig.maxSizeGB]);

  const displayedImageUrl = resource.originalUrl || resource.previewUrl;
  const imageOrientationMatrix = resource.originalUrl && resource.orientationMatrix?.length === 4 ? resource.orientationMatrix : [1, 0, 0, 1];
  const imageOrientationSwapsAxes = Boolean(resource.originalUrl && resource.orientationSwapsAxes);
  const imageOrientationKey = imageOrientationMatrix.join(',');

  useEffect(() => {
    if (!resource.originalUrl) return;
    // The thumbnail and corrected RAW preview can have different orientations.
    // Discard the old transform and remeasure the pane so the rotated image is
    // fitted from scratch instead of inheriting the landscape layout.
    setImageZoom(1);
    setImagePan({ x: 0, y: 0 });
    setImageDragging(false);
    imageDragRef.current = null;
    const surface = imageSurfaceRef.current;
    if (surface) setImageSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
  }, [resource.originalUrl, imageOrientationKey]);

  useEffect(() => {
    const surface = imageSurfaceRef.current;
    if (!surface) return;
    const measure = () => setImageSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [displayedImageUrl, entry?.kind]);

  // Fit against the full preview viewport. The previous 12px inset on every
  // side became especially visible after a portrait RAW was rotated.
  const availableImageWidth = Math.max(1, imageSurfaceSize.width);
  const availableImageHeight = Math.max(1, imageSurfaceSize.height);
  const orientedNaturalSize = {
    width: Math.abs(imageOrientationMatrix[0]) * imageNaturalSize.width + Math.abs(imageOrientationMatrix[2]) * imageNaturalSize.height,
    height: Math.abs(imageOrientationMatrix[1]) * imageNaturalSize.width + Math.abs(imageOrientationMatrix[3]) * imageNaturalSize.height
  };
  const fittedImageScale = imageNaturalSize.width && imageNaturalSize.height
    ? Math.min(availableImageWidth / orientedNaturalSize.width, availableImageHeight / orientedNaturalSize.height)
    : 0;
  const fittedImageElementSize = {
    width: imageNaturalSize.width * fittedImageScale,
    height: imageNaturalSize.height * fittedImageScale
  };
  const fittedImageSize = {
    width: orientedNaturalSize.width * fittedImageScale,
    height: orientedNaturalSize.height * fittedImageScale
  };
  const clampImagePan = (pan: { x: number; y: number }, zoom: number) => {
    // Once an axis fills the viewport, disallow movement far enough to reveal
    // extra blank space. A letterboxed axis remains centered.
    const maximumX = Math.max(0, (fittedImageSize.width * zoom - imageSurfaceSize.width) / 2);
    const maximumY = Math.max(0, (fittedImageSize.height * zoom - imageSurfaceSize.height) / 2);
    return {
      x: clampNumber(pan.x, -maximumX, maximumX),
      y: clampNumber(pan.y, -maximumY, maximumY)
    };
  };

  useEffect(() => {
    setImagePan(current => {
      const next = clampImagePan(current, imageZoom);
      return next.x === current.x && next.y === current.y ? current : next;
    });
  }, [imageSurfaceSize.width, imageSurfaceSize.height, fittedImageSize.width, fittedImageSize.height, imageZoom]);

  const zoomImage = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const surface = event.currentTarget;
    const rect = surface.getBoundingClientRect();
    const pointerX = event.clientX - rect.left - rect.width / 2;
    const pointerY = event.clientY - rect.top - rect.height / 2;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextZoom = clampNumber(imageZoom * factor, 1, 8);
    if (nextZoom === imageZoom) return;
    const currentHalfWidth = fittedImageSize.width * imageZoom / 2;
    const currentHalfHeight = fittedImageSize.height * imageZoom / 2;
    // If the cursor is over letterbox space, anchor to the nearest image edge
    // instead of treating the empty pane as part of the image.
    const anchorX = clampNumber(pointerX, imagePan.x - currentHalfWidth, imagePan.x + currentHalfWidth);
    const anchorY = clampNumber(pointerY, imagePan.y - currentHalfHeight, imagePan.y + currentHalfHeight);
    const ratio = nextZoom / imageZoom;
    const nextPan = clampImagePan({
      x: anchorX - (anchorX - imagePan.x) * ratio,
      y: anchorY - (anchorY - imagePan.y) * ratio
    }, nextZoom);
    setImagePan(nextPan);
    setImageZoom(nextZoom);
  };
  const resetImageZoom = () => {
    setImageZoom(1);
    setImagePan({ x: 0, y: 0 });
    setImageDragging(false);
    imageDragRef.current = null;
  };
  const beginImagePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || imageZoom <= 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    imageDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: imagePan.x,
      panY: imagePan.y
    };
    setImageDragging(true);
  };
  const moveImagePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = imageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setImagePan(clampImagePan({
      x: drag.panX + event.clientX - drag.startX,
      y: drag.panY + event.clientY - drag.startY
    }, imageZoom));
  };
  const finishImagePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = imageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    imageDragRef.current = null;
    setImageDragging(false);
  };
  const handleVideoPlaybackError = () => {
    if (!entry || entry.kind !== 'video') return;
    setPlaybackFailed(true);
    setLoading(false);
    onTechnicalMetadata({ unavailable: true });
  };

  return <section style={{ width }} className="flex min-h-0 shrink-0 flex-col bg-slate-50">
    <header className="flex h-20 shrink-0 items-end justify-between border-b border-slate-200 px-4 pb-2 pt-7">
      <div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">预览</p><p className="truncate text-sm font-semibold text-slate-700">{entry?.name || '未选择媒体'}</p></div>
      <div className="flex items-center gap-1">{entry && <button type="button" onClick={onOpen} title="使用系统默认应用打开" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><ExternalLink size={16}/></button>}<button type="button" onClick={onClose} title="关闭预览" aria-label="关闭预览" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button></div>
    </header>
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-slate-50">
      {!entry && <div className="max-w-[220px] text-center"><ImageIcon size={38} strokeWidth={1.4} className="mx-auto text-slate-600"/><p className="mt-3 text-sm font-medium text-slate-300">点击图片、RAW 或视频文件</p><p className="mt-1 text-xs leading-5 text-slate-500">此处会显示大图或轻量视频预览</p></div>}
      {entry && entry.kind === 'video' && resource.mediaUrl && !playbackFailed && <video key={resource.mediaUrl} controls preload="metadata" poster={resource.previewUrl} className="max-h-full max-w-full bg-black" onLoadedMetadata={event => { setLoading(false); onTechnicalMetadata({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight, duration: event.currentTarget.duration }); }} onError={handleVideoPlaybackError}><source src={resource.mediaUrl}/></video>}
      {entry && entry.kind === 'video' && (!resource.mediaUrl || playbackFailed) && <div className="flex max-h-full w-full flex-col items-center justify-center gap-4 text-center">{resource.previewUrl ? <img src={resource.previewUrl} alt={entry.name} draggable={false} className="max-h-[70%] max-w-full object-contain"/> : <Video size={52} strokeWidth={1.3} className="text-slate-600"/>}<div className="max-w-sm px-6"><p className="text-sm font-medium text-slate-700">{resource.importedVideoWithoutPreview ? '此导入视频没有软件内快速预览' : playbackFailed ? resource.usingImportedPreview ? '导入的视频预览无法播放' : '当前原始编码无法在应用内播放' : loading ? '正在准备视频预览…' : resource.previewUrl ? '视频封面已就绪' : '没有可用的视频封面'}</p>{resource.importedVideoWithoutPreview && <p className="mt-1 text-xs leading-5 text-slate-500">请在导入设置中开启“生成视频预览”。浏览时不会为这类大型导入视频临时转码。</p>}{playbackFailed && !resource.importedVideoWithoutPreview && <p className="mt-1 text-xs leading-5 text-slate-500">可以使用系统默认播放器打开原文件。</p>}<button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button></div></div>}
      {entry && entry.kind !== 'video' && displayedImageUrl && (
        <div ref={imageSurfaceRef} onWheel={zoomImage} onDoubleClick={resetImageZoom} onPointerDown={beginImagePan} onPointerMove={moveImagePan} onPointerUp={finishImagePan} onPointerCancel={finishImagePan} style={{ touchAction: 'none' }} className={`absolute inset-0 overflow-hidden ${imageZoom > 1 ? imageDragging ? 'cursor-grabbing' : 'cursor-grab' : ''}`}>
          <div
            style={{
              width: fittedImageSize.width || '100%',
              height: fittedImageSize.height || '100%',
              transform: `translate(-50%, -50%) translate3d(${imagePan.x}px, ${imagePan.y}px, 0) scale(${imageZoom})`,
              transformOrigin: 'center',
              willChange: 'transform'
            }}
            className="pointer-events-none absolute left-1/2 top-1/2"
          >
            <img
              src={displayedImageUrl}
              alt={entry.name}
              draggable={false}
              style={{
                width: fittedImageElementSize.width || undefined,
                height: fittedImageElementSize.height || undefined,
                // Tailwind Preflight applies max-width:100% to every image.
                // A portrait RAW is laid out landscape inside a narrower,
                // already-rotated wrapper, so that global rule would shrink it
                // a second time unless it is explicitly disabled here.
                maxWidth: fittedImageElementSize.width ? 'none' : '100%',
                maxHeight: fittedImageElementSize.height ? 'none' : '100%',
                transform: `translate(-50%, -50%) matrix(${imageOrientationMatrix.join(',')}, 0, 0)`,
                transformOrigin: 'center'
              }}
              className="pointer-events-none absolute left-1/2 top-1/2 select-none object-contain"
              onLoad={event => {
                const sourceSize = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
                const naturalSize = imageOrientationSwapsAxes ? { width: sourceSize.height, height: sourceSize.width } : sourceSize;
                setImageNaturalSize(sourceSize);
                onTechnicalMetadata(naturalSize);
              }}
              onError={() => onTechnicalMetadata({ unavailable: true })}
            />
          </div>
        </div>
      )}
      {entry && entry.kind !== 'video' && displayedImageUrl && <button type="button" onClick={resetImageZoom} title="恢复适合窗口" className="absolute bottom-4 right-4 rounded-md bg-slate-900/75 px-2 py-1 font-mono text-[11px] text-slate-200 shadow-lg">{Math.round(imageZoom * 100)}%</button>}
      {entry && entry.kind !== 'video' && !displayedImageUrl && !loading && <div className="text-center"><FileImage size={48} strokeWidth={1.3} className="mx-auto text-slate-600"/><p className="mt-3 text-sm text-slate-400">无法生成此文件的预览</p><button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button></div>}
      {entry && loading && <span className="absolute right-4 top-4 rounded-full bg-slate-900/80 p-2 text-slate-300"><Loader2 size={17} className="animate-spin"/></span>}
      {originalLoading && <div role="status" className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-slate-900/85 px-3 py-2 text-xs font-bold text-white shadow-xl"><Loader2 size={15} className="animate-spin text-blue-300"/><span>正在加载原图…</span></div>}
      {!originalLoading && originalLoadError && displayedImageUrl && <div role="status" className="absolute bottom-4 left-1/2 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-lg bg-slate-900/85 px-3 py-2 text-xs text-amber-200 shadow-xl" title={originalLoadError}>{originalLoadError}</div>}
    </div>
  </section>;
};

const METADATA_GROUP_LABELS: Record<string, string> = {
  Application: '文件', System: '文件系统', File: '文件属性', IFD0: '图像与相机', ExifIFD: '拍摄信息', ExifIFD1: '拍摄信息',
  Composite: '计算信息', MakerNotes: '相机厂商信息', XMP: 'XMP', XMPdc: 'XMP 描述', XMPphotoshop: 'Photoshop', XMPxmp: 'XMP 基础',
  IPTC: 'IPTC', ICC_Profile: '颜色配置', QuickTime: 'QuickTime', Track1: '视频轨道', Track2: '音频轨道', Track3: '媒体轨道',
  RIFF: '媒体容器', PNG: 'PNG', JFIF: 'JFIF', GPS: '位置', ExifTool: 'ExifTool'
};
const IMPORTANT_METADATA_ICONS: Record<string, typeof Camera> = {
  相机: Camera, 镜头: ScanSearch, 拍摄时间: Calendar, 尺寸: Ruler, 光圈: Aperture, 快门: Timer, ISO: Gauge, 焦距: ScanSearch,
  编码: Video, 帧率: Activity, 时长: Timer, 码率: Gauge, 音频: Volume2
};

const MetadataRow = ({ label, value }: { label: string; value: React.ReactNode }) => <div className="grid grid-cols-[minmax(76px,38%)_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2 last:border-b-0"><dt className="break-words text-[11px] font-medium text-slate-400">{label}</dt><dd className="select-text break-words text-xs leading-5 text-slate-700">{value}</dd></div>;

const FileMetadataPane = ({ entry, metadataFields, metadataLoading, metadataError, technicalMetadata, formatFileSize, width, onOpen, onCopyPath, onClose }: {
  entry?: ProjectFileEntry;
  metadataFields: MediaMetadataField[];
  metadataLoading: boolean;
  metadataError: string;
  technicalMetadata: PreviewTechnicalMetadata;
  formatFileSize: (size: number) => string;
  width: number;
  onOpen: () => void;
  onCopyPath: () => void;
  onClose: () => void;
}) => {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    setExpandedGroups(new Set(['Application', ...metadataFields.map(field => field.group)]));
  }, [entry?.path, metadataFields]);

  const mediaType = entry?.kind === 'image' ? '图片' : entry?.kind === 'raw' ? 'RAW 图片' : entry?.kind === 'video' ? '视频' : '文件';
  const firstValue = (...names: string[]) => pickMetadataValue(metadataFields, ...names);
  const exactWidth = firstValue('ImageWidth', 'SourceImageWidth', 'ExifImageWidth');
  const exactHeight = firstValue('ImageHeight', 'SourceImageHeight', 'ExifImageHeight');
  const dimensions = exactWidth && exactHeight ? `${exactWidth} × ${exactHeight}` : technicalMetadata.width && technicalMetadata.height ? `${technicalMetadata.width} × ${technicalMetadata.height}` : undefined;
  const cameraMake = firstValue('Make');
  const cameraModel = firstValue('Model');
  const camera = cameraMake && cameraModel && cameraModel.toLocaleLowerCase().startsWith(cameraMake.toLocaleLowerCase()) ? cameraModel : [cameraMake, cameraModel].filter(Boolean).join(' ');
  const importantItems = (entry?.kind === 'video' ? [
    ['编码', firstValue('CompressorName', 'VideoCodec', 'Encoder')], ['尺寸', dimensions], ['帧率', firstValue('VideoFrameRate', 'CaptureFrameRate')],
    ['时长', firstValue('Duration') || formatMediaDuration(technicalMetadata.duration)], ['码率', firstValue('AvgBitrate', 'VideoAvgBitrate', 'Bitrate')], ['音频', firstValue('AudioFormat', 'AudioCodec')]
  ] : [
    ['相机', camera], ['镜头', firstValue('LensModel', 'Lens')], ['拍摄时间', formatCaptureDate(firstValue('DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate'))], ['尺寸', dimensions],
    ['光圈', firstValue('FNumber', 'Aperture')], ['快门', formatShutterSpeed(firstValue('ExposureTime', 'ShutterSpeed'))], ['ISO', firstValue('ISO')], ['焦距', firstValue('FocalLength')]
  ]).filter((item): item is string[] => Boolean(item[1] && item[1] !== '—'));
  const applicationFields: MediaMetadataField[] = entry ? [
    { group: 'Application', name: '文件名', value: entry.name }, { group: 'Application', name: '媒体类型', value: mediaType },
    { group: 'Application', name: '文件大小', value: entry.size >= 0 ? formatFileSize(entry.size) : '正在读取…' },
    { group: 'Application', name: '项目内路径', value: entry.relativePath }, { group: 'Application', name: '完整路径', value: entry.path }
  ] : [];
  const groupedMetadata = [...applicationFields, ...metadataFields].reduce((groups, field) => {
    const existing = groups.get(field.group) || [];
    existing.push(field);
    groups.set(field.group, existing);
    return groups;
  }, new Map<string, MediaMetadataField[]>());
  const groupNames = Array.from(groupedMetadata.keys());
  const allExpanded = groupNames.length > 0 && groupNames.every(group => expandedGroups.has(group));
  const toggleGroup = (group: string) => setExpandedGroups(current => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });

  return <aside style={{ width }} className="flex min-h-0 shrink-0 flex-col bg-white">
    <header className="flex h-20 shrink-0 items-end justify-between border-b border-slate-200 px-4 pb-2 pt-7"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">元数据</p><p className="truncate text-sm font-semibold text-slate-700">{entry?.name || '文件信息'}</p></div><button type="button" onClick={onClose} title="关闭元数据" aria-label="关闭元数据" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {!entry ? <div className="py-12 text-center"><FileText size={34} strokeWidth={1.4} className="mx-auto text-slate-300"/><p className="mt-3 text-sm text-slate-400">选择媒体后显示文件信息</p></div> : <>
        {importantItems.length > 0 && <section className="grid grid-cols-2 gap-1.5 py-2">{importantItems.map(([label, value]) => { const Icon = IMPORTANT_METADATA_ICONS[label] || FileText; return <div key={label} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2"><p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Icon size={12}/>{label}</p><p title={value} className="mt-1 truncate text-xs font-semibold text-slate-700">{value}</p></div>; })}</section>}
        <div className="flex items-center justify-between border-b border-slate-200 py-2"><span className="text-[11px] text-slate-400">{metadataLoading ? '正在读取完整元数据…' : `${metadataFields.length + applicationFields.length} 个字段`}</span>{groupNames.length > 1 && <button type="button" onClick={() => setExpandedGroups(allExpanded ? new Set() : new Set(groupNames))} className="text-[11px] font-bold text-blue-500 hover:text-blue-400">{allExpanded ? '全部折叠' : '全部展开'}</button>}</div>
        {metadataError && <p className="my-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-600">{metadataError}</p>}
        {groupNames.map(group => {
          const fields = groupedMetadata.get(group) || [];
          const expanded = expandedGroups.has(group);
          return <section key={group} className="border-b border-slate-200"><button type="button" onClick={() => toggleGroup(group)} className="flex w-full items-center gap-2 py-2.5 text-left"><span className="text-slate-400">{expanded ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}</span><span className="text-xs font-bold text-slate-700">{METADATA_GROUP_LABELS[group] || group}</span><span className="ml-auto text-[10px] text-slate-400">{fields.length}</span></button>{expanded && <dl className="pb-2">{fields.map((field, index) => <MetadataRow key={`${group}:${field.name}:${index}`} label={field.name} value={field.value}/>)}</dl>}</section>;
        })}
        <div className="flex flex-col gap-2 py-4"><button type="button" onClick={onOpen} className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button><button type="button" onClick={onCopyPath} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><Copy size={14}/>复制文件地址</button></div>
      </>}
    </div>
  </aside>;
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
const MediaThumbnail = ({ entry, cacheConfig, requestedSize, queueOrder, large = false }: { entry: ProjectFileEntry; cacheConfig: AppConfig['mediaCache']; requestedSize: number; queueOrder: number; large?: boolean }) => {
  const videoPreviewSize = Math.max(320, Math.min(1600, requestedSize));
  const [preview, setPreview] = useState<{ url?: string; size: number }>({ url: entry.previewUrl, size: entry.previewUrl ? 320 : 0 });
  const [videoFrames, setVideoFrames] = useState<string[]>([]);
  const [videoPreviewComplete, setVideoPreviewComplete] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  const thumbnailSizeLabel = requestedSize <= 320 ? 'small' : requestedSize <= 640 ? 'medium' : 'large';
  useEffect(() => () => { void window.electronAPI.cancelMediaThumbnail(entry.path, requestedSize); }, [entry.path, requestedSize]);
  useEffect(() => {
    if (preview.size >= requestedSize || !container.current) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      setLoading(true);
      requestThumbnail(() => window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 1, queueOrder))
        .then(result => {
          if (!active) return;
          if (result.previewUrl) setPreview({ url: result.previewUrl, size: requestedSize });
          if (result.state !== 'QUEUED' && result.state !== 'GENERATING') setLoading(false);
        })
        .catch(() => { if (active) setLoading(false); });
    }, { rootMargin: '240px' });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [entry.path, entry.kind, preview.size, cacheConfig, requestedSize, queueOrder]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      void window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 0, queueOrder);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [entry.kind, entry.path, cacheConfig, requestedSize, queueOrder]);
  useEffect(() => window.electronAPI.onThumbnailStateChanged(update => {
    if (update.filePath.toLocaleLowerCase() !== entry.path.toLocaleLowerCase()) return;
    if (update.state === 'READY') {
      const url = update.previewUrls?.[thumbnailSizeLabel];
      if (url) setPreview({ url, size: requestedSize });
      setLoading(false);
    } else if (update.state === 'FAILED' || update.state === 'MISSING') {
      setLoading(false);
    }
  }), [entry.path, requestedSize, thumbnailSizeLabel]);
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
  return <span ref={container} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)} className="relative flex h-full w-full items-center justify-center overflow-hidden">{displayedUrl ? <img src={displayedUrl} alt="" className="h-full w-full object-contain"/> : <FileImage size={large ? 42 : 23} className="text-slate-400"/>}{loading && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-900/25"><Loader2 size={large ? 24 : 16} className="animate-spin text-white drop-shadow"/><span className="sr-only">正在加载预览</span></span>}{entry.kind === 'video' && durationLabel && <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-bold leading-4 text-white shadow">{durationLabel}</span>}</span>;
};

const MediaCacheSettings = ({ config, onChange }: { config: AppConfig['mediaCache']; onChange: (config: AppConfig['mediaCache']) => void }) => {
  const [info, setInfo] = useState({ path: '', sizeBytes: 0, fileCount: 0 });
  const [busy, setBusy] = useState(false);
  const [capacityInput, setCapacityInput] = useState(String(config.maxSizeGB));
  const refreshInfo = async (nextConfig = config) => {
    const result = await window.electronAPI.getMediaCacheInfo(nextConfig);
    if (result.success) setInfo(result);
  };
  useEffect(() => { refreshInfo(); }, [config.directory, config.maxSizeGB]);
  useEffect(() => { setCapacityInput(String(config.maxSizeGB)); }, [config.maxSizeGB]);
  const chooseDirectory = async () => {
    const result = await window.electronAPI.chooseCacheDirectory();
    if (!result.path) return;
    const next = { ...config, directory: result.path };
    onChange(next);
    refreshInfo(next);
  };
  const commitCapacity = () => {
    const maxSizeGB = normalizeMediaCacheSize(capacityInput);
    setCapacityInput(String(maxSizeGB));
    if (maxSizeGB !== config.maxSizeGB) onChange({ ...config, maxSizeGB });
  };
  const clearAll = async () => {
    setBusy(true);
    try {
      await window.electronAPI.clearMediaCache(config);
      await refreshInfo();
    } finally { setBusy(false); }
  };
  const sizeText = info.sizeBytes >= 1024 * 1024 * 1024 ? `${(info.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB` : `${Math.round(info.sizeBytes / 1024 / 1024)} MB`;
  return <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-end">
    <div className="space-y-4">
      <div><label className="form-label">最大缓存容量</label><div className="flex max-w-xs items-center gap-2"><input type="number" min={0} step={0.1} inputMode="decimal" value={capacityInput} onChange={event => setCapacityInput(event.target.value)} onBlur={commitCapacity} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="form-input"/><span className="text-sm font-medium text-slate-500">GB</span></div><p className="mt-2 text-xs text-slate-500">超过上限时自动清理最久未使用的缩略图。</p></div>
      <div><label className="form-label">缓存目录</label><div className="flex gap-2"><input readOnly value={info.path || config.directory || '默认应用缓存目录'} className="form-input min-w-0 font-mono text-xs"/><button onClick={chooseDirectory} className="dialog-secondary shrink-0">选择目录</button></div></div>
      <label className="settings-check"><input type="checkbox" checked={config.autoCleanup30Days} onChange={event => onChange({ ...config, autoCleanup30Days: event.target.checked })}/><span><span className="block">自动清理 30 天以前的缓存</span><span className="mt-1 block text-xs leading-5 text-slate-500">启用后会立即检查一次，并在应用运行期间每天自动检查。</span></span></label>
    </div>
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm"><p className="font-bold text-slate-800">当前缓存：{sizeText}</p><p className="mt-1 text-xs text-slate-500">{info.fileCount} 个缓存文件</p><div className="mt-3 flex flex-wrap gap-2"><button onClick={clearAll} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14}/>{busy ? '正在清理…' : '清空全部缓存'}</button></div></div>
  </div>;
};

const CollapsiblePanel = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => (
  <section className="rounded-xl border border-slate-200 bg-white p-6 animate-in slide-in-from-top-2 duration-200">
    <div className="mb-5 flex items-center justify-between border-b border-slate-100 pb-4"><h3 className="text-lg font-bold text-slate-800">{title}</h3><button onClick={onClose} className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-50">收起 <ChevronUp size={16}/></button></div>
    {children}
  </section>
);
const AboutPage = () => {
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'latest' | 'error'>('idle');
  const checkForUpdates = async () => {
    setUpdateStatus('checking');
    const result = await window.electronAPI.checkForUpdates();
    setUpdateStatus(result.success && !result.updateAvailable ? 'latest' : result.success ? 'idle' : 'error');
  };

  return <section aria-labelledby="about-title" className="flex min-h-full w-full flex-col bg-white">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 px-6 py-5"><h3 id="about-title" className="flex items-center gap-2 text-xl font-bold text-slate-800"><AtSign size={20} className="text-blue-600"/>关于</h3></header>
      <div className="mx-auto w-full max-w-4xl flex-1 space-y-5 p-6 text-sm leading-7 text-slate-600">
        <div><p className="text-lg font-bold text-slate-800">by秋也寻</p><div className="mt-1 flex flex-wrap items-center gap-3"><p className="text-blue-600">版本 26.7.19</p><button onClick={checkForUpdates} disabled={updateStatus === 'checking'} className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-bold leading-5 text-blue-700 transition hover:bg-blue-100 disabled:cursor-wait disabled:opacity-60">{updateStatus === 'checking' ? '正在检查…' : '检查更新'}</button>{updateStatus === 'latest' && <span className="text-xs text-emerald-600">已是最新版本</span>}{updateStatus === 'error' && <span className="text-xs text-red-500">检查失败，请稍后重试</span>}</div></div>
        <section><h4 className="text-base font-bold text-slate-800">软件简介</h4><p className="mt-1">照片流是一款为摄影师设计的项目管理与素材整理工具，帮助你跟进拍摄进度，并自动从 SD 卡导入和整理照片、视频。</p></section>
        <section><h4 className="text-base font-bold text-slate-800">功能说明</h4><p className="mt-1">调研整理功能可配合脚本整理下载的图片与视频、截取视频帧，并汇总调研资料信息。<br/>团片管理功能可将高像素大图裁切为便于修图的小图，后续再拼接回完整大图；也支持对比、对比图片并交接给下一位修图人员。</p></section>
        <section><h4 className="text-base font-bold text-slate-800">制作说明</h4><p className="mt-1">早期版本的大部分代码由 Google Gemini 与 Copilot 生成；当前版本主要使用 Codex 制作。</p></section>
        <section className="rounded-xl border border-blue-100 bg-blue-50 p-4"><h4 className="text-base font-bold text-slate-800">项目与联系</h4><p className="mt-1">如果你有任何建议或遇到问题，欢迎通过邮箱联系我，也可以前往项目仓库反馈。</p><div className="mt-3 flex flex-col items-start gap-2 leading-5"><button type="button" onClick={() => window.electronAPI.openExternal('https://github.com/akiyastudio/photoflow')} className="inline-flex items-center gap-1.5 break-all text-left font-medium text-blue-600 hover:underline">https://github.com/akiyastudio/photoflow <ExternalLink size={13} className="shrink-0"/></button><button type="button" onClick={() => window.electronAPI.openExternal('mailto:akiyastudio@qq.com')} className="inline-flex items-center gap-1.5 font-medium text-blue-600 hover:underline">akiyastudio@qq.com <ExternalLink size={13}/></button></div></section>
        <section className="border-t border-slate-200 pt-5"><h4 className="text-base font-bold text-slate-800">使用提示</h4><p className="mt-1">软件尚未经过充分测试。使用前请备份重要数据；作者不对使用本软件造成的损失负责。</p></section>
      </div>
  </section>;
};

const RootApp = () => <AppErrorBoundary><App/></AppErrorBoundary>;
export default RootApp;
