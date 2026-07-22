import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Folder,
  X,
  Settings,
  AtSign,
  ExternalLink,
  Gift,
  PanelLeftClose,
  PanelLeftOpen,
  Home,
} from 'lucide-react';
import { ProjectNavigator } from './components/ProjectNavigator';
import { FileOperationProgressOverlay } from './features/file-operations/FileOperationProgressOverlay';
import { ProjectWorkspace } from './features/workspace/ProjectWorkspace';
import { AppErrorBoundary } from './features/app/AppErrorBoundary';
import { RequirePlugin } from './features/plugins/RequirePlugin';
import { BackgroundTaskIndicator } from './features/background-tasks/BackgroundTaskIndicator';
import { SettingsNavigator, SettingsPage, WorkspaceSetupPage } from './features/settings/SettingsFeature';
import { ConverterView, DashboardView, HomePanel, MatchView, ResearchView, VideoSplitView } from './features/tools/ToolViews';
import type { AppConfig, HomeCardId, ProjectFileOperationProgress, ToolType, WorkspaceProject } from './types';

const DEFAULT_HOME_ORDER: HomeCardId[] = ['birthday', 'import', 'research', 'converter'];
const normalizeHomeOrder = (value: unknown): HomeCardId[] => {
  const valid = new Set<HomeCardId>(DEFAULT_HOME_ORDER);
  const ordered = (Array.isArray(value) ? value : []).filter((card): card is HomeCardId => valid.has(card as HomeCardId));
  return [...new Set([...ordered, ...DEFAULT_HOME_ORDER])];
};
const IMAGE_SELECTION_FOLDER_NAME = '图片选片';
const VIDEO_SELECTION_FOLDER_NAME = '视频选片';
type SettingsSection = 'general' | 'storage' | 'components' | 'import';
const normalizeMediaCacheSize = (value: unknown, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};

const clampNumber = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
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
    sdDriveTypes: {},
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
  fileImport: {
    preserveOriginal: false
  },
  imageConversion: {
    jpgQuality: 100
  },
  personDetection: {
    useGpu: true
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
  requestId?: string;
}

// --- 主组件 ---

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<ToolType>('home');
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
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
      showNotice(`取消文件操作失败：${result.error || '无法取消当前文件操作'}`);
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
            let normalizedConfig = { ...fileConfig, theme: fileConfig.theme ?? 'system', workspacePath: fileConfig.workspacePath?.trim() ?? '', homeOrder: normalizeHomeOrder(fileConfig.homeOrder), birthdayEnabled: fileConfig.birthdayEnabled ?? true, mediaCache: { maxSizeGB: normalizeMediaCacheSize(fileConfig.mediaCache?.maxSizeGB), directory: fileConfig.mediaCache?.directory ?? '', autoCleanup30Days: fileConfig.mediaCache?.autoCleanup30Days ?? false }, smartImport: { ...fileConfig.smartImport, sdPath: savedSdPaths[0] || '', sdPaths: savedSdPaths, sdDriveTypes: fileConfig.smartImport?.sdDriveTypes ?? {}, backupEnabled: false, generateVideoPreview: fileConfig.smartImport?.generateVideoPreview ?? false, splitLargeFiles: fileConfig.smartImport?.splitLargeFiles ?? false }, brollImport: { splitLargeFiles: fileConfig.brollImport?.splitLargeFiles ?? false, clearSource: fileConfig.brollImport?.clearSource ?? true }, fileImport: { preserveOriginal: fileConfig.fileImport?.preserveOriginal ?? false }, imageConversion: { jpgQuality: fileConfig.imageConversion?.jpgQuality ?? 100 }, personDetection: { useGpu: fileConfig.personDetection?.useGpu ?? true }, smartMatch: { imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME, videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME, imageSourceFolderName: !configuredImageSource || configuredImageSource.toLowerCase() === 'raw' ? 'raw' : configuredImageSource, videoSourceFolderName: !configuredVideoSource || configuredVideoSource.toLowerCase() === 'mov' ? 'mov' : configuredVideoSource }, research: { ...fileConfig.research, defaultDir: downloadPath, sensitivity: researchSensitivity, minDuration: fileConfig.research?.minDuration ?? 0.2 } } as AppConfig;
            if (normalizedConfig.workspacePath) {
              const workspace = await window.electronAPI.getWorkspaceProjects(normalizedConfig.workspacePath);
              if (workspace.success && workspace.root) normalizedConfig = { ...normalizedConfig, workspacePath: workspace.root };
            } else {
              setShowWorkspaceSetup(true);
            }
            setConfig(normalizedConfig);
            if ((fileConfig.workspacePath !== normalizedConfig.workspacePath || fileConfig.birthdayEnabled === undefined || !Array.isArray(fileConfig.smartImport?.sdPaths) || !fileConfig.smartImport?.sdDriveTypes || fileConfig.mediaCache?.maxSizeGB !== normalizedConfig.mediaCache.maxSizeGB || fileConfig.mediaCache?.autoCleanup30Days === undefined || fileConfig.smartImport.backupEnabled || fileConfig.smartImport?.splitLargeFiles === undefined || !fileConfig.brollImport || !fileConfig.fileImport || !fileConfig.imageConversion || fileConfig.personDetection?.useGpu === undefined || fileConfig.smartMatch?.imageDestFolderName !== IMAGE_SELECTION_FOLDER_NAME || fileConfig.smartMatch?.videoDestFolderName !== VIDEO_SELECTION_FOLDER_NAME || configuredImageSource !== normalizedConfig.smartMatch.imageSourceFolderName || configuredVideoSource !== normalizedConfig.smartMatch.videoSourceFolderName || JSON.stringify(fileConfig.homeOrder) !== JSON.stringify(normalizedConfig.homeOrder) || !fileConfig.research?.sensitivity) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
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
      const result = await window.electronAPI.undoLastRename(config?.workspacePath);
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
  }, [config?.workspacePath, showNotice, selectedProject?.path]);

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
  const handleHomeImportComplete = async (projectNames: string[] = []) => {
    if (!config) return;
    const result = await window.electronAPI.archiveImportedProjects(config.workspacePath, projectNames);
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
      <FileOperationProgressOverlay progress={fileOperationProgress} cancelling={isCancellingFileOperation} onCancel={() => void cancelFileOperation()}/>
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
            <span className="shrink-0 font-mono text-[10px] text-slate-400">v26.7.23</span>
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
        <BackgroundTaskIndicator/>
        <div className="app-titlebar-control flex h-10 w-[138px] shrink-0 items-stretch">
          <button type="button" onClick={() => window.electronAPI.minimizeWindow()} aria-label="最小化" title="最小化" className="window-control-button"><span className="window-glyph window-glyph-minimize"/></button>
          <button type="button" onClick={async () => setWindowMaximized(await window.electronAPI.toggleMaximizeWindow())} aria-label={windowMaximized ? '还原' : '最大化'} title={windowMaximized ? '还原' : '最大化'} className="window-control-button">{windowMaximized ? <span className="window-glyph window-glyph-restore"/> : <span className="window-glyph window-glyph-maximize"/>}</button>
          <button type="button" onClick={() => window.electronAPI.closeWindow()} aria-label="关闭" title="关闭" className="window-control-button window-control-close"><span className="window-glyph window-glyph-close"/></button>
        </div>
      </header>

      {showWorkspaceSetup ? <WorkspaceSetupPage config={config} onSave={handleWorkspaceSetup}/> : <div className="flex min-h-0 flex-1">
      {/* Sidebar */}
      <aside style={{ width: sidebarCollapsed ? 0 : renderedSidebarWidth }} className="relative z-30 flex min-w-0 shrink-0 flex-col overflow-hidden bg-white transition-[width] duration-200">
        {activeTab === 'settings'
          ? <SettingsNavigator activeSection={settingsSection} onSelect={setSettingsSection}/>
          : <><ProjectNavigator
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
        </div></>}
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
                ? <HomePanel title="调研整理" {...dragProps}><RequirePlugin embedded componentId="research-tools" title="调研整理" desc="尚未安装调研整理组件。请在设置的组件管理中打开组件目录并安装。"><ResearchView embedded config={config.research} onUpdateConfig={(research: AppConfig['research']) => handleConfigUpdate({ ...config, research })}/></RequirePlugin></HomePanel>
                : <HomePanel title="PNG 转 JPG" {...dragProps}><RequirePlugin embedded scriptName="png_to_jpg.py" title="PNG 转 JPG" desc="需要该引擎来执行图片格式的批量转换。"><ConverterView embedded defaultQuality={config.imageConversion.jpgQuality} /></RequirePlugin></HomePanel>;
          return <div key={card} className={draggedHomeCard === card ? 'opacity-40' : undefined}>{content}</div>;
        })}</div>}
        {activeTab === 'settings' && <SettingsPage activeSection={settingsSection} config={config} onSave={handleConfigUpdate} onNotice={showNotice}/>}
        {activeTab === 'about' && <AboutPage/>}
        {openProjects.map(project => { const active = activeTab === 'project' && selectedProject?.path === project.path; return <div key={project.path} className={active ? 'h-full w-full' : 'hidden'}><ProjectWorkspace active={active} project={project} workspacePath={config.workspacePath} initialPanel={projectOperations[project.path] ?? null} importConfig={config.smartImport} brollConfig={config.brollImport} fileImportConfig={config.fileImport} conversionConfig={config.imageConversion} matchConfig={config.smartMatch} mediaCacheConfig={config.mediaCache} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} onMatchConfigChange={(smartMatch: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch })} onMediaCacheConfigChange={(mediaCache: AppConfig['mediaCache']) => handleConfigUpdate({ ...config, mediaCache })} onNotice={showNotice} onProjectMoved={nextProject => { setOpenProjects(current => current.map(item => item.path === project.path ? nextProject : item)); setProjectOperations(current => { if (nextProject.path === project.path) return current; const next = { ...current, [nextProject.path]: current[project.path] ?? null }; delete next[project.path]; return next; }); setSelectedProject(nextProject); setProjectDestination(nextProject.path); window.dispatchEvent(new Event('workspace-projects-changed')); }} onDeleted={() => { closeProjectTab(project.path); window.dispatchEvent(new Event('workspace-projects-changed')); }} /></div>; })}

        {activeTab === 'converter' && (
          <RequirePlugin scriptName="png_to_jpg.py" title="PNG 转 JPG" desc="需要该引擎来执行图片格式的批量转换。">
            <ConverterView defaultQuality={config.imageConversion.jpgQuality} />
          </RequirePlugin>
        )}

        {activeTab === 'match' && (
          <RequirePlugin scriptName="catch.py" title="选片" desc="需要该引擎来根据关键词提取对应的 RAW 照片。">
            <MatchView config={config.smartMatch} projectPath={selectedProject?.path} onUpdateConfig={(newConfig: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch: newConfig })} />
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
        <div><p className="text-lg font-bold text-slate-800">by秋也寻</p><div className="mt-1 flex flex-wrap items-center gap-3"><p className="text-blue-600">版本 26.7.23</p><button onClick={checkForUpdates} disabled={updateStatus === 'checking'} className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-bold leading-5 text-blue-700 transition hover:bg-blue-100 disabled:cursor-wait disabled:opacity-60">{updateStatus === 'checking' ? '正在检查…' : '检查更新'}</button>{updateStatus === 'latest' && <span className="text-xs text-emerald-600">已是最新版本</span>}{updateStatus === 'error' && <span className="text-xs text-red-500">检查失败，请稍后重试</span>}</div></div>
        <section><h4 className="text-base font-bold text-slate-800">软件简介</h4><p className="mt-1">照片流是一款为摄影师设计的项目管理与素材整理工具，帮助你跟进拍摄进度，并自动从 SD 卡导入和整理照片、视频。</p></section>
        <section><h4 className="text-base font-bold text-slate-800">功能说明</h4><p className="mt-1">调研整理功能可配合脚本整理下载的图片与视频、截取视频帧，并汇总调研资料信息。<br/>团片管理功能可将高像素大图裁切为便于修图的小图，后续再拼接回完整大图；也支持版本核对并交接给下一位修图人员。</p></section>
        <section><h4 className="text-base font-bold text-slate-800">制作说明</h4><p className="mt-1">早期版本的大部分代码由 Google Gemini 与 Copilot 生成；当前版本主要使用 Codex 制作。</p></section>
        <section className="rounded-xl border border-blue-100 bg-blue-50 p-4"><h4 className="text-base font-bold text-slate-800">项目与联系</h4><p className="mt-1">如果你有任何建议或遇到问题，欢迎通过邮箱联系我，也可以前往项目仓库反馈。</p><div className="mt-3 flex flex-col items-start gap-2 leading-5"><button type="button" onClick={() => window.electronAPI.openExternal('https://github.com/akiyastudio/photoflow')} className="inline-flex items-center gap-1.5 break-all text-left font-medium text-blue-600 hover:underline">https://github.com/akiyastudio/photoflow <ExternalLink size={13} className="shrink-0"/></button><button type="button" onClick={() => window.electronAPI.openExternal('mailto:akiyastudio@qq.com')} className="inline-flex items-center gap-1.5 font-medium text-blue-600 hover:underline">akiyastudio@qq.com <ExternalLink size={13}/></button></div></section>
        <section className="border-t border-slate-200 pt-5"><h4 className="text-base font-bold text-slate-800">使用提示</h4><p className="mt-1">软件尚未经过充分测试。使用前请备份重要数据；作者不对使用本软件造成的损失负责。</p></section>
      </div>
  </section>;
};

const RootApp = () => <AppErrorBoundary><App/></AppErrorBoundary>;
export default RootApp;
