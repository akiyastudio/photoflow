import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  FolderSearch,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import type { AppConfig, MediaMetadataField, MediaVersion, MediaVersionBundle, ProjectFileEntry, WorkspaceProject } from '../types';
import { useAppDialog } from './AppDialogProvider';

type VersionManagerProps = {
  entry: ProjectFileEntry;
  workspacePath: string;
  project: WorkspaceProject;
  cacheConfig: AppConfig['mediaCache'];
  onClose: () => void;
  onNotice: (message: string) => void;
  onVersionStateChanged?: () => void;
};

const formatSize = (size: number) => size < 1024 * 1024
  ? `${Math.max(1, Math.round(size / 1024))} KB`
  : size < 1024 * 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
const visibleVersionName = (version: Pick<MediaVersion, 'versionName'>) => version.versionName.replace(/^R\d+\s*·\s*/i, '');
const visibleVersionNote = (note: string) => note.replace(/返修批次 R\d+/gi, '进度版本');
const normalizeVisibleVersionBundle = (bundle: MediaVersionBundle): MediaVersionBundle => ({
  ...bundle,
  versions: bundle.versions.map(version => ({
    ...version,
    versionName: visibleVersionName(version),
    note: visibleVersionNote(version.note),
  })),
});

const mediaKind = (filePath: string): 'image' | 'raw' | 'video' => {
  const extension = filePath.split('.').pop()?.toLocaleLowerCase() || '';
  if (['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'].includes(extension)) return 'video';
  if (['cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'dng', 'rwl', '3fr', 'fff', 'iiq', 'pef', 'srw'].includes(extension)) return 'raw';
  return 'image';
};

type VersionResourceData = { url?: string; videoUrl?: string };
const versionResourceCache = new Map<string, VersionResourceData>();
const versionResourceRequests = new Map<string, Promise<VersionResourceData>>();
const versionResourceCacheKey = (version: MediaVersion) => `${version.filePath.replace(/\\/g, '/').toLocaleLowerCase()}|${version.fileModifiedAt || 0}|${version.fileSize}`;
const loadVersionResource = (version: MediaVersion, cacheConfig: AppConfig['mediaCache']) => {
  const key = versionResourceCacheKey(version);
  const cached = versionResourceCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = versionResourceRequests.get(key);
  if (pending) return pending;
  const kind = mediaKind(version.filePath);
  const request = window.electronAPI.getMediaThumbnail(version.filePath, kind, cacheConfig, 1600, 0, -1).then(async result => {
    if (!result.success) return {};
    let url = result.previewUrl;
    if (kind !== 'video') {
      const original = await window.electronAPI.getMediaOriginal(version.filePath, kind, cacheConfig);
      if (original.success && original.mediaUrl) url = original.mediaUrl;
    }
    const resource = { url, videoUrl: result.mediaUrl };
    if (versionResourceCache.size >= 80) versionResourceCache.delete(versionResourceCache.keys().next().value as string);
    versionResourceCache.set(key, resource);
    return resource;
  }).catch(() => ({})).finally(() => versionResourceRequests.delete(key));
  versionResourceRequests.set(key, request);
  return request;
};

const VersionResource = ({ version, cacheConfig, className = '', contentStyle }: { version: MediaVersion; cacheConfig: AppConfig['mediaCache']; className?: string; contentStyle?: React.CSSProperties }) => {
  const resourceKey = versionResourceCacheKey(version);
  const [resource, setResource] = useState<VersionResourceData>(() => versionResourceCache.get(resourceKey) || {});
  const [loading, setLoading] = useState(false);
  const kind = mediaKind(version.filePath);
  useEffect(() => {
    let active = true;
    const cached = versionResourceCache.get(resourceKey);
    setResource(cached || {});
    if (version.fileMissing) return () => { active = false; };
    if (cached) {
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    loadVersionResource(version, cacheConfig).then(result => { if (active) setResource(result); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [resourceKey, version.fileMissing, cacheConfig.directory, cacheConfig.maxSizeGB]);

  if (version.fileMissing) return <div className={`flex items-center justify-center bg-slate-100 text-slate-400 ${className}`}><AlertTriangle size={26}/></div>;
  if (kind === 'video' && resource.videoUrl) return <video controls preload="metadata" poster={resource.url} style={contentStyle} className={`bg-black object-contain ${className}`}><source src={resource.videoUrl}/></video>;
  return <div className={`relative flex items-center justify-center overflow-hidden bg-slate-100 ${className}`}>
    {resource.url ? <img src={resource.url} alt={version.versionName} draggable={false} style={contentStyle} className="h-full w-full object-contain"/> : <ImageIcon size={28} className="text-slate-400"/>}
    {loading && <span className="absolute rounded-full bg-slate-900/70 p-2 text-white"><Loader2 size={16} className="animate-spin"/></span>}
  </div>;
};

const CompareView = ({ left, right, cacheConfig, workspacePath, photoId, onClose }: {
  left: MediaVersion;
  right: MediaVersion;
  cacheConfig: AppConfig['mediaCache'];
  workspacePath: string;
  photoId: string;
  onClose: () => void;
}) => {
  const [mode, setMode] = useState<'side-by-side' | 'split' | 'overlay' | 'blink' | 'difference'>('side-by-side');
  const [split, setSplit] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const [blinkRight, setBlinkRight] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [coordinates, setCoordinates] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  useEffect(() => {
    void window.electronAPI.recordMediaVersionCompare(workspacePath, { photoId, leftVersionId: left.id, rightVersionId: right.id, compareMode: mode });
  }, [mode, left.id, right.id, photoId, workspacePath]);
  useEffect(() => {
    if (mode !== 'blink') return;
    const timer = window.setInterval(() => setBlinkRight(value => !value), 550);
    return () => window.clearInterval(timer);
  }, [mode]);
  const layerClass = 'absolute inset-0 h-full w-full';
  const viewStyle: React.CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
    transformOrigin: 'center',
    transition: dragRef.current ? 'none' : 'transform 120ms ease-out',
  };
  const resetView = () => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); };
  return <div className="flex h-full min-h-[520px] flex-col overflow-hidden bg-slate-950 text-white">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2"><div className="mr-3 min-w-0"><h3 className="font-bold">版本对比</h3><p className="truncate text-xs text-slate-400">V{left.versionNumber} {visibleVersionName(left)} ↔ V{right.versionNumber} {visibleVersionName(right)}</p></div>{([['side-by-side', '并排'], ['split', '滑动分割'], ['overlay', '透明叠加'], ['blink', '闪烁'], ['difference', '差异']] as const).map(([value, label]) => <button key={value} onClick={() => setMode(value)} className={`rounded-md px-3 py-1.5 text-xs font-bold ${mode === value ? 'bg-blue-600 text-white' : 'bg-white/10 text-slate-300 hover:bg-white/15'}`}>{label}</button>)}<div className="ml-auto flex items-center gap-2"><button onClick={() => setRotation(value => (value + 90) % 360)} className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15">旋转 {rotation}°</button><button onClick={resetView} className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15">重置视图</button><span className="text-xs text-slate-400">缩放</span><input type="range" min="1" max="4" step="0.1" value={zoom} onChange={event => setZoom(Number(event.target.value))}/><button onClick={onClose} className="rounded p-2 hover:bg-white/10"><X size={18}/></button></div></header>
    {(mode === 'split' || mode === 'overlay') && <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2 text-xs text-slate-300"><span>{mode === 'split' ? '分割位置' : '右侧透明度'}</span><input className="w-64" type="range" min="0" max="100" value={mode === 'split' ? split : opacity} onChange={event => mode === 'split' ? setSplit(Number(event.target.value)) : setOpacity(Number(event.target.value))}/><span className="font-mono">{mode === 'split' ? split : opacity}%</span></div>}
    <main className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-black active:cursor-grabbing" onWheel={event => { event.preventDefault(); setZoom(value => Math.max(1, Math.min(4, Number((value * (event.deltaY < 0 ? 1.15 : 1 / 1.15)).toFixed(2))))); }} onDoubleClick={resetView} onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }; }} onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); setCoordinates({ x: Math.round(event.clientX - rect.left), y: Math.round(event.clientY - rect.top) }); const drag = dragRef.current; if (drag?.pointerId === event.pointerId) setPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY }); }} onPointerUp={event => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
      <div className="relative h-full min-h-[420px] w-full">
        {mode === 'side-by-side' ? <div className="grid h-full grid-cols-2 gap-px bg-white/15"><div className="relative min-w-0"><VersionResource version={left} cacheConfig={cacheConfig} contentStyle={viewStyle} className="h-full w-full"/><span className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs">A · V{left.versionNumber}</span></div><div className="relative min-w-0"><VersionResource version={right} cacheConfig={cacheConfig} contentStyle={viewStyle} className="h-full w-full"/><span className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs">B · V{right.versionNumber}</span></div></div> : <>
          <VersionResource version={left} cacheConfig={cacheConfig} contentStyle={viewStyle} className={layerClass}/>
          {mode === 'split' && <div className={layerClass} style={{ clipPath: `inset(0 0 0 ${split}%)` }}><VersionResource version={right} cacheConfig={cacheConfig} contentStyle={viewStyle} className="h-full w-full"/></div>}
          {mode === 'split' && <span className="absolute bottom-0 top-0 z-10 w-px bg-white shadow" style={{ left: `${split}%` }}/>} 
          {mode === 'overlay' && <div className={layerClass} style={{ opacity: opacity / 100 }}><VersionResource version={right} cacheConfig={cacheConfig} contentStyle={viewStyle} className="h-full w-full"/></div>}
          {mode === 'blink' && blinkRight && <VersionResource version={right} cacheConfig={cacheConfig} contentStyle={viewStyle} className={layerClass}/>} 
          {mode === 'difference' && <div className={`${layerClass} mix-blend-difference`}><VersionResource version={right} cacheConfig={cacheConfig} contentStyle={viewStyle} className="h-full w-full"/></div>}
        </>}
      </div>
      <span className="pointer-events-none absolute bottom-3 right-3 rounded bg-black/65 px-2 py-1 font-mono text-[11px] text-slate-300">x {coordinates.x} · y {coordinates.y} · {Math.round(zoom * 100)}%</span>
    </main>
  </div>;
};

const SingleVersionView = ({ version, cacheConfig, busy, onClose, onNotice, onToggleFinal, onEditNote, onMakeCurrent, onRelocate, onDelete }: {
  version: MediaVersion;
  cacheConfig: AppConfig['mediaCache'];
  busy: boolean;
  onClose: () => void;
  onNotice: (message: string) => void;
  onToggleFinal: () => void;
  onEditNote: () => void;
  onMakeCurrent: () => void;
  onRelocate: () => void;
  onDelete: () => void;
}) => {
  const [metadataFields, setMetadataFields] = useState<MediaMetadataField[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [metadataWidth, setMetadataWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('photoflow:version-metadata-width'));
    return Number.isFinite(stored) && stored >= 260 && stored <= 560 ? stored : 340;
  });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const metadataResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const fileName = version.filePath.replace(/\\/g, '/').split('/').pop() || version.versionName;

  useEffect(() => {
    let active = true;
    setMetadataFields([]);
    setMetadataError('');
    setZoom(1);
    setPan({ x: 0, y: 0 });
    if (version.fileMissing) return () => { active = false; };
    setMetadataLoading(true);
    window.electronAPI.getMediaMetadata(version.filePath).then(result => {
      if (!active) return;
      if (!result.success) setMetadataError(result.error || '无法读取完整详细信息');
      else setMetadataFields(result.fields);
    }).finally(() => { if (active) setMetadataLoading(false); });
    return () => { active = false; };
  }, [version.id, version.filePath, version.fileModifiedAt, version.fileMissing]);
  useEffect(() => window.localStorage.setItem('photoflow:version-metadata-width', String(Math.round(metadataWidth))), [metadataWidth]);
  useEffect(() => {
    if (!fullscreen) return;
    const exitFullscreen = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', exitFullscreen, true);
    return () => window.removeEventListener('keydown', exitFullscreen, true);
  }, [fullscreen]);

  const groupedMetadata = useMemo(() => metadataFields.reduce((groups, field) => {
    const fields = groups.get(field.group) || [];
    fields.push(field);
    groups.set(field.group, fields);
    return groups;
  }, new Map<string, MediaMetadataField[]>()), [metadataFields]);
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };
  const preview = <section className={`flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50 ${fullscreen ? 'fixed inset-x-0 bottom-0 top-10 z-[370] w-screen' : ''}`}>
    <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
      <div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">预览</p><p className="truncate text-sm font-semibold text-slate-700">{fileName}</p></div>
      <div className="flex items-center gap-1">
        <button type="button" disabled={busy || version.fileMissing} onClick={onToggleFinal} title={version.isFinal ? '取消标记最终版' : '标记为最终版'} className={`group min-w-[96px] rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition hover:!border-red-300 hover:!bg-red-50 hover:!text-red-700 disabled:opacity-40 ${version.isFinal ? 'border-red-200 bg-red-50 text-red-600' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>{busy ? '处理中…' : version.isFinal ? <><span className="group-hover:hidden">已标记最终版</span><span className="hidden group-hover:inline">取消标记最终版</span></> : '标记为最终版'}</button>
        {!fullscreen && <button type="button" onClick={() => setFullscreen(true)} title="全屏查看预览图" aria-label="全屏查看预览图" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Maximize2 size={16}/></button>}
        <button type="button" disabled={version.fileMissing} onClick={async () => { const result = await window.electronAPI.openMediaVersion(version.filePath); if (!result.success) onNotice(`打开版本失败：${result.error || '未知错误'}`); }} title="使用系统默认应用打开" aria-label="使用系统默认应用打开" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"><ExternalLink size={16}/></button>
        {fullscreen ? <button type="button" onClick={() => setFullscreen(false)} title="缩小预览（Esc）" aria-label="缩小预览" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><Minimize2 size={16}/></button> : <button type="button" onClick={onClose} title="关闭版本管理" aria-label="关闭版本管理" className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><X size={16}/></button>}
      </div>
    </header>
    <div
      className={`relative min-h-0 flex-1 overflow-hidden bg-slate-50 ${zoom > 1 ? dragging ? 'cursor-grabbing' : 'cursor-grab' : ''}`}
      onWheel={event => { if (mediaKind(version.filePath) === 'video') return; event.preventDefault(); setZoom(value => Math.max(1, Math.min(8, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15)))); }}
      onDoubleClick={resetView}
      onPointerDown={event => { if (zoom <= 1 || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }; setDragging(true); }}
      onPointerMove={event => { const drag = dragRef.current; if (drag?.pointerId === event.pointerId) setPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY }); }}
      onPointerUp={event => { if (dragRef.current?.pointerId === event.pointerId) { dragRef.current = null; setDragging(false); } }}
      onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
    >
      <VersionResource version={version} cacheConfig={cacheConfig} contentStyle={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center', transition: dragging ? 'none' : 'transform 100ms ease-out' }} className="h-full w-full"/>
      {mediaKind(version.filePath) !== 'video' && !version.fileMissing && <button type="button" onClick={resetView} title="恢复适合窗口" className="absolute bottom-4 right-4 rounded-md bg-slate-900/75 px-2 py-1 font-mono text-[11px] text-slate-200 shadow-lg">{Math.round(zoom * 100)}%</button>}
    </div>
  </section>;

  return <div className="flex h-full min-h-0 min-w-0 flex-1">
    {fullscreen ? createPortal(preview, document.body) : preview}
    <div role="separator" aria-label="调整预览区和详细信息区宽度" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={560} aria-valuenow={Math.round(metadataWidth)} tabIndex={0} title="左右拖动调整详细信息宽度" onDoubleClick={() => setMetadataWidth(340)} onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); setMetadataWidth(width => Math.max(260, Math.min(560, width + (event.key === 'ArrowLeft' ? 20 : -20)))); }} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); metadataResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: metadataWidth }; }} onPointerMove={event => { const resize = metadataResizeRef.current; if (resize?.pointerId === event.pointerId) setMetadataWidth(Math.max(260, Math.min(560, resize.startWidth - event.clientX + resize.startX))); }} onPointerUp={event => { if (metadataResizeRef.current?.pointerId === event.pointerId) metadataResizeRef.current = null; }} onPointerCancel={() => { metadataResizeRef.current = null; }} className="column-resize-handle"/>
    <aside style={{ width: metadataWidth }} className="flex min-h-0 shrink-0 flex-col bg-white">
      <header className="flex min-h-14 shrink-0 items-center border-b border-slate-200 px-4"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wider text-slate-400">详细信息</p><p className="truncate text-sm font-semibold text-slate-700">{visibleVersionName(version)}</p></div></header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <section className="border-b border-slate-200 pb-2"><h4 className="py-2 text-xs font-bold text-slate-700">版本信息</h4><dl>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">版本</dt><dd className="break-words text-xs text-slate-700">V{version.versionNumber} · {visibleVersionName(version)}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">标记</dt><dd className="text-xs text-slate-700">{[version.isCurrent && '当前版本', version.isFinal && '最终版'].filter(Boolean).join('、') || '—'}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">文件大小</dt><dd className="text-xs text-slate-700">{formatSize(version.fileSize)}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">状态</dt><dd className={`text-xs ${version.fileMissing ? 'font-bold text-red-500' : version.contentChanged ? 'font-bold text-amber-600' : 'text-slate-700'}`}>{version.fileMissing ? '文件丢失' : version.contentChanged ? '文件曾被外部修改' : '正常'}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2"><dt className="text-[11px] text-slate-400">创建时间</dt><dd className="text-xs text-slate-700">{new Date(version.createdAt).toLocaleString()}</dd></div>
          <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 py-2"><dt className="text-[11px] text-slate-400">版本说明</dt><dd className="whitespace-pre-wrap break-words text-xs leading-5 text-slate-700">{version.note || '暂无说明'}</dd></div>
        </dl></section>
        <div className="flex items-center justify-between border-b border-slate-200 py-2"><span className="text-[11px] text-slate-400">{metadataLoading ? '正在读取媒体元数据…' : `${metadataFields.length} 个媒体字段`}</span></div>
        {metadataError && <p className="my-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-600">{metadataError}</p>}
        {Array.from(groupedMetadata.entries()).map(([group, fields]) => <details key={group} className="border-b border-slate-200"><summary className="cursor-pointer py-2.5 text-xs font-bold text-slate-700">{group}<span className="ml-2 text-[10px] font-normal text-slate-400">{fields.length}</span></summary><dl className="pb-2">{fields.map((field, index) => <div key={`${field.name}:${index}`} className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2 last:border-0"><dt className="break-words text-[11px] text-slate-400">{field.name}</dt><dd className="select-text break-words text-xs leading-5 text-slate-700">{field.value}</dd></div>)}</dl></details>)}
        <div className="flex flex-col gap-2 py-4">
          {version.fileMissing && <button type="button" disabled={busy} onClick={onRelocate} className="dialog-secondary inline-flex items-center justify-center gap-2"><FolderSearch size={14}/>重新定位文件</button>}
          <button type="button" onClick={onEditNote} className="dialog-secondary inline-flex items-center justify-center gap-2"><Pencil size={14}/>编辑版本说明</button>
          {!version.isCurrent && <button type="button" disabled={busy || version.fileMissing} onClick={onMakeCurrent} className="dialog-secondary inline-flex items-center justify-center gap-2"><CheckCircle2 size={14}/>设为当前版本</button>}
          <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(version.filePath); onNotice('成功复制文字'); } catch { onNotice('复制文件地址失败'); } }} className="dialog-secondary inline-flex items-center justify-center gap-2"><Copy size={14}/>复制文件地址</button>
          {version.versionNumber > 0 && !version.fileMissing && <button type="button" disabled={busy} onClick={onDelete} className="inline-flex items-center justify-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-bold text-red-600 hover:bg-red-50"><Trash2 size={14}/>删除版本记录</button>}
        </div>
      </div>
    </aside>
  </div>;
};

export const VersionManager = ({ entry, workspacePath, project, cacheConfig, onClose, onNotice, onVersionStateChanged }: VersionManagerProps) => {
  const appDialog = useAppDialog();
  const [bundle, setBundle] = useState<MediaVersionBundle>({ success: true, versions: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<MediaVersion | null>(null);
  const [editNote, setEditNote] = useState('');
  const [treeWidth, setTreeWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('photoflow:version-manager-tree-width-v2'));
    return Number.isFinite(stored) && stored >= 260 && stored <= 760 ? stored : 360;
  });
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    window.localStorage.setItem('photoflow:version-manager-tree-width-v2', String(Math.round(treeWidth)));
  }, [treeWidth]);
  const clampTreeWidth = (width: number) => {
    const available = layoutRef.current?.getBoundingClientRect().width || window.innerWidth;
    return Math.max(260, Math.min(760, available - 360, width));
  };

  const load = async () => {
    setLoading(true);
    const result = await window.electronAPI.getMediaVersions(workspacePath, project.status, project.name, entry.relativePath);
    setLoading(false);
    if (!result.success) { onNotice(`读取版本失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeVisibleVersionBundle(result));
    const current = result.versions.find(version => version.isCurrent) || result.versions[result.versions.length - 1];
    setSelectedId(value => result.versions.some(version => version.id === value) ? value : current?.id || '');
  };
  useEffect(() => { void load(); }, [entry.path, entry.updatedAt]);

  const selected = bundle.versions.find(version => version.id === selectedId);
  const compareVersions = compareIds.map(id => bundle.versions.find(version => version.id === id)).filter((version): version is MediaVersion => Boolean(version));
  const missingVersionCount = bundle.versions.filter(version => version.fileMissing).length;
  useEffect(() => {
    const switchSelectedVersion = (event: KeyboardEvent) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || editing || compareVersions.length === 2) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      const currentIndex = bundle.versions.findIndex(version => version.id === selectedId);
      if (currentIndex < 0) return;
      const nextIndex = Math.max(0, Math.min(bundle.versions.length - 1, currentIndex + (event.key === 'ArrowRight' ? 1 : -1)));
      if (nextIndex === currentIndex) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedId(bundle.versions[nextIndex].id);
    };
    window.addEventListener('keydown', switchSelectedVersion);
    return () => window.removeEventListener('keydown', switchSelectedVersion);
  }, [bundle.versions, selectedId, editing, compareVersions.length]);
  const depths = useMemo(() => {
    const byId = new Map(bundle.versions.map(version => [version.id, version]));
    return new Map(bundle.versions.map(version => {
      let depth = 0;
      let parent = version.parentVersionId ? byId.get(version.parentVersionId) : undefined;
      const visited = new Set<string>();
      while (parent && depth < 6 && !visited.has(parent.id)) { visited.add(parent.id); depth += 1; parent = parent.parentVersionId ? byId.get(parent.parentVersionId) : undefined; }
      return [version.id, depth];
    }));
  }, [bundle.versions]);

  const updateVersion = async (request: { versionId: string; versionName?: string; note?: string; isFinal?: boolean; makeCurrent?: boolean }, notice: string) => {
    setBusy(true);
    const result = await window.electronAPI.updateMediaVersion(workspacePath, request);
    setBusy(false);
    if (!result.success) { onNotice(`更新版本失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeVisibleVersionBundle(result));
    setEditing(null);
    onVersionStateChanged?.();
    onNotice(notice);
  };
  const deleteVersion = async (version: MediaVersion) => {
    if (!bundle.photo) return;
    const scope = await window.electronAPI.getMediaVersionDeleteScope(workspacePath, version.id);
    const selectedReparentText = scope.success && scope.selectedChildCount
      ? `\n\n该版本有 ${scope.selectedChildCount} 条直接子版本；删除后会自动改接到它的上一级版本，编号不会变化。`
      : '';
    if (!await appDialog.confirm({
      title: `确定删除 V${version.versionNumber} 吗？`,
      message: `将删除“${visibleVersionName(version)}”的版本记录。${selectedReparentText}`,
      confirmLabel: '删除版本',
      tone: 'danger',
    })) return;
    if (version.fileMissing) {
      if (scope.success && scope.allMissing && scope.versionCount > 1) {
        const bulkReparentText = scope.childCount ? `\n其中 ${scope.childCount} 条直接子版本会自动改接到上一级版本。` : '';
        const deleteAll = await appDialog.confirm({
          title: `删除所有图片的 V${scope.versionNumber}？`,
          message: `当前项目中 V${scope.versionNumber} 的 ${scope.versionCount} 条版本记录已全部丢失。${bulkReparentText}\n\n选择“只删当前图片”将只删除当前这一张图片的 V${scope.versionNumber}。`,
          confirmLabel: '删除所有图片',
          cancelLabel: '只删当前图片',
          tone: 'danger',
        });
        if (deleteAll) {
          setBusy(true);
          const bulkResult = await window.electronAPI.deleteProjectMissingMediaVersion(workspacePath, version.id);
          setBusy(false);
          if (!bulkResult.success) { onNotice(`批量删除失效版本失败：${bulkResult.error || '未知错误'}`); return; }
          setCompareIds([]);
          await load();
          onVersionStateChanged?.();
          onNotice(`已删除当前项目 ${bulkResult.deletedCount} 张图片的 V${bulkResult.versionNumber} 失效版本${bulkResult.reparentedCount ? `，并改接 ${bulkResult.reparentedCount} 条后续版本` : ''}；其他版本编号保持不变`);
          return;
        }
      }
    }
    const trashFile = version.fileMissing ? false : await appDialog.confirm({
      title: '是否同时删除磁盘文件？',
      message: '对应磁盘文件将移入系统回收站。选择“仅删除记录”会保留磁盘文件。',
      confirmLabel: '文件移入回收站',
      cancelLabel: '仅删除记录',
      tone: 'danger',
    });
    setBusy(true);
    const result = await window.electronAPI.deleteMediaVersion(workspacePath, { photoId: bundle.photo.id, versionId: version.id, trashFile });
    setBusy(false);
    if (!result.success) { onNotice(`删除版本失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeVisibleVersionBundle(result));
    setSelectedId(result.versions.find(item => item.isCurrent)?.id || result.versions[0]?.id || '');
    setCompareIds(ids => ids.filter(id => id !== version.id));
    onVersionStateChanged?.();
    onNotice(result.warning || (trashFile ? '版本已删除，文件已移入回收站；其他版本编号保持不变' : '版本记录已删除；其他版本编号保持不变'));
  };
  const relocateVersion = async (version: MediaVersion) => {
    if (!bundle.photo) return;
    setBusy(true);
    const result = await window.electronAPI.relocateMediaVersion(workspacePath, project.status, project.name, {
      photoId: bundle.photo.id,
      versionId: version.id,
    });
    setBusy(false);
    if (result.cancelled) return;
    if (!result.success) { onNotice(`重新定位失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeVisibleVersionBundle(result));
    onNotice(result.versions.find(item => item.id === version.id)?.contentChanged ? '版本已重新定位；因内容指纹不同，已标记内容变化' : '版本文件已重新定位');
  };
  const toggleCompare = (id: string) => setCompareIds(current => current.includes(id) ? current.filter(value => value !== id) : [...(current.length >= 2 ? current.slice(1) : current), id]);

  return <div className="fixed inset-x-0 bottom-0 top-10 z-[300] flex flex-col bg-slate-50">
    {loading ? <div className="flex flex-1 items-center justify-center gap-3 text-slate-500"><Loader2 size={20} className="animate-spin"/>正在扫描文件身份并建立版本记录…</div> : <div ref={layoutRef} className="relative flex min-h-0 flex-1">
      <aside style={{ width: treeWidth }} className="shrink-0 overflow-y-auto bg-white">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3"><div className="flex items-start gap-2"><GitBranch size={18} className="mt-0.5 shrink-0 text-blue-600"/><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-bold text-slate-800">版本管理 · {bundle.photo?.displayName || entry.name}</h2><p className="mt-1 truncate text-[11px] text-slate-500" title={bundle.photo?.id}>Photo ID：<span className="font-mono">{bundle.photo?.id || '正在建立追踪…'}</span></p></div><button onClick={onClose} title="关闭版本管理" aria-label="关闭版本管理" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"><X size={17}/></button></div></header>
        {missingVersionCount > 0 && <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] font-medium leading-5 text-amber-800"><AlertTriangle size={14} className="mt-0.5 shrink-0"/><span>{missingVersionCount} 个版本文件已被删除或移动，可选择对应版本重新定位或删除记录。</span></div>}
        <div className="p-3"><div className="mb-2 flex items-center justify-between px-2"><span className="text-xs font-bold uppercase tracking-wider text-slate-400">版本树</span><span className="text-xs text-slate-400">{bundle.versions.length} 个版本</span></div>
        <div className="space-y-2">{bundle.versions.map(version => <div key={version.id} role="button" tabIndex={0} onClick={() => setSelectedId(version.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(version.id); } }} className={`relative w-full cursor-pointer rounded-xl border p-3 text-left transition ${selectedId === version.id ? 'border-blue-400 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:bg-slate-50'}`} style={{ paddingLeft: 12 + (depths.get(version.id) || 0) * 14 }}>
          {(depths.get(version.id) || 0) > 0 && <span className="absolute bottom-1/2 top-0 w-px bg-slate-200" style={{ left: 8 + (depths.get(version.id) || 0) * 14 }}/>} 
          <div className="flex items-start gap-3"><VersionResource version={version} cacheConfig={cacheConfig} className="h-16 w-20 shrink-0 rounded-md"/><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><span className="font-mono text-xs font-bold text-blue-600">V{version.versionNumber}</span><span className="truncate text-sm font-bold text-slate-800">{visibleVersionName(version)}</span>{version.isCurrent && <span title="当前版本" className="rounded-full bg-blue-600 p-0.5 text-white"><Check size={10}/></span>}{version.isFinal && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">最终</span>}</div><p className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><Clock3 size={11}/>{new Date(version.createdAt).toLocaleString()}</p>{version.fileMissing && <div className="mt-1 flex flex-wrap items-center gap-2"><span className="text-[11px] font-bold text-red-500">文件丢失</span>{version.versionNumber > 0 && <button type="button" disabled={busy} onClick={event => { event.stopPropagation(); void deleteVersion(version); }} className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={11}/>删除版本</button>}</div>}{version.contentChanged && <p className="mt-1 text-[11px] font-bold text-amber-600">文件曾被外部修改</p>}</div><input disabled={version.fileMissing} title={version.fileMissing ? '请先重新定位文件' : '选择进行对比'} aria-label={`选择 V${version.versionNumber} 进行对比`} type="checkbox" checked={compareIds.includes(version.id)} onClick={event => event.stopPropagation()} onChange={() => toggleCompare(version.id)} className="mt-1 accent-blue-600 disabled:opacity-40"/></div>
        </div>)}</div></div>
      </aside>
      <div
        role="separator"
        aria-label="调整版本树宽度"
        aria-orientation="vertical"
        aria-valuemin={260}
        aria-valuemax={760}
        aria-valuenow={Math.round(treeWidth)}
        tabIndex={0}
        title="左右拖动调整版本树宽度"
        onDoubleClick={() => setTreeWidth(360)}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setTreeWidth(width => clampTreeWidth(width + (event.key === 'ArrowLeft' ? -20 : 20)));
        }}
        onPointerDown={event => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: treeWidth };
        }}
        onPointerMove={event => {
          const resize = resizeRef.current;
          if (resize?.pointerId !== event.pointerId) return;
          setTreeWidth(clampTreeWidth(resize.startWidth + event.clientX - resize.startX));
        }}
        onPointerUp={event => {
          if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
        }}
        onPointerCancel={() => { resizeRef.current = null; }}
        className="column-resize-handle"
      />
      <main className="flex min-w-0 flex-1 overflow-hidden">{selected ? <SingleVersionView version={selected} cacheConfig={cacheConfig} busy={busy} onClose={onClose} onNotice={onNotice} onToggleFinal={() => void updateVersion({ versionId: selected.id, isFinal: !selected.isFinal }, selected.isFinal ? '已取消最终版' : '已标记为最终版')} onEditNote={() => { setEditing(selected); setEditNote(selected.note); }} onMakeCurrent={() => void updateVersion({ versionId: selected.id, makeCurrent: true }, '已切换当前版本')} onRelocate={() => void relocateVersion(selected)} onDelete={() => void deleteVersion(selected)}/> : <div className="flex h-full flex-1 items-center justify-center text-slate-400">请选择一个版本</div>}</main>
      {bundle.photo && compareVersions.length === 2 && <div className="absolute inset-y-0 right-0 z-20 bg-slate-950" style={{ left: treeWidth + 1 }}><CompareView left={compareVersions[0]} right={compareVersions[1]} cacheConfig={cacheConfig} workspacePath={workspacePath} photoId={bundle.photo.id} onClose={() => setCompareIds([])}/></div>}
    </div>}
    {editing && <div className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><header className="flex items-center justify-between"><h3 className="font-bold text-slate-800">编辑版本说明 · V{editing.versionNumber}</h3><button onClick={() => setEditing(null)}><X size={18}/></button></header><label className="form-label">版本说明</label><textarea autoFocus rows={5} value={editNote} onChange={event => setEditNote(event.target.value)} placeholder="记录本次进度的修改内容" className="form-input resize-none"/><p className="mt-3 text-xs text-slate-500">版本名称由进度规则生成，不在这里修改。</p><footer className="mt-5 flex justify-end gap-2"><button onClick={() => setEditing(null)} className="dialog-secondary">取消</button><button disabled={busy} onClick={() => void updateVersion({ versionId: editing.id, note: editNote }, '版本说明已更新')} className="dialog-primary">保存</button></footer></div></div>}
  </div>;
};
