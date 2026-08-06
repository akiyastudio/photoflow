import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Folder,
  X,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Home,
  UsersRound,
  Lightbulb,
  Pin,
} from 'lucide-react';
import { useAppDialog } from './components/AppDialogProvider';
import { ProjectNavigator } from './components/ProjectNavigator';
import { ProjectWorkspace } from './features/workspace/ProjectWorkspace';
import { AppErrorBoundary } from './features/app/AppErrorBoundary';
import { BackupHomeCard, StartupWindowFrame, UpdateModal, WindowControls } from './features/app/AppChrome';
import { projectTabId, useTitlebarTabOrder, workspaceToolTabId } from './features/app/useTitlebarTabOrder';
import { BackgroundTaskIndicator } from './features/background-tasks/BackgroundTaskIndicator';
import { useTaskCenter } from './features/background-tasks/TaskCenter';
import { PrivacyConsentPage, SettingsNavigator, SettingsPage, WorkspaceSetupPage } from './features/settings/SettingsFeature';
import { UsagePreferencesOnboarding, USAGE_PREFERENCES_VERSION } from './features/settings/UsagePreferencesOnboarding';
import type { SettingsSection } from './features/settings/SettingsFeature';
import { DashboardView, MatchView, VideoSplitView } from './features/tools/ToolViews';
import { InspirationLibraryNavigator, InspirationLibraryPage } from './features/inspiration/InspirationLibrary';
import { BUILT_IN_PROJECT_STATUSES, PROJECT_TOOLBAR_ACTION_IDS, normalizeProjectCategoryOrder, normalizeWorkspacePaths } from './types';
import type { AppConfig, BackupStatus, ComponentStatus, HomeCardId, ProjectToolbarActionId, ToolType, WorkspaceProject } from './types';

const DEFAULT_HOME_ORDER: HomeCardId[] = ['birthday', 'import', 'inspiration'];
const RESERVED_PROJECT_CATEGORIES = new Set<string>(['未分类', ...BUILT_IN_PROJECT_STATUSES]);
const normalizeProjectCategories = (value: unknown) => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const name = String(item || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    const hasControlCharacter = [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (!name || name.length > 24 || hasControlCharacter || RESERVED_PROJECT_CATEGORIES.has(name) || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= 50) break;
  }
  return result;
};
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
  const migrateToolbarId = (id: unknown): ProjectToolbarActionId | undefined => {
    if (valid.has(id as ProjectToolbarActionId)) return id as ProjectToolbarActionId;
    if (id === 'storyboard' || id === 'video-transcode' || id === 'video-split') return 'video-tools';
    if (id === 'png-converter' || id === 'screenshot-main-image') return 'image-tools';
    return undefined;
  };
  const order = Array.isArray(source.order) ? source.order.map(migrateToolbarId).filter((id): id is ProjectToolbarActionId => Boolean(id)) : [];
  const hidden = Array.isArray(source.hidden) ? source.hidden.filter((id): id is ProjectToolbarActionId => valid.has(id as ProjectToolbarActionId)) : [];
  return {
    order: [...new Set([...order, ...PROJECT_TOOLBAR_ACTION_IDS])],
    hidden: [...new Set(hidden)],
    onlyShowAvailable: source.onlyShowAvailable === true,
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
  workspacePaths: [],
  autoCleanupDeletedProjectData: true,
  createPlanningFolder: true,
  customProjectCategories: [],
  projectCategoryOrder: [...BUILT_IN_PROJECT_STATUSES],
  defaultFolderSort: 'date',
  itemOpenMode: 'single',
  favoriteDisplayMode: 'binary',
  usagePreferencesVersion: 0,
  projectToolbar: normalizeProjectToolbar(undefined),
  homeOrder: DEFAULT_HOME_ORDER,
  birthdayEnabled: true,
  pinInspirationLibrary: false,
  componentSettings: {
    'team-retouch': { useGpu: true, oversizeCropMode: 'face-centered' },
    'video-playback-mpv': { arrowKeyAction: 'seek' }
  },
  mediaCache: {
    maxSizeGB: 50,
    directory: '',
    autoCleanup30Days: false
  },
  backup: {
    enabled: false,
    targetType: 'local',
    targetPath: '',
    mode: 'history',
    automaticDaily: true,
    afterImport: true,
    retention: { daily: 7, weekly: 4, monthly: 12 },
    nas: { credentialRef: '', limitEnabled: false, bandwidthLimitMBps: 20, limitStart: '09:00', limitEnd: '18:00' }
  },
  archive: { enabled: false, targetPath: '' },
  importDefaults: {
    deleteSourceAfterImport: true,
    generateJpgFromRaw: false
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
    dateFilter: 'all',
    backupPath: isMac ? `${userPath}/Pictures/Backup` : "D:/Backup"
  },
  brollImport: {
    splitLargeFiles: false
  },
  inspirationLibrary: {
    rootPath: ''
  },
  personDetection: {
    useGpu: true,
    oversizeCropMode: 'face-centered'
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
  const { panelTasks } = useTaskCenter();
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
  const noticeTimerRef = useRef<number>();
  const autoBackedUpImportTasksRef = useRef(new Set<string>());
  const lastNoticeRef = useRef({ message: '', shownAt: 0 });
  const cacheCleanupCheckedRef = useRef(false);
  const [homeOrder, setHomeOrder] = useState<HomeCardId[]>(DEFAULT_HOME_ORDER);
  const [draggedHomeCard, setDraggedHomeCard] = useState<HomeCardId | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber('photoflow:sidebar-width', 256));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('photoflow:sidebar-collapsed') === 'true');
  const [backupStatus, setBackupStatus] = useState<BackupStatus>({ success: true, enabled: false, state: 'unconfigured', snapshots: [] });
  const [backupProjectFocus, setBackupProjectFocus] = useState<WorkspaceProject | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const titlebarTabsRef = useRef<HTMLDivElement>(null);
  const [titlebarTabScroll, setTitlebarTabScroll] = useState({ overflow: false, canScrollLeft: false, canScrollRight: false });
  useEffect(() => {
    const restorePanelTask = (event: Event) => {
      const scopeKey = (event as CustomEvent<{ scopeKey?: string }>).detail?.scopeKey;
      const project = openProjects.find(item => item.path === scopeKey);
      if (!project) return;
      setSelectedProject(project);
      setProjectDestination(project.path);
      setActiveTab('project');
    };
    window.addEventListener('photoflow:restore-panel-task', restorePanelTask);
    return () => window.removeEventListener('photoflow:restore-panel-task', restorePanelTask);
  }, [openProjects]);
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
      'video-playback-mpv': 'video-playback-mpv',
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

  useEffect(() => {
    if (config?.pinInspirationLibrary) setInspirationTabOpen(true);
  }, [config?.pinInspirationLibrary]);

  const titlebarTabDragProps = useTitlebarTabOrder({
    inspirationOpen: inspirationTabOpen,
    inspirationPinned: config?.pinInspirationLibrary === true,
    projectPaths: openProjects.map(project => project.path),
    toolTabs: workspaceToolTabs,
    settingsOpen: settingsTabOpen,
  });
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
            };
            const storedAdvancedVideo = fileConfig.componentSettings?.['video-playback-mpv'] as AppConfig['componentSettings']['video-playback-mpv'];
            const advancedVideoSettings: NonNullable<AppConfig['componentSettings']['video-playback-mpv']> = {
              arrowKeyAction: storedAdvancedVideo?.arrowKeyAction === 'navigate' ? 'navigate' : 'seek',
            };
            const configuredImageSource = fileConfig.smartMatch?.imageSourceFolderName;
            const configuredVideoSource = fileConfig.smartMatch?.videoSourceFolderName;
            const savedSdPaths = (Array.isArray(fileConfig.smartImport?.sdPaths) && fileConfig.smartImport.sdPaths.length ? fileConfig.smartImport.sdPaths : fileConfig.smartImport?.sdPath ? [fileConfig.smartImport.sdPath] : []).map((drive: string) => isMac ? drive : drive.replace(/\\/g, '/').replace(/\/DCIM\/?$/i, '/'));
            const componentSettings: AppConfig['componentSettings'] = { ...fileConfig.componentSettings, 'team-retouch': personDetectionSettings, 'video-playback-mpv': advancedVideoSettings };
            delete componentSettings['research-tools'];
            delete componentSettings['office-media-extractor'];
            const legacyConfig = { ...fileConfig } as AppConfig & { folderOpenMode?: 'single' | 'double'; fileImport?: { preserveOriginal?: boolean }; brollImport: AppConfig['brollImport'] & { clearSource?: boolean } };
            const legacyFolderOpenMode = legacyConfig.folderOpenMode;
            const legacyFileImport = legacyConfig.fileImport;
            const legacyBrollClearSource = legacyConfig.brollImport?.clearSource;
            delete legacyConfig.folderOpenMode;
            delete legacyConfig.fileImport;
            const customProjectCategories = normalizeProjectCategories(fileConfig.customProjectCategories);
            const configuredWorkspacePaths = normalizeWorkspacePaths(fileConfig.workspacePath, fileConfig.workspacePaths);
            let normalizedConfig = { ...legacyConfig, theme: fileConfig.theme ?? 'system', telemetry: { enabled: fileConfig.telemetry?.enabled === true, crashReports: fileConfig.telemetry?.crashReports === true }, workspacePath: fileConfig.workspacePath?.trim() ?? '', autoCleanupDeletedProjectData: fileConfig.autoCleanupDeletedProjectData ?? true, createPlanningFolder: fileConfig.createPlanningFolder ?? true, customProjectCategories, projectCategoryOrder: normalizeProjectCategoryOrder(fileConfig.projectCategoryOrder, customProjectCategories), defaultFolderSort: fileConfig.defaultFolderSort ?? 'date', itemOpenMode: fileConfig.itemOpenMode === 'double' || legacyFolderOpenMode === 'double' ? 'double' : 'single', favoriteDisplayMode: fileConfig.favoriteDisplayMode === 'stars' ? 'stars' : 'binary', usagePreferencesVersion: Number(fileConfig.usagePreferencesVersion) || 0, projectToolbar: normalizeProjectToolbar(fileConfig.projectToolbar), homeOrder: normalizeHomeOrder(fileConfig.homeOrder), birthdayEnabled: fileConfig.birthdayEnabled ?? true, pinInspirationLibrary: fileConfig.pinInspirationLibrary === true, componentSettings, mediaCache: { maxSizeGB: normalizeMediaCacheSize(fileConfig.mediaCache?.maxSizeGB), directory: fileConfig.mediaCache?.directory ?? '', autoCleanup30Days: fileConfig.mediaCache?.autoCleanup30Days ?? false }, backup: { enabled: fileConfig.backup?.enabled === true, targetType: fileConfig.backup?.targetType === 'nas' || (fileConfig.backup?.targetType === undefined && fileConfig.backup?.targetPath?.startsWith('\\\\')) ? 'nas' : 'local', targetPath: fileConfig.backup?.targetPath ?? '', mode: fileConfig.backup?.mode === 'latest' ? 'latest' : 'history', automaticDaily: fileConfig.backup?.automaticDaily ?? true, afterImport: fileConfig.backup?.afterImport ?? true, retention: { daily: Math.max(1, Number(fileConfig.backup?.retention?.daily) || 7), weekly: Math.max(0, Number(fileConfig.backup?.retention?.weekly) || 4), monthly: Math.max(0, Number(fileConfig.backup?.retention?.monthly) || 12) }, nas: { credentialRef: fileConfig.backup?.nas?.credentialRef ?? '', limitEnabled: fileConfig.backup?.nas?.limitEnabled === true, bandwidthLimitMBps: Math.max(1, Number(fileConfig.backup?.nas?.bandwidthLimitMBps) || 20), limitStart: fileConfig.backup?.nas?.limitStart || '09:00', limitEnd: fileConfig.backup?.nas?.limitEnd || '18:00' } }, archive: { enabled: fileConfig.archive?.enabled === true, targetPath: fileConfig.archive?.targetPath ?? '' }, importDefaults: { deleteSourceAfterImport: fileConfig.importDefaults?.deleteSourceAfterImport ?? !(legacyFileImport?.preserveOriginal ?? false), generateJpgFromRaw: fileConfig.importDefaults?.generateJpgFromRaw ?? false }, smartImport: { ...fileConfig.smartImport, sdPath: savedSdPaths[0] || '', sdPaths: savedSdPaths, sdDriveTypes: fileConfig.smartImport?.sdDriveTypes ?? {}, backupEnabled: false, generateVideoPreview: fileConfig.smartImport?.generateVideoPreview ?? false, videoPreviewQuality: normalizeVideoPreviewQuality(fileConfig.smartImport?.videoPreviewQuality), splitLargeFiles: fileConfig.smartImport?.splitLargeFiles ?? false, dateFilter: fileConfig.smartImport?.dateFilter === 'today' || fileConfig.smartImport?.dateFilter === 'today_yesterday' ? fileConfig.smartImport.dateFilter : 'all' }, brollImport: { splitLargeFiles: fileConfig.brollImport?.splitLargeFiles ?? false }, inspirationLibrary, personDetection: personDetectionSettings, smartMatch: { imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME, videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME, imageSourceFolderName: !configuredImageSource || configuredImageSource.toLowerCase() === 'raw' ? 'raw' : configuredImageSource, videoSourceFolderName: !configuredVideoSource || configuredVideoSource.toLowerCase() === 'mov' ? 'mov' : configuredVideoSource }, research: researchSettings } as AppConfig;
            normalizedConfig = { ...normalizedConfig, workspacePath: configuredWorkspacePaths[0] || '', workspacePaths: configuredWorkspacePaths };
            if (normalizedConfig.workspacePaths.length) {
              const resolved = await Promise.all(normalizedConfig.workspacePaths.map(async requestedPath => {
                const workspace = await window.electronAPI.getWorkspaceProjects(requestedPath);
                return workspace.success && workspace.root ? workspace.root : requestedPath;
              }));
              const workspacePaths = normalizeWorkspacePaths(resolved[0], resolved);
              normalizedConfig = { ...normalizedConfig, workspacePath: workspacePaths[0] || '', workspacePaths };
            } else {
              setShowWorkspaceSetup(true);
            }
            setConfig(normalizedConfig);
            if (JSON.stringify(fileConfig.workspacePaths) !== JSON.stringify(normalizedConfig.workspacePaths) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
            if ((fileConfig.workspacePath !== normalizedConfig.workspacePath || fileConfig.autoCleanupDeletedProjectData === undefined || fileConfig.createPlanningFolder === undefined || JSON.stringify(fileConfig.customProjectCategories) !== JSON.stringify(normalizedConfig.customProjectCategories) || JSON.stringify(fileConfig.projectCategoryOrder) !== JSON.stringify(normalizedConfig.projectCategoryOrder) || fileConfig.defaultFolderSort === undefined || fileConfig.itemOpenMode !== normalizedConfig.itemOpenMode || fileConfig.favoriteDisplayMode !== normalizedConfig.favoriteDisplayMode || fileConfig.usagePreferencesVersion !== normalizedConfig.usagePreferencesVersion || legacyFolderOpenMode !== undefined || fileConfig.birthdayEnabled === undefined || fileConfig.pinInspirationLibrary === undefined || !fileConfig.backup || fileConfig.backup?.targetType === undefined || !fileConfig.backup?.nas || !fileConfig.archive || !fileConfig.importDefaults || legacyFileImport !== undefined || legacyBrollClearSource !== undefined || !Array.isArray(fileConfig.smartImport?.sdPaths) || !fileConfig.smartImport?.sdDriveTypes || fileConfig.mediaCache?.maxSizeGB !== normalizedConfig.mediaCache.maxSizeGB || fileConfig.mediaCache?.autoCleanup30Days === undefined || fileConfig.smartImport.backupEnabled || fileConfig.smartImport?.videoPreviewQuality !== normalizedConfig.smartImport.videoPreviewQuality || fileConfig.smartImport?.splitLargeFiles === undefined || fileConfig.smartImport?.dateFilter !== normalizedConfig.smartImport.dateFilter || !fileConfig.brollImport || !fileConfig.inspirationLibrary || JSON.stringify(fileConfig.research) !== JSON.stringify(researchSettings) || fileConfig.personDetection?.useGpu === undefined || fileConfig.smartMatch?.imageDestFolderName !== IMAGE_SELECTION_FOLDER_NAME || fileConfig.smartMatch?.videoDestFolderName !== VIDEO_SELECTION_FOLDER_NAME || configuredImageSource !== normalizedConfig.smartMatch.imageSourceFolderName || configuredVideoSource !== normalizedConfig.smartMatch.videoSourceFolderName || JSON.stringify(fileConfig.homeOrder) !== JSON.stringify(normalizedConfig.homeOrder) || JSON.stringify(fileConfig.projectToolbar) !== JSON.stringify(normalizedConfig.projectToolbar) || JSON.stringify(fileConfig.componentSettings) !== JSON.stringify(normalizedConfig.componentSettings)) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
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

  const refreshBackupStatus = useCallback(async () => {
    if (!config?.workspacePath) return;
    const next = await window.electronAPI.getBackupStatus(config.workspacePath);
    setBackupStatus(next);
  }, [config?.workspacePath]);

  useEffect(() => {
    if (!configLoaded || !config?.workspacePath) return;
    void refreshBackupStatus();
    if (config.backup.enabled && config.backup.automaticDaily) void window.electronAPI.runBackupIfDue(config.workspacePath);
  }, [configLoaded, config?.workspacePath, config?.backup.enabled, config?.backup.automaticDaily, config?.backup.targetPath, refreshBackupStatus]);

  useEffect(() => window.electronAPI.onBackgroundTaskChanged(task => {
    if (task.type === 'workspace-backup' || task.type === 'backup-verify' || task.type.endsWith('-restore')) void refreshBackupStatus();
    const operation = String(task.metadata?.operation || '');
    const importStage = String(task.metadata?.importStage || '');
    if (!config?.backup.enabled || !config.backup.afterImport || task.state !== 'completed' || !operation.startsWith('import') || importStage === 'plan') return;
    if (autoBackedUpImportTasksRef.current.has(task.id)) return;
    autoBackedUpImportTasksRef.current.add(task.id);
    void window.electronAPI.runBackup(config.workspacePath, 'after-import');
  }), [config?.backup.enabled, config?.backup.afterImport, config?.workspacePath, refreshBackupStatus]);

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
      const undoWorkspacePath = activeTab === 'inspiration' ? config?.inspirationLibrary.rootPath : selectedProject?.workspacePath || config?.workspacePath;
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
  }, [activeTab, appDialog, config?.inspirationLibrary.rootPath, config?.workspacePath, showNotice, selectedProject?.path, selectedProject?.workspacePath]);

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
  const handleConfigUpdate = async (newConfig: AppConfig, options?: { applyAfterSave?: boolean }) => {
    if (!options?.applyAfterSave) setConfig(newConfig);
    try {
      if (window.electronAPI?.saveConfig) {
        const result = await window.electronAPI.saveConfig(newConfig);
        if (result.success) {
          if (options?.applyAfterSave) setConfig(newConfig);
          console.log('✅ Configuration saved successfully');
          return true;
        } else {
          window.electronAPI.reportRendererError('保存设置失败', result.error);
          showNotice(`保存设置失败：${result.error || '未知错误'}`, 5000);
          return false;
        }
      }
      if (options?.applyAfterSave) setConfig(newConfig);
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
    return { ...defaults, telemetry: { enabled: true, crashReports: true }, workspacePath: config?.workspacePath || '', workspacePaths: config?.workspacePaths || [], usagePreferencesVersion: config?.usagePreferencesVersion || USAGE_PREFERENCES_VERSION };
  }, [config?.usagePreferencesVersion, config?.workspacePath, config?.workspacePaths]);

  const handleWorkspaceSetup = async (newConfig: AppConfig) => {
    await handleConfigUpdate(newConfig);
    if (newConfig.workspacePath.trim()) setShowWorkspaceSetup(false);
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
    if (config?.pinInspirationLibrary) return;
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
  const openBackupSettings = (project?: WorkspaceProject) => {
    setBackupProjectFocus(project || null);
    setSettingsSection('backup');
    openSettingsTab();
  };
  const closeSettingsTab = () => {
    setSettingsTabOpen(false);
    if (activeTab === 'settings') showHomeTab();
  };
  const closeProjectTab = async (projectPath: string, force = false) => {
    const runningPanelTask = Object.values(panelTasks).find(task => task.scopeKey === projectPath && task.state === 'running');
    if (!force && runningPanelTask) {
      await appDialog.alert({
        title: '组件任务仍在运行',
        message: `“${runningPanelTask.title}”仍在运行，请等待完成或在组件面板中明确取消任务后再关闭项目标签。`,
        detail: '你可以切换到其他项目或页面；任务面板和进度不会丢失。',
      });
      return;
    }
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
      <StartupWindowFrame>
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
      </StartupWindowFrame>
    );
  }

  if (privacyConsentRequired) return <StartupWindowFrame><PrivacyConsentPage onAccept={acceptInternalBetaPrivacy}/></StartupWindowFrame>;

  if (config.usagePreferencesVersion < USAGE_PREFERENCES_VERSION) return <StartupWindowFrame><UsagePreferencesOnboarding config={config} onSave={nextConfig => handleConfigUpdate(nextConfig, { applyAfterSave: true })}/></StartupWindowFrame>;

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-slate-50 text-slate-900 font-sans selection:bg-blue-500/30">
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
            <button type="button" {...titlebarTabDragProps('home')} data-active-tab={activeTab === 'home'} onClick={showHomeTab} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[92px] max-w-[180px] items-center gap-2 rounded-t-lg border px-3 text-xs font-medium transition ${activeTab === 'home' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
              <Home size={14} className="shrink-0"/><span className="truncate">主页</span>
            </button>
            {inspirationTabOpen && <div {...titlebarTabDragProps('inspiration')} data-active-tab={activeTab === 'inspiration'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[112px] max-w-[190px] items-center rounded-t-lg border text-xs font-medium transition ${activeTab === 'inspiration' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={openInspirationTab} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Lightbulb size={14} className="shrink-0"/><span className="truncate">灵感库</span></button>{config.pinInspirationLibrary ? <span aria-label="灵感库已固定" title="灵感库已固定" className="mr-2 text-blue-500"><Pin size={12}/></span> : <button type="button" data-tab-drag-ignore="true" aria-label="关闭灵感库" title="关闭灵感库" onClick={closeInspirationTab} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>}</div>}
            {openProjects.map(project => <React.Fragment key={project.path}>
              <div {...titlebarTabDragProps(projectTabId(project.path))} title={project.name} data-active-tab={selectedProject?.path === project.path && activeTab === 'project'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[120px] max-w-[220px] items-center rounded-t-lg border text-xs font-medium transition ${selectedProject?.path === project.path && activeTab === 'project' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                <button type="button" onClick={() => openProjectTab(project, projectOperations[project.path] ?? null)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Folder size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{project.name}</span></button>
                <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${project.name}`} title={`关闭 ${project.name}`} onClick={() => void closeProjectTab(project.path)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
              </div>
              {workspaceToolTabs.filter(tab => tab.projectPath === project.path).map(tab => {
                const tabType = tab.kind === 'version' ? 'project-version' : 'project-team';
                const isActive = selectedProject?.path === project.path && activeTab === tabType;
                const Icon = tab.kind === 'version' ? GitBranch : UsersRound;
                return <div key={`${project.path}:${tab.kind}`} {...titlebarTabDragProps(workspaceToolTabId(project.path, tab.kind))} title={tab.label} data-active-tab={isActive} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[128px] max-w-[230px] items-center rounded-t-lg border text-xs font-medium transition ${isActive ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                  <button type="button" onClick={() => activateWorkspaceToolTab(project, tab.kind)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Icon size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{tab.label}</span>{tab.kind === 'team' && tab.busy && <span aria-label="任务运行中" title="任务运行中" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-violet-500"/>}</button>
                  <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${tab.label}`} title={`关闭 ${tab.label}`} onClick={() => void closeWorkspaceToolTab(project.path, tab.kind)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
                </div>;
              })}
            </React.Fragment>)}
            {settingsTabOpen && <div {...titlebarTabDragProps('settings')} data-active-tab={activeTab === 'settings'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[108px] max-w-[180px] items-center rounded-t-lg border text-xs font-medium transition ${activeTab === 'settings' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={openSettingsTab} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Settings size={14} className="shrink-0"/><span className="truncate">设置</span></button><button type="button" data-tab-drag-ignore="true" aria-label="关闭设置" title="关闭设置" onClick={closeSettingsTab} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button></div>}
          </div>
          {titlebarTabScroll.overflow && <button type="button" aria-label="向右滚动标签" title="向右滚动标签" disabled={!titlebarTabScroll.canScrollRight} onClick={() => scrollTitlebarTabs(1)} className="app-titlebar-control titlebar-tab-scroll-button"><ChevronRight size={15}/></button>}
          <div aria-label="拖动窗口" className="app-window-drag-region min-w-8 flex-1"/>
        </div>
        <BackgroundTaskIndicator/>
        <WindowControls/>
      </header>

      {showWorkspaceSetup ? <WorkspaceSetupPage config={config} onSave={handleWorkspaceSetup}/> : <div className="flex min-h-0 flex-1">
      {/* Sidebar */}
      <aside style={{ width: sidebarCollapsed ? 0 : renderedSidebarWidth }} className="relative z-30 flex min-w-0 shrink-0 flex-col overflow-hidden bg-white transition-[width] duration-200">
        {activeTab === 'settings' && <SettingsNavigator activeSection={settingsSection} components={components} onSelect={section => { setSettingsSection(section); if (section === 'backup' || section === 'storage') setBackupProjectFocus(null); }}/>}
        {inspirationTabOpen && <div className={activeTab === 'inspiration' ? 'contents' : 'hidden'}><InspirationLibraryNavigator active={activeTab === 'inspiration'} rootPath={config.inspirationLibrary.rootPath} targetWorkspacePath={config.workspacePath} currentRelativePath={inspirationRelativePath} onNavigate={navigateInspiration} onOpenSettings={openSettingsTab} onNotice={showNotice}/></div>}
        {activeTab !== 'settings' && activeTab !== 'inspiration' && <><ProjectNavigator
          workspacePath={config.workspacePath}
          workspacePaths={config.workspacePaths}
          backupEnabled={config.backup.enabled}
          backupStatus={backupStatus}
          autoCleanupDeletedProjectData={config.autoCleanupDeletedProjectData}
          createPlanningFolder={config.createPlanningFolder}
          customProjectCategories={config.customProjectCategories}
          projectCategoryOrder={config.projectCategoryOrder}
          selectedProject={selectedProject}
          onSelectProject={(project, replacePath) => openProjectTab(project, null, replacePath)}
          onProjectAction={handleProjectAction}
          onProjectDeleted={project => void closeProjectTab(project.path, true)}
          onWorkspacesResolved={workspacePaths => { if (workspacePaths.length) handleConfigUpdate({ ...config, workspacePath: workspacePaths[0], workspacePaths }); }}
          onOpenBackup={openBackupSettings}

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
        <div className={activeTab === 'home' ? 'mx-auto max-w-6xl space-y-4' : 'hidden'}>{homeOrder.filter(card => card !== 'birthday' || config.birthdayEnabled).map(card => {
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
            ? <DashboardView section="birthday" workspacePath={config.workspacePath} config={config.smartImport} importDefaults={config.importDefaults} brollConfig={config.brollImport} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} dragProps={dragProps}/>
            : card === 'import'
              ? <DashboardView section="import" workspacePath={config.workspacePath} config={config.smartImport} importDefaults={config.importDefaults} brollConfig={config.brollImport} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} onImportComplete={handleHomeImportComplete} dragProps={dragProps}/>
              : <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <button type="button" onClick={openInspirationTab} className="group flex min-w-0 items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-5 text-left transition hover:border-blue-400 hover:bg-blue-50 hover:shadow-sm">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><Lightbulb size={22}/></span>
                    <span className="min-w-0 flex-1"><span className="block text-base font-bold text-slate-800">灵感库</span><span className="mt-1 block truncate text-xs text-slate-500">整理、浏览与收集灵感素材</span></span>
                    <ChevronRight size={19} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500"/>
                  </button>
                  <BackupHomeCard status={backupStatus} onOpen={openBackupSettings} onRun={() => { void window.electronAPI.runBackup(config.workspacePath, 'manual').then(result => { if (!result.success) showNotice(result.error || '无法开始备份', 5000); else void refreshBackupStatus(); }); }}/>
                </div>;
          return <div key={card} className={draggedHomeCard === card ? 'opacity-40' : undefined}>{content}</div>;
        })}</div>
        {inspirationTabOpen && <div className={activeTab === 'inspiration' ? 'h-full w-full' : 'hidden'}><InspirationLibraryPage active={activeTab === 'inspiration'} navigationRequest={inspirationNavigationRequest} config={config} components={components} componentsLoading={componentsLoading} onUpdateConfig={handleConfigUpdate} onDirectoryChange={setInspirationRelativePath} onNotice={showNotice}/></div>}
        {activeTab === 'settings' && <SettingsPage activeSection={settingsSection} backupProjectFocus={backupProjectFocus} onClearBackupProjectFocus={() => setBackupProjectFocus(null)} config={config} components={components} componentInstallPath={componentInstallPath} componentsLoading={componentsLoading} onRefreshComponents={refreshComponents} onComponentsChanged={handleComponentsChanged} onSave={handleConfigUpdate} getDefaultSettings={getDefaultSettings} onNotice={showNotice}/>}
        {openProjects.map(project => {
          const active = activeTab.startsWith('project') && selectedProject?.path === project.path;
          const activeView = activeTab === 'project-version' ? 'version' : activeTab === 'project-team' ? 'team' : 'project';
          return <div key={project.path} className={active ? 'h-full w-full' : 'hidden'}><ProjectWorkspace
            active={active}
            activeView={activeView}
            project={project}
            workspacePath={project.workspacePath || config.workspacePath}
            inspirationLibraryRootPath={config.inspirationLibrary.rootPath}
            installedComponentIds={installedComponentIds}
            componentsLoading={componentsLoading}
            teamRetouchStatus={components.find(component => component.id === 'team-retouch')}
            advancedVideoSettings={config.componentSettings['video-playback-mpv'] || { arrowKeyAction: 'seek' }}
            projectToolbar={config.projectToolbar}
            customProjectCategories={config.customProjectCategories}
            projectCategoryOrder={config.projectCategoryOrder}
            initialPanel={projectOperations[project.path] ?? null}
            importConfig={config.smartImport}
            importDefaults={config.importDefaults}
            brollConfig={config.brollImport}
            matchConfig={config.smartMatch}
            researchConfig={config.research}
            mediaCacheConfig={config.mediaCache}
            defaultFolderSort={config.defaultFolderSort}
            itemOpenMode={config.itemOpenMode}
            favoriteDisplayMode={config.favoriteDisplayMode}
            onOpenInspirationPath={navigateInspiration}
            onOpenToolTab={(kind, label) => openWorkspaceToolTab(project, kind, label)}
            onCloseToolTab={kind => void closeWorkspaceToolTab(project.path, kind)}
            onToolTabBusyChange={(kind, busy) => updateWorkspaceToolTabBusy(project.path, kind, busy)}
            onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })}
            onMatchConfigChange={(smartMatch: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch })}
            onResearchConfigChange={(research: AppConfig['research']) => handleConfigUpdate({ ...config, research })}
            onNotice={showNotice}
            onProjectMoved={nextProject => {
              nextProject = { ...nextProject, workspacePath: project.workspacePath || config.workspacePath };
              setOpenProjects(current => current.map(item => item.path === project.path ? nextProject : item));
              setWorkspaceToolTabs(current => current.map(tab => tab.projectPath === project.path ? { ...tab, projectPath: nextProject.path, label: tab.kind === 'team' ? `团片 · ${nextProject.name}` : tab.label } : tab));
              setProjectOperations(current => {
                if (nextProject.path === project.path) return current;
                const next = { ...current, [nextProject.path]: current[project.path] ?? null };
                delete next[project.path];
                return next;
              });
              setSelectedProject(nextProject);
              setProjectDestination(nextProject.path);
              window.dispatchEvent(new Event('workspace-projects-changed'));
            }}
            onDeleted={() => {
              void closeProjectTab(project.path, true);
              window.dispatchEvent(new Event('workspace-projects-changed'));
            }}
          /></div>;
        })}

        {activeTab === 'match' && <MatchView config={config.smartMatch} projectPath={selectedProject?.path} onUpdateConfig={(newConfig: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch: newConfig })} />}

        {activeTab === 'video_split' && <VideoSplitView />}
      </main>
      </div>}
    </div>
  );
};

const RootApp = () => <AppErrorBoundary><App/></AppErrorBoundary>;
export default RootApp;
