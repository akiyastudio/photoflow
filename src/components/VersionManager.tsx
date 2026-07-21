import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  FileDiff,
  FilePlus2,
  FolderSearch,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RotateCcw,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { AppConfig, MediaVersion, MediaVersionBundle, ProjectFileEntry, WorkspaceProject } from '../types';

type VersionManagerProps = {
  entry: ProjectFileEntry;
  workspacePath: string;
  project: WorkspaceProject;
  cacheConfig: AppConfig['mediaCache'];
  onClose: () => void;
  onNotice: (message: string) => void;
};

type CreateDraft = {
  parentVersionId: string;
  mode: 'copy' | 'import';
  versionType: string;
  versionName: string;
  note: string;
  isFinal: boolean;
};

const VERSION_TYPES = [
  ['first', '第一版'], ['second', '第二版'], ['third', '第三版'],
  ['primary', '主版本'], ['secondary', '副版本'], ['custom', '自定义版本'],
] as const;

const formatSize = (size: number) => size < 1024 * 1024
  ? `${Math.max(1, Math.round(size / 1024))} KB`
  : size < 1024 * 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;

const mediaKind = (filePath: string): 'image' | 'raw' | 'video' => {
  const extension = filePath.split('.').pop()?.toLocaleLowerCase() || '';
  if (['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'].includes(extension)) return 'video';
  if (['cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'dng', 'rwl', '3fr', 'fff', 'iiq', 'pef', 'srw'].includes(extension)) return 'raw';
  return 'image';
};

const VersionResource = ({ version, cacheConfig, className = '', contentStyle }: { version: MediaVersion; cacheConfig: AppConfig['mediaCache']; className?: string; contentStyle?: React.CSSProperties }) => {
  const [resource, setResource] = useState<{ url?: string; videoUrl?: string }>({});
  const [loading, setLoading] = useState(false);
  const kind = mediaKind(version.filePath);
  useEffect(() => {
    let active = true;
    setResource({});
    if (version.fileMissing) return () => { active = false; };
    setLoading(true);
    window.electronAPI.getMediaThumbnail(version.filePath, kind, cacheConfig, 1600, 0, -1).then(async result => {
      if (!active || !result.success) return;
      let url = result.previewUrl;
      if (kind !== 'video') {
        const original = await window.electronAPI.getMediaOriginal(version.filePath, kind, cacheConfig);
        if (active && original.success && original.mediaUrl) url = original.mediaUrl;
      }
      if (active) setResource({ url, videoUrl: result.mediaUrl });
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [version.id, version.filePath, version.fileModifiedAt, version.fileMissing, cacheConfig.directory, cacheConfig.maxSizeGB]);

  if (version.fileMissing) return <div className={`flex items-center justify-center bg-slate-100 text-slate-400 ${className}`}><AlertTriangle size={26}/></div>;
  if (kind === 'video' && resource.videoUrl) return <video controls preload="metadata" poster={resource.url} style={contentStyle} className={`bg-black object-contain ${className}`}><source src={resource.videoUrl}/></video>;
  return <div className={`relative flex items-center justify-center overflow-hidden bg-slate-100 ${className}`}>
    {resource.url ? <img src={resource.url} alt={version.versionName} draggable={false} style={contentStyle} className="h-full w-full object-contain"/> : <ImageIcon size={28} className="text-slate-400"/>}
    {loading && <span className="absolute rounded-full bg-slate-900/70 p-2 text-white"><Loader2 size={16} className="animate-spin"/></span>}
  </div>;
};

const CreateVersionDialog = ({ draft, busy, onChange, onSubmit, onClose }: {
  draft: CreateDraft;
  busy: boolean;
  onChange: (draft: CreateDraft) => void;
  onSubmit: () => void;
  onClose: () => void;
}) => <div className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4">
  <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
    <header className="flex items-center justify-between"><div><h3 className="font-bold text-slate-800">创建新版本</h3><p className="mt-1 text-xs text-slate-500">新版本会获得永久 Version ID，并自动成为当前版本。</p></div><button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18}/></button></header>
    <label className="form-label">文件来源</label>
    <div className="grid grid-cols-2 gap-2"><button onClick={() => onChange({ ...draft, mode: 'copy' })} className={`rounded-lg border p-3 text-left text-sm ${draft.mode === 'copy' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600'}`}><Copy size={16} className="mb-1"/><b>复制基础版本</b><span className="mt-1 block text-xs font-normal">立即建立可编辑副本</span></button><button onClick={() => onChange({ ...draft, mode: 'import' })} className={`rounded-lg border p-3 text-left text-sm ${draft.mode === 'import' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600'}`}><Upload size={16} className="mb-1"/><b>导入外部成片</b><span className="mt-1 block text-xs font-normal">确认时选择处理后的文件</span></button></div>
    <label className="form-label">版本类型</label><select value={draft.versionType} onChange={event => onChange({ ...draft, versionType: event.target.value })} className="form-input">{VERSION_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    <label className="form-label">版本名称</label><input autoFocus value={draft.versionName} onChange={event => onChange({ ...draft, versionName: event.target.value })} placeholder="例如：初修、调色、最终交付" className="form-input"/>
    <label className="form-label">版本说明</label><textarea rows={3} value={draft.note} onChange={event => onChange({ ...draft, note: event.target.value })} placeholder="记录修改内容、客户意见或交付信息" className="form-input resize-none"/>
    <label className="settings-check"><input type="checkbox" checked={draft.isFinal} onChange={event => onChange({ ...draft, isFinal: event.target.checked })}/><span>创建后标记为最终版</span></label>
    <footer className="mt-5 flex justify-end gap-2"><button onClick={onClose} className="dialog-secondary">取消</button><button onClick={onSubmit} disabled={busy || !draft.versionName.trim()} className="dialog-primary inline-flex items-center gap-2">{busy && <Loader2 size={15} className="animate-spin"/>}{draft.mode === 'import' ? '选择文件并创建' : '创建版本'}</button></footer>
  </div>
</div>;

const CompareDialog = ({ left, right, cacheConfig, workspacePath, photoId, onClose }: {
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
  return <div className="fixed inset-x-0 bottom-0 top-10 z-[370] flex flex-col bg-slate-950 text-white">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2"><div className="mr-3 min-w-0"><h3 className="font-bold">版本对比</h3><p className="truncate text-xs text-slate-400">V{left.versionNumber} {left.versionName} ↔ V{right.versionNumber} {right.versionName}</p></div>{([['side-by-side', '并排'], ['split', '滑动分割'], ['overlay', '透明叠加'], ['blink', '闪烁'], ['difference', '差异']] as const).map(([value, label]) => <button key={value} onClick={() => setMode(value)} className={`rounded-md px-3 py-1.5 text-xs font-bold ${mode === value ? 'bg-blue-600 text-white' : 'bg-white/10 text-slate-300 hover:bg-white/15'}`}>{label}</button>)}<div className="ml-auto flex items-center gap-2"><button onClick={() => setRotation(value => (value + 90) % 360)} className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15">旋转 {rotation}°</button><button onClick={resetView} className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15">重置视图</button><span className="text-xs text-slate-400">缩放</span><input type="range" min="1" max="4" step="0.1" value={zoom} onChange={event => setZoom(Number(event.target.value))}/><button onClick={onClose} className="rounded p-2 hover:bg-white/10"><X size={18}/></button></div></header>
    {(mode === 'split' || mode === 'overlay') && <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2 text-xs text-slate-300"><span>{mode === 'split' ? '分割位置' : '右侧透明度'}</span><input className="w-64" type="range" min="0" max="100" value={mode === 'split' ? split : opacity} onChange={event => mode === 'split' ? setSplit(Number(event.target.value)) : setOpacity(Number(event.target.value))}/><span className="font-mono">{mode === 'split' ? split : opacity}%</span></div>}
    <main className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-black active:cursor-grabbing" onDoubleClick={resetView} onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }; }} onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); setCoordinates({ x: Math.round(event.clientX - rect.left), y: Math.round(event.clientY - rect.top) }); const drag = dragRef.current; if (drag?.pointerId === event.pointerId) setPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY }); }} onPointerUp={event => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
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

export const VersionManager = ({ entry, workspacePath, project, cacheConfig, onClose, onNotice }: VersionManagerProps) => {
  const [bundle, setBundle] = useState<MediaVersionBundle>({ success: true, versions: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [editing, setEditing] = useState<MediaVersion | null>(null);
  const [editName, setEditName] = useState('');
  const [editNote, setEditNote] = useState('');
  const [compareOpen, setCompareOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const result = await window.electronAPI.getMediaVersions(workspacePath, project.status, project.name, entry.relativePath);
    setLoading(false);
    if (!result.success) { onNotice(`读取版本失败：${result.error || '未知错误'}`); return; }
    setBundle(result);
    const current = result.versions.find(version => version.isCurrent) || result.versions[result.versions.length - 1];
    setSelectedId(value => result.versions.some(version => version.id === value) ? value : current?.id || '');
  };
  useEffect(() => { void load(); }, [entry.path, entry.updatedAt]);

  const selected = bundle.versions.find(version => version.id === selectedId);
  const compareVersions = compareIds.map(id => bundle.versions.find(version => version.id === id)).filter((version): version is MediaVersion => Boolean(version));
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

  const beginCreate = (parent: MediaVersion, mode: 'copy' | 'import' = 'copy', restored = false) => setCreateDraft({
    parentVersionId: parent.id,
    mode,
    versionType: 'custom',
    versionName: restored ? `恢复自 V${parent.versionNumber}` : '',
    note: restored ? `从历史版本 V${parent.versionNumber} 恢复` : '',
    isFinal: false,
  });
  const createVersion = async () => {
    if (!createDraft || !bundle.photo) return;
    setBusy(true);
    const result = await window.electronAPI.createMediaVersion(workspacePath, project.status, project.name, { photoId: bundle.photo.id, ...createDraft });
    setBusy(false);
    if (result.cancelled) return;
    if (!result.success) { onNotice(`创建版本失败：${result.error || '未知错误'}`); return; }
    setBundle(result);
    setSelectedId(result.versions.find(version => version.isCurrent)?.id || '');
    setCreateDraft(null);
    onNotice(`已创建 V${result.versions[result.versions.length - 1]?.versionNumber} · ${result.versions[result.versions.length - 1]?.versionName}`);
  };
  const updateVersion = async (request: { versionId: string; versionName?: string; note?: string; isFinal?: boolean; makeCurrent?: boolean }, notice: string) => {
    setBusy(true);
    const result = await window.electronAPI.updateMediaVersion(workspacePath, request);
    setBusy(false);
    if (!result.success) { onNotice(`更新版本失败：${result.error || '未知错误'}`); return; }
    setBundle(result);
    setEditing(null);
    onNotice(notice);
  };
  const deleteVersion = async (version: MediaVersion) => {
    if (!bundle.photo || !window.confirm(`确定删除 V${version.versionNumber} · ${version.versionName} 的版本记录吗？`)) return;
    const trashFile = window.confirm('是否同时把对应磁盘文件移入系统回收站？\n选择“取消”将只删除版本记录。');
    setBusy(true);
    const result = await window.electronAPI.deleteMediaVersion(workspacePath, { photoId: bundle.photo.id, versionId: version.id, trashFile });
    setBusy(false);
    if (!result.success) { onNotice(`删除版本失败：${result.error || '未知错误'}`); return; }
    setBundle(result);
    setSelectedId(result.versions.find(item => item.isCurrent)?.id || result.versions[0]?.id || '');
    setCompareIds(ids => ids.filter(id => id !== version.id));
    onNotice(result.warning || (trashFile ? '版本已删除，文件已移入回收站' : '版本记录已删除'));
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
    setBundle(result);
    onNotice(result.versions.find(item => item.id === version.id)?.contentChanged ? '版本已重新定位；因内容指纹不同，已标记内容变化' : '版本文件已重新定位');
  };
  const toggleCompare = (id: string) => setCompareIds(current => current.includes(id) ? current.filter(value => value !== id) : [...(current.length >= 2 ? current.slice(1) : current), id]);

  return <div className="fixed inset-x-0 bottom-0 top-10 z-[300] flex flex-col bg-slate-50">
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3"><div className="min-w-0"><div className="flex items-center gap-2"><GitBranch size={19} className="text-blue-600"/><h2 className="truncate font-bold text-slate-800">版本管理 · {bundle.photo?.displayName || entry.name}</h2></div><p className="mt-1 text-xs text-slate-500">Photo ID：<span className="font-mono">{bundle.photo?.id || '正在建立追踪…'}</span></p></div><div className="ml-auto flex flex-wrap items-center gap-2"><button disabled={!selected || busy} onClick={() => selected && beginCreate(selected, 'copy')} className="dialog-primary inline-flex items-center gap-2"><FilePlus2 size={16}/>创建新版本</button><button disabled={!selected || busy} onClick={() => selected && beginCreate(selected, 'import')} className="dialog-secondary inline-flex items-center gap-2"><Upload size={16}/>导入为新版本</button><button disabled={compareVersions.length !== 2} onClick={() => setCompareOpen(true)} className="dialog-secondary inline-flex items-center gap-2"><FileDiff size={16}/>对比 {compareVersions.length}/2</button><button onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={20}/></button></div></header>
    {loading ? <div className="flex flex-1 items-center justify-center gap-3 text-slate-500"><Loader2 size={20} className="animate-spin"/>正在扫描文件身份并建立版本记录…</div> : <div className="flex min-h-0 flex-1">
      <aside className="w-[420px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between px-2"><span className="text-xs font-bold uppercase tracking-wider text-slate-400">版本树</span><span className="text-xs text-slate-400">{bundle.versions.length} 个版本</span></div>
        <div className="space-y-2">{bundle.versions.map(version => <button key={version.id} onClick={() => setSelectedId(version.id)} className={`relative w-full rounded-xl border p-3 text-left transition ${selectedId === version.id ? 'border-blue-400 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:bg-slate-50'}`} style={{ paddingLeft: 12 + (depths.get(version.id) || 0) * 14 }}>
          {(depths.get(version.id) || 0) > 0 && <span className="absolute bottom-1/2 top-0 w-px bg-slate-200" style={{ left: 8 + (depths.get(version.id) || 0) * 14 }}/>} 
          <div className="flex items-start gap-3"><VersionResource version={version} cacheConfig={cacheConfig} className="h-16 w-20 shrink-0 rounded-md"/><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><span className="font-mono text-xs font-bold text-blue-600">V{version.versionNumber}</span><span className="truncate text-sm font-bold text-slate-800">{version.versionName}</span>{version.isCurrent && <span title="当前版本" className="rounded-full bg-blue-600 p-0.5 text-white"><Check size={10}/></span>}{version.isFinal && <Star size={13} fill="currentColor" className="text-amber-500"/>}</div><p className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><Clock3 size={11}/>{new Date(version.createdAt).toLocaleString()}</p>{version.fileMissing && <p className="mt-1 text-[11px] font-bold text-red-500">文件丢失</p>}{version.contentChanged && <p className="mt-1 text-[11px] font-bold text-amber-600">文件曾被外部修改</p>}</div><input disabled={version.fileMissing} title={version.fileMissing ? '请先重新定位文件' : '选择进行对比'} aria-label={`选择 V${version.versionNumber} 进行对比`} type="checkbox" checked={compareIds.includes(version.id)} onClick={event => event.stopPropagation()} onChange={() => toggleCompare(version.id)} className="mt-1 accent-blue-600 disabled:opacity-40"/></div>
        </button>)}</div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-5">{selected ? <div className="mx-auto max-w-5xl space-y-4"><VersionResource version={selected} cacheConfig={cacheConfig} className="h-[min(52vh,560px)] w-full rounded-xl border border-slate-200 bg-slate-950"/><section className="rounded-xl border border-slate-200 bg-white p-5"><div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="font-mono text-sm font-bold text-blue-600">V{selected.versionNumber}</span><h3 className="truncate text-xl font-bold text-slate-800">{selected.versionName}</h3>{selected.isCurrent && <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-bold text-blue-600">当前版本</span>}{selected.isFinal && <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-bold text-amber-600">最终版</span>}</div><p className="mt-2 break-all text-xs text-slate-400">Version ID：<span className="font-mono">{selected.id}</span></p><p className="mt-1 break-all text-xs text-slate-400">{selected.filePath}</p></div><div className="flex flex-wrap gap-2"><button disabled={selected.fileMissing} onClick={async () => { const result = await window.electronAPI.openMediaVersion(selected.filePath); if (!result.success) onNotice(`打开版本失败：${result.error}`); }} className="dialog-secondary inline-flex items-center gap-2"><ExternalLink size={15}/>打开</button>{selected.fileMissing && <button disabled={busy} onClick={() => void relocateVersion(selected)} className="dialog-secondary inline-flex items-center gap-2"><FolderSearch size={15}/>重新定位</button>}<button onClick={() => { setEditing(selected); setEditName(selected.versionName); setEditNote(selected.note); }} className="dialog-secondary inline-flex items-center gap-2"><Pencil size={15}/>编辑</button>{!selected.isCurrent && <button onClick={() => void updateVersion({ versionId: selected.id, makeCurrent: true }, '已切换当前版本')} className="dialog-secondary inline-flex items-center gap-2"><CheckCircle2 size={15}/>设为当前</button>}<button onClick={() => void updateVersion({ versionId: selected.id, isFinal: !selected.isFinal }, selected.isFinal ? '已取消最终版' : '已标记为最终版')} className="dialog-secondary inline-flex items-center gap-2"><Star size={15}/>{selected.isFinal ? '取消最终版' : '标记最终版'}</button>{selected.versionNumber > 0 && <button onClick={() => beginCreate(selected, 'copy', true)} className="dialog-secondary inline-flex items-center gap-2"><RotateCcw size={15}/>恢复为新版本</button>}<button onClick={() => beginCreate(selected, 'copy')} className="dialog-secondary inline-flex items-center gap-2"><GitBranch size={15}/>基于此版本创建</button>{selected.versionNumber > 0 && <button onClick={() => void deleteVersion(selected)} className="inline-flex items-center gap-2 rounded-md border border-red-200 px-3 py-2 text-sm font-bold text-red-600 hover:bg-red-50"><Trash2 size={15}/>删除</button>}</div></div><div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-bold text-slate-400">创建人</p><p className="mt-1 text-sm text-slate-700">{selected.author || '本机用户'}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-bold text-slate-400">文件大小</p><p className="mt-1 text-sm text-slate-700">{formatSize(selected.fileSize)}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-bold text-slate-400">状态</p><p className="mt-1 text-sm text-slate-700">{selected.fileMissing ? '文件丢失' : selected.contentChanged ? '内容已变化' : selected.status === 'original' ? '原片（受保护）' : selected.status === 'needs-review' ? '需要复核（Patch 重叠冲突）' : '正常'}</p></div></div><div className="mt-4 rounded-lg bg-slate-50 p-3"><p className="text-[11px] font-bold text-slate-400">版本说明</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">{selected.note || '暂无说明'}</p></div></section></div> : <div className="flex h-full items-center justify-center text-slate-400">请选择一个版本</div>}</main>
    </div>}
    {createDraft && <CreateVersionDialog draft={createDraft} busy={busy} onChange={setCreateDraft} onSubmit={() => void createVersion()} onClose={() => !busy && setCreateDraft(null)}/>} 
    {editing && <div className="fixed inset-0 z-[360] flex items-center justify-center bg-slate-950/45 p-4"><div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"><header className="flex items-center justify-between"><h3 className="font-bold text-slate-800">编辑 V{editing.versionNumber}</h3><button onClick={() => setEditing(null)}><X size={18}/></button></header><label className="form-label">版本名称</label><input autoFocus value={editName} onChange={event => setEditName(event.target.value)} className="form-input"/><label className="form-label">版本说明</label><textarea rows={4} value={editNote} onChange={event => setEditNote(event.target.value)} className="form-input resize-none"/><p className="mt-3 text-xs text-slate-500">修改显示名称不会重命名磁盘文件，也不会改变 Photo ID 或 Version ID。</p><footer className="mt-5 flex justify-end gap-2"><button onClick={() => setEditing(null)} className="dialog-secondary">取消</button><button disabled={busy || !editName.trim()} onClick={() => void updateVersion({ versionId: editing.id, versionName: editName, note: editNote }, '版本信息已更新')} className="dialog-primary">保存</button></footer></div></div>}
    {compareOpen && bundle.photo && compareVersions.length === 2 && <CompareDialog left={compareVersions[0]} right={compareVersions[1]} cacheConfig={cacheConfig} workspacePath={workspacePath} photoId={bundle.photo.id} onClose={() => setCompareOpen(false)}/>} 
  </div>;
};
