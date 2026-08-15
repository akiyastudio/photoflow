import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, FileInput, FolderPlus, Folder, Image as ImageIcon, ScanSearch, GalleryVerticalEnd, Play, Trash2, Edit, X, Plus, Loader2, CheckCircle2, ExternalLink, Video, ChevronDown, ChevronUp, File, FileImage, MemoryStick, LayoutList, Grid2X2, FileText, Copy, Scissors as Cut, ClipboardPaste, CheckSquare, ArrowLeft, ArrowRight, Camera, Aperture, Timer, Gauge, Ruler, Calendar, Activity, Volume2, PanelLeftOpen, ArrowUpDown, ArrowUp, ArrowDown, ArrowUpRight, AlertTriangle, Search, Filter as Funnel, Info, GripVertical, Maximize2, Minimize2, GitBranch, UsersRound, Heart, Star, RefreshCw, Crop, Pin } from 'lucide-react';
import { VersionManager } from '../../components/VersionManager';
import { AdvancedVideoPlayer, videoDirectionalAction, videoDirectionalKeyboardInput } from '../../components/AdvancedVideoPlayer';
import { InteractiveCropEditor } from '../../components/InteractiveCropEditor';
import { ImportSourceControls, type ImportMaterialKind } from '../../components/ImportSourceControls';
import type { CropRectangle } from '../../components/InteractiveCropEditor';
import { ProjectVersionTree, type VersionTreeCanvasController } from '../../components/ProjectVersionTree';
import type { TeamRetouchStep } from '../../components/TeamRetouchSteps';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useEscapeLayer } from '../../components/LayerProvider';
import { ConverterView, ImportCard, MatchView, ResearchView, ScreenshotMainImageView, VideoSplitView, VideoTranscodeView, type ImportCompletion } from '../tools/ToolViews';
import { PROJECT_FILE_BROWSER_CONTEXT } from '../file-browser/browser-context';
import type { FileBrowserContext } from '../file-browser/browser-context';
import { normalizeProjectCategoryOrder, PROJECT_TOOLBAR_ACTION_IDS, projectStatusLabel } from '../../types';
import type { AppConfig, ComponentStatus, MediaMetadataField, ProgressFolder, ProjectFileEntry, ProjectFileListFilter, ProjectFileOperationProgress, ProjectFileSortField, ProjectFilterScope, ProjectToolbarActionId, ShellNewFileType, ThumbnailState, VersionBatchFileOperation, VersionGraphEdge, WorkspaceProject } from '../../types';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../../utils/recycleBinFailure';
import { PanelTaskScope, useTaskCenter } from '../background-tasks/TaskCenter';
import { isPanelTaskRestoreForPage, panelTaskSessionKey, type PanelTaskRestoreDetail } from '../background-tasks/panel-task-session-model';
import { FILE_GRID_GAP, FILE_LIST_HEADER_HEIGHT, FILE_LIST_ROW_HEIGHT, FILE_SURFACE_HORIZONTAL_PADDING, FILE_SURFACE_PADDING, calculateFileGridGeometry, fileSurfaceContentWidth, finiteLogicalCanvasSize, hitMarqueeIndices, mergeMarqueeSelection, normalizeMarqueeRect, rectanglesIntersect, viewportPointToContentPoint, type MarqueeRect } from './marquee-selection-model';
import { advanceMarqueeAutoScroll, marqueeAutoScrollDelta } from './marquee-auto-scroll';
import { converterTriggerAction } from './project-panel-lifecycle';
import { resolveProjectWorkspaceLifecycle, type ProjectWorkspaceLifecycleIdentity } from './project-workspace-lifecycle';
import { applyShortcutPreviewState } from './shortcut-preview-state-model';
import { directoryEntryToSelectOnReturn, fileEntryClickIntent } from './file-entry-interaction-model';
import { FOLDER_ALPHABET_FILTER_THRESHOLD, FOLDER_ALPHABET_KEYS, availableFolderAlphabetKeys, folderAlphabetKey } from './folder-alphabet-filter-model';
import { useRecentFilesAutoLoad } from './useRecentFilesAutoLoad';
import { collectProgressSubtree, inspectProgressRelations } from './progress-tree-model';
import { TrackingConfirmationPanel } from '../versioning/TrackingConfirmationPanel';
import { ProgressPairPreview as SharedProgressPairPreview, type ProgressPairPreviewMode } from '../versioning/ProgressPairPreview';
import { VersionProgressPanel, type VersionProgressDraft } from '../versioning/VersionProgressPanel';
import { defaultMainParentId, defaultWorkflowInputIds, isUserVersionKey, nextVersionKeys, normalizeProgressSetupTrackingPolicy, normalizeTrackingPolicy, progressRelationChangeError, progressTrackingAction, progressTrackingActionLabel, selectableVersionParents, trackingPolicyForRelationChange, trackingStateLabel, versionKeyMatchesParentKind, versionKindForParent, versionTreeNodeBadgeLabel, workflowInputIdsForRelationChange, type VersionRelationKind } from '../versioning/versioning-v2-model';
import { ProgressRelationMutationQueue } from '../versioning/progress-relation-mutation-queue';
import { metadataFieldLabel, metadataGroupLabel } from '../metadata/metadata-labels';
import { metadataGroupDependencyKey, previewMetadataFieldsForEntry, reconcileExpandedMetadataGroups } from '../metadata/metadata-pane-model';
import { projectWorkspaceClient } from '../../platform/project-workspace-client';
import { useProjectFileSelection } from './useProjectFileSelection';
import { installedPluginHasCapability } from '../plugins/plugin-contributions';

const LazyTeamRetouchManager = React.lazy(() => import('../../components/TeamRetouchManager').then(module => ({ default: module.TeamRetouchManager })));
const LazyPersonIdentityManager = React.lazy(() => import('../../components/PersonIdentityManager').then(module => ({ default: module.PersonIdentityManager })));
const TeamFeatureLoading = () => <div role="status" className="flex h-full min-h-48 items-center justify-center text-sm text-slate-500"><Loader2 size={18} className="mr-2 animate-spin"/>正在加载团片协作…</div>;
const TeamRetouchManager = (props: React.ComponentProps<typeof LazyTeamRetouchManager>) => <React.Suspense fallback={<TeamFeatureLoading/>}><LazyTeamRetouchManager {...props}/></React.Suspense>;
const PersonIdentityManager = (props: React.ComponentProps<typeof LazyPersonIdentityManager>) => <React.Suspense fallback={<TeamFeatureLoading/>}><LazyPersonIdentityManager {...props}/></React.Suspense>;

const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
const FILE_VIRTUAL_OVERSCAN_ROWS = 10;
const RECENT_FILES_PAGE_SIZE = 240;
const RECENT_FILES_LOAD_AHEAD_PX = 900;
const RECENT_FILES_SESSION_EXPIRED = 'RECENT_FILES_SESSION_EXPIRED';
const FILE_LIST_PAGE_SIZE = 200;
const FILE_LIST_SESSION_EXPIRED = 'FILE_LIST_SESSION_EXPIRED';
const FILE_LIST_CANCELLED = 'FILE_LIST_CANCELLED';
const OFFICE_OPEN_XML_EXTENSIONS = new Set([
  '.docx', '.docm', '.dotx', '.dotm',
  '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam',
  '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlam', '.xlsb',
]);
const isOfficeOpenXmlEntry = (entry: ProjectFileEntry) => entry.kind === 'file' && OFFICE_OPEN_XML_EXTENSIONS.has(entry.extension.toLocaleLowerCase());
const SCREENSHOT_MAIN_IMAGE_EXTENSIONS = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
const isScreenshotMainImageEntry = (entry: ProjectFileEntry) => entry.kind === 'image' && SCREENSHOT_MAIN_IMAGE_EXTENSIONS.has(entry.extension.toLocaleLowerCase());
const PHOTOSHOP_DOCUMENT_EXTENSIONS = new Set(['.psd', '.psb']);
const isPhotoshopOpenEntry = (entry: ProjectFileEntry) => entry.kind === 'image'
  || entry.kind === 'raw'
  || entry.kind === 'file' && PHOTOSHOP_DOCUMENT_EXTENSIONS.has(entry.extension.toLocaleLowerCase());

type PreviewImageCropAnalysis = {
  success: boolean;
  crop?: CropRectangle;
  snapGuides?: { x: number[]; y: number[] };
  originalSize?: { width: number; height: number };
  error?: string;
};

const PhotoshopIcon = ({ size = 16 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 18 18" className="shrink-0">
    <rect x="0.75" y="0.75" width="16.5" height="16.5" rx="3" fill="#001E36" stroke="#31A8FF" strokeWidth="1.5"/>
    <text x="3.2" y="12.4" fill="#31A8FF" fontFamily="Arial, sans-serif" fontSize="9.2" fontWeight="700">Ps</text>
  </svg>
);

const ViewportContextMenu = ({ x, y, widthClass, allowSubmenus = false, children }: { x: number; y: number; widthClass: string; allowSubmenus?: boolean; children: React.ReactNode }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  const updatePosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const availableHeight = Math.max(0, window.innerHeight - CONTEXT_MENU_VIEWPORT_MARGIN * 2);
    const width = menu.getBoundingClientRect().width;
    const height = Math.min(menu.scrollHeight, availableHeight);
    const left = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - CONTEXT_MENU_VIEWPORT_MARGIN));
    const top = Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(y, window.innerHeight - height - CONTEXT_MENU_VIEWPORT_MARGIN));
    setPosition(current => current.left === left && current.top === top && current.ready ? current : { left, top, ready: true });
  }, [x, y]);

  useLayoutEffect(() => {
    updatePosition();
    const menu = menuRef.current;
    const resizeObserver = menu && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updatePosition) : null;
    if (menu) resizeObserver?.observe(menu);
    window.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('resize', updatePosition);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('resize', updatePosition);
    };
  }, [updatePosition]);

  return <div ref={menuRef} role="menu" className={`project-context-menu fixed z-[301] max-w-[calc(100vw-1rem)] rounded-lg border border-slate-200 bg-white p-1 shadow-xl ${allowSubmenus ? 'overflow-visible' : 'max-h-[calc(100vh-1rem)] overflow-y-auto overscroll-contain'} ${widthClass}`} style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }} onClick={event => event.stopPropagation()}>{children}</div>;
};

const TOOL_MODAL_DETAILS: Record<string, { description: string; icon: React.ReactNode }> = {
  import: { description: '分析 SD 卡素材并导入当前项目。', icon: <MemoryStick size={18}/> },
  'negative-import': { description: '从文件或文件夹导入并登记原始素材。', icon: <Aperture size={18}/> },
  broll: { description: '批量导入图片与视频花絮。', icon: <FolderInput size={18}/> },
  'file-import': { description: '从当前文件夹或右键菜单进入，目标目录已确定。', icon: <FileInput size={18}/> },
  match: { description: '按完整文件名预检，确认后再复制。', icon: <FileText size={18}/> },
  research: { description: '识别视频转场并挑选清晰画面。', icon: <Video size={18}/> },
  'video-transcode': { description: '转换视频封装、编码、画质与音频。', icon: <Gauge size={18}/> },
  'video-split': { description: '批量将视频无损切成约 3.95 GB 的连续分段。', icon: <Cut size={18}/> },
  converter: { description: '批量将 PNG 转换为 JPG。', icon: <ImageIcon size={18}/> },
  'screenshot-main-image': { description: '先分析候选范围，确认后再生成主图。', icon: <Crop size={18}/> },
  'office-extract': { description: '提取 Word、PowerPoint 或 Excel 中的图片。', icon: <FileImage size={18}/> },
  trash: { description: '将整个项目及其内容移入系统回收站。', icon: <Trash2 size={18}/> },
  'version-create': { description: '创建可跟踪的图片或视频版本节点。', icon: <FolderPlus size={18}/> },
  'version-create-next': { description: '从当前版本创建下一版本或可跟踪分支。', icon: <ArrowRight size={18}/> },
  'version-import': { description: '将已有项目文件夹登记为可跟踪版本。', icon: <FolderInput size={18}/> },
  'version-modify': { description: '修改版本信息与跟踪策略。', icon: <GitBranch size={18}/> },
};

const ToolModal = ({ title, ownerPageId, panelKind, open, busy = false, onClose, children }: { title: string; ownerPageId: string; panelKind: string; open: boolean; busy?: boolean; onClose: () => void; children: React.ReactNode }) => {
  const { panelTasks, reportPanelTask, dismissPanelTask } = useTaskCenter();
  const taskKey = panelTaskSessionKey(ownerPageId, panelKind);
  const task = panelTasks[taskKey];
  const manualBusyRef = useRef(false);
  const effectiveBusy = busy || task?.state === 'running';
  useEscapeLayer(open, onClose, true);

  const reportBusyAsPanelTask = !panelKind.startsWith('version-');
  useEffect(() => {
    if (busy && reportBusyAsPanelTask) {
      manualBusyRef.current = true;
      if (task?.state !== 'running') reportPanelTask({ key: taskKey, ownerPageId, panelKind, title }, { state: 'running', progress: task?.progress || 0, message: task?.message || '任务正在运行…', logs: task?.logs || [] });
    } else if (manualBusyRef.current) {
      manualBusyRef.current = false;
      dismissPanelTask(taskKey);
    }
  }, [busy, dismissPanelTask, ownerPageId, panelKind, reportBusyAsPanelTask, reportPanelTask, task, taskKey, title]);

  const detail = TOOL_MODAL_DETAILS[panelKind];
  return createPortal(<div aria-hidden={!open} className={open ? 'tool-panel-backdrop fixed inset-x-0 bottom-0 top-10 z-[360] flex items-center justify-center p-4' : 'hidden'} onMouseDown={event => { if (event.target === event.currentTarget && !effectiveBusy) onClose(); }}><PanelTaskScope ownerPageId={ownerPageId} panelKind={panelKind} title={title}><section role="dialog" aria-modal="true" aria-label={title} className="tool-panel-window flex max-h-[90vh] w-full max-w-[960px] flex-col overflow-hidden border bg-white"><header className="tool-panel-header flex shrink-0 items-center gap-3 border-b border-slate-200 px-5"><span className="tool-panel-title-icon flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">{detail?.icon}</span><div className="min-w-0 flex-1"><h3 className="truncate text-[15px] font-bold text-slate-800">{title}</h3>{detail?.description && <p className="mt-0.5 truncate text-[10px] text-slate-400">{detail.description}</p>}</div><button type="button" onClick={onClose} aria-label={effectiveBusy ? '收起到后台' : '关闭'} title={effectiveBusy ? '收起到后台，任务会继续运行' : '关闭'} className={`rounded-md text-slate-500 hover:bg-slate-100 ${effectiveBusy ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold' : 'p-1.5'}`}>{effectiveBusy ? <><Minimize2 size={15}/>收起到后台</> : <X size={18}/>}</button></header><div className="tool-panel-body min-h-0 flex-1 overflow-y-auto p-[22px]">{children}</div></section></PanelTaskScope></div>, document.body);
};

const ImportCompletion = ({ message, onClose }: { message: string; onClose: () => void }) => (
  <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50/70 px-6 py-10 text-center">
    <CheckCircle2 size={42} className="text-emerald-600" />
    <p className="mt-4 text-lg font-bold text-slate-800">导入完成</p>
    <p className="mt-2 text-sm text-slate-600">{message}</p>
    <button type="button" onClick={onClose} className="dialog-primary mt-6">关闭</button>
  </div>
);

// Source decoding is scheduled in the Electron main process. Renderer calls
// only probe the memory/disk layers and enqueue or reprioritize a task.
const requestThumbnail = <T,>(task: () => Promise<T>) => task();
const thumbnailSizeLabel = (requestedSize: number) => requestedSize <= 320 ? 'small' : requestedSize <= 640 ? 'medium' : 'large';
const mediaThumbnailPreviewCache = new Map<string, string>();
const mediaThumbnailPreviewKey = (filePath: string, updatedAt: number, requestedSize: number) => `${filePath.toLocaleLowerCase()}|${updatedAt}|${requestedSize}`;
const forgetMediaThumbnailPreviews = (filePath: string) => {
  const prefix = `${filePath.toLocaleLowerCase()}|`;
  for (const key of mediaThumbnailPreviewCache.keys()) if (key.startsWith(prefix)) mediaThumbnailPreviewCache.delete(key);
};
const rememberMediaThumbnailPreview = (key: string, url: string) => {
  if (mediaThumbnailPreviewCache.size >= 2000 && !mediaThumbnailPreviewCache.has(key)) {
    mediaThumbnailPreviewCache.delete(mediaThumbnailPreviewCache.keys().next().value as string);
  }
  mediaThumbnailPreviewCache.set(key, url);
};
const findCachedMediaThumbnailPreview = (filePath: string, updatedAt: number) => {
  const prefix = `${filePath.toLocaleLowerCase()}|${updatedAt}|`;
  const matches = [...mediaThumbnailPreviewCache.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, url]) => ({ url, size: Number(key.slice(prefix.length)) || 0 }))
    .sort((left, right) => right.size - left.size);
  return matches[0];
};

const useThumbnailUpdates = (
  filePath: string,
  requestedSize: number,
  onUpdate: (state: ThumbnailState, url?: string) => void,
) => {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const sizeLabel = thumbnailSizeLabel(requestedSize);
  useEffect(() => projectWorkspaceClient.onThumbnailStateChanged(update => {
    if (update.filePath.toLocaleLowerCase() !== filePath.toLocaleLowerCase()) return;
    onUpdateRef.current(update.state, update.previewUrls?.[sizeLabel]);
  }), [filePath, sizeLabel]);
};
const METADATA_GROUP_PRIORITY = ['ExifIFD', 'ExifIFD1', 'IFD0', 'Composite', 'QuickTime', 'Track1', 'XMP', 'File', 'System', '其他'];
const pickMetadataValue = (fields: readonly MediaMetadataField[], ...names: string[]) => {
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
const formatCaptureDate = (value?: string) => {
  const source = value?.trim();
  if (!source) return undefined;
  const parts = source.match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (parts) {
    const [, yearText, monthText, dayText, hourText = '00', minuteText = '00', secondText = '00'] = parts;
    const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
    const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
    const maximumDay = year > 0 && month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > maximumDay || hour > 23 || minute > 59 || second > 59) return undefined;
  }
  return source.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(/([+-]\d{2}):?(\d{2})$/, ' $1:$2');
};
const pickCaptureDate = (fields: readonly MediaMetadataField[], ...names: string[]) => {
  for (const name of names) {
    const formatted = formatCaptureDate(pickMetadataValue(fields, name));
    if (formatted) return formatted;
  }
  return undefined;
};
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
  const request = projectWorkspaceClient.getMediaMetadata(entry.path).then(result => {
    if (!result.success) return undefined;
    return pickCaptureDate(result.fields, 'DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate', 'CreationDate', 'FileModifyDate');
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
const readStoredBoolean = (key: string, fallback: boolean) => {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
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

type CompareMatch = { source: string; reference: string; target: string; confidence: string; distance: number };

type ProjectPanel = 'import' | 'negative-import' | 'broll' | 'file-import' | 'match' | 'research' | 'video-transcode' | 'video-split' | 'converter' | 'screenshot-main-image' | 'office-extract' | 'trash' | null;
type MountedProjectPanel = Exclude<ProjectPanel, null>;
const PROJECT_PANEL_TITLES: Record<MountedProjectPanel, string> = {
  import: '从 SD 卡导入',
  'negative-import': '导入 · 原始素材',
  broll: '导入 · 花絮',
  'file-import': '导入 · 其他文件',
  match: '从文件名选片',
  research: '截取分镜帧',
  'video-transcode': '视频转码',
  'video-split': '视频切割',
  converter: 'PNG 转 JPG',
  'screenshot-main-image': '提取截图主图',
  'office-extract': '提取文档图片',
  trash: '移入回收站',
};
type ProjectBrowseMode = 'recent' | 'grid' | 'list' | 'version-tree';
const isProjectBrowseMode = (value: unknown): value is ProjectBrowseMode => value === 'recent' || value === 'grid' || value === 'list' || value === 'version-tree';
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
const projectRelativeParentPath = (value: string) => normalizeProjectRelativePath(value).split('/').slice(0, -1).join('/');
const PROTECTED_PROJECT_FOLDER_NAMES = new Set(['raw', 'jpg', 'mov', 'mov_预览', '策划', '团片协作']);
const PROGRESS_FOLDER_NAME_PATTERN = /^(?:图片后期|视频后期)_\d+(?:_\d+)*(?:_.+)?$/u;
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
  activeView: 'project' | 'version' | 'team';
  project: WorkspaceProject;
  workspacePath: string;
  inspirationTargetWorkspacePath?: string;
  inspirationLibraryRootPath?: string;
  installedComponentIds: ReadonlySet<string>;
  componentsLoading: boolean;
  teamRetouchStatus?: ComponentStatus;
  advancedVideoSettings: NonNullable<AppConfig['componentSettings']['video-playback-mpv']>;
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
  favoriteDisplayMode?: AppConfig['favoriteDisplayMode'];
  browserContext: FileBrowserContext;
  navigationRequest?: { path: string; id: number };
  onDirectoryChange?: (relativePath: string) => void;
  onOpenInspirationPath?: (relativePath: string) => void;
  onOpenDirectoryPage?: (relativePath: string) => void;
  onOpenToolTab?: (kind: 'version' | 'team', label: string) => void;
  onCloseToolTab?: (kind: 'version' | 'team') => void;
  onToolTabBusyChange?: (kind: 'version' | 'team', busy: boolean) => void;
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onMatchConfigChange: (config: AppConfig['smartMatch']) => void;
  onResearchConfigChange: (config: AppConfig['research']) => void;
  onNotice: (message: string, duration?: number) => void | (() => void);
  onProjectMoved?: (project: WorkspaceProject) => void;
  onDeleted?: () => void;
};

const isFolderLikeEntry = (entry: ProjectFileEntry) => entry.kind === 'folder' || entry.externalLink === true && entry.externalLinkTargetKind !== 'file';
const isUnsupportedShortcutContent = (entry: ProjectFileEntry) => entry.viaShortcut === true && entry.viaExternalLink !== true;
const backgroundTaskPathKey = (value: unknown) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
const handledVideoTrimTaskIds = new Set<string>();

const FileBrowserWorkspace = ({ pageId, active, activeView, project, workspacePath, inspirationTargetWorkspacePath, inspirationLibraryRootPath, installedComponentIds, componentsLoading, teamRetouchStatus, advancedVideoSettings, projectToolbar = { order: [...PROJECT_TOOLBAR_ACTION_IDS], hidden: [], onlyShowAvailable: false }, customProjectCategories = [], projectCategoryOrder = [], progressNamePresets = [], initialPanel, initialRelativePath = '', importConfig, importDefaults, brollConfig, videoTools, matchConfig, researchConfig, mediaCacheConfig, defaultFolderSort, itemOpenMode, folderAlphabetFilterEnabled = true, favoriteDisplayMode = 'binary', browserContext, navigationRequest, onDirectoryChange, onOpenInspirationPath, onOpenDirectoryPage, onOpenToolTab = () => undefined, onCloseToolTab = () => undefined, onToolTabBusyChange = () => undefined, onImportConfigChange, onMatchConfigChange, onResearchConfigChange, onNotice, onProjectMoved = () => undefined, onDeleted = () => undefined }: FileBrowserWorkspaceProps) => {
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
  const relationMutationQueueRef = useRef(new ProgressRelationMutationQueue());
  const relationMutationCountsRef = useRef(new Map<string, number>());
  const detachedProgressCleanupIdsRef = useRef(new Set<string>());
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
  const progressRelationNoticeRef = useRef('');
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
  const [fileEntries, setFileEntries] = useState<ProjectFileEntry[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(active);
  const [currentDirectoryViaExternalLink, setCurrentDirectoryViaExternalLink] = useState(false);
  const [virtualWindow, setVirtualWindow] = useState({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 });
  const virtualWindowRef = useRef(virtualWindow);
  virtualWindowRef.current = virtualWindow;
  const [currentRelativePath, setCurrentRelativePath] = useState(initialRelativePath);
  const [directoryHistory, setDirectoryHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const [browseMode, setBrowseMode] = useState<ProjectBrowseMode>('grid');
  const viewMode: 'list' | 'grid' = browseMode === 'list' ? 'list' : 'grid';
  const recursiveFlatOpen = browseMode === 'recent';
  const versionTreeOpen = browseMode === 'version-tree';
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
  const [sortField, setSortField] = useState<ProjectFileSortField>(defaultFolderSort);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(defaultFolderSort === 'name' ? 'asc' : 'desc');
  useEffect(() => {
    setSortField(defaultFolderSort);
    setSortDirection(defaultFolderSort === 'name' ? 'asc' : 'desc');
  }, [defaultFolderSort]);
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
  const pendingDirectoryReturnSelectionRef = useRef<{ directoryPath: string; entryPath: string } | null>(null);
  const didInitializePathRefreshRef = useRef(false);
  const wasActiveRef = useRef(active);
  const skipNextPathRefreshRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const currentRelativePathRef = useRef('');
  const onDirectoryChangeRef = useRef(onDirectoryChange);
  onDirectoryChangeRef.current = onDirectoryChange;
  const projectPathRef = useRef(project.path);
  const projectLifecycleRef = useRef<ProjectWorkspaceLifecycleIdentity>();
  const directoryEntriesCacheRef = useRef(new Map<string, ProjectFileEntry[]>());
  const directoryPrefetchesRef = useRef(new Map<string, Promise<ProjectFileEntry[]>>());
  const shortcutPreviewStatesRef = useRef(new Map<string, Pick<ProjectFileEntry, 'shortcutTargetKind' | 'shortcutBroken'>>());
  const previewRatingCacheRef = useRef(new Map<string, number>());
  const previewRatingRequestsRef = useRef(new Map<string, ReturnType<typeof projectWorkspaceClient.getMediaRating>>());
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
    clearPreviewOnFinish: boolean;
  } | null>(null);
  const marqueeLayoutRegistryRef = useRef(new Map<string, MarqueeRect>());
  const selectionAutoScrollFrameRef = useRef(0);
  const directoryRefreshTimerRef = useRef(0);
  const pendingDirectoryRefreshesRef = useRef(new Set<string>());
  const internalDragPathsRef = useRef<string[]>([]);
  const internalDropHandledRef = useRef(false);
  const renameCommitRef = useRef(false);
  const selectionResetKey = `${active}|${fileFilter}|${ratingFilter}|${filterScope}|${searchQuery}`;
  const { anchorPathRef: selectionAnchorPathRef, selectedPaths, setSelectedPaths, selectRange: selectProjectFileRange, toggle: toggleSelected } = useProjectFileSelection(selectionResetKey);
  const entryPointerModifiersRef = useRef<{ path: string; additive: boolean; range: boolean } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchSequenceRef = useRef(0);
  const recentLoadInFlightRef = useRef(false);
  const scopeCursorRef = useRef('');
  const scopeLoadInFlightRef = useRef(false);
  const scopeRequestSequenceRef = useRef(0);
  const recursiveDirectoryRefreshSequenceRef = useRef(new Map<string, number>());
  const clipboardOperationSequenceRef = useRef(0);
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const [dragTargetPath, setDragTargetPath] = useState('');
  const [recursiveDropTargetPath, setRecursiveDropTargetPath] = useState<string | null>(null);
  const [surfaceDropActive, setSurfaceDropActive] = useState(false);
  const [operationDirectoryPath, setOperationDirectoryPath] = useState('');
  const [previewPath, setPreviewPath] = useState('');
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
  const [researchTargetKind, setResearchTargetKind] = useState<'file' | 'folder'>('file');
  const [researchTargetHasTxt, setResearchTargetHasTxt] = useState(false);
  const [videoTranscodeTargets, setVideoTranscodeTargets] = useState<string[]>([]);
  const [videoTranscodeSourceFolders, setVideoTranscodeSourceFolders] = useState<string[]>([]);
  const [videoTranscodeCollecting, setVideoTranscodeCollecting] = useState(false);
  const [videoSplitTargets, setVideoSplitTargets] = useState<string[]>([]);
  const [officeExtractEntries, setOfficeExtractEntries] = useState<ProjectFileEntry[]>([]);
  const [officeExtractBusy, setOfficeExtractBusy] = useState(false);
  const [officeExtractResult, setOfficeExtractResult] = useState<{ documents: number; images: number; failed: number; outputFolders: string[] } | null>(null);
  const videoTranscodeInspectionSequenceRef = useRef(0);
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
  const projectPanelIsRunning = useCallback((kind: MountedProjectPanel) => projectPanelTask(kind)?.state === 'running', [projectPanelTask]);
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
  const [progressImportStep, setProgressImportStep] = useState<'source' | 'settings'>('source');
  const [pendingProgressFolders, setPendingProgressFolders] = useState<Array<{ relativePath: string; name: string; mediaKind: 'image' | 'video' }>>([]);
  const [progressImportCompletion, setProgressImportCompletion] = useState('');
  const [progressCompare, setProgressCompare] = useState<ProgressCompareConfirmation | null>(null);
  const [trackingConfirmationSessionId, setTrackingConfirmationSessionId] = useState('');
  const [trackingConfirmationProgressId, setTrackingConfirmationProgressId] = useState('');
  const [progressCompareFilter, setProgressCompareFilter] = useState<ProgressCompareFilter>('recognized');
  const [activeProgressCompareItemKey, setActiveProgressCompareItemKey] = useState('');
  const [progressTask, setProgressTask] = useState('');
  const [progressSubmitting, setProgressSubmitting] = useState(false);
  const [progressImportStatus, setProgressImportStatus] = useState<ProjectFileOperationProgress | null>(null);
  const progressSubmittingRef = useRef(false);
  const progressImportOperationIdRef = useRef('');
  const [progressRepair, setProgressRepair] = useState<{ progressFolder: ProgressFolder; batchId: string; operations: VersionBatchFileOperation[] } | null>(null);
  const [progressRepairBusy, setProgressRepairBusy] = useState(false);
  const closeProgressSetup = useCallback(() => {
    setProgressImportCompletion('');
    setProgressImportStep('source');
    setProgressSetup(null);
  }, []);
  useEscapeLayer(Boolean(progressCompare), () => { void closeProgressCompare(); }, !progressSubmitting);
  useEscapeLayer(Boolean(progressRepair), () => setProgressRepair(null), !progressRepairBusy);
  useEscapeLayer(Boolean(pendingProgressFolders.length) && !progressSetup, () => setPendingProgressFolders([]));
  useEscapeLayer(Boolean(draggingChildId || pendingRelationChange), cancelRelationEdit);
  useEscapeLayer(batchRenameOpen, () => { if (!renameCommitRef.current) setBatchRenameOpen(false); });
  useEscapeLayer(confirmDelete, () => setConfirmDelete(false));
  useEscapeLayer(Boolean(gatherPickerPaths), () => setGatherPickerPaths(null), !gatheringInspiration);
  const [fileMenu, setFileMenu] = useState<{ entry: ProjectFileEntry; x: number; y: number } | null>(null);
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
  const [teamRetouchEntries, setTeamRetouchEntries] = useState<ProjectFileEntry[]>([]);
  const [teamRetouchHistory, setTeamRetouchHistory] = useState<ProjectFileEntry[]>([]);
  const [teamRetouchStep, setTeamRetouchStep] = useState<TeamRetouchStep | null>(null);
  const [teamRetouchOpening, setTeamRetouchOpening] = useState(false);
  const teamRetouchHistoryRequestRef = useRef<Promise<ProjectFileEntry[]> | null>(null);
  const teamRetouchWorkflowGeneratedRef = useRef(false);
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
    if (!projectWorkflows) return;
    const storageKey = `photoflow:imported-project-tracking:${project.path}`;
    try {
      const candidates = JSON.parse(window.localStorage.getItem(storageKey) || '[]') as Array<{ relativePath?: string; name?: string; mediaKind?: 'image' | 'video' }>;
      window.localStorage.removeItem(storageKey);
      const folders = candidates.flatMap(candidate => candidate.relativePath && candidate.name
        ? [{ relativePath: normalizeProjectRelativePath(candidate.relativePath), name: candidate.name, mediaKind: candidate.mediaKind === 'video' ? 'video' as const : 'image' as const }]
        : []);
      if (folders.length) setPendingProgressFolders(folders);
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [project.path, projectWorkflows]);
  const officeImageExtractorAvailable = true;
  const teamRetouchInstalled = installedPluginHasCapability(installedComponentIds, 'team-retouch.workspace');
  const teamRetouchAvailable = teamRetouchInstalled || componentsLoading;
  const folderBrowseModeStorageKey = `photoflow:folder-browse-modes:${browserContext.kind}:${workspacePath}|${project.name}`;
  const folderGridIconSizeStorageKey = `photoflow:folder-grid-icon-sizes:${browserContext.kind}:${workspacePath}|${project.name}`;
  const readFolderBrowseModes = (): Record<string, ProjectBrowseMode> => {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(folderBrowseModeStorageKey) || '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ProjectBrowseMode] => isProjectBrowseMode(entry[1])));
    } catch {
      return {};
    }
  };
  const storedFolderBrowseMode = (relativePath: string) => readFolderBrowseModes()[normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN')];
  const rememberFolderBrowseMode = (relativePath: string, mode: ProjectBrowseMode) => {
    const normalizedPath = normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN');
    try {
      window.sessionStorage.setItem(folderBrowseModeStorageKey, JSON.stringify({ ...readFolderBrowseModes(), [normalizedPath]: mode }));
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
    const normalizedRoot = project.path.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedFolder = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '');
    const relativePath = normalizedFolder.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)
      ? normalizedFolder.slice(normalizedRoot.length + 1)
      : normalizedFolder.split('/').pop() || '';
    return normalizeProjectRelativePath(relativePath).split('/').slice(0, -1).join('/').toLocaleLowerCase('zh-CN');
  };
  const hasVersionTreeFor = (foldersToCheck = progressFolders, relativePath = currentRelativePath) => {
    const scopePath = normalizeProjectRelativePath(relativePath).toLocaleLowerCase('zh-CN');
    return projectWorkflows && foldersToCheck.some(folder => !folder.folderMissing && progressFolderParentPath(folder) === scopePath);
  };
  const versionTreeModeAvailableFor = (foldersToCheck = progressFolders, relativePath = currentRelativePath) => {
    const scopePath = normalizeProjectRelativePath(relativePath);
    return projectWorkflows && (!scopePath || hasVersionTreeFor(foldersToCheck, scopePath));
  };
  const browseModeForFolder = (relativePath: string, foldersToCheck = progressFolders): ProjectBrowseMode => {
    const normalizedPath = normalizeProjectRelativePath(relativePath);
    const remembered = storedFolderBrowseMode(normalizedPath);
    if (remembered === 'version-tree' && !versionTreeModeAvailableFor(foldersToCheck, normalizedPath)) return 'grid';
    if (remembered) return remembered;
    return hasVersionTreeFor(foldersToCheck, normalizedPath) ? 'version-tree' : 'grid';
  };
  const selectFolderBrowseMode = (mode: ProjectBrowseMode) => {
    if (mode === 'version-tree' && !versionTreeModeAvailableFor()) return;
    rememberFolderBrowseMode(currentRelativePath, mode);
    setBrowseMode(mode);
  };
  const projectVersionTreeAvailable = versionTreeModeAvailableFor();

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

  const loadTeamRetouchHistory = useCallback((): Promise<ProjectFileEntry[]> => {
    if (!projectWorkflows || !teamRetouchAvailable) {
      setTeamRetouchHistory([]);
      teamRetouchWorkflowGeneratedRef.current = false;
      return Promise.resolve([]);
    }
    if (teamRetouchHistoryRequestRef.current) return teamRetouchHistoryRequestRef.current;
    const request: Promise<ProjectFileEntry[]> = projectWorkspaceClient.getTeamProjectWorkspace(workspacePath, project.name, project.status).then(result => {
      if (!result.success) throw new Error(result.error || '无法读取团片协作记录');
      if (result.workflowNodeCreated && result.workflowNode) {
        setProgressFolders(current => {
          const next = current.some(folder => folder.id === result.workflowNode!.id) ? current : [...current, result.workflowNode!];
          progressFoldersRef.current = next;
          return next;
        });
      }
      teamRetouchWorkflowGeneratedRef.current = Boolean(result.workflowGenerated);
      const entries = result.photos.map(photo => {
        const name = photo.sourcePath.split(/[\\/]/).pop() || photo.name;
        const extension = name.includes('.') ? `.${name.split('.').pop()}`.toLocaleLowerCase() : '';
        return { name, path: photo.sourcePath, relativePath: photo.relativePath, kind: 'image' as const, extension, size: -1, createdAt: 0, updatedAt: Math.max(0, ...photo.tasks.map(task => task.updatedAt || 0)) };
      });
      setTeamRetouchHistory(entries);
      return entries;
    }).finally(() => {
      if (teamRetouchHistoryRequestRef.current === request) teamRetouchHistoryRequestRef.current = null;
    });
    teamRetouchHistoryRequestRef.current = request;
    return request;
  }, [projectWorkflows, teamRetouchAvailable, workspacePath, project.name, project.status]);

  useEffect(() => {
    const items = progressCompare ? buildProgressCompareListItems(progressCompare, progressCompareFilter) : [];
    if (!items.length) {
      setActiveProgressCompareItemKey('');
      return;
    }
    setActiveProgressCompareItemKey(current => items.some(item => item.key === current) ? current : items[0].key);
  }, [progressCompare, progressCompareFilter]);

  useEffect(() => {
    if (!teamRetouchAvailable) { setTeamRetouchEntries([]); setTeamRetouchStep(null); teamRetouchWorkflowGeneratedRef.current = false; }
    void loadTeamRetouchHistory().catch(() => undefined);
  }, [teamRetouchAvailable, loadTeamRetouchHistory]);

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
    const fetchDrives = () => projectWorkspaceClient?.getDrives?.().then(nextDrives => setDrives(current =>
      current.length === nextDrives.length && current.every((drive, index) => drive === nextDrives[index]) ? current : nextDrives
    ));
    fetchDrives();
    const intervalId = window.setInterval(fetchDrives, 3000);
    return () => window.clearInterval(intervalId);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const refreshClipboardStatus = () => projectWorkspaceClient.getProjectFileClipboardStatus().then(result => setClipboardHasFiles(result.success && result.hasFiles));
    void refreshClipboardStatus();
    window.addEventListener('focus', refreshClipboardStatus);
    return () => window.removeEventListener('focus', refreshClipboardStatus);
  }, [active]);

  const loadProgressFolders = useCallback(async () => {
    const result = await projectWorkspaceClient.getProgressFolders(workspacePath, project.name);
    if (result.success) {
      progressFoldersRef.current = result.progressFolders;
      setProgressFolders(result.progressFolders);
      setVersionGraphEdges(result.graphEdges || []);
      return result.progressFolders;
    }
    onNotice(`读取版本进度失败：${result.error || '未知错误'}`);
    return [];
  }, [workspacePath, project.name, onNotice]);
  useEffect(() => {
    if (!active) return;
    const detached = progressFolders.filter(folder => folder.nodeRole === 'progress' && !folder.parentProgressId
      && !folder.folderMissing && !detachedProgressCleanupIdsRef.current.has(folder.id));
    if (!detached.length) return;
    detached.forEach(folder => detachedProgressCleanupIdsRef.current.add(folder.id));
    void Promise.all(detached.map(folder => projectWorkspaceClient.unregisterProgressFolder(workspacePath, project.name, folder.id)))
      .then(results => {
        const removed = results.some(result => result.success);
        results.forEach((result, index) => {
          if (!result.success) onNotice(`清理独立版本“${detached[index].displayName}”失败：${result.error || '未知错误'}`, 7000);
        });
        if (removed) void loadProgressFolders();
      });
  }, [active, progressFolders, workspacePath, project.name, loadProgressFolders, onNotice]);
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
  const requestSupplementalEdgeCreate = async (sourceProgressId: string, targetProgressId: string, edgeKind: 'media_companion' | 'derived_preview' | 'workflow_input') => {
    const source = progressFoldersRef.current.find(folder => folder.id === sourceProgressId);
    const target = progressFoldersRef.current.find(folder => folder.id === targetProgressId);
    if (!source || !target) { onNotice('关系节点不存在，请刷新后重试'); return; }
    const relationLabel = edgeKind === 'media_companion' ? '配套素材' : edgeKind === 'derived_preview' ? '预览产物' : '工作流输入';
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
        const sessionId = window.localStorage.getItem(sessionKey) || '';
        window.localStorage.removeItem(sessionKey);
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
            mediaKind: currentChild.mediaKind,
            versionKey: currentChild.versionKey,
            parentProgressId: nextParentProgressId || undefined,
            displayName: currentChild.displayName,
            relationKind: nextParentProgressId ? 'main' : undefined,
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
          const sessionId = window.localStorage.getItem(sessionKey) || '';
          window.localStorage.removeItem(sessionKey);
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
        pushRelationHistory({
          label: '修改版本父关系',
          undo: () => applyParent(previousParentProgressId, previousWorkflowInputProgressIds, previousTrackingPolicy),
          redo: () => applyParent(parentProgressId, nextWorkflowInputProgressIds),
        });
        if (updatedFolder.nodeRole === 'progress' && updatedFolder.trackingEnabled && parentProgressId) {
          const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, {
            progressId: updatedFolder.id,
            mode: 'refresh',
          });
          if (started.success && started.sessionId) {
            window.localStorage.setItem(`photoflow:tracking-session:${workspacePath}:${project.name}:${updatedFolder.id}`, started.sessionId);
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
      window.localStorage.setItem(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressId}`, sessionId);
      setTrackingConfirmationProgressId(progressId);
      setTrackingConfirmationSessionId(sessionId);
    };
    window.addEventListener('photoflow:open-tracking-confirmation', openTrackingConfirmation);
    return () => window.removeEventListener('photoflow:open-tracking-confirmation', openTrackingConfirmation);
  }, [active, progressFolders, workspacePath, project.name]);
  useEffect(() => {
    if (!active) return;
    return projectWorkspaceClient.onBackgroundTaskChanged(task => {
      if (task.type !== 'version-tracking') return;
      const progressId = typeof task.metadata.progressId === 'string' ? task.metadata.progressId : '';
      const progress = progressFoldersRef.current.find(folder => folder.id === progressId);
      if (!progressId || !progress?.trackingEnabled) {
        if (task.state === 'completed' || task.state === 'cancelled' || task.state === 'failed') void dismissBackgroundTask(task.id);
        return;
      }
      if (task.state !== 'completed') return;
      const sessionId = typeof task.metadata.sessionId === 'string' ? task.metadata.sessionId : '';
      if (!sessionId) return;
      window.localStorage.setItem(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressId}`, sessionId);
      setTrackingConfirmationProgressId(progressId);
      setTrackingConfirmationSessionId(sessionId);
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
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setSearchOpen(false);
    setSearchQuery('');
  };

  const refresh = async (relativePath?: string) => {
    const safeRelativePath = typeof relativePath === 'string' ? relativePath : currentRelativePathRef.current;
    const requestedPath = safeRelativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const requestedProjectPath = project.path;
    const refreshSequence = ++refreshSequenceRef.current;
    const cachedEntries = directoryEntriesCacheRef.current.get(requestedPath);
    if (cachedEntries && requestedPath === currentRelativePathRef.current && requestedProjectPath === projectPathRef.current) setFileEntries(cachedEntries);
    setDirectoryLoading(!cachedEntries);
    const contentsPromise = projectWorkspaceClient.getProjectContents(workspacePath, project.status, project.name);
    const browseResult = await projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, requestedPath, mediaCacheConfig);
    if (refreshSequence !== refreshSequenceRef.current || requestedPath !== currentRelativePathRef.current || requestedProjectPath !== projectPathRef.current) return;
    setDirectoryLoading(false);
    if (browseResult.success) {
      setCurrentDirectoryViaExternalLink(Boolean(browseResult.viaExternalLink));
      const cachedByPath = new Map((cachedEntries || []).map(entry => [entry.relativePath, entry]));
      const entries = browseResult.entries.map(entry => {
        const cached = cachedByPath.get(entry.relativePath);
        return cached && cached.updatedAt ? { ...entry, size: cached.size, createdAt: cached.createdAt, updatedAt: cached.updatedAt } : entry;
      });
      directoryEntriesCacheRef.current.set(requestedPath, entries);
      setFileEntries(entries);
    } else {
      // Never leave entries from the previous directory under a new breadcrumb.
      setCurrentDirectoryViaExternalLink(Boolean(browseResult.externalLinkOffline));
      setFileEntries([]);
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
      onNotice(`读取目录失败：${browseResult.error || '无法读取文件'}`);
    }
    const result = await contentsPromise;
    if (refreshSequence !== refreshSequenceRef.current || requestedPath !== currentRelativePathRef.current || requestedProjectPath !== projectPathRef.current) return;
    if (result.success) setFolders(result.folders);
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
    const result = await projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, directoryPath, mediaCacheConfig);
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
    setSearchEntries(current => {
      const retained = current.filter(entry => entry.viaShortcut || projectRelativeParentPath(normalizeProjectRelativePath(entry.relativePath)) !== directoryPath);
      const entriesByPath = new Map(retained.map(entry => [entry.path.toLocaleLowerCase(), entry]));
      for (const entry of nextDirectoryEntries) entriesByPath.set(entry.path.toLocaleLowerCase(), entry);
      return [...entriesByPath.values()];
    });
    directoryEntriesCacheRef.current.set(directoryPath, result.entries);
  }, [currentFolderRecursiveSearchActive, mediaCacheConfig, project.name, project.path, project.status, recursiveFlatOpen, searchQuery, workspacePath]);
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
        if (affectsCurrent) void refresh(currentPath);
      }
    }, 180);
  };

  useEffect(() => {
    const nextIdentity = { pageId, projectId: project.id, projectPath: project.path, projectName: project.name, projectStatus: project.status };
    const lifecycle = resolveProjectWorkspaceLifecycle(projectLifecycleRef.current, nextIdentity, currentRelativePathRef.current, initialRelativePath);
    projectLifecycleRef.current = nextIdentity;
    projectPathRef.current = project.path;
    if (lifecycle.kind === 'none') return;
    refreshSequenceRef.current += 1;
    directoryEntriesCacheRef.current.clear();
    directoryPrefetchesRef.current.clear();
    shortcutPreviewStatesRef.current.clear();
    setDirectoryLoading(active);
    if (lifecycle.kind === 'refresh') {
      if (active) {
        refresh(lifecycle.relativePath);
        if (projectWorkflows) {
          void loadProgressFolders();
        }
      }
      return;
    }
    currentRelativePathRef.current = lifecycle.relativePath;
    setProgressFolders([]);
    setVersionGraphEdges([]);
    setFileEntries([]);
    setDirectoryHistory({ back: [], forward: [] });
    setPreviewPath('');
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(previewPanePinnedRef.current);
    setMetadataPaneOpen(metadataPanePinnedRef.current);
    setFinalViewOpen(false);
    setFinalViewEntries([]);
    setVersionEntry(null);
    setTeamRetouchEntries([]);
    setProgressSetup(null);
    setProgressCompare(null);
    setProgressTask('');
    setPanel(initialPanel);
    setResearchTargetPath('');
    setResearchTargetKind('file');
    setResearchTargetHasTxt(false);
    setGatherPickerPaths(null);
    setBrowseMode(browseModeForFolder(lifecycle.relativePath, []));
    setGridIconSize(gridIconSizeForFolder(lifecycle.relativePath));
    if (currentRelativePath !== lifecycle.relativePath) skipNextPathRefreshRef.current = true;
    setCurrentRelativePath(lifecycle.relativePath);
    if (active) {
      refresh(lifecycle.relativePath);
      if (projectWorkflows) {
        void loadProgressFolders();
      }
    }
  }, [active, initialPanel, initialRelativePath, pageId, project.id, project.name, project.path, project.status, projectWorkflows]);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      refresh(currentRelativePathRef.current);
      if (projectWorkflows) {
        void loadProgressFolders();
      }
    }
    wasActiveRef.current = active;
  }, [active]);
  useEffect(() => {
    if (!active || currentRelativePath) return;
    const remembered = storedFolderBrowseMode('');
    if (remembered && remembered !== 'version-tree') return;
    const nextMode = browseModeForFolder('');
    setBrowseMode(current => current === nextMode ? current : nextMode);
  }, [active, currentRelativePath, progressFolders, project.path]);
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
    if (!active) return;
    let disposed = false;
    setRootWatchFailed(false);
    void projectWorkspaceClient.watchFileRoot(workspacePath, project.status, project.name).then(result => {
      if (!disposed) setRootWatchFailed(!result.success || Boolean(result.offlineLinks));
    });
    return () => {
      disposed = true;
      void projectWorkspaceClient.unwatchFileRoot(workspacePath, project.status, project.name);
    };
  }, [active, externalWatchRevision, project.name, project.status, watchRootDirectly, workspacePath]);
  useEffect(() => {
    if (!active || !rootWatchFailed) return;
    // Network drives and some virtual filesystems cannot be watched. Keep a
    // low-frequency fallback without making polling the normal code path.
    const interval = window.setInterval(() => {
      void projectWorkspaceClient.watchFileRoot(workspacePath, project.status, project.name).then(result => {
        if (result.success && !result.offlineLinks) setRootWatchFailed(false);
      });
      if (projectRootScopeSelected) setScopeRefreshToken(current => current + 1);
      else if (recursiveFlatOpen || currentFolderRecursiveSearchActive) setRecentRefreshToken(current => current + 1);
      else void refresh(currentRelativePathRef.current);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [active, currentFolderRecursiveSearchActive, project.name, project.path, project.status, projectRootScopeSelected, recursiveFlatOpen, rootWatchFailed, watchRootDirectly, workspacePath]);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let progressFolderTimer: number | undefined;
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
      if (change.eventType === 'rename' && /(?:^|\/)[^/]+\.lnk$/i.test(changedPath)) setExternalWatchRevision(current => current + 1);
      // A change in another project should never make a photo-heavy folder redraw.
      if (projectPrefix && changedPath && changedPath !== projectPrefix && !changedPath.startsWith(`${projectPrefix}/`)) return;
      // Content writes are handled by thumbnail/media tracking. Re-reading the
      // whole directory is only necessary when its membership may have changed.
      if (change.eventType === 'change') return;
      if (changedPath) {
        const projectRelativePath = !projectPrefix ? changedPath : changedPath === projectPrefix ? '' : changedPath.slice(projectPrefix.length + 1);
        if (projectWorkflows && (!projectRelativePath || !projectRelativePath.includes('/'))) {
          window.clearTimeout(progressFolderTimer);
          progressFolderTimer = window.setTimeout(() => void loadProgressFolders(), 550);
        }
        const changedParentPath = projectRelativePath.split('/').slice(0, -1).join('/');
        const currentPath = currentRelativePathRef.current.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
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
      directoryEntriesCacheRef.current.clear();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        refresh(currentRelativePathRef.current);
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
      setTeamRetouchEntries(applySourceRevision);
    });
    return unsubscribe;
  }, [active, previewOnlyOnMediaClick]);
  useEffect(() => {
    const query = searchQuery.trim();
    searchSequenceRef.current += 1;
    const sequence = searchSequenceRef.current;
    const previousCursor = recentCursorRef.current;
    recentCursorRef.current = '';
    if (previousCursor) void projectWorkspaceClient.cancelRecentProjectFiles(previousCursor);
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
          if (!query && staleRecentResult.success && staleRecentResult.cursor) void projectWorkspaceClient.cancelRecentProjectFiles(staleRecentResult.cursor);
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
          setSearchEntries([]);
          setRecentCursor('');
          setRecentHasMore(false);
          setSearchError(result.error || '搜索失败');
        }
      }).finally(() => {
        if (sequence === searchSequenceRef.current) setSearchLoading(false);
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [active, searchQuery, recursiveFlatOpen, currentFolderRecursiveSearchActive, currentRelativePath, finalViewOpen, workspacePath, project.status, project.name, recentRefreshToken]);
  const loadMoreRecentFiles = useCallback(async () => {
    if (!active || !recursiveFlatOpen || searchQuery.trim() || finalViewOpen || !recentHasMore || !recentCursor || recentLoadInFlightRef.current) return;
    recentLoadInFlightRef.current = true;
    setRecentLoadingMore(true);
    setRecentLoadError('');
    const sequence = searchSequenceRef.current;
    try {
      let result = await projectWorkspaceClient.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE, recentCursor);
      if (sequence !== searchSequenceRef.current || !active) return;
      if (!result.success && result.errorCode === RECENT_FILES_SESSION_EXPIRED) {
        result = await projectWorkspaceClient.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE);
        if (sequence !== searchSequenceRef.current || !active) {
          if (result.success && result.cursor) void projectWorkspaceClient.cancelRecentProjectFiles(result.cursor);
          return;
        }
      }
      if (!result.success) {
        setRecentHasMore(false);
        setRecentLoadError(result.error || '继续读取最近文件失败');
        return;
      }
      setSearchEntries(current => {
        const existing = new Set(current.map(entry => entry.path.toLocaleLowerCase()));
        return [...current, ...result.entries.filter(entry => !existing.has(entry.path.toLocaleLowerCase()))];
      });
      recentCursorRef.current = result.cursor || '';
      setRecentCursor(result.cursor || '');
      setRecentHasMore(Boolean(result.hasMore));
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
    if (cursor) void projectWorkspaceClient.cancelListProjectFiles(cursor);
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
    scopeRequestSequenceRef.current += 1;
    const sequence = scopeRequestSequenceRef.current;
    cancelScopeSession();
    scopeLoadInFlightRef.current = false;
    setScopeEntries([]);
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
        if (result.cursor) void projectWorkspaceClient.cancelListProjectFiles(result.cursor);
        return;
      }
      if (!result.success) {
        setScopeError(result.errorCode === FILE_LIST_CANCELLED ? '' : result.error || '读取项目文件失败');
        return;
      }
      setScopeEntries(result.entries);
      replaceScopeCursor(result.cursor || '');
      setScopeHasMore(Boolean(result.hasMore));
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
        if (result.cursor) void projectWorkspaceClient.cancelListProjectFiles(result.cursor);
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

  const recursiveSearchActive = (recursiveFlatOpen || currentFolderRecursiveSearchActive || projectRootFilterActive) && !finalViewOpen;
  const groupedResultsActive = (recursiveFlatOpen || currentFolderRecursiveSearchActive || projectRootFilterActive) && !finalViewOpen;
  const activeFileEntries = projectRootFilterActive ? scopeEntries : recursiveFlatOpen || currentFolderRecursiveSearchActive ? searchEntries : finalViewOpen ? finalViewEntries : fileEntries;
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
      const cacheKey = `${entry.path}|${entry.updatedAt || 0}`;
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
          previewRatingCacheRef.current.set(`${item.path}|${item.updatedAt || 0}`, rating);
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
    const effectiveSortField = sortField;
    const direction = sortDirection === 'asc' ? 1 : -1;
    return [...filtered].sort((left, right) => {
      if (isFolderLikeEntry(left) && !isFolderLikeEntry(right)) return -1;
      if (!isFolderLikeEntry(left) && isFolderLikeEntry(right)) return 1;
      let comparison = 0;
      if (effectiveSortField === 'date') comparison = left.updatedAt - right.updatedAt;
      else if (effectiveSortField === 'size') comparison = left.size - right.size;
      else comparison = left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      return comparison === 0
        ? left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
        : comparison * direction;
    });
  }, [activeFileEntries, fileFilter, filterRatings, folderAlphabetFilter, folderAlphabetFilterVisible, ratingFilter, searchQuery, recursiveSearchActive, sortDirection, sortField]);
  useEffect(() => {
    const pending = pendingDirectoryReturnSelectionRef.current;
    if (!pending || pending.directoryPath !== normalizeProjectRelativePath(currentRelativePath) || directoryLoading) return;
    pendingDirectoryReturnSelectionRef.current = null;
    const returnedFolder = fileEntries.find(entry => isFolderLikeEntry(entry) && normalizeProjectRelativePath(entry.relativePath) === pending.entryPath);
    if (!returnedFolder) return;
    selectionAnchorPathRef.current = returnedFolder.relativePath;
    setSelectedPaths([returnedFolder.relativePath]);
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
    return [...groups.entries()].sort(([leftPath, leftEntries], [rightPath, rightEntries]) => {
      if (recursiveFlatOpen && !searchQuery.trim()) {
        const leftNewest = Math.max(0, ...leftEntries.map(entry => entry.updatedAt));
        const rightNewest = Math.max(0, ...rightEntries.map(entry => entry.updatedAt));
        if (leftNewest !== rightNewest) return rightNewest - leftNewest;
      }
      return leftPath.localeCompare(rightPath, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  }, [displayedFileEntries, groupedResultsActive, recursiveFlatOpen, searchQuery]);
  const groupedLoading = projectRootFilterActive ? scopeLoading : searchLoading;
  const groupedError = projectRootFilterActive ? scopeError : searchError;
  const groupedLoadingMore = projectRootFilterActive ? scopeLoadingMore : recentLoadingMore;
  const groupedLoadError = projectRootFilterActive ? scopeError : recentLoadError;
  const groupedHasMore = projectRootFilterActive ? scopeHasMore : recentHasMore;
  const renderedFileEntries = displayedFileEntries.slice(virtualWindow.start, virtualWindow.end);
  const pathSegments = currentRelativePath.split(/[\\/]/).filter(Boolean);
  const browserRootLabel = inspirationMode ? browserContext.title : project.name;
  const recursiveScopeLabel = currentRelativePath ? '当前文件夹及其子文件夹' : inspirationMode ? '整个灵感库' : '整个项目';
  const breadcrumbs = pathSegments.map((label, index) => ({
    label: label.toLocaleLowerCase().endsWith('.lnk') ? label.slice(0, -4) : label,
    relativePath: pathSegments.slice(0, index + 1).join('/'),
    externalLink: currentDirectoryViaExternalLink && index === 0,
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
    });
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
    if (entry.kind !== 'folder' && entry.kind !== 'shortcut') return Promise.resolve([]);
    const cacheKey = entry.kind === 'shortcut' && !entry.externalLink ? `shortcut:${entry.relativePath}:${entry.updatedAt}` : entry.relativePath;
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
    const cached = directoryEntriesCacheRef.current.get(cacheKey);
    if (cached) {
      const shortcutState = shortcutPreviewStatesRef.current.get(cacheKey);
      if (shortcutState) applyShortcutState(shortcutState);
      return Promise.resolve(cached);
    }
    const pending = directoryPrefetchesRef.current.get(cacheKey);
    if (pending) return pending;
    const requestedProjectPath = project.path;
    const browseRequest: Promise<{ success: boolean; entries: ProjectFileEntry[]; shortcutTargetKind?: 'folder' | 'file'; shortcutBroken?: boolean }> = entry.kind === 'shortcut' && !entry.externalLink
      ? projectWorkspaceClient.browseProjectShortcutPreview(workspacePath, project.status, project.name, entry.relativePath).then(result => ({ success: result.success, entries: result.entries, shortcutTargetKind: result.success && result.targetKind ? result.targetKind : undefined, shortcutBroken: !result.success }))
      : projectWorkspaceClient.browseProjectFiles(workspacePath, project.status, project.name, entry.relativePath, mediaCacheConfig);
    const request = browseRequest
      .then(result => {
        if (requestedProjectPath !== projectPathRef.current) return [];
        if (entry.kind === 'shortcut' && !entry.externalLink) {
          const shortcutState = { shortcutTargetKind: result.shortcutTargetKind, shortcutBroken: result.shortcutBroken };
          shortcutPreviewStatesRef.current.set(cacheKey, shortcutState);
          applyShortcutState(shortcutState);
        }
        if (!result.success) {
          directoryEntriesCacheRef.current.set(cacheKey, []);
          return [];
        }
        directoryEntriesCacheRef.current.set(cacheKey, result.entries);
        return result.entries;
      })
      .finally(() => directoryPrefetchesRef.current.delete(cacheKey));
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
      if (!result.success) { onNotice(`导入花絮失败：${result.error || '未知错误'}`); return; }
      if (result.cancelled) { onNotice('已取消选择花絮文件。'); return; }
      setPanelImportResult({ kind: 'broll', count: result.count || 0, sourceDeleted: deleteBrollSources });
      onNotice(`已导入 ${result.count || 0} 个花絮文件，源文件${deleteBrollSources ? '已删除' : '已保留'}。`);
      if (result.warning) {
        if (isRecycleBinFailure(result.warning)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
        else onNotice(result.warning, 6000);
      }
      refresh();
    } finally {
      setPanelImportBusy('');
    }
  };
  const chooseBrollFiles = async () => {
    const result = await projectWorkspaceClient.chooseBrollSourceFiles();
    if (!result.cancelled && result.paths.length) setBrollSourcePaths(result.paths);
  };
  const chooseFilesToImport = async () => {
    const result = await projectWorkspaceClient.chooseProjectImportFiles();
    if (!result.cancelled && result.paths.length) setFileImportSourcePaths(result.paths);
  };
  const importFiles = async () => {
    if (!fileImportSourcePaths.length) return;
    const targetRelativePath = fileImportTarget;
    setPanelImportResult(null);
    setPanelImportBusy('files');
    try {
      const result = await projectWorkspaceClient.importProjectFiles(workspacePath, project.status, project.name, targetRelativePath, { deleteSourceAfterImport: deleteFileSources, linkOnly: linkFileSources, sourcePaths: fileImportSourcePaths });
      if (!result.success) { onNotice(`导入失败：${result.error || '未知错误'}`); return; }
      if (result.cancelled) { onNotice('已取消导入。'); return; }
      setPanelImportResult({ kind: 'files', count: result.count || 0, sourceDeleted: deleteFileSources });
      onNotice(`已导入 ${result.count || 0} 个文件，源文件${deleteFileSources ? '已删除' : '已保留'}。`);
      refresh();
      refreshRecursiveResults(targetRelativePath);
    } finally {
      setPanelImportBusy('');
    }
  };
  const openOfficeImageExtractor = (entries: ProjectFileEntry[]) => {
    const documents = entries.filter(isOfficeOpenXmlEntry);
    if (!documents.length) return;
    setOfficeExtractEntries(documents);
    setOfficeExtractResult(null);
    setPanel('office-extract');
  };
  const extractOfficeImages = async () => {
    const documents = officeExtractEntries.filter(isOfficeOpenXmlEntry);
    if (!documents.length || officeExtractBusy) return;
    setOfficeExtractBusy(true);
    onNotice(`正在从 ${documents.length} 个 Office 文档提取图片…`);
    try {
      const result = await projectWorkspaceClient.extractOfficeImages(workspacePath, project.status, project.name, documents.map(entry => entry.relativePath));
      if (!result.success) {
        onNotice(`提取图片失败：${result.error || '未知错误'}`, 6000);
        return;
      }
      directoryEntriesCacheRef.current.clear();
      await refresh();
      const imageCount = result.imageCount || 0;
      const failed = result.results.filter(item => !item.success);
      const empty = result.results.filter(item => item.success && !item.count);
      const outputFolders = result.results.filter(item => item.success && item.outputFolder).map(item => item.outputFolder as string);
      setOfficeExtractResult({ documents: result.successfulCount || documents.length, images: imageCount, failed: failed.length, outputFolders });
      if (imageCount) onNotice(`已从 ${result.successfulCount || documents.length} 个文档提取 ${imageCount} 张图片。`, 7000);
      else onNotice(empty.length ? '所选 Office 文档中没有可提取的图片。' : '没有提取到图片。');
      if (failed.length) onNotice(`${failed.length} 个文档提取失败：${failed.map(item => item.documentName).join('、')}`, 7000);
    } finally {
      setOfficeExtractBusy(false);
    }
  };
  const completeSdImport = async (completion: ImportCompletion) => {
    const result = await projectWorkspaceClient.finalizeSdImportedProjects(workspacePath, completion.projectNames, {
      moveProjectAfterImport: importConfig.autoMoveProjectAfterSdImport,
      workProjectNames: completion.workProjectNames,
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
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const createDirectly = recursiveFlatOpen || normalizedTarget !== normalizeProjectRelativePath(currentRelativePath);
    let folderName = '新建文件夹';
    if (createDirectly) {
      const answer = await appDialog.prompt({ title: '新建文件夹', message: '输入文件夹名称。', defaultValue: folderName, confirmLabel: '新建' });
      if (!answer?.trim()) return;
      folderName = answer.trim();
    }
    const result = await projectWorkspaceClient.createProjectFolder(workspacePath, project.status, project.name, folderName, normalizedTarget, true);
    if (!result.success) { onNotice(`新建文件夹失败：${result.error || '未知错误'}`); return; }
    directoryEntriesCacheRef.current.delete(normalizedTarget);
    await refresh();
    refreshRecursiveResults(normalizedTarget);
    if (createDirectly) {
      onNotice(`已在${normalizedTarget ? `“${normalizedTarget}”` : '项目根目录'}中新建文件夹“${result.folder?.name || folderName}”`);
      return;
    }
    const relativePath = result.folder?.relativePath || [...[normalizedTarget, result.folder?.name || folderName].filter(Boolean)].join('/');
    setSelectedPaths([relativePath]);
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
    const normalizedTarget = normalizeProjectRelativePath(targetRelativePath);
    const result = await projectWorkspaceClient.createProjectShellNewFile(workspacePath, project.status, project.name, normalizedTarget, type.id);
    if (!result.success || !result.file) { onNotice(`新建${type.label}失败：${result.error || '未知错误'}`); return; }
    directoryEntriesCacheRef.current.delete(normalizedTarget);
    await refresh();
    refreshRecursiveResults(normalizedTarget);
    if (normalizedTarget !== normalizeProjectRelativePath(currentRelativePath)) {
      onNotice(`已在${normalizedTarget ? `“${normalizedTarget}”` : '项目根目录'}中新建${type.label}`);
      return;
    }
    setSelectedPaths([result.file.relativePath]);
    setInlineRenamePath(result.file.relativePath);
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
    if (draft.relationKind === 'auxiliary' && !draft.parentProgressId) return false;
    // A blank/manual project must be able to create its first explicit main
    // root. Subsequent relationships still require a concrete parent ID.
    if (!draft.parentProgressId) return draft.relationKind === 'main' && draft.relation === 'root'
      && versionKeyMatchesParentKind(draft.versionKey, undefined, 'main');
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
    const branchParent = requestedParent || structuralParents.find(folder => folder.id === semanticDefaultParentId);
    const actualRelation = relation === 'branch' && branchParent ? 'branch' : 'root';
    let versionKey = '';
    let parentId = '';
    if (actualRelation === 'root') {
      versionKey = nextVersionKeys(sourceFolders, mediaKind, requestedParent).main;
      parentId = requestedParent?.id || semanticDefaultParentId;
    } else {
      if (!branchParent) throw new Error('分支进度缺少有效的结构父节点');
      versionKey = nextVersionKeys(sourceFolders, mediaKind, branchParent).branch;
      parentId = branchParent.id;
    }
    return { mode, mediaKind, relation: actualRelation, relationKind: 'main', parentProgressId: parentId, versionKey, progressName: '', trackingEnabled: mode !== 'create', deleteSourceAfterImport: importDefaults.deleteSourceAfterImport, linkOnly: false, sourcePaths: [], renameSources: false, copyMissingFromParent: false, workflowInputProgressIds: defaultWorkflowInputIds(sourceFolders, versionGraphEdges, parentId) };
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
    setShowImportMenu(false);
    setPanelImportResult(null);
    setFileImportTarget(targetRelativePath);
    if (kind === 'progress') {
      setPanel(null);
      openProgressSetup('import', sourcePaths);
      return;
    }
    closeProgressSetup();
    if (kind === 'original') {
      setNegativeSourcePaths(sourcePaths);
      setPanel('negative-import');
      return;
    }
    if (kind === 'broll') {
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
  const makeMarkProgressDraft = (entry: ProjectFileEntry, targetRelativePath: string, sourceFolders: ProgressFolder[], preferredMediaKind?: 'image' | 'video'): ProgressSetupDraft | null => {
    const normalizedPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const registered = sourceFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === normalizedPath);
    if (registered) {
      if (registered.nodeRole !== 'progress') return null;
      const registeredParent = sourceFolders.find(folder => folder.id === registered.parentProgressId);
      const normalizedVersionKey = isUserVersionKey(registered.versionKey)
        ? registered.versionKey
        : nextVersionKeys(sourceFolders, registered.mediaKind, registeredParent, registered.id).main;
      return {
        mode: 'mark',
        mediaKind: registered.mediaKind,
        relation: versionKindForParent(normalizedVersionKey, registeredParent) === 'branch' ? 'branch' : 'root',
        relationKind: registered.relationKind || 'main',
        parentProgressId: registered.parentProgressId || '',
        versionKey: normalizedVersionKey,
        progressName: progressNameFromDisplayName(registered.displayName, registered.mediaKind, registered.versionKey, entry.name),
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
    if (entry.kind !== 'folder') return null;
    const mediaKind: 'image' | 'video' = preferredMediaKind || (/(mov|video|视频|剪辑|成片)/iu.test(entry.name) ? 'video' : 'image');
    return {
      ...makeProgressDraft('mark', mediaKind, 'root', '', sourceFolders),
      progressName: entry.name,
      targetRelativePath,
      trackingEnabled: false,
      preserveFolderName: true,
    };
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
    const initialDraft = makeMarkProgressDraft(resolvedEntry, targetRelativePath, progressFolders, preferredMediaKind);
    if (!initialDraft) {
      onNotice('当前文件夹由对应功能管理，不能在版本设置面板中修改。');
      return;
    }
    // Show the cached draft immediately. A slow database or network drive must
    // not keep the dialog invisible while progress-folder locations are synced.
    setProgressSetup(initialDraft);
    void loadProgressFolders().then(latestFolders => {
      if (!latestFolders.length && progressFolders.length) return;
      const latestDraft = makeMarkProgressDraft(resolvedEntry, targetRelativePath, latestFolders, preferredMediaKind);
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
    const nextDraft = completeDraft(makeProgressDraft('mark', latestSource.mediaKind, 'root', latestSource.id, latestFolders));
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
    const draft = makeProgressDraft('create', source.mediaKind, branch ? 'branch' : 'root', source.id, latestFolders);
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
    const updated = await projectWorkspaceClient.registerProgressFolder(workspacePath, project.status, project.name, {
      relativePath: projectRelativePath(progressFolder.folderPath),
      mediaKind: progressFolder.mediaKind,
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
    relationKind: VersionRelationKind;
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
    if (progressNameHasConflict(draft)) { onNotice('生成的版本文件夹名称已存在，请修改版本号或名称。'); return; }
    const appendTarget = progressAppendTarget(draft);
    if (appendTarget?.trackingState === 'needs_repair' || appendTarget?.trackingState === 'committing') {
      onNotice(appendTarget.trackingState === 'needs_repair' ? '请先修复当前版本批次，再追加文件。' : '当前版本批次仍在提交，请稍后再追加。');
      return;
    }
    const generatedName = resolvedProgressFolderName(draft);
    const trackingEnabled = appendTarget ? appendTarget.trackingState !== 'disabled' : normalizeProgressSetupTrackingPolicy(draft.relationKind, draft).trackingEnabled;
    const parentFolder = appendTarget
      ? progressFolders.find(folder => folder.id === appendTarget.parentProgressId && !folder.folderMissing)
      : progressComparisonParent(draft);
    progressImportOperationIdRef.current = '';
    progressSubmittingRef.current = true;
    setProgressSubmitting(true);
    try {
      if (draft.mode === 'create') {
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const registered = await registerProgressWithWorkflow({
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          relationKind: draft.relationKind,
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
        let relativePath = projectRelativePath(existingProgress.folderPath);
        if (draft.relationKind === 'main' && relativePath.includes('/')) setProgressTask('正在安全移动文件夹到项目根目录…');
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const policyChanged = existingProgress.trackingEnabled !== policy.trackingEnabled
          || existingProgress.renameFromParent !== policy.renameFromParent
          || existingProgress.copyMissingFromParent !== policy.copyMissingFromParent
          || existingProgress.parentProgressId !== (draft.parentProgressId || undefined)
          || (existingProgress.relationKind || 'main') !== draft.relationKind;
        const renamed = await projectWorkspaceClient.updateProgressFolder(workspacePath, project.status, project.name, {
          progressId: existingProgress.id,
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          trackingEnabled: policy.trackingEnabled,
          trackingState: policy.trackingEnabled && policyChanged ? 'pending_compare' : policy.trackingEnabled ? existingProgress.trackingState : 'disabled',
          preserveFolderPath: false,
        });
        if (!renamed.success || !renamed.progressFolder) throw new Error(renamed.error || '无法修改版本文件夹名称或分支');
        relativePath = renamed.folder?.relativePath || projectRelativePath(renamed.progressFolder.folderPath) || relativePath;
        const registered = await registerProgressWithWorkflow({
          progressId: renamed.progressFolder.id,
          relativePath,
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          relationKind: draft.relationKind,
          ...policy,
          trackingState: policy.trackingEnabled && policyChanged ? 'pending_compare' : policy.trackingEnabled ? renamed.progressFolder.trackingState : 'disabled',
        }, draft.workflowInputProgressIds);
        if (!registered.success || !registered.progressFolder) throw new Error(registered.error || '版本文件夹已修改，但无法保存版本跟踪策略');
        setProgressSetup(null);
        directoryEntriesCacheRef.current.clear();
        progressFoldersRef.current = progressFoldersRef.current.map(folder => folder.id === registered.progressFolder!.id ? registered.progressFolder! : folder);
        setProgressFolders(current => current.map(folder => folder.id === registered.progressFolder!.id ? registered.progressFolder! : folder));
        setSelectedPaths([relativePath]);
        if (policy.trackingEnabled && draft.relationKind === 'main' && draft.parentProgressId && policyChanged) {
          const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: registered.progressFolder.id, mode: existingProgress.trackingEnabled ? 'refresh' : 'compare' });
          if (!started.success || !started.sessionId) throw new Error(started.error || '无法启动版本跟踪任务');
          window.localStorage.setItem(`photoflow:tracking-session:${workspacePath}:${project.name}:${registered.progressFolder.id}`, started.sessionId);
          setTrackingConfirmationProgressId(registered.progressFolder.id);
          if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
          onNotice('修改已保存，正在后台比较版本。');
        } else {
          onNotice(`已修改进度“${registered.progressFolder.displayName}”。`);
        }
        void Promise.all([loadProgressFolders(), refresh('')]);
        return;
      }

      if (draft.mode === 'mark') {
        if (!draft.targetRelativePath) throw new Error('没有找到要标记的文件夹');
        let targetRelativePath = draft.targetRelativePath;
        const moveToRoot = draft.relationKind === 'main' && targetRelativePath.includes('/');
        if (moveToRoot) setProgressTask('正在安全移动文件夹到项目根目录…');
        setProgressTask(`正在标记${draft.mediaKind === 'image' ? '图片' : '视频'}进度…`);
        const policy = normalizeProgressSetupTrackingPolicy(draft.relationKind, draft);
        const registered = await registerProgressWithWorkflow({
          relativePath: targetRelativePath,
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          relationKind: draft.relationKind,
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
            progressName: progressNameFromDisplayName(progressFolder.displayName, progressFolder.mediaKind, progressFolder.versionKey, progressFolder.displayName),
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
          setProgressTask('');
          onNotice(`已将“${generatedName}”登记为${draft.relationKind === 'auxiliary' ? '选片辅助节点' : '版本进度'}。`);
          openCreatedProgressEditor();
          return;
        }
        if (!parentFolder) {
          setProgressTask('正在建立首个版本的跟踪记录…');
          const baseline = await projectWorkspaceClient.registerVersionBaseline(workspacePath, project.status, project.name, targetRelativePath);
          if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
          await loadProgressFolders();
          setProgressTask('');
          onNotice(`已标记并建立首版跟踪：${progressFolder.displayName}`);
          openCreatedProgressEditor();
          return;
        }

        const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: progressFolder.id, mode: 'compare' });
        if (!started.success || !started.sessionId) throw new Error(started.error || '无法启动版本跟踪任务');
        window.localStorage.setItem(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressFolder.id}`, started.sessionId);
        setTrackingConfirmationProgressId(progressFolder.id);
        if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
        setProgressTask('');
        onNotice('已开始后台比较，完成后可确认版本匹配。');
        openCreatedProgressEditor();
        return;
      }

      setProgressTask('');
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
          setProgressTask('');
          setProgressSetup(null);
          return;
        }
        imported = await projectWorkspaceClient.importProgressFiles(workspacePath, project.status, project.name, generatedName, {
          ...importOptions,
          progressConflictPolicy: policy,
          sourcePaths: decision.sourcePaths,
        });
      }
      if (!imported.success) throw new Error(imported.error || '导入失败');
      if (imported.cancelled || !imported.folder) {
        setProgressTask('');
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
        relationKind: draft.relationKind,
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
        setProgressTask('');
        setProgressImportCompletion(`没有向“${progressFolder.displayName}”追加新文件${skippedSummary}。`);
        return;
      }

      if (!trackingEnabled) {
        setProgressTask('');
        setProgressImportCompletion(appendTarget
          ? `已向“${progressFolder.displayName}”追加 ${imported.count || 0} 个文件${skippedSummary}；沿用未开启版本跟踪的设置。`
          : `已导入 ${imported.count || 0} 个文件；此项目未开启版本跟踪。`);
        return;
      }
      if (!parentFolder) {
        setProgressTask(appendTarget ? '正在把本次追加文件写入首版跟踪记录…' : '正在建立首个版本的跟踪记录…');
        const baseline = await projectWorkspaceClient.registerVersionBaseline(workspacePath, project.status, project.name, imported.folder.relativePath);
        if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
        await loadProgressFolders();
        setProgressTask('');
        setProgressImportCompletion(appendTarget
          ? `已向“${progressFolder.displayName}”追加 ${imported.count || 0} 个文件并更新首版跟踪${skippedSummary}。`
          : `已导入并建立首版跟踪：${progressFolder.displayName}`);
        return;
      }

      setProgressSetup(null);
      const started = await projectWorkspaceClient.startProgressTracking(workspacePath, project.name, { progressId: progressFolder.id, mode: appendTarget ? 'refresh' : 'compare' });
      if (!started.success || !started.sessionId) throw new Error(started.error || '无法启动版本跟踪任务');
      window.localStorage.setItem(`photoflow:tracking-session:${workspacePath}:${project.name}:${progressFolder.id}`, started.sessionId);
      setTrackingConfirmationProgressId(progressFolder.id);
      if (started.sessionStatus === 'pending_confirm' || started.sessionStatus === 'committing' || started.sessionStatus === 'failed') setTrackingConfirmationSessionId(started.sessionId);
      setProgressTask('');
      onNotice('导入完成，正在后台比较版本。');
    } catch (error) {
      setProgressTask('');
      const action = draft.mode === 'create' ? '创建' : draft.mode === 'import' ? '导入' : draft.existingProgressId ? '修改' : '标记';
      onNotice(`${action}版本进度失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      progressSubmittingRef.current = false;
      setProgressSubmitting(false);
    }
  };
  const trackingParentForProgress = (progressFolder: ProgressFolder, sourceFolders = progressFolders) => sourceFolders.find(folder => folder.id === progressFolder.parentProgressId && !folder.folderMissing);
  const progressTrackingRefreshLabel = (progressFolder: ProgressFolder) => progressTrackingActionLabel(progressFolder);
  const openProgressRepair = async (progressFolder: ProgressFolder) => {
    if (!progressFolder.repairBatchId) { onNotice('没有找到可修复的版本批次，请刷新版本跟踪。'); return; }
    setProgressTask('正在读取失败的文件操作…');
    const result = await projectWorkspaceClient.getVersionBatchOperations(workspacePath, progressFolder.repairBatchId);
    setProgressTask('');
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
    if (progressSubmitting || progressTask) return;
    if (!progressTrackingAction(requestedProgress)) { onNotice('选片、预览和协作内容不参与版本跟踪。'); return; }
    if (requestedProgress.trackingState === 'needs_repair' && requestedProgress.repairBatchId) { await openProgressRepair(requestedProgress); return; }
    setProgressSubmitting(true);
    try {
      const latestFolders = await loadProgressFolders();
      const progressFolder = latestFolders.find(folder => folder.id === requestedProgress.id) || requestedProgress;
      if (progressFolder.folderMissing) throw new Error('当前进度文件夹已经丢失');
      const parentFolder = trackingParentForProgress(progressFolder, latestFolders.length ? latestFolders : progressFolders);
      const relativePath = projectRelativePath(progressFolder.folderPath);
      if (!parentFolder) {
        setProgressTask('正在重新扫描首个版本并更新项目跟踪…');
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
      window.localStorage.setItem(sessionStorageKey, started.sessionId);
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
      setProgressTask('');
      setProgressSubmitting(false);
    }
  };
  const commitProgressCompare = async () => {
    if (!progressCompare || progressSubmitting) return;
    setProgressSubmitting(true);
    setProgressTask('正在确认版本关系并写入素材历史…');
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
      setProgressTask('');
      onNotice(`建立版本跟踪失败：${result.error || '未知错误'}`);
      return;
    }
    const committedProgressFolder = progressCompare.progressFolder;
    setProgressSubmitting(false);
    setProgressTask('');
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
    const relativePath = projectRelativePath(progressCompare.progressFolder.folderPath);
    const result = await projectWorkspaceClient.registerProgressFolder(workspacePath, project.status, project.name, {
      relativePath,
      mediaKind: progressCompare.progressFolder.mediaKind,
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
  const closePngConverterPanel = () => {
    conversionInspectionSequenceRef.current += 1;
    setConversionCollecting(false);
    setPanel(null);
  };
  const openPngConverter = async (targetPaths: string | string[]) => {
    const triggerAction = converterTriggerAction(panel === 'converter', projectPanelIsRunning('converter'));
    if (triggerAction === 'restore') { setPanel('converter'); return; }
    if (triggerAction === 'close') { closePngConverterPanel(); return; }
    const requestedPaths = (Array.isArray(targetPaths) ? targetPaths : [targetPaths]).filter(Boolean);
    if (!requestedPaths.length) { onNotice('请先选择 PNG 文件或包含 PNG 的文件夹'); return; }
    const sequence = ++conversionInspectionSequenceRef.current;
    setConversionTargets([]);
    setConversionCollecting(true);
    setPanel('converter');
    while (sequence === conversionInspectionSequenceRef.current) {
      const result = await projectWorkspaceClient.inspectProjectToolSources(workspacePath, project.status, project.name, requestedPaths, false, false, true);
      if (sequence !== conversionInspectionSequenceRef.current) return;
      if (!result.success) {
        setConversionCollecting(false);
        onNotice(`读取 PNG 索引失败：${result.error || '未知错误'}`);
        return;
      }
      if (result.indexed) {
        setConversionTargets(result.pngPaths);
        setConversionCollecting(false);
        if (!result.pngPaths.length) onNotice('所选文件或文件夹中没有 PNG');
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
    const entry = fileEntries.find(candidate => candidate.relativePath === relativePath);
    if (!entry) return;
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
    const entry = fileEntries.find(candidate => candidate.relativePath === inlineRenamePath);
    const nextName = inlineRenameValue.trim();
    if (!entry || !nextName || nextName === entry.name) { cancelInlineRename(); return; }
    if (isProtectedRenameEntry(entry)) { cancelInlineRename(); onNotice('该文件夹由项目工作流管理，不能普通重命名。'); return; }
    renameCommitRef.current = true;
    const result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'rename', [inlineRenamePath], currentRelativePath, nextName);
    renameCommitRef.current = false;
    if (!result.success) { onNotice(`重命名失败：${result.error || '未知错误'}`); return; }
    cancelInlineRename();
    setSelectedPaths([]);
    onNotice(`已重命名为“${nextName}”`);
    refresh();
  };
  const beginRename = (targetPaths = selectedPaths) => {
    if (finalViewOpen) { onNotice('喜爱图片浏览是只读视图，请回到原文件夹重命名'); return; }
    if (!targetPaths.length) return;
    if (activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isUnsupportedShortcutContent(entry))) { onNotice('普通快捷方式中的文件是只读浏览内容，不能在项目中重命名'); return; }
    if (activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isProtectedRenameEntry(entry))) { onNotice('所选内容包含工作流文件夹，请使用“修改进度”。'); return; }
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
  const batchRenameEntries = selectedPaths.map(relativePath => fileEntries.find(entry => entry.relativePath === relativePath)).filter((entry): entry is ProjectFileEntry => Boolean(entry));
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
    renameCommitRef.current = true;
    const result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'rename', selectedPaths, currentRelativePath, '批量重命名', { renameNames: batchRenameNames });
    renameCommitRef.current = false;
    if (!result.success) { onNotice(`批量重命名失败：${result.error || '未知错误'}`); return; }
    const count = selectedPaths.length;
    setBatchRenameOpen(false);
    setBatchRenameParts([]);
    setSelectedPaths([]);
    onNotice(`已批量重命名 ${count} 个项目`);
    refresh();
  };
  const openFileMenuAt = (x: number, y: number, entry: ProjectFileEntry, selectEntry = true) => {
    filesSurfaceRef.current?.focus({ preventScroll: true });
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setSurfaceMenu(null);
    setOperationDirectoryPath(entry.viaShortcut ? currentRelativePath : projectRelativeParentPath(entry.relativePath));
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
    const returnEntryPath = directoryEntryToSelectOnReturn(currentRelativePathRef.current, normalizedPath);
    pendingDirectoryReturnSelectionRef.current = returnEntryPath ? { directoryPath: normalizedPath, entryPath: returnEntryPath } : null;
    // Invalidate the directory that is still loading before React commits the
    // breadcrumb change, so its late result cannot replace the new folder.
    refreshSequenceRef.current += 1;
    currentRelativePathRef.current = normalizedPath;
    const cachedEntries = directoryEntriesCacheRef.current.get(normalizedPath);
    if (cachedEntries) {
      setFileEntries(cachedEntries);
      setDirectoryLoading(false);
    } else {
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
    onNotice(result.count ? `已将 ${result.count} 个外链文件夹移动到项目内` : '没有可移动的 PhotoFlow 外链文件夹');
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
  const openVersions = (entry?: ProjectFileEntry) => {
    const target = entry || selectedEntries[0];
    if (!target || !['image', 'raw', 'video'].includes(target.kind)) {
      onNotice('请先选择一张图片、RAW 或视频');
      return;
    }
    if (!hasVersionProgressForEntry(target)) {
      onNotice(`项目尚未录入${target.kind === 'video' ? '视频' : '图片'}进度，请先标记或导入版本进度`);
      return;
    }
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
    const explicitParent = latestFolders.find(folder => folder.id === finalExportParentId && folder.mediaKind === 'image'
      && !folder.folderMissing && folder.nodeRole !== 'selection' && folder.relationKind !== 'auxiliary');
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
  const openTeamRetouch = async (entry?: ProjectFileEntry) => {
    if (teamRetouchOpening) return;
    const targets = entry
      ? (selectedPaths.includes(entry.relativePath) ? selectedEntries : [entry])
      : selectedEntries;
    const validTargets = targets.filter(target => target.kind === 'image');
    if (!validTargets.length && teamRetouchStep && teamRetouchEntries.length) {
      setTeamRetouchStep(teamRetouchWorkflowGeneratedRef.current ? 'workflow' : 'detect');
      onOpenToolTab('team', `团片 · ${project.name}`);
      return;
    }
    setTeamRetouchOpening(true);
    const dismissLoadingNotice = onNotice('正在加载团片协作数据…', 30000);
    try {
      const history = teamRetouchHistory.length ? teamRetouchHistory : await loadTeamRetouchHistory();
      if (targets.length && validTargets.length !== targets.length && !history.length) {
        onNotice('请选择成片图片，不要混选文件夹、RAW 或视频。');
        return;
      }
      if (!targets.length && !history.length) {
        onNotice('请选择至少一张成片图片开始团片协作');
        return;
      }
      const combined = new Map<string, ProjectFileEntry>();
      for (const item of [...history, ...teamRetouchEntries, ...validTargets]) combined.set(item.relativePath.toLocaleLowerCase(), item);
      if (validTargets.length) {
        const registered = await projectWorkspaceClient.registerTeamProjectPhotos(workspacePath, project.status, project.name, validTargets.map(target => target.relativePath));
        if (!registered.success) throw new Error(registered.error || '未知错误');
        void loadTeamRetouchHistory().catch(() => undefined);
      }
      setTeamRetouchEntries([...combined.values()]);
      setTeamRetouchStep(validTargets.length ? 'detect' : teamRetouchWorkflowGeneratedRef.current ? 'workflow' : 'detect');
      onOpenToolTab('team', `团片 · ${project.name}`);
      onNotice(`团片协作已加载，共 ${combined.size} 张图片`);
    } catch (error) {
      onNotice(`打开团片协作失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally {
      if (typeof dismissLoadingNotice === 'function') dismissLoadingNotice();
      setTeamRetouchOpening(false);
    }
  };
  const openProjectEntriesInPhotoshop = async (entries: ProjectFileEntry[]) => {
    if (entries.some(entry => entry.viaShortcut && !entry.viaExternalLink)) {
      onNotice('快捷方式中的文件不能直接发送到 Photoshop。');
      return;
    }
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
  const copyCurrentDirectoryPath = async (targetRelativePath = currentRelativePath) => {
    const result = await projectWorkspaceClient.copyProjectEntryPath(workspacePath, project.status, project.name, targetRelativePath);
    onNotice(result.success ? '成功复制文字' : `复制文件夹地址失败：${result.error || '未知错误'}`);
  };
  const clearPreviewAfterSelectionDrag = (drag: NonNullable<typeof selectionDragRef.current>) => {
    if (!drag.clearPreviewOnFinish) return;
    if (previewPath && (previewPaneOpen || metadataPaneOpen)) {
      paneLayoutRevealPathRef.current = previewPath;
      paneLayoutRevealPendingRef.current = true;
    }
    setPreviewPath('');
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
      clearPreviewOnFinish: !additive,
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
      clearPreviewAfterSelectionDrag(drag);
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
    clearPreviewAfterSelectionDrag(drag);
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
    if (finalViewOpen && operation !== 'copy') { onNotice('当前为只读视图，请到原文件夹修改。'); return; }
    if (operation !== 'paste' && activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isUnsupportedShortcutContent(entry))) { onNotice('普通快捷方式中的文件是只读浏览内容，不能执行此操作'); return; }
    if (operation === 'trash' && projectWorkflows) {
      const normalizedTargets = new Set(targetPaths.map(normalizeProjectRelativePath));
      const affectedProgressFolders = progressFolders.filter(folder => !folder.folderMissing
        && normalizedTargets.has(normalizeProjectRelativePath(projectRelativePath(folder.folderPath))));
      if (affectedProgressFolders.length && !await appDialog.confirm({
        title: affectedProgressFolders.length === 1 ? `删除版本 V${affectedProgressFolders[0].versionKey}？` : `删除 ${affectedProgressFolders.length} 个版本文件夹？`,
        message: '文件夹会移入回收站；数据库中的版本节点、素材历史和后代关系不会删除，并会在版本树中显示为“失效”。从回收站恢复原文件夹，或创建同版本文件夹后可以重新连接。',
        confirmLabel: '移入回收站',
        tone: 'danger',
      })) return;
    }
    const isClipboardSelection = operation === 'copy' || operation === 'cut';
    const clipboardOperationSequence = isClipboardSelection ? ++clipboardOperationSequenceRef.current : 0;
    const previousCutPaths = cutPaths;
    const previousClipboardHasFiles = clipboardHasFiles;
    const pasteClipboardGeneration = operation === 'paste' ? clipboardOperationSequenceRef.current : 0;
    const pasteCutPathsSnapshot = operation === 'paste' ? [...cutPaths] : [];
    if (isClipboardSelection) {
      setClipboardPending(true);
    }
    const normalizedDestination = normalizeProjectRelativePath(destinationRelativePath);
    let result: Awaited<ReturnType<typeof projectWorkspaceClient.projectFileOperation>>;
    try {
      result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, normalizedDestination, nextName);
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
        if (policy !== 'replace' && policy !== 'keep-both') { onNotice('粘贴已取消'); refresh(); return; }
        result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, normalizedDestination, nextName, { pasteConflictPolicy: policy });
      }
    } catch (error) {
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      onNotice(`操作失败：${error instanceof Error ? error.message : String(error || '未知错误')}`);
      return;
    }
    if (result.cancelled) {
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      onNotice('粘贴已取消'); refresh(); return;
    }
    if (!result.success) {
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
        setClipboardPending(false);
      }
      if (operation === 'trash' && isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else onNotice(`操作失败：${result.error || '未知错误'}`);
      return;
    }
    if (operation === 'copy' || operation === 'cut') {
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
      onNotice(operation === 'trash'
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
          : '操作完成');
      setSelectedPaths([]);
      if (projectWorkflows && (operation === 'trash' || operation === 'paste')) await loadProgressFolders();
      scheduleDirectoryRefresh(result.affectedDirectories);
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
  const selectedEntries = activeFileEntries.filter(entry => selectedPaths.includes(entry.relativePath));
  const selectedContainsShortcutContent = selectedEntries.some(isUnsupportedShortcutContent);
  const registeredProgressFolderForEntry = (entry?: ProjectFileEntry) => {
    if (!entry) return undefined;
    const entryPath = (entry.externalLinkTarget || entry.path).replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    return progressFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === entryPath);
  };
  const entryIsInsideProgressFolder = (entry: ProjectFileEntry) => {
    const topLevelName = normalizeProjectRelativePath(entry.relativePath).split('/')[0] || '';
    if (PROGRESS_FOLDER_NAME_PATTERN.test(topLevelName)) return true;
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
    return PROTECTED_PROJECT_FOLDER_NAMES.has(normalizedName)
      || PROGRESS_FOLDER_NAME_PATTERN.test(entry.name)
      || Boolean(registeredProgressFolderForEntry(entry));
  };
  const selectedContainsProtectedRenameEntry = selectedEntries.some(isProtectedRenameEntry);
  const selectedProgressFolder = selectedEntries.length === 1 && isFolderLikeEntry(selectedEntries[0]) ? selectedEntries[0] : undefined;
  const selectedRegisteredProgressFolder = registeredProgressFolderForEntry(selectedProgressFolder);
  const selectedEditableProgressFolder = selectedRegisteredProgressFolder?.nodeRole === 'progress' ? selectedRegisteredProgressFolder : undefined;
  const focusedEntry = activeFileEntries.find(entry => entry.relativePath === previewPath);
  const listedPreviewEntry = activeFileEntries.find(entry => entry.relativePath === previewMediaPath && (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'));
  const previewEntry = postTrimPreviewEntry?.relativePath === previewMediaPath ? postTrimPreviewEntry : listedPreviewEntry;
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
  const previewRatingCacheKey = previewEntry ? `${previewEntry.path.replace(/\\/g, '/').toLocaleLowerCase()}|${previewEntry.updatedAt}` : '';
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
    const previousRating = previewRating;
    setPreviewRating(requestedRating);
    setPreviewRatingBusy(true);
    const result = await projectWorkspaceClient.setMediaRating(workspacePath, targetEntry.path, requestedRating);
    setPreviewRatingBusy(false);
    if (!result.success) {
      setPreviewRating(previousRating);
      onNotice(`更新图片标星失败：${result.error || '未知错误'}`);
      return;
    }
    setPreviewRating(result.rating);
    if (previewRatingCacheKey) previewRatingCacheRef.current.set(previewRatingCacheKey, result.rating);
    setFilterRatings(current => ({ ...current, [targetEntry.path]: result.rating }));
    const applyRating = (entries: ProjectFileEntry[]) => entries.map(entry => entry.path === targetEntry.path ? { ...entry, rating: result.rating } : entry);
    setFileEntries(applyRating);
    setSearchEntries(applyRating);
    setScopeEntries(applyRating);
    for (const [cacheKey, entries] of directoryEntriesCacheRef.current) directoryEntriesCacheRef.current.set(cacheKey, applyRating(entries));
    if (previewMetadataResolvedPath === targetEntry.path) {
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
        setPreviewPath('');
        setPreviewPaneOpen(previewPanePinnedRef.current);
        setMetadataPaneOpen(metadataPanePinnedRef.current);
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
    setPreviewMediaPath(targetRelativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(true);
    onNotice('裁剪视频完成');
  };
  const trimPreviewVideo = async (start: number, end: number, saveMode: 'new' | 'replace', operationId: string, sourceDuration: number) => {
    if (!previewEntry || previewEntry.kind !== 'video' || isUnsupportedShortcutContent(previewEntry)) return { success: false, error: '当前视频不可剪辑' };
    const sourceRelativePath = previewEntry.relativePath;
    const result = await projectWorkspaceClient.trimProjectVideo(workspacePath, project.status, project.name, sourceRelativePath, { start, end, saveMode, operationId, sourceDuration });
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
    if (task.state === 'cancelled') {
      onNotice('已取消视频导出');
      return;
    }
    if (task.state === 'failed') {
      onNotice(`视频剪辑失败：${task.error || task.message || '未知错误'}`, 7000);
      return;
    }
    void showCompletedVideoTrim(result || {}, String(task.metadata?.sourceRelativePath || ''));
  }, [active, backgroundTasks, project.name, project.status, showCompletedVideoTrim, workspacePath]);
  const loadPreviewVideoTimelineFrames = useCallback((times: number[]) => {
    if (!previewEntry || previewEntry.kind !== 'video' || isUnsupportedShortcutContent(previewEntry)) return Promise.resolve({ success: false, error: '当前视频不可读取' });
    return projectWorkspaceClient.getProjectVideoTimelineFrames(workspacePath, project.status, project.name, previewEntry.relativePath, times);
  }, [previewEntry?.kind, previewEntry?.relativePath, previewEntry?.viaShortcut, workspacePath, project.status, project.name]);
  const previewMediaEntries = displayedFileEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
  const scrollFileEntryIntoView = useCallback((relativePath: string, align: 'nearest' | 'center' = 'nearest') => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    const fileIndex = displayedFileEntries.findIndex(entry => entry.relativePath === relativePath);
    if (fileIndex < 0 || !container || !surface) return false;

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
    if (revealRenderedNode()) return true;

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
          return;
        }
        attempts += 1;
        if (attempts >= 12) {
          fileRevealPathRef.current = '';
          return;
        }
        fileRevealFrameRef.current = window.requestAnimationFrame(finishReveal);
      };
      fileRevealFrameRef.current = window.requestAnimationFrame(finishReveal);
    });
    return true;
  }, [displayedFileEntries, gridIconSize, viewMode]);
  useEffect(() => () => {
    window.cancelAnimationFrame(fileRevealFrameRef.current);
    fileRevealPathRef.current = '';
  }, []);
  useEffect(() => {
    if (!pendingFileReveal || !scrollFileEntryIntoView(pendingFileReveal.path, pendingFileReveal.align)) return;
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
      });
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
    });
    return () => { active = false; };
  }, [focusedEntry?.path, workspacePath, project.status, project.name]);
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
    selectionAnchorPathRef.current = nextEntry.relativePath;
    setSelectedPaths([nextEntry.relativePath]);
    setPreviewPath(nextEntry.relativePath);
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
  const canExtractScreenshotMainImage = !finalViewOpen && !selectedContainsShortcutContent && selectedScreenshotMainImageEntries.length > 0;
  const selectedResearchTargets = !finalViewOpen && !selectedContainsShortcutContent && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'video' || isFolderLikeEntry(entry)) ? selectedEntries : [];
  const selectedVideoSplitTargets = selectedResearchTargets;
  const selectedOfficeExtractEntries = !finalViewOpen && !selectedContainsShortcutContent && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(isOfficeOpenXmlEntry) ? selectedEntries : [];
  const fileMenuEntrySelected = Boolean(fileMenu && selectedPaths.includes(fileMenu.entry.relativePath));
  const fileMenuTargetPaths = fileMenu
    ? fileMenuEntrySelected ? selectedPaths : [fileMenu.entry.relativePath]
    : selectedPaths;
  const fileMenuContainsShortcutContent = fileMenuTargetPaths.some(path => activeFileEntries.some(entry => entry.relativePath === path && isUnsupportedShortcutContent(entry)));
  const fileMenuContainsUnsupportedShortcutContent = fileMenuTargetPaths.some(path => activeFileEntries.some(entry => entry.relativePath === path && entry.viaShortcut && !entry.viaExternalLink));
  const fileMenuEntries = fileMenuTargetPaths.map(relativePath => activeFileEntries.find(entry => entry.relativePath === relativePath)).filter((entry): entry is ProjectFileEntry => Boolean(entry));
  const fileMenuContainsProtectedRenameEntry = fileMenuEntries.some(isProtectedRenameEntry);
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
    setResearchTargetKind(folderEntries.length > 0 ? 'folder' : 'file');
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
  const openVideoTranscode = async (targetRelativePaths = selectedPaths) => {
    setShowVideoToolsMenu(false);
    if (projectPanelIsRunning('video-transcode')) {
      setPanel('video-transcode');
      return;
    }
    if (!targetRelativePaths.length) {
      onNotice('请先选择包含视频的文件或文件夹');
      return;
    }
    const sequence = ++videoTranscodeInspectionSequenceRef.current;
    setVideoTranscodeTargets([]);
    setVideoTranscodeSourceFolders([]);
    setVideoTranscodeCollecting(true);
    setPanel('video-transcode');
    while (sequence === videoTranscodeInspectionSequenceRef.current) {
      const result = await projectWorkspaceClient.inspectProjectToolSources(workspacePath, project.status, project.name, targetRelativePaths, true);
      if (sequence !== videoTranscodeInspectionSequenceRef.current) return;
      if (!result.success) {
        setVideoTranscodeCollecting(false);
        onNotice(`读取视频索引失败：${result.error || '未知错误'}`);
        return;
      }
      if (result.indexed) {
        setVideoTranscodeTargets(result.videoPaths);
        setVideoTranscodeSourceFolders(result.folderPaths || []);
        setVideoTranscodeCollecting(false);
        if (!result.videoPaths.length) onNotice('所选文件或文件夹中没有视频');
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
    const result = await projectWorkspaceClient.executeManualSelection(project.path, { sourceFolderRelativePath, relativePaths: targetPaths, expectedSignature: preflight.signature, operationId: crypto.randomUUID() });
    if (!result.success || result.cancelled) { onNotice(`选片失败：${result.error || (result.cancelled ? '已取消并回滚本次创建内容' : '未知错误')}`); return; }
    onNotice(`已向“${result.targetFolderRelativePath || result.outputFolderName || '选片输出'}”追加 ${result.copiedCount || 0} 个媒体；附属节点已登记。`);
    setSelectedPaths([]);
    await loadProgressFolders();
    directoryEntriesCacheRef.current.clear();
    refresh('');
  };
  const focusEntry = (entry: ProjectFileEntry) => {
    selectionAnchorPathRef.current = entry.relativePath;
    setSelectedPaths([entry.relativePath]);
    setPreviewPath(entry.relativePath);
    if (itemOpenMode === 'double' || (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video')) {
      setPreviewMediaPath('');
      setPreviewTechnicalMetadata({});
    }
  };
  const activateMediaPreview = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video') return;
    focusEntry(entry);
    setPreviewMediaPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    if (previewPanePinned || !previewPaneAutoOpenSuppressed) setPreviewPaneOpen(true);
  };
  const openPreviewFromMenu = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video') return;
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
  const syncOpenPanesToSelection = (entry: ProjectFileEntry) => {
    if (!previewPaneOpen && !metadataPaneOpen) return;
    const isMedia = entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video';
    setPreviewPath(entry.relativePath);
    if (previewPaneOpen) setPreviewMediaPath(isMedia ? entry.relativePath : '');
    setPreviewTechnicalMetadata({});
  };
  const openEntryDetails = (entry: ProjectFileEntry) => {
    focusEntry(entry);
    setMetadataPaneAutoOpenSuppressed(false);
    setMetadataPaneOpen(true);
  };
  const handleEntryClick = (event: React.MouseEvent | React.KeyboardEvent, entry: ProjectFileEntry) => {
    if (inlineRenamePath === entry.relativePath) return;
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    setOperationDirectoryPath(entry.viaShortcut ? currentRelativePath : projectRelativeParentPath(entry.relativePath));
    const pointerModifiers = entryPointerModifiersRef.current?.path === entry.relativePath ? entryPointerModifiersRef.current : null;
    entryPointerModifiersRef.current = null;
    const range = event.shiftKey || Boolean(pointerModifiers?.range);
    const additive = event.ctrlKey || event.metaKey || Boolean(pointerModifiers?.additive);
    const clickCount = 'detail' in event ? event.detail : 1;
    if (isFolderLikeEntry(entry) && entry.externalLink && !range && !additive && clickCount === 1) {
      focusEntry(entry);
      void openProjectEntry(entry);
      return;
    }
    const intent = fileEntryClickIntent({ openMode: itemOpenMode, selectionCount: selectedPaths.length, range, additive, clickCount });
    if (intent === 'ignore-repeat') return;
    if (intent === 'range-select') {
      selectEntryRange(entry.relativePath, additive);
      syncOpenPanesToSelection(entry);
      return;
    }
    if (intent === 'toggle-select') {
      toggleSelected(entry.relativePath);
      syncOpenPanesToSelection(entry);
      return;
    }
    if (intent === 'open' && isFolderLikeEntry(entry)) { void openProjectEntry(entry); return; }
    focusEntry(entry);
    const isMedia = entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video';
    if (intent === 'focus') {
      if (isMedia && previewPaneOpen) {
        setPreviewMediaPath(entry.relativePath);
        setPreviewTechnicalMetadata({});
      }
      if (metadataPanePinned || !metadataPaneAutoOpenSuppressed) setMetadataPaneOpen(true);
      return;
    }
    if (isMedia) {
      activateMediaPreview(entry);
      if (metadataPanePinned || !previewOnlyOnMediaClick && !metadataPaneAutoOpenSuppressed) setMetadataPaneOpen(true);
      else if (previewOnlyOnMediaClick) setMetadataPaneOpen(false);
      return;
    }
    if (previewPanePinned) setPreviewPaneOpen(true);
    else setPreviewPaneOpen(false);
    if (metadataPanePinned || !metadataPaneAutoOpenSuppressed) setMetadataPaneOpen(true);
    void openProjectEntry(entry);
  };
  const handleEntryDoubleClick = (event: React.MouseEvent, entry: ProjectFileEntry) => {
    if (itemOpenMode !== 'double' || inlineRenamePath === entry.relativePath) return;
    event.preventDefault();
    event.stopPropagation();
    if (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') {
      activateMediaPreview(entry);
      if (metadataPanePinned || !previewOnlyOnMediaClick && !metadataPaneAutoOpenSuppressed) setMetadataPaneOpen(true);
      else if (previewOnlyOnMediaClick) setMetadataPaneOpen(false);
      return;
    }
    void openProjectEntry(entry);
  };
  const handleFileSurfacePointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointerTarget = event.target as HTMLElement;
    // Focusing the entry during the capture phase would blur the rename input
    // before its own pointer handler gets a chance to run.
    if (pointerTarget.closest('[data-inline-rename-input]')) return;
    const target = pointerTarget.closest<HTMLElement>('[data-entry-path]');
    target?.focus({ preventScroll: true });
    if (target?.dataset.entryPath) entryPointerModifiersRef.current = { path: target.dataset.entryPath, additive: event.ctrlKey || event.metaKey, range: event.shiftKey };
  };
  const getEntryDisplayName = (entry: ProjectFileEntry) => (entry.kind === 'shortcut' || entry.externalLink) && entry.name.toLocaleLowerCase().endsWith('.lnk')
    ? entry.name.slice(0, -4)
    : entry.name;
  const getEntryTypeLabel = (entry: ProjectFileEntry) => entry.externalLink ? '外链'
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
    onBlur={cancelInlineRename}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); void commitInlineRename(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelInlineRename(); }
    }}
    className={`${grid ? 'mt-2 w-full text-xs' : 'min-w-0 flex-1 text-sm'} rounded border border-blue-500 bg-white px-1.5 py-0.5 text-slate-800 outline-none ring-2 ring-blue-200`}
  /> : grid ? <p className="mt-2 truncate text-xs font-medium text-slate-700">{getEntryDisplayName(entry)}</p> : <span className="truncate font-medium text-slate-700">{getEntryDisplayName(entry)}</span>;
  const renderEntryIcon = (entry: ProjectFileEntry, large = false, queueOrder = displayedFileEntries.findIndex(candidate => candidate.path === entry.path)) => {
    if (isFolderLikeEntry(entry)) {
      const cover = <FolderCover entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? 320 : 160} queueOrder={queueOrder} large={large} loadEntries={loadDirectoryPreviewEntries}/>;
      return <>{cover}{entry.externalLink && <span aria-label="外链" className="shortcut-cover-badge"><ArrowUpRight size={large ? 16 : 10}/></span>}</>;
    }
    if (entry.kind === 'shortcut') return <ShortcutEntryIcon entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? 320 : 160} queueOrder={queueOrder} large={large} loadEntries={loadDirectoryPreviewEntries}/>;
    if (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') return <><MediaThumbnail entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? gridThumbnailSize : 160} queueOrder={queueOrder} large={large}/>{entry.externalLink && <span aria-label="外链" className="shortcut-cover-badge"><ArrowUpRight size={large ? 16 : 10}/></span>}</>;
    return <SystemFileIcon filePath={entry.path} size={large ? 48 : 28}/>;
  };
  const startEntryDrag = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const requestedPaths = selectedPaths.includes(entry.relativePath) ? selectedPaths : [entry.relativePath];
    const dragPaths = requestedPaths.filter(path => !activeFileEntries.some(candidate => candidate.relativePath === path && isUnsupportedShortcutContent(candidate)));
    if (!dragPaths.length) return;
    internalDragPathsRef.current = dragPaths;
    internalDropHandledRef.current = false;
    if (!selectedPaths.includes(entry.relativePath)) setSelectedPaths([entry.relativePath]);
    const draggedEntry = dragPaths.length === 1 ? activeFileEntries.find(candidate => normalizeProjectRelativePath(candidate.relativePath) === normalizeProjectRelativePath(dragPaths[0])) : undefined;
    if (draggedEntry && isFolderLikeEntry(draggedEntry) && !isUnsupportedShortcutContent(draggedEntry)) window.dispatchEvent(new Event('photoflow:folder-tab-drag-start'));
    projectWorkspaceClient.startProjectFileDrag(workspacePath, project.status, project.name, dragPaths);
  };
  const finishEntryDrag = () => {
    internalDragPathsRef.current = [];
    setDragTargetPath('');
    setRecursiveDropTargetPath(null);
  };
  const hasExternalFiles = (event: React.DragEvent<HTMLElement>) => internalDragPathsRef.current.length === 0 && Array.from(event.dataTransfer.types).includes('Files');
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
  const recursiveDropTargetFromElement = (element: Element | null) => {
    const target = element?.closest<HTMLElement>('[data-recursive-folder-path]');
    if (!target || target.dataset.recursiveFolderReadonly === 'true') return null;
    return {
      relativePath: normalizeProjectRelativePath(target.dataset.recursiveFolderPath || ''),
      label: target.dataset.recursiveFolderLabel || target.dataset.recursiveFolderPath || '项目根目录',
    };
  };
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
    const operation = internalPaths.length ? 'move' : 'import';
    const paths = internalPaths.length ? internalPaths : externalPaths;
    if (!paths.length) return;
    const result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, operation, paths, targetRelativePath);
    if (result.cancelled) { onNotice('导入已取消'); return; }
    if (!result.success) { onNotice(`${operation === 'move' ? '移动' : '导入'}失败：${result.error || '未知错误'}`); return; }
    if (operation === 'move') setCutPaths(current => current.filter(path => !paths.includes(path)));
    setSelectedPaths([]);
    onNotice(`已${operation === 'move' ? '移动' : '导入'} ${result.count} 个项目到 ${targetName}`);
    if (operation === 'import' && projectWorkflows) {
      const folders = trackingSuggestionsForCreatedItems(result.createdItems || []);
      if (folders.length) setPendingProgressFolders(folders);
    }
    refresh();
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
      if (!internalDragPathsRef.current.length) return;
      const element = event.target as HTMLElement | null;
      const folderTarget = element?.closest<HTMLElement>('[data-entry-kind="folder"][data-entry-path]');
      const recursiveTarget = folderTarget ? null : recursiveDropTargetFromElement(element);
      const targetRelativePath = folderTarget?.dataset.entryPath ?? recursiveTarget?.relativePath;
      if (targetRelativePath === undefined || !internalMovePathsForTarget(internalDragPathsRef.current, targetRelativePath).length) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      if (folderTarget) {
        setRecursiveDropTargetPath(null);
        setDragTargetPath(targetRelativePath);
      } else {
        setDragTargetPath('');
        setRecursiveDropTargetPath(normalizeProjectRelativePath(targetRelativePath));
      }
    };
    window.addEventListener('dragover', acceptInternalFolderDrag, true);
    return () => window.removeEventListener('dragover', acceptInternalFolderDrag, true);
  }, []);
  useEffect(() => projectWorkspaceClient.onProjectFileDragEnd(result => {
    window.dispatchEvent(new Event('photoflow:folder-tab-drag-end'));
    const dragPaths = result.paths?.length ? result.paths : [...internalDragPathsRef.current];
    internalDragPathsRef.current = [];
    setDragTargetPath('');
    setRecursiveDropTargetPath(null);
    setSurfaceDropActive(false);
    if (internalDropHandledRef.current) {
      internalDropHandledRef.current = false;
      return;
    }
    if (!result.insideWindow || !dragPaths.length) return;
    const element = document.elementFromPoint(result.clientX, result.clientY);
    const titlebarDropZone = element?.closest<HTMLElement>('[data-folder-tab-drop-zone="true"]');
    if (titlebarDropZone && dragPaths.length === 1) {
      const draggedEntry = activeFileEntries.find(entry => normalizeProjectRelativePath(entry.relativePath) === normalizeProjectRelativePath(dragPaths[0]));
      if (draggedEntry && isFolderLikeEntry(draggedEntry) && !isUnsupportedShortcutContent(draggedEntry) && onOpenDirectoryPage) onOpenDirectoryPage(draggedEntry.relativePath);
      return;
    }
    const folderTarget = element?.closest<HTMLElement>('[data-entry-kind="folder"][data-entry-path]');
    const recursiveTarget = folderTarget ? null : recursiveDropTargetFromElement(element);
    const targetRelativePath = folderTarget?.dataset.entryPath ?? recursiveTarget?.relativePath;
    if (targetRelativePath === undefined) return;
    const movablePaths = internalMovePathsForTarget(dragPaths, targetRelativePath);
    if (!movablePaths.length) return;
    const targetName = folderTarget?.title || recursiveTarget?.label || targetRelativePath.split(/[\\/]/).pop() || '项目根目录';
    void performDirectoryDrop(movablePaths, [], targetRelativePath, targetName);
  }), [activeFileEntries, onOpenDirectoryPage, workspacePath, project.status, project.name, recursiveFlatOpen]);
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
    const result = await projectWorkspaceClient.projectFileOperation(workspacePath, project.status, project.name, 'import', externalPaths, currentRelativePath);
    if (result.cancelled) { onNotice('导入已取消'); return; }
    if (!result.success) { onNotice(`导入失败：${result.error || '未知错误'}`); return; }
    onNotice(`已导入 ${result.count} 个项目`);
    if (projectWorkflows) {
      const folders = trackingSuggestionsForCreatedItems(result.createdItems || []);
      if (folders.length) setPendingProgressFolders(folders);
    }
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
      setGridIconSize(current => rememberFolderGridIconSize(currentRelativePathRef.current, current + direction * intensity));
    };
    zoomSurface.addEventListener('wheel', zoomWithWheel, { capture: true, passive: false });
    return () => {
      zoomSurface.removeEventListener('wheel', zoomWithWheel, true);
    };
  }, [viewMode, folderGridIconSizeStorageKey]);

  const versionTreeStatusLabel = (folder: ProgressFolder) => trackingStateLabel(folder);
  const adoptVersionTreeFolder = async (entry: ProjectFileEntry, mode: 'original' | 'companion' | 'preview', mediaKind: 'image' | 'video') => {
    let sourceProgressId: string | undefined;
    if (mode !== 'original') {
      const candidates = progressFolders.filter(folder => !folder.folderMissing && folder.mediaKind === mediaKind
        && (mode === 'companion' ? folder.nodeRole === 'original' : folder.nodeRole === 'original' || folder.nodeRole === 'progress'));
      if (!candidates.length) {
        onNotice(mode === 'companion' ? '请先设置一个图片原始素材节点。' : `请先设置一个${mediaKind === 'image' ? '图片' : '视频'}原始素材或主进度节点。`);
        return;
      }
      const selected = await appDialog.choice({
        title: mode === 'companion' ? '选择配套素材来源' : '选择预览产物来源',
        message: `“${entry.name}”将连接到哪个来源节点？`,
        choices: candidates.map(folder => ({ value: folder.id, label: folder.displayName })),
        defaultValue: candidates[0].id,
        cancelLabel: '取消',
        cancelDefault: true,
      });
      if (!selected) return;
      sourceProgressId = selected;
    }
    const result = await projectWorkspaceClient.adoptVersionTreeFolder(workspacePath, project.status, {
      projectName: project.name,
      relativePath: entry.relativePath,
      mode,
      mediaKind,
      sourceProgressId,
    });
    if (!result.success || !result.progressFolder) {
      onNotice(`纳入版本树失败：${result.error || '未知错误'}`, 5000);
      return;
    }
    await loadProgressFolders();
    onNotice(mode === 'original' ? `已将“${entry.name}”设为${mediaKind === 'image' ? '图片' : '视频'}原始素材。` : mode === 'companion' ? `已将“${entry.name}”设为配套素材。` : `已将“${entry.name}”设为预览产物。`);
  };
  const renderVersionTreeEntry = (entry: ProjectFileEntry, progressFolder?: ProgressFolder, sourceKind?: 'image' | 'video') => {
    const selected = selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath;
    const workflow = progressFolder?.nodeRole === 'workflow' && progressFolder.artifactKind === 'team_workspace';
    const previewArtifact = progressFolder?.nodeRole === 'artifact' && progressFolder.artifactKind === 'preview';
    const canonicalName = ['raw', 'jpg', 'mov'].includes(entry.name.toLocaleLowerCase()) ? entry.name.toLocaleUpperCase() : entry.name;
    const statusLabel = progressFolder
      ? progressFolder.nodeRole === 'original' ? '原始素材'
        : progressFolder.nodeRole === 'selection' || progressFolder.relationKind === 'auxiliary' ? '选片辅助节点'
          : previewArtifact ? '预览产物'
            : workflow ? '协作工作区'
              : versionTreeStatusLabel(progressFolder)
      : sourceKind === 'image' ? '原始图片素材'
        : sourceKind === 'video' ? '原始视频素材'
          : entry.name === '团片协作' ? '协作工作区'
            : getEntryTypeLabel(entry);
    return <div
      role="button"
      tabIndex={0}
      draggable={false}
      onDragOver={event => handleEntryDragOver(event, entry)}
      onDragLeave={event => handleEntryDragLeave(event, entry)}
      onDrop={event => void handleEntryDrop(event, entry)}
      data-entry-kind={entry.kind}
      data-entry-path={entry.relativePath}
      onMouseEnter={() => prefetchDirectory(entry)}
      onClick={event => handleEntryClick(event, entry)}
      onDoubleClick={event => handleEntryDoubleClick(event, entry)}
      onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }}
      onContextMenu={event => openFileMenu(event, entry)}
      title={entry.name}
      className={`group relative min-w-0 cursor-default rounded-lg border p-2 text-left transition ${progressFolder ? 'border-transparent bg-slate-500/[0.025] hover:border-blue-300/60 hover:bg-blue-500/[0.04]' : 'overflow-hidden border-transparent hover:bg-blue-50'} ${selected ? 'border-blue-400/80 bg-blue-500/[0.07] ring-1 ring-blue-400/70 shadow-sm' : ''} ${previewArtifact ? 'border-amber-400/20' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'border-blue-500 bg-blue-100 ring-2 ring-blue-500' : ''}`}
    >
      <span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span>
      {progressFolder && (progressFolder.nodeRole === 'progress' ? <button type="button" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); openMarkProgress(entry); }} title={`编辑 V${progressFolder.versionKey} 进度`} aria-label={`编辑 V${progressFolder.versionKey} 进度`} className="absolute right-3 top-3 z-10 rounded-full bg-blue-600 px-2 py-1 text-[10px] font-bold text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-300">{versionTreeNodeBadgeLabel(progressFolder)}</button> : <span className={`absolute right-3 top-3 z-10 rounded-full px-2 py-1 text-[10px] font-bold shadow-sm ${progressFolder.nodeRole === 'selection' || progressFolder.relationKind === 'auxiliary' || workflow ? 'bg-violet-600 text-white' : previewArtifact ? 'bg-amber-500 text-white' : 'bg-slate-700 text-white'}`}>{versionTreeNodeBadgeLabel(progressFolder)}</span>)}
      {!progressFolder && sourceKind && <span className="absolute right-3 top-3 z-10 rounded-full bg-slate-700 px-2 py-1 text-[10px] font-bold text-white shadow-sm">原始素材</span>}
      {!progressFolder && entry.name === '团片协作' && <span className="absolute right-3 top-3 z-10 rounded-full bg-violet-600 px-2 py-1 text-[10px] font-bold text-white shadow-sm">协作分支</span>}
      <div className={`relative flex aspect-square items-center justify-center ${previewArtifact ? 'rounded-xl bg-amber-500/[0.035]' : ''}`}>{renderEntryIcon(entry, true)}</div>
      {progressFolder ? <p className="mt-1 truncate text-xs font-medium text-slate-700" title={entry.name}>{canonicalName}</p> : renderEntryName(entry, true)}
      <p className={`mt-0.5 truncate text-[10px] ${progressFolder?.trackingState === 'needs_repair' ? 'font-bold text-amber-600' : 'text-slate-400'}`}><span aria-hidden className="mr-1">●</span>{statusLabel}</p>
    </div>;
  };

  const progressCompareCandidates = progressCompare ? [...progressCompare.matches, ...progressCompare.suggestions] : [];
  const progressCompareAcceptedReferences = new Set(progressCompareCandidates.filter(match => progressCompare?.acceptedSources.includes(match.source)).map(match => match.reference));
  const progressCompareMissingReferences = progressCompare?.unmatchedReferences.filter(reference => !progressCompareAcceptedReferences.has(reference)) || [];
  const progressCompareNewSources = progressCompare ? progressCompareNewSourcesFor(progressCompare) : [];
  const progressCompareListItems = progressCompare ? buildProgressCompareListItems(progressCompare, progressCompareFilter) : [];
  const activeProgressCompareItem = progressCompareListItems.find(item => item.key === activeProgressCompareItemKey);
  const photoshopToolbarAvailable = photoshopAvailable && !selectedEntries.some(entry => entry.viaShortcut && !entry.viaExternalLink) && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(isPhotoshopOpenEntry);
  // Do not recursively inspect folders just to decide whether contextual tools
  // should be visible. Folder-based tools validate and collect their inputs only
  // after the user explicitly starts that workflow.
  const pngConverterToolbarAvailable = !finalViewOpen && !selectedContainsShortcutContent && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length
    && selectedEntries.some(entry => isFolderLikeEntry(entry) || entry.extension.toLocaleLowerCase() === '.png');
  const videoToolsToolbarAvailable = !finalViewOpen && !selectedContainsShortcutContent && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length
    && selectedEntries.every(entry => isFolderLikeEntry(entry) || entry.kind === 'video');
  const fileMenuHasVideoTarget = !fileMenuContainsShortcutContent && fileMenuEntries.length > 0 && fileMenuEntries.every(entry => isFolderLikeEntry(entry) || entry.kind === 'video');
  const fileMenuHasPngTarget = !fileMenuContainsShortcutContent && fileMenuEntries.some(entry => isFolderLikeEntry(entry) || entry.extension.toLocaleLowerCase() === '.png');
  const fileMenuHasVideoSplitTarget = !finalViewOpen && fileMenuHasVideoTarget;
  const fileMenuOfficeEntries = !finalViewOpen && !fileMenuContainsShortcutContent && fileMenuEntries.length > 0 && fileMenuEntries.every(isOfficeOpenXmlEntry) ? fileMenuEntries : [];
  const fileMenuHasToolActions = Boolean(fileMenu && (fileMenuHasVideoTarget || fileMenuHasPngTarget || fileMenuScreenshotMainImageEntries.length || fileMenuOfficeEntries.length));
  const selectedCanSetVersionProgress = Boolean(projectWorkflows && selectedProgressFolder && !selectedRegisteredProgressFolder && !isUnsupportedShortcutContent(selectedProgressFolder));
  const versionManagementToolbarAvailable = Boolean(selectedEditableProgressFolder) || selectedCanSetVersionProgress || selectedEntries.length === 1 && hasVersionProgressForEntry(selectedEntries[0]);
  const teamRetouchToolbarAvailable = teamRetouchInstalled && (selectedEntries.some(entry => entry.kind === 'image') || teamRetouchHistory.length > 0);
  const projectToolbarAvailability: Record<ProjectToolbarActionId, boolean> = {
    'filename-selection': true,
    'select-media': canSelectMedia,
    'video-tools': selectedResearchTargets.length > 0 || videoToolsToolbarAvailable || selectedVideoSplitTargets.length > 0,
    'image-tools': pngConverterToolbarAvailable || canExtractScreenshotMainImage,
    photoshop: photoshopToolbarAvailable,
    'office-extract': selectedOfficeExtractEntries.length > 0,
    'version-management': versionManagementToolbarAvailable,
    'team-retouch': teamRetouchToolbarAvailable,
  };
  const unavailableProjectToolbarTitle = (label: string, reason: string) => `${label}，${reason}`;
  const projectToolbarButtons: Record<ProjectToolbarActionId, React.ReactNode> = {
    'filename-selection': <button onClick={() => togglePanel('match')} title="从文件名选片" aria-label="从文件名选片" className="project-action-button"><FileText size={16}/>从文件名选片</button>,
    'select-media': <button disabled={!canSelectMedia} title={canSelectMedia ? '选片：把所选素材加入图片或视频选片结果' : unavailableProjectToolbarTitle('选片', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '需选择选片源素材使用')} aria-label="选片" onClick={() => void selectMediaFiles()} className="project-action-button"><CheckCircle2 size={16}/>选片</button>,
    'video-tools': <div className="project-toolbar-tool-group relative" onClick={event => event.stopPropagation()}><button type="button" disabled={!projectToolbarAvailability['video-tools']} onClick={() => { const next = !showVideoToolsMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowVideoToolsMenu(next); }} title="视频工具" aria-label="视频工具" aria-haspopup="menu" aria-expanded={showVideoToolsMenu} className={`project-action-button ${showVideoToolsMenu || panel === 'research' || panel === 'video-transcode' || panel === 'video-split' ? 'bg-blue-50 text-blue-600' : ''}`}><Video size={16}/>视频工具<ChevronDown size={13}/></button>{showVideoToolsMenu && <div className="project-toolbar-tool-submenu absolute left-0 top-full z-50 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl"><button type="button" disabled={!selectedResearchTargets.length} title={selectedResearchTargets.length ? `从所选 ${selectedResearchTargets.length} 个视频或文件夹中提取代表性画面` : '请选择视频或文件夹'} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); if (selectedResearchTargets.length) void openResearchForEntries(selectedResearchTargets); }} className="project-menu-item"><Video size={14}/>截取分镜帧</button><button type="button" disabled={!videoToolsToolbarAvailable} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); void openVideoTranscode(); }} className="project-menu-item"><Gauge size={14}/>视频转码</button><button type="button" disabled={!selectedVideoSplitTargets.length} title={selectedVideoSplitTargets.length ? `将所选 ${selectedVideoSplitTargets.length} 个视频或文件夹中的视频无损切成约 3.95 GB 的连续分段` : '请选择视频或文件夹'} onClick={event => { event.stopPropagation(); setShowVideoToolsMenu(false); setShowToolbarOverflowMenu(false); if (!selectedVideoSplitTargets.length) { onNotice('请先选择视频或文件夹'); return; } setVideoSplitTargets(selectedVideoSplitTargets.map(entry => entry.path)); setPanel('video-split'); }} className="project-menu-item"><Cut size={14}/>视频切割</button></div>}</div>,
    'image-tools': <div className="project-toolbar-tool-group relative" onClick={event => event.stopPropagation()}><button type="button" disabled={!projectToolbarAvailability['image-tools']} onClick={() => { const next = !showImageToolsMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowImageToolsMenu(next); }} title="图片工具" aria-label="图片工具" aria-haspopup="menu" aria-expanded={showImageToolsMenu} className={`project-action-button ${showImageToolsMenu || panel === 'converter' || panel === 'screenshot-main-image' ? 'bg-blue-50 text-blue-600' : ''}`}><ImageIcon size={16}/>图片工具<ChevronDown size={13}/></button>{showImageToolsMenu && <div className="project-toolbar-tool-submenu absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-xl"><button type="button" disabled={!pngConverterToolbarAvailable} onClick={event => { event.stopPropagation(); setShowImageToolsMenu(false); setShowToolbarOverflowMenu(false); void openPngConverter(selectedEntries.map(entry => entry.path)); }} title={pngConverterToolbarAvailable ? selectedEntries.length > 1 ? `PNG 转 JPG：转换所选 ${selectedEntries.length} 个文件或文件夹中的 PNG` : 'PNG 转 JPG：转换所选文件或文件夹中的 PNG' : unavailableProjectToolbarTitle('PNG 转 JPG', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '请选择 PNG 文件或文件夹')} className="project-menu-item"><ImageIcon size={14}/>PNG 转 JPG</button><button type="button" disabled={!canExtractScreenshotMainImage} onClick={event => { event.stopPropagation(); setShowImageToolsMenu(false); setShowToolbarOverflowMenu(false); if (!selectedScreenshotMainImageEntries.length) { onNotice('请先选择要提取主图的截图'); return; } openScreenshotMainImage(selectedScreenshotMainImageEntries); }} title={canExtractScreenshotMainImage ? selectedScreenshotMainImageEntries.length > 1 ? `提取截图主图：批量识别并裁出所选 ${selectedScreenshotMainImageEntries.length} 张截图中的主要图片区域` : '提取截图主图：识别并裁出所选截图中的主要图片区域' : unavailableProjectToolbarTitle('提取截图主图', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '需选择截图图片使用')} className="project-menu-item"><Crop size={14}/>提取截图主图{selectedScreenshotMainImageEntries.length > 1 ? `（${selectedScreenshotMainImageEntries.length} 张）` : ''}</button></div>}</div>,
    photoshop: <button disabled={!photoshopToolbarAvailable} onClick={() => void openProjectEntriesInPhotoshop(selectedEntries)} title={photoshopToolbarAvailable ? selectedEntries.length > 1 ? `用 Photoshop 打开：把所选 ${selectedEntries.length} 个图片、RAW 或 Photoshop 文档发送到 Photoshop` : '用 Photoshop 打开所选图片或文档' : unavailableProjectToolbarTitle('用 Photoshop 打开', !photoshopAvailable ? '未检测到 Photoshop' : selectedContainsShortcutContent ? '快捷方式内容暂不支持' : '需选择图片、RAW 或 PSD/PSB 使用')} aria-label="在 Photoshop 中打开所选图片、RAW 或 Photoshop 文档" className="project-action-button"><PhotoshopIcon size={16}/>用 Photoshop 打开{selectedEntries.length > 1 && photoshopToolbarAvailable ? `（${selectedEntries.length} 个）` : ''}</button>,
    'office-extract': <button type="button" disabled={!selectedOfficeExtractEntries.length} onClick={() => openOfficeImageExtractor(selectedOfficeExtractEntries)} aria-pressed={panel === 'office-extract'} title={selectedOfficeExtractEntries.length ? `从所选 ${selectedOfficeExtractEntries.length} 个 Office 文档提取图片` : '请选择 Office 文档'} className={`project-action-button ${panel === 'office-extract' ? 'bg-blue-50 text-blue-600' : ''}`}><FileImage size={16}/>提取文档图片</button>,
    'version-management': selectedEditableProgressFolder ? selectedEditableProgressFolder.trackingState === 'needs_repair' ? <button onClick={() => void openProgressRepair(selectedEditableProgressFolder)} title="修复版本批次：继续处理未完成的版本提交操作" aria-label="修复版本批次" className="project-action-button !text-amber-600"><RefreshCw size={16}/>修复版本批次</button> : <button disabled={selectedEditableProgressFolder.trackingState === 'committing'} onClick={() => void openMarkProgress(selectedProgressFolder!)} title={selectedEditableProgressFolder.trackingState === 'committing' ? unavailableProjectToolbarTitle('版本管理', '版本批次正在提交') : '修改当前版本进度'} aria-label="修改进度" className="project-action-button"><GitBranch size={16}/>{selectedEditableProgressFolder.trackingState === 'committing' ? '正在提交' : '修改进度'}</button> : selectedCanSetVersionProgress ? <button onClick={() => void openMarkProgress(selectedProgressFolder!)} title="将所选文件夹纳入版本管理" aria-label="纳入版本管理" className="project-action-button"><GitBranch size={16}/>纳入版本管理</button> : selectedEntries.length === 1 && hasVersionProgressForEntry(selectedEntries[0]) ? <button onClick={() => openVersions()} title="查看和管理素材版本" aria-label="版本管理" className="project-action-button"><GitBranch size={16}/>版本管理</button> : <button disabled title={unavailableProjectToolbarTitle('版本管理', '需选择版本文件夹或已纳入版本的媒体')} aria-label="版本管理" className="project-action-button"><GitBranch size={16}/>版本管理</button>,
    'team-retouch': <button type="button" disabled={!teamRetouchToolbarAvailable || teamRetouchOpening} onClick={() => void openTeamRetouch()} title={!teamRetouchInstalled ? unavailableProjectToolbarTitle('团片协作', '组件未安装') : !teamRetouchToolbarAvailable ? unavailableProjectToolbarTitle('团片协作', '需选择图片使用') : teamRetouchOpening ? unavailableProjectToolbarTitle('团片协作', '正在加载') : selectedEntries.some(entry => entry.kind === 'image') ? '团片协作：打开协作工作区并加入所选图片' : `团片协作：打开项目已有的 ${teamRetouchHistory.length} 张协作图片`} className="project-action-button">{teamRetouchOpening ? <Loader2 size={16} className="animate-spin"/> : <UsersRound size={16}/>}团片协作{teamRetouchHistory.length ? `（${teamRetouchHistory.length} 张）` : ''}</button>,
  };
  const hiddenProjectToolbarActions = new Set(projectToolbar.hidden);
  const visibleProjectToolbarActionIds = projectToolbar.order.filter(id => !hiddenProjectToolbarActions.has(id) && (!projectToolbar.onlyShowAvailable || projectToolbarAvailability[id]));
  const hasProjectToolbarActions = visibleProjectToolbarActionIds.length > 0;
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

  return (
    <div ref={projectWorkspaceRef} className="flex h-full w-full min-w-0 flex-col animate-in fade-in duration-300">
      {pendingProgressFolders.length > 0 && !progressSetup && <div role="dialog" aria-modal="true" aria-label="接入项目跟踪" className="fixed inset-0 z-[339] flex items-center justify-center bg-slate-950/45 p-4"><div className="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-5 py-4"><h3 className="font-bold text-slate-800">纳入版本管理</h3><p className="mt-1 text-xs leading-5 text-slate-500">将现有文件夹登记为版本。</p></header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5">{pendingProgressFolders.map(folder => <div key={folder.relativePath} className="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-3"><Folder size={18} className="shrink-0 text-blue-500"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-700" title={folder.relativePath}>{folder.name}</p><p className="mt-0.5 truncate text-xs text-slate-400">{folder.relativePath} · 建议按{folder.mediaKind === 'video' ? '视频' : '图片'}处理</p></div><button type="button" className="dialog-secondary shrink-0" onClick={() => { const relativePath = folder.relativePath; setPendingProgressFolders(current => current.filter(item => item.relativePath !== relativePath)); openMarkProgress({ name: folder.name, path: `${project.path}/${relativePath}`, relativePath, kind: 'folder', extension: '', size: 0, createdAt: Date.now(), updatedAt: Date.now() }, folder.mediaKind); }}>设置版本</button></div>)}</div>
        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><p className="text-xs text-slate-500">也可右键文件夹选择“纳入版本管理”。</p><button type="button" onClick={() => setPendingProgressFolders([])} className="dialog-secondary">暂不设置</button></footer>
      </div></div>}
      {fileMenu && createPortal(<ViewportContextMenu x={fileMenu.x} y={fileMenu.y} widthClass="w-52" allowSubmenus>
        {isFolderLikeEntry(fileMenu.entry) && !isUnsupportedShortcutContent(fileMenu.entry) && onOpenDirectoryPage && <><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); onOpenDirectoryPage(entry.relativePath); }}><FolderPlus size={14}/>在新标签页打开</button><div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && isFolderLikeEntry(fileMenu.entry) && !fileMenuVersionTreeFolder && <><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openMarkProgress(entry); }}><GitBranch size={14}/>纳入版本管理…</button><div className="group/submenu relative"><button type="button" className="project-menu-item w-full"><FolderPlus size={14}/>纳入版本树<span className="ml-auto">›</span></button><div className="invisible absolute left-full top-0 z-[302] ml-1 w-56 rounded-lg border border-slate-200 bg-white p-1 opacity-0 shadow-xl transition group-hover/submenu:visible group-hover/submenu:opacity-100"><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void adoptVersionTreeFolder(entry, 'original', 'image'); }}>设为图片原始素材</button><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void adoptVersionTreeFolder(entry, 'original', 'video'); }}>设为视频原始素材</button><div className="my-1 border-t border-slate-100"/><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void adoptVersionTreeFolder(entry, 'companion', 'image'); }}>设为图片配套素材…</button><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void adoptVersionTreeFolder(entry, 'preview', 'image'); }}>设为图片预览产物…</button><button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void adoptVersionTreeFolder(entry, 'preview', 'video'); }}>设为视频预览产物…</button></div></div><div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && fileMenuRegisteredProgressFolder && <><button disabled={fileMenuRegisteredProgressFolder.trackingState === 'committing' || fileMenuRegisteredProgressFolder.trackingState === 'needs_repair'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openMarkProgress(entry); }}><GitBranch size={14}/>修改进度</button>{progressTrackingAction(fileMenuRegisteredProgressFolder) && <button disabled={progressSubmitting || Boolean(progressTask) || fileMenuRegisteredProgressFolder.trackingState === 'committing'} title="按已持久化策略刷新当前主分支版本跟踪" className="project-menu-item" onClick={() => { const progressFolder = fileMenuRegisteredProgressFolder; setFileMenu(null); void refreshProgressTracking(progressFolder); }}><RefreshCw size={14}/>{progressTrackingRefreshLabel(fileMenuRegisteredProgressFolder)}</button>}<div className="my-1 border-t border-slate-100"/></>}
        {gatherToProject && <><button disabled={fileMenuContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); startGatherInspiration(targets); }}><FolderInput size={14}/>添加到项目{inspirationTargetProject ? `“${inspirationTargetProject.name}”` : '…'}</button>{inspirationTargetProject && <button disabled={fileMenuContainsShortcutContent || gatheringInspiration} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); setGatherPickerPaths(targets); }}><ChevronDown size={14}/>选择其他项目…</button>}<div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && canSelectFileMenuMedia && <><button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); selectMediaFiles(targets); }}><CheckCircle2 size={14}/>选片</button><div className="my-1 border-t border-slate-100"/></>}
        {(fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openPreviewFromMenu(entry); }}><PanelLeftOpen size={14}/>预览</button>}
        {!isFolderLikeEntry(fileMenu.entry) && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openProjectEntry(entry); }}><ExternalLink size={14}/>{fileMenu.entry.kind === 'shortcut' ? '打开快捷方式' : '用默认方式打开'}</button>}
        {fileMenu.entry.externalLink && <><button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; setFileMenu(null); void relinkExternalFolder(path); }}><RefreshCw size={14}/>重新定位外链</button><button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; setFileMenu(null); void materializeExternalLinks([path]); }}><FolderInput size={14}/>移动外链{fileMenu.entry.externalLinkTargetKind === 'file' ? '文件' : '文件夹'}到项目内</button></>}
        {fileMenuHasVideoTarget && <div className="group/submenu relative"><button type="button" className="project-menu-item w-full"><Video size={14}/>视频工具<span className="ml-auto">›</span></button><div className="invisible absolute left-full top-0 z-[302] ml-1 w-52 rounded-lg border border-slate-200 bg-white p-1 opacity-0 shadow-xl transition group-hover/submenu:visible group-hover/submenu:opacity-100"><button className="project-menu-item" onClick={() => { const entries = fileMenuEntries; setFileMenu(null); void openResearchForEntries(entries); }}><Video size={14}/>截取分镜帧</button><button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); void openVideoTranscode(targets); }}><Gauge size={14}/>视频转码</button><button disabled={!fileMenuHasVideoSplitTarget} title={fileMenuHasVideoSplitTarget ? `将所选 ${fileMenuEntries.length} 个视频或文件夹中的视频无损切成约 3.95 GB 的连续分段` : '请选择视频或文件夹'} className="project-menu-item" onClick={() => { const targets = fileMenuEntries.map(entry => entry.path); setFileMenu(null); if (!targets.length) return; setVideoSplitTargets(targets); setPanel('video-split'); }}><Cut size={14}/>视频切割</button></div></div>}
        {(fileMenuHasPngTarget || fileMenuScreenshotMainImageEntries.length > 0) && <div className="group/submenu relative"><button type="button" className="project-menu-item w-full"><ImageIcon size={14}/>图片工具<span className="ml-auto">›</span></button><div className="invisible absolute left-full top-0 z-[302] ml-1 w-52 rounded-lg border border-slate-200 bg-white p-1 opacity-0 shadow-xl transition group-hover/submenu:visible group-hover/submenu:opacity-100">{fileMenuHasPngTarget && <button className="project-menu-item" onClick={() => { const targets = fileMenuEntries.map(entry => entry.path); setFileMenu(null); void openPngConverter(targets); }}><ImageIcon size={14}/>PNG 转 JPG</button>}<button disabled={!fileMenuScreenshotMainImageEntries.length} title={fileMenuScreenshotMainImageEntries.length ? fileMenuScreenshotMainImageEntries.length > 1 ? `批量提取 ${fileMenuScreenshotMainImageEntries.length} 张截图中的主图` : '提取截图中的主图' : '需选择截图图片使用'} className="project-menu-item" onClick={() => { const entries = fileMenuScreenshotMainImageEntries; setFileMenu(null); openScreenshotMainImage(entries); }}><Crop size={14}/>提取截图主图{fileMenuScreenshotMainImageEntries.length > 1 ? `（${fileMenuScreenshotMainImageEntries.length} 张）` : ''}</button></div></div>}
        {officeImageExtractorAvailable && fileMenuOfficeEntries.length > 0 && <button className="project-menu-item" onClick={() => { const entries = fileMenuOfficeEntries; setFileMenu(null); openOfficeImageExtractor(entries); }}><FileImage size={14}/>提取文档图片{fileMenuOfficeEntries.length > 1 ? `（${fileMenuOfficeEntries.length} 个文档）` : ''}</button>}
        {photoshopAvailable && isPhotoshopOpenEntry(fileMenu.entry) && <button disabled={fileMenuContainsUnsupportedShortcutContent} title={fileMenuContainsUnsupportedShortcutContent ? '普通快捷方式中的文件暂不支持直接发送到 Photoshop' : undefined} className="project-menu-item" onClick={() => { const entries = selectedPaths.includes(fileMenu.entry.relativePath) ? selectedEntries.filter(isPhotoshopOpenEntry) : [fileMenu.entry]; setFileMenu(null); void openProjectEntriesInPhotoshop(entries); }}><PhotoshopIcon size={14}/>用 Photoshop 打开{selectedPaths.includes(fileMenu.entry.relativePath) && selectedEntries.filter(isPhotoshopOpenEntry).length > 1 ? `（${selectedEntries.filter(isPhotoshopOpenEntry).length} 个）` : ''}</button>}
        {fileMenuHasToolActions && <div className="my-1 border-t border-slate-100"/>}
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent || fileMenuContainsProtectedRenameEntry} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : fileMenuContainsProtectedRenameEntry ? '该文件夹由项目工作流管理，不能普通重命名' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); beginRename(targets); }}><Edit size={14}/>{fileMenuTargetPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('cut', undefined, targets); }}><Cut size={14}/>剪切</button>
        <button disabled={fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('copy', undefined, targets); }}><Copy size={14}/>复制</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent || !clipboardHasFiles} title={fileMenuContainsShortcutContent ? '快捷方式指向的外部文件夹是只读浏览区域' : finalViewOpen ? '喜爱图片浏览为只读视图' : clipboardHasFiles ? '粘贴到此文件所在文件夹' : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('paste'); }}><ClipboardPaste size={14}/>粘贴</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item project-menu-danger" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('trash', undefined, targets); }}><Trash2 size={14}/>删除</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openEntryDetails(entry); }}><Info size={14}/>详细信息</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); copyEntryPath(entry); }}><FileText size={14}/>{isFolderLikeEntry(fileMenu.entry) ? '复制文件夹地址' : '复制文件地址'}</button>
        <button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; if (fileMenuEntrySelected) setSelectedPaths(current => current.filter(item => item !== path)); else { selectionAnchorPathRef.current = path; setSelectedPaths(current => [...current, path]); requestFileReveal(path); } setFileMenu(null); }}>{fileMenuEntrySelected ? <X size={14}/> : <CheckSquare size={14}/>} {fileMenuEntrySelected ? '取消选择' : '选择'}</button>
        {projectWorkflows && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <div className="my-1 border-t border-slate-100"/>}
        {projectWorkflows && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <><button disabled={!hasVersionProgressForEntry(fileMenu.entry)} title={hasVersionProgressForEntry(fileMenu.entry) ? '管理素材的当前版本和历史版本' : '请先标记或导入版本进度'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openVersions(entry); }}><GitBranch size={14}/>版本管理</button>{teamRetouchAvailable && fileMenu.entry.kind === 'image' && <button disabled={!teamRetouchInstalled || teamRetouchOpening} title={!teamRetouchInstalled ? '正在检查团片协作组件' : teamRetouchOpening ? '正在加载团片协作数据' : '团片协作'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openTeamRetouch(entry); }}>{teamRetouchOpening || !teamRetouchInstalled && componentsLoading ? <Loader2 size={14} className="animate-spin"/> : <UsersRound size={14}/>}团片协作</button>}</>}
      </ViewportContextMenu>, document.body)}
      {surfaceMenu && createPortal(<ViewportContextMenu x={surfaceMenu.x} y={surfaceMenu.y} widthClass="w-56" allowSubmenus>
        {surfaceMenu.kind === 'version-tree-layout' && <><button type="button" title="恢复版本树标准排版" className="project-menu-item" onClick={() => void restoreStandardVersionTreeLayout()}><RefreshCw size={14}/>刷新</button><div className="my-1 border-t border-slate-100"/></>}
        <p className="truncate px-2 py-1 text-[11px] font-bold text-slate-400" title={surfaceMenu.targetLabel}>在“{surfaceMenu.targetLabel}”中操作</p>
        <div className="group/submenu relative"><button className="project-menu-item w-full"><FolderPlus size={14}/>新建<span className="ml-auto">›</span></button><div className="invisible absolute left-full top-0 z-[302] ml-1 w-72 rounded-lg border border-slate-200 bg-white p-1 opacity-0 shadow-xl transition group-hover/submenu:visible group-hover/submenu:opacity-100">{projectWorkflows && !recursiveFlatOpen && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void openProgressSetup('create'); }}><FolderPlus size={14}/>新建进度</button>}<button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void createFolder(target); }}><Folder size={14}/>新建文件夹</button><div className="my-1 border-t border-slate-100"/><div className="flex items-center justify-between px-2 pb-1 pt-1"><p className="text-[11px] font-bold text-slate-400">Windows 文件类型</p><button type="button" title="重新扫描 Windows 新建文件类型" disabled={shellNewTypesLoading} onClick={() => void loadShellNewTypes(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"><RefreshCw size={12} className={shellNewTypesLoading ? 'animate-spin' : ''}/></button></div><div className="max-h-72 overflow-y-auto">{shellNewTypesLoading && <p className="px-2 py-2 text-xs text-slate-400">正在读取系统新建菜单…</p>}{!shellNewTypesLoading && shellNewTypes.map(type => <button key={type.id} className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void createShellNewFile(type, target); }}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-4 w-4 shrink-0 object-contain"/> : <File size={14} className="shrink-0"/>}<span className="min-w-0 flex-1 truncate">{type.label}</span><span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{type.extension}</span></button>)}{!shellNewTypesLoading && shellNewTypesLoaded && !shellNewTypes.length && <p className="px-2 py-2 text-xs text-slate-400">系统没有可用的新建文件类型</p>}</div></div></div>
        <div className="group/submenu relative"><button className="project-menu-item w-full"><FolderInput size={14}/>导入<span className="ml-auto">›</span></button><div className="invisible absolute left-full top-0 z-[302] ml-1 w-52 rounded-lg border border-slate-200 bg-white p-1 opacity-0 shadow-xl transition group-hover/submenu:visible group-hover/submenu:opacity-100">{projectWorkflows && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); setPanel('import'); }}><MemoryStick size={14}/>从 SD 卡导入</button>}<button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); openManualImport(projectWorkflows ? 'original' : 'files', [], target); }}><FolderInput size={14}/>导入</button></div></div>
        {projectWorkflows && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); togglePanel('match'); }}><FileText size={14}/>从文件名选片</button>}
        <div className="my-1 border-t border-slate-100"/>
        <button disabled={!clipboardHasFiles} title={clipboardHasFiles ? `粘贴到“${surfaceMenu.targetLabel}”` : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void runFileOperation('paste', undefined, [], target); }}><ClipboardPaste size={14}/>粘贴</button>
        <button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void copyCurrentDirectoryPath(target); }}><FileText size={14}/>复制此文件夹地址</button>
        <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void materializeExternalLinks(); }}><FolderInput size={14}/>移动所有外链文件夹到项目内</button>
        {projectWorkflows && <><div className="my-1 border-t border-slate-100"/><button className="project-menu-item project-menu-danger" onClick={() => { setSurfaceMenu(null); setPanel('trash'); }}><Trash2 size={14}/>将项目移入回收站</button></>}
      </ViewportContextMenu>, document.body)}
      <div ref={projectColumnLayoutRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div ref={filesColumnRef} style={previewPaneOpen || metadataPaneOpen ? { width: displayedColumnWidths.files } : undefined} onPointerDown={startSelectionDrag} onPointerMove={updateSelectionDrag} onPointerUp={finishSelectionDrag} onPointerCancel={cancelSelectionDrag} onLostPointerCapture={cancelSelectionDrag} className={`relative flex min-h-0 flex-col gap-3 overscroll-contain [overflow-anchor:none] px-6 ${versionTreeOpen ? 'overflow-hidden pb-0' : 'overflow-auto pb-6'} ${previewPaneOpen || metadataPaneOpen ? 'shrink-0' : 'flex-1'}`}>
        {selectionBox && <div aria-hidden className="marquee-logical-canvas pointer-events-none absolute left-0 top-0 z-20" style={{ width: selectionCanvasSize.width, height: selectionCanvasSize.height }}><div className="absolute border border-blue-500 bg-blue-400/15" style={selectionBox}/></div>}
      {active && activeView === 'project' && (viewportStatus || folderOnlyGridCount > 0) && createPortal(<div role="status" className="pointer-events-none fixed bottom-2 z-[35] flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-lg border border-white/10 bg-slate-950/80 px-3.5 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md" style={{ right: Math.max(12, projectLayoutWidth - displayedColumnWidths.files + 12) }}>
        {viewportStatus?.captureDateTime && <>
          <span className="truncate" title={viewportStatus.captureDateTime}>{viewportStatus.captureDateTime}</span>
          <span aria-hidden className="h-3 w-px shrink-0 bg-white/25"/>
        </>}
        <span className="shrink-0 font-mono font-bold tabular-nums">{viewportStatus ? `${viewportStatus.fileNumber}/${viewportStatus.total}` : folderOnlyGridCount}</span>
      </div>, document.body)}
      <div className="flex flex-wrap items-start justify-between gap-3 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-bold text-slate-800">{browserRootLabel}</h2>
          {projectWorkflows && <div className="relative" onClick={event => event.stopPropagation()}>
            <button onClick={() => { const next = !showStatusMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowStatusMenu(next); }} className="flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-600 hover:bg-blue-100">{projectStatusLabel(project.status)} <ChevronDown size={14}/></button>
            {showStatusMenu && <div className="absolute left-0 top-full z-[60] mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{projectStatuses.map(status => <button key={status} onClick={() => moveStatus(status)} className={`project-menu-item ${status === project.status ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{projectStatusLabel(status)}{status === project.status ? '（当前）' : ''}</button>)}</div>}
          </div>}
        </div>
        <div className="flex items-center gap-2"><button onClick={() => openFolder()} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><ExternalLink size={16}/>打开{browserContext.title}文件夹</button>{projectWorkflows && <button onClick={() => setConfirmDelete(true)} title="删除项目" className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-500 hover:bg-red-50"><Trash2 size={16}/></button>}</div>
      </div>

      <div className="project-toolbar-wrap sticky top-0 z-30 -mx-6 w-[calc(100%+3rem)] bg-slate-50">
      <div className="project-toolbar flex w-full flex-nowrap items-center border-b border-slate-200 px-6 py-1">
        <div className="relative" onClick={event => event.stopPropagation()}>
          <button onClick={toggleCreateMenu} title="新建" aria-label="新建" aria-haspopup="menu" aria-expanded={showCreateMenu} className="project-action-button"><FolderPlus size={16}/>新建</button>
          {showCreateMenu && <div className="project-create-menu absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            {projectWorkflows && <><button className="project-menu-item" onClick={() => void openProgressSetup('create')}><FolderPlus size={14}/>新建进度</button><div className="my-1 border-t border-slate-100"/></>}
            <button className="project-menu-item" onClick={() => void createFolder()}><Folder size={14}/>文件夹</button>
            <div className="flex items-center justify-between px-2 pb-1 pt-2"><p className="text-[11px] font-bold text-slate-400">Windows 文件类型</p><button type="button" title="重新扫描 Windows 新建文件类型" aria-label="重新扫描 Windows 新建文件类型" disabled={shellNewTypesLoading} onClick={() => void loadShellNewTypes(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"><RefreshCw size={12} className={shellNewTypesLoading ? 'animate-spin' : ''}/></button></div>
            <div className="max-h-72 overflow-y-auto">
              {shellNewTypesLoading && <p className="px-2 py-2 text-xs text-slate-400">正在读取系统新建菜单…</p>}
              {!shellNewTypesLoading && shellNewTypes.map(type => <button key={type.id} className="project-menu-item flex items-center gap-2" onClick={() => void createShellNewFile(type)}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-4 w-4 shrink-0 object-contain"/> : <File size={14} className="shrink-0"/>}<span className="min-w-0 flex-1 truncate">{type.label}</span><span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{type.extension}</span></button>)}
              {!shellNewTypesLoading && shellNewTypesLoaded && !shellNewTypes.length && <p className="px-2 py-2 text-xs text-slate-400">系统没有可用的新建文件类型</p>}
            </div>
          </div>}
        </div>
        <div className="relative" onClick={event => event.stopPropagation()}>
          <button onClick={() => { const next = !showImportMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowImportMenu(next); }} title="导入" aria-label="导入" aria-haspopup="menu" aria-expanded={showImportMenu} className="project-action-button"><FolderInput size={16}/>导入</button>
          {showImportMenu && <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            {projectWorkflows && <button className="project-menu-item" onClick={() => { setShowImportMenu(false); setPanel('import'); }}><MemoryStick size={14}/>从 SD 卡导入</button>}
            <button className="project-menu-item" onClick={() => openManualImport(projectWorkflows ? 'original' : 'files')}><FolderInput size={14}/>导入</button>
          </div>}
        </div>
        <span aria-hidden className="toolbar-divider"/>
        {selectedPaths.length > 0 && <span className="mr-1 self-center text-xs text-slate-500">已选 {selectedPaths.length}</span>}
        <button disabled={finalViewOpen || selectedContainsShortcutContent || selectedContainsProtectedRenameEntry || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : selectedContainsProtectedRenameEntry ? '所选文件夹由项目工作流管理，不能普通重命名' : finalViewOpen ? '喜爱图片浏览为只读视图' : selectedPaths.length > 1 ? '批量重命名' : '重命名'} onClick={() => beginRename()} className="project-action-button compact-hide-file-action"><Edit size={16}/>{selectedPaths.length > 1 ? '批量重命名' : '重命名'}</button>
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
        {gatherToProject && <span aria-hidden className="toolbar-divider"/>}
        {gatherToProject && !hiddenProjectToolbarActions.has('image-tools') && projectToolbarAvailability['image-tools'] && projectToolbarButtons['image-tools']}
        <div className={projectWorkflows ? 'contents' : 'hidden'}>
          {visibleProjectToolbarActionIds.map(id => <React.Fragment key={id}>{projectToolbarButtons[id]}</React.Fragment>)}
        </div>
        {gatherToProject && !hiddenProjectToolbarActions.has('video-tools') && projectToolbarAvailability['video-tools'] && projectToolbarButtons['video-tools']}
        </div>
        <div className="project-toolbar-overflow relative" onClick={event => event.stopPropagation()}>
          <button type="button" onClick={() => { const next = !showToolbarOverflowMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowToolbarOverflowMenu(next); }} aria-label="展开工具栏操作" aria-haspopup="menu" aria-expanded={showToolbarOverflowMenu} className={`project-action-button ${showToolbarOverflowMenu ? 'bg-blue-50 text-blue-600' : ''}`}><ChevronDown size={17} className={`transition-transform ${showToolbarOverflowMenu ? 'rotate-180' : ''}`}/></button>
          {showToolbarOverflowMenu && <div className="project-toolbar-overflow-menu absolute left-0 top-full z-50 mt-1 w-56 overflow-visible rounded-lg border border-slate-200 bg-white p-1 shadow-xl" onClick={event => { const button = (event.target as HTMLElement).closest('button'); if (button && button.getAttribute('aria-haspopup') !== 'menu') setShowToolbarOverflowMenu(false); }}>
            <div className="project-toolbar-overflow-primary">
              <button disabled={finalViewOpen || selectedContainsShortcutContent || selectedContainsProtectedRenameEntry || !selectedPaths.length} onClick={() => beginRename()} className="project-menu-item"><Edit size={14}/>{selectedPaths.length > 1 ? '批量重命名' : '重命名'}</button>
              <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('cut')} className="project-menu-item"><Cut size={14}/>剪切</button>
              <button disabled={selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('copy')} className="project-menu-item"><Copy size={14}/>复制</button>
              <button disabled={finalViewOpen || !clipboardHasFiles} onClick={() => runFileOperation('paste')} className="project-menu-item"><ClipboardPaste size={14}/>粘贴</button>
              <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} onClick={() => runFileOperation('trash')} className="project-menu-item project-menu-danger"><Trash2 size={14}/>删除</button>
            </div>
            <div className="project-toolbar-overflow-secondary">
              {(gatherToProject || projectWorkflows && hasProjectToolbarActions) && <div className="my-1 border-t border-slate-100"/>}
              {gatherToProject && <><button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => startGatherInspiration(selectedPaths)} className="project-menu-item">{gatheringInspiration ? <Loader2 size={14} className="animate-spin"/> : <FolderInput size={14}/>}添加到{inspirationTargetProject ? `“${inspirationTargetProject.name}”` : '项目'}</button><button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => setGatherPickerPaths(selectedPaths)} className="project-menu-item"><ChevronDown size={14}/>选择目标项目</button></>}
              {gatherToProject && !hiddenProjectToolbarActions.has('image-tools') && projectToolbarAvailability['image-tools'] && projectToolbarButtons['image-tools']}
              {projectWorkflows && visibleProjectToolbarActionIds.map(id => <React.Fragment key={`overflow-${id}`}>{projectToolbarButtons[id]}</React.Fragment>)}
              {gatherToProject && !hiddenProjectToolbarActions.has('video-tools') && projectToolbarAvailability['video-tools'] && projectToolbarButtons['video-tools']}
            </div>
          </div>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-3">
          <button type="button" onClick={() => { setSearchQuery(''); selectFolderBrowseMode('recent'); }} title="最近文件（包含子文件夹和文件夹快捷方式）" aria-label="最近文件" aria-pressed={browseMode === 'recent'} className={`rounded-md p-1.5 ${browseMode === 'recent' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><GalleryVerticalEnd size={17}/></button>
          <button type="button" onClick={() => selectFolderBrowseMode('grid')} title="图标模式" aria-label="图标模式" aria-pressed={browseMode === 'grid'} className={`rounded-md p-1.5 ${browseMode === 'grid' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><Grid2X2 size={17}/></button>
          <button type="button" onClick={() => selectFolderBrowseMode('list')} title="列表模式" aria-label="列表模式" aria-pressed={browseMode === 'list'} className={`rounded-md p-1.5 ${browseMode === 'list' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><LayoutList size={17}/></button>
          {projectVersionTreeAvailable && <button type="button" onClick={showVersionTree} title="项目版本树" aria-label="项目版本树" aria-pressed={browseMode === 'version-tree'} className={`rounded-md p-1.5 ${browseMode === 'version-tree' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><GitBranch size={17}/></button>}
          {(browseMode === 'grid' || browseMode === 'version-tree') && <input aria-label="图标大小" title="图标大小" type="range" min={MIN_FOLDER_GRID_ICON_SIZE} max={MAX_FOLDER_GRID_ICON_SIZE} step="4" value={gridIconSize} onChange={event => selectFolderGridIconSize(Number(event.target.value))} className="compact-hide-slider ml-2 w-24 accent-blue-600"/>}
          <span aria-hidden className="mx-1 h-5 w-px bg-slate-200"/>
          <div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !showSortMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowSortMenu(next); }} title={versionTreeOpen ? '排序版本树中的媒体' : recursiveFlatOpen ? '排序每个文件夹中的文件' : '排序'} aria-label="排序" aria-haspopup="menu" aria-expanded={showSortMenu} className={`rounded-md p-1.5 ${showSortMenu ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><ArrowUpDown size={17}/></button>{showSortMenu && <div className="sort-menu absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{([['name', '文件名'], ['date', '修改日期'], ['size', '大小']] as const).map(([field, label]) => <button key={field} type="button" onClick={() => setSortField(field)} className={`project-menu-item ${sortField === field ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{label}</button>)}<div className="my-1 border-t border-slate-100"/><button type="button" onClick={() => setSortDirection('asc')} className={`project-menu-item ${sortDirection === 'asc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowUp size={14}/><span>递增</span></button><button type="button" onClick={() => setSortDirection('desc')} className={`project-menu-item ${sortDirection === 'desc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowDown size={14}/><span>递减</span></button></div>}</div>
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
        {finalViewOpen && <div className="ml-auto flex min-w-0 items-center gap-2"><label className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500">父节点<select aria-label="喜爱图片导出父节点" value={finalExportParentId} onChange={event => setFinalExportParentId(event.target.value)} className="max-w-48 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700"><option value="">请选择</option>{progressFolders.filter(folder => folder.mediaKind === 'image' && !folder.folderMissing && folder.nodeRole !== 'selection' && folder.relationKind !== 'auxiliary').map(folder => <option key={folder.id} value={folder.id}>{folder.displayName}</option>)}</select></label><button type="button" disabled={finalExporting || !finalViewEntries.length || !finalExportParentId} onClick={() => void exportFinalVersions()} className="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40">{finalExporting ? '正在整理…' : '整理喜爱图片'}</button></div>}
      </div>
      </div>

      {folderAlphabetFilterVisible && <nav aria-label="按文件夹首字母筛选" className="flex flex-wrap items-center gap-1 border-t border-slate-200 px-6 py-2">
        <button type="button" aria-pressed={!folderAlphabetFilter} onClick={() => { setFolderAlphabetFilter(''); setSelectedPaths([]); }} className={`rounded px-2 py-1 text-xs font-bold ${!folderAlphabetFilter ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}>全部</button>
        {[...FOLDER_ALPHABET_KEYS, '#'].map(key => { const available = folderAlphabetKeys.includes(key); return <button key={key} type="button" disabled={!available} aria-pressed={folderAlphabetFilter === key} onClick={() => { setFolderAlphabetFilter(key); setSelectedPaths([]); }} className={`h-6 min-w-6 rounded px-1 text-xs font-bold ${folderAlphabetFilter === key ? 'bg-blue-600 text-white' : available ? 'text-slate-500 hover:bg-slate-100 hover:text-slate-800' : 'cursor-default text-slate-300'}`}>{key}</button>; })}
      </nav>}
      {mountedPanels.has('converter') && <ToolModal title={PROJECT_PANEL_TITLES.converter} ownerPageId={pageId} panelKind="converter" open={panel === 'converter'} onClose={closePngConverterPanel}><ConverterView embedded initialTargetPaths={conversionTargets} sourcesLoading={conversionCollecting}/></ToolModal>}
      {mountedPanels.has('screenshot-main-image') && <ToolModal title={screenshotMainImageMode === 'crop' ? '裁剪图片' : PROJECT_PANEL_TITLES['screenshot-main-image']} ownerPageId={pageId} panelKind="screenshot-main-image" open={panel === 'screenshot-main-image'} onClose={() => setPanel(null)}><ScreenshotMainImageView embedded cropMode={screenshotMainImageMode === 'crop'} workspacePath={workspacePath} projectStatus={project.status} projectName={project.name} initialRelativePaths={screenshotMainImageTargets} cacheConfig={mediaCacheConfig} onFilesChanged={async () => {
        directoryEntriesCacheRef.current.clear();
        refreshRecursiveResults(screenshotMainImageTargets.map(path => projectRelativeParentPath(normalizeProjectRelativePath(path))));
        await refresh(currentRelativePathRef.current);
        if (finalViewOpen) await loadFinalViewEntries();
      }}/></ToolModal>}
      {mountedPanels.has('import') && <ToolModal title={PROJECT_PANEL_TITLES.import} ownerPageId={pageId} panelKind="import" open={panel === 'import'} busy={sdImportBusy} onClose={() => setPanel(null)}><div className="space-y-4"><div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{project.name}”</p><p className="mt-1 text-xs leading-5 text-blue-600">自动识别 SD 卡中的工作文件与花絮，并按项目结构整理。两类素材分别使用“设置 → 导入行为”中的规则。</p></div><ImportCard config={importConfig} drives={drives} workspacePath={workspacePath} destinationPath={project.path} brollDestinationPath={project.path} active={active && panel === 'import'} deleteSourceAfterImport={importDefaults.deleteSourceAfterImport} generateJpgFromRaw={importDefaults.generateJpgFromRaw} splitVideosOnImport={importDefaults.splitVideosOnImport} transcodeVideosOnImport={importDefaults.transcodeVideosOnImport} splitBrollVideosOnImport={brollConfig.splitVideosOnImport} transcodeBrollVideosOnImport={brollConfig.transcodeVideosOnImport} transcodeSettings={videoTools.transcode} onBusyChange={setSdImportBusy} onImportConfigChange={onImportConfigChange} onImportComplete={completeSdImport} completedActionLabel="关闭" onCompletedAction={() => setPanel(null)}/></div></ToolModal>}
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
            onChooseSourceFiles={() => void projectWorkspaceClient.chooseImportSourceFiles().then(result => { if (!result.cancelled && result.paths.length) setNegativeSourcePaths(result.paths); })}
            onChooseSourceFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => { if (!result.cancelled && result.path) setNegativeSourcePaths([result.path]); })}
            onDropSourcePaths={paths => setNegativeSourcePaths(paths)}
            onLinkOnlyImport={async paths => {
              const result = await projectWorkspaceClient.importProjectFiles(workspacePath, project.status, project.name, '', { deleteSourceAfterImport: false, linkOnly: true, sourcePaths: paths, adoptAsOriginal: true, mediaKind: 'image' });
              if (!result.success) throw new Error(result.error || '导入原始素材外链失败');
              directoryEntriesCacheRef.current.clear();
              await Promise.all([refresh(''), loadProgressFolders()]);
              onNotice(`已创建 ${result.count || 0} 个原始素材外链`);
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
        {panelImportResult?.kind === 'broll' ? <ImportCompletion
          message={`已导入 ${panelImportResult.count} 个花絮文件，源文件${panelImportResult.sourceDeleted ? '已删除' : '已保留'}。`}
          onClose={() => { setBrollSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
        /> : <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{project.name} / 花絮”</p><p className="mt-1 text-xs leading-5 text-blue-600">支持图片与视频；大于 4GB 的视频是否分割由设置决定。</p></div>
          <ImportSourceControls
            selectionTitle="选择一个或多个花絮文件"
            selectionDescription="可一次选择多个图片或视频"
            selectedCount={brollSourcePaths.length}
            onChooseFiles={() => void chooseBrollFiles()}
            onDropPaths={paths => setBrollSourcePaths(paths)}
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
        {panelImportResult?.kind === 'files' ? <ImportCompletion
          message={`已导入 ${panelImportResult.count} 个文件，源文件${panelImportResult.sourceDeleted ? '已删除' : '已保留'}。`}
          onClose={() => { setFileImportSourcePaths([]); setPanelImportResult(null); setPanel(null); }}
        /> : <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
            <p className="text-sm font-bold text-blue-800">导入到“{[project.name, normalizeProjectRelativePath(fileImportTarget)].filter(Boolean).join(' / ')}”</p>
            <p className="mt-1 text-xs leading-5 text-blue-600">选择任意文件导入当前目录；重名文件会自动生成不冲突的名称，不覆盖现有文件。</p>
          </div>

          <ImportSourceControls
            selectionTitle="选择一个或多个文件"
            selectionDescription="文件将在确认后导入当前目录"
            selectedCount={fileImportSourcePaths.length}
            onChooseFiles={() => void chooseFilesToImport()}
            onDropPaths={paths => setFileImportSourcePaths(paths)}
            importKind="files"
            onImportKindChange={kind => openManualImport(kind, fileImportSourcePaths, fileImportTarget)}
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
      {mountedPanels.has('research') && <ToolModal title={PROJECT_PANEL_TITLES.research} ownerPageId={pageId} panelKind="research" open={panel === 'research'} onClose={() => { researchInspectionSequenceRef.current += 1; setResearchCollecting(false); setPanel(null); }}><ResearchView embedded initialTargetPath={researchTargetPath} initialTargetPaths={researchTargetPaths} sourcesLoading={researchCollecting} targetKind={researchTargetKind} hasTxtFiles={researchTargetHasTxt} config={researchConfig} onUpdateConfig={onResearchConfigChange}/></ToolModal>}
      {mountedPanels.has('video-transcode') && <ToolModal title={PROJECT_PANEL_TITLES['video-transcode']} ownerPageId={pageId} panelKind="video-transcode" open={panel === 'video-transcode'} onClose={() => { videoTranscodeInspectionSequenceRef.current += 1; setVideoTranscodeCollecting(false); setPanel(null); }}><VideoTranscodeView embedded initialTargetPaths={videoTranscodeTargets} initialSourceFolders={videoTranscodeSourceFolders} sourcesLoading={videoTranscodeCollecting}/></ToolModal>}
      {mountedPanels.has('video-split') && <ToolModal title={PROJECT_PANEL_TITLES['video-split']} ownerPageId={pageId} panelKind="video-split" open={panel === 'video-split'} onClose={() => setPanel(null)}><VideoSplitView embedded initialTargetPaths={videoSplitTargets}/></ToolModal>}
      {mountedPanels.has('office-extract') && <ToolModal title={PROJECT_PANEL_TITLES['office-extract']} ownerPageId={pageId} panelKind="office-extract" open={panel === 'office-extract'} busy={officeExtractBusy} onClose={() => setPanel(null)}>
        {officeExtractResult ? <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50/70 px-6 py-10 text-center"><CheckCircle2 size={42} className="text-emerald-600"/><p className="mt-4 text-lg font-bold text-slate-800">图片提取完成</p><p className="mt-2 text-sm text-slate-600">已处理 {officeExtractResult.documents} 个文档，提取 {officeExtractResult.images} 张图片{officeExtractResult.failed ? `，${officeExtractResult.failed} 个文档失败` : ''}。</p>{officeExtractResult.outputFolders.length > 0 && <p className="mt-2 max-w-2xl break-all text-xs leading-5 text-slate-500">{officeExtractResult.outputFolders.join('；')}</p>}<button type="button" onClick={() => { setOfficeExtractResult(null); setOfficeExtractEntries([]); setPanel(null); }} className="dialog-primary mt-6">关闭</button></div> : <div className="space-y-4">
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white"><header className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3"><FileImage size={18} className="text-blue-600"/><div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-800">已选择 {officeExtractEntries.length} 个 Office 文档</p><p className="mt-0.5 text-xs text-slate-500">支持 Word、PowerPoint 和 Excel 文档</p></div><span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500">{officeExtractEntries.length} 个文件</span></header><div className="max-h-52 divide-y divide-slate-100 overflow-y-auto">{officeExtractEntries.map(entry => <div key={entry.relativePath} className="flex items-center gap-3 px-4 py-2.5"><span className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[10px] font-bold text-blue-700">{entry.extension.slice(1).toUpperCase()}</span><span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{entry.name}</span><span className="text-[10px] font-bold text-slate-400">{officeExtractBusy ? '处理中' : '等待'}</span></div>)}</div></section>
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">输出到文档旁</p><p className="mt-1 text-xs leading-5 text-blue-600">图片保存到文档旁的“文档名_media”文件夹，不修改原文档。</p></div>
          <section className="rounded-xl bg-slate-900 px-4 py-3 text-white"><div className="flex items-center justify-between text-xs font-bold"><span>{officeExtractBusy ? '正在提取图片…' : '进度'}</span><span>{officeExtractBusy ? '处理中' : '0%'}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-700"><div className={`h-full rounded-full bg-blue-500 ${officeExtractBusy ? 'w-2/3 animate-pulse' : 'w-0'}`}/></div><p className="mt-2 text-[10px] text-slate-400">{officeExtractBusy ? '正在读取文档中的媒体文件，请稍候。' : '等待任务开始，状态与结果会显示在这里。'}</p></section>
          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-4"><button type="button" disabled={officeExtractBusy} onClick={() => { setOfficeExtractEntries([]); setPanel(null); }} className="dialog-secondary disabled:opacity-50">重新选择</button><button type="button" disabled={officeExtractBusy || !officeExtractEntries.length} onClick={() => void extractOfficeImages()} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-50">{officeExtractBusy ? <Loader2 size={16} className="animate-spin"/> : <Play size={16}/>} {officeExtractBusy ? '正在提取…' : '开始提取'}</button></div>
        </div>}
      </ToolModal>}
      {mountedPanels.has('trash') && <ToolModal title={PROJECT_PANEL_TITLES.trash} ownerPageId={pageId} panelKind="trash" open={panel === 'trash'} onClose={() => setPanel(null)}><p className="text-sm text-slate-500">项目“{project.name}”及其全部内容将移入系统回收站。</p><button onClick={moveToTrash} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">确认移入回收站</button></ToolModal>}
      {gatherPickerPaths && createPortal(<div role="dialog" aria-modal="true" aria-label="选择灵感汇聚项目" className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">选择目标项目</h3><p className="mt-1 text-sm text-slate-500">所选灵感将会出现在目录项目下的“策划”文件夹。</p></div><button type="button" disabled={gatheringInspiration} onClick={() => setGatherPickerPaths(null)} title="关闭" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"><X size={17}/></button></div><div className="mt-4 max-h-80 space-y-1 overflow-y-auto">{inspirationProjects.map(targetProject => <button key={targetProject.path} type="button" disabled={gatheringInspiration} onClick={() => void gatherInspiration(targetProject, gatherPickerPaths)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm hover:bg-blue-50 ${targetProject.path === inspirationTargetProject?.path ? 'bg-blue-50 font-bold text-blue-700' : 'text-slate-700'}`}><Folder size={17} className="shrink-0 text-blue-500"/><span className="min-w-0 flex-1 truncate">{targetProject.name}</span><span className="shrink-0 text-xs text-slate-400">{targetProject.status}</span></button>)}{!inspirationProjects.length && <p className="rounded-lg bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">当前工作目录中没有可用项目。</p>}</div></section></div>, document.body)}
      {progressTask && createPortal(<div role="status" aria-live="polite" className="fixed left-1/2 top-14 z-[390] flex w-[min(92vw,520px)] -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-2xl"><Loader2 size={18} className="shrink-0 animate-spin text-blue-300"/><span>{progressTask}</span></div>, document.body)}
      {progressSetup && versionProgressDraft && versionProgressPanelMode && <ToolModal title={versionProgressPanelTitle} ownerPageId={pageId} panelKind={`version-${versionProgressPanelMode}`} open busy={progressSubmitting} onClose={closeProgressSetup}><VersionProgressPanel
        draft={versionProgressDraft}
        folders={progressFolders}
        state={progressSubmitting ? 'processing' : progressImportCompletion ? 'result' : 'ready'}
        progress={progressSetup.mode === 'import' && progressImportStatus ? {
          percentage: progressImportStatus.progress,
          processedCount: progressImportStatus.filesCopied ?? progressImportStatus.processedCount,
          totalCount: progressImportStatus.totalFiles ?? progressImportStatus.totalCount,
          currentName: progressImportStatus.currentName,
        } : undefined}
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
          if (!result.cancelled && result.paths.length) setProgressSetup(current => current ? { ...current, sourcePaths: result.paths } : current);
        })}
        onChooseFolder={() => void projectWorkspaceClient.chooseWorkspaceDirectory('').then(result => {
          const sourcePath = result.path;
          if (!result.cancelled && sourcePath) setProgressSetup(current => current ? { ...current, sourcePaths: [sourcePath] } : current);
        })}
        importStep={progressImportStep}
        onImportStepChange={setProgressImportStep}
        onImportKindChange={(kind, sourcePaths) => openManualImport(kind, sourcePaths, fileImportTarget || currentRelativePath)}
        onSubmit={() => void submitProgressSetup()}
        onClose={closeProgressSetup}
      /></ToolModal>}
      {trackingConfirmationSessionId && <TrackingConfirmationPanel sessionId={trackingConfirmationSessionId} workspacePath={workspacePath} progressFolders={progressFolders} cacheConfig={mediaCacheConfig} onNotice={onNotice} onClose={() => setTrackingConfirmationSessionId('')} onCommitted={() => { dismissTrackingTaskForSession(trackingConfirmationSessionId); if (trackingConfirmationProgressId) window.localStorage.removeItem(`photoflow:tracking-session:${workspacePath}:${project.name}:${trackingConfirmationProgressId}`); setTrackingConfirmationSessionId(''); setTrackingConfirmationProgressId(''); void loadProgressFolders().then(() => refresh('')); }} onReleased={() => { dismissTrackingTaskForSession(trackingConfirmationSessionId); if (trackingConfirmationProgressId) window.localStorage.removeItem(`photoflow:tracking-session:${workspacePath}:${project.name}:${trackingConfirmationProgressId}`); setTrackingConfirmationSessionId(''); setTrackingConfirmationProgressId(''); void loadProgressFolders(); }}/>
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
      {versionEntry && <div className={activeView === 'version' ? 'contents' : 'hidden'}><VersionManager entry={versionEntry} workspacePath={workspacePath} project={project} cacheConfig={mediaCacheConfig} progressId={progressFolderForMediaEntry(versionEntry)?.id} progressVersionKey={progressFolderForMediaEntry(versionEntry)?.versionKey} onNotice={onNotice} onVersionStateChanged={() => { if (finalViewOpen) void loadFinalViewEntries(); }} onClose={() => { onCloseToolTab('version'); if (finalViewOpen) void loadFinalViewEntries(); }}/></div>}
      {teamRetouchAvailable && (teamRetouchStep === 'detect' || teamRetouchStep === 'people') && teamRetouchEntries.length > 0 && <div className={activeView === 'team' ? 'contents' : 'hidden'}><TeamRetouchManager
        entries={teamRetouchEntries}
        workspacePath={workspacePath}
        project={project}
        cacheConfig={mediaCacheConfig}
        componentStatus={teamRetouchStatus}
        activeStep={teamRetouchStep === 'people' ? 'detect' : teamRetouchStep}
        onStepChange={setTeamRetouchStep}
        onNotice={onNotice}
        onEntriesChange={setTeamRetouchEntries}
        onProjectChanged={() => { void Promise.all([loadTeamRetouchHistory(), loadProgressFolders()]); }}
        onBusyChange={busy => onToolTabBusyChange('team', busy)}
        onClose={() => { onCloseToolTab('team'); void loadTeamRetouchHistory(); }}
      /></div>}
      {teamRetouchAvailable && teamRetouchStep === 'workflow' && <div className={activeView === 'team' ? 'contents' : 'hidden'}><PersonIdentityManager
        workspacePath={workspacePath}
        project={project}
        cacheConfig={mediaCacheConfig}
        activeStep={teamRetouchStep}
        onStepChange={setTeamRetouchStep}
        onNotice={onNotice}
        onProjectChanged={() => { void Promise.all([loadTeamRetouchHistory(), loadProgressFolders()]); }}
        onBusyChange={busy => onToolTabBusyChange('team', busy)}
        onClose={() => { onCloseToolTab('team'); void loadTeamRetouchHistory(); }}
      /></div>}

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {versionTreeOpen ? <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={handleFileSurfacePointerDownCapture} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} style={{ marginInline: -FILE_SURFACE_HORIZONTAL_PADDING }} className={`relative min-h-0 flex-1 select-none overflow-hidden outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {progressRelationInspection.needsRepair ? <div role="alert" className="m-4 rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-900"><div className="flex items-center gap-2 font-bold"><AlertTriangle size={18}/>版本关系需要修复</div><p className="mt-2 text-sm">检测到循环关系，已停止版本树遍历，避免应用崩溃。</p><p className="mt-2 break-all font-mono text-xs text-amber-700">节点 ID：{progressRelationInspection.cycleNodeIds.join('、')}</p></div> : <ProjectVersionTree
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
            canUndoRelation={relationHistoryRevision >= 0 && relationUndoStackRef.current.length > 0}
            canRedoRelation={relationHistoryRevision >= 0 && relationRedoStackRef.current.length > 0}
            onUndoRelation={() => void undoVersionGraphAction()}
            onRedoRelation={() => void redoVersionGraphAction()}
            onCancelRelationEdit={cancelRelationEdit}
            onNotice={onNotice}
            onCanvasControllerChange={setVersionTreeCanvasController}
          />}
        </div> : <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={handleFileSurfacePointerDownCapture} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} style={{ marginInline: -FILE_SURFACE_HORIZONTAL_PADDING, paddingInline: FILE_SURFACE_HORIZONTAL_PADDING }} className={`relative min-h-[220px] flex-1 select-none outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {groupedResultsActive && (groupedLoading ? <p className="py-12 text-center text-sm text-slate-400"><Loader2 size={17} className="mr-2 inline animate-spin"/>{projectRootFilterActive ? '正在分页读取全部文件…' : searchQuery.trim() ? `正在搜索${recursiveScopeLabel}…` : '正在读取最近文件…'}</p> : groupedError ? <p className="py-8 text-center text-sm text-red-600">读取文件失败：{groupedError}</p> : searchResultGroups.length ? <div className="pb-4">
            <p className="px-1 text-xs text-slate-500">{projectRootFilterActive ? `已分页加载${browserContext.title}中的 ${displayedFileEntries.length} 个文件` : searchQuery.trim() ? `在${currentRelativePath ? `“${currentRelativePath}”及其子文件夹` : recursiveScopeLabel}中找到 ${displayedFileEntries.length} 个文件` : `已加载${currentRelativePath ? `“${currentRelativePath}”及其子文件夹` : recursiveScopeLabel}最近修改的 ${displayedFileEntries.length} 个文件`}</p>
            {searchResultGroups.map(([folderPath, entries], groupIndex) => { const viaShortcut = entries.some(entry => entry.viaShortcut); const viaExternalLink = entries.some(entry => entry.viaExternalLink); const readOnlyShortcut = viaShortcut && !viaExternalLink; const folderLabel = viaShortcut ? folderPath.replace(/\.lnk(?=\/|$)/gi, '') : folderPath; const targetLabel = folderLabel || project.name; const normalizedFolderPath = normalizeProjectRelativePath(folderPath); return <section key={folderPath || '__root__'} data-recursive-folder-path={normalizedFolderPath} data-recursive-folder-label={targetLabel} data-recursive-folder-readonly={readOnlyShortcut ? 'true' : 'false'} onContextMenu={event => { if (readOnlyShortcut) { event.preventDefault(); event.stopPropagation(); onNotice('快捷方式指向的外部文件夹是只读浏览区域'); } else openSurfaceMenu(event, normalizedFolderPath, targetLabel); }} onDragOver={event => handleRecursiveFolderDragOver(event, normalizedFolderPath, readOnlyShortcut)} onDragLeave={event => handleRecursiveFolderDragLeave(event, normalizedFolderPath)} onDrop={event => void handleRecursiveFolderDrop(event, normalizedFolderPath, targetLabel, readOnlyShortcut)} className={`${groupIndex ? 'mt-5 border-t border-slate-200 pt-4' : 'pt-3'} rounded-lg transition ${recursiveDropTargetPath === normalizedFolderPath ? 'bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}><header className="mb-2 flex min-w-0 items-center gap-2 px-1"><Folder size={16} className="shrink-0 text-blue-500"/>{readOnlyShortcut ? <span title={`${folderLabel}（快捷方式）`} className="min-w-0 truncate text-sm font-bold text-slate-700">{folderLabel || '快捷方式'} <span className="font-normal text-slate-400">（快捷方式）</span></span> : <button type="button" onClick={() => { setSearchQuery(''); navigateToDirectory(folderPath); }} title={`打开 ${folderPath || project.name}`} className="min-w-0 truncate text-sm font-bold text-slate-700 hover:text-blue-600">{folderPath || '项目根目录'}</button>}<span className="shrink-0 text-xs text-slate-400">{entries.length} 个</span></header><div className="grid w-full content-start" style={{ gap: FILE_GRID_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{entries.map(entry => <div key={`${entry.relativePath}|${entry.path}`} role="button" tabIndex={0} draggable={!entry.viaShortcut || entry.viaExternalLink} onDragStart={event => startEntryDrag(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.relativePath} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50 ring-1 ring-blue-400' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''}`}><span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span><div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div><p className="mt-2 truncate text-xs font-medium text-slate-700">{getEntryDisplayName(entry)}</p><p className="mt-0.5 text-[10px] uppercase text-slate-400">{entry.kind === 'shortcut' ? '快捷方式' : entry.kind === 'raw' ? `RAW · ${entry.extension.slice(1)}` : entry.kind === 'video' ? `视频 · ${entry.extension.slice(1)}` : entry.extension.slice(1) || '文件'}</p></div>)}</div></section>; })}
            {(!searchQuery.trim() || projectRootFilterActive) && <p className={`py-6 text-center text-xs ${groupedLoadError ? 'text-red-500' : 'text-slate-400'}`}>{groupedLoadError ? `继续加载失败：${groupedLoadError}` : groupedLoadingMore ? <><Loader2 size={14} className="mr-1.5 inline animate-spin"/>正在继续加载…</> : groupedHasMore ? '继续向下滚动以加载更多文件' : '已显示当前范围内的全部文件'}</p>}
          </div> : <p className="py-12 text-center text-sm text-slate-400">{projectRootFilterActive ? `${browserContext.title}中没有符合筛选条件的${filteredFileTypeLabel}。` : searchQuery.trim() ? `没有在${recursiveScopeLabel}中找到包含“${searchQuery}”且符合筛选条件的文件。` : `当前范围内没有可显示的最近${filteredFileTypeLabel}。`}</p>)}
          {!groupedResultsActive && searchQuery.trim() && searchLoading && <p className="py-12 text-center text-sm text-slate-400"><Loader2 size={17} className="mr-2 inline animate-spin"/>正在搜索{recursiveScopeLabel}…</p>}
          {!groupedResultsActive && searchQuery.trim() && searchError && <p className="py-8 text-center text-sm text-red-600">搜索失败：{searchError}</p>}
          <div className={groupedResultsActive || Boolean(searchQuery.trim() && (searchLoading || searchError)) ? 'hidden' : undefined}>
          {directoryLoading ? <div role="status" aria-live="polite" className="flex min-h-[220px] items-center justify-center border-y border-slate-200 text-sm text-slate-500"><Loader2 size={18} className="mr-2 animate-spin"/>加载中…</div> : displayedFileEntries.length ? viewMode === 'list' ? <div className="min-w-[620px] border-y border-slate-200 text-sm">
            <div className="file-list-row file-list-heading text-xs font-medium text-slate-500"><span>名称</span><span>修改日期</span><span>类型</span><span>大小</span></div>
            {virtualWindow.top > 0 && <div aria-hidden style={{ height: virtualWindow.top }} />}
            {renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`file-list-row group w-full cursor-default border-t border-slate-200 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-inset ring-blue-500' : ''}`}>
              <span className="flex min-w-0 items-center gap-2.5"><span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-select-box ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-transparent'} flex h-4 w-4 shrink-0 items-center justify-center rounded border`}><CheckSquare size={12}/></span><span className="relative flex h-9 w-11 shrink-0 items-center justify-center overflow-hidden">{renderEntryIcon(entry)}</span>{renderEntryName(entry)}</span>
              <span className="text-slate-500">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '…'}</span>
              <span className="uppercase text-slate-500">{getEntryTypeLabel(entry)}</span>
              <span className="text-slate-500">{entry.kind === 'folder' ? '' : entry.size >= 0 ? formatFileSize(entry.size) : '…'}</span>
            </div>)}
            {virtualWindow.bottom > 0 && <div aria-hidden style={{ height: virtualWindow.bottom }} />}
          </div> : <><div aria-hidden style={{ height: virtualWindow.top }}/><div className="grid w-full content-start" style={{ gap: FILE_GRID_GAP, gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50 ring-1 ring-blue-400' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-blue-500' : ''}`}><span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span><div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div>{renderEntryName(entry, true)}<p className="mt-0.5 text-[10px] uppercase text-slate-400">{getEntryTypeLabel(entry)}</p></div>)}</div><div aria-hidden style={{ height: virtualWindow.bottom }}/></> : <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">{searchQuery ? `没有找到包含“${searchQuery}”且符合筛选条件的文件。` : `当前文件夹没有${filteredFileTypeLabel}。`}</p>}
          </div>
        </div>}
      </section>

      <section className="hidden rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-slate-800">项目文件夹</h3><span className="text-sm text-slate-500">{folders.length} 个</span></div>
        {folders.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{folders.map(folder => <button key={folder.path} onClick={() => openFolder(folder.name)} title={`打开 ${folder.name}`} className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-blue-50"><Folder size={64} strokeWidth={1.5} fill="currentColor" className="text-blue-500 drop-shadow-sm transition-transform group-hover:scale-105"/><span className="max-w-full truncate text-sm font-medium text-slate-700">{folder.name}</span></button>)}</div> : <p className="py-8 text-center text-sm text-slate-400">暂无子文件夹。</p>}
      </section>

      </div>
      {previewPaneOpen && <><ColumnResizeHandle label="调整文件区和预览区宽度" onDrag={resizeFilesAndPreview}/><MediaPreviewPane entry={previewEntry} cacheConfig={mediaCacheConfig} width={displayedColumnWidths.preview} pinned={previewPanePinned} advancedVideoAvailable={active && installedComponentIds.has('video-playback-mpv')} keyboardSettings={advancedVideoSettings} photoshopAvailable={photoshopAvailable && (!previewEntry || !isUnsupportedShortcutContent(previewEntry))} ratingAvailable={previewCanMarkFinal} rating={previewRating} ratingMode={favoriteDisplayMode} ratingLoading={previewRatingLoading} ratingBusy={previewRatingBusy} onChangeRating={rating => void updatePreviewRating(rating)} onTogglePinned={togglePreviewPanePinned} onTechnicalMetadata={setPreviewTechnicalMetadata} onNavigate={navigatePreviewMedia} onContextMenu={event => previewEntry && openFileMenu(event, previewEntry, false)} onContextMenuAt={(x, y) => previewEntry && openFileMenuAt(x, y, previewEntry, false)} onAnalyzeImageCrop={analyzePreviewImageCrop} onConfirmImageCrop={savePreviewImageCrop} onTrimVideo={trimPreviewVideo} onLoadVideoTimelineFrames={loadPreviewVideoTimelineFrames} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onOpenInPhotoshop={() => previewEntry && openProjectEntriesInPhotoshop([previewEntry])} onClose={closePreviewPaneByUser}/></>}
      {metadataPaneOpen && <><ColumnResizeHandle label={previewPaneOpen ? '调整预览区和详细信息区宽度' : '调整文件区和详细信息区宽度'} onDrag={previewPaneOpen ? resizePreviewAndMetadata : resizeFilesAndMetadata}/><FileMetadataPane entry={focusedEntry} entryDetails={previewEntryDetails} metadataFields={currentPreviewMetadataFields} metadataLoading={currentPreviewMetadataLoading} metadataError={currentPreviewMetadataError} technicalMetadata={focusedEntry?.relativePath === previewEntry?.relativePath ? previewTechnicalMetadata : EMPTY_PREVIEW_TECHNICAL_METADATA} formatFileSize={formatFileSize} width={displayedColumnWidths.metadata} pinned={metadataPanePinned} onTogglePinned={toggleMetadataPanePinned} onOpen={() => focusedEntry && openProjectEntry(focusedEntry, true)} onCopyPath={() => focusedEntry && copyEntryPath(focusedEntry)} onClose={closeMetadataPaneByUser}/></>}
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

const VideoTrimTimeline = ({ duration, start, end, currentTime, frames, busyMode, exportProgress, progressVisible, onChange, onPreview, onCancel, onSave }: {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  frames: string[];
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
      <p className="min-w-0 truncate text-[10px] text-slate-500">始终按所选首尾画面高质量精确裁剪，确保保留区间正确。</p>
      <div className="flex shrink-0 items-center gap-2"><button type="button" disabled={exportProgress?.phase === 'cancelling'} onClick={onCancel} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-300 hover:bg-white/10 disabled:opacity-40">{busyMode ? exportProgress?.phase === 'cancelling' ? '正在取消…' : '取消导出' : '取消'}</button><button type="button" disabled={Boolean(busyMode) || selectedDuration < .05} onClick={() => onSave('new')} className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-white/20 disabled:opacity-40">{busyMode === 'new' && <Loader2 size={13} className="animate-spin"/>}{busyMode === 'new' ? '正在另存…' : '另存为新视频'}</button><button type="button" disabled={Boolean(busyMode) || selectedDuration < .05} onClick={() => onSave('replace')} className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-40">{busyMode === 'replace' && <Loader2 size={13} className="animate-spin"/>}{busyMode === 'replace' ? '正在替换…' : '替换原视频'}</button></div>
    </div>
  </div>;
};
const MediaPreviewPane = ({ entry, cacheConfig, width, pinned, advancedVideoAvailable, keyboardSettings, photoshopAvailable, ratingAvailable, rating, ratingMode, ratingLoading, ratingBusy, onChangeRating, onTogglePinned, onTechnicalMetadata, onNavigate, onContextMenu, onContextMenuAt, onAnalyzeImageCrop, onConfirmImageCrop, onTrimVideo, onLoadVideoTimelineFrames, onOpen, onOpenInPhotoshop, onClose }: {
  entry?: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  width: number;
  pinned: boolean;
  advancedVideoAvailable: boolean;
  keyboardSettings: NonNullable<AppConfig['componentSettings']['video-playback-mpv']>;
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
  const [resource, setResource] = useState<{ sourcePath?: string; previewUrl?: string; originalUrl?: string; mediaUrl?: string; usingImportedPreview?: boolean; importedVideoWithoutPreview?: boolean; orientationMatrix?: number[]; orientationSwapsAxes?: boolean }>({});
  const [loading, setLoading] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalLoadError, setOriginalLoadError] = useState('');
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [advancedPlaybackFailed, setAdvancedPlaybackFailed] = useState(false);
  const [imageZoom, setImageZoom] = useState(1);
  const [imagePan, setImagePan] = useState({ x: 0, y: 0 });
  const [imageNaturalSize, setImageNaturalSize] = useState({ width: 0, height: 0 });
  const [imageSurfaceSize, setImageSurfaceSize] = useState({ width: 0, height: 0 });
  const [imageDragging, setImageDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(true);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaybackTime, setVideoPlaybackTime] = useState(0);
  const [advancedEditorSeek, setAdvancedEditorSeek] = useState<{ id: number; time: number; pause?: boolean }>();
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
  const fallbackVideoRef = useRef<HTMLVideoElement>(null);
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
      setPlaybackFailed(false);
      setAdvancedPlaybackFailed(false);
      setImageZoom(1);
      setImagePan({ x: 0, y: 0 });
      setImageNaturalSize({ width: 0, height: 0 });
      setImageDragging(false);
      setVideoDuration(0);
      setVideoPlaybackTime(0);
      setAdvancedEditorSeek(undefined);
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
          setResource(current => current.sourcePath === entry.path ? { ...current, previewUrl: result.previewUrl || current.previewUrl || entry.previewUrl, mediaUrl: result.mediaUrl, usingImportedPreview: result.usingImportedPreview, importedVideoWithoutPreview: result.importedVideoWithoutPreview } : current);
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
    fullscreenControlsTimerRef.current = window.setTimeout(() => setFullscreenControlsVisible(false), 1800);
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
    fullscreenControlsTimerRef.current = window.setTimeout(() => setFullscreenControlsVisible(false), 1800);
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
  const handleVideoPlaybackError = () => {
    if (!entry || entry.kind !== 'video') return;
    setPlaybackFailed(true);
    setLoading(false);
    onTechnicalMetadata({ unavailable: true });
  };
  const handleAdvancedVideoError = (message: string) => {
    setAdvancedPlaybackFailed(true);
    setLoading(Boolean(resource.mediaUrl));
    console.warn('Advanced video decoder failed; falling back to Chromium playback', message);
    projectWorkspaceClient.trackTelemetry('media_preview_failed', { media_kind: 'video', reason: 'advanced_decoder_fallback' });
  };
  const previewVideoTrimTime = (requestedTime: number) => {
    const time = Math.max(0, Math.min(videoDuration, requestedTime));
    setVideoPlaybackTime(time);
    if (useAdvancedVideo) {
      editorSeekIdRef.current += 1;
      setAdvancedEditorSeek({ id: editorSeekIdRef.current, time, pause: true });
      return;
    }
    const video = fallbackVideoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = time;
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
    const fallbackVideo = fallbackVideoRef.current;
    if (fallbackVideo) {
      fallbackVideo.pause();
      fallbackVideo.removeAttribute('src');
      fallbackVideo.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
      fallbackVideo.load();
    }
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
  const useAdvancedVideo = Boolean(entry && entry.kind === 'video' && advancedVideoAvailable && !advancedPlaybackFailed);
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
    busyMode={trimBusyMode}
    exportProgress={trimExportProgress}
    progressVisible={trimProgressVisible}
    onChange={changeVideoTrimEdge}
    onPreview={previewVideoTrimTime}
    onCancel={cancelVideoTrim}
    onSave={mode => void confirmVideoTrim(mode)}
  /> : undefined;

  useEffect(() => {
    if (!entry || entry.kind !== 'video' || useAdvancedVideo) return;
    const runDirectionalAction = (direction: -1 | 1, group: 'arrows' | 'forward-back') => {
      if (videoDirectionalAction(keyboardSettings.arrowKeyAction, group) === 'navigate') {
        onNavigate(direction);
        return;
      }
      const video = fallbackVideoRef.current;
      if (!video) return;
      const duration = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
      video.currentTime = Math.max(0, Math.min(duration, video.currentTime + direction * 5));
    };
    const handleFallbackVideoKey = (event: KeyboardEvent) => {
      const input = videoDirectionalKeyboardInput(event.key);
      if (!input) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      runDirectionalAction(input.direction, input.group);
    };
    window.addEventListener('keydown', handleFallbackVideoKey);
    return () => {
      window.removeEventListener('keydown', handleFallbackVideoKey);
    };
  }, [entry?.path, useAdvancedVideo, keyboardSettings.arrowKeyAction, onNavigate]);

  const previewPane = <section onContextMenu={onContextMenu} onMouseMove={revealFullscreenControls} style={fullscreen ? undefined : { width }} className={`flex min-h-0 shrink-0 flex-col ${fullscreen ? 'fixed inset-0 z-[500] h-screen w-screen bg-black' : 'bg-slate-50'}`}>
    {!fullscreen && <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
      <div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">{imageCropPhase ? '裁剪' : trimEditor ? '剪辑' : '预览'}</p><p className="truncate text-sm font-semibold text-slate-700">{entry?.name || '未选择媒体'}</p></div>
      {imageCropPhase ? <div className="ml-2 flex shrink-0 items-center gap-2">
        <button type="button" disabled={imageCropPhase === 'saving'} onClick={cancelImageCrop} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">取消</button>
        <button type="button" disabled={imageCropPhase !== 'editing'} onClick={() => void confirmImageCrop()} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-blue-500 disabled:bg-blue-400">
          {(imageCropPhase === 'analyzing' || imageCropPhase === 'saving') && <Loader2 size={13} className="animate-spin"/>}
          {imageCropPhase === 'analyzing' ? '识别边缘中' : imageCropPhase === 'saving' ? '正在裁剪…' : '确定裁剪'}
        </button>
      </div> : trimEditor ? <button type="button" disabled={trimExportProgress?.phase === 'cancelling'} onClick={cancelVideoTrim} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">{trimBusy ? trimExportProgress?.phase === 'cancelling' ? '正在取消…' : '取消导出' : '取消剪辑'}</button> : <div className="flex items-center gap-1">{entry && <><button type="button" onClick={() => setFullscreen(true)} title="全屏查看" aria-label="全屏查看" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Maximize2 size={16}/></button>{ratingAvailable && (ratingMode === 'stars' ? <div className="flex items-center" aria-label={`图片评分 ${rating} 星`}>{[1, 2, 3, 4, 5].map(star => <button key={star} type="button" disabled={ratingLoading || ratingBusy} onClick={() => onChangeRating(rating === star ? 0 : star)} title={rating === star ? `清除 ${star} 星评分` : `设为 ${star} 星`} aria-label={rating === star ? `清除 ${star} 星评分` : `设为 ${star} 星`} className={`rounded p-1 transition hover:bg-amber-50 hover:text-amber-500 disabled:opacity-40 ${rating >= star ? 'text-amber-400' : 'text-slate-300'}`}><Star size={15} fill={rating >= star ? 'currentColor' : 'none'}/></button>)}</div> : <button type="button" disabled={ratingLoading || ratingBusy} onClick={() => onChangeRating(rating > 0 ? 0 : 5)} title={rating > 0 ? `取消喜欢（当前 ${rating} 星）` : ratingLoading ? '正在读取图片评分' : '喜欢（写入五星）'} aria-label={rating > 0 ? '取消喜欢' : '标记为喜欢'} className={`rounded-md p-2 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 ${rating > 0 ? 'text-red-500' : 'text-slate-500'}`}><Heart size={16} fill={rating > 0 ? 'currentColor' : 'none'}/></button>)}{photoshopAvailable && (entry.kind === 'image' || entry.kind === 'raw') && <button type="button" onClick={onOpenInPhotoshop} title="使用 Photoshop 打开" aria-label="使用 Photoshop 打开" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><PhotoshopIcon size={16}/></button>}<button type="button" disabled={entry.kind === 'raw' || isUnsupportedShortcutContent(entry) || entry.kind === 'video' && !videoDuration} onClick={entry.kind === 'video' ? openVideoTrim : () => void beginImageCrop()} title={entry.kind === 'video' ? videoDuration ? '剪辑视频（精确保留所选区间）' : '正在读取视频时长' : entry.kind === 'raw' ? 'RAW 暂不支持直接裁剪' : '裁剪图片（识别并磁吸边缘）'} aria-label={entry.kind === 'video' ? '剪辑视频' : '裁剪图片'} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-35"><Crop size={16}/></button></>}<button type="button" onClick={onTogglePinned} title={pinned ? '取消固定预览面板' : '固定预览面板'} aria-label={pinned ? '取消固定预览面板' : '固定预览面板'} aria-pressed={pinned} className={`rounded-md p-2 transition hover:bg-blue-50 hover:text-blue-600 ${pinned ? 'bg-blue-50 text-blue-600' : 'text-slate-500'}`}><Pin size={16} fill={pinned ? 'currentColor' : 'none'}/></button><button type="button" onClick={onClose} title="关闭预览" aria-label="关闭预览" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button></div>}
    </header>}
    {fullscreen && fullscreenControlsVisible && <button type="button" onClick={() => setFullscreen(false)} title="退出全屏（Esc）" aria-label="退出全屏" className="fixed right-5 top-5 z-[520] rounded-full bg-black/60 p-2.5 text-white shadow-lg backdrop-blur transition hover:bg-black/80"><X size={20}/></button>}
    <div className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${fullscreen ? 'bg-black' : 'bg-slate-50'}`}>
      {!entry && <div className="max-w-[220px] text-center"><ImageIcon size={38} strokeWidth={1.4} className="mx-auto text-slate-600"/><p className="mt-3 text-sm font-medium text-slate-300">点击图片、RAW 或视频文件</p><p className="mt-1 text-xs leading-5 text-slate-500">此处显示图片或视频预览。</p></div>}
      {entry && entry.kind === 'video' && trimBusy && <div className="absolute inset-0 flex min-h-0 flex-col bg-black"><div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">{resource.previewUrl ? <img src={resource.previewUrl} alt="" draggable={false} className="max-h-full max-w-full object-contain opacity-70"/> : <Video size={52} strokeWidth={1.3} className="text-slate-700"/>}</div>{videoTrimControls}</div>}
      {useAdvancedVideo && entry && !trimBusy && <AdvancedVideoPlayer filePath={entry.path} poster={resource.previewUrl} keyboardSettings={keyboardSettings} bottomControls={videoTrimControls} editorSeekRequest={advancedEditorSeek} onPlaybackState={playback => setVideoPlaybackTime(playback.time)} onError={handleAdvancedVideoError} onMetadata={metadata => { setLoading(false); setVideoDuration(Number(metadata.duration) || 0); onTechnicalMetadata(metadata); }} onNavigate={onNavigate} onContextMenuAt={onContextMenuAt} onPointerActivity={revealFullscreenControls} topRightOverlayHole={fullscreen && fullscreenControlsVisible ? 72 : 0} onEscape={() => setFullscreen(false)}/>}
      {entry && entry.kind === 'video' && !useAdvancedVideo && !trimBusy && resource.mediaUrl && !playbackFailed && <div className="absolute inset-0 flex min-h-0 flex-col bg-black"><video ref={fallbackVideoRef} key={resource.mediaUrl} autoPlay controls={!trimEditor} preload="metadata" poster={resource.previewUrl} className="min-h-0 w-full flex-1 bg-black object-contain" onTimeUpdate={event => setVideoPlaybackTime(event.currentTarget.currentTime)} onLoadedMetadata={event => { setLoading(false); setVideoDuration(Number(event.currentTarget.duration) || 0); setVideoPlaybackTime(event.currentTarget.currentTime); onTechnicalMetadata({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight, duration: event.currentTarget.duration }); void event.currentTarget.play().catch(() => undefined); }} onError={handleVideoPlaybackError}><source src={resource.mediaUrl}/></video>{videoTrimControls}</div>}
      {entry && entry.kind === 'video' && !useAdvancedVideo && !trimBusy && (!resource.mediaUrl || playbackFailed) && <div className="flex max-h-full w-full flex-col items-center justify-center gap-4 text-center">{resource.previewUrl ? <img src={resource.previewUrl} alt={entry.name} draggable={false} className="max-h-[70%] max-w-full object-contain"/> : <Video size={52} strokeWidth={1.3} className="text-slate-600"/>}<div className="max-w-sm px-6"><p className="text-sm font-medium text-slate-700">{resource.importedVideoWithoutPreview ? '此导入视频无法在软件内直接播放' : playbackFailed ? resource.usingImportedPreview ? '导入的视频预览无法播放' : '当前视频无法在软件内播放。' : loading ? '正在准备视频预览…' : resource.previewUrl ? '视频封面已就绪' : '没有可用的视频封面'}</p>{resource.importedVideoWithoutPreview && <p className="mt-1 text-xs leading-5 text-slate-500">可在“设置 → 导入行为”中开启视频转码，让以后导入的视频按视频转码面板参数生成兼容版本。</p>}{playbackFailed && !resource.importedVideoWithoutPreview && <p className="mt-1 text-xs leading-5 text-slate-500">可使用系统播放器打开。</p>}<button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button></div></div>}
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

const IMPORTANT_METADATA_ICONS: Record<string, typeof Camera> = {
  相机: Camera, 镜头: ScanSearch, 拍摄时间: Calendar, 尺寸: Ruler, 光圈: Aperture, 快门: Timer, ISO: Gauge, 焦距: ScanSearch,
  编码: Video, 帧率: Activity, 时长: Timer, 码率: Gauge, 音频: Volume2
};

const MetadataRow = ({ label, sourceLabel, value }: { label: string; sourceLabel?: string; value: React.ReactNode }) => <div className="grid grid-cols-[minmax(76px,38%)_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2 last:border-b-0"><dt title={sourceLabel} className="break-words text-[11px] font-medium text-slate-400">{label}</dt><dd className="select-text break-words text-xs leading-5 text-slate-700">{value}</dd></div>;

const FileMetadataPane = ({ entry, entryDetails, metadataFields, metadataLoading, metadataError, technicalMetadata, formatFileSize, width, pinned, onTogglePinned, onOpen, onCopyPath, onClose }: {
  entry?: ProjectFileEntry;
  entryDetails: ProjectEntryDetails | null;
  metadataFields: readonly MediaMetadataField[];
  metadataLoading: boolean;
  metadataError: string;
  technicalMetadata: PreviewTechnicalMetadata;
  formatFileSize: (size: number) => string;
  width: number;
  pinned: boolean;
  onTogglePinned: () => void;
  onOpen: () => void;
  onCopyPath: () => void;
  onClose: () => void;
}) => {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const metadataGroupKey = metadataGroupDependencyKey(metadataFields);

  useEffect(() => {
    setExpandedGroups(current => reconcileExpandedMetadataGroups(current, entry?.path, metadataGroupKey));
  }, [entry?.path, metadataGroupKey]);

  const mediaType = entry && isFolderLikeEntry(entry) ? '文件夹' : entry?.kind === 'image' ? '图片' : entry?.kind === 'raw' ? 'RAW 图片' : entry?.kind === 'video' ? '视频' : '文件';
  const firstValue = (...names: string[]) => pickMetadataValue(metadataFields, ...names);
  const exactWidth = firstValue('ImageWidth', 'SourceImageWidth', 'ExifImageWidth', 'PixelWidth');
  const exactHeight = firstValue('ImageHeight', 'SourceImageHeight', 'ExifImageHeight', 'PixelHeight');
  const compositeDimensionMatch = firstValue('ImageSize')?.match(/(\d+)\s*[x×]\s*(\d+)/i);
  const dimensions = exactWidth && exactHeight
    ? `${exactWidth} × ${exactHeight}`
    : compositeDimensionMatch
      ? `${compositeDimensionMatch[1]} × ${compositeDimensionMatch[2]}`
      : technicalMetadata.width && technicalMetadata.height
        ? `${technicalMetadata.width} × ${technicalMetadata.height}`
        : undefined;
  const cameraMake = firstValue('Make');
  const cameraModel = firstValue('Model');
  const camera = cameraMake && cameraModel && cameraModel.toLocaleLowerCase().startsWith(cameraMake.toLocaleLowerCase()) ? cameraModel : [cameraMake, cameraModel].filter(Boolean).join(' ');
  const importantItems = (entry?.kind === 'video' ? [
    ['编码', firstValue('CompressorName', 'VideoCodec', 'Encoder')], ['尺寸', dimensions], ['帧率', firstValue('VideoFrameRate', 'CaptureFrameRate')],
    ['时长', firstValue('Duration') || formatMediaDuration(technicalMetadata.duration)], ['码率', firstValue('AvgBitrate', 'VideoAvgBitrate', 'Bitrate')], ['音频', firstValue('AudioFormat', 'AudioCodec')]
  ] : [
    ['相机', camera], ['镜头', firstValue('LensModel', 'Lens')], ['拍摄时间', pickCaptureDate(metadataFields, 'DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate')], ['尺寸', dimensions],
    ['光圈', firstValue('FNumber', 'Aperture')], ['快门', formatShutterSpeed(firstValue('ExposureTime', 'ShutterSpeed'))], ['ISO', firstValue('ISO')], ['焦距', firstValue('FocalLength')]
  ]).filter((item): item is string[] => Boolean(item[1] && item[1] !== '—'));
  const applicationFields: MediaMetadataField[] = entry ? [
    { group: 'Application', name: '文件名', value: entry.name }, { group: 'Application', name: '媒体类型', value: mediaType },
    ...((entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') && dimensions ? [{ group: 'Application', name: '像素尺寸', value: dimensions }] : []),
    ...(entry.extension ? [{ group: 'Application', name: '文件格式', value: firstValue('FileType') || entry.extension.replace(/^\./, '').toLocaleUpperCase() }] : []),
    { group: 'Application', name: '大小', value: entryDetails ? formatFileSize(entryDetails.size) : entry.size >= 0 ? formatFileSize(entry.size) : '正在计算…' },
    ...(entryDetails ? [{ group: 'Application', name: '创建时间', value: new Date(entryDetails.createdAt).toLocaleString() }, { group: 'Application', name: '修改时间', value: new Date(entryDetails.updatedAt).toLocaleString() }] : []),
    ...(entry && isFolderLikeEntry(entry) && entryDetails ? [{ group: 'Application', name: '包含', value: `${entryDetails.fileCount} 个文件，${entryDetails.folderCount} 个文件夹` }] : []),
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
    <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">详细信息</p><p className="truncate text-sm font-semibold text-slate-700">{entry?.name || '文件信息'}</p></div><div className="flex items-center gap-1"><button type="button" onClick={onTogglePinned} title={pinned ? '取消固定详细信息面板' : '固定详细信息面板'} aria-label={pinned ? '取消固定详细信息面板' : '固定详细信息面板'} aria-pressed={pinned} className={`rounded-md p-2 transition hover:bg-blue-50 hover:text-blue-600 ${pinned ? 'bg-blue-50 text-blue-600' : 'text-slate-500'}`}><Pin size={16} fill={pinned ? 'currentColor' : 'none'}/></button><button type="button" onClick={onClose} title="关闭详细信息" aria-label="关闭详细信息" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button></div></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {!entry ? <div className="py-12 text-center"><FileText size={34} strokeWidth={1.4} className="mx-auto text-slate-300"/><p className="mt-3 text-sm text-slate-400">选择文件或文件夹后显示详细信息</p></div> : <>
        {importantItems.length > 0 && <section className="grid grid-cols-2 gap-1.5 py-2">{importantItems.map(([label, value]) => { const Icon = IMPORTANT_METADATA_ICONS[label] || FileText; return <div key={label} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2"><p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Icon size={12}/>{label}</p><p title={value} className="mt-1 truncate text-xs font-semibold text-slate-700">{value}</p></div>; })}</section>}
        <div className="flex items-center justify-between border-b border-slate-200 py-2"><span className="text-[11px] text-slate-400">{metadataLoading ? '正在读取详细信息…' : `${metadataFields.length + applicationFields.length} 个字段`}</span>{groupNames.length > 1 && <button type="button" onClick={() => setExpandedGroups(allExpanded ? new Set() : new Set(groupNames))} className="text-[11px] font-bold text-blue-500 hover:text-blue-400">{allExpanded ? '全部折叠' : '全部展开'}</button>}</div>
        {metadataError && <p className="my-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-600">{metadataError}</p>}
        {groupNames.map(group => {
          const fields = groupedMetadata.get(group) || [];
          const expanded = expandedGroups.has(group);
          return <section key={group} className="border-b border-slate-200"><button type="button" onClick={() => toggleGroup(group)} className="flex w-full items-center gap-2 py-2.5 text-left"><span className="text-slate-400">{expanded ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}</span><span className="text-xs font-bold text-slate-700">{metadataGroupLabel(group)}</span><span className="ml-auto text-[10px] text-slate-400">{fields.length}</span></button>{expanded && <dl className="pb-2">{fields.map((field, index) => <MetadataRow key={`${group}:${field.name}:${index}`} label={metadataFieldLabel(field.name)} sourceLabel={field.name} value={field.value}/>)}</dl>}</section>;
        })}
        <div className="flex flex-col gap-2 py-4"><button type="button" onClick={onOpen} className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button><button type="button" onClick={onCopyPath} className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><Copy size={14}/>复制文件地址</button></div>
      </>}
    </div>
  </aside>;
};

const FolderCoverMedia = ({ entry, cacheConfig, requestedSize, queueOrder }: {
  entry: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  requestedSize: number;
  queueOrder: number;
}) => {
  const [url, setUrl] = useState(entry.previewUrl);
  const [retryVersion, setRetryVersion] = useState(0);
  const failedLoadCountRef = useRef(0);
  useThumbnailUpdates(entry.path, requestedSize, (state, nextUrl) => {
    if (state === 'READY' && nextUrl) setUrl(nextUrl);
    if (state === 'STALE') {
      setUrl(undefined);
      setRetryVersion(version => version + 1);
    }
  });
  useEffect(() => {
    failedLoadCountRef.current = 0;
    setUrl(entry.previewUrl);
  }, [entry.path, entry.updatedAt, entry.previewUrl]);
  useEffect(() => {
    let active = true;
    projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 2, queueOrder)
      .then(result => { if (active && result.previewUrl) setUrl(result.previewUrl); });
    return () => { active = false; };
  }, [entry.path, entry.kind, cacheConfig.directory, cacheConfig.maxSizeGB, requestedSize, queueOrder, retryVersion]);
  return url
    ? <img src={url} alt="" draggable={false} className="h-full w-full object-cover" onLoad={() => { failedLoadCountRef.current = 0; }} onError={() => {
      setUrl(undefined);
      if (failedLoadCountRef.current >= 1) return;
      failedLoadCountRef.current += 1;
      setRetryVersion(version => version + 1);
    }}/>
    : <FileImage size={requestedSize > 160 ? 28 : 14} className="text-slate-400"/>;
};

const FolderCover = ({ entry, cacheConfig, requestedSize, queueOrder, large, loadEntries }: {
  entry: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  requestedSize: number;
  queueOrder: number;
  large: boolean;
  loadEntries: (entry: ProjectFileEntry) => Promise<ProjectFileEntry[]>;
}) => {
  const container = useRef<HTMLSpanElement>(null);
  const [coverEntry, setCoverEntry] = useState<ProjectFileEntry>();
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      void loadEntries(entry).then(entries => {
        if (!active) return;
        const media = entries.find(item => item.kind === 'image' || item.kind === 'raw' || item.kind === 'video');
        setCoverEntry(media || entries.find(item => item.kind !== 'folder'));
      });
    }, { rootMargin: '180px' });
    observer.observe(node);
    return () => { active = false; observer.disconnect(); };
  }, [entry.path, entry.updatedAt, loadEntries]);

  const isMedia = coverEntry && (coverEntry.kind === 'image' || coverEntry.kind === 'raw' || coverEntry.kind === 'video');
  const iconSize = large ? '100%' : 27;
  return <span ref={container} aria-hidden style={large ? undefined : { width: 27, height: 27 }} className={`relative isolate block shrink-0 text-blue-500 ${large ? 'h-[114%] w-[114%]' : ''}`}>
    <Folder size={iconSize} strokeWidth={1.5} fill="currentColor" className="absolute inset-0"/>
    {coverEntry && <span className="absolute bottom-[20%] left-[11%] right-[11%] top-[31%] z-10 flex items-center justify-center overflow-hidden rounded-[5%] bg-slate-100">
      {isMedia
        ? <FolderCoverMedia entry={coverEntry} cacheConfig={cacheConfig} requestedSize={requestedSize} queueOrder={queueOrder}/>
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
  loadEntries: (entry: ProjectFileEntry) => Promise<ProjectFileEntry[]>;
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
      request = projectWorkspaceClient.getFileIcon(filePath).then(result => result.success ? result.dataUrl : undefined);
      systemFileIconCache.set(extension, request);
    }
    let active = true;
    request.then(icon => { if (active) setDataUrl(icon); });
    return () => { active = false; };
  }, [filePath]);
  return dataUrl ? <img src={dataUrl} alt="" draggable={false} style={{ width: size, height: size }} className="object-contain"/> : <File size={size} className="text-slate-400"/>;
};
const HOVER_VIDEO_PLAY_DELAY_MS = 300;
let activeHoverVideo: HTMLVideoElement | null = null;

const MediaThumbnail = ({ entry, cacheConfig, requestedSize, queueOrder, large = false }: { entry: ProjectFileEntry; cacheConfig: AppConfig['mediaCache']; requestedSize: number; queueOrder: number; large?: boolean }) => {
  const previewCacheKey = mediaThumbnailPreviewKey(entry.path, entry.updatedAt, requestedSize);
  const cachedPreview = mediaThumbnailPreviewCache.get(previewCacheKey)
    ? { url: mediaThumbnailPreviewCache.get(previewCacheKey), size: requestedSize }
    : findCachedMediaThumbnailPreview(entry.path, entry.updatedAt);
  const [preview, setPreview] = useState<{ url?: string; size: number }>({ url: cachedPreview?.url || entry.previewUrl, size: cachedPreview?.size || (entry.previewUrl ? 320 : 0) });
  const [videoUrl, setVideoUrl] = useState<string>();
  const [videoActivated, setVideoActivated] = useState(false);
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoTime, setVideoTime] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const container = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hoverRatioRef = useRef(0);
  const hoverSeekFrameRef = useRef<number>();
  const previewSourceKeyRef = useRef(`${entry.path}|${entry.updatedAt}`);
  const thumbnailRequestRef = useRef<{ key: string; promoted: boolean; promise: ReturnType<typeof projectWorkspaceClient.getMediaThumbnail> }>();
  const failedPreviewLoadCountRef = useRef(0);
  useEffect(() => {
    failedPreviewLoadCountRef.current = 0;
    const sourceKey = `${entry.path}|${entry.updatedAt}`;
    const sourceChanged = previewSourceKeyRef.current !== sourceKey;
    previewSourceKeyRef.current = sourceKey;
    const exactUrl = mediaThumbnailPreviewCache.get(previewCacheKey);
    const cached = exactUrl ? { url: exactUrl, size: requestedSize } : findCachedMediaThumbnailPreview(entry.path, entry.updatedAt);
    setPreview(current => {
      if (sourceChanged) return { url: cached?.url || entry.previewUrl, size: cached?.size || (entry.previewUrl ? 320 : 0) };
      if (cached?.url && cached.size > current.size) return cached;
      if (current.url) return current;
      return { url: entry.previewUrl, size: entry.previewUrl ? 320 : 0 };
    });
    setLoading(false);
    thumbnailRequestRef.current = undefined;
  }, [entry.path, entry.updatedAt, entry.previewUrl, previewCacheKey, requestedSize]);
  useThumbnailUpdates(entry.path, requestedSize, (state, url) => {
    if (state === 'READY') {
      if (url) { rememberMediaThumbnailPreview(previewCacheKey, url); setPreview({ url, size: requestedSize }); }
      setLoading(false);
    } else if (state === 'STALE') {
      forgetMediaThumbnailPreviews(entry.path);
      thumbnailRequestRef.current = undefined;
      setPreview({ url: undefined, size: 0 });
      setVideoUrl(undefined);
      setVideoActivated(false);
      setLoading(true);
      setSourceRevision(version => version + 1);
    } else if (state === 'FAILED' || state === 'MISSING') {
      setLoading(false);
    }
  });
  const requestTileThumbnail = (priority: 0 | 1) => {
    const key = `${entry.path}|${entry.updatedAt}|${requestedSize}`;
    const current = thumbnailRequestRef.current;
    if (current?.key === key) {
      return current.promise.then(result => {
        if (priority === 0 && !current.promoted && (result.state === 'QUEUED' || result.state === 'GENERATING')) {
          current.promoted = true;
          return projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 0, queueOrder);
        }
        return result;
      });
    }
    const promise = projectWorkspaceClient.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, priority, queueOrder);
    thumbnailRequestRef.current = { key, promoted: priority === 0, promise };
    return promise;
  };
  const captureVideoResource = (result: Awaited<ReturnType<typeof projectWorkspaceClient.getMediaThumbnail>>) => {
    if (entry.kind !== 'video') return;
    if (result.mediaUrl) setVideoUrl(result.mediaUrl);
    if (result.importedVideoWithoutPreview) setVideoUnavailable(true);
  };
  useEffect(() => {
    if (preview.size >= requestedSize || !container.current) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      setLoading(true);
      requestThumbnail(() => requestTileThumbnail(1))
        .then(result => {
          if (!active) return;
          if (result.previewUrl) { rememberMediaThumbnailPreview(previewCacheKey, result.previewUrl); setPreview({ url: result.previewUrl, size: requestedSize }); }
          captureVideoResource(result);
          if (result.state !== 'QUEUED' && result.state !== 'GENERATING') setLoading(false);
        })
        .catch(() => { if (active) setLoading(false); });
    }, { rootMargin: '240px' });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [entry.path, entry.kind, entry.updatedAt, preview.size, cacheConfig, requestedSize, queueOrder, previewCacheKey, sourceRevision]);
  useEffect(() => {
    if (!container.current) return;
    let active = true;
    const observer = new IntersectionObserver(([item]) => {
      if (!item.isIntersecting) return;
      observer.disconnect();
      void requestTileThumbnail(0).then(result => {
        if (!active) return;
        captureVideoResource(result);
        if (result.previewUrl) {
          rememberMediaThumbnailPreview(previewCacheKey, result.previewUrl);
          setPreview({ url: result.previewUrl, size: requestedSize });
        }
        if (result.previewUrl || result.state !== 'QUEUED' && result.state !== 'GENERATING') setLoading(false);
      }).catch(() => { if (active) setLoading(false); });
    });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, [entry.kind, entry.path, entry.updatedAt, cacheConfig, requestedSize, queueOrder, previewCacheKey, sourceRevision]);
  useEffect(() => {
    if (!hovering || entry.kind !== 'video' || videoUnavailable) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setVideoActivated(true);
      if (!videoUrl) setLoading(true);
      requestTileThumbnail(0).then(result => {
        if (!active) return;
        captureVideoResource(result);
        if (!result.mediaUrl) setVideoUnavailable(true);
      }).finally(() => { if (active) setLoading(false); });
    }, HOVER_VIDEO_PLAY_DELAY_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [entry.kind, hovering, videoUnavailable, videoUrl]);
  useEffect(() => {
    const video = videoRef.current;
    if (!hovering || !videoActivated || !videoUrl || !video) return;
    let active = true;
    const beginPlayback = () => {
      if (!active) return;
      if (activeHoverVideo && activeHoverVideo !== video) activeHoverVideo.pause();
      activeHoverVideo = video;
      video.play().catch(() => {
        if (!active) return;
        if (activeHoverVideo === video) activeHoverVideo = null;
        setPlaybackFailed(true);
        setPlaying(false);
      });
    };
    const seekBeforePlayback = () => {
      if (!active || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const endBuffer = Math.max(0.05, Math.min(0.5, video.duration * 0.01));
      const targetTime = Math.min(Math.max(0, video.duration - endBuffer), hoverRatioRef.current * video.duration);
      setVideoDuration(video.duration);
      setVideoTime(targetTime);
      if (Math.abs(video.currentTime - targetTime) <= 0.04) { beginPlayback(); return; }
      video.addEventListener('seeked', beginPlayback, { once: true });
      video.currentTime = targetTime;
    };
    const preparePlayback = () => {
      if (!active) return;
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        video.addEventListener('loadeddata', seekBeforePlayback, { once: true });
        return;
      }
      seekBeforePlayback();
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) preparePlayback();
    else video.addEventListener('loadedmetadata', preparePlayback, { once: true });
    return () => {
      active = false;
      video.removeEventListener('loadedmetadata', preparePlayback);
      video.removeEventListener('loadeddata', seekBeforePlayback);
      video.removeEventListener('seeked', beginPlayback);
      video.pause();
      if (activeHoverVideo === video) activeHoverVideo = null;
    };
  }, [hovering, videoActivated, videoUrl]);
  useEffect(() => () => {
    const video = videoRef.current;
    if (video) video.pause();
    if (activeHoverVideo === video) activeHoverVideo = null;
    if (hoverSeekFrameRef.current !== undefined) window.cancelAnimationFrame(hoverSeekFrameRef.current);
  }, []);
  useEffect(() => {
    if (!playing) return;
    let animationFrame = 0;
    const updateProgress = () => {
      const video = videoRef.current;
      if (video) setVideoTime(video.currentTime);
      animationFrame = window.requestAnimationFrame(updateProgress);
    };
    animationFrame = window.requestAnimationFrame(updateProgress);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [playing]);
  const hoverTargetTime = (duration: number, ratio = hoverRatioRef.current) => {
    const endBuffer = Math.max(0.05, Math.min(0.5, duration * 0.01));
    return Math.min(Math.max(0, duration - endBuffer), ratio * duration);
  };
  const seekVideoToRatio = (ratio: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    if (hoverSeekFrameRef.current !== undefined) window.cancelAnimationFrame(hoverSeekFrameRef.current);
    hoverSeekFrameRef.current = window.requestAnimationFrame(() => {
      hoverSeekFrameRef.current = undefined;
      const targetTime = hoverTargetTime(video.duration, ratio);
      video.currentTime = targetTime;
      setVideoTime(targetTime);
    });
  };
  const handleMouseLeave = () => {
    setHovering(false);
    if (hoverSeekFrameRef.current !== undefined) {
      window.cancelAnimationFrame(hoverSeekFrameRef.current);
      hoverSeekFrameRef.current = undefined;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    hoverRatioRef.current = 0;
    setVideoTime(0);
    setVideoActivated(false);
  };
  const seekVideo = (event: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const nextTime = Number(event.currentTarget.value);
    video.currentTime = nextTime;
    if (video.duration > 0) hoverRatioRef.current = nextTime / video.duration;
    setVideoTime(nextTime);
  };
  const restartHoverPlayback = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (!hovering) { setPlaying(false); return; }
    const targetTime = hoverTargetTime(video.duration);
    video.currentTime = targetTime;
    setVideoTime(targetTime);
    video.play().catch(() => setPlaying(false));
  };
  useEffect(() => {
    if (!hovering || entry.kind !== 'video') return;
    let active = true;
    let pollTimer: number | undefined;
    const trackSystemPointer = async () => {
      const [cursorPoint, bounds] = await Promise.all([
        projectWorkspaceClient.getCursorScreenPoint().catch(() => null),
        Promise.resolve(container.current?.getBoundingClientRect()),
      ]);
      if (!active) return;
      if (cursorPoint && bounds && bounds.width > 0) {
        const clientX = cursorPoint.x - window.screenX;
        const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
        if (Math.abs(ratio - hoverRatioRef.current) >= 0.002) {
          hoverRatioRef.current = ratio;
          seekVideoToRatio(ratio);
        }
      }
      pollTimer = window.setTimeout(trackSystemPointer, 40);
    };
    void trackSystemPointer();
    return () => { active = false; window.clearTimeout(pollTimer); };
  }, [entry.kind, hovering]);
  const showVideo = entry.kind === 'video' && videoActivated && videoUrl && !playbackFailed;
  const progress = videoDuration > 0 ? Math.min(100, Math.max(0, videoTime / videoDuration * 100)) : 0;
  const handlePreviewLoadError = () => {
    mediaThumbnailPreviewCache.delete(previewCacheKey);
    thumbnailRequestRef.current = undefined;
    if (failedPreviewLoadCountRef.current >= 1) {
      setPreview({ url: undefined, size: requestedSize });
      setLoading(false);
      return;
    }
    failedPreviewLoadCountRef.current += 1;
    setPreview({ url: undefined, size: 0 });
    setLoading(true);
  };
  return <span ref={container} onMouseEnter={() => setHovering(true)} onMouseLeave={handleMouseLeave} className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black/5">
    {showVideo
      ? <video ref={videoRef} src={videoUrl} muted playsInline preload="auto" poster={preview.url} className="h-full w-full object-contain" onLoadedMetadata={event => { setVideoDuration(event.currentTarget.duration); setLoading(false); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={restartHoverPlayback} onError={() => { setPlaybackFailed(true); setPlaying(false); setLoading(false); }}/>
      : preview.url ? <img src={preview.url} alt="" draggable={false} className="h-full w-full object-contain" onLoad={() => { failedPreviewLoadCountRef.current = 0; setLoading(false); }} onError={handlePreviewLoadError}/> : <FileImage size={large ? 42 : 23} className="text-slate-400"/>}
    {loading && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-900/25"><Loader2 size={large ? 24 : 16} className="animate-spin text-white drop-shadow"/><span className="sr-only">正在加载预览</span></span>}
    {entry.kind === 'video' && !playing && <Play size={large ? 25 : 15} fill="currentColor" className="pointer-events-none absolute text-white drop-shadow-[0_1px_4px_rgba(0,0,0,.8)]"/>}
    {entry.kind === 'video' && showVideo && hovering && videoDuration > 0 && <span className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-black/20 px-2 pb-1.5 pt-3" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <input type="range" min="0" max={videoDuration} step="0.05" value={Math.min(videoTime, videoDuration)} onChange={seekVideo} aria-label={`调整 ${entry.name} 的播放进度`} className="video-hover-seek min-w-0 flex-1" style={{ '--seek-progress': `${progress}%` } as React.CSSProperties}/>
    </span>}
  </span>;
};

type ProjectWorkspaceProps = Omit<FileBrowserWorkspaceProps, 'browserContext' | 'onDirectoryChange' | 'onOpenToolTab' | 'onCloseToolTab' | 'onToolTabBusyChange'> & {
  pageId: string;
  onDirectoryChange?: (pageId: string, relativePath: string) => void;
  onOpenToolTab?: (pageId: string, kind: 'version' | 'team', label: string) => void;
  onCloseToolTab?: (pageId: string, kind: 'version' | 'team') => void;
  onToolTabBusyChange?: (pageId: string, kind: 'version' | 'team', busy: boolean) => void;
};
const ProjectWorkspace = ({ pageId, onDirectoryChange, onOpenToolTab, onCloseToolTab, onToolTabBusyChange, ...props }: ProjectWorkspaceProps) => {
  const bridgeRef = useRef({ onDirectoryChange, onOpenToolTab, onCloseToolTab, onToolTabBusyChange });
  bridgeRef.current = { onDirectoryChange, onOpenToolTab, onCloseToolTab, onToolTabBusyChange };
  const browserContext = useMemo(() => ({ ...PROJECT_FILE_BROWSER_CONTEXT, title: props.project.name }), [props.project.name]);
  const handleDirectoryChange = useCallback((relativePath: string) => bridgeRef.current.onDirectoryChange?.(pageId, relativePath), [pageId]);
  const handleOpenToolTab = useCallback((kind: 'version' | 'team', label: string) => bridgeRef.current.onOpenToolTab?.(pageId, kind, label), [pageId]);
  const handleCloseToolTab = useCallback((kind: 'version' | 'team') => bridgeRef.current.onCloseToolTab?.(pageId, kind), [pageId]);
  const handleToolTabBusyChange = useCallback((kind: 'version' | 'team', busy: boolean) => bridgeRef.current.onToolTabBusyChange?.(pageId, kind, busy), [pageId]);
  return <FileBrowserWorkspace {...props} pageId={pageId} onDirectoryChange={handleDirectoryChange} onOpenToolTab={handleOpenToolTab} onCloseToolTab={handleCloseToolTab} onToolTabBusyChange={handleToolTabBusyChange} browserContext={browserContext}/>;
};

export { FileBrowserWorkspace, ProjectWorkspace };
