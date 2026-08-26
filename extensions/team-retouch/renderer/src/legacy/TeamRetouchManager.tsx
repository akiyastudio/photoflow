// @ts-nocheck -- source-faithful migration from fef15e4^; RPC types are enforced by legacy-api.ts
import { legacyApi } from './legacy-api';
import { readableLegacyMediaError } from './legacy-media-preview-model';
import { legacyAdvancedStatusPresentation } from './legacy-advanced-status-model';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ExternalLink, Loader2, Maximize2, RefreshCw, ScanFace, Settings, SlidersHorizontal, Trash2, UserRound, UsersRound, Wand2, X } from 'lucide-react';
import type { AppConfig, ComponentStatus, MediaVersion, ProjectFileEntry, TeamIdentity, TeamIdentityWorkspace, TeamPatchBundle, TeamPatchTask, TeamPersonAssignment, TeamProjectPhoto, WorkspaceProject } from './legacy-types';
import { useAppDialog } from './legacy-dialog-context';
import { useEscapeLayer } from './legacy-layer';
import { TeamRetouchSteps, type TeamRetouchStep } from './TeamRetouchSteps';
import { ensureFaceRecognitionConsent } from './legacy-privacy';
import { teamWorkflowSourcePaths, useTeamOutputProgress } from './useTeamOutputProgress';
import { workingImageMetrics } from '../interaction-model';
import { createWorkspaceSeedGate, isUsableWorkspaceSeed, workspaceSeedScopeKey } from './legacy-workspace-seed-model';

type Props = {
  componentActive?: boolean;
  entries: ProjectFileEntry[];
  historyRecordCount?: number;
  historyOwnershipPendingCount?: number;
  workspacePath: string;
  project: WorkspaceProject;
  initialWorkspace?: TeamIdentityWorkspace;
  initialWorkspacePending?: boolean;
  cacheConfig: AppConfig['mediaCache'];
  componentStatus?: ComponentStatus;
  advancedStatusLoading?: boolean;
  advancedStatusError?: string;
  onRetryAdvancedStatus?: () => void;
  activeStep: TeamRetouchStep;
  onStepChange: (step: TeamRetouchStep) => void;
  stageSummaries?: import('../interaction-model').StageSummary[];
  onBlockedStage?: (reason: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onNotice: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void;
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

type LazyPreviewState = { url: string; status: 'idle' | 'loading' | 'ready' | 'failed'; error: string };
const thumbnailSizeLabel = (requestedSize: number) => requestedSize <= 320 ? 'small' : requestedSize <= 640 ? 'medium' : 'large';
const pickThumbnailUrl = (previewUrls: Partial<Record<'small' | 'medium' | 'large', string>> | undefined, requestedSize: number) => {
  const preferred = thumbnailSizeLabel(requestedSize);
  return previewUrls?.[preferred] || previewUrls?.large || previewUrls?.medium || previewUrls?.small || '';
};

const useLazyPreview = (filePath: string | undefined, cacheConfig: AppConfig['mediaCache'], size: number, refreshKey = '', enabled = true) => {
  const [state, setState] = useState<LazyPreviewState>({ url: '', status: 'idle', error: '' });
  const [retryToken, setRetryToken] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ url: '', status: filePath && enabled ? 'loading' : 'idle', error: '' });
    if (!filePath || !enabled) return () => { active = false; };
    const stop = legacyApi.onThumbnailStateChanged(update => {
      if (!active || update.filePath.toLocaleLowerCase() !== filePath.toLocaleLowerCase()) return;
      if (update.state === 'READY') {
        const url = pickThumbnailUrl(update.previewUrls, size);
        if (url) setState({ url, status: 'ready', error: '' });
      } else if (update.state === 'FAILED' || update.state === 'MISSING') {
        setState({ url: '', status: 'failed', error: readableLegacyMediaError(update.error || (update.state === 'MISSING' ? '原始文件不存在或磁盘离线' : '预览生成失败'), filePath.includes(':working:') ? 'working' : 'original') });
      }
    });
    void legacyApi.getMediaThumbnail(filePath, originalPreviewKind(filePath), cacheConfig, size, 1, 0).then(result => {
      if (!active) return;
      if (result.previewUrl) setState({ url: result.previewUrl, status: 'ready', error: '' });
      else if (!result.success || result.state === 'FAILED' || result.state === 'MISSING') setState({ url: '', status: 'failed', error: readableLegacyMediaError(result.error || '预览生成失败', filePath.includes(':working:') ? 'working' : 'original') });
    }).catch(error => {
      if (active) setState({ url: '', status: 'failed', error: readableLegacyMediaError(error, filePath.includes(':working:') ? 'working' : 'original') });
    });
    return () => { active = false; stop(); };
  }, [filePath, size, refreshKey, enabled, cacheConfig.directory, cacheConfig.maxSizeGB, retryToken]);
  return { ...state, retry: () => setRetryToken(current => current + 1) };
};

const originalPreviewKind = (filePath: string): 'image' | 'raw' => {
  const extension = filePath.split('.').pop()?.toLocaleLowerCase() || '';
  return ['cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'dng', 'rwl', '3fr', 'fff', 'iiq', 'pef', 'srw'].includes(extension) ? 'raw' : 'image';
};

const LazyPreviewPlaceholder = ({ failed, error, onRetry }: { failed: boolean; error: string; onRetry: () => void }) => failed
  ? <div className="flex max-w-lg flex-col items-center justify-center gap-2 px-4 text-center text-xs text-amber-300"><AlertTriangle size={22}/><strong>预览加载失败</strong><span className="break-words leading-5 text-amber-200" title={error}>{error || '未知媒体读取错误'}</span><button type="button" onClick={onRetry} className="rounded-md border border-amber-400/40 px-2.5 py-1 font-bold text-amber-300 hover:bg-amber-400/10">重试预览</button></div>
  : <Loader2 className="animate-spin text-slate-500"/>;

const FullscreenImageViewer = ({ url, filePath, cacheConfig, title, details, onClose }: { url: string; filePath?: string; cacheConfig?: AppConfig['mediaCache']; title: string; details?: string; onClose: () => void }) => {
  const [displayUrl, setDisplayUrl] = useState(url);
  useEffect(() => {
    let active = true;
    setDisplayUrl(url);
    if (filePath && cacheConfig) void legacyApi.getMediaOriginal(filePath, 'image', cacheConfig).then(result => {
      if (active && result.mediaUrl) setDisplayUrl(result.mediaUrl);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [url, filePath, cacheConfig]);
  useEscapeLayer(true, onClose);
  return createPortal(<div role="dialog" aria-modal="true" aria-label={`全窗口浏览：${title}`} className="fixed inset-0 z-[700] flex flex-col bg-slate-950/95" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-5 text-white"><div className="min-w-0"><h3 className="truncate text-sm font-bold">{title}</h3>{details && <p className="mt-0.5 text-xs text-slate-400">{details}</p>}</div><button type="button" onClick={onClose} title="关闭全窗口浏览" className="ml-auto rounded-md p-2 text-slate-300 hover:bg-white/10 hover:text-white"><X size={20}/></button></header><div className="flex min-h-0 flex-1 items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><img src={displayUrl} alt={title} className="max-h-full max-w-full object-contain"/></div></div>, document.body);
};

const ImageZoomButton = ({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) => <button type="button" disabled={disabled} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); onClick(); }} title="全窗口浏览图片" aria-label="全窗口浏览图片" className="absolute bottom-2 right-2 z-20 rounded-md border border-white/20 bg-black/75 p-1.5 text-white shadow-lg transition hover:bg-blue-600 disabled:hidden"><Maximize2 size={15}/></button>;

const PatchPreview = ({ task, cacheConfig, enabled = true, onPickPerson }: { task: TeamPatchTask; cacheConfig: AppConfig['mediaCache']; enabled?: boolean; onPickPerson?: (personIndex: number) => void }) => {
  const preview = useLazyPreview(task.patchPath, cacheConfig, 480, `${task.updatedAt}:${task.crop.x}:${task.crop.y}:${task.crop.width}:${task.crop.height}`, enabled);
  const [fullscreen, setFullscreen] = useState(false);
  return <><div className="relative flex h-44 items-center justify-center overflow-hidden rounded-lg bg-slate-950">
    {preview.url ? <svg className="h-full w-full" viewBox={`0 0 ${task.crop.width} ${task.crop.height}`} preserveAspectRatio="xMidYMid meet"><image href={preview.url} width={task.crop.width} height={task.crop.height}/>{membersOf(task).map(member => {
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
    })}</svg> : <LazyPreviewPlaceholder failed={preview.status === 'failed'} error={preview.error} onRetry={preview.retry}/>}
    <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[10px] font-bold text-white">识别工作图</span>
    <ImageZoomButton disabled={!preview.url} onClick={() => setFullscreen(true)}/>
  </div><p className="mt-1.5 text-center text-[11px] font-medium tabular-nums text-slate-500">{Math.round(task.crop.width)} × {Math.round(task.crop.height)} px</p>{fullscreen && preview.url && <FullscreenImageViewer url={preview.url} filePath={task.patchPath} cacheConfig={cacheConfig} title="识别工作图" details={`${Math.round(task.crop.width)} × ${Math.round(task.crop.height)} px`} onClose={() => setFullscreen(false)}/>}</>;
};

const IdentitySubjectThumb = ({ subject, cacheConfig, compact = false }: { subject: IdentitySubject; cacheConfig: AppConfig['mediaCache']; compact?: boolean }) => {
  const preview = useLazyPreview(subject.task.patchPath, cacheConfig, compact ? 320 : 480, `${subject.task.updatedAt}:${subject.personIndex}`);
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
    {preview.url ? <svg className="block h-full w-full" viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet"><image href={preview.url} width={subject.task.crop.width} height={subject.task.crop.height}/><rect x={x} y={y} width={boxWidth} height={boxHeight} fill="none" stroke="#facc15" strokeWidth={Math.max(3, viewWidth / 180)}/></svg> : <div className="absolute inset-0 flex items-center justify-center"><LazyPreviewPlaceholder failed={preview.status === 'failed'} error={preview.error} onRetry={preview.retry}/></div>}
    <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 py-1 pl-2 pr-11 text-[10px] font-bold text-white">{subject.photo.name} · 人物 {subject.personIndex}</span><ImageZoomButton disabled={!preview.url} onClick={() => setFullscreen(true)}/>
  </div>{fullscreen && preview.url && <FullscreenImageViewer url={preview.url} filePath={subject.task.patchPath} cacheConfig={cacheConfig} title={`${subject.photo.name} · 人物 ${subject.personIndex}`} details={`${Math.round(subject.task.crop.width)} × ${Math.round(subject.task.crop.height)} px`} onClose={() => setFullscreen(false)}/>}</>;
};

const IdentityChoiceCard = ({ identity, representative, count, cacheConfig, disabled, onSelect }: {
  identity: TeamIdentity;
  representative?: IdentitySubject;
  count: number;
  cacheConfig: AppConfig['mediaCache'];
  disabled: boolean;
  onSelect: () => void;
}) => (
  <div
    className={"group relative overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:border-blue-400 hover:shadow-md focus-within:ring-2 focus-within:ring-blue-500 " + (disabled ? 'opacity-50' : '')}
  >
    {representative
      ? <IdentitySubjectThumb subject={representative} cacheConfig={cacheConfig} compact/>
      : <div className="flex aspect-[4/3] items-center justify-center bg-slate-100 text-slate-400"><UserRound/></div>}
    <div className="pointer-events-none flex w-full items-center gap-2 border-t border-slate-100 p-3 text-left transition group-hover:bg-blue-50">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: identity.color }}/>
      <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">{identity.name}</span>
      <span className="text-[10px] text-slate-400">{count} 张</span>
    </div>
    <button
      type="button"
      disabled={disabled}
      aria-label={`选择人物身份“${identity.name}”`}
      title={`选择“${identity.name}”`}
      onClick={onSelect}
      className="absolute inset-0 z-10 cursor-pointer rounded-xl focus:outline-none disabled:cursor-not-allowed"
    >
      <span className="sr-only">选择人物身份“{identity.name}”</span>
    </button>
  </div>
);

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
          <div className="mt-6 border-t border-slate-200 pt-5"><div className="flex items-center gap-3"><div><h4 className="text-sm font-bold text-slate-800">选择已有身份</h4><p className="mt-1 text-xs text-slate-500">点击后会应用到上方已勾选的 {includedKeys.size} 个人物实例。</p></div><button disabled={busy} onClick={onCreate} className="dialog-secondary ml-auto">新建人物</button></div>{availableIdentities.length ? <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{availableIdentities.map(identity => {
            const representative = allSubjects.find(candidate => candidate.identity?.id === identity.id);
            const count = allSubjects.filter(candidate => candidate.identity?.id === identity.id).length;
            return <IdentityChoiceCard
              key={identity.id}
              identity={identity}
              representative={representative}
              count={count}
              cacheConfig={cacheConfig}
              disabled={busy || !includedKeys.size}
              onSelect={() => onConfirm(identity.id)}
            />;
          })}</div> : <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">还没有已确认人物，请新建第一个人物。</div>}</div>
        </section>
      </div>
      {busy && <footer className="flex items-center justify-center border-t border-blue-100 bg-blue-50 px-5 py-3 text-xs font-bold text-blue-700"><Loader2 size={14} className="mr-2 animate-spin"/>{busyLabel}</footer>}
    </div>
  </div>;
};

type CropHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

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

  const handles: Array<{ handle: Exclude<CropHandle, 'move'>; x: number; y: number; cursor: string; label: string }> = [
    { handle: 'nw', x: crop.x, y: crop.y, cursor: 'nwse-resize', label: '调整左上角裁剪范围' },
    { handle: 'n', x: crop.x + crop.width / 2, y: crop.y, cursor: 'ns-resize', label: '向上调整裁剪范围' },
    { handle: 'ne', x: crop.x + crop.width, y: crop.y, cursor: 'nesw-resize', label: '调整右上角裁剪范围' },
    { handle: 'e', x: crop.x + crop.width, y: crop.y + crop.height / 2, cursor: 'ew-resize', label: '向右调整裁剪范围' },
    { handle: 'se', x: crop.x + crop.width, y: crop.y + crop.height, cursor: 'nwse-resize', label: '调整右下角裁剪范围' },
    { handle: 's', x: crop.x + crop.width / 2, y: crop.y + crop.height, cursor: 'ns-resize', label: '向下调整裁剪范围' },
    { handle: 'sw', x: crop.x, y: crop.y + crop.height, cursor: 'nesw-resize', label: '调整左下角裁剪范围' },
    { handle: 'w', x: crop.x, y: crop.y + crop.height / 2, cursor: 'ew-resize', label: '向左调整裁剪范围' },
  ];

  return <div className="mt-4 flex max-h-80 justify-center overflow-hidden rounded-xl bg-slate-950">
    <svg ref={svgRef} className="max-h-80 w-full select-none touch-none" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <image href={previewUrl} width={imageSize.width} height={imageSize.height} pointerEvents="none"/>
      <path d={`M0 0H${imageSize.width}V${imageSize.height}H0Z M${crop.x} ${crop.y}V${crop.y + crop.height}H${crop.x + crop.width}V${crop.y}Z`} fill="rgba(2,6,23,.55)" fillRule="evenodd" pointerEvents="none"/>
      <rect data-crop-handle="move" aria-label="移动裁剪范围" x={crop.x} y={crop.y} width={crop.width} height={crop.height} fill="rgba(37,99,235,.1)" stroke="#60a5fa" strokeWidth={Math.max(3, imageSize.width / 800)} style={{ cursor: 'move' }} onPointerDown={event => beginDrag(event, 'move')}/>
      {handles.map(handle => <rect key={handle.handle} data-crop-handle={handle.handle} aria-label={handle.label} x={handle.x - handleSize / 2} y={handle.y - handleSize / 2} width={handleSize} height={handleSize} rx={handleSize * .16} fill="#ffffff" stroke="#2563eb" strokeWidth={Math.max(3, imageSize.width / 900)} style={{ cursor: handle.cursor }} onPointerDown={event => beginDrag(event, handle.handle)}/>)}
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

const TeamRetouchPhotoCard = ({ entry, workspacePath, project, cacheConfig, componentActive = true, identityState, refreshToken, onIdentityChanged, onDetectionComplete, onPickIdentity, processingMessage, initialPhoto, onNotice, onEntriesChange }: PhotoCardProps) => {
  const appDialog = useAppDialog();
  const [bundle, setBundle] = useState<TeamPatchBundle>(() => initialPhoto ? bundleFromWorkspacePhoto(initialPhoto) : { success: true, versions: [], tasks: [] });
  const [loading, setLoading] = useState(!initialPhoto);
  const [busy, setBusy] = useState('');
  const [cropEditor, setCropEditor] = useState<{ task: TeamPatchTask; crop: Crop } | null>(null);
  useEscapeLayer(Boolean(cropEditor), () => setCropEditor(null), !busy.startsWith('crop:'));
  const [detectionProgress, setDetectionProgress] = useState({ progress: 0, message: '等待识别操作' });
  const [sourceFullscreen, setSourceFullscreen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const initialWorkspaceBundleRef = useRef(Boolean(initialPhoto));
  const [previewEnabled, setPreviewEnabled] = useState(false);

  useEffect(() => {
    if (!componentActive) { setPreviewEnabled(false); return; }
    const card = cardRef.current;
    if (!card || typeof IntersectionObserver === 'undefined') { setPreviewEnabled(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setPreviewEnabled(true);
      observer.disconnect();
    }, { rootMargin: '800px 0px' });
    observer.observe(card);
    return () => observer.disconnect();
  }, [componentActive]);

  const load = async () => {
    setLoading(true);
    const result = await legacyApi.getTeamPatches(workspacePath, project.status, project.name, entry.relativePath, initialPhoto?.baseVersionId || entry.teamHistoryBaseVersionId || '');
    setLoading(false);
    if (!result.success) { onNotice(`打开团片协作失败：${result.error || '未知错误'}`, 'error'); return; }
    setBundle(normalizeBundle(result));
  };
  useEffect(() => {
    if (initialWorkspaceBundleRef.current) { initialWorkspaceBundleRef.current = false; return; }
    if (!previewEnabled) return;
    void load();
  }, [entry.path, entry.updatedAt, refreshToken, previewEnabled]);

  const baseVersion = useMemo<MediaVersion | undefined>(() => bundle.versions.find(version => version.id === bundle.photo?.currentVersionId) || bundle.versions.find(version => version.isCurrent) || bundle.versions.at(-1), [bundle.versions, bundle.photo?.currentVersionId]);
  const tasks = useMemo(() => bundle.tasks.filter(task => task.baseVersionId === baseVersion?.id), [bundle.tasks, baseVersion?.id]);
  const sourceThumbnail = useLazyPreview(baseVersion?.filePath, cacheConfig, 1280, '', previewEnabled);
  const sourcePreview = sourceThumbnail;
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const assignments = useMemo(() => new Map(identityState.assignments.map(item => [assignmentKey(item.photoId, item.baseVersionId, item.personIndex), item])), [identityState.assignments]);
  const identities = useMemo(() => new Map(identityState.identities.map(item => [item.id, item])), [identityState.identities]);
  useEffect(() => {
    if (!tasks.length) return;
    const inferredWidth = Math.max(...tasks.map(task => Math.max(task.crop.x + task.crop.width, ...(membersOf(task).map(member => member.bbox.x + member.bbox.width)), sourceDimensionFromMask(task.mask?.width, task.mask?.scale))));
    const inferredHeight = Math.max(...tasks.map(task => Math.max(task.crop.y + task.crop.height, ...(membersOf(task).map(member => member.bbox.y + member.bbox.height)), sourceDimensionFromMask(task.mask?.height, task.mask?.scale))));
    setImageSize({ width: Math.max(1, Math.round(inferredWidth)), height: Math.max(1, Math.round(inferredHeight)) });
  }, [tasks]);

  useEffect(() => legacyApi.onTeamPatchDetectionProgress(value => {
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
    try {
      const result = await legacyApi.detectTeamPatchPeople(workspacePath, project.status, project.name, { photoId: bundle.photo.id, baseVersionId: baseVersion.id, restoreExcluded });
      if (!result.success) { onNotice(`AI 识别失败：${result.error || '未知错误'}`, 'error'); return; }
      setBundle(normalizeBundle(result));
      await onDetectionComplete();
      const personCount = result.detection?.personCount || result.tasks.reduce((total, task) => total + membersOf(task).length, 0);
      onNotice(restoreExcluded ? `已恢复人工排除记录并重新识别 ${personCount} 个人物` : `已识别 ${personCount} 个人物，并自动尝试匹配项目中的人物身份`, 'success');
    } catch (error) { onNotice(`AI 识别失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(''); }
  };

  const updateTask = async (task: TeamPatchTask, changes: { personName?: string; assignee?: string; crop?: Crop; needsReview?: boolean; reviewReason?: string }) => {
    if (!bundle.photo) return null;
    const result = await legacyApi.updateTeamPatch(workspacePath, { photoId: bundle.photo.id, taskId: task.id, status: project.status, projectName: project.name, ...changes });
    if (!result.success) { onNotice(`更新工作图失败：${result.error || '未知错误'}`, 'error'); return null; }
    setBundle(current => ({ ...current, tasks: result.tasks }));
    return result;
  };

  const saveCrop = async () => {
    if (!cropEditor) return;
    setBusy(`crop:${cropEditor.task.id}`);
    try {
      const result = await updateTask(cropEditor.task, { crop: cropEditor.crop, needsReview: false, reviewReason: '' });
      if (result) { setCropEditor(null); onNotice(result.warning || `已按新范围重新生成工作图${result.workflowRefreshCount ? `，并同步更新 ${result.workflowRefreshCount} 个工作区文件` : ''}`, result.warning ? 'warning' : 'success'); }
    } catch (error) { onNotice(`更新工作图失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(''); }
  };

  const deleteTask = async (task: TeamPatchTask) => {
    if (!bundle.photo || !await appDialog.confirm({ title: '删除这张错误工作图？', message: '会删除该工作图及其中人物的标记；原照片不会删除。如只是范围不完整，请选择“调整范围”。', confirmLabel: '删除错误工作图', tone: 'danger' })) return;
    setBusy(`delete:${task.id}`);
    try {
      const result = await legacyApi.deleteTeamPatch(workspacePath, { photoId: bundle.photo.id, taskId: task.id });
      if (!result.success) { onNotice(`删除工作图失败：${result.error || '未知错误'}`, 'error'); return; }
      setBundle(current => ({ ...current, tasks: result.tasks }));
      await onIdentityChanged();
    } catch (error) { onNotice(`删除工作图失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(''); }
  };

  const removeFromProject = async () => {
    if (!bundle.photo || !baseVersion || !await appDialog.confirm({ title: `从团片协作中删除“${bundle.photo.displayName || entry.name}”？`, message: '会删除这张图片的裁图、人物标注和流程状态，原照片不会删除。', confirmLabel: '删除团片协作数据', tone: 'danger' })) return;
    setBusy('remove-photo');
    try {
      const result = await legacyApi.removeProjectTeamPhoto(workspacePath, { photoId: bundle.photo.id, baseVersionId: baseVersion.id });
      if (!result.success) { onNotice(`删除失败：${result.error || '未知错误'}`, 'error'); return; }
      onEntriesChange?.([]);
    } catch (error) { onNotice(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(''); }
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
    {loading ? <div className="flex min-h-64 items-center justify-center gap-2 text-slate-500"><Loader2 className="animate-spin"/>正在读取人物数据…</div> : <div className="team-photo-layout grid grid-cols-[minmax(320px,.9fr)_minmax(440px,1.1fr)]">
      <section className="border-r border-slate-200 bg-slate-950 p-4"><div className="relative mx-auto flex min-h-[500px] items-center justify-center overflow-hidden rounded-xl bg-black">{sourcePreview.url ? <svg className="max-h-[calc(100vh-190px)] w-full" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet"><image href={sourcePreview.url} width={imageSize.width} height={imageSize.height} onLoad={() => { if (tasks.length) return; const image = new Image(); image.onload = () => setImageSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 }); image.src = sourcePreview.url; }}/>{tasks.map((task, index) => <g key={task.id}><rect x={task.crop.x} y={task.crop.y} width={task.crop.width} height={task.crop.height} fill="rgba(59,130,246,.06)" stroke={task.needsReview ? '#fb923c' : '#60a5fa'} strokeWidth={Math.max(3, imageSize.width / 900)}/>{membersOf(task).map(member => { const color = personColor(member.personIndex); const fontSize = Math.max(20, imageSize.width / 100); return <g key={member.personIndex}><rect x={member.bbox.x} y={member.bbox.y} width={member.bbox.width} height={member.bbox.height} fill={`${color}0d`} stroke={color} strokeWidth={Math.max(2, imageSize.width / 1300)}/><text x={member.bbox.x + fontSize * .25} y={Math.max(fontSize, member.bbox.y - fontSize * .25)} fill={color} fontSize={fontSize} fontWeight="800" paintOrder="stroke" stroke="rgba(0,0,0,.85)" strokeWidth="5">人物 {member.personIndex}</text></g>; })}<text x={task.crop.x + 10} y={task.crop.y + 28} fill="white" fontSize={Math.max(20, imageSize.width / 85)} fontWeight="700" paintOrder="stroke" stroke="rgba(0,0,0,.75)" strokeWidth="5">工作图 {index + 1}</text></g>)}</svg> : <LazyPreviewPlaceholder failed={sourcePreview.status === 'failed'} error={sourcePreview.error} onRetry={sourcePreview.retry}/>}<ImageZoomButton disabled={!sourcePreview.url} onClick={() => setSourceFullscreen(true)}/></div><p className="mt-3 text-xs leading-5 text-slate-400">蓝框是工作图范围；人物颜色和编号与右侧对应。橙框表示需要检查。</p>{sourceFullscreen && sourcePreview.url && <FullscreenImageViewer url={sourcePreview.url} filePath={baseVersion?.filePath} cacheConfig={cacheConfig} title={bundle.photo?.displayName || entry.name} details={`${imageSize.width} × ${imageSize.height} px`} onClose={() => setSourceFullscreen(false)}/>}</section>
      <section className="p-5">{!tasks.length ? <div className="team-card pf-card flex min-h-96 flex-col items-center justify-center border-dashed p-8 text-center"><ScanFace size={34} className="text-violet-500"/><h4 className="mt-3 font-bold text-slate-800">识别人物并生成工作图</h4><p className="mt-2 text-sm text-slate-500">此步骤只识别、裁图和标记人物。</p><button onClick={() => void detect()} className="dialog-primary mt-4">开始识别</button></div> : <div className="grid gap-4 xl:grid-cols-2">{tasks.map((task, taskIndex) => {
        const names = taskIdentityNames(task, task.photoId, task.baseVersionId, assignments, identities);
        const taskMembers = membersOf(task);
        const taskMarkedCount = taskMembers.filter(member => {
          const identityId = assignments.get(assignmentKey(task.photoId, task.baseVersionId, member.personIndex))?.identityId;
          const identity = identityId ? identities.get(identityId) : undefined;
          return identity && !isGeneratedIdentity(identity);
        }).length;
        const taskFullyMarked = taskMarkedCount === taskMembers.length;
        const metrics = workingImageMetrics(task, { width: imageSize.width, height: imageSize.height });
        return <article key={task.id} className="team-card pf-card p-4"><header className="flex items-start gap-3"><span className={`rounded-full p-2 ${task.needsReview ? 'bg-amber-50 text-amber-600' : taskFullyMarked ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>{task.needsReview ? <AlertTriangle size={17}/> : <UserRound size={17}/>}</span><div className="min-w-0 flex-1"><h4 className="text-sm font-bold text-slate-800">工作图 {taskIndex + 1}</h4><p className="mt-1 truncate text-xs text-slate-500" title={names.join('、')}>{taskMarkedCount ? `人物标记 ${taskMarkedCount}/${taskMembers.length}${names.length ? ` · ${names.join('、')}` : ''}` : `${taskMembers.length} 个人物尚未标记`}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${task.needsReview ? 'bg-amber-50 text-amber-600' : taskFullyMarked ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>{task.needsReview ? '建议检查' : taskFullyMarked ? '已标记' : '未标记'}</span></header>
          {task.reviewReason && <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-700">{task.reviewReason}</p>}
          <PatchPreview task={task} cacheConfig={cacheConfig} enabled={previewEnabled} onPickPerson={personIndex => onPickIdentity(assignmentKey(task.photoId, task.baseVersionId, personIndex))}/>
          <dl className="mt-3 grid grid-cols-2 gap-1 rounded-lg border border-slate-100 bg-white p-2 text-[10px] text-slate-500" data-working-image-metrics><div><dt className="inline font-bold">工作图尺寸：</dt><dd className="inline">{metrics.width && metrics.height ? `${metrics.width} × ${metrics.height} px` : '未知 · 需核对'}</dd></div><div><dt className="inline font-bold">原图占比：</dt><dd className="inline">{metrics.areaRatio === undefined ? '未知 · 需核对' : `${Math.round(metrics.areaRatio * 100)}%`}</dd></div><div><dt className="inline font-bold">裁剪范围：</dt><dd className="inline">{metrics.fullFrame === undefined ? '未知 · 需核对' : metrics.fullFrame ? '整幅' : '局部'}</dd></div><div><dt className="inline font-bold">尺寸限制：</dt><dd className={`inline ${metrics.exceedsWorkTileEdge ? 'font-bold text-amber-700' : ''}`}>{metrics.exceedsWorkTileEdge === undefined ? '未知 · 需核对' : metrics.exceedsWorkTileEdge ? '超过工作图边长限制' : '未超过工作图边长限制'}</dd></div><div className="col-span-2"><dt className="inline font-bold">识别后端：</dt><dd className="inline">{metrics.backend === '未知' ? '未知 · 需核对' : `${metrics.backend} · ${metrics.detector}`}{metrics.fallbackReason ? ` · 已降级：${metrics.fallbackReason}` : ''}</dd></div>{metrics.reason && <div className="col-span-2"><dt className="inline font-bold">生成说明：</dt><dd className="inline">{metrics.reason}</dd></div>}</dl>
          {(metrics.requiresManualCrop === true || metrics.fullFrame === true) && <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800" role="status" data-manual-crop-warning>{metrics.requiresManualCrop ? '需要人工调整裁剪范围' : '当前为整幅工作图，请确认无需局部裁剪'}{metrics.reason ? `：${metrics.reason}` : ''}</div>}
          {metrics.requiresManualCrop === undefined && metrics.fullFrame === undefined && <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-600">裁剪决策未知 · 旧数据缺少 generation 元数据，请人工核对</div>}
          <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-2.5"><p className="text-[10px] font-bold text-slate-500">识别并标记人物</p>{taskMembers.map(member => { const subjectKey = assignmentKey(task.photoId, task.baseVersionId, member.personIndex); const assignment = assignments.get(subjectKey); const identity = assignment?.identityId ? identities.get(assignment.identityId) : undefined; const generated = isGeneratedIdentity(identity); const label = identity && !generated ? identity.name : '未标记'; const status = !identity || generated ? '未标记' : assignment?.source === 'manual' ? '已人工确认' : assignment?.source === 'manual-group' ? '组内确认' : '自动候选'; return <button type="button" key={subjectKey} disabled={Boolean(busy)} onClick={() => onPickIdentity(subjectKey)} className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-left transition hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: personColor(member.personIndex) }}/><span className="w-14 text-xs font-bold text-slate-500">人物 {member.personIndex}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${status === '已人工确认' ? 'bg-emerald-50 text-emerald-700' : status === '组内确认' ? 'bg-blue-50 text-blue-700' : status === '自动候选' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{status}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{label}</span><span className="text-[10px] font-bold text-blue-600">{identity && !generated ? '看图修改' : '去标记'}</span></button>; })}<p className="pt-1 text-[10px] text-slate-400">点击人物框或人物行确认身份，可应用到整组。</p></div>
          <div className="mt-3 flex flex-wrap gap-2"><button disabled={task.patchMissing} onClick={() => void legacyApi.openTeamPatch(task.patchPath)} className="dialog-secondary inline-flex items-center gap-1.5"><ExternalLink size={13}/>打开工作图</button><button onClick={() => setCropEditor({ task, crop: { ...task.crop } })} className="dialog-secondary inline-flex items-center gap-1.5"><SlidersHorizontal size={13}/>调整范围</button><button disabled={Boolean(busy)} onClick={() => void deleteTask(task)} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50"><Trash2 size={13}/>识别错误，删除</button></div>
        </article>;
      })}</div>}</section>
    </div>}
    {cropEditor && <div role="dialog" aria-modal="true" className="fixed inset-0 z-[460] flex items-center justify-center bg-slate-950/70 p-5"><div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl"><div className="flex items-center"><div><h3 className="font-bold text-slate-900">调整工作图范围</h3><p className="mt-1 text-xs text-slate-500">拖动框体移动，拖动边缘或八个控制点调整大小。</p></div><button onClick={() => setCropEditor(null)} className="ml-auto p-2 text-slate-500"><X size={18}/></button></div>{sourcePreview.url && <InteractiveCropEditor previewUrl={sourcePreview.url} imageSize={imageSize} crop={cropEditor.crop} onChange={crop => setCropEditor(current => current ? { ...current, crop } : current)}/>}<div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => setCropEditor(current => { if (!current) return current; const marginX = Math.max(20, Math.round(current.crop.width * .1)); const marginY = Math.max(20, Math.round(current.crop.height * .1)); const x = Math.max(0, current.crop.x - marginX); const y = Math.max(0, current.crop.y - marginY); return { ...current, crop: { x, y, width: Math.min(imageSize.width - x, current.crop.width + marginX * 2), height: Math.min(imageSize.height - y, current.crop.height + marginY * 2) } }; })} className="dialog-secondary">四周扩大 10%</button><button type="button" onClick={() => setCropEditor(current => { if (!current) return current; const boxes = membersOf(current.task).map(member => member.bbox); const left = Math.min(...boxes.map(box => box.x)); const top = Math.min(...boxes.map(box => box.y)); const right = Math.max(...boxes.map(box => box.x + box.width)); const bottom = Math.max(...boxes.map(box => box.y + box.height)); const marginX = Math.max(20, Math.round((right - left) * .12)); const marginY = Math.max(20, Math.round((bottom - top) * .12)); const x = Math.max(0, left - marginX); const y = Math.max(0, top - marginY); return { ...current, crop: { x, y, width: Math.min(imageSize.width - x, right - left + marginX * 2), height: Math.min(imageSize.height - y, bottom - top + marginY * 2) } }; })} className="dialog-secondary">完整包住已识别人物</button></div><div className="mt-4 grid grid-cols-2 gap-3">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key} className="text-xs font-bold text-slate-600">{{ x: '左边 X', y: '顶部 Y', width: '宽度', height: '高度' }[key]}<input type="number" min={key === 'x' || key === 'y' ? 0 : 1} value={cropEditor.crop[key]} onChange={event => setCropEditor(current => current ? { ...current, crop: { ...current.crop, [key]: Math.max(key === 'x' || key === 'y' ? 0 : 1, Math.round(Number(event.target.value) || 0)) } } : current)} className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2"/></label>)}</div><div className="mt-5 flex justify-end gap-2"><button onClick={() => setCropEditor(null)} className="dialog-secondary">取消</button><button disabled={Boolean(busy)} onClick={() => void saveCrop()} className="dialog-primary">{busy.startsWith('crop:') ? '正在重新裁图…' : '保存并重新裁图'}</button></div></div></div>}
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
    await legacyApi.updateTeamPatch(workspacePath, { photoId: photo.photoId, taskId: task.id, personName, assignee });
  })));
};

const TeamRetouchWorkspace = ({ entries, historyRecordCount = entries.length, historyOwnershipPendingCount = 0, workspacePath, project, initialWorkspace, initialWorkspacePending = false, cacheConfig, componentStatus, advancedStatusLoading = false, advancedStatusError = '', onRetryAdvancedStatus, activeStep, onStepChange, stageSummaries, onBlockedStage, onClose, onOpenSettings, onNotice, onEntriesChange, onProjectChanged, onBusyChange }: Props) => {
  const appDialog = useAppDialog();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [progress, setProgress] = useState({ itemIndex: 0, itemCount: entries.length, progress: 0, itemName: '', message: '准备批量识别' });
  const [refreshToken, setRefreshToken] = useState(0);
  const [visiblePhotoCount, setVisiblePhotoCount] = useState(24);
  const initialSeed = isUsableWorkspaceSeed(initialWorkspace) ? initialWorkspace : undefined;
  const seedScopeKey = workspaceSeedScopeKey(workspacePath, project);
  const workspaceSeedGateRef = useRef(createWorkspaceSeedGate(seedScopeKey, Boolean(initialSeed)));
  const [identityLoading, setIdentityLoading] = useState(!initialSeed);
  const [identityLoadError, setIdentityLoadError] = useState('');
  const [identityState, setIdentityState] = useState<IdentityState>(() => initialSeed || { success: true, photos: [], identities: [], assignments: [] });
  const [identityPickerKey, setIdentityPickerKey] = useState('');
  const [includedIdentityKeys, setIncludedIdentityKeys] = useState<Set<string>>(new Set());
  const [identityPickerBusy, setIdentityPickerBusy] = useState(false);
  const [identityPickerBusyLabel, setIdentityPickerBusyLabel] = useState('正在保存整组人物标记…');
  const [photoRefreshTokens, setPhotoRefreshTokens] = useState<Record<string, number>>({});
  const [photoProcessingMessages, setPhotoProcessingMessages] = useState<Record<string, string>>({});
  const teamGraph = useTeamOutputProgress(teamWorkflowSourcePaths(identityState.photos), workspacePath, project, onNotice);
  const identifyingRef = useRef(false);
  const lastUnmarkedSubjectKeyRef = useRef('');
  const identityLoadSequenceRef = useRef(0);
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  useEffect(() => {
    onBusyChangeRef.current?.(running || Boolean(identityState.identifying) || identityPickerBusy);
  }, [identityPickerBusy, identityState.identifying, running]);
  useEffect(() => () => onBusyChangeRef.current?.(false), []);
  const identitySubjects = useMemo(() => identitySubjectsFromWorkspace(identityState), [identityState]);
  const unrecognizedPaths = useMemo(() => entries
    .filter(entry => !entry.teamHistoryMissing && !(workspacePhotoForEntry(identityState.photos, entry)?.tasks.length))
    .map(entry => entry.relativePath), [entries, identityState.photos]);
  const visibleEntries = useMemo(() => entries.slice(0, visiblePhotoCount), [entries, visiblePhotoCount]);
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
    const sequence = ++identityLoadSequenceRef.current;
    setIdentityLoadError('');
    try {
      const result = await legacyApi.getTeamProjectWorkspace(workspacePath, project.name, project.status);
      if (!result.success) throw new Error(result.error || '未知错误');
      if (syncLabels) await syncTaskLabels(workspacePath, result);
      if (sequence === identityLoadSequenceRef.current) setIdentityState(result);
      if (result.workflowNodeCreated) onProjectChanged?.();
    } catch (error) {
      if (sequence === identityLoadSequenceRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setIdentityLoadError(message);
        onNotice(`读取人物数据失败：${message}`, 'error');
      }
    } finally {
      if (sequence === identityLoadSequenceRef.current) setIdentityLoading(false);
    }
  };
  useEffect(() => {
    if (workspaceSeedGateRef.current.isSeeded(seedScopeKey)) { setIdentityLoading(false); return () => { identityLoadSequenceRef.current += 1; }; }
    if (initialWorkspacePending) return () => { identityLoadSequenceRef.current += 1; };
    if (workspaceSeedGateRef.current.consume(seedScopeKey, isUsableWorkspaceSeed(initialWorkspace))) { setIdentityState(initialWorkspace); setIdentityLoadError(''); setIdentityLoading(false); return () => { identityLoadSequenceRef.current += 1; }; }
    setIdentityLoading(true);
    void loadIdentities();
    return () => { identityLoadSequenceRef.current += 1; };
  }, [workspacePath, project.id, project.name, project.status, initialWorkspace, initialWorkspacePending]);
  useEffect(() => legacyApi.onTeamPatchBatchProgress(value => setProgress({ itemIndex: value.itemIndex, itemCount: value.itemCount, progress: value.progress, itemName: value.itemName, message: value.message })), []);
  useEffect(() => {
    if (!identityState.workflowNode?.id) return;
    void teamGraph.ensureWorkflowInputs(identityState.workflowNode.id).then(() => onProjectChanged?.()).catch(error => {
      onNotice(`登记团片来源关系失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    });
  }, [identityState.workflowNode?.id, teamGraph.sourceProgressIds.join('|')]);

  const openIdentityPicker = (subjectKey: string) => {
    const subject = identitySubjects.find(candidate => candidate.key === subjectKey);
    if (!subject) { onNotice('人物识别数据仍在加载，请稍后再试', 'info'); return; }
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
    if (!identitySubjects.some(isUnmarkedIdentitySubject)) { onNotice('当前没有未标记人物', 'info'); return; }
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
    const result = await legacyApi.confirmTeamIdentityGroup(workspacePath, {
      projectName: project.name,
      anchorSubjectKey: selectedIdentitySubject.key,
      identityId,
      name,
      assignments,
    });
    setIdentityPickerBusy(false);
    if (!result.success) { onNotice(`整组标记人物失败：${result.error || '未知错误'}`, 'error'); return; }
    setIdentityState(result);
    setIdentityPickerKey('');
    setIncludedIdentityKeys(new Set());
    void syncTaskLabels(workspacePath, result).catch(() => undefined);
    onProjectChanged?.();
    const identity = result.identities.find(item => item.id === result.identityId);
    const releaseNote = result.autoReleasedCount ? `；同图中 ${result.autoReleasedCount} 个自动候选已让位` : '';
    const skippedDuplicates = Math.max(duplicateCount, result.duplicateSkippedCount || 0);
    const duplicateNote = skippedDuplicates ? `；已自动取消 ${skippedDuplicates} 张同图重复候选` : '';
    onNotice(identity ? `已将 ${result.updatedCount || assignments.length} 个人物实例标记为“${identity.name}”${releaseNote}${duplicateNote}` : `已将 ${result.updatedCount || assignments.length} 个人物实例设为未标记${duplicateNote}`, result.warning ? 'warning' : 'success');
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
          onNotice('当前图片中的人物优先保留，已跳过这张同图重复候选', 'warning');
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
    const result = await legacyApi.saveTeamIdentity(workspacePath, { projectName: project.name, identityId: identity.id, name });
    setIdentityPickerBusy(false);
    if (!result.success) { onNotice(`修改人物姓名失败：${result.error || '未知错误'}`, 'error'); return; }
    const nextState = { ...identityState, identities: identityState.identities.map(item => item.id === identity.id ? { ...item, name, updatedAt: Date.now() } : item) };
    setIdentityState(nextState);
    void syncTaskLabels(workspacePath, nextState).catch(() => undefined);
    onNotice(`人物姓名已修改为“${name}”`, 'success');
  };

  const deleteIdentityFromPicker = async (identity: TeamIdentity) => {
    const confirmed = await appDialog.confirm({ title: `删除人物“${identity.name}”？`, message: '会取消该人物全部实例的身份与完成状态，不会删除照片或工作图。', confirmLabel: '删除人物', tone: 'danger' });
    if (!confirmed) return;
    setIdentityPickerBusy(true);
    const result = await legacyApi.deleteTeamIdentity(workspacePath, { projectName: project.name, identityId: identity.id });
    setIdentityPickerBusy(false);
    if (!result.success) { onNotice(`删除人物失败：${result.error || '未知错误'}`, 'error'); return; }
    const nextState = {
      ...identityState,
      identities: identityState.identities.filter(item => item.id !== identity.id),
      assignments: identityState.assignments.map(item => item.identityId === identity.id ? { ...item, identityId: undefined, completed: false, updatedAt: Date.now() } : item),
    };
    setIdentityState(nextState);
    setIdentityPickerKey('');
    void syncTaskLabels(workspacePath, nextState).catch(() => undefined);
    onNotice(`已删除人物“${identity.name}”`, 'success');
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
    const result = await legacyApi.excludeTeamPerson(workspacePath, project.status, project.name, {
      photoId,
      baseVersionId: subject.photo.baseVersionId,
      personIndex: subject.personIndex,
    });
    setPhotoProcessingMessages(current => { const next = { ...current }; delete next[photoId]; return next; });
    if (!result.success) { onNotice(`移除误识别人物失败：${result.error || '未知错误'}`, 'error'); return; }
    setIdentityState(result);
    setPhotoRefreshTokens(current => ({ ...current, [photoId]: (current[photoId] || 0) + 1 }));
    void syncTaskLabels(workspacePath, result).catch(() => undefined);
    onProjectChanged?.();
    onNotice(result.warning || `已移除误识别人物，并重新计算当前图片的工作图；其他人物标记已保留${result.workflowRefreshCount ? `，同步更新 ${result.workflowRefreshCount} 个任务文件` : ''}`, result.warning ? 'warning' : 'success');
  };

  const identifyAndSync = async () => {
    if (identifyingRef.current) return;
    if (!await ensureFaceRecognitionConsent(appDialog)) return;
    identifyingRef.current = true;
    setIdentityState(current => ({ ...current, identifying: true }));
    try {
      const result = await legacyApi.suggestTeamIdentities(workspacePath, project.name);
      if (!result.success) { onNotice(`人物自动标记失败：${result.error || '未知错误'}`, 'error'); return; }
      await syncTaskLabels(workspacePath, result);
      setIdentityState({ ...result, identifying: false });
    } catch (error) { onNotice(`人物自动标记失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { identifyingRef.current = false; setIdentityState(current => ({ ...current, identifying: false })); }
  };

  const runBatch = async () => {
    if (identityLoading) return;
    const targetEntries = unrecognizedPaths.length ? entries.filter(entry => unrecognizedPaths.includes(entry.relativePath)) : entries;
    setRunning(true);
    setResults([]);
    try {
      const result = await legacyApi.detectTeamPatchBatch(workspacePath, project.status, project.name, { relativePaths: targetEntries.map(entry => entry.relativePath) });
      setResults(result.results || []);
      setRefreshToken(current => current + 1);
      if (!result.success) { onNotice(`识别图片失败：${result.error || '未知错误'}`, 'error'); return; }
      await identifyAndSync();
      onNotice(`识别完成：${result.results.filter(item => item.success).length}/${targetEntries.length} 张成功，并已自动尝试标记人物`, 'success');
    } catch (error) { onNotice(`识别图片失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setRunning(false); }
  };

  const overallProgress = progress.itemCount ? Math.max(0, Math.min(100, ((Math.max(1, progress.itemIndex) - 1) + progress.progress / 100) / progress.itemCount * 100)) : 0;
  const resultByPath = new Map(results.map(result => [result.relativePath, result]));
  const advancedPresentation = legacyAdvancedStatusPresentation(componentStatus, advancedStatusLoading, advancedStatusError);
  const confirmedIdentityCount = identitySubjects.filter(subject => subject.identity && !isGeneratedIdentity(subject.identity) && ['manual', 'manual-group'].includes(subject.assignment?.source || '')).length;
  const candidateIdentityCount = identitySubjects.filter(subject => subject.identity && !isGeneratedIdentity(subject.identity) && subject.assignment?.source === 'suggested').length;
  const unmarkedIdentityCount = identitySubjects.filter(isUnmarkedIdentitySubject).length;

  const stageOneReady = Boolean(identitySubjects.length && confirmedIdentityCount === identitySubjects.length && !identityState.photos.flatMap(photo => photo.tasks || []).some(task => task.needsReview || task.patchMissing));
  return <div className="team-shell pf-canvas fixed inset-x-0 bottom-0 top-10 z-[310] flex flex-col"><header className="team-workflow-header team-toolbar pf-toolbar flex min-h-16 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3"><span className="team-icon-tile pf-icon-tile p-2"><UsersRound size={20}/></span><div><h2 className="font-bold text-slate-900">{historyOwnershipPendingCount ? `团片协作 · 已找到 ${entries.length}/${historyRecordCount} 张图片` : `团片协作 · ${entries.length} 张图片`}</h2><p className="mt-0.5 text-xs text-slate-500">阶段 1 · 识别与裁剪，并在本阶段人工确认人物。</p></div><TeamRetouchSteps value={activeStep} onChange={onStepChange} summaries={stageSummaries} onBlocked={onBlockedStage} disabled={running}/><div className="team-stage-actions ml-auto flex items-center gap-2"><button disabled={running || identityLoading} onClick={() => void runBatch()} className="dialog-secondary inline-flex items-center gap-2">{running || identityLoading ? <Loader2 size={15} className="animate-spin"/> : <ScanFace size={15}/>} {identityLoading ? '读取团片历史…' : unrecognizedPaths.length ? `识别新增图片（${unrecognizedPaths.length} 张）` : entries.length > 1 ? '重新识别全部图片' : '重新识别图片'}</button><button disabled={running || identityLoading || identityState.identifying} onClick={() => void identifyAndSync()} className="dialog-secondary inline-flex items-center gap-2">{identityState.identifying ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>}自动标记候选</button><button type="button" disabled={!stageOneReady || running} onClick={() => onStepChange('assignment')} className="dialog-primary" title={stageOneReady ? '进入任务分配' : '需先完成识别、裁剪复核和人物人工确认'}>继续设置任务</button><button type="button" onClick={onOpenSettings} title="团片协作设置" aria-label="团片协作设置" className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><Settings size={20}/></button></div></header>
    <div className={`team-banner flex items-center gap-2 border-b px-5 py-2 text-xs ${advancedPresentation.state === 'ready' ? 'border-violet-100 bg-violet-50 text-violet-700' : advancedPresentation.state === 'repair-needed' || advancedPresentation.state === 'error' ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-blue-100 bg-blue-50 text-blue-700'}`}>{advancedPresentation.state === 'checking' && <Loader2 size={13} className="animate-spin"/>}<span className="font-bold">{advancedPresentation.text}</span>{advancedPresentation.state === 'error' && <button type="button" className="ml-auto rounded-md border border-amber-300 px-2 py-1 font-bold" onClick={onRetryAdvancedStatus}>重新检查</button>}</div>
    {!!identitySubjects.length && <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-5 py-2 text-xs"><span className="font-bold text-slate-700">人物标记</span><span className="rounded-full bg-emerald-50 px-2.5 py-1 font-bold text-emerald-700">已确认 {confirmedIdentityCount}</span>{candidateIdentityCount > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 font-bold text-amber-700">自动候选 {candidateIdentityCount}</span>}<button type="button" disabled={!unmarkedIdentityCount || identityLoading || identityState.identifying} onClick={openNextUnmarkedIdentity} title="打开下一个未标记人物" className="rounded-full bg-slate-100 px-2.5 py-1 font-bold text-slate-600 transition hover:bg-blue-50 hover:text-blue-700 disabled:cursor-default disabled:opacity-50">未标记 {unmarkedIdentityCount}{unmarkedIdentityCount ? ' · 下一个' : ''}</button><span className="ml-auto text-slate-500">点击“未标记”查看下一处，或直接选择人物。</span></div>}
    {running && <div className="border-b border-blue-100 bg-blue-50 px-5 py-3"><div className="flex justify-between text-xs font-bold text-blue-700"><span>{progress.itemIndex ? `${progress.itemIndex}/${progress.itemCount} · ${progress.itemName} · ` : ''}{progress.message}</span><span>{Math.round(overallProgress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full bg-blue-600" style={{ width: `${overallProgress}%` }}/></div></div>}
    <main className="min-h-0 flex-1 overflow-y-auto p-6"><div className="mx-auto max-w-[1600px] space-y-6">{!entries.length && !identityLoading && <div className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-sm font-bold text-slate-500">当前项目没有团片协作图片，可从项目文件中重新打开团片协作。</div>}{identityLoading
      ? <div className="flex min-h-52 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-600"><Loader2 size={18} className="mr-2 animate-spin text-blue-600"/>正在读取团片历史中的人物与工作图…</div>
      : identityLoadError
        ? <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-red-200 bg-white px-6 text-center text-sm text-red-700"><p className="font-bold">团片协作数据读取失败</p><p className="max-w-2xl text-xs text-slate-500">{identityLoadError}</p><button type="button" className="dialog-primary" onClick={() => { setIdentityLoading(true); void loadIdentities(); }}>重新读取</button></div>
        : visibleEntries.map(entry => {
        const result = resultByPath.get(entry.relativePath);
        const initialPhoto = workspacePhotoForEntry(identityState.photos, entry);
        const photoId = initialPhoto?.photoId || '';
        if (entry.teamHistoryMissing) return <section key={entry.relativePath} className="team-card pf-card p-5"><div className="flex items-start gap-3"><AlertTriangle size={22} className="mt-0.5 shrink-0 text-amber-500"/><div className="min-w-0 flex-1"><h3 className="font-bold text-slate-800">{entry.name || '团片历史图片'} · 缺失 / 需重新关联</h3><p className="mt-1 text-xs leading-5 text-slate-500">{entry.teamHistoryMissingReason || '历史记录暂时无法恢复项目内路径。'} 已保留该记录，不会删除人物、任务或版本数据。</p><div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500"><span className="rounded-full bg-slate-100 px-2.5 py-1">Photo ID：{entry.teamHistoryPhotoId || '未知'}</span><span className="rounded-full bg-slate-100 px-2.5 py-1">版本：{entry.teamHistoryBaseVersionId || '未知'}</span><span className="rounded-full bg-amber-50 px-2.5 py-1 font-bold text-amber-700">关联任务 {entry.teamHistoryTaskCount || 0}</span></div><button type="button" className="dialog-secondary mt-4" onClick={() => onProjectChanged?.()}>重新读取并关联</button></div></div></section>;
        return <section key={entry.relativePath} className="space-y-2">{result && !result.success && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">{result.error || `${entry.name} 识别失败`}</div>}<TeamRetouchPhotoCard entry={entry} workspacePath={workspacePath} project={project} cacheConfig={cacheConfig} componentStatus={componentStatus} onClose={onClose} onNotice={onNotice} onProjectChanged={onProjectChanged} onEntriesChange={() => { const next = entries.filter(candidate => candidate.relativePath !== entry.relativePath); onEntriesChange?.(next); }} identityState={identityState} initialPhoto={initialPhoto} refreshToken={refreshToken + (photoRefreshTokens[photoId] || 0)} processingMessage={photoProcessingMessages[photoId]} onIdentityChanged={() => loadIdentities(true)} onDetectionComplete={identifyAndSync} onPickIdentity={openIdentityPicker}/></section>;
        })}{!identityLoading && !identityLoadError && visiblePhotoCount < entries.length && <button type="button" className="dialog-secondary mx-auto block" aria-label="加载更多团片照片" onClick={() => setVisiblePhotoCount(current => current + 24)}>再加载 24 张（剩余 {entries.length - visiblePhotoCount}）</button>}</div></main>
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
  const [advancedStatusLoading, setAdvancedStatusLoading] = useState(!props.componentStatus?.advancedState && !props.componentStatus?.advancedAvailable);
  const [advancedStatusError, setAdvancedStatusError] = useState('');
  const advancedStatusSequenceRef = useRef(0);
  const refreshAdvancedStatus = useCallback(async () => {
    const sequence = ++advancedStatusSequenceRef.current;
    setAdvancedStatusLoading(true); setAdvancedStatusError('');
    try {
      const result = await legacyApi.getComponents();
      if (!result.success) throw new Error(result.error || '宿主没有返回组件状态');
      const latest = result.components?.find(component => component.id === 'team-retouch');
      if (!latest) throw new Error('未找到团片协作组件状态');
      if (sequence === advancedStatusSequenceRef.current) setFreshComponentStatus(latest);
    } catch (error) {
      if (sequence === advancedStatusSequenceRef.current) setAdvancedStatusError(error instanceof Error ? error.message : String(error));
    } finally { if (sequence === advancedStatusSequenceRef.current) setAdvancedStatusLoading(false); }
  }, []);
  useEffect(() => {
    setFreshComponentStatus(props.componentStatus);
    if (props.componentStatus?.advancedState || props.componentStatus?.advancedAvailable) { advancedStatusSequenceRef.current += 1; setAdvancedStatusLoading(false); setAdvancedStatusError(''); return; }
    void refreshAdvancedStatus();
    return () => { advancedStatusSequenceRef.current += 1; };
  }, [props.componentStatus, refreshAdvancedStatus]);
  return <div className="team-shell pf-canvas contents"><TeamRetouchWorkspace {...props} componentStatus={freshComponentStatus} advancedStatusLoading={advancedStatusLoading} advancedStatusError={advancedStatusError} onRetryAdvancedStatus={() => void refreshAdvancedStatus()}/></div>;
};
