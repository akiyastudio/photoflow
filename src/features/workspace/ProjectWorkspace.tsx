import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, FileInput, FolderPlus, Folder, Image as ImageIcon, ScanSearch, GalleryVerticalEnd, Play, Trash2, Edit, X, Plus, Loader2, CheckCircle2, ExternalLink, Video, ChevronDown, ChevronUp, File, FileImage, MemoryStick, LayoutList, Grid2X2, FileText, Copy, Scissors as Cut, ClipboardPaste, CheckSquare, ArrowLeft, ArrowRight, Camera, Aperture, Timer, Gauge, Ruler, Calendar, Activity, Volume2, PanelLeftOpen, ArrowUpDown, ArrowUp, ArrowDown, Search, Info, GripVertical, Maximize2, Minimize2, GitBranch, UsersRound, Heart, RefreshCw, Crop } from 'lucide-react';
import { VersionManager } from '../../components/VersionManager';
import { AdvancedVideoPlayer, videoDirectionalAction, videoDirectionalKeyboardInput } from '../../components/AdvancedVideoPlayer';
import { InteractiveCropEditor } from '../../components/InteractiveCropEditor';
import type { CropRectangle } from '../../components/InteractiveCropEditor';
import { TeamRetouchManager } from '../../components/TeamRetouchManager';
import { PersonIdentityManager } from '../../components/PersonIdentityManager';
import { ProjectVersionTree } from '../../components/ProjectVersionTree';
import type { TeamRetouchStep } from '../../components/TeamRetouchSteps';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useEscapeLayer } from '../../components/LayerProvider';
import { MediaCacheSettings } from '../settings/SettingsFeature';
import { ConverterView, ImportCard, MatchView, ResearchView, ScreenshotMainImageView, VideoTranscodeView } from '../tools/ToolViews';
import { PROJECT_FILE_BROWSER_CONTEXT } from '../file-browser/browser-context';
import type { FileBrowserContext } from '../file-browser/browser-context';
import { normalizeProjectCategoryOrder, PROJECT_TOOLBAR_ACTION_IDS, projectStatusLabel } from '../../types';
import type { AppConfig, ComponentStatus, MediaMetadataField, MediaVersion, MediaVersionBundle, ProgressFolder, ProjectFileEntry, ProjectFileSortField, ProjectToolbarActionId, ShellNewFileType, ThumbnailState, VersionBatchFileOperation, WorkspaceProject } from '../../types';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../../utils/recycleBinFailure';
import { PanelTaskScope, useTaskCenter } from '../background-tasks/TaskCenter';

const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
const FILE_VIRTUAL_OVERSCAN_ROWS = 10;
const RECENT_FILES_PAGE_SIZE = 240;
const RECENT_FILES_LOAD_AHEAD_PX = 900;
const OFFICE_OPEN_XML_EXTENSIONS = new Set([
  '.docx', '.docm', '.dotx', '.dotm',
  '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam',
  '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlam', '.xlsb',
]);
const isOfficeOpenXmlEntry = (entry: ProjectFileEntry) => entry.kind === 'file' && OFFICE_OPEN_XML_EXTENSIONS.has(entry.extension.toLocaleLowerCase());
const SCREENSHOT_MAIN_IMAGE_EXTENSIONS = new Set(['.bmp', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
const isScreenshotMainImageEntry = (entry: ProjectFileEntry) => entry.kind === 'image' && SCREENSHOT_MAIN_IMAGE_EXTENSIONS.has(entry.extension.toLocaleLowerCase());

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

const ToolModal = ({ title, scopeKey, panelKind, open, busy = false, onClose, children }: { title: string; scopeKey: string; panelKind: string; open: boolean; busy?: boolean; onClose: () => void; children: React.ReactNode }) => {
  const { panelTasks, reportPanelTask, dismissPanelTask } = useTaskCenter();
  const taskKey = `${scopeKey}:${panelKind}`;
  const task = panelTasks[taskKey];
  const manualBusyRef = useRef(false);
  const effectiveBusy = busy || task?.state === 'running';
  useEscapeLayer(open, onClose, true);

  useEffect(() => {
    if (busy) {
      manualBusyRef.current = true;
      if (task?.state !== 'running') reportPanelTask({ key: taskKey, scopeKey, panelKind, title }, { state: 'running', progress: task?.progress || 0, message: task?.message || '任务正在运行…', logs: task?.logs || [] });
    } else if (manualBusyRef.current) {
      manualBusyRef.current = false;
      dismissPanelTask(taskKey);
    }
  }, [busy, dismissPanelTask, panelKind, reportPanelTask, scopeKey, task, taskKey, title]);

  return createPortal(<div aria-hidden={!open} className={open ? 'fixed inset-x-0 bottom-0 top-10 z-[360] flex items-center justify-center bg-slate-950/45 p-4' : 'hidden'} onMouseDown={event => { if (event.target === event.currentTarget && !effectiveBusy) onClose(); }}><PanelTaskScope scopeKey={scopeKey} panelKind={panelKind} title={title}><section role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"><header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4"><div className="flex min-w-0 items-center gap-3"><h3 className="truncate text-lg font-bold text-slate-800">{title}</h3>{effectiveBusy && <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-blue-50 px-2 py-1 text-xs font-bold text-blue-600"><Loader2 size={12} className="animate-spin"/>{Math.round(task?.progress || 0)}%</span>}{!effectiveBusy && task?.state === 'completed' && <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-600">已完成</span>}{task?.state === 'failed' && <span className="shrink-0 rounded-full bg-red-50 px-2 py-1 text-xs font-bold text-red-600">失败</span>}</div><button type="button" onClick={onClose} aria-label={effectiveBusy ? '收起到后台' : '关闭'} title={effectiveBusy ? '收起到后台，任务会继续运行' : '关闭'} className={`rounded-md text-slate-500 hover:bg-slate-100 ${effectiveBusy ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold' : 'p-1.5'}`}>{effectiveBusy ? <><Minimize2 size={15}/>收起到后台</> : <X size={18}/>}</button></header><div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div></section></PanelTaskScope></div>, document.body);
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
  const matches = [...mediaThumbnailPreviewCache.entries()].filter(([key]) => key.startsWith(prefix));
  return matches[matches.length - 1]?.[1];
};

const useThumbnailUpdates = (
  filePath: string,
  requestedSize: number,
  onUpdate: (state: ThumbnailState, url?: string) => void,
) => {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const sizeLabel = thumbnailSizeLabel(requestedSize);
  useEffect(() => window.electronAPI.onThumbnailStateChanged(update => {
    if (update.filePath.toLocaleLowerCase() !== filePath.toLocaleLowerCase()) return;
    onUpdateRef.current(update.state, update.previewUrls?.[sizeLabel]);
  }), [filePath, sizeLabel]);
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
const mergeMarqueeSelection = (initialPaths: string[], hitPaths: string[], additive: boolean) => {
  if (!additive) return Array.from(new Set(hitPaths));
  const initialSet = new Set(initialPaths);
  const hitSet = new Set(hitPaths);
  return [
    ...initialPaths.filter(path => !hitSet.has(path)),
    ...hitPaths.filter(path => !initialSet.has(path)),
  ];
};
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

type CompareMatch = { source: string; reference: string; target: string; confidence: string; distance: number };

type ProjectPanel = 'import' | 'negative-import' | 'broll' | 'file-import' | 'match' | 'research' | 'video-transcode' | 'converter' | 'screenshot-main-image' | 'trash' | 'cache' | null;
type MountedProjectPanel = Exclude<ProjectPanel, null>;
type ToolSourceAvailability = { loading: boolean; hasVideo: boolean; hasPng: boolean; pngPaths: string[] };
const PROJECT_PANEL_TITLES: Record<MountedProjectPanel, string> = {
  import: '从 SD 卡导入',
  'negative-import': '导入底片',
  broll: '导入花絮',
  'file-import': '导入文件',
  match: '从文件名选片',
  research: '截取分镜帧',
  'video-transcode': '视频转码',
  converter: 'PNG 转 JPG',
  'screenshot-main-image': '提取截图主图',
  trash: '移入回收站',
  cache: '缩略图缓存',
};
type ProjectBrowseMode = 'recent' | 'grid' | 'list' | 'version-tree';
const isProjectBrowseMode = (value: unknown): value is ProjectBrowseMode => value === 'recent' || value === 'grid' || value === 'list' || value === 'version-tree';
type ProjectFileFilter = 'all' | 'media' | 'image' | 'video';
const PROJECT_FILE_FILTER_OPTIONS: ReadonlyArray<{ value: ProjectFileFilter; label: string }> = [
  { value: 'all', label: '全部文件' },
  { value: 'media', label: '媒体文件' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
];
const normalizeProjectRelativePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
const projectRelativeParentPath = (value: string) => normalizeProjectRelativePath(value).split('/').slice(0, -1).join('/');
const SELECTION_SOURCE_FOLDER_NAMES = new Set(['raw', 'jpg', 'mov', 'mov_预览']);
const SELECTION_BASELINE_FOLDER_NAMES = new Set(['图片选片', '视频选片']);
const PROTECTED_PROJECT_FOLDER_NAMES = new Set(['raw', 'jpg', 'mov', 'mov_预览', '图片选片', '视频选片', '策划', '团片协作']);
const PROGRESS_FOLDER_NAME_PATTERN = /^(?:图片后期|视频后期)_\d+(?:_\d+)*(?:_.+)?$/u;
const entryTopLevelFolderName = (entry: ProjectFileEntry) => normalizeProjectRelativePath(entry.relativePath).split('/')[0]?.toLocaleLowerCase('zh-CN') || '';
const entryIsInSelectionSourceFolder = (entry: ProjectFileEntry) => SELECTION_SOURCE_FOLDER_NAMES.has(entryTopLevelFolderName(entry));
const relativePathTouchesSelectionBaseline = (value: string) => SELECTION_BASELINE_FOLDER_NAMES.has(normalizeProjectRelativePath(value).split('/')[0]?.toLocaleLowerCase('zh-CN') || '');
type ProgressSetupDraft = {
  mode: 'create' | 'import' | 'mark';
  mediaKind: 'image' | 'video';
  relation: 'root' | 'branch';
  parentProgressId: string;
  versionKey: string;
  progressName: string;
  trackingEnabled: boolean;
  deleteSourceAfterImport: boolean;
  renameSources: boolean;
  copyMissingFromParent: boolean;
  targetRelativePath?: string;
  existingProgressId?: string;
};
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

const comparePreviewKind = (fileName: string): 'image' | 'raw' | 'video' => {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLocaleLowerCase();
  if (new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.crm']).has(extension)) return 'video';
  if (new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']).has(extension)) return 'raw';
  return 'image';
};
const comparePreviewPath = (folderPath: string, fileName: string) => `${folderPath.replace(/[\\/]+$/, '')}${folderPath.includes('\\') ? '\\' : '/'}${fileName}`;

const ProgressPairPreview = ({ match, parentFolder, progressFolder, cacheConfig }: {
  match?: { source?: string; reference?: string };
  parentFolder: ProgressFolder;
  progressFolder: ProgressFolder;
  cacheConfig: AppConfig['mediaCache'];
}) => {
  const [mode, setMode] = useState<'side' | 'slider'>('side');
  const [sliderPosition, setSliderPosition] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [resources, setResources] = useState<{ previous?: string; current?: string; loading: boolean; error?: string }>({ loading: false });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const previousPath = match?.reference ? comparePreviewPath(parentFolder.folderPath, match.reference) : '';
  const currentPath = match?.source ? comparePreviewPath(progressFolder.folderPath, match.source) : '';
  const hasBothSides = Boolean(match?.reference && match?.source);

  useEffect(() => {
    let active = true;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setResources({ loading: Boolean(previousPath || currentPath) });
    if (!match || !previousPath && !currentPath) return () => { active = false; };
    const paths = new Map<string, 'previous' | 'current'>();
    if (previousPath) paths.set(previousPath.toLocaleLowerCase(), 'previous');
    if (currentPath) paths.set(currentPath.toLocaleLowerCase(), 'current');
    const unsubscribe = window.electronAPI.onThumbnailStateChanged(update => {
      if (update.state !== 'READY') return;
      const side = paths.get(update.filePath.toLocaleLowerCase());
      const url = update.previewUrls?.large || update.previewUrls?.medium;
      if (side && url) setResources(current => ({ ...current, [side]: url }));
    });
    Promise.all([
      previousPath && match.reference ? window.electronAPI.getMediaThumbnail(previousPath, comparePreviewKind(match.reference), cacheConfig, 1600, 0, -2) : Promise.resolve(undefined),
      currentPath && match.source ? window.electronAPI.getMediaThumbnail(currentPath, comparePreviewKind(match.source), cacheConfig, 1600, 0, -1) : Promise.resolve(undefined),
    ]).then(([previous, current]) => {
      if (!active) return;
      setResources({
        previous: previous?.previewUrl || previous?.mediaUrl,
        current: current?.previewUrl || current?.mediaUrl,
        loading: false,
        error: previous && !previous.success || current && !current.success ? previous?.error || current?.error || '对比预览加载失败' : undefined,
      });
    }).catch(error => {
      if (active) setResources({ loading: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      active = false;
      unsubscribe();
      if (previousPath) void window.electronAPI.cancelMediaThumbnail(previousPath, 1600);
      if (currentPath) void window.electronAPI.cancelMediaThumbnail(currentPath, 1600);
    };
  }, [match?.reference, match?.source, parentFolder.folderPath, progressFolder.folderPath, cacheConfig.directory, cacheConfig.maxSizeGB]);

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoom(current => clampNumber(current * (event.deltaY < 0 ? 1.15 : 0.87), 1, 5));
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPan({ x: dragRef.current.panX + event.clientX - dragRef.current.x, y: dragRef.current.panY + event.clientY - dragRef.current.y });
  };
  const finishPan = () => { dragRef.current = null; };
  const imageStyle: React.CSSProperties = { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center' };
  const previewImage = (url: string | undefined, label: string) => url
    ? <img src={url} alt={label} draggable={false} style={imageStyle} className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain transition-transform duration-75"/>
    : <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">{resources.loading ? <Loader2 size={22} className="animate-spin"/> : '没有可用预览'}</div>;

  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-950">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 bg-slate-900 px-3 py-2">
      {hasBothSides ? <div className="flex items-center gap-1 rounded-lg bg-slate-800 p-1 text-xs"><button type="button" onClick={() => setMode('side')} className={`rounded px-2 py-1 ${mode === 'side' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>并排</button><button type="button" onClick={() => setMode('slider')} className={`rounded px-2 py-1 ${mode === 'slider' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>滑块</button></div> : <span className="text-xs text-slate-400">单项预览</span>}
      <div className="flex items-center gap-1 text-xs text-slate-300"><button type="button" onClick={() => setZoom(current => clampNumber(current / 1.2, 1, 5))} className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">−</button><button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="min-w-12 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">{Math.round(zoom * 100)}%</button><button type="button" onClick={() => setZoom(current => clampNumber(current * 1.2, 1, 5))} className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">＋</button></div>
    </header>
    {!match ? <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-slate-400">选择左侧的一组匹配以查看图片对比。</div> : <>
      <div className={`grid border-b border-slate-700 bg-slate-900 text-xs font-bold text-slate-300 ${hasBothSides && mode === 'side' ? 'grid-cols-2' : 'grid-cols-1'}`}>{hasBothSides && mode === 'side' ? <><div className="truncate border-r border-slate-700 px-3 py-2" title={match.reference}>上一版本 · {match.reference}</div><div className="truncate px-3 py-2" title={match.source}>当前版本 · {match.source}</div></> : hasBothSides ? <div className="flex justify-between gap-3 px-3 py-2"><span className="truncate" title={match.reference}>上一版本 · {match.reference}</span><span className="truncate text-right" title={match.source}>当前版本 · {match.source}</span></div> : <div className="truncate px-3 py-2" title={match.source || match.reference}>{match.source ? `当前版本 · ${match.source}` : `上一版本 · ${match.reference}`}</div>}</div>
      <div onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finishPan} onPointerCancel={finishPan} className={`relative min-h-[300px] flex-1 overflow-hidden ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}>
        {!hasBothSides ? <div className="absolute inset-0">{previewImage(match.source ? resources.current : resources.previous, match.source || match.reference || '')}</div> : mode === 'side' ? <div className="grid h-full grid-cols-2"><div className="relative overflow-hidden border-r border-slate-700">{previewImage(resources.previous, match.reference || '')}</div><div className="relative overflow-hidden">{previewImage(resources.current, match.source || '')}</div></div> : <><div className="absolute inset-0">{previewImage(resources.previous, match.reference || '')}</div><div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }}>{previewImage(resources.current, match.source || '')}</div><div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${sliderPosition}%` }}/></>}
      </div>
      {hasBothSides && mode === 'slider' && <div className="border-t border-slate-700 bg-slate-900 px-4 py-2"><input aria-label="调整新旧版本分界线" type="range" min="0" max="100" value={sliderPosition} onChange={event => setSliderPosition(Number(event.target.value))} className="w-full accent-blue-500"/></div>}
      {resources.error && <p className="border-t border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-300">{resources.error}</p>}
    </>}
  </section>;
};
type PreviewTechnicalMetadata = { width?: number; height?: number; duration?: number; unavailable?: boolean };
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
  initialPanel: 'import' | 'broll' | 'match' | null;
  importConfig: AppConfig['smartImport'];
  importDefaults: AppConfig['importDefaults'];
  brollConfig: AppConfig['brollImport'];
  matchConfig: AppConfig['smartMatch'];
  researchConfig: AppConfig['research'];
  mediaCacheConfig: AppConfig['mediaCache'];
  defaultFolderSort: ProjectFileSortField;
  browserContext: FileBrowserContext;
  navigationRequest?: { path: string; id: number };
  onDirectoryChange?: (relativePath: string) => void;
  onOpenInspirationPath?: (relativePath: string) => void;
  onOpenToolTab?: (kind: 'version' | 'team', label: string) => void;
  onCloseToolTab?: (kind: 'version' | 'team') => void;
  onToolTabBusyChange?: (kind: 'version' | 'team', busy: boolean) => void;
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onMatchConfigChange: (config: AppConfig['smartMatch']) => void;
  onResearchConfigChange: (config: AppConfig['research']) => void;
  onMediaCacheConfigChange: (config: AppConfig['mediaCache']) => void;
  onNotice: (message: string, duration?: number) => void;
  onProjectMoved?: (project: WorkspaceProject) => void;
  onDeleted?: () => void;
};

const FileBrowserWorkspace = ({ active, activeView, project, workspacePath, inspirationTargetWorkspacePath, inspirationLibraryRootPath, installedComponentIds, componentsLoading, teamRetouchStatus, advancedVideoSettings, projectToolbar = { order: [...PROJECT_TOOLBAR_ACTION_IDS], hidden: [], onlyShowAvailable: false }, customProjectCategories = [], projectCategoryOrder = [], initialPanel, importConfig, importDefaults, brollConfig, matchConfig, researchConfig, mediaCacheConfig, defaultFolderSort, browserContext, navigationRequest, onDirectoryChange, onOpenInspirationPath, onOpenToolTab = () => undefined, onCloseToolTab = () => undefined, onToolTabBusyChange = () => undefined, onImportConfigChange, onMatchConfigChange, onResearchConfigChange, onMediaCacheConfigChange, onNotice, onProjectMoved = () => undefined, onDeleted = () => undefined }: FileBrowserWorkspaceProps) => {
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
  const { panelTasks } = useTaskCenter();
  const [folders, setFolders] = useState<Array<{ name: string; path: string; updatedAt: number }>>([]);
  const [progressFolders, setProgressFolders] = useState<ProgressFolder[]>([]);
  const [fileEntries, setFileEntries] = useState<ProjectFileEntry[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(active);
  const [virtualWindow, setVirtualWindow] = useState({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 });
  const virtualWindowRef = useRef(virtualWindow);
  virtualWindowRef.current = virtualWindow;
  const [currentRelativePath, setCurrentRelativePath] = useState('');
  const [directoryHistory, setDirectoryHistory] = useState<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const [browseMode, setBrowseMode] = useState<ProjectBrowseMode>('grid');
  const viewMode: 'list' | 'grid' = browseMode === 'list' ? 'list' : 'grid';
  const recursiveFlatOpen = browseMode === 'recent';
  const versionTreeOpen = browseMode === 'version-tree';
  const [gridIconSize, setGridIconSize] = useState(132);
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
  const [searchEntries, setSearchEntries] = useState<ProjectFileEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [recentCursor, setRecentCursor] = useState('');
  const [recentHasMore, setRecentHasMore] = useState(false);
  const [recentLoadingMore, setRecentLoadingMore] = useState(false);
  const [recentLoadError, setRecentLoadError] = useState('');
  const [recentRefreshToken, setRecentRefreshToken] = useState(0);
  const [rootWatchFailed, setRootWatchFailed] = useState(false);
  useEffect(() => {
    if (searchQuery && !searchOpen) setSearchOpen(true);
  }, [searchQuery, searchOpen]);
  const projectWorkspaceRef = useRef<HTMLDivElement>(null);
  const projectColumnLayoutRef = useRef<HTMLDivElement>(null);
  const filesColumnRef = useRef<HTMLDivElement>(null);
  const filesSurfaceRef = useRef<HTMLDivElement>(null);
  const fileRevealFrameRef = useRef(0);
  const fileRevealPathRef = useRef('');
  const didInitializePathRefreshRef = useRef(false);
  const wasActiveRef = useRef(active);
  const skipNextPathRefreshRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const currentRelativePathRef = useRef('');
  const projectPathRef = useRef(project.path);
  const directoryEntriesCacheRef = useRef(new Map<string, ProjectFileEntry[]>());
  const directoryPrefetchesRef = useRef(new Map<string, Promise<ProjectFileEntry[]>>());
  const previewVersionCacheRef = useRef(new Map<string, MediaVersion>());
  const previewVersionRequestsRef = useRef(new Map<string, Promise<MediaVersionBundle>>());
  const selectionDragRef = useRef<{ pointerId: number; startX: number; startY: number; initialPaths: string[]; additive: boolean; started: boolean; clearPreviewOnFinish: boolean } | null>(null);
  const internalDragPathsRef = useRef<string[]>([]);
  const internalDropHandledRef = useRef(false);
  const renameCommitRef = useRef(false);
  const selectionAnchorPathRef = useRef('');
  const entryPointerModifiersRef = useRef<{ path: string; additive: boolean; range: boolean } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchSequenceRef = useRef(0);
  const recentLoadInFlightRef = useRef(false);
  const clipboardOperationSequenceRef = useRef(0);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  useEffect(() => {
    selectionAnchorPathRef.current = '';
    setSelectedPaths([]);
  }, [fileFilter]);
  const [cutPaths, setCutPaths] = useState<string[]>([]);
  const [dragTargetPath, setDragTargetPath] = useState('');
  const [recursiveDropTargetPath, setRecursiveDropTargetPath] = useState<string | null>(null);
  const [surfaceDropActive, setSurfaceDropActive] = useState(false);
  const [operationDirectoryPath, setOperationDirectoryPath] = useState('');
  const [previewPath, setPreviewPath] = useState('');
  const [previewTechnicalMetadata, setPreviewTechnicalMetadata] = useState<PreviewTechnicalMetadata>({});
  const [previewMetadataFields, setPreviewMetadataFields] = useState<MediaMetadataField[]>([]);
  const [previewMetadataResolvedPath, setPreviewMetadataResolvedPath] = useState('');
  const [previewMetadataLoading, setPreviewMetadataLoading] = useState(false);
  const [previewMetadataError, setPreviewMetadataError] = useState('');
  const [previewEntryDetails, setPreviewEntryDetails] = useState<ProjectEntryDetails | null>(null);
  const [viewportCurrentPath, setViewportCurrentPath] = useState('');
  const [viewportStatus, setViewportStatus] = useState<{ path: string; fileNumber: number; total: number; captureDateTime?: string } | null>(null);
  const [previewPaneOpen, setPreviewPaneOpen] = useState(false);
  const fileRevealRequestIdRef = useRef(0);
  const [pendingFileReveal, setPendingFileReveal] = useState<{ path: string; requestId: number; align: 'nearest' | 'center' } | null>(null);
  const previousPaneLayoutRef = useRef('');
  const paneLayoutRevealPendingRef = useRef(false);
  const paneLayoutRevealPathRef = useRef('');
  const metadataAutoOpenDismissedFoldersRef = useRef(new Set<string>());
  const [metadataPaneOpen, setMetadataPaneOpen] = useState(false);
  const [columnWidths, setColumnWidths] = useState(() => ({
    files: readStoredNumber('photoflow:files-column-width', 560),
    preview: readStoredNumber('photoflow:preview-column-width', 340),
    metadata: readStoredNumber('photoflow:metadata-column-width', 320)
  }));
  const [projectLayoutWidth, setProjectLayoutWidth] = useState(0);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const cancelSelectionDrag = () => {
      selectionDragRef.current = null;
      setSelectionBox(null);
    };
    window.addEventListener('pointerup', cancelSelectionDrag);
    window.addEventListener('pointercancel', cancelSelectionDrag);
    window.addEventListener('blur', cancelSelectionDrag);
    return () => {
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
  const [deleteBrollSources, setDeleteBrollSources] = useState(importDefaults.deleteSourceAfterImport);
  const [deleteFileSources, setDeleteFileSources] = useState(importDefaults.deleteSourceAfterImport);
  const [fileImportTarget, setFileImportTarget] = useState('');
  const [panelImportBusy, setPanelImportBusy] = useState<'broll' | 'files' | ''>('');
  const [panelImportResult, setPanelImportResult] = useState<{ kind: 'broll' | 'files'; count: number; sourceDeleted: boolean } | null>(null);
  const [sdImportBusy, setSdImportBusy] = useState(false);
  const [negativeImportBusy, setNegativeImportBusy] = useState(false);
  const [negativeImportCompleted, setNegativeImportCompleted] = useState(false);
  const [researchTargetPath, setResearchTargetPath] = useState('');
  const [researchTargetKind, setResearchTargetKind] = useState<'file' | 'folder'>('file');
  const [researchTargetHasTxt, setResearchTargetHasTxt] = useState(false);
  const [videoTranscodeTargets, setVideoTranscodeTargets] = useState<string[]>([]);
  const [videoTranscodeSourceFolders, setVideoTranscodeSourceFolders] = useState<string[]>([]);
  const [videoTranscodeCollecting, setVideoTranscodeCollecting] = useState(false);
  const [selectedToolSourceAvailability, setSelectedToolSourceAvailability] = useState<ToolSourceAvailability>({ loading: false, hasVideo: false, hasPng: false, pngPaths: [] });
  const [fileMenuToolSourceAvailability, setFileMenuToolSourceAvailability] = useState<ToolSourceAvailability>({ loading: false, hasVideo: false, hasPng: false, pngPaths: [] });
  const selectedToolSourceInspectionSequenceRef = useRef(0);
  const fileMenuToolSourceInspectionSequenceRef = useRef(0);
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
  const projectPanelTaskKey = useCallback((kind: MountedProjectPanel) => `${project.path}:${kind}`, [project.path]);
  const projectPanelTask = useCallback((kind: MountedProjectPanel) => panelTasks[projectPanelTaskKey(kind)], [panelTasks, projectPanelTaskKey]);
  const projectPanelIsRunning = useCallback((kind: MountedProjectPanel) => projectPanelTask(kind)?.state === 'running', [projectPanelTask]);
  useEffect(() => {
    const restorePanelTask = (event: Event) => {
      const detail = (event as CustomEvent<{ scopeKey?: string; panelKind?: string }>).detail;
      if (detail?.scopeKey !== project.path || !detail.panelKind || !(detail.panelKind in PROJECT_PANEL_TITLES)) return;
      setPanel(detail.panelKind as MountedProjectPanel);
    };
    window.addEventListener('photoflow:restore-panel-task', restorePanelTask);
    return () => window.removeEventListener('photoflow:restore-panel-task', restorePanelTask);
  }, [project.path]);
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
  const [progressSetup, setProgressSetup] = useState<ProgressSetupDraft | null>(null);
  const [progressImportCompletion, setProgressImportCompletion] = useState('');
  const [progressCompare, setProgressCompare] = useState<ProgressCompareConfirmation | null>(null);
  const [progressCompareFilter, setProgressCompareFilter] = useState<ProgressCompareFilter>('recognized');
  const [activeProgressCompareItemKey, setActiveProgressCompareItemKey] = useState('');
  const [progressTask, setProgressTask] = useState('');
  const [progressSubmitting, setProgressSubmitting] = useState(false);
  const progressImportOperationIdRef = useRef('');
  const progressImportBackdropCancellingRef = useRef(false);
  const [progressRepair, setProgressRepair] = useState<{ progressFolder: ProgressFolder; batchId: string; operations: VersionBatchFileOperation[] } | null>(null);
  const [progressRepairBusy, setProgressRepairBusy] = useState(false);
  const closeProgressSetup = useCallback(() => {
    setProgressImportCompletion('');
    setProgressSetup(null);
  }, []);
  useEscapeLayer(Boolean(progressSetup), closeProgressSetup, !progressSubmitting && !progressTask);
  useEscapeLayer(Boolean(progressCompare), () => { void closeProgressCompare(); }, !progressSubmitting);
  useEscapeLayer(Boolean(progressRepair), () => setProgressRepair(null), !progressRepairBusy);
  useEscapeLayer(batchRenameOpen, () => { if (!renameCommitRef.current) setBatchRenameOpen(false); });
  useEscapeLayer(confirmDelete, () => setConfirmDelete(false));
  useEscapeLayer(Boolean(gatherPickerPaths), () => setGatherPickerPaths(null), !gatheringInspiration);
  const [fileMenu, setFileMenu] = useState<{ entry: ProjectFileEntry; x: number; y: number } | null>(null);
  const [surfaceMenu, setSurfaceMenu] = useState<{ x: number; y: number; targetRelativePath: string; targetLabel: string } | null>(null);
  const [missingProgressMenu, setMissingProgressMenu] = useState<{ folder: ProgressFolder; x: number; y: number } | null>(null);
  const [clipboardHasFiles, setClipboardHasFiles] = useState(false);
  const [photoshopAvailable, setPhotoshopAvailable] = useState(false);
  const [conversionTargets, setConversionTargets] = useState<string[]>([]);
  const [screenshotMainImageTargets, setScreenshotMainImageTargets] = useState<string[]>([]);
  const [screenshotMainImageMode, setScreenshotMainImageMode] = useState<'extract' | 'crop'>('extract');
  const [versionEntry, setVersionEntry] = useState<ProjectFileEntry | null>(null);
  const [teamRetouchEntries, setTeamRetouchEntries] = useState<ProjectFileEntry[]>([]);
  const [teamRetouchHistory, setTeamRetouchHistory] = useState<ProjectFileEntry[]>([]);
  const [teamRetouchStep, setTeamRetouchStep] = useState<TeamRetouchStep | null>(null);
  const [teamRetouchOpening, setTeamRetouchOpening] = useState(false);
  const teamRetouchHistoryRequestRef = useRef<Promise<ProjectFileEntry[]> | null>(null);
  const teamRetouchWorkflowGeneratedRef = useRef(false);
  const [finalVersionSummary, setFinalVersionSummary] = useState({ count: 0, availableCount: 0, missingCount: 0 });
  const [finalExporting, setFinalExporting] = useState(false);
  const [finalViewOpen, setFinalViewOpen] = useState(false);
  const [finalViewLoading, setFinalViewLoading] = useState(false);
  const [finalViewEntries, setFinalViewEntries] = useState<ProjectFileEntry[]>([]);
  const [previewVersion, setPreviewVersion] = useState<MediaVersion | null>(null);
  const [previewVersionLoading, setPreviewVersionLoading] = useState(false);
  const [previewVersionBusy, setPreviewVersionBusy] = useState(false);
  const [drives, setDrives] = useState<string[]>([]);
  const requestFileReveal = useCallback((path: string, align: 'nearest' | 'center' = 'nearest') => {
    fileRevealRequestIdRef.current += 1;
    setPendingFileReveal({ path, requestId: fileRevealRequestIdRef.current, align });
  }, []);

  useEffect(() => {
    void window.electronAPI.getPhotoshopStatus().then(result => setPhotoshopAvailable(result.available));
  }, []);

  useEffect(() => window.electronAPI.onProjectFileOperationProgress(progress => {
    if (progress.operation !== 'import-progress') return;
    if (progress.projectName && progress.projectName !== project.name) return;
    if (progress.phase === 'complete' || progress.phase === 'cancelled' || progress.phase === 'failed') {
      if (progressImportOperationIdRef.current === progress.operationId) progressImportOperationIdRef.current = '';
      return;
    }
    progressImportOperationIdRef.current = progress.operationId;
  }), [project.name]);

  const inspirationMode = browserContext.kind === 'inspiration';
  const { projectWorkflows, gatherToProject, watchRootDirectly, rootRelativeFileEvents, previewOnlyOnMediaClick } = browserContext.capabilities;
  const officeImageExtractorAvailable = true;
  const teamRetouchInstalled = installedComponentIds.has('team-retouch');
  const teamRetouchAvailable = teamRetouchInstalled || componentsLoading;
  const folderBrowseModeStorageKey = `photoflow:folder-browse-modes:${browserContext.kind}:${workspacePath}|${project.name}`;
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
    if (mode === 'version-tree' && normalizedPath) return;
    try {
      window.localStorage.setItem(folderBrowseModeStorageKey, JSON.stringify({ ...readFolderBrowseModes(), [normalizedPath]: mode }));
    } catch { /* storage unavailable */ }
  };
  const hasVersionTreeFor = (foldersToCheck = progressFolders) => projectWorkflows && foldersToCheck.some(folder => folder.versionKey === '0' && !folder.folderMissing);
  const browseModeForFolder = (relativePath: string, foldersToCheck = progressFolders): ProjectBrowseMode => {
    const normalizedPath = normalizeProjectRelativePath(relativePath);
    const remembered = storedFolderBrowseMode(normalizedPath);
    if (normalizedPath && remembered === 'version-tree') return 'grid';
    if (!normalizedPath && remembered === 'version-tree' && !hasVersionTreeFor(foldersToCheck)) return 'grid';
    if (remembered) return remembered;
    return !normalizedPath && hasVersionTreeFor(foldersToCheck) ? 'version-tree' : 'grid';
  };
  const selectFolderBrowseMode = (mode: ProjectBrowseMode) => {
    if (mode === 'version-tree' && (currentRelativePath || !hasVersionTreeFor())) return;
    rememberFolderBrowseMode(currentRelativePath, mode);
    setBrowseMode(mode);
  };
  const projectVersionTreeAvailable = !currentRelativePath && hasVersionTreeFor();

  useEffect(() => {
    if (!gatherToProject || !inspirationTargetWorkspacePath?.trim()) {
      setInspirationProjects([]);
      setInspirationTargetProject(null);
      return;
    }
    let disposed = false;
    const loadProjects = async () => {
      const result = await window.electronAPI.getWorkspaceProjects(inspirationTargetWorkspacePath);
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
    const request: Promise<ProjectFileEntry[]> = window.electronAPI.getTeamProjectWorkspace(workspacePath, project.name, project.status).then(result => {
      if (!result.success) throw new Error(result.error || '无法读取团片协作记录');
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
    const fetchDrives = () => window.electronAPI?.getDrives?.().then(nextDrives => setDrives(current =>
      current.length === nextDrives.length && current.every((drive, index) => drive === nextDrives[index]) ? current : nextDrives
    ));
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

  const loadProgressFolders = useCallback(async () => {
    const result = await window.electronAPI.getProgressFolders(workspacePath, project.name);
    if (result.success) {
      setProgressFolders(result.progressFolders);
      return result.progressFolders;
    }
    onNotice(`读取版本进度失败：${result.error || '未知错误'}`);
    return [];
  }, [workspacePath, project.name, onNotice]);
  const ensureSelectionBaseline = useCallback(async (showError = false) => {
    const result = await window.electronAPI.ensureSelectionBaseline(workspacePath, project.status, project.name);
    if (!result.success) {
      if (showError) onNotice(`建立选片 V0 基线失败：${result.error || '未知错误'}`, 7000);
      return result;
    }
    if (result.registered) await loadProgressFolders();
    return result;
  }, [workspacePath, project.status, project.name, loadProgressFolders, onNotice]);
  const loadFinalVersionSummary = useCallback(async () => {
    const result = await window.electronAPI.getFinalVersionSummary(workspacePath, project.name);
    if (result.success) {
      const summary = { count: result.count, availableCount: result.availableCount, missingCount: result.missingCount };
      setFinalVersionSummary(summary);
      return summary;
    }
    setFinalVersionSummary({ count: 0, availableCount: 0, missingCount: 0 });
    return { count: 0, availableCount: 0, missingCount: 0 };
  }, [workspacePath, project.name]);
  const loadFinalViewEntries = useCallback(async (showMissingNotice = false) => {
    setFinalViewLoading(true);
    try {
      const result = await window.electronAPI.browseFinalVersions(workspacePath, project.status, project.name);
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
  const openFinalVersionView = async () => {
    const result = await loadFinalViewEntries(true);
    if (!result?.count) {
      if (result) onNotice('当前项目还没有标记为喜爱的图片');
      return;
    }
    setFinalViewOpen(true);
    setSelectedPaths([]);
    setPreviewPath('');
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(false);
    setSearchOpen(false);
    setSearchQuery('');
  };
  const closeFinalVersionView = () => {
    setFinalViewOpen(false);
    setSelectedPaths([]);
    setPreviewPath('');
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(false);
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
    const contentsPromise = window.electronAPI.getProjectContents(workspacePath, project.status, project.name);
    const browseResult = await window.electronAPI.browseProjectFiles(workspacePath, project.status, project.name, requestedPath, mediaCacheConfig);
    if (refreshSequence !== refreshSequenceRef.current || requestedPath !== currentRelativePathRef.current || requestedProjectPath !== projectPathRef.current) return;
    setDirectoryLoading(false);
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

  const removeMissingProgress = async (folder: ProgressFolder) => {
    if (!folder.folderMissing || folder.versionKey === '0') return;
    const confirmed = await appDialog.confirm({
      title: `移除失效版本 V${folder.versionKey}？`,
      message: `将移除“${folder.displayName}”的数据库进度节点及其失效版本记录，不会删除项目目录中的素材文件；关联缓存和内部工作文件会在后台清理。后代版本会自动连接到上一级；移除后，即使恢复原文件夹也不会再自动连接。`,
      confirmLabel: '移除记录',
      tone: 'danger',
    });
    if (!confirmed) return;
    const result = await window.electronAPI.deleteMissingProgressFolder(workspacePath, project.name, folder.id);
    if (!result.success) {
      onNotice(`移除失效版本失败：${result.error || '未知错误'}`, 7000);
      return;
    }
    directoryEntriesCacheRef.current.clear();
    await Promise.all([loadProgressFolders(), refresh()]);
    setVersionEntry(current => current ? { ...current, updatedAt: Date.now() } : current);
    const deletedVersions = result.deletedVersionCount || 0;
    onNotice(`已移除 V${result.versionKey || folder.versionKey} 失效记录${deletedVersions ? `，并清理 ${deletedVersions} 条失效素材版本` : ''}`);
  };

  useEffect(() => {
    projectPathRef.current = project.path;
    currentRelativePathRef.current = '';
    refreshSequenceRef.current += 1;
    directoryEntriesCacheRef.current.clear();
    directoryPrefetchesRef.current.clear();
    setProgressFolders([]);
    setFileEntries([]);
    setDirectoryLoading(active);
    setDirectoryHistory({ back: [], forward: [] });
    setPreviewPath('');
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(false);
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
    setBrowseMode(browseModeForFolder('', []));
    if (currentRelativePath) skipNextPathRefreshRef.current = true;
    setCurrentRelativePath('');
    if (active) {
      refresh('');
      if (projectWorkflows) {
        void loadProgressFolders();
        void ensureSelectionBaseline();
        void loadFinalVersionSummary();
      }
    }
  }, [project.path, project.status, initialPanel, projectWorkflows]);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      refresh(currentRelativePathRef.current);
      if (projectWorkflows) {
        void loadProgressFolders();
        void ensureSelectionBaseline();
        void loadFinalVersionSummary();
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
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(false);
    setInlineRenamePath('');
    setInlineRenameValue('');
    setFileMenu(null);
    setMissingProgressMenu(null);
    refresh();
  }, [currentRelativePath]);
  useEffect(() => {
    onDirectoryChange?.(currentRelativePath);
  }, [currentRelativePath, onDirectoryChange]);
  useEffect(() => {
    setOperationDirectoryPath(currentRelativePath);
  }, [currentRelativePath, recursiveFlatOpen]);
  useEffect(() => {
    if (!active || !watchRootDirectly) return;
    let disposed = false;
    setRootWatchFailed(false);
    void window.electronAPI.watchFileRoot(workspacePath, project.status, project.name).then(result => {
      if (!disposed) setRootWatchFailed(!result.success);
    });
    return () => {
      disposed = true;
      void window.electronAPI.unwatchFileRoot(workspacePath, project.status, project.name);
    };
  }, [active, project.name, project.status, watchRootDirectly, workspacePath]);
  useEffect(() => {
    if (!active || !watchRootDirectly || !rootWatchFailed) return;
    // Network drives and some virtual filesystems cannot be watched. Keep a
    // low-frequency fallback without making polling the normal code path.
    const interval = window.setInterval(() => refresh(currentRelativePathRef.current), 2500);
    return () => window.clearInterval(interval);
  }, [active, rootWatchFailed, watchRootDirectly, workspacePath, project.path]);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let selectionBaselineTimer: number | undefined;
    let progressFolderTimer: number | undefined;
    const normalizedWorkspaceRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
    const normalizedProjectPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const projectPrefix = rootRelativeFileEvents
      ? ''
      : normalizedProjectPath.toLocaleLowerCase().startsWith(`${normalizedWorkspaceRoot}/`)
        ? normalizedProjectPath.slice(normalizedWorkspaceRoot.length + 1)
        : project.name.replace(/\\/g, '/');
    const unsubscribe = window.electronAPI.onWorkspaceFilesChanged(change => {
      if (change.root && change.root.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase() !== normalizedWorkspaceRoot) return;
      if (change.watcherFailed && watchRootDirectly) setRootWatchFailed(true);
      const changedPath = (change.fileName || '').replace(/\\/g, '/');
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
        if (projectWorkflows && relativePathTouchesSelectionBaseline(projectRelativePath)) {
          window.clearTimeout(selectionBaselineTimer);
          selectionBaselineTimer = window.setTimeout(() => void ensureSelectionBaseline(), 750);
        }
        const changedParentPath = projectRelativePath.split('/').slice(0, -1).join('/');
        const currentPath = currentRelativePathRef.current.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
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
      window.clearTimeout(selectionBaselineTimer);
      window.clearTimeout(progressFolderTimer);
      unsubscribe();
    };
  }, [active, workspacePath, project.path, project.status, project.name, rootRelativeFileEvents, watchRootDirectly, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB, finalViewOpen, loadFinalViewEntries, projectWorkflows, ensureSelectionBaseline, loadProgressFolders]);
  useEffect(() => {
    if (!active) return;
    const unsubscribe = window.electronAPI.onThumbnailStateChanged(update => {
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
    if ((!query && !recursiveFlatOpen) || finalViewOpen) {
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
        ? window.electronAPI.searchProjectFiles(workspacePath, project.status, project.name, currentRelativePath, query)
        : window.electronAPI.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE);
      void request.then(result => {
        if (sequence !== searchSequenceRef.current) return;
        if (result.success) {
          setSearchEntries(result.entries);
          const recentResult = result as { cursor?: string; hasMore?: boolean };
          setRecentCursor(!query ? recentResult.cursor || '' : '');
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
  }, [searchQuery, recursiveFlatOpen, currentRelativePath, finalViewOpen, workspacePath, project.status, project.name, recentRefreshToken]);
  const loadMoreRecentFiles = useCallback(async () => {
    if (!recursiveFlatOpen || searchQuery.trim() || finalViewOpen || !recentHasMore || !recentCursor || recentLoadInFlightRef.current) return;
    recentLoadInFlightRef.current = true;
    setRecentLoadingMore(true);
    setRecentLoadError('');
    const sequence = searchSequenceRef.current;
    try {
      const result = await window.electronAPI.listRecentProjectFiles(workspacePath, project.status, project.name, currentRelativePath, RECENT_FILES_PAGE_SIZE, recentCursor);
      if (sequence !== searchSequenceRef.current) return;
      if (!result.success) {
        setRecentHasMore(false);
        setRecentLoadError(result.error || '继续读取最近文件失败');
        return;
      }
      setSearchEntries(current => {
        const existing = new Set(current.map(entry => entry.path.toLocaleLowerCase()));
        return [...current, ...result.entries.filter(entry => !existing.has(entry.path.toLocaleLowerCase()))];
      });
      setRecentCursor(result.cursor || '');
      setRecentHasMore(Boolean(result.hasMore));
    } finally {
      if (sequence === searchSequenceRef.current) {
        recentLoadInFlightRef.current = false;
        setRecentLoadingMore(false);
      }
    }
  }, [currentRelativePath, finalViewOpen, project.name, project.status, recentCursor, recentHasMore, recursiveFlatOpen, searchQuery, workspacePath]);
  useEffect(() => {
    if (!recursiveFlatOpen || searchQuery.trim() || finalViewOpen || !recentHasMore) return;
    const container = filesColumnRef.current;
    if (!container) return;
    let frame = 0;
    const loadNearBottom = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (container.scrollHeight - container.scrollTop - container.clientHeight <= RECENT_FILES_LOAD_AHEAD_PX) void loadMoreRecentFiles();
      });
    };
    loadNearBottom();
    container.addEventListener('scroll', loadNearBottom, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', loadNearBottom);
    };
  }, [finalViewOpen, loadMoreRecentFiles, recentHasMore, recentLoadingMore, recursiveFlatOpen, searchEntries.length, searchQuery]);
  useEffect(() => {
    const closeMenus = () => { setFileMenu(null); setSurfaceMenu(null); setMissingProgressMenu(null); setShowStatusMenu(false); setShowCreateMenu(false); setShowImportMenu(false); setShowVideoToolsMenu(false); setShowSortMenu(false); };
    window.addEventListener('click', closeMenus);
    window.addEventListener('photoflow-menu-open', closeMenus);
    return () => { window.removeEventListener('click', closeMenus); window.removeEventListener('photoflow-menu-open', closeMenus); };
  }, []);

  const recursiveSearchActive = (recursiveFlatOpen || Boolean(searchQuery.trim())) && !finalViewOpen;
  const groupedResultsActive = recursiveFlatOpen && !finalViewOpen;
  const activeFileEntries = recursiveSearchActive ? searchEntries : finalViewOpen ? finalViewEntries : fileEntries;
  const displayedFileEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('zh-CN');
    const queryFiltered = normalizedQuery && !recursiveSearchActive ? activeFileEntries.filter(entry => entry.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) : activeFileEntries;
    const filtered = fileFilter === 'all' ? queryFiltered : queryFiltered.filter(entry => {
      if (fileFilter === 'image') return entry.kind === 'image' || entry.kind === 'raw';
      if (fileFilter === 'video') return entry.kind === 'video';
      return entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video';
    });
    const effectiveSortField = sortField;
    const direction = sortDirection === 'asc' ? 1 : -1;
    return [...filtered].sort((left, right) => {
      if (left.kind === 'folder' && right.kind !== 'folder') return -1;
      if (left.kind !== 'folder' && right.kind === 'folder') return 1;
      let comparison = 0;
      if (effectiveSortField === 'date') comparison = left.updatedAt - right.updatedAt;
      else if (effectiveSortField === 'size') comparison = left.size - right.size;
      else comparison = left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      return comparison === 0
        ? left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
        : comparison * direction;
    });
  }, [activeFileEntries, fileFilter, recursiveFlatOpen, searchQuery, recursiveSearchActive, sortDirection, sortField]);
  const filteredFileTypeLabel = fileFilter === 'all' ? '文件' : PROJECT_FILE_FILTER_OPTIONS.find(option => option.value === fileFilter)?.label || '文件';
  const searchResultGroups = useMemo(() => {
    if (!groupedResultsActive) return [];
    const groups = new Map<string, ProjectFileEntry[]>();
    for (const entry of displayedFileEntries) {
      const normalizedPath = entry.relativePath.replace(/\\/g, '/');
      const folderPath = normalizedPath.split('/').slice(0, -1).join('/');
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
  const renderedFileEntries = displayedFileEntries.slice(virtualWindow.start, virtualWindow.end);
  const pathSegments = currentRelativePath.split(/[\\/]/).filter(Boolean);
  const browserRootLabel = inspirationMode ? browserContext.title : project.name;
  const breadcrumbs = pathSegments.map((label, index) => ({ label, relativePath: pathSegments.slice(0, index + 1).join('/') }));
  useEffect(() => { setVirtualWindow({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 }); }, [browseMode, currentRelativePath, fileFilter, finalViewOpen, sortField, sortDirection, searchQuery]);
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
        const firstRow = Math.max(0, Math.floor(visibleTop / rowHeight) - FILE_VIRTUAL_OVERSCAN_ROWS);
        const lastRow = Math.min(rowCount, Math.ceil((visibleTop + container.clientHeight) / rowHeight) + FILE_VIRTUAL_OVERSCAN_ROWS);
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
  }, [currentRelativePath, finalViewOpen, displayedFileEntries.length, viewMode, gridIconSize, previewPaneOpen, metadataPaneOpen, sortField, sortDirection, searchQuery]);
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
        const entriesByPath = new Map(activeFileEntries.map(entry => [entry.relativePath, entry]));
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
  }, [activeFileEntries, virtualWindow.start, virtualWindow.end, viewMode, gridIconSize, previewPaneOpen, metadataPaneOpen]);

  const loadDirectoryPreviewEntries = useCallback((entry: ProjectFileEntry) => {
    if (entry.kind !== 'folder') return Promise.resolve([]);
    const cached = directoryEntriesCacheRef.current.get(entry.relativePath);
    if (cached) return Promise.resolve(cached);
    const pending = directoryPrefetchesRef.current.get(entry.relativePath);
    if (pending) return pending;
    const requestedProjectPath = project.path;
    const request = window.electronAPI.browseProjectFiles(workspacePath, project.status, project.name, entry.relativePath, mediaCacheConfig)
      .then(result => {
        if (!result.success || requestedProjectPath !== projectPathRef.current) return [];
        directoryEntriesCacheRef.current.set(entry.relativePath, result.entries);
        return result.entries;
      })
      .finally(() => directoryPrefetchesRef.current.delete(entry.relativePath));
    directoryPrefetchesRef.current.set(entry.relativePath, request);
    return request;
  }, [workspacePath, project.path, project.status, project.name, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB]);
  const prefetchDirectory = (entry: ProjectFileEntry) => {
    if (entry.kind === 'folder') void loadDirectoryPreviewEntries(entry);
  };

  const togglePanel = (next: Exclude<ProjectPanel, null>) => setPanel(current => current === next ? null : next);
  const refreshRecursiveResults = () => {
    if (recursiveFlatOpen) setRecentRefreshToken(current => current + 1);
  };
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
    setShowImportMenu(false);
    setPanelImportResult(null);
    setPanelImportBusy('broll');
    try {
      const result = await window.electronAPI.importBroll(workspacePath, project.status, project.name, { splitLargeFiles: brollConfig.splitLargeFiles, deleteSourceAfterImport: deleteBrollSources });
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
  const openFileImport = (targetRelativePath = currentRelativePath) => {
    setShowImportMenu(false);
    setFileImportTarget(targetRelativePath);
    setDeleteFileSources(importDefaults.deleteSourceAfterImport);
    setPanelImportResult(null);
    setPanel('file-import');
  };
  const importFiles = async () => {
    const targetRelativePath = fileImportTarget;
    setPanelImportResult(null);
    setPanelImportBusy('files');
    try {
      const result = await window.electronAPI.importProjectFiles(workspacePath, project.status, project.name, targetRelativePath, { deleteSourceAfterImport: deleteFileSources });
      if (!result.success) { onNotice(`导入失败：${result.error || '未知错误'}`); return; }
      if (result.cancelled) { onNotice('已取消导入。'); return; }
      setPanelImportResult({ kind: 'files', count: result.count || 0, sourceDeleted: deleteFileSources });
      onNotice(`已导入 ${result.count || 0} 个文件，源文件${deleteFileSources ? '已删除' : '已保留'}。`);
      if (projectWorkflows && relativePathTouchesSelectionBaseline(targetRelativePath)) await ensureSelectionBaseline();
      refresh();
      refreshRecursiveResults();
    } finally {
      setPanelImportBusy('');
    }
  };
  const extractOfficeImages = async (entries: ProjectFileEntry[]) => {
    const documents = entries.filter(isOfficeOpenXmlEntry);
    if (!documents.length) return;
    onNotice(`正在从 ${documents.length} 个 Office 文档提取图片…`);
    const result = await window.electronAPI.extractOfficeImages(workspacePath, project.status, project.name, documents.map(entry => entry.relativePath));
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
    if (imageCount) onNotice(`已从 ${result.successfulCount || documents.length} 个文档提取 ${imageCount} 张图片。输出文件夹：${outputFolders.join('；')}`, 7000);
    else onNotice(empty.length ? '所选 Office 文档中没有可提取的图片。' : '没有提取到图片。');
    if (failed.length) onNotice(`${failed.length} 个文档提取失败：${failed.map(item => item.documentName).join('、')}`, 7000);
  };
  const markInProgress = async () => {
    if (project.status === '后期中') return;
    const result = await window.electronAPI.moveWorkspaceProject(workspacePath, project.status, project.name, '后期中');
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
    const result = await window.electronAPI.createProjectFolder(workspacePath, project.status, project.name, folderName, normalizedTarget, true);
    if (!result.success) { onNotice(`新建文件夹失败：${result.error || '未知错误'}`); return; }
    directoryEntriesCacheRef.current.delete(normalizedTarget);
    await refresh();
    refreshRecursiveResults();
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
      const result = await window.electronAPI.getShellNewFileTypes(refresh);
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
    const result = await window.electronAPI.createProjectShellNewFile(workspacePath, project.status, project.name, normalizedTarget, type.id);
    if (!result.success || !result.file) { onNotice(`新建${type.label}失败：${result.error || '未知错误'}`); return; }
    directoryEntriesCacheRef.current.delete(normalizedTarget);
    await refresh();
    refreshRecursiveResults();
    if (normalizedTarget !== normalizeProjectRelativePath(currentRelativePath)) {
      onNotice(`已在${normalizedTarget ? `“${normalizedTarget}”` : '项目根目录'}中新建${type.label}`);
      return;
    }
    setSelectedPaths([result.file.relativePath]);
    setInlineRenamePath(result.file.relativePath);
    setInlineRenameValue(result.file.name);
  };
  const compareProgressKeys = (left: string, right: string) => {
    const leftParts = left.split('_').map(Number);
    const rightParts = right.split('_').map(Number);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
      if ((leftParts[index] ?? -1) !== (rightParts[index] ?? -1)) return (leftParts[index] ?? -1) - (rightParts[index] ?? -1);
    }
    return 0;
  };
  const progressFolderPrefix = (mediaKind: 'image' | 'video') => mediaKind === 'image' ? '图片后期' : '视频后期';
  const buildProgressFolderName = (mediaKind: 'image' | 'video', versionKey: string, progressName: string) => {
    const baseName = `${progressFolderPrefix(mediaKind)}_${versionKey}`;
    return progressName.trim() ? `${baseName}_${progressName.trim()}` : baseName;
  };
  const progressAppendTarget = (draft: ProgressSetupDraft) => draft.mode === 'import'
    ? progressFolders.find(folder => !folder.folderMissing && folder.mediaKind === draft.mediaKind && folder.versionKey === draft.versionKey)
    : undefined;
  const progressReplacementTarget = (draft: ProgressSetupDraft) => draft.mode === 'mark' && draft.existingProgressId
    ? progressFolders.find(folder => folder.folderMissing && folder.id !== draft.existingProgressId && folder.mediaKind === draft.mediaKind && folder.versionKey === draft.versionKey)
    : undefined;
  const progressVersionIsValid = (draft: ProgressSetupDraft) => {
    if (!/^\d+(?:_\d+)*$/.test(draft.versionKey)) return false;
    if (progressAppendTarget(draft)) return true;
    const hasConflict = progressFolders.some(folder => !folder.folderMissing && folder.mediaKind === draft.mediaKind && folder.versionKey === draft.versionKey && folder.id !== draft.existingProgressId);
    if (hasConflict) return false;
    if (draft.relation === 'root') return !draft.versionKey.includes('_');
    const parent = progressFolders.find(folder => folder.id === draft.parentProgressId);
    return Boolean(parent && !progressSubtreeIds(draft.existingProgressId).has(parent.id) && draft.versionKey.startsWith(`${parent.versionKey}_`) && draft.versionKey.split('_').length === parent.versionKey.split('_').length + 1);
  };
  const progressSubtreeIds = (progressId?: string) => {
    const ids = new Set<string>();
    if (!progressId) return ids;
    const collect = (id: string) => {
      ids.add(id);
      progressFolders.filter(folder => folder.parentProgressId === id).forEach(folder => collect(folder.id));
    };
    collect(progressId);
    return ids;
  };
  const progressParentOptions = (draft: ProgressSetupDraft) => {
    const excluded = progressSubtreeIds(draft.existingProgressId);
    return progressFolders.filter(folder => folder.mediaKind === draft.mediaKind && !folder.folderMissing && !excluded.has(folder.id));
  };
  const inferProgressComparisonParent = (mediaKind: 'image' | 'video', versionKey: string, sourceFolders = progressFolders, excludedId = '') => {
    const available = sourceFolders.filter(folder => folder.id !== excludedId && folder.mediaKind === mediaKind && !folder.folderMissing);
    if (versionKey.includes('_')) {
      const parentVersionKey = versionKey.split('_').slice(0, -1).join('_');
      return available.find(folder => folder.versionKey === parentVersionKey);
    }
    return available
      .filter(folder => !folder.versionKey.includes('_') && compareProgressKeys(folder.versionKey, versionKey) < 0)
      .sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey))
      .at(-1);
  };
  const progressComparisonParent = (draft: ProgressSetupDraft) => progressFolders.find(folder => folder.id === draft.parentProgressId && !folder.folderMissing)
    || inferProgressComparisonParent(draft.mediaKind, draft.versionKey, progressFolders, draft.existingProgressId);
  const progressParentIsAvailable = (draft: ProgressSetupDraft) => Boolean(progressComparisonParent(draft));
  const progressNameHasConflict = (draft: ProgressSetupDraft) => {
    if (!draft.versionKey) return false;
    if (progressAppendTarget(draft)) return false;
    const generatedName = buildProgressFolderName(draft.mediaKind, draft.versionKey, draft.progressName).toLocaleLowerCase('zh-CN');
    return progressFolders.some(folder => !folder.folderMissing && folder.id !== draft.existingProgressId && folder.displayName.toLocaleLowerCase('zh-CN') === generatedName);
  };
  const progressNameFromDisplayName = (displayName: string, mediaKind: 'image' | 'video', versionKey: string, fallback: string) => {
    const generatedBase = `${progressFolderPrefix(mediaKind)}_${versionKey}`;
    if (displayName === generatedBase) return '';
    const generatedPrefix = `${generatedBase}_`;
    return displayName.startsWith(generatedPrefix) ? displayName.slice(generatedPrefix.length) : fallback;
  };
  const makeProgressDraft = (mode: 'create' | 'import' | 'mark', mediaKind: 'image' | 'video', relation: 'root' | 'branch', parentProgressId = '', sourceFolders = progressFolders): ProgressSetupDraft => {
    const kindFolders = sourceFolders.filter(folder => folder.mediaKind === mediaKind).sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey));
    const availableFolders = kindFolders.filter(folder => !folder.folderMissing);
    const rootFolders = availableFolders.filter(folder => !folder.versionKey.includes('_'));
    const availableRootFolders = rootFolders.filter(folder => !folder.folderMissing);
    const requestedParent = availableFolders.find(folder => folder.id === parentProgressId);
    const branchParent = requestedParent || availableFolders[availableFolders.length - 1];
    const actualRelation = relation === 'branch' && branchParent ? 'branch' : 'root';
    let versionKey = '';
    let parentId = '';
    if (actualRelation === 'root') {
      const nextRoot = rootFolders.reduce((highest, folder) => Math.max(highest, Number(folder.versionKey) || 0), 0) + 1;
      versionKey = String(nextRoot);
      parentId = availableRootFolders[availableRootFolders.length - 1]?.id || '';
    } else {
      const parentParts = branchParent.versionKey.split('_');
      const childPrefix = `${branchParent.versionKey}_`;
      const nextChild = availableFolders.reduce((highest, folder) => {
        const parts = folder.versionKey.split('_');
        return folder.versionKey.startsWith(childPrefix) && parts.length === parentParts.length + 1
          ? Math.max(highest, Number(parts[parts.length - 1]) || 0)
          : highest;
      }, 0) + 1;
      versionKey = `${branchParent.versionKey}_${nextChild}`;
      parentId = branchParent.id;
    }
    return { mode, mediaKind, relation: actualRelation, parentProgressId: parentId, versionKey, progressName: '', trackingEnabled: mode !== 'create', deleteSourceAfterImport: importDefaults.deleteSourceAfterImport, renameSources: false, copyMissingFromParent: false };
  };
  const openProgressSetup = (mode: 'create' | 'import') => {
    setShowCreateMenu(false);
    setShowImportMenu(false);
    setProgressImportCompletion('');
    // The cached list is already loaded when the project opens. Render the
    // editor immediately and reconcile the list in the background instead of
    // making the dialog wait on a database IPC round trip.
    setProgressSetup(makeProgressDraft(mode, 'image', 'root', '', progressFolders));
    void loadProgressFolders();
  };
  const makeMarkProgressDraft = (entry: ProjectFileEntry, targetRelativePath: string, sourceFolders: ProgressFolder[]): ProgressSetupDraft | null => {
    const normalizedPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const registered = sourceFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === normalizedPath);
    if (registered?.versionKey === '0') return null;
    if (registered) {
      const inferredParent = inferProgressComparisonParent(registered.mediaKind, registered.versionKey, sourceFolders, registered.id);
      return {
        mode: 'mark',
        mediaKind: registered.mediaKind,
        relation: registered.versionKey.includes('_') ? 'branch' : 'root',
        parentProgressId: registered.versionKey.includes('_') ? registered.parentProgressId || inferredParent?.id || '' : '',
        versionKey: registered.versionKey,
        progressName: progressNameFromDisplayName(registered.displayName, registered.mediaKind, registered.versionKey, entry.name),
        trackingEnabled: registered.trackingState !== 'disabled',
        deleteSourceAfterImport: true,
        renameSources: false,
        copyMissingFromParent: false,
        targetRelativePath,
        existingProgressId: registered.id,
      };
    }
    return null;
  };
  const openMarkProgress = (entry: ProjectFileEntry) => {
    const targetRelativePath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (entry.kind !== 'folder' || targetRelativePath.includes('/')) {
      onNotice('只能把项目根目录下的文件夹标记为进度。');
      return;
    }
    const initialDraft = makeMarkProgressDraft(entry, targetRelativePath, progressFolders);
    if (!initialDraft) {
      onNotice(entry.name === '图片选片' || entry.name === '视频选片'
        ? `“${entry.name}”是自动管理的 V0 ${entry.name === '视频选片' ? '原片' : '原图'}基线，不需要手动修改进度。`
        : '普通文件夹不能标记为进度；请通过“新建进度”或“导入进度”创建。');
      return;
    }
    // Show the cached draft immediately. A slow database or network drive must
    // not keep the dialog invisible while progress-folder locations are synced.
    setProgressSetup(initialDraft);
    void loadProgressFolders().then(latestFolders => {
      if (!latestFolders.length && progressFolders.length) return;
      const latestDraft = makeMarkProgressDraft(entry, targetRelativePath, latestFolders);
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
  const changeProgressMediaKind = (mediaKind: 'image' | 'video') => {
    setProgressSetup(current => {
      if (!current || current.existingProgressId || current.mediaKind === mediaKind) return current;
      const next = makeProgressDraft(current.mode, mediaKind, 'root', '', progressFolders);
      return {
        ...next,
        progressName: current.progressName,
        targetRelativePath: current.targetRelativePath,
        trackingEnabled: current.trackingEnabled,
        deleteSourceAfterImport: current.deleteSourceAfterImport,
        renameSources: current.renameSources,
        copyMissingFromParent: current.copyMissingFromParent && Boolean(next.parentProgressId),
      };
    });
  };
  const changeProgressRelation = (relation: 'root' | 'branch', parentProgressId = '') => {
    setProgressSetup(current => {
      if (!current) return current;
      let sourceFolders = progressFolders;
      if (current.existingProgressId) {
        const excluded = new Set<string>();
        const collect = (progressId: string) => {
          excluded.add(progressId);
          progressFolders.filter(folder => folder.parentProgressId === progressId).forEach(folder => collect(folder.id));
        };
        collect(current.existingProgressId);
        sourceFolders = progressFolders.filter(folder => !excluded.has(folder.id));
      }
      const next = makeProgressDraft(current.mode, current.mediaKind, relation, parentProgressId, sourceFolders);
      return {
        ...current,
        relation: next.relation,
        parentProgressId: next.parentProgressId,
        versionKey: next.versionKey,
        progressName: current.progressName,
        trackingEnabled: current.trackingEnabled,
        deleteSourceAfterImport: current.deleteSourceAfterImport,
        renameSources: current.renameSources,
        copyMissingFromParent: current.copyMissingFromParent && Boolean(next.parentProgressId),
        targetRelativePath: current.targetRelativePath,
      };
    });
  };
  const projectRelativePath = (absolutePath: string) => {
    const normalizedRoot = project.path.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    return normalizedPath.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : normalizedPath.split('/').pop() || '';
  };
  const setProgressTrackingState = async (progressFolder: ProgressFolder, trackingState: ProgressFolder['trackingState']) => {
    const updated = await window.electronAPI.registerProgressFolder(workspacePath, project.status, project.name, {
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
  const closeOrCancelProgressSetupFromBackdrop = async () => {
    if (!progressSetup) return;
    if (!progressSubmitting && !progressTask) {
      closeProgressSetup();
      return;
    }
    const operationId = progressImportOperationIdRef.current;
    if (!operationId || progressImportBackdropCancellingRef.current) return;
    progressImportBackdropCancellingRef.current = true;
    try {
      const result = await window.electronAPI.cancelProjectFileOperation(operationId);
      if (!result.success) {
        onNotice(`取消进度导入失败：${result.error || '无法取消当前导入'}`);
        return;
      }
      setProgressSetup(null);
    } catch (error) {
      onNotice(`取消进度导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      progressImportBackdropCancellingRef.current = false;
    }
  };
  const submitProgressSetup = async () => {
    if (!progressSetup || progressSubmitting || !progressVersionIsValid(progressSetup) || progressNameHasConflict(progressSetup)) return;
    const draft = progressSetup;
    const appendTarget = progressAppendTarget(draft);
    if (appendTarget?.trackingState === 'needs_repair' || appendTarget?.trackingState === 'committing') {
      onNotice(appendTarget.trackingState === 'needs_repair' ? '请先修复当前版本批次，再追加文件。' : '当前版本批次仍在提交，请稍后再追加。');
      return;
    }
    const replacementTarget = progressReplacementTarget(draft);
    const generatedName = appendTarget?.displayName || buildProgressFolderName(draft.mediaKind, draft.versionKey, draft.progressName);
    const trackingEnabled = appendTarget ? appendTarget.trackingState !== 'disabled' : draft.trackingEnabled;
    const parentFolder = appendTarget
      ? progressFolders.find(folder => folder.id === appendTarget.parentProgressId && !folder.folderMissing)
        || inferProgressComparisonParent(appendTarget.mediaKind, appendTarget.versionKey, progressFolders, appendTarget.id)
      : progressComparisonParent(draft);
    progressImportOperationIdRef.current = '';
    setProgressSubmitting(true);
    try {
      if (draft.mode === 'create') {
        const created = await window.electronAPI.createProgressFolder(workspacePath, project.status, project.name, {
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
        });
        if (!created.success || !created.folder || !created.progressFolder) throw new Error(created.error || '无法创建进度文件夹');
        setProgressSetup(null);
        setProgressFolders(current => current.some(folder => folder.id === created.progressFolder!.id) ? current : [...current, created.progressFolder!]);
        directoryEntriesCacheRef.current.delete('');
        if (!currentRelativePathRef.current) {
          const folderEntry: ProjectFileEntry = { ...created.folder, kind: 'folder', extension: '', size: 0, createdAt: created.folder.updatedAt };
          setFileEntries(current => current.some(entry => entry.relativePath === folderEntry.relativePath) ? current : [...current, folderEntry]);
        }
        onNotice(`已创建${draft.mediaKind === 'image' ? '图片' : '视频'}进度“${generatedName}”（版本 V${draft.versionKey}）`);
        void loadProgressFolders();
        void refresh('');
        return;
      }

      if (draft.mode === 'mark' && draft.existingProgressId) {
        const existingProgress = progressFolders.find(folder => folder.id === draft.existingProgressId);
        const needsTrackingRebuild = draft.trackingEnabled && (Boolean(replacementTarget) || !existingProgress?.trackingEnabled || Boolean(parentFolder && (draft.renameSources || draft.copyMissingFromParent)));
        setProgressTask('正在更新进度名称和版本关系…');
        const updated = await window.electronAPI.updateProgressFolder(workspacePath, project.status, project.name, {
          progressId: draft.existingProgressId,
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          trackingEnabled: draft.trackingEnabled && !needsTrackingRebuild,
          trackingState: !draft.trackingEnabled ? 'disabled' : needsTrackingRebuild ? 'pending_compare' : 'ready',
        });
        if (!updated.success || !updated.progressFolder) throw new Error(updated.error || '无法修改进度');
        setProgressSetup(null);
        setProgressFolders(updated.progressFolders || progressFolders.map(folder => folder.id === updated.progressFolder!.id ? updated.progressFolder! : folder));
        setProgressTask('');
        directoryEntriesCacheRef.current.clear();
        await refresh('');
        if (updated.folder) setSelectedPaths([updated.folder.relativePath]);
        if (needsTrackingRebuild) {
          const updatedRelativePath = updated.folder?.relativePath || projectRelativePath(updated.progressFolder.folderPath);
          if (!parentFolder) {
              setProgressTask('正在建立首个版本的跟踪记录…');
              const baseline = await window.electronAPI.registerVersionBaseline(workspacePath, project.status, project.name, updatedRelativePath);
              if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
              await loadProgressFolders();
              setProgressTask('');
              onNotice(`已修改进度并建立首版跟踪：“${updated.progressFolder.displayName}”`);
              return;
          }
          setProgressTask('正在对比原有版本和当前进度，文件较多时可能需要几分钟…');
          const compared = await window.electronAPI.compareVersionFolders(workspacePath, project.status, project.name, projectRelativePath(parentFolder.folderPath), updatedRelativePath);
          if (!compared.success) throw new Error(compared.error || '版本比对失败');
          const confirmationProgress = await setProgressTrackingState(updated.progressFolder, 'pending_confirm');
          setProgressTask('');
          setProgressCompare({
            sourceMode: 'mark',
            progressFolder: confirmationProgress,
            parentFolder,
            matches: compared.matches,
            suggestions: compared.suggestions,
            acceptedSources: compared.matches.filter(match => match.confidence !== '低').map(match => match.source),
            unmatchedSources: compared.unmatched,
            unmatchedReferences: compared.unmatchedReference,
            renameSources: draft.renameSources,
            copyMissingFromParent: draft.copyMissingFromParent,
            reconcileExisting: Boolean(replacementTarget ? replacementTarget.trackingEnabled : existingProgress?.trackingEnabled),
          });
          return;
        }
        onNotice(`已修改进度“${updated.progressFolder.displayName}”，当前版本为 V${updated.progressFolder.versionKey}`);
        return;
      }

      if (draft.mode === 'mark') {
        if (!draft.targetRelativePath) throw new Error('没有找到要标记的文件夹');
        const originalFolderName = draft.targetRelativePath.split('/').filter(Boolean).pop() || '';
        const requestedFolderName = generatedName;
        let targetRelativePath = draft.targetRelativePath;
        let renamedFolder: { before: string; after: string } | null = null;
        if (requestedFolderName !== originalFolderName) {
          setProgressTask(`正在把文件夹“${originalFolderName}”重命名为“${requestedFolderName}”…`);
          const renamed = await window.electronAPI.renameProjectFolder(workspacePath, project.status, project.name, originalFolderName, requestedFolderName);
          if (!renamed.success || !renamed.folder) throw new Error(renamed.error || '无法重命名文件夹');
          targetRelativePath = renamed.folder.name;
          renamedFolder = { before: originalFolderName, after: renamed.folder.name };
        }
        setProgressTask(`正在标记${draft.mediaKind === 'image' ? '图片' : '视频'}进度…`);
        const registered = await window.electronAPI.registerProgressFolder(workspacePath, project.status, project.name, {
          relativePath: targetRelativePath,
          mediaKind: draft.mediaKind,
          versionKey: draft.versionKey,
          parentProgressId: draft.parentProgressId || undefined,
          displayName: generatedName,
          trackingEnabled: false,
          trackingState: draft.trackingEnabled ? 'pending_compare' : 'disabled',
          progressId: draft.existingProgressId,
        });
        if (!registered.success || !registered.progressFolder) {
          if (renamedFolder) {
            await window.electronAPI.renameProjectFolder(workspacePath, project.status, project.name, renamedFolder.after, renamedFolder.before).catch(() => undefined);
          }
          throw new Error(registered.error || '无法登记进度文件夹');
        }
        const progressFolder = registered.progressFolder;
        setProgressSetup(null);
        await loadProgressFolders();
        if (renamedFolder) {
          directoryEntriesCacheRef.current.delete('');
          await refresh('');
          setSelectedPaths([targetRelativePath]);
        }

        if (!draft.trackingEnabled) {
          setProgressTask('');
          onNotice(`已将“${generatedName}”标记为${draft.mediaKind === 'image' ? '图片' : '视频'}进度 V${draft.versionKey}（未开启版本跟踪）。`);
          return;
        }
        if (!parentFolder) {
          setProgressTask('正在建立首个版本的跟踪记录…');
          const baseline = await window.electronAPI.registerVersionBaseline(workspacePath, project.status, project.name, targetRelativePath);
          if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
          await loadProgressFolders();
          setProgressTask('');
          onNotice(`已标记并建立首版跟踪：${progressFolder.displayName}`);
          return;
        }

        setProgressTask('正在对比原有版本和新版本，文件较多时可能需要几分钟…');
        const compared = await window.electronAPI.compareVersionFolders(workspacePath, project.status, project.name, projectRelativePath(parentFolder.folderPath), targetRelativePath);
        if (!compared.success) throw new Error(compared.error || '版本比对失败');
        const confirmationProgress = await setProgressTrackingState(progressFolder, 'pending_confirm');
        setProgressTask('');
        setProgressCompare({
          sourceMode: 'mark',
          progressFolder: confirmationProgress,
          parentFolder,
          matches: compared.matches,
          suggestions: compared.suggestions,
          acceptedSources: compared.matches.filter(match => match.confidence !== '低').map(match => match.source),
          unmatchedSources: compared.unmatched,
          unmatchedReferences: compared.unmatchedReference,
          renameSources: draft.renameSources,
          copyMissingFromParent: draft.copyMissingFromParent,
        });
        return;
      }

      setProgressTask('');
      const importOptions: Parameters<typeof window.electronAPI.importProgressFiles>[4] = {
        deleteSourceAfterImport: draft.deleteSourceAfterImport,
        mediaKind: draft.mediaKind,
        versionKey: draft.versionKey,
        parentProgressId: appendTarget?.parentProgressId || draft.parentProgressId || undefined,
        trackingEnabled,
        trackingState: trackingEnabled ? 'pending_compare' : 'disabled',
        appendProgressId: appendTarget?.id,
      };
      let imported = await window.electronAPI.importProgressFiles(workspacePath, project.status, project.name, generatedName, importOptions);
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
        imported = await window.electronAPI.importProgressFiles(workspacePath, project.status, project.name, generatedName, {
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
      const progressFolder = imported.progressFolder;
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
        const baseline = await window.electronAPI.registerVersionBaseline(workspacePath, project.status, project.name, imported.folder.relativePath);
        if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
        await loadProgressFolders();
        setProgressTask('');
        setProgressImportCompletion(appendTarget
          ? `已向“${progressFolder.displayName}”追加 ${imported.count || 0} 个文件并更新首版跟踪${skippedSummary}。`
          : `已导入并建立首版跟踪：${progressFolder.displayName}`);
        return;
      }

      const importedSourceNames = (imported.importedPaths || []).map(filePath => filePath.replace(/\\/g, '/').split('/').pop() || '').filter(Boolean);
      setProgressSetup(null);
      setProgressTask(appendTarget ? '正在为本次追加文件匹配上一版本…' : '正在对比原有版本和新版本，文件较多时可能需要几分钟…');
      const compared = await window.electronAPI.compareVersionFolders(workspacePath, project.status, project.name, projectRelativePath(parentFolder.folderPath), imported.folder.relativePath, appendTarget ? importedSourceNames : undefined);
      if (!compared.success) throw new Error(compared.error || '版本比对失败');
      const confirmationProgress = await setProgressTrackingState(progressFolder, 'pending_confirm');
      setProgressTask('');
      setProgressCompare({
        sourceMode: 'import',
        progressFolder: confirmationProgress,
        parentFolder,
        matches: compared.matches,
        suggestions: compared.suggestions,
        acceptedSources: compared.matches.filter(match => match.confidence !== '低').map(match => match.source),
        unmatchedSources: compared.unmatched,
        unmatchedReferences: appendTarget ? [] : compared.unmatchedReference,
        renameSources: appendTarget ? false : draft.renameSources,
        copyMissingFromParent: appendTarget ? false : draft.copyMissingFromParent,
        reconcileExisting: Boolean(appendTarget),
        incrementalSources: appendTarget ? importedSourceNames : undefined,
      });
    } catch (error) {
      setProgressTask('');
      const action = draft.mode === 'create' ? '创建' : draft.mode === 'import' ? '导入' : draft.existingProgressId ? '修改' : '标记';
      onNotice(`${action}版本进度失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProgressSubmitting(false);
    }
  };
  const trackingParentForProgress = (progressFolder: ProgressFolder, sourceFolders = progressFolders) => sourceFolders.find(folder => folder.id === progressFolder.parentProgressId && !folder.folderMissing)
    || inferProgressComparisonParent(progressFolder.mediaKind, progressFolder.versionKey, sourceFolders, progressFolder.id);
  const progressTrackingRefreshLabel = (progressFolder: ProgressFolder) => progressFolder.trackingState === 'needs_repair'
    ? `修复版本批次${progressFolder.pendingOperationCount ? `（${progressFolder.pendingOperationCount}）` : ''}`
    : progressFolder.trackingState === 'committing' ? '正在提交版本批次'
    : progressFolder.trackingState === 'pending_confirm' ? '继续确认版本关系'
    : progressFolder.trackingState === 'pending_compare' ? '继续建立版本跟踪'
    : !trackingParentForProgress(progressFolder) ? '更新项目跟踪'
    : progressFolder.trackingEnabled ? '重新扫描版本跟踪' : '建立版本跟踪';
  const openProgressRepair = async (progressFolder: ProgressFolder) => {
    if (!progressFolder.repairBatchId) { onNotice('没有找到可修复的版本批次，请重新扫描版本跟踪。'); return; }
    setProgressTask('正在读取失败的文件操作…');
    const result = await window.electronAPI.getVersionBatchOperations(workspacePath, progressFolder.repairBatchId);
    setProgressTask('');
    if (!result.success) { onNotice(`读取修复任务失败：${result.error || '未知错误'}`); return; }
    setProgressRepair({ progressFolder, batchId: progressFolder.repairBatchId, operations: result.operations });
  };
  const retryProgressRepair = async () => {
    if (!progressRepair || progressRepairBusy) return;
    setProgressRepairBusy(true);
    const retried = await window.electronAPI.retryVersionBatchOperations(workspacePath, progressRepair.batchId);
    const refreshed = await window.electronAPI.getVersionBatchOperations(workspacePath, progressRepair.batchId);
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
    if (requestedProgress.trackingState === 'needs_repair') { await openProgressRepair(requestedProgress); return; }
    setProgressSubmitting(true);
    try {
      const latestFolders = await loadProgressFolders();
      const progressFolder = latestFolders.find(folder => folder.id === requestedProgress.id) || requestedProgress;
      if (progressFolder.folderMissing) throw new Error('当前进度文件夹已经丢失');
      const parentFolder = trackingParentForProgress(progressFolder, latestFolders.length ? latestFolders : progressFolders);
      const relativePath = projectRelativePath(progressFolder.folderPath);
      if (!parentFolder) {
        setProgressTask('正在重新扫描首个版本并更新项目跟踪…');
        const baseline = await window.electronAPI.registerVersionBaseline(workspacePath, project.status, project.name, relativePath);
        if (!baseline.success) throw new Error(baseline.error || '无法更新项目跟踪');
        await loadProgressFolders();
        directoryEntriesCacheRef.current.clear();
        await refresh('');
        setVersionEntry(current => current ? { ...current, updatedAt: Date.now() } : current);
        onNotice(`已更新 ${progressFolder.displayName} 的 V${progressFolder.versionKey} 项目跟踪`);
        return;
      }
      const comparingProgress = await setProgressTrackingState(progressFolder, 'pending_compare');
      setProgressTask(`正在重新扫描 V${parentFolder.versionKey} 与 V${progressFolder.versionKey}，文件较多时可能需要几分钟…`);
      const compared = await window.electronAPI.compareVersionFolders(
        workspacePath,
        project.status,
        project.name,
        projectRelativePath(parentFolder.folderPath),
        relativePath,
      );
      if (!compared.success) throw new Error(compared.error || '重新扫描版本跟踪失败');
      const confirmationProgress = await setProgressTrackingState(comparingProgress, 'pending_confirm');
      setProgressCompare({
        sourceMode: 'mark',
        progressFolder: confirmationProgress,
        parentFolder,
        matches: compared.matches,
        suggestions: compared.suggestions,
        acceptedSources: compared.matches.filter(match => match.confidence !== '低').map(match => match.source),
        unmatchedSources: compared.unmatched,
        unmatchedReferences: compared.unmatchedReference,
        renameSources: false,
        copyMissingFromParent: false,
        reconcileExisting: true,
        trackingRefreshMode: progressFolder.trackingEnabled ? 'refresh' : 'establish',
        enableTrackingOnCommit: !progressFolder.trackingEnabled,
      });
    } catch (error) {
      onNotice(`刷新版本跟踪失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally {
      setProgressTask('');
      setProgressSubmitting(false);
    }
  };
  const updateSelectionBaselineTracking = async (entry: ProjectFileEntry) => {
    if (progressSubmitting || progressTask || entry.kind !== 'folder') return;
    setProgressSubmitting(true);
    setProgressTask(`正在扫描“${entry.name}”并更新项目跟踪…`);
    try {
      const result = await ensureSelectionBaseline(true);
      if (!result.success || !result.registered) throw new Error(result.error || '没有找到可登记的选片文件夹');
      directoryEntriesCacheRef.current.clear();
      await refresh('');
      const count = entry.name === '视频选片' ? result.videoCount || 0 : result.imageCount || 0;
      onNotice(`已将“${entry.name}”登记为 V0，并更新 ${count} 个媒体文件的项目跟踪`);
    } catch (error) {
      onNotice(`更新项目跟踪失败：${error instanceof Error ? error.message : String(error)}`, 7000);
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
    const result = await window.electronAPI.commitVersionBatch(workspacePath, project.status, project.name, {
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
    const result = await window.electronAPI.registerProgressFolder(workspacePath, project.status, project.name, {
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
    const result = await window.electronAPI.trashWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) {
      if (isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else onNotice(`删除项目失败：${result.error || '未知错误'}`);
      return;
    }
    if (result.permanent) onNotice('项目已按 Windows 确认永久删除');
    onDeleted();
  };
  const openPngConverter = (targetPaths: string | string[]) => {
    if (projectPanelIsRunning('converter')) { setPanel('converter'); return; }
    setConversionTargets(Array.isArray(targetPaths) ? targetPaths : [targetPaths]);
    setPanel('converter');
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
    if (!isScreenshotMainImageEntry(entry) || entry.viaShortcut) {
      return { success: false, error: '当前图片格式暂不支持裁剪' };
    }
    try {
      const analysis = await window.electronAPI.extractScreenshotMainImages(workspacePath, project.status, project.name, [entry.relativePath], { analyzeOnly: true });
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
      const extraction = await window.electronAPI.extractScreenshotMainImages(workspacePath, project.status, project.name, [entry.relativePath], { crops: [crop], outputSuffix: '裁剪' });
      const result = extraction.results[0];
      if (!result?.success || !result.cropped) return { success: false, error: result?.error || extraction.error || '裁剪失败' };
      directoryEntriesCacheRef.current.clear();
      setRecentRefreshToken(value => value + 1);
      await refresh(currentRelativePathRef.current);
      if (finalViewOpen) await loadFinalViewEntries();
      onNotice(`裁剪完成：${result.outputName || '已在原图旁生成裁剪图片'}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const toggleSelected = (relativePath: string) => {
    selectionAnchorPathRef.current = relativePath;
    setSelectedPaths(current => current.includes(relativePath) ? current.filter(path => path !== relativePath) : [...current, relativePath]);
  };
  const selectEntryRange = (relativePath: string, additive: boolean) => {
    const targetIndex = displayedFileEntries.findIndex(entry => entry.relativePath === relativePath);
    if (targetIndex < 0) return;
    const storedAnchorPath = selectedPaths.includes(selectionAnchorPathRef.current) ? selectionAnchorPathRef.current : '';
    const selectedAnchorPath = storedAnchorPath || [...selectedPaths].reverse().find(path => displayedFileEntries.some(entry => entry.relativePath === path)) || '';
    const anchorIndex = selectedPaths.length ? displayedFileEntries.findIndex(entry => entry.relativePath === selectedAnchorPath) : -1;
    if (anchorIndex < 0) {
      selectionAnchorPathRef.current = relativePath;
      setSelectedPaths(additive ? current => Array.from(new Set([...current, relativePath])) : [relativePath]);
      return;
    }
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const rangePaths = displayedFileEntries.slice(start, end + 1).map(entry => entry.relativePath);
    setSelectedPaths(additive ? current => Array.from(new Set([...current, ...rangePaths])) : rangePaths);
  };
  const beginInlineRename = (relativePath: string) => {
    const entry = fileEntries.find(candidate => candidate.relativePath === relativePath);
    if (!entry) return;
    if (isProtectedRenameEntry(entry)) { onNotice('该文件夹由项目工作流管理，不能普通重命名；进度文件夹请使用“修改进度”。'); return; }
    setSelectedPaths([relativePath]);
    setInlineRenamePath(relativePath);
    setInlineRenameValue(entry.name);
  };
  const getInlineRenameSelectionEnd = (entry: ProjectFileEntry) => {
    if (entry.kind === 'folder' || !entry.extension || !entry.name.toLocaleLowerCase().endsWith(entry.extension.toLocaleLowerCase())) return entry.name.length;
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
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'rename', [inlineRenamePath], currentRelativePath, nextName);
    renameCommitRef.current = false;
    if (!result.success) { onNotice(`重命名失败：${result.error || '未知错误'}`); return; }
    const selectionBaselineChanged = projectWorkflows && relativePathTouchesSelectionBaseline(inlineRenamePath);
    cancelInlineRename();
    setSelectedPaths([]);
    onNotice(`已重命名为“${nextName}”`);
    if (selectionBaselineChanged) await ensureSelectionBaseline();
    refresh();
  };
  const beginRename = (targetPaths = selectedPaths) => {
    if (finalViewOpen) { onNotice('喜爱图片浏览是只读视图，请回到原文件夹重命名'); return; }
    if (!targetPaths.length) return;
    if (activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && entry.viaShortcut)) { onNotice('快捷方式中的文件是只读浏览内容，不能在项目中重命名'); return; }
    if (activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && isProtectedRenameEntry(entry))) { onNotice('所选内容包含工作流管理的文件夹，不能普通重命名；进度文件夹请使用“修改进度”。'); return; }
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
    const selectionBaselineChanged = projectWorkflows && selectedPaths.some(relativePathTouchesSelectionBaseline);
    setBatchRenameOpen(false);
    setBatchRenameParts([]);
    setSelectedPaths([]);
    onNotice(`已批量重命名 ${count} 个项目`);
    if (selectionBaselineChanged) await ensureSelectionBaseline();
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
    setSurfaceMenu({ x: event.clientX, y: event.clientY, targetRelativePath: normalizedTarget, targetLabel: targetLabel || normalizedTarget || '项目根目录' });
    void loadShellNewTypes();
  };
  const openMissingProgressMenu = (folder: ProgressFolder, x: number, y: number) => {
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setFileMenu(null);
    setSurfaceMenu(null);
    setMissingProgressMenu({ folder, x, y });
  };
  const showDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
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
    setCurrentRelativePath(normalizedPath);
  };
  const navigateToDirectory = (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (normalizedPath === currentRelativePath) return;
    setDirectoryHistory(current => ({ back: [...current.back, currentRelativePath], forward: [] }));
    showDirectory(normalizedPath);
  };
  const showVersionTree = () => {
    if (currentRelativePath || !hasVersionTreeFor()) return;
    setFinalViewOpen(false);
    setSelectedPaths([]);
    setPreviewPath('');
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(false);
    setSearchOpen(false);
    setSearchQuery('');
    setFileFilter('all');
    rememberFolderBrowseMode('', 'version-tree');
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
  const openProjectEntry = async (entry: ProjectFileEntry) => {
    if (entry.kind === 'folder') { navigateToDirectory(entry.relativePath); return; }
    if (entry.viaShortcut) {
      const linkedResult = await window.electronAPI.openMediaVersion(entry.path);
      if (!linkedResult.success) onNotice(`打开快捷方式中的文件失败：${linkedResult.error || '无法打开文件'}`);
      return;
    }
    if (entry.kind === 'shortcut') {
      const shortcut = await window.electronAPI.resolveProjectShortcut(workspacePath, project.status, project.name, entry.relativePath);
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
    const result = await window.electronAPI.openProjectEntry(workspacePath, project.status, project.name, entry.relativePath);
    if (!result.success) onNotice(`打开文件失败：${result.error || '无法打开文件'}`);
  };
  const progressFolderForMediaEntry = (entry?: ProjectFileEntry) => {
    if (!entry || !['image', 'raw', 'video'].includes(entry.kind)) return undefined;
    const mediaKind = entry.kind === 'video' ? 'video' : 'image';
    const entryPath = entry.path.replace(/\\/g, '/').toLocaleLowerCase();
    return progressFolders.find(folder => {
      const folderPath = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      return folder.mediaKind === mediaKind && !folder.folderMissing
        && (entryPath === folderPath || entryPath.startsWith(`${folderPath}/`));
    });
  };
  const teamRetouchProgressCounts = teamRetouchHistory.reduce((counts, entry) => {
    const progressId = progressFolderForMediaEntry(entry)?.id;
    if (progressId) counts.set(progressId, (counts.get(progressId) || 0) + 1);
    return counts;
  }, new Map<string, number>());
  const teamRetouchParentProgressIds = [...teamRetouchProgressCounts.keys()].sort((leftId, rightId) => {
    const countDifference = (teamRetouchProgressCounts.get(rightId) || 0) - (teamRetouchProgressCounts.get(leftId) || 0);
    if (countDifference) return countDifference;
    const left = progressFolders.find(folder => folder.id === leftId);
    const right = progressFolders.find(folder => folder.id === rightId);
    return left && right ? compareProgressKeys(right.versionKey, left.versionKey) : 0;
  });
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
      const result = await window.electronAPI.exportFinalVersions(workspacePath, project.status, project.name);
      if (!result.success || !result.folder) throw new Error(result.error || '无法整理喜爱图片');
      directoryEntriesCacheRef.current.clear();
      await loadProgressFolders();
      await loadFinalVersionSummary();
      setFinalViewOpen(false);
      setFinalViewEntries([]);
      setSelectedPaths([]);
      setPreviewPath('');
      setPreviewPaneOpen(false);
      setMetadataPaneOpen(false);
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
    onNotice('正在加载团片协作数据…', 30000);
    try {
      const history = teamRetouchHistory.length ? teamRetouchHistory : await loadTeamRetouchHistory();
      if (targets.length && validTargets.length !== targets.length && !history.length) {
        onNotice('请选择 JPG、PNG、TIFF、HEIC 等成片图片；不能混选文件夹、RAW 或视频');
        return;
      }
      if (!targets.length && !history.length) {
        onNotice('请选择至少一张成片图片开始团片协作');
        return;
      }
      const combined = new Map<string, ProjectFileEntry>();
      for (const item of [...history, ...teamRetouchEntries, ...validTargets]) combined.set(item.relativePath.toLocaleLowerCase(), item);
      if (validTargets.length) {
        const registered = await window.electronAPI.registerTeamProjectPhotos(workspacePath, project.status, project.name, validTargets.map(target => target.relativePath));
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
      setTeamRetouchOpening(false);
    }
  };
  const openProjectEntriesInPhotoshop = async (entries: ProjectFileEntry[]) => {
    if (entries.some(entry => entry.viaShortcut)) {
      onNotice('快捷方式目标中的文件暂不支持直接发送到 Photoshop，请先用默认方式打开');
      return;
    }
    const imagePaths = entries.filter(entry => entry.kind === 'image' || entry.kind === 'raw').map(entry => entry.relativePath);
    if (!imagePaths.length) return;
    const result = await window.electronAPI.openProjectEntriesInPhotoshop(workspacePath, project.status, project.name, imagePaths);
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
    const result = await window.electronAPI.copyProjectEntryPath(workspacePath, project.status, project.name, entry.relativePath);
    const typeLabel = entry.kind === 'folder' ? '文件夹' : '文件';
    onNotice(result.success ? '成功复制文字' : `复制${typeLabel}地址失败：${result.error || '未知错误'}`);
  };
  const copyCurrentDirectoryPath = async (targetRelativePath = currentRelativePath) => {
    const result = await window.electronAPI.copyProjectEntryPath(workspacePath, project.status, project.name, targetRelativePath);
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
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(false);
  };
  const startSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointerTarget = event.target as HTMLElement;
    if (event.button !== 0 || pointerTarget.closest('[data-entry-path], button, input, select, textarea')) return;
    const surface = filesSurfaceRef.current;
    if (!surface) return;
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
    selectionDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, initialPaths: [...selectedPaths], additive, started: false, clearPreviewOnFinish: !additive };
    if (!additive) {
      setSelectedPaths([]);
    }
    setSelectionBox(null);
  };
  const updateSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    const surface = filesSurfaceRef.current;
    if (!drag || !surface || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
      selectionDragRef.current = null;
      setSelectionBox(null);
      clearPreviewAfterSelectionDrag(drag);
      return;
    }
    if (!drag.started) {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (moved < 5) return;
      drag.started = true;
    }
    event.preventDefault();
    const surfaceRect = surface.getBoundingClientRect();
    const currentX = clampNumber(event.clientX, Math.min(surfaceRect.left, drag.startX), Math.max(surfaceRect.right, drag.startX));
    const currentY = clampNumber(event.clientY, Math.min(surfaceRect.top, drag.startY), Math.max(surfaceRect.bottom, drag.startY));
    const leftClient = Math.min(drag.startX, currentX);
    const topClient = Math.min(drag.startY, currentY);
    const rightClient = Math.max(drag.startX, currentX);
    const bottomClient = Math.max(drag.startY, currentY);
    setSelectionBox({ left: leftClient - surfaceRect.left, top: topClient - surfaceRect.top, width: rightClient - leftClient, height: bottomClient - topClient });
    const hits = Array.from(surface.querySelectorAll<HTMLElement>('[data-entry-path]')).filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.right >= leftClient && rect.left <= rightClient && rect.bottom >= topClient && rect.top <= bottomClient;
    }).map(node => node.dataset.entryPath).filter((path): path is string => Boolean(path));
    const additive = drag.additive || event.ctrlKey || event.metaKey;
    if (additive) drag.additive = true;
    setSelectedPaths(mergeMarqueeSelection(drag.initialPaths, hits, additive));
  };
  const cancelSelectionDrag = () => {
    selectionDragRef.current = null;
    setSelectionBox(null);
  };
  const finishSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    selectionDragRef.current = null;
    setSelectionBox(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    clearPreviewAfterSelectionDrag(drag);
  };
  const cancelFileCut = async () => {
    if (!cutPaths.length) return;
    const cancelledPaths = [...cutPaths];
    const cancellationSequence = ++clipboardOperationSequenceRef.current;
    setCutPaths([]);
    setClipboardHasFiles(false);
    onNotice('已取消剪切');
    const result = await window.electronAPI.cancelProjectFileCut(workspacePath, project.status, project.name, cancelledPaths);
    if (clipboardOperationSequenceRef.current !== cancellationSequence) return;
    if (!result.success) {
      const status = await window.electronAPI.getProjectFileClipboardStatus();
      if (clipboardOperationSequenceRef.current !== cancellationSequence) return;
      setClipboardHasFiles(status.success && status.hasFiles);
      return;
    }
    setClipboardHasFiles(result.hasFiles);
  };
  const runFileOperation = async (operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename', nextName?: string, targetPaths = selectedPaths, destinationRelativePath = operationDirectoryPath) => {
    if (finalViewOpen && operation !== 'copy') { onNotice('喜爱图片浏览是只读视图，请回到原文件夹修改文件'); return; }
    if (operation !== 'paste' && activeFileEntries.some(entry => targetPaths.includes(entry.relativePath) && entry.viaShortcut)) { onNotice('快捷方式中的文件是只读浏览内容，不能执行此操作'); return; }
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
    if (isClipboardSelection) {
      setCutPaths(operation === 'cut' ? [...targetPaths] : []);
      setClipboardHasFiles(true);
      onNotice(operation === 'copy' ? '成功复制文件' : `已剪切 ${targetPaths.length} 个项目`);
    }
    const normalizedDestination = normalizeProjectRelativePath(destinationRelativePath);
    let result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, normalizedDestination, nextName);
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
      result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, normalizedDestination, nextName, { pasteConflictPolicy: policy });
    }
    if (result.cancelled) { onNotice('粘贴已取消'); refresh(); return; }
    if (!result.success) {
      if (isClipboardSelection && clipboardOperationSequenceRef.current === clipboardOperationSequence) {
        setCutPaths(previousCutPaths);
        setClipboardHasFiles(previousClipboardHasFiles);
      }
      if (operation === 'trash' && isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else onNotice(`操作失败：${result.error || '未知错误'}`);
      return;
    }
    if (operation === 'copy' || operation === 'cut') {
      // The renderer already reflected this operation immediately. Waiting for
      // Windows clipboard synchronization here would make a metadata-only
      // action feel like a file transfer.
    } else {
      if (operation === 'paste') setCutPaths([]);
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
      if (projectWorkflows && (relativePathTouchesSelectionBaseline(normalizedDestination) || targetPaths.some(relativePathTouchesSelectionBaseline))) {
        await ensureSelectionBaseline();
      }
      if (projectWorkflows && (operation === 'trash' || operation === 'paste')) await loadProgressFolders();
      refresh();
      refreshRecursiveResults();
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
  const selectedContainsShortcutContent = selectedEntries.some(entry => entry.viaShortcut);
  const registeredProgressFolderForEntry = (entry?: ProjectFileEntry) => {
    if (!entry) return undefined;
    const entryPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
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
    if (entry.kind !== 'folder') return false;
    const normalizedPath = normalizeProjectRelativePath(entry.relativePath);
    if (!normalizedPath || normalizedPath.includes('/')) return false;
    const normalizedName = entry.name.toLocaleLowerCase('zh-CN');
    return PROTECTED_PROJECT_FOLDER_NAMES.has(normalizedName)
      || PROGRESS_FOLDER_NAME_PATTERN.test(entry.name)
      || Boolean(registeredProgressFolderForEntry(entry));
  };
  const selectedContainsProtectedRenameEntry = selectedEntries.some(isProtectedRenameEntry);
  const selectedProgressFolder = selectedEntries.length === 1 && selectedEntries[0].kind === 'folder' ? selectedEntries[0] : undefined;
  const selectedRegisteredProgressFolder = registeredProgressFolderForEntry(selectedProgressFolder);
  const previewEntry = activeFileEntries.find(entry => entry.relativePath === previewPath);
  const filesInCurrentDirectory = activeFileEntries.filter(entry => entry.kind !== 'folder');
  const viewportCurrentEntry = filesInCurrentDirectory.find(entry => entry.relativePath === viewportCurrentPath);
  const viewportCurrentFileNumber = viewportCurrentEntry ? filesInCurrentDirectory.findIndex(entry => entry.relativePath === viewportCurrentEntry.relativePath) + 1 : 0;
  const currentPreviewMetadataFields = previewEntry && previewMetadataResolvedPath === previewEntry.path ? previewMetadataFields : [];
  const currentPreviewMetadataLoading = Boolean(previewEntry && (previewMetadataLoading || previewMetadataResolvedPath !== previewEntry.path));
  const currentPreviewMetadataError = previewEntry && previewMetadataResolvedPath === previewEntry.path ? previewMetadataError : '';
  // The persisted isFinal flag is retained for backward compatibility, but the
  // product concept is now a project-wide image favorite and no longer depends
  // on a version-progress folder.
  const previewCanMarkFinal = Boolean(previewEntry && !previewEntry.viaShortcut && (previewEntry.kind === 'image' || previewEntry.kind === 'raw'));
  const previewVersionCacheKey = previewEntry ? `${workspacePath}|${project.name}|${previewEntry.path.replace(/\\/g, '/').toLocaleLowerCase()}|${previewEntry.updatedAt}` : '';
  useEffect(() => {
    let active = true;
    setPreviewVersion(null);
    setPreviewVersionLoading(false);
    if (!previewEntry || !previewCanMarkFinal) return () => { active = false; };
    const cached = previewVersionCacheRef.current.get(previewVersionCacheKey);
    if (cached) {
      setPreviewVersion(cached);
      return () => { active = false; };
    }
    setPreviewVersionLoading(true);
    let request = previewVersionRequestsRef.current.get(previewVersionCacheKey);
    if (!request) {
      request = window.electronAPI.getMediaVersions(workspacePath, project.status, project.name, previewEntry.relativePath);
      previewVersionRequestsRef.current.set(previewVersionCacheKey, request);
      void request.finally(() => previewVersionRequestsRef.current.delete(previewVersionCacheKey)).catch(() => undefined);
    }
    request.then(result => {
      if (!active || !result.success) return;
      const normalizedPreviewPath = previewEntry.path.replace(/\\/g, '/').toLocaleLowerCase();
      const matchingVersion = result.versions.find(version => version.filePath.replace(/\\/g, '/').toLocaleLowerCase() === normalizedPreviewPath)
        || result.versions.find(version => version.isCurrent)
        || result.versions[result.versions.length - 1];
      if (matchingVersion) {
        if (previewVersionCacheRef.current.size >= 200) previewVersionCacheRef.current.delete(previewVersionCacheRef.current.keys().next().value as string);
        previewVersionCacheRef.current.set(previewVersionCacheKey, matchingVersion);
      }
      setPreviewVersion(matchingVersion || null);
    }).catch(() => undefined).finally(() => { if (active) setPreviewVersionLoading(false); });
    return () => { active = false; };
  }, [previewEntry?.path, previewEntry?.updatedAt, previewCanMarkFinal, previewVersionCacheKey, workspacePath, project.status, project.name]);
  const togglePreviewFinalVersion = async () => {
    if (!previewVersion || previewVersionBusy) return;
    setPreviewVersionBusy(true);
    const nextFinalState = !previewVersion.isFinal;
    const result = await window.electronAPI.updateMediaVersion(workspacePath, { versionId: previewVersion.id, isFinal: nextFinalState });
    setPreviewVersionBusy(false);
    if (!result.success) {
      onNotice(`更新喜爱状态失败：${result.error || '未知错误'}`);
      return;
    }
    const updatedPreviewVersion = result.versions.find(version => version.id === previewVersion.id) || null;
    setPreviewVersion(updatedPreviewVersion);
    if (updatedPreviewVersion && previewVersionCacheKey) previewVersionCacheRef.current.set(previewVersionCacheKey, updatedPreviewVersion);
    await loadFinalVersionSummary();
    if (finalViewOpen) {
      await loadFinalViewEntries();
      if (!nextFinalState) {
        setPreviewPath('');
        setPreviewPaneOpen(false);
        setMetadataPaneOpen(false);
      }
    }
    onNotice(nextFinalState ? '已标记为喜爱' : '已取消喜爱');
  };
  const trimPreviewVideo = async (start: number, end: number, saveMode: 'new' | 'replace') => {
    if (!previewEntry || previewEntry.kind !== 'video' || previewEntry.viaShortcut) return { success: false, error: '当前视频不可剪辑' };
    const result = await window.electronAPI.trimProjectVideo(workspacePath, project.status, project.name, previewEntry.relativePath, { start, end, saveMode });
    if (!result.success) {
      onNotice(`视频剪辑失败：${result.error || '未知错误'}`, 7000);
      return result;
    }
    directoryEntriesCacheRef.current.clear();
    setRecentRefreshToken(value => value + 1);
    await refresh(currentRelativePathRef.current);
    onNotice(result.replaced
      ? `已用剪辑结果覆盖原视频：${previewEntry.name}`
      : `视频剪辑已保存：${result.relativePath?.split('/').pop() || '新视频'}`);
    return result;
  };
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
    if (previewEntry.kind === 'folder' || previewEntry.kind === 'file') {
      setPreviewMetadataResolvedPath(previewEntry.path);
      setPreviewMetadataLoading(false);
      return () => { active = false; };
    }
    setPreviewMetadataLoading(true);
    window.electronAPI.getMediaMetadata(previewEntry.path).then(result => {
      if (!active) return;
      if (!result.success) {
        setPreviewMetadataError(result.error || '无法读取完整详细信息');
        setPreviewMetadataResolvedPath(previewEntry.path);
        return;
      }
      setPreviewMetadataFields(result.fields);
      setPreviewMetadataResolvedPath(previewEntry.path);
    }).finally(() => { if (active) setPreviewMetadataLoading(false); });
    return () => { active = false; };
  }, [previewEntry?.path, previewEntry?.updatedAt]);
  useEffect(() => {
    let active = true;
    setPreviewEntryDetails(null);
    if (!previewEntry || previewEntry.viaShortcut) return () => { active = false; };
    window.electronAPI.getProjectEntryDetails(workspacePath, project.status, project.name, previewEntry.relativePath).then(result => {
      if (active && result.success && result.details) setPreviewEntryDetails(result.details);
    });
    return () => { active = false; };
  }, [previewEntry?.path, workspacePath, project.status, project.name]);
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
  const canSelectMedia = !finalViewOpen && !selectedContainsShortcutContent && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entryIsInSelectionSourceFolder(entry) && (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'));
  const selectedScreenshotMainImageEntries = selectedEntries.filter(entry => isScreenshotMainImageEntry(entry) && !entryIsInSelectionSourceFolder(entry) && !entryIsInsideProgressFolder(entry));
  const canExtractScreenshotMainImage = !finalViewOpen && !selectedContainsShortcutContent && selectedScreenshotMainImageEntries.length > 0;
  const selectedResearchTarget = selectedEntries.length === 1 && selectedPaths.length === 1 && (selectedEntries[0].kind === 'video' || selectedEntries[0].kind === 'folder') ? selectedEntries[0] : null;
  const fileMenuEntrySelected = Boolean(fileMenu && selectedPaths.includes(fileMenu.entry.relativePath));
  const fileMenuTargetPaths = fileMenu
    ? fileMenuEntrySelected ? selectedPaths : [fileMenu.entry.relativePath]
    : selectedPaths;
  const fileMenuContainsShortcutContent = fileMenuTargetPaths.some(path => activeFileEntries.some(entry => entry.relativePath === path && entry.viaShortcut));
  const fileMenuEntries = fileMenuTargetPaths.map(relativePath => activeFileEntries.find(entry => entry.relativePath === relativePath)).filter((entry): entry is ProjectFileEntry => Boolean(entry));
  const fileMenuContainsProtectedRenameEntry = fileMenuEntries.some(isProtectedRenameEntry);
  const fileMenuRegisteredProgressFolder = registeredProgressFolderForEntry(fileMenu?.entry);
  const fileMenuIsSelectionBaselineFolder = Boolean(fileMenu && fileMenu.entry.kind === 'folder'
    && !normalizeProjectRelativePath(fileMenu.entry.relativePath).includes('/')
    && SELECTION_BASELINE_FOLDER_NAMES.has(fileMenu.entry.name.toLocaleLowerCase('zh-CN')));
  const fileMenuScreenshotMainImageEntries = fileMenu
    ? fileMenuEntrySelected ? selectedEntries.filter(entry => isScreenshotMainImageEntry(entry) && !entryIsInSelectionSourceFolder(entry) && !entryIsInsideProgressFolder(entry)) : isScreenshotMainImageEntry(fileMenu.entry) && !entryIsInSelectionSourceFolder(fileMenu.entry) && !entryIsInsideProgressFolder(fileMenu.entry) ? [fileMenu.entry] : []
    : [];
  const canSelectFileMenuMedia = !finalViewOpen && fileMenuTargetPaths.length > 0 && fileMenuTargetPaths.every(path => {
    const entry = activeFileEntries.find(candidate => candidate.relativePath === path);
    return Boolean(entry && !entry.viaShortcut && entryIsInSelectionSourceFolder(entry) && (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'));
  });
  const selectedToolSourceKey = selectedPaths.join('\0');
  const fileMenuToolSourceKey = fileMenu ? fileMenuTargetPaths.join('\0') : '';
  useEffect(() => {
    const sequence = ++selectedToolSourceInspectionSequenceRef.current;
    let retryTimer = 0;
    if (finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length) {
      setSelectedToolSourceAvailability({ loading: false, hasVideo: false, hasPng: false, pngPaths: [] });
      return () => undefined;
    }
    setSelectedToolSourceAvailability(current => ({ ...current, loading: true }));
    const readIndex = async () => {
      const result = await window.electronAPI.inspectProjectToolSources(workspacePath, project.status, project.name, selectedPaths);
      if (sequence !== selectedToolSourceInspectionSequenceRef.current) return;
      if (!result.success) {
        setSelectedToolSourceAvailability({ loading: false, hasVideo: false, hasPng: false, pngPaths: [] });
        return;
      }
      if (!result.indexed) {
        setSelectedToolSourceAvailability({ loading: true, hasVideo: false, hasPng: false, pngPaths: [] });
        retryTimer = window.setTimeout(() => void readIndex(), 800);
        return;
      }
      setSelectedToolSourceAvailability({ loading: false, hasVideo: result.hasVideo, hasPng: result.hasPng, pngPaths: result.pngPaths });
    };
    void readIndex();
    return () => {
      selectedToolSourceInspectionSequenceRef.current += 1;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [workspacePath, project.status, project.name, selectedToolSourceKey, recentRefreshToken, finalViewOpen, selectedContainsShortcutContent]);
  useEffect(() => {
    const sequence = ++fileMenuToolSourceInspectionSequenceRef.current;
    let retryTimer = 0;
    if (!fileMenu || fileMenuContainsShortcutContent || !fileMenuTargetPaths.length) {
      setFileMenuToolSourceAvailability({ loading: false, hasVideo: false, hasPng: false, pngPaths: [] });
      return () => undefined;
    }
    setFileMenuToolSourceAvailability(current => ({ ...current, loading: true }));
    const readIndex = async () => {
      const result = await window.electronAPI.inspectProjectToolSources(workspacePath, project.status, project.name, fileMenuTargetPaths, false, true);
      if (sequence !== fileMenuToolSourceInspectionSequenceRef.current) return;
      if (!result.success) {
        setFileMenuToolSourceAvailability({ loading: false, hasVideo: false, hasPng: false, pngPaths: [] });
        return;
      }
      if (!result.indexed) {
        setFileMenuToolSourceAvailability({ loading: true, hasVideo: false, hasPng: false, pngPaths: [] });
        retryTimer = window.setTimeout(() => void readIndex(), 800);
        return;
      }
      setFileMenuToolSourceAvailability({ loading: false, hasVideo: result.hasVideo, hasPng: result.hasPng, pngPaths: result.pngPaths });
    };
    void readIndex();
    return () => {
      fileMenuToolSourceInspectionSequenceRef.current += 1;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [workspacePath, project.status, project.name, fileMenuToolSourceKey, recentRefreshToken, fileMenuContainsShortcutContent]);
  const gatherInspiration = async (targetProject: WorkspaceProject, targetPaths: string[]) => {
    if (!gatherToProject || gatheringInspiration) return;
    if (!inspirationTargetWorkspacePath?.trim()) { onNotice('请先设置项目工作目录'); return; }
    if (!targetPaths.length) { onNotice('请先选择要汇聚的文件或文件夹'); return; }
    setGatheringInspiration(true);
    try {
      const result = await window.electronAPI.addInspirationToProject(workspacePath, inspirationTargetWorkspacePath, targetProject.status, targetProject.name, targetPaths);
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
  const openResearchForEntry = async (entry: ProjectFileEntry) => {
    if (entry.kind !== 'video' && entry.kind !== 'folder') return;
    if (projectPanelIsRunning('research')) { setPanel('research'); return; }
    const sequence = ++researchInspectionSequenceRef.current;
    setResearchTargetPath(entry.path);
    setResearchTargetKind(entry.kind === 'folder' ? 'folder' : 'file');
    setResearchTargetHasTxt(false);
    setPanel('research');
    if (entry.kind !== 'folder') return;
    const result = await window.electronAPI.browseProjectFiles(workspacePath, project.status, project.name, entry.relativePath, mediaCacheConfig);
    if (sequence !== researchInspectionSequenceRef.current) return;
    setResearchTargetHasTxt(Boolean(result.success && result.entries.some(candidate => candidate.extension.toLocaleLowerCase() === '.txt')));
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
      const result = await window.electronAPI.inspectProjectToolSources(workspacePath, project.status, project.name, targetRelativePaths, true);
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
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'select', targetPaths);
    if (!result.success) { onNotice(`选片失败：${result.error || '未知错误'}`); return; }
    const imageCount = result.imageCount || 0;
    const videoCount = result.videoCount || 0;
    const baseline = imageCount || videoCount ? await ensureSelectionBaseline(true) : null;
    if ((imageCount || videoCount) && !baseline?.success) return;
    const baselineSummary = [imageCount ? `${imageCount} 张图片` : '', videoCount ? `${videoCount} 个视频` : ''].filter(Boolean).join('、');
    onNotice(baselineSummary
      ? `已将 ${result.count || 0} 个媒体文件放入选片文件夹，并将 ${baselineSummary}登记为 V0 基线`
      : `已将 ${result.count || 0} 个媒体文件放入选片文件夹`);
    setSelectedPaths([]);
    refresh();
  };
  const openPreviewAndMetadata = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video') return;
    selectionAnchorPathRef.current = entry.relativePath;
    setSelectedPaths([entry.relativePath]);
    setPreviewPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(true);
    setMetadataPaneOpen(true);
  };
  const metadataPreferenceFolderKey = (entry?: ProjectFileEntry) => {
    const relativeFolder = entry && !entry.viaShortcut
      ? projectRelativeParentPath(entry.relativePath)
      : currentRelativePath;
    return `${project.path}|${normalizeProjectRelativePath(relativeFolder)}`;
  };
  const closeMetadataPaneByUser = () => {
    if (previewEntry?.kind === 'image' || previewEntry?.kind === 'raw') {
      metadataAutoOpenDismissedFoldersRef.current.add(metadataPreferenceFolderKey(previewEntry));
    }
    setMetadataPaneOpen(false);
  };
  const openPreviewOnly = (entry: ProjectFileEntry) => {
    if (entry.kind !== 'image' && entry.kind !== 'raw' && entry.kind !== 'video') return;
    selectionAnchorPathRef.current = entry.relativePath;
    setSelectedPaths([entry.relativePath]);
    setPreviewPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(true);
    setMetadataPaneOpen(false);
  };
  const openEntryDetails = (entry: ProjectFileEntry) => {
    setPreviewPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(false);
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
    if (range) {
      selectEntryRange(entry.relativePath, additive);
      return;
    }
    if (additive) {
      toggleSelected(entry.relativePath);
      return;
    }
    if (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') {
      const imageMetadataAutoOpenDismissed = (entry.kind === 'image' || entry.kind === 'raw')
        && metadataAutoOpenDismissedFoldersRef.current.has(metadataPreferenceFolderKey(entry));
      if (previewOnlyOnMediaClick || imageMetadataAutoOpenDismissed) openPreviewOnly(entry);
      else openPreviewAndMetadata(entry);
      return;
    }
    if (selectedPaths.length) toggleSelected(entry.relativePath);
    else openProjectEntry(entry);
  };
  const handleEntryDoubleClick = (event: React.MouseEvent, entry: ProjectFileEntry) => {
    if (entry.kind === 'folder' || entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video' || inlineRenamePath === entry.relativePath) return;
    event.preventDefault();
    event.stopPropagation();
    void openProjectEntry(entry);
  };
  const getEntryDisplayName = (entry: ProjectFileEntry) => entry.kind === 'shortcut' && entry.name.toLocaleLowerCase().endsWith('.lnk')
    ? entry.name.slice(0, -4)
    : entry.name;
  const renderEntryName = (entry: ProjectFileEntry, grid = false) => inlineRenamePath === entry.relativePath ? <input
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
  const gridThumbnailSize = gridIconSize <= 112 ? 320 : gridIconSize <= 184 ? 640 : gridIconSize <= 264 ? 960 : 1200;
  const renderEntryIcon = (entry: ProjectFileEntry, large = false, queueOrder = displayedFileEntries.findIndex(candidate => candidate.path === entry.path)) => entry.kind === 'folder'
    ? <FolderCover entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? 320 : 160} queueOrder={queueOrder} large={large} loadEntries={loadDirectoryPreviewEntries}/>
    : entry.kind === 'shortcut'
      ? <FolderInput size={large ? 48 : 28} strokeWidth={1.4} className="text-blue-500"/>
      : entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'
      ? <MediaThumbnail entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? gridThumbnailSize : 160} queueOrder={queueOrder} large={large}/>
      : <SystemFileIcon filePath={entry.path} size={large ? 48 : 28}/>;
  const startEntryDrag = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const requestedPaths = selectedPaths.includes(entry.relativePath) ? selectedPaths : [entry.relativePath];
    const dragPaths = requestedPaths.filter(path => !activeFileEntries.some(candidate => candidate.relativePath === path && candidate.viaShortcut));
    if (!dragPaths.length) return;
    internalDragPathsRef.current = dragPaths;
    internalDropHandledRef.current = false;
    if (!selectedPaths.includes(entry.relativePath)) setSelectedPaths([entry.relativePath]);
    window.electronAPI.startProjectFileDrag(workspacePath, project.status, project.name, dragPaths);
  };
  const finishEntryDrag = () => {
    internalDragPathsRef.current = [];
    setDragTargetPath('');
    setRecursiveDropTargetPath(null);
  };
  const hasExternalFiles = (event: React.DragEvent<HTMLElement>) => internalDragPathsRef.current.length === 0 && Array.from(event.dataTransfer.types).includes('Files');
  const getExternalFilePaths = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.files)
    .map(file => (file as File & { path?: string }).path || '')
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
  const performDirectoryDrop = async (internalPaths: string[], externalPaths: string[], targetRelativePath: string, targetName: string) => {
    const operation = internalPaths.length ? 'move' : 'import';
    const paths = internalPaths.length ? internalPaths : externalPaths;
    if (!paths.length) return;
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, operation, paths, targetRelativePath);
    if (!result.success) { onNotice(`${operation === 'move' ? '移动' : '导入'}失败：${result.error || '未知错误'}`); return; }
    if (operation === 'move') setCutPaths(current => current.filter(path => !paths.includes(path)));
    setSelectedPaths([]);
    onNotice(`已${operation === 'move' ? '移动' : '导入'} ${result.count} 个项目到 ${targetName}`);
    if (projectWorkflows && (relativePathTouchesSelectionBaseline(targetRelativePath) || internalPaths.some(relativePathTouchesSelectionBaseline))) {
      await ensureSelectionBaseline();
    }
    refresh();
    refreshRecursiveResults();
  };
  const handleEntryDragOver = (event: React.DragEvent<HTMLDivElement>, entry: ProjectFileEntry) => {
    if (entry.kind !== 'folder' || (!canDropInternalIntoFolder(entry) && !hasExternalFiles(event))) return;
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
    if (entry.kind !== 'folder') return;
    const requestedInternalPaths = [...internalDragPathsRef.current];
    const internalPaths = internalMovePathsForTarget(requestedInternalPaths, entry.relativePath);
    const externalPaths = requestedInternalPaths.length ? [] : getExternalFilePaths(event);
    if (requestedInternalPaths.length ? !internalPaths.length : !externalPaths.length) return;
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
    const internalPaths = internalMovePathsForTarget(requestedInternalPaths, targetRelativePath);
    const externalPaths = requestedInternalPaths.length ? [] : getExternalFilePaths(event);
    if (requestedInternalPaths.length ? !internalPaths.length : !externalPaths.length) return;
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
  useEffect(() => window.electronAPI.onProjectFileDragEnd(result => {
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
    const folderTarget = element?.closest<HTMLElement>('[data-entry-kind="folder"][data-entry-path]');
    const recursiveTarget = folderTarget ? null : recursiveDropTargetFromElement(element);
    const targetRelativePath = folderTarget?.dataset.entryPath ?? recursiveTarget?.relativePath;
    if (targetRelativePath === undefined) return;
    const movablePaths = internalMovePathsForTarget(dragPaths, targetRelativePath);
    if (!movablePaths.length) return;
    const targetName = folderTarget?.title || recursiveTarget?.label || targetRelativePath.split(/[\\/]/).pop() || '项目根目录';
    void performDirectoryDrop(movablePaths, [], targetRelativePath, targetName);
  }), [workspacePath, project.status, project.name, recursiveFlatOpen]);
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
    if (finalViewOpen) { onNotice('喜爱图片浏览是只读视图，不能导入文件'); return; }
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'import', externalPaths, currentRelativePath);
    if (!result.success) { onNotice(`导入失败：${result.error || '未知错误'}`); return; }
    onNotice(`已导入 ${result.count} 个项目`);
    if (projectWorkflows && relativePathTouchesSelectionBaseline(currentRelativePath)) await ensureSelectionBaseline();
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

  const versionTreeStatusLabel = (folder: ProgressFolder) => folder.folderMissing
    ? '文件夹失效'
    : folder.trackingState === 'needs_repair'
      ? '待修复'
      : folder.trackingState === 'committing'
        ? '正在提交'
        : folder.trackingState === 'pending_compare' || folder.trackingState === 'pending_confirm'
          ? '等待确认'
          : folder.trackingEnabled && folder.trackingState === 'ready'
            ? '跟踪中'
            : '未跟踪';
  const renderVersionTreeEntry = (entry: ProjectFileEntry, progressFolder?: ProgressFolder, sourceKind?: 'image' | 'video') => <div
    role="button"
    tabIndex={0}
    draggable={inlineRenamePath !== entry.relativePath}
    onDragStart={event => startEntryDrag(event, entry)}
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
    className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50 ring-1 ring-blue-400' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-blue-500' : ''}`}
  >
    <span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span>
    {progressFolder && <span className={`absolute right-3 top-3 z-10 rounded-full px-2 py-1 font-mono text-[10px] font-bold shadow-sm ${progressFolder.folderMissing ? 'bg-red-50 text-red-700' : progressFolder.displayName.includes('团片协作合成') ? 'bg-violet-600 text-white' : 'bg-blue-600 text-white'}`}>V{progressFolder.versionKey}</span>}
    {!progressFolder && sourceKind && <span className="absolute right-3 top-3 z-10 rounded-full bg-slate-700 px-2 py-1 text-[10px] font-bold text-white shadow-sm">底片</span>}
    {!progressFolder && entry.name === '团片协作' && <span className="absolute right-3 top-3 z-10 rounded-full bg-violet-600 px-2 py-1 text-[10px] font-bold text-white shadow-sm">协作分支</span>}
    <div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div>
    {renderEntryName(entry, true)}
    <p className={`mt-0.5 truncate text-[10px] ${progressFolder?.trackingState === 'needs_repair' || progressFolder?.folderMissing ? 'font-bold text-amber-600' : 'uppercase text-slate-400'}`}>{progressFolder ? `${progressFolder.displayName.includes('团片协作合成') ? '协作分支' : '文件夹'} · ${versionTreeStatusLabel(progressFolder)}` : sourceKind === 'image' ? '文件夹 · 原始图片素材' : sourceKind === 'video' ? '文件夹 · 原始视频素材' : entry.name === '团片协作' ? '文件夹 · 协作工作区' : entry.kind === 'folder' ? '文件夹' : entry.kind === 'shortcut' ? '快捷方式' : entry.extension.slice(1) || '文件'}</p>
  </div>;

  const progressCompareCandidates = progressCompare ? [...progressCompare.matches, ...progressCompare.suggestions] : [];
  const progressCompareAcceptedReferences = new Set(progressCompareCandidates.filter(match => progressCompare?.acceptedSources.includes(match.source)).map(match => match.reference));
  const progressCompareMissingReferences = progressCompare?.unmatchedReferences.filter(reference => !progressCompareAcceptedReferences.has(reference)) || [];
  const progressCompareNewSources = progressCompare ? progressCompareNewSourcesFor(progressCompare) : [];
  const progressCompareListItems = progressCompare ? buildProgressCompareListItems(progressCompare, progressCompareFilter) : [];
  const activeProgressCompareItem = progressCompareListItems.find(item => item.key === activeProgressCompareItemKey);
  const photoshopToolbarAvailable = photoshopAvailable && !selectedContainsShortcutContent && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw');
  const pngConverterToolbarAvailable = !finalViewOpen && !selectedContainsShortcutContent && !selectedToolSourceAvailability.loading && selectedToolSourceAvailability.hasPng;
  const videoToolsToolbarAvailable = !finalViewOpen && !selectedContainsShortcutContent && !selectedToolSourceAvailability.loading && selectedToolSourceAvailability.hasVideo;
  const fileMenuHasToolActions = Boolean(fileMenu && (fileMenu.entry.kind !== 'folder' || fileMenuToolSourceAvailability.loading || fileMenuToolSourceAvailability.hasVideo || fileMenuToolSourceAvailability.hasPng));
  const versionManagementToolbarAvailable = Boolean(selectedRegisteredProgressFolder) || selectedEntries.length === 1 && hasVersionProgressForEntry(selectedEntries[0]);
  const teamRetouchToolbarAvailable = teamRetouchInstalled && (selectedEntries.some(entry => entry.kind === 'image') || teamRetouchHistory.length > 0);
  const projectToolbarAvailability: Record<ProjectToolbarActionId, boolean> = {
    'filename-selection': true,
    'select-media': canSelectMedia,
    storyboard: videoToolsToolbarAvailable,
    'screenshot-main-image': canExtractScreenshotMainImage,
    photoshop: photoshopToolbarAvailable,
    'png-converter': pngConverterToolbarAvailable,
    'version-management': versionManagementToolbarAvailable,
    'team-retouch': teamRetouchToolbarAvailable,
    'final-versions': finalVersionSummary.count > 0,
  };
  const unavailableProjectToolbarTitle = (label: string, reason: string) => `${label}，${reason}`;
  const projectToolbarButtons: Record<ProjectToolbarActionId, React.ReactNode> = {
    'filename-selection': <button onClick={() => togglePanel('match')} title="从文件名选片" aria-label="从文件名选片" className="project-action-button"><FileText size={16}/>从文件名选片</button>,
    'select-media': <button disabled={!canSelectMedia} title={canSelectMedia ? '选片：把所选素材加入图片或视频选片结果' : unavailableProjectToolbarTitle('选片', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '需选择选片源素材使用')} aria-label="选片" onClick={() => void selectMediaFiles()} className="project-action-button"><CheckCircle2 size={16}/>选片</button>,
    storyboard: <div className="relative" onClick={event => event.stopPropagation()}>
      <button type="button" disabled={!videoToolsToolbarAvailable} onClick={() => { const next = !showVideoToolsMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowVideoToolsMenu(next); }} title={selectedToolSourceAvailability.loading ? '项目媒体索引正在建立' : videoToolsToolbarAvailable ? '视频工具' : '所选文件或文件夹中没有视频'} aria-label="视频工具" aria-haspopup="menu" aria-expanded={showVideoToolsMenu} aria-pressed={panel === 'research' || panel === 'video-transcode'} className={`project-action-button ${panel === 'research' || panel === 'video-transcode' ? 'bg-blue-50 text-blue-600' : ''}`}>{selectedToolSourceAvailability.loading ? <Loader2 size={16} className="animate-spin"/> : <Video size={16}/>}视频工具</button>
      {showVideoToolsMenu && <div role="menu" className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
        <button type="button" role="menuitem" disabled={!selectedResearchTarget || !selectedToolSourceAvailability.hasVideo} title={selectedResearchTarget ? '从所选视频或文件夹中提取代表性画面' : '需单独选择一个视频或文件夹'} className="project-menu-item" onClick={() => { if (!selectedResearchTarget) return; setShowVideoToolsMenu(false); void openResearchForEntry(selectedResearchTarget); }}><Video size={14}/>截取分镜帧</button>
        <button type="button" role="menuitem" className="project-menu-item" onClick={() => void openVideoTranscode()}><Gauge size={14}/>视频转码</button>
      </div>}
    </div>,
    'screenshot-main-image': <button type="button" disabled={!canExtractScreenshotMainImage} onClick={() => { if (panel === 'screenshot-main-image') setPanel(null); else openScreenshotMainImage(selectedScreenshotMainImageEntries); }} title={canExtractScreenshotMainImage ? selectedScreenshotMainImageEntries.length > 1 ? `提取截图主图：批量识别并裁出所选 ${selectedScreenshotMainImageEntries.length} 张截图中的主要图片区域` : '提取截图主图：识别并裁出所选截图中的主要图片区域' : unavailableProjectToolbarTitle('提取截图主图', finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '需选择截图图片使用')} aria-label="提取截图主图" aria-pressed={panel === 'screenshot-main-image'} className={`project-action-button ${panel === 'screenshot-main-image' ? 'bg-blue-50 text-blue-600' : ''}`}><Crop size={16}/>提取截图主图{selectedScreenshotMainImageEntries.length > 1 ? `（${selectedScreenshotMainImageEntries.length} 张）` : ''}</button>,
    photoshop: <button disabled={!photoshopToolbarAvailable} onClick={() => void openProjectEntriesInPhotoshop(selectedEntries)} title={photoshopToolbarAvailable ? selectedEntries.length > 1 ? `在 PS 中打开：把所选 ${selectedEntries.length} 张图片或 RAW 发送到 Photoshop` : '在 PS 中打开：把所选图片或 RAW 发送到 Photoshop' : unavailableProjectToolbarTitle('在 PS 中打开', !photoshopAvailable ? '未检测到 Photoshop' : selectedContainsShortcutContent ? '快捷方式内容暂不支持' : '需选择图片/RAW 使用')} aria-label="在 Photoshop 中打开所选图片或 RAW" className="project-action-button"><PhotoshopIcon size={16}/>在 PS 中打开{selectedEntries.length > 1 && photoshopToolbarAvailable ? `（${selectedEntries.length} 张）` : ''}</button>,
    'png-converter': <button disabled={!pngConverterToolbarAvailable} onClick={() => { if (panel === 'converter') setPanel(null); else openPngConverter(selectedEntries.map(entry => entry.path)); }} title={pngConverterToolbarAvailable ? selectedEntries.length > 1 ? `PNG 转 JPG：转换所选 ${selectedEntries.length} 个文件或文件夹中的 PNG` : 'PNG 转 JPG：转换所选文件或文件夹中的 PNG' : unavailableProjectToolbarTitle('PNG 转 JPG', selectedToolSourceAvailability.loading ? '项目媒体索引正在建立' : finalViewOpen ? '喜爱图片为只读' : selectedContainsShortcutContent ? '快捷方式内容为只读' : '所选文件或文件夹中没有 PNG')} aria-label="PNG 转 JPG" aria-pressed={panel === 'converter'} className={`project-action-button ${panel === 'converter' ? 'bg-blue-50 text-blue-600' : ''}`}>{selectedToolSourceAvailability.loading ? <Loader2 size={16} className="animate-spin"/> : <ImageIcon size={16}/>}PNG 转 JPG</button>,
    'version-management': selectedRegisteredProgressFolder ? selectedRegisteredProgressFolder.trackingState === 'needs_repair' ? <button onClick={() => void openProgressRepair(selectedRegisteredProgressFolder)} title="修复版本批次：继续处理未完成的版本提交操作" aria-label="修复版本批次" className="project-action-button !text-amber-600"><RefreshCw size={16}/>修复版本批次</button> : <button disabled={selectedRegisteredProgressFolder.trackingState === 'committing'} onClick={() => void openMarkProgress(selectedProgressFolder!)} title={selectedRegisteredProgressFolder.trackingState === 'committing' ? unavailableProjectToolbarTitle('版本管理', '版本批次正在提交') : '修改当前进度：调整当前进度文件夹的版本信息'} aria-label="修改进度" className="project-action-button"><GitBranch size={16}/>{selectedRegisteredProgressFolder.trackingState === 'committing' ? '正在提交' : '修改进度'}</button> : selectedEntries.length === 1 && hasVersionProgressForEntry(selectedEntries[0]) ? <button onClick={() => openVersions()} title="版本管理：查看和管理素材的当前版本与历史版本" aria-label="版本管理" className="project-action-button"><GitBranch size={16}/>版本管理</button> : <button disabled title={unavailableProjectToolbarTitle('版本管理', '需选择图片使用')} aria-label="版本管理" className="project-action-button"><GitBranch size={16}/>版本管理</button>,
    'team-retouch': <button type="button" disabled={!teamRetouchToolbarAvailable || teamRetouchOpening} onClick={() => void openTeamRetouch()} title={!teamRetouchInstalled ? unavailableProjectToolbarTitle('团片协作', '组件未安装') : !teamRetouchToolbarAvailable ? unavailableProjectToolbarTitle('团片协作', '需选择图片使用') : teamRetouchOpening ? unavailableProjectToolbarTitle('团片协作', '正在加载') : selectedEntries.some(entry => entry.kind === 'image') ? '团片协作：打开协作工作区并加入所选图片' : `团片协作：打开项目已有的 ${teamRetouchHistory.length} 张协作图片`} className="project-action-button">{teamRetouchOpening ? <Loader2 size={16} className="animate-spin"/> : <UsersRound size={16}/>}团片协作{teamRetouchHistory.length ? `（${teamRetouchHistory.length} 张）` : ''}</button>,
    'final-versions': <button disabled={finalVersionSummary.count === 0 || finalViewLoading} onClick={() => void openFinalVersionView()} title={finalViewLoading ? unavailableProjectToolbarTitle('查看喜爱', '正在加载') : finalVersionSummary.count > 0 ? `查看喜爱：浏览项目中已标记的 ${finalVersionSummary.availableCount} 张喜爱图片${finalVersionSummary.missingCount ? `，另有 ${finalVersionSummary.missingCount} 张文件丢失` : ''}` : unavailableProjectToolbarTitle('查看喜爱', '暂无喜爱图片')} aria-label="查看所有已标记为喜爱的图片" aria-pressed={finalViewOpen} className={`project-action-button ${finalVersionSummary.count > 0 ? '!text-red-500 hover:!bg-red-50' : ''} ${finalViewOpen ? '!bg-red-50' : ''}`}>{finalViewLoading ? <Loader2 size={16} className="animate-spin"/> : <Heart size={16} fill={finalVersionSummary.count > 0 ? 'currentColor' : 'none'}/>}</button>,
  };
  const hiddenProjectToolbarActions = new Set(projectToolbar.hidden);
  const visibleProjectToolbarActionIds = projectToolbar.order.filter(id => !hiddenProjectToolbarActions.has(id) && (!projectToolbar.onlyShowAvailable || projectToolbarAvailability[id]));
  const hasProjectToolbarActions = visibleProjectToolbarActionIds.length > 0;
  const progressSetupAppendTarget = progressSetup ? progressAppendTarget(progressSetup) : undefined;
  const progressSetupReplacementTarget = progressSetup ? progressReplacementTarget(progressSetup) : undefined;

  return (
    <div ref={projectWorkspaceRef} className="flex h-full w-full min-w-0 flex-col animate-in fade-in duration-300">
      {missingProgressMenu && createPortal(<ViewportContextMenu x={missingProgressMenu.x} y={missingProgressMenu.y} widthClass="w-52">
        <p className="truncate px-2 py-1 text-[11px] font-bold text-slate-400" title={missingProgressMenu.folder.displayName}>V{missingProgressMenu.folder.versionKey} · {missingProgressMenu.folder.displayName}</p>
        <div className="my-1 border-t border-slate-100"/>
        <button type="button" disabled={missingProgressMenu.folder.versionKey === '0'} title={missingProgressMenu.folder.versionKey === '0' ? '原始版本不可移除' : '仅移除数据库中的失效版本记录，不删除项目素材'} className="project-menu-item project-menu-danger" onClick={() => { const folder = missingProgressMenu.folder; setMissingProgressMenu(null); void removeMissingProgress(folder); }}><Trash2 size={14}/>移除记录</button>
      </ViewportContextMenu>, document.body)}
      {fileMenu && createPortal(<ViewportContextMenu x={fileMenu.x} y={fileMenu.y} widthClass="w-52">
        {projectWorkflows && (fileMenuRegisteredProgressFolder || fileMenuIsSelectionBaselineFolder) && <>{fileMenuRegisteredProgressFolder?.versionKey !== '0' && fileMenuRegisteredProgressFolder && <button disabled={fileMenuRegisteredProgressFolder.trackingState === 'committing' || fileMenuRegisteredProgressFolder.trackingState === 'needs_repair'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openMarkProgress(entry); }}><GitBranch size={14}/>修改进度</button>}<button disabled={progressSubmitting || Boolean(progressTask) || fileMenuRegisteredProgressFolder?.trackingState === 'committing'} title="重新扫描当前进度中的素材并更新已有版本关系" className="project-menu-item" onClick={() => { const entry = fileMenu.entry; const progressFolder = fileMenuRegisteredProgressFolder; setFileMenu(null); if (progressFolder) void refreshProgressTracking(progressFolder); else void updateSelectionBaselineTracking(entry); }}><RefreshCw size={14}/>{fileMenuRegisteredProgressFolder ? progressTrackingRefreshLabel(fileMenuRegisteredProgressFolder) : '更新项目跟踪'}</button><div className="my-1 border-t border-slate-100"/></>}
        {gatherToProject && <><button disabled={fileMenuContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); startGatherInspiration(targets); }}><FolderInput size={14}/>增加到项目{inspirationTargetProject ? `“${inspirationTargetProject.name}”` : '…'}</button>{inspirationTargetProject && <button disabled={fileMenuContainsShortcutContent || gatheringInspiration} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); setGatherPickerPaths(targets); }}><ChevronDown size={14}/>选择其他项目…</button>}<div className="my-1 border-t border-slate-100"/></>}
        {projectWorkflows && canSelectFileMenuMedia && <><button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); selectMediaFiles(targets); }}><CheckCircle2 size={14}/>选片</button><div className="my-1 border-t border-slate-100"/></>}
        {(fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openPreviewAndMetadata(entry); }}><PanelLeftOpen size={14}/>打开预览和详细信息</button>}
        {fileMenu.entry.kind !== 'folder' && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openProjectEntry(entry); }}><ExternalLink size={14}/>{fileMenu.entry.kind === 'shortcut' ? '打开快捷方式' : '用默认方式打开'}</button>}
        {fileMenuToolSourceAvailability.loading && <button disabled className="project-menu-item"><Loader2 size={14} className="animate-spin"/>正在建立媒体索引…</button>}
        {!fileMenuToolSourceAvailability.loading && fileMenuToolSourceAvailability.hasVideo && (fileMenu.entry.kind === 'video' || fileMenu.entry.kind === 'folder') && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openResearchForEntry(entry); }}><Video size={14}/>提取分镜帧</button>}
        {!fileMenuToolSourceAvailability.loading && fileMenuToolSourceAvailability.hasVideo && <button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); void openVideoTranscode(targets); }}><Gauge size={14}/>视频转码</button>}
        {!fileMenuContainsShortcutContent && fileMenuScreenshotMainImageEntries.length > 0 && <button title={fileMenuScreenshotMainImageEntries.length > 1 ? `批量提取 ${fileMenuScreenshotMainImageEntries.length} 张截图中的主图` : '提取截图中的主图'} className="project-menu-item" onClick={() => { const entries = fileMenuScreenshotMainImageEntries; setFileMenu(null); openScreenshotMainImage(entries); }}><Crop size={14}/>提取截图主图{fileMenuScreenshotMainImageEntries.length > 1 ? `（${fileMenuScreenshotMainImageEntries.length} 张）` : ''}</button>}
        {officeImageExtractorAvailable && isOfficeOpenXmlEntry(fileMenu.entry) && <button disabled={fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item" onClick={() => { const entries = selectedPaths.includes(fileMenu.entry.relativePath) ? selectedEntries.filter(isOfficeOpenXmlEntry) : [fileMenu.entry]; setFileMenu(null); void extractOfficeImages(entries); }}><ImageIcon size={14}/>提取图片{selectedPaths.includes(fileMenu.entry.relativePath) && selectedEntries.filter(isOfficeOpenXmlEntry).length > 1 ? `（${selectedEntries.filter(isOfficeOpenXmlEntry).length} 个文档）` : ''}</button>}
        {photoshopAvailable && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw') && <button disabled={fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件暂不支持直接发送到 Photoshop' : undefined} className="project-menu-item" onClick={() => { const entries = selectedPaths.includes(fileMenu.entry.relativePath) ? selectedEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw') : [fileMenu.entry]; setFileMenu(null); void openProjectEntriesInPhotoshop(entries); }}><PhotoshopIcon size={14}/>用 Photoshop 打开{selectedPaths.includes(fileMenu.entry.relativePath) && selectedEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw').length > 1 ? `（${selectedEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw').length} 个）` : ''}</button>}
        {!fileMenuToolSourceAvailability.loading && fileMenuToolSourceAvailability.hasPng && <button className="project-menu-item" onClick={() => { const targets = fileMenuToolSourceAvailability.pngPaths; setFileMenu(null); openPngConverter(targets); }}><ImageIcon size={14}/>PNG 转 JPG</button>}
        {fileMenuHasToolActions && <div className="my-1 border-t border-slate-100"/>}
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent || fileMenuContainsProtectedRenameEntry} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : fileMenuContainsProtectedRenameEntry ? '该文件夹由项目工作流管理，不能普通重命名' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); beginRename(targets); }}><Edit size={14}/>{fileMenuTargetPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('cut', undefined, targets); }}><Cut size={14}/>剪切</button>
        <button disabled={fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('copy', undefined, targets); }}><Copy size={14}/>复制</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent || !clipboardHasFiles} title={fileMenuContainsShortcutContent ? '快捷方式指向的外部文件夹是只读浏览区域' : finalViewOpen ? '喜爱图片浏览为只读视图' : clipboardHasFiles ? '粘贴到此文件所在文件夹' : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('paste'); }}><ClipboardPaste size={14}/>粘贴</button>
        <button disabled={finalViewOpen || fileMenuContainsShortcutContent} title={fileMenuContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : undefined} className="project-menu-item project-menu-danger" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('trash', undefined, targets); }}><Trash2 size={14}/>删除</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openEntryDetails(entry); }}><Info size={14}/>详细信息</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); copyEntryPath(entry); }}><FileText size={14}/>{fileMenu.entry.kind === 'folder' ? '复制文件夹地址' : '复制文件地址'}</button>
        <button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; if (fileMenuEntrySelected) setSelectedPaths(current => current.filter(item => item !== path)); else { selectionAnchorPathRef.current = path; setSelectedPaths(current => [...current, path]); requestFileReveal(path); } setFileMenu(null); }}>{fileMenuEntrySelected ? <X size={14}/> : <CheckSquare size={14}/>} {fileMenuEntrySelected ? '取消选择' : '选择'}</button>
        {projectWorkflows && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <div className="my-1 border-t border-slate-100"/>}
        {projectWorkflows && (fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <><button disabled={!hasVersionProgressForEntry(fileMenu.entry)} title={hasVersionProgressForEntry(fileMenu.entry) ? '管理素材的当前版本和历史版本' : '请先标记或导入版本进度'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openVersions(entry); }}><GitBranch size={14}/>版本管理</button>{teamRetouchAvailable && fileMenu.entry.kind === 'image' && <button disabled={!teamRetouchInstalled || teamRetouchOpening} title={!teamRetouchInstalled ? '正在检查团片协作组件' : teamRetouchOpening ? '正在加载团片协作数据' : '团片协作'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openTeamRetouch(entry); }}>{teamRetouchOpening || !teamRetouchInstalled && componentsLoading ? <Loader2 size={14} className="animate-spin"/> : <UsersRound size={14}/>}团片协作</button>}</>}
      </ViewportContextMenu>, document.body)}
      {surfaceMenu && createPortal(<ViewportContextMenu x={surfaceMenu.x} y={surfaceMenu.y} widthClass="w-56" allowSubmenus>
        <p className="truncate px-2 py-1 text-[11px] font-bold text-slate-400" title={surfaceMenu.targetLabel}>在“{surfaceMenu.targetLabel}”中操作</p>
        <div className="group/submenu relative"><button className="project-menu-item w-full"><FolderPlus size={14}/>新建<span className="ml-auto">›</span></button><div className="invisible absolute left-full top-0 z-[302] ml-1 w-72 rounded-lg border border-slate-200 bg-white p-1 opacity-0 shadow-xl transition group-hover/submenu:visible group-hover/submenu:opacity-100">{projectWorkflows && !recursiveFlatOpen && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void openProgressSetup('create'); }}><FolderPlus size={14}/>新建进度</button>}<button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void createFolder(target); }}><Folder size={14}/>新建文件夹</button><div className="my-1 border-t border-slate-100"/><div className="flex items-center justify-between px-2 pb-1 pt-1"><p className="text-[11px] font-bold text-slate-400">Windows 文件类型</p><button type="button" title="重新扫描 Windows 新建文件类型" disabled={shellNewTypesLoading} onClick={() => void loadShellNewTypes(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"><RefreshCw size={12} className={shellNewTypesLoading ? 'animate-spin' : ''}/></button></div><div className="max-h-72 overflow-y-auto">{shellNewTypesLoading && <p className="px-2 py-2 text-xs text-slate-400">正在读取系统新建菜单…</p>}{!shellNewTypesLoading && shellNewTypes.map(type => <button key={type.id} className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void createShellNewFile(type, target); }}>{type.iconDataUrl ? <img src={type.iconDataUrl} alt="" className="h-4 w-4 shrink-0 object-contain"/> : <File size={14} className="shrink-0"/>}<span className="min-w-0 flex-1 truncate">{type.label}</span><span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{type.extension}</span></button>)}{!shellNewTypesLoading && shellNewTypesLoaded && !shellNewTypes.length && <p className="px-2 py-2 text-xs text-slate-400">系统没有可用的新建文件类型</p>}</div></div></div>
        <div className="group/submenu relative"><button className="project-menu-item w-full"><FolderInput size={14}/>导入<span className="ml-auto">›</span></button><div className="invisible absolute left-full top-0 z-[302] ml-1 w-52 rounded-lg border border-slate-200 bg-white p-1 opacity-0 shadow-xl transition group-hover/submenu:visible group-hover/submenu:opacity-100"><button className="project-menu-item" onClick={() => { setSurfaceMenu(null); setPanel('import'); }}><MemoryStick size={14}/>从 SD 卡导入</button><button className="project-menu-item" onClick={() => { setSurfaceMenu(null); setPanel('negative-import'); }}><Aperture size={14}/>导入底片</button>{projectWorkflows && !recursiveFlatOpen && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void openProgressSetup('import'); }}><FolderInput size={14}/>导入进度</button>}{projectWorkflows && !recursiveFlatOpen && <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); setDeleteBrollSources(importDefaults.deleteSourceAfterImport); setPanel('broll'); }}><FolderInput size={14}/>导入花絮</button>}<div className="my-1 border-t border-slate-100"/><button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); openFileImport(target); }}><FileInput size={14}/>导入文件</button></div></div>
        <div className="my-1 border-t border-slate-100"/>
        <button disabled={!clipboardHasFiles} title={clipboardHasFiles ? `粘贴到“${surfaceMenu.targetLabel}”` : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void runFileOperation('paste', undefined, [], target); }}><ClipboardPaste size={14}/>粘贴</button>
        <button className="project-menu-item" onClick={() => { const target = surfaceMenu.targetRelativePath; setSurfaceMenu(null); void copyCurrentDirectoryPath(target); }}><FileText size={14}/>复制此文件夹地址</button>
      </ViewportContextMenu>, document.body)}
      <div ref={projectColumnLayoutRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div ref={filesColumnRef} style={previewPaneOpen || metadataPaneOpen ? { width: displayedColumnWidths.files } : undefined} onPointerDown={startSelectionDrag} onPointerMove={updateSelectionDrag} onPointerUp={finishSelectionDrag} onPointerCancel={finishSelectionDrag} onLostPointerCapture={cancelSelectionDrag} className={`flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain [overflow-anchor:none] px-6 pb-6 ${previewPaneOpen || metadataPaneOpen ? 'shrink-0' : 'flex-1'}`}>
      {viewportStatus && createPortal(<div role="status" className="pointer-events-none fixed bottom-2 z-[35] flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-lg border border-white/10 bg-slate-950/80 px-3.5 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md" style={{ right: Math.max(12, projectLayoutWidth - displayedColumnWidths.files + 12) }}>
        {viewportStatus.captureDateTime && <>
          <span className="truncate" title={viewportStatus.captureDateTime}>{viewportStatus.captureDateTime}</span>
          <span aria-hidden className="h-3 w-px shrink-0 bg-white/25"/>
        </>}
        <span className="shrink-0 font-mono font-bold tabular-nums">{viewportStatus.fileNumber}/{viewportStatus.total}</span>
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
            <button className="project-menu-item" onClick={() => { setShowImportMenu(false); setPanel('import'); }}><MemoryStick size={14}/>从 SD 卡导入</button>
            <button className="project-menu-item" onClick={() => { setShowImportMenu(false); setPanel('negative-import'); }}><Aperture size={14}/>导入底片</button>
            {projectWorkflows && <button className="project-menu-item" onClick={() => void openProgressSetup('import')}><FolderInput size={14}/>导入进度</button>}
            {projectWorkflows && <button className="project-menu-item" onClick={() => { setShowImportMenu(false); setDeleteBrollSources(importDefaults.deleteSourceAfterImport); setPanel('broll'); }}><FolderInput size={14}/>导入花絮</button>}
            <div className="my-1 border-t border-slate-100"/>
            <button className="project-menu-item" onClick={() => openFileImport()}><FileInput size={14}/>导入文件</button>
          </div>}
        </div>
        <span aria-hidden className="toolbar-divider"/>
        {selectedPaths.length > 0 && <span className="mr-1 self-center text-xs text-slate-500">已选 {selectedPaths.length}</span>}
        <button disabled={finalViewOpen || selectedContainsShortcutContent || selectedContainsProtectedRenameEntry || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : selectedContainsProtectedRenameEntry ? '所选文件夹由项目工作流管理，不能普通重命名' : finalViewOpen ? '喜爱图片浏览为只读视图' : selectedPaths.length > 1 ? '批量重命名' : '重命名'} onClick={() => beginRename()} className="project-action-button compact-hide-file-action"><Edit size={16}/>{selectedPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : finalViewOpen ? '喜爱图片浏览为只读视图' : '剪切'} onClick={() => runFileOperation('cut')} className="project-action-button compact-hide-file-action"><Cut size={16}/>剪切</button>
        <button disabled={selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : '复制'} onClick={() => runFileOperation('copy')} className="project-action-button compact-hide-file-action"><Copy size={16}/>复制</button>
        <button disabled={finalViewOpen || !clipboardHasFiles} title={finalViewOpen ? '喜爱图片浏览为只读视图' : clipboardHasFiles ? '粘贴到当前文件夹' : '剪贴板中没有文件'} onClick={() => runFileOperation('paste')} className="project-action-button compact-hide-file-action"><ClipboardPaste size={16}/>粘贴</button>
        <button disabled={finalViewOpen || selectedContainsShortcutContent || !selectedPaths.length} title={selectedContainsShortcutContent ? '快捷方式中的文件是只读浏览内容' : finalViewOpen ? '喜爱图片浏览为只读视图' : '删除'} onClick={() => runFileOperation('trash')} className="project-action-button project-action-danger compact-hide-file-action"><Trash2 size={16}/>删除</button>
        <button disabled={!selectedPaths.length} title="取消选择" onClick={() => setSelectedPaths([])} className="project-action-button"><X size={16}/>取消选择</button>
        {(gatherToProject || projectWorkflows && hasProjectToolbarActions) && <span aria-hidden className="toolbar-divider"/>}
        {gatherToProject && <div className="flex items-stretch">
          <button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => startGatherInspiration(selectedPaths)} title={inspirationTargetProject ? `将所选灵感添加到项目“${inspirationTargetProject.name}”的“策划”文件夹` : '将所选灵感添加到目标项目的“策划”文件夹'} aria-label="将所选灵感添加到目标项目" className="project-action-button inspiration-target-button !rounded-r-none">{gatheringInspiration ? <Loader2 size={16} className="animate-spin"/> : <FolderInput size={16}/>}<span className="truncate">{inspirationTargetProject ? inspirationTargetProject.name : '添加到项目'}</span></button>
          <button type="button" disabled={!selectedPaths.length || selectedContainsShortcutContent || gatheringInspiration || !inspirationProjects.length} onClick={() => setGatherPickerPaths(selectedPaths)} title="选择要汇聚灵感的目标项目" aria-label="选择要汇聚灵感的目标项目" className="project-action-button !rounded-l-none !px-1"><ChevronDown size={14}/></button>
        </div>}
        {gatherToProject && <span aria-hidden className="toolbar-divider"/>}
        {gatherToProject && !hiddenProjectToolbarActions.has('screenshot-main-image') && projectToolbarAvailability['screenshot-main-image'] && projectToolbarButtons['screenshot-main-image']}
        <div className={projectWorkflows ? 'contents' : 'hidden'}>
          {visibleProjectToolbarActionIds.map(id => <React.Fragment key={id}>{projectToolbarButtons[id]}</React.Fragment>)}
        </div>
        {gatherToProject && !hiddenProjectToolbarActions.has('storyboard') && projectToolbarAvailability.storyboard && projectToolbarButtons.storyboard}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-3">
          <button type="button" onClick={() => { setSearchQuery(''); selectFolderBrowseMode('recent'); }} title="最近文件（包含子文件夹和文件夹快捷方式）" aria-label="最近文件" aria-pressed={browseMode === 'recent'} className={`rounded-md p-1.5 ${browseMode === 'recent' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><GalleryVerticalEnd size={17}/></button>
          <button type="button" onClick={() => selectFolderBrowseMode('grid')} title="图标模式" aria-label="图标模式" aria-pressed={browseMode === 'grid'} className={`rounded-md p-1.5 ${browseMode === 'grid' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><Grid2X2 size={17}/></button>
          <button type="button" onClick={() => selectFolderBrowseMode('list')} title="列表模式" aria-label="列表模式" aria-pressed={browseMode === 'list'} className={`rounded-md p-1.5 ${browseMode === 'list' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><LayoutList size={17}/></button>
          {projectVersionTreeAvailable && <button type="button" onClick={showVersionTree} title="项目版本树" aria-label="项目版本树" aria-pressed={browseMode === 'version-tree'} className={`rounded-md p-1.5 ${browseMode === 'version-tree' ? 'bg-blue-100 text-blue-700' : 'text-slate-500 hover:bg-slate-200'}`}><GitBranch size={17}/></button>}
          {(browseMode === 'grid' || browseMode === 'version-tree') && <input aria-label="图标大小" title="图标大小" type="range" min="80" max="360" step="4" value={gridIconSize} onChange={event => setGridIconSize(Number(event.target.value))} className="compact-hide-slider ml-2 w-24 accent-blue-600"/>}
          <span aria-hidden className="mx-1 h-5 w-px bg-slate-200"/>
          <div className="relative" onClick={event => event.stopPropagation()}><button type="button" disabled={versionTreeOpen} onClick={() => { const next = !showSortMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowSortMenu(next); }} title={versionTreeOpen ? '版本树按照版本关系排列' : recursiveFlatOpen ? '排序每个文件夹中的文件' : '排序'} aria-label="排序" aria-haspopup="menu" aria-expanded={showSortMenu} className="project-action-button"><ArrowUpDown size={16}/>排序</button>{showSortMenu && <div className="sort-menu absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{([['name', '文件名'], ['date', '修改日期'], ['size', '大小']] as const).map(([field, label]) => <button key={field} type="button" onClick={() => setSortField(field)} className={`project-menu-item ${sortField === field ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{label}</button>)}<div className="my-1 border-t border-slate-100"/><button type="button" onClick={() => setSortDirection('asc')} className={`project-menu-item ${sortDirection === 'asc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowUp size={14}/><span>递增</span></button><button type="button" onClick={() => setSortDirection('desc')} className={`project-menu-item ${sortDirection === 'desc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowDown size={14}/><span>递减</span></button></div>}</div>
          <div className="relative" onClick={event => event.stopPropagation()}><button type="button" disabled={versionTreeOpen} onClick={() => { const next = !searchOpen; window.dispatchEvent(new Event('photoflow-menu-open')); setSearchOpen(next); }} title={versionTreeOpen ? '版本树不使用文件查找' : '查找与筛选文件（Ctrl+F）'} aria-label="查找与筛选文件" aria-expanded={searchOpen} className={`project-action-button ${searchOpen || searchQuery || fileFilter !== 'all' ? 'bg-blue-50 text-blue-600' : ''}`}><Search size={16}/>查找文件</button>{searchOpen && <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"><div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2"><Search size={15} className="shrink-0 text-slate-400"/><input ref={searchInputRef} autoFocus value={searchQuery} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); } }} placeholder="输入文件名" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-slate-800 outline-none"/>{searchQuery && <button type="button" onClick={() => setSearchQuery('')} title="清除查找" className="rounded p-0.5 text-slate-400 hover:bg-slate-200"><X size={14}/></button>}</div><div className="mt-2 border-t border-slate-100 pt-2"><p className="mb-1.5 px-1 text-[11px] font-bold text-slate-400">筛选</p><div className="grid grid-cols-2 gap-1">{PROJECT_FILE_FILTER_OPTIONS.map(option => <button key={option.value} type="button" aria-pressed={fileFilter === option.value} onClick={() => setFileFilter(option.value)} className={`rounded-md px-2 py-1.5 text-xs font-medium ${fileFilter === option.value ? 'bg-blue-100 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{option.label}</button>)}</div></div></div>}</div>
        </div>
      </div>
      <div className="flex min-w-0 items-center px-6 py-2">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-sm text-slate-500">
          {finalViewOpen ? <><button type="button" onClick={closeFinalVersionView} title="退出喜爱图片浏览" aria-label="退出喜爱图片浏览" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={17}/></button><span className="inline-flex h-8 shrink-0 items-center px-1.5 font-bold leading-none text-slate-700">喜爱</span></> : versionTreeOpen ? <><button type="button" onClick={() => selectFolderBrowseMode('grid')} title="返回图标模式" aria-label="退出版本树" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"><ArrowLeft size={17}/></button><span className="inline-flex h-8 shrink-0 items-center px-1.5 font-bold leading-none text-slate-700">{browserContext.title}</span><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><span className="inline-flex h-8 shrink-0 items-center gap-1.5 px-1.5 font-bold leading-none text-blue-700"><GitBranch size={15}/>版本树</span></> : <><button type="button" onClick={navigateBack} disabled={!directoryHistory.back.length} title="后退" aria-label="后退" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowLeft size={17}/></button><button type="button" onClick={navigateForward} disabled={!directoryHistory.forward.length} title="前进" aria-label="前进" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowRight size={17}/></button><button type="button" onClick={() => navigateToDirectory('')} title={`返回${browserRootLabel}根目录`} className="mr-1 inline-flex h-8 shrink-0 items-center rounded border border-transparent px-1.5 font-bold leading-none text-slate-800 transition hover:border-slate-300 hover:bg-slate-100">{browserContext.title}</button>{breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.relativePath || 'root'}><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><button onClick={() => navigateToDirectory(crumb.relativePath)} title={`进入 ${crumb.label}`} className={`inline-flex h-8 min-w-0 items-center truncate rounded border border-transparent px-1.5 text-sm leading-none transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 ${index === breadcrumbs.length - 1 ? 'font-bold text-slate-700' : ''}`}>{crumb.label}</button></React.Fragment>)}</>}
        </div>
        {finalViewOpen && <button type="button" disabled={finalExporting || !finalViewEntries.length} onClick={() => void exportFinalVersions()} className="ml-auto shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40">{finalExporting ? '正在整理…' : '整理喜爱图片'}</button>}
      </div>
      </div>

      {mountedPanels.has('converter') && <ToolModal title={PROJECT_PANEL_TITLES.converter} scopeKey={project.path} panelKind="converter" open={panel === 'converter'} onClose={() => setPanel(null)}><ConverterView embedded initialTargetPaths={conversionTargets}/></ToolModal>}
      {mountedPanels.has('screenshot-main-image') && <ToolModal title={screenshotMainImageMode === 'crop' ? '裁剪图片' : PROJECT_PANEL_TITLES['screenshot-main-image']} scopeKey={project.path} panelKind="screenshot-main-image" open={panel === 'screenshot-main-image'} onClose={() => setPanel(null)}><ScreenshotMainImageView embedded cropMode={screenshotMainImageMode === 'crop'} workspacePath={workspacePath} projectStatus={project.status} projectName={project.name} initialRelativePaths={screenshotMainImageTargets} cacheConfig={mediaCacheConfig} onFilesChanged={async () => {
        directoryEntriesCacheRef.current.clear();
        setRecentRefreshToken(value => value + 1);
        await refresh(currentRelativePathRef.current);
        if (finalViewOpen) await loadFinalViewEntries();
      }}/></ToolModal>}
      {mountedPanels.has('import') && <ToolModal title={PROJECT_PANEL_TITLES.import} scopeKey={project.path} panelKind="import" open={panel === 'import'} busy={sdImportBusy} onClose={() => setPanel(null)}><div className="space-y-4"><div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{project.name}”</p><p className="mt-1 text-xs leading-5 text-blue-600">自动识别 SD 卡中的工作文件与花絮，并按项目结构整理。RAW 转 JPG 规则取自设置。</p></div><ImportCard config={importConfig} drives={drives} destinationPath={project.path} brollDestinationPath={project.path} active={active && panel === 'import'} deleteSourceAfterImport={importDefaults.deleteSourceAfterImport} generateJpgFromRaw={importDefaults.generateJpgFromRaw} splitLargeBrollFiles={brollConfig.splitLargeFiles} onBusyChange={setSdImportBusy} onImportConfigChange={onImportConfigChange} onImportComplete={markInProgress} completedActionLabel="关闭" onCompletedAction={() => setPanel(null)}/></div></ToolModal>}
      {mountedPanels.has('negative-import') && <ToolModal title={PROJECT_PANEL_TITLES['negative-import']} scopeKey={project.path} panelKind="negative-import" open={panel === 'negative-import'} busy={negativeImportBusy} onClose={() => { setNegativeSourcePaths([]); setNegativeImportCompleted(false); setPanel(null); }}>
        <div className="space-y-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{project.name}”</p><p className="mt-1 text-xs leading-5 text-blue-600">可直接读取文件或文件夹。</p></div>
          {!negativeImportBusy && !negativeImportCompleted && <div className="flex flex-wrap items-center gap-2"><button className="dialog-primary inline-flex items-center gap-2" onClick={() => void window.electronAPI.chooseImportSourceFiles().then(result => { if (!result.cancelled && result.paths.length) setNegativeSourcePaths(result.paths); })}><FileInput size={15}/>选择文件</button><button className="dialog-secondary inline-flex items-center gap-2" onClick={() => void window.electronAPI.chooseWorkspaceDirectory('').then(result => { if (!result.cancelled && result.path) setNegativeSourcePaths([result.path]); })}><FolderInput size={15}/>选择文件夹</button>{negativeSourcePaths.length > 0 && <button className="ml-auto text-sm font-bold text-blue-600" onClick={() => setNegativeSourcePaths([])}>重新选择</button>}</div>}
          {!negativeSourcePaths.length ? <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center"><Aperture size={36} className="mx-auto text-blue-500"/><p className="mt-3 text-sm text-slate-600">选择一个或多个底片文件，或选择底片文件夹。</p></div> : <>{!negativeImportBusy && !negativeImportCompleted && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700"><p className="font-bold">已选择 {negativeSourcePaths.length} 个来源</p></div>}<ImportCard directSource config={{ ...importConfig, sdPath: negativeSourcePaths[0], sdPaths: negativeSourcePaths }} drives={negativeSourcePaths} destinationPath={project.path} brollDestinationPath={project.path} active={active && panel === 'negative-import'} deleteSourceAfterImport={importDefaults.deleteSourceAfterImport} generateJpgFromRaw={importDefaults.generateJpgFromRaw} onBusyChange={setNegativeImportBusy} onImportConfigChange={onImportConfigChange} onImportComplete={() => { setNegativeImportCompleted(true); void markInProgress(); }} completedActionLabel="关闭" onCompletedAction={() => { setNegativeSourcePaths([]); setNegativeImportCompleted(false); setPanel(null); }}/></>}
        </div>
      </ToolModal>}
      {mountedPanels.has('broll') && <ToolModal title={PROJECT_PANEL_TITLES.broll} scopeKey={project.path} panelKind="broll" open={panel === 'broll'} busy={panelImportBusy === 'broll'} onClose={() => { setPanelImportResult(null); setPanel(null); }}>{panelImportResult?.kind === 'broll' ? <ImportCompletion message={`已导入 ${panelImportResult.count} 个花絮文件，源文件${panelImportResult.sourceDeleted ? '已删除' : '已保留'}。`} onClose={() => { setPanelImportResult(null); setPanel(null); }}/> : <div className="space-y-4"><div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{project.name}/花絮”</p><p className="mt-1 text-xs leading-5 text-blue-600">支持图片与视频；大于 4GB 的视频是否分割由设置决定。</p></div><label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"><input type="checkbox" checked={deleteBrollSources} disabled={Boolean(panelImportBusy)} onChange={event => setDeleteBrollSources(event.target.checked)} className="mt-0.5"/><span><span className="block text-sm font-bold text-slate-700">导入后删除源文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">初始值来自设置。只有花絮成功导入后才会删除源文件；取消勾选则复制并保留来源。</span></span></label><div className="flex justify-end border-t border-slate-200 pt-4"><button onClick={importBroll} disabled={Boolean(panelImportBusy)} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-50">{panelImportBusy === 'broll' && <Loader2 size={15} className="animate-spin"/>}{panelImportBusy === 'broll' ? '正在选择或导入…' : '选择花絮文件并导入'}</button></div></div>}</ToolModal>}
      {mountedPanels.has('file-import') && <ToolModal title={PROJECT_PANEL_TITLES['file-import']} scopeKey={project.path} panelKind="file-import" open={panel === 'file-import'} busy={panelImportBusy === 'files'} onClose={() => { setPanelImportResult(null); setPanel(null); }}>{panelImportResult?.kind === 'files' ? <ImportCompletion message={`已导入 ${panelImportResult.count} 个文件，源文件${panelImportResult.sourceDeleted ? '已删除' : '已保留'}。`} onClose={() => { setPanelImportResult(null); setPanel(null); }}/> : <div className="space-y-4"><div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3"><p className="text-sm font-bold text-blue-800">导入到“{fileImportTarget || project.name}”</p><p className="mt-1 text-xs leading-5 text-blue-600">选择任意文件导入当前目录；重名文件会自动生成不冲突的名称，不覆盖现有文件。</p></div><label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"><input type="checkbox" checked={deleteFileSources} disabled={Boolean(panelImportBusy)} onChange={event => setDeleteFileSources(event.target.checked)} className="mt-0.5"/><span><span className="block text-sm font-bold text-slate-700">导入后删除源文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">初始值来自设置。成功导入后移动来源；取消勾选则复制并保留来源。</span></span></label><div className="flex justify-end border-t border-slate-200 pt-4"><button onClick={() => void importFiles()} disabled={Boolean(panelImportBusy)} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-50">{panelImportBusy === 'files' && <Loader2 size={15} className="animate-spin"/>}{panelImportBusy === 'files' ? '正在选择或导入…' : '选择文件并导入'}</button></div></div>}</ToolModal>}
      {mountedPanels.has('match') && <ToolModal title={PROJECT_PANEL_TITLES.match} scopeKey={project.path} panelKind="match" open={panel === 'match'} onClose={() => setPanel(null)}><MatchView embedded config={matchConfig} projectPath={project.path} folderOptions={folders} onUpdateConfig={onMatchConfigChange}/></ToolModal>}
      {mountedPanels.has('research') && <ToolModal title={PROJECT_PANEL_TITLES.research} scopeKey={project.path} panelKind="research" open={panel === 'research'} onClose={() => setPanel(null)}><ResearchView embedded initialTargetPath={researchTargetPath} targetKind={researchTargetKind} hasTxtFiles={researchTargetHasTxt} config={researchConfig} onUpdateConfig={onResearchConfigChange}/></ToolModal>}
      {mountedPanels.has('video-transcode') && <ToolModal title={PROJECT_PANEL_TITLES['video-transcode']} scopeKey={project.path} panelKind="video-transcode" open={panel === 'video-transcode'} onClose={() => { videoTranscodeInspectionSequenceRef.current += 1; setVideoTranscodeCollecting(false); setPanel(null); }}><VideoTranscodeView embedded initialTargetPaths={videoTranscodeTargets} initialSourceFolders={videoTranscodeSourceFolders} sourcesLoading={videoTranscodeCollecting}/></ToolModal>}
      {mountedPanels.has('cache') && <ToolModal title={PROJECT_PANEL_TITLES.cache} scopeKey={project.path} panelKind="cache" open={panel === 'cache'} onClose={() => setPanel(null)}><MediaCacheSettings config={mediaCacheConfig} onChange={onMediaCacheConfigChange}/></ToolModal>}
      {mountedPanels.has('trash') && <ToolModal title={PROJECT_PANEL_TITLES.trash} scopeKey={project.path} panelKind="trash" open={panel === 'trash'} onClose={() => setPanel(null)}><p className="text-sm text-slate-500">项目“{project.name}”及其全部内容将移入系统回收站。</p><button onClick={moveToTrash} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">确认移入回收站</button></ToolModal>}
      {gatherPickerPaths && createPortal(<div role="dialog" aria-modal="true" aria-label="选择灵感汇聚项目" className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">选择目标项目</h3><p className="mt-1 text-sm text-slate-500">所选灵感将会出现在目录项目下的“策划”文件夹。</p></div><button type="button" disabled={gatheringInspiration} onClick={() => setGatherPickerPaths(null)} title="关闭" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"><X size={17}/></button></div><div className="mt-4 max-h-80 space-y-1 overflow-y-auto">{inspirationProjects.map(targetProject => <button key={targetProject.path} type="button" disabled={gatheringInspiration} onClick={() => void gatherInspiration(targetProject, gatherPickerPaths)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm hover:bg-blue-50 ${targetProject.path === inspirationTargetProject?.path ? 'bg-blue-50 font-bold text-blue-700' : 'text-slate-700'}`}><Folder size={17} className="shrink-0 text-blue-500"/><span className="min-w-0 flex-1 truncate">{targetProject.name}</span><span className="shrink-0 text-xs text-slate-400">{targetProject.status}</span></button>)}{!inspirationProjects.length && <p className="rounded-lg bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">当前工作目录中没有可用项目。</p>}</div></section></div>, document.body)}
      {progressTask && createPortal(<div role="status" aria-live="polite" className="fixed left-1/2 top-14 z-[390] flex w-[min(92vw,520px)] -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-2xl"><Loader2 size={18} className="shrink-0 animate-spin text-blue-300"/><span>{progressTask}</span></div>, document.body)}
      {progressSetup && <div role="dialog" aria-modal="true" aria-label={`${progressSetupAppendTarget ? '追加' : progressSetup.mode === 'create' ? '新建' : progressSetup.mode === 'import' ? '导入' : progressSetup.existingProgressId ? '修改' : '标记'}版本进度`} className="fixed inset-0 z-[340] flex items-center justify-center bg-slate-950/45 p-4" onMouseDown={event => { if (event.target === event.currentTarget) void closeOrCancelProgressSetupFromBackdrop(); }}><div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4"><div><h3 className="text-lg font-bold text-slate-800">{progressSetupAppendTarget ? '追加' : progressSetup.mode === 'create' ? '新建' : progressSetup.mode === 'import' ? '导入' : progressSetup.existingProgressId ? '修改' : '标记'}{progressSetup.mediaKind === 'image' ? '图片' : '视频'}进度</h3><p className="mt-1 text-xs text-slate-500">{progressSetupAppendTarget ? '新文件会加入已有进度，现有文件和版本关系保持不变。' : '描述这个进度的版本和名称，系统会生成统一的进度名称。'}</p></div><button type="button" onClick={closeProgressSetup} disabled={progressSubmitting} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X size={18}/></button></header>
        {progressImportCompletion ? <div className="min-h-0 flex-1 overflow-y-auto p-5"><ImportCompletion message={progressImportCompletion} onClose={closeProgressSetup}/></div> : <><div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section><h4 className="mb-2 text-sm font-bold text-slate-700">进度类型</h4><div className="grid grid-cols-2 gap-3"><button type="button" disabled={Boolean(progressSetup.existingProgressId)} onClick={() => changeProgressMediaKind('image')} className={`rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 ${progressSetup.mediaKind === 'image' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}><span className="text-sm font-bold text-slate-700">图片进度</span><span className="mt-1 block text-xs text-slate-500">图片后期版本</span></button><button type="button" disabled={Boolean(progressSetup.existingProgressId)} onClick={() => changeProgressMediaKind('video')} className={`rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 ${progressSetup.mediaKind === 'video' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}><span className="text-sm font-bold text-slate-700">视频进度</span><span className="mt-1 block text-xs text-slate-500">视频后期版本</span></button></div>{progressSetup.mode === 'mark' && <p className="mt-2 text-xs text-slate-500">当前文件夹：{progressSetup.targetRelativePath}{progressSetup.existingProgressId ? '（修改版本号时会同步映射后代进度）' : ''}</p>}</section>
          {progressSetupAppendTarget ? <section className="rounded-xl border border-blue-100 bg-blue-50 p-4"><span className="block text-xs font-bold text-blue-500">正在追加到已有版本</span><span className="mt-1 block break-all font-mono text-sm font-bold text-blue-800">V{progressSetupAppendTarget.versionKey} · {progressSetupAppendTarget.displayName}</span><span className="mt-2 block text-xs leading-5 text-blue-600">沿用现有版本关系和项目跟踪设置，不创建新文件夹。同内容的重名文件会跳过；内容不同的重名文件会让你选择，绝不覆盖现有文件。</span></section> : <>
            <section><h4 className="mb-2 text-sm font-bold text-slate-700">版本关系</h4><div className="grid grid-cols-2 gap-3"><label className={`cursor-pointer rounded-xl border p-3 ${progressSetup.relation === 'root' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}><input type="radio" className="mr-2" checked={progressSetup.relation === 'root'} onChange={() => changeProgressRelation('root')}/><span className="text-sm font-bold text-slate-700">主版本</span><p className="mt-1 pl-5 text-xs text-slate-500">例如 _1、_2、_3</p></label><label className={`rounded-xl border p-3 ${progressParentOptions(progressSetup).length ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'} ${progressSetup.relation === 'branch' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}><input type="radio" className="mr-2" checked={progressSetup.relation === 'branch'} disabled={!progressParentOptions(progressSetup).length} onChange={() => changeProgressRelation('branch')}/><span className="text-sm font-bold text-slate-700">某版本的分支</span><p className="mt-1 pl-5 text-xs text-slate-500">例如 _1_1、_1_2</p></label></div></section>
            {progressSetup.relation === 'branch' && <label className="block"><span className="mb-1.5 block text-sm font-bold text-slate-700">从哪个版本分支</span><select value={progressSetup.parentProgressId} onChange={event => changeProgressRelation('branch', event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-700">{progressParentOptions(progressSetup).sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)).map(folder => <option key={folder.id} value={folder.id}>V{folder.versionKey} · {folder.displayName}</option>)}</select></label>}
          </>}
          <label className="block"><span className="mb-1.5 block text-sm font-bold text-slate-700">版本编号</span><div className="flex items-center gap-2"><span className="text-lg font-bold text-slate-400">V</span><input value={progressSetup.versionKey} onChange={event => setProgressSetup(current => current ? { ...current, versionKey: event.target.value.replace(/[^\d_]/g, '') } : current)} className={`w-full rounded-lg border px-3 py-2.5 font-mono text-sm outline-none ${progressVersionIsValid(progressSetup) ? 'border-slate-300 focus:border-blue-500' : 'border-red-300 focus:border-red-500'}`} placeholder={progressSetup.relation === 'root' ? '例如 2' : '例如 1_2'}/></div><span className={`mt-1.5 block text-xs ${progressVersionIsValid(progressSetup) ? 'text-slate-400' : 'text-red-500'}`}>{progressSetupAppendTarget ? `V${progressSetup.versionKey} 已存在，本次会追加文件。` : progressVersionIsValid(progressSetup) ? '已根据版本关系给出建议值，你可以改成实际版本。' : progressSetup.relation === 'root' ? '主版本只能填写未使用的数字，例如 1、2、3。' : '分支编号必须属于所选父版本且未被使用，例如 1_2。'}</span></label>
          {!progressSetupAppendTarget && <label className="block"><span className="mb-1.5 block text-sm font-bold text-slate-700">进度名字 <span className="font-normal text-slate-400">（可留空）</span></span><input autoFocus value={progressSetup.progressName} onChange={event => setProgressSetup(current => current ? { ...current, progressName: event.target.value } : current)} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500" placeholder="例如：调色"/><span className="mt-1.5 block text-xs text-slate-400">留空时只使用进度类型和版本编号，例如“图片后期_1”。</span></label>}
          {!progressSetupAppendTarget && <section className={`rounded-xl border p-4 ${progressNameHasConflict(progressSetup) ? 'border-red-200 bg-red-50' : 'border-blue-100 bg-blue-50'}`}><span className={`block text-xs font-bold ${progressNameHasConflict(progressSetup) ? 'text-red-500' : 'text-blue-500'}`}>{progressSetupReplacementTarget ? '将接管已失效的进度' : progressSetup.existingProgressId ? '进度文件夹将更新为' : progressSetup.mode === 'mark' ? '文件夹将重命名为' : '文件夹将创建为'}</span><span className={`mt-1 block break-all font-mono text-sm font-bold ${progressNameHasConflict(progressSetup) ? 'text-red-700' : 'text-blue-800'}`}>{progressSetup.versionKey ? buildProgressFolderName(progressSetup.mediaKind, progressSetup.versionKey, progressSetup.progressName) : '填写版本编号后生成'}</span>{progressSetupReplacementTarget ? <span className="mt-2 block text-xs leading-5 text-blue-600">“{progressSetupReplacementTarget.displayName}”的原文件夹已失效。保存后，当前文件夹会接管该数据库记录；当前版本原来的记录会保留为失效状态，后代版本同步重新映射。</span> : progressSetup.existingProgressId && <span className="mt-2 block text-xs text-blue-600">版本号变化时，所有后代版本及其文件夹名称会同步重新映射。</span>}{progressNameHasConflict(progressSetup) && <span className="mt-2 block text-xs text-red-600">已有同名进度，请修改版本编号或进度名字。</span>}</section>}
          <section className="space-y-3 rounded-xl border border-slate-200 p-4">
            {progressSetup.mode === 'import' && <label className="flex cursor-pointer items-start gap-3 border-b border-slate-200 pb-3">
              <input type="checkbox" className="mt-0.5" checked={progressSetup.deleteSourceAfterImport} onChange={event => setProgressSetup(current => current ? { ...current, deleteSourceAfterImport: event.target.checked } : current)}/>
              <span><span className="block text-sm font-bold text-slate-700">导入后删除源文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">初始值来自设置。只有所选进度文件全部导入成功后才会删除来源；取消勾选则复制并保留原文件。</span></span>
            </label>}
            {progressSetupAppendTarget ? <div className="text-xs leading-5 text-slate-500">项目跟踪设置沿用已有进度：<span className="font-bold text-slate-700">{progressSetupAppendTarget.trackingState === 'disabled' ? '未开启' : progressSetupAppendTarget.trackingState === 'ready' ? '已开启' : '等待完成'}</span>。追加后会继续完成当前版本关系。</div> : <>
            <label className={`flex items-start gap-3 ${progressSetup.mode === 'create' ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'}`}>
              <input type="checkbox" className="mt-0.5" disabled={progressSetup.mode === 'create'} checked={progressSetup.trackingEnabled} onChange={event => setProgressSetup(current => current ? { ...current, trackingEnabled: event.target.checked, renameSources: event.target.checked ? current.renameSources : false, copyMissingFromParent: event.target.checked ? current.copyMissingFromParent : false } : current)}/>
              <span><span className="block text-sm font-bold text-slate-700">开启项目跟踪</span><span className="mt-1 block text-xs leading-5 text-slate-500">{progressSetup.mode === 'create' ? '当前只是创建空进度文件夹；导入或标记包含媒体的文件夹时可以开启跟踪。' : progressSetup.existingProgressId ? '控制这个进度是否参与版本管理；更改后会随进度设置一起保存。' : '导入后自动按文件名优先匹配上一个版本，未确定的素材再进行视觉比对，并让你确认继承关系；关闭时只导入文件。'}</span></span>
            </label>
            <label className={`flex items-start gap-3 ${progressSetup.mode !== 'create' && progressSetup.trackingEnabled && progressParentIsAvailable(progressSetup) ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'}`}>
              <input type="checkbox" className="mt-0.5" disabled={progressSetup.mode === 'create' || !progressSetup.trackingEnabled || !progressParentIsAvailable(progressSetup)} checked={progressSetup.renameSources && progressParentIsAvailable(progressSetup)} onChange={event => setProgressSetup(current => current ? { ...current, renameSources: event.target.checked } : current)}/>
              <span><span className="block text-sm font-bold text-slate-700">确定版本关系后，同步重命名新版本的文件名</span><span className="mt-1 block text-xs leading-5 text-slate-500">{progressSetup.existingProgressId ? '保存后会重新比对上一版本，只重命名本次确认继承的文件；不会改动新素材。' : progressSetup.mode === 'create' ? '创建空文件夹时没有媒体文件可重命名。' : progressParentIsAvailable(progressSetup) ? '只重命名确认继承的文件；文件扩展名不变，新素材保留原名。' : '当前没有可用的上一个版本，因此无法选择。'}</span></span>
            </label>
            <label className={`flex items-start gap-3 ${progressSetup.mode !== 'create' && progressSetup.trackingEnabled && progressParentIsAvailable(progressSetup) ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'}`}>
              <input type="checkbox" className="mt-0.5" disabled={progressSetup.mode === 'create' || !progressSetup.trackingEnabled || !progressParentIsAvailable(progressSetup)} checked={progressSetup.copyMissingFromParent && progressParentIsAvailable(progressSetup)} onChange={event => setProgressSetup(current => current ? { ...current, copyMissingFromParent: event.target.checked } : current)}/>
              <span><span className="block text-sm font-bold text-slate-700">复制当前版本中没有、但上一版本中存在的媒体文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">{progressSetup.mode === 'create' ? '创建空文件夹时没有上一版本媒体可补齐。' : progressParentIsAvailable(progressSetup) ? progressSetup.existingProgressId ? `保存后会重新比对 V${progressComparisonParent(progressSetup)?.versionKey}，只补齐确认缺失的媒体；不会覆盖同名文件。` : `确认版本关系后，从 V${progressComparisonParent(progressSetup)?.versionKey} 复制缺失媒体；不会覆盖同名文件。` : '当前没有可用的上一个版本，因此无法选择。'}</span></span>
            </label>
            </>}
          </section>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4"><button type="button" onClick={closeProgressSetup} disabled={progressSubmitting} className="dialog-secondary">取消</button><button type="button" onClick={() => void submitProgressSetup()} disabled={progressSubmitting || !progressVersionIsValid(progressSetup) || progressNameHasConflict(progressSetup)} className="dialog-primary inline-flex items-center gap-2">{progressSubmitting && <Loader2 size={15} className="animate-spin"/>}{progressSetupAppendTarget ? '选择文件并追加' : progressSetup.mode === 'create' ? '创建文件夹' : progressSetup.mode === 'import' ? '选择文件并导入' : progressSetup.existingProgressId ? '保存进度修改' : '标记当前文件夹'}</button></footer></>}
      </div></div>}
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
      {versionEntry && <div className={activeView === 'version' ? 'contents' : 'hidden'}><VersionManager entry={versionEntry} workspacePath={workspacePath} project={project} cacheConfig={mediaCacheConfig} progressVersionKey={progressFolderForMediaEntry(versionEntry)?.versionKey} onNotice={onNotice} onVersionStateChanged={() => { void loadFinalVersionSummary(); if (finalViewOpen) void loadFinalViewEntries(); }} onClose={() => { onCloseToolTab('version'); void loadFinalVersionSummary(); if (finalViewOpen) void loadFinalViewEntries(); }}/></div>}
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
        onProjectChanged={() => void loadTeamRetouchHistory()}
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
        onProjectChanged={() => void loadTeamRetouchHistory()}
        onBusyChange={busy => onToolTabBusyChange('team', busy)}
        onClose={() => { onCloseToolTab('team'); void loadTeamRetouchHistory(); }}
      /></div>}

      <section className="flex min-h-[220px] min-w-0 flex-auto flex-col">
        {versionTreeOpen ? <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={event => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-entry-path]'); target?.focus({ preventScroll: true }); if (target?.dataset.entryPath) entryPointerModifiersRef.current = { path: target.dataset.entryPath, additive: event.ctrlKey || event.metaKey, range: event.shiftKey }; }} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} className={`relative -mx-6 min-h-[220px] flex-1 select-none px-6 outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {selectionBox && <div className="pointer-events-none absolute z-20 border border-blue-500 bg-blue-400/15" style={selectionBox}/>}
          <ProjectVersionTree
            progressFolders={progressFolders}
            entries={displayedFileEntries}
            activeRelativePath={currentRelativePath}
            gridIconSize={gridIconSize}
            projectRelativePath={projectRelativePath}
            renderEntry={renderVersionTreeEntry}
            teamRetouchParentProgressIds={teamRetouchParentProgressIds}
            onOpenMissingProgressMenu={openMissingProgressMenu}
          />
        </div> : <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={event => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-entry-path]'); target?.focus({ preventScroll: true }); if (target?.dataset.entryPath) entryPointerModifiersRef.current = { path: target.dataset.entryPath, additive: event.ctrlKey || event.metaKey, range: event.shiftKey }; }} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} className={`relative -mx-6 min-h-[220px] flex-1 select-none px-6 outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {selectionBox && <div className="pointer-events-none absolute z-20 border border-blue-500 bg-blue-400/15" style={selectionBox}/>}
          {groupedResultsActive && (searchLoading ? <p className="py-12 text-center text-sm text-slate-400"><Loader2 size={17} className="mr-2 inline animate-spin"/>{searchQuery.trim() ? `正在搜索${currentRelativePath ? '当前文件夹及其子文件夹' : '整个项目'}…` : '正在读取最近文件…'}</p> : searchError ? <p className="py-8 text-center text-sm text-red-600">{searchQuery.trim() ? '搜索' : '读取最近文件'}失败：{searchError}</p> : searchResultGroups.length ? <div className="pb-4">
            <p className="px-1 text-xs text-slate-500">{searchQuery.trim() ? `在${currentRelativePath ? `“${currentRelativePath}”及其子文件夹` : '整个项目'}中找到 ${displayedFileEntries.length} 个文件` : `已加载${currentRelativePath ? `“${currentRelativePath}”及其子文件夹` : '整个项目'}最近修改的 ${displayedFileEntries.length} 个文件`}</p>
            {searchResultGroups.map(([folderPath, entries], groupIndex) => { const viaShortcut = entries.some(entry => entry.viaShortcut); const folderLabel = viaShortcut ? folderPath.replace(/\.lnk(?=\/|$)/gi, '') : folderPath; const targetLabel = folderLabel || project.name; const normalizedFolderPath = normalizeProjectRelativePath(folderPath); return <section key={folderPath || '__root__'} data-recursive-folder-path={normalizedFolderPath} data-recursive-folder-label={targetLabel} data-recursive-folder-readonly={viaShortcut ? 'true' : 'false'} onContextMenu={event => { if (viaShortcut) { event.preventDefault(); event.stopPropagation(); onNotice('快捷方式指向的外部文件夹是只读浏览区域'); } else openSurfaceMenu(event, normalizedFolderPath, targetLabel); }} onDragOver={event => handleRecursiveFolderDragOver(event, normalizedFolderPath, viaShortcut)} onDragLeave={event => handleRecursiveFolderDragLeave(event, normalizedFolderPath)} onDrop={event => void handleRecursiveFolderDrop(event, normalizedFolderPath, targetLabel, viaShortcut)} className={`${groupIndex ? 'mt-5 border-t border-slate-200 pt-4' : 'pt-3'} rounded-lg transition ${recursiveDropTargetPath === normalizedFolderPath ? 'bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}><header className="mb-2 flex min-w-0 items-center gap-2 px-1"><Folder size={16} className="shrink-0 text-blue-500"/>{viaShortcut ? <span title={`${folderLabel}（快捷方式）`} className="min-w-0 truncate text-sm font-bold text-slate-700">{folderLabel || '快捷方式'} <span className="font-normal text-slate-400">（快捷方式）</span></span> : <button type="button" onClick={() => { setSearchQuery(''); navigateToDirectory(folderPath); }} title={`打开 ${folderPath || project.name}`} className="min-w-0 truncate text-sm font-bold text-slate-700 hover:text-blue-600">{folderPath || '项目根目录'}</button>}<span className="shrink-0 text-xs text-slate-400">{entries.length} 个</span></header><div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{entries.map(entry => <div key={`${entry.relativePath}|${entry.path}`} role="button" tabIndex={0} draggable={!entry.viaShortcut} onDragStart={event => startEntryDrag(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.relativePath} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50 ring-1 ring-blue-400' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''}`}><span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span><div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div><p className="mt-2 truncate text-xs font-medium text-slate-700">{getEntryDisplayName(entry)}</p><p className="mt-0.5 text-[10px] uppercase text-slate-400">{entry.kind === 'shortcut' ? '快捷方式' : entry.kind === 'raw' ? `RAW · ${entry.extension.slice(1)}` : entry.kind === 'video' ? `视频 · ${entry.extension.slice(1)}` : entry.extension.slice(1) || '文件'}</p></div>)}</div></section>; })}
            {!searchQuery.trim() && <p className={`py-6 text-center text-xs ${recentLoadError ? 'text-red-500' : 'text-slate-400'}`}>{recentLoadError ? `继续加载失败：${recentLoadError}` : recentLoadingMore ? <><Loader2 size={14} className="mr-1.5 inline animate-spin"/>正在继续加载…</> : recentHasMore ? '继续向下滚动以加载更多文件' : '已显示当前范围内的全部文件'}</p>}
          </div> : <p className="py-12 text-center text-sm text-slate-400">{searchQuery.trim() ? `没有在${currentRelativePath ? '当前文件夹及其子文件夹' : '整个项目'}中找到包含“${searchQuery}”且符合筛选条件的文件。` : `当前范围内没有可显示的最近${filteredFileTypeLabel}。`}</p>)}
          {!groupedResultsActive && searchQuery.trim() && searchLoading && <p className="py-12 text-center text-sm text-slate-400"><Loader2 size={17} className="mr-2 inline animate-spin"/>正在搜索{currentRelativePath ? '当前文件夹及其子文件夹' : '整个项目'}…</p>}
          {!groupedResultsActive && searchQuery.trim() && searchError && <p className="py-8 text-center text-sm text-red-600">搜索失败：{searchError}</p>}
          <div className={groupedResultsActive || Boolean(searchQuery.trim() && (searchLoading || searchError)) ? 'hidden' : undefined}>
          {directoryLoading ? <div role="status" aria-live="polite" className="flex min-h-[220px] items-center justify-center border-y border-slate-200 text-sm text-slate-500"><Loader2 size={18} className="mr-2 animate-spin"/>加载中…</div> : displayedFileEntries.length ? viewMode === 'list' ? <div className="min-w-[620px] border-y border-slate-200 text-sm">
            <div className="file-list-row file-list-heading text-xs font-medium text-slate-500"><span>名称</span><span>修改日期</span><span>类型</span><span>大小</span></div>
            {virtualWindow.top > 0 && <div aria-hidden style={{ height: virtualWindow.top }} />}
            {renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`file-list-row group w-full cursor-default border-t border-slate-200 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-inset ring-blue-500' : ''}`}>
              <span className="flex min-w-0 items-center gap-2.5"><span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-select-box ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-transparent'} flex h-4 w-4 shrink-0 items-center justify-center rounded border`}><CheckSquare size={12}/></span><span className="relative flex h-9 w-11 shrink-0 items-center justify-center overflow-hidden">{renderEntryIcon(entry)}</span>{renderEntryName(entry)}</span>
              <span className="text-slate-500">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '…'}</span>
              <span className="uppercase text-slate-500">{entry.kind === 'folder' ? '文件夹' : entry.kind === 'shortcut' ? '快捷方式' : entry.kind === 'raw' ? `RAW · ${entry.extension.slice(1)}` : entry.kind === 'video' ? `视频 · ${entry.extension.slice(1)}` : entry.extension.slice(1) || '文件'}</span>
              <span className="text-slate-500">{entry.kind === 'folder' ? '' : entry.size >= 0 ? formatFileSize(entry.size) : '…'}</span>
            </div>)}
            {virtualWindow.bottom > 0 && <div aria-hidden style={{ height: virtualWindow.bottom }} />}
          </div> : <><div aria-hidden style={{ height: virtualWindow.top }}/><div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50 ring-1 ring-blue-400' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-blue-500' : ''}`}><span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span><div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div>{renderEntryName(entry, true)}<p className="mt-0.5 text-[10px] uppercase text-slate-400">{entry.kind === 'folder' ? '文件夹' : entry.kind === 'shortcut' ? '快捷方式' : entry.extension.slice(1) || '文件'}</p></div>)}</div><div aria-hidden style={{ height: virtualWindow.bottom }}/></> : <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">{searchQuery ? `没有找到包含“${searchQuery}”且符合筛选条件的文件。` : `当前文件夹没有${filteredFileTypeLabel}。`}</p>}
          </div>
        </div>}
      </section>

      <section className="hidden rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-slate-800">项目文件夹</h3><span className="text-sm text-slate-500">{folders.length} 个</span></div>
        {folders.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{folders.map(folder => <button key={folder.path} onClick={() => openFolder(folder.name)} title={`打开 ${folder.name}`} className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-blue-50"><Folder size={64} strokeWidth={1.5} fill="currentColor" className="text-blue-500 drop-shadow-sm transition-transform group-hover:scale-105"/><span className="max-w-full truncate text-sm font-medium text-slate-700">{folder.name}</span></button>)}</div> : <p className="py-8 text-center text-sm text-slate-400">当前项目还没有子文件夹。</p>}
      </section>

      </div>
      {previewPaneOpen && <><ColumnResizeHandle label="调整文件区和预览区宽度" onDrag={resizeFilesAndPreview}/><MediaPreviewPane entry={previewEntry} cacheConfig={mediaCacheConfig} width={displayedColumnWidths.preview} advancedVideoAvailable={active && installedComponentIds.has('video-playback-mpv')} keyboardSettings={advancedVideoSettings} photoshopAvailable={photoshopAvailable && !previewEntry?.viaShortcut} finalVersionAvailable={previewCanMarkFinal} finalVersion={previewVersion} finalVersionLoading={previewVersionLoading} finalVersionBusy={previewVersionBusy} onToggleFinal={() => void togglePreviewFinalVersion()} onTechnicalMetadata={setPreviewTechnicalMetadata} onNavigate={navigatePreviewMedia} onContextMenu={event => previewEntry && openFileMenu(event, previewEntry, false)} onContextMenuAt={(x, y) => previewEntry && openFileMenuAt(x, y, previewEntry, false)} onAnalyzeImageCrop={analyzePreviewImageCrop} onConfirmImageCrop={savePreviewImageCrop} onTrimVideo={trimPreviewVideo} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onOpenInPhotoshop={() => previewEntry && openProjectEntriesInPhotoshop([previewEntry])} onClose={() => setPreviewPaneOpen(false)}/></>}
      {metadataPaneOpen && <><ColumnResizeHandle label={previewPaneOpen ? '调整预览区和详细信息区宽度' : '调整文件区和详细信息区宽度'} onDrag={previewPaneOpen ? resizePreviewAndMetadata : resizeFilesAndMetadata}/><FileMetadataPane entry={previewEntry} entryDetails={previewEntryDetails} metadataFields={currentPreviewMetadataFields} metadataLoading={currentPreviewMetadataLoading} metadataError={currentPreviewMetadataError} technicalMetadata={previewTechnicalMetadata} formatFileSize={formatFileSize} width={displayedColumnWidths.metadata} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onCopyPath={() => previewEntry && copyEntryPath(previewEntry)} onClose={closeMetadataPaneByUser}/></>}
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

const VideoTrimTimeline = ({ duration, start, end, currentTime, frames, busyMode, onChange, onPreview, onCancel, onSave }: {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  frames: string[];
  busyMode: 'new' | 'replace' | '';
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
      {currentTime >= start && currentTime <= end && (
        <div className="pointer-events-none absolute inset-y-1 z-20 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_5px_rgba(0,0,0,.9)]" style={{ left: `${playheadPercent}%` }}/>
      )}
      <button type="button" aria-label={`调整开始时间，当前 ${formatMediaDuration(start)}`} disabled={Boolean(busyMode)} onPointerDown={event => beginDrag(event, 'start')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} className="absolute inset-y-0 z-30 w-5 -translate-x-1/2 cursor-ew-resize rounded-l-md border-y-[3px] border-l-[3px] border-amber-400 bg-amber-400/20 outline-none disabled:cursor-default" style={{ left: `${startPercent}%`, touchAction: 'none' }}><span className="absolute left-1/2 top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-amber-100"/></button>
      <button type="button" aria-label={`调整结束时间，当前 ${formatMediaDuration(end)}`} disabled={Boolean(busyMode)} onPointerDown={event => beginDrag(event, 'end')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} className="absolute inset-y-0 z-30 w-5 -translate-x-1/2 cursor-ew-resize rounded-r-md border-y-[3px] border-r-[3px] border-amber-400 bg-amber-400/20 outline-none disabled:cursor-default" style={{ left: `${endPercent}%`, touchAction: 'none' }}><span className="absolute left-1/2 top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-amber-100"/></button>
    </div>
    <div className="mt-2.5 flex items-center justify-between gap-2">
      <p className="min-w-0 truncate text-[10px] text-slate-500">保持原视频编码、音轨和画质；实际切点受关键帧位置限制。</p>
      <div className="flex shrink-0 items-center gap-2"><button type="button" disabled={Boolean(busyMode)} onClick={onCancel} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-300 hover:bg-white/10 disabled:opacity-40">取消</button><button type="button" disabled={Boolean(busyMode) || selectedDuration < .05} onClick={() => onSave('new')} className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-white/20 disabled:opacity-40">{busyMode === 'new' && <Loader2 size={13} className="animate-spin"/>}{busyMode === 'new' ? '正在另存…' : '另存为新视频'}</button><button type="button" disabled={Boolean(busyMode) || selectedDuration < .05} onClick={() => onSave('replace')} className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 disabled:opacity-40">{busyMode === 'replace' && <Loader2 size={13} className="animate-spin"/>}{busyMode === 'replace' ? '正在替换…' : '替换原视频'}</button></div>
    </div>
  </div>;
};

const MediaPreviewPane = ({ entry, cacheConfig, width, advancedVideoAvailable, keyboardSettings, photoshopAvailable, finalVersionAvailable, finalVersion, finalVersionLoading, finalVersionBusy, onToggleFinal, onTechnicalMetadata, onNavigate, onContextMenu, onContextMenuAt, onAnalyzeImageCrop, onConfirmImageCrop, onTrimVideo, onOpen, onOpenInPhotoshop, onClose }: {
  entry?: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  width: number;
  advancedVideoAvailable: boolean;
  keyboardSettings: NonNullable<AppConfig['componentSettings']['video-playback-mpv']>;
  photoshopAvailable: boolean;
  finalVersionAvailable: boolean;
  finalVersion: MediaVersion | null;
  finalVersionLoading: boolean;
  finalVersionBusy: boolean;
  onToggleFinal: () => void;
  onTechnicalMetadata: (metadata: PreviewTechnicalMetadata) => void;
  onNavigate: (direction: -1 | 1) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onContextMenuAt: (x: number, y: number) => void;
  onAnalyzeImageCrop: (entry: ProjectFileEntry) => Promise<PreviewImageCropAnalysis>;
  onConfirmImageCrop: (entry: ProjectFileEntry, crop: CropRectangle) => Promise<{ success: boolean; error?: string }>;
  onTrimVideo: (start: number, end: number, saveMode: 'new' | 'replace') => Promise<{ success: boolean; error?: string }>;
  onOpen: () => void;
  onOpenInPhotoshop: () => void;
  onClose: () => void;
}) => {
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
  const [imageCropEditor, setImageCropEditor] = useState<{ crop: CropRectangle; snapGuides: { x: number[]; y: number[] }; originalSize: { width: number; height: number } } | null>(null);
  const [imageCropPhase, setImageCropPhase] = useState<'analyzing' | 'editing' | 'saving' | ''>('');
  const [imageCropError, setImageCropError] = useState('');
  const trimBusy = Boolean(trimBusyMode);
  const imageSurfaceRef = useRef<HTMLDivElement>(null);
  const fallbackVideoRef = useRef<HTMLVideoElement>(null);
  const imageDragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const previewResourcePathRef = useRef('');
  const fullscreenControlsTimerRef = useRef(0);
  const imageCropRequestRef = useRef(0);
  const editorSeekIdRef = useRef(0);

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
    const cachedPreviewUrl = entry ? findCachedMediaThumbnailPreview(entry.path, entry.updatedAt) : undefined;
    setResource(current => entry
      ? current.sourcePath === entry.path
        // File details often hydrate just after selection. Keep an already
        // decoded original visible until its refreshed replacement is ready.
        ? { ...current, previewUrl: current.previewUrl || cachedPreviewUrl || entry.previewUrl }
        : { sourcePath: entry.path, previewUrl: cachedPreviewUrl || entry.previewUrl }
      : {});
    onTechnicalMetadata({});
    if (!entry) return () => { active = false; };
    const unsubscribe = window.electronAPI.onThumbnailStateChanged(update => {
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
    requestThumbnail(() => window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, 1600, 0, -1))
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
    return () => { active = false; unsubscribe(); void window.electronAPI.cancelMediaThumbnail(entry.path, 1600); };
  }, [entry?.path, entry?.updatedAt, cacheConfig.directory, cacheConfig.maxSizeGB]);

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
    window.electronAPI.getMediaOriginal(entry.path, entry.kind, cacheConfig).then(result => {
      if (!active) return;
      if (!result.success || !result.mediaUrl) {
        window.clearTimeout(loadingTimer);
        setOriginalLoading(false);
        setOriginalLoadError(result.error || '原图加载失败，当前显示预览图');
        console.warn('Original image preview failed', result.error || 'unknown error');
        window.electronAPI.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'missing_or_unavailable' });
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
        window.electronAPI.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'decode_failed' });
      };
      originalImage.src = result.mediaUrl;
    }).catch(error => {
      window.clearTimeout(loadingTimer);
      if (active) {
        setOriginalLoading(false);
        setOriginalLoadError('原图加载失败，当前显示预览图');
        console.warn('Original image preview request failed', error instanceof Error ? error.message : String(error));
        window.electronAPI.trackTelemetry('media_preview_failed', { media_kind: entry.kind, reason: 'request_failed' });
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
    void window.electronAPI.setWindowFullscreen(true);
    return () => {
      window.clearTimeout(fullscreenControlsTimerRef.current);
      void window.electronAPI.setWindowFullscreen(false);
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
    if (!entry || entry.kind !== 'image' || entry.viaShortcut || imageCropPhase) return;
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
    window.electronAPI.trackTelemetry('media_preview_failed', { media_kind: 'video', reason: 'advanced_decoder_fallback' });
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
    const currentTime = useAdvancedVideo ? videoPlaybackTime : Number(fallbackVideoRef.current?.currentTime || 0);
    const start = Math.max(0, Math.min(videoDuration - .05, currentTime));
    setTrimEditor({ start, end: videoDuration });
    previewVideoTrimTime(start);
  };
  const confirmVideoTrim = async (saveMode: 'new' | 'replace') => {
    if (!trimEditor || trimBusy || trimEditor.end - trimEditor.start < .05) return;
    setTrimBusyMode(saveMode);
    try {
      // Unmount the active video backend before replacing the source so Windows
      // does not keep the original file locked while the atomic rename runs.
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      const result = await onTrimVideo(trimEditor.start, trimEditor.end, saveMode);
      if (result.success) setTrimEditor(null);
    } finally {
      setTrimBusyMode('');
    }
  };
  const useAdvancedVideo = Boolean(entry && entry.kind === 'video' && advancedVideoAvailable && !advancedPlaybackFailed);
  const trimEditing = Boolean(trimEditor);

  useEffect(() => {
    let active = true;
    setVideoTrimFrames([]);
    if (!trimEditing || !resource.mediaUrl || !videoDuration) return () => { active = false; };
    const source = document.createElement('video');
    source.muted = true;
    source.preload = 'auto';
    source.playsInline = true;
    const waitForEvent = (name: 'loadedmetadata' | 'seeked') => new Promise<void>((resolve, reject) => {
      const failed = () => { cleanup(); reject(new Error('无法读取视频时间轴画面')); };
      const completed = () => { cleanup(); resolve(); };
      const cleanup = () => {
        source.removeEventListener(name, completed);
        source.removeEventListener('error', failed);
      };
      source.addEventListener(name, completed, { once: true });
      source.addEventListener('error', failed, { once: true });
    });
    void (async () => {
      source.src = resource.mediaUrl || '';
      source.load();
      if (source.readyState < 1) await waitForEvent('loadedmetadata');
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext('2d');
      if (!context) return;
      const frames: string[] = [];
      for (let index = 0; index < 8 && active; index += 1) {
        source.currentTime = Math.min(videoDuration - .01, videoDuration * (index + .5) / 8);
        await waitForEvent('seeked');
        const sourceRatio = source.videoWidth / Math.max(1, source.videoHeight);
        const targetRatio = canvas.width / canvas.height;
        let sx = 0; let sy = 0; let sw = source.videoWidth; let sh = source.videoHeight;
        if (sourceRatio > targetRatio) { sw = source.videoHeight * targetRatio; sx = (source.videoWidth - sw) / 2; }
        else { sh = source.videoWidth / targetRatio; sy = (source.videoHeight - sh) / 2; }
        context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', .72));
      }
      if (active) setVideoTrimFrames(frames);
    })().catch(() => { if (active) setVideoTrimFrames([]); });
    return () => {
      active = false;
      source.pause();
      source.removeAttribute('src');
      source.load();
    };
  }, [trimEditing, resource.mediaUrl, videoDuration, entry?.path]);

  const videoTrimControls = trimEditor ? <VideoTrimTimeline
    duration={videoDuration}
    start={trimEditor.start}
    end={trimEditor.end}
    currentTime={videoPlaybackTime}
    frames={videoTrimFrames}
    busyMode={trimBusyMode}
    onChange={changeVideoTrimEdge}
    onPreview={previewVideoTrimTime}
    onCancel={() => { if (!trimBusy) setTrimEditor(null); }}
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
    const handleFallbackMouseNavigationButton = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopPropagation();
      runDirectionalAction(event.button === 4 ? 1 : -1, 'forward-back');
    };
    window.addEventListener('keydown', handleFallbackVideoKey);
    window.addEventListener('mousedown', handleFallbackMouseNavigationButton);
    return () => {
      window.removeEventListener('keydown', handleFallbackVideoKey);
      window.removeEventListener('mousedown', handleFallbackMouseNavigationButton);
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
      </div> : trimEditor ? <button type="button" disabled={trimBusy} onClick={() => setTrimEditor(null)} className="rounded-md px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">取消剪辑</button> : <div className="flex items-center gap-1">{entry && <><button type="button" onClick={() => setFullscreen(true)} title="全屏查看" aria-label="全屏查看" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Maximize2 size={16}/></button>{(finalVersionAvailable || finalVersion) && <button type="button" disabled={finalVersionLoading || finalVersionBusy || !finalVersion || finalVersion.fileMissing} onClick={onToggleFinal} title={finalVersion?.isFinal ? '取消喜爱' : finalVersionLoading ? '正在读取喜爱状态' : '标记为喜爱'} aria-label={finalVersion?.isFinal ? '取消喜爱' : '标记为喜爱'} className={`rounded-md p-2 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40 ${finalVersion?.isFinal ? 'text-red-500' : 'text-slate-500'}`}><Heart size={16} fill={finalVersion?.isFinal ? 'currentColor' : 'none'}/></button>}{photoshopAvailable && (entry.kind === 'image' || entry.kind === 'raw') && <button type="button" onClick={onOpenInPhotoshop} title="使用 Photoshop 打开" aria-label="使用 Photoshop 打开" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><PhotoshopIcon size={16}/></button>}<button type="button" disabled={entry.kind === 'raw' || entry.viaShortcut || entry.kind === 'video' && !videoDuration} onClick={entry.kind === 'video' ? openVideoTrim : () => void beginImageCrop()} title={entry.kind === 'video' ? videoDuration ? '剪辑视频（保持原编码和画质）' : '正在读取视频时长' : entry.kind === 'raw' ? 'RAW 暂不支持直接裁剪' : '裁剪图片（识别并磁吸边缘）'} aria-label={entry.kind === 'video' ? '剪辑视频' : '裁剪图片'} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-35"><Crop size={16}/></button></>}<button type="button" onClick={onClose} title="关闭预览" aria-label="关闭预览" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button></div>}
    </header>}
    {fullscreen && fullscreenControlsVisible && <button type="button" onClick={() => setFullscreen(false)} title="退出全屏（Esc）" aria-label="退出全屏" className="fixed right-5 top-5 z-[520] rounded-full bg-black/60 p-2.5 text-white shadow-lg backdrop-blur transition hover:bg-black/80"><X size={20}/></button>}
    <div className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${fullscreen ? 'bg-black' : 'bg-slate-50'}`}>
      {!entry && <div className="max-w-[220px] text-center"><ImageIcon size={38} strokeWidth={1.4} className="mx-auto text-slate-600"/><p className="mt-3 text-sm font-medium text-slate-300">点击图片、RAW 或视频文件</p><p className="mt-1 text-xs leading-5 text-slate-500">此处会显示大图或轻量视频预览</p></div>}
      {useAdvancedVideo && entry && !trimBusy && <AdvancedVideoPlayer filePath={entry.path} poster={resource.previewUrl} keyboardSettings={keyboardSettings} bottomControls={videoTrimControls} editorSeekRequest={advancedEditorSeek} onPlaybackState={playback => setVideoPlaybackTime(playback.time)} onError={handleAdvancedVideoError} onMetadata={metadata => { setLoading(false); setVideoDuration(Number(metadata.duration) || 0); onTechnicalMetadata(metadata); }} onNavigate={onNavigate} onContextMenuAt={onContextMenuAt} onPointerActivity={revealFullscreenControls} topRightOverlayHole={fullscreen && fullscreenControlsVisible ? 72 : 0} onEscape={() => setFullscreen(false)}/>}
      {entry && entry.kind === 'video' && !useAdvancedVideo && !trimBusy && resource.mediaUrl && !playbackFailed && <div className="absolute inset-0 flex min-h-0 flex-col bg-black"><video ref={fallbackVideoRef} key={resource.mediaUrl} autoPlay controls={!trimEditor} preload="metadata" poster={resource.previewUrl} className="min-h-0 w-full flex-1 bg-black object-contain" onTimeUpdate={event => setVideoPlaybackTime(event.currentTarget.currentTime)} onLoadedMetadata={event => { setLoading(false); setVideoDuration(Number(event.currentTarget.duration) || 0); setVideoPlaybackTime(event.currentTarget.currentTime); onTechnicalMetadata({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight, duration: event.currentTarget.duration }); void event.currentTarget.play().catch(() => undefined); }} onError={handleVideoPlaybackError}><source src={resource.mediaUrl}/></video>{videoTrimControls}</div>}
      {entry && entry.kind === 'video' && !useAdvancedVideo && !trimBusy && (!resource.mediaUrl || playbackFailed) && <div className="flex max-h-full w-full flex-col items-center justify-center gap-4 text-center">{resource.previewUrl ? <img src={resource.previewUrl} alt={entry.name} draggable={false} className="max-h-[70%] max-w-full object-contain"/> : <Video size={52} strokeWidth={1.3} className="text-slate-600"/>}<div className="max-w-sm px-6"><p className="text-sm font-medium text-slate-700">{resource.importedVideoWithoutPreview ? '此导入视频没有软件内快速预览' : playbackFailed ? resource.usingImportedPreview ? '导入的视频预览无法播放' : '当前原始编码无法在应用内播放' : loading ? '正在准备视频预览…' : resource.previewUrl ? '视频封面已就绪' : '没有可用的视频封面'}</p>{resource.importedVideoWithoutPreview && <p className="mt-1 text-xs leading-5 text-slate-500">请在导入设置中开启“生成视频预览”。浏览时不会为这类大型导入视频临时转码。</p>}{playbackFailed && !resource.importedVideoWithoutPreview && <p className="mt-1 text-xs leading-5 text-slate-500">可以使用系统默认播放器打开原文件。</p>}<button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button></div></div>}
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

const FileMetadataPane = ({ entry, entryDetails, metadataFields, metadataLoading, metadataError, technicalMetadata, formatFileSize, width, onOpen, onCopyPath, onClose }: {
  entry?: ProjectFileEntry;
  entryDetails: ProjectEntryDetails | null;
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

  const mediaType = entry?.kind === 'folder' ? '文件夹' : entry?.kind === 'image' ? '图片' : entry?.kind === 'raw' ? 'RAW 图片' : entry?.kind === 'video' ? '视频' : '文件';
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
    ['相机', camera], ['镜头', firstValue('LensModel', 'Lens')], ['拍摄时间', formatCaptureDate(firstValue('DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate'))], ['尺寸', dimensions],
    ['光圈', firstValue('FNumber', 'Aperture')], ['快门', formatShutterSpeed(firstValue('ExposureTime', 'ShutterSpeed'))], ['ISO', firstValue('ISO')], ['焦距', firstValue('FocalLength')]
  ]).filter((item): item is string[] => Boolean(item[1] && item[1] !== '—'));
  const applicationFields: MediaMetadataField[] = entry ? [
    { group: 'Application', name: '文件名', value: entry.name }, { group: 'Application', name: '媒体类型', value: mediaType },
    ...((entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') && dimensions ? [{ group: 'Application', name: '像素尺寸', value: dimensions }] : []),
    ...(entry.extension ? [{ group: 'Application', name: '文件格式', value: firstValue('FileType') || entry.extension.replace(/^\./, '').toLocaleUpperCase() }] : []),
    { group: 'Application', name: '大小', value: entryDetails ? formatFileSize(entryDetails.size) : entry.size >= 0 ? formatFileSize(entry.size) : '正在计算…' },
    ...(entryDetails ? [{ group: 'Application', name: '创建时间', value: new Date(entryDetails.createdAt).toLocaleString() }, { group: 'Application', name: '修改时间', value: new Date(entryDetails.updatedAt).toLocaleString() }] : []),
    ...(entry?.kind === 'folder' && entryDetails ? [{ group: 'Application', name: '包含', value: `${entryDetails.fileCount} 个文件，${entryDetails.folderCount} 个文件夹` }] : []),
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
    <header className="flex h-20 shrink-0 items-end justify-between border-b border-slate-200 px-4 pb-2 pt-7"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">详细信息</p><p className="truncate text-sm font-semibold text-slate-700">{entry?.name || '文件信息'}</p></div><button type="button" onClick={onClose} title="关闭详细信息" aria-label="关闭详细信息" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {!entry ? <div className="py-12 text-center"><FileText size={34} strokeWidth={1.4} className="mx-auto text-slate-300"/><p className="mt-3 text-sm text-slate-400">选择文件或文件夹后显示详细信息</p></div> : <>
        {importantItems.length > 0 && <section className="grid grid-cols-2 gap-1.5 py-2">{importantItems.map(([label, value]) => { const Icon = IMPORTANT_METADATA_ICONS[label] || FileText; return <div key={label} className="min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2"><p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400"><Icon size={12}/>{label}</p><p title={value} className="mt-1 truncate text-xs font-semibold text-slate-700">{value}</p></div>; })}</section>}
        <div className="flex items-center justify-between border-b border-slate-200 py-2"><span className="text-[11px] text-slate-400">{metadataLoading ? '正在读取详细信息…' : `${metadataFields.length + applicationFields.length} 个字段`}</span>{groupNames.length > 1 && <button type="button" onClick={() => setExpandedGroups(allExpanded ? new Set() : new Set(groupNames))} className="text-[11px] font-bold text-blue-500 hover:text-blue-400">{allExpanded ? '全部折叠' : '全部展开'}</button>}</div>
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
    window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 2, queueOrder)
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
const HOVER_VIDEO_PLAY_DELAY_MS = 300;
let activeHoverVideo: HTMLVideoElement | null = null;

const MediaThumbnail = ({ entry, cacheConfig, requestedSize, queueOrder, large = false }: { entry: ProjectFileEntry; cacheConfig: AppConfig['mediaCache']; requestedSize: number; queueOrder: number; large?: boolean }) => {
  const previewCacheKey = mediaThumbnailPreviewKey(entry.path, entry.updatedAt, requestedSize);
  const cachedPreviewUrl = mediaThumbnailPreviewCache.get(previewCacheKey);
  const [preview, setPreview] = useState<{ url?: string; size: number }>({ url: cachedPreviewUrl || entry.previewUrl, size: cachedPreviewUrl ? requestedSize : entry.previewUrl ? 320 : 0 });
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
  const thumbnailRequestRef = useRef<{ key: string; promoted: boolean; promise: ReturnType<typeof window.electronAPI.getMediaThumbnail> }>();
  const failedPreviewLoadCountRef = useRef(0);
  useEffect(() => {
    failedPreviewLoadCountRef.current = 0;
    const cached = mediaThumbnailPreviewCache.get(previewCacheKey);
    setPreview({ url: cached || entry.previewUrl, size: cached ? requestedSize : entry.previewUrl ? 320 : 0 });
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
          return window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 0, queueOrder);
        }
        return result;
      });
    }
    const promise = window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, priority, queueOrder);
    thumbnailRequestRef.current = { key, promoted: priority === 0, promise };
    return promise;
  };
  const captureVideoResource = (result: Awaited<ReturnType<typeof window.electronAPI.getMediaThumbnail>>) => {
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
        window.electronAPI.getCursorScreenPoint().catch(() => null),
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

type ProjectWorkspaceProps = Omit<FileBrowserWorkspaceProps, 'browserContext'>;
const ProjectWorkspace = (props: ProjectWorkspaceProps) => <FileBrowserWorkspace {...props} browserContext={{ ...PROJECT_FILE_BROWSER_CONTEXT, title: props.project.name }}/>;

export { FileBrowserWorkspace, ProjectWorkspace };
