import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Folder, X, Settings, PanelLeftClose, PanelLeftOpen, ChevronLeft, ChevronRight, GitBranch, Home, Lightbulb, Pin } from 'lucide-react';
import { useAppDialog } from './components/AppDialogProvider';
import { ProjectNavigator } from './components/ProjectNavigator';
import { ProjectWorkspace } from './features/workspace/ProjectWorkspace';
import { AppErrorBoundary } from './features/app/AppErrorBoundary';
import { BackupHomeCard, StartupWindowFrame, UpdateModal, WindowControls } from './features/app/AppChrome';
import { componentTabId, inspirationTabId, projectTabId, useTitlebarTabOrder, workspaceToolTabId } from './features/app/useTitlebarTabOrder';
import { useWorkspaceTabs } from './features/app/useWorkspaceTabs';
import { useFolderTabNavigation } from './features/app/useFolderTabNavigation';
import { browserPageActivation } from './features/app/workspace-tab-model';
import { BackgroundTaskIndicator } from './features/background-tasks/BackgroundTaskIndicator';
import { useTaskCenter } from './features/background-tasks/TaskCenter';
import { useToast } from './features/app/useTopToastStack';
import { rendererErrorFingerprint, rendererErrorNoticeSummary, shouldReportRendererError, type RendererErrorOccurrence } from './features/app/renderer-error-notice-model';
import { DomainHealthBanner } from './features/app/DomainHealthBanner';
import { ComponentPageSurface } from './features/components/ComponentPageSurface'; import { ComponentSettingsPageSurface } from './features/components/ComponentSettingsPageSurface';
import { useComponentPages } from './features/components/useComponentPages';
import { ComponentIcon } from './components/ComponentIcon';
import { PrivacyConsentPage, SettingsNavigator, SettingsPage, WorkspaceSetupPage } from './features/settings/SettingsFeature'; import { componentSettingsSectionKey } from './features/settings/component-settings-page-model';
import { UsagePreferencesOnboarding, USAGE_PREFERENCES_VERSION } from './features/settings/UsagePreferencesOnboarding';
import type { BuiltInSettingsSection, SettingsSection } from './features/settings/SettingsFeature';
import { DashboardView, MatchView, VideoSplitView, type ImportCompletion } from './features/tools/ToolViews';
import { useStartupSdAutoImport } from './features/tools/use-startup-sd-auto-import';
import { normalizeSavedSdDeviceRecords } from './features/tools/sd-startup-import-model';
import { InspirationLibraryNavigator, InspirationLibraryPage } from './features/inspiration/InspirationLibrary';
import { normalizeProgressNamePresets, normalizeProjectCategoryOrder, normalizeWorkspacePaths } from './types';
import type { AppConfig, AppUpdateInfo, BackupStatus, ComponentHostAction, ComponentPageOpenScope, ComponentSettingsPageContribution, ComponentStatus, HomeCardId, ToolType, WorkspaceProject } from './types';
import { ColumnResizeHandle } from './features/app/AppShellLayout';
import { clampNumber, readStoredNumber } from './features/app/app-shell-layout-model';
import { DEFAULT_CONFIG, DEFAULT_HOME_ORDER, IMAGE_SELECTION_FOLDER_NAME, VIDEO_SELECTION_FOLDER_NAME, isMac, localDateKey, normalizeHomeOrder, normalizeMediaCacheSize, normalizeProjectCategories, normalizeProjectToolbar, normalizeVideoPreviewQuality } from './features/app/app-config';
import { normalizeSubtitleFontSize } from './features/app/video-player-settings';
type WorkspaceToolKind = 'version'; type WorkspaceToolTab = { ownerPageId: string; projectId: string; projectPath: string; kind: WorkspaceToolKind; label: string; busy: boolean };
interface PythonEvent { type: 'log' | 'error' | 'progress' | 'status' | 'ask_user' | 'success' | 'warning' | 'preview';
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [showWorkspaceSetup, setShowWorkspaceSetup] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null); const [startupSdAutoStart, setStartupSdAutoStart] = useState(false);
  const [startupBirthdays, setStartupBirthdays] = useState<Record<string, string> | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [privacyStateLoaded, setPrivacyStateLoaded] = useState(false);
  const [privacyConsentRequired, setPrivacyConsentRequired] = useState(true);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [selectedProject, setSelectedProject] = useState<WorkspaceProject | null>(null);
  const { pages: projectPages, activePageId, createPage, activatePage, updatePagePath, closePage, updateProject, closeProject, selectSidebarProject, requestInspirationPath, ensureInspirationRoot, resetInspirationPages } = useWorkspaceTabs();
  const { dismissPanelTasksByOwnerPageId } = useTaskCenter(); const openPageIds = useMemo(() => new Set(projectPages.map(page => page.id)), [projectPages]);
  const [workspaceToolTabs, setWorkspaceToolTabs] = useState<WorkspaceToolTab[]>([]);
  const [, setProjectDestination] = useState<string | null>(null);
  const toast = useToast();
  const showNotice = useCallback((message: string, durationOrTone?: number | 'info' | 'success' | 'warning' | 'error') => {
    toast.show(message, durationOrTone);
  }, [toast]);
  const autoBackedUpImportTasksRef = useRef(new Set<string>()); const lastRendererErrorRef = useRef<RendererErrorOccurrence | null>(null);
  const cacheCleanupCheckedRef = useRef(false);
  const [homeOrder, setHomeOrder] = useState<HomeCardId[]>(DEFAULT_HOME_ORDER);
  const [draggedHomeCard, setDraggedHomeCard] = useState<HomeCardId | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber('photoflow:sidebar-width', 256));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('photoflow:sidebar-collapsed') === 'true');
  const [backgroundTaskDrawerOpen, setBackgroundTaskDrawerOpen] = useState(false);
  const backgroundTaskDrawerHostRef = useRef<HTMLDivElement>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus>({ success: true, enabled: false, state: 'unconfigured', snapshots: [] });
  const [backupProjectFocus, setBackupProjectFocus] = useState<WorkspaceProject | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const titlebarTabsRef = useRef<HTMLDivElement>(null);
  const [titlebarTabScroll, setTitlebarTabScroll] = useState({ overflow: false, canScrollLeft: false, canScrollRight: false });
  useEffect(() => {
    const restorePanelTask = (event: Event) => {
      const ownerPageId = (event as CustomEvent<{ ownerPageId?: string }>).detail?.ownerPageId;
      const page = projectPages.find(item => item.id === ownerPageId);
      if (!page) return;
      activatePage(page.id);
      if (page.project) {
        setSelectedProject(page.project); setProjectDestination(page.project.path); setActiveTab('project');
      } else if (page.kind === 'inspiration') {
        setSelectedProject(null); setProjectDestination(null); setActiveTab('inspiration');
      }
    };
    window.addEventListener('photoflow:restore-panel-task', restorePanelTask);
    return () => window.removeEventListener('photoflow:restore-panel-task', restorePanelTask);
  }, [activatePage, projectPages]);
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
  const [componentSettingsPages, setComponentSettingsPages] = useState<ComponentSettingsPageContribution[]>([]);
  const selectedComponentSettingsPage = useMemo(() => componentSettingsPages.find(page => componentSettingsSectionKey(page) === settingsSection), [componentSettingsPages, settingsSection]);
  const reportComponentSettingsError = useCallback((message: string) => showNotice(`打开组件设置页失败：${message}`), [showNotice]);
  const installedComponentIds = useMemo(() => new Set(components.filter(component => component.installed).map(component => component.id)), [components]);
  const componentHost = useComponentPages({ browserPages: projectPages, components, onProjectFallback: page => { if (page.project) { activatePage(page.id); setSelectedProject(page.project); setProjectDestination(page.project.path); setActiveTab('project'); } }, onHomeFallback: () => { setSelectedProject(null); setProjectDestination(null); setActiveTab('home'); } });
  const { actions: componentHostActions, pages: componentPages, activeIdentity: activeComponentPageIdentity } = componentHost;

  useEffect(() => {
    window.localStorage.setItem('photoflow:sidebar-width', String(Math.round(sidebarWidth)));
  }, [sidebarWidth]);

  useEffect(() => { if (activeTab !== 'component') void componentHost.deactivate(); }, [activeTab, componentHost.deactivate]);

  useEffect(() => {
    let active = true;
    void window.electronAPI.getComponentSettingsPages().then(result => {
      if (!active) return;
      const pages = result.success ? result.pages || [] : [];
      setComponentSettingsPages(pages);
      setSettingsSection(current => current.startsWith('component:') && !pages.some(page => componentSettingsSectionKey(page) === current) ? 'components' : current);
    }).catch(() => { if (active) setComponentSettingsPages([]); });
    return () => { active = false; };
  }, [components]);

  useEffect(() => { window.localStorage.setItem('photoflow:sidebar-collapsed', String(sidebarCollapsed)); }, [sidebarCollapsed]);
  const previousInspirationRootRef = useRef<string>(); const previousInspirationPinnedRef = useRef<boolean>();
  useEffect(() => {
    if (!configLoaded || !config) return;
    const rootPath = config.inspirationLibrary.rootPath.trim();
    const rootChanged = previousInspirationRootRef.current !== rootPath;
    const pinChanged = previousInspirationPinnedRef.current !== config.pinInspirationLibrary;
    previousInspirationRootRef.current = rootPath;
    previousInspirationPinnedRef.current = config.pinInspirationLibrary;
    if (!rootChanged) {
      if (pinChanged && config.pinInspirationLibrary) ensureInspirationRoot(rootPath);
      return;
    }
    const activeWasInspiration = projectPages.some(page => page.id === activePageId && page.kind === 'inspiration');
    resetInspirationPages(rootPath, config.pinInspirationLibrary);
    if (activeWasInspiration) { setSelectedProject(null); setActiveTab(config.pinInspirationLibrary ? 'inspiration' : 'home'); }
  }, [activePageId, config, configLoaded, ensureInspirationRoot, projectPages, resetInspirationPages]);

  const titlebarPages = useMemo(() => ({
    inspiration: projectPages.filter(page => page.kind === 'inspiration').map(page => ({ id: page.id, currentRelativePath: page.currentRelativePath })),
    pinnedInspirationPageId: config?.pinInspirationLibrary ? projectPages.find(page => page.kind === 'inspiration' && page.initialRelativePath === '')?.id : undefined,
    projects: projectPages.filter(page => page.project).map(page => ({ id: page.id, projectPath: page.project!.path })),
  }), [config?.pinInspirationLibrary, projectPages]);
  const titlebarTabDragProps = useTitlebarTabOrder({
    inspirationPages: titlebarPages.inspiration,
    pinnedInspirationPageId: titlebarPages.pinnedInspirationPageId,
    projectPages: titlebarPages.projects,
    toolTabs: workspaceToolTabs,
    componentPages,
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
  }, [componentPages.length, configLoaded, projectPages.length, settingsTabOpen, updateTitlebarTabScroll, workspaceToolTabs.length]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = titlebarTabsRef.current;
      element?.querySelector<HTMLElement>('[data-active-tab="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateTitlebarTabScroll();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [componentPages.length, configLoaded, activeTab, activePageId, projectPages.length, settingsTabOpen, updateTitlebarTabScroll, workspaceToolTabs.length]);

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
    const timer = window.setTimeout(() => {
      void window.electronAPI.clearMediaCache(config.mediaCache, 30, { origin: 'daily-auto' }).then(result => {
        if (result.success) window.localStorage.setItem(storageKey, today);
      });
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [config?.mediaCache.autoCleanup30Days, config?.mediaCache.directory, config?.mediaCache.maxSizeGB]);
  // Keep the user's preferred width untouched while the window is compact.
  // The rendered width may shrink temporarily and returns automatically when
  // the window is enlarged again.
  const renderedSidebarWidth = clampNumber(sidebarWidth, 128, Math.min(420, Math.max(128, viewportWidth - 700)));

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

  const refreshComponents = useCallback(async (force = false) => {
    setComponentsLoading(true);
    try {
      const result = await window.electronAPI.getComponents(force);
      if (!result.success) throw new Error(result.error || '无法读取组件状态');
      setComponents(result.components || []);
      window.localStorage.setItem('photoflow:components-cache', JSON.stringify(result.components || []));
      setComponentInstallPath(result.installPath || '');
    } catch (error) {
      setComponents([]);
      showNotice(`读取组件状态失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setComponentsLoading(false);
    }
  }, [showNotice]);

  const handleComponentsChanged = useCallback(async () => {
    await refreshComponents(true);
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
      const now = Date.now(); if (!shouldReportRendererError(lastRendererErrorRef.current, message, now)) return;
      lastRendererErrorRef.current = { fingerprint: rendererErrorFingerprint(message), reportedAt: now }; showNotice(`发生错误：${rendererErrorNoticeSummary(message)}`);
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
    const removeMainErrorListener = window.electronAPI?.onAppError?.(message => report(message));
    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      console.error = originalConsoleError;
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      removePythonListener?.();
      removeMainErrorListener?.();
    };
  }, [showNotice]);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        if (window.electronAPI?.loadConfig) {
          const startupSnapshot = await window.electronAPI.loadStartupSnapshot?.();
          const fileConfig = startupSnapshot ? startupSnapshot.config : await window.electronAPI.loadConfig();
          if (startupSnapshot) setStartupBirthdays(startupSnapshot.birthdays || {});
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
            const legacyAdvancedVideo = fileConfig.componentSettings?.['video-playback-mpv'];
            const videoPlayback: AppConfig['videoPlayback'] = {
              arrowKeyAction: fileConfig.videoPlayback?.arrowKeyAction === 'navigate' ? 'navigate' : fileConfig.videoPlayback?.arrowKeyAction === 'seek' ? 'seek' : legacyAdvancedVideo?.arrowKeyAction === 'navigate' ? 'navigate' : 'seek',
              subtitlesEnabled: fileConfig.videoPlayback?.subtitlesEnabled === true,
              subtitlePreferredLanguages: Array.isArray(fileConfig.videoPlayback?.subtitlePreferredLanguages) ? fileConfig.videoPlayback.subtitlePreferredLanguages.map(value => String(value).trim().toLowerCase()).filter(Boolean).slice(0, 8) : ['zh', 'chi', 'zho'],
              subtitleSize: normalizeSubtitleFontSize(fileConfig.videoPlayback?.subtitleSize),
              subtitleStyle: fileConfig.videoPlayback?.subtitleStyle === 'high-contrast' ? 'high-contrast' : 'standard',
            };
            const configuredImageSource = fileConfig.smartMatch?.imageSourceFolderName;
            const configuredVideoSource = fileConfig.smartMatch?.videoSourceFolderName;
            const savedSdPaths = (Array.isArray(fileConfig.smartImport?.sdPaths) && fileConfig.smartImport.sdPaths.length ? fileConfig.smartImport.sdPaths : fileConfig.smartImport?.sdPath ? [fileConfig.smartImport.sdPath] : []).map((drive: string) => isMac ? drive : drive.replace(/\\/g, '/').replace(/\/DCIM\/?$/i, '/'));
            const savedSdDevices = normalizeSavedSdDeviceRecords(fileConfig.smartImport?.sdDevices, savedSdPaths, fileConfig.smartImport?.sdDeviceIds, fileConfig.smartImport?.sdDriveTypes);
            const componentSettings: AppConfig['componentSettings'] = { ...fileConfig.componentSettings };
            delete componentSettings['video-playback-mpv'];
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
            let normalizedConfig = { ...legacyConfig, theme: fileConfig.theme ?? 'system', telemetry: { enabled: fileConfig.telemetry?.enabled === true, crashReports: fileConfig.telemetry?.crashReports === true }, workspacePath: fileConfig.workspacePath?.trim() ?? '', autoCleanupDeletedProjectData: fileConfig.autoCleanupDeletedProjectData ?? true, createPlanningFolder: fileConfig.createPlanningFolder ?? true, customProjectCategories, projectCategoryOrder: normalizeProjectCategoryOrder(fileConfig.projectCategoryOrder, customProjectCategories), defaultFolderSort: fileConfig.defaultFolderSort ?? 'date', itemOpenMode: fileConfig.itemOpenMode === 'double' || legacyFolderOpenMode === 'double' ? 'double' : 'single', favoriteDisplayMode: fileConfig.favoriteDisplayMode === 'stars' ? 'stars' : 'binary', usagePreferencesVersion: Number(fileConfig.usagePreferencesVersion) || 0, projectToolbar: normalizeProjectToolbar(fileConfig.projectToolbar), homeOrder: normalizeHomeOrder(fileConfig.homeOrder), birthdayEnabled: fileConfig.birthdayEnabled ?? true, pinInspirationLibrary: fileConfig.pinInspirationLibrary === true, componentSettings, videoPlayback, mediaCache: { maxSizeGB: normalizeMediaCacheSize(fileConfig.mediaCache?.maxSizeGB), directory: fileConfig.mediaCache?.directory ?? '', autoCleanup30Days: fileConfig.mediaCache?.autoCleanup30Days ?? false }, backup: { enabled: fileConfig.backup?.enabled === true, targetType: fileConfig.backup?.targetType === 'nas' || (fileConfig.backup?.targetType === undefined && fileConfig.backup?.targetPath?.startsWith('\\\\')) ? 'nas' : 'local', targetPath: fileConfig.backup?.targetPath ?? '', mode: fileConfig.backup?.mode === 'latest' ? 'latest' : 'history', automaticDaily: fileConfig.backup?.automaticDaily ?? true, afterImport: fileConfig.backup?.afterImport ?? true, retention: { daily: Math.max(1, Number(fileConfig.backup?.retention?.daily) || 7), weekly: Math.max(0, Number(fileConfig.backup?.retention?.weekly) || 4), monthly: Math.max(0, Number(fileConfig.backup?.retention?.monthly) || 12) }, nas: { credentialRef: fileConfig.backup?.nas?.credentialRef ?? '', limitEnabled: fileConfig.backup?.nas?.limitEnabled === true, bandwidthLimitMBps: Math.max(1, Number(fileConfig.backup?.nas?.bandwidthLimitMBps) || 20), limitStart: fileConfig.backup?.nas?.limitStart || '09:00', limitEnd: fileConfig.backup?.nas?.limitEnd || '18:00' } }, archive: { enabled: fileConfig.archive?.enabled === true, targetPath: fileConfig.archive?.targetPath ?? '' }, importDefaults: { deleteSourceAfterImport: fileConfig.importDefaults?.deleteSourceAfterImport ?? !(legacyFileImport?.preserveOriginal ?? false), generateJpgFromRaw: fileConfig.importDefaults?.generateJpgFromRaw ?? true, splitVideosOnImport: fileConfig.importDefaults?.splitVideosOnImport ?? fileConfig.smartImport?.splitLargeFiles ?? false, transcodeVideosOnImport: fileConfig.importDefaults?.transcodeVideosOnImport ?? fileConfig.smartImport?.generateVideoPreview ?? false }, videoTools: { transcode: { container: fileConfig.videoTools?.transcode?.container ?? 'mp4', videoMode: fileConfig.videoTools?.transcode?.videoMode ?? 'h264', quality: fileConfig.videoTools?.transcode?.quality ?? 'balanced', resolution: fileConfig.videoTools?.transcode?.resolution ?? 'original', frameRate: fileConfig.videoTools?.transcode?.frameRate ?? 'original', audioMode: fileConfig.videoTools?.transcode?.audioMode ?? 'aac' } }, smartImport: { ...fileConfig.smartImport, sdPath: savedSdPaths[0] || '', sdPaths: savedSdPaths, sdDriveTypes: fileConfig.smartImport?.sdDriveTypes ?? {}, sdDeviceIds: fileConfig.smartImport?.sdDeviceIds ?? {}, sdDevices: savedSdDevices, backupEnabled: false, generateVideoPreview: false, videoPreviewQuality: normalizeVideoPreviewQuality(fileConfig.smartImport?.videoPreviewQuality), splitLargeFiles: false, dateFilter: fileConfig.smartImport?.dateFilter === 'today' || fileConfig.smartImport?.dateFilter === 'today_yesterday' ? fileConfig.smartImport.dateFilter : 'all' }, brollImport: { splitVideosOnImport: fileConfig.brollImport?.splitVideosOnImport ?? fileConfig.importDefaults?.splitVideosOnImport ?? fileConfig.brollImport?.splitLargeFiles ?? false, transcodeVideosOnImport: fileConfig.brollImport?.transcodeVideosOnImport ?? fileConfig.importDefaults?.transcodeVideosOnImport ?? fileConfig.smartImport?.generateVideoPreview ?? false }, inspirationLibrary, smartMatch: { imageDestFolderName: IMAGE_SELECTION_FOLDER_NAME, videoDestFolderName: VIDEO_SELECTION_FOLDER_NAME, imageSourceFolderName: configuredImageSource === undefined || configuredImageSource.toLowerCase() === 'raw' ? 'raw' : configuredImageSource, videoSourceFolderName: configuredVideoSource === undefined || configuredVideoSource.toLowerCase() === 'mov' ? 'mov' : configuredVideoSource }, research: researchSettings } as AppConfig;
            normalizedConfig.componentSettingsRevisions = { ...(fileConfig.componentSettingsRevisions || {}) }; normalizedConfig.videoTools.trim = { exportMode: fileConfig.videoTools?.trim?.exportMode === 'exact' ? 'exact' : 'fast' };
            normalizedConfig.folderAlphabetFilterEnabled = fileConfig.folderAlphabetFilterEnabled !== false;
            normalizedConfig.versionTreeEnabled = fileConfig.versionTreeEnabled !== false;
            normalizedConfig.progressNamePresets = normalizeProgressNamePresets(fileConfig.progressNamePresets);
            normalizedConfig.smartImport.autoMoveProjectAfterSdImport = fileConfig.smartImport?.autoMoveProjectAfterSdImport ?? true;
            normalizedConfig.smartMatch.sourceFolderRelativePath = fileConfig.smartMatch?.sourceFolderRelativePath;
            normalizedConfig = { ...normalizedConfig, workspacePath: configuredWorkspacePaths[0] || '', workspacePaths: configuredWorkspacePaths };
            if (!normalizedConfig.workspacePaths.length) setShowWorkspaceSetup(true);
            setStartupSdAutoStart(normalizedConfig.smartImport.autoStart === true); setConfig(normalizedConfig);
            if (fileConfig.videoTools?.trim?.exportMode !== normalizedConfig.videoTools.trim.exportMode && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
            if ((JSON.stringify(fileConfig.workspacePaths) !== JSON.stringify(normalizedConfig.workspacePaths) || fileConfig.smartImport?.autoMoveProjectAfterSdImport === undefined || JSON.stringify(fileConfig.smartImport?.sdDevices) !== JSON.stringify(savedSdDevices) || fileConfig.folderAlphabetFilterEnabled === undefined || fileConfig.versionTreeEnabled === undefined || JSON.stringify(fileConfig.progressNamePresets) !== JSON.stringify(normalizedConfig.progressNamePresets)) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
            if ((fileConfig.workspacePath !== normalizedConfig.workspacePath || fileConfig.autoCleanupDeletedProjectData === undefined || fileConfig.createPlanningFolder === undefined || JSON.stringify(fileConfig.customProjectCategories) !== JSON.stringify(normalizedConfig.customProjectCategories) || JSON.stringify(fileConfig.projectCategoryOrder) !== JSON.stringify(normalizedConfig.projectCategoryOrder) || fileConfig.defaultFolderSort === undefined || fileConfig.itemOpenMode !== normalizedConfig.itemOpenMode || fileConfig.favoriteDisplayMode !== normalizedConfig.favoriteDisplayMode || fileConfig.usagePreferencesVersion !== normalizedConfig.usagePreferencesVersion || legacyFolderOpenMode !== undefined || fileConfig.birthdayEnabled === undefined || fileConfig.pinInspirationLibrary === undefined || !fileConfig.backup || fileConfig.backup?.targetType === undefined || !fileConfig.backup?.nas || !fileConfig.archive || !fileConfig.importDefaults || fileConfig.importDefaults?.splitVideosOnImport === undefined || fileConfig.importDefaults?.transcodeVideosOnImport === undefined || !fileConfig.videoTools?.transcode || legacyFileImport !== undefined || legacyBrollClearSource !== undefined || !Array.isArray(fileConfig.smartImport?.sdPaths) || !fileConfig.smartImport?.sdDriveTypes || !fileConfig.smartImport?.sdDeviceIds || fileConfig.mediaCache?.maxSizeGB !== normalizedConfig.mediaCache.maxSizeGB || fileConfig.mediaCache?.autoCleanup30Days === undefined || fileConfig.smartImport.backupEnabled || fileConfig.smartImport?.videoPreviewQuality !== normalizedConfig.smartImport.videoPreviewQuality || fileConfig.smartImport?.splitLargeFiles === undefined || fileConfig.smartImport?.dateFilter !== normalizedConfig.smartImport.dateFilter || !fileConfig.brollImport || fileConfig.brollImport?.splitVideosOnImport === undefined || fileConfig.brollImport?.transcodeVideosOnImport === undefined || !fileConfig.inspirationLibrary || JSON.stringify(fileConfig.research) !== JSON.stringify(researchSettings) || fileConfig.smartMatch?.imageDestFolderName !== IMAGE_SELECTION_FOLDER_NAME || fileConfig.smartMatch?.videoDestFolderName !== VIDEO_SELECTION_FOLDER_NAME || configuredImageSource !== normalizedConfig.smartMatch.imageSourceFolderName || configuredVideoSource !== normalizedConfig.smartMatch.videoSourceFolderName || JSON.stringify(fileConfig.homeOrder) !== JSON.stringify(normalizedConfig.homeOrder) || JSON.stringify(fileConfig.projectToolbar) !== JSON.stringify(normalizedConfig.projectToolbar) || JSON.stringify(fileConfig.componentSettings) !== JSON.stringify(normalizedConfig.componentSettings)) && window.electronAPI?.saveConfig) await window.electronAPI.saveConfig(normalizedConfig);
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
      showNotice('组件版本不一致。请重启软件，仍无效时重新安装。');
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
    void window.electronAPI.recoverMediaWorkflowImports(config.workspacePath).then(result => { if (result.failures.length) showNotice('媒体已导入，部分关系将在下次启动时重试恢复。'); }).catch(() => undefined); void refreshBackupStatus();
    if (config.backup.enabled && config.backup.automaticDaily) void window.electronAPI.runBackupIfDue(config.workspacePath);
  }, [configLoaded, config?.workspacePath, config?.backup.enabled, config?.backup.automaticDaily, config?.backup.targetPath, refreshBackupStatus, showNotice]);

  useEffect(() => window.electronAPI.onBackgroundTaskChanged(delta => {
    for (const task of delta.upserts) {
      if (task.type === 'workspace-backup' || task.type === 'backup-verify' || task.type.endsWith('-restore')) void refreshBackupStatus();
      const operation = String(task.metadata?.operation || '');
      const importStage = String(task.metadata?.importStage || '');
      if (!config?.backup.enabled || !config.backup.afterImport || task.state !== 'completed' || !operation.startsWith('import') || importStage === 'plan') continue;
      if (autoBackedUpImportTasksRef.current.has(task.id)) continue;
      autoBackedUpImportTasksRef.current.add(task.id);
      void window.electronAPI.runBackup(config.workspacePath, 'after-import');
    }
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
      const cleanup = window.electronAPI.onUpdateAvailable(info => {
        console.log("Update available:", info);
        setUpdateInfo({ ...info, mandatory: info.mandatory === true });
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
      showNotice(result.success ? (result.message || '\u5df2\u64a4\u9500\u4e0a\u4e00\u6b21\u91cd\u547d\u540d') : (result.error || '\u6682\u65e0\u53ef\u64a4\u9500\u7684\u91cd\u547d\u540d'), result.success ? 'success' : 'error');
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
          const savedConfig = result.savedConfig || newConfig;
          if (options?.applyAfterSave) setConfig(savedConfig);
          else setConfig(current => current ? { ...current, componentSettings: savedConfig.componentSettings, componentSettingsRevisions: savedConfig.componentSettingsRevisions } : savedConfig);
          console.log('✅ Configuration saved successfully');
          return true;
        } else {
          window.electronAPI.reportRendererError('保存设置失败', result.error);
          showNotice(`保存设置失败：${result.error || '未知错误'}`);
          return false;
        }
      }
      if (options?.applyAfterSave) setConfig(newConfig);
      return true;
    } catch (error) {
      window.electronAPI.reportRendererError('保存设置异常', error instanceof Error ? error.stack : String(error));
      showNotice(`保存设置失败：${error instanceof Error ? error.message : String(error)}`);
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
      showNotice(`保存隐私确认失败：${consent.error || '未知错误'}`);
      return;
    }
    const saved = await handleConfigUpdate({ ...config, telemetry: { enabled: true, crashReports: true } });
    if (saved) setPrivacyConsentRequired(false);
  };
  const openProjectTab = (project: WorkspaceProject, operation: 'import' | 'broll' | 'match' | null = null, replacePath?: string) => {
    if (replacePath !== undefined) {
      updateProject(project);
      setWorkspaceToolTabs(current => current.map(tab => tab.projectId === project.id ? { ...tab, projectPath: project.path } : tab));
      setSelectedProject(current => current?.id === project.id ? project : current);
      if (projectPages.some(page => page.id === activePageId && page.projectId === project.id)) setProjectDestination(project.path);
      return;
    }
    const rootPage = projectPages.find(page => page.projectId === project.id && page.currentRelativePath === '');
    if (projectPages.some(page => page.projectId === project.id)) updateProject(project);
    if (rootPage) activatePage(rootPage.id);
    else createPage({ kind: 'project', projectId: project.id, project, currentRelativePath: '', initialRelativePath: '', operation });
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project');
  };
  const activateProjectPage = (pageId: string) => {
    const page = projectPages.find(candidate => candidate.id === pageId);
    if (!page?.project) return;
    activatePage(pageId);
    setSelectedProject(page.project);
    setProjectDestination(page.project.path);
    setActiveTab('project');
  };
  const selectSidebarProjectPage = (project: WorkspaceProject, replacePath?: string) => {
    if (replacePath !== undefined) {
      openProjectTab(project, null, replacePath);
      return;
    }
    selectSidebarProject(project);
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project');
  };
  const openProjectDirectoryPage = (project: WorkspaceProject, initialRelativePath: string) => {
    createPage({ kind: 'project', projectId: project.id, project, currentRelativePath: initialRelativePath, initialRelativePath, operation: null });
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project');
  };
  const openWorkspaceToolTab = (ownerPageId: string, project: WorkspaceProject, kind: WorkspaceToolKind, label: string) => {
    setWorkspaceToolTabs(current => {
      const existing = current.find(tab => tab.ownerPageId === ownerPageId && tab.kind === kind);
      return existing
        ? current.map(tab => tab === existing ? { ...tab, projectId: project.id, projectPath: project.path, label } : tab)
        : [...current, { ownerPageId, projectId: project.id, projectPath: project.path, kind, label, busy: false }];
    });
    activatePage(ownerPageId);
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project-version');
  };
  const activateWorkspaceToolTab = (tab: WorkspaceToolTab, project: WorkspaceProject) => {
    activatePage(tab.ownerPageId);
    setSelectedProject(project);
    setProjectDestination(project.path);
    setActiveTab('project-version');
  };
  const activateComponentPageTab = (page: typeof componentPages[number]) => {
    const projectPage = projectPages.find(candidate => candidate.projectId === page.projectId && candidate.project);
    if (projectPage?.project) { setSelectedProject(projectPage.project); setProjectDestination(projectPage.project.path); }
    componentHost.activate(page); setActiveTab('component');
  };
  const openComponentPage = async (action: ComponentHostAction, project: WorkspaceProject, workspacePath: string, scope?: ComponentPageOpenScope) => {
    const insertAfterTabId = activeTab === 'home' ? 'home'
      : activeTab === 'settings' ? 'settings'
        : activeTab === 'component' && activeComponentPageIdentity ? componentTabId(activeComponentPageIdentity)
          : activeTab === 'project-version' && activePageId ? workspaceToolTabId(activePageId, 'version')
            : activeTab === 'inspiration' && activePageId ? inspirationTabId(activePageId)
              : activePageId ? projectTabId(activePageId) : 'home';
    setSelectedProject(project); setProjectDestination(project.path); setActiveTab('component');
    if (!await componentHost.open(action, project, workspacePath, insertAfterTabId, scope)) setActiveTab('project');
  };
  const closeComponentPageTab = (page: typeof componentPages[number]) => componentHost.close(page);
  const disposeProjectComponentPages = componentHost.disposeProject;
  const closeWorkspaceToolTab = async (ownerPageId: string, kind: WorkspaceToolKind) => {
    setWorkspaceToolTabs(current => current.filter(item => item.ownerPageId !== ownerPageId || item.kind !== kind));
    const closingActiveTab = activePageId === ownerPageId
      && activeTab === 'project-version';
    if (closingActiveTab) setActiveTab('project');
  };
  const showHomeTab = () => {
    setSelectedProject(null); setProjectDestination(null); setActiveTab('home');
  };
  const openInspirationTab = () => {
    if (!config) return;
    requestInspirationPath(config.inspirationLibrary.rootPath.trim(), '');
    setSelectedProject(null);
    setActiveTab('inspiration');
  };
  const disposePageOwnedUi = useCallback((pageIds: string[]) => {
    if (!pageIds.length) return; const pageIdSet = new Set(pageIds);
    for (const pageId of pageIds) dismissPanelTasksByOwnerPageId(pageId);
    setWorkspaceToolTabs(current => current.filter(tab => !pageIdSet.has(tab.ownerPageId)));
  }, [dismissPanelTasksByOwnerPageId]);
  const closeInspirationTab = (pageId: string) => {
    const page = projectPages.find(candidate => candidate.id === pageId);
    if (!page || page.kind !== 'inspiration') return;
    if (config?.pinInspirationLibrary && page.currentRelativePath === '' && !projectPages.some(candidate => candidate.kind === 'inspiration' && candidate.id !== pageId && candidate.currentRelativePath === '')) return;
    const closingIndex = projectPages.findIndex(candidate => candidate.id === pageId);
    const remaining = projectPages.filter(candidate => candidate.id !== pageId);
    disposePageOwnedUi([pageId]);
    closePage(pageId);
    if (activePageId !== pageId) return;
    const nextPage = remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)];
    if (nextPage?.kind === 'inspiration') { setSelectedProject(null); setProjectDestination(null); setActiveTab('inspiration'); }
    else if (nextPage?.project) { setSelectedProject(nextPage.project); setProjectDestination(nextPage.project.path); setActiveTab('project'); }
    else showHomeTab();
  };
  const activateInspiration = () => {
    setSelectedProject(null);
    setProjectDestination(null);
    setActiveTab('inspiration');
  };
  const { navigationRequests: browserNavigationRequests, openInNewTab: openInspirationDirectoryPage, navigateCurrent: navigateInspiration, dropActive: folderTabDropActive, sourceDragActive: folderTabSourceDragActive, dropProps: folderTabDropProps } = useFolderTabNavigation({ rootPath: config?.inspirationLibrary.rootPath.trim() || '', pages: projectPages, activePageId, createPage, requestInspirationPath, activateInspiration, openProjectInNewTab: project => openProjectDirectoryPage(project, '') });
  const openSettingsTab = async () => {
    if (activeTab === 'component') await componentHost.deactivate(); setSettingsTabOpen(true);
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
  const closeProjectTab = async (pageId: string, _force = false) => {
    const page = projectPages.find(candidate => candidate.id === pageId);
    if (!page?.project) return;
    const remaining = projectPages.filter(candidate => candidate.id !== pageId);
    const closingIndex = projectPages.findIndex(candidate => candidate.id === pageId);
    const closingLastProjectPage = !remaining.some(candidate => candidate.projectId === page.projectId);
    const closingActiveComponent = componentPages.some(candidate => candidate.identity === activeComponentPageIdentity && candidate.projectId === page.projectId);
    disposePageOwnedUi([pageId]);
    if (closingLastProjectPage) disposeProjectComponentPages(page.project.workspacePath || config?.workspacePath || '', page.projectId);
    closePage(pageId);
    if (activePageId !== pageId && !closingActiveComponent) return;
    const nextPage = remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)];
    if (nextPage?.project) {
      activatePage(nextPage.id); setActiveTab('project');
      setSelectedProject(nextPage.project); setProjectDestination(nextPage.project.path);
    } else if (nextPage?.kind === 'inspiration') {
      activatePage(nextPage.id);
      setSelectedProject(null);
      setProjectDestination(null);
      setActiveTab('inspiration');
    } else showHomeTab();
  };
  const closeAllPagesForProject = (project: WorkspaceProject) => {
    const closingPageIds = projectPages.filter(page => page.projectId === project.id).map(page => page.id); const activeBelongsToProject = projectPages.some(page => page.id === activePageId && page.projectId === project.id) || componentPages.some(page => page.identity === activeComponentPageIdentity && page.projectId === project.id); const remaining = projectPages.filter(page => page.projectId !== project.id);
    disposePageOwnedUi(closingPageIds);
    disposeProjectComponentPages(project.workspacePath || config?.workspacePath || '', project.id);
    closeProject(project.id);
    if (!activeBelongsToProject) return;
    const nextPage = remaining[0];
    const nextActivation = browserPageActivation(nextPage);
    if (nextPage) activatePage(nextPage.id);
    setSelectedProject(nextActivation.selectedProject);
    setProjectDestination(nextActivation.projectDestination);
    setActiveTab(nextActivation.activeTab);
  };
  const handleHomeImportComplete = async (completion: ImportCompletion) => { if (!config) return;
    const result = await window.electronAPI.finalizeSdImportedProjects(config.workspacePath, completion.projectNames, { moveProjectAfterImport: config.smartImport.autoMoveProjectAfterSdImport, workProjectNames: completion.workProjectNames, importedPathsByProject: completion.importedPathsByProject });
    if (!result.success) { showNotice(`整理导入项目失败：${result.error || '未知错误'}`); return; }
    if (result.failures.length) showNotice(`导入已完成，但有 ${result.failures.length} 个项目的分类更新失败。`);
    else if (result.movedProjects.length) showNotice('导入完成，项目已移入“后期中”。');
    else showNotice('导入完成，项目分类保持不变。');
    if (result.projects.length === 1) openProjectTab(result.projects[0]); window.dispatchEvent(new Event('workspace-projects-changed'));
  };
  // 等待配置加载完成再渲染主界面
  const handleProjectAction = (action: 'import' | 'broll' | 'match', project: WorkspaceProject) => {
    openProjectTab(project, action);
  };
  const startupSdImportRequest = useStartupSdAutoImport({ enabledAtLaunch: startupSdAutoStart, enabledNow: config?.smartImport.autoStart === true, ready: Boolean(configLoaded && privacyStateLoaded && !privacyConsentRequired && config && !showWorkspaceSetup && config.usagePreferencesVersion >= USAGE_PREFERENCES_VERSION), onStart: showHomeTab });
  if (!configLoaded || !config || !privacyStateLoaded) {
    return (
      <>
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
      </>
    );
  }
  if (updateInfo?.mandatory) return <StartupWindowFrame><UpdateModal {...updateInfo} onClose={() => undefined}/></StartupWindowFrame>;
  if (privacyConsentRequired) return <StartupWindowFrame><PrivacyConsentPage onAccept={acceptInternalBetaPrivacy}/></StartupWindowFrame>;
  if (config.usagePreferencesVersion < USAGE_PREFERENCES_VERSION) return <StartupWindowFrame><UsagePreferencesOnboarding config={config} onSave={nextConfig => handleConfigUpdate(nextConfig, { applyAfterSave: true })}/></StartupWindowFrame>;

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-slate-50 text-slate-900 font-sans selection:bg-blue-500/30">

      {updateInfo && (
        <UpdateModal
          version={updateInfo.version}
          url={updateInfo.url}
          notes={updateInfo.notes}
          mandatory={updateInfo.mandatory}
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
        <div {...folderTabDropProps} data-folder-tab-drop-zone="true" aria-label="标签栏" className={`relative flex min-w-0 flex-1 transition-colors ${folderTabDropActive ? 'bg-blue-50 ring-1 ring-inset ring-blue-400' : ''}`}>
          {titlebarTabScroll.overflow && <button type="button" aria-label="向左滚动标签" title="向左滚动标签" disabled={!titlebarTabScroll.canScrollLeft} onClick={() => scrollTitlebarTabs(-1)} className="app-titlebar-control titlebar-tab-scroll-button"><ChevronLeft size={15}/></button>}
          <div ref={titlebarTabsRef} onWheel={handleTitlebarTabWheel} aria-label="已打开的窗口" className="titlebar-tabs-scroll scrollbar-hide flex min-w-0 shrink items-end gap-0 overflow-x-auto px-2 pt-1.5">
            <button type="button" {...titlebarTabDragProps('home')} data-active-tab={activeTab === 'home'} onClick={showHomeTab} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[92px] max-w-[180px] items-center gap-2 rounded-t-lg border px-3 text-xs font-medium transition ${activeTab === 'home' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
              <Home size={14} className="shrink-0"/><span className="truncate">主页</span>
            </button>
            {projectPages.filter(page => page.kind === 'inspiration').map(page => { const folderName = page.currentRelativePath.split('/').filter(Boolean).pop(); const label = page.currentRelativePath ? `灵感库 · ${folderName || page.currentRelativePath}` : '灵感库'; const pinnedRoot = config.pinInspirationLibrary && page.initialRelativePath === ''; const isActive = activePageId === page.id && activeTab === 'inspiration'; return <div key={page.id} {...titlebarTabDragProps(inspirationTabId(page.id))} data-active-tab={isActive} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[112px] max-w-[210px] items-center rounded-t-lg border text-xs font-medium transition ${isActive ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={() => { activatePage(page.id); setSelectedProject(null); setActiveTab('inspiration'); }} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Lightbulb size={14} className="shrink-0"/><span className="truncate">{label}</span></button>{pinnedRoot ? <span aria-label="灵感库已固定" title="灵感库已固定" className="mr-2 text-blue-500"><Pin size={12}/></span> : <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${label}`} title={`关闭 ${label}`} onClick={() => closeInspirationTab(page.id)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>}</div>; })}
            {projectPages.filter(page => page.project).map(page => { const project = page.project!; const folderName = page.currentRelativePath.split('/').filter(Boolean).pop(); const label = page.initialRelativePath ? `${project.name} · ${folderName || page.initialRelativePath}` : project.name; return <React.Fragment key={page.id}>
              <div {...titlebarTabDragProps(projectTabId(page.id))} title={label} data-active-tab={activePageId === page.id && activeTab === 'project'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[120px] max-w-[220px] items-center rounded-t-lg border text-xs font-medium transition ${activePageId === page.id && activeTab === 'project' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                <button type="button" onClick={() => activateProjectPage(page.id)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Folder size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{label}</span></button>
                <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${label}`} title={`关闭 ${label}`} onClick={() => void closeProjectTab(page.id)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
              </div>
              {workspaceToolTabs.filter(tab => tab.ownerPageId === page.id).map(tab => {
                const tabType = 'project-version';
                const isActive = activePageId === tab.ownerPageId && activeTab === tabType;
                const Icon = GitBranch;
                return <div key={`${tab.ownerPageId}:${tab.kind}`} {...titlebarTabDragProps(workspaceToolTabId(tab.ownerPageId, tab.kind))} title={tab.label} data-active-tab={isActive} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[128px] max-w-[230px] items-center rounded-t-lg border text-xs font-medium transition ${isActive ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
                  <button type="button" onClick={() => activateWorkspaceToolTab(tab, project)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Icon size={14} className="shrink-0"/><span className="min-w-0 flex-1 truncate">{tab.label}</span></button>
                  <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${tab.label}`} title={`关闭 ${tab.label}`} onClick={() => void closeWorkspaceToolTab(tab.ownerPageId, tab.kind)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
                </div>;
              })}
            </React.Fragment>; })}
            {componentPages.map(page => { const isActive = activeTab === 'component' && activeComponentPageIdentity === page.identity; return <div key={page.identity} {...titlebarTabDragProps(componentTabId(page.identity))} data-active-tab={isActive} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[128px] max-w-[230px] items-center rounded-t-lg border text-xs font-medium transition ${isActive ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>
              <button type="button" onClick={() => activateComponentPageTab(page)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><ComponentIcon src={page.iconUrl} size={14}/><span className="min-w-0 flex-1 truncate">{page.title} · {page.projectName}</span></button>
              <button type="button" data-tab-drag-ignore="true" aria-label={`关闭 ${page.title}`} title={`关闭 ${page.title}`} onClick={() => void closeComponentPageTab(page)} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button>
            </div>; })}
            {settingsTabOpen && <div {...titlebarTabDragProps('settings')} data-active-tab={activeTab === 'settings'} className={`app-titlebar-control workspace-tab group flex h-[34px] min-w-[108px] max-w-[180px] items-center rounded-t-lg border text-xs font-medium transition ${activeTab === 'settings' ? 'is-active border-slate-200 bg-slate-50 text-slate-900' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}><button type="button" onClick={openSettingsTab} className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 text-left"><Settings size={14} className="shrink-0"/><span className="truncate">设置</span></button><button type="button" data-tab-drag-ignore="true" aria-label="关闭设置" title="关闭设置" onClick={closeSettingsTab} className="mr-1.5 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-200 hover:text-slate-800 group-hover:opacity-100"><X size={13}/></button></div>}
          </div>
          {titlebarTabScroll.overflow && <button type="button" aria-label="向右滚动标签" title="向右滚动标签" disabled={!titlebarTabScroll.canScrollRight} onClick={() => scrollTitlebarTabs(1)} className="app-titlebar-control titlebar-tab-scroll-button"><ChevronRight size={15}/></button>}
          <div aria-label={folderTabSourceDragActive ? '标签栏空白区域' : '拖动窗口'} className={`${folderTabSourceDragActive ? 'app-titlebar-control' : 'app-window-drag-region'} min-w-8 flex-1`}/>
        </div>
        <DomainHealthBanner components={components}/>
        <BackgroundTaskIndicator ownerPageIds={openPageIds} open={backgroundTaskDrawerOpen} onOpenChange={setBackgroundTaskDrawerOpen} drawerHostRef={backgroundTaskDrawerHostRef}/>
        <WindowControls/>
      </header>

      {showWorkspaceSetup ? <WorkspaceSetupPage config={config} onSave={handleWorkspaceSetup}/> : <div className="flex min-h-0 flex-1">
      {/* Sidebar */}
      <aside style={{ width: sidebarCollapsed ? 0 : renderedSidebarWidth }} className="relative z-30 flex min-w-0 shrink-0 flex-col overflow-hidden bg-white transition-[width] duration-200">
        {activeTab === 'settings' && <SettingsNavigator activeSection={settingsSection} componentPages={componentSettingsPages}
          onSelect={section => { setSettingsSection(section); if (section === 'backup' || section === 'storage') setBackupProjectFocus(null); }}/>
        }
        {projectPages.some(page => page.kind === 'inspiration') && <div className={activeTab === 'inspiration' ? 'contents' : 'hidden'}><InspirationLibraryNavigator active={activeTab === 'inspiration'} rootPath={config.inspirationLibrary.rootPath} targetWorkspacePath={config.workspacePath} currentRelativePath={projectPages.find(page => page.id === activePageId && page.kind === 'inspiration')?.currentRelativePath || ''} onNavigate={navigateInspiration} onOpenInNewTab={openInspirationDirectoryPage} onOpenSettings={openSettingsTab}/></div>}
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
          onSelectProject={(project, replacePath) => selectSidebarProjectPage(project, replacePath)}
          onProjectAction={handleProjectAction}
          onProjectDeleted={closeAllPagesForProject}
          onWorkspacesResolved={workspacePaths => { if (workspacePaths.length) handleConfigUpdate({ ...config, workspacePath: workspacePaths[0], workspacePaths }); }}
          onOpenBackup={openBackupSettings}

        />
        <div className="border-t border-slate-200 px-4 py-2">
          <button onClick={openSettingsTab} className="flex w-full items-center gap-3 rounded-lg p-3 text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"><Settings size={18} className="text-slate-400"/><span className="text-sm font-medium">设置</span></button>
        </div></>}
      </aside>
      {!sidebarCollapsed && <ColumnResizeHandle label="调整项目栏宽度" onDrag={deltaX => setSidebarWidth(width => clampNumber(width + deltaX, 128, 420))}/>}

      {/* Main Content */}
      <main className={`relative min-w-0 flex-1 bg-slate-50 ${activeTab.startsWith('project') || activeTab === 'inspiration' || activeTab === 'component' || (activeTab === 'settings' && selectedComponentSettingsPage) ? 'overflow-hidden p-0' : activeTab === 'settings' ? 'overflow-auto p-0' : 'overflow-auto p-8'}`}>
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
            ? <DashboardView section="birthday" initialBirthdays={startupBirthdays || undefined} workspacePath={config.workspacePath} config={config.smartImport} importDefaults={config.importDefaults} brollConfig={config.brollImport} videoTools={config.videoTools} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} dragProps={dragProps}/>
            : card === 'import'
              ? <DashboardView section="import" active={activeTab === 'home'} startupAutoImportRequest={startupSdImportRequest} workspacePath={config.workspacePath} config={config.smartImport} importDefaults={config.importDefaults} brollConfig={config.brollImport} videoTools={config.videoTools} onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })} onImportComplete={handleHomeImportComplete} dragProps={dragProps}/>
              : <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <button type="button" onClick={openInspirationTab} className="group flex min-w-0 items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-5 text-left transition hover:border-blue-400 hover:bg-blue-50 hover:shadow-sm">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><Lightbulb size={22}/></span>
                    <span className="min-w-0 flex-1"><span className="block text-base font-bold text-slate-800">灵感库</span><span className="mt-1 block truncate text-xs text-slate-500">整理和浏览灵感素材</span></span>
                    <ChevronRight size={19} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500"/>
                  </button>
                  <BackupHomeCard status={backupStatus} onOpen={openBackupSettings} onRun={() => { void window.electronAPI.runBackup(config.workspacePath, 'manual').then(result => { if (!result.success) showNotice(result.error || '无法开始备份', 'error'); else void refreshBackupStatus(); }); }}/>
                </div>;
          return <div key={card} className={draggedHomeCard === card ? 'opacity-40' : undefined}>{content}</div>;
        })}</div>
        {projectPages.filter(page => page.kind === 'inspiration').map(page => { const active = activeTab === 'inspiration' && activePageId === page.id; return <div key={page.id} className={active ? 'h-full w-full' : 'hidden'}><InspirationLibraryPage pageId={page.id} active={active} initialRelativePath={page.initialRelativePath} navigationRequest={browserNavigationRequests[page.id]} config={config} components={components} onUpdateConfig={handleConfigUpdate} onDirectoryChange={updatePagePath} onOpenDirectoryPage={openInspirationDirectoryPage}/></div>; })}
        {activeTab === 'settings' && !selectedComponentSettingsPage && <SettingsPage activeSection={settingsSection as BuiltInSettingsSection} backupProjectFocus={backupProjectFocus} onClearBackupProjectFocus={() => setBackupProjectFocus(null)} config={config} components={components} componentInstallPath={componentInstallPath} componentsLoading={componentsLoading} onRefreshComponents={() => refreshComponents(true)} onComponentsChanged={handleComponentsChanged} onSave={handleConfigUpdate} onConfigRestored={setConfig} getDefaultSettings={getDefaultSettings}/>}
        {activeTab === 'settings' && selectedComponentSettingsPage && <ComponentSettingsPageSurface key={`${selectedComponentSettingsPage.componentId}:${selectedComponentSettingsPage.pageId}:${selectedComponentSettingsPage.componentVersion}`} page={selectedComponentSettingsPage} onError={reportComponentSettingsError}/>}
        {componentPages.map(page => <ComponentPageSurface key={page.identity} page={page} active={activeTab === 'component' && activeComponentPageIdentity === page.identity}/>)}
        {projectPages.filter(page => page.project).map(page => { const project = page.project!;
          const active = activeTab.startsWith('project') && activePageId === page.id;
          const activeView = activeTab === 'project-version' ? 'version' : 'project';
          return <div key={page.id} className={active ? 'h-full w-full' : 'hidden'}><ProjectWorkspace
            pageId={page.id}
            active={active}
            activeView={activeView}
            project={project}
            workspacePath={project.workspacePath || config.workspacePath}
            inspirationLibraryRootPath={config.inspirationLibrary.rootPath}
            installedComponentIds={installedComponentIds}
            componentHostActions={componentHostActions} onOpenComponentPage={(action, scope) => void openComponentPage(action, project, project.workspacePath || config.workspacePath, scope)}
            videoPlaybackSettings={config.videoPlayback}
            projectToolbar={config.projectToolbar}
            customProjectCategories={config.customProjectCategories}
            projectCategoryOrder={config.projectCategoryOrder}
            progressNamePresets={config.progressNamePresets}
            initialPanel={page.operation}
            initialRelativePath={page.initialRelativePath}
            onDirectoryChange={updatePagePath}
            importConfig={config.smartImport}
            importDefaults={config.importDefaults}
            brollConfig={config.brollImport}
            videoTools={config.videoTools}
            matchConfig={config.smartMatch}
            researchConfig={config.research}
            mediaCacheConfig={config.mediaCache}
            defaultFolderSort={config.defaultFolderSort}
            itemOpenMode={config.itemOpenMode}
            folderAlphabetFilterEnabled={config.folderAlphabetFilterEnabled}
            versionTreeEnabled={config.versionTreeEnabled}
            favoriteDisplayMode={config.favoriteDisplayMode}
            onOpenInspirationPath={navigateInspiration}
            onOpenDirectoryPage={relativePath => openProjectDirectoryPage(project, relativePath)}
            onOpenToolTab={(pageId, kind, label) => openWorkspaceToolTab(pageId, project, kind, label)}
            onCloseToolTab={(pageId, kind) => void closeWorkspaceToolTab(pageId, kind)}
            onImportConfigChange={(smartImport: AppConfig['smartImport']) => handleConfigUpdate({ ...config, smartImport })}
            onMatchConfigChange={(smartMatch: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch })}
            onResearchConfigChange={(research: AppConfig['research']) => handleConfigUpdate({ ...config, research })}
            onProjectMoved={nextProject => {
              nextProject = { ...nextProject, workspacePath: project.workspacePath || config.workspacePath };
              updateProject(nextProject);
              setWorkspaceToolTabs(current => current.map(tab => tab.projectId === project.id ? { ...tab, projectPath: nextProject.path } : tab));
              setSelectedProject(nextProject);
              setProjectDestination(nextProject.path);
              window.dispatchEvent(new Event('workspace-projects-changed'));
            }}
            onDeleted={() => {
              closeAllPagesForProject(project);
              window.dispatchEvent(new Event('workspace-projects-changed'));
            }}
          /></div>;
        })}

        {activeTab === 'match' && <MatchView config={config.smartMatch} projectPath={selectedProject?.path} onUpdateConfig={(newConfig: AppConfig['smartMatch']) => handleConfigUpdate({ ...config, smartMatch: newConfig })} />}

        {activeTab === 'video_split' && <VideoSplitView />}
      </main>
      <div ref={backgroundTaskDrawerHostRef} className={backgroundTaskDrawerOpen ? 'w-80 shrink-0 overflow-hidden border-l border-slate-200 bg-white' : 'hidden'} />
      </div>}
    </div>
  );
};

const RootApp = () => <AppErrorBoundary><App/></AppErrorBoundary>;
export default RootApp;
