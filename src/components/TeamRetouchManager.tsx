import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ExternalLink, Loader2, Maximize2, RefreshCw, ScanFace, SlidersHorizontal, Trash2, UserRound, UsersRound, Wand2, X } from 'lucide-react';
import type { AppConfig, ComponentStatus, MediaVersion, ProjectFileEntry, TeamIdentity, TeamIdentityWorkspace, TeamPatchBundle, TeamPatchTask, TeamPersonAssignment, TeamProjectPhoto, WorkspaceProject } from '../types';
import { useAppDialog } from './AppDialogProvider';
import { useEscapeLayer } from './LayerProvider';
import { TeamRetouchSteps, type TeamRetouchStep } from './TeamRetouchSteps';

type Props = {
  entries: ProjectFileEntry[];
  workspacePath: string;
  project: WorkspaceProject;
  cacheConfig: AppConfig['mediaCache'];
  defaultBackendMode: AppConfig['personDetection']['backendMode'];
  componentStatus?: ComponentStatus;
  activeStep: TeamRetouchStep;
  onStepChange: (step: TeamRetouchStep) => void;
  onClose: () => void;
  onNotice: (message: string) => void;
  onEntriesChange?: (entries: ProjectFileEntry[]) => void;
  onProjectChanged?: () => void;
  onBusyChange?: (busy: boolean) => void;
};

type BatchResult = { relativePath: string; name: string; success: boolean; error?: string };
type Crop = { x: number; y: number; width: number; height: number };
type IdentityState = TeamIdentityWorkspace & { identifying?: boolean };
type IdentitySubject = {
  key: string;
  photo: TeamProjectPhoto;
  task: TeamPatchTask;
  personIndex: number;
  bbox: Crop;
  assignment?: TeamPersonAssignment;
  identity?: TeamIdentity;
};

const identitySubjectPhotoKey = (subject: IdentitySubject) => `${subject.photo.photoId}:${subject.photo.baseVersionId}`;
const uniqueIdentitySubjectsPerPhoto = (subjects: IdentitySubject[], anchorKey: string) => {
  const anchor = subjects.find(subject => subject.key === anchorKey);
  const ordered = anchor ? [anchor, ...subjects.filter(subject => subject.key !== anchorKey)] : subjects;
  const usedPhotos = new Set<string>();
  return ordered.filter(subject => {
    const photoKey = identitySubjectPhotoKey(subject);
    if (usedPhotos.has(photoKey)) return false;
    usedPhotos.add(photoKey);
    return true;
  });
};

const assignmentKey = (photoId: string, baseVersionId: string, personIndex: number) => `${photoId}:${baseVersionId}:${personIndex}`;
const membersOf = (task: TeamPatchTask) => task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox }];
const isGeneratedIdentity = (identity?: TeamIdentity) => Boolean(identity && /^待确认人物\s+\d+$/.test(identity.name));
const isUnmarkedIdentitySubject = (subject: IdentitySubject) => !subject.identity || isGeneratedIdentity(subject.identity);
const identitySubjectsFromWorkspace = (workspace: TeamIdentityWorkspace): IdentitySubject[] => {
  const assignments = new Map(workspace.assignments.map(item => [assignmentKey(item.photoId, item.baseVersionId, item.personIndex), item]));
  const identities = new Map(workspace.identities.map(item => [item.id, item]));
  const subjects = new Map<string, IdentitySubject>();
  for (const photo of workspace.photos) {
    for (const task of photo.tasks) {
      for (const member of membersOf(task)) {
        const key = assignmentKey(photo.photoId, photo.baseVersionId, member.personIndex);
        const assignment = assignments.get(key);
        if (!subjects.has(key)) subjects.set(key, {
          key,
          photo,
          task,
          personIndex: member.personIndex,
          bbox: member.bbox,
          assignment,
          identity: assignment?.identityId ? identities.get(assignment.identityId) : undefined,
        });
      }
    }
  }
  return [...subjects.values()];
};
const personColors = ['#facc15', '#22d3ee', '#fb7185', '#a78bfa', '#4ade80', '#fb923c', '#60a5fa', '#f472b6'];
const personColor = (personIndex: number) => personColors[Math.abs(personIndex - 1) % personColors.length];
const sourceDimensionFromMask = (proxyDimension?: number, proxyScale?: number) => {
  const dimension = Number(proxyDimension || 0);
  const scale = Number(proxyScale || 0);
  return dimension > 0 && scale > 0 ? dimension / scale : 0;
};
const normalizeBundle = (bundle: TeamPatchBundle): TeamPatchBundle => ({
  ...bundle,
  versions: bundle.versions.map(version => ({ ...version, versionName: version.versionName.replace(/^R\d+\s*·\s*/i, '') })),
});

const normalizedPathKey = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
const workspacePhotoForEntry = (photos: TeamProjectPhoto[], entry: ProjectFileEntry) => {
  const relativeKey = normalizedPathKey(entry.relativePath);
  const absoluteKey = normalizedPathKey(entry.path);
  return photos.find(photo => normalizedPathKey(photo.relativePath) === relativeKey || normalizedPathKey(photo.sourcePath) === absoluteKey);
};
const bundleFromWorkspacePhoto = (photo: TeamProjectPhoto): TeamPatchBundle => ({
  success: true,
  photo: {
    id: photo.photoId,
    projectId: '',
    mediaType: 'image',
    originalName: photo.name,
    displayName: photo.name,
    currentVersionId: photo.baseVersionId,
    originalFilePath: photo.sourcePath,
    createdAt: 0,
    updatedAt: 0,
  },
  versions: [{
    id: photo.baseVersionId,
    photoId: photo.photoId,
    versionNumber: 0,
    versionName: '当前版本',
    versionType: 'current',
    filePath: photo.sourcePath,
    fileSize: 0,
    note: '',
    status: 'ready',
    isCurrent: true,
    isFinal: false,
    fileMissing: false,
    contentChanged: false,
    createdAt: 0,
    updatedAt: 0,
  }],
  tasks: photo.tasks,
  excludedPersonCount: photo.excludedPersonCount || 0,
  excludedPersonCounts: { [photo.baseVersionId]: photo.excludedPersonCount || 0 },
});

const useLazyPreview = (filePath: string | undefined, cacheConfig: AppConfig['mediaCache'], size: number, refreshKey = '', enabled = true) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    setUrl('');
    if (!filePath || !enabled) return () => { active = false; };
    const stop = window.electronAPI.onThumbnailStateChanged(update => {
      if (active && update.filePath.toLocaleLowerCase() === filePath.toLocaleLowerCase() && update.state === 'READY' && update.previewUrls?.medium) setUrl(update.previewUrls.medium);
    });
    void window.electronAPI.getMediaThumbnail(filePath, 'image', cacheConfig, size, 1, 0).then(result => {
      if (active && result.previewUrl) setUrl(result.previewUrl);
    });
    return () => { active = false; stop(); };
  }, [filePath, size, refreshKey, enabled, cacheConfig.directory, cacheConfig.maxSizeGB]);
  return url;
};

const FullscreenImageViewer = ({ url, filePath, cacheConfig, title, details, onClose }: { url: string; filePath?: string; cacheConfig?: AppConfig['mediaCache']; title: string; details?: string; onClose: () => void }) => {
  const [displayUrl, setDisplayUrl] = useState(url);
  useEffect(() => {
    let active = true;
    setDisplayUrl(url);
    if (filePath && cacheConfig) void window.electronAPI.getMediaOriginal(filePath, 'image', cacheConfig).then(result => {
      if (active && result.mediaUrl) setDisplayUrl(result.mediaUrl);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [url, filePath, cacheConfig]);
  useEscapeLayer(true, onClose);
  return createPortal(<div role="dialog" aria-modal="true" aria-label={`全窗口浏览：${title}`} className="fixed inset-0 z-[700] flex flex-col bg-slate-950/95" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-5 text-white"><div className="min-w-0"><h3 className="truncate text-sm font-bold">{title}</h3>{details && <p className="mt-0.5 text-xs text-slate-400">{details}</p>}</div><button type="button" onClick={onClose} title="关闭全窗口浏览" className="ml-auto rounded-md p-2 text-slate-300 hover:bg-white/10 hover:text-white"><X size={20}/></button></header><div className="flex min-h-0 flex-1 items-center justify-center p-4"><img src={displayUrl} alt={title} className="max-h-full max-w-full object-contain"/></div></div>, document.body);
};

const ImageZoomButton = ({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) => <button type="button" disabled={disabled} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); onClick(); }} title="全窗口浏览图片" aria-label="全窗口浏览图片" className="absolute bottom-2 right-2 z-20 rounded-md border border-white/20 bg-black/75 p-1.5 text-white shadow-lg transition hover:bg-blue-600 disabled:hidden"><Maximize2 size={15}/></button>;

const PatchPreview = ({ task, cacheConfig, enabled = true, onPickPerson }: { task: TeamPatchTask; cacheConfig: AppConfig['mediaCache']; enabled?: boolean; onPickPerson?: (personIndex: number) => void }) => {
  const url = useLazyPreview(task.patchPath, cacheConfig, 480, `${task.updatedAt}:${task.crop.x}:${task.crop.y}:${task.crop.width}:${task.crop.height}`, enabled);
  const [fullscreen, setFullscreen] = useState(false);
  return <><div className="relative flex h-44 items-center justify-center overflow-hidden rounded-lg bg-slate-950">
    {url ? <svg className="h-full w-full" viewBox={`0 0 ${task.crop.width} ${task.crop.height}`} preserveAspectRatio="xMidYMid meet"><image href={url} width={task.crop.width} height={task.crop.height}/>{membersOf(task).map(member => {
      const x = Math.max(0, member.bbox.x - task.crop.x);
      const y = Math.max(0, member.bbox.y - task.crop.y);
      const width = Math.min(member.bbox.width, task.crop.width - x);
      const height = Math.min(member.bbox.height, task.crop.height - y);
      const color = personColor(member.personIndex);
      const fontSize = Math.max(18, task.crop.width / 28);
      const labelWidth = fontSize * 3.8;
      const labelHeight = fontSize * 1.45;
      const labelY = Math.max(0, y - labelHeight);
      return <g key={member.personIndex} onClick={() => onPickPerson?.(member.personIndex)} className={onPickPerson ? 'cursor-pointer' : undefined}><rect x={x} y={y} width={width} height={height} fill={`${color}12`} stroke={color} strokeWidth={Math.max(2, task.crop.width / 420)}/><rect x={x} y={labelY} width={labelWidth} height={labelHeight} rx={fontSize * .2} fill={color}/><text x={x + fontSize * .35} y={labelY + fontSize * 1.05} fill="#020617" fontSize={fontSize} fontWeight="800">人物 {member.personIndex}</text></g>;
    })}</svg> : <Loader2 className="animate-spin text-slate-500"/>}
    <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[10px] font-bold text-white">识别工作图</span>
    <ImageZoomButton disabled={!url} onClick={() => setFullscreen(true)}/>
  </div><p className="mt-1.5 text-center text-[11px] font-medium tabular-nums text-slate-500">{Math.round(task.crop.width)} × {Math.round(task.crop.height)} px</p>{fullscreen && url && <FullscreenImageViewer url={url} filePath={task.patchPath} cacheConfig={cacheConfig} title="识别工作图" details={`${Math.round(task.crop.width)} × ${Math.round(task.crop.height)} px`} onClose={() => setFullscreen(false)}/>}</>;
};

const IdentitySubjectThumb = ({ subject, cacheConfig, compact = false }: { subject: IdentitySubject; cacheConfig: AppConfig['mediaCache']; compact?: boolean }) => {
  const url = useLazyPreview(subject.task.patchPath, cacheConfig, compact ? 320 : 480, `${subject.task.updatedAt}:${subject.personIndex}`);
  const [fullscreen, setFullscreen] = useState(false);
  const x = Math.max(0, subject.bbox.x - subject.task.crop.x);
  const y = Math.max(0, subject.bbox.y - subject.task.crop.y);
  const boxWidth = Math.max(1, Math.min(subject.bbox.width, subject.task.crop.width - x));
  const boxHeight = Math.max(1, Math.min(subject.bbox.height, subject.task.crop.height - y));
  const targetRatio = 4 / 3;
  let viewWidth = Math.min(subject.task.crop.width, boxWidth * 1.45);
  let viewHeight = Math.min(subject.task.crop.height, boxHeight * 1.3);
  if (viewWidth / viewHeight < targetRatio) viewWidth = Math.min(subject.task.crop.width, viewHeight * targetRatio);
  else viewHeight = Math.min(subject.task.crop.height, viewWidth / targetRatio);
  const centerX = x + boxWidth / 2;
  const centerY = y + boxHeight / 2;
  const viewX = Math.max(0, Math.min(subject.task.crop.width - viewWidth, centerX - viewWidth / 2));
  const viewY = Math.max(0, Math.min(subject.task.crop.height - viewHeight, centerY - viewHeight / 2));
  return <><div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-slate-950">
    {url ? <svg className="block h-full w-full" viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet"><image href={url} width={subject.task.crop.width} height={subject.task.crop.height}/><rect x={x} y={y} width={boxWidth} height={boxHeight} fill="none" stroke="#facc15" strokeWidth={Math.max(3, viewWidth / 180)}/></svg> : <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin text-slate-500"/></div>}
    <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 py-1 pl-2 pr-11 text-[10px] font-bold text-white">{subject.photo.name} · 人物 {subject.personIndex}</span><ImageZoomButton disabled={!url} onClick={() => setFullscreen(true)}/>
  </div>{fullscreen && url && <FullscreenImageViewer url={url} filePath={subject.task.patchPath} cacheConfig={cacheConfig} title={`${subject.photo.name} · 人物 ${subject.personIndex}`} details={`${Math.round(subject.task.crop.width)} × ${Math.round(subject.task.crop.height)} px`} onClose={() => setFullscreen(false)}/>}</>;
};

const IdentityPicker = ({ subject, candidates, allSubjects, identities, includedKeys, cacheConfig, busy, busyLabel, onToggleCandidate, onOnlyCurrent, onConfirm, onCreate, onClear, onExclude, onRename, onDelete, onClose }: {
  subject: IdentitySubject;
  candidates: IdentitySubject[];
  allSubjects: IdentitySubject[];
  identities: TeamIdentity[];
  includedKeys: Set<string>;
  cacheConfig: AppConfig['mediaCache'];
  busy: boolean;
  busyLabel: string;
  onToggleCandidate: (key: string) => void;
  onOnlyCurrent: () => void;
  onConfirm: (identityId: string) => void;
  onCreate: () => void;
  onClear: () => void;
  onExclude: () => void;
  onRename: (identity: TeamIdentity) => void;
  onDelete: (identity: TeamIdentity) => void;
  onClose: () => void;
}) => {
  const availableIdentities = identities.filter(identity => !isGeneratedIdentity(identity));
  const currentIdentity = subject.identity;
  useEscapeLayer(true, onClose, !busy);
  return <div role="dialog" aria-modal="true" aria-label="确认人物身份" className="fixed inset-0 z-[470] flex items-center justify-center bg-slate-950/75 p-5" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="flex max-h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex items-center gap-4 border-b border-slate-200 px-5 py-4"><div><h3 className="font-bold text-slate-900">这是谁？</h3><p className="mt-1 text-xs text-slate-500">确认一个人物后，可一次应用到系统识别出的整组相同人物。</p></div><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">本次将标记 {includedKeys.size} 个实例</span><button disabled={busy} onClick={onClose} className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"><X size={19}/></button></header>
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
        <aside className="overflow-y-auto border-r border-slate-200 bg-slate-50 p-5"><p className="mb-2 text-xs font-bold text-slate-500">当前人物</p><IdentitySubjectThumb subject={subject} cacheConfig={cacheConfig}/><p className="mt-3 text-sm font-bold text-slate-800">{currentIdentity && !isGeneratedIdentity(currentIdentity) ? currentIdentity.name : '未标记'}</p><p className="mt-1 text-xs text-slate-500">{!currentIdentity || isGeneratedIdentity(currentIdentity) ? '未标记' : subject.assignment?.source === 'manual' ? '已人工确认' : subject.assignment?.source === 'manual-group' ? '由人工确认组传播' : `自动候选 · ${Math.round((subject.assignment?.confidence || 0) * 100)}%`}</p><div className="mt-5 space-y-2"><button disabled={busy} onClick={onCreate} className="dialog-primary w-full">这是一个新人物</button><button disabled={busy} onClick={onClear} className="dialog-secondary w-full">设为未标记</button><button disabled={busy} onClick={onExclude} className="w-full rounded-md border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"><Trash2 size={13} className="mr-1.5 inline"/>识别错误，移除此人物</button>{currentIdentity && !isGeneratedIdentity(currentIdentity) && <><button disabled={busy} onClick={() => onRename(currentIdentity)} className="dialog-secondary w-full">修改“{currentIdentity.name}”姓名</button><button disabled={busy} onClick={() => onDelete(currentIdentity)} className="w-full rounded-md border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50">删除这个人物身份</button></>}</div></aside>
        <section className="min-h-0 overflow-y-auto p-5">
          <div className="flex items-center gap-3"><div><h4 className="text-sm font-bold text-slate-800">系统认为是同一个人的候选图</h4><p className="mt-1 text-xs text-slate-500">默认勾选整组；有误的图片可以取消勾选，当前人物不能取消。</p></div><button disabled={busy} onClick={onOnlyCurrent} className="dialog-secondary ml-auto">仅标记当前人物</button></div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{candidates.map(candidate => { const included = includedKeys.has(candidate.key); const isAnchor = candidate.key === subject.key; return <label key={candidate.key} className={`relative cursor-pointer overflow-hidden rounded-xl border bg-white p-2 transition ${included ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200 opacity-65'}`}><input type="checkbox" checked={included} disabled={busy || isAnchor} onChange={() => onToggleCandidate(candidate.key)} className="absolute left-3 top-3 z-10 h-4 w-4 accent-blue-600"/><IdentitySubjectThumb subject={candidate} cacheConfig={cacheConfig} compact/><div className="mt-2 flex items-center justify-between gap-2 text-[10px]"><span className="font-bold text-slate-600">{isAnchor ? '当前人物' : candidate.assignment?.source === 'suggested' ? '自动候选' : '同组人物'}</span><span className="text-slate-400">{Math.round((candidate.assignment?.confidence || 0) * 100)}%</span></div></label>; })}</div>
          <div className="mt-6 border-t border-slate-200 pt-5"><div className="flex items-center gap-3"><div><h4 className="text-sm font-bold text-slate-800">选择已有身份</h4><p className="mt-1 text-xs text-slate-500">点击后会应用到上方已勾选的 {includedKeys.size} 个人物实例。</p></div><button disabled={busy} onClick={onCreate} className="dialog-secondary ml-auto">新建人物</button></div>{availableIdentities.length ? <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{availableIdentities.map(identity => { const representative = allSubjects.find(candidate => candidate.identity?.id === identity.id); const count = allSubjects.filter(candidate => candidate.identity?.id === identity.id).length; return <button key={identity.id} disabled={busy || !includedKeys.size} onClick={() => onConfirm(identity.id)} className="overflow-hidden rounded-xl border border-slate-200 bg-white text-left transition hover:border-blue-400 hover:shadow-md disabled:opacity-50">{representative ? <IdentitySubjectThumb subject={representative} cacheConfig={cacheConfig} compact/> : <div className="flex aspect-[4/3] items-center justify-center bg-slate-100 text-slate-400"><UserRound/></div>}<div className="flex items-center gap-2 p-3"><span className="h-2.5 w-2.5 rounded-full" style={{ background: identity.color }}/><span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">{identity.name}</span><span className="text-[10px] text-slate-400">{count} 张</span></div></button>; })}</div> : <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">还没有已确认人物，请新建第一个人物。</div>}</div>
        </section>
      </div>
      {busy && <footer className="flex items-center justify-center border-t border-blue-100 bg-blue-50 px-5 py-3 text-xs font-bold text-blue-700"><Loader2 size={14} className="mr-2 animate-spin"/>{busyLabel}</footer>}
    </div>
  </div>;
};

type CropHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

const InteractiveCropEditor = ({ previewUrl, imageSize, crop, onChange }: { previewUrl: string; imageSize: { width: number; height: number }; crop: Crop; onChange: (crop: Crop) => void }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ pointerId: number; handle: CropHandle; x: number; y: number; crop: Crop } | null>(null);
  const minimumSize = Math.max(40, Math.round(Math.min(imageSize.width, imageSize.height) * .025));
  const handleSize = Math.max(40, Math.min(imageSize.width, imageSize.height) / 28);

  const imagePoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  };

  const beginDrag = (event: ReactPointerEvent<SVGElement>, handle: CropHandle) => {
    event.preventDefault();
    event.stopPropagation();
    const point = imagePoint(event.clientX, event.clientY);
    svgRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, handle, x: point.x, y: point.y, crop: { ...crop } };
  };

  const moveDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = imagePoint(event.clientX, event.clientY);
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    if (drag.handle === 'move') {
      onChange({
        ...drag.crop,
        x: Math.round(Math.max(0, Math.min(imageSize.width - drag.crop.width, drag.crop.x + dx))),
        y: Math.round(Math.max(0, Math.min(imageSize.height - drag.crop.height, drag.crop.y + dy))),
      });
      return;
    }
    let left = drag.crop.x;
    let top = drag.crop.y;
    let right = drag.crop.x + drag.crop.width;
    let bottom = drag.crop.y + drag.crop.height;
    if (drag.handle.includes('w')) left = Math.max(0, Math.min(right - minimumSize, drag.crop.x + dx));
    if (drag.handle.includes('e')) right = Math.min(imageSize.width, Math.max(left + minimumSize, drag.crop.x + drag.crop.width + dx));
    if (drag.handle.includes('n')) top = Math.max(0, Math.min(bottom - minimumSize, drag.crop.y + dy));
    if (drag.handle.includes('s')) bottom = Math.min(imageSize.height, Math.max(top + minimumSize, drag.crop.y + drag.crop.height + dy));
    onChange({ x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) });
  };

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };

  const corners: Array<{ handle: Exclude<CropHandle, 'move'>; x: number; y: number; cursor: string }> = [
    { handle: 'nw', x: crop.x, y: crop.y, cursor: 'nwse-resize' },
    { handle: 'ne', x: crop.x + crop.width, y: crop.y, cursor: 'nesw-resize' },
    { handle: 'sw', x: crop.x, y: crop.y + crop.height, cursor: 'nesw-resize' },
    { handle: 'se', x: crop.x + crop.width, y: crop.y + crop.height, cursor: 'nwse-resize' },
  ];

  return <div className="mt-4 flex max-h-80 justify-center overflow-hidden rounded-xl bg-slate-950">
    <svg ref={svgRef} className="max-h-80 w-full select-none touch-none" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <image href={previewUrl} width={imageSize.width} height={imageSize.height} pointerEvents="none"/>
      <path d={`M0 0H${imageSize.width}V${imageSize.height}H0Z M${crop.x} ${crop.y}V${crop.y + crop.height}H${crop.x + crop.width}V${crop.y}Z`} fill="rgba(2,6,23,.55)" fillRule="evenodd" pointerEvents="none"/>
      <rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} fill="rgba(37,99,235,.1)" stroke="#60a5fa" strokeWidth={Math.max(3, imageSize.width / 800)} style={{ cursor: 'move' }} onPointerDown={event => beginDrag(event, 'move')}/>
      {corners.map(corner => <rect key={corner.handle} x={corner.x - handleSize / 2} y={corner.y - handleSize / 2} width={handleSize} height={handleSize} rx={handleSize * .16} fill="#ffffff" stroke="#2563eb" strokeWidth={Math.max(3, imageSize.width / 900)} style={{ cursor: corner.cursor }} onPointerDown={event => beginDrag(event, corner.handle)}/>)}
    </svg>
  </div>;
};

const taskIdentityNames = (task: TeamPatchTask, photoId: string, baseVersionId: string, assignments: Map<string, TeamPersonAssignment>, identities: Map<string, TeamIdentity>) => {
  const names = membersOf(task).map(member => {
    const identityId = assignments.get(assignmentKey(photoId, baseVersionId, member.personIndex))?.identityId;
    const identity = identityId ? identities.get(identityId) : undefined;
    return identity && !isGeneratedIdentity(identity) ? identity.name : undefined;
  }).filter((value): value is string => Boolean(value));
  return [...new Set(names)];
};

type PhotoCardProps = Omit<Props, 'entries' | 'activeStep' | 'onStepChange'> & {
  entry: ProjectFileEntry;
  identityState: IdentityState;
  refreshToken: number;
  onIdentityChanged: () => Promise<void>;
  onDetectionComplete: () => Promise<void>;
  onPickIdentity: (subjectKey: string) => void;
  processingMessage?: string;
  initialPhoto?: TeamProjectPhoto;
};

const TeamRetouchPhotoCard = ({ entry, workspacePath, project, cacheConfig, defaultBackendMode, identityState, refreshToken, onIdentityChanged, onDetectionComplete, onPickIdentity, processingMessage, initialPhoto, onNotice, onEntriesChange, onProjectChanged }: PhotoCardProps) => {
  const appDialog = useAppDialog();
  const [bundle, setBundle] = useState<TeamPatchBundle>(() => initialPhoto ? bundleFromWorkspacePhoto(initialPhoto) : { success: true, versions: [], tasks: [] });
  const [loading, setLoading] = useState(!initialPhoto);
  const [busy, setBusy] = useState('');
  const backendMode = defaultBackendMode || 'auto';
  const [cropEditor, setCropEditor] = useState<{ task: TeamPatchTask; crop: Crop } | null>(null);
  useEscapeLayer(Boolean(cropEditor), () => setCropEditor(null), !busy.startsWith('crop:'));
  const [detectionProgress, setDetectionProgress] = useState({ progress: 0, message: '等待识别操作' });
  const [sourceFullscreen, setSourceFullscreen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const initialWorkspaceBundleRef = useRef(Boolean(initialPhoto));
  const [previewEnabled, setPreviewEnabled] = useState(false);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof IntersectionObserver === 'undefined') { setPreviewEnabled(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setPreviewEnabled(true);
      observer.disconnect();
    }, { rootMargin: '800px 0px' });
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  const load = async () => {
    setLoading(true);
    const result = await window.electronAPI.getTeamPatches(workspacePath, project.status, project.name, entry.relativePath);
    setLoading(false);
    if (!result.success) { onNotice(`打开团片协作失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeBundle(result));
  };
  useEffect(() => {
    if (initialWorkspaceBundleRef.current) { initialWorkspaceBundleRef.current = false; return; }
    void load();
  }, [entry.path, entry.updatedAt, refreshToken]);

  const baseVersion = useMemo<MediaVersion | undefined>(() => bundle.versions.find(version => version.id === bundle.photo?.currentVersionId) || bundle.versions.find(version => version.isCurrent) || bundle.versions.at(-1), [bundle.versions, bundle.photo?.currentVersionId]);
  const tasks = useMemo(() => bundle.tasks.filter(task => task.baseVersionId === baseVersion?.id), [bundle.tasks, baseVersion?.id]);
  const previewUrl = useLazyPreview(baseVersion?.filePath, cacheConfig, 1280, '', previewEnabled);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const assignments = useMemo(() => new Map(identityState.assignments.map(item => [assignmentKey(item.photoId, item.baseVersionId, item.personIndex), item])), [identityState.assignments]);
  const identities = useMemo(() => new Map(identityState.identities.map(item => [item.id, item])), [identityState.identities]);
  useEffect(() => {
    if (!tasks.length) return;
    const inferredWidth = Math.max(...tasks.map(task => Math.max(task.crop.x + task.crop.width, ...(membersOf(task).map(member => member.bbox.x + member.bbox.width)), sourceDimensionFromMask(task.mask?.width, task.mask?.scale))));
    const inferredHeight = Math.max(...tasks.map(task => Math.max(task.crop.y + task.crop.height, ...(membersOf(task).map(member => member.bbox.y + member.bbox.height)), sourceDimensionFromMask(task.mask?.height, task.mask?.scale))));
    setImageSize({ width: Math.max(1, Math.round(inferredWidth)), height: Math.max(1, Math.round(inferredHeight)) });
  }, [tasks]);

  useEffect(() => window.electronAPI.onTeamPatchDetectionProgress(value => {
    if (value.photoId === bundle.photo?.id && value.baseVersionId === baseVersion?.id) setDetectionProgress({ progress: value.progress, message: value.message });
  }), [bundle.photo?.id, baseVersion?.id]);

  const detect = async (restoreExcluded = false) => {
    if (!bundle.photo || !baseVersion) return;
    if (tasks.length && !await appDialog.confirm({
      title: restoreExcluded ? '恢复已排除人物并重新识别？' : '重新识别这张图片？',
      message: restoreExcluded ? '会清除这张图片的人工排除记录，并重新显示算法检测到的人物。当前裁图、人物标注和确认状态也会被替换。' : '会替换当前裁图、人物标注和确认状态；人工排除的误识别人物仍会保持隐藏。',
      confirmLabel: restoreExcluded ? '恢复并重新识别' : '重新识别',
      tone: 'danger',
    })) return;
    setBusy('detect');
    setDetectionProgress({ progress: 1, message: '正在启动 AI 识别进程…' });
    const result = await window.electronAPI.detectTeamPatchPeople(workspacePath, project.status, project.name, { photoId: bundle.photo.id, baseVersionId: baseVersion.id, backendMode, restoreExcluded });
    setBusy('');
    if (!result.success) { onNotice(`AI 识别失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeBundle(result));
    await onDetectionComplete();
    const personCount = result.detection?.personCount || result.tasks.reduce((total, task) => total + membersOf(task).length, 0);
    onNotice(restoreExcluded ? `已恢复人工排除记录并重新识别 ${personCount} 个人物` : `已识别 ${personCount} 个人物，并自动尝试匹配项目中的人物身份`);
  };

  const updateTask = async (task: TeamPatchTask, changes: { personName?: string; assignee?: string; crop?: Crop; needsReview?: boolean; reviewReason?: string }) => {
    if (!bundle.photo) return null;
    const result = await window.electronAPI.updateTeamPatch(workspacePath, { photoId: bundle.photo.id, taskId: task.id, status: project.status, projectName: project.name, ...changes });
    if (!result.success) { onNotice(`更新工作图失败：${result.error || '未知错误'}`); return null; }
    setBundle(current => ({ ...current, tasks: result.tasks }));
    return result;
  };

  const saveCrop = async () => {
    if (!cropEditor) return;
    setBusy(`crop:${cropEditor.task.id}`);
    const result = await updateTask(cropEditor.task, { crop: cropEditor.crop, needsReview: false, reviewReason: '' });
    setBusy('');
    if (result) { setCropEditor(null); onNotice(result.warning || `已按新范围重新生成工作图${result.workflowRefreshCount ? `，并同步更新 ${result.workflowRefreshCount} 个工作区文件` : ''}`); }
  };

  const deleteTask = async (task: TeamPatchTask) => {
    if (!bundle.photo || !await appDialog.confirm({ title: '删除这张错误工作图？', message: '会删除该工作图及其中人物的标记；原照片不会删除。如只是范围不完整，请选择“调整范围”。', confirmLabel: '删除错误工作图', tone: 'danger' })) return;
    setBusy(`delete:${task.id}`);
    const result = await window.electronAPI.deleteTeamPatch(workspacePath, { photoId: bundle.photo.id, taskId: task.id });
    setBusy('');
    if (!result.success) { onNotice(`删除工作图失败：${result.error || '未知错误'}`); return; }
    setBundle(current => ({ ...current, tasks: result.tasks }));
    await onIdentityChanged();
  };

  const removeFromProject = async () => {
    if (!bundle.photo || !baseVersion || !await appDialog.confirm({ title: `从团片协作中删除“${bundle.photo.displayName || entry.name}”？`, message: '会删除这张图片的裁图、人物标注和流程状态，原照片不会删除。', confirmLabel: '删除团片协作数据', tone: 'danger' })) return;
    setBusy('remove-photo');
    const result = await window.electronAPI.removeProjectTeamPhoto(workspacePath, { photoId: bundle.photo.id, baseVersionId: baseVersion.id });
    setBusy('');
    if (!result.success) { onNotice(`删除失败：${result.error || '未知错误'}`); return; }
    onProjectChanged?.();
    onEntriesChange?.([]);
  };

  const identifiedCount = tasks.reduce((total, task) => total + membersOf(task).filter(member => {
    const identityId = assignments.get(assignmentKey(task.photoId, task.baseVersionId, member.personIndex))?.identityId;
    const identity = identityId ? identities.get(identityId) : undefined;
    return identity && !isGeneratedIdentity(identity);
  }).length, 0);
  const personCount = tasks.reduce((total, task) => total + membersOf(task).length, 0);
  const excludedPersonCount = baseVersion ? bundle.excludedPersonCounts?.[baseVersion.id] ?? bundle.excludedPersonCount ?? 0 : 0;
  const visibleProcessingMessage = processingMessage || (busy === 'detect' ? `${detectionProgress.message} · ${Math.round(detectionProgress.progress)}%` : '');

  return <div ref={cardRef} aria-busy={Boolean(visibleProcessingMessage)} className={`relative ${cropEditor ? 'overflow-visible' : 'overflow-hidden'} rounded-2xl border border-slate-200 bg-slate-50 shadow-sm`} style={cropEditor ? undefined : { contentVisibility: 'auto', containIntrinsicSize: '900px' }}>
    {visibleProcessingMessage && <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-200/85 backdrop-grayscale"><div className="flex max-w-sm items-center gap-3 rounded-xl border border-slate-300 bg-white px-5 py-4 text-sm font-bold text-slate-700 shadow-xl"><Loader2 size={18} className="shrink-0 animate-spin text-blue-600"/><span>{visibleProcessingMessage}</span></div></div>}
    <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3"><div className="min-w-0"><h3 className="truncate font-bold text-slate-900">{bundle.photo?.displayName || entry.name}</h3><p className="mt-0.5 text-xs text-slate-500">{tasks.length} 张工作图 · {identifiedCount}/{personCount} 个人物已标记{tasks.some(task => task.needsReview) ? ` · ${tasks.filter(task => task.needsReview).length} 张建议检查` : ''}{excludedPersonCount ? ` · 已排除 ${excludedPersonCount} 个误识别` : ''}</p></div><div className="ml-auto flex flex-wrap items-center gap-2"><button disabled={!baseVersion || Boolean(busy)} onClick={() => void detect()} className="dialog-secondary inline-flex items-center gap-2">{busy === 'detect' ? <Loader2 size={15} className="animate-spin"/> : tasks.length ? <RefreshCw size={15}/> : <ScanFace size={15}/>} {tasks.length ? '重新识别本图' : '识别本图'}</button>{excludedPersonCount > 0 && <button disabled={!baseVersion || Boolean(busy)} onClick={() => void detect(true)} className="dialog-secondary inline-flex items-center gap-2"><RefreshCw size={15}/>恢复已排除（{excludedPersonCount}）</button>}{baseVersion && <button disabled={Boolean(busy)} onClick={() => void removeFromProject()} title="从项目团片协作中删除这张图片" className="rounded-md border border-red-200 p-2 text-red-600 hover:bg-red-50"><Trash2 size={15}/></button>}</div></header>
    {busy === 'detect' && <div className="border-b border-blue-100 bg-blue-50 px-5 py-3"><div className="flex justify-between text-xs font-bold text-blue-700"><span>{detectionProgress.message}</span><span>{Math.round(detectionProgress.progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full bg-blue-600" style={{ width: `${detectionProgress.progress}%` }}/></div></div>}
    {loading ? <div className="flex min-h-64 items-center justify-center gap-2 text-slate-500"><Loader2 className="animate-spin"/>正在读取人物数据…</div> : <div className="grid grid-cols-[minmax(320px,.9fr)_minmax(440px,1.1fr)]">
      <section className="border-r border-slate-200 bg-slate-950 p-4"><div className="relative mx-auto flex min-h-[500px] items-center justify-center overflow-hidden rounded-xl bg-black">{previewUrl ? <svg className="max-h-[calc(100vh-190px)] w-full" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet"><image href={previewUrl} width={imageSize.width} height={imageSize.height} onLoad={() => { if (tasks.length) return; const image = new Image(); image.onload = () => setImageSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 }); image.src = previewUrl; }}/>{tasks.map((task, index) => <g key={task.id}><rect x={task.crop.x} y={task.crop.y} width={task.crop.width} height={task.crop.height} fill="rgba(59,130,246,.06)" stroke={task.needsReview ? '#fb923c' : '#60a5fa'} strokeWidth={Math.max(3, imageSize.width / 900)}/>{membersOf(task).map(member => { const color = personColor(member.personIndex); const fontSize = Math.max(20, imageSize.width / 100); return <g key={member.personIndex}><rect x={member.bbox.x} y={member.bbox.y} width={member.bbox.width} height={member.bbox.height} fill={`${color}0d`} stroke={color} strokeWidth={Math.max(2, imageSize.width / 1300)}/><text x={member.bbox.x + fontSize * .25} y={Math.max(fontSize, member.bbox.y - fontSize * .25)} fill={color} fontSize={fontSize} fontWeight="800" paintOrder="stroke" stroke="rgba(0,0,0,.85)" strokeWidth="5">人物 {member.personIndex}</text></g>; })}<text x={task.crop.x + 10} y={task.crop.y + 28} fill="white" fontSize={Math.max(20, imageSize.width / 85)} fontWeight="700" paintOrder="stroke" stroke="rgba(0,0,0,.75)" strokeWidth="5">工作图 {index + 1}</text></g>)}</svg> : <Loader2 className="animate-spin text-slate-500"/>}<ImageZoomButton disabled={!previewUrl} onClick={() => setSourceFullscreen(true)}/></div><p className="mt-3 text-xs leading-5 text-slate-400">蓝框是工作图范围；每个人物使用独立颜色和编号，并与右侧人物标记行对应。橙色框表示建议检查，有误可直接删除工作图。</p>{sourceFullscreen && previewUrl && <FullscreenImageViewer url={previewUrl} filePath={baseVersion?.filePath} cacheConfig={cacheConfig} title={bundle.photo?.displayName || entry.name} details={`${imageSize.width} × ${imageSize.height} px`} onClose={() => setSourceFullscreen(false)}/>}</section>
      <section className="p-5">{!tasks.length ? <div className="flex min-h-96 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center"><ScanFace size={34} className="text-violet-500"/><h4 className="mt-3 font-bold text-slate-800">识别人物并生成工作图</h4><p className="mt-2 text-sm text-slate-500">这一步只识别、裁图和标记人物，不上传返图，也不进行合成。</p><button onClick={() => void detect()} className="dialog-primary mt-4">开始识别</button></div> : <div className="grid gap-4 xl:grid-cols-2">{tasks.map((task, taskIndex) => {
        const names = taskIdentityNames(task, task.photoId, task.baseVersionId, assignments, identities);
        const taskMembers = membersOf(task);
        const taskMarkedCount = taskMembers.filter(member => {
          const identityId = assignments.get(assignmentKey(task.photoId, task.baseVersionId, member.personIndex))?.identityId;
          const identity = identityId ? identities.get(identityId) : undefined;
          return identity && !isGeneratedIdentity(identity);
        }).length;
        const taskFullyMarked = taskMarkedCount === taskMembers.length;
        return <article key={task.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><header className="flex items-start gap-3"><span className={`rounded-full p-2 ${task.needsReview ? 'bg-amber-50 text-amber-600' : taskFullyMarked ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>{task.needsReview ? <AlertTriangle size={17}/> : <UserRound size={17}/>}</span><div className="min-w-0 flex-1"><h4 className="text-sm font-bold text-slate-800">工作图 {taskIndex + 1}</h4><p className="mt-1 truncate text-xs text-slate-500" title={names.join('、')}>{taskMarkedCount ? `人物标记 ${taskMarkedCount}/${taskMembers.length}${names.length ? ` · ${names.join('、')}` : ''}` : `${taskMembers.length} 个人物尚未标记`}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${task.needsReview ? 'bg-amber-50 text-amber-600' : taskFullyMarked ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>{task.needsReview ? '建议检查' : taskFullyMarked ? '已标记' : '未标记'}</span></header>
          {task.reviewReason && <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-700">{task.reviewReason}</p>}
          <PatchPreview task={task} cacheConfig={cacheConfig} enabled={previewEnabled} onPickPerson={personIndex => onPickIdentity(assignmentKey(task.photoId, task.baseVersionId, personIndex))}/>
          <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-2.5"><p className="text-[10px] font-bold text-slate-500">识别并标记人物</p>{taskMembers.map(member => { const subjectKey = assignmentKey(task.photoId, task.baseVersionId, member.personIndex); const assignment = assignments.get(subjectKey); const identity = assignment?.identityId ? identities.get(assignment.identityId) : undefined; const generated = isGeneratedIdentity(identity); const label = identity && !generated ? identity.name : '未标记'; const status = !identity || generated ? '未标记' : assignment?.source === 'manual' ? '已人工确认' : assignment?.source === 'manual-group' ? '组内确认' : '自动候选'; return <button type="button" key={subjectKey} disabled={Boolean(busy)} onClick={() => onPickIdentity(subjectKey)} className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-left transition hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: personColor(member.personIndex) }}/><span className="w-14 text-xs font-bold text-slate-500">人物 {member.personIndex}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${status === '已人工确认' ? 'bg-emerald-50 text-emerald-700' : status === '组内确认' ? 'bg-blue-50 text-blue-700' : status === '自动候选' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{status}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{label}</span><span className="text-[10px] font-bold text-blue-600">{identity && !generated ? '看图修改' : '去标记'}</span></button>; })}<p className="pt-1 text-[10px] text-slate-400">点击人物框或人物行，看图选择已有身份、新建人物，并可一次应用到整组相同人物。</p></div>
          <div className="mt-3 flex flex-wrap gap-2"><button disabled={task.patchMissing} onClick={() => void window.electronAPI.openTeamPatch(task.patchPath)} className="dialog-secondary inline-flex items-center gap-1.5"><ExternalLink size={13}/>打开工作图</button><button onClick={() => setCropEditor({ task, crop: { ...task.crop } })} className="dialog-secondary inline-flex items-center gap-1.5"><SlidersHorizontal size={13}/>调整范围</button><button disabled={Boolean(busy)} onClick={() => void deleteTask(task)} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50"><Trash2 size={13}/>识别错误，删除</button></div>
        </article>;
      })}</div>}</section>
    </div>}
    {cropEditor && <div role="dialog" aria-modal="true" className="fixed inset-0 z-[460] flex items-center justify-center bg-slate-950/70 p-5"><div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl"><div className="flex items-center"><div><h3 className="font-bold text-slate-900">调整工作图范围</h3><p className="mt-1 text-xs text-slate-500">拖动蓝框可移动范围，拖动四角可放大或缩小；也可以精确输入像素。</p></div><button onClick={() => setCropEditor(null)} className="ml-auto p-2 text-slate-500"><X size={18}/></button></div>{previewUrl && <InteractiveCropEditor previewUrl={previewUrl} imageSize={imageSize} crop={cropEditor.crop} onChange={crop => setCropEditor(current => current ? { ...current, crop } : current)}/>}<div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => setCropEditor(current => { if (!current) return current; const marginX = Math.max(20, Math.round(current.crop.width * .1)); const marginY = Math.max(20, Math.round(current.crop.height * .1)); const x = Math.max(0, current.crop.x - marginX); const y = Math.max(0, current.crop.y - marginY); return { ...current, crop: { x, y, width: Math.min(imageSize.width - x, current.crop.width + marginX * 2), height: Math.min(imageSize.height - y, current.crop.height + marginY * 2) } }; })} className="dialog-secondary">四周扩大 10%</button><button type="button" onClick={() => setCropEditor(current => { if (!current) return current; const boxes = membersOf(current.task).map(member => member.bbox); const left = Math.min(...boxes.map(box => box.x)); const top = Math.min(...boxes.map(box => box.y)); const right = Math.max(...boxes.map(box => box.x + box.width)); const bottom = Math.max(...boxes.map(box => box.y + box.height)); const marginX = Math.max(20, Math.round((right - left) * .12)); const marginY = Math.max(20, Math.round((bottom - top) * .12)); const x = Math.max(0, left - marginX); const y = Math.max(0, top - marginY); return { ...current, crop: { x, y, width: Math.min(imageSize.width - x, right - left + marginX * 2), height: Math.min(imageSize.height - y, bottom - top + marginY * 2) } }; })} className="dialog-secondary">完整包住已识别人物</button></div><div className="mt-4 grid grid-cols-2 gap-3">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key} className="text-xs font-bold text-slate-600">{{ x: '左边 X', y: '顶部 Y', width: '宽度', height: '高度' }[key]}<input type="number" min={key === 'x' || key === 'y' ? 0 : 1} value={cropEditor.crop[key]} onChange={event => setCropEditor(current => current ? { ...current, crop: { ...current.crop, [key]: Math.max(key === 'x' || key === 'y' ? 0 : 1, Math.round(Number(event.target.value) || 0)) } } : current)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2"/></label>)}</div><div className="mt-5 flex justify-end gap-2"><button onClick={() => setCropEditor(null)} className="dialog-secondary">取消</button><button disabled={Boolean(busy)} onClick={() => void saveCrop()} className="dialog-primary">{busy.startsWith('crop:') ? '正在重新裁图…' : '保存并重新裁图'}</button></div></div></div>}
  </div>;
};

const syncTaskLabels = async (workspacePath: string, workspace: TeamIdentityWorkspace) => {
  const assignments = new Map(workspace.assignments.map(item => [assignmentKey(item.photoId, item.baseVersionId, item.personIndex), item]));
  const identities = new Map(workspace.identities.map(item => [item.id, item]));
  await Promise.all(workspace.photos.flatMap(photo => photo.tasks.map(async task => {
    const names = taskIdentityNames(task, photo.photoId, photo.baseVersionId, assignments, identities);
    const personName = names.length ? names.join('、') : membersOf(task).map(member => `人物 ${member.personIndex}`).join('、');
    const assignee = names.join('、');
    if (task.personName === personName && task.assignee === assignee) return;
    await window.electronAPI.updateTeamPatch(workspacePath, { photoId: photo.photoId, taskId: task.id, personName, assignee });
  })));
};

const TeamRetouchWorkspace = ({ entries, workspacePath, project, cacheConfig, defaultBackendMode, componentStatus, activeStep, onStepChange, onClose, onNotice, onEntriesChange, onProjectChanged, onBusyChange }: Props) => {
  const appDialog = useAppDialog();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [progress, setProgress] = useState({ itemIndex: 0, itemCount: entries.length, progress: 0, itemName: '', message: '准备批量识别' });
  const backendMode = defaultBackendMode || 'auto';
  const [refreshToken, setRefreshToken] = useState(0);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [identityState, setIdentityState] = useState<IdentityState>({ success: true, photos: [], identities: [], assignments: [] });
  const [identityPickerKey, setIdentityPickerKey] = useState('');
  const [includedIdentityKeys, setIncludedIdentityKeys] = useState<Set<string>>(new Set());
  const [identityPickerBusy, setIdentityPickerBusy] = useState(false);
  const [identityPickerBusyLabel, setIdentityPickerBusyLabel] = useState('正在保存整组人物标记…');
  const [photoRefreshTokens, setPhotoRefreshTokens] = useState<Record<string, number>>({});
  const [photoProcessingMessages, setPhotoProcessingMessages] = useState<Record<string, string>>({});
  const identifyingRef = useRef(false);
  const lastUnmarkedSubjectKeyRef = useRef('');
  useEffect(() => {
    onBusyChange?.(running || Boolean(identityState.identifying) || identityPickerBusy);
  }, [identityPickerBusy, identityState.identifying, onBusyChange, running]);
  const identitySubjects = useMemo(() => identitySubjectsFromWorkspace(identityState), [identityState]);
  const unrecognizedPaths = useMemo(() => entries
    .filter(entry => !(workspacePhotoForEntry(identityState.photos, entry)?.tasks.length))
    .map(entry => entry.relativePath), [entries, identityState.photos]);
  const selectedIdentitySubject = identitySubjects.find(subject => subject.key === identityPickerKey);
  const selectedCandidateSubjects = useMemo(() => {
    if (!selectedIdentitySubject) return [];
    const identityId = selectedIdentitySubject.assignment?.identityId;
    const source = selectedIdentitySubject.assignment?.source;
    const candidates = identityId && (isGeneratedIdentity(selectedIdentitySubject.identity) || source === 'suggested')
      ? identitySubjects.filter(subject => subject.assignment?.identityId === identityId && (isGeneratedIdentity(selectedIdentitySubject.identity) || subject.assignment?.source === 'suggested' || subject.key === selectedIdentitySubject.key))
      : [selectedIdentitySubject];
    return [selectedIdentitySubject, ...candidates.filter(subject => subject.key !== selectedIdentitySubject.key).sort((left, right) => (right.assignment?.confidence || 0) - (left.assignment?.confidence || 0))];
  }, [selectedIdentitySubject, identitySubjects]);

  const loadIdentities = async (syncLabels = false) => {
    const result = await window.electronAPI.getTeamProjectWorkspace(workspacePath, project.name);
    if (result.success) {
      if (syncLabels) await syncTaskLabels(workspacePath, result);
      setIdentityState(result);
    } else onNotice(`读取人物数据失败：${result.error || '未知错误'}`);
    setIdentityLoading(false);
  };
  useEffect(() => {
    setIdentityLoading(true);
    void loadIdentities();
  }, [workspacePath, project.name]);
  useEffect(() => window.electronAPI.onTeamPatchBatchProgress(value => setProgress({ itemIndex: value.itemIndex, itemCount: value.itemCount, progress: value.progress, itemName: value.itemName, message: value.message })), []);

  const openIdentityPicker = (subjectKey: string) => {
    const subject = identitySubjects.find(candidate => candidate.key === subjectKey);
    if (!subject) { onNotice('人物识别数据仍在加载，请稍后再试'); return; }
    const identityId = subject.assignment?.identityId;
    const source = subject.assignment?.source;
    const candidates = identityId && (isGeneratedIdentity(subject.identity) || source === 'suggested')
      ? identitySubjects.filter(candidate => candidate.assignment?.identityId === identityId && (isGeneratedIdentity(subject.identity) || candidate.assignment?.source === 'suggested' || candidate.key === subject.key))
      : [subject];
    const uniqueCandidates = uniqueIdentitySubjectsPerPhoto([subject, ...candidates], subject.key);
    setIncludedIdentityKeys(new Set(uniqueCandidates.map(candidate => candidate.key)));
    if (isUnmarkedIdentitySubject(subject)) lastUnmarkedSubjectKeyRef.current = subject.key;
    setIdentityPickerKey(subject.key);
  };

  const openNextUnmarkedIdentity = () => {
    if (!identitySubjects.some(isUnmarkedIdentitySubject)) { onNotice('当前没有未标记人物'); return; }
    const lastIndex = identitySubjects.findIndex(subject => subject.key === lastUnmarkedSubjectKeyRef.current);
    const ordered = lastIndex >= 0 ? [...identitySubjects.slice(lastIndex + 1), ...identitySubjects.slice(0, lastIndex + 1)] : identitySubjects;
    const nextSubject = ordered.find(isUnmarkedIdentitySubject);
    if (nextSubject) openIdentityPicker(nextSubject.key);
  };

  const confirmIdentitySelection = async (identityId?: string, name?: string) => {
    if (!selectedIdentitySubject || !includedIdentityKeys.has(selectedIdentitySubject.key)) return;
    const selectedSubjects = identitySubjects.filter(subject => includedIdentityKeys.has(subject.key));
    const uniqueSelectedSubjects = uniqueIdentitySubjectsPerPhoto(selectedSubjects, selectedIdentitySubject.key);
    const duplicateCount = selectedSubjects.length - uniqueSelectedSubjects.length;
    const assignments = uniqueSelectedSubjects.map(subject => ({
      photoId: subject.photo.photoId,
      baseVersionId: subject.photo.baseVersionId,
      personIndex: subject.personIndex,
      confidence: subject.key === selectedIdentitySubject.key ? 1 : Math.max(.5, subject.assignment?.confidence || .5),
    }));
    setIdentityPickerBusyLabel('正在保存整组人物标记…');
    setIdentityPickerBusy(true);
    const result = await window.electronAPI.confirmTeamIdentityGroup(workspacePath, {
      projectName: project.name,
      anchorSubjectKey: selectedIdentitySubject.key,
      identityId,
      name,
      assignments,
    });
    setIdentityPickerBusy(false);
    if (!result.success) { onNotice(`整组标记人物失败：${result.error || '未知错误'}`); return; }
    setIdentityState(result);
    setIdentityPickerKey('');
    setIncludedIdentityKeys(new Set());
    void syncTaskLabels(workspacePath, result).catch(() => undefined);
    onProjectChanged?.();
    const identity = result.identities.find(item => item.id === result.identityId);
    const releaseNote = result.autoReleasedCount ? `；同图中 ${result.autoReleasedCount} 个自动候选已让位` : '';
    const skippedDuplicates = Math.max(duplicateCount, result.duplicateSkippedCount || 0);
    const duplicateNote = skippedDuplicates ? `；已自动取消 ${skippedDuplicates} 张同图重复候选` : '';
    onNotice(identity ? `已将 ${result.updatedCount || assignments.length} 个人物实例标记为“${identity.name}”${releaseNote}${duplicateNote}` : `已将 ${result.updatedCount || assignments.length} 个人物实例设为未标记${duplicateNote}`);
  };

  const toggleIdentityCandidate = (key: string) => {
    const candidate = identitySubjects.find(subject => subject.key === key);
    if (!candidate || !selectedIdentitySubject || key === selectedIdentitySubject.key) return;
    setIncludedIdentityKeys(current => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        const duplicate = identitySubjects.find(subject => subject.key !== key && next.has(subject.key) && identitySubjectPhotoKey(subject) === identitySubjectPhotoKey(candidate));
        if (duplicate?.key === selectedIdentitySubject.key) {
          onNotice('当前图片中的人物优先保留，已跳过这张同图重复候选');
          return current;
        }
        if (duplicate) next.delete(duplicate.key);
        next.add(key);
      }
      next.add(selectedIdentitySubject.key);
      return next;
    });
  };

  const createIdentityFromPicker = async () => {
    if (!selectedIdentitySubject) return;
    const answer = await appDialog.prompt({ title: '把候选组标记为新人物', message: `填写姓名后，将应用到当前勾选的 ${includedIdentityKeys.size} 个人物实例。`, defaultValue: `人物 ${identityState.identities.filter(identity => !isGeneratedIdentity(identity)).length + 1}`, confirmLabel: '新建并标记整组' });
    const name = answer?.trim();
    if (!name) return;
    const existing = identityState.identities.find(identity => !isGeneratedIdentity(identity) && identity.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
    // Create a real identity instead of renaming the temporary candidate ID.
    // Unchecked images can then remain in their original candidate group.
    await confirmIdentitySelection(existing?.id, existing ? undefined : name);
  };

  const renameIdentityFromPicker = async (identity: TeamIdentity) => {
    const answer = await appDialog.prompt({ title: `修改人物“${identity.name}”`, message: '新姓名会同步用于该人物的任务标记。', defaultValue: identity.name, confirmLabel: '保存姓名' });
    const name = answer?.trim();
    if (!name || name === identity.name) return;
    setIdentityPickerBusy(true);
    const result = await window.electronAPI.saveTeamIdentity(workspacePath, { projectName: project.name, identityId: identity.id, name });
    setIdentityPickerBusy(false);
    if (!result.success) { onNotice(`修改人物姓名失败：${result.error || '未知错误'}`); return; }
    const nextState = { ...identityState, identities: identityState.identities.map(item => item.id === identity.id ? { ...item, name, updatedAt: Date.now() } : item) };
    setIdentityState(nextState);
    void syncTaskLabels(workspacePath, nextState).catch(() => undefined);
    onNotice(`人物姓名已修改为“${name}”`);
  };

  const deleteIdentityFromPicker = async (identity: TeamIdentity) => {
    const confirmed = await appDialog.confirm({ title: `删除人物“${identity.name}”？`, message: '会取消该人物全部实例的身份与完成状态，不会删除照片或工作图。', confirmLabel: '删除人物', tone: 'danger' });
    if (!confirmed) return;
    setIdentityPickerBusy(true);
    const result = await window.electronAPI.deleteTeamIdentity(workspacePath, { projectName: project.name, identityId: identity.id });
    setIdentityPickerBusy(false);
    if (!result.success) { onNotice(`删除人物失败：${result.error || '未知错误'}`); return; }
    const nextState = {
      ...identityState,
      identities: identityState.identities.filter(item => item.id !== identity.id),
      assignments: identityState.assignments.map(item => item.identityId === identity.id ? { ...item, identityId: undefined, completed: false, updatedAt: Date.now() } : item),
    };
    setIdentityState(nextState);
    setIdentityPickerKey('');
    void syncTaskLabels(workspacePath, nextState).catch(() => undefined);
    onNotice(`已删除人物“${identity.name}”`);
  };

  const excludeSubjectFromPicker = async () => {
    if (!selectedIdentitySubject) return;
    const subject = selectedIdentitySubject;
    const confirmed = await appDialog.confirm({
      title: `移除“${subject.photo.name}”中的人物 ${subject.personIndex}？`,
      message: '这会把当前人物记为误识别，重新计算这张图片的工作图，并保留其他人物已有的身份标记。不会删除原照片，也不会删除人物身份。',
      confirmLabel: '移除误识别人物',
      tone: 'danger',
    });
    if (!confirmed) return;
    const photoId = subject.photo.photoId;
    setIdentityPickerKey('');
    setIncludedIdentityKeys(new Set());
    setPhotoProcessingMessages(current => ({ ...current, [photoId]: '正在移除误识别人物并重新计算工作图…' }));
    const result = await window.electronAPI.excludeTeamPerson(workspacePath, project.status, project.name, {
      photoId,
      baseVersionId: subject.photo.baseVersionId,
      personIndex: subject.personIndex,
      backendMode,
    });
    setPhotoProcessingMessages(current => { const next = { ...current }; delete next[photoId]; return next; });
    if (!result.success) { onNotice(`移除误识别人物失败：${result.error || '未知错误'}`); return; }
    setIdentityState(result);
    setPhotoRefreshTokens(current => ({ ...current, [photoId]: (current[photoId] || 0) + 1 }));
    void syncTaskLabels(workspacePath, result).catch(() => undefined);
    onProjectChanged?.();
    onNotice(result.warning || `已移除误识别人物，并重新计算当前图片的工作图；其他人物标记已保留${result.workflowRefreshCount ? `，同步更新 ${result.workflowRefreshCount} 个任务文件` : ''}`);
  };

  const identifyAndSync = async () => {
    if (identifyingRef.current) return;
    identifyingRef.current = true;
    setIdentityState(current => ({ ...current, identifying: true }));
    const result = await window.electronAPI.suggestTeamIdentities(workspacePath, project.name);
    identifyingRef.current = false;
    if (!result.success) { setIdentityState(current => ({ ...current, identifying: false })); onNotice(`人物自动标记失败：${result.error || '未知错误'}`); return; }
    await syncTaskLabels(workspacePath, result);
    setIdentityState({ ...result, identifying: false });
    onProjectChanged?.();
  };

  const runBatch = async () => {
    if (identityLoading) return;
    const targetEntries = unrecognizedPaths.length ? entries.filter(entry => unrecognizedPaths.includes(entry.relativePath)) : entries;
    setRunning(true);
    setResults([]);
    const result = await window.electronAPI.detectTeamPatchBatch(workspacePath, project.status, project.name, { relativePaths: targetEntries.map(entry => entry.relativePath), backendMode });
    setRunning(false);
    setResults(result.results || []);
    setRefreshToken(current => current + 1);
    if (!result.success) { onNotice(`识别图片失败：${result.error || '未知错误'}`); return; }
    await identifyAndSync();
    onNotice(`识别完成：${result.results.filter(item => item.success).length}/${targetEntries.length} 张成功，并已自动尝试标记人物`);
  };

  const overallProgress = progress.itemCount ? Math.max(0, Math.min(100, ((Math.max(1, progress.itemIndex) - 1) + progress.progress / 100) / progress.itemCount * 100)) : 0;
  const resultByPath = new Map(results.map(result => [result.relativePath, result]));
  const advancedNeedsRepair = componentStatus?.advancedState === 'repair-needed';
  const confirmedIdentityCount = identitySubjects.filter(subject => subject.identity && !isGeneratedIdentity(subject.identity) && ['manual', 'manual-group'].includes(subject.assignment?.source || '')).length;
  const candidateIdentityCount = identitySubjects.filter(subject => subject.identity && !isGeneratedIdentity(subject.identity) && subject.assignment?.source === 'suggested').length;
  const unmarkedIdentityCount = identitySubjects.filter(isUnmarkedIdentitySubject).length;

  return <div className="fixed inset-x-0 bottom-0 top-10 z-[310] flex flex-col bg-slate-50"><header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3"><span className="rounded-xl bg-violet-50 p-2 text-violet-600"><UsersRound size={20}/></span><div><h2 className="font-bold text-slate-900">团片协作 · {entries.length} 张图片</h2><p className="mt-0.5 text-xs text-slate-500">识别并裁图时同步标记人物；确认后再生成工作流程。</p></div><TeamRetouchSteps value={activeStep} onChange={onStepChange} disabled={running}/><div className="ml-auto flex items-center gap-2"><button disabled={running || identityLoading} onClick={() => void runBatch()} className="dialog-secondary inline-flex items-center gap-2">{running || identityLoading ? <Loader2 size={15} className="animate-spin"/> : <ScanFace size={15}/>} {identityLoading ? '读取项目数据…' : unrecognizedPaths.length ? `识别新增图片（${unrecognizedPaths.length} 张）` : entries.length > 1 ? '重新识别全部图片' : '重新识别图片'}</button><button disabled={running || identityLoading || identityState.identifying} onClick={() => void identifyAndSync()} className="dialog-primary inline-flex items-center gap-2">{identityState.identifying ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>}重新自动标记人物</button><button onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={20}/></button></div></header>
    <div className={`border-b px-5 py-2 text-xs ${componentStatus?.advancedAvailable ? 'border-violet-100 bg-violet-50 text-violet-700' : advancedNeedsRepair ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-blue-100 bg-blue-50 text-blue-700'}`}><span className="font-bold">{componentStatus?.advancedAvailable ? '高级引擎可用' : advancedNeedsRepair ? '高级引擎需要修复' : '基础可用 · 高级未安装'}</span></div>
    {!!identitySubjects.length && <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-5 py-2 text-xs"><span className="font-bold text-slate-700">人物标记</span><span className="rounded-full bg-emerald-50 px-2.5 py-1 font-bold text-emerald-700">已确认 {confirmedIdentityCount}</span>{candidateIdentityCount > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 font-bold text-amber-700">自动候选 {candidateIdentityCount}</span>}<button type="button" disabled={!unmarkedIdentityCount || identityLoading || identityState.identifying} onClick={openNextUnmarkedIdentity} title="打开下一个未标记人物" className="rounded-full bg-slate-100 px-2.5 py-1 font-bold text-slate-600 transition hover:bg-blue-50 hover:text-blue-700 disabled:cursor-default disabled:opacity-50">未标记 {unmarkedIdentityCount}{unmarkedIdentityCount ? ' · 下一个' : ''}</button><span className="ml-auto text-slate-500">点击“未标记”可连续找到下一处，也可直接点击人物框或人物行</span></div>}
    {running && <div className="border-b border-blue-100 bg-blue-50 px-5 py-3"><div className="flex justify-between text-xs font-bold text-blue-700"><span>{progress.itemIndex ? `${progress.itemIndex}/${progress.itemCount} · ${progress.itemName} · ` : ''}{progress.message}</span><span>{Math.round(overallProgress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full bg-blue-600" style={{ width: `${overallProgress}%` }}/></div></div>}
    <main className="min-h-0 flex-1 overflow-y-auto p-6"><div className="mx-auto max-w-[1600px] space-y-6">{identityLoading
      ? <div className="flex min-h-52 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-600"><Loader2 size={18} className="mr-2 animate-spin text-blue-600"/>正在读取整个项目的人物与工作图数据…</div>
      : entries.map(entry => {
        const result = resultByPath.get(entry.relativePath);
        const initialPhoto = workspacePhotoForEntry(identityState.photos, entry);
        const photoId = initialPhoto?.photoId || '';
        return <section key={entry.relativePath} className="space-y-2">{result && !result.success && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">{result.error || `${entry.name} 识别失败`}</div>}<TeamRetouchPhotoCard entry={entry} workspacePath={workspacePath} project={project} cacheConfig={cacheConfig} defaultBackendMode={defaultBackendMode} componentStatus={componentStatus} onClose={onClose} onNotice={onNotice} onProjectChanged={onProjectChanged} onEntriesChange={() => { const next = entries.filter(candidate => candidate.relativePath !== entry.relativePath); onEntriesChange?.(next); if (!next.length) onClose(); }} identityState={identityState} initialPhoto={initialPhoto} refreshToken={refreshToken + (photoRefreshTokens[photoId] || 0)} processingMessage={photoProcessingMessages[photoId]} onIdentityChanged={() => loadIdentities(true)} onDetectionComplete={identifyAndSync} onPickIdentity={openIdentityPicker}/></section>;
      })}</div></main>
    {selectedIdentitySubject && <IdentityPicker
      subject={selectedIdentitySubject}
      candidates={selectedCandidateSubjects}
      allSubjects={identitySubjects}
      identities={identityState.identities}
      includedKeys={includedIdentityKeys}
      cacheConfig={cacheConfig}
      busy={identityPickerBusy}
      busyLabel={identityPickerBusyLabel}
      onToggleCandidate={toggleIdentityCandidate}
      onOnlyCurrent={() => setIncludedIdentityKeys(new Set([selectedIdentitySubject.key]))}
      onConfirm={identityId => void confirmIdentitySelection(identityId)}
      onCreate={() => void createIdentityFromPicker()}
      onClear={() => void confirmIdentitySelection()}
      onExclude={() => void excludeSubjectFromPicker()}
      onRename={identity => void renameIdentityFromPicker(identity)}
      onDelete={identity => void deleteIdentityFromPicker(identity)}
      onClose={() => {
        if (!identityPickerBusy) {
          setIdentityPickerKey('');
          setIncludedIdentityKeys(new Set());
        }
      }}
    />}
  </div>;
};

export const TeamRetouchManager = (props: Props) => {
  const [freshComponentStatus, setFreshComponentStatus] = useState(props.componentStatus);
  useEffect(() => {
    setFreshComponentStatus(props.componentStatus);
    if (props.componentStatus?.advancedAvailable) return;
    let active = true;
    void window.electronAPI.getComponents().then(result => { const latest = result.components?.find(component => component.id === 'team-retouch'); if (active && result.success && latest) setFreshComponentStatus(latest); });
    return () => { active = false; };
  }, [props.componentStatus]);
  return <TeamRetouchWorkspace {...props} componentStatus={freshComponentStatus}/>;
};
