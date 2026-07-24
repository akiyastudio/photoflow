import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, FolderPlus, Folder, Image as ImageIcon, ScanSearch, Play, Trash2, Edit, X, Plus, Loader2, CheckCircle2, ExternalLink, Video, ChevronDown, ChevronUp, File, FileImage, MemoryStick, LayoutList, Grid2X2, FileText, Copy, Scissors as Cut, ClipboardPaste, CheckSquare, ArrowLeft, ArrowRight, Camera, Aperture, Timer, Gauge, Ruler, Calendar, Activity, Volume2, PanelLeftOpen, ArrowUpDown, ArrowUp, ArrowDown, Search, Info, GripVertical, Maximize2, Minimize2, GitBranch, UsersRound, Heart } from 'lucide-react';
import { VersionManager } from '../../components/VersionManager';
import { TeamRetouchManager } from '../../components/TeamRetouchManager';
import { useAppDialog } from '../../components/AppDialogProvider';
import { MediaCacheSettings } from '../settings/SettingsFeature';
import { ConverterView, ImportCard, MatchView } from '../tools/ToolViews';
import { PROJECT_STATUS_LABELS } from '../../types';
import type { AppConfig, MediaMetadataField, MediaVersion, MediaVersionBundle, ProgressFolder, ProjectFileEntry, ThumbnailState, WorkspaceProject } from '../../types';
import { RECYCLE_BIN_FAILURE_DIALOG, isRecycleBinFailure } from '../../utils/recycleBinFailure';

const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
const OFFICE_OPEN_XML_EXTENSIONS = new Set([
  '.docx', '.docm', '.dotx', '.dotm',
  '.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm', '.ppam',
  '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlam', '.xlsb',
]);
const isOfficeOpenXmlEntry = (entry: ProjectFileEntry) => entry.kind === 'file' && OFFICE_OPEN_XML_EXTENSIONS.has(entry.extension.toLocaleLowerCase());

const PhotoshopIcon = ({ size = 16 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 18 18" className="shrink-0">
    <rect x="0.75" y="0.75" width="16.5" height="16.5" rx="3" fill="#001E36" stroke="#31A8FF" strokeWidth="1.5"/>
    <text x="3.2" y="12.4" fill="#31A8FF" fontFamily="Arial, sans-serif" fontSize="9.2" fontWeight="700">Ps</text>
  </svg>
);

const ViewportContextMenu = ({ x, y, widthClass, children }: { x: number; y: number; widthClass: string; children: React.ReactNode }) => {
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

  return <div ref={menuRef} role="menu" className={`project-context-menu fixed z-[301] max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white p-1 shadow-xl ${widthClass}`} style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }} onClick={event => event.stopPropagation()}>{children}</div>;
};

const CollapsiblePanel = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => (
  <section className="shrink-0 rounded-xl border border-slate-200 bg-white p-6 animate-in slide-in-from-top-2 duration-200">
    <div className="-mx-6 -mt-6 mb-5 flex items-center justify-between border-b border-slate-100 px-6 pb-4 pt-6"><h3 className="text-lg font-bold text-slate-800">{title}</h3><button type="button" onClick={onClose} className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-50">收起 <ChevronUp size={16}/></button></div>
    {children}
  </section>
);

// Source decoding is scheduled in the Electron main process. Renderer calls
// only probe the memory/disk layers and enqueue or reprioritize a task.
const requestThumbnail = <T,>(task: () => Promise<T>) => task();
const thumbnailSizeLabel = (requestedSize: number) => requestedSize <= 320 ? 'small' : requestedSize <= 640 ? 'medium' : 'large';

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

type ProjectPanel = 'import' | 'broll' | 'match' | 'converter' | 'trash' | 'cache' | null;
type ProgressSetupDraft = {
  mode: 'create' | 'import' | 'mark';
  mediaKind: 'image' | 'video';
  relation: 'root' | 'branch';
  parentProgressId: string;
  versionKey: string;
  progressName: string;
  trackingEnabled: boolean;
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
  acceptedSources: string[];
  unmatchedSources: string[];
  unmatchedReferences: string[];
  renameSources: boolean;
  copyMissingFromParent: boolean;
};

const comparePreviewKind = (fileName: string): 'image' | 'raw' | 'video' => {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLocaleLowerCase();
  if (new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.crm']).has(extension)) return 'video';
  if (new Set(['.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.dng', '.rwl', '.3fr', '.fff', '.iiq', '.pef', '.srw']).has(extension)) return 'raw';
  return 'image';
};
const comparePreviewPath = (folderPath: string, fileName: string) => `${folderPath.replace(/[\\/]+$/, '')}${folderPath.includes('\\') ? '\\' : '/'}${fileName}`;

const ProgressPairPreview = ({ match, parentFolder, progressFolder, cacheConfig }: {
  match?: CompareMatch;
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

  const previousPath = match ? comparePreviewPath(parentFolder.folderPath, match.reference) : '';
  const currentPath = match ? comparePreviewPath(progressFolder.folderPath, match.source) : '';

  useEffect(() => {
    let active = true;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setResources({ loading: Boolean(match) });
    if (!match) return () => { active = false; };
    const paths = new Map([[previousPath.toLocaleLowerCase(), 'previous'], [currentPath.toLocaleLowerCase(), 'current']] as const);
    const unsubscribe = window.electronAPI.onThumbnailStateChanged(update => {
      if (update.state !== 'READY') return;
      const side = paths.get(update.filePath.toLocaleLowerCase());
      const url = update.previewUrls?.large || update.previewUrls?.medium;
      if (side && url) setResources(current => ({ ...current, [side]: url }));
    });
    Promise.all([
      window.electronAPI.getMediaThumbnail(previousPath, comparePreviewKind(match.reference), cacheConfig, 1600, 0, -2),
      window.electronAPI.getMediaThumbnail(currentPath, comparePreviewKind(match.source), cacheConfig, 1600, 0, -1),
    ]).then(([previous, current]) => {
      if (!active) return;
      setResources({
        previous: previous.previewUrl || previous.mediaUrl,
        current: current.previewUrl || current.mediaUrl,
        loading: false,
        error: !previous.success || !current.success ? previous.error || current.error || '对比预览加载失败' : undefined,
      });
    }).catch(error => {
      if (active) setResources({ loading: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      active = false;
      unsubscribe();
      void window.electronAPI.cancelMediaThumbnail(previousPath, 1600);
      void window.electronAPI.cancelMediaThumbnail(currentPath, 1600);
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
      <div className="flex items-center gap-1 rounded-lg bg-slate-800 p-1 text-xs"><button type="button" onClick={() => setMode('side')} className={`rounded px-2 py-1 ${mode === 'side' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>并排</button><button type="button" onClick={() => setMode('slider')} className={`rounded px-2 py-1 ${mode === 'slider' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}>滑块</button></div>
      <div className="flex items-center gap-1 text-xs text-slate-300"><button type="button" onClick={() => setZoom(current => clampNumber(current / 1.2, 1, 5))} className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">−</button><button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="min-w-12 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">{Math.round(zoom * 100)}%</button><button type="button" onClick={() => setZoom(current => clampNumber(current * 1.2, 1, 5))} className="rounded bg-slate-800 px-2 py-1 hover:bg-slate-700">＋</button></div>
    </header>
    {!match ? <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-slate-400">选择左侧的一组匹配以查看图片对比。</div> : <>
      <div className={`grid border-b border-slate-700 bg-slate-900 text-xs font-bold text-slate-300 ${mode === 'side' ? 'grid-cols-2' : 'grid-cols-1'}`}>{mode === 'side' ? <><div className="truncate border-r border-slate-700 px-3 py-2" title={match.reference}>上一版本 · {match.reference}</div><div className="truncate px-3 py-2" title={match.source}>当前版本 · {match.source}</div></> : <div className="flex justify-between gap-3 px-3 py-2"><span className="truncate" title={match.reference}>上一版本 · {match.reference}</span><span className="truncate text-right" title={match.source}>当前版本 · {match.source}</span></div>}</div>
      <div onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finishPan} onPointerCancel={finishPan} className={`relative min-h-[300px] flex-1 overflow-hidden ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}>
        {mode === 'side' ? <div className="grid h-full grid-cols-2"><div className="relative overflow-hidden border-r border-slate-700">{previewImage(resources.previous, match.reference)}</div><div className="relative overflow-hidden">{previewImage(resources.current, match.source)}</div></div> : <><div className="absolute inset-0">{previewImage(resources.previous, match.reference)}</div><div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }}>{previewImage(resources.current, match.source)}</div><div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${sliderPosition}%` }}/></>}
      </div>
      {mode === 'slider' && <div className="border-t border-slate-700 bg-slate-900 px-4 py-2"><input aria-label="调整新旧版本分界线" type="range" min="0" max="100" value={sliderPosition} onChange={event => setSliderPosition(Number(event.target.value))} className="w-full accent-blue-500"/></div>}
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

const PROJECT_STATUSES: Array<WorkspaceProject['status']> = ['策划中', '待拍摄', '后期中', '已归档'];

const ProjectWorkspace = ({ active, project, workspacePath, installedComponentIds, initialPanel, importConfig, brollConfig, fileImportConfig, conversionConfig, matchConfig, mediaCacheConfig, onImportConfigChange, onMatchConfigChange, onMediaCacheConfigChange, onNotice, onProjectMoved, onDeleted }: {
  active: boolean;
  project: WorkspaceProject;
  workspacePath: string;
  installedComponentIds: ReadonlySet<string>;
  initialPanel: 'import' | 'broll' | 'match' | null;
  importConfig: AppConfig['smartImport'];
  brollConfig: AppConfig['brollImport'];
  fileImportConfig: AppConfig['fileImport'];
  conversionConfig: AppConfig['imageConversion'];
  matchConfig: AppConfig['smartMatch'];
  mediaCacheConfig: AppConfig['mediaCache'];
  onImportConfigChange: (config: AppConfig['smartImport']) => void;
  onMatchConfigChange: (config: AppConfig['smartMatch']) => void;
  onMediaCacheConfigChange: (config: AppConfig['mediaCache']) => void;
  onNotice: (message: string, duration?: number) => void;
  onProjectMoved: (project: WorkspaceProject) => void;
  onDeleted: () => void;
}) => {
  const appDialog = useAppDialog();
  const [folders, setFolders] = useState<Array<{ name: string; path: string; updatedAt: number }>>([]);
  const [progressFolders, setProgressFolders] = useState<ProgressFolder[]>([]);
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
  const selectionDragRef = useRef<{ startX: number; startY: number; initialPaths: string[]; additive: boolean; started: boolean } | null>(null);
  const internalDragPathsRef = useRef<string[]>([]);
  const internalDropHandledRef = useRef(false);
  const renameCommitRef = useRef(false);
  const selectionAnchorPathRef = useRef('');
  const searchInputRef = useRef<HTMLInputElement>(null);
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
  const [previewEntryDetails, setPreviewEntryDetails] = useState<ProjectEntryDetails | null>(null);
  const [viewportCurrentPath, setViewportCurrentPath] = useState('');
  const [viewportStatus, setViewportStatus] = useState<{ path: string; fileNumber: number; total: number; captureDateTime?: string } | null>(null);
  const [previewPaneOpen, setPreviewPaneOpen] = useState(false);
  const fileRevealRequestIdRef = useRef(0);
  const [pendingFileReveal, setPendingFileReveal] = useState<{ path: string; requestId: number } | null>(null);
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
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [progressSetup, setProgressSetup] = useState<ProgressSetupDraft | null>(null);
  const [progressCompare, setProgressCompare] = useState<ProgressCompareConfirmation | null>(null);
  const [activeProgressCompareSource, setActiveProgressCompareSource] = useState('');
  const [progressTask, setProgressTask] = useState('');
  const [progressSubmitting, setProgressSubmitting] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ entry: ProjectFileEntry; x: number; y: number } | null>(null);
  const [surfaceMenu, setSurfaceMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipboardHasFiles, setClipboardHasFiles] = useState(false);
  const [photoshopAvailable, setPhotoshopAvailable] = useState(false);
  const [conversionTarget, setConversionTarget] = useState('');
  const [versionEntry, setVersionEntry] = useState<ProjectFileEntry | null>(null);
  const [teamRetouchEntries, setTeamRetouchEntries] = useState<ProjectFileEntry[]>([]);
  const [finalVersionSummary, setFinalVersionSummary] = useState({ count: 0, availableCount: 0, missingCount: 0 });
  const [finalExporting, setFinalExporting] = useState(false);
  const [finalViewOpen, setFinalViewOpen] = useState(false);
  const [finalViewLoading, setFinalViewLoading] = useState(false);
  const [finalViewEntries, setFinalViewEntries] = useState<ProjectFileEntry[]>([]);
  const [previewVersion, setPreviewVersion] = useState<MediaVersion | null>(null);
  const [previewVersionLoading, setPreviewVersionLoading] = useState(false);
  const [previewVersionBusy, setPreviewVersionBusy] = useState(false);
  const [drives, setDrives] = useState<string[]>([]);
  const requestFileReveal = useCallback((path: string) => {
    fileRevealRequestIdRef.current += 1;
    setPendingFileReveal({ path, requestId: fileRevealRequestIdRef.current });
  }, []);

  useEffect(() => {
    void window.electronAPI.getPhotoshopStatus().then(result => setPhotoshopAvailable(result.available));
  }, []);

  const officeImageExtractorAvailable = installedComponentIds.has('office-media-extractor');
  const teamRetouchAvailable = installedComponentIds.has('team-retouch');

  useEffect(() => {
    if (!progressCompare?.matches.length) {
      setActiveProgressCompareSource('');
      return;
    }
    setActiveProgressCompareSource(current => progressCompare.matches.some(match => match.source === current) ? current : progressCompare.matches[0].source);
  }, [progressCompare]);

  useEffect(() => {
    if (!teamRetouchAvailable) setTeamRetouchEntries([]);
  }, [teamRetouchAvailable]);

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
      if (showError) onNotice(`建立图片选片 V0 失败：${result.error || '未知错误'}`, 7000);
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
        onNotice(`读取最终版失败：${result.error || '未知错误'}`);
        return null;
      }
      setFinalViewEntries(result.entries);
      if (showMissingNotice && result.missingCount) onNotice(`已显示 ${result.availableCount} 张最终版；另有 ${result.missingCount} 张文件已被删除、移动或不在项目中。`, 7000);
      return result;
    } finally {
      setFinalViewLoading(false);
    }
  }, [workspacePath, project.status, project.name, onNotice]);
  const openFinalVersionView = async () => {
    const result = await loadFinalViewEntries(true);
    if (!result?.count) {
      if (result) onNotice('当前项目还没有标记最终版的图片');
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
      if (browseResult.missingDirectory && !requestedPath) {
        onNotice(`项目“${project.name}”已在外部删除，已关闭项目标签`);
        onDeleted();
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
    else onNotice(`读取项目失败：${result.error || '无法读取项目文件夹'}`);
  };

  useEffect(() => {
    projectPathRef.current = project.path;
    currentRelativePathRef.current = '';
    refreshSequenceRef.current += 1;
    directoryEntriesCacheRef.current.clear();
    directoryPrefetchesRef.current.clear();
    setFileEntries([]);
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
    if (currentRelativePath) skipNextPathRefreshRef.current = true;
    setCurrentRelativePath('');
    if (active) {
      refresh('');
      void loadProgressFolders();
      void ensureSelectionBaseline();
      void loadFinalVersionSummary();
    }
  }, [project.path, project.status, initialPanel]);
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      refresh(currentRelativePathRef.current);
      void loadProgressFolders();
      void ensureSelectionBaseline();
      void loadFinalVersionSummary();
    }
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
      timer = window.setTimeout(() => {
        refresh(currentRelativePathRef.current);
        if (finalViewOpen) void loadFinalViewEntries();
      }, 500);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [active, workspacePath, project.path, project.status, project.name, mediaCacheConfig.directory, mediaCacheConfig.maxSizeGB, finalViewOpen, loadFinalViewEntries]);
  useEffect(() => {
    const closeMenus = () => { setFileMenu(null); setSurfaceMenu(null); setShowStatusMenu(false); setShowCreateMenu(false); setShowImportMenu(false); setShowSortMenu(false); setSearchOpen(false); };
    window.addEventListener('click', closeMenus);
    window.addEventListener('photoflow-menu-open', closeMenus);
    return () => { window.removeEventListener('click', closeMenus); window.removeEventListener('photoflow-menu-open', closeMenus); };
  }, []);

  const activeFileEntries = finalViewOpen ? finalViewEntries : fileEntries;
  const displayedFileEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('zh-CN');
    const filtered = normalizedQuery ? activeFileEntries.filter(entry => entry.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) : activeFileEntries;
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
  }, [activeFileEntries, searchQuery, sortDirection, sortField]);
  const renderedFileEntries = displayedFileEntries.slice(virtualWindow.start, virtualWindow.end);
  const pathSegments = currentRelativePath.split(/[\\/]/).filter(Boolean);
  const breadcrumbs = [{ label: project.name, relativePath: '' }, ...pathSegments.map((label, index) => ({ label, relativePath: pathSegments.slice(0, index + 1).join('/') }))];
  useEffect(() => { setVirtualWindow({ start: 0, end: 120, top: 0, bottom: 0, rowHeight: 0, columns: 1 }); }, [currentRelativePath, finalViewOpen, sortField, sortDirection, searchQuery]);
  useEffect(() => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (!container || !surface) return;
    let frameId = 0;
    const update = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        if (fileRevealPathRef.current) return;
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
    onNotice('正在选择花絮文件…');
    const result = await window.electronAPI.importBroll(workspacePath, project.status, project.name, { splitLargeFiles: brollConfig.splitLargeFiles, preserveOriginal: fileImportConfig.preserveOriginal });
    if (!result.success) { onNotice(`导入花絮失败：${result.error || '未知错误'}`); return; }
    if (result.cancelled) { onNotice('已取消选择花絮文件。'); return; }
    onNotice(`已导入 ${result.count || 0} 个花絮文件。`);
    if (result.warning) {
      if (isRecycleBinFailure(result.warning)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else onNotice(result.warning, 6000);
    }
    refresh();
  };
  const importFiles = async () => {
    setShowImportMenu(false);
    onNotice('正在选择要导入的文件…');
    const result = await window.electronAPI.importProjectFiles(workspacePath, project.status, project.name, currentRelativePath, fileImportConfig);
    if (!result.success) { onNotice(`导入失败：${result.error || '未知错误'}`); return; }
    if (result.cancelled) { onNotice('已取消导入。'); return; }
    onNotice(`已${fileImportConfig.preserveOriginal ? '复制' : '移动'}导入 ${result.count || 0} 个文件。`);
    refresh();
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
    if (imageCount) onNotice(`已从 ${result.successfulCount || documents.length} 个文档提取 ${imageCount} 张图片。`);
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
  const progressVersionIsValid = (draft: ProgressSetupDraft) => {
    if (!/^\d+(?:_\d+)*$/.test(draft.versionKey)) return false;
    const hasConflict = progressFolders.some(folder => folder.mediaKind === draft.mediaKind && folder.versionKey === draft.versionKey && folder.id !== draft.existingProgressId);
    if (hasConflict) return false;
    if (draft.relation === 'root') return !draft.versionKey.includes('_');
    const parent = progressFolders.find(folder => folder.id === draft.parentProgressId);
    return Boolean(parent && draft.versionKey.startsWith(`${parent.versionKey}_`) && draft.versionKey.split('_').length === parent.versionKey.split('_').length + 1);
  };
  const progressParentIsAvailable = (draft: ProgressSetupDraft) => Boolean(
    draft.parentProgressId && progressFolders.some(folder => folder.id === draft.parentProgressId && !folder.folderMissing),
  );
  const progressNameHasConflict = (draft: ProgressSetupDraft) => {
    if (!draft.versionKey) return false;
    const generatedName = buildProgressFolderName(draft.mediaKind, draft.versionKey, draft.progressName).toLocaleLowerCase('zh-CN');
    return progressFolders.some(folder => folder.id !== draft.existingProgressId && folder.displayName.toLocaleLowerCase('zh-CN') === generatedName);
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
    const rootFolders = kindFolders.filter(folder => !folder.versionKey.includes('_'));
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
      const nextChild = kindFolders.reduce((highest, folder) => {
        const parts = folder.versionKey.split('_');
        return folder.versionKey.startsWith(childPrefix) && parts.length === parentParts.length + 1
          ? Math.max(highest, Number(parts[parts.length - 1]) || 0)
          : highest;
      }, 0) + 1;
      versionKey = `${branchParent.versionKey}_${nextChild}`;
      parentId = branchParent.id;
    }
    return { mode, mediaKind, relation: actualRelation, parentProgressId: parentId, versionKey, progressName: '', trackingEnabled: mode !== 'create', renameSources: false, copyMissingFromParent: false };
  };
  const openProgressSetup = async (mode: 'create' | 'import') => {
    setShowCreateMenu(false);
    setShowImportMenu(false);
    const latestFolders = await loadProgressFolders();
    setProgressSetup(makeProgressDraft(mode, 'image', 'root', '', latestFolders));
  };
  const openMarkProgress = async (entry: ProjectFileEntry) => {
    const targetRelativePath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (entry.kind !== 'folder' || targetRelativePath.includes('/')) {
      onNotice('只能把项目根目录下的文件夹标记为进度。');
      return;
    }
    const latestFolders = await loadProgressFolders();
    const normalizedPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const registered = latestFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === normalizedPath);
    if (registered) {
      if (registered.mediaKind === 'image' && registered.versionKey === '0') {
        onNotice('“图片选片”是自动管理的 V0 原图基线，不需要手动修改进度版本。');
        return;
      }
      setProgressSetup({
        mode: 'mark',
        mediaKind: registered.mediaKind,
        relation: registered.versionKey.includes('_') ? 'branch' : 'root',
        parentProgressId: registered.parentProgressId || '',
        versionKey: registered.versionKey,
        progressName: progressNameFromDisplayName(registered.displayName, registered.mediaKind, registered.versionKey, entry.name),
        trackingEnabled: registered.trackingEnabled,
        renameSources: false,
        copyMissingFromParent: false,
        targetRelativePath,
        existingProgressId: registered.id,
      });
      return;
    }
    setProgressSetup({
      ...makeProgressDraft('mark', 'image', 'root', '', latestFolders),
      progressName: entry.name,
      targetRelativePath,
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
        renameSources: current.renameSources,
        copyMissingFromParent: current.copyMissingFromParent && Boolean(next.parentProgressId),
      };
    });
  };
  const changeProgressRelation = (relation: 'root' | 'branch', parentProgressId = '') => {
    setProgressSetup(current => {
      if (!current || current.existingProgressId) return current;
      const next = makeProgressDraft(current.mode, current.mediaKind, relation, parentProgressId, progressFolders);
      return {
        ...next,
        progressName: current.progressName,
        trackingEnabled: current.trackingEnabled,
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
  const submitProgressSetup = async () => {
    if (!progressSetup || progressSubmitting || !progressVersionIsValid(progressSetup) || progressNameHasConflict(progressSetup)) return;
    const draft = progressSetup;
    const generatedName = buildProgressFolderName(draft.mediaKind, draft.versionKey, draft.progressName);
    const parentFolder = progressFolders.find(folder => folder.id === draft.parentProgressId);
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
        await loadProgressFolders();
        await refresh('');
        onNotice(`已创建${draft.mediaKind === 'image' ? '图片' : '视频'}进度“${generatedName}”（版本 _${draft.versionKey}）`);
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
          trackingEnabled: draft.trackingEnabled,
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
          onNotice(`已将“${generatedName}”标记为${draft.mediaKind === 'image' ? '图片' : '视频'}进度 _${draft.versionKey}（未开启版本跟踪）。`);
          return;
        }
        if (!parentFolder) {
          setProgressTask('正在建立首个版本的跟踪记录…');
          const baseline = await window.electronAPI.registerVersionBaseline(workspacePath, project.status, project.name, targetRelativePath);
          if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
          setProgressTask('');
          onNotice(`已标记并建立首版跟踪：${progressFolder.displayName}`);
          return;
        }

        setProgressTask('正在对比原有版本和新版本，文件较多时可能需要几分钟…');
        const compared = await window.electronAPI.compareVersionFolders(workspacePath, project.status, project.name, projectRelativePath(parentFolder.folderPath), targetRelativePath);
        if (!compared.success) throw new Error(compared.error || '版本比对失败');
        setProgressTask('');
        setProgressCompare({
          sourceMode: 'mark',
          progressFolder,
          parentFolder,
          matches: compared.matches,
          acceptedSources: compared.matches.filter(match => match.confidence !== '低').map(match => match.source),
          unmatchedSources: compared.unmatched,
          unmatchedReferences: compared.unmatchedReference,
          renameSources: draft.renameSources,
          copyMissingFromParent: draft.copyMissingFromParent,
        });
        return;
      }

      setProgressTask(`正在导入${draft.mediaKind === 'image' ? '图片' : '视频'}进度…`);
      const imported = await window.electronAPI.importProgressFiles(workspacePath, project.status, project.name, generatedName, {
        preserveOriginal: fileImportConfig.preserveOriginal,
        mediaKind: draft.mediaKind,
        versionKey: draft.versionKey,
        parentProgressId: draft.parentProgressId || undefined,
        trackingEnabled: draft.trackingEnabled,
      });
      if (!imported.success) throw new Error(imported.error || '导入失败');
      if (imported.cancelled || !imported.folder) {
        setProgressTask('');
        return;
      }
      if (!imported.progressFolder) throw new Error('版本进度没有完成数据库登记');
      const progressFolder = imported.progressFolder;
      setProgressSetup(null);
      await loadProgressFolders();
      await refresh('');

      if (!draft.trackingEnabled) {
        setProgressTask('');
        onNotice(`已导入 ${imported.count || 0} 个文件；此项目未开启版本跟踪。`);
        return;
      }
      if (!parentFolder) {
        setProgressTask('正在建立首个版本的跟踪记录…');
        const baseline = await window.electronAPI.registerVersionBaseline(workspacePath, project.status, project.name, imported.folder.relativePath);
        if (!baseline.success) throw new Error(baseline.error || '无法建立首版跟踪');
        setProgressTask('');
        onNotice(`已导入并建立首版跟踪：${progressFolder.displayName}`);
        return;
      }

      setProgressTask('正在对比原有版本和新版本，文件较多时可能需要几分钟…');
      const compared = await window.electronAPI.compareVersionFolders(workspacePath, project.status, project.name, projectRelativePath(parentFolder.folderPath), imported.folder.relativePath);
      if (!compared.success) throw new Error(compared.error || '版本比对失败');
      setProgressTask('');
      setProgressCompare({
        sourceMode: 'import',
        progressFolder,
        parentFolder,
        matches: compared.matches,
        acceptedSources: compared.matches.filter(match => match.confidence !== '低').map(match => match.source),
        unmatchedSources: compared.unmatched,
        unmatchedReferences: compared.unmatchedReference,
        renameSources: draft.renameSources,
        copyMissingFromParent: draft.copyMissingFromParent,
      });
    } catch (error) {
      setProgressTask('');
      const action = draft.mode === 'create' ? '创建' : draft.mode === 'import' ? '导入' : '标记';
      onNotice(`${action}版本进度失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProgressSubmitting(false);
    }
  };
  const commitProgressCompare = async () => {
    if (!progressCompare || progressSubmitting) return;
    setProgressSubmitting(true);
    setProgressTask('正在确认版本关系并写入素材历史…');
    const accepted = new Set(progressCompare.acceptedSources);
    const result = await window.electronAPI.commitVersionBatch(workspacePath, project.status, project.name, {
      folderA: progressCompare.parentFolder.folderPath,
      folderB: progressCompare.progressFolder.folderPath,
      importKey: crypto.randomUUID(),
      displayName: progressCompare.progressFolder.displayName,
      renameSources: progressCompare.renameSources,
      copyMissingReferences: progressCompare.copyMissingFromParent ? progressCompare.unmatchedReferences : [],
      matches: progressCompare.matches.filter(match => accepted.has(match.source)),
    });
    setProgressSubmitting(false);
    setProgressTask('');
    if (!result.success) { onNotice(`建立版本跟踪失败：${result.error || '未知错误'}`); return; }
    setProgressCompare(null);
    await refresh('');
    const renameWarning = result.renameErrors?.length ? `，${result.renameErrors.length} 个文件未能同步重命名` : '';
    const copySummary = result.copiedMissingCount ? `，从上一版本补齐 ${result.copiedMissingCount} 个文件` : '';
    const copyWarning = result.copyMissingErrors?.length ? `，${result.copyMissingErrors.length} 个缺失文件复制失败` : '';
    onNotice(`已建立 _${progressCompare.parentFolder.versionKey} → _${progressCompare.progressFolder.versionKey} 的版本关系：${result.batch?.matchedCount || 0} 个延续版本，${result.batch?.newCount || 0} 个新素材${copySummary}${renameWarning}${copyWarning}`);
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
    });
    setProgressSubmitting(false);
    if (!result.success) { onNotice(`关闭项目跟踪失败：${result.error || '未知错误'}`); return; }
    setProgressCompare(null);
    await loadProgressFolders();
    onNotice(progressCompare.sourceMode === 'mark' ? '文件夹已标记为进度，但没有建立项目版本跟踪。' : '本次导入已保留，但没有建立项目版本跟踪。');
  };
  const moveToTrash = async () => {
    const result = await window.electronAPI.trashWorkspaceProject(workspacePath, project.status, project.name);
    if (!result.success) {
      if (isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else onNotice(`删除项目失败：${result.error || '未知错误'}`);
      return;
    }
    onDeleted();
  };
  const openPngConverter = async (folderPath: string) => {
    const result = await window.electronAPI.folderHasPng(folderPath);
    if (!result.success) { onNotice(`检查 PNG 文件失败：${result.error || '未知错误'}`); return; }
    if (!result.hasPng) { onNotice('文件夹中没有 PNG 文件。'); return; }
    setConversionTarget(folderPath);
    setPanel('converter');
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
    renameCommitRef.current = true;
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'rename', [inlineRenamePath], currentRelativePath, nextName);
    renameCommitRef.current = false;
    if (!result.success) { onNotice(`重命名失败：${result.error || '未知错误'}`); return; }
    cancelInlineRename();
    setSelectedPaths([]);
    onNotice(`已重命名为“${nextName}”`);
    refresh();
  };
  const beginRename = (targetPaths = selectedPaths) => {
    if (finalViewOpen) { onNotice('最终版浏览是只读视图，请回到原文件夹重命名'); return; }
    if (!targetPaths.length) return;
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
    setBatchRenameOpen(false);
    setBatchRenameParts([]);
    setSelectedPaths([]);
    onNotice(`已批量重命名 ${count} 个项目`);
    refresh();
  };
  const openFileMenu = (event: React.MouseEvent, entry: ProjectFileEntry, selectEntry = true) => {
    event.preventDefault();
    event.stopPropagation();
    filesSurfaceRef.current?.focus({ preventScroll: true });
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setSurfaceMenu(null);
    if (selectEntry) {
      if (!selectedPaths.includes(entry.relativePath)) selectionAnchorPathRef.current = entry.relativePath;
      setSelectedPaths(current => current.includes(entry.relativePath) ? current : [entry.relativePath]);
    }
    setFileMenu({ entry, x: event.clientX, y: event.clientY });
    setClipboardHasFiles(false);
    void window.electronAPI.getProjectFileClipboardStatus().then(result => setClipboardHasFiles(result.success && result.hasFiles));
  };
  const openSurfaceMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-entry-path]')) return;
    event.preventDefault();
    if (finalViewOpen) return;
    filesSurfaceRef.current?.focus({ preventScroll: true });
    window.dispatchEvent(new Event('photoflow-menu-open'));
    setFileMenu(null);
    selectionAnchorPathRef.current = '';
    setSelectedPaths([]);
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
    setSearchOpen(false);
    setSearchQuery('');
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
  const hasVersionTrackingForEntry = (entry?: ProjectFileEntry) => {
    if (!entry || !['image', 'raw', 'video'].includes(entry.kind)) return false;
    const mediaKind = entry.kind === 'video' ? 'video' : 'image';
    const entryPath = entry.path.replace(/\\/g, '/').toLocaleLowerCase();
    return progressFolders.some(folder => {
      const folderPath = folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
      return folder.mediaKind === mediaKind && folder.trackingEnabled && !folder.folderMissing
        && (entryPath === folderPath || entryPath.startsWith(`${folderPath}/`));
    });
  };
  const openVersions = (entry?: ProjectFileEntry) => {
    const target = entry || selectedEntries[0];
    if (!target || !['image', 'raw', 'video'].includes(target.kind)) {
      onNotice('请先选择一张图片、RAW 或视频');
      return;
    }
    if (!hasVersionTrackingForEntry(target)) {
      onNotice(`项目尚未录入${target.kind === 'video' ? '视频' : '图片'}版本信息，请先导入版本进度并开启项目跟踪`);
      return;
    }
    setTeamRetouchEntries([]);
    setVersionEntry(target);
  };
  const exportFinalVersions = async () => {
    if (finalExporting) return;
    const summary = await loadFinalVersionSummary();
    if (!summary.count) return;
    if (summary.missingCount) {
      onNotice(`有 ${summary.missingCount} 个最终版文件已被删除或移动，请先在版本管理中重新定位。`, 7000);
      return;
    }
    const latestFolders = await loadProgressFolders();
    const latestRootNumber = latestFolders
      .filter(folder => folder.mediaKind === 'image' && /^\d+$/.test(folder.versionKey))
      .reduce((highest, folder) => Math.max(highest, Number(folder.versionKey)), 0);
    const expectedName = `图片后期_${latestRootNumber + 1}_最终版`;
    if (!await appDialog.confirm({
      title: '确定创建最终版进度吗？',
      message: `将 ${summary.availableCount} 张最终版图片复制到新进度“${expectedName}”。`,
      confirmLabel: '创建并复制',
    })) return;
    setFinalExporting(true);
    try {
      const result = await window.electronAPI.exportFinalVersions(workspacePath, project.status, project.name);
      if (!result.success || !result.folder) throw new Error(result.error || '无法创建最终版进度');
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
      onNotice(`成功复制文件：已将 ${result.count} 张最终版图片放入“${result.displayName}”。`, 6000);
    } catch (error) {
      onNotice(`创建最终版进度失败：${error instanceof Error ? error.message : String(error)}`, 7000);
    } finally {
      setFinalExporting(false);
    }
  };
  const openTeamRetouch = (entry?: ProjectFileEntry) => {
    const targets = entry
      ? (selectedPaths.includes(entry.relativePath) ? selectedEntries : [entry])
      : selectedEntries;
    if (!targets.length || targets.some(target => target.kind !== 'image')) {
      onNotice('请选择 JPG、PNG、TIFF、HEIC 等成片图片；不能混选文件夹、RAW 或视频');
      return;
    }
    setVersionEntry(null);
    setTeamRetouchEntries(targets);
  };
  const openProjectEntriesInPhotoshop = async (entries: ProjectFileEntry[]) => {
    const imagePaths = entries.filter(entry => entry.kind === 'image').map(entry => entry.relativePath);
    if (!imagePaths.length) return;
    const result = await window.electronAPI.openProjectEntriesInPhotoshop(workspacePath, project.status, project.name, imagePaths);
    if (!result.success) onNotice(`用 Photoshop 打开失败：${result.error || '无法打开文件'}`);
  };
  const copyEntryPath = async (entry: ProjectFileEntry) => {
    const result = await window.electronAPI.copyProjectEntryPath(workspacePath, project.status, project.name, entry.relativePath);
    const typeLabel = entry.kind === 'folder' ? '文件夹' : '文件';
    onNotice(result.success ? '成功复制文字' : `复制${typeLabel}地址失败：${result.error || '未知错误'}`);
  };
  const copyCurrentDirectoryPath = async () => {
    const result = await window.electronAPI.copyProjectEntryPath(workspacePath, project.status, project.name, currentRelativePath);
    onNotice(result.success ? '成功复制文字' : `复制文件夹地址失败：${result.error || '未知错误'}`);
  };
  const startSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-entry-path], button, input, select, textarea')) return;
    const surface = filesSurfaceRef.current;
    if (!surface) return;
    surface.focus({ preventScroll: true });
    cancelInlineRename();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const additive = event.ctrlKey || event.metaKey;
    selectionDragRef.current = { startX: event.clientX, startY: event.clientY, initialPaths: additive ? selectedPaths : [], additive, started: false };
    if (!additive) {
      if (previewPath) requestFileReveal(previewPath);
      setSelectedPaths([]);
      setPreviewPath('');
      setViewportCurrentPath('');
      setPreviewPaneOpen(false);
      setMetadataPaneOpen(false);
    }
    setSelectionBox(null);
  };
  const updateSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    const surface = filesSurfaceRef.current;
    if (!drag || !surface) return;
    if (!drag.started) {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (moved < 5) return;
      drag.started = true;
    }
    event.preventDefault();
    const surfaceRect = surface.getBoundingClientRect();
    const currentX = clampNumber(event.clientX, surfaceRect.left, surfaceRect.right);
    const currentY = clampNumber(event.clientY, surfaceRect.top, surfaceRect.bottom);
    const leftClient = Math.min(drag.startX, currentX);
    const topClient = Math.min(drag.startY, currentY);
    const rightClient = Math.max(drag.startX, currentX);
    const bottomClient = Math.max(drag.startY, currentY);
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
  const runFileOperation = async (operation: 'trash' | 'copy' | 'cut' | 'paste' | 'rename', nextName?: string, targetPaths = selectedPaths) => {
    if (finalViewOpen && operation !== 'copy') { onNotice('最终版浏览是只读视图，请回到原文件夹修改文件'); return; }
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, operation, targetPaths, currentRelativePath, nextName);
    if (result.cancelled) { onNotice('粘贴已取消'); refresh(); return; }
    if (!result.success) {
      if (operation === 'trash' && isRecycleBinFailure(result.error, result.errorCode)) await appDialog.alert(RECYCLE_BIN_FAILURE_DIALOG);
      else onNotice(`操作失败：${result.error || '未知错误'}`);
      return;
    }
    if (operation === 'copy' || operation === 'cut') {
      setCutPaths(operation === 'cut' ? [...targetPaths] : []);
      setClipboardHasFiles(true);
      onNotice(operation === 'copy' ? '成功复制文件' : `已剪切 ${result.count} 个项目`);
    } else {
      if (operation === 'paste') setCutPaths([]);
      if (operation === 'trash') setCutPaths(current => current.filter(path => !targetPaths.includes(path)));
      onNotice(operation === 'trash'
        ? `已移入回收站 ${result.count} 个项目`
        : operation === 'paste'
          ? result.replacedCount
            ? `已粘贴 ${result.count} 个项目；${result.replacedCount} 个同名文件夹的原内容已移入回收站`
            : `已粘贴 ${result.count} 个项目`
          : '操作完成');
      setSelectedPaths([]);
      refresh();
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
      if (!target || !filesSurfaceRef.current?.contains(target)) return;
      let handled = false;

      if (commandKey && !event.altKey && !event.shiftKey && key === 'a') {
        setSelectedPaths(activeFileEntries.map(entry => entry.relativePath));
        onNotice(`已选择 ${activeFileEntries.length} 个项目`);
        handled = true;
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
  const selectedProgressFolder = selectedEntries.length === 1 && selectedEntries[0].kind === 'folder' ? selectedEntries[0] : undefined;
  const selectedProgressFolderIsRoot = Boolean(selectedProgressFolder && !selectedProgressFolder.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').includes('/'));
  const selectedRegisteredProgressFolder = selectedProgressFolder ? progressFolders.find(folder => folder.folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === selectedProgressFolder.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase()) : undefined;
  const previewEntry = activeFileEntries.find(entry => entry.relativePath === previewPath);
  const filesInCurrentDirectory = activeFileEntries.filter(entry => entry.kind !== 'folder');
  const viewportCurrentEntry = filesInCurrentDirectory.find(entry => entry.relativePath === viewportCurrentPath);
  const viewportCurrentFileNumber = viewportCurrentEntry ? filesInCurrentDirectory.findIndex(entry => entry.relativePath === viewportCurrentEntry.relativePath) + 1 : 0;
  const currentPreviewMetadataFields = previewEntry && previewMetadataResolvedPath === previewEntry.path ? previewMetadataFields : [];
  const currentPreviewMetadataLoading = Boolean(previewEntry && (previewMetadataLoading || previewMetadataResolvedPath !== previewEntry.path));
  const currentPreviewMetadataError = previewEntry && previewMetadataResolvedPath === previewEntry.path ? previewMetadataError : '';
  const previewCanMarkFinal = Boolean(previewEntry && hasVersionTrackingForEntry(previewEntry));
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
      onNotice(`更新最终版失败：${result.error || '未知错误'}`);
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
    onNotice(nextFinalState ? '已标记为最终版' : '已取消最终版');
  };
  const previewImageEntries = displayedFileEntries.filter(entry => entry.kind === 'image' || entry.kind === 'raw');
  const scrollFileEntryIntoView = useCallback((relativePath: string) => {
    const container = filesColumnRef.current;
    const surface = filesSurfaceRef.current;
    if (displayedFileEntries.findIndex(entry => entry.relativePath === relativePath) < 0 || !container || !surface) return false;

    fileRevealPathRef.current = relativePath;
    window.cancelAnimationFrame(fileRevealFrameRef.current);
    let previousSurfaceWidth = -1;
    let stableWidthFrames = 0;
    let measureAttempts = 0;
    const revealAfterVirtualRender = (targetRow: number, rowHeight: number) => {
      fileRevealFrameRef.current = window.requestAnimationFrame(() => {
        fileRevealFrameRef.current = window.requestAnimationFrame(() => {
          if (fileRevealPathRef.current !== relativePath) return;
          const node = Array.from(surface.querySelectorAll<HTMLElement>('[data-entry-path]')).find(item => item.dataset.entryPath === relativePath);
          fileRevealPathRef.current = '';
          if (node) {
            node.scrollIntoView({ block: 'center', inline: 'nearest' });
            node.focus({ preventScroll: true });
            return;
          }
          const containerRect = container.getBoundingClientRect();
          const surfaceRect = surface.getBoundingClientRect();
          const surfaceTop = surfaceRect.top - containerRect.top + container.scrollTop;
          container.scrollTo({ top: Math.max(0, surfaceTop + targetRow * rowHeight - Math.max(0, container.clientHeight - rowHeight) / 2) });
        });
      });
    };
    const measureStableLayout = () => {
      if (fileRevealPathRef.current !== relativePath) return;
      const surfaceWidth = Math.max(1, surface.clientWidth);
      stableWidthFrames = Math.abs(surfaceWidth - previousSurfaceWidth) < 1 ? stableWidthFrames + 1 : 0;
      previousSurfaceWidth = surfaceWidth;
      measureAttempts += 1;
      if (stableWidthFrames < 1 && measureAttempts < 8) {
        fileRevealFrameRef.current = window.requestAnimationFrame(measureStableLayout);
        return;
      }

      const fileIndex = displayedFileEntries.findIndex(entry => entry.relativePath === relativePath);
      if (fileIndex < 0) {
        fileRevealPathRef.current = '';
        return;
      }
      const columns = viewMode === 'list' ? 1 : Math.max(1, Math.floor((surfaceWidth + 12) / (gridIconSize + 12)));
      const cellWidth = viewMode === 'list' ? surfaceWidth : (surfaceWidth - (columns - 1) * 12) / columns;
      const measuredItem = surface.querySelector<HTMLElement>('[data-entry-path]');
      const measuredRowHeight = measuredItem
        ? measuredItem.getBoundingClientRect().height + (viewMode === 'list' ? 0 : 12)
        : 0;
      const rowHeight = measuredRowHeight || (viewMode === 'list' ? 48 : cellWidth + 68);
      const targetRow = Math.floor(fileIndex / columns);
      const rowCount = Math.ceil(displayedFileEntries.length / columns);
      const firstRow = Math.max(0, targetRow - 4);
      const lastRow = Math.min(rowCount, targetRow + 5);
      setVirtualWindow({
        start: firstRow * columns,
        end: Math.min(displayedFileEntries.length, lastRow * columns),
        top: firstRow * rowHeight,
        bottom: Math.max(0, (rowCount - lastRow) * rowHeight),
        rowHeight,
        columns,
      });
      revealAfterVirtualRender(targetRow, rowHeight);
    };
    fileRevealFrameRef.current = window.requestAnimationFrame(measureStableLayout);
    return true;
  }, [displayedFileEntries, gridIconSize, viewMode]);
  useEffect(() => () => {
    window.cancelAnimationFrame(fileRevealFrameRef.current);
    fileRevealPathRef.current = '';
  }, []);
  useEffect(() => {
    if (!pendingFileReveal || !scrollFileEntryIntoView(pendingFileReveal.path)) return;
    setPendingFileReveal(current => current?.requestId === pendingFileReveal.requestId ? null : current);
  }, [pendingFileReveal, scrollFileEntryIntoView]);
  useEffect(() => {
    if (previewPath) requestFileReveal(previewPath);
  }, [previewPath, previewPaneOpen, metadataPaneOpen, requestFileReveal]);
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
  }, [previewEntry?.path]);
  useEffect(() => {
    let active = true;
    setPreviewEntryDetails(null);
    if (!previewEntry) return () => { active = false; };
    window.electronAPI.getProjectEntryDetails(workspacePath, project.status, project.name, previewEntry.relativePath).then(result => {
      if (active && result.success && result.details) setPreviewEntryDetails(result.details);
    });
    return () => { active = false; };
  }, [previewEntry?.path, workspacePath, project.status, project.name]);
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
    };
    window.addEventListener('keydown', switchPreviewImage);
    return () => window.removeEventListener('keydown', switchPreviewImage);
  }, [previewPaneOpen, previewEntry?.relativePath, previewEntry?.kind, previewImageEntries]);
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
  const canSelectMedia = !finalViewOpen && selectedEntries.length > 0 && selectedEntries.length === selectedPaths.length && selectedEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
  const fileMenuEntrySelected = Boolean(fileMenu && selectedPaths.includes(fileMenu.entry.relativePath));
  const fileMenuTargetPaths = fileMenu
    ? fileMenuEntrySelected ? selectedPaths : [fileMenu.entry.relativePath]
    : selectedPaths;
  const canSelectFileMenuMedia = !finalViewOpen && fileMenuTargetPaths.length > 0 && fileMenuTargetPaths.every(path => {
    const entry = activeFileEntries.find(candidate => candidate.relativePath === path);
    return Boolean(entry && (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'));
  });
  const selectMediaFiles = async (targetPaths = selectedPaths) => {
    if (finalViewOpen) { onNotice('最终版浏览是只读视图，请回到原文件夹进行选片'); return; }
    const targetEntries = activeFileEntries.filter(entry => targetPaths.includes(entry.relativePath));
    const canSelectTargets = targetEntries.length > 0 && targetEntries.length === targetPaths.length && targetEntries.every(entry => entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video');
    if (!canSelectTargets) { onNotice(targetPaths.length ? '只能选择媒体文件' : '请先选择媒体文件'); return; }
    const result = await window.electronAPI.projectFileOperation(workspacePath, project.status, project.name, 'select', targetPaths);
    if (!result.success) { onNotice(`选片失败：${result.error || '未知错误'}`); return; }
    const baseline = result.imageCount ? await ensureSelectionBaseline(true) : null;
    if (result.imageCount && !baseline?.success) return;
    onNotice(result.imageCount
      ? `已将 ${result.count || 0} 个媒体文件放入选片文件夹，并将 ${result.imageCount} 张图片登记为 V0 原图基线`
      : `已将 ${result.count || 0} 个媒体文件放入选片文件夹`);
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
  const openEntryDetails = (entry: ProjectFileEntry) => {
    setPreviewPath(entry.relativePath);
    setPreviewTechnicalMetadata({});
    setPreviewPaneOpen(false);
    setMetadataPaneOpen(true);
  };
  const handleEntryClick = (event: React.MouseEvent | React.KeyboardEvent, entry: ProjectFileEntry) => {
    if (inlineRenamePath === entry.relativePath) return;
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    if (event.shiftKey) {
      selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey);
      return;
    }
    if (entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video') {
      openPreviewAndMetadata(entry);
      if (selectedPaths.length) toggleSelected(entry.relativePath);
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
      if (event.key === 'Enter') commitInlineRename();
      if (event.key === 'Escape') cancelInlineRename();
    }}
    className={`${grid ? 'mt-2 w-full text-xs' : 'min-w-0 flex-1 text-sm'} rounded border border-blue-500 bg-white px-1.5 py-0.5 text-slate-800 outline-none ring-2 ring-blue-200`}
  /> : grid ? <p className="mt-2 truncate text-xs font-medium text-slate-700">{entry.name}</p> : <span className="truncate font-medium text-slate-700">{entry.name}</span>;
  const gridThumbnailSize = gridIconSize <= 112 ? 320 : gridIconSize <= 184 ? 640 : gridIconSize <= 264 ? 960 : 1200;
  const renderEntryIcon = (entry: ProjectFileEntry, large = false, queueOrder = displayedFileEntries.findIndex(candidate => candidate.path === entry.path)) => entry.kind === 'folder'
    ? <FolderCover entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? 320 : 160} queueOrder={queueOrder} large={large} loadEntries={loadDirectoryPreviewEntries}/>
    : entry.kind === 'image' || entry.kind === 'raw' || entry.kind === 'video'
      ? <MediaThumbnail entry={entry} cacheConfig={mediaCacheConfig} requestedSize={large ? gridThumbnailSize : 160} queueOrder={queueOrder} large={large}/>
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
    if (finalViewOpen) { onNotice('最终版浏览是只读视图，不能导入文件'); return; }
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
      {fileMenu && createPortal(<ViewportContextMenu x={fileMenu.x} y={fileMenu.y} widthClass="w-52">
        {(fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openPreviewAndMetadata(entry); }}><PanelLeftOpen size={14}/>打开预览和详细信息</button>}
        {fileMenu.entry.kind !== 'folder' && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openProjectEntry(entry); }}><ExternalLink size={14}/>用默认方式打开</button>}
        {officeImageExtractorAvailable && isOfficeOpenXmlEntry(fileMenu.entry) && <button className="project-menu-item" onClick={() => { const entries = selectedPaths.includes(fileMenu.entry.relativePath) ? selectedEntries.filter(isOfficeOpenXmlEntry) : [fileMenu.entry]; setFileMenu(null); void extractOfficeImages(entries); }}><ImageIcon size={14}/>提取图片{selectedPaths.includes(fileMenu.entry.relativePath) && selectedEntries.filter(isOfficeOpenXmlEntry).length > 1 ? `（${selectedEntries.filter(isOfficeOpenXmlEntry).length} 个文档）` : ''}</button>}
        {photoshopAvailable && fileMenu.entry.kind === 'image' && <button className="project-menu-item" onClick={() => { const entries = selectedPaths.includes(fileMenu.entry.relativePath) ? selectedEntries.filter(entry => entry.kind === 'image') : [fileMenu.entry]; setFileMenu(null); void openProjectEntriesInPhotoshop(entries); }}><PhotoshopIcon size={14}/>用 Photoshop 打开{selectedPaths.includes(fileMenu.entry.relativePath) && selectedEntries.filter(entry => entry.kind === 'image').length > 1 ? `（${selectedEntries.filter(entry => entry.kind === 'image').length} 个）` : ''}</button>}
        {(fileMenu.entry.kind === 'image' || fileMenu.entry.kind === 'raw' || fileMenu.entry.kind === 'video') && <><div className="my-1 border-t border-slate-100"/><button disabled={!canSelectFileMenuMedia} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); selectMediaFiles(targets); }}><CheckCircle2 size={14}/>选片</button><button disabled={!hasVersionTrackingForEntry(fileMenu.entry)} title={hasVersionTrackingForEntry(fileMenu.entry) ? '管理素材的历史版本' : '请先导入版本进度并开启项目跟踪'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openVersions(entry); }}><GitBranch size={14}/>版本管理</button>{teamRetouchAvailable && fileMenu.entry.kind === 'image' && <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openTeamRetouch(entry); }}><UsersRound size={14}/>多人修脸</button>}</>}
        {fileMenu.entry.kind !== 'folder' && <div className="my-1 border-t border-slate-100"/>}
        <button disabled={finalViewOpen} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); beginRename(targets); }}><Edit size={14}/>{fileMenuTargetPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button disabled={finalViewOpen} className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('cut', undefined, targets); }}><Cut size={14}/>剪切</button>
        <button className="project-menu-item" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('copy', undefined, targets); }}><Copy size={14}/>复制</button>
        <button disabled={finalViewOpen || !clipboardHasFiles} title={finalViewOpen ? '最终版浏览为只读视图' : clipboardHasFiles ? '粘贴到当前文件夹' : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { setFileMenu(null); runFileOperation('paste'); }}><ClipboardPaste size={14}/>粘贴</button>
        {fileMenu.entry.kind === 'folder' && <><div className="my-1 border-t border-slate-100"/><button disabled={fileMenu.entry.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').includes('/')} title={fileMenu.entry.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').includes('/') ? '进度文件夹必须位于项目根目录' : '把当前文件夹登记为图片或视频进度'} className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); void openMarkProgress(entry); }}><GitBranch size={14}/>标记进度</button></>}
        {fileMenu.entry.kind === 'folder' && <button className="project-menu-item" onClick={() => { setFileMenu(null); openPngConverter(fileMenu.entry.path); }}><ImageIcon size={14}/>PNG 转 JPG</button>}
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); copyEntryPath(entry); }}><FileText size={14}/>{fileMenu.entry.kind === 'folder' ? '复制文件夹地址' : '复制文件地址'}</button>
        <button className="project-menu-item" onClick={() => { const entry = fileMenu.entry; setFileMenu(null); openEntryDetails(entry); }}><Info size={14}/>详细信息</button>
        <button className="project-menu-item" onClick={() => { const path = fileMenu.entry.relativePath; if (fileMenuEntrySelected) setSelectedPaths(current => current.filter(item => item !== path)); else { selectionAnchorPathRef.current = path; setSelectedPaths(current => [...current, path]); setSearchOpen(false); setSearchQuery(''); requestFileReveal(path); } setFileMenu(null); }}>{fileMenuEntrySelected ? <X size={14}/> : <CheckSquare size={14}/>} {fileMenuEntrySelected ? '取消选择' : '选择'}</button>
        <button disabled={finalViewOpen} className="project-menu-item project-menu-danger" onClick={() => { const targets = fileMenuTargetPaths; setFileMenu(null); runFileOperation('trash', undefined, targets); }}><Trash2 size={14}/>删除</button>
      </ViewportContextMenu>, document.body)}
      {surfaceMenu && createPortal(<ViewportContextMenu x={surfaceMenu.x} y={surfaceMenu.y} widthClass="w-56">
        <p className="px-2 py-1 text-[11px] font-bold text-slate-400">新建</p>
        <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void openProgressSetup('create'); }}><FolderPlus size={14}/>新建进度</button>
        <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void createFolder(); }}><FolderPlus size={14}/>新建文件夹</button>
        <div className="my-1 border-t border-slate-100"/>
        <p className="px-2 py-1 text-[11px] font-bold text-slate-400">导入</p>
        <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void openProgressSetup('import'); }}><FolderInput size={14}/>导入进度</button>
        <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void importFiles(); }}><FolderInput size={14}/>导入文件</button>
        <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void importBroll(); }}><FolderInput size={14}/>导入花絮</button>
        <div className="my-1 border-t border-slate-100"/>
        <button disabled={!clipboardHasFiles} title={clipboardHasFiles ? '粘贴到当前文件夹' : '剪贴板中没有文件'} className="project-menu-item" onClick={() => { setSurfaceMenu(null); void runFileOperation('paste'); }}><ClipboardPaste size={14}/>粘贴</button>
        <button className="project-menu-item" onClick={() => { setSurfaceMenu(null); void copyCurrentDirectoryPath(); }}><FileText size={14}/>复制当前文件夹地址</button>
      </ViewportContextMenu>, document.body)}
      <div ref={projectColumnLayoutRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div ref={filesColumnRef} style={previewPaneOpen || metadataPaneOpen ? { width: displayedColumnWidths.files } : undefined} className={`flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain [overflow-anchor:none] px-6 pb-6 ${previewPaneOpen || metadataPaneOpen ? 'shrink-0' : 'flex-1'}`}>
      {viewportStatus && createPortal(<div role="status" className="pointer-events-none fixed bottom-2 z-[35] flex max-w-[calc(100vw-3rem)] items-center gap-3 rounded-lg border border-white/10 bg-slate-950/80 px-3.5 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md" style={{ right: Math.max(12, projectLayoutWidth - displayedColumnWidths.files + 12) }}>
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

      <div className="project-toolbar-wrap sticky top-0 z-30 -mx-6 w-[calc(100%+3rem)] bg-slate-50">
      <div className="project-toolbar flex w-full flex-nowrap items-center border-b border-slate-200 px-6 py-1">
        <div className="relative" onClick={event => event.stopPropagation()}>
          <button onClick={() => { const next = !showCreateMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowCreateMenu(next); }} title="新建" aria-label="新建" aria-haspopup="menu" aria-expanded={showCreateMenu} className="project-action-button"><FolderPlus size={16}/>新建</button>
          {showCreateMenu && <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            <button className="project-menu-item" onClick={() => void openProgressSetup('create')}>新建进度</button>
            <div className="my-1 border-t border-slate-100"/>
            <button className="project-menu-item" onClick={() => void createFolder()}>新建文件夹</button>
          </div>}
        </div>
        <div className="relative" onClick={event => event.stopPropagation()}>
          <button onClick={() => { const next = !showImportMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowImportMenu(next); }} title="导入" aria-label="导入" aria-haspopup="menu" aria-expanded={showImportMenu} className="project-action-button"><FolderInput size={16}/>导入</button>
          {showImportMenu && <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
            <button className="project-menu-item" onClick={() => void openProgressSetup('import')}>导入进度</button>
            <div className="my-1 border-t border-slate-100"/>
            <button className="project-menu-item" onClick={() => void importFiles()}>导入文件</button>
            <button className="project-menu-item" onClick={() => void importBroll()}><span className="block">导入花絮</span><span className="mt-0.5 block text-[11px] leading-4 text-slate-400">会创建“花絮”文件夹</span></button>
          </div>}
        </div>
        <span aria-hidden className="toolbar-divider"/>
        {selectedPaths.length > 0 && <span className="mr-1 self-center text-xs text-slate-500">已选 {selectedPaths.length}</span>}
        <button disabled={finalViewOpen || !selectedPaths.length} title={finalViewOpen ? '最终版浏览为只读视图' : selectedPaths.length > 1 ? '批量重命名' : '重命名'} onClick={() => beginRename()} className="project-action-button compact-hide-file-action"><Edit size={16}/>{selectedPaths.length > 1 ? '批量重命名' : '重命名'}</button>
        <button disabled={finalViewOpen || !selectedPaths.length} title={finalViewOpen ? '最终版浏览为只读视图' : '剪切'} onClick={() => runFileOperation('cut')} className="project-action-button compact-hide-file-action"><Cut size={16}/>剪切</button>
        <button disabled={!selectedPaths.length} title="复制" onClick={() => runFileOperation('copy')} className="project-action-button compact-hide-file-action"><Copy size={16}/>复制</button>
        <button disabled={finalViewOpen || !clipboardHasFiles} title={finalViewOpen ? '最终版浏览为只读视图' : clipboardHasFiles ? '粘贴到当前文件夹' : '剪贴板中没有文件'} onClick={() => runFileOperation('paste')} className="project-action-button compact-hide-file-action"><ClipboardPaste size={16}/>粘贴</button>
        <button disabled={finalViewOpen || !selectedPaths.length} title={finalViewOpen ? '最终版浏览为只读视图' : '删除'} onClick={() => runFileOperation('trash')} className="project-action-button project-action-danger compact-hide-file-action"><Trash2 size={16}/>删除</button>
        <button disabled={!selectedPaths.length} title="取消选择" onClick={() => setSelectedPaths([])} className="project-action-button"><X size={16}/>取消选择</button>
        <span aria-hidden className="toolbar-divider"/>
        <div className="contents">
          <button onClick={() => togglePanel('import')} title="从 SD 卡导入" aria-label="从 SD 卡导入" className="project-action-button"><MemoryStick size={16}/>从 SD 卡导入</button>
          <button onClick={() => togglePanel('match')} title="从文件名选片" aria-label="从文件名选片" className="project-action-button"><FileText size={16}/>从文件名选片</button>
          <button aria-disabled={!canSelectMedia} title="选片" onClick={() => void selectMediaFiles()} className={`project-action-button ${canSelectMedia ? '' : 'cursor-not-allowed opacity-50'}`}><CheckCircle2 size={16}/>选片</button>
          {photoshopAvailable && <button disabled={!selectedEntries.length || selectedEntries.some(entry => entry.kind !== 'image')} onClick={() => void openProjectEntriesInPhotoshop(selectedEntries)} title={selectedEntries.length > 1 ? `在 Photoshop 中打开 ${selectedEntries.length} 张图片` : '在 Photoshop 中打开'} aria-label="在 Photoshop 中打开所选图片" className="project-action-button"><PhotoshopIcon size={16}/>在 PS 中打开{selectedEntries.length > 1 ? `（${selectedEntries.length} 张）` : ''}</button>}
        </div>
        <div className="contents">
          <button disabled={selectedProgressFolder ? !selectedProgressFolderIsRoot : selectedEntries.length !== 1 || !hasVersionTrackingForEntry(selectedEntries[0])} onClick={() => selectedProgressFolder ? void openMarkProgress(selectedProgressFolder) : openVersions()} title={selectedProgressFolder ? selectedProgressFolderIsRoot ? selectedRegisteredProgressFolder ? '修改当前进度版本' : '标记当前文件夹为进度' : '进度文件夹必须位于项目根目录' : '版本管理'} aria-label={selectedProgressFolder ? selectedRegisteredProgressFolder ? '修改进度版本' : '标记进度' : '版本管理'} className="project-action-button"><GitBranch size={16}/>{selectedProgressFolder ? selectedRegisteredProgressFolder ? '修改进度版本' : '标记进度' : '版本管理'}</button>
          {finalVersionSummary.count > 0 && <button disabled={finalViewLoading} onClick={() => void openFinalVersionView()} title={`浏览最终版（${finalVersionSummary.availableCount} 张${finalVersionSummary.missingCount ? `，${finalVersionSummary.missingCount} 张文件丢失` : ''}）`} aria-label="浏览所有已标记最终版的图片" aria-pressed={finalViewOpen} className={`project-action-button !text-emerald-600 hover:!bg-emerald-50 ${finalViewOpen ? '!bg-emerald-50' : ''}`}>{finalViewLoading ? <Loader2 size={16} className="animate-spin"/> : <Heart size={16} fill="currentColor"/>}</button>}
          {teamRetouchAvailable && <button disabled={!selectedEntries.length || selectedEntries.some(entry => entry.kind !== 'image')} onClick={() => openTeamRetouch()} title="多人修脸" aria-label="多人修脸" className="project-action-button"><UsersRound size={16}/>多人修脸{selectedEntries.length > 1 ? `（${selectedEntries.length} 张）` : ''}</button>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-3"><button onClick={() => setViewMode('grid')} title="图标模式" className={`rounded-md p-1.5 ${viewMode === 'grid' ? 'bg-slate-200 text-slate-800' : 'text-slate-500 hover:bg-slate-200'}`}><Grid2X2 size={17}/></button><button onClick={() => setViewMode('list')} title="列表模式" className={`rounded-md p-1.5 ${viewMode === 'list' ? 'bg-slate-200 text-slate-800' : 'text-slate-500 hover:bg-slate-200'}`}><LayoutList size={17}/></button>{viewMode === 'grid' && <input aria-label="图标大小" title="图标大小" type="range" min="80" max="360" step="4" value={gridIconSize} onChange={event => setGridIconSize(Number(event.target.value))} className="compact-hide-slider ml-2 w-24 accent-blue-600"/>}<span aria-hidden className="mx-1 h-5 w-px bg-slate-200"/><div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !showSortMenu; window.dispatchEvent(new Event('photoflow-menu-open')); setShowSortMenu(next); }} title="排序" aria-label="排序" aria-haspopup="menu" aria-expanded={showSortMenu} className="project-action-button"><ArrowUpDown size={16}/>排序</button>{showSortMenu && <div className="sort-menu absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">{([['name', '文件名'], ['date', '修改日期'], ['size', '大小']] as const).map(([field, label]) => <button key={field} type="button" onClick={() => setSortField(field)} className={`project-menu-item ${sortField === field ? 'bg-blue-50 font-bold text-blue-600' : ''}`}>{label}</button>)}<div className="my-1 border-t border-slate-100"/><button type="button" onClick={() => setSortDirection('asc')} className={`project-menu-item ${sortDirection === 'asc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowUp size={14}/><span>递增</span></button><button type="button" onClick={() => setSortDirection('desc')} className={`project-menu-item ${sortDirection === 'desc' ? 'bg-blue-50 font-bold text-blue-600' : ''}`}><ArrowDown size={14}/><span>递减</span></button></div>}</div><div className="relative" onClick={event => event.stopPropagation()}><button type="button" onClick={() => { const next = !searchOpen; window.dispatchEvent(new Event('photoflow-menu-open')); setSearchOpen(next); }} title="查找文件（Ctrl+F）" aria-label="查找文件" aria-expanded={searchOpen} className={`project-action-button ${searchOpen || searchQuery ? 'bg-blue-50 text-blue-600' : ''}`}><Search size={16}/>查找文件</button>{searchOpen && <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl"><div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2"><Search size={15} className="shrink-0 text-slate-400"/><input ref={searchInputRef} autoFocus value={searchQuery} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); } }} placeholder="输入文件名" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-slate-800 outline-none"/>{searchQuery && <button type="button" onClick={() => setSearchQuery('')} title="清除查找" className="rounded p-0.5 text-slate-400 hover:bg-slate-200"><X size={14}/></button>}</div></div>}</div></div>
      </div>
      <div className="flex min-w-0 items-center px-6 py-2">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-sm text-slate-500">
          {finalViewOpen ? <><button type="button" onClick={closeFinalVersionView} title="退出最终版浏览" aria-label="退出最终版浏览" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={17}/></button><span className="inline-flex h-8 shrink-0 items-center px-1.5 font-bold leading-none text-slate-700">最终版</span></> : <><button type="button" onClick={navigateBack} disabled={!directoryHistory.back.length} title="后退" aria-label="后退" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowLeft size={17}/></button><button type="button" onClick={navigateForward} disabled={!directoryHistory.forward.length} title="前进" aria-label="前进" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"><ArrowRight size={17}/></button><span className="mr-1 inline-flex h-8 shrink-0 items-center font-bold leading-none text-slate-800">项目</span>{breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.relativePath || 'root'}><span className="inline-flex h-8 shrink-0 items-center leading-none text-slate-300">/</span><button onClick={() => navigateToDirectory(crumb.relativePath)} title={`进入 ${crumb.label}`} className={`inline-flex h-8 min-w-0 items-center truncate rounded border border-transparent px-1.5 text-sm leading-none transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 ${index === breadcrumbs.length - 1 ? 'font-bold text-slate-700' : ''}`}>{crumb.label}</button></React.Fragment>)}</>}
        </div>
        {finalViewOpen && <button type="button" disabled={finalExporting || !finalViewEntries.length} onClick={() => void exportFinalVersions()} className="ml-auto shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40">{finalExporting ? '正在整理…' : '整理到最终版'}</button>}
      </div>
      </div>

      {panel === 'converter' && <CollapsiblePanel title="PNG 转 JPG" onClose={() => setPanel(null)}><ConverterView embedded initialTargetPath={conversionTarget} defaultQuality={conversionConfig.jpgQuality}/></CollapsiblePanel>}
      {panel === 'import' && <CollapsiblePanel title="从 SD 卡导入" onClose={() => setPanel(null)}><p className="mb-4 text-sm text-slate-500">导入的文件会直接整理到当前项目“{project.name}”中。</p><ImportCard config={importConfig} drives={drives} destinationPath={project.path} brollDestinationPath={project.path} active={active} onImportConfigChange={onImportConfigChange} onImportComplete={markInProgress}/></CollapsiblePanel>}
      {panel === 'broll' && <CollapsiblePanel title="导入花絮" onClose={() => setPanel(null)}><p className="text-sm text-slate-500">选择要保留的花絮媒体，软件会复制到当前项目的“花絮”文件夹。</p><button onClick={importBroll} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">选择花絮文件</button></CollapsiblePanel>}
      {panel === 'match' && <CollapsiblePanel title="从文件名选片" onClose={() => setPanel(null)}><MatchView embedded config={matchConfig} projectPath={project.path} folderOptions={folders} onUpdateConfig={onMatchConfigChange}/></CollapsiblePanel>}
      {panel === 'cache' && <CollapsiblePanel title="缩略图缓存" onClose={() => setPanel(null)}><MediaCacheSettings config={mediaCacheConfig} onChange={onMediaCacheConfigChange}/></CollapsiblePanel>}
      {panel === 'trash' && <CollapsiblePanel title="移入回收站" onClose={() => setPanel(null)}><p className="text-sm text-slate-500">项目“{project.name}”及其全部内容将移入系统回收站。</p><button onClick={moveToTrash} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">确认移入回收站</button></CollapsiblePanel>}
      {progressTask && createPortal(<div role="status" aria-live="polite" className="fixed left-1/2 top-14 z-[390] flex w-[min(92vw,520px)] -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-2xl"><Loader2 size={18} className="shrink-0 animate-spin text-blue-300"/><span>{progressTask}</span></div>, document.body)}
      {progressSetup && <div role="dialog" aria-modal="true" aria-label={`${progressSetup.mode === 'create' ? '新建' : progressSetup.mode === 'import' ? '导入' : progressSetup.existingProgressId ? '修改' : '标记'}版本进度`} className="fixed inset-0 z-[340] flex items-center justify-center bg-slate-950/45 p-4"><div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4"><div><h3 className="text-lg font-bold text-slate-800">{progressSetup.mode === 'create' ? '新建' : progressSetup.mode === 'import' ? '导入' : progressSetup.existingProgressId ? '修改' : '标记'}{progressSetup.mediaKind === 'image' ? '图片' : '视频'}进度</h3><p className="mt-1 text-xs text-slate-500">描述这个进度的版本和名称，系统会生成统一的进度名称。</p></div><button type="button" onClick={() => setProgressSetup(null)} disabled={progressSubmitting} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X size={18}/></button></header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <section><h4 className="mb-2 text-sm font-bold text-slate-700">进度类型</h4><div className="grid grid-cols-2 gap-3"><button type="button" disabled={Boolean(progressSetup.existingProgressId)} onClick={() => changeProgressMediaKind('image')} className={`rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 ${progressSetup.mediaKind === 'image' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}><span className="text-sm font-bold text-slate-700">图片进度</span><span className="mt-1 block text-xs text-slate-500">图片后期版本</span></button><button type="button" disabled={Boolean(progressSetup.existingProgressId)} onClick={() => changeProgressMediaKind('video')} className={`rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 ${progressSetup.mediaKind === 'video' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}><span className="text-sm font-bold text-slate-700">视频进度</span><span className="mt-1 block text-xs text-slate-500">视频后期版本</span></button></div>{progressSetup.mode === 'mark' && <p className="mt-2 text-xs text-slate-500">当前文件夹：{progressSetup.targetRelativePath}{progressSetup.existingProgressId ? '（已登记，可继续或重新配置跟踪）' : ''}</p>}</section>
          <section><h4 className="mb-2 text-sm font-bold text-slate-700">版本关系</h4><div className="grid grid-cols-2 gap-3"><label className={`${progressSetup.existingProgressId ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} rounded-xl border p-3 ${progressSetup.relation === 'root' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}><input type="radio" className="mr-2" checked={progressSetup.relation === 'root'} disabled={Boolean(progressSetup.existingProgressId)} onChange={() => changeProgressRelation('root')}/><span className="text-sm font-bold text-slate-700">下一个主版本</span><p className="mt-1 pl-5 text-xs text-slate-500">例如 _1、_2、_3</p></label><label className={`rounded-xl border p-3 ${!progressSetup.existingProgressId && progressFolders.some(folder => folder.mediaKind === progressSetup.mediaKind && !folder.folderMissing) ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'} ${progressSetup.relation === 'branch' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}><input type="radio" className="mr-2" checked={progressSetup.relation === 'branch'} disabled={Boolean(progressSetup.existingProgressId) || !progressFolders.some(folder => folder.mediaKind === progressSetup.mediaKind && !folder.folderMissing)} onChange={() => changeProgressRelation('branch')}/><span className="text-sm font-bold text-slate-700">某版本的分支</span><p className="mt-1 pl-5 text-xs text-slate-500">例如 _1_1、_1_2</p></label></div></section>
          {progressSetup.relation === 'branch' && <label className="block"><span className="mb-1.5 block text-sm font-bold text-slate-700">从哪个版本分支</span><select value={progressSetup.parentProgressId} disabled={Boolean(progressSetup.existingProgressId)} onChange={event => changeProgressRelation('branch', event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-60">{progressFolders.filter(folder => folder.mediaKind === progressSetup.mediaKind && !folder.folderMissing).sort((left, right) => compareProgressKeys(left.versionKey, right.versionKey)).map(folder => <option key={folder.id} value={folder.id}>_{folder.versionKey} · {folder.displayName}</option>)}</select></label>}
          <label className="block"><span className="mb-1.5 block text-sm font-bold text-slate-700">版本编号</span><div className="flex items-center gap-2"><span className="text-lg font-bold text-slate-400">_</span><input value={progressSetup.versionKey} onChange={event => setProgressSetup(current => current ? { ...current, versionKey: event.target.value.replace(/[^\d_]/g, '') } : current)} className={`w-full rounded-lg border px-3 py-2.5 font-mono text-sm outline-none ${progressVersionIsValid(progressSetup) ? 'border-slate-300 focus:border-blue-500' : 'border-red-300 focus:border-red-500'}`} placeholder={progressSetup.relation === 'root' ? '例如 2' : '例如 1_2'}/></div><span className={`mt-1.5 block text-xs ${progressVersionIsValid(progressSetup) ? 'text-slate-400' : 'text-red-500'}`}>{progressVersionIsValid(progressSetup) ? '已根据版本关系给出建议值，你可以改成实际版本。' : progressSetup.relation === 'root' ? '主版本只能填写未使用的数字，例如 1、2、3。' : '分支编号必须属于所选父版本且未被使用，例如 1_2。'}</span></label>
          <label className="block"><span className="mb-1.5 block text-sm font-bold text-slate-700">进度名字 <span className="font-normal text-slate-400">（可留空）</span></span><input autoFocus value={progressSetup.progressName} onChange={event => setProgressSetup(current => current ? { ...current, progressName: event.target.value } : current)} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500" placeholder="例如：调色"/><span className="mt-1.5 block text-xs text-slate-400">留空时只使用进度类型和版本编号，例如“图片后期_1”。</span></label>
          <section className={`rounded-xl border p-4 ${progressNameHasConflict(progressSetup) ? 'border-red-200 bg-red-50' : 'border-blue-100 bg-blue-50'}`}><span className={`block text-xs font-bold ${progressNameHasConflict(progressSetup) ? 'text-red-500' : 'text-blue-500'}`}>{progressSetup.mode === 'mark' ? '文件夹将重命名为' : '文件夹将创建为'}</span><span className={`mt-1 block break-all font-mono text-sm font-bold ${progressNameHasConflict(progressSetup) ? 'text-red-700' : 'text-blue-800'}`}>{progressSetup.versionKey ? buildProgressFolderName(progressSetup.mediaKind, progressSetup.versionKey, progressSetup.progressName) : '填写版本编号后生成'}</span>{progressNameHasConflict(progressSetup) && <span className="mt-2 block text-xs text-red-600">已有同名进度，请修改版本编号或进度名字。</span>}</section>
          {progressSetup.mode !== 'create' && <section className="space-y-3 rounded-xl border border-slate-200 p-4"><label className="flex cursor-pointer items-start gap-3"><input type="checkbox" className="mt-0.5" checked={progressSetup.trackingEnabled} onChange={event => setProgressSetup(current => current ? { ...current, trackingEnabled: event.target.checked, renameSources: event.target.checked ? current.renameSources : false, copyMissingFromParent: event.target.checked ? current.copyMissingFromParent : false } : current)}/><span><span className="block text-sm font-bold text-slate-700">开启项目跟踪</span><span className="mt-1 block text-xs leading-5 text-slate-500">{progressSetup.mode === 'mark' ? '标记后自动和上一个版本进行视觉哈希比对，并让你确认继承关系；关闭时只登记进度。' : '导入后自动和上一个版本进行视觉哈希比对，并让你确认继承关系；关闭时只导入文件。'}</span></span></label><label className={`flex items-start gap-3 ${progressSetup.trackingEnabled && progressParentIsAvailable(progressSetup) ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'}`}><input type="checkbox" className="mt-0.5" disabled={!progressSetup.trackingEnabled || !progressParentIsAvailable(progressSetup)} checked={progressSetup.renameSources && progressParentIsAvailable(progressSetup)} onChange={event => setProgressSetup(current => current ? { ...current, renameSources: event.target.checked } : current)}/><span><span className="block text-sm font-bold text-slate-700">确定版本关系后，同步重命名新版本的文件名</span><span className="mt-1 block text-xs leading-5 text-slate-500">{progressParentIsAvailable(progressSetup) ? '只重命名确认继承的文件；文件扩展名不变，新素材保留原名。' : '当前没有可用的上一个版本，因此无法选择。'}</span></span></label><label className={`flex items-start gap-3 ${progressSetup.trackingEnabled && progressParentIsAvailable(progressSetup) ? 'cursor-pointer' : 'cursor-not-allowed opacity-45'}`}><input type="checkbox" className="mt-0.5" disabled={!progressSetup.trackingEnabled || !progressParentIsAvailable(progressSetup)} checked={progressSetup.copyMissingFromParent && progressParentIsAvailable(progressSetup)} onChange={event => setProgressSetup(current => current ? { ...current, copyMissingFromParent: event.target.checked } : current)}/><span><span className="block text-sm font-bold text-slate-700">复制当前版本中没有、但上一版本中存在的媒体文件</span><span className="mt-1 block text-xs leading-5 text-slate-500">{progressParentIsAvailable(progressSetup) ? `确认版本关系后，从 _${progressFolders.find(folder => folder.id === progressSetup.parentProgressId)?.versionKey} 复制缺失媒体；不会覆盖同名文件。` : '当前没有可用的上一个版本，因此无法选择。'}</span></span></label></section>}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4"><button type="button" onClick={() => setProgressSetup(null)} disabled={progressSubmitting} className="dialog-secondary">取消</button><button type="button" onClick={() => void submitProgressSetup()} disabled={progressSubmitting || !progressVersionIsValid(progressSetup) || progressNameHasConflict(progressSetup)} className="dialog-primary inline-flex items-center gap-2">{progressSubmitting && <Loader2 size={15} className="animate-spin"/>}{progressSetup.mode === 'create' ? '创建文件夹' : progressSetup.mode === 'import' ? '选择文件并导入' : progressSetup.existingProgressId ? '保存进度修改' : '标记当前文件夹'}</button></footer>
      </div></div>}
      {progressCompare && <div role="dialog" aria-modal="true" aria-label="确认版本关系" className="fixed inset-0 z-[345] flex items-center justify-center bg-slate-950/50 p-4"><div className="flex h-[min(92vh,820px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-5 py-4"><h3 className="text-lg font-bold text-slate-800">确认版本关系</h3><p className="mt-1 text-xs text-slate-500">_{progressCompare.parentFolder.versionKey} “{progressCompare.parentFolder.displayName}” → _{progressCompare.progressFolder.versionKey} “{progressCompare.progressFolder.displayName}”</p></header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.85fr)_minmax(0,1.65fr)] gap-4 overflow-hidden p-5">
          <div className="flex min-h-0 flex-col"><div className="mb-3 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-blue-50 px-2.5 py-1 text-blue-700">识别匹配 {progressCompare.matches.length}</span><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">已选继承 {progressCompare.acceptedSources.length}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">新素材 {progressCompare.unmatchedSources.length + progressCompare.matches.length - progressCompare.acceptedSources.length}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">旧版未返回 {progressCompare.unmatchedReferences.length}</span></div>
            {progressCompare.matches.length ? <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-200">{progressCompare.matches.map(match => { const accepted = progressCompare.acceptedSources.includes(match.source); const activeMatch = activeProgressCompareSource === match.source; return <div key={match.source} role="button" tabIndex={0} onClick={() => setActiveProgressCompareSource(match.source)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveProgressCompareSource(match.source); } }} className={`grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 py-2.5 text-xs last:border-0 ${activeMatch ? 'border-blue-100 bg-blue-50 ring-1 ring-inset ring-blue-300' : 'border-slate-100 hover:bg-slate-50'}`}><input type="checkbox" checked={accepted} aria-label={`将 ${match.source} 作为继承版本`} onClick={event => event.stopPropagation()} onChange={() => setProgressCompare(current => current ? { ...current, acceptedSources: accepted ? current.acceptedSources.filter(source => source !== match.source) : [...current.acceptedSources, match.source] } : current)}/><span className="min-w-0"><span className="block truncate font-medium text-slate-700" title={match.source}>当前 · {match.source}</span><span className="mt-1 block truncate text-slate-400" title={match.reference}>上一版 · {match.reference}</span></span><span className={`rounded-full px-2 py-0.5 font-bold ${match.confidence === '高' ? 'bg-emerald-50 text-emerald-600' : match.confidence === '中' ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-500'}`}>{match.confidence}</span></div>; })}</div> : <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">没有识别到继承关系。确认后，新版本中的文件都会作为新素材建立跟踪。</p>}
            {progressCompare.renameSources && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">确认后，会把已勾选的新版本文件同步改为继承自上一版本的名称。</p>}
            {progressCompare.copyMissingFromParent && <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">确认后，会从上一版本复制当前缺失的 {progressCompare.unmatchedReferences.length} 个媒体文件，并将它们登记为继承版本。</p>}
          </div>
          <ProgressPairPreview match={progressCompare.matches.find(match => match.source === activeProgressCompareSource)} parentFolder={progressCompare.parentFolder} progressFolder={progressCompare.progressFolder} cacheConfig={mediaCacheConfig}/>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><button type="button" onClick={() => void disableProgressTracking()} disabled={progressSubmitting} className="dialog-secondary">{progressCompare.sourceMode === 'mark' ? '只标记进度，不开启跟踪' : '保留导入，但不开启跟踪'}</button><button type="button" onClick={() => void commitProgressCompare()} disabled={progressSubmitting} className="dialog-primary inline-flex items-center gap-2">{progressSubmitting && <Loader2 size={15} className="animate-spin"/>}确认并建立跟踪</button></footer>
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
      {versionEntry && <VersionManager entry={versionEntry} workspacePath={workspacePath} project={project} cacheConfig={mediaCacheConfig} onNotice={onNotice} onVersionStateChanged={() => { void loadFinalVersionSummary(); if (finalViewOpen) void loadFinalViewEntries(); }} onClose={() => { setVersionEntry(null); void loadFinalVersionSummary(); if (finalViewOpen) void loadFinalViewEntries(); }}/>} 
      {teamRetouchAvailable && teamRetouchEntries.length > 0 && <TeamRetouchManager entries={teamRetouchEntries} workspacePath={workspacePath} project={project} cacheConfig={mediaCacheConfig} onNotice={onNotice} onClose={() => setTeamRetouchEntries([])}/>}

      <section className="flex min-h-[220px] min-w-0 flex-auto flex-col">
        <div ref={filesSurfaceRef} data-photoflow-file-surface="true" tabIndex={0} onContextMenu={openSurfaceMenu} onPointerDownCapture={event => (event.target as HTMLElement).closest<HTMLElement>('[data-entry-path]')?.focus({ preventScroll: true })} onPointerDown={startSelectionDrag} onPointerMove={updateSelectionDrag} onPointerUp={finishSelectionDrag} onPointerCancel={finishSelectionDrag} onDragOver={handleSurfaceDragOver} onDragLeave={handleSurfaceDragLeave} onDrop={event => void handleSurfaceDrop(event)} className={`relative -mx-6 min-h-[220px] flex-1 select-none px-6 outline-none transition ${surfaceDropActive ? 'rounded-lg bg-blue-50 ring-2 ring-inset ring-blue-400' : ''}`}>
          {selectionBox && <div className="pointer-events-none absolute z-20 border border-blue-500 bg-blue-400/15" style={selectionBox}/>}
          {displayedFileEntries.length ? viewMode === 'list' ? <div className="min-w-[620px] border-y border-slate-200 text-sm">
            <div className="file-list-row file-list-heading text-xs font-medium text-slate-500"><span>名称</span><span>修改日期</span><span>类型</span><span>大小</span></div>
            {virtualWindow.top > 0 && <div aria-hidden style={{ height: virtualWindow.top }} />}
            {renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`file-list-row group w-full cursor-default border-t border-slate-200 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-inset ring-blue-500' : ''}`}>
              <span className="flex min-w-0 items-center gap-2.5"><span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-select-box ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white text-transparent'} flex h-4 w-4 shrink-0 items-center justify-center rounded border`}><CheckSquare size={12}/></span><span className="relative flex h-9 w-11 shrink-0 items-center justify-center overflow-hidden">{renderEntryIcon(entry)}</span>{renderEntryName(entry)}</span>
              <span className="text-slate-500">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '…'}</span>
              <span className="uppercase text-slate-500">{entry.kind === 'folder' ? '文件夹' : entry.kind === 'raw' ? `RAW · ${entry.extension.slice(1)}` : entry.kind === 'video' ? `视频 · ${entry.extension.slice(1)}` : entry.extension.slice(1) || '文件'}</span>
              <span className="text-slate-500">{entry.kind === 'folder' ? '' : entry.size >= 0 ? formatFileSize(entry.size) : '…'}</span>
            </div>)}
            {virtualWindow.bottom > 0 && <div aria-hidden style={{ height: virtualWindow.bottom }} />}
          </div> : <><div aria-hidden style={{ height: virtualWindow.top }}/><div className="grid w-full content-start gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridIconSize}px), 1fr))` }}>{renderedFileEntries.map(entry => <div role="button" tabIndex={0} draggable={inlineRenamePath !== entry.relativePath} onDragStart={event => startEntryDrag(event, entry)} onDragOver={event => handleEntryDragOver(event, entry)} onDragLeave={event => handleEntryDragLeave(event, entry)} onDrop={event => void handleEntryDrop(event, entry)} data-entry-kind={entry.kind} data-entry-path={entry.relativePath} key={entry.path} onMouseEnter={() => prefetchDirectory(entry)} onClick={event => handleEntryClick(event, entry)} onDoubleClick={event => handleEntryDoubleClick(event, entry)} onKeyDown={event => { if (event.key === 'Enter') handleEntryClick(event, entry); }} onContextMenu={event => openFileMenu(event, entry)} title={entry.name} className={`group relative min-w-0 cursor-default overflow-hidden rounded-lg p-2 text-left transition hover:bg-blue-50 ${selectedPaths.includes(entry.relativePath) || previewPath === entry.relativePath ? 'bg-blue-50 ring-1 ring-blue-400' : ''} ${cutPaths.includes(entry.relativePath) ? 'opacity-45' : ''} ${dragTargetPath === entry.relativePath ? 'bg-blue-100 ring-2 ring-blue-500' : ''}`}><span onClick={event => { event.stopPropagation(); if (event.shiftKey) selectEntryRange(entry.relativePath, event.ctrlKey || event.metaKey); else toggleSelected(entry.relativePath); }} className={`file-grid-select ${selectedPaths.includes(entry.relativePath) ? 'is-selected border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white/90 text-transparent'} absolute left-3 top-3 z-10 flex h-4 w-4 items-center justify-center rounded border`}><CheckSquare size={12}/></span><div className="relative flex aspect-square items-center justify-center">{renderEntryIcon(entry, true)}</div>{renderEntryName(entry, true)}<p className="mt-0.5 text-[10px] uppercase text-slate-400">{entry.kind === 'folder' ? '文件夹' : entry.extension.slice(1) || '文件'}</p></div>)}</div><div aria-hidden style={{ height: virtualWindow.bottom }}/></> : <p className="border-y border-slate-200 py-12 text-center text-sm text-slate-400">{searchQuery ? `没有找到包含“${searchQuery}”的文件。` : '当前文件夹为空。'}</p>}
        </div>
      </section>

      <section className="hidden rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-slate-800">项目文件夹</h3><span className="text-sm text-slate-500">{folders.length} 个</span></div>
        {folders.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{folders.map(folder => <button key={folder.path} onClick={() => openFolder(folder.name)} title={`打开 ${folder.name}`} className="group flex flex-col items-center gap-2 rounded-lg p-3 text-center transition hover:bg-blue-50"><Folder size={64} strokeWidth={1.5} fill="currentColor" className="text-blue-500 drop-shadow-sm transition-transform group-hover:scale-105"/><span className="max-w-full truncate text-sm font-medium text-slate-700">{folder.name}</span></button>)}</div> : <p className="py-8 text-center text-sm text-slate-400">当前项目还没有子文件夹。</p>}
      </section>

      </div>
      {previewPaneOpen && <><ColumnResizeHandle label="调整文件区和预览区宽度" onDrag={resizeFilesAndPreview}/><MediaPreviewPane entry={previewEntry} cacheConfig={mediaCacheConfig} width={displayedColumnWidths.preview} photoshopAvailable={photoshopAvailable} finalVersionAvailable={previewCanMarkFinal} finalVersion={previewVersion} finalVersionLoading={previewVersionLoading} finalVersionBusy={previewVersionBusy} onToggleFinal={() => void togglePreviewFinalVersion()} onTechnicalMetadata={setPreviewTechnicalMetadata} onContextMenu={event => previewEntry && openFileMenu(event, previewEntry, false)} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onOpenInPhotoshop={() => previewEntry && openProjectEntriesInPhotoshop([previewEntry])} onClose={() => setPreviewPaneOpen(false)}/></>}
      {metadataPaneOpen && <><ColumnResizeHandle label={previewPaneOpen ? '调整预览区和详细信息区宽度' : '调整文件区和详细信息区宽度'} onDrag={previewPaneOpen ? resizePreviewAndMetadata : resizeFilesAndMetadata}/><FileMetadataPane entry={previewEntry} entryDetails={previewEntryDetails} metadataFields={currentPreviewMetadataFields} metadataLoading={currentPreviewMetadataLoading} metadataError={currentPreviewMetadataError} technicalMetadata={previewTechnicalMetadata} formatFileSize={formatFileSize} width={displayedColumnWidths.metadata} onOpen={() => previewEntry && openProjectEntry(previewEntry)} onCopyPath={() => previewEntry && copyEntryPath(previewEntry)} onClose={() => setMetadataPaneOpen(false)}/></>}
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

const MediaPreviewPane = ({ entry, cacheConfig, width, photoshopAvailable, finalVersionAvailable, finalVersion, finalVersionLoading, finalVersionBusy, onToggleFinal, onTechnicalMetadata, onContextMenu, onOpen, onOpenInPhotoshop, onClose }: {
  entry?: ProjectFileEntry;
  cacheConfig: AppConfig['mediaCache'];
  width: number;
  photoshopAvailable: boolean;
  finalVersionAvailable: boolean;
  finalVersion: MediaVersion | null;
  finalVersionLoading: boolean;
  finalVersionBusy: boolean;
  onToggleFinal: () => void;
  onTechnicalMetadata: (metadata: PreviewTechnicalMetadata) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onOpen: () => void;
  onOpenInPhotoshop: () => void;
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
  const [fullscreen, setFullscreen] = useState(false);
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
        window.electronAPI.reportRendererError('Original image preview failed', `${entry.path}: ${result.error || 'unknown error'}`);
        return;
      }
      originalImage = new Image();
      originalImage.onload = () => {
        if (!active) return;
        window.clearTimeout(loadingTimer);
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
        setOriginalLoading(false);
        setOriginalLoadError('原图解码失败，当前显示预览图');
        window.electronAPI.reportRendererError('Original image decode failed', `${entry.path}: ${result.mediaUrl}`);
      };
      originalImage.src = result.mediaUrl;
    }).catch(error => {
      window.clearTimeout(loadingTimer);
      if (active) {
        setOriginalLoading(false);
        setOriginalLoadError('原图加载失败，当前显示预览图');
        window.electronAPI.reportRendererError('Original image preview request failed', `${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
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
  }, [displayedImageUrl, entry?.kind, fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const exitFullscreen = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setFullscreen(false);
    };
    window.addEventListener('keydown', exitFullscreen, true);
    return () => window.removeEventListener('keydown', exitFullscreen, true);
  }, [fullscreen]);

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
  const handleVideoPlaybackError = () => {
    if (!entry || entry.kind !== 'video') return;
    setPlaybackFailed(true);
    setLoading(false);
    onTechnicalMetadata({ unavailable: true });
  };

  const previewPane = <section onContextMenu={onContextMenu} style={fullscreen ? undefined : { width }} className={`flex min-h-0 shrink-0 flex-col bg-slate-50 ${fullscreen ? 'fixed inset-x-0 bottom-0 top-10 z-40 w-screen' : ''}`}>
    <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
      <div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">预览</p><p className="truncate text-sm font-semibold text-slate-700">{entry?.name || '未选择媒体'}</p></div>
      <div className="flex items-center gap-1">{entry && <>{(finalVersionAvailable || finalVersion) && <button type="button" disabled={finalVersionLoading || finalVersionBusy || !finalVersion || finalVersion.fileMissing} onClick={onToggleFinal} title={finalVersion?.isFinal ? '取消标记最终版' : finalVersionLoading ? '正在读取最终版状态' : '标记为最终版'} className={`group min-w-[96px] rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition hover:!border-red-300 hover:!bg-red-50 hover:!text-red-700 disabled:opacity-40 ${finalVersion?.isFinal ? 'border-red-200 bg-red-50 text-red-600' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>{finalVersionBusy ? '处理中…' : finalVersionLoading ? '读取最终版状态…' : finalVersion?.isFinal ? <><span className="group-hover:hidden">已标记最终版</span><span className="hidden group-hover:inline">取消标记最终版</span></> : '标记为最终版'}</button>}{!fullscreen && <button type="button" onClick={() => setFullscreen(true)} title="全屏查看预览图" aria-label="全屏查看预览图" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Maximize2 size={16}/></button>}{photoshopAvailable && entry.kind === 'image' && <button type="button" onClick={onOpenInPhotoshop} title="使用 Photoshop 打开" aria-label="使用 Photoshop 打开" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><PhotoshopIcon size={16}/></button>}<button type="button" onClick={onOpen} title="使用系统默认应用打开" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><ExternalLink size={16}/></button></>}{fullscreen ? <button type="button" onClick={() => setFullscreen(false)} title="缩小预览（Esc）" aria-label="缩小预览" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Minimize2 size={16}/></button> : <button type="button" onClick={onClose} title="关闭预览" aria-label="关闭预览" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button>}</div>
    </header>
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-slate-50">
      {!entry && <div className="max-w-[220px] text-center"><ImageIcon size={38} strokeWidth={1.4} className="mx-auto text-slate-600"/><p className="mt-3 text-sm font-medium text-slate-300">点击图片、RAW 或视频文件</p><p className="mt-1 text-xs leading-5 text-slate-500">此处会显示大图或轻量视频预览</p></div>}
      {entry && entry.kind === 'video' && resource.mediaUrl && !playbackFailed && <video key={resource.mediaUrl} controls preload="metadata" poster={resource.previewUrl} className="max-h-full max-w-full bg-black" onLoadedMetadata={event => { setLoading(false); onTechnicalMetadata({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight, duration: event.currentTarget.duration }); }} onError={handleVideoPlaybackError}><source src={resource.mediaUrl}/></video>}
      {entry && entry.kind === 'video' && (!resource.mediaUrl || playbackFailed) && <div className="flex max-h-full w-full flex-col items-center justify-center gap-4 text-center">{resource.previewUrl ? <img src={resource.previewUrl} alt={entry.name} draggable={false} className="max-h-[70%] max-w-full object-contain"/> : <Video size={52} strokeWidth={1.3} className="text-slate-600"/>}<div className="max-w-sm px-6"><p className="text-sm font-medium text-slate-700">{resource.importedVideoWithoutPreview ? '此导入视频没有软件内快速预览' : playbackFailed ? resource.usingImportedPreview ? '导入的视频预览无法播放' : '当前原始编码无法在应用内播放' : loading ? '正在准备视频预览…' : resource.previewUrl ? '视频封面已就绪' : '没有可用的视频封面'}</p>{resource.importedVideoWithoutPreview && <p className="mt-1 text-xs leading-5 text-slate-500">请在导入设置中开启“生成视频预览”。浏览时不会为这类大型导入视频临时转码。</p>}{playbackFailed && !resource.importedVideoWithoutPreview && <p className="mt-1 text-xs leading-5 text-slate-500">可以使用系统默认播放器打开原文件。</p>}<button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button></div></div>}
      {entry && entry.kind !== 'video' && displayedImageUrl && (
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
      {entry && entry.kind !== 'video' && displayedImageUrl && <button type="button" onClick={resetImageZoom} title="恢复适合窗口" className="absolute bottom-4 right-4 rounded-md bg-slate-900/75 px-2 py-1 font-mono text-[11px] text-slate-200 shadow-lg">{Math.round(imageZoom * 100)}%</button>}
      {entry && entry.kind !== 'video' && !displayedImageUrl && !loading && <div className="text-center"><FileImage size={48} strokeWidth={1.3} className="mx-auto text-slate-600"/><p className="mt-3 text-sm text-slate-400">无法生成此文件的预览</p><button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"><ExternalLink size={14}/>外部打开</button></div>}
      {entry && loading && <span className="absolute right-4 top-4 rounded-full bg-slate-900/80 p-2 text-slate-300"><Loader2 size={17} className="animate-spin"/></span>}
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
  useThumbnailUpdates(entry.path, requestedSize, (state, nextUrl) => {
    if (state === 'READY' && nextUrl) setUrl(nextUrl);
  });
  useEffect(() => {
    let active = true;
    window.electronAPI.getMediaThumbnail(entry.path, entry.kind as 'image' | 'raw' | 'video', cacheConfig, requestedSize, 2, queueOrder)
      .then(result => { if (active && result.previewUrl) setUrl(result.previewUrl); });
    return () => { active = false; };
  }, [entry.path, entry.kind, cacheConfig.directory, cacheConfig.maxSizeGB, requestedSize, queueOrder]);
  return url
    ? <img src={url} alt="" draggable={false} className="h-full w-full object-cover"/>
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
  const [preview, setPreview] = useState<{ url?: string; size: number }>({ url: entry.previewUrl, size: entry.previewUrl ? 320 : 0 });
  const [videoUrl, setVideoUrl] = useState<string>();
  const [videoActivated, setVideoActivated] = useState(false);
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoTime, setVideoTime] = useState(0);
  const [hovering, setHovering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hoverRatioRef = useRef(0);
  const hoverSeekFrameRef = useRef<number>();
  const thumbnailRequestRef = useRef<{ key: string; promoted: boolean; promise: ReturnType<typeof window.electronAPI.getMediaThumbnail> }>();
  useThumbnailUpdates(entry.path, requestedSize, (state, url) => {
    if (state === 'READY') {
      if (url) setPreview({ url, size: requestedSize });
      setLoading(false);
    } else if (state === 'FAILED' || state === 'MISSING') {
      setLoading(false);
    }
  });
  const requestTileThumbnail = (priority: 0 | 1) => {
    const key = `${entry.path}|${requestedSize}`;
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
  useEffect(() => () => { void window.electronAPI.cancelMediaThumbnail(entry.path, requestedSize); }, [entry.path, requestedSize]);
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
          if (result.previewUrl) setPreview({ url: result.previewUrl, size: requestedSize });
          captureVideoResource(result);
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
      void requestTileThumbnail(0).then(captureVideoResource);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [entry.kind, entry.path, cacheConfig, requestedSize, queueOrder]);
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
  return <span ref={container} onMouseEnter={() => setHovering(true)} onMouseLeave={handleMouseLeave} className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black/5">
    {showVideo
      ? <video ref={videoRef} src={videoUrl} muted playsInline preload="auto" poster={preview.url} className="h-full w-full object-contain" onLoadedMetadata={event => { setVideoDuration(event.currentTarget.duration); setLoading(false); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={restartHoverPlayback} onError={() => { setPlaybackFailed(true); setPlaying(false); setLoading(false); }}/>
      : preview.url ? <img src={preview.url} alt="" draggable={false} className="h-full w-full object-contain"/> : <FileImage size={large ? 42 : 23} className="text-slate-400"/>}
    {loading && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-900/25"><Loader2 size={large ? 24 : 16} className="animate-spin text-white drop-shadow"/><span className="sr-only">正在加载预览</span></span>}
    {entry.kind === 'video' && !playing && <Play size={large ? 25 : 15} fill="currentColor" className="pointer-events-none absolute text-white drop-shadow-[0_1px_4px_rgba(0,0,0,.8)]"/>}
    {entry.kind === 'video' && showVideo && hovering && videoDuration > 0 && <span className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-black/20 px-2 pb-1.5 pt-3" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <input type="range" min="0" max={videoDuration} step="0.05" value={Math.min(videoTime, videoDuration)} onChange={seekVideo} aria-label={`调整 ${entry.name} 的播放进度`} className="video-hover-seek min-w-0 flex-1" style={{ '--seek-progress': `${progress}%` } as React.CSSProperties}/>
    </span>}
  </span>;
};

export { ProjectWorkspace };
