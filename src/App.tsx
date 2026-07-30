import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Folder,
  X,
  Settings,
  ExternalLink,
  Gift,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Home,
  UsersRound,
  Lightbulb,
} from 'lucide-react';
import { useAppDialog } from './components/AppDialogProvider';
import { useEscapeLayer } from './components/LayerProvider';
import { ProjectNavigator } from './components/ProjectNavigator';
import { FileOperationProgressOverlay } from './features/file-operations/FileOperationProgressOverlay';
import { ProjectWorkspace } from './features/workspace/ProjectWorkspace';
import { AppErrorBoundary } from './features/app/AppErrorBoundary';
import { RequirePlugin } from './features/plugins/RequirePlugin';
import { BackgroundTaskIndicator } from './features/background-tasks/BackgroundTaskIndicator';
import { PrivacyConsentPage, SettingsNavigator, SettingsPage, WorkspaceSetupPage } from './features/settings/SettingsFeature';
import type { SettingsSection } from './features/settings/SettingsFeature';
import { DashboardView, MatchView, VideoSplitView } from './features/tools/ToolViews';
import { InspirationLibraryNavigator, InspirationLibraryPage } from './features/inspiration/InspirationLibrary';
import { PROJECT_TOOLBAR_ACTION_IDS } from './types';
import type { AppConfig, ComponentStatus, HomeCardId, ProjectFileOperationProgress, ProjectToolbarActionId, ToolType, WorkspaceProject } from './types';

const DEFAULT_HOME_ORDER: HomeCardId[] = ['birthday', 'import', 'inspiration'];
type WorkspaceToolKind = 'version' | 'team';
type WorkspaceToolTab = { projectPath: string; kind: WorkspaceToolKind; label: string; busy: boolean };
const localDateKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const normalizeHomeOrder = (value: unknown): HomeCardId[] => {
  const valid = new Set<HomeCardId>(DEFAULT_HOME_ORDER);
  const migrated = Array.isArray(value) ? value : [];
  const ordered = migrated.filter((card): card is HomeCardId => valid.has(card as HomeCardId));
  return [...new Set([...ordered, ...DEFAULT_HOME_ORDER])];
};
const normalizeProjectToolbar = (value: unknown): AppConfig['projectToolbar'] => {
  const source = value && typeof value === 'object' ? value as Partial<AppConfig['projectToolbar']> : {};
  const valid = new Set<ProjectToolbarActionId>(PROJECT_TOOLBAR_ACTION_IDS);
  const order = Array.isArray(source.order) ? source.order.filter((id): id is ProjectToolbarActionId => valid.has(id as ProjectToolbarActionId)) : [];
  const hidden = Array.isArray(source.hidden) ? source.hidden.filter((id): id is ProjectToolbarActionId => valid.has(id as ProjectToolbarActionId)) : [];
  if (order.length && !order.includes('screenshot-main-image')) {
    const storyboardIndex = order.indexOf('storyboard');
    order.splice(storyboardIndex < 0 ? order.length : storyboardIndex + 1, 0, 'screenshot-main-image');
  }
  return {
    order: [...new Set([...order, ...PROJECT_TOOLBAR_ACTION_IDS])],
    hidden: [...new Set(hidden)],
  };
};
const IMAGE_SELECTION_FOLDER_NAME = '图片选片';
const VIDEO_SELECTION_FOLDER_NAME = '视频选片';
const normalizeMediaCacheSize = (value: unknown, fallback = 50) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
};
const normalizeVideoPreviewQuality = (value: unknown): AppConfig['smartImport']['videoPreviewQuality'] => value === 'high' ? value : 'medium';

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
  telemetry: {
    enabled: false,
    crashReports: false,
  },
  workspacePath: '',
  autoCleanupDeletedProjectData: true,
  createPlanningFolder: true,
  defaultFolderSort: 'date',
  projectToolbar: normalizeProjectToolbar(undefined),
  homeOrder: DEFAULT_HOME_ORDER,
  birthdayEnabled: true,
  componentSettings: {
    'team-retouch': { useGpu: true, oversizeCropMode: 'face-centered', backendMode: 'auto' }
  },
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
    videoPreviewQuality: 'medium',
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
  inspirationLibrary: {
    rootPath: ''
  },
  personDetection: {
    useGpu: true,
    oversizeCropMode: 'face-centered',
    backendMode: 'auto'
  },
  smartMatch: {
    imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME,
    videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME,
    imageSourceFolderName: 'raw',
    videoSourceFolderName: 'mov'
  },
  research: {
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
  const appDialog = useAppDialog();
  const [activeTab, setActiveTab] = useState<ToolType>('home');
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [inspirationTabOpen, setInspirationTabOpen] = useState(false);
  const [inspirationRelativePath, setInspirationRelativePath] = useState('');
  const [inspirationNavigationRequest, setInspirationNavigationRequest] = useState<{ path: string; id: number }>();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [showWorkspaceSetup, setShowWorkspaceSetup] = useState(false);

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [privacyStateLoaded, setPrivacyStateLoaded] = useState(false);
  const [privacyConsentRequired, setPrivacyConsentRequired] = useState(true);
  const [updateInfo, setUpdateInfo] = useState<{version: string, url: string, notes: string} | null>(null);
  const [selectedProject, setSelectedProject] = useState<WorkspaceProject | null>(null);
  const [openProjects, setOpenProjects] = useState<WorkspaceProject[]>([]);
  const [workspaceToolTabs, setWorkspaceToolTabs] = useState<WorkspaceToolTab[]>([]);
  const [projectOperations, setProjectOperations] = useState<Record<string, 'import' | 'broll' | 'match' | null>>({});
  const [, setProjectDestination] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState('');
  const [fileOperationProgress, setFileOperationProgress] = useState<ProjectFileOperationProgress | null>(null);
  const [isCancellingFileOperation, setIsCancellingFileOperation] = useState(false);
  const noticeTimerRef = useRef<number>();
  const lastNoticeRef = useRef({ message: '', shownAt: 0 });
  const cacheCleanupCheckedRef = useRef(false);
  const [homeOrder, setHomeOrder] = useState<HomeCardId[]>(DEFAULT_HOME_ORDER);
  const [draggedHomeCard, setDraggedHomeCard] = useState<HomeCardId | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber('photoflow:sidebar-width', 256));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('photoflow:sidebar-collapsed') === 'true');
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const titlebarTabsRef = useRef<HTMLDivElement>(null);
  const [titlebarTabScroll, setTitlebarTabScroll] = useState({ overflow: false, canScrollLeft: false, canScrollRight: false });
  const [components, setComponents] = useState<ComponentStatus[]>(() => {
    try {
      const cached = JSON.parse(window.localStorage.getItem('photoflow:components-cache') || '[]');
      return Array.isArray(cached)
        ? cached.filter(component => component && !['application', 'legacy-application', 'bundled'].includes(String(component.source || '')))
        : [];
    } catch {
      return [];
    }
  });
  const [componentInstallPath, setComponentInstallPath] = useState('');
  const [componentsLoading, setComponentsLoading] = useState(true);
  const installedComponentIds = useMemo(() => new Set(components.filter(component => component.installed).map(component => component.id)), [components]);

  useEffect(() => {
    if (componentsLoading) return;
    const componentIdBySection: Partial<Record<SettingsSection, string>> = {
      'team-retouch': 'team-retouch',
    };
    const componentId = componentIdBySection[settingsSection];
    if (componentId && !installedComponentIds.has(componentId)) setSettingsSection('components');
  }, [componentsLoading, installedComponentIds, settingsSection]);

  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-width', String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const updateTitlebarTabScroll = useCallback(() => {
    const element = titlebarTabsRef.current;
    if (!element) return;
    const overflow = element.scrollWidth > element.clientWidth + 1;
    const next = {
      overflow,
      canScrollLeft: overflow && element.scrollLeft > 1,
      canScrollRight: overflow && element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    };
    setTitlebarTabScroll(current => current.overflow === next.overflow
      && current.canScrollLeft === next.canScrollLeft
      && current.canScrollRight === next.canScrollRight ? current : next);
  }, []);

  useEffect(() => {
    const element = titlebarTabsRef.current;
    if (!element) return;
    const observer = new ResizeObserver(updateTitlebarTabScroll);
    observer.observe(element);
    element.addEventListener('scroll', updateTitlebarTabScroll, { passive: true });
    updateTitlebarTabScroll();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', updateTitlebarTabScroll);
    };
  }, [configLoaded, inspirationTabOpen, openProjects.length, settingsTabOpen, updateTitlebarTabScroll, workspaceToolTabs.length]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = titlebarTabsRef.current;
      element?.querySelector<HTMLElement>('[data-active-tab="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateTitlebarTabScroll();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [configLoaded, activeTab, inspirationTabOpen, selectedProject?.path, openProjects.length, settingsTabOpen, updateTitlebarTabScroll, workspaceToolTabs.length]);

  const scrollTitlebarTabs = (direction: -1 | 1) => {
    const element = titlebarTabsRef.current;
    if (!element) return;
    element.scrollBy({ left: direction * Math.max(180, element.clientWidth * 0.65), behavior: 'smooth' });
  };

  const handleTitlebarTabWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    element.scrollBy({ left: delta, behavior: 'auto' });
  };

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
    if (!config?.mediaCache.autoCleanup30Days || cacheCleanupCheckedRef.current) return;
    const storageKey = 'photoflow:maintenance:cache-cleanup-date';
    const today = localDateKey();
    if (window.localStorage.getItem(storageKey) === today) {
      cacheCleanupCheckedRef.current = true;
      return;
    }
    cacheCleanupCheckedRef.current = true;
    void window.electronAPI.clearMediaCache(config.mediaCache, 30).then(result => {
      if (result.success) window.localStorage.setItem(storageKey, today);
    });
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
    const showTextCopyNotice = (event: ClipboardEvent) => {
      const target = event.target;
      let selectedText = event.clipboardData?.getData('text/plain') || '';
      if (!selectedText && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        const selectionStart = target.selectionStart ?? 0;
        const selectionEnd = target.selectionEnd ?? selectionStart;
        selectedText = target.value.slice(selectionStart, selectionEnd);
      }
      if (!selectedText) selectedText = window.getSelection()?.toString() || '';
      if (selectedText) showNotice('成功复制文字');
    };
    window.addEventListener('copy', showTextCopyNotice);
    return () => window.removeEventListener('copy', showTextCopyNotice);
  }, [showNotice]);

  const refreshComponents = useCallback(async () => {
    setComponentsLoading(true);
    try {
      const result = await window.electronAPI.getComponents();
      if (!result.success) throw new Error(result.error || '无法读取组件状态');
      setComponents(result.components || []);
      window.localStorage.setItem('photoflow:components-cache', JSON.stringify(result.components || []));
      setComponentInstallPath(result.installPath || '');
    } catch (error) {
      setComponents([]);
      showNotice(`读取组件状态失败：${error instanceof Error ? error.message : String(error)}`, 5000);
    } finally {
      setComponentsLoading(false);
    }
  }, [showNotice]);

  const handleComponentsChanged = useCallback(async () => {
    await refreshComponents();
    window.dispatchEvent(new Event('photoflow-components-changed'));
  }, [refreshComponents]);

  useEffect(() => { void refreshComponents(); }, [refreshComponents]);

  useEffect(() => window.electronAPI.onComponentsStatusChanged(result => {
    if (!result.success) return;
    const nextComponents = result.components || [];
    setComponents(nextComponents);
    window.localStorage.setItem('photoflow:components-cache', JSON.stringify(nextComponents));
    setComponentInstallPath(result.installPath || '');
  }), []);

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
            const storedResearch = fileConfig.componentSettings?.['research-tools'] as AppConfig['research'] | undefined;
            const legacyResearch = storedResearch || fileConfig.research;
            const legacyInspiration = fileConfig.inspirationLibrary as AppConfig['inspirationLibrary'] & Partial<AppConfig['research']>;
            const legacyThreshold = legacyResearch?.ssimThreshold;
            const inspirationLibrary: AppConfig['inspirationLibrary'] = { rootPath: legacyInspiration?.rootPath || '' };
            const researchSettings: AppConfig['research'] = {
              sensitivity: legacyResearch?.sensitivity ?? legacyInspiration?.sensitivity ?? (legacyThreshold !== undefined && legacyThreshold >= 0.98 ? 'high' : legacyThreshold !== undefined && legacyThreshold <= 0.85 ? 'low' : 'standard'),
              minDuration: legacyResearch?.minDuration ?? legacyInspiration?.minDuration ?? 0.2,
            };
            const storedPersonDetection = fileConfig.componentSettings?.['team-retouch'] as AppConfig['personDetection'] | undefined;
            const personDetectionSettings: AppConfig['personDetection'] = {
              useGpu: storedPersonDetection?.useGpu ?? fileConfig.personDetection?.useGpu ?? true,
              oversizeCropMode: storedPersonDetection?.oversizeCropMode ?? fileConfig.personDetection?.oversizeCropMode ?? 'face-centered',
              backendMode: storedPersonDetection?.backendMode ?? fileConfig.personDetection?.backendMode ?? 'auto',
            };
            const configuredImageSource = fileConfig.smartMatch?.imageSourceFolderName;
            const configuredVideoSource = fileConfig.smartMatch?.videoSourceFolderName;
            const savedSdPaths = (Array.isArray(fileConfig.smartImport?.sdPaths) && fileConfig.smartImport.sdPaths.length ? fileConfig.smartImport.sdPaths : fileConfig.smartImport?.sdPath ? [fileConfig.smartImport.sdPath] : []).map((drive: string) => isMac ? drive : drive.replace(/\\/g, '/').replace(/\/DCIM\/?$/i, '/'));
            const componentSettings = { ...fileConfig.componentSettings, 'team-retouch': personDetectionSettings };
            delete componentSettings['research-tools'];
            delete componentSettings['office-media-extractor'];
            let normalizedConfig = { ...fileConfig, theme: fileConfig.theme ?? 'system', telemetry: { enabled: fileConfig.telemetry?.enabled === true, crashReports: fileConfig.telemetry?.crashReports === true }, workspacePath: fileConfig.workspacePath?.trim() ?? '', autoCleanupDeletedProjectData: fileConfig.autoCleanupDeletedProjectData ?? true, createPlanningFolder: fileConfig.createPlanningFolder ?? true, defaultFolderSort: fileConfig.defaultFolderSort ?? 'date', projectToolbar: normalizeProjectToolbar(fileConfig.projectToolbar), homeOrder: normalizeHomeOrder(fileConfig.homeOrder), birthdayEnabled: fileConfig.birthdayEnabled ?? true, componentSettings, mediaCache: { maxSizeGB: normalizeMediaCacheSize(fileConfig.mediaCache?.maxSizeGB), directory: fileConfig.mediaCache?.directory ?? '', autoCleanup30Days: fileConfig.mediaCache?.autoCleanup30Days ?? false }, smartImport: { ...fileConfig.smartImport, sdPath: savedSdPaths[0] || '', sdPaths: savedSdPaths, sdDriveTypes: fileConfig.smartImport?.sdDriveTypes ?? {}, backupEnabled: false, generateVideoPreview: fileConfig.smartImport?.generateVideoPreview ?? false, videoPreviewQuality: normalizeVideoPreviewQuality(fileConfig.smartImport?.videoPreviewQuality), splitLargeFiles: fileConfig.smartImport?.splitLargeFiles ?? false }, brollImport: { splitLargeFiles: fileConfig.brollImport?.splitLargeFiles ?? false, clearSource: fileConfig.brollImport?.clearSource ?? true }, fileImport: { preserveOriginal: fileConfig.fileImport?.preserveOriginal ?? false }, inspirationLibrary, personDetection: personDetectionSettings, smartMatch: { imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME, videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME, imageSourceFolderName: !configuredImageSource || configuredImageSource.toLowerCase() === 'raw' ? 'raw' : configuredImageSource, videoSourceFolderName: !configuredVideoSource || configuredVideoSource.toLowerCase() === 'mov' ? 'mov' : configuredVideoSource }, research: researchSettings } as AppConfig;
            if (normalizedConfig.workspacePath) {
              const workspace = await window.electronAPI.getWorkspaceProjects(normalizedConfig.workspacePath);
              if (workspace.success && workspace.root) normalizedConfig = { ...normalizedConfig, workspacePath: workspace.root };
            } else {
              setShowWorkspaceSetup(true);
            }
            setConfig(normalizedConfig);
            if ((fileConfig.workspacePath !== normalizedConfig.workspacePath || fileConfig.autoCleanupDeletedProjectData === undefined || fileConfig.createPlanningFolder === undefined || fileConfig.defaultFolderSort === undefined || fileConfig.birthdayEnabled === undefined || !Array.isArray(fileConfig.smartImport?.sdPaths) || !fileConfig.smartImport?.sdDriveTypes || fileConfig.mediaCache?.maxSizeGB !== normalizedConfig.mediaCache.maxSizeGB || fileConfig.mediaCache?.autoCleanup30Days === undefined || fileConfig.smartImport.backupEnabled || fileConfig.smartImport?.videoPreviewQuality !== normalizedConfig.smartImport.videoPreviewQuality || fileConfig.smartImport?.splitLargeFiles === undefined || !fileConfig.brollImport || !fileConfig.fileImport || !fileConfig.inspirationLibrary || JSON.stringify(fileConfig.research) !== JSON.stringify(researchSettings) || fileConfig.personDetection?.useGpu === undefined || fileConfig.smartMatch?.imageDestFolderName !== IMAGE_SELECTION_FOLDER_NAME || fileConfig.smartMatch?.videoDestFolderName !== VIDEO_SELECTION_FOLDER_NAME || configuredImageSource !== normalizedConfig.smartMatch.imageSourceFolderName || configuredVideoSource !== normalizedConfig.smartMatch.videoSourceFolderName || JSON.stringify(fileConfig.homeOrder) !== JSON.stringify(normalizedConfig.homeOrder) || JSON.stringify(fileConfig.projectToolbar) !== JSON.stringify(normalizedConfig.projectToolbar) || JSON.stringify(fileConfig.componentSettings) !== JSON.stringify(normalizedConfig.componentSettings)) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
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
    if (!configLoaded) return;
    const getConsentState = window.electronAPI?.getPrivacyConsentState;
    if (window.electronAPI?.apiContractVersion !== 1 || typeof getConsentState !== 'function') {
      setPrivacyConsentRequired(true);
      setPrivacyStateLoaded(true);
      showNotice('应用组件版本不一致，请完全退出后重新启动；若仍然出现，请重新安装当前版本。', 10000);
      return;
    }
    void getConsentState().then(state => {
      setPrivacyConsentRequired(state.privacyNoticeVersion !== state.currentPrivacyNoticeVersion || state.termsVersion !== state.currentTermsVersion);
    }).catch(() => setPrivacyConsentRequired(true)).finally(() => setPrivacyStateLoaded(true));
  }, [configLoaded, showNotice]);

  useEffect(() => {
    if (!configLoaded) return;
    window.electronAPI?.trackTelemetry?.('feature_opened', { feature: activeTab });
  }, [activeTab, configLoaded]);

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
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      if (!target?.closest('[data-photoflow-file-surface="true"]')) return;
      event.preventDefault();
      const undoWorkspacePath = activeTab === 'inspiration' ? config?.inspirationLibrary.rootPath : config?.workspacePath;
      let result = await window.electronAPI.undoLastRename(undoWorkspacePath);
      if (result.requiresDecision?.kind === 'restore-conflict') {
        const decision = result.requiresDecision;
        const policy = await appDialog.choice({
          title: '原位置已有同名项目',
          message: decision.message,
          detail: decision.detail,
          choices: [
            { value: 'rename', label: '改名恢复' },
            { value: 'overwrite', label: '覆盖恢复', tone: 'danger' },
          ],
          defaultValue: 'rename',
        });
        if (policy !== 'rename' && policy !== 'overwrite') { showNotice('已取消撤销'); return; }
        result = await window.electronAPI.undoLastRename(undoWorkspacePath, { restoreConflictPolicy: policy });
      }
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
  }, [activeTab, appDialog, config?.inspirationLibrary.rootPath, config?.workspacePath, showNotice, selectedProject?.path]);

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

  const getDefaultSettings = useCallback(async () => {
    const userPath = await window.electronAPI.getUserPath().catch(() => '');
    const defaults = DEFAULT_CONFIG(userPath || '');
    return { ...defaults, telemetry: { enabled: true, crashReports: true }, workspacePath: config?.workspacePath || '' };
  }, [config?.workspacePath]);

  const handleWorkspaceSetup = async (newConfig: AppConfig) => {
    await handleConfigUpdate(newConfig);
    setShowWorkspaceSetup(false);
  };
  const acceptInternalBetaPrivacy = async () => {
    if (!config) return;
    const consent = await window.electronAPI.savePrivacyConsent({ acceptCore: true });
    if (!consent.success) {
      showNotice(`保存隐私确认失败：${consent.error || '未知错误'}`, 6000);
      return;
    }
    const saved = await handleConfigUpdate({ ...config, telemetry: { enabled: true, crashReports: true } });
    if (saved) setPrivacyConsentRequired(false);
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
  const openWorkspaceToolTab = (project: WorkspaceProject, kind: WorkspaceToolKind, label: string) => {
    setOpenProjects(current => current.some(item => item.path === project.path) ? current : [...current, project]);
    setWorkspaceToolTabs(current => {
      const existing = current.find(tab => tab.projectPath === project.path && tab.kind === kind);
      return existing
        ? current.map(tab => tab === existing ? { ...tab, label } : tab)
        : [...current, { projectPath: project.path, kind, label, busy: false }];
    });
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab(kind === 'version' ? 'project-version' : 'project-team');
  };
  const activateWorkspaceToolTab = (project: WorkspaceProject, kind: WorkspaceToolKind) => {
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab(kind === 'version' ? 'project-version' : 'project-team');
  };
  const updateWorkspaceToolTabBusy = useCallback((projectPath: string, kind: WorkspaceToolKind, busy: boolean) => {
    setWorkspaceToolTabs(current => {
      let changed = false;
      const next = current.map(tab => {
        if (tab.projectPath !== projectPath || tab.kind !== kind || tab.busy === busy) return tab;
        changed = true;
        return { ...tab, busy };
      });
      return changed ? next : current;
    });
  }, []);
  const closeWorkspaceToolTab = async (projectPath: string, kind: WorkspaceToolKind) => {
    const tab = workspaceToolTabs.find(item => item.projectPath === projectPath && item.kind === kind);
    if (kind === 'team' && tab?.busy && !await appDialog.confirm({
      title: '团片任务仍在运行',
      message: '关闭标签不会取消后台任务；稍后重新打开团片协作可以继续查看进度。',
      confirmLabel: '关闭标签',
    })) return;
    setWorkspaceToolTabs(current => current.filter(item => item.projectPath !== projectPath || item.kind !== kind));
    const closingActiveTab = selectedProject?.path === projectPath
      && activeTab === (kind === 'version' ? 'project-version' : 'project-team');
    if (closingActiveTab) setActiveTab('project');
  };
  const showHomeTab = () => {
    setSelectedProject(null);
    setProjectDestination(null);
    setActiveTab('home');
  };
  const openInspirationTab = () => {
    setInspirationTabOpen(true);
    setSelectedProject(null);
    setActiveTab('inspiration');
  };
  const closeInspirationTab = () => {
    setInspirationTabOpen(false);
    if (activeTab === 'inspiration') showHomeTab();
  };
  const navigateInspiration = (path: string) => {
    setInspirationTabOpen(true);
    setInspirationNavigationRequest({ path, id: Date.now() });
    setActiveTab('inspiration');
  };
  const openSettingsTab = () => {
    setSettingsTabOpen(true);
    setActiveTab('settings');
  };
  const closeSettingsTab = () => {
    setSettingsTabOpen(false);
    if (activeTab === 'settings') showHomeTab();
  };
  const closeProjectTab = async (projectPath: string, force = false) => {
    const runningTeamTab = workspaceToolTabs.find(tab => tab.projectPath === projectPath && tab.kind === 'team' && tab.busy);
    if (!force && runningTeamTab && !await appDialog.confirm({
      title: '团片任务仍在运行',
      message: '关闭项目标签会同时关闭它的团片标签，但不会取消后台任务。',
      confirmLabel: '关闭项目标签',
    })) return;
    const closingIndex = openProjects.findIndex(project => project.path === projectPath);
    const remaining = openProjects.filter(project => project.path !== projectPath);
    setOpenProjects(remaining);
    setWorkspaceToolTabs(current => current.filter(tab => tab.projectPath !== projectPath));
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
  if (!configLoaded || !config || !privacyStateLoaded) {
    return (
      <div className="flex h-screen w-full items-center justify-center overflow-hidden bg-slate-950 text-white">
        <div className="flex flex-col items-center gap-6 text-center">
          <img src="./app-logo.svg" className="brand-logo h-20 w-20" alt="照片流" />
          <div className="space-y-2">
            <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-500 to-indigo-400 bg-clip-text text-transparent">照片流</h2>
            <p className="text-sm text-slate-400">正在启动…</p>
          </div>
          <span className="win11-spinner" aria-label="正在加载" />
        </div>
      </div>
    );
  }

  if (privacyConsentRequired) return <PrivacyConsentPage onAccept={acceptInternalBetaPrivacy}/>;

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
            <img src="./app-logo.svg" className="brand-logo h-5 w-5 shrink-0" alt="" />
            <span className="truncate text-sm font-bold text-slate-800">照片流</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1">
          {titlebarTabScroll.overflow && <button type="button" aria-label="向左滚动标签" title="向左滚动标签" disabled={!titlebarTabScroll.canScrollLeft} onClick={() => scrollTitlebarTabs(-1)} className="app-titlebar-control titlebar-tab-scroll-button"><ChevronLeft size={15}/></button>}
          <div ref={titlebarTabsRef} onWheel={handleTitlebarTabWheel} aria-label="已打开的窗口" className="titlebar-tabs-scroll scrollbar-hide flex min-w-0 shrink items-end gap-0 overflow-x-auto px-2 pt-1.5">
            <button type="button" data-active-tab={activeTab === 'home'} onClick={showHomeTab} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[92px] max-w-[180px] items-center gap-2 rounded-t-lg border px-3 text-xs font-medium transition ${activeTab === 'home' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
              <Home size={14} className="shrink-0"/><span className="truncate">主页</span>
            </button>
            {inspirationTabOpen && <div data-active-tab={activeTab === 'inspiration'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[112px] max-w-[190px] items-center rounded-t-lg border text-xs font-medium transition ${activeTab === 'inspiration' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={openInspirationTab} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Lightbulb size={14} className="shrink-0"/><span className="truncate">灵感库</span></button><button type="button" aria-label="关闭灵感库" title="关闭灵感库" onClick={closeInspirationTab} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button></div>}
            {openProjects.map(project => <React.Fragment key={project.path}>
              <div title={project.name} data-active-tab={selectedProject?.path === project.path && activeTab === 'project'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[120px] max-w-[220px] items-center rounded-t-lg border text-xs font-medium transition ${selectedProject?.path === project.path && activeTab === 'project' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                <button type="button" onClick={() => openProjectTab(project, projectOperations[project.path] ?? null)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Folder size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{project.name}</span></button>
                <button type="button" aria-label={`关闭 ${project.name}`} title={`关闭 ${project.name}`} onClick={() => void closeProjectTab(project.path)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
              </div>
              {workspaceToolTabs.filter(tab => tab.projectPath === project.path).map(tab => {
                const tabType = tab.kind === 'version' ? 'project-version' : 'project-team';
                const isActive = selectedProject?.path === project.path && activeTab === tabType;
                const Icon = tab.kind === 'version' ? GitBranch : UsersRound;
                return <div key={`${project.path}:${tab.kind}`} title={tab.label} data-active-tab={isActive} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[128px] max-w-[230px] items-center rounded-t-lg border text-xs font-medium transition ${isActive ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                  <button type="button" onClick={() => activateWorkspaceToolTab(project, tab.kind)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Icon size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{tab.label}</span>{tab.kind === 'team' && tab.busy && <span aria-label="任务运行中" title="任务运行中" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-violet-500"/>}</button>
                  <button type="button" aria-label={`关闭 ${tab.label}`} title={`关闭 ${tab.label}`} onClick={() => void closeWorkspaceToolTab(project.path, tab.kind)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
                </div>;
              })}
            </React.Fragment>)}
            {settingsTabOpen && <div data-active-tab={activeTab === 'settings'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[108px] max-w-[180px] items-center rounded-t-lg border text-xs font-medium transition ${activeTab === 'settings' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={openSettingsTab} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Settings size={14} className="shrink-0"/><span className="truncate">设置</span></button><button type="button" aria-label="关闭设置" title="关闭设置" onClick={closeSettingsTab} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button></div>}
          </div>
          {titlebarTabScroll.overflow && <button type="button" aria-label="向右滚动标签" title="向右滚动标签" disabled={!titlebarTabScroll.canScrollRight} onClick={() => scrollTitlebarTabs(1)} className="app-titlebar-control titlebar-tab-scroll-button"><ChevronRight size={15}/></button>}
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
        {activeTab === 'settings' && <SettingsNavigator activeSection={settingsSection} components={components} onSelect={setSettingsSection}/>}
        {inspirationTabOpen && <div className={activeTab === 'inspiration' ? 'contents' : 'hidden'}><InspirationLibraryNavigator active={activeTab === 'inspiration'} rootPath={config.inspirationLibrary.rootPath} targetWorkspacePath={config.workspacePath} currentRelativePath={inspirationRelativePath} onNavigate={navigateInspiration} onOpenSettings={openSettingsTab} onNotice={showNotice}/></div>}
        {activeTab !== 'settings' && activeTab !== 'inspiration' && <><ProjectNavigator
          workspacePath={config.workspacePath}
          autoCleanupDeletedProjectData={config.autoCleanupDeletedProjectData}
          createPlanningFolder={config.createPlanningFolder}
          selectedProject={selectedProject}
          onSelectProject={(project, replacePath) => openProjectTab(project, null, replacePath)}
          onProjectAction={handleProjectAction}
          onProjectDeleted={project => void closeProjectTab(project.path, true)}
          onWorkspaceResolved={workspacePath => { if (config.workspacePath.trim() && workspacePath !== config.workspacePath) handleConfigUpdate({ ...config, workspacePath }); }}

        />
        <div className="p-4 border-t border-slate-200">
          <div className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
            <button onClick={openSettingsTab} className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition-all group"><Settings size={18} className="text-slate-400"/><span className="font-medium text-sm">设置</span></button>
          </div>
        </div></>}
      </aside>
      {!sidebarCollapsed && <ColumnResizeHandle label="调整项目栏宽度" onDrag={deltaX => setSidebarWidth(width => clampNumber(width + deltaX, 128, 420))}/>}

      {/* Main Content */}
      <main className={`relative min-w-0 flex-1 bg-slate-50 ${activeTab.startsWith('project') || activeTab === 'inspiration' ? 'overflow-hidden p-0' : activeTab === 'settings' ? 'overflow-auto p-0' : 'overflow-auto p-8'}`}>
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
              : <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <button type="button" onClick={openInspirationTab} className="group flex min-w-0 items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-5 text-left transition hover:border-blue-400 hover:bg-blue-50 hover:shadow-sm">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><Lightbulb size={22}/></span>
                    <span className="min-w-0 flex-1"><span className="block text-base font-bold text-slate-800">灵感库</span><span className="mt-1 block truncate text-xs text-slate-500">整理、浏览与收集灵感素材</span></span>
                    <ChevronRight size={19} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500"/>
                  </button>
                </div>;
          return <div key={card} className={draggedHomeCard === card ? 'opacity-40' : undefined}>{content}</div>;
        })}</div>}
        {inspirationTabOpen && <div className={activeTab === 'inspiration' ? 'h-full w-full' : 'hidden'}><InspirationLibraryPage active={activeTab === 'inspiration'} navigationRequest={inspirationNavigationRequest} config={config} components={components} componentsLoading={componentsLoading} onUpdateConfig={handleConfigUpdate} onDirectoryChange={setInspirationRelativePath} onNotice={showNotice}/></div>}
        {activeTab === 'settings' && <SettingsPage activeSection={settingsSection} config={config} components={components} componentInstallPath={componentInstallPath} componentsLoading={componentsLoading} onRefreshComponents={refreshComponents} onComponentsChanged={handleComponentsChanged} onSave={handleConfigUpdate} getDefaultSettings={getDefaultSettings} onNotice={showNotice}/>}
        {openProjects.map(project => { const active = activeTab.startsWith('project') && selectedProject?.path === project.path; const activeView = activeTab === 'project-version' ? 'version' : activeTab === 'project-team' ? 'team' : 'project'; return <div key={project.path} className={active ? 'h-full w-full' : 'hidden'}><ProjectWorkspace active={active} activeView={activeView} project={project} workspacePath={config.workspacePath} inspirationLibraryRootPath={config.inspirationLibrary.rootPath} installedComponentIds={installedComponentIds} componentsLoading={componentsLoading} teamRetouchStatus={components.find(component => component.id === 'team-retouch')} teamRetouchSettings={(config.componentSettings['team-retouch'] as AppConfig['personDetection'] | undefined) || config.personDetection} projectToolbar={config.projectToolbar} initialPanel={projectOperations[project.path] ?? null} importConfig={config.smartImport} brollConfig={config.brollImport} fileImportConfig={config.fileImport} matchConfig={config.smartMatch} researchConfig={config.research} mediaCacheConfig={config.mediaCache} defaultFolderSort={config.defaultFolderSort} onOpenInspirationPath={navigateInspiration} onOpenToolTab={(kind, label) => openWorkspaceToolTab(project, kind, label)} onCloseToolTab={kind => void closeWorkspaceToolTab(project.path, kind)} onToolTabBusyChange={(kind, busy) => updateWorkspaceToolTabBusy(project.path, kind, busy)} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} onMatchConfigChange={(smartMatch: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch })} onResearchConfigChange={(research: AppConfig['research']) => handleConfigUpdate({ ...config, research })} onMediaCacheConfigChange={(mediaCache: AppConfig['mediaCache']) => handleConfigUpdate({ ...config, mediaCache })} onNotice={showNotice} onProjectMoved={nextProject => { setOpenProjects(current => current.map(item => item.path === project.path ? nextProject : item)); setWorkspaceToolTabs(current => current.map(tab => tab.projectPath === project.path ? { ...tab, projectPath: nextProject.path, label: tab.kind === 'team' ? `团片 · ${nextProject.name}` : tab.label } : tab)); setProjectOperations(current => { if (nextProject.path === project.path) return current; const next = { ...current, [nextProject.path]: current[project.path] ?? null }; delete next[project.path]; return next; }); setSelectedProject(nextProject); setProjectDestination(nextProject.path); window.dispatchEvent(new Event('workspace-projects-changed')); }} onDeleted={() => { void closeProjectTab(project.path, true); window.dispatchEvent(new Event('workspace-projects-changed')); }} /></div>; })}

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
  useEscapeLayer(true, onClose);
  const handleUpdate = () => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-50/80 backdrop-blur-sm p-4 animate-in fade-in duration-300">
      <div role="dialog" aria-modal="true" aria-label={`发现新版本 ${version}`} className="bg-white border border-blue-500/30 w-full max-w-md rounded-2xl shadow-2xl flex flex-col relative overflow-hidden">
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

const RootApp = () => <AppErrorBoundary><App/></AppErrorBoundary>;
export default RootApp;
