import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, FolderPlus, Folder, Image as ImageIcon, GalleryVerticalEnd, Play, Trash2, Edit, X, Plus, Loader2, CheckCircle2, ExternalLink, Video, ChevronDown, File, FileImage, MemoryStick, LayoutList, Grid2X2, FileText, Copy, Scissors as Cut, ClipboardPaste, CheckSquare, ArrowLeft, ArrowRight, Gauge, PanelLeftOpen, ArrowUpDown, ArrowUp, ArrowDown, ArrowUpRight, AlertTriangle, Search, Filter as Funnel, Info, GripVertical, Maximize2, GitBranch, Heart, Star, RefreshCw, Crop, Pin } from 'lucide-react';
import { VersionManager } from '../../components/VersionManager';
import { VideoPlayer } from '../../components/AdvancedVideoPlayer';
import { MediaThumbnail } from '../../components/MediaThumbnail';
import { InteractiveCropEditor } from '../../components/InteractiveCropEditor';
import { ImportSourceControls, type ImportMaterialKind } from '../../components/ImportSourceControls';
import { mergeSourcePaths } from '../../components/source-path-picker-model';
import type { CropRectangle } from '../../components/InteractiveCropEditor';
import { ProjectVersionTree, type VersionTreeCanvasController } from '../../components/ProjectVersionTree';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useEscapeLayer } from '../../components/LayerProvider';
import { ConverterView, ImportCard, MatchView, ResearchView, ScreenshotMainImageView, type ImportCompletion } from '../tools/ToolViews';
import { resolveInspectedToolSources } from '../tools/tool-source-selection-model';
import { PROJECT_FILE_BROWSER_CONTEXT } from '../file-browser/browser-context';
import type { FileBrowserContext } from '../file-browser/browser-context';
import { normalizeProjectCategoryOrder, PROJECT_TOOLBAR_ACTION_IDS, projectStatusLabel } from '../../types';
import type { AppConfig, ComponentContribution, ComponentHostAction, ComponentPageOpenScope, MediaMetadataField, ProgressFolder, ProjectFileEntry, ProjectFileListFilter, ProjectFileOperationProgress, ProjectFileSortField, ProjectFilterScope, ProjectToolbarActionId, ShellNewFileType, VersionBatchFileOperation, VersionGraphEdge, WorkspaceProject } from '../../types';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../../utils/recycleBinFailure';
import { useTaskCenter } from '../background-tasks/TaskCenter';
import { isPanelTaskRestoreForPage, panelTaskSessionKey, type PanelTaskRestoreDetail } from '../background-tasks/panel-task-session-model';
import { FILE_GRID_GAP, FILE_LIST_HEADER_HEIGHT, FILE_LIST_ROW_HEIGHT, FILE_SURFACE_HORIZONTAL_PADDING, FILE_SURFACE_PADDING, calculateFileGridGeometry, fileSurfaceContentWidth, finiteLogicalCanvasSize, hitMarqueeIndices, mergeMarqueeSelection, normalizeMarqueeRect, rectanglesIntersect, viewportPointToContentPoint, type MarqueeRect } from './marquee-selection-model';
import { advanceMarqueeAutoScroll, marqueeAutoScrollDelta } from './marquee-auto-scroll';
import { converterTriggerAction } from './project-panel-lifecycle';
import { PROJECT_BACKGROUND_LOAD_DELAYS_MS, PROJECT_WATCH_FALLBACK_REFRESH_MS, isForegroundDirectoryRefresh, resolveProjectWorkspaceLifecycle, shouldReconcileProjectWatch, type ProjectWorkspaceLifecycleIdentity } from './project-workspace-lifecycle';
import { applyShortcutPreviewState } from './shortcut-preview-state-model';
import { directoryEntryToRevealOnReturn, fileEntryClickIntent, fileEntryDragPaths, fileEntryPointerModifiers, mediaRatingCacheKey, mergeRefreshedEntryMetadata, mergeRefreshedRecursiveDirectoryEntries, mutatedEntryCanBeRevealed, mutatedEntryFiltersNeedReset, ratingMutationPreviewIsCurrent, remapEntryAfterProgressFolderMove, renamedEntryDestinationPath, retainStableGroupOrder, type ProgressFolderEntryLocation } from './file-entry-interaction-model';
import { nativeFileDragDecisionDetails, nativeFileDragOwnerIdentity, nativeFileDragSessionMustReset, nativeFileDragTargetFromElement, tryStartNativeFileDrag } from './native-file-drag-session-model';
import { FOLDER_ALPHABET_FILTER_THRESHOLD, FOLDER_ALPHABET_KEYS, availableFolderAlphabetKeys, folderAlphabetKey } from './folder-alphabet-filter-model';
import { useRecentFilesAutoLoad } from './useRecentFilesAutoLoad';
import { collectProgressSubtree, inspectProgressRelations } from './progress-tree-model';
import { FolderMarkPanel, createFolderMarkDraft, TrackingConfirmationPanel, ProgressPairPreview as SharedProgressPairPreview, type FolderMarkDraft, type ProgressPairPreviewMode, VersionProgressPanel, type VersionProgressDraft, defaultFolderMarkPurpose, defaultMainParentId, defaultWorkflowInputIds, exportedImageFolderCandidate, exportedImageFolderCandidates, exportFolderPromptWasShown, isUserVersionKey, nextVersionKeys, normalizeProgressSetupTrackingPolicy, normalizeTrackingPolicy, progressRelationChangeError, progressTrackingAction, progressTrackingActionLabel, rememberExportFolderPromptShown, selectableVersionParents, trackingPolicyForRelationChange, trackingStateLabel, versionKeyMatchesParentKind, versionKindForParent, versionTreeNodeBadgeLabel, versionTreeTaskPanelProgress, workflowInputIdsForRelationChange, type VersionRelationKind, ProgressRelationMutationQueue } from '../versioning/public';
import { previewMetadataFieldsForEntry } from '../metadata/metadata-pane-model';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { useProjectFileSelection } from './useProjectFileSelection';
import { defaultProjectFileSortDirection, isFolderLikeEntry, sortProjectFileEntries } from './file-entry-sort-model';
import { pageOwnsFileOperationNotification } from './file-operation-notification-model';
import { presentOfficeExtractionResult, type OfficeExtractionPresentation } from './office-extraction-result-model';
import { addPendingFileOperation, applyPendingFileOperations, claimClipboardGeneration, operationRefreshDirectories, pendingOperationForEntry, pendingPathConflicts, predictUniqueDirectoryName, removePendingFileOperation, type PendingFileOperation, type PendingProjectFileEntry } from './file-operation-state-model';
import { directoryPreviewCacheKey, directoryPreviewCacheKeyWithin, folderCoverEntryAfterLoad, pendingDirectoryPreviewSourceCacheKey, remapDirectoryPreviewCacheKey, remapPendingDirectoryPreviewEntries, settlePendingDirectoryPreviewRenameCaches, shouldCacheDirectoryPreviewResult } from './directory-preview-cache-model';
import { FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES, createFolderCoverMediaState, folderCoverMediaSourceKey, folderCoverRequestKey, reduceFolderCoverMediaState } from './folder-cover-media-model';
import { ImportCompletionNotice, ToolModal } from './ProjectToolModal';
import { ColumnResizeHandle, ComponentToolbarActions, FileListColumnResizeHandle, ViewportContextMenu, ViewportSubmenu } from './ProjectWorkspaceLayout';
import { findCachedMediaThumbnailPreview, forgetMediaThumbnailPreviews, mediaThumbnailPreviewKey, rememberMediaThumbnailPreview, requestThumbnail, useThumbnailUpdates } from './useProjectThumbnail';
import { isOfficeOpenXmlEntry, isPhotoshopOpenEntry, isScreenshotMainImageEntry, requestCaptureDateTime } from './project-workspace-media-metadata';
import { DEFAULT_FILE_LIST_COLUMN_WIDTHS, FILE_LIST_COLUMN_KEYS, FILE_LIST_GRID_CHROME_WIDTH, clampNumber, fitFileListColumnWidths, fitProjectColumnWidths, groupedResultsAreInitiallyLoading, readStoredBoolean, readStoredNumber, resizeFileListColumnBoundary, scheduleAfterProjectPaint, shouldRetainGroupedResultsDuringRefresh, type FileListColumnBoundary, type FileListColumnWidths } from './project-workspace-layout-model';
import { PhotoshopIcon } from './PhotoshopIcon';
import { useUserFacingToast, type ToastActivityHandle } from '../app/useUserFacingToast';
import { ComponentContributionDock } from '../components/ComponentContributionDock';
import { ComponentIcon } from '../../components/ComponentIcon';
import { componentHostSelectedRelativePaths as safeComponentHostSelectedRelativePaths, mediaContributionScope, placedFullPageActions, projectContributionScope, visibleComponentToolbarActions } from '../components/component-contribution-scope-model';
import { mayCommitAsyncOperationResult } from '../file-operation-identity-model';
import type { SelectionEntryDetails } from './multi-selection-metadata-model';
import { FileMetadataPane } from './FileMetadataPane';
type ProjectFileDragEndResult = Parameters<Parameters<typeof projectWorkspaceClient.onProjectFileDragEnd>[0]>[0];
const FILE_VIRTUAL_OVERSCAN_ROWS = 10;
const RECENT_FILES_PAGE_SIZE = 240;
const RECENT_FILES_LOAD_AHEAD_PX = 900;
const RECENT_FILES_SESSION_EXPIRED = 'RECENT_FILES_SESSION_EXPIRED';
const FILE_LIST_PAGE_SIZE = 200;
const FILE_LIST_SESSION_EXPIRED = 'FILE_LIST_SESSION_EXPIRED';
const FILE_LIST_CANCELLED = 'FILE_LIST_CANCELLED';
const DIRECTORY_PREVIEW_RETRY_DELAYS_MS = [120, 480] as const;
const JPG_CONVERSION_EXTENSIONS = new Set(['.png', '.webp', '.heic', '.heif', '.hif', '.avif', '.tif', '.tiff', '.bmp', '.gif']);
type PreviewImageCropAnalysis = {
  success: boolean;
  crop?: CropRectangle;
  snapGuides?: { x: number[]; y: number[] };
  originalSize?: { width: number; height: number };
  error?: string;
};
type DirectoryPreviewLoadResult = { entries: ProjectFileEntry[]; authoritative: boolean };
type CompareMatch = { source: string; reference: string; target: string; confidence: string; distance: number };
type ProjectPanel = 'import' | 'negative-import' | 'broll' | 'file-import' | 'match' | 'research' | 'converter' | 'screenshot-main-image' | 'office-extract' | 'trash' | null;
type MountedProjectPanel = Exclude<ProjectPanel, null>;
const PROJECT_PANEL_TITLES: Record<MountedProjectPanel, string> = {
  import: '从 SD 卡导入',
  'negative-import': '导入 · 原始素材',
  broll: '导入 · 花絮',
  'file-import': '导入 · 其他文件',
  match: '从文件名选片',
  research: '截取分镜帧',
  converter: '图片转 JPG',
  'screenshot-main-image': '提取截图主图',
  'office-extract': '提取文档图片',
  trash: '移入回收站',
};
type ProjectBrowseMode = 'recent' | 'grid' | 'list' | 'version-tree';
const isProjectBrowseMode = (value: unknown): value is ProjectBrowseMode => value === 'recent' || value === 'grid' || value === 'list' || value === 'version-tree';
const FILE_LIST_COLUMN_STORAGE_KEYS: Record<keyof FileListColumnWidths, string> = {
  name: 'photoflow:file-list-name-column-width',
  modified: 'photoflow:file-list-modified-column-width',
  type: 'photoflow:file-list-type-column-width',
  size: 'photoflow:file-list-size-column-width',
};
const FILE_LIST_COLUMNS_CUSTOMIZED_STORAGE_KEY = 'photoflow:file-list-columns-customized-v2';
const DEFAULT_FOLDER_GRID_ICON_SIZE = 132;
const MIN_FOLDER_GRID_ICON_SIZE = 80;
const MAX_FOLDER_GRID_ICON_SIZE = 360;
const normalizeFolderGridIconSize = (value: unknown) => Math.max(MIN_FOLDER_GRID_ICON_SIZE, Math.min(MAX_FOLDER_GRID_ICON_SIZE, Math.round(Number(value) / 4) * 4));
type ProjectFileFilter = 'all' | 'media' | 'image' | 'video';
type ProjectRatingFilter = 'all' | 'rated' | '1' | '2' | '3' | '4' | '5';
const PROJECT_FILE_FILTER_OPTIONS: ReadonlyArray<{ value: ProjectFileFilter; label: string }> = [
  { value: 'all', label: '全部文件' },
  { value: 'media', label: '媒体文件' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
];
const PROJECT_BINARY_RATING_FILTER_OPTIONS: ReadonlyArray<{ value: ProjectRatingFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'rated', label: '仅看喜爱' },
];
const PROJECT_STAR_RATING_FILTER_OPTIONS: ReadonlyArray<{ value: ProjectRatingFilter; label: string }> = [
  { value: 'all', label: '全部评分' },
  { value: 'rated', label: '有星媒体' },
  { value: '1', label: '1 星' },
  { value: '2', label: '2 星' },
  { value: '3', label: '3 星' },
  { value: '4', label: '4 星' },
  { value: '5', label: '5 星' },
];
const normalizeProjectRelativePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const safeStorageGet = (key: string) => { try { return window.localStorage.getItem(key) || ''; } catch { return ''; } };
const safeStorageSet = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* optional state */ } };
const safeStorageRemove = (key: string) => { try { window.localStorage.removeItem(key); } catch { /* optional state */ } };
const projectRelativeParentPath = (value: string) => normalizeProjectRelativePath(value).split('/').slice(0, -1).join('/');
const INSPIRATION_DISABLED_IMPORT_KINDS: readonly ImportMaterialKind[] = ['original', 'progress', 'broll'];
const PROTECTED_PROJECT_FOLDER_NAMES = new Set(['raw', 'jpg', 'mov', 'mov_转码', '策划']);
const progressNodeMediaKind = (folder: Pick<ProgressFolder, 'mediaKind'>): 'image' | 'video' | null => folder.mediaKind === 'image' || folder.mediaKind === 'video' ? folder.mediaKind : null;
type ProgressSetupDraft = {
  mode: 'create' | 'import' | 'mark';
  mediaKind: 'image' | 'video';
  relation: 'root' | 'branch';
  relationKind: VersionRelationKind;
  parentProgressId: string;
  versionKey: string;
  progressName: string;
  trackingEnabled: boolean;
  deleteSourceAfterImport: boolean;
  linkOnly: boolean;
  sourcePaths: string[];
  renameSources: boolean;
  copyMissingFromParent: boolean;
  workflowInputProgressIds: string[];
  targetRelativePath?: string;
  existingProgressId?: string;
  preserveFolderName?: boolean;
  contextLocked?: boolean;
  openEditorAfterCreate?: boolean;
};
type VersionGraphHistoryEntry = { label: string; undo: () => Promise<void>; redo: () => Promise<void> };
type ProgressCompareConfirmation = {
  sourceMode: 'import' | 'mark';
  progressFolder: ProgressFolder;
  parentFolder: ProgressFolder;
  matches: CompareMatch[];
  suggestions: CompareMatch[];
  acceptedSources: string[];
  unmatchedSources: string[];
  unmatchedReferences: string[];
  renameSources: boolean;
  copyMissingFromParent: boolean;
  reconcileExisting?: boolean;
  trackingRefreshMode?: 'establish' | 'refresh';
  enableTrackingOnCommit?: boolean;
  incrementalSources?: string[];
};
type ProgressCompareFilter = 'recognized' | 'accepted' | 'new' | 'missing';
type ProgressCompareListItem = {
  key: string;
  source?: string;
  reference?: string;
  match?: CompareMatch;
  category: ProgressCompareFilter;
};
const progressCompareCandidatesFor = (compare: ProgressCompareConfirmation) => [...compare.matches, ...compare.suggestions];
const progressCompareMissingReferencesFor = (compare: ProgressCompareConfirmation) => {
  const acceptedSources = new Set(compare.acceptedSources);
  const acceptedReferences = new Set(progressCompareCandidatesFor(compare)
    .filter(match => acceptedSources.has(match.source))
    .map(match => match.reference));
  return compare.unmatchedReferences.filter(reference => !acceptedReferences.has(reference));
};
const progressCompareNewSourcesFor = (compare: ProgressCompareConfirmation) => {
  const acceptedSources = new Set(compare.acceptedSources);
  return Array.from(new Set([
    ...compare.unmatchedSources,
    ...compare.matches.filter(match => !acceptedSources.has(match.source)).map(match => match.source),
  ])).filter(source => !acceptedSources.has(source));
};
const buildProgressCompareListItems = (compare: ProgressCompareConfirmation, filter: ProgressCompareFilter): ProgressCompareListItem[] => {
  const candidates = progressCompareCandidatesFor(compare);
  const acceptedSources = new Set(compare.acceptedSources);
  if (filter === 'recognized') return compare.matches.map(match => ({ key: `source:${match.source}`, source: match.source, reference: match.reference, match, category: filter }));
  if (filter === 'accepted') return candidates.filter(match => acceptedSources.has(match.source)).map(match => ({ key: `source:${match.source}`, source: match.source, reference: match.reference, match, category: filter }));
  if (filter === 'new') return progressCompareNewSourcesFor(compare).map(source => {
    const match = candidates.find(candidate => candidate.source === source);
    return { key: `source:${source}`, source, reference: match?.reference, match, category: filter };
  });
  return progressCompareMissingReferencesFor(compare).map(reference => {
    const match = candidates.find(candidate => candidate.reference === reference && !acceptedSources.has(candidate.source));
    return { key: `reference:${reference}`, source: match?.source, reference, match, category: filter };
  });
};
const ProgressPairPreview = ({ match, parentFolder, progressFolder, cacheConfig }: {
  match?: { source?: string; reference?: string };
  parentFolder: ProgressFolder;
  progressFolder: ProgressFolder;
  cacheConfig: AppConfig['mediaCache'];
}) => {
  const [mode, setMode] = useState<ProgressPairPreviewMode>('side-by-side');
  const [swapped, setSwapped] = useState(false);
  const joinPath = (folderPath: string, name?: string) => name
    ? `${folderPath.replace(/[\\/]+$/, '')}${folderPath.includes('\\') ? '\\' : '/'}${name}`
    : '';
  return <SharedProgressPairPreview
    referencePath={joinPath(parentFolder.folderPath, match?.reference)}
    sourcePath={joinPath(progressFolder.folderPath, match?.source)}
    referenceLabel={match?.reference ? `上一版本 · ${match.reference}` : '上一版本'}
    sourceLabel={match?.source ? `当前版本 · ${match.source}` : '当前版本'}
    referenceMissing={!match?.reference}
    mode={mode}
    swapped={swapped}
    cacheConfig={cacheConfig}
    onModeChange={setMode}
    onSwappedChange={setSwapped}
  />;
};
type PreviewTechnicalMetadata = { width?: number; height?: number; duration?: number; unavailable?: boolean };
const EMPTY_PREVIEW_TECHNICAL_METADATA: PreviewTechnicalMetadata = {};
type ProjectEntryDetails = { size: number; createdAt: number; updatedAt: number; fileCount: number; folderCount: number };
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
type FileBrowserWorkspaceProps = {
  pageId: string;
  initialRelativePath?: string;
  active: boolean;
  activeView: 'project' | 'version';
  project: WorkspaceProject;
  workspacePath: string;
  inspirationTargetWorkspacePath?: string;
  inspirationLibraryRootPath?: string;
  installedComponentIds: ReadonlySet<string>;
  videoToolsAvailable: boolean;
  advancedVideoPlaybackAvailable: boolean;
  componentHostActions?: ComponentHostAction[]; componentContributions?: ComponentContribution[]; onOpenComponentPage?: (action: ComponentHostAction, scope: ComponentPageOpenScope) => void; videoPlaybackSettings: AppConfig['videoPlayback'];
  projectToolbar?: AppConfig['projectToolbar'];
  customProjectCategories?: string[];
  projectCategoryOrder?: string[];
  progressNamePresets?: string[];
  initialPanel: 'import' | 'broll' | 'match' | null;
  importConfig: AppConfig['smartImport'];
  importDefaults: AppConfig['importDefaults'];
  brollConfig: AppConfig['brollImport'];
  videoTools: AppConfig['videoTools'];
  matchConfig: AppConfig['smartMatch'];
  researchConfig: AppConfig['research'];
  mediaCacheConfig: AppConfig['mediaCache'];
  defaultFolderSort: ProjectFileSortField;
  itemOpenMode: AppConfig['itemOpenMode'];
  folderAlphabetFilterEnabled?: boolean;
  versionTreeEnabled?: boolean;
  favoriteDisplayMode?: AppConfig['favoriteDisplayMode'];
  browserContext: FileBrowserContext;
  navigationRequest?: { path: string; id: number };
  onDirectoryChange?: (relativePath: string) => void;
  onOpenInspirationPath?: (relativePath: string) => void;
  onOpenDirectoryPage?: (relativePath: string) => void;
  onOpenToolTab?: (kind: 'version', label: string) => void;
  onCloseToolTab?: (kind: 'version') => void;
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onMatchConfigChange: (config: AppConfig['smartMatch']) => void;
  onResearchConfigChange: (config: AppConfig['research']) => void;
  onNotice: (message: string, duration?: number) => void | (() => void);
  onProjectMoved?: (project: WorkspaceProject) => void;
  onDeleted?: () => void;
};
const isUnsupportedShortcutContent = (entry: ProjectFileEntry) => entry.viaShortcut === true && entry.viaExternalLink !== true;
const backgroundTaskPathKey = (value: unknown) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
const handledVideoTrimTaskIds = new Set<string>();
const FileBrowserWorkspace = ({ pageId, active, activeView, project, workspacePath, inspirationTargetWorkspacePath, inspirationLibraryRootPath, installedComponentIds: _installedComponentIds, videoToolsAvailable, advancedVideoPlaybackAvailable, componentHostActions = [], componentContributions = [], onOpenComponentPage = () => undefined, videoPlaybackSettings, projectToolbar = { order: [...PROJECT_TOOLBAR_ACTION_IDS], hidden: [], onlyShowAvailable: false }, customProjectCategories = [], projectCategoryOrder = [], progressNamePresets = [], initialPanel, initialRelativePath = '', importConfig, importDefaults, brollConfig, videoTools, matchConfig, researchConfig, mediaCacheConfig, defaultFolderSort, itemOpenMode, folderAlphabetFilterEnabled = true, versionTreeEnabled = true, favoriteDisplayMode = 'binary', browserContext, navigationRequest, onDirectoryChange, onOpenInspirationPath, onOpenDirectoryPage, onOpenToolTab = () => undefined, onCloseToolTab = () => undefined, onImportConfigChange, onMatchConfigChange, onResearchConfigChange, onNotice, onProjectMoved = () => undefined, onDeleted = () => undefined }: FileBrowserWorkspaceProps) => {
  const toast = useUserFacingToast();
  const appDialog = useAppDialog();
  const projectStatuses = useMemo<Array<WorkspaceProject['status']>>(() => {
    const values = [...normalizeProjectCategoryOrder(projectCategoryOrder, customProjectCategories), project.status];
    const seen = new Set<string>();
    return values.filter(status => {
      const key = status.toLocaleLowerCase();
      if (status === '未分类' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [customProjectCategories, project.status, projectCategoryOrder]);
  const { backgroundTasks, panelTasks, dismissBackgroundTask } = useTaskCenter();
  const [folders, setFolders] = useState<Array<{ name: string; path: string; updatedAt: number }>>([]);
  const [progressFolders, setProgressFolders] = useState<ProgressFolder[]>([]);
  const [versionGraphEdges, setVersionGraphEdges] = useState<VersionGraphEdge[]>([]);
  const [draggingChildId, setDraggingChildId] = useState('');
  const [hoverParentId, setHoverParentId] = useState('');
  const [pendingRelationChange, setPendingRelationChange] = useState<{ childProgressId: string; parentProgressId: string | null } | null>(null);
  const [relationMutationId, setRelationMutationId] = useState(0);
  const relationMutationIdRef = useRef(0);
  const progressFoldersRef = useRef<ProgressFolder[]>([]);
  const exportCandidateTimersRef = useRef(new Map<string, number>());
  const exportCandidateChangedAtRef = useRef(new Map<string, number>());
  const offeredExportFoldersRef = useRef(new Set<string>());
  const relationMutationQueueRef = useRef(new ProgressRelationMutationQueue());
  const relationMutationCountsRef = useRef(new Map<string, number>());
  const supplementalEdgeDeletionIdsRef = useRef(new Set<string>());
  const relationUndoStackRef = useRef<VersionGraphHistoryEntry[]>([]);
  const relationRedoStackRef = useRef<VersionGraphHistoryEntry[]>([]);
  const [relationHistoryRevision, setRelationHistoryRevision] = useState(0);
  const [relationMutatingChildIds, setRelationMutatingChildIds] = useState<string[]>([]);
  useEffect(() => { progressFoldersRef.current = progressFolders; }, [progressFolders]);
  const cancelRelationEdit = useCallback(() => {
    setDraggingChildId('');
    setHoverParentId('');
    setPendingRelationChange(null);
  }, []);
  const dismissTrackingTaskForSession = (sessionId: string) => {
    const task = backgroundTasks.find(item => item.type === 'version-tracking' && item.metadata?.sessionId === sessionId);
    if (task) void dismissBackgroundTask(task.id);
  };
  const progressRelationInspection = useMemo(() => inspectProgressRelations(progressFolders), [progressFolders]);
  const orphanedProgressFolders = useMemo(() => progressFolders.filter(folder => folder.nodeRole === 'progress'
    && !folder.parentProgressId && !folder.folderMissing), [progressFolders]);
  const progressRelationNoticeRef = useRef('');
  const orphanedProgressNoticeRef = useRef('');
  useEffect(() => {
    const signature = progressRelationInspection.cycleNodeIds.slice().sort().join(',');
    if (!signature) {
      progressRelationNoticeRef.current = '';
      return;
    }
    if (progressRelationNoticeRef.current === signature) return;
    progressRelationNoticeRef.current = signature;
    console.error('Version relation cycle detected', { projectName: project.name, nodeIds: progressRelationInspection.cycleNodeIds });
    onNotice(`版本关系需要修复：检测到循环节点 ${progressRelationInspection.cycleNodeIds.join('、')}`, 10000);
  }, [onNotice, progressRelationInspection, project.name]);
  useEffect(() => {
    const signature = orphanedProgressFolders.map(folder => folder.id).sort().join(',');
    if (!signature) { orphanedProgressNoticeRef.current = ''; return; }
    if (orphanedProgressNoticeRef.current === signature) return;
    orphanedProgressNoticeRef.current = signature;
    onNotice(`检测到 ${orphanedProgressFolders.length} 个旧版游离进度；已保留数据且不会自动删除。请修改进度并选择有效父版本，或显式取消版本登记。`, 12000);
  }, [onNotice, orphanedProgressFolders]);
  const [fileEntries, setFileEntries] = useState<ProjectFileEntry[]>([]);
  const fileEntriesRef = useRef(fileEntries);
  fileEntriesRef.current = fileEntries;
  const [pendingFileOperations, setPendingFileOperations] = useState<PendingFileOperation[]>([]);
  const pendingFileOperationsRef = useRef(pendingFileOperations);
  pendingFileOperationsRef.current = pendingFileOperations;
  const pendingFileOperationSequenceRef = useRef(0);
  const renderedDirectoryRef = useRef({ path: normalizeProjectRelativePath(initialRelativePath), ready: false });
  const [directoryLoading, setDirectoryLoading] = useState(active);
  const [foregroundDirectoryReady, setForegroundDirectoryReady] = useState(false);
  const [currentDirectoryViaExternalLink, setCurrentDirectoryViaExternalLink] = useState(false);
  const [currentExternalLinkRootPath, setCurrentExternalLinkRootPath] = useState('');
  const [hasExternalFolderLinks, setHasExternalFolderLinks] = useState(false);
  const [virtualWindow, setVirtualWindow] = useState({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 });
  const virtualWindowRef = useRef(virtualWindow);
  virtualWindowRef.current = virtualWindow;
  const [currentRelativePath, setCurrentRelativePath] = useState(initialRelativePath);
  const [directoryHistory, setDirectoryHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const [browseMode, setBrowseMode] = useState<ProjectBrowseMode>('grid');
  const browseModeRef = useRef(browseMode);
  browseModeRef.current = browseMode;
  const viewMode: 'list' | 'grid' = browseMode === 'list' ? 'list' : 'grid';
  const recursiveFlatOpen = browseMode === 'recent';
  const versionTreeOpen = browseMode === 'version-tree';
  const [versionTreeHeaderCollapsed, setVersionTreeHeaderCollapsed] = useState(false);
  const [gridIconSize, setGridIconSize] = useState(DEFAULT_FOLDER_GRID_ICON_SIZE);
  const initialGridThumbnailSize = DEFAULT_FOLDER_GRID_ICON_SIZE * Math.min(2, window.devicePixelRatio || 1) <= 320 ? 320 : 640;
  const [gridThumbnailSize, setGridThumbnailSize] = useState(initialGridThumbnailSize);
  useEffect(() => {
    const physicalSize = gridIconSize * Math.min(2, window.devicePixelRatio || 1);
    const desiredSize = physicalSize <= 320 ? 320 : physicalSize <= 640 ? 640 : 1600;
    if (desiredSize <= gridThumbnailSize) return;
    const timer = window.setTimeout(() => setGridThumbnailSize(current => Math.max(current, desiredSize)), 320);
    return () => window.clearTimeout(timer);
  }, [gridIconSize, gridThumbnailSize]);
  useEffect(() => {
    setVersionTreeHeaderCollapsed(false);
  }, [currentRelativePath, versionTreeOpen]);
  const [sortField, setSortField] = useState<ProjectFileSortField>(defaultFolderSort);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(defaultProjectFileSortDirection(defaultFolderSort));
  useEffect(() => {
    setSortField(defaultFolderSort);
    setSortDirection(defaultProjectFileSortDirection(defaultFolderSort));
  }, [defaultFolderSort]);
  const selectSortField = (field: ProjectFileSortField) => {
    if (field !== sortField) setSortDirection(defaultProjectFileSortDirection(field));
    setSortField(field);
  };
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [fileFilter, setFileFilter] = useState<ProjectFileFilter>('all');
  const [folderAlphabetFilter, setFolderAlphabetFilter] = useState('');
  const [filterScope, setFilterScope] = useState<ProjectFilterScope>('current-folder');
  const projectRootScopeSelected = filterScope === 'project-root';
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [ratingFilter, setRatingFilter] = useState<ProjectRatingFilter>('all');
  const [filterRatings, setFilterRatings] = useState<Record<string, number>>({});
  const [filterRatingsLoading, setFilterRatingsLoading] = useState(false);
  const [filterRatingsCheckedCount, setFilterRatingsCheckedCount] = useState(0);
  const filterRatingSequenceRef = useRef(0);
  useEffect(() => {
    if (favoriteDisplayMode !== 'stars' && ratingFilter !== 'all' && ratingFilter !== 'rated') setRatingFilter('rated');
  }, [favoriteDisplayMode, ratingFilter]);
  const [searchEntries, setSearchEntries] = useState<ProjectFileEntry[]>([]);
  const searchEntriesRef = useRef<ProjectFileEntry[]>([]);
  searchEntriesRef.current = searchEntries;
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [recentCursor, setRecentCursor] = useState('');
  const recentCursorRef = useRef('');
  const [recentHasMore, setRecentHasMore] = useState(false);
  const [recentLoadingMore, setRecentLoadingMore] = useState(false);
  const [recentLoadError, setRecentLoadError] = useState('');
  const [recentRefreshToken, setRecentRefreshToken] = useState(0);
  const [scopeEntries, setScopeEntries] = useState<ProjectFileEntry[]>([]);
  const scopeEntriesRef = useRef<ProjectFileEntry[]>([]);
  scopeEntriesRef.current = scopeEntries;
  const [scopeCursor, setScopeCursor] = useState('');
  const [scopeHasMore, setScopeHasMore] = useState(false);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeLoadingMore, setScopeLoadingMore] = useState(false);
  const [scopeError, setScopeError] = useState('');
  const [scopeRefreshToken, setScopeRefreshToken] = useState(0);
  const [rootWatchFailed, setRootWatchFailed] = useState(false);
  const [externalWatchRevision, setExternalWatchRevision] = useState(0);
  useEffect(() => {
    if (searchQuery && !searchOpen) setSearchOpen(true);
  }, [searchQuery, searchOpen]);
  const projectWorkspaceRef = useRef<HTMLDivElement>(null);
  const projectColumnLayoutRef = useRef<HTMLDivElement>(null);
  const filesColumnRef = useRef<HTMLDivElement>(null);
  const filesSurfaceRef = useRef<HTMLDivElement>(null);
  const fileRevealFrameRef = useRef(0);
  const fileRevealPathRef = useRef('');
  const pendingDirectoryReturnRevealRef = useRef<{ directoryPath: string; entryPath: string } | null>(null);
  const didInitializePathRefreshRef = useRef(false);
  const wasActiveRef = useRef(active);
  const activeRef = useRef(active);
  activeRef.current = active;
  const skipNextPathRefreshRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const currentRelativePathRef = useRef('');
  const onDirectoryChangeRef = useRef(onDirectoryChange);
  onDirectoryChangeRef.current = onDirectoryChange;
  const projectPathRef = useRef(project.path);
  projectPathRef.current = project.path;
  const projectLifecycleRef = useRef<ProjectWorkspaceLifecycleIdentity>();
  const automaticProgressLoadKeyRef = useRef('');
  const progressFoldersRequestRef = useRef<Promise<ProgressFolder[]> | null>(null);
  const watchReconcileStateRef = useRef({ identity: '', externalWatchRevision: -1, lastReconciledAt: 0 });
  const directoryEntriesCacheRef = useRef(new Map<string, ProjectFileEntry[]>());
  const optimisticDirectoryEntriesCacheRef = useRef(new Map<string, ProjectFileEntry[]>());
  const directoryPrefetchesRef = useRef(new Map<string, Promise<DirectoryPreviewLoadResult>>());
  const directoryPreviewRequestTokensRef = useRef(new Map<string, symbol>());
  const shortcutPreviewStatesRef = useRef(new Map<string, Pick<ProjectFileEntry, 'shortcutTargetKind' | 'shortcutBroken'>>());
  const previewRatingCacheRef = useRef(new Map<string, number>());
  const previewRatingRequestsRef = useRef(new Map<string, ReturnType<typeof projectWorkspaceClient.getMediaRating>>());
  const boundWorkspaceCaches = () => {
    const trim = <K, V>(cache: Map<K, V>, limit: number) => {
      while (cache.size > limit) cache.delete(cache.keys().next().value as K);
    };
    trim(directoryEntriesCacheRef.current, 192);
    trim(optimisticDirectoryEntriesCacheRef.current, 96);
    trim(directoryPrefetchesRef.current, 96);
    trim(shortcutPreviewStatesRef.current, 512);
    trim(previewRatingCacheRef.current, 400);
    trim(previewRatingRequestsRef.current, 200);
  };
  useEffect(boundWorkspaceCaches);
  const selectionDragRef = useRef<{
    pointerId: number;
    pointerStartX: number;
    pointerStartY: number;
    startContentX: number;
    startContentY: number;
    lastClientX: number;
    lastClientY: number;
    initialPaths: string[];
    additive: boolean;
    started: boolean;
  } | null>(null);
  const marqueeLayoutRegistryRef = useRef(new Map<string, MarqueeRect>());
  const selectionAutoScrollFrameRef = useRef(0);
  const directoryRefreshTimerRef = useRef(0);
  const pendingDirectoryRefreshesRef = useRef(new Set<string>());
  useEffect(() => () => {
    window.clearTimeout(directoryRefreshTimerRef.current);
    directoryRefreshTimerRef.current = 0;
    pendingDirectoryRefreshesRef.current.clear();
    recursiveDirectoryRefreshSequenceRef.current.clear();
  }, [project.path]);
  const internalDragPathsRef = useRef<string[]>([]);
  const internalDropHandledRef = useRef(false);
  const nativeFileDragSessionRef = useRef<{ id: string; origin: 'file-browser' | 'version-tree'; paths: string[]; folderTabSource: boolean } | null>(null);
  const projectFileDragEndHandlerRef = useRef<(result: ProjectFileDragEndResult) => void>(() => undefined);
  const nativeFileDragOwnerIdentityRef = useRef(nativeFileDragOwnerIdentity(pageId, project.path));
  const suppressDraggedEntryClickRef = useRef<{ path: string; sessionId: string } | null>(null);
  const renameCommitRef = useRef(false);
  const selectionResetKey = `${active}|${fileFilter}|${ratingFilter}|${filterScope}|${searchQuery}`;
  const { anchorPathRef: selectionAnchorPathRef, selectedPaths, setSelectedPaths, selectRange: selectProjectFileRange, toggle: toggleProjectFileSelection } = useProjectFileSelection(selectionResetKey);
  const entryPointerModifiersRef = useRef<{ path: string; additive: boolean; range: boolean; pointerType: 'mouse' | 'pen' | 'touch' } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchSequenceRef = useRef(0);
  const searchRequestIdentityRef = useRef('');
  const recentLoadInFlightRef = useRef(false);
  const scopeCursorRef = useRef('');
  const scopeLoadInFlightRef = useRef(false);
  const scopeRequestSequenceRef = useRef(0);
  const scopeRequestIdentityRef = useRef('');
  const recursiveDirectoryRefreshSequenceRef = useRef(new Map<string, number>());
  const recursiveGroupOrderRef = useRef<{ identity: string; paths: string[] }>({ identity: '', paths: [] });
  const clipboardOperationSequenceRef = useRef(0);
  const ratingMutationSequenceRef = useRef(0);
  const previewRatingIdentityRef = useRef('');
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const [dragTargetPath, setDragTargetPath] = useState('');
  const [recursiveDropTargetPath, setRecursiveDropTargetPath] = useState<string | null>(null);
  const [surfaceDropActive, setSurfaceDropActive] = useState(false);
  const [operationDirectoryPath, setOperationDirectoryPath] = useState('');
  const [previewPath, setPreviewPath] = useState('');
  const [previewHighlightPath, setPreviewHighlightPath] = useState('');
  const [previewMediaPath, setPreviewMediaPath] = useState('');
  const [postTrimPreviewEntry, setPostTrimPreviewEntry] = useState<ProjectFileEntry>();
  useEffect(() => {
    if (!previewPath) setPreviewMediaPath('');
  }, [previewPath]);
  const [previewTechnicalMetadata, setPreviewTechnicalMetadata] = useState<PreviewTechnicalMetadata>({});
  const [previewMetadataFields, setPreviewMetadataFields] = useState<MediaMetadataField[]>([]);
  const [previewMetadataResolvedPath, setPreviewMetadataResolvedPath] = useState('');
  const [previewMetadataLoading, setPreviewMetadataLoading] = useState(false);
  const [previewMetadataError, setPreviewMetadataError] = useState('');
  const [previewEntryDetails, setPreviewEntryDetails] = useState<ProjectEntryDetails | null>(null);
  const [selectionEntryDetails, setSelectionEntryDetails] = useState<Record<string, SelectionEntryDetails>>({});
  const [selectionEntryDetailsLoading, setSelectionEntryDetailsLoading] = useState(false);
  const [viewportCurrentPath, setViewportCurrentPath] = useState('');
  const [viewportStatus, setViewportStatus] = useState<{ path: string; fileNumber: number; total: number; captureDateTime?: string } | null>(null);
  const previewPanePinnedStorageKey = `photoflow:${browserContext.kind}:preview-pane-pinned`;
  const metadataPanePinnedStorageKey = `photoflow:${browserContext.kind}:metadata-pane-pinned`;
  const previewPaneSuppressedStorageKey = `photoflow:${browserContext.kind}:preview-pane-auto-open-suppressed`;
  const metadataPaneSuppressedStorageKey = `photoflow:${browserContext.kind}:metadata-pane-auto-open-suppressed`;
  const [previewPanePinned, setPreviewPanePinned] = useState(() => readStoredBoolean(previewPanePinnedStorageKey, true));
  const [metadataPanePinned, setMetadataPanePinned] = useState(() => readStoredBoolean(metadataPanePinnedStorageKey, true));
  const [previewPaneAutoOpenSuppressed, setPreviewPaneAutoOpenSuppressed] = useState(() => readStoredBoolean(previewPaneSuppressedStorageKey, false));
  const [metadataPaneAutoOpenSuppressed, setMetadataPaneAutoOpenSuppressed] = useState(() => readStoredBoolean(metadataPaneSuppressedStorageKey, false));
  const [previewPaneOpen, setPreviewPaneOpen] = useState(() => readStoredBoolean(previewPanePinnedStorageKey, true));
  const fileRevealRequestIdRef = useRef(0);
  const [pendingFileReveal, setPendingFileReveal] = useState<{ path: string; requestId: number; align: 'nearest' | 'center' } | null>(null);
  const [directoryReturnHighlightPath, setDirectoryReturnHighlightPath] = useState('');
  const toggleSelected = (relativePath: string) => {
    toggleProjectFileSelection(relativePath);
  };
  const [pendingMutationSelection, setPendingMutationSelection] = useState<{ path: string; align: 'nearest' | 'center'; directoryPath: string; projectPath: string } | null>(null);
  const previousPaneLayoutRef = useRef('');
  const paneLayoutRevealPendingRef = useRef(false);
  const paneLayoutRevealPathRef = useRef('');
  const previewPanePinnedRef = useRef(previewPanePinned);
  const metadataPanePinnedRef = useRef(metadataPanePinned);
  previewPanePinnedRef.current = previewPanePinned;
  metadataPanePinnedRef.current = metadataPanePinned;
  const [metadataPaneOpen, setMetadataPaneOpen] = useState(() => readStoredBoolean(metadataPanePinnedStorageKey, true));
  useEffect(() => {
    try { window.localStorage.setItem(previewPanePinnedStorageKey, String(previewPanePinned)); } catch { /* Ignore unavailable storage. */ }
  }, [previewPanePinned, previewPanePinnedStorageKey]);
  useEffect(() => {
    try { window.localStorage.setItem(metadataPanePinnedStorageKey, String(metadataPanePinned)); } catch { /* Ignore unavailable storage. */ }
  }, [metadataPanePinned, metadataPanePinnedStorageKey]);
  useEffect(() => {
    try { window.localStorage.setItem(previewPaneSuppressedStorageKey, String(previewPaneAutoOpenSuppressed)); } catch { /* Ignore unavailable storage. */ }
  }, [previewPaneAutoOpenSuppressed, previewPaneSuppressedStorageKey]);
  useEffect(() => {
    try { window.localStorage.setItem(metadataPaneSuppressedStorageKey, String(metadataPaneAutoOpenSuppressed)); } catch { /* Ignore unavailable storage. */ }
  }, [metadataPaneAutoOpenSuppressed, metadataPaneSuppressedStorageKey]);
  const [columnWidths, setColumnWidths] = useState(() => ({
    files: readStoredNumber('photoflow:files-column-width', 560),
    preview: readStoredNumber('photoflow:preview-column-width', 340),
    metadata: readStoredNumber('photoflow:metadata-column-width', 320)
  }));
  const [fileListColumnWidths, setFileListColumnWidths] = useState<FileListColumnWidths>(() => Object.fromEntries(FILE_LIST_COLUMN_KEYS.map(key => [
    key,
    readStoredNumber(FILE_LIST_COLUMN_STORAGE_KEYS[key], DEFAULT_FILE_LIST_COLUMN_WIDTHS[key]),
  ])) as FileListColumnWidths);
  const [fileListColumnsCustomized, setFileListColumnsCustomized] = useState(() => readStoredBoolean(FILE_LIST_COLUMNS_CUSTOMIZED_STORAGE_KEY, false));
  const [projectLayoutWidth, setProjectLayoutWidth] = useState(0);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [selectionCanvasSize, setSelectionCanvasSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const cancelSelectionDrag = () => {
      window.cancelAnimationFrame(selectionAutoScrollFrameRef.current);
      selectionAutoScrollFrameRef.current = 0;
      selectionDragRef.current = null;
      setSelectionBox(null);
    };
    window.addEventListener('pointerup', cancelSelectionDrag);
    window.addEventListener('pointercancel', cancelSelectionDrag);
    window.addEventListener('blur', cancelSelectionDrag);
    return () => {
      window.cancelAnimationFrame(selectionAutoScrollFrameRef.current);
      window.removeEventListener('pointerup', cancelSelectionDrag);
      window.removeEventListener('pointercancel', cancelSelectionDrag);
      window.removeEventListener('blur', cancelSelectionDrag);
    };
  }, []);
  const [inlineRenamePath, setInlineRenamePath] = useState('');
  const [inlineRenameValue, setInlineRenameValue] = useState('');
  const [batchRenameOpen, setBatchRenameOpen] = useState(false);
  const [batchRenameParts, setBatchRenameParts] = useState<BatchRenamePart[]>([]);
  const [batchExtensionMode, setBatchExtensionMode] = useState<'preserve' | 'replace'>('preserve');
  const [batchExtensionValue, setBatchExtensionValue] = useState('');
  const [draggedBatchRenamePartId, setDraggedBatchRenamePartId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [panel, setPanel] = useState<ProjectPanel>(initialPanel);
  const [mountedPanels, setMountedPanels] = useState<Set<MountedProjectPanel>>(() => new Set(initialPanel ? [initialPanel] : []));
  const [negativeSourcePaths, setNegativeSourcePaths] = useState<string[]>([]);
  const [brollSourcePaths, setBrollSourcePaths] = useState<string[]>([]);
  const [deleteBrollSources, setDeleteBrollSources] = useState(importDefaults.deleteSourceAfterImport);
  const [deleteFileSources, setDeleteFileSources] = useState(importDefaults.deleteSourceAfterImport);
  const [linkBrollSources, setLinkBrollSources] = useState(false);
  const [linkFileSources, setLinkFileSources] = useState(false);
  const [fileImportTarget, setFileImportTarget] = useState('');
  const [fileImportSourcePaths, setFileImportSourcePaths] = useState<string[]>([]);
  const [panelImportBusy, setPanelImportBusy] = useState<'broll' | 'files' | ''>('');
  const [panelImportResult, setPanelImportResult] = useState<{ kind: 'broll' | 'files'; count: number; sourceDeleted: boolean } | null>(null);
  const [sdImportBusy, setSdImportBusy] = useState(false);
  const [negativeImportBusy, setNegativeImportBusy] = useState(false);
  const [researchTargetPath, setResearchTargetPath] = useState('');
  const [researchTargetPaths, setResearchTargetPaths] = useState<string[]>([]);
  const [researchCollecting, setResearchCollecting] = useState(false);
  const [researchTargetHasTxt, setResearchTargetHasTxt] = useState(false);
  const [officeExtractEntries, setOfficeExtractEntries] = useState<ProjectFileEntry[]>([]);
  const [officeExtractBusy, setOfficeExtractBusy] = useState(false);
  const [officeExtractResult, setOfficeExtractResult] = useState<OfficeExtractionPresentation | null>(null);
  const [officeExtractError, setOfficeExtractError] = useState('');
  const researchInspectionSequenceRef = useRef(0);
  useEffect(() => {
    if (!panel) return;
    setMountedPanels(current => {
      if (current.has(panel)) return current;
      const next = new Set(current);
      next.add(panel);
      return next;
    });
  }, [panel]);
  const projectPanelTaskKey = useCallback((kind: MountedProjectPanel) => panelTaskSessionKey(pageId, kind), [pageId]);
  const projectPanelTask = useCallback((kind: MountedProjectPanel) => panelTasks[projectPanelTaskKey(kind)], [panelTasks, projectPanelTaskKey]);
  const projectPanelIsRunning = useCallback((kind: MountedProjectPanel) => projectPanelTask(kind)?.state === 'running' || backgroundTasks.some(task => (
    ['queued', 'running', 'pausing', 'paused', 'resuming'].includes(task.state)
    && task.metadata?.presentationOwnerPageId === pageId
    && task.metadata?.presentationPanelKind === kind
  )), [backgroundTasks, pageId, projectPanelTask]);
  useEffect(() => {
    const restorePanelTask = (event: Event) => {
      const detail = (event as CustomEvent<PanelTaskRestoreDetail>).detail;
      if (!isPanelTaskRestoreForPage(pageId, detail) || !detail.panelKind || !(detail.panelKind in PROJECT_PANEL_TITLES)) return;
      setPanel(detail.panelKind as MountedProjectPanel);
    };
    window.addEventListener('photoflow:restore-panel-task', restorePanelTask);
    return () => window.removeEventListener('photoflow:restore-panel-task', restorePanelTask);
  }, [pageId]);
  const [inspirationProjects, setInspirationProjects] = useState<WorkspaceProject[]>([]);
  const [inspirationTargetProject, setInspirationTargetProject] = useState<WorkspaceProject | null>(null);
  const [gatherPickerPaths, setGatherPickerPaths] = useState<string[] | null>(null);
  const [gatheringInspiration, setGatheringInspiration] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [shellNewTypes, setShellNewTypes] = useState<ShellNewFileType[]>([]);
  const [shellNewTypesLoaded, setShellNewTypesLoaded] = useState(false);
  const [shellNewTypesLoading, setShellNewTypesLoading] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [showVideoToolsMenu, setShowVideoToolsMenu] = useState(false);
  const [showImageToolsMenu, setShowImageToolsMenu] = useState(false);
  const [showToolbarOverflowMenu, setShowToolbarOverflowMenu] = useState(false);
  const [progressSetup, setProgressSetup] = useState<ProgressSetupDraft | null>(null);
  const [folderMarkSetup, setFolderMarkSetup] = useState<FolderMarkDraft | null>(null);
  const [progressImportStep, setProgressImportStep] = useState<'source' | 'settings'>('source');
  const [pendingProgressFolders, setPendingProgressFolders] = useState<Array<{ relativePath: string; name: string; mediaKind: 'image' | 'video' }>>([]);
  const [progressImportCompletion, setProgressImportCompletion] = useState('');
  const [progressCompare, setProgressCompare] = useState<ProgressCompareConfirmation | null>(null);
  const [trackingConfirmationSessionId, setTrackingConfirmationSessionId] = useState('');
  const [trackingConfirmationProgressId, setTrackingConfirmationProgressId] = useState('');
  const [progressCompareFilter, setProgressCompareFilter] = useState<ProgressCompareFilter>('recognized');
  const [activeProgressCompareItemKey, setActiveProgressCompareItemKey] = useState('');
  const [workspaceActivityMessage, setWorkspaceActivityMessage] = useState('');
  const workspaceActivityRef = useRef<ToastActivityHandle | null>(null);
  useEffect(() => {
    if (!workspaceActivityMessage) { workspaceActivityRef.current?.dismiss(); workspaceActivityRef.current = null; return; }
    if (workspaceActivityRef.current) workspaceActivityRef.current.update(workspaceActivityMessage);
    else workspaceActivityRef.current = toast.activity(workspaceActivityMessage, { dedupeKey: `workspace-activity:${pageId}` });
  }, [pageId, toast, workspaceActivityMessage]);
  useEffect(() => () => workspaceActivityRef.current?.dismiss(), []);
  const [progressSubmitting, setProgressSubmitting] = useState(false);
  const [progressImportStatus, setProgressImportStatus] = useState<ProjectFileOperationProgress | null>(null);
  const progressSubmittingRef = useRef(false);
  const progressImportOperationIdRef = useRef('');
  const progressMutationStatus = useMemo(() => versionTreeTaskPanelProgress(
    backgroundTasks,
    project.name,
    progressSetup?.mode === 'mark' ? progressSetup.existingProgressId || '' : '',
  ), [backgroundTasks, progressSetup?.existingProgressId, progressSetup?.mode, project.name]);
  const [progressRepair, setProgressRepair] = useState<{ progressFolder: ProgressFolder; batchId: string; operations: VersionBatchFileOperation[] } | null>(null);
  const [progressRepairBusy, setProgressRepairBusy] = useState(false);
  const closeProgressSetup = useCallback(() => {
    setProgressImportCompletion('');
    setProgressImportStep('source');
    setProgressSetup(null);
  }, []);
  useEscapeLayer(active && Boolean(progressCompare), () => { void closeProgressCompare(); }, !progressSubmitting, true);
  useEscapeLayer(active && Boolean(progressRepair), () => setProgressRepair(null), !progressRepairBusy, true);
  useEscapeLayer(active && Boolean(pendingProgressFolders.length) && !progressSetup && !folderMarkSetup, () => setPendingProgressFolders([]), true, true);
  useEscapeLayer(active && Boolean(draggingChildId || pendingRelationChange), cancelRelationEdit, true, true);
  useEscapeLayer(active && batchRenameOpen, () => { if (!renameCommitRef.current) setBatchRenameOpen(false); }, true, true);
  useEscapeLayer(active && confirmDelete, () => setConfirmDelete(false), true, true);
  useEscapeLayer(Boolean(gatherPickerPaths), () => setGatherPickerPaths(null), !gatheringInspiration, true);
  const [fileMenu, setFileMenu] = useState<{ entry: ProjectFileEntry; x: number; y: number } | null>(null);
  const fileMenuSelectionSnapshotRef = useRef<string[]>([]);
  const fileMenuSelectionAnchorSnapshotRef = useRef('');
  const fileMenuSelectionWasImplicitRef = useRef(false);
  const [surfaceMenu, setSurfaceMenu] = useState<{ x: number; y: number; targetRelativePath: string; targetLabel: string; kind: 'files' | 'version-tree-layout' } | null>(null);
  const versionTreeCanvasControllerRef = useRef<VersionTreeCanvasController | null>(null);
  const setVersionTreeCanvasController = useCallback((controller: VersionTreeCanvasController | null) => {
    versionTreeCanvasControllerRef.current = controller;
  }, []);
  const [clipboardHasFiles, setClipboardHasFiles] = useState(false);
  const [clipboardPending, setClipboardPending] = useState(false);
  const [photoshopAvailable, setPhotoshopAvailable] = useState(false);
  const [conversionTargets, setConversionTargets] = useState<string[]>([]);
  const [conversionCollecting, setConversionCollecting] = useState(false);
  const conversionInspectionSequenceRef = useRef(0);
  const [screenshotMainImageTargets, setScreenshotMainImageTargets] = useState<string[]>([]);
  const [screenshotMainImageMode, setScreenshotMainImageMode] = useState<'extract' | 'crop'>('extract');
  const [versionEntry, setVersionEntry] = useState<ProjectFileEntry | null>(null);
  const [versionProgressId, setVersionProgressId] = useState('');
  const versionProgressLocationRef = useRef<(ProgressFolderEntryLocation & { progressId: string }) | null>(null);
  const [, setFinalVersionSummary] = useState({ count: 0, availableCount: 0, missingCount: 0 });
  const [finalExporting, setFinalExporting] = useState(false);
  const [finalExportParentId, setFinalExportParentId] = useState('');
  const [finalViewOpen, setFinalViewOpen] = useState(false);
  const currentFolderRecursiveSearchActive = Boolean(searchQuery.trim()) && filterScope === 'current-folder' && !versionTreeOpen && !finalViewOpen;
  const [, setFinalViewLoading] = useState(false);
  const [finalViewEntries, setFinalViewEntries] = useState<ProjectFileEntry[]>([]);
  const [previewRating, setPreviewRating] = useState(0);
  const [previewRatingLoading, setPreviewRatingLoading] = useState(false);
  const [previewRatingBusy, setPreviewRatingBusy] = useState(false);
  const [drives, setDrives] = useState<string[]>([]);
  const requestFileReveal = useCallback((path: string, align: 'nearest' | 'center' = 'nearest') => {
    fileRevealRequestIdRef.current += 1;
    setPendingFileReveal({ path, requestId: fileRevealRequestIdRef.current, align });
  }, []);
  const selectAndRevealFileEntry = (relativePath: string, align: 'nearest' | 'center' = 'nearest') => {
    const normalizedPath = normalizeProjectRelativePath(relativePath);
    if (!normalizedPath) return;
    setFolderAlphabetFilter('');
    if (mutatedEntryFiltersNeedReset({ searchQuery, fileFilter, ratingFilter, filterScope })) {
      setPendingMutationSelection({
        path: normalizedPath,
        align,
        directoryPath: normalizeProjectRelativePath(currentRelativePathRef.current),
        projectPath: projectPathRef.current,
      });
      setSearchQuery('');
      setFileFilter('all');
      setRatingFilter('all');
      setFilterScope('current-folder');
      return;
    }
    setPendingMutationSelection(null);
    selectionAnchorPathRef.current = normalizedPath;
    setSelectedPaths([normalizedPath]);
    requestFileReveal(normalizedPath, align);
  };
  useEffect(() => {
    if (!pendingMutationSelection) return;
    if (!mutatedEntryCanBeRevealed({
      requestedProjectPath: pendingMutationSelection.projectPath,
      currentProjectPath: projectPathRef.current,
      mutationDirectoryPath: pendingMutationSelection.directoryPath,
      currentDirectoryPath: currentRelativePathRef.current,
      browseMode,
    })) {
      setPendingMutationSelection(null);
      return;
    }
    if (mutatedEntryFiltersNeedReset({ searchQuery, fileFilter, ratingFilter, filterScope })) return;
    setPendingMutationSelection(null);
    selectionAnchorPathRef.current = pendingMutationSelection.path;
    setSelectedPaths([pendingMutationSelection.path]);
    requestFileReveal(pendingMutationSelection.path, pendingMutationSelection.align);
  }, [browseMode, currentRelativePath, fileFilter, filterScope, pendingMutationSelection, project.path, ratingFilter, requestFileReveal, searchQuery]);
  useEffect(() => {
    void projectWorkspaceClient.getPhotoshopStatus().then(result => setPhotoshopAvailable(result.available));
  }, []);
  useEffect(() => projectWorkspaceClient.onProjectFileOperationProgress(progress => {
    if (progress.operation !== 'import-progress') return;
    if (progress.projectName && progress.projectName !== project.name) return;
    setProgressImportStatus(current => ({
      ...progress,
      progress: progress.phase === 'failed' || progress.phase === 'cancelled'
        ? progress.progress
        : Math.max(current?.operationId === progress.operationId ? current.progress : 0, progress.progress),
    }));
    if (progress.phase === 'complete' || progress.phase === 'cancelled' || progress.phase === 'failed') {
      if (progressImportOperationIdRef.current === progress.operationId) progressImportOperationIdRef.current = '';
      return;
    }
    progressImportOperationIdRef.current = progress.operationId;
  }), [project.name]);
  const inspirationMode = browserContext.kind === 'inspiration';
  const { projectWorkflows, gatherToProject, watchRootDirectly, rootRelativeFileEvents, previewOnlyOnMediaClick } = browserContext.capabilities;
  useEffect(() => {
    if (!projectWorkflows) { setPendingProgressFolders([]); return; }
    const storageKey = `photoflow:imported-project-tracking:${project.path}`;
    try {
      const candidates = JSON.parse(window.localStorage.getItem(storageKey) || '[]') as Array<{ relativePath?: string; name?: string; mediaKind?: 'image' | 'video' }>;
      window.localStorage.removeItem(storageKey);
      const folders = candidates.flatMap(candidate => candidate.relativePath && candidate.name
        ? [{ relativePath: normalizeProjectRelativePath(candidate.relativePath), name: candidate.name, mediaKind: candidate.mediaKind === 'video' ? 'video' as const : 'image' as const }]
        : []);
      setPendingProgressFolders(folders);
    } catch {
      try { window.localStorage.removeItem(storageKey); } catch { /* unavailable storage */ }
      setPendingProgressFolders([]);
    }
  }, [project.path, projectWorkflows]);
  const officeImageExtractorAvailable = true;
  const folderBrowseModeStorageKey = `photoflow:folder-browse-modes:${browserContext.kind}:${workspacePath}|${project.name}`;
  const folderGridIconSizeStorageKey = `photoflow:folder-grid-icon-sizes:${browserContext.kind}:${workspacePath}|${project.name}`;
  const readFolderBrowseModes = (): Record<string, ProjectBrowseMode> => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(folderBrowseModeStorageKey) || '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ProjectBrowseMode] => isProjectBrowseMode(entry[1])));
    } catch {
      return {};
    }
  };
  const storedFolderBrowseMode = (relativePath: string) => readFolderBrowseModes()[normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN')];
  const rememberFolderBrowseMode = (relativePath: string, mode: ProjectBrowseMode) => {
    const normalizedPath = normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN');
    try {
      window.localStorage.setItem(folderBrowseModeStorageKey, JSON.stringify({ ...readFolderBrowseModes(), [normalizedPath]: mode }));
    } catch { /* storage unavailable */ }
  };
  const readFolderGridIconSizes = (): Record<string, number> => {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(folderGridIconSizeStorageKey) || '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).flatMap(([path, value]) => Number.isFinite(Number(value))
        ? [[path, normalizeFolderGridIconSize(value)] as [string, number]]
        : []));
    } catch {
      return {};
    }
  };
  const gridIconSizeForFolder = (relativePath: string) => readFolderGridIconSizes()[normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN')] ?? DEFAULT_FOLDER_GRID_ICON_SIZE;
  const rememberFolderGridIconSize = (relativePath: string, size: number) => {
    const normalizedPath = normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN');
    const normalizedSize = normalizeFolderGridIconSize(size);
    try {
      window.sessionStorage.setItem(folderGridIconSizeStorageKey, JSON.stringify({ ...readFolderGridIconSizes(), [normalizedPath]: normalizedSize }));
    } catch { /* storage unavailable */ }
    return normalizedSize;
  };
  const selectFolderGridIconSize = (size: number) => setGridIconSize(rememberFolderGridIconSize(currentRelativePath, size));
  const progressFolderParentPath = (folder: ProgressFolder) => {
    if (folder.externalLinkRelativePath) {
      return normalizeProjectRelativePath(folder.externalLinkRelativePath).split('/').slice(0, -1).join('/').toLocaleLowerCase('zh-CN');
    }
    const normalizedRoot = project.path.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedFolder = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '');
    const relativePath = normalizedFolder.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)
      ? normalizedFolder.slice(normalizedRoot.length + 1)
      : normalizedFolder.split('/').pop() || '';
    return normalizeProjectRelativePath(relativePath).split('/').slice(0, -1).join('/').toLocaleLowerCase('zh-CN');
  };
  const progressFolderRelativePath = (folder: ProgressFolder) => normalizeProjectRelativePath(
    folder.externalLinkRelativePath || projectRelativePath(folder.folderPath),
  );
  const hasVersionTreeFor = (foldersToCheck = progressFolders, relativePath = currentRelativePath) => {
    const scopePath = normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN');
    return projectWorkflows && foldersToCheck.some(folder => !folder.folderMissing && progressFolderParentPath(folder) === scopePath);
  };
  const versionTreeModeAvailableFor = (foldersToCheck = progressFolders, relativePath = currentRelativePath) => {
    const scopePath = normalizeProjectRelativePath(relativePath);
    return versionTreeEnabled && projectWorkflows && (!scopePath || hasVersionTreeFor(foldersToCheck, scopePath));
  };
  const browseModeForFolder = (relativePath: string, foldersToCheck = progressFolders): ProjectBrowseMode => {
    const normalizedPath = normalizeProjectRelativePath(relativePath);
    const remembered = storedFolderBrowseMode(normalizedPath);
    if (remembered === 'version-tree' && !versionTreeModeAvailableFor(foldersToCheck, normalizedPath)) return 'grid';
    if (remembered) return remembered;
    return versionTreeEnabled && hasVersionTreeFor(foldersToCheck, normalizedPath) ? 'version-tree' : 'grid';
  };
  const selectFolderBrowseMode = (mode: ProjectBrowseMode) => {
    if (mode === 'version-tree' && !versionTreeModeAvailableFor()) return;
    rememberFolderBrowseMode(currentRelativePath, mode);
    setBrowseMode(mode);
  };
  const projectVersionTreeAvailable = versionTreeModeAvailableFor();
  useEffect(() => {
    if (versionTreeEnabled || browseMode !== 'version-tree') return;
    setBrowseMode('grid');
  }, [browseMode, versionTreeEnabled]);
  useEffect(() => {
    if (!gatherToProject || !inspirationTargetWorkspacePath?.trim()) {
      setInspirationProjects([]);
      setInspirationTargetProject(null);
      return;
    }
    let disposed = false;
    const loadProjects = async () => {
      const result = await projectWorkspaceClient.getWorkspaceProjects(inspirationTargetWorkspacePath);
      if (disposed || !result.success) return;
      const projects = result.statuses.flatMap(group => group.projects).filter(candidate => candidate.availability !== 'missing');
      setInspirationProjects(projects);
      let preferredPath = '';
      try { preferredPath = window.localStorage.getItem('photoflow:inspiration-target-project') || ''; } catch { /* storage unavailable */ }
      setInspirationTargetProject(current => projects.find(candidate => candidate.path === current?.path)
        || projects.find(candidate => candidate.path === preferredPath)
        || null);
    };
    void loadProjects();
    const changed = () => void loadProjects();
    window.addEventListener('workspace-projects-changed', changed);
    return () => { disposed = true; window.removeEventListener('workspace-projects-changed', changed); };
  }, [gatherToProject, inspirationTargetWorkspacePath]);
  useEffect(() => {
    const items = progressCompare ? buildProgressCompareListItems(progressCompare, progressCompareFilter) : [];
    if (!items.length) {
      setActiveProgressCompareItemKey('');
      return;
    }
    setActiveProgressCompareItemKey(current => items.some(item => item.key === current) ? current : items[0].key);
  }, [progressCompare, progressCompareFilter]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem('photoflow:files-column-width', String(Math.round(columnWidths.files)));
        window.localStorage.setItem('photoflow:preview-column-width', String(Math.round(columnWidths.preview)));
        window.localStorage.setItem('photoflow:metadata-column-width', String(Math.round(columnWidths.metadata)));
      } catch { /* unavailable storage */ }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [columnWidths]);
  useEffect(() => {
    if (!fileListColumnsCustomized) return;
    const timer = window.setTimeout(() => {
      try {
        for (const key of FILE_LIST_COLUMN_KEYS) window.localStorage.setItem(FILE_LIST_COLUMN_STORAGE_KEYS[key], String(Math.round(fileListColumnWidths[key])));
        window.localStorage.setItem(FILE_LIST_COLUMNS_CUSTOMIZED_STORAGE_KEY, 'true');
      } catch { /* Ignore unavailable storage. */ }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [fileListColumnWidths, fileListColumnsCustomized]);
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
    if (!active || !foregroundDirectoryReady) return;
    let intervalId = 0;
    const fetchDrives = () => projectWorkspaceClient?.getDrives?.().then(nextDrives => setDrives(current =>
      current.length === nextDrives.length && current.every((drive, index) => drive === nextDrives[index]) ? current : nextDrives
    )).catch(() => undefined);
    const cancelDeferredStart = scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.drives, () => {
      void fetchDrives();
      intervalId = window.setInterval(fetchDrives, 3000);
    });
    return () => {
      cancelDeferredStart();
      window.clearInterval(intervalId);
    };
  }, [active, foregroundDirectoryReady]);
  useEffect(() => {
    if (!active || !foregroundDirectoryReady) return;
    const refreshClipboardStatus = () => projectWorkspaceClient.getProjectFileClipboardStatus()
      .then(result => setClipboardHasFiles(result.success && result.hasFiles))
      .catch(() => undefined);
    const cancelDeferredStart = scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.clipboard, () => {
      void refreshClipboardStatus();
      window.addEventListener('focus', refreshClipboardStatus);
    });
    return () => {
      cancelDeferredStart();
      window.removeEventListener('focus', refreshClipboardStatus);
    };
  }, [active, foregroundDirectoryReady]);
  const loadProgressFolders = useCallback(async () => {
    if (progressFoldersRequestRef.current) return progressFoldersRequestRef.current;
    const requestedProjectPath = project.path;
    const request: Promise<ProgressFolder[]> = projectWorkspaceClient.getProgressFolders(workspacePath, project.name).then(result => {
      if (projectPathRef.current !== requestedProjectPath) return [];
      if (result.success) {
        progressFoldersRef.current = result.progressFolders;
        setProgressFolders(result.progressFolders);
        setVersionGraphEdges(result.graphEdges || []);
        return result.progressFolders;
      }
      onNotice(`读取版本进度失败：${result.error || '未知错误'}`);
      return [];
    }).finally(() => {
      if (progressFoldersRequestRef.current === request) progressFoldersRequestRef.current = null;
    });
    progressFoldersRequestRef.current = request;
    return request;
  }, [workspacePath, project.name, project.path, onNotice]);
  useEffect(() => {
    if (!active || !foregroundDirectoryReady || !projectWorkflows) return;
    const loadKey = `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`;
    if (automaticProgressLoadKeyRef.current === loadKey) return;
    return scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.progress, () => {
      if (!activeRef.current) return;
      automaticProgressLoadKeyRef.current = loadKey;
      void loadProgressFolders();
    });
  }, [active, foregroundDirectoryReady, loadProgressFolders, project.name, project.path, project.status, projectWorkflows, workspacePath]);
  const pushRelationHistory = (entry: VersionGraphHistoryEntry) => {
    relationUndoStackRef.current.push(entry);
    if (relationUndoStackRef.current.length > 80) relationUndoStackRef.current.shift();
    relationRedoStackRef.current = [];
    setRelationHistoryRevision(value => value + 1);
  };
  const undoVersionGraphAction = async () => {
    const entry = relationUndoStackRef.current.pop();
    if (!entry) return;
    try {
      await entry.undo();
      relationRedoStackRef.current.push(entry);
      onNotice(`已撤销：${entry.label}`);
    } catch (error) {
      relationUndoStackRef.current.push(entry);
      onNotice(`撤销失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally { setRelationHistoryRevision(value => value + 1); }
  };
  const redoVersionGraphAction = async () => {
    const entry = relationRedoStackRef.current.pop();
    if (!entry) return;
    try {
      await entry.redo();
      relationUndoStackRef.current.push(entry);
      onNotice(`已重做：${entry.label}`);
    } catch (error) {
      relationRedoStackRef.current.push(entry);
      onNotice(`重做失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally { setRelationHistoryRevision(value => value + 1); }
  };
  const mutateSupplementalEdge = async (mode: 'create' | 'delete', request: Pick<VersionGraphEdge, 'projectId' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => {
    const result = mode === 'create'
      ? await projectWorkspaceClient.createVersionGraphEdge(workspacePath, request)
      : await projectWorkspaceClient.deleteVersionGraphEdge(workspacePath, request);
    if (!result.success) throw new Error(result.error || '无法更新版本图关系');
    await loadProgressFolders();
  };
  const requestSupplementalEdgeCreate = async (sourceProgressId: string, targetProgressId: string, edgeKind: 'media_companion' | 'derived_preview' | 'derived_transcode' | 'workflow_input') => {
    const source = progressFoldersRef.current.find(folder => folder.id === sourceProgressId);
    const target = progressFoldersRef.current.find(folder => folder.id === targetProgressId);
    if (!source || !target) { onNotice('关系节点不存在，请刷新后重试'); return; }
    const relationLabel = edgeKind === 'media_companion' ? '配套素材' : edgeKind === 'derived_preview' ? '预览产物' : edgeKind === 'derived_transcode' ? '转码产物' : '工作流输入';
    const confirmed = await appDialog.confirm({
      title: `创建${relationLabel}关系？`,
      message: `将“${source.displayName}”连接到“${target.displayName}”。这不会创建版本号，也不会移动文件。`,
      confirmLabel: '创建关系',
    });
    if (!confirmed) return;
    const request = {
      projectId: target.projectId,
      sourceProgressId,
      targetProgressId,
      edgeKind,
    };
    const result = await projectWorkspaceClient.createVersionGraphEdge(workspacePath, request);
    if (!result.success) { onNotice(`创建${relationLabel}关系失败：${result.error || '未知错误'}`, 7000); return; }
    await loadProgressFolders();
    pushRelationHistory({ label: `创建${relationLabel}关系`, undo: () => mutateSupplementalEdge('delete', request), redo: () => mutateSupplementalEdge('create', request) });
    onNotice(`已创建${relationLabel}关系`);
  };
  const requestSupplementalEdgeDelete = async (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>) => {
    if (supplementalEdgeDeletionIdsRef.current.has(edge.id)) return;
    const child = progressFoldersRef.current.find(folder => folder.id === edge.targetProgressId);
    if (!child) { cancelRelationEdit(); await loadProgressFolders(); return; }
    // Keep all relation mutations behind the same front-end validation entry.
    progressRelationChangeError(progressFoldersRef.current, child.id, child.parentProgressId || null);
    const confirmed = await appDialog.confirm({
      title: '删除补充关系？',
      message: '只会删除这条工作流或媒体关联，不会改变主版本父节点，也不会移动文件。',
      confirmLabel: '删除关系',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (supplementalEdgeDeletionIdsRef.current.has(edge.id)) return;
    supplementalEdgeDeletionIdsRef.current.add(edge.id);
    cancelRelationEdit();
    const request = {
      projectId: child.projectId,
      sourceProgressId: edge.sourceProgressId,
      targetProgressId: edge.targetProgressId,
      edgeKind: edge.edgeKind,
    };
    try {
      const result = await projectWorkspaceClient.deleteVersionGraphEdge(workspacePath, request);
      const alreadyMissing = result.error?.includes('version_graph_edge_not_found');
      if (!result.success && !alreadyMissing) { onNotice(`删除补充关系失败：${result.error || '未知错误'}`, 7000); return; }
      await loadProgressFolders();
      if (!alreadyMissing) pushRelationHistory({ label: '断开补充关系', undo: () => mutateSupplementalEdge('create', request), redo: () => mutateSupplementalEdge('delete', request) });
      onNotice('补充关系已删除');
    } finally {
      supplementalEdgeDeletionIdsRef.current.delete(edge.id);
    }
  };
  const requestSupplementalEdgeReconnect = async (edge: Pick<VersionGraphEdge, 'id' | 'sourceProgressId' | 'targetProgressId' | 'edgeKind'>, newSourceProgressId: string) => {
    const child = progressFoldersRef.current.find(folder => folder.id === edge.targetProgressId);
    const source = progressFoldersRef.current.find(folder => folder.id === newSourceProgressId);
    if (!child || !source) { onNotice('关系节点不存在，请刷新后重试'); cancelRelationEdit(); return; }
    // Keep the shared structural validator in every relation-mutation entry path.
    progressRelationChangeError(progressFoldersRef.current, child.id, child.parentProgressId || null);
    if (edge.sourceProgressId === newSourceProgressId) { onNotice('补充关系没有变化'); cancelRelationEdit(); return; }
    const confirmed = await appDialog.confirm({
      title: '确认改接关系来源？',
      message: `将这条关系的来源改为“${source.displayName}”。不会改变关系类型、主版本父节点或物理文件。`,
      confirmLabel: '改接关系',
    });
    if (!confirmed) { cancelRelationEdit(); return; }
    const request = {
      projectId: child.projectId,
      sourceProgressId: edge.sourceProgressId,
      targetProgressId: edge.targetProgressId,
      edgeKind: edge.edgeKind,
      newSourceProgressId,
    };
    const result = await projectWorkspaceClient.replaceVersionGraphEdgeSource(workspacePath, request);
    cancelRelationEdit();
    if (!result.success) { onNotice(`改接补充关系失败：${result.error || '未知错误'}`, 7000); return; }
    await loadProgressFolders();
    pushRelationHistory({
      label: '改接补充关系',
      undo: async () => {
        const reverted = await projectWorkspaceClient.replaceVersionGraphEdgeSource(workspacePath, { ...request, sourceProgressId: newSourceProgressId, newSourceProgressId: edge.sourceProgressId });
        if (!reverted.success) throw new Error(reverted.error || '无法撤销改接');
        await loadProgressFolders();
      },
      redo: async () => {
        const repeated = await projectWorkspaceClient.replaceVersionGraphEdgeSource(workspacePath, request);
        if (!repeated.success) throw new Error(repeated.error || '无法重做改接');
        await loadProgressFolders();
      },
    });
    onNotice('补充关系来源已更新');
  };
  const requestProgressRelationChange = async (childProgressId: string, parentProgressId: string | null) => {
    const child = progressFoldersRef.current.find(folder => folder.id === childProgressId);
    const parent = parentProgressId ? progressFoldersRef.current.find(folder => folder.id === parentProgressId) : undefined;
    if (!child) { onNotice('要修改的版本节点不存在，请刷新后重试'); return; }
    const relationError = progressRelationChangeError(progressFoldersRef.current, childProgressId, parentProgressId);
    if (relationError) { onNotice(relationError, 5000); cancelRelationEdit(); return; }
    const desiredWorkflowInputs = child.nodeRole === 'progress'
      ? workflowInputIdsForRelationChange(progressFoldersRef.current, versionGraphEdges, childProgressId, parentProgressId)
      : [];
    const existingWorkflowInputSet = new Set(versionGraphEdges
      .filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId)
      .map(edge => edge.sourceProgressId));
    const needsWorkflowInputRepair = desiredWorkflowInputs.length !== existingWorkflowInputSet.size
      || desiredWorkflowInputs.some(id => !existingWorkflowInputSet.has(id));
    if ((child.parentProgressId || null) === parentProgressId && !needsWorkflowInputRepair) {
      onNotice(parent
        ? `“${child.displayName}”已经连接到“${parent.displayName}”；无需重复连接。如需重新比较内容，请刷新该版本的版本跟踪。`
        : '该节点已经是独立根节点，无需重复断开。', 6000);
      cancelRelationEdit();
      return;
    }
    const request = { childProgressId, parentProgressId };
    setPendingRelationChange(request);
    const confirmed = await appDialog.confirm({
      title: '确认修改版本关系？',
      message: child.nodeRole === 'selection'
        ? `将“${child.displayName}”的来源改为“${parent?.displayName || '未知节点'}”。只修改版本关系，不会重新复制选片内容。`
        : parent ? `将“${child.displayName}”连接到“${parent.displayName}”下面。保存后会按新来源重新比较已开启跟踪的版本；不会移动或重命名物理文件夹。` : `将“${child.displayName}”断开为独立根节点，并自动关闭版本跟踪及其附加策略。不会移动或重命名物理文件夹。`,
      confirmLabel: '修改关系',
    });
    if (!confirmed) { cancelRelationEdit(); return; }
    if (child.nodeRole === 'progress' && parentProgressId === null) {
      setPendingRelationChange({ childProgressId, parentProgressId: null });
      setRelationMutatingChildIds(current => current.includes(childProgressId) ? current : [...current, childProgressId]);
      try {
        const activeTrackingTask = backgroundTasks.find(task => task.type === 'version-tracking'
          && task.metadata?.progressId === childProgressId
          && (task.state === 'queued' || task.state === 'running'));
        if (activeTrackingTask) await projectWorkspaceClient.cancelBackgroundTask(activeTrackingTask.id);
        const result = await projectWorkspaceClient.unregisterProgressFolder(workspacePath, project.name, childProgressId);
        if (!result.success) throw new Error(result.error || '无法取消版本登记');
        const sessionKey = `photoflow:tracking-session:${workspacePath}:${project.name}:${childProgressId}`;
        const sessionId = safeStorageGet(sessionKey);
        safeStorageRemove(sessionKey);
        if (sessionId) dismissTrackingTaskForSession(sessionId);
        if (trackingConfirmationProgressId === childProgressId) {
          setTrackingConfirmationProgressId('');
          setTrackingConfirmationSessionId('');
        }
        await loadProgressFolders();
        onNotice('版本关系已断开，该文件夹已恢复为普通文件夹');
      } catch (error) {
        onNotice(`取消版本登记失败：${error instanceof Error ? error.message : String(error)}`, 7000);
      } finally {
        cancelRelationEdit();
        setPendingRelationChange(current => current?.childProgressId === childProgressId ? null : current);
        setRelationMutatingChildIds(current => current.filter(id => id !== childProgressId));
      }
      return;
    }
    if (parent && (child.nodeRole === 'progress' && (parent.nodeRole === 'selection' || parent.nodeRole === 'workflow')
      || child.nodeRole === 'workflow' && parent.nodeRole === 'progress')) {
      const edgeRequest = {
        projectId: child.projectId,
        sourceProgressId: parent.id,
        targetProgressId: child.id,
        edgeKind: 'workflow_input',
      } as const;
      const result = await projectWorkspaceClient.createVersionGraphEdge(workspacePath, edgeRequest);
      cancelRelationEdit();
      if (!result.success) {
        onNotice(`添加工作流输入关系失败：${result.error || '未知错误'}`, 7000);
        return;
      }
      await loadProgressFolders();
      pushRelationHistory({ label: '添加工作流输入', undo: () => mutateSupplementalEdge('delete', edgeRequest), redo: () => mutateSupplementalEdge('create', edgeRequest) });
      onNotice('工作流输入关系已添加');
      return;
    }
    const mutationId = Math.max(relationMutationIdRef.current, relationMutationId) + 1;
    relationMutationIdRef.current = mutationId;
    setRelationMutationId(mutationId);
    relationMutationCountsRef.current.set(childProgressId, (relationMutationCountsRef.current.get(childProgressId) || 0) + 1);
    setRelationMutatingChildIds(current => current.includes(childProgressId) ? current : [...current, childProgressId]);
    const mutationQueue = relationMutationQueueRef.current;
    const mutationGeneration = mutationQueue.captureGeneration();
    try {
      await mutationQueue.enqueue(childProgressId, async () => {
        let latestChild = progressFoldersRef.current.find(folder => folder.id === childProgressId);
        if (!latestChild) latestChild = (await loadProgressFolders()).find(folder => folder.id === childProgressId);
        if (!latestChild) throw new Error('要修改的版本节点不存在，请刷新后重试');
        const previousParentProgressId = latestChild.parentProgressId || null;
        const previousTrackingPolicy = trackingPolicyForRelationChange(latestChild, previousParentProgressId);
        const previousWorkflowInputProgressIds = versionGraphEdges
          .filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId)
          .map(edge => edge.sourceProgressId);
        const nextWorkflowInputProgressIds = workflowInputIdsForRelationChange(
          progressFoldersRef.current,
          versionGraphEdges,
          childProgressId,
          parentProgressId,
        );
        const applyProgressGraph = async (
          currentChild: ProgressFolder,
          nextParentProgressId: string | null,
          workflowInputProgressIds: string[],
          trackingPolicy = trackingPolicyForRelationChange(currentChild, nextParentProgressId),
        ) => projectWorkspaceClient.registerProgressWithGraph(workspacePath, project.status, {
          projectName: project.name,
          progress: {
            progressId: currentChild.id,
            mediaKind: progressNodeMediaKind(currentChild) || undefined,
            versionKey: currentChild.versionKey,
            parentProgressId: nextParentProgressId || undefined,
            displayName: currentChild.displayName,
            trackingEnabled: trackingPolicy.trackingEnabled,
            trackingState: trackingPolicy.trackingState,
            renameFromParent: trackingPolicy.renameFromParent,
            copyMissingFromParent: trackingPolicy.copyMissingFromParent,
          },
          workflowInputProgressIds,
        });
        const detachingProgress = latestChild.nodeRole === 'progress' && parentProgressId === null;
        if (detachingProgress) {
          const activeTrackingTask = backgroundTasks.find(task => task.type === 'version-tracking'
            && task.metadata?.progressId === childProgressId
            && (task.state === 'queued' || task.state === 'running'));
          if (activeTrackingTask) await projectWorkspaceClient.cancelBackgroundTask(activeTrackingTask.id);
        }
        const result = latestChild.nodeRole === 'progress'
          ? await applyProgressGraph(latestChild, parentProgressId, nextWorkflowInputProgressIds)
          : await projectWorkspaceClient.updateProgressRelation(workspacePath, project.name, {
            childProgressId,
            parentProgressId,
            expectedUpdatedAt: latestChild.updatedAt,
          });
        if (!mutationQueue.isGenerationCurrent(mutationGeneration)) return;
        if (!result.success || !result.progressFolder) {
          if ((result.error || '').includes('stale_update')) await loadProgressFolders();
          throw new Error(result.error || '未知错误');
        }
        if (latestChild.nodeRole === 'progress') {
          const committedEdges: VersionGraphEdge[] = 'edges' in result && Array.isArray(result.edges) ? result.edges : [];
          const committedWorkflowInputIds = new Set(committedEdges
            .filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId)
            .map(edge => edge.sourceProgressId));
          const graphWasPersisted = (result.progressFolder.parentProgressId || null) === parentProgressId
            && committedWorkflowInputIds.size === nextWorkflowInputProgressIds.length
            && nextWorkflowInputProgressIds.every(id => committedWorkflowInputIds.has(id));
          if (!graphWasPersisted) {
            await loadProgressFolders();
            throw new Error('关系写入后校验失败，请刷新后重试');
          }
          const committedChildWorkflowEdges = committedEdges.filter(edge => edge.edgeKind === 'workflow_input' && edge.targetProgressId === childProgressId);
          setVersionGraphEdges(current => [
            ...current.filter(edge => edge.edgeKind !== 'workflow_input' || edge.targetProgressId !== childProgressId),
            ...committedChildWorkflowEdges,
          ]);
        }
        const updatedFolder = result.progressFolder;
        setProgressFolders(current => {
          const next = current.map(folder => folder.id === updatedFolder.id ? updatedFolder : folder);
          progressFoldersRef.current = next;
          return next;
        });
        if (detachingProgress) {
          const sessionKey = `photoflow:tracking-session:${workspacePath}:${project.name}:${childProgressId}`;
          const sessionId = safeStorageGet(sessionKey);
          safeStorageRemove(sessionKey);
          if (sessionId) dismissTrackingTaskForSession(sessionId);
          if (trackingConfirmationProgressId === childProgressId) {
            setTrackingConfirmationProgressId('');
            setTrackingConfirmationSessionId('');
          }
        }
        const applyParent = async (
          nextParentProgressId: string | null,
          workflowInputProgressIds: string[],
          trackingPolicy?: ReturnType<typeof trackingPolicyForRelationChange>,
        ) => {
          const currentChild = progressFoldersRef.current.find(folder => folder.id === childProgressId);
          if (!currentChild) throw new Error('要修改的版本节点不存在，请刷新后重试');
          const changed = currentChild.nodeRole === 'progress'
            ? await applyProgressGraph(currentChild, nextParentProgressId, workflowInputProgressIds, trackingPolicy)
            : await projectWorkspaceClient.updateProgressRelation(workspacePath, project.name, { childProgressId, parentProgressId: nextParentProgressId, expectedUpdatedAt: currentChild.updatedAt });
          if (!changed.success) throw new Error(changed.error || '无法更新版本关系');
          await loadProgressFolders();
        };
        if (!(latestChild.nodeRole === 'progress' && previousParentProgressId === null)) {
          pushRelationHistory({
            label: '修改版本父关系',
            undo: () => applyParent(previousParentProgressId, previousWorkflowInputProgressIds, previousTrackingPolicy),
            redo: () => applyParent(parentProgressId, nextWorkflowInputProgressIds),
          });
        }
        if (updatedFolder.nodeRole === 'progress' && updatedFolder.trackingEnabled && parentProgressId) {
          const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, {
            progressId: updatedFolder.id,
            mode: 'refresh',
          });
          if (started.success && started.sessionId) {
            safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${updatedFolder.id}`, started.sessionId);
            setTrackingConfirmationProgressId(updatedFolder.id);
            if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
            await loadProgressFolders();
            onNotice(`版本关系已更新，正在重新比较 ${parent?.displayName || '新来源'} → ${updatedFolder.displayName}；完成后可从任务中心确认。`, 7000);
          } else {
            onNotice(`版本关系已更新，${updatedFolder.displayName} 已标记为待刷新；自动重新比较启动失败：${started.error || '未知错误'}`, 8000);
          }
        } else {
          onNotice(detachingProgress ? '版本关系已断开，版本跟踪已自动关闭' : '版本关系已更新');
        }
      });
    } catch (error) {
      mutationQueue.runIfCurrent(mutationGeneration, () => {
        onNotice(`修改版本关系失败：${error instanceof Error ? error.message : '未知错误'}`, 7000);
      });
    } finally {
      if (mutationQueue.isGenerationCurrent(mutationGeneration)) {
        const remaining = Math.max(0, (relationMutationCountsRef.current.get(childProgressId) || 1) - 1);
        if (remaining) relationMutationCountsRef.current.set(childProgressId, remaining);
        else {
          relationMutationCountsRef.current.delete(childProgressId);
          setRelationMutatingChildIds(current => current.filter(id => id !== childProgressId));
          setPendingRelationChange(current => current?.childProgressId === childProgressId ? null : current);
          setDraggingChildId(current => current === childProgressId ? '' : current);
          setHoverParentId('');
        }
      }
    }
  };
  useEffect(() => {
    // React StrictMode intentionally runs an effect setup/cleanup cycle twice
    // in development. Each setup must therefore own a fresh queue; otherwise
    // the first cleanup permanently disposes every later relation mutation.
    const queue = new ProgressRelationMutationQueue();
    relationMutationQueueRef.current = queue;
    return () => {
      relationMutationIdRef.current += 1;
      queue.dispose();
      relationMutationCountsRef.current.clear();
    };
  }, []);
  useEffect(() => {
    const openTrackingConfirmation = (event: Event) => {
      if (!active) return;
      const detail = (event as CustomEvent<{ sessionId?: string; progressId?: string }>).detail;
      const sessionId = String(detail?.sessionId || '');
      const progressId = String(detail?.progressId || '');
      if (!sessionId || !progressId || !progressFolders.some(folder => folder.id === progressId)) return;
      safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressId}`, sessionId);
      setTrackingConfirmationProgressId(progressId);
      setTrackingConfirmationSessionId(sessionId);
    };
    window.addEventListener('photoflow:open-tracking-confirmation', openTrackingConfirmation);
    return () => window.removeEventListener('photoflow:open-tracking-confirmation', openTrackingConfirmation);
  }, [active, progressFolders, workspacePath, project.name]);
  useEffect(() => {
    if (!active) return;
    return projectWorkspaceClient.onBackgroundTaskChanged(delta => {
      for (const task of delta.upserts) {
      if (task.type !== 'version-tracking') continue;
      const progressId = typeof task.metadata.progressId === 'string' ? task.metadata.progressId : '';
      const progress = progressFoldersRef.current.find(folder => folder.id === progressId);
      if (!progressId || !progress?.trackingEnabled) {
        if (!task.retryPending && (task.state === 'completed' || task.state === 'cancelled' || task.state === 'failed')) void dismissBackgroundTask(task.id);
        continue;
      }
      if (task.state !== 'completed') continue;
      const sessionId = typeof task.metadata.sessionId === 'string' ? task.metadata.sessionId : '';
      if (!sessionId) continue;
      safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressId}`, sessionId);
      setTrackingConfirmationProgressId(progressId);
      setTrackingConfirmationSessionId(sessionId);
      }
    });
  }, [active, dismissBackgroundTask, project.name, workspacePath]);
  const loadFinalVersionSummary = useCallback(async () => {
    const result = await projectWorkspaceClient.getFinalVersionSummary(workspacePath, project.status, project.name);
    if (result.success) {
      const summary = { count: result.count, availableCount: result.availableCount, missingCount: result.missingCount };
      setFinalVersionSummary(summary);
      return summary;
    }
    setFinalVersionSummary({ count: 0, availableCount: 0, missingCount: 0 });
    return { count: 0, availableCount: 0, missingCount: 0 };
  }, [workspacePath, project.status, project.name]);
  const loadFinalViewEntries = useCallback(async (showMissingNotice = false) => {
    setFinalViewLoading(true);
    try {
      const result = await projectWorkspaceClient.browseFinalVersions(workspacePath, project.status, project.name);
      if (!result.success) {
        onNotice(`读取喜爱图片失败：${result.error || '未知错误'}`);
        return null;
      }
      setFinalViewEntries(result.entries);
      if (showMissingNotice && result.missingCount) onNotice(`已显示 ${result.availableCount} 张喜爱图片；另有 ${result.missingCount} 张文件已被删除、移动或不在项目中。`, 7000);
      return result;
    } finally {
      setFinalViewLoading(false);
    }
  }, [workspacePath, project.status, project.name, onNotice]);
  const closeFinalVersionView = () => {
    setFinalViewOpen(false);
    setSelectedPaths([]);
    setPreviewPath('');
    setPreviewHighlightPath('');
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setSearchOpen(false);
    setSearchQuery('');
  };
  const refresh = async (relativePath?: string, options: { includeProjectContents?: boolean } = {}) => {
    const safeRelativePath = typeof relativePath === 'string' ? relativePath : currentRelativePathRef.current;
    const requestedPath = safeRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const requestedProjectPath = project.path;
    // Callers that mutate version metadata often invalidate the root while the
    // user is browsing a child folder. Such a refresh must not take ownership
    // of the visible directory's loading state or invalidate its active read.
    if (!isForegroundDirectoryRefresh(requestedPath, currentRelativePathRef.current, requestedProjectPath, projectPathRef.current)) return;
    const refreshSequence = ++refreshSequenceRef.current;
    const cachedEntries = directoryEntriesCacheRef.current.get(requestedPath);
    const renderedDirectory = renderedDirectoryRef.current;
    const retainedEntries = cachedEntries ?? (renderedDirectory.ready && renderedDirectory.path === requestedPath ? fileEntriesRef.current : undefined);
    if (cachedEntries) {
      setFileEntries(cachedEntries);
      if (activeRef.current) setForegroundDirectoryReady(true);
    }
    setDirectoryLoading(retainedEntries === undefined);
    const contentsPromise = options.includeProjectContents === false ? null : projectWorkspaceClient.getProjectContents(workspacePath, project.status, project.name).then(
      result => ({ result }),
      error => ({ error }),
    );
    let browseResult: Awaited<ReturnType<typeof projectWorkspaceClient.browseProjectFiles>>;
    try {
      browseResult = await projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, requestedPath, mediaCacheConfig);
    } catch (error) {
      if (refreshSequence !== refreshSequenceRef.current
        || !isForegroundDirectoryRefresh(requestedPath, currentRelativePathRef.current, requestedProjectPath, projectPathRef.current)) return;
      setDirectoryLoading(false);
      if (activeRef.current) setForegroundDirectoryReady(true);
      renderedDirectoryRef.current = { path: requestedPath, ready: true };
      if (retainedEntries === undefined) setFileEntries([]);
      onNotice(`${retainedEntries === undefined ? '读取目录失败' : '目录后台刷新失败，继续显示已有内容'}：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (refreshSequence !== refreshSequenceRef.current
      || !isForegroundDirectoryRefresh(requestedPath, currentRelativePathRef.current, requestedProjectPath, projectPathRef.current)) return;
    setDirectoryLoading(false);
    if (activeRef.current) setForegroundDirectoryReady(true);
    renderedDirectoryRef.current = { path: requestedPath, ready: true };
    if (browseResult.success) {
      setCurrentDirectoryViaExternalLink(Boolean(browseResult.viaExternalLink));
      setCurrentExternalLinkRootPath(normalizeProjectRelativePath(browseResult.externalLinkRootRelativePath || ''));
      const entries = mergeRefreshedEntryMetadata(browseResult.entries, retainedEntries || []);
      directoryEntriesCacheRef.current.set(requestedPath, entries);
      setFileEntries(entries);
      if (!requestedPath) setHasExternalFolderLinks(entries.some(entry => entry.externalLink && entry.externalLinkTargetKind !== 'file'));
    } else {
      // Never leave entries from the previous directory under a new breadcrumb.
      setCurrentDirectoryViaExternalLink(Boolean(browseResult.externalLinkOffline));
      setCurrentExternalLinkRootPath(browseResult.externalLinkOffline
        ? requestedPath.split('/').slice(0, requestedPath.split('/').findIndex(segment => segment.toLocaleLowerCase().endsWith('.lnk')) + 1).join('/')
        : '');
      if (retainedEntries === undefined || browseResult.externalLinkOffline || browseResult.missingDirectory) setFileEntries([]);
      if (browseResult.externalLinkOffline) {
        onNotice('外链目标当前离线或路径不可用；重新连接磁盘后会自动恢复，也可以返回项目根目录后右键重新定位外链。', 7000);
        return;
      }
      if (browseResult.missingDirectory && !requestedPath) {
        onNotice(inspirationMode ? '灵感库文件夹已被移动或删除，请在设置中重新选择。' : `项目“${project.name}”已在外部删除，已关闭项目标签`);
        if (projectWorkflows) onDeleted();
        return;
      }
      if (browseResult.missingDirectory && requestedPath) {
        const parentPath = requestedPath.split('/').slice(0, -1).join('/');
        setDirectoryHistory(current => ({
          back: current.back.filter(path => path !== requestedPath && !path.startsWith(`${requestedPath}/`)),
          forward: current.forward.filter(path => path !== requestedPath && !path.startsWith(`${requestedPath}/`)),
        }));
        onNotice(`文件夹“${requestedPath.split('/').pop()}”已在外部被删除，已返回上一级目录`);
        showDirectory(parentPath);
        return;
      }
      onNotice(`${retainedEntries === undefined ? '读取目录失败' : '目录后台刷新失败，继续显示已有内容'}：${browseResult.error || '无法读取文件'}`);
    }
    if (!contentsPromise) return;
    const contentsOutcome = await contentsPromise;
    if (refreshSequence !== refreshSequenceRef.current
      || !isForegroundDirectoryRefresh(requestedPath, currentRelativePathRef.current, requestedProjectPath, projectPathRef.current)) return;
    if ('error' in contentsOutcome) {
      onNotice(`读取${browserContext.title}失败：${contentsOutcome.error instanceof Error ? contentsOutcome.error.message : String(contentsOutcome.error)}`);
      return;
    }
    const { result } = contentsOutcome;
    if (result.success) setFolders(current => current.length === result.folders.length
      && current.every((folder, index) => folder.path === result.folders[index]?.path
        && folder.name === result.folders[index]?.name
        && folder.updatedAt === result.folders[index]?.updatedAt)
      ? current : result.folders);
    else onNotice(`${inspirationMode ? '读取灵感库' : '读取项目'}失败：${result.error || '无法读取文件夹'}`);
  };
  const refreshRecursiveDirectory = useCallback(async (relativeDirectoryPath: string) => {
    if (!recursiveFlatOpen && !currentFolderRecursiveSearchActive) return;
    if (searchQuery.trim()) {
      setRecentRefreshToken(current => current + 1);
      return;
    }
    const directoryPath = normalizeProjectRelativePath(relativeDirectoryPath);
    const currentScope = normalizeProjectRelativePath(currentRelativePathRef.current);
    if (currentScope && directoryPath !== currentScope && !directoryPath.startsWith(`${currentScope}/`)) return;
    const sequence = (recursiveDirectoryRefreshSequenceRef.current.get(directoryPath) || 0) + 1;
    recursiveDirectoryRefreshSequenceRef.current.set(directoryPath, sequence);
    const requestedProjectPath = project.path;
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.browseProjectFiles>>;
    try {
      result = await projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, directoryPath, mediaCacheConfig);
    } catch {
      if (recursiveDirectoryRefreshSequenceRef.current.get(directoryPath) === sequence) recursiveDirectoryRefreshSequenceRef.current.delete(directoryPath);
      return;
    }
    if (recursiveDirectoryRefreshSequenceRef.current.get(directoryPath) !== sequence || requestedProjectPath !== projectPathRef.current) return;
    if (!result.success) {
      if (result.missingDirectory && directoryPath) {
        setSearchEntries(current => current.filter(entry => {
          if (entry.viaShortcut) return true;
          const entryPath = normalizeProjectRelativePath(entry.relativePath);
          return projectRelativeParentPath(entryPath) !== directoryPath && !entryPath.startsWith(`${directoryPath}/`);
        }));
        return;
      }
      setRecentRefreshToken(current => current + 1);
      return;
    }
    const nextDirectoryEntries = result.entries.filter(entry => entry.kind !== 'folder');
    setSearchEntries(current => mergeRefreshedRecursiveDirectoryEntries(current, nextDirectoryEntries, directoryPath));
    directoryEntriesCacheRef.current.set(directoryPath, result.entries);
  }, [currentFolderRecursiveSearchActive, mediaCacheConfig, project.name, project.path, project.status, recursiveFlatOpen, searchQuery, workspacePath]);
  const upsertOptimisticDirectoryEntry = (directoryPath: string, entry: ProjectFileEntry, previousRelativePath = '') => {
    const normalizedDirectory = normalizeProjectRelativePath(directoryPath);
    const currentDirectory = normalizeProjectRelativePath(currentRelativePathRef.current);
    const cachedEntries = directoryEntriesCacheRef.current.get(normalizedDirectory);
    if (!cachedEntries && normalizedDirectory !== currentDirectory) return;
    const sourceEntries = cachedEntries ?? fileEntriesRef.current;
    const nextEntries = [
      ...sourceEntries.filter(candidate => candidate.relativePath !== previousRelativePath && candidate.relativePath !== entry.relativePath),
      entry,
    ];
    directoryEntriesCacheRef.current.set(normalizedDirectory, nextEntries);
    if (normalizedDirectory === currentDirectory) setFileEntries(nextEntries);
  };
  const removeOptimisticDirectoryEntry = (directoryPath: string, relativePath: string) => {
    const normalizedDirectory = normalizeProjectRelativePath(directoryPath);
    const currentDirectory = normalizeProjectRelativePath(currentRelativePathRef.current);
    const cachedEntries = directoryEntriesCacheRef.current.get(normalizedDirectory);
    const sourceEntries = cachedEntries ?? (normalizedDirectory === currentDirectory ? fileEntriesRef.current : null);
    if (!sourceEntries) return;
    const nextEntries = sourceEntries.filter(candidate => candidate.relativePath !== relativePath);
    directoryEntriesCacheRef.current.set(normalizedDirectory, nextEntries);
    if (normalizedDirectory === currentDirectory) setFileEntries(nextEntries);
  };
  const settleDirectoryPreviewRenames = (entries: PendingProjectFileEntry[], committed: boolean) => {
    const settled = settlePendingDirectoryPreviewRenameCaches(
      directoryEntriesCacheRef.current,
      optimisticDirectoryEntriesCacheRef.current,
      entries,
      committed,
    );
    if (!settled) return;
    for (const root of settled.invalidatedRequestRoots) {
      const requestKeys = new Set([...directoryPreviewRequestTokensRef.current.keys(), ...directoryPrefetchesRef.current.keys()]);
      for (const key of requestKeys) {
        if (!directoryPreviewCacheKeyWithin(key, root)) continue;
        directoryPreviewRequestTokensRef.current.delete(key);
        directoryPrefetchesRef.current.delete(key);
      }
    }
    if (!committed) return;
    const shortcutSnapshot = new Map(shortcutPreviewStatesRef.current);
    const shortcutUpdates = new Map<string, Pick<ProjectFileEntry, 'shortcutTargetKind' | 'shortcutBroken'>>();
    for (const [sourceStateKey, sourceState] of shortcutSnapshot) {
      for (const { sourceKey, targetKey } of settled.renames) {
        const targetStateKey = remapDirectoryPreviewCacheKey(sourceStateKey, sourceKey, targetKey);
        if (targetStateKey) shortcutUpdates.set(targetStateKey, sourceState);
      }
    }
    for (const key of [...shortcutPreviewStatesRef.current.keys()]) {
      if (settled.renames.some(({ sourceKey, targetKey }) => directoryPreviewCacheKeyWithin(key, sourceKey) || directoryPreviewCacheKeyWithin(key, targetKey))) {
        shortcutPreviewStatesRef.current.delete(key);
      }
    }
    for (const [key, state] of shortcutUpdates) shortcutPreviewStatesRef.current.set(key, state);
  };
  const scheduleDirectoryRefresh = (directoryPaths: string[] = [currentRelativePathRef.current]) => {
    for (const directoryPath of directoryPaths) {
      const normalized = normalizeProjectRelativePath(directoryPath);
      pendingDirectoryRefreshesRef.current.add(normalized);
      directoryEntriesCacheRef.current.delete(normalized);
    }
    window.clearTimeout(directoryRefreshTimerRef.current);
    directoryRefreshTimerRef.current = window.setTimeout(() => {
      directoryRefreshTimerRef.current = 0;
      const directories = [...pendingDirectoryRefreshesRef.current];
      pendingDirectoryRefreshesRef.current.clear();
      if (projectRootScopeSelected) setScopeRefreshToken(current => current + 1);
      else if (recursiveFlatOpen || currentFolderRecursiveSearchActive) {
        for (const directory of directories) void refreshRecursiveDirectory(directory);
      } else {
        const currentPath = normalizeProjectRelativePath(currentRelativePathRef.current);
        const affectsCurrent = directories.some(directory => directory === currentPath
          || (!directory && !currentPath)
          || Boolean(directory && currentPath.startsWith(`${directory}/`)));
        if (affectsCurrent) void refresh(currentPath, { includeProjectContents: directories.some(directory => !directory) });
      }
    }, 180);
  };
  const startPendingFileOperation = (operation: Omit<PendingFileOperation, 'id'>) => {
    if (pendingPathConflicts(pendingFileOperationsRef.current, operation.lockedPaths)) {
      onNotice('所选文件或目标位置正在处理中，请等待当前操作完成');
      return null;
    }
    const pending = { ...operation, projectPath: projectPathRef.current, id: `file-operation-${Date.now()}-${++pendingFileOperationSequenceRef.current}` };
    const next = addPendingFileOperation(pendingFileOperationsRef.current, pending);
    if (next === pendingFileOperationsRef.current) return null;
    pendingFileOperationsRef.current = next;
    setPendingFileOperations(next);
    return pending;
  };
  const clearPendingFileOperation = (operationId: string) => {
    const next = removePendingFileOperation(pendingFileOperationsRef.current, operationId);
    pendingFileOperationsRef.current = next;
    setPendingFileOperations(next);
  };
  const projectOperationIsCurrent = (requestedProjectPath: string) => mayCommitAsyncOperationResult(requestedProjectPath, projectPathRef.current);
  const discardStaleProjectOperation = (requestedProjectPath: string, operation?: PendingFileOperation | null) => {
    if (projectOperationIsCurrent(requestedProjectPath)) return false;
    if (operation) clearPendingFileOperation(operation.id);
    return true;
  };
  const reconcilePendingFileOperation = async (operation: PendingFileOperation, result?: { affectedDirectories?: string[] }, rollbackImmediately = false) => {
    const requestedProjectPath = operation.projectPath || projectPathRef.current;
    if (!projectOperationIsCurrent(requestedProjectPath)) { clearPendingFileOperation(operation.id); return; }
    const directories = operationRefreshDirectories(operation, result);
    if (rollbackImmediately) clearPendingFileOperation(operation.id);
    for (const directory of directories) directoryEntriesCacheRef.current.delete(directory);
    const currentPath = normalizeProjectRelativePath(currentRelativePathRef.current);
    if (directories.includes(currentPath)) await refresh(currentPath, { includeProjectContents: !currentPath });
    if (!projectOperationIsCurrent(requestedProjectPath)) { clearPendingFileOperation(operation.id); return; }
    if (recursiveFlatOpen || currentFolderRecursiveSearchActive) {
      await Promise.all(directories.map(directory => refreshRecursiveDirectory(directory)));
      if (!projectOperationIsCurrent(requestedProjectPath)) { clearPendingFileOperation(operation.id); return; }
    }
    if (projectRootScopeSelected) setScopeRefreshToken(current => current + 1);
    if (!rollbackImmediately) clearPendingFileOperation(operation.id);
    // A later concurrent refresh may have invalidated the awaited request. The
    // debounced pass is the final authority after the overlay has been removed.
    scheduleDirectoryRefresh(directories);
  };
  useEffect(() => {
    const nextIdentity = { pageId, projectId: project.id, projectPath: project.path, projectName: project.name, projectStatus: project.status };
    const lifecycle = resolveProjectWorkspaceLifecycle(projectLifecycleRef.current, nextIdentity, currentRelativePathRef.current, initialRelativePath);
    projectLifecycleRef.current = nextIdentity;
    projectPathRef.current = project.path;
    if (lifecycle.kind === 'none') return;
    refreshSequenceRef.current += 1;
    setForegroundDirectoryReady(false);
    if (lifecycle.kind !== 'refresh') renderedDirectoryRef.current = { path: lifecycle.relativePath, ready: false };
    directoryEntriesCacheRef.current.clear();
    optimisticDirectoryEntriesCacheRef.current.clear();
    directoryPrefetchesRef.current.clear();
    directoryPreviewRequestTokensRef.current.clear();
    pendingFileOperationsRef.current = [];
    setPendingFileOperations([]);
    clipboardOperationSequenceRef.current += 1;
    setCutPaths([]);
    setClipboardPending(false);
    setClipboardHasFiles(false);
    shortcutPreviewStatesRef.current.clear();
    progressFoldersRequestRef.current = null;
    if (lifecycle.kind !== 'refresh') setDirectoryLoading(active);
    if (lifecycle.kind === 'refresh') {
      if (active) refresh(lifecycle.relativePath);
      return;
    }
    currentRelativePathRef.current = lifecycle.relativePath;
    setProgressFolders([]);
    setVersionGraphEdges([]);
    setFileEntries([]);
    setHasExternalFolderLinks(false);
    setDirectoryHistory({ back: [], forward: [] });
    setPreviewPath('');
    setPreviewHighlightPath('');
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setFinalViewOpen(false);
    setFinalViewEntries([]);
    setVersionEntry(null);
    setVersionProgressId('');
    versionProgressLocationRef.current = null;
    setProgressSetup(null);
    setFolderMarkSetup(null);
    setProgressCompare(null);
    setWorkspaceActivityMessage('');
    setPanel(initialPanel);
    setResearchTargetPath('');
    setResearchTargetHasTxt(false);
    setGatherPickerPaths(null);
    setBrowseMode(browseModeForFolder(lifecycle.relativePath, []));
    setGridIconSize(gridIconSizeForFolder(lifecycle.relativePath));
    if (currentRelativePath !== lifecycle.relativePath) skipNextPathRefreshRef.current = true;
    setCurrentRelativePath(lifecycle.relativePath);
    if (active) refresh(lifecycle.relativePath);
  }, [active, initialPanel, initialRelativePath, pageId, project.id, project.name, project.path, project.status, projectWorkflows]);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      setForegroundDirectoryReady(false);
      refresh(currentRelativePathRef.current);
    } else if (!active) {
      automaticProgressLoadKeyRef.current = '';
      setForegroundDirectoryReady(false);
    }
    wasActiveRef.current = active;
  }, [active]);
  useEffect(() => {
    if (!active || currentRelativePath) return;
    const remembered = storedFolderBrowseMode('');
    if (remembered && remembered !== 'version-tree') return;
    const nextMode = browseModeForFolder('');
    setBrowseMode(current => current === nextMode ? current : nextMode);
  }, [active, currentRelativePath, progressFolders, project.path, versionTreeEnabled]);
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
    setPreviewHighlightPath('');
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setInlineRenamePath('');
    setInlineRenameValue('');
    setFileMenu(null);
    refresh();
  }, [currentRelativePath]);
  useEffect(() => { setFolderAlphabetFilter(''); }, [currentRelativePath, browseMode, folderAlphabetFilterEnabled]);
  useEffect(() => {
    onDirectoryChangeRef.current?.(currentRelativePath);
  }, [currentRelativePath]);
  useEffect(() => {
    setOperationDirectoryPath(currentRelativePath);
  }, [currentRelativePath, recursiveFlatOpen]);
  useEffect(() => {
    if (!active || !foregroundDirectoryReady) return;
    let disposed = false;
    let watchStarted = false;
    const watchIdentity = `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`;
    const previousReconcile = watchReconcileStateRef.current;
    const forceReconcile = previousReconcile.identity !== watchIdentity
      || previousReconcile.externalWatchRevision !== externalWatchRevision;
    const reconcile = shouldReconcileProjectWatch(previousReconcile.lastReconciledAt, Date.now(), forceReconcile);
    const cancelDeferredStart = scheduleAfterProjectPaint(PROJECT_BACKGROUND_LOAD_DELAYS_MS.watcher, () => {
      if (disposed || !activeRef.current) return;
      watchStarted = true;
      setRootWatchFailed(false);
      void projectWorkspaceClient.watchFileRoot(workspacePath, project.status, project.name, { reconcile }).then(result => {
        if (disposed) return;
        setRootWatchFailed(!result.success || result.degraded === true);
        if (typeof result.externalFolderLinks === 'number') setHasExternalFolderLinks(result.externalFolderLinks > 0);
        if (result.reconciled) {
          watchReconcileStateRef.current = { identity: watchIdentity, externalWatchRevision, lastReconciledAt: Date.now() };
          if (projectWorkflows) void loadProgressFolders();
        }
      }).catch(() => { if (!disposed) setRootWatchFailed(true); });
    });
    return () => {
      disposed = true;
      cancelDeferredStart();
      if (watchStarted) void projectWorkspaceClient.unwatchFileRoot(workspacePath, project.status, project.name);
    };
  }, [active, externalWatchRevision, foregroundDirectoryReady, loadProgressFolders, project.name, project.path, project.status, projectWorkflows, watchRootDirectly, workspacePath]);
  useEffect(() => {
    if (!active || !rootWatchFailed) return;
    // Network drives and some virtual filesystems cannot be watched. Keep a
    // low-frequency fallback without making polling the normal code path.
    const interval = window.setInterval(() => {
      void projectWorkspaceClient.watchFileRoot(workspacePath, project.status, project.name, { reconcile: true }).then(result => {
        if (result.success && !result.degraded) setRootWatchFailed(false);
        if (typeof result.externalFolderLinks === 'number') setHasExternalFolderLinks(result.externalFolderLinks > 0);
        if (result.reconciled) {
          watchReconcileStateRef.current = {
            identity: `${workspacePath}\0${project.status}\0${project.name}\0${project.path}`,
            externalWatchRevision,
            lastReconciledAt: Date.now(),
          };
          if (projectWorkflows) void loadProgressFolders();
        }
      }).catch(() => { if (activeRef.current) setRootWatchFailed(true); });
      if (projectRootScopeSelected) setScopeRefreshToken(current => current + 1);
      else if (recursiveFlatOpen || currentFolderRecursiveSearchActive) setRecentRefreshToken(current => current + 1);
      else {
        const currentPath = normalizeProjectRelativePath(currentRelativePathRef.current);
        void refresh(currentPath, { includeProjectContents: !currentPath }).catch(() => undefined);
      }
    }, PROJECT_WATCH_FALLBACK_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [active, currentFolderRecursiveSearchActive, externalWatchRevision, loadProgressFolders, project.name, project.path, project.status, projectRootScopeSelected, projectWorkflows, recursiveFlatOpen, rootWatchFailed, watchRootDirectly, workspacePath]);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let progressFolderTimer: number | undefined;
    let refreshProjectContents = false;
    const pendingRecursiveDirectories = new Set<string>();
    const normalizedWorkspaceRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
    const normalizedProjectPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const projectPrefix = rootRelativeFileEvents
      ? ''
      : normalizedProjectPath.toLocaleLowerCase().startsWith(`${normalizedWorkspaceRoot}/`)
        ? normalizedProjectPath.slice(normalizedWorkspaceRoot.length + 1)
        : project.name.replace(/\\/g, '/');
    const unsubscribe = projectWorkspaceClient.onWorkspaceFilesChanged(change => {
      if (change.root && change.root.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() !== normalizedWorkspaceRoot) return;
      if (change.watcherFailed && watchRootDirectly) setRootWatchFailed(true);
      const changedPath = (change.fileName || '').replace(/\\/g, '/');
      if (!changedPath) refreshProjectContents = true;
      if (change.eventType === 'rename' && /(?:^|\/)[^/]+\.lnk$/i.test(changedPath)) setExternalWatchRevision(current => current + 1);
      // A change in another project should never make a photo-heavy folder redraw.
      if (projectPrefix && changedPath && changedPath !== projectPrefix && !changedPath.startsWith(`${projectPrefix}/`)) return;
      // Content writes are handled by thumbnail/media tracking. Re-reading the
      // whole directory is only necessary when its membership may have changed.
      if (change.eventType === 'change') {
        // Media writes are reflected by thumbnail events, but ordinary files
        // still need their lightweight details and parent listing refreshed.
        const extension = changedPath.split('.').pop()?.toLocaleLowerCase() || '';
        if (/^(?:avif|bmp|gif|heic|heif|jpe?g|png|raw|tiff?|webp|mp4|mov|mkv|avi|webm|m4v)$/.test(extension)) return;
      }
      if (changedPath) {
        const projectRelativePath = !projectPrefix ? changedPath : changedPath === projectPrefix ? '' : changedPath.slice(projectPrefix.length + 1);
        if (!projectRelativePath || !projectRelativePath.includes('/')) refreshProjectContents = true;
        if (projectWorkflows && (!projectRelativePath || !projectRelativePath.includes('/'))) {
          window.clearTimeout(progressFolderTimer);
          progressFolderTimer = window.setTimeout(() => void loadProgressFolders(), 550);
        }
        const changedParentPath = projectRelativePath.split('/').slice(0, -1).join('/');
        const currentPath = currentRelativePathRef.current.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (changedParentPath !== currentPath) directoryEntriesCacheRef.current.delete(normalizeProjectRelativePath(changedParentPath));
        if (projectRootScopeSelected) {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => setScopeRefreshToken(current => current + 1), 350);
          return;
        }
        if (recursiveFlatOpen || currentFolderRecursiveSearchActive) {
          const normalizedChangedPath = normalizeProjectRelativePath(projectRelativePath);
          const affectsRecursiveScope = !currentPath
            || normalizedChangedPath === currentPath
            || normalizedChangedPath.startsWith(`${currentPath}/`);
          if (!affectsRecursiveScope) return;
          pendingRecursiveDirectories.add(normalizeProjectRelativePath(changedParentPath));
          if (normalizedChangedPath === currentPath) pendingRecursiveDirectories.add(normalizedChangedPath);
          const changedPathWasLoadedFolder = Boolean(normalizedChangedPath) && searchEntriesRef.current.some(entry => {
            if (entry.viaShortcut) return false;
            const entryPath = normalizeProjectRelativePath(entry.relativePath);
            return projectRelativeParentPath(entryPath) === normalizedChangedPath || entryPath.startsWith(`${normalizedChangedPath}/`);
          });
          if (changedPathWasLoadedFolder) pendingRecursiveDirectories.add(normalizedChangedPath);
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            const directories = [...pendingRecursiveDirectories];
            pendingRecursiveDirectories.clear();
            for (const directory of directories) void refreshRecursiveDirectory(directory);
          }, 350);
          return;
        }
        const affectsCurrentDirectory = !projectRelativePath
          || changedParentPath === currentPath
          || projectRelativePath === currentPath
          || Boolean(currentPath && currentPath.startsWith(`${projectRelativePath}/`));
        if (!affectsCurrentDirectory) return;
      }
      if (!changedPath) {
        const currentPath = normalizeProjectRelativePath(currentRelativePathRef.current);
        const currentEntries = directoryEntriesCacheRef.current.get(currentPath) ?? (renderedDirectoryRef.current.ready ? fileEntriesRef.current : undefined);
        directoryEntriesCacheRef.current.clear();
        if (currentEntries) directoryEntriesCacheRef.current.set(currentPath, currentEntries);
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const includeProjectContents = refreshProjectContents;
        refreshProjectContents = false;
        refresh(currentRelativePathRef.current, { includeProjectContents });
        if (finalViewOpen) void loadFinalViewEntries();
      }, 500);
    });
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(progressFolderTimer);
      unsubscribe();
    };
  }, [active, workspacePath, project.path, project.status, project.name, rootRelativeFileEvents, watchRootDirectly, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB, currentFolderRecursiveSearchActive, finalViewOpen, loadFinalViewEntries, projectWorkflows, loadProgressFolders, projectRootScopeSelected, recursiveFlatOpen, refreshRecursiveDirectory]);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = projectWorkspaceClient.onThumbnailStateChanged(update => {
      if (update.state !== 'STALE') return;
      const changedPath = update.filePath.replace(/\\/g, '/').toLocaleLowerCase();
      const applySourceRevision = (entries: ProjectFileEntry[]) => {
        let changed = false;
        const next = entries.map(entry => {
          if (entry.path.replace(/\\/g, '/').toLocaleLowerCase() !== changedPath) return entry;
          changed = true;
          return {
            ...entry,
            size: update.sourceSize ?? entry.size,
            updatedAt: update.sourceMtimeMs ?? Date.now(),
            previewUrl: undefined,
          };
        });
        return changed ? next : entries;
      };
      forgetMediaThumbnailPreviews(update.filePath);
      for (const [relativePath, entries] of directoryEntriesCacheRef.current) {
        const next = applySourceRevision(entries);
        if (next !== entries) directoryEntriesCacheRef.current.set(relativePath, next);
      }
      setFileEntries(applySourceRevision);
      setSearchEntries(applySourceRevision);
      setFinalViewEntries(applySourceRevision);
    });
    return unsubscribe;
  }, [active, previewOnlyOnMediaClick]);
  useEffect(() => {
    const query = searchQuery.trim();
    const requestIdentity = [
      active ? 'active' : 'inactive',
      recursiveFlatOpen ? 'all-files' : currentFolderRecursiveSearchActive ? 'folder-search' : 'closed',
      finalViewOpen ? 'final' : 'files',
      workspacePath,
      project.status,
      project.name,
      normalizeProjectRelativePath(currentRelativePath),
      query,
    ].join('\0');
    const retainExistingEntries = shouldRetainGroupedResultsDuringRefresh(
      searchRequestIdentityRef.current,
      requestIdentity,
      searchEntriesRef.current.length,
    );
    searchRequestIdentityRef.current = requestIdentity;
    searchSequenceRef.current += 1;
    const sequence = searchSequenceRef.current;
    const previousCursor = recentCursorRef.current;
    recentCursorRef.current = '';
    if (previousCursor) void projectWorkspaceClient.cancelRecentProjectFiles(previousCursor).catch(() => undefined);
    if (!active || !(recursiveFlatOpen || currentFolderRecursiveSearchActive) || finalViewOpen) {
      setSearchEntries([]);
      setSearchLoading(false);
      setSearchError('');
      setRecentCursor('');
      setRecentHasMore(false);
      setRecentLoadingMore(false);
      setRecentLoadError('');
      recentLoadInFlightRef.current = false;
      return;
    }
    if (!retainExistingEntries) setSearchEntries([]);
    setSearchLoading(true);
    setSearchError('');
    setRecentCursor('');
    setRecentHasMore(false);
    setRecentLoadingMore(false);
    setRecentLoadError('');
    recentLoadInFlightRef.current = false;
    const timer = window.setTimeout(() => {
      const request = query
        ? projectWorkspaceClient.searchProjectFiles(workspacePath, project.status, project.name, currentRelativePath, query)
        : projectWorkspaceClient.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE);
      void request.then(result => {
        if (sequence !== searchSequenceRef.current || !active) {
          const staleRecentResult = result as { success: boolean; cursor?: string };
          if (!query && staleRecentResult.success && staleRecentResult.cursor) void projectWorkspaceClient.cancelRecentProjectFiles(staleRecentResult.cursor).catch(() => undefined);
          return;
        }
        if (result.success) {
          setSearchEntries(result.entries);
          const recentResult = result as { cursor?: string; hasMore?: boolean };
          const nextCursor = !query ? recentResult.cursor || '' : '';
          recentCursorRef.current = nextCursor;
          setRecentCursor(nextCursor);
          setRecentHasMore(!query && Boolean(recentResult.hasMore));
        }
        else {
          if (!retainExistingEntries) setSearchEntries([]);
          setRecentCursor('');
          setRecentHasMore(false);
          setSearchError(result.error || '搜索失败');
        }
      }).catch(error => {
        if (sequence !== searchSequenceRef.current) return;
        if (!retainExistingEntries) setSearchEntries([]);
        setRecentHasMore(false);
        setSearchError(error instanceof Error ? error.message : '搜索失败');
      }).finally(() => {
        if (sequence === searchSequenceRef.current) setSearchLoading(false);
      });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      if (sequence === searchSequenceRef.current) searchSequenceRef.current += 1;
      const cursor = recentCursorRef.current;
      recentCursorRef.current = '';
      if (cursor) void projectWorkspaceClient.cancelRecentProjectFiles(cursor).catch(() => undefined);
    };
  }, [active, searchQuery, recursiveFlatOpen, currentFolderRecursiveSearchActive, currentRelativePath, finalViewOpen, workspacePath, project.status, project.name, recentRefreshToken]);
  const loadMoreRecentFiles = useCallback(async () => {
    if (!active || !recursiveFlatOpen || searchQuery.trim() || finalViewOpen || !recentHasMore || !recentCursor || recentLoadInFlightRef.current) return;
    recentLoadInFlightRef.current = true;
    setRecentLoadingMore(true);
    setRecentLoadError('');
    const sequence = searchSequenceRef.current;
    try {
      let sessionWasRecreated = false;
      let result = await projectWorkspaceClient.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE, recentCursor);
      if (sequence !== searchSequenceRef.current || !active) {
        if (result.success && result.cursor) void projectWorkspaceClient.cancelRecentProjectFiles(result.cursor).catch(() => undefined);
        return;
      }
      if (!result.success && result.errorCode === RECENT_FILES_SESSION_EXPIRED) {
        sessionWasRecreated = true;
        result = await projectWorkspaceClient.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE);
        if (sequence !== searchSequenceRef.current || !active) {
          if (result.success && result.cursor) void projectWorkspaceClient.cancelRecentProjectFiles(result.cursor).catch(() => undefined);
          return;
        }
      }
      if (!result.success) {
        setRecentHasMore(false);
        setRecentLoadError(result.error || '继续读取所有文件失败');
        return;
      }
      setSearchEntries(current => {
        if (sessionWasRecreated) return result.entries;
        const existing = new Set(current.map(entry => entry.path.toLocaleLowerCase()));
        return [...current, ...result.entries.filter(entry => !existing.has(entry.path.toLocaleLowerCase()))];
      });
      recentCursorRef.current = result.cursor || '';
      setRecentCursor(result.cursor || '');
      setRecentHasMore(Boolean(result.hasMore));
    } catch (error) {
      if (sequence === searchSequenceRef.current) {
        setRecentHasMore(false);
        setRecentLoadError(error instanceof Error ? error.message : '继续读取所有文件失败');
      }
    } finally {
      if (sequence === searchSequenceRef.current) {
        recentLoadInFlightRef.current = false;
        setRecentLoadingMore(false);
      }
    }
  }, [active, currentRelativePath, finalViewOpen, project.name, project.status, recentCursor, recentHasMore, recursiveFlatOpen, searchQuery, workspacePath]);
  useRecentFilesAutoLoad(
    active,
    recursiveFlatOpen && !searchQuery.trim() && !finalViewOpen && recentHasMore,
    filesColumnRef,
    loadMoreRecentFiles,
    `${recentLoadingMore}:${searchEntries.length}`,
    RECENT_FILES_LOAD_AHEAD_PX,
  );
  const projectRootFilterActive = filterScope === 'project-root' && !recursiveFlatOpen && !versionTreeOpen && !finalViewOpen;
  const scopeFileListFilter = useMemo<ProjectFileListFilter>(() => ({
    query: searchQuery,
    ...(fileFilter === 'video' ? { kinds: ['video'] }
      : fileFilter === 'image' ? { kinds: ['image', 'raw', 'file'] }
        : fileFilter === 'media' ? { kinds: ['image', 'raw', 'video', 'file'] }
          : {}),
  }), [fileFilter, searchQuery]);
  const replaceScopeCursor = useCallback((cursor: string) => {
    scopeCursorRef.current = cursor;
    setScopeCursor(cursor);
  }, []);
  const cancelScopeSession = useCallback(() => {
    const cursor = scopeCursorRef.current;
    replaceScopeCursor('');
    if (cursor) void projectWorkspaceClient.cancelListProjectFiles(cursor).catch(() => undefined);
  }, [replaceScopeCursor]);
  const changeFilterScope = useCallback((scope: ProjectFilterScope) => {
    if (scope === filterScope) return;
    scopeRequestSequenceRef.current += 1;
    cancelScopeSession();
    scopeLoadInFlightRef.current = false;
    setScopeEntries([]);
    setScopeHasMore(false);
    setScopeLoading(false);
    setScopeLoadingMore(false);
    setScopeError('');
    selectionAnchorPathRef.current = '';
    setSelectedPaths([]);
    setFilterScope(scope);
  }, [cancelScopeSession, filterScope]);
  useEffect(() => {
    const requestIdentity = [
      active ? 'active' : 'inactive',
      projectRootFilterActive ? 'project-root' : 'closed',
      workspacePath,
      project.status,
      project.name,
      JSON.stringify(scopeFileListFilter),
    ].join('\0');
    const retainExistingEntries = shouldRetainGroupedResultsDuringRefresh(
      scopeRequestIdentityRef.current,
      requestIdentity,
      scopeEntriesRef.current.length,
    );
    scopeRequestIdentityRef.current = requestIdentity;
    scopeRequestSequenceRef.current += 1;
    const sequence = scopeRequestSequenceRef.current;
    cancelScopeSession();
    scopeLoadInFlightRef.current = false;
    if (!retainExistingEntries) setScopeEntries([]);
    setScopeHasMore(false);
    setScopeLoadingMore(false);
    setScopeError('');
    if (!active || !projectRootFilterActive) {
      setScopeLoading(false);
      return;
    }
    setScopeLoading(true);
    void projectWorkspaceClient.listProjectFiles(workspacePath, project.status, project.name, '', FILE_LIST_PAGE_SIZE, undefined, scopeFileListFilter).then(result => {
      if (sequence !== scopeRequestSequenceRef.current) {
        if (result.cursor) void projectWorkspaceClient.cancelListProjectFiles(result.cursor).catch(() => undefined);
        return;
      }
      if (!result.success) {
        setScopeError(result.errorCode === FILE_LIST_CANCELLED ? '' : result.error || '读取项目文件失败');
        return;
      }
      setScopeEntries(result.entries);
      replaceScopeCursor(result.cursor || '');
      setScopeHasMore(Boolean(result.hasMore));
    }).catch(error => {
      if (sequence !== scopeRequestSequenceRef.current) return;
      setScopeHasMore(false);
      setScopeError(error instanceof Error ? error.message : '读取项目文件失败');
    }).finally(() => {
      if (sequence === scopeRequestSequenceRef.current) setScopeLoading(false);
    });
    return () => {
      scopeRequestSequenceRef.current += 1;
      cancelScopeSession();
    };
  }, [active, cancelScopeSession, project.name, project.status, projectRootFilterActive, replaceScopeCursor, scopeFileListFilter, scopeRefreshToken, workspacePath]);
  const loadMoreScopeFiles = useCallback(async () => {
    if (!active || !projectRootFilterActive || !scopeHasMore || !scopeCursor || scopeLoadInFlightRef.current) return;
    scopeLoadInFlightRef.current = true;
    setScopeLoadingMore(true);
    const sequence = scopeRequestSequenceRef.current;
    try {
      const result = await projectWorkspaceClient.listProjectFiles(workspacePath, project.status, project.name, '', FILE_LIST_PAGE_SIZE, scopeCursor, scopeFileListFilter);
      if (sequence !== scopeRequestSequenceRef.current) {
        if (result.cursor) void projectWorkspaceClient.cancelListProjectFiles(result.cursor).catch(() => undefined);
        return;
      }
      if (!result.success) {
        replaceScopeCursor('');
        setScopeHasMore(false);
        if (result.errorCode === FILE_LIST_SESSION_EXPIRED) setScopeRefreshToken(value => value + 1);
        else if (result.errorCode !== FILE_LIST_CANCELLED) setScopeError(result.error || '继续读取项目文件失败');
        return;
      }
      setScopeEntries(current => [...current, ...result.entries]);
      replaceScopeCursor(result.cursor || '');
      setScopeHasMore(Boolean(result.hasMore));
    } catch (error) {
      if (sequence === scopeRequestSequenceRef.current) {
        replaceScopeCursor('');
        setScopeHasMore(false);
        setScopeError(error instanceof Error ? error.message : '继续读取项目文件失败');
      }
    } finally {
      if (sequence === scopeRequestSequenceRef.current) {
        scopeLoadInFlightRef.current = false;
        setScopeLoadingMore(false);
      }
    }
  }, [active, project.name, project.status, projectRootFilterActive, replaceScopeCursor, scopeCursor, scopeFileListFilter, scopeHasMore, workspacePath]);
  useEffect(() => {
    if (!projectRootFilterActive || !scopeHasMore) return;
    const container = filesColumnRef.current;
    if (!container) return;
    let frame = 0;
    const loadNearBottom = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (container.scrollHeight - container.scrollTop - container.clientHeight <= RECENT_FILES_LOAD_AHEAD_PX) void loadMoreScopeFiles();
      });
    };
    loadNearBottom();
    container.addEventListener('scroll', loadNearBottom, { passive: true });
    return () => { window.cancelAnimationFrame(frame); container.removeEventListener('scroll', loadNearBottom); };
  }, [loadMoreScopeFiles, projectRootFilterActive, scopeEntries.length, scopeHasMore, scopeLoadingMore]);
  useEffect(() => {
    const closeMenus = () => {
      const keepToolbarOverflowOpen = Boolean(document.activeElement?.closest('.project-toolbar-overflow-menu'));
      setFileMenu(null);
      setSurfaceMenu(null);
      setShowStatusMenu(false);
      setShowCreateMenu(false);
      setShowImportMenu(false);
      setShowVideoToolsMenu(false);
      setShowImageToolsMenu(false);
      if (!keepToolbarOverflowOpen) setShowToolbarOverflowMenu(false);
      setShowSortMenu(false);
      setShowFilterMenu(false);
    };
    window.addEventListener('click', closeMenus);
    window.addEventListener('photoflow-menu-open', closeMenus);
    return () => { window.removeEventListener('click', closeMenus); window.removeEventListener('photoflow-menu-open', closeMenus); };
  }, []);
  useEffect(() => {
    const closeToolbarOverflow = () => setShowToolbarOverflowMenu(false);
    window.addEventListener('resize', closeToolbarOverflow);
    window.visualViewport?.addEventListener('resize', closeToolbarOverflow);
    return () => {
      window.removeEventListener('resize', closeToolbarOverflow);
      window.visualViewport?.removeEventListener('resize', closeToolbarOverflow);
    };
  }, []);
  const recursiveSearchActive = (recursiveFlatOpen || currentFolderRecursiveSearchActive || projectRootFilterActive) && !finalViewOpen;
  const groupedResultsActive = (recursiveFlatOpen || currentFolderRecursiveSearchActive || projectRootFilterActive) && !finalViewOpen;
  const authoritativeActiveFileEntries = projectRootFilterActive ? scopeEntries : recursiveFlatOpen || currentFolderRecursiveSearchActive ? searchEntries : finalViewOpen ? finalViewEntries : fileEntries;
  const activeFileEntries = useMemo(() => finalViewOpen
    ? authoritativeActiveFileEntries
    : applyPendingFileOperations(
      authoritativeActiveFileEntries,
      projectRootFilterActive || recursiveFlatOpen || currentFolderRecursiveSearchActive ? undefined : currentRelativePath,
      pendingFileOperations,
    ), [authoritativeActiveFileEntries, currentFolderRecursiveSearchActive, currentRelativePath, finalViewOpen, pendingFileOperations, projectRootFilterActive, recursiveFlatOpen]);
  const currentDirectoryFolders = useMemo(() => fileEntries.filter(isFolderLikeEntry), [fileEntries]);
  const folderAlphabetKeys = useMemo(() => availableFolderAlphabetKeys(currentDirectoryFolders.map(entry => entry.name)), [currentDirectoryFolders]);
  const folderAlphabetFilterVisible = folderAlphabetFilterEnabled && browseMode === 'grid' && !finalViewOpen && !recursiveSearchActive && !searchQuery.trim() && fileFilter === 'all' && ratingFilter === 'all' && currentDirectoryFolders.length > FOLDER_ALPHABET_FILTER_THRESHOLD;
  useEffect(() => {
    filterRatingSequenceRef.current += 1;
    const sequence = filterRatingSequenceRef.current;
    setFilterRatingsCheckedCount(0);
    if (!active || ratingFilter === 'all') {
      setFilterRatingsLoading(false);
      return;
    }
    const ratingEntries = activeFileEntries.filter(entry => (!entry.viaShortcut || entry.viaExternalLink) && (entry.kind === 'image' || entry.kind === 'raw'));
    const cachedRatings: Record<string, number> = {};
    const pending = ratingEntries.filter(entry => {
      if (typeof entry.rating === 'number') {
        cachedRatings[entry.path] = entry.rating;
        return false;
      }
      const cacheKey = mediaRatingCacheKey(entry.path, entry.updatedAt || 0);
      const cached = previewRatingCacheRef.current.get(cacheKey);
      if (cached === undefined) return true;
      cachedRatings[entry.path] = cached;
      return false;
    });
    setFilterRatings(cachedRatings);
    setFilterRatingsCheckedCount(Object.keys(cachedRatings).length);
    if (!pending.length) {
      setFilterRatingsLoading(false);
      return;
    }
    setFilterRatingsLoading(true);
    const readPendingRatings = async () => {
      const collected = { ...cachedRatings };
      for (let offset = 0; offset < pending.length; offset += 200) {
        const batch = pending.slice(offset, offset + 200);
        const result = await projectWorkspaceClient.getMediaRatings(batch.map(entry => ({ path: entry.path, updatedAt: entry.updatedAt || 0 })));
        if (sequence !== filterRatingSequenceRef.current) return;
        for (const item of result.results || []) {
          const rating = item.success ? item.rating : 0;
          previewRatingCacheRef.current.set(mediaRatingCacheKey(item.path, item.updatedAt || 0), rating);
          collected[item.path] = rating;
        }
        setFilterRatings({ ...collected });
        setFilterRatingsCheckedCount(Object.keys(collected).length);
      }
    };
    void readPendingRatings().catch(() => {
      if (sequence === filterRatingSequenceRef.current) setFilterRatings(cachedRatings);
    }).finally(() => {
      if (sequence === filterRatingSequenceRef.current) setFilterRatingsLoading(false);
    });
    return () => { filterRatingSequenceRef.current += 1; };
  }, [active, activeFileEntries, filterScope, ratingFilter]);
  const displayedFileEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('zh-CN');
    const queryFiltered = normalizedQuery && !recursiveSearchActive ? activeFileEntries.filter(entry => entry.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) : activeFileEntries;
    let filtered = fileFilter === 'all' ? queryFiltered : queryFiltered.filter(entry => {
      if (fileFilter === 'image') return isPhotoshopOpenEntry(entry);
      if (fileFilter === 'video') return entry.kind === 'video';
      return isPhotoshopOpenEntry(entry) || entry.kind === 'video';
    });
    if (ratingFilter !== 'all') {
      filtered = filtered.filter(entry => {
        const rating = typeof entry.rating === 'number' ? entry.rating : filterRatings[entry.path] || 0;
        return ratingFilter === 'rated' ? rating > 0 : rating === Number(ratingFilter);
      });
    }
    if (folderAlphabetFilterVisible && folderAlphabetFilter) {
      filtered = filtered.filter(entry => isFolderLikeEntry(entry) && folderAlphabetKey(entry.name) === folderAlphabetFilter);
    }
    return sortProjectFileEntries(filtered, sortField, sortDirection);
  }, [activeFileEntries, fileFilter, filterRatings, folderAlphabetFilter, folderAlphabetFilterVisible, ratingFilter, searchQuery, recursiveSearchActive, sortDirection, sortField]);
  useEffect(() => {
    const pending = pendingDirectoryReturnRevealRef.current;
    if (!pending || pending.directoryPath !== normalizeProjectRelativePath(currentRelativePath) || directoryLoading) return;
    pendingDirectoryReturnRevealRef.current = null;
    const returnedFolder = fileEntries.find(entry => isFolderLikeEntry(entry) && normalizeProjectRelativePath(entry.relativePath) === pending.entryPath);
    if (!returnedFolder) return;
    selectionAnchorPathRef.current = '';
    setSelectedPaths([]);
    setDirectoryReturnHighlightPath(returnedFolder.relativePath);
    requestFileReveal(returnedFolder.relativePath);
  }, [currentRelativePath, directoryLoading, fileEntries, requestFileReveal]);
  const filteredFileTypeLabel = fileFilter === 'all' ? '文件' : PROJECT_FILE_FILTER_OPTIONS.find(option => option.value === fileFilter)?.label || '文件';
  const searchResultGroups = useMemo(() => {
    if (!groupedResultsActive) return [];
    const groups = new Map<string, ProjectFileEntry[]>();
    for (const entry of displayedFileEntries) {
      const normalizedPath = entry.relativePath.replace(/\\/g, '/');
      const folderPath = entry.parentRelativePath?.replace(/\\/g, '/') ?? normalizedPath.split('/').slice(0, -1).join('/');
      const items = groups.get(folderPath) || [];
      items.push(entry);
      groups.set(folderPath, items);
    }
    const orderedGroups = [...groups.entries()].sort(([leftPath, leftEntries], [rightPath, rightEntries]) => {
      if (recursiveFlatOpen && !searchQuery.trim()) {
        const leftNewest = Math.max(0, ...leftEntries.map(entry => entry.updatedAt));
        const rightNewest = Math.max(0, ...rightEntries.map(entry => entry.updatedAt));
        if (leftNewest !== rightNewest) return rightNewest - leftNewest;
      }
      return leftPath.localeCompare(rightPath, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
    if (!recursiveFlatOpen || searchQuery.trim()) return orderedGroups;
    const identity = `${project.path}\0${normalizeProjectRelativePath(currentRelativePath)}\0all-files`;
    if (recursiveGroupOrderRef.current.identity !== identity) recursiveGroupOrderRef.current = { identity, paths: [] };
    const paths = retainStableGroupOrder(recursiveGroupOrderRef.current.paths, orderedGroups.map(([folderPath]) => folderPath));
    recursiveGroupOrderRef.current = { identity, paths };
    const orderByPath = new Map(paths.map((folderPath, index) => [folderPath, index]));
    return orderedGroups.sort(([leftPath], [rightPath]) => (orderByPath.get(leftPath) ?? Number.MAX_SAFE_INTEGER) - (orderByPath.get(rightPath) ?? Number.MAX_SAFE_INTEGER));
  }, [currentRelativePath, displayedFileEntries, groupedResultsActive, project.path, recursiveFlatOpen, searchQuery]);
  const groupedLoading = projectRootFilterActive ? scopeLoading : searchLoading;
  const groupedError = projectRootFilterActive ? scopeError : searchError;
  const groupedLoadingMore = projectRootFilterActive ? scopeLoadingMore : recentLoadingMore;
  const groupedLoadError = projectRootFilterActive ? scopeError : recentLoadError;
  const groupedHasMore = projectRootFilterActive ? scopeHasMore : recentHasMore;
  const groupedInitialLoading = groupedResultsAreInitiallyLoading(groupedLoading, searchResultGroups.length);
  const renderedFileEntries = displayedFileEntries.slice(virtualWindow.start, virtualWindow.end);
  const pathSegments = currentRelativePath.split(/[\\/]/).filter(Boolean);
  const browserRootLabel = gatherToProject ? browserContext.title : project.name;
  const recursiveScopeLabel = currentRelativePath ? '当前文件夹及其子文件夹' : inspirationMode ? '整个灵感库' : '整个项目';
  const breadcrumbs = pathSegments.map((label, index) => ({
    label: label.toLocaleLowerCase().endsWith('.lnk') ? label.slice(0, -4) : label,
    relativePath: pathSegments.slice(0, index + 1).join('/'),
    externalLink: currentDirectoryViaExternalLink && normalizeProjectRelativePath(pathSegments.slice(0, index + 1).join('/')) === currentExternalLinkRootPath,
  }));
  useEffect(() => { setVirtualWindow({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 }); }, [browseMode, currentRelativePath, fileFilter, filterScope, ratingFilter, finalViewOpen, sortField, sortDirection, searchQuery]);
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
        const surfaceWidth = Math.max(1, surface.clientWidth);
        const measuredItem = surface.querySelector<HTMLElement>('[data-entry-path]');
        const gridGeometry = viewMode === 'grid' ? calculateFileGridGeometry(surfaceWidth, gridIconSize, measuredItem?.getBoundingClientRect().height) : null;
        const columns = gridGeometry?.columns || 1;
        const rowHeight = gridGeometry?.rowHeight || FILE_LIST_ROW_HEIGHT;
        const rowPitch = gridGeometry?.rowPitch || FILE_LIST_ROW_HEIGHT;
        const rowCount = Math.ceil(displayedFileEntries.length / columns);
        const firstRow = Math.max(0, Math.floor(visibleTop / rowPitch) - FILE_VIRTUAL_OVERSCAN_ROWS);
        const lastRow = Math.min(rowCount, Math.ceil((visibleTop + container.clientHeight) / rowPitch) + FILE_VIRTUAL_OVERSCAN_ROWS);
        const next = {
          start: firstRow * columns,
          end: Math.min(displayedFileEntries.length, lastRow * columns),
          top: firstRow * rowPitch,
          bottom: Math.max(0, (rowCount - lastRow) * rowPitch),
          rowHeight,
          columns,
        };
        setVirtualWindow(current => current.start === next.start && current.end === next.end && Math.abs(current.top - next.top) < 1 && Math.abs(current.bottom - next.bottom) < 1 && Math.abs(current.rowHeight - next.rowHeight) < 1 && current.columns === next.columns ? current : next);
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
  }, [currentRelativePath, finalViewOpen, displayedFileEntries.length, viewMode, gridIconSize, previewPaneOpen, metadataPaneOpen, sortField, sortDirection, searchQuery]);
  useEffect(() => {
    if (sortField === 'name') return;
    const missingPaths = fileEntries.filter(entry => entry.updatedAt === 0 || entry.size < 0).map(entry => entry.relativePath);
    if (!missingPaths.length) return;
    let active = true;
    const directoryPath = currentRelativePath;
    const chunks = Array.from({ length: Math.ceil(missingPaths.length / 500) }, (_value, index) => missingPaths.slice(index * 500, (index + 1) * 500));
    Promise.all(chunks.map(paths => projectWorkspaceClient.getProjectFileDetails(workspacePath, project.status, project.name, paths))).then(results => {
      if (!active || directoryPath !== currentRelativePathRef.current) return;
      const detailsByPath = new Map(results.flatMap(result => result.success ? result.details : []).map(detail => [detail.relativePath, detail]));
      if (!detailsByPath.size) return;
      setFileEntries(current => {
        let changed = false;
        const next = current.map(entry => {
          const detail = detailsByPath.get(entry.relativePath);
          if (!detail || entry.size === detail.size && entry.createdAt === detail.createdAt && entry.updatedAt === detail.updatedAt) return entry;
          changed = true;
          return { ...entry, size: detail.size, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
        });
        if (!changed) return current;
        directoryEntriesCacheRef.current.set(directoryPath, next);
        return next;
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [sortField, fileEntries, currentRelativePath, workspacePath, project.status, project.name]);
  useEffect(() => {
    const missingDetails = renderedFileEntries.filter(entry => entry.updatedAt === 0).map(entry => entry.relativePath);
    if (!missingDetails.length) return;
    let active = true;
    const directoryPath = currentRelativePath;
    projectWorkspaceClient.getProjectFileDetails(workspacePath, project.status, project.name, missingDetails).then(result => {
      if (!active || directoryPath !== currentRelativePathRef.current || !result.success || !result.details.length) return;
      const detailsByPath = new Map(result.details.map(detail => [detail.relativePath, detail]));
      setFileEntries(current => {
        let changed = false;
        const next = current.map(entry => {
          const detail = detailsByPath.get(entry.relativePath);
          if (!detail || entry.size === detail.size && entry.createdAt === detail.createdAt && entry.updatedAt === detail.updatedAt) return entry;
          changed = true;
          return { ...entry, size: detail.size, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
        });
        if (!changed) return current;
        directoryEntriesCacheRef.current.set(directoryPath, next);
        return next;
      });
    }).catch(() => undefined);
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
        const entriesByPath = new Map(activeFileEntries.map(entry => [entry.relativePath, entry]));
        let currentPath = '';
        let currentScore = Number.NEGATIVE_INFINITY;
        for (const node of filesSurface.querySelectorAll<HTMLElement>('[data-entry-path]')) {
          const path = node.dataset.entryPath || '';
          if (!path || (entriesByPath.get(path) && isFolderLikeEntry(entriesByPath.get(path)!))) continue;
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
  }, [activeFileEntries, virtualWindow.start, virtualWindow.end, viewMode, gridIconSize, previewPaneOpen, metadataPaneOpen]);

  const loadDirectoryPreviewEntries = useCallback((entry: ProjectFileEntry) => {
    if (entry.kind !== 'folder' && entry.kind !== 'shortcut') return Promise.resolve({ entries: [], authoritative: true });
    const pendingEntry = entry as PendingProjectFileEntry;
    const pendingRename = Boolean(pendingEntry.pendingSourceRelativePath);
    const cacheKey = directoryPreviewCacheKey(entry);
    const applyShortcutState = (state: Pick<ProjectFileEntry, 'shortcutTargetKind' | 'shortcutBroken'>) => {
      const applyState = (entries: ProjectFileEntry[]) => applyShortcutPreviewState(entries, entry.path, entry.updatedAt, state);
      setFileEntries(applyState);
      setScopeEntries(applyState);
      setSearchEntries(applyState);
      for (const [directoryKey, entries] of directoryEntriesCacheRef.current) {
        const next = applyState(entries);
        if (next !== entries) directoryEntriesCacheRef.current.set(directoryKey, next);
      }
    };
    const optimisticCached = pendingRename ? optimisticDirectoryEntriesCacheRef.current.get(cacheKey) : undefined;
    if (optimisticCached) return Promise.resolve({ entries: optimisticCached, authoritative: true });
    const sourceCacheKey = pendingDirectoryPreviewSourceCacheKey(pendingEntry);
    const sourceCached = sourceCacheKey ? directoryEntriesCacheRef.current.get(sourceCacheKey) : undefined;
    if (sourceCached) {
      const remapped = remapPendingDirectoryPreviewEntries(pendingEntry, sourceCached);
      if (remapped) {
        // A cold optimistic read may already be in flight against a path that
        // does not exist yet. Retire it before promoting the authoritative
        // source cache so its late empty result cannot overwrite this cover.
        directoryPreviewRequestTokensRef.current.delete(cacheKey);
        directoryPrefetchesRef.current.delete(cacheKey);
        optimisticDirectoryEntriesCacheRef.current.set(cacheKey, remapped);
        return Promise.resolve({ entries: remapped, authoritative: true });
      }
    }
    // The predicted target is not an authoritative read location until the
    // filesystem transaction commits. In a name swap it is the *other* source
    // directory, so a cold read here would capture the wrong cover.
    if (pendingRename) return Promise.resolve({ entries: [], authoritative: false });
    const cached = directoryEntriesCacheRef.current.get(cacheKey);
    if (cached) {
      const shortcutState = shortcutPreviewStatesRef.current.get(cacheKey);
      if (shortcutState) applyShortcutState(shortcutState);
      return Promise.resolve({ entries: cached, authoritative: true });
    }
    const pending = directoryPrefetchesRef.current.get(cacheKey);
    if (pending) return pending;
    const requestedProjectPath = project.path;
    type BrowseResult = { success: boolean; entries: ProjectFileEntry[]; shortcutTargetKind?: 'folder' | 'file'; shortcutBroken?: boolean };
    const browse = (): Promise<BrowseResult> => entry.kind === 'shortcut' && !entry.externalLink
      ? projectWorkspaceClient.browseProjectShortcutPreview(workspacePath, project.status, project.name, entry.relativePath).then(result => ({ success: result.success, entries: result.entries, shortcutTargetKind: result.success && result.targetKind ? result.targetKind : undefined, shortcutBroken: !result.success }))
      : projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, entry.relativePath, mediaCacheConfig);
    const browseRequest = (async () => {
      let result: BrowseResult = { success: false, entries: [] };
      for (let attempt = 0; attempt <= DIRECTORY_PREVIEW_RETRY_DELAYS_MS.length; attempt += 1) {
        try { result = await browse(); }
        catch { result = { success: false, entries: [], shortcutBroken: entry.kind === 'shortcut' && !entry.externalLink }; }
        if (shouldCacheDirectoryPreviewResult(pendingRename, result) || attempt === DIRECTORY_PREVIEW_RETRY_DELAYS_MS.length) return result;
        await new Promise<void>(resolve => window.setTimeout(resolve, DIRECTORY_PREVIEW_RETRY_DELAYS_MS[attempt]));
      }
      return result;
    })();
    const requestToken = Symbol(cacheKey);
    directoryPreviewRequestTokensRef.current.set(cacheKey, requestToken);
    const request = browseRequest
      .then(result => {
        if (requestedProjectPath !== projectPathRef.current || directoryPreviewRequestTokensRef.current.get(cacheKey) !== requestToken) return { entries: [], authoritative: false };
        if (entry.kind === 'shortcut' && !entry.externalLink) {
          const shortcutState = { shortcutTargetKind: result.shortcutTargetKind, shortcutBroken: result.shortcutBroken };
          shortcutPreviewStatesRef.current.set(cacheKey, shortcutState);
          applyShortcutState(shortcutState);
        }
        if (!shouldCacheDirectoryPreviewResult(pendingRename, result)) {
          return { entries: [], authoritative: false };
        }
        if (pendingRename) optimisticDirectoryEntriesCacheRef.current.set(cacheKey, result.entries);
        else directoryEntriesCacheRef.current.set(cacheKey, result.entries);
        return { entries: result.entries, authoritative: true };
      })
      .finally(() => {
        if (directoryPreviewRequestTokensRef.current.get(cacheKey) !== requestToken) return;
        directoryPreviewRequestTokensRef.current.delete(cacheKey);
        directoryPrefetchesRef.current.delete(cacheKey);
      });
    directoryPrefetchesRef.current.set(cacheKey, request);
    return request;
  }, [workspacePath, project.path, project.status, project.name, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB]);
  const prefetchDirectory = (entry: ProjectFileEntry) => {
    if (entry.kind === 'folder' || entry.kind === 'shortcut') void loadDirectoryPreviewEntries(entry);
  };

  const togglePanel = (next: Exclude<ProjectPanel, null>) => setPanel(current => current === next ? null : next);
  const refreshRecursiveResults = (directoryPaths: string | string[] = operationDirectoryPath || currentRelativePath) => {
    if (!recursiveFlatOpen) return;
    const uniqueDirectories = [...new Set((Array.isArray(directoryPaths) ? directoryPaths : [directoryPaths]).map(normalizeProjectRelativePath))];
    for (const directory of uniqueDirectories) void refreshRecursiveDirectory(directory);
  };
  const formatFileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : size < 1024 * 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
  const openFolder = async (folderName?: string) => {
    const result = await projectWorkspaceClient.openWorkspaceProject(workspacePath, project.status, project.name, folderName);
    if (!result.success) onNotice(`打开文件夹失败：${result.error || '未知错误'}`);
  };
  const moveStatus = async (status: WorkspaceProject['status']) => {
    setShowStatusMenu(false);
    if (status === project.status) return;
    const result = await projectWorkspaceClient.moveWorkspaceProject(workspacePath, project.status, project.name, status);
    if (!result.success || !result.project) { onNotice(`更改状态失败：${result.error || '未知错误'}`); return; }
    onProjectMoved(result.project);
  };
  const importBroll = async () => {
    if (!brollSourcePaths.length) return;
    setShowImportMenu(false);
    setPanelImportResult(null);
    setPanelImportBusy('broll');
    try {
      const result = await projectWorkspaceClient.importBroll(workspacePath, project.status, project.name, { splitVideosOnImport: brollConfig.splitVideosOnImport, transcodeVideosOnImport: brollConfig.transcodeVideosOnImport, transcodeSettings: videoTools.transcode, deleteSourceAfterImport: deleteBrollSources, linkOnly: linkBrollSources, sourcePaths: brollSourcePaths });
      const pageOwnsNotice = pageOwnsFileOperationNotification(result);
      if (!result.success) { if (pageOwnsNotice) onNotice(`导入花絮失败：${result.error || '未知错误'}`); return; }
      if (result.cancelled) { if (pageOwnsNotice) onNotice('已取消选择花絮文件。'); return; }
      setPanelImportResult({ kind: 'broll', count: result.count || 0, sourceDeleted: deleteBrollSources });
      if (pageOwnsNotice) onNotice(`已导入 ${result.count || 0} 个花絮文件，源文件${deleteBrollSources ? '已删除' : '已保留'}。`);
      if (result.warning) {
        if (isRecycleBinFailure(result.warning)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
        else if (pageOwnsNotice) onNotice(result.warning, 6000);
      }
      refresh();
    } catch (error) {
      onNotice(`导入花絮失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
    } finally {
      setPanelImportBusy('');
    }
  };
  const chooseBrollFiles = async () => {
    const result = await projectWorkspaceClient.chooseBrollSourceFiles();
    if (!result.cancelled && result.paths.length) setBrollSourcePaths(current => mergeSourcePaths(current, result.paths));
  };
  const chooseFilesToImport = async () => {
    const result = await projectWorkspaceClient.chooseProjectImportFiles();
    if (!result.cancelled && result.paths.length) setFileImportSourcePaths(current => mergeSourcePaths(current, result.paths));
  };
  const handleProjectImportRecovery = async (result: Awaited<ReturnType<typeof projectWorkspaceClient.importProjectFiles>>) => {
    if (!result.recoveryRequired) return false;
    directoryEntriesCacheRef.current.clear(); setFileImportSourcePaths([]); setNegativeSourcePaths([]);
    await Promise.all([refresh(''), projectWorkflows ? loadProgressFolders() : Promise.resolve([])]);
    const cleanupSummary = result.recovery?.cleanupErrors.length ? `\n\n仍有 ${result.recovery.cleanupErrors.length} 项未能自动清理。` : '';
    await appDialog.alert({ title: '导入结果已保留，需要恢复处理', message: `软件已刷新目录和版本树。保留的外链或文件仍然有效，请勿直接重复导入同一来源。${cleanupSummary}`, detail: result.error, confirmLabel: '我知道了' });
    if (pageOwnsFileOperationNotification(result)) onNotice('已刷新保留的导入结果；请先处理现有外链或文件，勿重复导入。', 10_000);
    return true;
  };
  const importFiles = async () => {
    if (!fileImportSourcePaths.length) return;
    const targetRelativePath = fileImportTarget;
    setPanelImportResult(null);
    setPanelImportBusy('files');
    try {
      const result = await projectWorkspaceClient.importProjectFiles(workspacePath, project.status, project.name, targetRelativePath, { deleteSourceAfterImport: deleteFileSources, linkOnly: linkFileSources, sourcePaths: fileImportSourcePaths });
      if (await handleProjectImportRecovery(result)) return;
      const pageOwnsNotice = pageOwnsFileOperationNotification(result);
      if (!result.success) { if (pageOwnsNotice) onNotice(`导入失败：${result.error || '未知错误'}`); return; }
      if (result.cancelled) { if (pageOwnsNotice) onNotice('已取消导入。'); return; }
      if (result.watchDegraded) setRootWatchFailed(true);
      setPanelImportResult({ kind: 'files', count: result.count || 0, sourceDeleted: deleteFileSources });
      if (pageOwnsNotice) onNotice(`已导入 ${result.count || 0} 个文件，源文件${deleteFileSources ? '已删除' : '已保留'}。`);
      refresh();
      refreshRecursiveResults(targetRelativePath);
    } catch (error) {
      onNotice(`导入失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
    } finally {
      setPanelImportBusy('');
    }
  };
  const openOfficeImageExtractor = (entries: ProjectFileEntry[]) => {
    const documents = entries.filter(isOfficeOpenXmlEntry);
    if (!documents.length) return;
    setOfficeExtractEntries(documents);
    setOfficeExtractResult(null);
    setOfficeExtractError('');
    setPanel('office-extract');
  };
  const extractOfficeImages = async () => {
    const documents = officeExtractEntries.filter(isOfficeOpenXmlEntry);
    if (!documents.length || officeExtractBusy) return;
    setOfficeExtractResult(null);
    setOfficeExtractError('');
    setOfficeExtractBusy(true);
    onNotice(`正在从 ${documents.length} 个 Office 文档提取图片…`);
    try {
      const result = await projectWorkspaceClient.extractOfficeImages(workspacePath, project.status, project.name, documents.map(entry => entry.relativePath));
      const results = Array.isArray(result.results) ? result.results : [];
      const successful = results.filter(item => item.success);
      const presentation = presentOfficeExtractionResult(result, documents.length);
      if (!presentation) {
        const message = result.error || '未知错误';
        setOfficeExtractError(message);
        onNotice(`提取图片失败：${message}`, 6000);
        return;
      }
      const imageCount = presentation.images;
      const failed = presentation.extractionFailures;
      const empty = successful.filter(item => !item.count);
      setOfficeExtractResult(presentation);
      if (presentation.state === 'publication-failed') onNotice(`图片已提取但发布失败：${presentation.warning}`, 9000);
      else if (imageCount) onNotice(`已从 ${presentation.successful} 个文档提取 ${imageCount} 张图片。`, 7000);
      else onNotice(empty.length ? '所选 Office 文档中没有可提取的图片。' : '没有提取到图片。');
      if (failed.length) onNotice(`${failed.length} 个文档提取失败：${failed.map(item => item.documentName).join('、')}`, 7000);
      directoryEntriesCacheRef.current.clear();
      try {
        await refresh();
      } catch (error) {
        onNotice(`图片已提取完成，但目录刷新失败：${error instanceof Error ? error.message : String(error || '未知错误')}`, 7000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '未知错误');
      setOfficeExtractError(message);
      onNotice(`提取图片失败：${message}`, 6000);
    } finally {
      setOfficeExtractBusy(false);
    }
  };
  const completeSdImport = async (completion: ImportCompletion) => {
    const result = await projectWorkspaceClient.finalizeSdImportedProjects(workspacePath, completion.projectNames, {
      moveProjectAfterImport: importConfig.autoMoveProjectAfterSdImport,
      workProjectNames: completion.workProjectNames, importedPathsByProject: completion.importedPathsByProject,
    });
    await refresh();
    window.dispatchEvent(new Event('workspace-projects-changed'));
    if (!result.success) { onNotice(`整理导入项目失败：${result.error || '未知错误'}`, 7000); return; }
    const latestProject = result.projects.find(item => item.id === project.id || item.name.toLocaleLowerCase() === project.name.toLocaleLowerCase());
    if (latestProject && latestProject.status !== project.status) onProjectMoved(latestProject);
    if (result.failures.length) onNotice(`导入已完成，但有 ${result.failures.length} 个项目的分类更新失败。`, 7000);
    else if (result.movedProjects.some(item => item.id === project.id || item.name.toLocaleLowerCase() === project.name.toLocaleLowerCase())) onNotice('导入完成，项目已移入“后期中”。');
    else onNotice('导入完成，项目分类保持不变。');
  };
  const completeNegativeImport = async () => {
    await refresh();
    if (project.status === '后期中') return;
    const result = await projectWorkspaceClient.moveWorkspaceProject(workspacePath, project.status, project.name, '后期中');
    if (!result.success || !result.project) { onNotice(`项目状态更新失败：${result.error || '未知错误'}`); return; }
    onNotice('导入完成，项目已移入“后期中”。');
    onProjectMoved(result.project);
  };
  const createFolder = async (targetRelativePath = currentRelativePath) => {
    setShowCreateMenu(false);
    const requestedProjectPath = project.path;
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const createDirectly = recursiveFlatOpen || versionTreeOpen || normalizedTarget !== normalizeProjectRelativePath(currentRelativePath);
    let folderName = '新建文件夹';
    if (createDirectly) {
      const answer = await appDialog.prompt({ title: '新建文件夹', message: '输入文件夹名称。', defaultValue: folderName, confirmLabel: '新建' });
      if (!answer?.trim()) return;
      folderName = answer.trim();
    }
    if (projectPathRef.current !== requestedProjectPath) return;
    const targetEntries = directoryEntriesCacheRef.current.get(normalizedTarget)
      || (normalizedTarget === normalizeProjectRelativePath(currentRelativePathRef.current) ? fileEntriesRef.current : []);
    const predictedName = predictUniqueDirectoryName(folderName, targetEntries.map(entry => entry.name));
    const requestedRelativePath = normalizeProjectRelativePath([normalizedTarget, predictedName].filter(Boolean).join('/'));
    const optimisticEntry: ProjectFileEntry = {
      name: predictedName, path: [project.path, requestedRelativePath].filter(Boolean).join('/'), relativePath: requestedRelativePath,
      kind: 'folder', extension: '', size: 0, createdAt: Date.now(), updatedAt: Date.now(),
    };
    const pendingOperation = startPendingFileOperation({
      kind: 'create',
      label: '正在创建…',
      lockedPaths: [`__directory__/${normalizedTarget || '__root__'}`, requestedRelativePath],
      affectedDirectories: [normalizedTarget],
    });
    if (!pendingOperation) return;
    upsertOptimisticDirectoryEntry(normalizedTarget, optimisticEntry);
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.createProjectFolder>>;
    try { result = await projectWorkspaceClient.createProjectFolder(workspacePath, project.status, project.name, folderName, normalizedTarget, true); }
    catch (error) { if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; } removeOptimisticDirectoryEntry(normalizedTarget, requestedRelativePath); await reconcilePendingFileOperation(pendingOperation, undefined, true); onNotice(`新建文件夹失败：${error instanceof Error ? error.message : String(error)}`); return; }
    if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; }
    if (!result.success) { removeOptimisticDirectoryEntry(normalizedTarget, requestedRelativePath); await reconcilePendingFileOperation(pendingOperation, undefined, true); onNotice(`新建文件夹失败：${result.error || '未知错误'}`); return; }
    const relativePath = normalizeProjectRelativePath(result.folder?.relativePath || [...[normalizedTarget, result.folder?.name || folderName].filter(Boolean)].join('/'));
    const updatedAt = result.folder?.updatedAt || Date.now();
    const createdEntry: ProjectFileEntry = {
      name: result.folder?.name || folderName,
      path: result.folder?.path || [project.path, relativePath].filter(Boolean).join('/'),
      relativePath,
      kind: 'folder',
      extension: '',
      size: 0,
      createdAt: updatedAt,
      updatedAt,
    };
    upsertOptimisticDirectoryEntry(normalizedTarget, createdEntry, requestedRelativePath);
    refreshRecursiveResults(normalizedTarget);
    await reconcilePendingFileOperation(pendingOperation, { affectedDirectories: [normalizedTarget] });
    const canReveal = !createDirectly && mutatedEntryCanBeRevealed({
      requestedProjectPath,
      currentProjectPath: projectPathRef.current,
      mutationDirectoryPath: normalizedTarget,
      currentDirectoryPath: currentRelativePathRef.current,
      browseMode: browseModeRef.current,
    });
    if (!canReveal) {
      onNotice(`已在${normalizedTarget ? `“${normalizedTarget}”` : '项目根目录'}中新建文件夹“${result.folder?.name || folderName}”`);
      return;
    }
    selectAndRevealFileEntry(relativePath);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(result.folder?.name || '新建文件夹');
  };
  const loadShellNewTypes = async (refresh = false) => {
    if (shellNewTypesLoading || shellNewTypesLoaded && !refresh) return;
    setShellNewTypesLoading(true);
    try {
      const result = await projectWorkspaceClient.getShellNewFileTypes(refresh);
      if (!result.success) { onNotice(`读取 Windows 新建文件类型失败：${result.error || '未知错误'}`); return; }
      setShellNewTypes(result.types);
      setShellNewTypesLoaded(true);
    } finally {
      setShellNewTypesLoading(false);
    }
  };
  const toggleCreateMenu = () => {
    const next = !showCreateMenu;
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setShowCreateMenu(next);
    if (next) void loadShellNewTypes();
  };
  const createShellNewFile = async (type: ShellNewFileType, targetRelativePath = currentRelativePath) => {
    setShowCreateMenu(false);
    const requestedProjectPath = project.path;
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const pendingOperation = startPendingFileOperation({
      kind: 'create', label: `正在新建${type.label}…`,
      lockedPaths: [`__directory__/${normalizedTarget || '__root__'}`],
      affectedDirectories: [normalizedTarget],
    });
    if (!pendingOperation) return;
    setWorkspaceActivityMessage(`正在新建${type.label}…`);
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.createProjectShellNewFile>>;
    try { result = await projectWorkspaceClient.createProjectShellNewFile(workspacePath, project.status, project.name, normalizedTarget, type.id); }
    catch (error) { if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; } setWorkspaceActivityMessage(''); await reconcilePendingFileOperation(pendingOperation, undefined, true); onNotice(`新建${type.label}失败：${error instanceof Error ? error.message : String(error)}`); return; }
    if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; }
    setWorkspaceActivityMessage('');
    if (!result.success || !result.file) { await reconcilePendingFileOperation(pendingOperation, undefined, true); onNotice(`新建${type.label}失败：${result.error || '未知错误'}`); return; }
    const relativePath = normalizeProjectRelativePath(result.file.relativePath);
    upsertOptimisticDirectoryEntry(normalizedTarget, {
      ...result.file,
      relativePath,
      kind: 'file',
      extension: result.file.name.includes('.') ? `.${result.file.name.split('.').pop()!.toLocaleLowerCase()}` : '',
      size: 0,
      createdAt: result.file.updatedAt,
    });
    refreshRecursiveResults(normalizedTarget);
    await reconcilePendingFileOperation(pendingOperation, { affectedDirectories: [normalizedTarget] });
    const canReveal = mutatedEntryCanBeRevealed({
      requestedProjectPath,
      currentProjectPath: projectPathRef.current,
      mutationDirectoryPath: normalizedTarget,
      currentDirectoryPath: currentRelativePathRef.current,
      browseMode: browseModeRef.current,
    });
    if (!canReveal) {
      onNotice(`已在${normalizedTarget ? `“${normalizedTarget}”` : '项目根目录'}中新建${type.label}`);
      return;
    }
    selectAndRevealFileEntry(relativePath);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(result.file.name);
  };
  const progressFolderPrefix = (mediaKind: 'image' | 'video') => mediaKind === 'image' ? '图片后期' : '视频后期';
  const buildProgressFolderName = (mediaKind: 'image' | 'video', versionKey: string, progressName: string) => {
    const baseName = `${progressFolderPrefix(mediaKind)}_${versionKey}`;
    return progressName.trim() ? `${baseName}_${progressName.trim()}` : baseName;
  };
  const progressAppendTarget = (draft: ProgressSetupDraft) => draft.mode === 'import'
    ? progressFolders.find(folder => !folder.folderMissing && folder.mediaKind === draft.mediaKind && folder.versionKey === draft.versionKey)
    : undefined;
  const progressVersionIsValid = (draft: ProgressSetupDraft) => {
    if (progressRelationInspection.needsRepair) return false;
    if (!isUserVersionKey(draft.versionKey)) return false;
    if (!draft.parentProgressId) return false;
    const parent = selectableVersionParents(progressFolders, draft).find(folder => folder.id === draft.parentProgressId);
    return Boolean(parent && !progressSubtreeIds(draft.existingProgressId).has(parent.id)
      && versionKeyMatchesParentKind(draft.versionKey, parent, draft.relation === 'branch' ? 'branch' : 'main'));
  };
  const progressSubtreeIds = (progressId?: string) => {
    return collectProgressSubtree(progressFolders, progressId).visitedIds;
  };
  const progressComparisonParent = (draft: ProgressSetupDraft) => progressFolders.find(folder => folder.id === draft.parentProgressId && !folder.folderMissing);
  const resolvedProgressFolderName = (draft: ProgressSetupDraft) => {
    const appendTarget = progressAppendTarget(draft);
    if (appendTarget) return appendTarget.displayName;
    if (draft.existingProgressId) return buildProgressFolderName(draft.mediaKind, draft.versionKey, draft.progressName);
    if (draft.preserveFolderName) return draft.targetRelativePath?.split('/').pop() || draft.progressName.trim() || buildProgressFolderName(draft.mediaKind, draft.versionKey, '');
    return buildProgressFolderName(draft.mediaKind, draft.versionKey, draft.progressName);
  };
  const progressNameHasConflict = (draft: ProgressSetupDraft) => {
    if (progressAppendTarget(draft)) return false;
    const generatedName = resolvedProgressFolderName(draft).toLocaleLowerCase('zh-CN');
    return progressFolders.some(folder => !folder.folderMissing && folder.id !== draft.existingProgressId && folder.displayName.toLocaleLowerCase('zh-CN') === generatedName);
  };
  const progressVersionHasConflict = (draft: ProgressSetupDraft) => draft.mode !== 'import' && progressFolders.some(folder => !folder.folderMissing
    && folder.id !== draft.existingProgressId && folder.nodeRole === 'progress'
    && folder.mediaKind === draft.mediaKind && folder.versionKey === draft.versionKey);
  const progressNameFromDisplayName = (displayName: string, mediaKind: 'image' | 'video', versionKey: string, fallback: string) => {
    const generatedBase = `${progressFolderPrefix(mediaKind)}_${versionKey}`;
    if (displayName === generatedBase) return '';
    const generatedPrefix = `${generatedBase}_`;
    return displayName.startsWith(generatedPrefix) ? displayName.slice(generatedPrefix.length) : fallback;
  };
  const makeProgressDraft = (mode: 'create' | 'import' | 'mark', mediaKind: 'image' | 'video', relation: 'root' | 'branch', parentProgressId = '', sourceFolders = progressFolders): ProgressSetupDraft => {
    const structuralParents = selectableVersionParents(sourceFolders, { mediaKind, relationKind: 'main' });
    const requestedParent = structuralParents.find(folder => folder.id === parentProgressId);
    const semanticDefaultParentId = defaultMainParentId(sourceFolders, versionGraphEdges, mediaKind);
    const selectedParent = requestedParent || structuralParents.find(folder => folder.id === semanticDefaultParentId);
    if (relation === 'branch' && !selectedParent) throw new Error('分支进度缺少有效的结构父节点');
    const actualRelation = relation === 'branch' ? 'branch' : 'root';
    const parentId = selectedParent?.id || '';
    const versionKey = selectedParent
      ? relation === 'branch' ? nextVersionKeys(sourceFolders, mediaKind, selectedParent).branch : nextVersionKeys(sourceFolders, mediaKind, selectedParent).main
      : '';
    return { mode, mediaKind, relation: actualRelation, relationKind: 'main', parentProgressId: parentId, versionKey, progressName: '', trackingEnabled: Boolean(parentId) && mode !== 'create', deleteSourceAfterImport: importDefaults.deleteSourceAfterImport, linkOnly: false, sourcePaths: [], renameSources: false, copyMissingFromParent: false, workflowInputProgressIds: parentId ? defaultWorkflowInputIds(sourceFolders, versionGraphEdges, parentId) : [] };
  };
  const openProgressSetup = (mode: 'create' | 'import', sourcePaths: string[] = []) => {
    setShowCreateMenu(false);
    setShowImportMenu(false);
    setProgressImportCompletion('');
    setProgressImportStatus(null);
    setProgressImportStep(mode === 'import' ? 'source' : 'settings');
    // The cached list is already loaded when the project opens. Render the
    // editor immediately and reconcile the list in the background instead of
    // making the dialog wait on a database IPC round trip.
    setProgressSetup({ ...makeProgressDraft(mode, 'image', 'root', '', progressFolders), sourcePaths });
    void loadProgressFolders();
  };
  const openManualImport = (kind: ImportMaterialKind, sourcePaths: string[] = [], targetRelativePath = currentRelativePath) => {
    const availableKind = gatherToProject ? 'files' : kind;
    setShowImportMenu(false);
    setPanelImportResult(null);
    setFileImportTarget(targetRelativePath);
    if (availableKind === 'progress') {
      setPanel(null);
      openProgressSetup('import', sourcePaths);
      return;
    }
    closeProgressSetup();
    if (availableKind === 'original') {
      setNegativeSourcePaths(sourcePaths);
      setPanel('negative-import');
      return;
    }
    if (availableKind === 'broll') {
      setBrollSourcePaths(sourcePaths);
      setDeleteBrollSources(importDefaults.deleteSourceAfterImport);
      setLinkBrollSources(false);
      setPanel('broll');
      return;
    }
    setFileImportTarget(targetRelativePath);
    setFileImportSourcePaths(sourcePaths);
    setDeleteFileSources(importDefaults.deleteSourceAfterImport);
    setLinkFileSources(false);
    setPanel('file-import');
  };
  const makeMarkProgressDraft = (entry: ProjectFileEntry, targetRelativePath: string, sourceFolders: ProgressFolder[]): ProgressSetupDraft | null => {
    const normalizedPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const registered = sourceFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === normalizedPath);
    if (registered) {
      const mediaKind = progressNodeMediaKind(registered);
      if (registered.nodeRole !== 'progress' || !mediaKind) return null;
      const registeredParent = sourceFolders.find(folder => folder.id === registered.parentProgressId);
      const normalizedVersionKey = isUserVersionKey(registered.versionKey)
        ? registered.versionKey
        : nextVersionKeys(sourceFolders, mediaKind, registeredParent, registered.id).main;
      return {
        mode: 'mark',
        mediaKind,
        relation: versionKindForParent(normalizedVersionKey, registeredParent) === 'branch' ? 'branch' : 'root',
        relationKind: registered.relationKind || 'main',
        parentProgressId: registered.parentProgressId || '',
        versionKey: normalizedVersionKey,
        progressName: progressNameFromDisplayName(registered.displayName, mediaKind, registered.versionKey, entry.name),
        trackingEnabled: registered.trackingState !== 'disabled',
        deleteSourceAfterImport: true,
        linkOnly: false,
        sourcePaths: [],
        renameSources: registered.renameFromParent,
        copyMissingFromParent: registered.copyMissingFromParent,
        targetRelativePath,
        existingProgressId: registered.id,
        preserveFolderName: targetRelativePath.includes('/') || entry.name !== registered.displayName,
        workflowInputProgressIds: defaultWorkflowInputIds(sourceFolders, versionGraphEdges, registered.parentProgressId || '', registered.id),
      };
    }
    return null;
  };
  const openMarkProgress = async (entry: ProjectFileEntry, preferredMediaKind?: 'image' | 'video') => {
    let resolvedEntry = entry;
    if (entry.kind === 'shortcut' && !entry.viaShortcut) {
      const resolved = await projectWorkspaceClient.resolveProjectShortcut(workspacePath, project.status, project.name, entry.relativePath);
      if (!resolved.success || resolved.targetKind !== 'folder' || !resolved.target) {
        onNotice(resolved.error || '所选外链没有指向可用的文件夹');
        return;
      }
      resolvedEntry = { ...entry, name: entry.name.replace(/\.lnk$/i, ''), path: resolved.target, kind: 'folder', extension: '' };
    }
    const targetRelativePath = resolvedEntry.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (resolvedEntry.kind !== 'folder') {
      onNotice('只有文件夹可以创建版本进度。');
      return;
    }
    if (resolvedEntry.viaShortcut && !resolvedEntry.viaExternalLink) {
      onNotice('快捷方式指向的外部目录不能移动或登记为版本进度。');
      return;
    }
    const normalizedFolderPath = resolvedEntry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const registered = progressFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === normalizedFolderPath);
    if (!registered) {
      const mediaKind: 'image' | 'video' = preferredMediaKind || (/(mov|video|视频|剪辑|成片)/iu.test(resolvedEntry.name) ? 'video' : 'image');
      const folderEntries = targetRelativePath.includes('/') ? [] : (await loadDirectoryPreviewEntries(resolvedEntry)).entries;
      const initialPurpose = defaultFolderMarkPurpose(targetRelativePath, folderEntries.some(candidate => candidate.kind === 'raw'));
      setProgressImportCompletion('');
      setProgressImportStatus(null);
      setFolderMarkSetup(createFolderMarkDraft({ relativePath: targetRelativePath, folderName: resolvedEntry.name }, initialPurpose, progressFolders, mediaKind));
      void loadProgressFolders();
      return;
    }
    const initialDraft = makeMarkProgressDraft(resolvedEntry, targetRelativePath, progressFolders);
    if (!initialDraft) {
      onNotice('当前文件夹由对应功能管理，不能在版本设置面板中修改。');
      return;
    }
    // Show the cached draft immediately. A slow database or network drive must
    // not keep the dialog invisible while progress-folder locations are synced.
    setProgressSetup(initialDraft);
    void loadProgressFolders().then(latestFolders => {
      if (!latestFolders.length && progressFolders.length) return;
      const latestDraft = makeMarkProgressDraft(resolvedEntry, targetRelativePath, latestFolders);
      if (!latestDraft) {
        setProgressSetup(current => current === initialDraft ? null : current);
        onNotice('当前文件夹已不再是可修改的进度。');
        return;
      }
      // Do not replace fields after the user has started editing or closed the
      // dialog. Unchanged drafts can safely adopt the refreshed registration.
      setProgressSetup(current => current === initialDraft ? latestDraft : current);
    });
  };
  useEffect(() => {
    if (!active || !versionTreeEnabled || !projectWorkflows) return;
    let disposed = false;
    const normalizedWorkspaceRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
    const normalizedProjectPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const projectPrefix = rootRelativeFileEvents
      ? ''
      : normalizedProjectPath.toLocaleLowerCase().startsWith(`${normalizedWorkspaceRoot}/`)
        ? normalizedProjectPath.slice(normalizedWorkspaceRoot.length + 1)
        : project.name.replace(/\\/g, '/');
    const comparableProjectPrefix = projectPrefix.toLocaleLowerCase();
    const candidateKeyPrefix = `${normalizedProjectPath.toLocaleLowerCase()}|`;
    const candidateKey = (relativePath: string) => `${candidateKeyPrefix}${normalizeProjectRelativePath(relativePath).toLocaleLowerCase()}`;
    const scheduleCandidate = (projectRelativePath: string) => {
      const candidate = exportedImageFolderCandidate(projectRelativePath);
      if (!candidate) return;
      const key = candidateKey(candidate);
      exportCandidateChangedAtRef.current.set(key, Date.now());
      if (offeredExportFoldersRef.current.has(key) || exportFolderPromptWasShown(window.localStorage, key)) {
        offeredExportFoldersRef.current.add(key);
        return;
      }
      const previousTimer = exportCandidateTimersRef.current.get(key);
      if (previousTimer) window.clearTimeout(previousTimer);
      const timer = window.setTimeout(async () => {
        exportCandidateTimersRef.current.delete(key);
        const inspected = await projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, candidate, mediaCacheConfig);
        if (disposed || !inspected.success) return;
        const mediaCount = inspected.entries.filter(entry => entry.kind === 'image' || entry.kind === 'raw').length;
        if (!mediaCount) return;
        const candidatePath = `${normalizedProjectPath}/${candidate}`.replace(/\/+$/, '').toLocaleLowerCase();
        if (progressFoldersRef.current.some(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() === candidatePath)) {
          offeredExportFoldersRef.current.add(key);
          return;
        }
        offeredExportFoldersRef.current.add(key);
        rememberExportFolderPromptShown(window.localStorage, key);
        const folderName = candidate.split('/').pop() || candidate;
        const jpegFolder = /^(?:jpg|jpeg)$/iu.test(folderName);
        const accepted = await appDialog.confirm({
          title: jpegFolder ? '发现新的 JPEG 导出文件夹' : '发现新的“_导出”文件夹',
          message: `项目内位置：“${project.name}/${candidate}”\n文件夹中有 ${mediaCount} 张导出图片，是否创建为新的图片版本进度？`,
          detail: candidate.includes('/')
            ? '确认后会把整个导出文件夹移动到项目根目录，再打开版本设置供你确认名称、父版本和版本号。'
            : '该文件夹已位于项目根目录，确认后会打开版本设置供你确认名称、父版本和版本号。',
          confirmLabel: '创建新版本',
        });
        if (disposed || !accepted) return;
        if (Date.now() - (exportCandidateChangedAtRef.current.get(key) || 0) < 5000) {
          offeredExportFoldersRef.current.delete(key);
          onNotice(`“${folderName}”仍在写入，导出停止后会再次询问。`);
          scheduleCandidate(candidate);
          return;
        }
        let targetRelativePath = candidate;
        if (candidate.includes('/')) {
          const moved = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'move', [candidate], '');
          if (!moved.success || !moved.movedItems?.[0]?.destinationRelativePath) {
            if (pageOwnsFileOperationNotification(moved)) onNotice(`移动导出文件夹失败：${moved.error || '未知错误'}`);
            return;
          }
          targetRelativePath = normalizeProjectRelativePath(moved.movedItems[0].destinationRelativePath);
          offeredExportFoldersRef.current.add(candidateKey(targetRelativePath));
        }
        directoryEntriesCacheRef.current.clear();
        void refresh(currentRelativePathRef.current);
        const targetName = targetRelativePath.split('/').pop() || folderName;
        const latestFolders = await loadProgressFolders();
        setPendingProgressFolders(current => current.filter(folder => folder.relativePath !== targetRelativePath));
        setFolderMarkSetup(createFolderMarkDraft({ relativePath: targetRelativePath, folderName: targetName }, 'progress', latestFolders, 'image'));
      }, 5000);
      exportCandidateTimersRef.current.set(key, timer);
    };
    const scanExistingCandidates = async () => {
      // The watcher only reports changes made after it starts. Reconcile folder
      // names on activation so exports completed in the background are not lost.
      await loadProgressFolders();
      const listed = await projectWorkspaceClient.listWorkspaceFolders(workspacePath, project.status, project.name);
      if (disposed || !listed.success) return;
      const candidates = exportedImageFolderCandidates(listed.folders
        .filter(folder => !folder.externalLink && !folder.viaExternalLink)
        .map(folder => folder.relativePath));
      const presentKeys = new Set(candidates.map(candidateKey));
      for (const key of offeredExportFoldersRef.current) {
        if (key.startsWith(candidateKeyPrefix) && !presentKeys.has(key)) offeredExportFoldersRef.current.delete(key);
      }
      for (const candidate of candidates) scheduleCandidate(candidate);
    };
    const unsubscribe = projectWorkspaceClient.onWorkspaceFilesChanged(change => {
      if (change.root && change.root.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() !== normalizedWorkspaceRoot) return;
      const changedPath = (change.fileName || '').replace(/\\/g, '/');
      if (!changedPath) return;
      const comparableChangedPath = changedPath.toLocaleLowerCase();
      if (projectPrefix && comparableChangedPath !== comparableProjectPrefix && !comparableChangedPath.startsWith(`${comparableProjectPrefix}/`)) return;
      const projectRelativePath = !projectPrefix ? changedPath : changedPath === projectPrefix ? '' : changedPath.slice(projectPrefix.length + 1);
      scheduleCandidate(projectRelativePath);
    });
    void scanExistingCandidates();
    return () => {
      disposed = true;
      unsubscribe();
      for (const timer of exportCandidateTimersRef.current.values()) window.clearTimeout(timer);
      exportCandidateTimersRef.current.clear();
      exportCandidateChangedAtRef.current.clear();
    };
  }, [active, loadProgressFolders, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB, project.name, project.path, project.status, projectWorkflows, rootRelativeFileEvents, versionTreeEnabled, workspacePath]);
  const openNextProgressFromVersionTree = async (source: ProgressFolder, entry: ProjectFileEntry) => {
    if (!isFolderLikeEntry(entry) || isUnsupportedShortcutContent(entry) || source.folderMissing || (source.nodeRole !== 'original' && source.nodeRole !== 'progress')) {
      onNotice('请选择项目内的普通文件夹来创建下一版本。');
      return;
    }
    const targetRelativePath = normalizeProjectRelativePath(entry.relativePath);
    const latestFolders = await loadProgressFolders();
    const targetPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase('zh-CN');
    if (latestFolders.some(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase('zh-CN') === targetPath)) {
      onNotice('该文件夹已经是版本树节点，不能重复创建版本。');
      return;
    }
    const completeDraft = (draft: ProgressSetupDraft): ProgressSetupDraft => ({
      ...draft,
      progressName: entry.name,
      targetRelativePath,
      trackingEnabled: false,
      preserveFolderName: true,
    });
    const latestSource = latestFolders.find(folder => folder.id === source.id) || source;
    const mediaKind = progressNodeMediaKind(latestSource);
    if (!mediaKind) { onNotice('混合媒体节点不能作为图片或视频版本进度父节点。'); return; }
    const nextDraft = completeDraft(makeProgressDraft('mark', mediaKind, 'root', latestSource.id, latestFolders));
    setProgressImportCompletion('');
    setProgressImportStatus(null);
    setProgressImportStep('settings');
    setProgressSetup({ ...nextDraft, contextLocked: true });
  };
  const openEmptyProgressFromVersionTree = async (source: ProgressFolder, branch: boolean) => {
    if (source.folderMissing || source.nodeRole !== 'progress') {
      onNotice('只能从有效的版本进度创建下一版本。');
      return;
    }
    const latestFolders = await loadProgressFolders();
    const latestSource = latestFolders.find(folder => folder.id === source.id);
    if (!latestSource) { onNotice('来源版本已发生变化，请刷新后重试。'); return; }
    const mediaKind = progressNodeMediaKind(latestSource);
    if (!mediaKind) { onNotice('混合媒体节点不能创建版本进度。'); return; }
    const draft = makeProgressDraft('create', mediaKind, branch ? 'branch' : 'root', source.id, latestFolders);
    setProgressSetup({ ...draft, trackingEnabled: true, contextLocked: true });
  };
  const projectRelativePath = useCallback((absolutePath: string) => {
    const normalizedRoot = project.path.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    return normalizedPath.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : normalizedPath.split('/').pop() || '';
  }, [project.path]);
  const setProgressTrackingState = async (progressFolder: ProgressFolder, trackingState: ProgressFolder['trackingState']) => {
    const mediaKind = progressNodeMediaKind(progressFolder);
    if (!mediaKind) throw new Error('混合媒体节点不能启用版本跟踪');
    const updated = await projectWorkspaceClient.registerProgressFolder(workspacePath, project.status, project.name, {
      relativePath: progressFolderRelativePath(progressFolder),
      mediaKind,
      versionKey: progressFolder.versionKey,
      parentProgressId: progressFolder.parentProgressId || undefined,
      displayName: progressFolder.displayName,
      trackingEnabled: trackingState === 'ready',
      trackingState,
      progressId: progressFolder.id,
    });
    if (!updated.success || !updated.progressFolder) throw new Error(updated.error || '无法更新版本跟踪状态');
    return updated.progressFolder;
  };
  const registerProgressWithWorkflow = async (progress: {
    relativePath?: string;
    mediaKind: 'image' | 'video';
    versionKey: string;
    parentProgressId?: string;
    displayName: string;
    trackingEnabled: boolean;
    renameFromParent: boolean;
    copyMissingFromParent: boolean;
    trackingState: ProgressFolder['trackingState'];
    progressId?: string;
    moveToRoot?: boolean;
  }, workflowInputProgressIds: string[]) => {
    return projectWorkspaceClient.registerProgressWithGraph(workspacePath, project.status, {
      projectName: project.name,
      progress,
      workflowInputProgressIds,
    });
  };
  const submitProgressSetup = async (requestedDraft?: ProgressSetupDraft) => {
    const draft = requestedDraft || progressSetup;
    if (!draft || progressSubmittingRef.current) return;
    if (!progressVersionIsValid(draft)) { onNotice('版本号格式或分支层级无效，请检查后重试。'); return; }
    if (progressVersionHasConflict(draft)) { onNotice(`版本 V${draft.versionKey} 已存在，请使用其他版本号。`); return; }
    const appendTarget = progressAppendTarget(draft);
    if (appendTarget?.trackingState === 'needs_repair' || appendTarget?.trackingState === 'committing') {
      onNotice(appendTarget.trackingState === 'needs_repair' ? '请先修复当前版本批次，再追加文件。' : '当前版本批次仍在提交，请稍后再追加。');
      return;
    }
    const trackingEnabled = appendTarget ? appendTarget.trackingState !== 'disabled' : normalizeProgressSetupTrackingPolicy(draft.relationKind, draft).trackingEnabled;
    const parentFolder = appendTarget
      ? progressFolders.find(folder => folder.id === appendTarget.parentProgressId && !folder.folderMissing)
      : progressComparisonParent(draft);
    progressImportOperationIdRef.current = '';
    progressSubmittingRef.current = true;
    setProgressSubmitting(true);
    let taskOwnedImportFailure = false;
    try {
      if (draft.mode === 'create') {
        if (progressNameHasConflict(draft)) { onNotice('生成的版本文件夹名称已存在，请修改版本号或名称。'); return; }
        const generatedName = resolvedProgressFolderName(draft);
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const registered = await registerProgressWithWorkflow({
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          ...policy,
          trackingState: policy.trackingEnabled ? 'pending_compare' : 'disabled',
        }, draft.workflowInputProgressIds);
        if (!registered.success || !registered.progressFolder || !registered.folder) throw new Error(registered.error || '无法原子创建进度和版本 V2 关系');
        setProgressSetup(null);
        setProgressFolders(current => current.some(folder => folder.id === registered.progressFolder!.id) ? current.map(folder => folder.id === registered.progressFolder!.id ? registered.progressFolder! : folder) : [...current, registered.progressFolder!]);
        directoryEntriesCacheRef.current.delete('');
        if (!currentRelativePathRef.current) {
          const folderEntry: ProjectFileEntry = { ...registered.folder, kind: 'folder', extension: '', size: 0, createdAt: registered.folder.updatedAt };
          setFileEntries(current => current.some(entry => entry.relativePath === folderEntry.relativePath) ? current : [...current, folderEntry]);
        }
        onNotice(`已创建${draft.mediaKind === 'image' ? '图片' : '视频'}进度“${generatedName}”（版本 V${draft.versionKey}）`);
        void loadProgressFolders();
        void refresh('');
        return;
      }

      if (draft.mode === 'mark' && draft.existingProgressId) {
        const existingProgress = progressFolders.find(folder => folder.id === draft.existingProgressId);
        if (!existingProgress) throw new Error('没有找到要修改的版本节点');
        const relativePath = progressFolderRelativePath(existingProgress);
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const policyChanged = existingProgress.trackingEnabled !== policy.trackingEnabled
          || existingProgress.renameFromParent !== policy.renameFromParent
          || existingProgress.copyMissingFromParent !== policy.copyMissingFromParent
          || existingProgress.parentProgressId !== (draft.parentProgressId || undefined)
          || (existingProgress.relationKind || 'main') !== draft.relationKind;
        const updated = await projectWorkspaceClient.updateProgressFolder(workspacePath, project.status, project.name, {
          progressId: existingProgress.id,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          trackingEnabled: policy.trackingEnabled,
          trackingState: policy.trackingEnabled && policyChanged ? 'pending_compare' : policy.trackingEnabled ? existingProgress.trackingState : 'disabled',
          renameFromParent: policy.renameFromParent,
          copyMissingFromParent: policy.copyMissingFromParent,
        });
        if (!updated.success || !updated.progressFolder) throw new Error(updated.error || '无法更新版本信息或跟踪策略');
        setProgressSetup(null);
        if (versionProgressId === existingProgress.id) {
          versionProgressLocationRef.current = {
            progressId: updated.progressFolder.id,
            folderPath: updated.progressFolder.folderPath,
            relativePath: progressFolderRelativePath(updated.progressFolder),
          };
          setVersionProgressId(updated.progressFolder.id);
        }
        progressFoldersRef.current = progressFoldersRef.current.map(folder => folder.id === updated.progressFolder!.id ? updated.progressFolder! : folder);
        setProgressFolders(current => current.map(folder => folder.id === updated.progressFolder!.id ? updated.progressFolder! : folder));
        setSelectedPaths([relativePath]);
        if (policy.trackingEnabled && draft.relationKind === 'main' && draft.parentProgressId && policyChanged) {
          const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: updated.progressFolder.id, mode: existingProgress.trackingEnabled ? 'refresh' : 'compare' });
          if (!started.success || !started.sessionId) {
            await loadProgressFolders();
            onNotice(`进度修改已保存，但跟踪启动失败：${started.error || '可从“继续版本跟踪”重试'}`, 8000);
            return;
          }
          safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${updated.progressFolder.id}`, started.sessionId);
          setTrackingConfirmationProgressId(updated.progressFolder.id);
          if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
        } else {
          onNotice(`已修改进度“${updated.progressFolder.displayName}”。`);
        }
        void loadProgressFolders();
        return;
      }

      if (draft.mode === 'mark') {
        if (progressNameHasConflict(draft)) { onNotice('生成的版本文件夹名称已存在，请修改版本号或名称。'); return; }
        const generatedName = resolvedProgressFolderName(draft);
        if (!draft.targetRelativePath) throw new Error('没有找到要标记的文件夹');
        let targetRelativePath = draft.targetRelativePath;
        const moveToRoot = draft.relationKind === 'main' && targetRelativePath.includes('/');
        if (moveToRoot) setWorkspaceActivityMessage('正在安全移动文件夹到项目根目录…');
        setWorkspaceActivityMessage(`正在标记${draft.mediaKind === 'image' ? '图片' : '视频'}进度…`);
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const registered = await registerProgressWithWorkflow({
          relativePath: targetRelativePath,
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          ...policy,
          trackingState: policy.trackingEnabled ? 'pending_compare' : 'disabled',
          progressId: draft.existingProgressId,
          moveToRoot,
        }, draft.workflowInputProgressIds);
        if (!registered.success || !registered.progressFolder) throw new Error(registered.error || '无法登记进度文件夹');
        targetRelativePath = registered.relativePath || targetRelativePath;
        const progressFolder = registered.progressFolder;
        const openCreatedProgressEditor = () => {
          if (!draft.openEditorAfterCreate) return;
          const createdParent = progressFoldersRef.current.find(folder => folder.id === progressFolder.parentProgressId) || parentFolder;
          setProgressSetup({
            ...draft,
            mode: 'mark',
            relation: versionKindForParent(progressFolder.versionKey, createdParent) === 'branch' ? 'branch' : 'root',
            relationKind: progressFolder.relationKind || 'main',
            parentProgressId: progressFolder.parentProgressId || '',
            versionKey: progressFolder.versionKey,
            progressName: progressNameFromDisplayName(progressFolder.displayName, draft.mediaKind, progressFolder.versionKey, progressFolder.displayName),
            trackingEnabled: progressFolder.trackingEnabled,
            renameSources: progressFolder.renameFromParent,
            copyMissingFromParent: progressFolder.copyMissingFromParent,
            targetRelativePath,
            existingProgressId: progressFolder.id,
            preserveFolderName: targetRelativePath.includes('/') || targetRelativePath.split('/').pop() !== progressFolder.displayName,
            contextLocked: undefined,
            openEditorAfterCreate: undefined,
          });
        };
        setProgressSetup(null);
        await loadProgressFolders();
        directoryEntriesCacheRef.current.clear();
        await refresh('');
        setSelectedPaths([targetRelativePath]);

        if (!policy.trackingEnabled || draft.relationKind === 'auxiliary') {
          setWorkspaceActivityMessage('');
          onNotice(`已将“${generatedName}”登记为${draft.relationKind === 'auxiliary' ? '选片辅助节点' : '版本进度'}。`);
          openCreatedProgressEditor();
          return;
        }
        if (!parentFolder) {
          setWorkspaceActivityMessage('正在建立首个版本的跟踪记录…');
          const baseline = await projectWorkspaceClient.registerVersionBaseline(workspacePath, project.status, project.name, targetRelativePath);
          if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
          await loadProgressFolders();
          setWorkspaceActivityMessage('');
          onNotice(`已标记并建立首版跟踪：${progressFolder.displayName}`);
          openCreatedProgressEditor();
          return;
        }

        const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: progressFolder.id, mode: 'compare' });
        if (!started.success || !started.sessionId) {
          setWorkspaceActivityMessage('');
          await loadProgressFolders();
          directoryEntriesCacheRef.current.clear();
          await refresh('');
          onNotice(`版本“${progressFolder.displayName}”已登记，但跟踪启动失败；可从修改进度或“继续版本跟踪”重试：${started.error || '未知错误'}`, 9000);
          openCreatedProgressEditor();
          return;
        }
        safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressFolder.id}`, started.sessionId);
        setTrackingConfirmationProgressId(progressFolder.id);
        if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
        setWorkspaceActivityMessage('');
        openCreatedProgressEditor();
        return;
      }

      if (progressNameHasConflict(draft)) { onNotice('生成的版本文件夹名称已存在，请修改版本号或名称。'); return; }
      const generatedName = resolvedProgressFolderName(draft);
      setWorkspaceActivityMessage('');
      const importOptions: Parameters<typeof projectWorkspaceClient.importProgressFiles>[4] = {
        deleteSourceAfterImport: draft.deleteSourceAfterImport,
        linkOnly: draft.linkOnly,
        sourcePaths: draft.sourcePaths,
        mediaKind: draft.mediaKind,
        versionKey: draft.versionKey,
        parentProgressId: appendTarget?.parentProgressId || draft.parentProgressId || undefined,
        trackingEnabled,
        trackingState: trackingEnabled ? 'pending_compare' : 'disabled',
        appendProgressId: appendTarget?.id,
      };
      let imported = await projectWorkspaceClient.importProgressFiles(workspacePath, project.status, project.name, generatedName, importOptions);
      if (imported.requiresDecision?.kind === 'progress-import-conflict') {
        const decision = imported.requiresDecision;
        const policy = await appDialog.choice({
          title: '追加进度时发现同名文件',
          message: decision.message,
          detail: decision.detail,
          choices: [
            { value: 'skip', label: '跳过同名文件' },
            { value: 'keep-both', label: '保留两份' },
          ],
          defaultValue: 'skip',
          cancelLabel: '取消追加',
          cancelDefault: true,
        });
        if (policy !== 'skip' && policy !== 'keep-both') {
          setWorkspaceActivityMessage('');
          setProgressSetup(null);
          return;
        }
        imported = await projectWorkspaceClient.importProgressFiles(workspacePath, project.status, project.name, generatedName, {
          ...importOptions,
          progressConflictPolicy: policy,
          sourcePaths: decision.sourcePaths,
        });
      }
      if (await handleProjectImportRecovery(imported)) {
        setWorkspaceActivityMessage('');
        setProgressSetup(null);
        return;
      }
      if (!imported.success) {
        taskOwnedImportFailure = !pageOwnsFileOperationNotification(imported);
        throw new Error(imported.error || '导入失败');
      }
      if (imported.watchDegraded) setRootWatchFailed(true);
      if (imported.cancelled || !imported.folder) {
        setWorkspaceActivityMessage('');
        setProgressSetup(null);
        return;
      }
      if (!imported.progressFolder) throw new Error('版本进度没有完成数据库登记');
      const importPolicy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
      const v2Imported = await registerProgressWithWorkflow({
        relativePath: imported.folder.relativePath,
        mediaKind: draft.mediaKind,
        versionKey: draft.versionKey,
        parentProgressId: appendTarget?.parentProgressId || draft.parentProgressId || undefined,
        displayName: generatedName,
        ...importPolicy,
        trackingState: importPolicy.trackingEnabled ? 'pending_compare' : 'disabled',
        progressId: imported.progressFolder.id,
      }, draft.workflowInputProgressIds);
      if (!v2Imported.success || !v2Imported.progressFolder) throw new Error(v2Imported.error || '无法保存导入进度的 V2 关系');
      const progressFolder = v2Imported.progressFolder;
      await loadProgressFolders();
      await refresh('');

      const skippedSummary = imported.skippedCount ? `；已跳过 ${imported.skippedCount} 个重复或冲突文件` : '';
      if (appendTarget && !(imported.count || 0)) {
        setWorkspaceActivityMessage('');
        setProgressImportCompletion(`没有向“${progressFolder.displayName}”追加新文件${skippedSummary}。`);
        return;
      }

      if (!trackingEnabled) {
        setWorkspaceActivityMessage('');
        setProgressImportCompletion(appendTarget
          ? `已向“${progressFolder.displayName}”追加 ${imported.count || 0} 个文件${skippedSummary}；沿用未开启版本跟踪的设置。`
          : `已导入 ${imported.count || 0} 个文件；此项目未开启版本跟踪。`);
        return;
      }
      if (!parentFolder) {
        setWorkspaceActivityMessage(appendTarget ? '正在把本次追加文件写入首版跟踪记录…' : '正在建立首个版本的跟踪记录…');
        const baseline = await projectWorkspaceClient.registerVersionBaseline(workspacePath, project.status, project.name, imported.folder.relativePath);
        if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
        await loadProgressFolders();
        setWorkspaceActivityMessage('');
        setProgressImportCompletion(appendTarget
          ? `已向“${progressFolder.displayName}”追加 ${imported.count || 0} 个文件并更新首版跟踪${skippedSummary}。`
          : `已导入并建立首版跟踪：${progressFolder.displayName}`);
        return;
      }

      setProgressSetup(null);
      const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: progressFolder.id, mode: appendTarget ? 'refresh' : 'compare' });
      if (!started.success || !started.sessionId) {
        setWorkspaceActivityMessage('');
        await loadProgressFolders();
        directoryEntriesCacheRef.current.clear();
        await refresh('');
        const message = `文件已导入且版本“${progressFolder.displayName}”已登记，但跟踪启动失败；可从“继续版本跟踪”重试：${started.error || '未知错误'}`;
        setProgressImportCompletion(message);
        onNotice(message, 9000);
        return;
      }
      safeStorageSet(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressFolder.id}`, started.sessionId);
      setTrackingConfirmationProgressId(progressFolder.id);
      if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
      setWorkspaceActivityMessage('');
    } catch (error) {
      setWorkspaceActivityMessage('');
      const action = draft.mode === 'create' ? '创建' : draft.mode === 'import' ? '导入' : draft.existingProgressId ? '修改' : '标记';
      if (!taskOwnedImportFailure) onNotice(`${action}版本进度失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      progressSubmittingRef.current = false;
      setProgressSubmitting(false);
    }
  };
  const unregisterLegacyOrphanProgress = async (progressFolder: ProgressFolder) => {
    if (progressFolder.nodeRole !== 'progress' || progressFolder.parentProgressId) return;
    const confirmed = await appDialog.confirm({
      title: '取消旧版游离进度登记？',
      message: `“${progressFolder.displayName}”会恢复为普通文件夹；只移除版本元数据，不会删除或移动文件。`,
      confirmLabel: '取消版本登记',
      tone: 'danger',
    });
    if (!confirmed) return;
    const result = await projectWorkspaceClient.unregisterProgressFolder(workspacePath, project.name, progressFolder.id);
    if (!result.success) { onNotice(`取消版本登记失败：${result.error || '未知错误'}`, 7000); return; }
    await loadProgressFolders();
    onNotice(`已保留“${progressFolder.displayName}”的物理文件夹并移除旧版游离进度元数据。`);
  };
  const submitFolderMarkSetup = async (draft: FolderMarkDraft) => {
    if (progressSubmittingRef.current) return;
    if (draft.purpose === 'progress') {
      const panelDraft = draft.progress;
      const parent = selectableVersionParents(progressFolders, { mediaKind: panelDraft.mediaKind, relationKind: 'main' })
        .find(folder => folder.id === panelDraft.parentProgressId);
      if (!parent || !isUserVersionKey(panelDraft.versionKey || '')) {
        onNotice('请先选择同媒体类型的原始素材或有效进度父节点。');
        return;
      }
      const policy = normalizeTrackingPolicy('main', panelDraft);
      const setup: ProgressSetupDraft = {
        mode: 'mark',
        mediaKind: panelDraft.mediaKind,
        relation: (panelDraft.versionKind || versionKindForParent(panelDraft.versionKey, parent)) === 'branch' ? 'branch' : 'root',
        relationKind: 'main',
        parentProgressId: parent.id,
        versionKey: panelDraft.versionKey || '',
        progressName: draft.folderName,
        trackingEnabled: policy.trackingEnabled,
        deleteSourceAfterImport: false,
        linkOnly: false,
        sourcePaths: [],
        renameSources: policy.renameFromParent,
        copyMissingFromParent: policy.copyMissingFromParent,
        workflowInputProgressIds: defaultWorkflowInputIds(progressFolders, versionGraphEdges, parent.id),
        targetRelativePath: draft.relativePath,
        preserveFolderName: true,
      };
      setFolderMarkSetup(null);
      setPendingProgressFolders(current => current.filter(folder => folder.relativePath !== draft.relativePath));
      setProgressSetup(setup);
      await submitProgressSetup(setup);
      return;
    }
    progressSubmittingRef.current = true;
    setProgressSubmitting(true);
    try {
      const adopted = await adoptVersionTreeFolder(
        { name: draft.folderName, relativePath: draft.relativePath },
        draft.purpose,
        draft.purpose === 'broll' ? 'mixed' : draft.mediaKind,
      );
      if (adopted) {
        setFolderMarkSetup(null);
        setPendingProgressFolders(current => current.filter(folder => folder.relativePath !== draft.relativePath));
      }
    } finally {
      progressSubmittingRef.current = false;
      setProgressSubmitting(false);
    }
  };
  const trackingParentForProgress = (progressFolder: ProgressFolder, sourceFolders = progressFolders) => sourceFolders.find(folder => folder.id === progressFolder.parentProgressId && !folder.folderMissing);
  const progressTrackingRefreshLabel = (progressFolder: ProgressFolder) => progressTrackingActionLabel(progressFolder);
  const openProgressRepair = async (progressFolder: ProgressFolder) => {
    if (!progressFolder.repairBatchId) { onNotice('没有找到可修复的版本批次，请刷新版本跟踪。'); return; }
    setWorkspaceActivityMessage('正在读取失败的文件操作…');
    const result = await projectWorkspaceClient.getVersionBatchOperations(workspacePath, progressFolder.repairBatchId);
    setWorkspaceActivityMessage('');
    if (!result.success) { onNotice(`读取修复任务失败：${result.error || '未知错误'}`); return; }
    setProgressRepair({ progressFolder, batchId: progressFolder.repairBatchId, operations: result.operations });
  };
  const retryProgressRepair = async () => {
    if (!progressRepair || progressRepairBusy) return;
    setProgressRepairBusy(true);
    const retried = await projectWorkspaceClient.retryVersionBatchOperations(workspacePath, progressRepair.batchId);
    const refreshed = await projectWorkspaceClient.getVersionBatchOperations(workspacePath, progressRepair.batchId);
    setProgressRepairBusy(false);
    if (refreshed.success) setProgressRepair(current => current ? { ...current, operations: refreshed.operations } : current);
    await loadProgressFolders();
    directoryEntriesCacheRef.current.clear();
    await refresh('');
    if (retried.success && !retried.repairRequired) {
      setProgressRepair(null);
      onNotice('文件操作已全部修复，版本批次已完成。');
      return;
    }
    onNotice(`仍有 ${retried.renameErrors?.length || 0} 个文件操作需要处理：${retried.error || retried.renameErrors?.[0]?.error || '请检查文件占用或目标名称冲突'}`, 7000);
  };
  const refreshProgressTracking = async (requestedProgress: ProgressFolder) => {
    if (progressSubmitting || workspaceActivityMessage) return;
    if (!progressTrackingAction(requestedProgress)) { onNotice('选片、预览和协作内容不参与版本跟踪。'); return; }
    if (requestedProgress.trackingState === 'needs_repair' && requestedProgress.repairBatchId) { await openProgressRepair(requestedProgress); return; }
    setProgressSubmitting(true);
    try {
      const latestFolders = await loadProgressFolders();
      const progressFolder = latestFolders.find(folder => folder.id === requestedProgress.id) || requestedProgress;
      if (progressFolder.folderMissing) throw new Error('当前进度文件夹已经丢失');
      const parentFolder = trackingParentForProgress(progressFolder, latestFolders.length ? latestFolders : progressFolders);
      const relativePath = progressFolderRelativePath(progressFolder);
      if (!parentFolder) {
        setWorkspaceActivityMessage('正在重新扫描首个版本并更新项目跟踪…');
        const baseline = await projectWorkspaceClient.registerVersionBaseline(workspacePath, project.status, project.name, relativePath);
        if (!baseline.success) throw new Error(baseline.error || '无法更新项目跟踪');
        await loadProgressFolders();
        directoryEntriesCacheRef.current.clear();
        await refresh('');
        setVersionEntry(current => current ? { ...current, updatedAt: Date.now() } : current);
        onNotice(`已更新 ${progressFolder.displayName} 的 V${progressFolder.versionKey} 项目跟踪`);
        return;
      }
      const sessionStorageKey = `photoflow:tracking-session:${workspacePath}:${project.name}:${progressFolder.id}`;
      const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, {
        progressId: progressFolder.id,
        mode: progressFolder.lastTrackedAt || progressFolder.trackingState === 'stale' ? 'refresh' : 'compare',
      });
      if (!started.success || !started.sessionId) throw new Error(started.error || '无法启动版本跟踪任务');
      safeStorageSet(sessionStorageKey, started.sessionId);
      setTrackingConfirmationProgressId(progressFolder.id);
      if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') {
        setTrackingConfirmationSessionId(started.sessionId);
        if (started.sessionStatus === 'failed') {
          onNotice('已恢复上次失败的跟踪会话，可检查后重试。');
          return;
        }
        onNotice(started.sessionStatus === 'committing' ? '已恢复上次未完成的跟踪提交，可继续提交。' : '已恢复待确认的版本跟踪会话。');
        return;
      }
      onNotice(`已在后台开始比较 ${parentFolder.displayName} → ${progressFolder.displayName}，完成后可从任务中心打开确认面板。`);
    } catch (error) {
      onNotice(`刷新版本跟踪失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally {
      setWorkspaceActivityMessage('');
      setProgressSubmitting(false);
    }
  };
  const commitProgressCompare = async () => {
    if (!progressCompare || progressSubmitting) return;
    setProgressSubmitting(true);
    setWorkspaceActivityMessage('正在确认版本关系并写入素材历史…');
    const accepted = new Set(progressCompare.acceptedSources);
    const candidates = [...progressCompare.matches, ...progressCompare.suggestions];
    const acceptedMatches = candidates.filter(match => accepted.has(match.source));
    const acceptedReferences = new Set(acceptedMatches.map(match => match.reference));
    const result = await projectWorkspaceClient.commitVersionBatch(workspacePath, project.status, project.name, {
      folderA: progressCompare.parentFolder.folderPath,
      folderB: progressCompare.progressFolder.folderPath,
      importKey: crypto.randomUUID(),
      displayName: progressCompare.progressFolder.displayName,
      renameSources: progressCompare.renameSources,
      copyMissingReferences: progressCompare.copyMissingFromParent ? progressCompare.unmatchedReferences.filter(reference => !acceptedReferences.has(reference)) : [],
      reconcileExisting: Boolean(progressCompare.reconcileExisting),
      incrementalSources: progressCompare.incrementalSources,
      matches: acceptedMatches,
    });
    if (!result.success) {
      setProgressSubmitting(false);
      setWorkspaceActivityMessage('');
      onNotice(`建立版本跟踪失败：${result.error || '未知错误'}`);
      return;
    }
    const committedProgressFolder = progressCompare.progressFolder;
    setProgressSubmitting(false);
    setWorkspaceActivityMessage('');
    setProgressCompare(null);
    const latestProgressFolders = await loadProgressFolders();
    directoryEntriesCacheRef.current.clear();
    await refresh('');
    setVersionEntry(current => current ? { ...current, updatedAt: Date.now() } : current);
    const renameWarning = result.renameErrors?.length ? `，${result.renameErrors.length} 个文件未能同步重命名` : '';
    const copySummary = result.copiedMissingCount ? `，从上一版本补齐 ${result.copiedMissingCount} 个文件` : '';
    const copyWarning = result.copyMissingErrors?.length ? `，${result.copyMissingErrors.length} 个缺失文件复制失败` : '';
    const actionLabel = progressCompare.trackingRefreshMode === 'refresh' ? '已更新' : '已建立';
    if (result.repairRequired && result.batch?.id) {
      const repairFolder = latestProgressFolders.find(folder => folder.id === committedProgressFolder.id) || { ...committedProgressFolder, trackingEnabled: false, trackingState: 'needs_repair' as const, repairBatchId: result.batch.id, pendingOperationCount: result.renameErrors?.length || 0 };
      await openProgressRepair(repairFolder);
      onNotice(`版本关系已写入，但有 ${result.renameErrors?.length || 0} 个文件操作需要修复。`, 7000);
      return;
    }
    onNotice(`${actionLabel} V${progressCompare.parentFolder.versionKey} → V${progressCompare.progressFolder.versionKey} 的版本关系：${result.batch?.matchedCount || 0} 个延续版本，${result.batch?.newCount || 0} 个新素材${copySummary}${renameWarning}${copyWarning}`);
  };
  const disableProgressTracking = async () => {
    if (!progressCompare || progressSubmitting) return;
    setProgressSubmitting(true);
    const mediaKind = progressNodeMediaKind(progressCompare.progressFolder);
    if (!mediaKind) { setProgressSubmitting(false); onNotice('混合媒体节点不能修改版本跟踪。'); return; }
    const relativePath = progressFolderRelativePath(progressCompare.progressFolder);
    const result = await projectWorkspaceClient.registerProgressFolder(workspacePath, project.status, project.name, {
      relativePath,
      mediaKind,
      versionKey: progressCompare.progressFolder.versionKey,
      parentProgressId: progressCompare.progressFolder.parentProgressId,
      displayName: progressCompare.progressFolder.displayName,
      trackingEnabled: false,
      trackingState: 'disabled',
    });
    setProgressSubmitting(false);
    if (!result.success) { onNotice(`关闭项目跟踪失败：${result.error || '未知错误'}`); return; }
    setProgressCompare(null);
    await loadProgressFolders();
    onNotice(progressCompare.sourceMode === 'mark' ? '文件夹已标记为进度，但没有建立项目版本跟踪。' : '本次导入已保留，但没有建立项目版本跟踪。');
  };
  async function closeProgressCompare() {
    const current = progressCompare;
    if (!current || progressSubmitting) return;
    setProgressCompare(null);
    if (current.trackingRefreshMode !== 'refresh') return;
    try {
      await setProgressTrackingState(current.progressFolder, 'ready');
      await loadProgressFolders();
    } catch (error) {
      onNotice(`恢复原有跟踪状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const moveToTrash = async () => {
    const result = await projectWorkspaceClient.trashWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) {
      if (isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else onNotice(`删除项目失败：${result.error || '未知错误'}`);
      return;
    }
    if (result.permanent) onNotice('项目已按 Windows 确认永久删除');
    onDeleted();
  };
  const closeImageConverterPanel = () => {
    conversionInspectionSequenceRef.current += 1;
    setConversionCollecting(false);
    setPanel(null);
  };
  const openImageConverter = async (targetPaths: string | string[]) => {
    const triggerAction = converterTriggerAction(panel === 'converter', projectPanelIsRunning('converter'));
    if (triggerAction === 'restore') { setPanel('converter'); return; }
    if (triggerAction === 'close') { closeImageConverterPanel(); return; }
    const requestedPaths = (Array.isArray(targetPaths) ? targetPaths : [targetPaths]).filter(Boolean);
    if (!requestedPaths.length) { onNotice('请先选择可转换的图片或包含图片的文件夹'); return; }
    const sequence = ++conversionInspectionSequenceRef.current;
    setConversionTargets([]);
    setConversionCollecting(true);
    setPanel('converter');
    while (sequence === conversionInspectionSequenceRef.current) {
      const result = await projectWorkspaceClient.inspectProjectToolSources(workspacePath, project.status, project.name, requestedPaths, false, false, true);
      if (sequence !== conversionInspectionSequenceRef.current) return;
      if (!result.success) {
        setConversionCollecting(false);
        onNotice(`读取图片索引失败：${result.error || '未知错误'}`);
        return;
      }
      if (result.indexed) {
        setConversionTargets(resolveInspectedToolSources(result.sources, result.folderPaths, result.convertibleImagePaths).map(source => source.path));
        setConversionCollecting(false);
        if (!result.convertibleImagePaths.length) onNotice('所选文件或文件夹中没有可转换的图片');
        return;
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 800));
    }
  };
  const openScreenshotMainImage = (entries: ProjectFileEntry[]) => {
    if (projectPanelIsRunning('screenshot-main-image')) { setPanel('screenshot-main-image'); return; }
    const targets = entries.filter(isScreenshotMainImageEntry).map(entry => entry.relativePath);
    if (!targets.length) return;
    setScreenshotMainImageMode('extract');
    setScreenshotMainImageTargets(targets);
    setPanel('screenshot-main-image');
  };
  const analyzePreviewImageCrop = async (entry: ProjectFileEntry): Promise<PreviewImageCropAnalysis> => {
    if (!isScreenshotMainImageEntry(entry) || isUnsupportedShortcutContent(entry)) {
      return { success: false, error: '当前图片格式暂不支持裁剪' };
    }
    try {
      const analysis = await projectWorkspaceClient.extractScreenshotMainImages(workspacePath, project.status, project.name, [entry.relativePath], { analyzeOnly: true });
      const result = analysis.results[0];
      if (!result?.success || !result.crop || !result.originalSize) return { success: false, error: result?.error || analysis.error || '无法识别可裁剪范围' };
      return {
        success: true,
        crop: result.crop,
        originalSize: result.originalSize,
        snapGuides: result.snapGuides || { x: [0, result.originalSize.width], y: [0, result.originalSize.height] }
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const savePreviewImageCrop = async (entry: ProjectFileEntry, crop: CropRectangle): Promise<{ success: boolean; error?: string }> => {
    try {
      const extraction = await projectWorkspaceClient.extractScreenshotMainImages(workspacePath, project.status, project.name, [entry.relativePath], { crops: [crop], outputSuffix: '裁剪' });
      const result = extraction.results[0];
      if (!result?.success || !result.cropped) return { success: false, error: result?.error || extraction.error || '裁剪失败' };
      directoryEntriesCacheRef.current.clear();
      refreshRecursiveResults(projectRelativeParentPath(entry.relativePath));
      await refresh(currentRelativePathRef.current);
      if (finalViewOpen) await loadFinalViewEntries();
      onNotice(`裁剪完成：${result.outputName || '已在原图旁生成裁剪图片'}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const selectEntryRange = (relativePath: string, additive: boolean) => {
    selectProjectFileRange(relativePath, additive, displayedFileEntries);
  };
  const beginInlineRename = (relativePath: string) => {
    const entry = activeFileEntries.find(candidate => candidate.relativePath === relativePath);
    if (!entry) return;
    if (pendingPathConflicts(pendingFileOperationsRef.current, [relativePath])) { onNotice('该项目正在处理中，请稍后再试'); return; }
    if (isProtectedRenameEntry(entry)) { onNotice('该文件夹由工作流管理，请使用“修改进度”。'); return; }
    setSelectedPaths([relativePath]);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(entry.name);
  };
  const getInlineRenameSelectionEnd = (entry: ProjectFileEntry) => {
    if (isFolderLikeEntry(entry) || !entry.extension || !entry.name.toLocaleLowerCase().endsWith(entry.extension.toLocaleLowerCase())) return entry.name.length;
    return entry.name.length - entry.extension.length;
  };
  const cancelInlineRename = () => {
    setInlineRenamePath('');
    setInlineRenameValue('');
  };
  const commitInlineRename = async () => {
    if (!inlineRenamePath || renameCommitRef.current) return;
    const sourcePath = inlineRenamePath;
    const sourceDirectoryPath = finalViewOpen ? projectRelativeParentPath(sourcePath) : normalizeProjectRelativePath(currentRelativePathRef.current);
    const requestedProjectPath = project.path;
    const entry = activeFileEntries.find(candidate => candidate.relativePath === sourcePath);
    const nextName = inlineRenameValue.trim();
    if (!entry || !nextName || nextName === entry.name) { cancelInlineRename(); return; }
    if (isProtectedRenameEntry(entry)) { cancelInlineRename(); onNotice('该文件夹由项目工作流管理，不能普通重命名。'); return; }
    const progressFolder = registeredProgressFolderForEntry(entry);
    const pathSeparatorIndex = Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\'));
    const optimisticName = entry.externalLink && entry.path.toLocaleLowerCase().endsWith('.lnk') && !nextName.toLocaleLowerCase().endsWith('.lnk') ? `${nextName}.lnk` : nextName;
    const optimisticRelativePath = normalizeProjectRelativePath(`${sourceDirectoryPath}/${optimisticName}`);
    const optimisticPhysicalPath = `${pathSeparatorIndex >= 0 ? entry.path.slice(0, pathSeparatorIndex + 1) : ''}${optimisticName}`;
    const optimisticRenameEntry: PendingProjectFileEntry = {
      ...entry,
      name: optimisticName,
      path: optimisticPhysicalPath,
      relativePath: optimisticRelativePath,
      pendingSourceRelativePath: sourcePath,
    };
    const pendingOperation = startPendingFileOperation({
      kind: 'rename', label: '正在重命名…', lockedPaths: [sourcePath, optimisticRelativePath], affectedDirectories: [sourceDirectoryPath],
      tombstonePaths: [sourcePath],
      optimisticEntries: [optimisticRenameEntry],
    });
    if (!pendingOperation) return;
    cancelInlineRename();
    renameCommitRef.current = true;
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>> | Awaited<ReturnType<typeof projectWorkspaceClient.renameProgressFolder>>;
    try {
      result = await (progressFolder?.nodeRole === 'progress'
        ? projectWorkspaceClient.renameProgressFolder(workspacePath, project.status, project.name, {
          progressId: progressFolder.id,
          expectedFolderId: progressFolder.folderId,
          expectedRelativePath: progressFolderRelativePath(progressFolder),
          newName: nextName,
        })
        : projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'rename', [sourcePath], sourceDirectoryPath, nextName));
    } catch (error) {
      await reconcilePendingFileOperation(pendingOperation, undefined, true);
      settleDirectoryPreviewRenames([optimisticRenameEntry], false);
      onNotice(`重命名失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    } finally { renameCommitRef.current = false; }
    if (projectPathRef.current !== requestedProjectPath) { clearPendingFileOperation(pendingOperation.id); return; }
    if (!result.success) {
      await reconcilePendingFileOperation(pendingOperation, 'affectedDirectories' in result ? result : undefined, true);
      settleDirectoryPreviewRenames([optimisticRenameEntry], false);
      onNotice(`重命名失败：${result.error || '未知错误'}`);
      return;
    }
    const renamedPath = ('newRelativePath' in result ? result.newRelativePath : undefined)
      || ('movedItems' in result ? renamedEntryDestinationPath(sourcePath, nextName, result.movedItems) : normalizeProjectRelativePath(`${sourceDirectoryPath}/${nextName}`));
    if (finalViewOpen) {
      clearPendingFileOperation(pendingOperation.id);
      settleDirectoryPreviewRenames([optimisticRenameEntry], true);
      setSelectedPaths([renamedPath]);
      setPreviewPath(current => current === sourcePath ? renamedPath : current);
      setPreviewMediaPath(current => current === sourcePath ? renamedPath : current);
      await loadFinalViewEntries();
      onNotice(`已重命名为“${nextName}”`);
      return;
    }
    const renamedName = renamedPath.split('/').pop() || nextName;
    upsertOptimisticDirectoryEntry(sourceDirectoryPath, {
      ...entry,
      name: renamedName,
      path: `${pathSeparatorIndex >= 0 ? entry.path.slice(0, pathSeparatorIndex + 1) : ''}${renamedName}`,
      relativePath: renamedPath,
    }, sourcePath);
    refreshRecursiveResults(sourceDirectoryPath);
    if (progressFolder?.nodeRole === 'progress') {
      const renamedProgress = 'progressFolder' in result ? result.progressFolder : undefined;
      if (renamedProgress) {
        progressFoldersRef.current = progressFoldersRef.current.map(folder => folder.id === renamedProgress.id ? renamedProgress : folder);
        setProgressFolders(current => current.map(folder => folder.id === renamedProgress.id ? renamedProgress : folder));
        if (versionProgressId === renamedProgress.id) {
          const previousLocation = versionProgressLocationRef.current;
          const nextLocation = { progressId: renamedProgress.id, folderPath: renamedProgress.folderPath, relativePath: renamedPath };
          if (previousLocation) setVersionEntry(current => current ? remapEntryAfterProgressFolderMove(current, previousLocation, nextLocation) : current);
          versionProgressLocationRef.current = nextLocation;
        }
      }
      await loadProgressFolders();
    }
    await reconcilePendingFileOperation(pendingOperation, 'affectedDirectories' in result ? result : { affectedDirectories: [sourceDirectoryPath] });
    settleDirectoryPreviewRenames([optimisticRenameEntry], true);
    const canReveal = mutatedEntryCanBeRevealed({
      requestedProjectPath,
      currentProjectPath: projectPathRef.current,
      mutationDirectoryPath: sourceDirectoryPath,
      currentDirectoryPath: currentRelativePathRef.current,
      browseMode: browseModeRef.current,
    });
    if (canReveal) selectAndRevealFileEntry(renamedPath);
    onNotice(`已重命名为“${nextName}”`);
  };
  const beginRename = (targetPaths = selectedPaths) => {
    if (!targetPaths.length) return;
    if (activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isUnsupportedShortcutContent(entry))) { onNotice('普通快捷方式中的文件是只读浏览内容，不能在项目中重命名'); return; }
    if (activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isProtectedRenameEntry(entry))) { onNotice('所选内容包含工作流文件夹，请使用“修改进度”。'); return; }
    const registeredProgressEntries = activeFileEntries.filter(entry => targetPaths.includes(entry.relativePath) && registeredProgressFolderForEntry(entry)?.nodeRole === 'progress');
    if (registeredProgressEntries.length && targetPaths.length > 1) { onNotice('已登记版本目录暂不支持批量或混合批量重命名，请单独重命名。'); return; }
    if (targetPaths.length === 1) {
      beginInlineRename(targetPaths[0]);
      return;
    }
    if (targetPaths !== selectedPaths) setSelectedPaths(targetPaths);
    setBatchRenameParts([
      createBatchRenamePart('text'),
      createBatchRenamePart('sequence')
    ]);
    setBatchExtensionMode('preserve');
    setBatchExtensionValue('');
    setBatchRenameOpen(true);
  };
  const batchRenameEntries = selectedPaths.map(relativePath => activeFileEntries.find(entry => entry.relativePath === relativePath)).filter((entry): entry is ProjectFileEntry => Boolean(entry));
  const buildBatchRenameNames = () => batchRenameEntries.map((entry, index) => {
    const extension = isFolderLikeEntry(entry) || !entry.extension ? '' : entry.name.slice(-entry.extension.length);
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
    if (!isFolderLikeEntry(entry)) {
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
    if (batchRenameEntries.length !== selectedPaths.length || batchRenameNames.length !== selectedPaths.length) {
      onNotice('所选文件已变化，请重新选择后再批量重命名。');
      return;
    }
    if (batchRenameEntries.some(entry => registeredProgressFolderForEntry(entry)?.nodeRole === 'progress')) { onNotice('已登记版本目录暂不支持批量或混合批量重命名，请单独重命名。'); return; }
    const sourcePaths = [...selectedPaths];
    const requestedNames = [...batchRenameNames];
    const optimisticEntries: PendingProjectFileEntry[] = batchRenameEntries.map((entry, index) => {
      const requestedName = requestedNames[index];
      const name = entry.externalLink && entry.path.toLocaleLowerCase().endsWith('.lnk') && !requestedName.toLocaleLowerCase().endsWith('.lnk') ? `${requestedName}.lnk` : requestedName;
      const parentPath = projectRelativeParentPath(entry.relativePath);
      const relativePath = normalizeProjectRelativePath(`${parentPath}/${name}`);
      const separatorIndex = Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\'));
      return { ...entry, name, path: `${separatorIndex >= 0 ? entry.path.slice(0, separatorIndex + 1) : ''}${name}`, relativePath, pendingSourceRelativePath: batchRenameEntries[index].relativePath };
    });
    const pendingOperation = startPendingFileOperation({
      kind: 'rename', label: '正在批量重命名…', lockedPaths: [...sourcePaths, ...optimisticEntries.map(entry => entry.relativePath)],
      affectedDirectories: [...new Set(sourcePaths.map(projectRelativeParentPath))], tombstonePaths: sourcePaths, optimisticEntries,
    });
    if (!pendingOperation) return;
    setBatchRenameOpen(false);
    renameCommitRef.current = true;
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>>;
    try {
      result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'rename', sourcePaths, currentRelativePath, '批量重命名', { renameNames: requestedNames });
    } catch (error) {
      await reconcilePendingFileOperation(pendingOperation, undefined, true);
      settleDirectoryPreviewRenames(optimisticEntries, false);
      onNotice(`批量重命名失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    } finally { renameCommitRef.current = false; }
    if (!result.success) {
      await reconcilePendingFileOperation(pendingOperation, result, true);
      settleDirectoryPreviewRenames(optimisticEntries, false);
      onNotice(`批量重命名失败：${result.error || '未知错误'}`);
      return;
    }
    const count = sourcePaths.length;
    setBatchRenameParts([]);
    setSelectedPaths([]);
    onNotice(`已批量重命名 ${count} 个项目`);
    if (finalViewOpen) {
      clearPendingFileOperation(pendingOperation.id);
      settleDirectoryPreviewRenames(optimisticEntries, true);
      await loadFinalViewEntries();
    } else {
      await reconcilePendingFileOperation(pendingOperation, result);
      settleDirectoryPreviewRenames(optimisticEntries, true);
    }
  };
  const openFileMenuAt = (x: number, y: number, entry: ProjectFileEntry, selectEntry = true) => {
    filesSurfaceRef.current?.focus({ preventScroll: true });
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setSurfaceMenu(null);
    setOperationDirectoryPath(isUnsupportedShortcutContent(entry) ? currentRelativePath : projectRelativeParentPath(entry.relativePath));
    fileMenuSelectionSnapshotRef.current = [...selectedPaths];
    fileMenuSelectionAnchorSnapshotRef.current = selectionAnchorPathRef.current;
    fileMenuSelectionWasImplicitRef.current = selectEntry && !selectedPaths.includes(entry.relativePath);
    if (selectEntry) {
      if (!selectedPaths.includes(entry.relativePath)) selectionAnchorPathRef.current = entry.relativePath;
      setSelectedPaths(current => current.includes(entry.relativePath) ? current : [entry.relativePath]);
    }
    setFileMenu({ entry, x, y });
  };
  const openFileMenu = (event: React.MouseEvent, entry: ProjectFileEntry, selectEntry = true) => {
    event.preventDefault();
    event.stopPropagation();
    openFileMenuAt(event.clientX, event.clientY, entry, selectEntry);
  };
  const openSurfaceMenu = (event: React.MouseEvent<HTMLElement>, targetRelativePath = currentRelativePath, targetLabel = '') => {
    if (versionTreeOpen) {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target as Element;
      const blankCanvas = target.closest('[data-version-tree-canvas]') && !target.closest('[data-version-tree-node],[data-edge-id],[data-edge-child-handle],button');
      if (!blankCanvas || normalizeProjectRelativePath(currentRelativePath) || !versionTreeModeAvailableFor()) return;
      filesSurfaceRef.current?.focus({ preventScroll: true });
      window.dispatchEvent(new Event('photoflow-menu-open'));
      setFileMenu(null);
      selectionAnchorPathRef.current = '';
      setSelectedPaths([]);
      setOperationDirectoryPath('');
      setSurfaceMenu({ x: event.clientX, y: event.clientY, targetRelativePath: '', targetLabel: '项目根目录', kind: 'version-tree-layout' });
      void loadShellNewTypes();
      return;
    }
    if ((event.target as HTMLElement).closest('[data-entry-path]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (finalViewOpen) return;
    filesSurfaceRef.current?.focus({ preventScroll: true });
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setFileMenu(null);
    selectionAnchorPathRef.current = '';
    setSelectedPaths([]);
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    setOperationDirectoryPath(normalizedTarget);
    setSurfaceMenu({ x: event.clientX, y: event.clientY, targetRelativePath: normalizedTarget, targetLabel: targetLabel || normalizedTarget || '项目根目录', kind: 'files' });
    void loadShellNewTypes();
  };
  const restoreStandardVersionTreeLayout = async () => {
    const controller = versionTreeCanvasControllerRef.current;
    setSurfaceMenu(null);
    if (!versionTreeOpen || normalizeProjectRelativePath(currentRelativePath) || !versionTreeModeAvailableFor() || !controller) return;
    if (controller.hasManualLayout) {
      const confirmed = await appDialog.confirm({
        title: '恢复版本树标准排版？',
        message: '将恢复标准排版。版本关系和文件不会改变。',
        confirmLabel: '刷新',
      });
      if (!confirmed) return;
    }
    const success = await controller.refreshLayout();
    if (success) onNotice('版本树已恢复标准排版');
  };
  const showDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const returnEntryPath = directoryEntryToRevealOnReturn(currentRelativePathRef.current, normalizedPath);
    pendingDirectoryReturnRevealRef.current = returnEntryPath ? { directoryPath: normalizedPath, entryPath: returnEntryPath } : null;
    setDirectoryReturnHighlightPath('');
    setPreviewHighlightPath('');
    // Invalidate the directory that is still loading before React commits the
    // breadcrumb change, so its late result cannot replace the new folder.
    refreshSequenceRef.current += 1;
    currentRelativePathRef.current = normalizedPath;
    const cachedEntries = directoryEntriesCacheRef.current.get(normalizedPath);
    if (cachedEntries) {
      renderedDirectoryRef.current = { path: normalizedPath, ready: true };
      setFileEntries(cachedEntries);
      setDirectoryLoading(false);
    } else {
      renderedDirectoryRef.current = { path: normalizedPath, ready: false };
      setFileEntries([]);
      setDirectoryLoading(true);
    }
    setSearchOpen(false);
    setSearchQuery('');
    setBrowseMode(browseModeForFolder(normalizedPath));
    setGridIconSize(gridIconSizeForFolder(normalizedPath));
    setCurrentRelativePath(normalizedPath);
  };
  const navigateToDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (normalizedPath === currentRelativePath) return;
    setDirectoryHistory(current => ({ back: [...current.back, currentRelativePath], forward: [] }));
    showDirectory(normalizedPath);
  };
  const showVersionTree = () => {
    if (!versionTreeModeAvailableFor()) return;
    setFinalViewOpen(false);
    setSelectedPaths([]);
    setPreviewPath('');
    setPreviewHighlightPath('');
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setSearchOpen(false);
    setSearchQuery('');
    setFileFilter('all');
    rememberFolderBrowseMode(currentRelativePath, 'version-tree');
    setBrowseMode('version-tree');
    void loadProgressFolders();
  };
  useEffect(() => {
    if (!navigationRequest) return;
    navigateToDirectory(navigationRequest.path);
  }, [navigationRequest?.id]);
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
  const openProjectEntry = async (entry: ProjectFileEntry, external = false) => {
    if (isFolderLikeEntry(entry) && !external) { navigateToDirectory(entry.relativePath); return; }
    if (entry.viaShortcut) {
      const linkedResult = await projectWorkspaceClient.openMediaVersion(entry.path);
      if (!linkedResult.success) onNotice(`打开快捷方式中的文件失败：${linkedResult.error || '无法打开文件'}`);
      return;
    }
    if (entry.kind === 'shortcut') {
      const shortcut = await projectWorkspaceClient.resolveProjectShortcut(workspacePath, project.status, project.name, entry.relativePath);
      if (!shortcut.success || !shortcut.target) { onNotice(`打开快捷方式失败：${shortcut.error || '目标不存在'}`, 6000); return; }
      const inspirationRoot = inspirationLibraryRootPath?.trim().replace(/\\/g, '/').replace(/\/+$/g, '') || '';
      const shortcutTarget = shortcut.target.replace(/\\/g, '/').replace(/\/+$/g, '');
      const normalizedRoot = inspirationRoot.toLocaleLowerCase();
      const normalizedTarget = shortcutTarget.toLocaleLowerCase();
      if (shortcut.targetKind === 'folder' && inspirationRoot && onOpenInspirationPath && (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`))) {
        onOpenInspirationPath(shortcutTarget.slice(inspirationRoot.length).replace(/^\/+/, ''));
        return;
      }
    }
    const result = await projectWorkspaceClient.openProjectEntry(workspacePath, project.status, project.name, entry.relativePath);
    if (!result.success) onNotice(`打开文件失败：${result.error || '无法打开文件'}`);
  };
  const materializeExternalLinks = async (relativePaths?: string[]) => {
    const result = await projectWorkspaceClient.materializeProjectExternalLinks(workspacePath, project.status, project.name, relativePaths);
    if (!result.success) { onNotice(`移动外链到项目失败：${result.error || '未知错误'}`, 7000); return; }
    directoryEntriesCacheRef.current.clear();
    await refresh(currentRelativePathRef.current);
    if (!relativePaths?.length && !result.partial) setHasExternalFolderLinks(false);
    onNotice(result.warning || (result.count ? `已将 ${result.count} 个外链文件夹移动到项目内` : '没有可移动的 PhotoFlow 外链文件夹'), result.warning ? 8000 : undefined);
  };
  const relinkExternalFolder = async (relativePath: string) => {
    const result = await projectWorkspaceClient.relinkProjectExternalFolder(workspacePath, project.status, project.name, relativePath);
    if (result.cancelled) return;
    if (!result.success) { onNotice(`重新定位外链失败：${result.error || '未知错误'}`, 7000); return; }
    directoryEntriesCacheRef.current.clear();
    await Promise.all([refresh(currentRelativePathRef.current), loadProgressFolders()]);
    onNotice(`外链已重新定位到 ${result.target || '新文件夹'}`);
  };
  const progressFolderForMediaEntry = (entry?: ProjectFileEntry) => {
    if (!entry || !['image', 'raw', 'video'].includes(entry.kind)) return undefined;
    const mediaKind = entry.kind === 'video' ? 'video' : 'image';
    const entryPath = entry.path.replace(/\\/g, '/').toLocaleLowerCase();
    return progressFolders.find(folder => {
      const folderPath = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      return folder.mediaKind === mediaKind && !folder.folderMissing
        && folder.nodeRole !== 'selection' && folder.relationKind !== 'auxiliary'
        && (entryPath === folderPath || entryPath.startsWith(`${folderPath}/`));
    });
  };
  const hasVersionProgressForEntry = (entry?: ProjectFileEntry) => Boolean(progressFolderForMediaEntry(entry));
  const versionProgressFolder = versionProgressId ? progressFolders.find(folder => folder.id === versionProgressId) : undefined;
  const versionProgressLocation = versionProgressFolder && !versionProgressFolder.folderMissing ? {
    progressId: versionProgressFolder.id,
    folderPath: versionProgressFolder.folderPath,
    relativePath: progressFolderRelativePath(versionProgressFolder),
  } : null;
  const renderedVersionEntry = versionEntry && versionProgressLocationRef.current && versionProgressLocation
    ? remapEntryAfterProgressFolderMove(versionEntry, versionProgressLocationRef.current, versionProgressLocation)
    : versionEntry;
  useEffect(() => {
    if (!versionProgressLocation) return;
    const previousLocation = versionProgressLocationRef.current;
    if (versionEntry && previousLocation?.progressId === versionProgressLocation.progressId) {
      setVersionEntry(current => current ? remapEntryAfterProgressFolderMove(current, previousLocation, versionProgressLocation) : current);
    }
    versionProgressLocationRef.current = versionProgressLocation;
  }, [versionProgressLocation?.folderPath, versionProgressLocation?.progressId, versionProgressLocation?.relativePath]);
  const openVersions = (entry?: ProjectFileEntry) => {
    const target = entry || selectedEntries[0];
    if (!target || !['image', 'raw', 'video'].includes(target.kind)) {
      onNotice('请先选择一张图片、RAW 或视频');
      return;
    }
    const targetProgressFolder = progressFolderForMediaEntry(target);
    if (!targetProgressFolder) {
      onNotice(`项目尚未录入${target.kind === 'video' ? '视频' : '图片'}进度，请先标记或导入版本进度`);
      return;
    }
    versionProgressLocationRef.current = {
      progressId: targetProgressFolder.id,
      folderPath: targetProgressFolder.folderPath,
      relativePath: progressFolderRelativePath(targetProgressFolder),
    };
    setVersionProgressId(targetProgressFolder.id);
    setVersionEntry(target);
    onOpenToolTab('version', `版本 · ${target.name}`);
  };
  const exportFinalVersions = async () => {
    if (finalExporting) return;
    const summary = await loadFinalVersionSummary();
    if (!summary.count) return;
    if (summary.missingCount) {
      onNotice(`有 ${summary.missingCount} 个喜爱图片已被删除或移动，请先重新定位。`, 7000);
      return;
    }
    const latestFolders = await loadProgressFolders();
    const explicitParent = selectableVersionParents(latestFolders, { mediaKind: 'image', relationKind: 'main' })
      .find(folder => folder.id === finalExportParentId);
    if (!explicitParent) {
      onNotice('请先选择喜爱图片新进度要连接的父节点', 6000);
      return;
    }
    const latestRootNumber = latestFolders
      .filter(folder => folder.mediaKind === 'image' && /^\d+$/.test(folder.versionKey))
      .reduce((highest, folder) => Math.max(highest, Number(folder.versionKey)), 0);
    const expectedName = `图片后期_${latestRootNumber + 1}_喜爱`;
    if (!await appDialog.confirm({
      title: '确定整理喜爱图片吗？',
      message: `将 ${summary.availableCount} 张喜爱图片复制到新进度“${expectedName}”。`,
      confirmLabel: '创建并复制',
    })) return;
    setFinalExporting(true);
    try {
      const result = await projectWorkspaceClient.exportFinalVersions(workspacePath, project.status, project.name, { parentProgressId: explicitParent.id });
      if (!result.success || !result.folder) throw new Error(result.error || '无法整理喜爱图片');
      directoryEntriesCacheRef.current.clear();
      await loadProgressFolders();
      await loadFinalVersionSummary();
      setFinalViewOpen(false);
      setFinalViewEntries([]);
      setSelectedPaths([]);
      setPreviewPath('');
      setPreviewHighlightPath('');
      setPreviewPaneOpen(previewPanePinnedRef.current);
      setMetadataPaneOpen(metadataPanePinnedRef.current);
      navigateToDirectory(result.folder.relativePath);
      onNotice(`成功复制文件：已将 ${result.count} 张喜爱图片放入“${result.displayName}”。`, 6000);
    } catch (error) {
      onNotice(`整理喜爱图片失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally {
      setFinalExporting(false);
    }
  };
  const openProjectEntriesInPhotoshop = async (entries: ProjectFileEntry[]) => {
    const imagePaths = entries.filter(entry => entry.kind === 'image' || entry.kind === 'raw').map(entry => entry.relativePath);
    if (!imagePaths.length) return;
    const result = await projectWorkspaceClient.openProjectEntriesInPhotoshop(workspacePath, project.status, project.name, imagePaths);
    if (!result.success) onNotice(`用 Photoshop 打开失败：${result.error || '无法打开文件'}`);
  };
  const copyEntryPath = async (entry: ProjectFileEntry) => {
    if (entry.viaShortcut) {
      try {
        await navigator.clipboard.writeText(entry.path);
        onNotice('成功复制文件地址');
      } catch {
        onNotice('复制文件地址失败');
      }
      return;
    }
    const result = await projectWorkspaceClient.copyProjectEntryPath(workspacePath, project.status, project.name, entry.relativePath);
    const typeLabel = isFolderLikeEntry(entry) ? '文件夹' : '文件';
    onNotice(result.success ? '成功复制文字' : `复制${typeLabel}地址失败：${result.error || '未知错误'}`);
  };
  const copyEntryPaths = async (entries: readonly ProjectFileEntry[]) => {
    if (entries.length === 1) {
      await copyEntryPath(entries[0]);
      return;
    }
    if (!entries.length) return;
    try {
      await navigator.clipboard.writeText(entries.map(entry => entry.path).join('\n'));
      onNotice(`已复制 ${entries.length} 个项目的地址`);
    } catch {
      onNotice('复制项目地址失败');
    }
  };
  const copyCurrentDirectoryPath = async (targetRelativePath = currentRelativePath) => {
    const result = await projectWorkspaceClient.copyProjectEntryPath(workspacePath, project.status, project.name, targetRelativePath);
    onNotice(result.success ? '成功复制文字' : `复制文件夹地址失败：${result.error || '未知错误'}`);
  };
  const dismissPreviewFromBlankClick = (drag: NonNullable<typeof selectionDragRef.current>) => {
    if (drag.started || drag.additive) return;
    if (previewPath && (previewPaneOpen || metadataPaneOpen)) {
      paneLayoutRevealPathRef.current = previewPath;
      paneLayoutRevealPendingRef.current = true;
    }
    setPreviewPath('');
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    setPreviewMediaPath('');
    setViewportCurrentPath('');
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
  };
  const stopSelectionAutoScroll = () => {
    window.cancelAnimationFrame(selectionAutoScrollFrameRef.current);
    selectionAutoScrollFrameRef.current = 0;
  };
  const getMarqueeFormulaLayout = () => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return null;
    const containerRect = container.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
    const contentWidth = fileSurfaceContentWidth(surface.clientWidth);
    if (viewMode === 'list') {
      return {
        kind: 'list' as const,
        rowHeight: Math.max(1, virtualWindowRef.current.rowHeight || FILE_LIST_ROW_HEIGHT),
        columnWidth: contentWidth,
        gap: 0,
        padding: { ...FILE_SURFACE_PADDING, top: surfaceTop + FILE_LIST_HEADER_HEIGHT },
      };
    }
    const measuredItemHeight = surface.querySelector<HTMLElement>('[data-entry-path]')?.getBoundingClientRect().height;
    const geometry = calculateFileGridGeometry(surface.clientWidth, gridIconSize, measuredItemHeight || virtualWindowRef.current.rowHeight || undefined);
    return { ...geometry, padding: { ...geometry.padding, top: surfaceTop } };
  };
  const rebuildMarqueeLayoutRegistry = () => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return marqueeLayoutRegistryRef.current;
    const containerRect = container.getBoundingClientRect();
    const registry = new Map<string, MarqueeRect>();
    for (const node of surface.querySelectorAll<HTMLElement>('[data-entry-path]')) {
      const path = node.dataset.entryPath;
      if (!path) continue;
      const rect = node.getBoundingClientRect();
      // Grouped search results and the ordinary file layout currently coexist
      // in the DOM. The ordinary layout is hidden, so its duplicate entry
      // nodes report zero-sized rectangles and must not overwrite the visible
      // search-result geometry registered under the same relative path.
      if (rect.width <= 0 || rect.height <= 0) continue;
      registry.set(path, normalizeMarqueeRect(
        { x: rect.left - containerRect.left + container.scrollLeft, y: rect.top - containerRect.top + container.scrollTop },
        { x: rect.right - containerRect.left + container.scrollLeft, y: rect.bottom - containerRect.top + container.scrollTop },
      ));
    }
    marqueeLayoutRegistryRef.current = registry;
    return registry;
  };
  const updateSelectionDragAtPoint = (clientX: number, clientY: number) => {
    const drag = selectionDragRef.current;
    const container = filesColumnRef.current;
    if (!drag || !container || !drag.started) return;
    const containerRect = container.getBoundingClientRect();
    const current = viewportPointToContentPoint({ x: clientX, y: clientY }, {
      viewportLeft: containerRect.left,
      viewportTop: containerRect.top,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    });
    const selection = normalizeMarqueeRect({ x: drag.startContentX, y: drag.startContentY }, current);
    setSelectionBox({ left: selection.left, top: selection.top, width: selection.width, height: selection.height });
    let hits: string[];
    let logicalWidth = Math.max(container.clientWidth, selection.right);
    let logicalHeight = Math.max(container.clientHeight, selection.bottom);
    if (groupedResultsActive || versionTreeOpen) {
      const registry = rebuildMarqueeLayoutRegistry();
      hits = Array.from(registry.entries()).filter(([, rect]) => rectanglesIntersect(selection, rect)).map(([path]) => path);
      const surface = filesSurfaceRef.current;
      if (surface) {
        const surfaceRect = surface.getBoundingClientRect();
        const surfaceLeft = surfaceRect.left - containerRect.left + container.scrollLeft;
        const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
        logicalWidth = Math.max(logicalWidth, surfaceLeft + surface.scrollWidth);
        logicalHeight = Math.max(logicalHeight, surfaceTop + surface.scrollHeight);
      }
      for (const rect of registry.values()) {
        logicalWidth = Math.max(logicalWidth, rect.right);
        logicalHeight = Math.max(logicalHeight, rect.bottom);
      }
    } else {
      const layout = getMarqueeFormulaLayout();
      if (!layout) return;
      hits = hitMarqueeIndices(selection, displayedFileEntries.length, layout).map(index => displayedFileEntries[index].relativePath);
      const size = finiteLogicalCanvasSize(displayedFileEntries.length, layout, { width: container.clientWidth, height: container.clientHeight }, selection);
      logicalWidth = size.width;
      logicalHeight = size.height;
    }
    setSelectionCanvasSize(currentSize => currentSize.width === logicalWidth && currentSize.height === logicalHeight ? currentSize : { width: logicalWidth, height: logicalHeight });
    setSelectedPaths(mergeMarqueeSelection(drag.initialPaths, hits, drag.additive));
  };
  const runSelectionAutoScroll = () => {
    selectionAutoScrollFrameRef.current = 0;
    const drag = selectionDragRef.current;
    const container = filesColumnRef.current;
    if (!drag || !drag.started || !container) return;
    const result = advanceMarqueeAutoScroll(container, { clientX: drag.lastClientX, clientY: drag.lastClientY });
    if (!result.edgeActive) return;
    if (result.scrolled) updateSelectionDragAtPoint(drag.lastClientX, drag.lastClientY);
    // Keep retrying while the pointer remains at an edge. The logical canvas
    // state may have grown even when its DOM scroll dimensions have not yet
    // been committed during this frame.
    selectionAutoScrollFrameRef.current = window.requestAnimationFrame(runSelectionAutoScroll);
  };
  const queueSelectionAutoScroll = () => {
    const drag = selectionDragRef.current;
    const container = filesColumnRef.current;
    if (!drag?.started || !container) return;
    const containerRect = container.getBoundingClientRect();
    const deltaY = marqueeAutoScrollDelta(drag.lastClientY, containerRect.top, containerRect.bottom);
    const deltaX = marqueeAutoScrollDelta(drag.lastClientX, containerRect.left, containerRect.right);
    if (!deltaY && !deltaX) {
      stopSelectionAutoScroll();
      return;
    }
    if (!selectionAutoScrollFrameRef.current) selectionAutoScrollFrameRef.current = window.requestAnimationFrame(runSelectionAutoScroll);
  };
  const startSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointerTarget = event.target as HTMLElement;
    if (event.button !== 0 || pointerTarget.closest('[data-entry-path], button, input, select, textarea')) return;
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return;
    const containerRect = container.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    if (event.clientY < surfaceRect.top) return;
    const recursiveFolder = pointerTarget.closest<HTMLElement>('[data-recursive-folder-path]');
    if (recursiveFolder?.dataset.recursiveFolderReadonly !== 'true') setOperationDirectoryPath(normalizeProjectRelativePath(recursiveFolder?.dataset.recursiveFolderPath || currentRelativePath));
    else if (!recursiveFolder) setOperationDirectoryPath(currentRelativePath);
    surface.focus({ preventScroll: true });
    cancelInlineRename();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const additive = event.ctrlKey || event.metaKey;
    const start = viewportPointToContentPoint({ x: event.clientX, y: event.clientY }, {
      viewportLeft: containerRect.left,
      viewportTop: containerRect.top,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    });
    selectionDragRef.current = {
      pointerId: event.pointerId,
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      startContentX: start.x,
      startContentY: start.y,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      initialPaths: [...selectedPaths],
      additive,
      started: false,
    };
    if (!additive) {
      setSelectedPaths([]);
    }
    setSelectionBox(null);
  };
  const updateSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
      stopSelectionAutoScroll();
      selectionDragRef.current = null;
      setSelectionBox(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      dismissPreviewFromBlankClick(drag);
      return;
    }
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    if (!drag.started) {
      const moved = Math.hypot(event.clientX - drag.pointerStartX, event.clientY - drag.pointerStartY);
      if (moved < 5) return;
      drag.started = true;
    }
    event.preventDefault();
    const additive = drag.additive || event.ctrlKey || event.metaKey;
    if (additive) drag.additive = true;
    updateSelectionDragAtPoint(event.clientX, event.clientY);
    queueSelectionAutoScroll();
  };
  const cancelSelectionDrag = () => {
    stopSelectionAutoScroll();
    selectionDragRef.current = null;
    setSelectionBox(null);
  };
  const finishSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    stopSelectionAutoScroll();
    selectionDragRef.current = null;
    setSelectionBox(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dismissPreviewFromBlankClick(drag);
  };
  useEffect(() => {
    const drag = selectionDragRef.current;
    if (!drag?.started) return;
    const frameId = window.requestAnimationFrame(() => updateSelectionDragAtPoint(drag.lastClientX, drag.lastClientY));
    return () => window.cancelAnimationFrame(frameId);
  }, [columnWidths.files, displayedFileEntries, gridIconSize, groupedResultsActive, metadataPaneOpen, previewPaneOpen, projectLayoutWidth, versionTreeOpen, viewMode, virtualWindow.columns, virtualWindow.rowHeight]);
  const cancelFileCut = async () => {
    if (!cutPaths.length) return;
    const cancelledPaths = [...cutPaths];
    const cancellationSequence = ++clipboardOperationSequenceRef.current;
    setClipboardPending(true);
    setCutPaths([]);
    setClipboardHasFiles(false);
    onNotice('已取消剪切');
    const result = await projectWorkspaceClient.cancelProjectFileCut(workspacePath, project.status, project.name, cancelledPaths);
    if (clipboardOperationSequenceRef.current !== cancellationSequence) return;
    setClipboardPending(false);
    if (!result.success) {
      const status = await projectWorkspaceClient.getProjectFileClipboardStatus();
      if (clipboardOperationSequenceRef.current !== cancellationSequence) return;
      setClipboardPending(false);
      setClipboardHasFiles(status.success && status.hasFiles);
      return;
    }
    setClipboardHasFiles(result.hasFiles);
  };
  const runFileOperation = async (operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename', nextName?: string, targetPaths = selectedPaths, destinationRelativePath = operationDirectoryPath) => {
    const requestedProjectPath = projectPathRef.current;
    if (finalViewOpen && operation !== 'copy') { onNotice('当前为只读视图，请到原文件夹修改。'); return; }
    if (operation !== 'paste' && activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isUnsupportedShortcutContent(entry))) { onNotice('普通快捷方式中的文件是只读浏览内容，不能执行此操作'); return; }
    const targetEntries = activeFileEntries.filter(entry => targetPaths.includes(entry.relativePath));
    if ((operation === 'copy' || operation === 'cut') && targetEntries.some(entry => entry.externalLink)) {
      onNotice('外链根不能普通复制或剪切；可以进入外链复制其中内容，或使用“移动外链到项目内”');
      return;
    }
    if (operation === 'rename' && targetEntries.some(entry => entry.externalLink && registeredProgressFolderForEntry(entry))) {
      onNotice('已标记为版本节点的外链不能普通重命名；请使用版本管理功能，或先移动外链到项目内');
      return;
    }
    if (operation === 'trash' && projectWorkflows) {
      const normalizedTargets = new Set(targetPaths.map(normalizeProjectRelativePath));
      const affectedProgressFolders = progressFolders.filter(folder => !folder.folderMissing
        && normalizedTargets.has(normalizeProjectRelativePath(folder.externalLinkRelativePath || projectRelativePath(folder.folderPath))));
      if (affectedProgressFolders.length) {
        const confirmed = await appDialog.confirm({
          title: affectedProgressFolders.length === 1 ? `删除版本 V${affectedProgressFolders[0].versionKey}？` : `删除 ${affectedProgressFolders.length} 个版本文件夹？`,
          message: '文件夹会移入回收站；数据库中的版本节点、素材历史和后代关系不会删除，并会在版本树中显示为“失效”。从回收站恢复原文件夹，或创建同版本文件夹后可以重新连接。',
          confirmLabel: '移入回收站',
          tone: 'danger',
        });
        if (!projectOperationIsCurrent(requestedProjectPath) || !confirmed) return;
      }
    }
    const isClipboardSelection = operation === 'copy' || operation === 'cut';
    const clipboardOperationSequence = isClipboardSelection ? ++clipboardOperationSequenceRef.current : 0;
    const previousCutPaths = cutPaths;
    const previousClipboardHasFiles = clipboardHasFiles;
    const pasteClipboardGeneration = operation === 'paste' ? clipboardOperationSequenceRef.current + 1 : 0;
    const pasteCutPathsSnapshot = operation === 'paste' ? [...cutPaths] : [];
    const normalizedDestination = normalizeProjectRelativePath(destinationRelativePath);
    const pendingKind = operation === 'trash' ? 'delete' : operation;
    const pendingOperation = operation === 'rename' ? null : startPendingFileOperation({
      kind: pendingKind,
      label: operation === 'trash' ? '正在移入回收站…'
        : operation === 'paste' ? '正在准备粘贴…'
          : operation === 'cut' ? '正在剪切…' : '正在复制…',
      lockedPaths: operation === 'paste'
        ? [`__directory__/${normalizedDestination || '__root__'}`, ...(normalizedDestination ? [normalizedDestination] : []), ...pasteCutPathsSnapshot, ...pasteCutPathsSnapshot.map(path => `__directory__/${projectRelativeParentPath(path) || '__root__'}`)]
        : targetPaths,
      affectedDirectories: operation === 'paste'
        ? [normalizedDestination]
        : targetPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))),
      tombstonePaths: operation === 'trash' ? targetPaths : undefined,
    });
    if (operation !== 'rename' && !pendingOperation) return;
    if (operation === 'paste') clipboardOperationSequenceRef.current = claimClipboardGeneration(clipboardOperationSequenceRef.current, true);
    if (isClipboardSelection) {
      setClipboardPending(true);
      setCutPaths(operation === 'cut' ? [...targetPaths] : []);
      setClipboardHasFiles(true);
    }
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>>;
    try {
      result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, normalizedDestination, nextName);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (result.requiresDecision?.kind === 'paste-conflict') {
        const policy = await appDialog.choice({
          title: '目标位置已有同名项目',
          message: result.requiresDecision.message,
          detail: result.requiresDecision.detail,
          choices: [
            { value: 'replace', label: '替换并继续', tone: 'danger' },
            { value: 'keep-both', label: '保留两者' },
          ],
          defaultValue: 'keep-both',
        });
        if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
        if (policy !== 'replace' && policy !== 'keep-both') {
          if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, result, true);
          if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
          onNotice('粘贴已取消'); refresh(); return;
        }
        result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, normalizedDestination, nextName, { pasteConflictPolicy: policy });
        if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      }
    } catch (error) {
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, undefined, true);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      onNotice(`操作失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
      return;
    }
    if (result.cancelled) {
      if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, result);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      if (operation === 'trash' && result.count) setSelectedPaths([]);
      if (pageOwnsFileOperationNotification(result)) onNotice('粘贴已取消');
      refresh(); return;
    }
    if (!result.success) {
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, result, operation === 'copy' || operation === 'cut');
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      if (operation === 'trash' && result.count) {
        setSelectedPaths(current => current.filter(path => !targetPaths.includes(path)));
        scheduleDirectoryRefresh(result.affectedDirectories);
        refreshRecursiveResults(targetPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))));
        if (projectWorkflows) {
          await loadProgressFolders();
          if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
        }
      }
      if (operation === 'trash' && isRecycleBinFailure(result.error, result.errorCode)) {
        await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
        if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      } else if (pageOwnsFileOperationNotification(result)) onNotice(`操作失败：${result.error || '未知错误'}`);
      return;
    }
    if (operation === 'copy' || operation === 'cut') {
      if (pendingOperation) clearPendingFileOperation(pendingOperation.id);
      if (clipboardOperationSequenceRef.current !== clipboardOperationSequence) return;
      setCutPaths(operation === 'cut' ? [...targetPaths] : []);
      setClipboardHasFiles(true);
      setClipboardPending(false);
      onNotice(operation === 'copy' ? '成功复制文件' : `已剪切 ${targetPaths.length} 个项目`);
    } else {
      if (operation === 'paste' && result.consumedCutClipboard
        && clipboardOperationSequenceRef.current === pasteClipboardGeneration
        && cutPaths.length === pasteCutPathsSnapshot.length
        && pasteCutPathsSnapshot.every(path => cutPaths.includes(path))) setCutPaths([]);
      if (operation === 'trash') setCutPaths(current => current.filter(path => !targetPaths.includes(path)));
      if (pageOwnsFileOperationNotification(result)) {
        onNotice(operation === 'trash' && result.warning ? result.warning : operation === 'trash'
          ? result.permanentCount
            ? `已删除 ${result.count} 个项目，其中 ${result.permanentCount} 个已按 Windows 确认永久删除`
            : `已移入回收站 ${result.count} 个项目`
          : operation === 'paste'
            ? result.replacedCount
              ? result.replacedRetainedCount
                ? `已粘贴 ${result.count} 个项目；替换了 ${result.replacedCount} 个同名项目，其中 ${result.replacedRetainedCount} 个原项目因回收站操作失败而保留为安全恢复副本${result.replacedPermanentCount ? `，另有 ${result.replacedPermanentCount} 个已按 Windows 确认永久删除，此次替换无法撤销` : ''}`
                : result.replacedPermanentCount
                ? `已粘贴 ${result.count} 个项目；替换了 ${result.replacedCount} 个同名项目，其中 ${result.replacedPermanentCount} 个原项目已按 Windows 确认永久删除，此次替换无法撤销`
                : `已粘贴 ${result.count} 个项目；${result.replacedCount} 个同名项目的原内容已移入回收站`
              : `已粘贴 ${result.count} 个项目`
            : '操作完成', result.warning ? 8000 : undefined);
      }
      setSelectedPaths([]);
      if (projectWorkflows && (operation === 'trash' || operation === 'paste')) {
        await loadProgressFolders();
        if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      }
      if (pendingOperation) await reconcilePendingFileOperation(pendingOperation, result);
      else scheduleDirectoryRefresh(result.affectedDirectories);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      refreshRecursiveResults(operation === 'paste'
        ? normalizedDestination
        : targetPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))));
    }
  };
  useEffect(() => {
    const handleFileShortcut = (event: KeyboardEvent) => {
      if (!active) return;
      const target = event.target as HTMLElement | null;
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (commandKey && key === 'f' && !target?.closest('[role="dialog"]')) {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new Event('photoflow-menu-open'));
        setSearchOpen(true);
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (!target) return;
      const insideFileSurface = Boolean(filesSurfaceRef.current?.contains(target));
      let handled = false;

      if (event.key === 'Escape' && cutPaths.length) {
        void cancelFileCut();
        handled = true;
      } else if (commandKey && !event.altKey && !event.shiftKey && key === 'a') {
        setSelectedPaths(displayedFileEntries.map(entry => entry.relativePath));
        onNotice(`已选择 ${displayedFileEntries.length} 个项目`);
        handled = true;
      } else if (event.key === 'F2' && versionTreeOpen && selectedPaths.length) {
        beginRename();
        handled = true;
      } else if (!insideFileSurface) {
        return;
      } else if (commandKey && !event.altKey && !event.shiftKey && key === 'c' && selectedPaths.length) {
        void runFileOperation('copy');
        handled = true;
      } else if (commandKey && !event.altKey && !event.shiftKey && key === 'x' && selectedPaths.length) {
        void runFileOperation('cut');
        handled = true;
      } else if (commandKey && !event.altKey && !event.shiftKey && key === 'v') {
        void runFileOperation('paste');
        handled = true;
      } else if (event.key === 'Delete' && selectedPaths.length) {
        void runFileOperation('trash');
        handled = true;
      } else if (event.key === 'F2' && selectedPaths.length) {
        beginRename();
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
  const selectedEntries = useMemo(() => activeFileEntries.filter(entry => selectedPaths.includes(entry.relativePath)), [activeFileEntries, selectedPaths]);
  const selectedRelativePaths = useMemo(() => selectedEntries.map(entry => entry.relativePath), [selectedEntries]);
  const componentHostSelectedRelativePaths = useMemo(() => safeComponentHostSelectedRelativePaths(selectedEntries), [selectedEntries]);
  const selectedContainsShortcutContent = selectedEntries.some(isUnsupportedShortcutContent);
  const registeredProgressFolderForEntry = (entry?: ProjectFileEntry) => {
    if (!entry) return undefined;
    const entryPath = (entry.externalLinkTarget || entry.path).replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const entryRelativePath = normalizeProjectRelativePath(entry.relativePath).toLocaleLowerCase('zh-CN');
    return progressFolders.find(folder => {
      const folderPath = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      const folderRelativePath = progressFolderRelativePath(folder).toLocaleLowerCase('zh-CN');
      return folderPath === entryPath || folderRelativePath === entryRelativePath;
    });
  };
  const entryIsInsideProgressFolder = (entry: ProjectFileEntry) => {
    const entryPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    return progressFolders.some(folder => {
      const folderPath = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      return entryPath === folderPath || entryPath.startsWith(`${folderPath}/`);
    });
  };
  const isProtectedRenameEntry = (entry: ProjectFileEntry) => {
    if (!isFolderLikeEntry(entry)) return false;
    const normalizedPath = normalizeProjectRelativePath(entry.relativePath);
    if (!normalizedPath || normalizedPath.includes('/')) return false;
    const normalizedName = entry.name.toLocaleLowerCase('zh-CN');
    return PROTECTED_PROJECT_FOLDER_NAMES.has(normalizedName);
  };
  const selectedContainsProtectedRenameEntry = selectedEntries.some(isProtectedRenameEntry);
  const selectedRegisteredProgressRenameEntries = selectedEntries.filter(entry => registeredProgressFolderForEntry(entry)?.nodeRole === 'progress');
  const selectedContainsBlockedProgressRenameEntry = selectedRegisteredProgressRenameEntries.length > 0
    && selectedEntries.length !== 1;
  const selectedProgressFolder = selectedEntries.length === 1 && isFolderLikeEntry(selectedEntries[0]) ? selectedEntries[0] : undefined;
  const selectedRegisteredProgressFolder = registeredProgressFolderForEntry(selectedProgressFolder);
  const selectedEditableProgressFolder = selectedRegisteredProgressFolder?.nodeRole === 'progress' ? selectedRegisteredProgressFolder : undefined;
  const focusedEntry = activeFileEntries.find(entry => entry.relativePath === previewPath);
  useEffect(() => {
    let active = true;
    setSelectionEntryDetails({});
    if (selectedEntries.length < 2) {
      setSelectionEntryDetailsLoading(false);
      return () => { active = false; };
    }
    const targets = selectedEntries.filter(entry => (isFolderLikeEntry(entry) || entry.size < 0) && (!entry.viaShortcut || entry.viaExternalLink));
    if (!targets.length) {
      setSelectionEntryDetailsLoading(false);
      return () => { active = false; };
    }
    setSelectionEntryDetailsLoading(true);
    void (async () => {
      for (const target of targets) {
        let result: Awaited<ReturnType<typeof projectWorkspaceClient.getProjectEntryDetails>>;
        try { result = await projectWorkspaceClient.getProjectEntryDetails(workspacePath, project.status, project.name, target.relativePath); }
        catch { continue; }
        if (!active) return;
        if (result.success && result.details) {
          setSelectionEntryDetails(current => ({ ...current, [target.path]: result.details! }));
        }
      }
    })().finally(() => { if (active) setSelectionEntryDetailsLoading(false); });
    return () => { active = false; };
  }, [selectedEntries, workspacePath, project.status, project.name]);
  const listedPreviewEntry = activeFileEntries.find(entry => entry.relativePath === previewMediaPath && (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'));
  const previewEntry = postTrimPreviewEntry?.relativePath === previewMediaPath ? postTrimPreviewEntry : listedPreviewEntry;
  previewRatingIdentityRef.current = previewEntry ? mediaRatingCacheKey(previewEntry.path, previewEntry.updatedAt) : '';
  useEffect(() => {
    ratingMutationSequenceRef.current += 1;
    setPreviewRatingBusy(false);
  }, [previewEntry?.path, previewEntry?.updatedAt]);
  useEffect(() => {
    if (postTrimPreviewEntry && postTrimPreviewEntry.relativePath !== previewMediaPath) setPostTrimPreviewEntry(undefined);
  }, [postTrimPreviewEntry?.relativePath, previewMediaPath]);
  const filesInCurrentDirectory = activeFileEntries.filter(entry => !isFolderLikeEntry(entry));
  const folderOnlyGridCount = browseMode === 'grid' && filesInCurrentDirectory.length === 0 ? displayedFileEntries.filter(isFolderLikeEntry).length : 0;
  const viewportCurrentEntry = filesInCurrentDirectory.find(entry => entry.relativePath === viewportCurrentPath);
  const viewportCurrentFileNumber = viewportCurrentEntry ? filesInCurrentDirectory.findIndex(entry => entry.relativePath === viewportCurrentEntry.relativePath) + 1 : 0;
  const currentPreviewMetadataFields = previewMetadataFieldsForEntry(previewMetadataFields, previewMetadataResolvedPath, focusedEntry?.path);
  const currentPreviewMetadataLoading = Boolean(focusedEntry && (previewMetadataLoading || previewMetadataResolvedPath !== focusedEntry.path));
  const currentPreviewMetadataError = focusedEntry && previewMetadataResolvedPath === focusedEntry.path ? previewMetadataError : '';
  const previewCanMarkFinal = Boolean(previewEntry && (!previewEntry.viaShortcut || previewEntry.viaExternalLink) && (previewEntry.kind === 'image' || previewEntry.kind === 'raw'));
  const previewRatingCacheKey = previewEntry ? mediaRatingCacheKey(previewEntry.path, previewEntry.updatedAt) : '';
  useEffect(() => {
    let active = true;
    setPreviewRating(0);
    setPreviewRatingLoading(false);
    if (!previewEntry || !previewCanMarkFinal) return () => { active = false; };
    const cached = previewRatingCacheRef.current.get(previewRatingCacheKey);
    if (cached !== undefined) {
      setPreviewRating(cached);
      return () => { active = false; };
    }
    setPreviewRatingLoading(true);
    let request = previewRatingRequestsRef.current.get(previewRatingCacheKey);
    if (!request) {
      request = projectWorkspaceClient.getMediaRating(previewEntry.path);
      previewRatingRequestsRef.current.set(previewRatingCacheKey, request);
      void request.finally(() => previewRatingRequestsRef.current.delete(previewRatingCacheKey)).catch(() => undefined);
    }
    request.then(result => {
      if (!active || !result.success) return;
      if (previewRatingCacheRef.current.size >= 400) previewRatingCacheRef.current.delete(previewRatingCacheRef.current.keys().next().value as string);
      previewRatingCacheRef.current.set(previewRatingCacheKey, result.rating);
      setPreviewRating(result.rating);
    }).catch(() => undefined).finally(() => { if (active) setPreviewRatingLoading(false); });
    return () => { active = false; };
  }, [previewEntry?.path, previewEntry?.updatedAt, previewCanMarkFinal, previewRatingCacheKey]);
  const updatePreviewRating = async (requestedRating: number) => {
    if (!previewEntry || !previewCanMarkFinal || previewRatingBusy) return;
    const targetEntry = previewEntry;
    const targetIdentity = mediaRatingCacheKey(targetEntry.path, targetEntry.updatedAt);
    const mutationSequence = ++ratingMutationSequenceRef.current;
    const previousRating = previewRating;
    setPreviewRating(requestedRating);
    setPreviewRatingBusy(true);
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.setMediaRating>>;
    try {
      result = await projectWorkspaceClient.setMediaRating(workspacePath, targetEntry.path, requestedRating);
    } catch (error) {
      previewRatingCacheRef.current.set(targetIdentity, previousRating);
      if (ratingMutationSequenceRef.current === mutationSequence && previewRatingIdentityRef.current === targetIdentity) {
        setPreviewRating(previousRating);
        setPreviewRatingBusy(false);
        onNotice(`更新图片标星失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const previewIsCurrent = ratingMutationPreviewIsCurrent(mutationSequence, ratingMutationSequenceRef.current, targetIdentity, previewRatingIdentityRef.current);
    if (previewIsCurrent) setPreviewRatingBusy(false);
    if (!result.success) {
      previewRatingCacheRef.current.set(targetIdentity, previousRating);
      if (previewIsCurrent) setPreviewRating(previousRating);
      onNotice(`更新图片标星失败：${result.error || '未知错误'}`);
      return;
    }
    if (previewIsCurrent) setPreviewRating(result.rating);
    if (previewRatingCacheRef.current.size >= 400 && !previewRatingCacheRef.current.has(targetIdentity)) previewRatingCacheRef.current.delete(previewRatingCacheRef.current.keys().next().value as string);
    previewRatingCacheRef.current.set(targetIdentity, result.rating);
    setFilterRatings(current => ({ ...current, [targetEntry.path]: result.rating }));
    const applyRating = (entries: ProjectFileEntry[]) => entries.map(entry => entry.path === targetEntry.path ? { ...entry, rating: result.rating } : entry);
    setFileEntries(applyRating);
    setSearchEntries(applyRating);
    setScopeEntries(applyRating);
    for (const [cacheKey, entries] of directoryEntriesCacheRef.current) directoryEntriesCacheRef.current.set(cacheKey, applyRating(entries));
    if (previewIsCurrent && previewMetadataResolvedPath === targetEntry.path) {
      setPreviewMetadataFields(current => {
        const index = current.findIndex(field => field.name === 'Rating');
        if (index < 0) return [...current, { group: 'XMP', name: 'Rating', value: String(result.rating) }];
        return current.map((field, fieldIndex) => fieldIndex === index ? { ...field, value: String(result.rating) } : field);
      });
    }
    if (finalViewOpen) {
      if (result.rating > 0) setFinalViewEntries(current => current.map(entry => entry.path === targetEntry.path ? { ...entry, rating: result.rating } : entry));
      else {
        setFinalViewEntries(current => current.filter(entry => entry.path !== targetEntry.path));
        if (previewIsCurrent) {
          setPreviewPath('');
          setPreviewHighlightPath('');
          setPreviewPaneOpen(previewPanePinnedRef.current);
          setMetadataPaneOpen(metadataPanePinnedRef.current);
        }
      }
    }
    onNotice(result.rating > 0 ? `已写入 ${result.rating} 星评分` : '已清除图片评分');
  };
  const showCompletedVideoTrim = async (result: { outputPath?: string; relativePath?: string; replaced?: boolean }, sourceRelativePathValue: string) => {
    const sourceRelativePath = normalizeProjectRelativePath(sourceRelativePathValue);
    const targetRelativePath = normalizeProjectRelativePath(result.relativePath || sourceRelativePath);
    if (!result.outputPath || !targetRelativePath) {
      onNotice('视频已导出，但无法定位导出文件', 7000);
      return;
    }
    const sourceEntry = [previewEntry, ...fileEntries, ...searchEntries, ...scopeEntries]
      .find(entry => entry?.relativePath === sourceRelativePath);
    const targetName = targetRelativePath.split('/').pop() || sourceEntry?.name || '裁剪视频.mp4';
    const targetExtensionIndex = targetName.lastIndexOf('.');
    const now = Date.now();
    const targetPreviewEntry: ProjectFileEntry = {
      name: targetName,
      path: result.outputPath,
      relativePath: targetRelativePath,
      kind: 'video',
      extension: targetExtensionIndex >= 0 ? targetName.slice(targetExtensionIndex).toLocaleLowerCase() : sourceEntry?.extension || '',
      size: -1,
      createdAt: result.replaced && sourceEntry ? sourceEntry.createdAt : now,
      updatedAt: now,
    };
    // Replacing a file keeps the same path. Clearing the media path for one
    // render guarantees that the old Windows player handle is discarded.
    setPreviewMediaPath('');
    directoryEntriesCacheRef.current.clear();
    refreshRecursiveResults(projectRelativeParentPath(sourceRelativePath));
    await refresh(currentRelativePathRef.current).catch(error => {
      console.error('Unable to refresh trimmed video directory', error);
    });
    setPostTrimPreviewEntry(targetPreviewEntry);
    selectionAnchorPathRef.current = targetRelativePath;
    setSelectedPaths([targetRelativePath]);
    setPreviewPath(targetRelativePath);
    setPreviewHighlightPath(targetRelativePath);
    setPreviewMediaPath(targetRelativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(true);
    onNotice('裁剪视频完成');
  };
  const trimPreviewVideo = async (start: number, end: number, saveMode: 'new' | 'replace', operationId: string, sourceDuration: number) => {
    if (!previewEntry || previewEntry.kind !== 'video' || isUnsupportedShortcutContent(previewEntry)) return { success: false, error: '当前视频不可剪辑' };
    const sourceRelativePath = previewEntry.relativePath;
    const result = await projectWorkspaceClient.trimProjectVideo(workspacePath, project.status, project.name, sourceRelativePath, { start, end, saveMode, exportMode: videoTools.trim.exportMode, operationId, sourceDuration });
    if (!result.success) {
      if (result.cancelled) {
        onNotice('已取消视频导出');
        return result;
      }
      onNotice(`视频剪辑失败：${result.error || '未知错误'}`, 7000);
      return result;
    }
    // Keep compatibility with a renderer hot reload talking to the previous
    // main-process handler, which returns the final result instead of a start
    // acknowledgement. A full app restart switches to the detached path.
    if (!result.started && result.outputPath) await showCompletedVideoTrim(result, sourceRelativePath);
    return result;
  };
  useEffect(() => {
    if (!active) return;
    const task = backgroundTasks.find(item => item.type === 'video-trim'
      && (item.state === 'completed' || item.state === 'cancelled' || item.state === 'failed')
      && !handledVideoTrimTaskIds.has(item.id)
      && backgroundTaskPathKey(item.metadata?.workspacePath) === backgroundTaskPathKey(workspacePath)
      && item.metadata?.projectStatus === project.status
      && item.metadata?.projectName === project.name);
    if (!task) return;
    const result = task.metadata?.result as { outputPath?: string; relativePath?: string; replaced?: boolean } | undefined;
    // The previous main-process implementation has no result metadata and
    // resolves the original IPC request with the completed file instead.
    if (task.state === 'completed' && !result) return;
    handledVideoTrimTaskIds.add(task.id);
    if (task.state === 'cancelled' || task.state === 'failed') return;
    void showCompletedVideoTrim(result || {}, String(task.metadata?.sourceRelativePath || ''));
  }, [active, backgroundTasks, project.name, project.status, showCompletedVideoTrim, workspacePath]);
  const loadPreviewVideoTimelineFrames = useCallback((times: number[]) => {
    if (!previewEntry || previewEntry.kind !== 'video' || isUnsupportedShortcutContent(previewEntry)) return Promise.resolve({ success: false, error: '当前视频不可读取' });
    return projectWorkspaceClient.getProjectVideoTimelineFrames(workspacePath, project.status, project.name, previewEntry.relativePath, times);
  }, [previewEntry?.kind, previewEntry?.relativePath, previewEntry?.viaShortcut, workspacePath, project.status, project.name]);
  const previewMediaEntries = displayedFileEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
  const scrollFileEntryIntoView = useCallback((relativePath: string, align: 'nearest' | 'center' = 'nearest', requestId?: number): 'complete' | 'scheduled' | 'unavailable' => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    const fileIndex = displayedFileEntries.findIndex(entry => entry.relativePath === relativePath);
    if (fileIndex < 0 || !container || !surface) return 'unavailable';

    const findRenderedNode = () => Array.from(surface.querySelectorAll<HTMLElement>('[data-entry-path]')).find(item => item.dataset.entryPath === relativePath);
    const revealRenderedNode = () => {
      const node = findRenderedNode();
      if (!node) return false;
      const containerRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const fullyVisible = nodeRect.top >= containerRect.top
        && nodeRect.bottom <= containerRect.bottom
        && nodeRect.left >= containerRect.left
        && nodeRect.right <= containerRect.right;
      if (align === 'center') node.scrollIntoView({ block: 'center', inline: 'nearest' });
      else if (!fullyVisible) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    };

    window.cancelAnimationFrame(fileRevealFrameRef.current);
    fileRevealPathRef.current = '';
    if (revealRenderedNode()) return 'complete';

    fileRevealPathRef.current = relativePath;
    fileRevealFrameRef.current = window.requestAnimationFrame(() => {
      if (fileRevealPathRef.current !== relativePath) return;
      const surfaceWidth = Math.max(1, surface.clientWidth);
      const columns = viewMode === 'list' ? 1 : Math.max(1, Math.floor((surfaceWidth + 12) / (gridIconSize + 12)));
      const cellWidth = viewMode === 'list' ? surfaceWidth : (surfaceWidth - (columns - 1) * 12) / columns;
      const measuredItem = surface.querySelector<HTMLElement>('[data-entry-path]');
      const measuredRowHeight = measuredItem ? measuredItem.getBoundingClientRect().height + (viewMode === 'list' ? 0 : 12) : 0;
      const rowHeight = measuredRowHeight || (viewMode === 'list' ? 48 : cellWidth + 68);
      const targetRow = Math.floor(fileIndex / columns);
      const targetTop = targetRow * rowHeight;
      const targetBottom = targetTop + rowHeight;
      const headerHeight = viewMode === 'list' ? 32 : 0;
      const containerRect = container.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
      const visibleTop = Math.max(0, container.scrollTop - surfaceTop - headerHeight);
      const visibleHeight = Math.max(rowHeight, container.clientHeight - headerHeight);
      const nextVisibleTop = targetTop < visibleTop
        ? targetTop
        : targetBottom > visibleTop + visibleHeight ? targetBottom - visibleHeight : visibleTop;
      container.scrollTo({ top: Math.max(0, surfaceTop + headerHeight + nextVisibleTop) });

      let attempts = 0;
      const finishReveal = () => {
        if (fileRevealPathRef.current !== relativePath) return;
        if (revealRenderedNode()) {
          fileRevealPathRef.current = '';
          if (requestId !== undefined) setPendingFileReveal(current => current?.requestId === requestId ? null : current);
          return;
        }
        attempts += 1;
        if (attempts >= 12) {
          fileRevealPathRef.current = '';
          if (requestId !== undefined) setPendingFileReveal(current => current?.requestId === requestId ? null : current);
          return;
        }
        fileRevealFrameRef.current = window.requestAnimationFrame(finishReveal);
      };
      fileRevealFrameRef.current = window.requestAnimationFrame(finishReveal);
    });
    return 'scheduled';
  }, [displayedFileEntries, gridIconSize, viewMode]);
  useEffect(() => () => {
    window.cancelAnimationFrame(fileRevealFrameRef.current);
    fileRevealPathRef.current = '';
  }, []);
  useEffect(() => {
    if (!pendingFileReveal || scrollFileEntryIntoView(pendingFileReveal.path, pendingFileReveal.align, pendingFileReveal.requestId) !== 'complete') return;
    setPendingFileReveal(current => current?.requestId === pendingFileReveal.requestId ? null : current);
  }, [pendingFileReveal, scrollFileEntryIntoView]);
  useEffect(() => {
    const paneLayout = `${previewPaneOpen}:${metadataPaneOpen}`;
    const paneLayoutChanged = previousPaneLayoutRef.current !== '' && previousPaneLayoutRef.current !== paneLayout;
    previousPaneLayoutRef.current = paneLayout;
    if (paneLayoutChanged) paneLayoutRevealPendingRef.current = true;
    const revealPath = previewPath || paneLayoutRevealPathRef.current;
    if (!revealPath) return;
    let frameId = 0;
    let previousWidth = -1;
    let stableFrames = 0;
    let attempts = 0;
    const revealAfterStableLayout = () => {
      const width = filesSurfaceRef.current?.clientWidth || 0;
      stableFrames = width > 0 && Math.abs(width - previousWidth) < 1 ? stableFrames + 1 : 0;
      previousWidth = width;
      attempts += 1;
      const expectedColumns = viewMode === 'list' ? 1 : Math.max(1, Math.floor((width + 12) / (gridIconSize + 12)));
      const virtualLayoutReady = virtualWindowRef.current.columns === expectedColumns && virtualWindowRef.current.rowHeight > 0;
      if ((stableFrames >= 2 && virtualLayoutReady) || attempts >= 24) {
        const align = paneLayoutRevealPendingRef.current ? 'center' : 'nearest';
        paneLayoutRevealPendingRef.current = false;
        if (paneLayoutRevealPathRef.current === revealPath) paneLayoutRevealPathRef.current = '';
        requestFileReveal(revealPath, align);
        return;
      }
      frameId = window.requestAnimationFrame(revealAfterStableLayout);
    };
    frameId = window.requestAnimationFrame(revealAfterStableLayout);
    return () => window.cancelAnimationFrame(frameId);
  }, [previewPath, previewPaneOpen, metadataPaneOpen, requestFileReveal, viewMode, gridIconSize]);
  useEffect(() => {
    let active = true;
    if (browseMode !== 'grid' || !viewportCurrentEntry || viewportCurrentFileNumber <= 0) {
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
      }).catch(() => { if (active) setViewportStatus(nextStatus); });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [browseMode, viewportCurrentEntry?.path, viewportCurrentEntry?.updatedAt, viewportCurrentFileNumber, filesInCurrentDirectory.length]);
  useEffect(() => {
    let active = true;
    setPreviewMetadataFields([]);
    setPreviewMetadataResolvedPath('');
    setPreviewMetadataError('');
    if (!focusedEntry) {
      setPreviewMetadataLoading(false);
      return () => { active = false; };
    }
    if (focusedEntry.kind === 'folder' || focusedEntry.kind === 'file' || focusedEntry.kind === 'shortcut') {
      setPreviewMetadataResolvedPath(focusedEntry.path);
      setPreviewMetadataLoading(false);
      return () => { active = false; };
    }
    setPreviewMetadataLoading(true);
    projectWorkspaceClient.getMediaMetadata(focusedEntry.path).then(result => {
      if (!active) return;
      if (!result.success) {
        setPreviewMetadataError(result.error || '无法读取完整详细信息');
        setPreviewMetadataResolvedPath(focusedEntry.path);
        return;
      }
      setPreviewMetadataFields(result.fields);
      setPreviewMetadataResolvedPath(focusedEntry.path);
    }).catch(error => {
      if (!active) return;
      setPreviewMetadataError(error instanceof Error ? error.message : String(error || '无法读取完整详细信息'));
      setPreviewMetadataResolvedPath(focusedEntry.path);
    }).finally(() => { if (active) setPreviewMetadataLoading(false); });
    return () => { active = false; };
  }, [focusedEntry?.path, focusedEntry?.updatedAt]);
  useEffect(() => {
    let active = true;
    setPreviewEntryDetails(null);
    if (!focusedEntry || (focusedEntry.viaShortcut && !focusedEntry.viaExternalLink)) return () => { active = false; };
    projectWorkspaceClient.getProjectEntryDetails(workspacePath, project.status, project.name, focusedEntry.relativePath).then(result => {
      if (active && result.success && result.details) setPreviewEntryDetails(result.details);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [focusedEntry?.path, workspacePath, project.status, project.name]);
  useEffect(() => {
    if (!previewPaneOpen || !previewPath) return;
    let frameId = 0;
    let attempts = 0;
    const focusPreviewEntryNode = () => {
      const entryNode = Array.from(filesSurfaceRef.current?.querySelectorAll<HTMLElement>('[data-entry-path]') || [])
        .find(node => node.dataset.entryPath === previewPath);
      if (entryNode) {
        entryNode.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      if (attempts < 24) frameId = window.requestAnimationFrame(focusPreviewEntryNode);
    };
    frameId = window.requestAnimationFrame(focusPreviewEntryNode);
    return () => window.cancelAnimationFrame(frameId);
  }, [previewPaneOpen, previewPath]);
  const navigatePreviewMedia = useCallback((direction: -1 | 1) => {
    if (!previewEntry) return;
    const navigableEntries = previewEntry.kind === 'video'
      ? previewMediaEntries.filter(entry => entry.kind === 'video')
      : previewMediaEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw');
    const currentIndex = navigableEntries.findIndex(entry => entry.relativePath === previewEntry.relativePath);
    if (currentIndex < 0) return;
    const nextIndex = clampNumber(currentIndex + direction, 0, navigableEntries.length - 1);
    if (nextIndex === currentIndex) return;
    const nextEntry = navigableEntries[nextIndex];
    setPreviewPath(nextEntry.relativePath);
    setPreviewHighlightPath(nextEntry.relativePath);
    setDirectoryReturnHighlightPath('');
    setPreviewMediaPath(nextEntry.relativePath);
    setPreviewTechnicalMetadata({});
  }, [previewEntry?.relativePath, previewMediaEntries]);
  useEffect(() => {
    const switchPreviewMedia = (event: KeyboardEvent) => {
      if (!previewPaneOpen || !previewEntry || !['image', 'raw'].includes(previewEntry.kind) || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      navigatePreviewMedia(event.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', switchPreviewMedia);
    return () => window.removeEventListener('keydown', switchPreviewMedia);
  }, [previewPaneOpen, previewEntry?.relativePath, previewEntry?.kind, navigatePreviewMedia]);
  const displayedColumnWidths = fitProjectColumnWidths(columnWidths, projectLayoutWidth, previewPaneOpen, metadataPaneOpen);
  const fileListTrackWidth = Math.max(0, displayedColumnWidths.files - FILE_SURFACE_HORIZONTAL_PADDING * 2 - FILE_LIST_GRID_CHROME_WIDTH);
  const displayedFileListColumnWidths = fileListColumnsCustomized
    ? fileListColumnWidths
    : fitFileListColumnWidths(DEFAULT_FILE_LIST_COLUMN_WIDTHS, fileListTrackWidth);
  const fileListColumnsWidth = FILE_LIST_COLUMN_KEYS.reduce((total, key) => total + displayedFileListColumnWidths[key], FILE_LIST_GRID_CHROME_WIDTH);
  const fileListViewportWidth = Math.max(0, displayedColumnWidths.files - FILE_SURFACE_HORIZONTAL_PADDING * 2);
  const fileListGridStyle = {
    '--file-list-name-width': `${displayedFileListColumnWidths.name}px`,
    '--file-list-modified-width': `${displayedFileListColumnWidths.modified}px`,
    '--file-list-type-width': `${displayedFileListColumnWidths.type}px`,
    '--file-list-size-width': `${displayedFileListColumnWidths.size}px`,
    width: Math.max(fileListColumnsWidth, fileListViewportWidth),
  } as React.CSSProperties;
  const resizeFileListBoundary = (boundary: FileListColumnBoundary, deltaX: number) => {
    setFileListColumnsCustomized(true);
    setFileListColumnWidths(resizeFileListColumnBoundary(displayedFileListColumnWidths, boundary, deltaX));
  };
  const visiblePreferredTotal = columnWidths.files + (previewPaneOpen ? columnWidths.preview : 0) + (metadataPaneOpen ? columnWidths.metadata : 0);
  const visibleAvailableWidth = Math.max(1, projectLayoutWidth - Number(previewPaneOpen) - Number(metadataPaneOpen));
  const columnCompressionScale = Math.min(1, visibleAvailableWidth / Math.max(1, visiblePreferredTotal));
  const preferredDragDelta = (deltaX: number) => deltaX / Math.max(0.35, columnCompressionScale);
  const resizeFilesAndPreview = (deltaX: number) => setColumnWidths(current => {
    const total = current.files + current.preview;
    // The preview is allowed to consume the complete two-column viewport.
    // Keeping a minimum width on the files column imposed an artificial
    // maximum on the preview pane.
    const files = clampNumber(current.files + preferredDragDelta(deltaX), 0, total);
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
  const canSelectMedia = !finalViewOpen && !selectedContainsShortcutContent && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
  const selectedScreenshotMainImageEntries = selectedEntries.filter(entry => isScreenshotMainImageEntry(entry) && !entryIsInsideProgressFolder(entry));
  const canExtractScreenshotMainImage = !finalViewOpen && selectedScreenshotMainImageEntries.length > 0;
  const selectedResearchTargets = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'video' || isFolderLikeEntry(entry)) ? selectedEntries : [];
  const selectedVideoSplitTargets = selectedResearchTargets;
  const selectedOfficeExtractEntries = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(isOfficeOpenXmlEntry) ? selectedEntries : [];
  const fileMenuEntrySelected = Boolean(fileMenu && selectedPaths.includes(fileMenu.entry.relativePath));
  const fileMenuTargetPaths = fileMenu
    ? fileMenuEntrySelected ? selectedPaths : [fileMenu.entry.relativePath]
    : selectedPaths;
  const fileMenuContainsShortcutContent = fileMenuTargetPaths.some(path => activeFileEntries.some(entry => entry.relativePath === path && isUnsupportedShortcutContent(entry)));
  const fileMenuEntries = fileMenuTargetPaths.map(relativePath => activeFileEntries.find(entry => entry.relativePath === relativePath)).filter((entry): entry is ProjectFileEntry => Boolean(entry));
  const fileMenuContainsProtectedRenameEntry = fileMenuEntries.some(isProtectedRenameEntry);
  const fileMenuRegisteredProgressRenameEntries = fileMenuEntries.filter(entry => registeredProgressFolderForEntry(entry)?.nodeRole === 'progress');
  const fileMenuContainsBlockedProgressRenameEntry = fileMenuRegisteredProgressRenameEntries.length > 0
    && fileMenuEntries.length !== 1;
  const fileMenuVersionTreeFolder = registeredProgressFolderForEntry(fileMenu?.entry);
  const fileMenuRegisteredProgressFolder = fileMenuVersionTreeFolder?.nodeRole === 'progress' ? fileMenuVersionTreeFolder : undefined;
  const fileMenuScreenshotMainImageEntries = fileMenu
    ? fileMenuEntrySelected ? selectedEntries.filter(entry => isScreenshotMainImageEntry(entry) && !entryIsInsideProgressFolder(entry)) : isScreenshotMainImageEntry(fileMenu.entry) && !entryIsInsideProgressFolder(fileMenu.entry) ? [fileMenu.entry] : []
    : [];
  const canSelectFileMenuMedia = !finalViewOpen && fileMenuTargetPaths.length > 0 && fileMenuTargetPaths.every(path => {
    const entry = activeFileEntries.find(candidate => candidate.relativePath === path);
    return Boolean(entry && !isUnsupportedShortcutContent(entry) && (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'));
  });
  const gatherInspiration = async (targetProject: WorkspaceProject, targetPaths: string[]) => {
    if (!gatherToProject || gatheringInspiration) return;
    if (!inspirationTargetWorkspacePath?.trim()) { onNotice('请先设置项目工作目录'); return; }
    if (!targetPaths.length) { onNotice('请先选择要汇聚的文件或文件夹'); return; }
    setGatheringInspiration(true);
    try {
      const result = await projectWorkspaceClient.addInspirationToProject(workspacePath, inspirationTargetWorkspacePath, targetProject.status, targetProject.name, targetPaths);
      if (!result.success) { onNotice(`汇聚灵感失败：${result.error || '未知错误'}`, 7000); return; }
      setInspirationTargetProject(targetProject);
      try { window.localStorage.setItem('photoflow:inspiration-target-project', targetProject.path); } catch { /* storage unavailable */ }
      window.dispatchEvent(new Event('photoflow:inspiration-target-project-changed'));
      setGatherPickerPaths(null);
      setSelectedPaths([]);
      const details = [result.shortcutCount ? `${result.shortcutCount} 个文件夹快捷方式` : '', result.fileCount ? `${result.fileCount} 个文件` : ''].filter(Boolean).join('、');
      onNotice(`已将${details || `${result.count || 0} 项内容`}添加到项目“${targetProject.name}”的“策划”文件夹`);
    } finally {
      setGatheringInspiration(false);
    }
  };
  const startGatherInspiration = (targetPaths: string[]) => {
    if (!targetPaths.length) { onNotice('请先选择要汇聚的文件或文件夹'); return; }
    if (inspirationTargetProject) void gatherInspiration(inspirationTargetProject, targetPaths);
    else setGatherPickerPaths(targetPaths);
  };
  useEffect(() => {
    if (!gatherToProject) return;
    const addFolder = (event: Event) => {
      const detail = (event as CustomEvent<{ relativePath?: string; chooseProject?: boolean }>).detail;
      const relativePath = detail?.relativePath?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!relativePath) return;
      if (detail.chooseProject) setGatherPickerPaths([relativePath]);
      else startGatherInspiration([relativePath]);
    };
    window.addEventListener('photoflow:inspiration-add-folder-to-project', addFolder);
    return () => window.removeEventListener('photoflow:inspiration-add-folder-to-project', addFolder);
  }, [gatherToProject, inspirationTargetProject, inspirationProjects.length, gatheringInspiration]);
  const openResearchForEntries = async (entries: ProjectFileEntry[]) => {
    if (!entries.length || entries.some(entry => entry.kind !== 'video' && !isFolderLikeEntry(entry))) return;
    if (projectPanelIsRunning('research')) { setPanel('research'); return; }
    const sequence = ++researchInspectionSequenceRef.current;
    const folderEntries = entries.filter(isFolderLikeEntry);
    setResearchTargetPath(entries.length === 1 ? entries[0].path : '');
    setResearchTargetPaths(entries.map(entry => entry.path));
    setResearchCollecting(folderEntries.length > 0);
    setResearchTargetHasTxt(false);
    setPanel('research');
    if (!folderEntries.length) return;
    if (entries.length === 1) {
      void projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, entries[0].relativePath, mediaCacheConfig).then(result => {
        if (sequence !== researchInspectionSequenceRef.current) return;
        setResearchTargetHasTxt(Boolean(result.success && result.entries.some(candidate => candidate.extension.toLocaleLowerCase() === '.txt')));
      });
    }
    while (sequence === researchInspectionSequenceRef.current) {
      const result = await projectWorkspaceClient.inspectProjectToolSources(workspacePath, project.status, project.name, entries.map(entry => entry.relativePath), true);
      if (sequence !== researchInspectionSequenceRef.current) return;
      if (!result.success) {
        setResearchCollecting(false);
        onNotice(`读取视频索引失败：${result.error || '未知错误'}`);
        return;
      }
      if (result.indexed) {
        setResearchCollecting(false);
        if (!result.videoPaths.length) onNotice('所选文件夹中没有视频');
        return;
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 800));
    }
  };
  const selectMediaFiles = async (targetPaths = selectedPaths) => {
    if (finalViewOpen) { onNotice('喜爱图片浏览是只读视图，请回到原文件夹进行选片'); return; }
    const targetEntries = activeFileEntries.filter(entry => targetPaths.includes(entry.relativePath));
    const canSelectTargets = targetEntries.length > 0 && targetEntries.length === targetPaths.length && targetEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
    if (!canSelectTargets) { onNotice(targetPaths.length ? '只能选择媒体文件' : '请先选择媒体文件'); return; }
    const sourceFolders = new Set(targetEntries.map(entry => projectRelativeParentPath(entry.relativePath)));
    if (sourceFolders.size !== 1) { onNotice('一次手动选片只能选择同一来源文件夹中的媒体。'); return; }
    const sourceFolderRelativePath = [...sourceFolders][0] || '';
    const preflight = await projectWorkspaceClient.preflightManualSelection(project.path, { sourceFolderRelativePath, relativePaths: targetPaths });
    if (!preflight.success || !preflight.signature) { onNotice(`选片预检失败：${preflight.error || '未知错误'}`); return; }
    const decision = await appDialog.choice({
      title: '确认手动选片',
      message: `${preflight.sourceFolderRelativePath || '项目根目录'} → ${preflight.targetFolderRelativePath || preflight.outputFolderName || '选片输出'}`,
      detail: `匹配 ${preflight.matchedCount || targetPaths.length}；已存在 ${preflight.existingCount || 0}；冲突 ${preflight.conflictCount || 0}；未找到 ${preflight.missingCount || 0}。不会覆盖已有文件。`,
      choices: [{ value: 'execute', label: '确认选片' }],
      defaultValue: 'execute',
      cancelLabel: '取消',
      cancelDefault: true,
    });
    if (decision !== 'execute') return;
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.executeManualSelection>>;
    try {
      result = await projectWorkspaceClient.executeManualSelection(project.path, { sourceFolderRelativePath, relativePaths: targetPaths, expectedSignature: preflight.signature, operationId: crypto.randomUUID() });
    } catch (error) {
      onNotice(`选片失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
      return;
    }
    if (!result.success || result.cancelled) {
      if (pageOwnsFileOperationNotification(result)) onNotice(`选片失败：${result.error || (result.cancelled ? '已取消并回滚本次创建内容' : '未知错误')}`);
      return;
    }
    if (pageOwnsFileOperationNotification(result)) onNotice(`已向“${result.targetFolderRelativePath || result.outputFolderName || '选片输出'}”追加 ${result.copiedCount || 0} 个媒体；附属节点已登记。`);
    setSelectedPaths([]);
    await loadProgressFolders();
    directoryEntriesCacheRef.current.clear();
    refresh('');
  };
  const focusEntry = (entry: ProjectFileEntry) => {
    setPreviewPath(entry.relativePath);
    if (itemOpenMode === 'double' || (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video')) {
      setPreviewMediaPath('');
      setPreviewTechnicalMetadata({});
    }
  };
  const activateMediaPreview = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video') return;
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    focusEntry(entry);
    setPreviewMediaPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    if (previewPanePinned || !previewPaneAutoOpenSuppressed) setPreviewPaneOpen(true);
  };
  const openPreviewFromMenu = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video') return;
    setPreviewHighlightPath(entry.relativePath);
    setDirectoryReturnHighlightPath('');
    focusEntry(entry);
    setPreviewMediaPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneAutoOpenSuppressed(false);
    setPreviewPaneOpen(true);
  };
  const closePreviewPaneByUser = () => {
    setPreviewPanePinned(false);
    setPreviewPaneAutoOpenSuppressed(true);
    setPreviewPaneOpen(false);
  };
  const closeMetadataPaneByUser = () => {
    setMetadataPanePinned(false);
    setMetadataPaneAutoOpenSuppressed(true);
    setMetadataPaneOpen(false);
  };
  const togglePreviewPanePinned = () => {
    const nextPinned = !previewPanePinned;
    setPreviewPanePinned(nextPinned);
    setPreviewPaneAutoOpenSuppressed(false);
    if (nextPinned) setPreviewPaneOpen(true);
  };
  const toggleMetadataPanePinned = () => {
    const nextPinned = !metadataPanePinned;
    setMetadataPanePinned(nextPinned);
    setMetadataPaneAutoOpenSuppressed(false);
    if (nextPinned) setMetadataPaneOpen(true);
  };
  const openEntryDetails = (entry: ProjectFileEntry) => {
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    focusEntry(entry);
    setMetadataPaneAutoOpenSuppressed(false);
    setMetadataPaneOpen(true);
  };
  const addSelectionAndSyncOpenPanes = (entry: ProjectFileEntry) => {
    selectionAnchorPathRef.current = entry.relativePath;
    setSelectedPaths(current => current.includes(entry.relativePath) ? current : [...current, entry.relativePath]);
    if (!previewPaneOpen && !metadataPaneOpen) return;
    const isMedia = entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video';
    setPreviewPath(entry.relativePath);
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    if (previewPaneOpen) setPreviewMediaPath(isMedia ? entry.relativePath : '');
    setPreviewTechnicalMetadata({});
  };
  const activateEntry = (entry: ProjectFileEntry) => {
    const isMedia = entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video';
    if (isMedia) {
      activateMediaPreview(entry);
      if (metadataPanePinned || !previewOnlyOnMediaClick && !metadataPaneAutoOpenSuppressed) setMetadataPaneOpen(true);
      else if (previewOnlyOnMediaClick) setMetadataPaneOpen(false);
      return;
    }
    setPreviewHighlightPath('');
    setDirectoryReturnHighlightPath('');
    focusEntry(entry);
    if (previewPanePinned) setPreviewPaneOpen(true);
    else setPreviewPaneOpen(false);
    if (metadataPanePinned || !metadataPaneAutoOpenSuppressed) setMetadataPaneOpen(true);
    void openProjectEntry(entry);
  };
  const handleEntryClick = (event: React.MouseEvent | React.KeyboardEvent, entry: ProjectFileEntry) => {
    if (!('key' in event) && suppressDraggedEntryClickRef.current?.path === entry.relativePath) { event.preventDefault(); event.stopPropagation(); return; }
    if (pendingOperationForEntry(entry).pendingOperationId) { event.preventDefault(); event.stopPropagation(); return; }
    if (inlineRenamePath === entry.relativePath) return;
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    setOperationDirectoryPath(isUnsupportedShortcutContent(entry) ? currentRelativePath : projectRelativeParentPath(entry.relativePath));
    if ('key' in event) {
      event.preventDefault();
      event.stopPropagation();
      activateEntry(entry);
      return;
    }
    const pointerModifiers = entryPointerModifiersRef.current?.path === entry.relativePath ? entryPointerModifiersRef.current : null;
    entryPointerModifiersRef.current = null;
    const range = event.shiftKey || Boolean(pointerModifiers?.range);
    const additive = event.ctrlKey || event.metaKey || Boolean(pointerModifiers?.additive);
    const intent = fileEntryClickIntent({ openMode: itemOpenMode, selectionCount: selectedPaths.length, entrySelected: selectedPaths.includes(entry.relativePath), range, additive, clickCount: event.detail });
    if (intent === 'ignore-repeat') return;
    if (intent === 'range-select') {
      selectEntryRange(entry.relativePath, additive);
      return;
    }
    if (intent === 'toggle-select') {
      toggleSelected(entry.relativePath);
      return;
    }
    if (intent === 'add-and-preview') {
      addSelectionAndSyncOpenPanes(entry);
      return;
    }
    if (intent === 'select') {
      selectionAnchorPathRef.current = entry.relativePath;
      setSelectedPaths([entry.relativePath]);
      return;
    }
    activateEntry(entry);
  };
  const handleEntryDoubleClick = (event: React.MouseEvent, entry: ProjectFileEntry) => {
    if (suppressDraggedEntryClickRef.current?.path === entry.relativePath) { event.preventDefault(); event.stopPropagation(); return; }
    if (pendingOperationForEntry(entry).pendingOperationId) { event.preventDefault(); event.stopPropagation(); return; }
    if (itemOpenMode !== 'double' || inlineRenamePath === entry.relativePath) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    activateEntry(entry);
  };
  const handleFileSurfacePointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointerTarget = event.target as HTMLElement;
    // Focusing the entry during the capture phase would blur the rename input
    // before its own pointer handler gets a chance to run.
    if (pointerTarget.closest('[data-inline-rename-input]')) return;
    const target = pointerTarget.closest<HTMLElement>('[data-entry-path]');
    target?.focus({ preventScroll: true });
    if (target?.dataset.entryPath) {
      const relativePath = target.dataset.entryPath;
      entryPointerModifiersRef.current = fileEntryPointerModifiers({
        path: relativePath,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        pointerType: event.pointerType as 'mouse' | 'pen' | 'touch',
      });
    }
  };
  const getEntryDisplayName = (entry: ProjectFileEntry) => (entry.kind === 'shortcut' || entry.externalLink) && entry.name.toLocaleLowerCase().endsWith('.lnk')
    ? entry.name.slice(0, -4)
    : entry.name;
  const getEntryTypeLabel = (entry: ProjectFileEntry) => entry.externalLink ? '外链'
    : entry.sourceChannel === 'inspiration' ? '灵感库'
    : entry.kind === 'folder' ? '文件夹'
      : entry.kind === 'shortcut' ? '快捷方式'
        : entry.kind === 'raw' ? `RAW · ${entry.extension.slice(1)}`
          : entry.kind === 'video' ? `视频 · ${entry.extension.slice(1)}`
            : entry.extension.slice(1) || '文件';
  const renderEntryName = (entry: ProjectFileEntry, grid = false) => inlineRenamePath === entry.relativePath ? <input
    data-inline-rename-input="true"
    autoFocus
    value={inlineRenameValue}
    onFocus={event => event.currentTarget.setSelectionRange(0, getInlineRenameSelectionEnd(entry))}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
    onChange={event => setInlineRenameValue(event.target.value)}
    onBlur={() => { void commitInlineRename(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); void commitInlineRename(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelInlineRename(); }
    }}
    className={`${grid ? 'mt-2 w-full text-xs' : 'min-w-0 flex-1 text-sm'} rounded border border-blue-500 bg-white px-1.5 py-0.5 text-slate-800 outline-none ring-2 ring-blue-200`}
  /> : grid ? <p className="mt-2 truncate text-xs font-medium text-slate-700">{getEntryDisplayName(entry)}</p> : <span className="truncate font-medium text-slate-700">{getEntryDisplayName(entry)}</span>;
  const renderEntryIcon = (entry: ProjectFileEntry, large = false, queueOrder = displayedFileEntries.findIndex(candidate => candidate.path === entry.path)) => {
    const visualEntry = entry;
    if (isFolderLikeEntry(visualEntry)) {
      const cover = <FolderCover entry={visualEntry} cacheConfig={mediaCacheConfig} requestedSize={large ? 320 : 160} queueOrder={queueOrder} large={large} loadEntries={loadDirectoryPreviewEntries}/>;
      return <>{cover}{entry.externalLink && <span aria-label="外链" className="shortcut-cover-badge"><ArrowUpRight size={large ? 16 : 10}/></span>}</>;
    }
    if (visualEntry.kind === 'shortcut') {
      const shortcutIcon = <ShortcutEntryIcon entry={visualEntry} cacheConfig={mediaCacheConfig} requestedSize={large ? 320 : 160} queueOrder={queueOrder} large={large} loadEntries={loadDirectoryPreviewEntries}/>;
      return large ? <span className="relative flex h-full w-full min-h-0 min-w-0 items-center justify-center">{shortcutIcon}</span> : shortcutIcon;
    }
    if (visualEntry.kind === 'image' || visualEntry.kind === 'raw' || visualEntry.kind === 'video') return <><MediaThumbnail entry={visualEntry} cacheConfig={mediaCacheConfig} requestedSize={large ? gridThumbnailSize : 160} queueOrder={queueOrder} large={large}/>{entry.externalLink && <span aria-label="外链" className="shortcut-cover-badge"><ArrowUpRight size={large ? 16 : 10}/></span>}</>;
    return <SystemFileIcon filePath={visualEntry.path} size={large ? 48 : 28}/>;
  };
  const entryHasPreviewState = (entry: ProjectFileEntry) => previewHighlightPath === entry.relativePath || directoryReturnHighlightPath === entry.relativePath;
  const renderEntrySelectionControl = (entry: ProjectFileEntry, list = false) => {
    const selected = selectedPaths.includes(entry.relativePath);
    const pending = Boolean(pendingOperationForEntry(entry).pendingOperationId);
    return <button
      type="button"
      disabled={pending}
      aria-pressed={selected}
      aria-label={`${selected ? '取消选择' : '选择'} ${getEntryDisplayName(entry)}`}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
      onClick={event => {
        event.stopPropagation();
        if (event.detail > 1) return;
        if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey);
        else toggleSelected(entry.relativePath);
      }}
      className={`${list ? 'file-select-box' : 'file-grid-select'} ${selected ? 'is-selected border-blue-600 bg-blue-600 text-white' : `border-slate-300 ${list ? 'bg-white' : 'bg-white/90'} text-transparent`} ${list ? 'flex h-4 w-4 shrink-0' : 'absolute left-3 top-3 z-10 flex h-4 w-4'} items-center justify-center rounded border`}
    ><CheckSquare size={12}/></button>;
  };
  const entryDragPaths = (entry: ProjectFileEntry) => {
    return fileEntryDragPaths(entry.relativePath, selectedPaths, path => activeFileEntries.some(candidate => candidate.relativePath === path && isUnsupportedShortcutContent(candidate)));
  };
  const resetNativeDragSession = (expectedSessionId: string) => {
    const session = nativeFileDragSessionRef.current;
    if (!session || session.id !== expectedSessionId) return false;
    if (session.folderTabSource) window.dispatchEvent(new Event('photoflow:folder-tab-drag-end'));
    nativeFileDragSessionRef.current = null;
    internalDragPathsRef.current = [];
    internalDropHandledRef.current = false;
    if (suppressDraggedEntryClickRef.current?.sessionId === expectedSessionId) suppressDraggedEntryClickRef.current = null;
    setDragTargetPath(''); setRecursiveDropTargetPath(null); setSurfaceDropActive(false);
    return true;
  };
  const startEntryDrag = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry, origin: 'file-browser' | 'version-tree' = 'file-browser') => {
    event.preventDefault();
    event.stopPropagation();
    const { requestedPaths, dragPaths } = entryDragPaths(entry);
    if (pendingPathConflicts(pendingFileOperationsRef.current, requestedPaths)) { onNotice('所选项目正在处理中，暂时不能拖动'); return; }
    if (!dragPaths.length) return;
    const sessionId = crypto.randomUUID();
    const folderTabSource = origin === 'file-browser' && dragPaths.length === 1 && isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry);
    internalDragPathsRef.current = origin === 'file-browser' ? dragPaths : [];
    internalDropHandledRef.current = false;
    nativeFileDragSessionRef.current = { id: sessionId, origin, paths: dragPaths, folderTabSource };
    suppressDraggedEntryClickRef.current = { path: entry.relativePath, sessionId };
    if (folderTabSource) window.dispatchEvent(new Event('photoflow:folder-tab-drag-start'));
    tryStartNativeFileDrag(() => projectWorkspaceClient.startProjectFileDrag(workspacePath, project.status, project.name, dragPaths, {
      sessionId, sourcePageId: pageId, origin,
    }), () => { if (resetNativeDragSession(sessionId)) onNotice('无法开始文件拖动，请重试'); });
  };
  const finishEntryDrag = () => {
    internalDragPathsRef.current = [];
    setDragTargetPath(''); setRecursiveDropTargetPath(null); setSurfaceDropActive(false);
  };
  useEffect(() => {
    const nextIdentity = nativeFileDragOwnerIdentity(pageId, project.path); const reset = nativeFileDragSessionMustReset(nativeFileDragOwnerIdentityRef.current, nextIdentity, active); nativeFileDragOwnerIdentityRef.current = nextIdentity;
    if (!reset) return;
    if (nativeFileDragSessionRef.current?.folderTabSource) window.dispatchEvent(new Event('photoflow:folder-tab-drag-end'));
    nativeFileDragSessionRef.current = null;
    internalDragPathsRef.current = []; internalDropHandledRef.current = false; suppressDraggedEntryClickRef.current = null;
    setDragTargetPath(''); setRecursiveDropTargetPath(null); setSurfaceDropActive(false);
  }, [active, pageId, project.path]);
  const hasExternalFiles = (event: React.DragEvent<HTMLElement>) => !nativeFileDragSessionRef.current && internalDragPathsRef.current.length === 0 && Array.from(event.dataTransfer.types).includes('Files');
  const getExternalFilePaths = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.files)
    .map(file => {
      try { return projectWorkspaceClient.getPathForFile(file); }
      catch { return ''; }
    })
    .filter(Boolean);
  const internalMovePathsForTarget = (paths: string[], targetRelativePath: string) => {
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const normalizedSources = paths.map(source => ({ source, normalized: normalizeProjectRelativePath(source) }));
    if (normalizedSources.some(({ normalized }) => normalizedTarget === normalized || normalizedTarget.startsWith(`${normalized}/`))) return [];
    return normalizedSources.filter(({ normalized }) => projectRelativeParentPath(normalized) !== normalizedTarget).map(({ source }) => source);
  };
  const canDropInternalIntoFolder = (entry: ProjectFileEntry) => internalMovePathsForTarget(internalDragPathsRef.current, entry.relativePath).length > 0;
  const resolveNativeDragTarget = (element: Element | null) => nativeFileDragTargetFromElement({ element, surface: filesSurfaceRef.current, currentRelativePath: currentRelativePathRef.current, rootLabel: project.name, normalize: normalizeProjectRelativePath });
  const reportNativeDragDecision = (reason: string, result: { clientX: number; clientY: number; insideWindow: boolean; started: boolean }, targetSource = 'none') => window.electronAPI?.reportRendererInfo?.('Native project file drag decision', nativeFileDragDecisionDetails(reason, result, targetSource));
  const trackingSuggestionsForCreatedItems = (items: Array<{ name: string; relativePath: string; isDirectory: boolean }>) => {
    const folders = items.filter(item => item.isDirectory).map(item => ({
      relativePath: normalizeProjectRelativePath(item.relativePath),
      name: item.name,
      mediaKind: /(mov|video|视频|剪辑|成片)/iu.test(item.name) ? 'video' as const : 'image' as const,
    }));
    const hasRawFolder = folders.some(folder => /^(raw|原片|原图|底片)$/iu.test(folder.name));
    return folders.filter(folder => !(hasRawFolder && /^(jpg|jpeg|preview|previews|proxy|预览|代理)$/iu.test(folder.name)));
  };
  const performDirectoryDrop = async (internalPaths: string[], externalPaths: string[], targetRelativePath: string, targetName: string) => {
    const requestedProjectPath = projectPathRef.current;
    const operation = internalPaths.length ? 'move' : 'import';
    const paths = internalPaths.length ? internalPaths : externalPaths;
    if (!paths.length) return;
    if (internalPaths.some(relativePath => {
      const entry = activeFileEntries.find(candidate => normalizeProjectRelativePath(candidate.relativePath) === normalizeProjectRelativePath(relativePath));
      return Boolean(entry?.externalLink && registeredProgressFolderForEntry(entry));
    })) {
      onNotice('已标记为版本节点的外链不能普通移动；请使用版本管理功能，或先移动外链到项目内');
      return;
    }
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const pendingOperation = startPendingFileOperation({
      kind: operation, label: operation === 'move' ? '正在移动…' : '正在导入…',
      lockedPaths: [...internalPaths, `__directory__/${normalizedTarget || '__root__'}`, ...(normalizedTarget ? [normalizedTarget] : [])],
      affectedDirectories: [normalizedTarget, ...internalPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path)))],
      tombstonePaths: operation === 'move' ? internalPaths : undefined,
    });
    if (!pendingOperation) return;
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>>;
    try {
      result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, paths, targetRelativePath);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
    } catch (error) {
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      await reconcilePendingFileOperation(pendingOperation, undefined);
      if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
      onNotice(`${operation === 'move' ? '移动' : '导入'}失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
      return;
    }
    const pageOwnsNotice = pageOwnsFileOperationNotification(result);
    if (result.cancelled) { await reconcilePendingFileOperation(pendingOperation, result); if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return; if (pageOwnsNotice) onNotice(operation === 'move' ? '移动已取消' : '导入已取消'); return; }
    if (!result.success) { await reconcilePendingFileOperation(pendingOperation, result); if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return; if (pageOwnsNotice) onNotice(`${operation === 'move' ? '移动' : '导入'}失败：${result.error || '未知错误'}`); return; }
    if (operation === 'move') setCutPaths(current => current.filter(path => !paths.includes(path)));
    setSelectedPaths([]);
    if (pageOwnsNotice) onNotice(`已${operation === 'move' ? '移动' : '导入'} ${result.count} 个项目到 ${targetName}`);
    if (operation === 'import' && projectWorkflows) {
      const folders = trackingSuggestionsForCreatedItems(result.createdItems || []);
      if (folders.length) setPendingProgressFolders(folders);
    }
    await reconcilePendingFileOperation(pendingOperation, result);
    if (discardStaleProjectOperation(requestedProjectPath, pendingOperation)) return;
    refreshRecursiveResults([targetRelativePath, ...internalPaths.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path)))]);
  };
  const handleEntryDragOver = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (!isFolderLikeEntry(entry) || (!canDropInternalIntoFolder(entry) && !hasExternalFiles(event))) return;
    event.preventDefault();
    event.stopPropagation();
    // Electron's native file drag advertises copy support to Windows. Accept it
    // as copy here so the cursor is not shown as forbidden; an internal drop is
    // still completed as a move by the main process.
    event.dataTransfer.dropEffect = 'copy';
    setSurfaceDropActive(false);
    setRecursiveDropTargetPath(null);
    if (dragTargetPath !== entry.relativePath) setDragTargetPath(entry.relativePath);
  };
  const handleEntryDragLeave = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (dragTargetPath === entry.relativePath) setDragTargetPath('');
  };
  const handleEntryDrop = async (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (!isFolderLikeEntry(entry)) return;
    const requestedInternalPaths = [...internalDragPathsRef.current];
    const externalDrop = !requestedInternalPaths.length && hasExternalFiles(event);
    if (externalDrop) { event.preventDefault(); event.stopPropagation(); }
    const internalPaths = internalMovePathsForTarget(requestedInternalPaths, entry.relativePath);
    const externalPaths = requestedInternalPaths.length ? [] : getExternalFilePaths(event);
    if (requestedInternalPaths.length ? !internalPaths.length : !externalPaths.length) {
      if (externalDrop) onNotice('无法读取拖入文件的系统路径，请重新拖入');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    internalDropHandledRef.current = requestedInternalPaths.length > 0;
    finishEntryDrag();
    setSurfaceDropActive(false);
    await performDirectoryDrop(internalPaths, externalPaths, entry.relativePath, entry.name);
  };
  const handleRecursiveFolderDragOver = (event: React.DragEvent<HTMLElement>, targetRelativePath: string, readOnly: boolean) => {
    if (readOnly) return;
    const internalPaths = internalMovePathsForTarget(internalDragPathsRef.current, targetRelativePath);
    if (internalDragPathsRef.current.length ? !internalPaths.length : !hasExternalFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setSurfaceDropActive(false);
    setDragTargetPath('');
    setRecursiveDropTargetPath(normalizeProjectRelativePath(targetRelativePath));
  };
  const handleRecursiveFolderDragLeave = (event: React.DragEvent<HTMLElement>, targetRelativePath: string) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (recursiveDropTargetPath === normalizeProjectRelativePath(targetRelativePath)) setRecursiveDropTargetPath(null);
  };
  const handleRecursiveFolderDrop = async (event: React.DragEvent<HTMLElement>, targetRelativePath: string, targetName: string, readOnly: boolean) => {
    if (readOnly) return;
    const requestedInternalPaths = [...internalDragPathsRef.current];
    const externalDrop = !requestedInternalPaths.length && hasExternalFiles(event);
    if (externalDrop) { event.preventDefault(); event.stopPropagation(); }
    const internalPaths = internalMovePathsForTarget(requestedInternalPaths, targetRelativePath);
    const externalPaths = requestedInternalPaths.length ? [] : getExternalFilePaths(event);
    if (requestedInternalPaths.length ? !internalPaths.length : !externalPaths.length) {
      if (externalDrop) onNotice('无法读取拖入文件的系统路径，请重新拖入');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    internalDropHandledRef.current = requestedInternalPaths.length > 0;
    finishEntryDrag();
    setSurfaceDropActive(false);
    await performDirectoryDrop(internalPaths, externalPaths, normalizeProjectRelativePath(targetRelativePath), targetName);
  };
  useEffect(() => {
    const acceptInternalFolderDrag = (event: DragEvent) => {
      const session = nativeFileDragSessionRef.current;
      if (!activeRef.current || !session || session.origin !== 'file-browser' || !internalDragPathsRef.current.length) return;
      const target = resolveNativeDragTarget(event.target as HTMLElement | null);
      if (!target || !internalMovePathsForTarget(internalDragPathsRef.current, target.relativePath).length) {
        setDragTargetPath(''); setRecursiveDropTargetPath(null);
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      if (target.element.dataset.entryKind === 'folder') {
        setRecursiveDropTargetPath(null); setDragTargetPath(target.relativePath);
      } else if (target.element.dataset.recursiveFolderPath !== undefined) {
        setDragTargetPath(''); setRecursiveDropTargetPath(target.relativePath);
      } else {
        setDragTargetPath(''); setRecursiveDropTargetPath(null);
      }
    };
    window.addEventListener('dragover', acceptInternalFolderDrag, true);
    return () => window.removeEventListener('dragover', acceptInternalFolderDrag, true);
  }, []);
  projectFileDragEndHandlerRef.current = result => {
    const session = nativeFileDragSessionRef.current;
    if (!session || result.sessionId !== session.id || result.sourcePageId !== pageId) return;
    nativeFileDragSessionRef.current = null;
    const releaseElement = result.insideWindow ? document.elementFromPoint(result.clientX, result.clientY) : null;
    if (session.folderTabSource) window.dispatchEvent(new Event('photoflow:folder-tab-drag-end'));
    const clickSuppression = suppressDraggedEntryClickRef.current;
    window.setTimeout(() => { if (suppressDraggedEntryClickRef.current === clickSuppression) suppressDraggedEntryClickRef.current = null; }, 250);
    const dragPaths = result.paths?.length ? result.paths : session.paths;
    finishEntryDrag();
    if (internalDropHandledRef.current) {
      internalDropHandledRef.current = false; reportNativeDragDecision('html-drop-already-handled', result, 'html-drop'); return;
    }
    if (!result.started) { reportNativeDragDecision('native-drag-not-started', result); return; }
    if (!result.insideWindow) { reportNativeDragDecision('released-outside-window', result); return; }
    const titlebarDropZone = releaseElement?.closest<HTMLElement>('[data-folder-tab-drop-zone="true"]');
    if (session.folderTabSource && titlebarDropZone && dragPaths.length === 1 && onOpenDirectoryPage) {
      const draggedEntry = activeFileEntries.find(entry => normalizeProjectRelativePath(entry.relativePath) === normalizeProjectRelativePath(dragPaths[0]));
      if (draggedEntry && isFolderLikeEntry(draggedEntry) && !isUnsupportedShortcutContent(draggedEntry)) {
        reportNativeDragDecision('folder-tab-opened', result, 'release-hit-test');
        onOpenDirectoryPage(draggedEntry.relativePath);
        return;
      }
    }
    const target = resolveNativeDragTarget(releaseElement);
    if (session.origin === 'version-tree') {
      reportNativeDragDecision(target ? 'version-tree-internal-target-rejected' : 'version-tree-external-drag-ended', result, target ? 'release-hit-test' : 'none');
      return;
    }
    if (!dragPaths.length) { reportNativeDragDecision('empty-source-set', result); return; }
    if (!target) { reportNativeDragDecision('no-internal-target', result); return; }
    const targetRelativePath = target.relativePath;
    const movablePaths = internalMovePathsForTarget(dragPaths, targetRelativePath);
    if (!movablePaths.length) { reportNativeDragDecision('target-is-source-or-current-parent', result, 'release-hit-test'); return; }
    reportNativeDragDecision('internal-move-accepted', result, 'release-hit-test');
    void performDirectoryDrop(movablePaths, [], targetRelativePath, target.label);
  };
  useEffect(() => projectWorkspaceClient.onProjectFileDragEnd(result => projectFileDragEndHandlerRef.current(result)), []);
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
    event.preventDefault();
    event.stopPropagation();
    const externalPaths = getExternalFilePaths(event);
    setSurfaceDropActive(false);
    if (!externalPaths.length) { onNotice('无法读取拖入文件的系统路径，请重新拖入'); return; }
    if (finalViewOpen) { onNotice('喜爱图片浏览是只读视图，不能导入文件'); return; }
    await performDirectoryDrop([], externalPaths, currentRelativePath, currentRelativePath.split('/').pop() || project.name);
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
      setGridIconSize(current => rememberFolderGridIconSize(currentRelativePathRef.current, current + direction * intensity));
    };
    zoomSurface.addEventListener('wheel', zoomWithWheel, { capture: true, passive: false });
    return () => {
      zoomSurface.removeEventListener('wheel', zoomWithWheel, true);
    };
  }, [viewMode, folderGridIconSizeStorageKey]);

  const versionTreeStatusLabel = (folder: ProgressFolder) => trackingStateLabel(folder);
  const adoptVersionTreeFolder = async (entry: Pick<ProjectFileEntry, 'name' | 'relativePath'>, mode: 'original' | 'broll', mediaKind: 'image' | 'video' | 'mixed') => {
    const result = await projectWorkspaceClient.adoptVersionTreeFolder(workspacePath, project.status, {
      projectName: project.name,
      relativePath: entry.relativePath,
      mode,
      mediaKind,
    });
    if (!result.success || !result.progressFolder) {
      onNotice(`标记失败：${result.error || '未知错误'}`, 5000);
      return false;
    }
    await loadProgressFolders();
    onNotice(mode === 'original' ? `已将“${entry.name}”设为${mediaKind === 'image' ? '图片' : '视频'}原始素材。` : `已将“${entry.name}”标记为花絮。`);
    return true;
  };
  const renderVersionTreeEntry = (entry: ProjectFileEntry, progressFolder?: ProgressFolder, sourceKind?: 'image' | 'video') => {
    const selected = selectedPaths.includes(entry.relativePath);
    const previewed = entryHasPreviewState(entry);
    const returnHighlighted = directoryReturnHighlightPath === entry.relativePath;
    const workflow = progressFolder?.nodeRole === 'workflow';
    const previewArtifact = progressFolder?.nodeRole === 'artifact' && progressFolder.artifactKind === 'preview';
    const transcodeArtifact = progressFolder?.nodeRole === 'artifact' && progressFolder.artifactKind === 'transcode';
    const displayName = getEntryDisplayName(entry);
    const statusLabel = progressFolder
      ? progressFolder.nodeRole === 'original' ? '原始素材'
        : progressFolder.nodeRole === 'broll' ? '花絮'
        : progressFolder.nodeRole === 'selection' || progressFolder.relationKind === 'auxiliary' ? '选片辅助节点'
          : previewArtifact ? '预览产物'
            : transcodeArtifact ? '转码产物'
            : workflow ? '协作工作区'
              : versionTreeStatusLabel(progressFolder)
      : sourceKind === 'image' ? '原始图片素材'
        : sourceKind === 'video' ? '原始视频素材'
          : getEntryTypeLabel(entry);
    return <div
      role="button"
      tabIndex={0}
      draggable={false}
      onDragOver={event => handleEntryDragOver(event, entry)}
      onDragLeave={event => handleEntryDragLeave(event, entry)}
      onDrop={event => void handleEntryDrop(event, entry)}
      data-entry-kind={entry.kind}
      data-drop-capable={isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry) ? 'true' : 'false'}
      data-entry-path={entry.relativePath}
      data-return-highlight={returnHighlighted ? 'true' : undefined}
      onMouseEnter={() => prefetchDirectory(entry)}
      onClick={event => handleEntryClick(event, entry)}
      onDoubleClick={event => handleEntryDoubleClick(event, entry)}
      onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }}
      onContextMenu={event => openFileMenu(event, entry)}
      title={entry.name}
      className={`group relative min-w-0 cursor-default rounded-lg border p-2 text-left transition ${progressFolder ? 'border-transparent bg-slate-500/[0.025] hover:border-blue-300/60 hover:bg-blue-500/[0.04]' : 'overflow-hidden border-transparent hover:bg-blue-50'} ${selected ? 'border-blue-400/80 bg-blue-500/[0.07] ring-1 ring-blue-400/70 shadow-sm focus-visible:outline-none' : ''} ${previewed && !selected ? 'project-file-entry-preview' : ''} ${previewArtifact ? 'border-amber-400/20' : transcodeArtifact ? 'border-blue-400/20' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'border-blue-500 bg-blue-100 ring-2 ring-blue-500' : ''}`}
    >
      {renderEntrySelectionControl(entry)}
      {progressFolder && (progressFolder.nodeRole === 'progress' ? <button type="button" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); openMarkProgress(entry); }} title={`编辑 V${progressFolder.versionKey} 进度`} aria-label={`编辑 V${progressFolder.versionKey} 进度`} className="absolute right-3 top-3 z-10 rounded-full bg-blue-600 px-2 py-1 text-[10px] font-bold text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-300">{versionTreeNodeBadgeLabel(progressFolder)}</button> : <span className={`absolute right-3 top-3 z-10 rounded-full px-2 py-1 text-[10px] font-bold shadow-sm ${progressFolder.nodeRole === 'selection' || progressFolder.relationKind === 'auxiliary' || workflow ? 'bg-violet-600 text-white' : previewArtifact ? 'bg-amber-500 text-white' : transcodeArtifact ? 'bg-blue-600 text-white' : 'bg-slate-700 text-white'}`}>{versionTreeNodeBadgeLabel(progressFolder)}</span>)}
      {!progressFolder && sourceKind && <span className="absolute right-3 top-3 z-10 rounded-full bg-slate-700 px-2 py-1 text-[10px] font-bold text-white shadow-sm">原始素材</span>}
      <div className={`relative flex aspect-square items-center justify-center ${previewArtifact ? 'rounded-xl bg-amber-500/[0.035]' : transcodeArtifact ? 'rounded-xl bg-blue-500/[0.035]' : ''}`}>{renderEntryIcon(entry, true)}</div>
      {progressFolder && inlineRenamePath !== entry.relativePath ? <p className="mt-1 truncate text-xs font-medium text-slate-700" title={displayName}>{displayName}</p> : renderEntryName(entry, true)}
      <p className={`mt-0.5 truncate text-[10px] ${progressFolder?.trackingState === 'needs_repair' ? 'font-bold text-amber-600' : 'text-slate-400'}`}><span aria-hidden className="mr-1">●</span>{statusLabel}</p>
    </div>;
  };

  const progressCompareCandidates = progressCompare ? [...progressCompare.matches, ...progressCompare.suggestions] : [];
  const progressCompareAcceptedReferences = new Set(progressCompareCandidates.filter(match => progressCompare?.acceptedSources.includes(match.source)).map(match => match.reference));
  const progressCompareMissingReferences = progressCompare?.unmatchedReferences.filter(reference => !progressCompareAcceptedReferences.has(reference)) || [];
  const progressCompareNewSources = progressCompare ? progressCompareNewSourcesFor(progressCompare) : [];
  const progressCompareListItems = progressCompare ? buildProgressCompareListItems(progressCompare, progressCompareFilter) : [];
  const activeProgressCompareItem = progressCompareListItems.find(item => item.key === activeProgressCompareItemKey);
  const photoshopToolbarAvailable = photoshopAvailable && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(isPhotoshopOpenEntry);
  // Do not recursively inspect folders just to decide whether contextual tools
  // should be visible. Folder-based tools validate and collect their inputs only
  // after the user explicitly starts that workflow.
  const imageConverterToolbarAvailable = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length
    && selectedEntries.some(entry => isFolderLikeEntry(entry) || JPG_CONVERSION_EXTENSIONS.has(entry.extension.toLocaleLowerCase()));
  const videoToolsToolbarAvailable = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length
    && selectedEntries.every(entry => isFolderLikeEntry(entry) || entry.kind === 'video');
  const fileMenuHasVideoTarget = fileMenuEntries.length > 0 && fileMenuEntries.every(entry => isFolderLikeEntry(entry) || entry.kind === 'video');
  const fileMenuHasConvertibleImageTarget = fileMenuEntries.some(entry => isFolderLikeEntry(entry) || JPG_CONVERSION_EXTENSIONS.has(entry.extension.toLocaleLowerCase()));
  const fileMenuHasVideoSplitTarget = !finalViewOpen && fileMenuHasVideoTarget;
  const videoToolPanelContributions = componentContributions.filter(item => item.type === 'component.sidePanel' && item.placement === 'workspace.videoTools');
  const placedVideoToolProjectContributions = componentContributions.filter(item => item.type === 'project.contextAction' && item.placement === 'workspace.videoTools');
  const placedVideoToolPageActions = placedFullPageActions(placedVideoToolProjectContributions, componentHostActions);
  const visibleComponentHostActions = visibleComponentToolbarActions(componentHostActions, placedVideoToolProjectContributions);
  const videoTranscodeContribution = videoToolPanelContributions.find(item => item.contributionId === 'transcode');
  const videoSplitContribution = videoToolPanelContributions.find(item => item.contributionId === 'split');
  const openVideoToolContribution = (contribution: ComponentContribution | undefined, relativePaths: string[]) => {
    if (!contribution) { onNotice('视频处理插件未安装或不可用'); return; }
    window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution, scope: { scopeRelativePath: currentRelativePath, selectedRelativePaths: relativePaths, sourcePageId: pageId } } }));
  };
  const fileMenuHasPlacedVideoToolAction = fileMenuEntries.length > 0
    && fileMenuEntries.length === fileMenuTargetPaths.length
    && !fileMenuContainsShortcutContent
    && placedVideoToolPageActions.length > 0;
  const toolbarHasPlacedVideoToolAction = componentHostSelectedRelativePaths.length > 0
    && componentHostSelectedRelativePaths.length === selectedEntries.length
    && placedVideoToolPageActions.length > 0;
  const fileMenuOfficeEntries = !finalViewOpen && fileMenuEntries.length > 0 && fileMenuEntries.every(isOfficeOpenXmlEntry) ? fileMenuEntries : [];
  const fileMenuHasToolActions = Boolean(fileMenu && (fileMenuHasVideoTarget || fileMenuHasPlacedVideoToolAction || fileMenuHasConvertibleImageTarget || fileMenuScreenshotMainImageEntries.length || fileMenuOfficeEntries.length));
  const selectedCanSetVersionProgress = Boolean(projectWorkflows && selectedProgressFolder && !selectedRegisteredProgressFolder && !isUnsupportedShortcutContent(selectedProgressFolder));
  const versionManagementToolbarAvailable = Boolean(selectedEditableProgressFolder) || selectedCanSetVersionProgress || selectedEntries.length === 1 && hasVersionProgressForEntry(selectedEntries[0]);
  const projectToolbarAvailability: Record<ProjectToolbarActionId, boolean> = {
    'filename-selection': true,
    'select-media': canSelectMedia,
    'video-tools': selectedResearchTargets.length > 0 || videoToolsToolbarAvailable || selectedVideoSplitTargets.length > 0 || toolbarHasPlacedVideoToolAction,
    'image-tools': imageConverterToolbarAvailable || canExtractScreenshotMainImage,
    photoshop: photoshopToolbarAvailable,
    'office-extract': selectedOfficeExtractEntries.length > 0,
    'version-management': versionManagementToolbarAvailable,
  };
  const unavailableProjectToolbarTitle = (label: string, reason: string) => `${label}，${reason}`;
  const projectToolbarButtons: Record<ProjectToolbarActionId, React.ReactNode> = {
    'filename-selection': <button onClick={() => togglePanel('match')} title="从文件名选片" aria-label="从文件名选片" className="project-action-button"><FileText size={16}/>从文件名选片</button>,
    'select-media': <button disabled={!canSelectMedia} title={canSelectMedia ? '选片：把所选素材加入图片或视频选片结果' : unavailableProjectToolbarTitle('选片', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '需选择选片源素材使用')} aria-label="选片" onClick={() => void selectMediaFiles()} className="project-action-button"><CheckCircle2 size={16}/>选片</button>,
    'video-tools': <div className="project-toolbar-tool-group relative" onClick={event => event.stopPropagation()}><button type="button" disabled={!projectToolbarAvailability['video-tools']} onClick={() => { const next = !showVideoToolsMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowVideoToolsMenu(next); }} title="视频工具" aria-label="视频工具" aria-haspopup="menu" aria-expanded={showVideoToolsMenu} className={`project-action-button ${showVideoToolsMenu || panel === 'research' ? 'bg-blue-50 text-blue-600' : ''}`}><Video size={16}/>视频工具<ChevronDown size={13}/></button>{showVideoToolsMenu && <div className="project-toolbar-tool-submenu absolute left-0 top-full z-50 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl"><button type="button" disabled={!selectedResearchTargets.length} title={selectedResearchTargets.length ? `从所选 ${selectedResearchTargets.length} 个视频或文件夹中提取代表性画面` : '请选择视频或文件夹'} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); if (selectedResearchTargets.length) void openResearchForEntries(selectedResearchTargets); }} className="project-menu-item"><Video size={14}/>截取分镜帧</button>{videoTranscodeContribution && <button type="button" disabled={!videoToolsToolbarAvailable} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); openVideoToolContribution(videoTranscodeContribution, selectedEntries.map(entry => entry.relativePath)); }} className="project-menu-item"><Gauge size={14}/>视频转码</button>}{videoSplitContribution && <button type="button" disabled={!selectedVideoSplitTargets.length} title={selectedVideoSplitTargets.length ? `将所选 ${selectedVideoSplitTargets.length} 个视频或文件夹中的视频无损切成约 3.95 GB 的连续分段` : '请选择视频或文件夹'} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); if (!selectedVideoSplitTargets.length) { onNotice('请先选择视频或文件夹'); return; } openVideoToolContribution(videoSplitContribution, selectedVideoSplitTargets.map(entry => entry.relativePath)); }} className="project-menu-item"><Cut size={14}/>视频切割</button>}{placedVideoToolPageActions.map(({ contribution, action }) => <button key={`${contribution.componentId}:${contribution.contributionId}`} type="button" disabled={!toolbarHasPlacedVideoToolAction} title={toolbarHasPlacedVideoToolAction ? contribution.title : '请选择文件或文件夹'} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); onOpenComponentPage(action, projectContributionScope(currentRelativePath, pageId, componentHostSelectedRelativePaths)); }} className="project-menu-item"><ComponentIcon src={contribution.iconUrl} size={14}/>{contribution.label}</button>)}</div>}</div>,
    'image-tools': <div className="project-toolbar-tool-group relative" onClick={event => event.stopPropagation()}><button type="button" disabled={!projectToolbarAvailability['image-tools']} onClick={() => { const next = !showImageToolsMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowImageToolsMenu(next); }} title="图片工具" aria-label="图片工具" aria-haspopup="menu" aria-expanded={showImageToolsMenu} className={`project-action-button ${showImageToolsMenu || panel === 'converter' || panel === 'screenshot-main-image' ? 'bg-blue-50 text-blue-600' : ''}`}><ImageIcon size={16}/>图片工具<ChevronDown size={13}/></button>{showImageToolsMenu && <div className="project-toolbar-tool-submenu absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl"><button type="button" disabled={!imageConverterToolbarAvailable} onClick={event => { event.stopPropagation(); setShowImageToolsMenu(false); setShowToolbarOverflowMenu(false); void openImageConverter(selectedEntries.map(entry => entry.relativePath)); }} title={imageConverterToolbarAvailable ? selectedEntries.length > 1 ? `图片转 JPG：转换所选 ${selectedEntries.length} 个文件或文件夹中的图片` : '图片转 JPG：转换所选文件或文件夹中的图片' : unavailableProjectToolbarTitle('图片转 JPG', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '请选择可转换的图片或文件夹')} className="project-menu-item"><ImageIcon size={14}/>图片转 JPG</button><button type="button" disabled={!canExtractScreenshotMainImage} onClick={event => { event.stopPropagation(); setShowImageToolsMenu(false); setShowToolbarOverflowMenu(false); if (!selectedScreenshotMainImageEntries.length) { onNotice('请先选择要提取主图的截图'); return; } openScreenshotMainImage(selectedScreenshotMainImageEntries); }} title={canExtractScreenshotMainImage ? selectedScreenshotMainImageEntries.length > 1 ? `提取截图主图：批量识别并裁出所选 ${selectedScreenshotMainImageEntries.length} 张截图中的主要图片区域` : '提取截图主图：识别并裁出所选截图中的主要图片区域' : unavailableProjectToolbarTitle('提取截图主图', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '需选择截图图片使用')} className="project-menu-item"><Crop size={14}/>提取截图主图{selectedScreenshotMainImageEntries.length > 1 ? `（${selectedScreenshotMainImageEntries.length} 张）` : ''}</button></div>}</div>,
    photoshop: <button disabled={!photoshopToolbarAvailable} onClick={() => void openProjectEntriesInPhotoshop(selectedEntries)} title={photoshopToolbarAvailable ? selectedEntries.length > 1 ? `用 Photoshop 打开：把所选 ${selectedEntries.length} 个图片、RAW 或 Photoshop 文档发送到 Photoshop` : '用 Photoshop 打开所选图片或文档' : unavailableProjectToolbarTitle('用 Photoshop 打开', !photoshopAvailable ? '未检测到 Photoshop' : '需选择图片、RAW 或 PSD/PSB 使用')} aria-label="在 Photoshop 中打开所选图片、RAW 或 Photoshop 文档" className="project-action-button"><PhotoshopIcon size={16}/>用 Photoshop 打开{selectedEntries.length > 1 && photoshopToolbarAvailable ? `（${selectedEntries.length} 个）` : ''}</button>,
    'office-extract': <button type="button" disabled={!selectedOfficeExtractEntries.length} onClick={() => openOfficeImageExtractor(selectedOfficeExtractEntries)} aria-pressed={panel === 'office-extract'} title={selectedOfficeExtractEntries.length ? `从所选 ${selectedOfficeExtractEntries.length} 个 Office 文档提取图片` : '请选择 Office 文档'} className={`project-action-button ${panel === 'office-extract' ? 'bg-blue-50 text-blue-600' : ''}`}><FileImage size={16}/>提取文档图片</button>,
    'version-management': selectedEditableProgressFolder ? selectedEditableProgressFolder.trackingState === 'needs_repair' ? <button onClick={() => void openProgressRepair(selectedEditableProgressFolder)} title="修复版本批次：继续处理未完成的版本提交操作" aria-label="修复版本批次" className="project-action-button !text-amber-600"><RefreshCw size={16}/>修复版本批次</button> : <button disabled={selectedEditableProgressFolder.trackingState === 'committing'} onClick={() => void openMarkProgress(selectedProgressFolder!)} title={selectedEditableProgressFolder.trackingState === 'committing' ? unavailableProjectToolbarTitle('版本管理', '版本批次正在提交') : '修改当前版本进度'} aria-label="修改进度" className="project-action-button"><GitBranch size={16}/>{selectedEditableProgressFolder.trackingState === 'committing' ? '正在提交' : '修改进度'}</button> : selectedCanSetVersionProgress ? <button onClick={() => void openMarkProgress(selectedProgressFolder!)} title="标记所选文件夹用途" aria-label="标记文件夹" className="project-action-button"><GitBranch size={16}/>标记…</button> : selectedEntries.length === 1 && hasVersionProgressForEntry(selectedEntries[0]) ? <button onClick={() => openVersions()} title="查看和管理素材版本" aria-label="版本管理" className="project-action-button"><GitBranch size={16}/>版本管理</button> : <button disabled title={unavailableProjectToolbarTitle('版本管理', '需选择版本文件夹或已纳入版本的媒体')} aria-label="版本管理" className="project-action-button"><GitBranch size={16}/>版本管理</button>,
  };
  const hiddenProjectToolbarActions = new Set(projectToolbar.hidden);
  const visibleProjectToolbarActionIds = projectToolbar.order.filter(id => !hiddenProjectToolbarActions.has(id) && (!projectToolbar.onlyShowAvailable || projectToolbarAvailability[id]));
  const hasProjectToolbarActions = visibleProjectToolbarActionIds.length > 0;
  const hasGatherToolbarTools = (!hiddenProjectToolbarActions.has('image-tools') && projectToolbarAvailability['image-tools'])
    || (!hiddenProjectToolbarActions.has('video-tools') && projectToolbarAvailability['video-tools']);
  const versionProgressPanelMode: VersionProgressDraft['mode'] | null = progressSetup
    ? progressSetup.mode === 'mark' ? progressSetup.existingProgressId ? 'modify' : 'create' : progressSetup.mode
    : null;
  const versionProgressPanelTitle = progressSetup?.mode === 'mark' && !progressSetup.existingProgressId ? '标记版本进度'
    : progressSetup?.contextLocked ? '创建下一版本'
    : versionProgressPanelMode === 'create' ? '新建进度'
      : versionProgressPanelMode === 'import' ? '导入 · 进度'
        : '修改进度';
  const versionProgressDraft: VersionProgressDraft | null = progressSetup && versionProgressPanelMode ? {
    mode: progressSetup.contextLocked ? 'create-next' : versionProgressPanelMode,
    sourceRelativePath: progressSetup.targetRelativePath || currentRelativePath,
    displayName: progressSetup.progressName,
    mediaKind: progressSetup.mediaKind,
    relationKind: 'main',
    parentProgressId: progressSetup.parentProgressId,
    trackingEnabled: progressSetup.trackingEnabled,
    renameFromParent: progressSetup.renameSources,
    copyMissingFromParent: progressSetup.copyMissingFromParent,
    workflowInputProgressIds: progressSetup.workflowInputProgressIds,
    sourcePaths: progressSetup.sourcePaths,
    deleteSourceAfterImport: progressSetup.deleteSourceAfterImport,
    linkOnly: progressSetup.linkOnly,
    existingProgressId: progressSetup.existingProgressId,
    versionKey: progressSetup.versionKey,
    versionKind: progressSetup.relation === 'branch' ? 'branch' : 'main',
    contextLocked: progressSetup.contextLocked,
    targetFolderLocked: Boolean(progressSetup.preserveFolderName),
  } : null;
  const finalExportParentOptions = selectableVersionParents(progressFolders, { mediaKind: 'image', relationKind: 'main' });
  const handleFilesColumnWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!versionTreeOpen || event.ctrlKey || event.deltaY === 0) return;
    if (event.deltaY > 0) {
      setVersionTreeHeaderCollapsed(true);
      return;
    }
    const viewport = event.currentTarget.querySelector<HTMLElement>('[data-version-tree-viewport="true"]');
    if (!viewport || viewport.scrollTop <= 2) setVersionTreeHeaderCollapsed(false);
  };

  return (
    <div ref={projectWorkspaceRef} className="flex h-full w-full min-w-0 flex-col animate-in fade-in duration-300">
      {pendingProgressFolders.length > 0 && !progressSetup && !folderMarkSetup && <div role="dialog" aria-modal="true" aria-label="标记文件夹用途" className="fixed inset-0 z-[339] flex items-center justify-center bg-slate-950/45 p-4"><div className="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-5 py-4"><h3 className="font-bold text-slate-800">标记文件夹用途</h3><p className="mt-1 text-xs leading-5 text-slate-500">在统一面板中选择原始素材、进度或花絮；关闭不会修改文件。</p></header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5">{pendingProgressFolders.map(folder => <div key={folder.relativePath} className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-3"><Folder size={18} className="shrink-0 text-blue-500"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-700" title={folder.relativePath}>{folder.name}</p><p className="mt-0.5 truncate text-xs text-slate-400">{folder.relativePath} · 建议按{folder.mediaKind === 'video' ? '视频' : '图片'}处理</p></div><button type="button" className="dialog-secondary shrink-0" onClick={() => { const relativePath = folder.relativePath; openMarkProgress({ name: folder.name, path: `${project.path}/${relativePath}`, relativePath, kind: 'folder', extension: '', size: 0, createdAt: Date.now(), updatedAt: Date.now() }, folder.mediaKind); }}>标记…</button></div>)}</div>
        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><p className="text-xs text-slate-500">也可右键文件夹选择“标记…”。</p><button type="button" onClick={() => setPendingProgressFolders([])} className="dialog-secondary">暂不设置</button></footer>
      </div></div>}
      {fileMenu && createPortal(<ViewportContextMenu x={fileMenu.x} y={fileMenu.y} widthClass="w-52" allowSubmenus>
        {isFolderLikeEntry(fileMenu.entry) && !isUnsupportedShortcutContent(fileMenu.entry) && onOpenDirectoryPage && <><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); onOpenDirectoryPage(entry.relativePath); }}><FolderPlus size={14}/>在新标签页打开</button><div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && isFolderLikeEntry(fileMenu.entry) && !fileMenuVersionTreeFolder && <><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openMarkProgress(entry); }}><GitBranch size={14}/>标记…</button><div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && fileMenuRegisteredProgressFolder && <><button disabled={fileMenuRegisteredProgressFolder.trackingState === 'committing' || fileMenuRegisteredProgressFolder.trackingState === 'needs_repair'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openMarkProgress(entry); }}><GitBranch size={14}/>修改进度</button>{!fileMenuRegisteredProgressFolder.parentProgressId && <button className="project-menu-item" onClick={() => { const progressFolder = fileMenuRegisteredProgressFolder; setFileMenu(null); void unregisterLegacyOrphanProgress(progressFolder); }}><X size={14}/>取消旧版游离进度登记</button>}{progressTrackingAction(fileMenuRegisteredProgressFolder) && <button disabled={progressSubmitting || Boolean(workspaceActivityMessage) || fileMenuRegisteredProgressFolder.trackingState === 'committing'} title="按已持久化策略刷新当前主分支版本跟踪" className="project-menu-item" onClick={() => { const progressFolder = fileMenuRegisteredProgressFolder; setFileMenu(null); void refreshProgressTracking(progressFolder); }}><RefreshCw size={14}/>{progressTrackingRefreshLabel(fileMenuRegisteredProgressFolder)}</button>}<div className="my-1 border-t border-slate-100"/></>}
        {gatherToProject && <><button disabled={fileMenuContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); startGatherInspiration(targets); }}><FolderInput size={14}/>添加到项目{inspirationTargetProject ? `“${inspirationTargetProject.name}”` : '…'}</button>{inspirationTargetProject && <button disabled={fileMenuContainsShortcutContent || gatheringInspiration} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); setGatherPickerPaths(targets); }}><ChevronDown size={14}/>选择其他项目…</button>}<div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && canSelectFileMenuMedia && <><button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); selectMediaFiles(targets); }}><CheckCircle2 size={14}/>选片</button><div className="my-1 border-t border-slate-100"/></>}
        {(fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; const restoreSelection = fileMenuSelectionWasImplicitRef.current ? fileMenuSelectionSnapshotRef.current : null; setFileMenu(null); if (restoreSelection) { selectionAnchorPathRef.current = fileMenuSelectionAnchorSnapshotRef.current; setSelectedPaths(restoreSelection); } openPreviewFromMenu(entry); }}><PanelLeftOpen size={14}/>预览</button>}
        {mediaContributionScope(fileMenuEntries, fileMenu.entry, pageId) && componentContributions.filter(item => item.type === 'media.contextAction').map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scope = mediaContributionScope(fileMenuEntries, fileMenu.entry, pageId)!; setFileMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope } })); }}><Plus size={14}/>{item.label}</button>)}
        {componentContributions.filter(item => item.type === 'project.contextAction' && !item.placement).map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scope = projectContributionScope(currentRelativePath, pageId, fileMenuEntries.map(entry => entry.relativePath)); setFileMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope } })); }}><Plus size={14}/>{item.label}</button>)}
        {!isFolderLikeEntry(fileMenu.entry) && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openProjectEntry(entry); }}><ExternalLink size={14}/>{fileMenu.entry.kind === 'shortcut' ? '打开快捷方式' : '用默认方式打开'}</button>}
        {fileMenu.entry.externalLink && <><button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; setFileMenu(null); void relinkExternalFolder(path); }}><RefreshCw size={14}/>重新定位外链</button><button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; setFileMenu(null); void materializeExternalLinks([path]); }}><FolderInput size={14}/>移动外链{fileMenu.entry.externalLinkTargetKind === 'file' ? '文件' : '文件夹'}到项目内</button></>}
        {fileMenu.entry.kind === 'shortcut' && !fileMenu.entry.externalLink && <button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; setFileMenu(null); void relinkExternalFolder(path); }}><RefreshCw size={14}/>重新接管旧版外链…</button>}
        {(fileMenuHasVideoTarget || fileMenuHasPlacedVideoToolAction) && <ViewportSubmenu><button type="button" aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><Video size={14}/>视频工具<span className="ml-auto">›</span></button><div className="z-[302] w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">{fileMenuHasVideoTarget && <button className="project-menu-item" onClick={() => { const entries = fileMenuEntries; setFileMenu(null); void openResearchForEntries(entries); }}><Video size={14}/>截取分镜帧</button>}{fileMenuHasVideoTarget && videoTranscodeContribution && <button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); openVideoToolContribution(videoTranscodeContribution, targets); }}><Gauge size={14}/>视频转码</button>}{fileMenuHasVideoTarget && videoSplitContribution && <button disabled={!fileMenuHasVideoSplitTarget} title={fileMenuHasVideoSplitTarget ? `将所选 ${fileMenuEntries.length} 个视频或文件夹中的视频无损切成约 3.95 GB 的连续分段` : '请选择视频或文件夹'} className="project-menu-item" onClick={() => { const targets = fileMenuEntries.map(entry => entry.relativePath); setFileMenu(null); if (!targets.length) return; openVideoToolContribution(videoSplitContribution, targets); }}><Cut size={14}/>视频切割</button>}{fileMenuHasPlacedVideoToolAction && placedVideoToolPageActions.map(({ contribution, action }) => <button key={`${contribution.componentId}:${contribution.contributionId}`} className="project-menu-item" onClick={() => { const scope = projectContributionScope(currentRelativePath, pageId, fileMenuEntries.map(entry => entry.relativePath)); setFileMenu(null); onOpenComponentPage(action, scope); }}><ComponentIcon src={contribution.iconUrl} size={14}/>{contribution.label}</button>)}</div></ViewportSubmenu>}
        {(fileMenuHasConvertibleImageTarget || fileMenuScreenshotMainImageEntries.length > 0) && <ViewportSubmenu><button type="button" aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><ImageIcon size={14}/>图片工具<span className="ml-auto">›</span></button><div className="z-[302] w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">{fileMenuHasConvertibleImageTarget && <button className="project-menu-item" onClick={() => { const targets = fileMenuEntries.map(entry => entry.relativePath); setFileMenu(null); void openImageConverter(targets); }}><ImageIcon size={14}/>图片转 JPG</button>}<button disabled={!fileMenuScreenshotMainImageEntries.length} title={fileMenuScreenshotMainImageEntries.length ? fileMenuScreenshotMainImageEntries.length > 1 ? `批量提取 ${fileMenuScreenshotMainImageEntries.length} 张截图中的主图` : '提取截图中的主图' : '需选择截图图片使用'} className="project-menu-item" onClick={() => { const entries = fileMenuScreenshotMainImageEntries; setFileMenu(null); openScreenshotMainImage(entries); }}><Crop size={14}/>提取截图主图{fileMenuScreenshotMainImageEntries.length > 1 ? `（${fileMenuScreenshotMainImageEntries.length} 张）` : ''}</button></div></ViewportSubmenu>}
        {officeImageExtractorAvailable && fileMenuOfficeEntries.length > 0 && <button className="project-menu-item" onClick={() => { const entries = fileMenuOfficeEntries; setFileMenu(null); openOfficeImageExtractor(entries); }}><FileImage size={14}/>提取文档图片{fileMenuOfficeEntries.length > 1 ? `（${fileMenuOfficeEntries.length} 个文档）` : ''}</button>}
        {photoshopAvailable && isPhotoshopOpenEntry(fileMenu.entry) && <button className="project-menu-item" onClick={() => { const entries = selectedPaths.includes(fileMenu.entry.relativePath) ? selectedEntries.filter(isPhotoshopOpenEntry) : [fileMenu.entry]; setFileMenu(null); void openProjectEntriesInPhotoshop(entries); }}><PhotoshopIcon size={14}/>用 Photoshop 打开{selectedPaths.includes(fileMenu.entry.relativePath) && selectedEntries.filter(isPhotoshopOpenEntry).length > 1 ? `（${selectedEntries.filter(isPhotoshopOpenEntry).length} 个）` : ''}</button>}
        {fileMenuHasToolActions && <div className="my-1 border-t border-slate-100"/>}
        <button disabled={fileMenuContainsShortcutContent || fileMenuContainsProtectedRenameEntry || fileMenuContainsBlockedProgressRenameEntry} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : fileMenuContainsProtectedRenameEntry ? '该文件夹由项目工作流管理，不能普通重命名' : fileMenuContainsBlockedProgressRenameEntry ? '已登记版本目录暂不支持批量或混合批量重命名' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); beginRename(targets); }}><Edit size={14}/>{fileMenuTargetPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('cut', undefined, targets); }}><Cut size={14}/>剪切</button>
        <button disabled={fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('copy', undefined, targets); }}><Copy size={14}/>复制</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent || !clipboardHasFiles} title={fileMenuContainsShortcutContent ? '快捷方式指向的外部文件夹是只读浏览区域' : finalViewOpen ? '喜爱图片浏览为只读视图' : clipboardHasFiles ? '粘贴到此文件所在文件夹' : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('paste'); }}><ClipboardPaste size={14}/>粘贴</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item project-menu-danger" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('trash', undefined, targets); }}><Trash2 size={14}/>删除</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openEntryDetails(entry); }}><Info size={14}/>详细信息</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); copyEntryPath(entry); }}><FileText size={14}/>{isFolderLikeEntry(fileMenu.entry) ? '复制文件夹地址' : '复制文件地址'}</button>
        <button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; if (fileMenuEntrySelected) setSelectedPaths(current => current.filter(item => item !== path)); else { selectionAnchorPathRef.current = path; setSelectedPaths(current => [...current, path]); requestFileReveal(path); } setFileMenu(null); }}>{fileMenuEntrySelected ? <X size={14}/> : <CheckSquare size={14}/>} {fileMenuEntrySelected ? '取消选择' : '选择'}</button>
        {projectWorkflows && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <div className="my-1 border-t border-slate-100"/>}
        {projectWorkflows && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button disabled={!hasVersionProgressForEntry(fileMenu.entry)} title={hasVersionProgressForEntry(fileMenu.entry) ? '管理素材的当前版本和历史版本' : '请先标记或导入版本进度'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openVersions(entry); }}><GitBranch size={14}/>版本管理</button>}
      </ViewportContextMenu>, document.body)}
      {surfaceMenu && createPortal(<ViewportContextMenu x={surfaceMenu.x} y={surfaceMenu.y} widthClass="w-56" allowSubmenus>
        {surfaceMenu.kind === 'version-tree-layout' && <><button type="button" title="恢复版本树标准排版" className="project-menu-item" onClick={() => void restoreStandardVersionTreeLayout()}><RefreshCw size={14}/>刷新</button><div className="my-1 border-t border-slate-100"/></>}
        <p className="truncate px-2 py-1 text-[11px] font-bold text-slate-400" title={surfaceMenu.targetLabel}>在“{surfaceMenu.targetLabel}”中操作</p>
        {componentContributions.filter(item => item.type === 'project.contextAction' && !item.placement).map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scope = projectContributionScope(surfaceMenu.targetRelativePath, pageId); setSurfaceMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope } })); }}><Plus size={14}/>{item.label}</button>)}
        <ViewportSubmenu><button aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><FolderPlus size={14}/>新建<span className="ml-auto">›</span></button><div className="z-[302] w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">{projectWorkflows && !recursiveFlatOpen && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void openProgressSetup('create'); }}><FolderPlus size={14}/>新建进度</button>}<button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void createFolder(target); }}><Folder size={14}/>新建文件夹</button><div className="my-1 border-t border-slate-100"/><div className="flex items-center justify-between px-2 pb-1 pt-1"><p className="text-[11px] font-bold text-slate-400">Windows 文件类型</p><button type="button" title="重新扫描 Windows 新建文件类型" disabled={shellNewTypesLoading} onClick={() => void loadShellNewTypes(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"><RefreshCw size={12} className={shellNewTypesLoading ? 'animate-spin' : ''}/></button></div><div className="max-h-72 overflow-y-auto">{shellNewTypesLoading && <p className="px-2 py-2 text-xs text-slate-400">正在读取系统新建菜单…</p>}{!shellNewTypesLoading && shellNewTypes.map(type => <button key={type.id} className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void createShellNewFile(type, target); }}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-4 w-4 shrink-0 object-contain"/> : <File size={14} className="shrink-0"/>}<span className="min-w-0 flex-1 truncate">{type.label}</span><span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{type.extension}</span></button>)}{!shellNewTypesLoading && shellNewTypesLoaded && !shellNewTypes.length && <p className="px-2 py-2 text-xs text-slate-400">系统没有可用的新建文件类型</p>}</div></div></ViewportSubmenu>
        <ViewportSubmenu><button aria-haspopup="menu" aria-expanded={false} className="project-menu-item w-full"><FolderInput size={14}/>导入<span className="ml-auto">›</span></button><div className="z-[302] w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl transition">{projectWorkflows && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); setPanel('import'); }}><MemoryStick size={14}/>从 SD 卡导入</button>}<button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); openManualImport(projectWorkflows ? 'original' : 'files', [], target); }}><FolderInput size={14}/>导入</button>{componentContributions.filter(item => item.type === 'project.importProvider').map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scopeRelativePath = surfaceMenu.targetRelativePath; setSurfaceMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope: { scopeRelativePath, selectedRelativePaths: [], sourcePageId: pageId } } })); }}><FolderInput size={14}/>{item.label}</button>)}</div></ViewportSubmenu>
        {componentContributions.filter(item => item.type === 'project.exportProvider').map(item => <button key={`${item.componentId}:${item.contributionId}`} className="project-menu-item" onClick={() => { const scopeRelativePath = surfaceMenu.targetRelativePath; setSurfaceMenu(null); window.dispatchEvent(new CustomEvent('photoflow:open-component-contribution', { detail: { contribution: item, scope: { scopeRelativePath, selectedRelativePaths: [], sourcePageId: pageId } } })); }}><ExternalLink size={14}/>{item.label}</button>)}
        {projectWorkflows && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); togglePanel('match'); }}><FileText size={14}/>从文件名选片</button>}
        <div className="my-1 border-t border-slate-100"/>
        <button disabled={!clipboardHasFiles} title={clipboardHasFiles ? `粘贴到“${surfaceMenu.targetLabel}”` : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void runFileOperation('paste', undefined, [], target); }}><ClipboardPaste size={14}/>粘贴</button>
        <button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void copyCurrentDirectoryPath(target); }}><FileText size={14}/>复制此文件夹地址</button>
        {hasExternalFolderLinks && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void materializeExternalLinks(); }}><FolderInput size={14}/>移动所有外链文件夹到项目内</button>}
        {projectWorkflows && <><div className="my-1 border-t border-slate-100"/><button className="project-menu-item project-menu-danger" onClick={() => { setSurfaceMenu(null); setPanel('trash'); }}><Trash2 size={14}/>将项目移入回收站</button></>}
      </ViewportContextMenu>, document.body)}
      <div ref={projectColumnLayoutRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div ref={filesColumnRef} style={previewPaneOpen || metadataPaneOpen ? { width: displayedColumnWidths.files } : undefined} onWheelCapture={handleFilesColumnWheelCapture} onPointerDown={startSelectionDrag} onPointerMove={updateSelectionDrag} onPointerUp={finishSelectionDrag} onPointerCancel={cancelSelectionDrag} onLostPointerCapture={cancelSelectionDrag} className={`relative flex min-h-0 flex-col overscroll-contain [overflow-anchor:none] px-6 ${versionTreeOpen ? 'gap-0 overflow-hidden pb-0' : 'gap-3 overflow-auto pb-6'} ${previewPaneOpen || metadataPaneOpen ? 'shrink-0' : 'flex-1'}`}>
        {selectionBox && <div aria-hidden className="marquee-logical-canvas pointer-events-none absolute left-0 top-0 z-20" style={{ width: selectionCanvasSize.width, height: selectionCanvasSize.height }}><div className="absolute border border-blue-500 bg-blue-400/15" style={selectionBox}/></div>}
      {active && activeView === 'project' && (viewportStatus || folderOnlyGridCount > 0) && createPortal(<div role="status" className="pointer-events-none fixed bottom-2 z-[35] flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-lg border border-white/10 bg-slate-950/80 px-3.5 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md" style={{ right: Math.max(12, projectLayoutWidth - displayedColumnWidths.files + 12) }}>
        {viewportStatus?.captureDateTime && <>
          <span className="truncate" title={viewportStatus.captureDateTime}>{viewportStatus.captureDateTime}</span>
          <span aria-hidden className="h-3 w-px shrink-0 bg-white/25"/>
        </>}
        <span className="shrink-0 font-mono font-bold tabular-nums">{viewportStatus ? `${viewportStatus.fileNumber}/${viewportStatus.total}` : folderOnlyGridCount}</span>
      </div>, document.body)}
      <div data-project-overview-shell="true" className={versionTreeOpen ? `grid transition-[grid-template-rows,margin-bottom] duration-200 ${versionTreeHeaderCollapsed ? 'grid-rows-[0fr]' : 'mb-3 grid-rows-[1fr]'}` : 'contents'}>
      <div className={versionTreeOpen ? 'min-h-0 overflow-hidden' : 'contents'}>
      <div data-project-overview="true" className="flex flex-wrap items-start justify-between gap-3 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-bold text-slate-800">{browserRootLabel}</h2>
          {projectWorkflows && <div className="relative" onClick={event => event.stopPropagation()}>
            <button onClick={() => { const next = !showStatusMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowStatusMenu(next); }} className="flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-600 hover:bg-blue-100">{projectStatusLabel(project.status)} <ChevronDown size={14}/></button>
            {showStatusMenu && <div className="absolute left-0 top-full z-[60] mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{projectStatuses.map(status => <button key={status} onClick={() => moveStatus(status)} className={`project-menu-item ${status === project.status ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{projectStatusLabel(status)}{status === project.status ? '（当前）' : ''}</button>)}</div>}
          </div>}
        </div>
        <div className="flex items-center gap-2"><button onClick={() => openFolder()} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><ExternalLink size={16}/>打开{browserContext.title}文件夹</button>{projectWorkflows && <button onClick={() => setConfirmDelete(true)} title="删除项目" className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-500 hover:bg-red-50"><Trash2 size={16}/></button>}</div>
      </div>
      </div>
      </div>

      <div className="project-toolbar-wrap sticky top-0 z-30 -mx-6 w-[calc(100%+3rem)] bg-slate-50">
      <div className={`project-toolbar flex w-full flex-nowrap items-center border-b border-slate-200 px-6 py-1 ${selectedPaths.length ? 'project-toolbar--has-selection' : ''}`}>
        <div className="project-toolbar-create-action relative" onClick={event => event.stopPropagation()}>
          <button onClick={toggleCreateMenu} title="新建" aria-label="新建" aria-haspopup="menu" aria-expanded={showCreateMenu} className="project-action-button"><FolderPlus size={16}/>新建</button>
          {showCreateMenu && <div className="project-create-menu absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            {projectWorkflows && <button className="project-menu-item" onClick={() => void openProgressSetup('create')}><FolderPlus size={14}/>新建进度</button>}
            <button className="project-menu-item" onClick={() => void createFolder()}><Folder size={14}/>文件夹</button>
            <div className="my-1 border-t border-slate-100"/>
            <div className="flex items-center justify-between px-2 pb-1 pt-2"><p className="text-[11px] font-bold text-slate-400">Windows 文件类型</p><button type="button" title="重新扫描 Windows 新建文件类型" aria-label="重新扫描 Windows 新建文件类型" disabled={shellNewTypesLoading} onClick={() => void loadShellNewTypes(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"><RefreshCw size={12} className={shellNewTypesLoading ? 'animate-spin' : ''}/></button></div>
            <div className="max-h-72 overflow-y-auto">
              {shellNewTypesLoading && <p className="px-2 py-2 text-xs text-slate-400">正在读取系统新建菜单…</p>}
              {!shellNewTypesLoading && shellNewTypes.map(type => <button key={type.id} className="project-menu-item flex items-center gap-2" onClick={() => void createShellNewFile(type)}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-4 w-4 shrink-0 object-contain"/> : <File size={14} className="shrink-0"/>}<span className="min-w-0 flex-1 truncate">{type.label}</span><span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{type.extension}</span></button>)}
              {!shellNewTypesLoading && shellNewTypesLoaded && !shellNewTypes.length && <p className="px-2 py-2 text-xs text-slate-400">系统没有可用的新建文件类型</p>}
            </div>
          </div>}
        </div>
        <div className="project-toolbar-import-action relative" onClick={event => event.stopPropagation()}>
          <button onClick={() => { const next = !showImportMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowImportMenu(next); }} title="导入" aria-label="导入" aria-haspopup="menu" aria-expanded={showImportMenu} className="project-action-button"><FolderInput size={16}/>导入</button>
          {showImportMenu && <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            {projectWorkflows && <button className="project-menu-item" onClick={() => { setShowImportMenu(false); setPanel('import'); }}><MemoryStick size={14}/>从 SD 卡导入</button>}
            <button className="project-menu-item" onClick={() => openManualImport(projectWorkflows ? 'original' : 'files')}><FolderInput size={14}/>导入</button>
          </div>}
        </div>
        <span aria-hidden className="project-toolbar-core-divider toolbar-divider"/>
        {selectedPaths.length > 0 && <span className="project-toolbar-selection mr-1 self-center text-xs text-slate-500">已选 {selectedPaths.length}</span>}
        <button disabled={selectedContainsShortcutContent || selectedContainsProtectedRenameEntry || selectedContainsBlockedProgressRenameEntry || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : selectedContainsProtectedRenameEntry ? '所选文件夹由项目工作流管理，不能普通重命名' : selectedContainsBlockedProgressRenameEntry ? '已登记版本目录暂不支持批量或混合批量重命名' : selectedPaths.length > 1 ? '批量重命名' : '重命名'} onClick={() => beginRename()} className="project-action-button compact-hide-file-action"><Edit size={16}/>{selectedPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : finalViewOpen ? '喜爱图片浏览为只读视图' : '剪切'} onClick={() => runFileOperation('cut')} className="project-action-button compact-hide-file-action"><Cut size={16}/>剪切</button>
        <button disabled={selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : '复制'} onClick={() => runFileOperation('copy')} className="project-action-button compact-hide-file-action"><Copy size={16}/>复制</button>
        {clipboardPending && <span role="status" aria-live="polite" className="text-xs text-slate-400">正在同步剪贴板…</span>}
        <button disabled={clipboardPending || finalViewOpen || !clipboardHasFiles} title={clipboardPending ? '正在同步系统剪贴板' : finalViewOpen ? '喜爱图片浏览为只读视图' : clipboardHasFiles ? '粘贴到当前文件夹' : '剪贴板中没有文件'} onClick={() => runFileOperation('paste')} className="project-action-button compact-hide-file-action"><ClipboardPaste size={16}/>粘贴</button>
        <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : finalViewOpen ? '喜爱图片浏览为只读视图' : '删除'} onClick={() => runFileOperation('trash')} className="project-action-button project-action-danger compact-hide-file-action"><Trash2 size={16}/>删除</button>
        <button disabled={!selectedPaths.length} title="取消选择" onClick={() => setSelectedPaths([])} className="project-action-button"><X size={16}/>取消选择</button>
        <div className="project-toolbar-secondary contents">
        {(gatherToProject || projectWorkflows && hasProjectToolbarActions) && <span aria-hidden className="toolbar-divider"/>}
        {gatherToProject && <div className="flex items-stretch">
          <button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => startGatherInspiration(selectedPaths)} title={inspirationTargetProject ? `将所选灵感添加到项目“${inspirationTargetProject.name}”的“策划”文件夹` : '将所选灵感添加到目标项目的“策划”文件夹'} aria-label="将所选灵感添加到目标项目" className="project-action-button inspiration-target-button !rounded-r-none">{gatheringInspiration ? <Loader2 size={16} className="animate-spin"/> : <FolderInput size={16}/>}<span className="truncate">{inspirationTargetProject ? inspirationTargetProject.name : '添加到项目'}</span></button>
          <button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => setGatherPickerPaths(selectedPaths)} title="选择要汇聚灵感的目标项目" aria-label="选择要汇聚灵感的目标项目" className="project-action-button !rounded-l-none !px-1"><ChevronDown size={14}/></button>
        </div>}
        {gatherToProject && hasGatherToolbarTools && <span aria-hidden className="toolbar-divider"/>}
        {gatherToProject && !hiddenProjectToolbarActions.has('image-tools') && projectToolbarAvailability['image-tools'] && projectToolbarButtons['image-tools']}
        <div className={projectWorkflows ? 'contents' : 'hidden'}>
          {visibleProjectToolbarActionIds.map(id => <React.Fragment key={id}>{projectToolbarButtons[id]}</React.Fragment>)}
        </div>
        {gatherToProject && !hiddenProjectToolbarActions.has('video-tools') && projectToolbarAvailability['video-tools'] && projectToolbarButtons['video-tools']}
        </div>
        <div className="project-toolbar-component-actions contents">{projectWorkflows && <ComponentToolbarActions actions={visibleComponentHostActions} scope={{ scopeRelativePath: currentRelativePath, selectedRelativePaths: componentHostSelectedRelativePaths, sourcePageId: pageId }} onOpen={onOpenComponentPage}/>}<ComponentContributionDock contributions={componentContributions.filter(item => item.type !== 'application.command')} project={project} workspacePath={workspacePath} scope={{ scopeRelativePath: currentRelativePath, selectedRelativePaths, sourcePageId: pageId }} active={active}/></div>
        <div className="project-toolbar-overflow relative" onClick={event => event.stopPropagation()}>
          <button type="button" onClick={() => { const next = !showToolbarOverflowMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowToolbarOverflowMenu(next); }} aria-label="展开工具栏操作" aria-haspopup="menu" aria-expanded={showToolbarOverflowMenu} className={`project-action-button ${showToolbarOverflowMenu ? 'bg-blue-50 text-blue-600' : ''}`}><ChevronDown size={17} className={`transition-transform ${showToolbarOverflowMenu ? 'rotate-180' : ''}`}/></button>
          {showToolbarOverflowMenu && <div role="menu" aria-label="更多工具栏操作" className="project-toolbar-overflow-menu absolute left-0 top-full z-50 mt-1 w-56 overflow-visible rounded-lg border border-slate-200 bg-white p-1 shadow-xl" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setShowToolbarOverflowMenu(false); (event.currentTarget.previousElementSibling as HTMLButtonElement | null)?.focus(); } }} onClick={event => { const button = (event.target as HTMLElement).closest('button'); if (button && button.getAttribute('aria-haspopup') !== 'menu') setShowToolbarOverflowMenu(false); }}>
            <div className="project-toolbar-overflow-primary">
              <button disabled={selectedContainsShortcutContent || selectedContainsProtectedRenameEntry || selectedContainsBlockedProgressRenameEntry || !selectedPaths.length} onClick={() => beginRename()} className="project-menu-item"><Edit size={14}/>{selectedPaths.length > 1 ? '批量重命名' : '重命名'}</button>
              <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('cut')} className="project-menu-item"><Cut size={14}/>剪切</button>
              <button disabled={selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('copy')} className="project-menu-item"><Copy size={14}/>复制</button>
              <button disabled={finalViewOpen || !clipboardHasFiles} onClick={() => runFileOperation('paste')} className="project-menu-item"><ClipboardPaste size={14}/>粘贴</button>
              <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('trash')} className="project-menu-item project-menu-danger"><Trash2 size={14}/>删除</button>
            </div>
            <div className="project-toolbar-overflow-compact">
              <div className="my-1 border-t border-slate-100"/>
              <p className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">新建与导入</p>
              {projectWorkflows && <button className="project-menu-item" onClick={() => void openProgressSetup('create')}><FolderPlus size={14}/>新建进度</button>}
              <button className="project-menu-item" onClick={() => void createFolder()}><Folder size={14}/>新建文件夹</button>
              {shellNewTypes.length > 0 && <div className="max-h-40 overflow-y-auto border-y border-slate-100 py-1">
                {shellNewTypes.map(type => <button key={`compact-${type.id}`} className="project-menu-item" onClick={() => void createShellNewFile(type)}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-3.5 w-3.5 shrink-0 object-contain"/> : <File size={14}/>}<span className="min-w-0 flex-1 truncate">新建{type.label}</span></button>)}
              </div>}
              {projectWorkflows && <button className="project-menu-item" onClick={() => setPanel('import')}><MemoryStick size={14}/>从 SD 卡导入</button>}
              <button className="project-menu-item" onClick={() => openManualImport(projectWorkflows ? 'original' : 'files')}><FolderInput size={14}/>导入文件</button>
              <div className="my-1 border-t border-slate-100"/>
              <p className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">视图</p>
              <button type="button" onClick={() => { setSearchQuery(''); selectFolderBrowseMode('recent'); }} aria-pressed={browseMode === 'recent'} className={`project-menu-item ${browseMode === 'recent' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><GalleryVerticalEnd size={14}/>所有文件</button>
              <button type="button" onClick={() => selectFolderBrowseMode('grid')} aria-pressed={browseMode === 'grid'} className={`project-menu-item ${browseMode === 'grid' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><Grid2X2 size={14}/>图标模式</button>
              <button type="button" onClick={() => selectFolderBrowseMode('list')} aria-pressed={browseMode === 'list'} className={`project-menu-item ${browseMode === 'list' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><LayoutList size={14}/>列表模式</button>
              {projectVersionTreeAvailable && <button type="button" onClick={showVersionTree} aria-pressed={browseMode === 'version-tree'} className={`project-menu-item ${browseMode === 'version-tree' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><GitBranch size={14}/>项目版本树</button>}
            </div>
            <div className="project-toolbar-overflow-secondary">
              {(gatherToProject || projectWorkflows && hasProjectToolbarActions) && <div className="my-1 border-t border-slate-100"/>}
              {gatherToProject && <><button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => startGatherInspiration(selectedPaths)} className="project-menu-item">{gatheringInspiration ? <Loader2 size={14} className="animate-spin"/> : <FolderInput size={14}/>}添加到{inspirationTargetProject ? `“${inspirationTargetProject.name}”` : '项目'}</button><button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => setGatherPickerPaths(selectedPaths)} className="project-menu-item"><ChevronDown size={14}/>选择目标项目</button></>}
              {gatherToProject && !hiddenProjectToolbarActions.has('image-tools') && projectToolbarAvailability['image-tools'] && projectToolbarButtons['image-tools']}
              {projectWorkflows && visibleProjectToolbarActionIds.map(id => <React.Fragment key={`overflow-${id}`}>{projectToolbarButtons[id]}</React.Fragment>)}
              {gatherToProject && !hiddenProjectToolbarActions.has('video-tools') && projectToolbarAvailability['video-tools'] && projectToolbarButtons['video-tools']}
              {projectWorkflows && visibleComponentHostActions.length > 0 && <><div className="my-1 border-t border-slate-100"/><ComponentToolbarActions overflow actions={visibleComponentHostActions} scope={{ scopeRelativePath: currentRelativePath, selectedRelativePaths: componentHostSelectedRelativePaths, sourcePageId: pageId }} onOpen={onOpenComponentPage}/></>}
            </div>
          </div>}
        </div>
        <div className="project-toolbar-view-actions ml-auto flex shrink-0 items-center gap-1 pl-3">
          <div className="project-toolbar-view-mode-actions contents">
          <button type="button" onClick={() => { setSearchQuery(''); selectFolderBrowseMode('recent'); }} title="所有文件（包含子文件夹和文件夹快捷方式）" aria-label="所有文件" aria-pressed={browseMode === 'recent'} className={`rounded-md p-1.5 ${browseMode === 'recent' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><GalleryVerticalEnd size={17}/></button>
          <button type="button" onClick={() => selectFolderBrowseMode('grid')} title="图标模式" aria-label="图标模式" aria-pressed={browseMode === 'grid'} className={`rounded-md p-1.5 ${browseMode === 'grid' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><Grid2X2 size={17}/></button>
          <button type="button" onClick={() => selectFolderBrowseMode('list')} title="列表模式" aria-label="列表模式" aria-pressed={browseMode === 'list'} className={`rounded-md p-1.5 ${browseMode === 'list' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><LayoutList size={17}/></button>
          {projectVersionTreeAvailable && <button type="button" onClick={showVersionTree} title="项目版本树" aria-label="项目版本树" aria-pressed={browseMode === 'version-tree'} className={`rounded-md p-1.5 ${browseMode === 'version-tree' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><GitBranch size={17}/></button>}
          </div>
          {(browseMode === 'grid' || browseMode === 'version-tree') && <input aria-label="图标大小" title="图标大小" type="range" min={MIN_FOLDER_GRID_ICON_SIZE} max={MAX_FOLDER_GRID_ICON_SIZE} step="4" value={gridIconSize} onChange={event => selectFolderGridIconSize(Number(event.target.value))} className="compact-hide-slider ml-2 w-24 accent-blue-600"/>}
          <span aria-hidden className="project-toolbar-view-mode-divider mx-1 h-5 w-px bg-slate-200"/>
          <div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !showSortMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowSortMenu(next); }} title={versionTreeOpen ? '排序版本树中的媒体' : recursiveFlatOpen ? '排序每个文件夹中的文件' : '排序'} aria-label="排序" aria-haspopup="menu" aria-expanded={showSortMenu} className={`rounded-md p-1.5 ${showSortMenu ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><ArrowUpDown size={17}/></button>{showSortMenu && <div className="sort-menu absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{([['name', '文件名'], ['date', '修改日期'], ['size', '大小']] as const).map(([field, label]) => <button key={field} type="button" onClick={() => selectSortField(field)} className={`project-menu-item ${sortField === field ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{label}</button>)}<div className="my-1 border-t border-slate-100"/><button type="button" onClick={() => setSortDirection('asc')} className={`project-menu-item ${sortDirection === 'asc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowUp size={14}/><span>递增</span></button><button type="button" onClick={() => setSortDirection('desc')} className={`project-menu-item ${sortDirection === 'desc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowDown size={14}/><span>递减</span></button></div>}</div>
          <div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !searchOpen; window.dispatchEvent(new Event('photoflow-menu-open')); setSearchOpen(next); }} title={versionTreeOpen ? '查找版本树中的文件（Ctrl+F）' : '查找文件（Ctrl+F）'} aria-label="查找文件" aria-expanded={searchOpen} className={`rounded-md p-1.5 ${searchOpen || searchQuery ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><Search size={17}/></button>{searchOpen && <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"><div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2"><Search size={15} className="shrink-0 text-slate-400"/><input ref={searchInputRef} autoFocus value={searchQuery} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); } }} placeholder="输入文件名" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-slate-800 outline-none"/>{searchQuery && <button type="button" onClick={() => setSearchQuery('')} title="清除查找" className="rounded p-0.5 text-slate-400 hover:bg-slate-200"><X size={14}/></button>}</div></div>}</div>
          <div className="relative" onClick={event => event.stopPropagation()}>
            <button type="button" onClick={() => { const next = !showFilterMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowFilterMenu(next); }} title={versionTreeOpen ? '筛选版本树中的文件' : '筛选文件'} aria-label="筛选文件" aria-haspopup="menu" aria-expanded={showFilterMenu} className={`rounded-md p-1.5 ${showFilterMenu || filterScope !== 'current-folder' || fileFilter !== 'all' || ratingFilter !== 'all' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><Funnel size={17}/></button>
            {showFilterMenu && <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
              <div><p className="mb-1.5 px-1 text-[11px] font-bold text-slate-400">筛选范围</p><div className="grid grid-cols-2 gap-1">
                <button type="button" aria-pressed={filterScope === 'current-folder'} onClick={() => changeFilterScope('current-folder')} className={`rounded-md px-2 py-1.5 text-xs font-medium ${filterScope === 'current-folder' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>当前文件夹</button>
                <button type="button" aria-pressed={filterScope === 'project-root'} onClick={() => changeFilterScope('project-root')} className={`rounded-md px-2 py-1.5 text-xs font-medium ${filterScope === 'project-root' ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{browserContext.rootFilterLabel}</button>
              </div></div>
              <div className="mt-2 border-t border-slate-100 pt-2"><p className="mb-1.5 px-1 text-[11px] font-bold text-slate-400">文件类型</p><div className="grid grid-cols-2 gap-1">{PROJECT_FILE_FILTER_OPTIONS.map(option => <button key={option.value} type="button" aria-pressed={fileFilter === option.value} onClick={() => setFileFilter(option.value)} className={`rounded-md px-2 py-1.5 text-xs font-medium ${fileFilter === option.value ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{option.label}</button>)}</div></div>
              <div className="mt-2 border-t border-slate-100 pt-2"><div className="mb-1.5 flex items-center justify-between gap-2 px-1"><p className="text-[11px] font-bold text-slate-400">{favoriteDisplayMode === 'stars' ? '星级' : '喜爱'}</p>{ratingFilter !== 'all' && <span className="flex items-center gap-1 text-[10px] text-slate-400">{filterRatingsLoading && <Loader2 size={11} className="animate-spin"/>}已检查 {filterRatingsCheckedCount} 个文件</span>}</div><div className="grid grid-cols-2 gap-1">{(favoriteDisplayMode === 'stars' ? PROJECT_STAR_RATING_FILTER_OPTIONS : PROJECT_BINARY_RATING_FILTER_OPTIONS).map(option => <button key={option.value} type="button" aria-pressed={ratingFilter === option.value} onClick={() => setRatingFilter(option.value)} className={`rounded-md px-2 py-1.5 text-xs font-medium ${ratingFilter === option.value ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{option.label}</button>)}</div></div>
              {(fileFilter !== 'all' || ratingFilter !== 'all') && <button type="button" onClick={() => { setFileFilter('all'); setRatingFilter('all'); }} className="mt-2 w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100">清除筛选</button>}
            </div>}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 items-center px-6 py-2">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-sm text-slate-500">
          {finalViewOpen ? <><button type="button" onClick={closeFinalVersionView} title="退出喜爱图片浏览" aria-label="退出喜爱图片浏览" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={17}/></button><span className="inline-flex h-8 shrink-0 items-center px-1.5 font-bold leading-none text-slate-700">喜爱</span></> : versionTreeOpen ? <><button type="button" onClick={() => selectFolderBrowseMode('grid')} title="返回图标模式" aria-label="退出版本树" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"><ArrowLeft size={17}/></button><span className="inline-flex h-8 shrink-0 items-center px-1.5 font-bold leading-none text-slate-700">{browserContext.title}</span><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><span className="inline-flex h-8 shrink-0 items-center gap-1.5 px-1.5 font-bold leading-none text-blue-700"><GitBranch size={15}/>版本树</span></> : <><button type="button" onClick={navigateBack} disabled={!directoryHistory.back.length} title="后退" aria-label="后退" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowLeft size={17}/></button><button type="button" onClick={navigateForward} disabled={!directoryHistory.forward.length} title="前进" aria-label="前进" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowRight size={17}/></button><button type="button" onClick={() => navigateToDirectory('')} title={`返回${browserRootLabel}根目录`} className="mr-1 inline-flex h-8 shrink-0 items-center rounded border border-transparent px-1.5 font-bold leading-none text-slate-800 transition hover:border-slate-300 hover:bg-slate-100">{browserContext.title}</button>{breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.relativePath || 'root'}><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><button onClick={() => navigateToDirectory(crumb.relativePath)} title={`进入 ${crumb.label}`} className={`inline-flex h-8 min-w-0 items-center truncate rounded border border-transparent px-1.5 text-sm leading-none transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 ${index === breadcrumbs.length - 1 ? 'font-bold text-slate-700' : ''}`}>{crumb.label}</button>{crumb.externalLink && <span aria-label="外链文件夹" className="ml-1 inline-flex h-5 shrink-0 items-center rounded-md border border-blue-200 bg-blue-50 px-1.5 text-[10px] font-bold leading-none text-blue-600">外链</span>}</React.Fragment>)}</>}
        </div>
        {finalViewOpen && <div className="ml-auto flex min-w-0 items-center gap-2"><label className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500">父节点<select aria-label="喜爱图片导出父节点" value={finalExportParentId} onChange={event => setFinalExportParentId(event.target.value)} className="max-w-48 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700"><option value="">请选择</option>{finalExportParentOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.displayName}</option>)}</select></label><button type="button" disabled={finalExporting || !finalViewEntries.length || !finalExportParentId} onClick={() => void exportFinalVersions()} className="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40">{finalExporting ? '正在整理…' : '整理喜爱图片'}</button></div>}
      </div>
      </div>

      {folderAlphabetFilterVisible && <nav aria-label="按文件夹首字母筛选" className="flex flex-wrap items-center gap-1 border-t border-slate-200 px-6 py-2">
        <button type="button" aria-pressed={!folderAlphabetFilter} onClick={() => { setFolderAlphabetFilter(''); setSelectedPaths([]); }} className={`rounded px-2 py-1 text-xs font-bold ${!folderAlphabetFilter ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>全部</button>
        {[...FOLDER_ALPHABET_KEYS, '#'].map(key => { const available = folderAlphabetKeys.includes(key); return <button key={key} type="button" disabled={!available} aria-pressed={folderAlphabetFilter === key} onClick={() => { setFolderAlphabetFilter(key); setSelectedPaths([]); }} className={`h-6 min-w-6 rounded px-1 text-xs font-bold ${folderAlphabetFilter === key ? 'bg-blue-600 text-white' : available ? 'text-slate-500 hover:bg-slate-100 hover:text-slate-800' : 'cursor-default text-slate-300'}`}>{key}</button>; })}
      </nav>}
      {mountedPanels.has('converter') && <ToolModal title={PROJECT_PANEL_TITLES.converter} ownerPageId={pageId} panelKind="converter" open={panel === 'converter'} onClose={closeImageConverterPanel}><ConverterView embedded initialTargetPaths={conversionTargets} sourcesLoading={conversionCollecting}/></ToolModal>}
      {mountedPanels.has('screenshot-main-image') && <ToolModal title={screenshotMainImageMode === 'crop' ? '裁剪图片' : PROJECT_PANEL_TITLES['screenshot-main-image']} ownerPageId={pageId} panelKind="screenshot-main-image" open={panel === 'screenshot-main-image'} onClose={() => setPanel(null)}><ScreenshotMainImageView embedded cropMode={screenshotMainImageMode === 'crop'} workspacePath={workspacePath} projectStatus={project.status} projectName={project.name} initialRelativePaths={screenshotMainImageTargets} cacheConfig={mediaCacheConfig} onFilesChanged={async () => {
        directoryEntriesCacheRef.current.clear();
        refreshRecursiveResults(screenshotMainImageTargets.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))));
        await refresh(currentRelativePathRef.current);
        if (finalViewOpen) await loadFinalViewEntries();
      }}/></ToolModal>}
      {mountedPanels.has('import') && <ToolModal title={PROJECT_PANEL_TITLES.import} ownerPageId={pageId} panelKind="import" open={panel === 'import'} busy={sdImportBusy} onClose={() => setPanel(null)}><div className="space-y-4"><div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{project.name}”</p><p className="mt-1 text-xs leading-5 text-blue-600">自动识别 SD 卡中的原始素材与花絮，并按项目结构整理。视频切割和转码会按“设置 → 导入 → 已记录的 SD 卡设备”中对应设备的规则执行。</p></div><ImportCard config={importConfig} drives={drives} workspacePath={workspacePath} destinationPath={project.path} brollDestinationPath={project.path} active={active && panel === 'import'} deleteSourceAfterImport={importDefaults.deleteSourceAfterImport} generateJpgFromRaw={importDefaults.generateJpgFromRaw} splitVideosOnImport={importDefaults.splitVideosOnImport} transcodeVideosOnImport={importDefaults.transcodeVideosOnImport} splitBrollVideosOnImport={brollConfig.splitVideosOnImport} transcodeBrollVideosOnImport={brollConfig.transcodeVideosOnImport} transcodeSettings={videoTools.transcode} videoToolsAvailable={videoToolsAvailable} onBusyChange={setSdImportBusy} onImportConfigChange={onImportConfigChange} onImportComplete={completeSdImport} completedActionLabel="关闭" onCompletedAction={() => setPanel(null)}/></div></ToolModal>}
      {mountedPanels.has('negative-import') && <ToolModal title={PROJECT_PANEL_TITLES['negative-import']} ownerPageId={pageId} panelKind="negative-import" open={panel === 'negative-import'} busy={negativeImportBusy} onClose={() => { setNegativeSourcePaths([]); setPanel(null); }}>
        <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{project.name}”</p><p className="mt-1 text-xs leading-5 text-blue-600">可直接读取文件或文件夹。</p></div>
          <ImportCard
            directSource
            importKind="original"
            onImportKindChange={(kind, sourcePaths) => openManualImport(kind, sourcePaths, fileImportTarget || currentRelativePath)}
            workspacePath={workspacePath}
            config={{ ...importConfig, sdPath: negativeSourcePaths[0], sdPaths: negativeSourcePaths }}
            drives={negativeSourcePaths}
            destinationPath={project.path}
            brollDestinationPath={project.path}
            active={active && panel === 'negative-import'}
            deleteSourceAfterImport={importDefaults.deleteSourceAfterImport}
            generateJpgFromRaw={importDefaults.generateJpgFromRaw}
            splitVideosOnImport={importDefaults.splitVideosOnImport}
            transcodeVideosOnImport={importDefaults.transcodeVideosOnImport}
            transcodeSettings={videoTools.transcode}
            videoToolsAvailable={videoToolsAvailable}
            onChooseSourceFiles={() => void projectWorkspaceClient.chooseImportSourceFiles().then(result => { if (!result.cancelled && result.paths.length) setNegativeSourcePaths(current => mergeSourcePaths(current, result.paths)); })}
            onChooseSourceFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => { if (!result.cancelled && result.path) setNegativeSourcePaths(current => mergeSourcePaths(current, [result.path!])); })}
            onDropSourcePaths={paths => setNegativeSourcePaths(paths)}
            onLinkOnlyImport={async paths => {
              const result = await projectWorkspaceClient.importProjectFiles(workspacePath, project.status, project.name, '', { deleteSourceAfterImport: false, linkOnly: true, sourcePaths: paths, adoptAsOriginal: true, mediaKind: 'image' });
              if (await handleProjectImportRecovery(result)) return;
              if (!result.success) throw new Error(result.error || '导入原始素材外链失败');
              if (result.watchDegraded) setRootWatchFailed(true);
              directoryEntriesCacheRef.current.clear();
              await Promise.all([refresh(''), loadProgressFolders()]);
              if (pageOwnsFileOperationNotification(result)) {
                onNotice(result.watchDegraded
                  ? `已创建 ${result.count || 0} 个原始素材外链；部分位置无法实时监听，已启用低频补扫。`
                  : `已创建 ${result.count || 0} 个原始素材外链`);
              }
            }}
            onBusyChange={setNegativeImportBusy}
            onImportConfigChange={onImportConfigChange}
            onImportComplete={() => { void completeNegativeImport(); }}
            completedActionLabel="关闭"
            onCompletedAction={() => { setNegativeSourcePaths([]); setPanel(null); }}
          />
        </div>
      </ToolModal>}
      {mountedPanels.has('broll') && <ToolModal
        title={PROJECT_PANEL_TITLES.broll}
        ownerPageId={pageId}
        panelKind="broll"
        open={panel === 'broll'}
        busy={panelImportBusy === 'broll'}
        onClose={() => { setBrollSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
      >
        {panelImportResult?.kind === 'broll' ? <ImportCompletionNotice
          message={`已导入 ${panelImportResult.count} 个花絮文件，源文件${panelImportResult.sourceDeleted ? '已删除' : '已保留'}。`}
          onClose={() => { setBrollSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
        /> : <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{project.name} / 花絮”</p><p className="mt-1 text-xs leading-5 text-blue-600">支持图片与视频；大于 4GB 的视频是否分割由设置决定。</p></div>
          <ImportSourceControls
            selectionTitle="选择一个或多个花絮文件或文件夹"
            selectionDescription="文件夹中的图片与视频会一并导入"
            selectedPaths={brollSourcePaths}
            onSelectedPathsChange={setBrollSourcePaths}
            onChooseFiles={() => void chooseBrollFiles()}
            onChooseFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => { if (!result.cancelled && result.path) setBrollSourcePaths(current => mergeSourcePaths(current, [result.path!])); })}
            importKind="broll"
            onImportKindChange={kind => openManualImport(kind, brollSourcePaths, fileImportTarget || currentRelativePath)}
            linkOnly={linkBrollSources}
            onLinkOnlyChange={value => { setLinkBrollSources(value); if (value) setDeleteBrollSources(false); }}
            deleteSourceAfterImport={deleteBrollSources}
            onDeleteSourceAfterImportChange={setDeleteBrollSources}
            deleteSourceDescription="花絮导入并验证成功后删除源文件；关闭则保留。"
            busy={panelImportBusy === 'broll'}
            onStart={() => void importBroll()}
          />
        </div>}
      </ToolModal>}
      {mountedPanels.has('file-import') && <ToolModal
        title={PROJECT_PANEL_TITLES['file-import']}
        ownerPageId={pageId}
        panelKind="file-import"
        open={panel === 'file-import'}
        busy={panelImportBusy === 'files'}
        onClose={() => { setFileImportSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
      >
        {panelImportResult?.kind === 'files' ? <ImportCompletionNotice
          message={`已导入 ${panelImportResult.count} 个文件，源文件${panelImportResult.sourceDeleted ? '已删除' : '已保留'}。`}
          onClose={() => { setFileImportSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
        /> : <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
            <p className="text-sm font-bold text-blue-800">导入到“{[browserRootLabel, normalizeProjectRelativePath(fileImportTarget)].filter(Boolean).join(' / ')}”</p>
            <p className="mt-1 text-xs leading-5 text-blue-600">选择任意文件导入当前目录；重名文件会自动生成不冲突的名称，不覆盖现有文件。</p>
          </div>

          <ImportSourceControls
            selectionTitle="选择一个或多个文件或文件夹"
            selectionDescription="所选内容将在确认后导入当前目录"
            selectedPaths={fileImportSourcePaths}
            onSelectedPathsChange={setFileImportSourcePaths}
            onChooseFiles={() => void chooseFilesToImport()}
            onChooseFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => { if (!result.cancelled && result.path) setFileImportSourcePaths(current => mergeSourcePaths(current, [result.path!])); })}
            importKind="files"
            onImportKindChange={kind => openManualImport(kind, fileImportSourcePaths, fileImportTarget)}
            disabledImportKinds={inspirationMode ? INSPIRATION_DISABLED_IMPORT_KINDS : undefined}
            linkOnly={linkFileSources}
            onLinkOnlyChange={value => { setLinkFileSources(value); if (value) setDeleteFileSources(false); }}
            deleteSourceAfterImport={deleteFileSources}
            onDeleteSourceAfterImportChange={setDeleteFileSources}
            deleteSourceDescription="导入并验证成功后删除源文件；关闭则保留。"
            busy={panelImportBusy === 'files'}
            onStart={() => void importFiles()}
          />
        </div>}
      </ToolModal>}
      {mountedPanels.has('match') && <ToolModal title={PROJECT_PANEL_TITLES.match} ownerPageId={pageId} panelKind="match" open={panel === 'match'} onClose={() => setPanel(null)}><MatchView embedded config={matchConfig} projectPath={project.path} folderOptions={folders} onUpdateConfig={onMatchConfigChange}/></ToolModal>}
      {mountedPanels.has('research') && <ToolModal title={PROJECT_PANEL_TITLES.research} ownerPageId={pageId} panelKind="research" open={panel === 'research'} onClose={() => { researchInspectionSequenceRef.current += 1; setResearchCollecting(false); setPanel(null); }}><ResearchView embedded initialTargetPath={researchTargetPath} initialTargetPaths={researchTargetPaths} sourcesLoading={researchCollecting} hasTxtFiles={researchTargetHasTxt} config={researchConfig} onUpdateConfig={onResearchConfigChange}/></ToolModal>}
      {mountedPanels.has('office-extract') && <ToolModal title={PROJECT_PANEL_TITLES['office-extract']} ownerPageId={pageId} panelKind="office-extract" open={panel === 'office-extract'} busy={officeExtractBusy} onClose={() => setPanel(null)}>
        {officeExtractResult ? <div className={`flex min-h-64 flex-col items-center justify-center rounded-xl border px-6 py-10 text-center ${officeExtractResult.state === 'success' ? 'border-emerald-200 bg-emerald-50/70' : 'border-amber-200 bg-amber-50/70'}`}>{officeExtractResult.state === 'success' ? <CheckCircle2 size={42} className="text-emerald-600"/> : <AlertTriangle size={42} className="text-amber-600"/>}<p className="mt-4 text-lg font-bold text-slate-800">{officeExtractResult.state === 'publication-failed' ? '图片已提取，但发布失败' : officeExtractResult.state === 'partial' ? '图片提取完成（部分文档失败）' : '图片提取完成'}</p><p className="mt-2 text-sm text-slate-600">共处理 {officeExtractResult.documents} 个文档，成功提取 {officeExtractResult.successful} 个，提取 {officeExtractResult.images} 张图片{officeExtractResult.failed ? `，文档失败 ${officeExtractResult.failed} 个` : ''}{officeExtractResult.publicationFailures.length ? `，发布失败 ${officeExtractResult.publicationFailures.length} 个` : ''}。</p>{officeExtractResult.warning && <p className="mt-3 max-w-2xl rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-sm font-medium leading-6 text-amber-800">{officeExtractResult.warning} 请勿盲目重试提取。</p>}{officeExtractResult.extractionFailures.length > 0 && <ul className="mt-3 max-w-2xl space-y-1 text-left text-xs text-slate-600">{officeExtractResult.extractionFailures.map(item => <li key={`extract-${item.documentName}`}>提取失败：{item.documentName} — {item.error}</li>)}</ul>}{officeExtractResult.publicationFailures.length > 0 && <ul className="mt-3 max-w-2xl space-y-2 text-left text-xs text-amber-800">{officeExtractResult.publicationFailures.map(item => <li key={`publish-${item.documentName}`} className="rounded-md bg-white/70 px-3 py-2"><span className="font-bold">发布失败：{item.documentName}</span><span className="block">{item.error}</span>{item.outputFolder && <span className="mt-1 block break-all text-slate-600">恢复目录：{item.outputFolder}</span>}</li>)}</ul>}{officeExtractResult.outputFolders.length > 0 && <p className="mt-3 max-w-2xl break-all text-xs leading-5 text-slate-500">输出目录：{officeExtractResult.outputFolders.join('；')}</p>}<button type="button" onClick={() => { setOfficeExtractResult(null); setOfficeExtractEntries([]); setPanel(null); }} className="dialog-primary mt-6">关闭</button></div> : officeExtractError ? <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50/70 px-6 py-10 text-center"><AlertTriangle size={42} className="text-red-600"/><p className="mt-4 text-lg font-bold text-slate-800">图片提取失败</p><p className="mt-2 max-w-2xl break-words text-sm text-slate-600">{officeExtractError}</p><div className="mt-6 flex items-center gap-2"><button type="button" onClick={() => { setOfficeExtractError(''); setOfficeExtractEntries([]); setPanel(null); }} className="dialog-secondary">重新选择</button><button type="button" onClick={() => void extractOfficeImages()} className="dialog-primary">重试</button></div></div> : <div className="space-y-4">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white"><header className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3"><FileImage size={18} className="text-blue-600"/><div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-800">已选择 {officeExtractEntries.length} 个 Office 文档</p><p className="mt-0.5 text-xs text-slate-500">支持 Word、PowerPoint 和 Excel 文档</p></div><span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500">{officeExtractEntries.length} 个文件</span></header><div className="max-h-52 divide-y divide-slate-100 overflow-y-auto">{officeExtractEntries.map(entry => <div key={entry.relativePath} className="flex items-center gap-3 px-4 py-2.5"><span className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[10px] font-bold text-blue-700">{entry.extension.slice(1).toUpperCase()}</span><span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{entry.name}</span><span className="text-[10px] font-bold text-slate-400">{officeExtractBusy ? '处理中' : '等待'}</span></div>)}</div></section>
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">输出到文档旁</p><p className="mt-1 text-xs leading-5 text-blue-600">图片保存到文档旁的“文档名_media”文件夹，不修改原文档。</p></div>
          <section className="rounded-xl bg-slate-900 px-4 py-3 text-white"><div className="flex items-center justify-between text-xs font-bold"><span>{officeExtractBusy ? '正在提取图片…' : '进度'}</span><span>{officeExtractBusy ? '处理中' : '0%'}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-700"><div className={`h-full rounded-full bg-blue-500 ${officeExtractBusy ? 'w-2/3 animate-pulse' : 'w-0'}`}/></div><p className="mt-2 text-[10px] text-slate-400">{officeExtractBusy ? '正在读取文档中的媒体文件，请稍候。' : '等待任务开始，状态与结果会显示在这里。'}</p></section>
          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-4"><button type="button" disabled={officeExtractBusy} onClick={() => { setOfficeExtractEntries([]); setPanel(null); }} className="dialog-secondary disabled:opacity-50">重新选择</button><button type="button" disabled={officeExtractBusy || !officeExtractEntries.length} onClick={() => void extractOfficeImages()} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-50">{officeExtractBusy ? <Loader2 size={16} className="animate-spin"/> : <Play size={16}/>} {officeExtractBusy ? '正在提取…' : '开始提取'}</button></div>
        </div>}
      </ToolModal>}
      {mountedPanels.has('trash') && <ToolModal title={PROJECT_PANEL_TITLES.trash} ownerPageId={pageId} panelKind="trash" open={panel === 'trash'} onClose={() => setPanel(null)}><p className="text-sm text-slate-500">项目“{project.name}”及其全部内容将移入系统回收站。</p><button onClick={moveToTrash} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">确认移入回收站</button></ToolModal>}
      {gatherPickerPaths && createPortal(<div role="dialog" aria-modal="true" aria-label="选择灵感汇聚项目" className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">选择目标项目</h3><p className="mt-1 text-sm text-slate-500">所选灵感将会出现在目录项目下的“策划”文件夹。</p></div><button type="button" disabled={gatheringInspiration} onClick={() => setGatherPickerPaths(null)} title="关闭" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"><X size={17}/></button></div><div className="mt-4 max-h-80 space-y-1 overflow-y-auto">{inspirationProjects.map(targetProject => <button key={targetProject.path} type="button" disabled={gatheringInspiration} onClick={() => void gatherInspiration(targetProject, gatherPickerPaths)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm hover:bg-blue-50 ${targetProject.path === inspirationTargetProject?.path ? 'bg-blue-50 font-bold text-blue-700' : 'text-slate-700'}`}><Folder size={17} className="shrink-0 text-blue-500"/><span className="min-w-0 flex-1 truncate">{targetProject.name}</span><span className="shrink-0 text-xs text-slate-400">{targetProject.status}</span></button>)}{!inspirationProjects.length && <p className="rounded-lg bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">当前工作目录中没有可用项目。</p>}</div></section></div>, document.body)}
      {folderMarkSetup && <ToolModal title="标记文件夹用途" ownerPageId={pageId} panelKind="folder-mark" open busy={progressSubmitting} onClose={() => setFolderMarkSetup(null)}><FolderMarkPanel
        draft={folderMarkSetup}
        folders={progressFolders}
        state={progressSubmitting ? 'processing' : 'ready'}
        namePresets={progressNamePresets}
        onChange={setFolderMarkSetup}
        onSubmit={draft => void submitFolderMarkSetup(draft)}
        onClose={() => setFolderMarkSetup(null)}
      /></ToolModal>}
      {progressSetup && versionProgressDraft && versionProgressPanelMode && <ToolModal title={versionProgressPanelTitle} ownerPageId={pageId} panelKind={`version-${versionProgressPanelMode}`} open busy={progressSubmitting} onClose={closeProgressSetup}><VersionProgressPanel
        draft={versionProgressDraft}
        folders={progressFolders}
        state={progressSubmitting ? 'processing' : progressImportCompletion ? 'result' : 'ready'}
        progress={progressSetup.mode === 'import' && progressImportStatus ? {
          percentage: progressImportStatus.progress,
          processedCount: progressImportStatus.filesCopied ?? progressImportStatus.processedCount,
          totalCount: progressImportStatus.totalFiles ?? progressImportStatus.totalCount,
          currentName: progressImportStatus.currentName,
        } : progressMutationStatus}
        message={progressImportCompletion}
        namePresets={progressNamePresets}
        onChange={(draft: VersionProgressDraft) => {
          const policy = normalizeTrackingPolicy('main', draft);
          const draftParent = progressFolders.find(folder => folder.id === draft.parentProgressId);
          const relation: ProgressSetupDraft['relation'] = (draft.versionKind || versionKindForParent(draft.versionKey, draftParent)) === 'branch' ? 'branch' : 'root';
          setProgressSetup(current => current ? {
            ...current,
            mediaKind: draft.mediaKind,
            versionKey: draft.versionKey ?? current.versionKey,
            progressName: draft.displayName,
            relationKind: 'main',
            relation,
            parentProgressId: draft.parentProgressId,
            trackingEnabled: policy.trackingEnabled,
            sourcePaths: draft.sourcePaths || [],
            deleteSourceAfterImport: draft.deleteSourceAfterImport === true,
            linkOnly: draft.linkOnly === true,
            renameSources: policy.renameFromParent,
            copyMissingFromParent: policy.copyMissingFromParent,
            workflowInputProgressIds: current.existingProgressId
              ? workflowInputIdsForRelationChange(progressFolders, versionGraphEdges, current.existingProgressId, draft.parentProgressId || null)
              : defaultWorkflowInputIds(progressFolders, versionGraphEdges, draft.parentProgressId),
          } : current);
        }}
        onChooseFiles={() => void projectWorkspaceClient.chooseImportSourceFiles().then(result => {
          if (!result.cancelled && result.paths.length) setProgressSetup(current => current ? { ...current, sourcePaths: mergeSourcePaths(current.sourcePaths, result.paths) } : current);
        })}
        onChooseFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => {
          const sourcePath = result.path;
          if (!result.cancelled && sourcePath) setProgressSetup(current => current ? { ...current, sourcePaths: mergeSourcePaths(current.sourcePaths, [sourcePath]) } : current);
        })}
        importStep={progressImportStep}
        onImportStepChange={setProgressImportStep}
        onImportKindChange={(kind, sourcePaths) => openManualImport(kind, sourcePaths, fileImportTarget || currentRelativePath)}
        onSubmit={() => void submitProgressSetup()}
        onClose={closeProgressSetup}
      /></ToolModal>}
      {trackingConfirmationSessionId && <TrackingConfirmationPanel key={`${workspacePath}:${trackingConfirmationSessionId}`} active={active} sessionId={trackingConfirmationSessionId} workspacePath={workspacePath} progressFolders={progressFolders} cacheConfig={mediaCacheConfig} onNotice={onNotice} onClose={() => setTrackingConfirmationSessionId('')} onCommitted={() => { const committedSessionId = trackingConfirmationSessionId; const committedProgressId = trackingConfirmationProgressId; dismissTrackingTaskForSession(committedSessionId); if (committedProgressId) safeStorageRemove(`photoflow:tracking-session:${workspacePath}:${project.name}:${committedProgressId}`); setTrackingConfirmationSessionId(current => current === committedSessionId ? '' : current); setTrackingConfirmationProgressId(current => current === committedProgressId ? '' : current); void loadProgressFolders().then(() => refresh('')); }} onReleased={() => { dismissTrackingTaskForSession(trackingConfirmationSessionId); if (trackingConfirmationProgressId) safeStorageRemove(`photoflow:tracking-session:${workspacePath}:${project.name}:${trackingConfirmationProgressId}`); setTrackingConfirmationSessionId(''); setTrackingConfirmationProgressId(''); void loadProgressFolders(); }}/>
      }
      {progressCompare && <div role="dialog" aria-modal="true" aria-label="确认版本关系" className="fixed inset-0 z-[345] flex items-center justify-center bg-slate-950/50 p-4"><div className="flex h-[min(92vh,820px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-5 py-4"><h3 className="text-lg font-bold text-slate-800">确认版本关系</h3><p className="mt-1 text-xs text-slate-500">“{progressCompare.parentFolder.displayName}” → “{progressCompare.progressFolder.displayName}”</p></header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.85fr)_minmax(0,1.65fr)] gap-4 overflow-hidden p-5">
          <div className="flex min-h-0 flex-col"><div aria-label="版本关系统计筛选" className="mb-3 flex flex-wrap gap-2 text-xs">
            {([
              ['recognized', '识别匹配', progressCompare.matches.length, 'border-blue-200 bg-blue-50 text-blue-700', 'border-blue-500 ring-blue-200'],
              ['accepted', '已选继承', progressCompare.acceptedSources.length, 'border-emerald-200 bg-emerald-50 text-emerald-700', 'border-emerald-500 ring-emerald-200'],
              ['new', '新素材', progressCompareNewSources.length, 'border-slate-200 bg-slate-100 text-slate-600', 'border-slate-500 ring-slate-200'],
              ['missing', '旧版未返回', progressCompareMissingReferences.length, 'border-slate-200 bg-slate-100 text-slate-600', 'border-slate-500 ring-slate-200'],
            ] as const).map(([filter, label, count, colorClass, activeClass]) => <button key={filter} type="button" aria-pressed={progressCompareFilter === filter} onClick={() => setProgressCompareFilter(filter)} className={`rounded-full border px-2.5 py-1 transition hover:brightness-95 focus:outline-none focus-visible:ring-2 ${colorClass} ${progressCompareFilter === filter ? `${activeClass} ring-2` : ''}`}>{label} {count}</button>)}
          </div>
            {progressCompareListItems.length ? <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-200">{progressCompareListItems.map(item => { const match = item.match; const accepted = Boolean(match && progressCompare.acceptedSources.includes(match.source)); const activeItem = activeProgressCompareItemKey === item.key; const suggested = Boolean(match && progressCompare.suggestions.some(candidate => candidate.source === match.source)); const badge = item.category === 'accepted' ? '已继承' : item.category === 'new' ? suggested ? '可继承' : '新素材' : item.category === 'missing' ? suggested ? '有候选' : '未返回' : suggested ? '最佳候选' : match?.confidence || '匹配'; return <div key={item.key} role="button" tabIndex={0} onClick={() => setActiveProgressCompareItemKey(item.key)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveProgressCompareItemKey(item.key); } }} className={`grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 py-2.5 text-xs last:border-0 ${activeItem ? 'border-blue-100 bg-blue-50 ring-1 ring-inset ring-blue-300' : 'border-slate-100 hover:bg-slate-50'}`}>
              {match ? <input type="checkbox" checked={accepted} aria-label={`将 ${match.source} 作为继承版本`} onClick={event => event.stopPropagation()} onChange={() => setProgressCompare(current => current ? { ...current, acceptedSources: accepted ? current.acceptedSources.filter(source => source !== match.source) : [...current.acceptedSources, match.source] } : current)}/> : <span aria-hidden className="h-4 w-4"/>}
              <span className="min-w-0">{item.source ? <span className="block truncate font-medium text-slate-700" title={item.source}>当前 · {item.source}</span> : <span className="block text-slate-400">当前 · 未返回</span>}{item.reference ? <span className="mt-1 block truncate text-slate-400" title={item.reference}>上一版 · {item.reference}</span> : <span className="mt-1 block text-slate-400">上一版 · 无匹配素材</span>}</span>
              <span className={`rounded-full px-2 py-0.5 font-bold ${item.category === 'accepted' ? 'bg-emerald-50 text-emerald-600' : item.category === 'new' || item.category === 'missing' ? 'bg-slate-100 text-slate-500' : suggested ? 'bg-slate-100 text-slate-500' : match?.confidence === '高' ? 'bg-emerald-50 text-emerald-600' : match?.confidence === '中' ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-500'}`}>{badge}</span>
            </div>; })}</div> : <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">当前分类中没有素材。</p>}
            {progressCompare.renameSources && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">确认后，会把已勾选的新版本文件同步改为继承自上一版本的名称。</p>}
            {progressCompare.copyMissingFromParent && <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">确认后，会从上一版本复制当前缺失的 {progressCompareMissingReferences.length} 个媒体文件，并将它们登记为继承版本。</p>}
          </div>
          <ProgressPairPreview match={activeProgressCompareItem ? { source: activeProgressCompareItem.source, reference: activeProgressCompareItem.reference } : undefined} parentFolder={progressCompare.parentFolder} progressFolder={progressCompare.progressFolder} cacheConfig={mediaCacheConfig}/>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><button type="button" onClick={() => progressCompare.reconcileExisting ? void closeProgressCompare() : void disableProgressTracking()} disabled={progressSubmitting} className="dialog-secondary">{progressCompare.trackingRefreshMode === 'establish' ? '取消建立跟踪' : progressCompare.trackingRefreshMode === 'refresh' ? '取消重新扫描' : progressCompare.reconcileExisting ? '取消重新处理' : progressCompare.sourceMode === 'mark' ? '只标记进度，不开启跟踪' : '保留导入，但不开启跟踪'}</button><button type="button" onClick={() => void commitProgressCompare()} disabled={progressSubmitting} className="dialog-primary inline-flex items-center gap-2">{progressSubmitting && <Loader2 size={15} className="animate-spin"/>}{progressCompare.trackingRefreshMode === 'establish' ? '确认并建立跟踪' : progressCompare.reconcileExisting ? '确认并更新版本关系' : '确认并建立跟踪'}</button></footer>
      </div></div>}
      {progressRepair && <div role="dialog" aria-modal="true" aria-label="修复版本批次" className="fixed inset-0 z-[348] flex items-center justify-center bg-slate-950/50 p-4"><div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h3 className="font-bold text-slate-800">修复版本批次</h3><p className="mt-1 text-xs text-slate-500">{progressRepair.progressFolder.displayName} · 已保存版本关系；下面的文件操作可安全重试。</p></div><button type="button" disabled={progressRepairBusy} onClick={() => setProgressRepair(null)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"><X size={17}/></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="overflow-hidden rounded-xl border border-slate-200">{progressRepair.operations.length ? progressRepair.operations.map(operation => <div key={operation.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-slate-100 px-4 py-3 text-xs last:border-0"><div className="min-w-0"><p className="truncate font-medium text-slate-700" title={operation.sourcePath}>{operation.sourcePath.replace(/.*[\\/]/, '')} → {operation.targetPath.replace(/.*[\\/]/, '')}</p><p className={`mt-1 leading-5 ${operation.status === 'succeeded' ? 'text-emerald-600' : 'text-red-600'}`}>{operation.status === 'succeeded' ? '已完成' : operation.error || '等待执行'}</p></div><span className={`self-start rounded-full px-2 py-1 font-bold ${operation.status === 'succeeded' ? 'bg-emerald-50 text-emerald-600' : operation.status === 'running' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'}`}>{operation.status === 'succeeded' ? '成功' : operation.status === 'running' ? '处理中' : `待重试 · ${operation.attemptCount}`}</span></div>) : <p className="px-4 py-8 text-center text-sm text-slate-500">该批次没有待修复的文件操作。</p>}</div></div>
        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><p className="text-xs text-slate-500">重试只处理失败或未完成的项目，已成功项目不会重复执行。</p><div className="flex gap-2"><button type="button" disabled={progressRepairBusy} onClick={() => setProgressRepair(null)} className="dialog-secondary">稍后处理</button><button type="button" disabled={progressRepairBusy || !progressRepair.operations.some(operation => operation.status !== 'succeeded')} onClick={() => void retryProgressRepair()} className="dialog-primary inline-flex items-center gap-2">{progressRepairBusy && <Loader2 size={15} className="animate-spin"/>}重试未完成项</button></div></footer>
      </div></div>}
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
      {renderedVersionEntry && <div className={activeView === 'version' ? 'contents' : 'hidden'}><VersionManager active={active && activeView === 'version'} entry={renderedVersionEntry} workspacePath={workspacePath} project={project} cacheConfig={mediaCacheConfig} videoPlaybackSettings={videoPlaybackSettings} progressId={versionProgressFolder?.id || versionProgressId} progressVersionKey={versionProgressFolder?.versionKey} onNotice={onNotice} onVersionStateChanged={() => { if (finalViewOpen) void loadFinalViewEntries(); }} onClose={() => { setVersionEntry(null); setVersionProgressId(''); versionProgressLocationRef.current = null; onCloseToolTab('version'); if (finalViewOpen) void loadFinalViewEntries(); }}/></div>}

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {versionTreeOpen ? <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={handleFileSurfacePointerDownCapture} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} style={{ marginInline: -FILE_SURFACE_HORIZONTAL_PADDING }} className={`relative min-h-0 flex-1 select-none overflow-hidden outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {progressRelationInspection.needsRepair ? <div role="alert" className="m-4 rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-900"><div className="flex items-center gap-2 font-bold"><AlertTriangle size={18}/>版本关系需要修复</div><p className="mt-2 text-sm">检测到循环关系，已停止版本树遍历，避免应用崩溃。</p><p className="mt-2 break-all font-mono text-xs text-amber-700">节点 ID：{progressRelationInspection.cycleNodeIds.join('、')}</p></div> : <>{orphanedProgressFolders.length > 0 && <div role="alert" className="m-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900"><div className="flex items-center gap-2 font-bold"><AlertTriangle size={18}/>旧版游离进度已保留</div><p className="mt-2 text-sm">这些节点不会在刷新时自动删除，也不能作为新版本的父节点。请打开“修改进度”选择有效父版本，或显式取消版本登记；物理文件不会被删除。</p><p className="mt-2 text-xs text-amber-700">{orphanedProgressFolders.map(folder => folder.displayName).join('、')}</p></div>}<ProjectVersionTree
            active={active && activeView === 'project'}
            progressFolders={progressFolders}
            graphEdges={versionGraphEdges}
            entries={displayedFileEntries}
            structureEntries={fileEntries}
            selectedRelativePaths={selectedPaths}
            filterActive={Boolean(searchQuery.trim() || fileFilter !== 'all' || ratingFilter !== 'all')}
            activeRelativePath={currentRelativePath}
            gridIconSize={gridIconSize}
            workspacePath={workspacePath}
            projectName={project.name}
            projectRelativePath={projectRelativePath}
            renderEntry={renderVersionTreeEntry}
            pendingChildId={pendingRelationChange?.childProgressId || draggingChildId || undefined}
            hoverParentId={hoverParentId || undefined}
            mutatingChildIds={relationMutatingChildIds}
            onBeginRelationEdit={childId => { setDraggingChildId(childId); setHoverParentId(''); }}
            onHoverRelationParent={parentId => setHoverParentId(parentId || '')}
            onRequestRelationChange={(childProgressId, parentProgressId) => void requestProgressRelationChange(childProgressId, parentProgressId)}
            onRequestSupplementalEdgeDelete={edge => void requestSupplementalEdgeDelete(edge)}
            onRequestSupplementalEdgeReconnect={(edge, newSourceProgressId) => void requestSupplementalEdgeReconnect(edge, newSourceProgressId)}
            onRequestSupplementalEdgeCreate={(sourceProgressId, targetProgressId, edgeKind) => void requestSupplementalEdgeCreate(sourceProgressId, targetProgressId, edgeKind)}
            onRequestCreateVersion={(source, entry) => void openNextProgressFromVersionTree(source, entry)}
            onRequestCreateEmptyVersion={(source, branch) => void openEmptyProgressFromVersionTree(source, branch)}
            onRequestEntryContextMenu={openFileMenu}
            onStartFileDrag={(event, entry) => startEntryDrag(event, entry, 'version-tree')}
            canUndoRelation={relationHistoryRevision >= 0 && relationUndoStackRef.current.length > 0}
            canRedoRelation={relationHistoryRevision >= 0 && relationRedoStackRef.current.length > 0}
            onUndoRelation={() => void undoVersionGraphAction()}
            onRedoRelation={() => void redoVersionGraphAction()}
            onCancelRelationEdit={cancelRelationEdit}
            onNotice={onNotice}
            onCanvasControllerChange={setVersionTreeCanvasController}
            onViewportScrollChange={setVersionTreeHeaderCollapsed}
          /></>}
        </div> : <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={handleFileSurfacePointerDownCapture} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} style={{ marginInline: -FILE_SURFACE_HORIZONTAL_PADDING, paddingInline: FILE_SURFACE_HORIZONTAL_PADDING }} className={`relative min-h-[220px] flex-1 select-none outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {groupedResultsActive && (groupedInitialLoading ? <p className="py-12 text-center text-sm text-slate-400"><Loader2 size={17} className="mr-2 inline animate-spin"/>{projectRootFilterActive ? '正在分页读取全部文件…' : searchQuery.trim() ? `正在搜索${recursiveScopeLabel}…` : '正在读取所有文件…'}</p> : groupedError && !searchResultGroups.length ? <p className="py-8 text-center text-sm text-red-600">读取文件失败：{groupedError}</p> : searchResultGroups.length ? <div className="pb-4">
            <p className="flex items-center gap-1.5 px-1 text-xs text-slate-500">{groupedLoading && <Loader2 aria-label="正在后台刷新" size={13} className="shrink-0 animate-spin"/>}<span>{projectRootFilterActive ? `已分页加载${browserContext.title}中的 ${displayedFileEntries.length} 个文件` : searchQuery.trim() ? `在${currentRelativePath ? `“${currentRelativePath}”及其子文件夹` : recursiveScopeLabel}中找到 ${displayedFileEntries.length} 个文件` : `已加载${currentRelativePath ? `“${currentRelativePath}”及其子文件夹` : recursiveScopeLabel}中的 ${displayedFileEntries.length} 个文件`}</span></p>
            {searchResultGroups.map(([folderPath, entries], groupIndex) => { const viaShortcut = entries.some(entry => entry.viaShortcut); const viaExternalLink = entries.some(entry => entry.viaExternalLink); const readOnlyShortcut = viaShortcut && !viaExternalLink; const folderLabel = viaShortcut ? folderPath.replace(/\.lnk(?=\/|$)/gi, '') : folderPath; const targetLabel = folderLabel || project.name; const normalizedFolderPath = normalizeProjectRelativePath(folderPath); return <section key={folderPath || '__root__'} data-recursive-folder-path={normalizedFolderPath} data-recursive-folder-label={targetLabel} data-recursive-folder-readonly={readOnlyShortcut ? 'true' : 'false'} data-drop-capable={readOnlyShortcut ? 'false' : 'true'} onContextMenu={event => { if (readOnlyShortcut) { event.preventDefault(); event.stopPropagation(); onNotice('快捷方式指向的外部文件夹是只读浏览区域'); } else openSurfaceMenu(event, normalizedFolderPath, targetLabel); }} onDragOver={event => handleRecursiveFolderDragOver(event, normalizedFolderPath, readOnlyShortcut)} onDragLeave={event => handleRecursiveFolderDragLeave(event, normalizedFolderPath)} onDrop={event => void handleRecursiveFolderDrop(event, normalizedFolderPath, targetLabel, readOnlyShortcut)} className={`${groupIndex ? 'mt-5 border-t border-slate-200 pt-4' : 'pt-3'} rounded-lg transition ${recursiveDropTargetPath === normalizedFolderPath ? 'bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}><header className="mb-2 flex min-w-0 items-center gap-2 px-1"><Folder size={16} className="shrink-0 text-blue-500"/>{readOnlyShortcut ? <span title={`${folderLabel}（快捷方式）`} className="min-w-0 truncate text-sm font-bold text-slate-700">{folderLabel || '快捷方式'} <span className="font-normal text-slate-400">（快捷方式）</span></span> : <button type="button" onClick={() => { setSearchQuery(''); navigateToDirectory(folderPath); }} title={`打开 ${folderPath || project.name}`} className="min-w-0 truncate text-sm font-bold text-slate-700 hover:text-blue-600">{folderPath || '项目根目录'}</button>}<span className="shrink-0 text-xs text-slate-400">{entries.length} 个</span></header><div className="grid w-full content-start" style={{ gap: FILE_GRID_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{entries.map(entry => <div key={`${entry.relativePath}|${entry.path}`} role="button" tabIndex={0} draggable={!entry.viaShortcut || entry.viaExternalLink} onDragStart={event => startEntryDrag(event, entry)} data-entry-kind={entry.kind} data-drop-capable={isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry) ? 'true' : 'false'} data-entry-path={entry.relativePath} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.relativePath} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) ? 'bg-blue-50 ring-1 ring-blue-400 focus-visible:outline-none' : ''} ${entryHasPreviewState(entry) && !selectedPaths.includes(entry.relativePath) ? 'project-file-entry-preview' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''}`}>{renderEntrySelectionControl(entry)}<div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div><p className="mt-2 truncate text-xs font-medium text-slate-700">{getEntryDisplayName(entry)}</p><p className="mt-0.5 text-[10px] uppercase text-slate-400">{getEntryTypeLabel(entry)}</p></div>)}</div></section>; })}
            {(!searchQuery.trim() || projectRootFilterActive) && <p className={`py-6 text-center text-xs ${groupedLoadError ? 'text-red-500' : 'text-slate-400'}`}>{groupedLoadError ? `继续加载失败：${groupedLoadError}` : groupedLoadingMore ? <><Loader2 size={14} className="mr-1.5 inline animate-spin"/>正在继续加载…</> : groupedHasMore ? '继续向下滚动以加载更多文件' : '已显示当前范围内的全部文件'}</p>}
          </div> : <p className="py-12 text-center text-sm text-slate-400">{projectRootFilterActive ? `${browserContext.title}中没有符合筛选条件的${filteredFileTypeLabel}。` : searchQuery.trim() ? `没有在${recursiveScopeLabel}中找到包含“${searchQuery}”且符合筛选条件的文件。` : `当前范围内没有可显示的${filteredFileTypeLabel}。`}</p>)}
          {!groupedResultsActive && searchQuery.trim() && searchLoading && <p className="py-12 text-center text-sm text-slate-400"><Loader2 size={17} className="mr-2 inline animate-spin"/>正在搜索{recursiveScopeLabel}…</p>}
          {!groupedResultsActive && searchQuery.trim() && searchError && <p className="py-8 text-center text-sm text-red-600">搜索失败：{searchError}</p>}
          <div className={groupedResultsActive || Boolean(searchQuery.trim() && (searchLoading || searchError)) ? 'hidden' : undefined}>
          {directoryLoading ? <div role="status" aria-live="polite" className="flex min-h-[220px] items-center justify-center border-y border-slate-200 text-sm text-slate-500"><Loader2 size={18} className="mr-2 animate-spin"/>加载中…</div> : displayedFileEntries.length ? viewMode === 'list' ? <div className="file-list-table border-y border-slate-200 text-sm" style={fileListGridStyle}>
            <div className="file-list-row file-list-heading text-xs font-medium text-slate-500">
              <span className="file-list-heading-cell"><span className="file-list-heading-label">名称</span><FileListColumnResizeHandle label="调整名称列宽度" onDrag={deltaX => resizeFileListBoundary(0, deltaX)}/></span>
              <span className="file-list-heading-cell"><span className="file-list-heading-label">修改日期</span><FileListColumnResizeHandle label="调整修改日期列宽度" onDrag={deltaX => resizeFileListBoundary(1, deltaX)}/></span>
              <span className="file-list-heading-cell"><span className="file-list-heading-label">类型</span><FileListColumnResizeHandle label="调整类型列宽度" onDrag={deltaX => resizeFileListBoundary(2, deltaX)}/></span>
              <span className="file-list-heading-cell"><span className="file-list-heading-label">大小</span><FileListColumnResizeHandle last label="调整大小列宽度" onDrag={deltaX => resizeFileListBoundary(3, deltaX)}/></span>
            </div>
            {virtualWindow.top > 0 && <div aria-hidden style={{ height: virtualWindow.top }} />}
            {renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-drop-capable={isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry) ? 'true' : 'false'} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`file-list-row group w-full cursor-default border-t border-slate-200 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) ? 'bg-blue-50 focus-visible:outline-none' : ''} ${entryHasPreviewState(entry) && !selectedPaths.includes(entry.relativePath) ? 'project-file-entry-preview' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-inset ring-blue-500' : ''}`}>
              <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">{renderEntrySelectionControl(entry, true)}<span className="relative flex h-9 w-11 shrink-0 items-center justify-center overflow-hidden">{renderEntryIcon(entry)}</span>{renderEntryName(entry)}</span>
              <span className="min-w-0 truncate text-slate-500">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '…'}</span>
              <span className="min-w-0 truncate uppercase text-slate-500">{getEntryTypeLabel(entry)}</span>
              <span className="min-w-0 truncate text-slate-500">{entry.kind === 'folder' ? '' : entry.size >= 0 ? formatFileSize(entry.size) : '…'}</span>
            </div>)}
            {virtualWindow.bottom > 0 && <div aria-hidden style={{ height: virtualWindow.bottom }} />}
          </div> : <><div aria-hidden style={{ height: virtualWindow.top }}/><div className="grid w-full content-start" style={{ gap: FILE_GRID_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-drop-capable={isFolderLikeEntry(entry) && !isUnsupportedShortcutContent(entry) ? 'true' : 'false'} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) ? 'bg-blue-50 ring-1 ring-blue-400 focus-visible:outline-none' : ''} ${entryHasPreviewState(entry) && !selectedPaths.includes(entry.relativePath) ? 'project-file-entry-preview' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-blue-500' : ''}`}>{renderEntrySelectionControl(entry)}<div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div>{renderEntryName(entry, true)}<p className="mt-0.5 text-[10px] uppercase text-slate-400">{getEntryTypeLabel(entry)}</p></div>)}</div><div aria-hidden style={{ height: virtualWindow.bottom }}/></> : <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">{searchQuery ? `没有找到包含“${searchQuery}”且符合筛选条件的文件。` : `当前文件夹没有${filteredFileTypeLabel}。`}</p>}
          </div>
        </div>}
      </section>

      <section className="hidden rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-slate-800">项目文件夹</h3><span className="text-sm text-slate-500">{folders.length} 个</span></div>
        {folders.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{folders.map(folder => <button key={folder.path} onClick={() => openFolder(folder.name)} title={`打开 ${folder.name}`} className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-blue-50"><Folder size={64} strokeWidth={1.5} fill="currentColor" className="text-blue-500 drop-shadow-sm transition-transform group-hover:scale-105"/><span className="max-w-full truncate text-sm font-medium text-slate-700">{folder.name}</span></button>)}</div> : <p className="py-8 text-center text-sm text-slate-400">暂无子文件夹。</p>}
      </section>

      </div>
      {previewPaneOpen && active && activeView === 'project' && <><ColumnResizeHandle label="调整文件区和预览区宽度" onDrag={resizeFilesAndPreview}/><MediaPreviewPane entry={previewEntry} cacheConfig={mediaCacheConfig} width={displayedColumnWidths.preview} pinned={previewPanePinned} keyboardSettings={videoPlaybackSettings} videoTrimExportMode={videoTools.trim.exportMode} videoTrimAvailable={videoToolsAvailable && advancedVideoPlaybackAvailable} photoshopAvailable={photoshopAvailable} ratingAvailable={previewCanMarkFinal} rating={previewRating} ratingMode={favoriteDisplayMode} ratingLoading={previewRatingLoading} ratingBusy={previewRatingBusy} onChangeRating={rating => void updatePreviewRating(rating)} onTogglePinned={togglePreviewPanePinned} onTechnicalMetadata={setPreviewTechnicalMetadata} onNavigate={navigatePreviewMedia} onContextMenu={event => previewEntry && openFileMenu(event, previewEntry, false)} onContextMenuAt={(x, y) => previewEntry && openFileMenuAt(x, y, previewEntry, false)} onAnalyzeImageCrop={analyzePreviewImageCrop} onConfirmImageCrop={savePreviewImageCrop} onTrimVideo={trimPreviewVideo} onLoadVideoTimelineFrames={loadPreviewVideoTimelineFrames} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onOpenInPhotoshop={() => previewEntry && openProjectEntriesInPhotoshop([previewEntry])} onClose={closePreviewPaneByUser}/></>}
      {metadataPaneOpen && <><ColumnResizeHandle label={previewPaneOpen ? '调整预览区和详细信息区宽度' : '调整文件区和详细信息区宽度'} onDrag={previewPaneOpen ? resizePreviewAndMetadata : resizeFilesAndMetadata}/><FileMetadataPane entry={focusedEntry} selectedEntries={selectedEntries} selectionEntryDetails={selectionEntryDetails} selectionEntryDetailsLoading={selectionEntryDetailsLoading} entryDetails={previewEntryDetails} metadataFields={currentPreviewMetadataFields} metadataLoading={currentPreviewMetadataLoading} metadataError={currentPreviewMetadataError} technicalMetadata={focusedEntry?.relativePath === previewEntry?.relativePath ? previewTechnicalMetadata : EMPTY_PREVIEW_TECHNICAL_METADATA} formatFileSize={formatFileSize} width={displayedColumnWidths.metadata} pinned={metadataPanePinned} onTogglePinned={toggleMetadataPanePinned} onOpen={() => focusedEntry && openProjectEntry(focusedEntry, true)} onCopyPath={() => copyEntryPaths(selectedEntries.length > 1 ? selectedEntries : focusedEntry ? [focusedEntry] : [])} onClose={closeMetadataPaneByUser}/></>}
      </div>

      {confirmDelete && <div className="fixed inset-0 z-[320] flex items-center justify-center bg-slate-950/40 p-4"><div role="dialog" aria-modal="true" aria-label="删除项目" className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="mb-3 flex items-center justify-between"><h3 className="font-bold text-slate-800">确定要删除项目吗？</h3><button onClick={() => setConfirmDelete(false)}><X size={18}/></button></div><p className="text-sm text-slate-500">删除项目会将项目文件夹“{project.name}”移入回收站。</p><div className="mt-5 flex justify-end gap-2"><button onClick={() => setConfirmDelete(false)} className="dialog-secondary">取消</button><button onClick={async () => { setConfirmDelete(false); await moveToTrash(); }} className="rounded-md bg-red-600 px-3 py-2 text-sm font-bold text-white hover:bg-red-500">删除项目</button></div></div></div>}
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

type VideoTrimExportProgress = { phase: string; progress: number; message: string };

const VideoTrimTimeline = ({ duration, start, end, currentTime, frames, exportMode, busyMode, exportProgress, progressVisible, onChange, onPreview, onCancel, onSave }: {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  frames: string[];
  exportMode: AppConfig['videoTools']['trim']['exportMode'];
  busyMode: 'new' | 'replace' | '';
  exportProgress?: VideoTrimExportProgress;
  progressVisible: boolean;
  onChange: (edge: 'start' | 'end', time: number) => void;
  onPreview: (time: number) => void;
  onCancel: () => void;
  onSave: (mode: 'new' | 'replace') => void;
}) => {
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; edge: 'start' | 'end' } | null>(null);
  const safeDuration = Math.max(.05, duration);
  const percent = (value: number) => Math.max(0, Math.min(100, value / safeDuration * 100));
  const startPercent = percent(start);
  const endPercent = percent(end);
  const playheadPercent = percent(currentTime);
  const timeAtClientX = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect?.width) return 0;
    return Math.max(0, Math.min(safeDuration, (clientX - rect.left) / rect.width * safeDuration));
  };
  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>, edge: 'start' | 'end') => {
    if (busyMode) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, edge };
    event.currentTarget.setPointerCapture(event.pointerId);
    const time = timeAtClientX(event.clientX);
    onChange(edge, time);
  };
  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const time = timeAtClientX(event.clientX);
    onChange(drag.edge, time);
  };
  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };
  const selectedDuration = Math.max(0, end - start);

  return <div role="dialog" aria-label="剪辑视频" className="relative z-30 shrink-0 border-t border-white/10 bg-[#070b15] px-3 pb-3 pt-2.5 text-white shadow-[0_-12px_30px_rgba(0,0,0,.35)]" onContextMenu={event => event.stopPropagation()}>
    <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
      <div className="min-w-0"><span className="font-bold text-white">剪辑视频</span><span className="ml-2 text-slate-400">拖动左右边缘，画面会实时定位</span></div>
      <div className="shrink-0 tabular-nums text-slate-300"><span className="text-white">{formatMediaDuration(start)}</span><span className="mx-1.5 text-slate-600">—</span><span className="text-white">{formatMediaDuration(end)}</span><span className="ml-2 text-slate-500">保留 {formatMediaDuration(selectedDuration)}</span></div>
    </div>
    <div ref={railRef} onPointerDown={event => { if (busyMode || (event.target as HTMLElement).closest('button')) return; const time = timeAtClientX(event.clientX); onPreview(Math.max(start, Math.min(end, time))); }} className="relative h-16 select-none overflow-hidden rounded-lg border border-white/10 bg-slate-900" style={{ touchAction: 'none' }}>
      <div className="pointer-events-none absolute inset-0 grid grid-cols-8 opacity-60">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className="border-r border-black/25 bg-slate-800 bg-cover bg-center last:border-r-0" style={frames[index] ? { backgroundImage: `url(${JSON.stringify(frames[index]).slice(1, -1)})` } : undefined}/>)}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/70" style={{ width: `${startPercent}%` }}/>
      <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/70" style={{ width: `${100 - endPercent}%` }}/>
      <div className="pointer-events-none absolute inset-y-0 rounded border-y-[3px] border-amber-400" style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }}/>
      {busyMode && exportProgress && <div role="progressbar" aria-label={exportProgress.message} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exportProgress.progress)} className="pointer-events-none absolute inset-0 z-40 overflow-hidden bg-slate-600/65 backdrop-blur-[1px]">
        <div className="absolute inset-x-0 top-0 h-1 bg-slate-950/45"><div className="h-full bg-amber-400 transition-[width] duration-200" style={{ width: `${progressVisible ? Math.max(0, Math.min(100, exportProgress.progress)) : 0}%` }}/></div>
        <div className="absolute inset-x-2 top-2 flex min-w-0 items-center justify-between gap-2 text-[10px] font-bold text-white drop-shadow-sm"><span className="shrink-0">正在裁剪视频…</span><span className="min-w-0 truncate text-right text-slate-100">{progressVisible ? `${exportProgress.message} · ${Math.round(exportProgress.progress)}%` : '正在准备裁剪…'}</span></div>
      </div>}
      {currentTime >= start && currentTime <= end && (
        <div className="pointer-events-none absolute inset-y-1 z-20 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_5px_rgba(0,0,0,.9)]" style={{ left: `${playheadPercent}%` }}/>
      )}
      <button type="button" aria-label={`调整开始时间，当前 ${formatMediaDuration(start)}`} disabled={Boolean(busyMode)} onPointerDown={event => beginDrag(event, 'start')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} className="absolute inset-y-0 z-30 w-5 -translate-x-1/2 cursor-ew-resize rounded-l-md border-y-[3px] border-l-[3px] border-amber-400 bg-amber-400/20 outline-none disabled:cursor-default" style={{ left: `${startPercent}%`, touchAction: 'none' }}><span className="absolute left-1/2 top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-amber-100"/></button>
      <button type="button" aria-label={`调整结束时间，当前 ${formatMediaDuration(end)}`} disabled={Boolean(busyMode)} onPointerDown={event => beginDrag(event, 'end')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} className="absolute inset-y-0 z-30 w-5 -translate-x-1/2 cursor-ew-resize rounded-r-md border-y-[3px] border-r-[3px] border-amber-400 bg-amber-400/20 outline-none disabled:cursor-default" style={{ left: `${endPercent}%`, touchAction: 'none' }}><span className="absolute left-1/2 top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-amber-100"/></button>
    </div>
    <div className="mt-2.5 flex items-center justify-between gap-2">
      <p className="min-w-0 truncate text-[10px] text-slate-500">{exportMode === 'fast' ? '快速导出不重新编码；边界可能按关键帧产生少量偏差。' : '精确导出会高质量重新编码，确保保留区间正确。'}</p>
      <div className="flex shrink-0 items-center gap-2"><button type="button" disabled={exportProgress?.phase === 'cancelling'} onClick={onCancel} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-300 hover:bg-white/10 disabled:opacity-40">{busyMode ? exportProgress?.phase === 'cancelling' ? '正在取消…' : '取消导出' : '取消'}</button><button type="button" disabled={Boolean(busyMode) || selectedDuration < .05} onClick={() => onSave('new')} className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-white/20 disabled:opacity-40">{busyMode === 'new' && <Loader2 size={13} className="animate-spin"/>}{busyMode === 'new' ? '正在另存…' : '另存为新视频'}</button><button type="button" disabled={Boolean(busyMode) || selectedDuration < .05} onClick={() => onSave('replace')} className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-40">{busyMode === 'replace' && <Loader2 size={13} className="animate-spin"/>}{busyMode === 'replace' ? '正在替换…' : '替换原视频'}</button></div>
    </div>
  </div>;
};
const FULLSCREEN_CONTROLS_HIDE_DELAY_MS = 1800;
const MediaPreviewPane = ({ entry, cacheConfig, width, pinned, keyboardSettings, videoTrimExportMode, videoTrimAvailable, photoshopAvailable, ratingAvailable, rating, ratingMode, ratingLoading, ratingBusy, onChangeRating, onTogglePinned, onTechnicalMetadata, onNavigate, onContextMenu, onContextMenuAt, onAnalyzeImageCrop, onConfirmImageCrop, onTrimVideo, onLoadVideoTimelineFrames, onOpen, onOpenInPhotoshop, onClose }: {
  entry?: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  width: number;
  pinned: boolean;
  keyboardSettings: AppConfig['videoPlayback'];
  videoTrimExportMode: AppConfig['videoTools']['trim']['exportMode'];
  videoTrimAvailable: boolean;
  photoshopAvailable: boolean;
  ratingAvailable: boolean;
  rating: number;
  ratingMode: AppConfig['favoriteDisplayMode'];
  ratingLoading: boolean;
  ratingBusy: boolean;
  onChangeRating: (rating: number) => void;
  onTogglePinned: () => void;
  onTechnicalMetadata: (metadata: PreviewTechnicalMetadata) => void;
  onNavigate: (direction: -1 | 1) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onContextMenuAt: (x: number, y: number) => void;
  onAnalyzeImageCrop: (entry: ProjectFileEntry) => Promise<PreviewImageCropAnalysis>;
  onConfirmImageCrop: (entry: ProjectFileEntry, crop: CropRectangle) => Promise<{ success: boolean; error?: string }>;
  onTrimVideo: (start: number, end: number, saveMode: 'new' | 'replace', operationId: string, sourceDuration: number) => Promise<{ success: boolean; started?: boolean; cancelled?: boolean; error?: string }>;
  onLoadVideoTimelineFrames: (times: number[]) => Promise<{ success: boolean; frames?: string[]; error?: string }>;
  onOpen: () => void;
  onOpenInPhotoshop: () => void;
  onClose: () => void;
}) => {
  const { backgroundTasks } = useTaskCenter();
  const backgroundTrimTask = entry?.kind === 'video' ? backgroundTasks.find(task => task.type === 'video-trim'
    && (task.state === 'queued' || task.state === 'running')
    && backgroundTaskPathKey(task.metadata?.sourcePath) === backgroundTaskPathKey(entry.path)) : undefined;
  const [resource, setResource] = useState<{ sourcePath?: string; previewUrl?: string; originalUrl?: string; orientationMatrix?: number[]; orientationSwapsAxes?: boolean }>({});
  const [loading, setLoading] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalLoadError, setOriginalLoadError] = useState('');
  const [videoPlaybackFailed, setVideoPlaybackFailed] = useState(false);
  const [videoPlayerError, setVideoPlayerError] = useState('');
  const [imageZoom, setImageZoom] = useState(1);
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const [imageNaturalSize, setImageNaturalSize] = useState({ width: 0, height: 0 });
  const [imageSurfaceSize, setImageSurfaceSize] = useState({ width: 0, height: 0 });
  const [imageDragging, setImageDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(true);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaybackTime, setVideoPlaybackTime] = useState(0);
  const [videoEditorSeek, setVideoEditorSeek] = useState<{ id: number; time: number; pause?: boolean }>();
  const [videoTrimFrames, setVideoTrimFrames] = useState<string[]>([]);
  const [trimEditor, setTrimEditor] = useState<{ start: number; end: number } | null>(null);
  const [trimBusyMode, setTrimBusyMode] = useState<'new' | 'replace' | ''>('');
  const [trimExportProgress, setTrimExportProgress] = useState<VideoTrimExportProgress>();
  const [trimProgressVisible, setTrimProgressVisible] = useState(false);
  const [imageCropEditor, setImageCropEditor] = useState<{ crop: CropRectangle; snapGuides: { x: number[]; y: number[] }; originalSize: { width: number; height: number } } | null>(null);
  const [imageCropPhase, setImageCropPhase] = useState<'analyzing' | 'editing' | 'saving' | ''>('');
  const [imageCropError, setImageCropError] = useState('');
  // A restored main-process task must suppress the player on the very first
  // render; waiting for the synchronization effect would briefly reopen and
  // lock the source file on Windows before a replace commit.
  const trimBusy = Boolean(trimBusyMode || backgroundTrimTask);
  const imageSurfaceRef = useRef<HTMLDivElement>(null);
  const imageDragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const previewResourcePathRef = useRef('');
  const fullscreenControlsTimerRef = useRef(0);
  const imageCropRequestRef = useRef(0);
  const trimOperationIdRef = useRef('');
  const restoredBackgroundTrimIdRef = useRef('');
  const trimProgressTimerRef = useRef(0);
  const editorSeekIdRef = useRef(0);
  const loadVideoTimelineFramesRef = useRef(onLoadVideoTimelineFrames);
  loadVideoTimelineFramesRef.current = onLoadVideoTimelineFrames;

  useEffect(() => {
    const unsubscribe = projectWorkspaceClient.onProjectVideoTrimProgress(progress => {
      if (!trimOperationIdRef.current || progress.operationId !== trimOperationIdRef.current) return;
      setTrimExportProgress(current => current?.phase === 'cancelling' && progress.phase !== 'cancelled' && progress.phase !== 'failed'
        ? current
        : { phase: progress.phase, progress: progress.progress, message: progress.message });
      if (progress.phase === 'complete' || progress.phase === 'cancelled' || progress.phase === 'failed') {
        window.clearTimeout(trimProgressTimerRef.current);
        trimOperationIdRef.current = '';
        setTrimProgressVisible(false);
        setTrimBusyMode('');
        if (progress.phase === 'complete') setTrimEditor(null);
      }
    });
    return () => {
      window.clearTimeout(trimProgressTimerRef.current);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const nextSourcePath = entry?.path || '';
    const sourceChanged = previewResourcePathRef.current !== nextSourcePath;
    previewResourcePathRef.current = nextSourcePath;
    if (sourceChanged) {
      setVideoPlaybackFailed(false);
      setVideoPlayerError('');
      setImageZoom(1);
      setImagePan({ x: 0, y: 0 });
      setImageNaturalSize({ width: 0, height: 0 });
      setImageDragging(false);
      setVideoDuration(0);
      setVideoPlaybackTime(0);
      setVideoEditorSeek(undefined);
      setVideoTrimFrames([]);
      setTrimEditor(null);
      imageCropRequestRef.current += 1;
      setImageCropEditor(null);
      setImageCropPhase('');
      setImageCropError('');
      imageDragRef.current = null;
    }
    const cachedPreviewUrl = entry ? findCachedMediaThumbnailPreview(entry.path, entry.updatedAt)?.url : undefined;
    setResource(current => entry
      ? current.sourcePath === entry.path
        // File details often hydrate just after selection. Keep an already
        // decoded original visible until its refreshed replacement is ready.
        ? { ...current, previewUrl: current.previewUrl || cachedPreviewUrl || entry.previewUrl }
        : { sourcePath: entry.path, previewUrl: cachedPreviewUrl || entry.previewUrl }
      : {});
    onTechnicalMetadata({});
    if (!entry) return () => { active = false; };
    const unsubscribe = projectWorkspaceClient.onThumbnailStateChanged(update => {
      if (update.filePath.toLocaleLowerCase() !== entry.path.toLocaleLowerCase()) return;
      if (update.state === 'STALE') {
        setLoading(true);
        return;
      }
      if (update.state === 'FAILED' || update.state === 'MISSING') {
        setLoading(false);
        onTechnicalMetadata({ unavailable: true });
        return;
      }
      if (update.state !== 'READY') return;
      const previewUrl = update.previewUrls?.large || update.previewUrls?.medium || update.previewUrls?.small;
      if (previewUrl) {
        rememberMediaThumbnailPreview(mediaThumbnailPreviewKey(entry.path, entry.updatedAt, 1600), previewUrl);
        setResource(current => current.sourcePath === entry.path ? { ...current, previewUrl } : current);
      }
      setLoading(false);
    });
    setLoading(true);
    requestThumbnail(() => projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, 1600, 0, -1))
      .then(result => {
        if (!active) return;
        if (result.success) {
          if (result.previewUrl) rememberMediaThumbnailPreview(mediaThumbnailPreviewKey(entry.path, entry.updatedAt, 1600), result.previewUrl);
          setResource(current => current.sourcePath === entry.path ? { ...current, previewUrl: result.previewUrl || current.previewUrl || entry.previewUrl } : current);
          setLoading(result.state === 'QUEUED' || result.state === 'GENERATING' || result.state === 'NOT_READY' || result.state === 'STALE');
        } else {
          setLoading(false);
          onTechnicalMetadata({ unavailable: true });
        }
      })
      .catch(() => {
        if (!active) return;
        setLoading(false);
        onTechnicalMetadata({ unavailable: true });
      });
    return () => { active = false; unsubscribe(); void projectWorkspaceClient.cancelMediaThumbnail(entry.path, 1600); };
  }, [entry?.path, entry?.updatedAt, cacheConfig.directory, cacheConfig.maxSizeGB]);

  useEffect(() => {
    if (backgroundTrimTask) {
      const start = Math.max(0, Number(backgroundTrimTask.metadata?.start) || 0);
      const end = Math.max(start + .05, Number(backgroundTrimTask.metadata?.end) || start + .05);
      const sourceDuration = Math.max(end, Number(backgroundTrimTask.metadata?.sourceDuration) || end);
      const saveMode = backgroundTrimTask.metadata?.saveMode === 'replace' ? 'replace' : 'new';
      restoredBackgroundTrimIdRef.current = backgroundTrimTask.id;
      trimOperationIdRef.current = backgroundTrimTask.id;
      window.clearTimeout(trimProgressTimerRef.current);
      setVideoDuration(sourceDuration);
      setTrimEditor({ start, end });
      setTrimBusyMode(saveMode);
      setTrimProgressVisible(true);
      setTrimExportProgress({
        phase: String(backgroundTrimTask.metadata?.phase || (backgroundTrimTask.state === 'queued' ? 'preparing' : 'encoding')),
        progress: backgroundTrimTask.progress,
        message: backgroundTrimTask.message || (backgroundTrimTask.state === 'queued' ? '等待后台导出…' : '正在后台导出视频…'),
      });
      return;
    }
    const restoredOperationId = restoredBackgroundTrimIdRef.current;
    if (!restoredOperationId || trimOperationIdRef.current !== restoredOperationId) return;
    restoredBackgroundTrimIdRef.current = '';
    trimOperationIdRef.current = '';
    window.clearTimeout(trimProgressTimerRef.current);
    setTrimProgressVisible(false);
    setTrimExportProgress(undefined);
    setTrimBusyMode('');
  }, [backgroundTrimTask?.id, backgroundTrimTask?.state, backgroundTrimTask?.progress, backgroundTrimTask?.message, backgroundTrimTask?.metadata?.phase]);

  useEffect(() => {
    let active = true;
    let originalImage: HTMLImageElement | undefined;
    setOriginalLoading(false);
    setOriginalLoadError('');
    if (!entry || (entry.kind !== 'image' && entry.kind !== 'raw')) return () => { active = false; };

    // Avoid flashing the toast for images that are already in the OS/browser
    // cache, while keeping it visible for genuinely slow originals.
    const loadingTimer = window.setTimeout(() => {
      if (active) setOriginalLoading(true);
    }, 180);
    projectWorkspaceClient.getMediaOriginal(entry.path, entry.kind, cacheConfig).then(result => {
      if (!active) return;
      if (!result.success || !result.mediaUrl) {
        window.clearTimeout(loadingTimer);
        setOriginalLoading(false);
        setOriginalLoadError(result.error || '原图加载失败，当前显示预览图');
        console.warn('Original image preview failed', result.error || 'unknown error');
        projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'missing_or_unavailable' });
        return;
      }
      originalImage = new Image();
      originalImage.onload = () => {
        if (!active) return;
        window.clearTimeout(loadingTimer);
        setImageNaturalSize({ width: originalImage?.naturalWidth || 0, height: originalImage?.naturalHeight || 0 });
        setResource(current => current.sourcePath === entry.path ? {
          ...current,
          originalUrl: result.mediaUrl,
          orientationMatrix: result.orientation?.matrix,
          orientationSwapsAxes: result.orientation?.swapsAxes
        } : current);
        setOriginalLoading(false);
        setOriginalLoadError('');
      };
      originalImage.onerror = () => {
        if (!active) return;
        window.clearTimeout(loadingTimer);
        setOriginalLoading(false);
        setOriginalLoadError('原图解码失败，当前显示预览图');
        console.warn('Original image decode failed');
        projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'decode_failed' });
      };
      originalImage.src = result.mediaUrl;
    }).catch(error => {
      window.clearTimeout(loadingTimer);
      if (active) {
        setOriginalLoading(false);
        setOriginalLoadError('原图加载失败，当前显示预览图');
        console.warn('Original image preview request failed', error instanceof Error ? error.message : String(error));
        projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'request_failed' });
      }
    });
    return () => {
      active = false;
      window.clearTimeout(loadingTimer);
      if (originalImage) {
        originalImage.onload = null;
        originalImage.onerror = null;
        originalImage.src = '';
      }
    };
  }, [entry?.path, entry?.kind, entry?.updatedAt, cacheConfig.directory, cacheConfig.maxSizeGB]);

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
  }, [displayedImageUrl, entry?.kind, fullscreen, Boolean(imageCropEditor)]);

  useEffect(() => {
    if (!fullscreen) return;
    setFullscreenControlsVisible(true);
    fullscreenControlsTimerRef.current = window.setTimeout(() => setFullscreenControlsVisible(false), FULLSCREEN_CONTROLS_HIDE_DELAY_MS);
    void projectWorkspaceClient.setWindowFullscreen(true);
    return () => {
      window.clearTimeout(fullscreenControlsTimerRef.current);
      void projectWorkspaceClient.setWindowFullscreen(false);
    };
  }, [fullscreen]);
  const revealFullscreenControls = () => {
    if (!fullscreen) return;
    setFullscreenControlsVisible(true);
    window.clearTimeout(fullscreenControlsTimerRef.current);
    fullscreenControlsTimerRef.current = window.setTimeout(() => setFullscreenControlsVisible(false), FULLSCREEN_CONTROLS_HIDE_DELAY_MS);
  };
  const cancelImageCrop = () => {
    if (imageCropPhase === 'saving') return;
    imageCropRequestRef.current += 1;
    setImageCropEditor(null);
    setImageCropPhase('');
    setImageCropError('');
  };
  useEscapeLayer(fullscreen, () => setFullscreen(false));
  useEscapeLayer(Boolean(trimEditor), () => { if (!trimBusy) setTrimEditor(null); }, !trimBusy);
  useEscapeLayer(Boolean(imageCropPhase), cancelImageCrop, imageCropPhase !== 'saving');

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
    // There is intentionally no upper zoom limit. The lower bound preserves
    // the existing "fit to pane" behaviour when scrolling out.
    const nextZoom = Math.max(1, imageZoom * factor);
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
  const beginImageCrop = async () => {
    if (!entry || entry.kind !== 'image' || isUnsupportedShortcutContent(entry) || imageCropPhase) return;
    const requestId = imageCropRequestRef.current + 1;
    imageCropRequestRef.current = requestId;
    setImageCropError('');
    setImageCropEditor(null);
    setImageCropPhase('analyzing');
    const result = await onAnalyzeImageCrop(entry);
    if (imageCropRequestRef.current !== requestId) return;
    if (!result.success || !result.crop || !result.originalSize) {
      setImageCropPhase('');
      setImageCropError(result.error || '无法识别图片边缘');
      return;
    }
    setImageCropEditor({
      crop: result.crop,
      originalSize: result.originalSize,
      snapGuides: result.snapGuides || { x: [0, result.originalSize.width], y: [0, result.originalSize.height] }
    });
    setImageCropPhase('editing');
  };
  const confirmImageCrop = async () => {
    if (!entry || !imageCropEditor || imageCropPhase !== 'editing') return;
    const requestId = imageCropRequestRef.current;
    const { originalSize } = imageCropEditor;
    const x = Math.max(0, Math.min(originalSize.width - 20, Math.round(imageCropEditor.crop.x)));
    const y = Math.max(0, Math.min(originalSize.height - 20, Math.round(imageCropEditor.crop.y)));
    const crop = {
      x,
      y,
      width: Math.max(20, Math.min(originalSize.width - x, Math.round(imageCropEditor.crop.width))),
      height: Math.max(20, Math.min(originalSize.height - y, Math.round(imageCropEditor.crop.height)))
    };
    setImageCropError('');
    setImageCropPhase('saving');
    const result = await onConfirmImageCrop(entry, crop);
    if (imageCropRequestRef.current !== requestId) return;
    if (result.success) {
      setImageCropEditor(null);
      setImageCropPhase('');
      return;
    }
    setImageCropPhase('editing');
    setImageCropError(result.error || '裁剪失败');
  };
  const handleVideoPlayerError = (message: string) => {
    setVideoPlaybackFailed(true);
    setVideoPlayerError(message);
    setLoading(false);
    projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: 'video', reason: 'video_player_failed' });
  };
  const previewVideoTrimTime = (requestedTime: number) => {
    const time = Math.max(0, Math.min(videoDuration, requestedTime));
    setVideoPlaybackTime(time);
    editorSeekIdRef.current += 1;
    setVideoEditorSeek({ id: editorSeekIdRef.current, time, pause: true });
  };
  const changeVideoTrimEdge = (edge: 'start' | 'end', requestedTime: number) => {
    if (!trimEditor || trimBusy) return;
    const time = edge === 'start'
      ? Math.max(0, Math.min(trimEditor.end - .05, requestedTime))
      : Math.min(videoDuration, Math.max(trimEditor.start + .05, requestedTime));
    setTrimEditor(current => current ? { ...current, [edge]: time } : current);
    previewVideoTrimTime(time);
  };
  const openVideoTrim = () => {
    if (!videoDuration) return;
    // Playback commonly reaches the end before the user opens the editor. Using
    // that position as the trim start leaves an almost empty selection and makes
    // both export buttons appear broken. Always open with the complete clip
    // selected; the user can then move either edge deliberately.
    setTrimEditor({ start: 0, end: videoDuration });
    previewVideoTrimTime(0);
  };
  const confirmVideoTrim = async (saveMode: 'new' | 'replace') => {
    if (!trimEditor || trimBusy || trimEditor.end - trimEditor.start < .05) return;
    const operationId = crypto.randomUUID();
    trimOperationIdRef.current = operationId;
    setTrimExportProgress({ phase: 'preparing', progress: 0, message: '正在准备视频…' });
    setTrimProgressVisible(false);
    window.clearTimeout(trimProgressTimerRef.current);
    trimProgressTimerRef.current = window.setTimeout(() => {
      if (trimOperationIdRef.current === operationId) setTrimProgressVisible(true);
    }, 500);
    setTrimBusyMode(saveMode);
    let startedInBackground = false;
    try {
      // Unmount the active video backend before replacing the source so Windows
      // does not keep the original file locked while the atomic rename runs.
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      const result = await onTrimVideo(trimEditor.start, trimEditor.end, saveMode, operationId, videoDuration);
      startedInBackground = Boolean(result.success && result.started);
      if (result.success && !startedInBackground) setTrimEditor(null);
    } finally {
      if (!startedInBackground) {
        window.clearTimeout(trimProgressTimerRef.current);
        trimOperationIdRef.current = '';
        setTrimProgressVisible(false);
        setTrimExportProgress(undefined);
        setTrimBusyMode('');
      }
    }
  };
  const cancelVideoTrim = () => {
    if (!trimBusy) {
      setTrimEditor(null);
      return;
    }
    const operationId = trimOperationIdRef.current;
    if (!operationId || trimExportProgress?.phase === 'cancelling') return;
    setTrimProgressVisible(true);
    setTrimExportProgress(current => ({ phase: 'cancelling', progress: current?.progress || 0, message: '正在取消导出…' }));
    void projectWorkspaceClient.cancelProjectVideoTrim(operationId);
  };
  const useVideoPlayer = Boolean(entry && entry.kind === 'video' && !videoPlaybackFailed);
  // Frame extraction opens a second hidden video element. Stop it together
  // with the visible player so Windows can release the source before replace.
  const trimEditing = Boolean(trimEditor) && !trimBusy;

  useEffect(() => {
    let active = true;
    setVideoTrimFrames([]);
    if (!trimEditing || !videoDuration) return () => { active = false; };
    const times = Array.from({ length: 8 }, (_, index) => Math.min(videoDuration - .01, videoDuration * (index + .5) / 8));
    void loadVideoTimelineFramesRef.current(times).then(result => {
      if (active && result.success && result.frames?.length) setVideoTrimFrames(result.frames);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [trimEditing, videoDuration, entry?.path]);

  const videoTrimControls = trimEditor ? <VideoTrimTimeline
    duration={videoDuration}
    start={trimEditor.start}
    end={trimEditor.end}
    currentTime={videoPlaybackTime}
    frames={videoTrimFrames}
    exportMode={videoTrimExportMode}
    busyMode={trimBusyMode}
    exportProgress={trimExportProgress}
    progressVisible={trimProgressVisible}
    onChange={changeVideoTrimEdge}
    onPreview={previewVideoTrimTime}
    onCancel={cancelVideoTrim}
    onSave={mode => void confirmVideoTrim(mode)}
  /> : undefined;

  const previewPane = <section onContextMenu={onContextMenu} onMouseMove={revealFullscreenControls} style={fullscreen ? undefined : { width }} className={`flex min-h-0 shrink-0 flex-col ${fullscreen ? 'media-preview-fullscreen fixed inset-0 z-[500] h-screen w-screen bg-black' : 'bg-slate-50'}`}>
    {!fullscreen && <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
      <div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">{imageCropPhase ? '裁剪' : trimEditor ? '剪辑' : '预览'}</p><p className="truncate text-sm font-semibold text-slate-700">{entry?.name || '未选择媒体'}</p></div>
      {imageCropPhase ? <div className="ml-2 flex shrink-0 items-center gap-2">
        <button type="button" disabled={imageCropPhase === 'saving'} onClick={cancelImageCrop} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">取消</button>
        <button type="button" disabled={imageCropPhase !== 'editing'} onClick={() => void confirmImageCrop()} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-blue-500 disabled:bg-blue-400">
          {(imageCropPhase === 'analyzing' || imageCropPhase === 'saving') && <Loader2 size={13} className="animate-spin"/>}
          {imageCropPhase === 'analyzing' ? '识别边缘中' : imageCropPhase === 'saving' ? '正在裁剪…' : '确定裁剪'}
        </button>
      </div> : trimEditor ? <button type="button" disabled={trimExportProgress?.phase === 'cancelling'} onClick={cancelVideoTrim} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">{trimBusy ? trimExportProgress?.phase === 'cancelling' ? '正在取消…' : '取消导出' : '取消剪辑'}</button> : <div className="flex items-center gap-1">{entry && <><button type="button" onClick={() => setFullscreen(true)} title="全屏查看" aria-label="全屏查看" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Maximize2 size={16}/></button>{ratingAvailable && (ratingMode === 'stars' ? <div className="flex items-center" aria-label={`图片评分 ${rating} 星`}>{[1, 2, 3, 4, 5].map(star => <button key={star} type="button" disabled={ratingLoading || ratingBusy} onClick={() => onChangeRating(rating === star ? 0 : star)} title={rating === star ? `清除 ${star} 星评分` : `设为 ${star} 星`} aria-label={rating === star ? `清除 ${star} 星评分` : `设为 ${star} 星`} className={`rounded p-1 transition hover:bg-amber-50 hover:text-amber-500 disabled:opacity-40 ${rating >= star ? 'text-amber-400' : 'text-slate-300'}`}><Star size={15} fill={rating >= star ? 'currentColor' : 'none'}/></button>)}</div> : <button type="button" disabled={ratingLoading || ratingBusy} onClick={() => onChangeRating(rating > 0 ? 0 : 5)} title={rating > 0 ? `取消喜欢（当前 ${rating} 星）` : ratingLoading ? '正在读取图片评分' : '喜欢（写入五星）'} aria-label={rating > 0 ? '取消喜欢' : '标记为喜欢'} className={`rounded-md p-2 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 ${rating > 0 ? 'text-red-500' : 'text-slate-500'}`}><Heart size={16} fill={rating > 0 ? 'currentColor' : 'none'}/></button>)}{photoshopAvailable && (entry.kind === 'image' || entry.kind === 'raw') && <button type="button" onClick={onOpenInPhotoshop} title="使用 Photoshop 打开" aria-label="使用 Photoshop 打开" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><PhotoshopIcon size={16}/></button>}{(entry.kind !== 'video' || videoTrimAvailable) && <button type="button" disabled={entry.kind === 'raw' || isUnsupportedShortcutContent(entry) || entry.kind === 'video' && !videoDuration} onClick={entry.kind === 'video' ? openVideoTrim : () => void beginImageCrop()} title={entry.kind === 'video' ? videoDuration ? `剪辑视频（${videoTrimExportMode === 'fast' ? '快速导出' : '精确导出'}）` : '正在读取视频时长' : entry.kind === 'raw' ? 'RAW 暂不支持直接裁剪' : '裁剪图片（识别并磁吸边缘）'} aria-label={entry.kind === 'video' ? '剪辑视频' : '裁剪图片'} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-35"><Crop size={16}/></button>}</>}<button type="button" onClick={onTogglePinned} title={pinned ? '取消固定预览面板' : '固定预览面板'} aria-label={pinned ? '取消固定预览面板' : '固定预览面板'} aria-pressed={pinned} className={`rounded-md p-2 transition hover:bg-blue-50 hover:text-blue-600 ${pinned ? 'bg-blue-50 text-blue-600' : 'text-slate-500'}`}><Pin size={16} fill={pinned ? 'currentColor' : 'none'}/></button><button type="button" onClick={onClose} title="关闭预览" aria-label="关闭预览" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button></div>}
    </header>}
    {fullscreen && fullscreenControlsVisible && <button type="button" onClick={() => setFullscreen(false)} title="退出全屏（Esc）" aria-label="退出全屏" className="fixed right-5 top-5 z-[520] rounded-full bg-black/60 p-2.5 text-white shadow-lg backdrop-blur transition hover:bg-black/80"><X size={20}/></button>}
    <div className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${fullscreen ? 'bg-black' : 'bg-slate-50'}`}>
      {!entry && <div className="max-w-[220px] text-center"><ImageIcon size={38} strokeWidth={1.4} className="mx-auto text-slate-600"/><p className="mt-3 text-sm font-medium text-slate-300">点击图片、RAW 或视频文件</p><p className="mt-1 text-xs leading-5 text-slate-500">此处显示图片或视频预览。</p></div>}
      {entry && entry.kind === 'video' && trimBusy && <div className="absolute inset-0 flex min-h-0 flex-col bg-black"><div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">{resource.previewUrl ? <img src={resource.previewUrl} alt="" draggable={false} className="max-h-full max-w-full object-contain opacity-70"/> : <Video size={52} strokeWidth={1.3} className="text-slate-700"/>}</div>{videoTrimControls}</div>}
      {useVideoPlayer && entry && !trimBusy && <VideoPlayer filePath={entry.path} poster={resource.previewUrl} keyboardSettings={keyboardSettings} bottomControls={trimEditor ? videoTrimControls : undefined} controlsVisible={!fullscreen || fullscreenControlsVisible} controlsOverlay={fullscreen} editorSeekRequest={videoEditorSeek} onPlaybackState={playback => setVideoPlaybackTime(playback.time)} onError={handleVideoPlayerError} onMetadata={metadata => { setLoading(false); setVideoDuration(Number(metadata.duration) || 0); onTechnicalMetadata(metadata); }} onNavigate={onNavigate} onContextMenuAt={onContextMenuAt} onPointerActivity={revealFullscreenControls} topRightOverlayHole={fullscreen && fullscreenControlsVisible ? 60 : 0} onEscape={() => setFullscreen(false)} onToggleFullscreen={() => setFullscreen(current => !current)}/>}
      {entry && entry.kind === 'video' && videoPlaybackFailed && !trimBusy && <div role="alert" className="flex max-h-full w-full flex-col items-center justify-center gap-4 text-center">{resource.previewUrl ? <img src={resource.previewUrl} alt={entry.name} draggable={false} className="max-h-[70%] max-w-full object-contain opacity-60"/> : <Video size={52} strokeWidth={1.3} className="text-slate-600"/>}<div className="max-w-sm px-6"><p className="text-sm font-bold text-red-600">视频播放器无法启动</p><p className="mt-1 text-xs leading-5 text-slate-500">{videoPlayerError || 'Chromium 与高级解码组件均无法播放此视频；请安装或修复高级解码组件。'}</p><button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>使用系统播放器打开</button></div></div>}
      {entry && entry.kind === 'image' && displayedImageUrl && imageCropEditor && <div className="absolute inset-0 bg-slate-950">
        <InteractiveCropEditor embedded snapEnabled snapGuides={imageCropEditor.snapGuides} previewUrl={displayedImageUrl} imageSize={imageCropEditor.originalSize} crop={imageCropEditor.crop} onChange={crop => { if (imageCropPhase === 'editing') setImageCropEditor(current => current ? { ...current, crop } : current); }}/>
        <span className="pointer-events-none absolute bottom-4 left-4 rounded-md bg-slate-950/80 px-2.5 py-1.5 text-[11px] font-bold text-cyan-200 shadow-lg">磁吸边缘已开启</span>
      </div>}
      {entry && entry.kind !== 'video' && displayedImageUrl && !imageCropEditor && (
        <div ref={imageSurfaceRef} onWheel={zoomImage} onDoubleClick={resetImageZoom} onPointerDown={beginImagePan} onPointerMove={moveImagePan} onPointerUp={finishImagePan} onPointerCancel={finishImagePan} style={{ touchAction: 'none' }} className={`absolute inset-0 overflow-hidden ${imageZoom > 1 ? imageDragging ? 'cursor-grabbing' : 'cursor-grab' : ''}`}>
          <div
            style={{
              // Rasterize the image at the requested zoom size. Scaling the
              // fitted wrapper with CSS transform made Chromium enlarge its
              // low-resolution compositor texture, so a full-resolution image
              // still looked like a thumbnail when zoomed in.
              width: fittedImageSize.width ? fittedImageSize.width * imageZoom : '100%',
              height: fittedImageSize.height ? fittedImageSize.height * imageZoom : '100%',
              transform: `translate(-50%, -50%) translate3d(${imagePan.x}px, ${imagePan.y}px, 0)`,
              transformOrigin: 'center',
              willChange: imageDragging ? 'transform' : undefined
            }}
            className="pointer-events-none absolute left-1/2 top-1/2"
          >
            <img
              src={displayedImageUrl}
              alt={entry.name}
              draggable={false}
              style={{
                width: fittedImageElementSize.width ? fittedImageElementSize.width * imageZoom : undefined,
                height: fittedImageElementSize.height ? fittedImageElementSize.height * imageZoom : undefined,
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
      {entry && entry.kind !== 'video' && displayedImageUrl && !imageCropPhase && <button type="button" onClick={resetImageZoom} title="恢复适合窗口" className="absolute bottom-4 right-4 rounded-md bg-slate-900/75 px-2 py-1 font-mono text-[11px] text-slate-200 shadow-lg">{Math.round(imageZoom * 100)}%</button>}
      {entry && entry.kind !== 'video' && !displayedImageUrl && !loading && <div className="text-center"><FileImage size={48} strokeWidth={1.3} className="mx-auto text-slate-600"/><p className="mt-3 text-sm text-slate-400">无法生成此文件的预览</p><button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button></div>}
      {entry && loading && <span className="absolute right-4 top-4 rounded-full bg-slate-900/80 p-2 text-slate-300"><Loader2 size={17} className="animate-spin"/></span>}
      {imageCropPhase === 'analyzing' && <div role="status" className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/35"><span className="inline-flex items-center gap-2 rounded-lg bg-slate-950/85 px-3 py-2 text-xs font-bold text-white shadow-xl"><Loader2 size={15} className="animate-spin text-cyan-300"/>识别边缘中</span></div>}
      {imageCropPhase === 'saving' && <div role="status" className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/35"><span className="inline-flex items-center gap-2 rounded-lg bg-slate-950/85 px-3 py-2 text-xs font-bold text-white shadow-xl"><Loader2 size={15} className="animate-spin text-blue-300"/>正在生成裁剪图片…</span></div>}
      {imageCropError && <div role="alert" className="absolute bottom-4 left-1/2 z-30 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-lg bg-red-950/90 px-3 py-2 text-xs text-red-100 shadow-xl" title={imageCropError}>{imageCropError}</div>}
      {originalLoading && <div role="status" className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg bg-slate-900/85 px-3 py-2 text-xs font-bold text-white shadow-xl"><Loader2 size={15} className="animate-spin text-blue-300"/><span>正在加载原图…</span></div>}
      {!originalLoading && originalLoadError && displayedImageUrl && <div role="status" className="absolute bottom-4 left-1/2 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-lg bg-slate-900/85 px-3 py-2 text-xs text-amber-200 shadow-xl" title={originalLoadError}>{originalLoadError}</div>}
    </div>
  </section>;
  return fullscreen ? createPortal(previewPane, document.body) : previewPane;
};

const FOLDER_COVER_THUMBNAIL_RETRY_DELAYS_MS = [1500, 4000] as const;

const FolderCoverMedia = ({ entry, cacheConfig, requestedSize, queueOrder, pendingRename }: {
  entry: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  requestedSize: number;
  queueOrder: number;
  pendingRename: boolean;
}) => {
  const sourceKey = folderCoverMediaSourceKey(entry, requestedSize);
  const [mediaState, setMediaState] = useState(() => createFolderCoverMediaState(sourceKey, entry.previewUrl));
  const mediaStateRef = useRef(mediaState);
  mediaStateRef.current = mediaState;
  const [retryVersion, setRetryVersion] = useState(0);
  const updateRetryCountRef = useRef(0);
  const updateRetryTimerRef = useRef<number>();
  const requestKey = folderCoverRequestKey(sourceKey, pendingRename, retryVersion);
  const clearScheduledRetry = useCallback(() => {
    if (updateRetryTimerRef.current !== undefined) window.clearTimeout(updateRetryTimerRef.current);
    updateRetryTimerRef.current = undefined;
  }, []);
  const scheduleRetry = useCallback(() => {
    if (mediaStateRef.current.consecutiveLoadFailures >= FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES
      || updateRetryCountRef.current >= FOLDER_COVER_THUMBNAIL_RETRY_DELAYS_MS.length
      || updateRetryTimerRef.current !== undefined) return;
    const attempt = updateRetryCountRef.current;
    updateRetryCountRef.current += 1;
    const retryDelay = pendingRename ? 250 * (attempt + 1) : FOLDER_COVER_THUMBNAIL_RETRY_DELAYS_MS[attempt];
    updateRetryTimerRef.current = window.setTimeout(() => {
      updateRetryTimerRef.current = undefined;
      setRetryVersion(version => version + 1);
    }, retryDelay);
  }, [pendingRename]);
  useThumbnailUpdates(entry.path, requestedSize, (state, nextUrl) => {
    setMediaState(current => reduceFolderCoverMediaState(current, { type: 'THUMBNAIL_UPDATED', state, previewUrl: nextUrl }));
    if (state === 'READY' && nextUrl) {
      clearScheduledRetry();
      updateRetryCountRef.current = 0;
      return;
    }
    if (state === 'STALE') {
      clearScheduledRetry();
      updateRetryCountRef.current = 0;
      setRetryVersion(version => version + 1);
      return;
    }
    if (state === 'NOT_READY' || state === 'QUEUED' || state === 'GENERATING' || state === 'FAILED') scheduleRetry();
  });
  useEffect(() => {
    updateRetryCountRef.current = 0;
    clearScheduledRetry();
    setMediaState(current => reduceFolderCoverMediaState(current, {
      type: 'SOURCE_UPDATED', sourceKey, preserveDisplayed: pendingRename,
    }));
  }, [clearScheduledRetry, sourceKey, pendingRename]);
  useEffect(() => {
    setMediaState(current => reduceFolderCoverMediaState(current, {
      type: 'SOURCE_UPDATED', sourceKey, previewUrl: entry.previewUrl, preserveDisplayed: pendingRename,
    }));
  }, [sourceKey, entry.previewUrl, pendingRename]);
  useEffect(() => () => clearScheduledRetry(), [clearScheduledRetry]);
  useEffect(() => {
    let active = true;
    projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 1, queueOrder)
      .then(result => {
        if (!active) return;
        if (result.previewUrl) {
          clearScheduledRetry();
          updateRetryCountRef.current = 0;
          setMediaState(current => reduceFolderCoverMediaState(current, { type: 'THUMBNAIL_UPDATED', state: 'READY', previewUrl: result.previewUrl }));
          return;
        }
        if (!result.success || result.state === 'NOT_READY' || result.state === 'QUEUED' || result.state === 'GENERATING' || result.state === 'FAILED') scheduleRetry();
      })
      .catch(() => { if (active) scheduleRetry(); });
    return () => { active = false; };
  }, [entry.path, entry.kind, cacheConfig.directory, cacheConfig.maxSizeGB, requestedSize, queueOrder, requestKey, clearScheduledRetry, scheduleRetry]);
  return <>
    {mediaState.displayedUrl
      ? <img key={mediaState.displayedUrl} src={mediaState.displayedUrl} alt="" draggable={false} className="h-full w-full object-cover" onError={() => {
        const failedUrl = mediaState.displayedUrl!;
        const nextFailureCount = mediaState.consecutiveLoadFailures + 1;
        setMediaState(current => reduceFolderCoverMediaState(current, { type: 'DISPLAYED_FAILED', url: failedUrl }));
        if (nextFailureCount < FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES) scheduleRetry();
      }}/>
      : <FileImage size={requestedSize > 160 ? 28 : 14} className="text-slate-400"/>}
    {mediaState.candidateUrl && (
      <img key={mediaState.candidateUrl} src={mediaState.candidateUrl} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full opacity-0" onLoad={() => {
      clearScheduledRetry();
      updateRetryCountRef.current = 0;
      setMediaState(current => reduceFolderCoverMediaState(current, { type: 'CANDIDATE_LOADED', url: mediaState.candidateUrl! }));
    }} onError={() => {
      const failedUrl = mediaState.candidateUrl!;
      const nextFailureCount = mediaState.consecutiveLoadFailures + 1;
      setMediaState(current => reduceFolderCoverMediaState(current, { type: 'CANDIDATE_FAILED', url: failedUrl }));
      if (nextFailureCount < FOLDER_COVER_MAX_CONSECUTIVE_LOAD_FAILURES) scheduleRetry();
    }}/>
    )}
  </>;
};

const FolderCover = ({ entry, cacheConfig, requestedSize, queueOrder, large, loadEntries }: {
  entry: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  requestedSize: number;
  queueOrder: number;
  large: boolean;
  loadEntries: (entry: ProjectFileEntry) => Promise<DirectoryPreviewLoadResult>;
}) => {
  const container = useRef<HTMLSpanElement>(null);
  const [coverEntry, setCoverEntry] = useState<ProjectFileEntry>();
  const pendingRename = Boolean((entry as ProjectFileEntry & { pendingSourceRelativePath?: string }).pendingSourceRelativePath);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      void loadEntries(entry).then(result => {
        if (!active) return;
        setCoverEntry(previous => folderCoverEntryAfterLoad(previous, result.entries, pendingRename || !result.authoritative));
      });
    }, { rootMargin: '180px' });
    observer.observe(node);
    return () => { active = false; observer.disconnect(); };
  }, [entry.path, entry.updatedAt, pendingRename, loadEntries]);

  const isMedia = coverEntry && (coverEntry.kind === 'image' || coverEntry.kind === 'raw' || coverEntry.kind === 'video');
  const iconSize = large ? '100%' : 27;
  return <span ref={container} aria-hidden style={large ? undefined : { width: 27, height: 27 }} className={`relative isolate block shrink-0 text-blue-500 ${large ? 'h-[114%] w-[114%]' : ''}`}>
    <Folder size={iconSize} strokeWidth={1.5} fill="currentColor" className="absolute inset-0"/>
    {coverEntry && <span className="absolute bottom-[20%] left-[11%] right-[11%] top-[31%] z-10 flex items-center justify-center overflow-hidden rounded-[5%] bg-slate-100">
      {isMedia
        ? <FolderCoverMedia entry={coverEntry} cacheConfig={cacheConfig} requestedSize={requestedSize} queueOrder={queueOrder} pendingRename={pendingRename}/>
        : <SystemFileIcon filePath={coverEntry.path} size={large ? 40 : 11}/>}
    </span>}
    {coverEntry && <>
      <span
        className="pointer-events-none absolute bottom-[17%] left-[8.3%] right-[8.3%] z-20 h-[18%] bg-blue-500 shadow-[0_-1px_0_rgba(255,255,255,0.32)]"
        style={{ clipPath: 'polygon(0 18%, 39% 18%, 46% 0, 100% 0, 100% 100%, 0 100%)' }}
      />
      <Folder size={iconSize} strokeWidth={1.5} fill="none" className="pointer-events-none absolute inset-0 z-30"/>
    </>}
  </span>;
};

const ShortcutEntryIcon = ({ entry, cacheConfig, requestedSize, queueOrder, large, loadEntries }: {
  entry: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  requestedSize: number;
  queueOrder: number;
  large: boolean;
  loadEntries: (entry: ProjectFileEntry) => Promise<DirectoryPreviewLoadResult>;
}) => {
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (entry.shortcutTargetKind || entry.shortcutBroken) return;
    const node = container.current;
    if (!node) return;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      void loadEntries(entry);
    }, { rootMargin: '180px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [entry.path, entry.updatedAt, entry.shortcutTargetKind, entry.shortcutBroken, loadEntries]);

  if (entry.shortcutBroken) return <span ref={container} className={`shortcut-folder-cover is-broken ${large ? 'h-full w-full' : ''}`} aria-label="失效的文件夹快捷方式">
    <Folder size={large ? 64 : 30} strokeWidth={1.5} fill="currentColor"/>
    <span className="shortcut-cover-badge is-warning"><AlertTriangle size={large ? 15 : 10}/></span>
  </span>;
  if (entry.shortcutTargetKind === 'folder') return <>
    <FolderCover entry={entry} cacheConfig={cacheConfig} requestedSize={requestedSize} queueOrder={queueOrder} large={large} loadEntries={loadEntries}/>
    <span aria-label="快捷方式" className="shortcut-cover-badge"><ArrowUpRight size={large ? 16 : 10}/></span>
  </>;
  return <span ref={container} className="relative inline-flex"><FolderInput size={large ? 48 : 28} strokeWidth={1.4} className="text-blue-500"/></span>;
};

const systemFileIconCache = new Map<string, Promise<string | undefined>>();
const SystemFileIcon = ({ filePath, size }: { filePath: string; size: number }) => {
  const [dataUrl, setDataUrl] = useState<string>();
  useEffect(() => {
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const extension = fileName.includes('.') ? `.${fileName.split('.').pop()?.toLowerCase()}` : fileName.toLowerCase();
    let request = systemFileIconCache.get(extension);
    if (!request) {
      request = projectWorkspaceClient.getFileIcon(filePath)
        .then(result => result.success ? result.dataUrl : undefined)
        .catch(error => { systemFileIconCache.delete(extension); throw error; });
      if (systemFileIconCache.size >= 128) systemFileIconCache.delete(systemFileIconCache.keys().next().value as string);
      systemFileIconCache.set(extension, request);
    }
    let active = true;
    request.then(icon => { if (active) setDataUrl(icon); }).catch(() => undefined);
    return () => { active = false; };
  }, [filePath]);
  return dataUrl ? <img src={dataUrl} alt="" draggable={false} style={{ width: size, height: size }} className="object-contain"/> : <File size={size} className="text-slate-400"/>;
};
type ProjectWorkspaceProps = Omit<FileBrowserWorkspaceProps, 'browserContext' | 'onDirectoryChange' | 'onOpenToolTab' | 'onCloseToolTab' | 'onNotice'> & {
  pageId: string;
  onDirectoryChange?: (pageId: string, relativePath: string) => void;
  onOpenToolTab?: (pageId: string, kind: 'version', label: string) => void;
  onCloseToolTab?: (pageId: string, kind: 'version') => void;
};
const ProjectWorkspace = ({ pageId, onDirectoryChange, onOpenToolTab, onCloseToolTab, ...props }: ProjectWorkspaceProps) => {
  const toast = useUserFacingToast();
  const onNotice = useCallback((message: string, duration?: number) => { toast.show(message, duration); }, [toast]);
  const bridgeRef = useRef({ onDirectoryChange, onOpenToolTab, onCloseToolTab });
  bridgeRef.current = { onDirectoryChange, onOpenToolTab, onCloseToolTab };
  const browserContext = useMemo(() => ({ ...PROJECT_FILE_BROWSER_CONTEXT, title: props.project.name }), [props.project.name]);
  const handleDirectoryChange = useCallback((relativePath: string) => bridgeRef.current.onDirectoryChange?.(pageId, relativePath), [pageId]);
  const handleOpenToolTab = useCallback((kind: 'version', label: string) => bridgeRef.current.onOpenToolTab?.(pageId, kind, label), [pageId]);
  const handleCloseToolTab = useCallback((kind: 'version') => bridgeRef.current.onCloseToolTab?.(pageId, kind), [pageId]);
  return <FileBrowserWorkspace {...props} pageId={pageId} onDirectoryChange={handleDirectoryChange} onOpenToolTab={handleOpenToolTab} onCloseToolTab={handleCloseToolTab} browserContext={browserContext} onNotice={onNotice}/>;
};

export { FileBrowserWorkspace, ProjectWorkspace };
