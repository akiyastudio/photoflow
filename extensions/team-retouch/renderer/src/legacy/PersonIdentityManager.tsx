// @ts-nocheck -- source-faithful migration from fef15e4^; RPC types are enforced by legacy-api.ts
import { legacyApi } from './legacy-api';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, FolderOutput, GripVertical, Image as ImageIcon, Loader2, Maximize2, Trash2, Upload, UserRound, UsersRound, Wand2, X } from 'lucide-react';
import type { AppConfig, TeamIdentity, TeamIdentityWorkspace, TeamPatchReturnBatchResult, TeamPatchReturnMatch, TeamPatchTask, TeamPersonAssignment, TeamProjectPhoto, TeamWorkflowGenerationProgress, WorkspaceProject } from './legacy-types';
import { scheduleWorkflowWeeks } from '../workflow-schedule';
import { useAppDialog } from './legacy-dialog-context';
import { useEscapeLayer } from './legacy-layer';
import type { TeamRetouchStep } from './TeamRetouchSteps';
import { TeamWorkflowHeader } from './TeamWorkflowHeader';
import { TeamOutputProgressPicker } from './TeamRetouchOutputProgress';
import { teamWorkflowSourcePaths, useTeamOutputProgress } from './useTeamOutputProgress';
import { ensureFaceRecognitionConsent } from './legacy-privacy';
import { ImageComparisonView, type ImageComparisonMode } from './ImageComparisonView';
import { beginWorkflowReturnProgress, isPhotoMergeComplete, mergeAudit, relayChainForItems, returnMatchAssessment, returnModificationAssessment, updateWorkflowReturnProgress, workflowStageSummaries, WORKFLOW_STAGES, type WorkflowReturnProgressState } from '../interaction-model';
import { createWorkspaceSeedGate, isUsableWorkspaceSeed, workspaceSeedScopeKey } from './legacy-workspace-seed-model';
import { shouldEmitTerminalToast } from '../task-terminal-notice-model';
import { IdentityPickerPanel } from './IdentityPickerPanel';

type Props = {
  componentActive?: boolean;
  workspacePath: string;
  project: WorkspaceProject;
  initialWorkspace?: TeamIdentityWorkspace;
  initialWorkspacePending?: boolean;
  historyIssue?: string;
  onRetryHistory?: () => void;
  cacheConfig: AppConfig['mediaCache'];
  activeStep: Extract<TeamRetouchStep, 'assignment' | 'relay' | 'review'>;
  onStepChange: (step: TeamRetouchStep) => void;
  stageSummaries?: import('../interaction-model').StageSummary[];
  onBlockedStage?: (reason: string) => void;
  onClose: () => void;
  onNotice: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void;
  onProjectChanged: () => void;
  onBusyChange?: (busy: boolean) => void;
};

type Subject = {
  key: string;
  photo: TeamProjectPhoto;
  task: TeamPatchTask;
  personIndex: number;
  bbox: { x: number; y: number; width: number; height: number };
  assignment?: TeamPersonAssignment;
  identity?: TeamIdentity;
  matchScore?: number;
  matchEvidence?: string;
};

const assignmentKey = (photoId: string, baseVersionId: string, personIndex: number) => `${photoId}:${baseVersionId}:${personIndex}`;
const isGeneratedIdentity = (identity: TeamIdentity) => /^\u5f85\u786e\u8ba4\u4eba\u7269\s+\d+$/.test(identity.name);
const similarityPairKey = (left: string, right: string) => left < right ? `${left}|${right}` : `${right}|${left}`;

const IDENTITY_THUMBNAIL_SIZE = 384;

const subjectsFromWorkspace = (workspace: TeamIdentityWorkspace): Subject[] => {
  const assignments = new Map(workspace.assignments.map(item => [assignmentKey(item.photoId, item.baseVersionId, item.personIndex), item]));
  const identities = new Map(workspace.identities.map(item => [item.id, item]));
  const subjects = new Map<string, Subject>();
  for (const photo of workspace.photos) {
    for (const task of photo.tasks) {
      const members = task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox }];
      for (const member of members) {
        const key = assignmentKey(photo.photoId, photo.baseVersionId, member.personIndex);
        const assignment = assignments.get(key);
        if (!subjects.has(key)) subjects.set(key, { key, photo, task, personIndex: member.personIndex, bbox: member.bbox, assignment, identity: assignment?.identityId ? identities.get(assignment.identityId) : undefined });
      }
    }
  }
  return [...subjects.values()];
};

const SubjectFullscreenViewer = ({ url, filePath, cacheConfig, title, onClose }: { url: string; filePath: string; cacheConfig: AppConfig['mediaCache']; title: string; onClose: () => void }) => {
  const [displayUrl, setDisplayUrl] = useState(url);
  useEffect(() => {
    let active = true;
    setDisplayUrl(url);
    void legacyApi.getMediaOriginal(filePath, 'image', cacheConfig).then(result => { if (active && result.mediaUrl) setDisplayUrl(result.mediaUrl); }).catch(() => undefined);
    return () => { active = false; };
  }, [url, filePath, cacheConfig.directory, cacheConfig.maxSizeGB]);
  useEscapeLayer(true, onClose);
  return createPortal(<div role="dialog" aria-modal="true" aria-label={`全窗口浏览：${title}`} className="fixed inset-0 z-[700] flex flex-col bg-slate-950/95" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-5 text-white"><h3 className="min-w-0 flex-1 truncate text-sm font-bold">{title}</h3><button type="button" onClick={onClose} title="关闭全窗口浏览" className="rounded-md p-2 text-slate-300 hover:bg-white/10 hover:text-white"><X size={20}/></button></header><div className="flex min-h-0 flex-1 items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><img src={displayUrl} alt={title} className="max-h-full max-w-full object-contain"/></div></div>, document.body);
};

const SubjectThumb = memo(({ subject, cacheConfig, active: componentActive = true, interactive = true, sourcePath }: { subject: Subject; cacheConfig: AppConfig['mediaCache']; active?: boolean; interactive?: boolean; sourcePath?: string }) => {
  const container = useRef<HTMLDivElement>(null);
  const imagePath = sourcePath || subject.task.patchPath;
  const mediaScope = legacyApi.getMediaAuthorizationScope();
  const [url, setUrl] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    let active = true;
    if (!componentActive) return () => undefined;
    setUrl('');
    setLoadFailed(false);
    const node = container.current;
    const observer = node ? new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer?.disconnect();
      const request = legacyApi.getMediaThumbnail(imagePath, 'image', cacheConfig, IDENTITY_THUMBNAIL_SIZE, 1, 0);
      void request.then(result => {
        if (!active) return;
        if (result.previewUrl) setUrl(result.previewUrl);
        else if (!result.success || result.state === 'FAILED' || result.state === 'MISSING') setLoadFailed(true);
      }).catch(() => { if (active) setLoadFailed(true); });
    }, { rootMargin: '320px' }) : null;
    if (node) observer?.observe(node);
    return () => { active = false; observer?.disconnect(); };
  }, [imagePath, componentActive, cacheConfig.directory, cacheConfig.maxSizeGB, mediaScope]);
  const x = Math.max(0, subject.bbox.x - subject.task.crop.x);
  const y = Math.max(0, subject.bbox.y - subject.task.crop.y);
  const boxWidth = Math.max(1, Math.min(subject.bbox.width, subject.task.crop.width - x));
  const boxHeight = Math.max(1, Math.min(subject.bbox.height, subject.task.crop.height - y));
  const targetRatio = 4 / 3;
  let viewWidth = Math.min(subject.task.crop.width, boxWidth * 1.35);
  let viewHeight = Math.min(subject.task.crop.height, boxHeight * 1.2);
  if (viewWidth / viewHeight < targetRatio) viewWidth = Math.min(subject.task.crop.width, viewHeight * targetRatio);
  else viewHeight = Math.min(subject.task.crop.height, viewWidth / targetRatio);
  const centerX = x + boxWidth / 2;
  const centerY = y + boxHeight / 2;
  const viewX = Math.max(0, Math.min(subject.task.crop.width - viewWidth, centerX - viewWidth / 2));
  const viewY = Math.max(0, Math.min(subject.task.crop.height - viewHeight, centerY - viewHeight / 2));
  const openVisualPicker = () => {
    if (interactive) window.dispatchEvent(new CustomEvent('photoflow-team-person-pick', { detail: { key: subject.key } }));
  };
  const title = `${subject.photo.name} · 人物 ${subject.personIndex}`;
  return <><div ref={container} role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined} onClick={openVisualPicker} onKeyDown={event => { if (interactive && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openVisualPicker(); } }} title={interactive ? '点击看图修改人物归属' : undefined} className={`group relative aspect-[4/3] overflow-hidden rounded-lg bg-slate-950 ${interactive ? 'cursor-pointer ring-blue-400 transition hover:ring-2 focus:outline-none focus:ring-2' : ''}`}>
    {url ? <svg className="block h-full w-full overflow-hidden" overflow="hidden" viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet"><image href={url} width={subject.task.crop.width} height={subject.task.crop.height}/><rect x={x} y={y} width={boxWidth} height={boxHeight} fill="none" stroke="#facc15" strokeWidth={Math.max(3, viewWidth / 180)}/></svg> : <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-500"><UserRound/>{loadFailed && <span className="px-2 text-center text-[10px] text-amber-400">预览读取失败，请重新识别生成工作图</span>}</div>}
    <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 py-1 pl-2 pr-11 text-[10px] font-bold text-white">{title}</span>
    {typeof subject.matchScore === 'number' && subject.matchScore >= 0 && <span className="absolute left-1.5 top-1.5 rounded bg-emerald-600/95 px-1.5 py-0.5 text-[9px] font-bold text-white">匹配度 {Math.round(subject.matchScore * 100)}% · {subject.matchEvidence === 'face+body' ? '脸+外观' : '外观辅助'}</span>}
    {interactive && <span className="absolute right-1.5 top-1.5 rounded bg-blue-600/90 px-1.5 py-0.5 text-[9px] font-bold text-white opacity-0 transition group-hover:opacity-100">看图改归属</span>}
    <button type="button" disabled={!url} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); setFullscreen(true); }} title="全窗口浏览图片" aria-label={`全窗口浏览图片：${title}`} className="absolute bottom-1.5 right-1.5 z-20 rounded-md border border-white/20 bg-black/75 p-1.5 text-white shadow-lg transition hover:bg-blue-600 disabled:hidden"><Maximize2 size={14}/></button>
  </div>{fullscreen && url && <SubjectFullscreenViewer url={url} filePath={imagePath} cacheConfig={cacheConfig} title={title} onClose={() => setFullscreen(false)}/>}</>;
}, (previous, next) => {
  const previousCrop = previous.subject.task.crop;
  const nextCrop = next.subject.task.crop;
  const previousBox = previous.subject.bbox;
  const nextBox = next.subject.bbox;
  return previous.subject.task.patchPath === next.subject.task.patchPath
    && previous.subject.photo.name === next.subject.photo.name
    && previous.subject.personIndex === next.subject.personIndex
    && previous.subject.matchScore === next.subject.matchScore
    && previous.subject.matchEvidence === next.subject.matchEvidence
    && previousCrop.x === nextCrop.x
    && previousCrop.y === nextCrop.y
    && previousCrop.width === nextCrop.width
    && previousCrop.height === nextCrop.height
    && previousBox.x === nextBox.x
    && previousBox.y === nextBox.y
    && previousBox.width === nextBox.width
    && previousBox.height === nextBox.height
    && previous.cacheConfig.directory === next.cacheConfig.directory
    && previous.cacheConfig.maxSizeGB === next.cacheConfig.maxSizeGB
    && previous.interactive === next.interactive
    && previous.active === next.active
    && previous.sourcePath === next.sourcePath;
});

type ReturnCandidate = {
  taskId?: string;
  photoId?: string;
  baseVersionId?: string;
  personIndex?: number;
  identityId?: string;
  photoName?: string;
  personName?: string;
  patchPath?: string;
  score: number;
};

const ReturnImage = ({ filePath, cacheConfig, active: componentActive = true, eager = false, className = '', style }: { filePath?: string; cacheConfig: AppConfig['mediaCache']; active?: boolean; eager?: boolean; className?: string; style?: React.CSSProperties }) => {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const mediaScope = legacyApi.getMediaAuthorizationScope();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!componentActive) { setVisible(false); return; }
    if (eager) { setVisible(true); return; }
    const node = container.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [componentActive, eager]);
  useEffect(() => {
    let active = true;
    if (!componentActive || !filePath) { if (!filePath) setUrl(''); setLoading(false); return () => { active = false; }; }
    setUrl('');
    if (!visible) return () => { active = false; };
    setLoading(true);
    const loadImage = async () => {
      let nextUrl = '';
      if (eager) {
        const original = await legacyApi.getMediaOriginal(filePath, 'image', cacheConfig);
        if (original.success && original.mediaUrl) nextUrl = original.mediaUrl;
      } else {
        const thumbnail = await legacyApi.getMediaThumbnail(filePath, 'image', cacheConfig, 480, 1, 0);
        nextUrl = thumbnail.previewUrl || '';
      }
      if (!active || !nextUrl) return;
      setUrl(nextUrl);
    };
    void loadImage().catch(() => undefined).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [filePath, visible, componentActive, eager, cacheConfig.directory, cacheConfig.maxSizeGB, mediaScope]);
  return <div ref={container} className={`relative flex items-center justify-center overflow-hidden bg-slate-950 ${className}`}>
    {url ? <img src={url} alt="" draggable={false} style={style} className="h-full w-full object-contain"/> : <ImageIcon size={24} className="text-slate-500"/>}
    {loading && <span className="absolute rounded-full bg-black/65 p-2 text-white"><Loader2 size={15} className="animate-spin"/></span>}
  </div>;
};

const returnCandidates = (match: TeamPatchReturnMatch): ReturnCandidate[] => {
  const primary: ReturnCandidate = {
    taskId: match.taskId,
    photoId: match.photoId,
    baseVersionId: match.baseVersionId,
    personIndex: match.personIndex,
    photoName: match.photoName,
    personName: match.personName,
    patchPath: match.patchPath,
    score: match.score,
  };
  const candidates = match.matched ? [primary, ...(match.alternatives || [])] : [...(match.alternatives || [])];
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    if (!candidate.taskId || seen.has(candidate.taskId)) return false;
    seen.add(candidate.taskId);
    return true;
  });
};

const WorkflowReturnReviewDialog = ({ result, cacheConfig, componentActive, busy, onClose, onConfirm, onIgnore }: {
  result: TeamPatchReturnBatchResult;
  cacheConfig: AppConfig['mediaCache'];
  componentActive: boolean;
  busy: string;
  onClose: () => void;
  onConfirm: (match: TeamPatchReturnMatch, candidate: ReturnCandidate) => Promise<boolean>;
  onIgnore: (match: TeamPatchReturnMatch) => Promise<boolean>;
}) => {
  const firstMatch = result.matches.find(match => !match.accepted) || result.matches[0];
  const [activeReturnId, setActiveReturnId] = useState(firstMatch?.returnId || '');
  const [candidateByReturn, setCandidateByReturn] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<ImageComparisonMode>('side-by-side');
  const activeMatch = result.matches.find(match => match.returnId === activeReturnId) || firstMatch;
  const candidates = activeMatch ? returnCandidates(activeMatch) : [];
  const selectedTaskId = activeMatch ? candidateByReturn[activeMatch.returnId] || activeMatch.taskId || candidates[0]?.taskId || '' : '';
  const activeCandidate = candidates.find(candidate => candidate.taskId === selectedTaskId) || candidates[0];
  const matchAssessment = returnMatchAssessment({ ...activeMatch, ...activeCandidate, taskId: activeCandidate?.taskId });
  const modificationAssessment = returnModificationAssessment(activeMatch || {});
  const usedTaskIds = new Set(result.matches.filter(match => match.accepted && match.taskId).map(match => match.taskId));
  const candidateAlreadyUsed = Boolean(activeCandidate?.taskId && usedTaskIds.has(activeCandidate.taskId) && !(activeMatch?.accepted && activeCandidate.taskId === activeMatch.taskId));
  const nextPendingReturnId = () => {
    if (!activeMatch) return '';
    const activeIndex = result.matches.findIndex(match => match.returnId === activeMatch.returnId);
    const following = [...result.matches.slice(activeIndex + 1), ...result.matches.slice(0, Math.max(0, activeIndex))];
    return following.find(match => !match.accepted)?.returnId || '';
  };
  const confirmAndAdvance = async () => {
    if (!activeMatch || !activeCandidate) return;
    const nextReturnId = nextPendingReturnId();
    if (await onConfirm(activeMatch, activeCandidate) && nextReturnId) setActiveReturnId(nextReturnId);
  };
  const ignoreAndAdvance = async () => {
    if (!activeMatch) return;
    const nextReturnId = nextPendingReturnId();
    if (await onIgnore(activeMatch) && nextReturnId) setActiveReturnId(nextReturnId);
  };
  useEffect(() => {
    if (!result.matches.some(match => match.returnId === activeReturnId)) setActiveReturnId(firstMatch?.returnId || '');
  }, [result.matches, activeReturnId, firstMatch?.returnId]);
  const workflowBusy = busy.startsWith('workflow-');
  const pendingReviewCount = result.matches.filter(match => !match.accepted).length;
  return <div role="dialog" aria-modal="true" aria-label="批量返图图片确认" className="fixed inset-0 z-[460] flex items-center justify-center bg-slate-950/70 p-4">
    <div className="flex max-h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex shrink-0 items-start gap-4 border-b border-slate-200 px-5 py-4"><div className="min-w-0 flex-1"><h3 className="font-bold text-slate-900">批量返图 · 看图确认</h3>{result.success ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-full bg-emerald-50 px-2.5 py-1 font-bold text-emerald-700">已确认 {result.acceptedCount || 0}</span><span className="rounded-full bg-amber-50 px-2.5 py-1 font-bold text-amber-700">待确认 {result.reviewCount || 0}</span>{Boolean(result.missingTaskCount) && <span className="text-slate-500">另有 {result.missingTaskCount} 个任务未收到可靠返图</span>}<span className="text-slate-400">左侧选返图，右侧直接核对照片内容</span></div> : <p className="mt-1 text-sm text-red-600">{result.error || '批量返图失败'}</p>}</div><button type="button" onClick={onClose} disabled={workflowBusy} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-40"><X size={19}/></button></header>
      {result.success && result.matches.length > 0 ? <div className="grid min-h-0 flex-1 grid-cols-[330px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-slate-200 bg-slate-50 p-3"><div className="space-y-2">{result.matches.map((match, index) => <button type="button" key={match.returnId} onClick={() => setActiveReturnId(match.returnId)} className={`w-full overflow-hidden rounded-xl border text-left transition ${activeMatch?.returnId === match.returnId ? 'border-blue-500 bg-white shadow-sm ring-2 ring-blue-100' : 'border-slate-200 bg-white hover:border-blue-300'}`}><div className="grid h-24 grid-cols-2 gap-px bg-slate-200"><ReturnImage active={componentActive} filePath={match.mediaPath || match.path} cacheConfig={cacheConfig}/><ReturnImage active={componentActive} filePath={match.patchPath} cacheConfig={cacheConfig}/></div><div className="p-2.5"><div className="flex items-center gap-2"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500">{index + 1}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{match.sourceName}</span><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${match.relayState === 'failed' ? 'bg-red-50 text-red-700' : match.accepted ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{!match.accepted ? '待确认' : match.relayState === 'ready' ? '接力已就绪' : match.relayState === 'failed' ? '更新失败' : '返图已确认'}</span></div><p className="mt-1 truncate pl-7 text-[11px] text-slate-500">{match.matched ? `${match.photoName} · ${match.personName} · ${Math.round(match.score * 100)}%` : '未找到可靠候选任务'}</p></div></button>)}</div></aside>
        <section className="flex min-h-0 min-w-0 flex-col bg-slate-950 text-white">{activeMatch ? <><div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-slate-900 px-4 py-2 text-[11px]" data-return-evidence><span className={`rounded-full px-2.5 py-1 font-bold ${matchAssessment.needsManualMatch ? 'bg-amber-500/20 text-amber-300' : 'bg-blue-500/20 text-blue-200'}`}>{matchAssessment.label}{matchAssessment.score !== undefined ? ` · ${Math.round(matchAssessment.score * 100)}%` : ''}</span><span className={`rounded-full px-2.5 py-1 font-bold ${modificationAssessment.suspicious || !modificationAssessment.known ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}`}>{modificationAssessment.label}</span>{!modificationAssessment.known && <span className="text-slate-400">旧数据无 editEvidence，必须看图核对</span>}{modificationAssessment.warnings.length > 0 && <span className="font-bold text-amber-300">返图警告：{modificationAssessment.warnings.map(warning => warning?.message || warning?.code || String(warning)).join('；')}</span>}</div><ImageComparisonView active={componentActive}
          left={{ label: `任务图 · ${activeCandidate?.photoName || '暂无候选'}`, content: activeCandidate?.patchPath ? <ReturnImage active={componentActive} filePath={activeCandidate.patchPath} cacheConfig={cacheConfig} eager className="absolute inset-0 h-full w-full"/> : <div className="absolute inset-0 flex items-center justify-center text-xs text-amber-300">没有可对比的候选任务</div> }}
          right={{ label: `返图 · ${activeMatch.sourceName}`, content: <ReturnImage active={componentActive} filePath={activeMatch.mediaPath || activeMatch.path} cacheConfig={cacheConfig} eager className="absolute inset-0 h-full w-full"/> }}
          mode={mode}
          onModeChange={setMode}
          comparisonKey={`${activeMatch.returnId}|${activeCandidate?.taskId || ''}`}
          unavailable={!activeCandidate?.patchPath}
          className="min-h-[360px]"
          leading={<><p className="truncate text-sm font-bold">{activeMatch.sourceName}</p><p className="mt-0.5 truncate text-[11px] text-slate-400">返图 ↔ {activeCandidate ? `${activeCandidate.photoName} · ${activeCandidate.personName}` : '暂无候选任务'}</p></>}
        />
          <footer className="shrink-0 border-t border-white/10 bg-slate-900 px-4 py-3"><div className="flex items-end gap-3"><div className="min-w-0 flex-1"><p className="mb-2 text-xs font-bold text-slate-300">候选任务（点击缩略图可人工改匹配）</p><div className="flex gap-2 overflow-x-auto">{candidates.length ? candidates.map(candidate => { const used = Boolean(candidate.taskId && usedTaskIds.has(candidate.taskId) && !(activeMatch.accepted && candidate.taskId === activeMatch.taskId)); return <button type="button" key={candidate.taskId} disabled={used} onClick={() => setCandidateByReturn(current => ({ ...current, [activeMatch.returnId]: candidate.taskId || '' }))} className={`flex w-44 shrink-0 items-center gap-2 rounded-lg border p-1.5 text-left disabled:opacity-35 ${activeCandidate?.taskId === candidate.taskId ? 'border-blue-400 bg-blue-500/15' : 'border-white/10 bg-white/5 hover:border-white/25'}`}><ReturnImage active={componentActive} filePath={candidate.patchPath} cacheConfig={cacheConfig} className="h-12 w-16 shrink-0 rounded"/><span className="min-w-0"><span className="block truncate text-[11px] font-bold text-slate-200">{candidate.photoName || '未知照片'}</span><span className="mt-1 block truncate text-[10px] text-slate-400">{candidate.personName || '未知人物'} · {Math.round((candidate.score || 0) * 100)}%</span></span></button>; }) : <p className="py-3 text-xs text-slate-500">没有可用候选</p>}</div></div><div className="shrink-0 text-right">{activeMatch.accepted ? <div><span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${activeMatch.relayState === 'failed' ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300'}`}><CheckCircle2 size={14}/>{activeMatch.relayState === 'ready' ? '接力已就绪' : activeMatch.relayState === 'failed' ? '接力更新失败' : '返图已确认 · 接力准备中'}</span><p className="mt-1 text-[10px] text-slate-500">确认只归档返图；接力发布完成后才会显示就绪</p></div> : <div className="flex items-center gap-2"><button type="button" disabled={workflowBusy} onClick={() => void ignoreAndAdvance()} title="从本批审核中移除，不会完成任何任务，也不会删除原始文件" className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-2.5 text-xs font-bold text-slate-200 hover:border-amber-400 hover:text-amber-300 disabled:opacity-40">{busy === `workflow-ignore:${activeMatch.returnId}` ? <Loader2 size={14} className="animate-spin"/> : <X size={14}/>}忽略 · 不是任务返图</button><button type="button" disabled={!activeCandidate?.taskId || !activeCandidate.photoId || !activeCandidate.baseVersionId || activeCandidate.personIndex === undefined || candidateAlreadyUsed || workflowBusy} onClick={() => void confirmAndAdvance()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40">{busy === `workflow-confirm:${activeMatch.returnId}` ? <Loader2 size={14} className="animate-spin"/> : <CheckCircle2 size={14}/>}确认返图</button></div>}{modificationAssessment.suspicious && <p className="mt-1 text-[10px] font-bold text-amber-300">返图疑似未修改，请先用对比模式核对</p>}{candidateAlreadyUsed && <p className="mt-1 text-[10px] text-amber-300">这个任务已被另一张返图占用</p>}</div></div></footer></> : null}</section>
      </div> : result.success ? <div className="flex min-h-64 items-center justify-center text-sm text-slate-500">没有可确认的返图</div> : null}
      <div className="flex shrink-0 items-center justify-between gap-4 border-t border-slate-200 bg-slate-50 px-5 py-3"><span className="text-xs text-slate-500">点击四周不会关闭；退出时会保留或明确放弃未确认返图。</span><button type="button" onClick={onClose} disabled={workflowBusy} className="dialog-primary">{pendingReviewCount ? '退出审核…' : '完成并关闭'}</button></div>
    </div>
  </div>;
};

type WorkflowItem = Subject & { week: number; ready: boolean; blockedBy: string[]; workflowImagePath: string };

const workflowWeekLabel = (week: number) => {
  const value = Math.max(1, Math.floor(Number(week) || 1));
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const text = value < 10 ? digits[value]
    : value === 10 ? '十'
      : value < 20 ? `十${digits[value - 10]}`
        : value < 100 ? `${digits[Math.floor(value / 10)]}十${digits[value % 10]}`
          : String(value);
  return `第${text}周`;
};

const completedReturnPath = (subject: Subject) => subject.assignment?.completed
  && subject.assignment.completionKind === 'returned'
  && subject.assignment.editedPatchPath
  && !subject.assignment.returnMissing
  ? subject.assignment.editedPatchPath
  : '';

const buildWorkflow = (subjects: Subject[], identities: TeamIdentity[], preferredIdentityOrder: string[] = [], sameWeekIdentityIds: string[] = []) => {
  const subjectCounts = new Map<string, number>();
  for (const subject of subjects) if (subject.identity) subjectCounts.set(subject.identity.id, (subjectCounts.get(subject.identity.id) || 0) + 1);
  const preferenceRank = new Map(preferredIdentityOrder.map((identityId, index) => [identityId, index]));
  const prioritizedIdentities = [...identities].sort((left, right) =>
    (preferenceRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (preferenceRank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || (subjectCounts.get(right.id) || 0) - (subjectCounts.get(left.id) || 0)
    || left.name.localeCompare(right.name));
  const identityOrder = new Map(prioritizedIdentities.map((identity, index) => [identity.id, index]));
  const anonymousOrder = new Map(subjects.filter(subject => !subject.identity).map((subject, index) => [subject.key, identities.length + index]));
  const orderOf = (subject: Subject) => subject.identity ? identityOrder.get(subject.identity.id) ?? Number.MAX_SAFE_INTEGER : anonymousOrder.get(subject.key) ?? Number.MAX_SAFE_INTEGER;
  const byTask = new Map<string, Subject[]>();
  for (const subject of subjects) {
    const current = byTask.get(subject.task.id) || [];
    current.push(subject);
    byTask.set(subject.task.id, current);
  }
  const scheduledWeeks = scheduleWorkflowWeeks(subjects.map(subject => ({
    key: subject.key,
    taskId: subject.task.id,
    personIndex: subject.personIndex,
    identityId: subject.identity?.id,
    identityName: subject.identity?.name,
  })), { preferredIdentityOrder, sameWeekIdentityIds });
  const items: WorkflowItem[] = [];
  for (const members of byTask.values()) {
    // Readiness is isolated per photo/task. A completed predecessor immediately
    // unlocks the next person even when that person is scheduled in a later week.
    const ordered = [...members].sort((left, right) => (scheduledWeeks.get(left.key) || 1) - (scheduledWeeks.get(right.key) || 1) || orderOf(left) - orderOf(right) || left.personIndex - right.personIndex);
    ordered.forEach((subject, index) => {
      const predecessors = ordered.slice(0, index);
      const blockedBy = [...new Set(predecessors
        .filter(item => !item.assignment?.completed)
        .map(item => item.identity?.name || `人物 ${item.personIndex}`))];
      // The persistent task folder receives the latest completed predecessor
      // return, while the people tab intentionally keeps showing the original crop.
      const predecessorReturn = [...predecessors].reverse().map(completedReturnPath).find(Boolean) || '';
      const workflowImagePath = predecessorReturn || subject.task.patchPath;
      items.push({ ...subject, week: scheduledWeeks.get(subject.key) || 1, ready: blockedBy.length === 0, blockedBy, workflowImagePath });
    });
  }
  return items.sort((left, right) => left.week - right.week || orderOf(left) - orderOf(right) || left.photo.name.localeCompare(right.photo.name));
};

const MergeReviewSurface = ({ workspace, subjects, mergeablePhotos, mergeReport, cacheConfig, componentActive, outputProgress, outputProgressDisabled, mergeActionLabel, mergeActionDisabled, mergeActionBusy, reoutputingPhotoId, onMergeAction, onReoutput }: {
  workspace: TeamIdentityWorkspace;
  subjects: Subject[];
  mergeablePhotos: TeamProjectPhoto[];
  mergeReport: ReturnType<typeof mergeAudit>;
  cacheConfig: AppConfig['mediaCache'];
  componentActive: boolean;
  outputProgress: ReturnType<typeof useTeamOutputProgress>;
  outputProgressDisabled: boolean;
  mergeActionLabel: '开始合并' | '继续合并' | '全部重新合并';
  mergeActionDisabled: boolean;
  mergeActionBusy: boolean;
  reoutputingPhotoId: string;
  onMergeAction: () => void;
  onReoutput: (photo: TeamProjectPhoto) => void;
}) => {
  const [showAllPhotos, setShowAllPhotos] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const mergeableKeys = new Set(mergeablePhotos.map(photo => `${photo.photoId}:${photo.baseVersionId}`));
  const photoRows = workspace.photos.map(photo => {
    const photoSubjects = subjects.filter(subject => subject.photo.photoId === photo.photoId && subject.photo.baseVersionId === photo.baseVersionId);
    const returned = photoSubjects.filter(subject => subject.assignment?.completed && subject.assignment.completionKind === 'returned' && !subject.assignment.returnMissing).length;
    const skipped = photoSubjects.filter(subject => subject.assignment?.completed && subject.assignment.completionKind !== 'returned').length;
    const incomplete = photoSubjects.filter(subject => !subject.assignment?.completed).length;
    const missing = photoSubjects.filter(subject => subject.assignment?.returnMissing).length;
    const pendingCropReview = photo.tasks.filter(task => task.needsReview || task.patchMissing).length;
    const merged = isPhotoMergeComplete(workspace, photo);
    const issues = [
      missing ? `返图缺失 ${missing}` : '',
      incomplete ? `任务未完成 ${incomplete}` : '',
      pendingCropReview ? `工作图待复核 ${pendingCropReview}` : '',
      !photoSubjects.length ? '没有人物任务' : '',
    ].filter(Boolean);
    const ready = merged || mergeableKeys.has(`${photo.photoId}:${photo.baseVersionId}`) && issues.length === 0;
    return { photo, returned, skipped, incomplete, missing, merged, ready, issues, total: photoSubjects.length };
  });
  const exceptions = photoRows.filter(row => row.issues.length > 0);
  const returnedCount = subjects.filter(subject => subject.assignment?.completed && subject.assignment.completionKind === 'returned' && !subject.assignment.returnMissing).length;
  const skippedCount = subjects.filter(subject => subject.assignment?.completed && subject.assignment.completionKind !== 'returned').length;
  const incompleteCount = subjects.filter(subject => !subject.assignment?.completed).length;
  const readyCount = photoRows.filter(row => row.ready && !row.merged).length;
  const visibleRows = showAllPhotos ? photoRows : exceptions;
  const ready = mergeReport.blockers.length === 0;
  return <section data-merge-review-surface className="space-y-4">
    <div className={`overflow-hidden rounded-2xl border ${ready ? 'border-emerald-200 bg-emerald-50/35' : 'border-amber-200 bg-amber-50/35'}`}>
      <div className="flex flex-wrap items-start gap-4 p-5"><span className={`mt-0.5 rounded-full p-2 ${ready ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{ready ? <CheckCircle2 size={20}/> : <AlertTriangle size={20}/>}</span><div className="min-w-0 flex-1"><h3 className="text-base font-bold text-slate-900">{ready ? `${readyCount} 张照片已就绪，可以合并` : `还有 ${mergeReport.blockers.length} 项问题需要处理`}</h3><p className="mt-1 text-sm text-slate-600">{subjects.length} 个任务：{returnedCount} 个已返图 · {skippedCount} 个不用修 · {incompleteCount} 个未完成</p></div><div className="grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-lg bg-white/80 px-3 py-2"><strong className="block text-base text-slate-900">{readyCount}</strong><span className="text-slate-500">待合并</span></div><div className="rounded-lg bg-white/80 px-3 py-2"><strong className="block text-base text-emerald-700">{mergeReport.completedPhotoCount}</strong><span className="text-slate-500">已输出</span></div><div className="rounded-lg bg-white/80 px-3 py-2"><strong className={`block text-base ${exceptions.length ? 'text-amber-700' : 'text-emerald-700'}`}>{exceptions.length}</strong><span className="text-slate-500">异常照片</span></div></div></div>
      {!ready && <div className="flex flex-wrap gap-2 border-t border-amber-100 px-5 py-3">{mergeReport.blockers.map(item => <span key={item.code} className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">{item.label} {item.count}</span>)}</div>}
    </div>
    <div className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4"><div className="min-w-0 flex-1"><h3 className="font-bold text-slate-900">{exceptions.length ? `需要注意的照片（${exceptions.length}）` : `全部 ${photoRows.length} 张照片检查通过`}</h3><p className="mt-1 text-xs text-slate-500">{exceptions.length ? '默认只显示异常；处理完后即可合并。' : '没有需要单独处理的照片。'}</p></div><button type="button" aria-expanded={showAllPhotos} onClick={() => setShowAllPhotos(current => !current)} className="dialog-secondary inline-flex items-center gap-2">{showAllPhotos ? '收起全部照片' : `查看全部照片（${photoRows.length}）`}<ChevronDown size={15} className={`transition-transform ${showAllPhotos ? 'rotate-180' : ''}`}/></button></div>
      {visibleRows.length > 0 && <div className="grid gap-3 border-t border-slate-100 p-4 md:grid-cols-2 xl:grid-cols-3">{visibleRows.map(row => <article key={`${row.photo.photoId}:${row.photo.baseVersionId}`} className={`flex min-w-0 gap-3 rounded-xl border p-3 ${row.issues.length ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200 bg-slate-50/50'}`}><ReturnImage active={componentActive} filePath={row.photo.sourcePath} cacheConfig={cacheConfig} className="h-16 w-24 shrink-0 rounded-lg"/><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h4 className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">{row.photo.name || row.photo.photoId}</h4><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${row.merged ? 'bg-blue-50 text-blue-700' : row.issues.length ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'}`}>{row.merged ? '已输出' : row.issues.length ? '需处理' : '已就绪'}</span></div><p className="mt-2 text-xs text-slate-500">{row.total} 个人物 · {row.returned} 个已返图 · {row.skipped} 个不用修</p>{row.issues.length > 0 && <p className="mt-1 text-xs font-bold text-amber-700">{row.issues.join('·')}</p>}{row.merged && <button type="button" disabled={Boolean(reoutputingPhotoId)} onClick={() => onReoutput(row.photo)} title="原输出被删除或需要替换时，生成新的输出文件和版本" className="dialog-secondary mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px]">{reoutputingPhotoId === row.photo.photoId ? <Loader2 size={12} className="animate-spin"/> : <Wand2 size={12}/>} 重新输出</button>}</div></article>)}</div>}
    </div>
    <div className="rounded-2xl border border-slate-200 bg-white"><button type="button" aria-expanded={showQuality} onClick={() => setShowQuality(current => !current)} className="flex w-full items-center gap-3 px-5 py-4 text-left"><div className="min-w-0 flex-1"><h3 className="font-bold text-slate-900">高级质量检查</h3><p className="mt-1 text-xs text-slate-500">旧数据没有自动评分时不影响合并；可在这里查看详情。</p></div><ChevronDown size={16} className={`text-slate-400 transition-transform ${showQuality ? 'rotate-180' : ''}`}/></button>{showQuality && <div className="grid gap-3 border-t border-slate-100 p-4 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">任务匹配</p><p className="mt-1 font-bold text-slate-800">{workspace.qualityMetrics?.taskMatchRate === undefined ? '旧数据未记录' : `${Math.round(workspace.qualityMetrics.taskMatchRate * 100)}%`}</p></div><div className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">修改有效性</p><p className="mt-1 font-bold text-slate-800">{workspace.qualityMetrics?.effectiveEditRate === undefined ? '旧数据未记录' : `${Math.round(workspace.qualityMetrics.effectiveEditRate * 100)}%`}</p></div><div className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">评分用途</p><p className="mt-1 text-xs font-bold leading-5 text-slate-700">仅用于辅助检查，不作为旧项目合并条件。</p></div></div>}</div>
    <div data-merge-actions className="flex flex-col items-center gap-3 py-5"><TeamOutputProgressPicker controller={outputProgress} disabled={outputProgressDisabled}/><button type="button" disabled={mergeActionDisabled} onClick={onMergeAction} className="dialog-primary inline-flex min-w-40 items-center justify-center gap-2">{mergeActionBusy ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>} {mergeActionLabel}</button></div>
  </section>;
};

export const PersonIdentityManager = ({ workspacePath, project, initialWorkspace, initialWorkspacePending = false, historyIssue, onRetryHistory, cacheConfig, componentActive = true, activeStep, onStepChange, onBlockedStage, onNotice, onProjectChanged, onBusyChange }: Props) => {
  const appDialog = useAppDialog();
  const initialSeed = isUsableWorkspaceSeed(initialWorkspace) ? initialWorkspace : undefined;
  const seedScopeKey = workspaceSeedScopeKey(workspacePath, project);
  const workspaceSeedGateRef = useRef(createWorkspaceSeedGate(seedScopeKey, Boolean(initialSeed)));
  const [workspace, setWorkspace] = useState<TeamIdentityWorkspace>(() => initialSeed || { success: true, photos: [], identities: [], assignments: [] });
  const [loading, setLoading] = useState(!initialSeed);
  const [workspaceLoadError, setWorkspaceLoadError] = useState('');
  const workspaceLoadSequenceRef = useRef(0);
  const [busy, setBusy] = useState('');
  const [mergeProgress, setMergeProgress] = useState({ active: false, phase: 'idle', total: 0, completed: 0, succeeded: 0, failed: 0 });
  const [pendingResources, setPendingResources] = useState<Set<string>>(new Set());
  const setResourcePending = (key: string, pending: boolean) => setPendingResources(current => { const next = new Set(current); if (pending) next.add(key); else next.delete(key); return next; });
  const tab = 'workflow' as const;
  const [assigningSubject, setAssigningSubject] = useState<Subject | null>(null);
  const identityPickerBusy = Boolean(busy) || Boolean(assigningSubject && pendingResources.has(assigningSubject.key));
  const [workflowReturnResult, setWorkflowReturnResult] = useState<TeamPatchReturnBatchResult | null>(null);
  const [workflowReturnReviewOpen, setWorkflowReturnReviewOpen] = useState(false);
  const pendingWorkflowReturnReviewCount = workflowReturnResult?.matches.filter(match => !match.accepted).length || 0;
  const requestCloseWorkflowReturnReview = async () => {
    if (!workflowReturnResult || busy.startsWith('workflow-')) return;
    if (!pendingWorkflowReturnReviewCount) {
      setWorkflowReturnReviewOpen(false);
      setWorkflowReturnResult(null);
      return;
    }
    const canSuspend = Boolean(workflowReturnResult.reviewSessionId);
    const action = await appDialog.choice({
      title: `还有 ${pendingWorkflowReturnReviewCount} 张返图未确认`,
      message: canSuspend ? '未确认返图已安全暂存在当前项目的审核批次中。' : '本批次还有返图没有确认，直接关闭会丢失当前审核进度。',
      detail: canSuspend ? '可暂存后继续处理；放弃将删除未确认的暂存副本，已确认返图不受影响。' : '请继续标注，或明确放弃本批次。',
      choices: [
        ...(canSuspend ? [{ value: 'suspend', label: '暂存并退出' }] : []),
        { value: 'discard', label: '放弃本批次', tone: 'danger' as const },
      ],
      cancelLabel: '继续标注',
      cancelDefault: true,
    });
    if (action === 'suspend') {
      setWorkflowReturnReviewOpen(false);
      return;
    }
    if (action !== 'discard') return;
    if (workflowReturnResult.reviewSessionId) {
      setBusy('workflow-review-discard');
      try {
        const result = await legacyApi.discardTeamWorkflowReturnReview(workspacePath, project.name, workflowReturnResult.reviewSessionId);
        if (!result.success) {
          onNotice(`放弃返图审核批次失败：${result.error || '未知错误'}`, 'error');
          return;
        }
      } catch (error) {
        onNotice(`放弃返图审核批次失败：${error instanceof Error ? error.message : String(error)}`, 'error');
        return;
      } finally { setBusy(''); }
    }
    setWorkflowReturnReviewOpen(false);
    setWorkflowReturnResult(null);
    onNotice('已放弃本批次未确认返图；已经确认完成的返图不受影响', 'success');
  };
  useEscapeLayer(Boolean(workflowReturnResult) && workflowReturnReviewOpen, () => void requestCloseWorkflowReturnReview(), !busy.startsWith('workflow-'));
  const [workflowReturnProgress, setWorkflowReturnProgress] = useState<WorkflowReturnProgressState | null>(null);
  const workflowReturnVisibleTaskIdsRef = useRef(new Set<string>());
  const workflowGenerationVisibleTaskIdsRef = useRef(new Set<string>());
  const [workflowGeneration, setWorkflowGeneration] = useState<TeamWorkflowGenerationProgress | null>(null);
  const [similarities, setSimilarities] = useState<NonNullable<TeamIdentityWorkspace['similarities']>>([]);
  const [subjectPageSize, setSubjectPageSize] = useState(18);
  const [relayChainsOpen, setRelayChainsOpen] = useState(false);
  const [draggedWorkflowIdentityId, setDraggedWorkflowIdentityId] = useState('');
  const [workflowDragTargetId, setWorkflowDragTargetId] = useState('');
  const workflowOrderDragRef = useRef<{ pointerId: number; sourceIdentityId: string; startX: number; startY: number; moved: boolean } | null>(null);
  const peopleScrollRef = useRef<HTMLElement>(null);
  const pendingPeopleScrollAnchorRef = useRef<{ key: string; top: number; scrollTop: number } | null>(null);
  const load = async (showLoading = true) => {
    const sequence = ++workspaceLoadSequenceRef.current;
    if (showLoading) setLoading(true);
    setWorkspaceLoadError('');
    try {
      const result = await legacyApi.getTeamProjectWorkspace(workspacePath, project.name, project.status);
      if (!result.success) throw new Error(result.error || '未知错误');
      if (sequence !== workspaceLoadSequenceRef.current) return;
      setWorkspace(result);
      if (result.workflowNodeCreated) onProjectChanged();
    } catch (error) {
      if (sequence !== workspaceLoadSequenceRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setWorkspaceLoadError(message); onNotice(`读取人物识别失败：${message}`, 'error');
    } finally { if (showLoading && sequence === workspaceLoadSequenceRef.current) setLoading(false); }
  };
  useEffect(() => {
    if (workspaceSeedGateRef.current.isSeeded(seedScopeKey)) { setLoading(false); return () => { workspaceLoadSequenceRef.current += 1; }; }
    if (initialWorkspacePending) return () => { workspaceLoadSequenceRef.current += 1; };
    if (workspaceSeedGateRef.current.consume(seedScopeKey, isUsableWorkspaceSeed(initialWorkspace))) { setWorkspace(initialWorkspace); setWorkspaceLoadError(''); setLoading(false); return () => { workspaceLoadSequenceRef.current += 1; }; }
    void load(true); return () => { workspaceLoadSequenceRef.current += 1; };
  }, [workspacePath, project.id, project.name, project.status, initialWorkspace, initialWorkspacePending]);
  useEffect(() => {
    let active = true;
    setWorkflowReturnResult(null);
    setWorkflowReturnReviewOpen(false);
    void legacyApi.drainTeamWorkflowReconciles(20).then(result => {
      if (!active) return;
      if (result.state === 'failed') onNotice(`返图已确认，但接力更新失败：${result.error || '请稍后重试'}`, 'error');
    }).catch(error => { if (active) onNotice(`返图接力恢复失败：${error instanceof Error ? error.message : String(error)}`, 'error'); });
    void legacyApi.getTeamWorkflowReturnReview(workspacePath, project.name, project.status).then(result => {
      if (!active) return;
      if (!result.success) {
        onNotice(`恢复未确认返图失败：${result.error || '未知错误'}`, 'error');
        return;
      }
      if (result.review) {
        setWorkflowReturnResult(result.review);
        setWorkflowReturnReviewOpen(true);
      }
    });
    return () => { active = false; };
  }, [workspacePath, project.name, project.status]);
  useEffect(() => legacyApi.onTeamPatchReturnBatchProgress(value => {
    if (!value.projectId || value.projectId === project.id) {
      if (value.operationId) workflowReturnVisibleTaskIdsRef.current.add(value.operationId);
      setWorkflowReturnProgress(current => current ? updateWorkflowReturnProgress(current, value) : current);
    }
  }), [project.id]);
  useEffect(() => {
    let active = true;
    const unsubscribe = legacyApi.onTeamWorkflowGenerationProgress(value => {
      if ((!value.projectId || value.projectId === project.id) && value.projectName === project.name) {
        if (value.operationId) workflowGenerationVisibleTaskIdsRef.current.add(value.operationId);
        setWorkflowGeneration(value);
      }
    });
    void legacyApi.getTeamWorkflowGenerationStatus(workspacePath, project.status, project.name).then(result => {
      if (active && result.success && result.job) setWorkflowGeneration(result.job);
    });
    return () => { active = false; unsubscribe(); };
  }, [workspacePath, project.status, project.name]);
  const subjects = useMemo(() => subjectsFromWorkspace(workspace), [workspace]);
  const similarityByPair = useMemo(() => new Map(similarities.map(item => [similarityPairKey(item.leftKey, item.rightKey), item])), [similarities]);
  const similarityFor = (left: string, right: string) => similarityByPair.get(similarityPairKey(left, right));
  useEffect(() => {
    const handlePick = async (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      const subject = subjects.find(item => item.key === key);
      if (subject) {
        if (tab === 'workflow' && subject.assignment?.completed) {
          onNotice('这个任务已经完成，不能再修改人物归属', 'warning');
          return;
        }
        setAssigningSubject(subject);
        if (!similarities.length) {
          const result = await legacyApi.getTeamIdentitySimilarities(workspacePath, project.name);
          if (result.success) setSimilarities(result.similarities);
        }
      }
    };
    window.addEventListener('photoflow-team-person-pick', handlePick);
    return () => window.removeEventListener('photoflow-team-person-pick', handlePick);
  }, [subjects, tab, similarities, workspacePath, project.name, onNotice]);
  const workflowIdentityOptions = useMemo(() => workspace.identities.filter(identity => subjects.some(subject => subject.identity?.id === identity.id)), [subjects, workspace.identities]);
  const preferredIdentityOrder = useMemo(() => {
    const storedOrder = workspace.workflowSettings?.preferredIdentityOrder?.length
      ? workspace.workflowSettings.preferredIdentityOrder
      : workspace.workflowSettings?.preferredIdentityId ? [workspace.workflowSettings.preferredIdentityId] : [];
    const availableIds = new Set(workflowIdentityOptions.map(identity => identity.id));
    return [...new Set(storedOrder)].filter(identityId => availableIds.has(identityId));
  }, [workflowIdentityOptions, workspace.workflowSettings]);
  const sameWeekIdentityIds = useMemo(() => {
    const requested = new Set(workspace.workflowSettings?.sameWeekIdentityIds || []);
    return preferredIdentityOrder.slice(1).filter(identityId => requested.has(identityId));
  }, [preferredIdentityOrder, workspace.workflowSettings?.sameWeekIdentityIds]);
  const workflow = useMemo(() => {
    const scheduled = buildWorkflow(subjects, workspace.identities, preferredIdentityOrder, sameWeekIdentityIds);
    if (!workspace.workflowGenerated) return scheduled;
    const available = new Set(workspace.workflowAvailableKeys || []);
    const availableSubjects = new Set(workspace.workflowAvailableSubjectKeys || []);
    return scheduled.map(item => {
      const workImageAvailable = availableSubjects.has(`${item.photo.baseVersionId}:${item.personIndex}`) || available.has(item.key);
      return {
        ...item,
        blockedBy: !workImageAvailable && item.blockedBy.length === 0 ? ['协作流程重新生成'] : item.blockedBy,
        ready: item.ready && workImageAvailable,
      };
    });
  }, [subjects, workspace.identities, workspace.workflowAvailableKeys, workspace.workflowAvailableSubjectKeys, workspace.workflowGenerated, preferredIdentityOrder, sameWeekIdentityIds]);
  const workflowIdentitySequence = useMemo(() => {
    const seen = new Set<string>();
    const sequence: Array<{ identity: TeamIdentity; week: number }> = [];
    for (const item of workflow) {
      if (!item.identity || seen.has(item.identity.id)) continue;
      seen.add(item.identity.id);
      sequence.push({ identity: item.identity, week: item.week });
    }
    return sequence;
  }, [workflow]);
  const workflowIdentityWeeks = useMemo(() => {
    const groups: Array<{ week: number; entries: typeof workflowIdentitySequence }> = [];
    for (const entry of workflowIdentitySequence) {
      const current = groups[groups.length - 1];
      if (current?.week === entry.week) current.entries.push(entry);
      else groups.push({ week: entry.week, entries: [entry] });
    }
    return groups;
  }, [workflowIdentitySequence]);
  const workflowOrderLocked = workspace.assignments.some(assignment => assignment.completed || assignment.returnMissing)
    || workspace.photos.some(photo => photo.tasks.some(task => Boolean(task.editedPatchPath) || !['', 'exported'].includes(String(task.status || 'exported'))));
  const workflowReady = Boolean(workspace.workflowGenerated && !workspace.workflowNeedsRegeneration);
  const outputProgress = useTeamOutputProgress(teamWorkflowSourcePaths(workspace.photos), workspacePath, project, onNotice);
  useEffect(() => {
    if (!workspace.workflowNode?.id) return;
    void outputProgress.ensureWorkflowInputs(workspace.workflowNode.id).then(() => onProjectChanged()).catch(error => {
      onNotice(`登记团片来源关系失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    });
  }, [workspace.workflowNode?.id, outputProgress.sourceProgressIds.join('|')]);
  const grouped = useMemo(() => {
    const groups = new Map<string, Subject[]>();
    for (const identity of workspace.identities) groups.set(identity.id, []);
    groups.set('__unassigned__', []);
    for (const subject of subjects) groups.get(subject.identity?.id || '__unassigned__')?.push(subject);
    if (assigningSubject) {
      for (const [key, items] of groups) {
        groups.set(key, items.map(item => {
          const similarity = similarityFor(assigningSubject.key, item.key);
          return { ...item, matchScore: similarity?.score, matchEvidence: similarity?.evidence };
        }).sort((left, right) => (right.matchScore ?? -1) - (left.matchScore ?? -1)));
      }
    }
    return groups;
  }, [subjects, workspace.identities, assigningSubject, similarityByPair]);
  const pickerIdentities = useMemo(() => {
    const availableIdentities = workspace.identities.filter(identity => !isGeneratedIdentity(identity));
    if (!assigningSubject) return availableIdentities;
    const bestScoreByIdentity = new Map<string, number>();
    for (const subject of subjects) {
      if (!subject.identity || subject.key === assigningSubject.key) continue;
      const score = similarityByPair.get(similarityPairKey(assigningSubject.key, subject.key))?.score ?? -1;
      bestScoreByIdentity.set(subject.identity.id, Math.max(bestScoreByIdentity.get(subject.identity.id) ?? -1, score));
    }
    // Similar identities are ordered only inside the picker. Reordering the
    // workspace identities made every section on the page move twice per mark.
    return availableIdentities.sort((left, right) =>
      (bestScoreByIdentity.get(right.id) ?? -1) - (bestScoreByIdentity.get(left.id) ?? -1)
      || left.createdAt - right.createdAt
    );
  }, [assigningSubject, subjects, similarityByPair, workspace.identities]);
  const preservePeopleScrollPosition = (movingSubjectKey: string) => {
    const scrollContainer = peopleScrollRef.current;
    if (!scrollContainer || tab !== 'people') return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const anchor = Array.from(scrollContainer.querySelectorAll<HTMLElement>('[data-team-person-key]')).find(node => {
      if (node.dataset.teamPersonKey === movingSubjectKey) return false;
      const rect = node.getBoundingClientRect();
      return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    });
    pendingPeopleScrollAnchorRef.current = {
      key: anchor?.dataset.teamPersonKey || '',
      top: anchor?.getBoundingClientRect().top || 0,
      scrollTop: scrollContainer.scrollTop,
    };
  };
  useLayoutEffect(() => {
    const pending = pendingPeopleScrollAnchorRef.current;
    const scrollContainer = peopleScrollRef.current;
    if (!pending || !scrollContainer) return;
    pendingPeopleScrollAnchorRef.current = null;
    const anchor = pending.key
      ? scrollContainer.querySelector<HTMLElement>(`[data-team-person-key="${CSS.escape(pending.key)}"]`)
      : null;
    if (anchor) scrollContainer.scrollTop += anchor.getBoundingClientRect().top - pending.top;
    else scrollContainer.scrollTop = pending.scrollTop;
  }, [workspace.assignments, tab]);

  const suggest = async () => {
    if (!await ensureFaceRecognitionConsent(appDialog)) return;
    setBusy('suggest');
    try {
      const result = await legacyApi.suggestTeamIdentities(workspacePath, project.name);
      if (!result.success) { onNotice(`自动人物分组失败：${result.error || '未知错误'}`, 'error'); return; }
      setSimilarities([]);
      setWorkspace({ ...result, similarities: undefined, workflowSettings: workspace.workflowSettings });
      const engine = result.faceBackend?.startsWith('adaface') ? 'AdaFace IR-18' : '身份识别模型';
      onNotice(`已生成 ${result.candidateGroupCount || 0} 个跨图候选组；${result.unmatchedCount || 0} 个人物因证据不足保持未标注 · ${engine}`, 'success');
    } catch (error) { onNotice(`自动人物分组失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(''); }
  };
  const createIdentity = async () => {
    const answer = await appDialog.prompt({ title: '新建人物身份', message: '填写姓名或便于团队识别的称呼。', defaultValue: `人物 ${workspace.identities.length + 1}`, confirmLabel: '新建' });
    if (!answer?.trim()) return;
    const result = await legacyApi.saveTeamIdentity(workspacePath, { projectName: project.name, name: answer.trim() });
    if (!result.success) onNotice(`新建人物失败：${result.error || '未知错误'}`, 'error');
    else setWorkspace(current => ({ ...current, identities: [...current.identities, { id: result.identityId, name: answer.trim(), color: '#2563eb', createdAt: Date.now(), updatedAt: Date.now() }] }));
  };
  const renameIdentity = async (identity: TeamIdentity, name: string) => {
    if (!name.trim() || name.trim() === identity.name) return;
    const result = await legacyApi.saveTeamIdentity(workspacePath, { projectName: project.name, identityId: identity.id, name: name.trim() });
    if (!result.success) onNotice(`保存姓名失败：${result.error || '未知错误'}`, 'error'); else { setWorkspace(current => ({ ...current, identities: current.identities.map(item => item.id === identity.id ? { ...item, name: name.trim(), updatedAt: Date.now() } : item) })); onNotice('人物姓名已更新', 'success'); }
  };
  const assign = async (subject: Subject, identityId: string) => {
    if (pendingResources.has(subject.key)) return;
    const nextIdentityId = identityId || undefined;
    const previousAssignment = subject.assignment;
    const completed = previousAssignment?.identityId === nextIdentityId ? Boolean(previousAssignment?.completed) : false;
    const updatedAt = Date.now();
    const optimisticAssignment: TeamPersonAssignment = {
      photoId: subject.photo.photoId,
      baseVersionId: subject.photo.baseVersionId,
      personIndex: subject.personIndex,
      identityId: nextIdentityId,
      source: 'manual',
      confidence: 1,
      completed,
      updatedAt,
    };
    const replaceAssignment = (current: TeamIdentityWorkspace, assignment?: TeamPersonAssignment) => {
      const assignments = current.assignments.filter(item => assignmentKey(item.photoId, item.baseVersionId, item.personIndex) !== subject.key);
      if (assignment) assignments.push(assignment);
      return { ...current, assignments };
    };
    preservePeopleScrollPosition(subject.key);
    setWorkspace(current => replaceAssignment(current, optimisticAssignment));
    setResourcePending(subject.key, true);
    try {
      const result = await legacyApi.assignTeamIdentity(workspacePath, { projectName: project.name, photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, personIndex: subject.personIndex, identityId: nextIdentityId, source: 'manual', confidence: 1, completed });
      if (!result.success) throw new Error(result.error || '未知错误');
      setAssigningSubject(null);
      if (previousAssignment?.identityId && previousAssignment.identityId !== nextIdentityId) {
        preservePeopleScrollPosition(subject.key);
        setWorkspace(current => ({
          ...current,
          identities: current.identities.filter(identity => identity.id !== previousAssignment.identityId || !isGeneratedIdentity(identity) || current.assignments.some(item => item.identityId === identity.id)),
        }));
      }
      if (tab === 'workflow' && previousAssignment?.identityId !== nextIdentityId) {
        void load(false);
        onProjectChanged();
        onNotice('人物归属已更新。请重新生成协作流程。', 'warning');
      }
    } catch (error) {
      preservePeopleScrollPosition(subject.key);
      setWorkspace(current => {
        const currentAssignment = current.assignments.find(item => assignmentKey(item.photoId, item.baseVersionId, item.personIndex) === subject.key);
        return currentAssignment?.updatedAt === updatedAt ? replaceAssignment(current, previousAssignment) : current;
      });
      onNotice(`标注人物失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally { setResourcePending(subject.key, false); }
  };
  const createIdentityForSubject = async (subject: Subject) => {
    if (pendingResources.has(subject.key)) return;
    const answer = await appDialog.prompt({ title: '把这张图标记为新人物', message: '填写姓名或便于团队识别的称呼。', defaultValue: `人物 ${workspace.identities.length + 1}`, confirmLabel: '新建并归入' });
    if (!answer?.trim()) return;
    setResourcePending(subject.key, true);
    try {
      const result = await legacyApi.saveTeamIdentity(workspacePath, { projectName: project.name, name: answer.trim(), assignments: [{ photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, personIndex: subject.personIndex, confidence: 1, source: 'manual' }] });
      if (!result.success) onNotice(`新建人物失败：${result.error || '未知错误'}`, 'error'); else {
        setAssigningSubject(null);
        void load(false);
        if (tab === 'workflow') onNotice('已添加人物。请重新生成协作流程。', 'warning');
      }
    } catch (error) { onNotice(`新建人物失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setResourcePending(subject.key, false); }
  };
  const removeIdentity = async (identity: TeamIdentity) => {
    const answer = await appDialog.confirm({ title: `删除人物“${identity.name}”？`, message: '只删除身份与归属标记，不会删除照片或团片协作工作图。', confirmLabel: '删除', tone: 'danger' });
    if (!answer) return;
    const result = await legacyApi.deleteTeamIdentity(workspacePath, { projectName: project.name, identityId: identity.id });
    if (!result.success) onNotice(`删除人物失败：${result.error || '未知错误'}`, 'error');
    else setWorkspace(current => ({ ...current, identities: current.identities.filter(item => item.id !== identity.id), assignments: current.assignments.map(item => item.identityId === identity.id ? { ...item, identityId: undefined, completed: false, updatedAt: Date.now() } : item) }));
  };
  const savePreferredIdentityOrder = async (identityOrder: string[], requestedSameWeekIdentityIds: string[], successMessage: string) => {
    if (workflowOrderLocked) {
      onNotice('已有任务返图或完成，开工顺序已锁定', 'warning');
      return;
    }
    const nextOrder = [...new Set(identityOrder)].filter(identityId => workflowIdentityOptions.some(identity => identity.id === identityId));
    const nextSameWeekIdentityIds = [...new Set(requestedSameWeekIdentityIds)].filter(identityId => nextOrder.slice(1).includes(identityId));
    setBusy('workflow-settings');
    try {
      const result = await legacyApi.saveTeamWorkflowSettings(workspacePath, { projectName: project.name, preferredIdentityOrder: nextOrder, sameWeekIdentityIds: nextSameWeekIdentityIds });
      if (!result.success) { onNotice(`保存开工顺序失败：${result.error || '未知错误'}`, 'error'); return; }
      setWorkspace(current => ({ ...current, workflowNeedsRegeneration: Boolean(current.workflowGenerated), workflowSettings: result.workflowSettings || { ...current.workflowSettings, preferredIdentityOrder: nextOrder, preferredIdentityId: nextOrder[0], sameWeekIdentityIds: nextSameWeekIdentityIds } }));
      onNotice(successMessage, 'success');
    } catch (error) { onNotice(`保存开工顺序失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(''); }
  };
  const movePreferredIdentity = async (sourceIdentityId: string, targetIdentityId: string) => {
    if (!sourceIdentityId || sourceIdentityId === targetIdentityId) return;
    const weekGroups = workflowIdentityWeeks.map(group => group.entries.map(entry => entry.identity.id));
    const sourceGroup = weekGroups.find(group => group.includes(sourceIdentityId));
    const targetGroup = weekGroups.find(group => group.includes(targetIdentityId));
    if (!sourceGroup || !targetGroup) return;
    sourceGroup.splice(sourceGroup.indexOf(sourceIdentityId), 1);
    const targetIndex = targetGroup.indexOf(targetIdentityId);
    if (targetIndex < 0) return;
    targetGroup.splice(targetIndex, 0, sourceIdentityId);
    const compactGroups = weekGroups.filter(group => group.length);
    const nextOrder = compactGroups.flat();
    const nextSameWeekIdentityIds = compactGroups.flatMap(group => group.slice(1));
    await savePreferredIdentityOrder(nextOrder, nextSameWeekIdentityIds, '人物顺序和工作周已保存。请重新生成协作流程。');
  };
  const workflowIdentityAtPoint = (clientX: number, clientY: number) => document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>('[data-workflow-identity-id]')
    ?.dataset.workflowIdentityId || '';
  const startWorkflowIdentityPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, sourceIdentityId: string) => {
    if (workflowOrderLocked || busy || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    workflowOrderDragRef.current = {
      pointerId: event.pointerId,
      sourceIdentityId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    setDraggedWorkflowIdentityId(sourceIdentityId);
    setWorkflowDragTargetId('');
  };
  const moveWorkflowIdentityPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = workflowOrderDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    const targetIdentityId = workflowIdentityAtPoint(event.clientX, event.clientY);
    setWorkflowDragTargetId(targetIdentityId === drag.sourceIdentityId ? '' : targetIdentityId);
  };
  const finishWorkflowIdentityPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = workflowOrderDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const targetIdentityId = !cancelled && drag.moved ? workflowIdentityAtPoint(event.clientX, event.clientY) : '';
    workflowOrderDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggedWorkflowIdentityId('');
    setWorkflowDragTargetId('');
    if (targetIdentityId && targetIdentityId !== drag.sourceIdentityId) void movePreferredIdentity(drag.sourceIdentityId, targetIdentityId);
  };
  const moveWorkflowIdentityWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, identityId: string, index: number) => {
    if (workflowOrderLocked || busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const targetIndex = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? index - 1 : index + 1;
    const targetIdentity = workflowIdentitySequence[targetIndex]?.identity;
    if (!targetIdentity) return;
    event.preventDefault();
    void movePreferredIdentity(identityId, targetIdentity.id);
  };
  const toggleComplete = async (item: WorkflowItem) => {
    const completed = !item.assignment?.completed;
    if (completed && !await appDialog.confirm({ title: '确认这个任务不用修？', message: '会将当前工作图原样交给接力链中的下一位，并把此人的修图任务标记为完成。', confirmLabel: '确认不用修' })) return;
    if (pendingResources.has(item.key)) return;
    setResourcePending(item.key, true);
    try {
      const result = await legacyApi.completeTeamIdentity(workspacePath, { photoId: item.photo.photoId, baseVersionId: item.photo.baseVersionId, personIndex: item.personIndex, completed, completionKind: completed ? 'no-retouch' : '', taskId: item.task.id, taskOrder: workflow.filter(candidate => candidate.photo.photoId === item.photo.photoId && candidate.photo.baseVersionId === item.photo.baseVersionId && candidate.task.id === item.task.id && candidate.identity).sort((left, right) => left.week - right.week || left.personIndex - right.personIndex).map(candidate => candidate.personIndex), projectName: project.name, status: project.status });
      if (!result.success) onNotice(`更新完成状态失败：${result.error || '未知错误'}`, 'error'); else { if (result.warning) onNotice(result.warning, 'warning'); void load(false); }
    } catch (error) { onNotice(`更新完成状态失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setResourcePending(item.key, false); }
  };
  const markWeekNoRetouch = async (identity: TeamIdentity, week: number, groupItems: WorkflowItem[]) => {
    const pending = groupItems.filter(item => item.ready && !item.assignment?.completed);
    if (!pending.length) return;
    const confirmed = await appDialog.confirm({
      title: `确认“${identity.name}”第 ${week} 周不用修？`,
      message: `将把本周当前可分发且尚未上传的 ${pending.length} 个任务标记为不用修，并把上一步图片原样交给下一位。已上传返图和其他周次不会受影响。`,
      confirmLabel: '本周均不用修',
    });
    if (!confirmed) return;
    setBusy(`skip:${week}:${identity.id}`);
    let completedCount = 0;
    let errorMessage = '';
    let warningMessage = '';
    try {
      let cursor = 0;
      const worker = async () => {
        while (!errorMessage && cursor < pending.length) {
          const item = pending[cursor++];
          const result = await legacyApi.completeTeamIdentity(workspacePath, { photoId: item.photo.photoId, baseVersionId: item.photo.baseVersionId, personIndex: item.personIndex, completed: true, completionKind: 'no-retouch', taskId: item.task.id, taskOrder: workflow.filter(candidate => candidate.photo.photoId === item.photo.photoId && candidate.photo.baseVersionId === item.photo.baseVersionId && candidate.task.id === item.task.id && candidate.identity).sort((left, right) => left.week - right.week || left.personIndex - right.personIndex).map(candidate => candidate.personIndex), projectName: project.name, status: project.status });
          if (!result.success) { errorMessage = result.error || '未知错误'; return; }
          if (result.warning) warningMessage = result.warning;
          completedCount += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
      await load(false);
      if (errorMessage) onNotice(`已标记 ${completedCount} 个任务，剩余任务处理失败：${errorMessage}`, 'error');
      else if (warningMessage) onNotice(warningMessage, 'warning');
      else onNotice(`“${identity.name}”第 ${week} 周的 ${completedCount} 个任务已标记为不用修`, 'success');
    } catch (error) { onNotice(`批量标记失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(''); }
  };
  const upload = async (item: WorkflowItem) => {
    if (pendingResources.has(item.key)) return;
    setResourcePending(item.key, true);
    try {
      const result = await legacyApi.uploadTeamPatch(workspacePath, { photoId: item.photo.photoId, taskId: item.task.id, personIndex: item.personIndex, projectName: project.name, status: project.status });
      if (!result.success) onNotice(`上传返图失败：${result.error || '未知错误'}`, 'error'); else if (!result.cancelled) { onNotice(result.warning || '返图已上传，下一位接力正在准备。', result.warning ? 'warning' : 'success'); void load(false); }
    } catch (error) { onNotice(`上传返图失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setResourcePending(item.key, false); }
  };
  const removeUpload = async (item: WorkflowItem) => {
    if (!await appDialog.confirm({ title: '删除这张返图？', message: '会删除团片协作中的返图副本、撤销任务完成状态，并重新阻塞后续接力；不会删除你选择的原始返图文件。', confirmLabel: '删除返图', tone: 'danger' })) return;
    if (pendingResources.has(item.key)) return;
    setResourcePending(item.key, true);
    try {
      const result = await legacyApi.removeTeamPatchUpload(workspacePath, { photoId: item.photo.photoId, taskId: item.task.id, personIndex: item.personIndex, projectName: project.name, status: project.status });
      if (!result.success) onNotice(`删除返图失败：${result.error || '未知错误'}`, 'error');
      else { await load(false); onNotice(result.warning || '返图已删除，并已撤销完成标记', result.warning ? 'warning' : 'success'); }
    } catch (error) { onNotice(`删除返图失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setResourcePending(item.key, false); }
  };
  const openTaskFolder = async (identity: TeamIdentity, week: number) => {
    setBusy(`open:${week}:${identity.id}`);
    try {
      const result = await legacyApi.exportTeamIdentityTasks(workspacePath, project.status, project.name, { week, identityId: identity.id });
      if (!result.success) onNotice(`打开任务文件夹失败：${result.error || '未知错误'}`, 'error');
      else if (result.state === 'preparing') onNotice(result.message || '任务文件夹正在后台准备', 'info');
      else if (result.path) void legacyApi.openTeamPatchFolder(result.path);
    } catch (error) { onNotice(`打开任务文件夹失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
    finally { setBusy(''); }
  };
  const receiveWorkflowBatch = async (items: WorkflowItem[]) => {
    const operationId = crypto.randomUUID();
    setBusy('workflow-return');
    setWorkflowReturnResult(null);
    setWorkflowReturnReviewOpen(false);
    setWorkflowReturnProgress(beginWorkflowReturnProgress(operationId));
    try {
      const selected = await legacyApi.selectTeamPatchReturns(project.name);
      if (!selected.success) throw new Error(selected.error || '无法选择返图');
      if (selected.cancelled || !selected.files?.length) { if (selected.cancelled) onNotice('已取消选择返图', 'info'); return; }
      setWorkflowReturnProgress(current => current ? updateWorkflowReturnProgress(current, { operationId, phase: 'reading', progress: 4, message: `已选择 ${selected.files.length} 张返图，正在读取内容` }) : current);
      const result = await legacyApi.returnTeamWorkflowBatch(workspacePath, project.name, {
        operationId,
        status: project.status,
        returnedFiles: selected.files,
        items: items.map(item => ({
          photoId: item.photo.photoId,
          baseVersionId: item.photo.baseVersionId,
          personIndex: item.personIndex,
          taskId: item.task.id,
          taskOrder: workflow
            .filter(candidate => candidate.photo.photoId === item.photo.photoId && candidate.photo.baseVersionId === item.photo.baseVersionId && candidate.task.id === item.task.id && candidate.identity)
            .sort((left, right) => left.week - right.week || left.personIndex - right.personIndex)
            .map(candidate => candidate.personIndex),
        })),
      });
      const presentation = workflowReturnVisibleTaskIdsRef.current.has(operationId) ? 'visible' : 'none';
      if (!result.success) {
        if (shouldEmitTerminalToast({ presentation, outcome: result.cancelled ? 'cancelled' : 'failed' })) onNotice(result.cancelled ? '批量导入返图已取消' : `批量导入返图失败：${result.error || '未知错误'}`, result.cancelled ? 'info' : 'error');
        return;
      }
      if ((result.reviewCount || 0) > 0) {
        setWorkflowReturnResult(result);
        setWorkflowReturnReviewOpen(true);
      }
      await load(false);
      onProjectChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = /取消|cancel/i.test(message);
      const presentation = workflowReturnVisibleTaskIdsRef.current.has(operationId) ? 'visible' : 'none';
      if (shouldEmitTerminalToast({ presentation, outcome: cancelled ? 'cancelled' : 'failed' })) onNotice(cancelled ? '批量导入返图已取消' : `批量导入返图失败：${message}`, cancelled ? 'info' : 'error');
    } finally {
      workflowReturnVisibleTaskIdsRef.current.delete(operationId);
      setBusy('');
      setWorkflowReturnProgress(null);
    }
  };
  const confirmWorkflowReturn = async (match: TeamPatchReturnMatch, candidate: ReturnCandidate) => {
    if (!candidate.taskId || !candidate.photoId || !candidate.baseVersionId || candidate.personIndex === undefined) return false;
    const taskOrder = workflow
      .filter(item => item.photo.photoId === candidate.photoId && item.photo.baseVersionId === candidate.baseVersionId && item.task.id === candidate.taskId && item.identity)
      .sort((left, right) => left.week - right.week || left.personIndex - right.personIndex)
      .map(item => item.personIndex);
    setBusy(`workflow-confirm:${match.returnId}`);
    try {
      const result = await legacyApi.confirmTeamWorkflowReturn(workspacePath, project.name, {
        status: project.status,
        reviewSessionId: workflowReturnResult?.reviewSessionId,
        returnId: match.returnId,
        photoId: candidate.photoId,
        baseVersionId: candidate.baseVersionId,
        personIndex: candidate.personIndex,
        taskId: candidate.taskId,
        taskOrder,
      });
      if (!result.success) { onNotice(`确认返图失败：${result.error || '未知错误'}`, 'error'); return false; }
      setWorkflowReturnResult(current => {
        if (!current) return current;
        const wasAccepted = Boolean(current.matches.find(item => item.returnId === match.returnId)?.accepted);
        const acceptedDelta = wasAccepted ? 0 : 1;
        return {
          ...current,
          reviewSessionId: result.reviewSessionCompleted ? undefined : current.reviewSessionId,
          acceptedCount: (current.acceptedCount || 0) + acceptedDelta,
          reviewCount: Math.max(0, (current.reviewCount || 0) - acceptedDelta),
          missingTaskCount: Math.max(0, (current.missingTaskCount || 0) - acceptedDelta),
          matches: current.matches.map(item => item.returnId === match.returnId ? {
            ...item, ...candidate, returnId: item.returnId, sourceName: item.sourceName, path: item.path,
            matched: true, accepted: true, confidence: 'manual', relayState: 'preparing',
          } : item),
        };
      });
      onProjectChanged();
      onNotice(`返图已确认：${candidate.photoName || '任务图'} · ${candidate.personName || '人物'}；接力准备中`, 'success');
      void legacyApi.drainTeamWorkflowReconciles(20).then(drain => {
        const relayState = drain.state === 'ready' ? 'ready' : drain.state === 'failed' ? 'failed' : 'preparing';
        setWorkflowReturnResult(current => current ? { ...current, matches: current.matches.map(item => item.returnId === match.returnId ? { ...item, relayState, relayError: drain.error || '' } : item) } : current);
        if (relayState === 'ready') { onNotice('返图接力已就绪', 'success'); void load(false); }
        else if (relayState === 'failed') onNotice(`返图已确认，但接力更新失败：${drain.error || '下次启动将继续恢复'}`, 'error');
      }).catch(error => {
        setWorkflowReturnResult(current => current ? { ...current, matches: current.matches.map(item => item.returnId === match.returnId ? { ...item, relayState: 'failed', relayError: error instanceof Error ? error.message : String(error) } : item) } : current);
        onNotice(`返图已确认，但接力更新失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      });
      return true;
    } catch (error) {
      onNotice(`确认返图失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      return false;
    } finally { setBusy(''); }
  };
  const ignoreWorkflowReturn = async (match: TeamPatchReturnMatch) => {
    const reviewSessionId = workflowReturnResult?.reviewSessionId;
    if (!reviewSessionId) {
      onNotice('当前审核批次无法单独移除返图，请重新进入项目后重试', 'warning');
      return false;
    }
    const confirmed = await appDialog.confirm({
      title: '确认这不是任务返图？',
      message: `“${match.sourceName}”将从本次审核中移除，不会匹配或完成任何任务。`,
      detail: '将删除未确认的暂存副本，不删除原文件；对应任务仍为未完成。',
      confirmLabel: '移出审核',
      cancelLabel: '继续核对',
      tone: 'danger',
    });
    if (!confirmed) return false;
    setBusy(`workflow-ignore:${match.returnId}`);
    let result;
    try { result = await legacyApi.ignoreTeamWorkflowReturnReview(workspacePath, project.name, reviewSessionId, match.returnId); }
    catch (error) { onNotice(`移除非任务返图失败：${error instanceof Error ? error.message : String(error)}`, 'error'); return false; }
    finally { setBusy(''); }
    if (!result.success) {
      onNotice(`移除非任务返图失败：${result.error || '未知错误'}`, 'error');
      return false;
    }
    if (result.reviewSessionCompleted) {
      setWorkflowReturnReviewOpen(false);
      setWorkflowReturnResult(null);
    } else {
      setWorkflowReturnResult(current => current ? {
        ...current,
        reviewCount: Math.max(0, (current.reviewCount || 0) - 1),
        matches: current.matches.filter(item => item.returnId !== match.returnId),
      } : current);
    }
    onNotice(`已将“${match.sourceName}”标记为不是任务返图；没有任务被完成`, 'success');
    return true;
  };

  const workflowGroups = new Map<string, { identity: TeamIdentity; week: number; items: WorkflowItem[] }>();
  for (const item of workflow) {
    if (!item.identity) continue;
    const key = `${item.week}:${item.identity.id}`;
    const group = workflowGroups.get(key) || { identity: item.identity, week: item.week, items: [] };
    group.items.push(item);
    workflowGroups.set(key, group);
  }
  const weeks = [...new Set([...workflowGroups.values()].map(group => group.week))].sort((a, b) => a - b);
  const identityWeeks = new Map<string, Set<number>>();
  for (const item of workflow) {
    if (!item.identity) continue;
    const usedWeeks = identityWeeks.get(item.identity.id) || new Set<number>();
    usedWeeks.add(item.week);
    identityWeeks.set(item.identity.id, usedWeeks);
  }
  const splitIdentityCount = [...identityWeeks.values()].filter(usedWeeks => usedWeeks.size > 1).length;
  const personWeekCount = [...identityWeeks.values()].reduce((total, usedWeeks) => total + usedWeeks.size, 0);
  const readyWorkflowItems = workflowReady ? workflow.filter(item => item.identity && item.ready && !item.assignment?.completed) : [];
  const workflowGenerating = workflowGeneration?.state === 'running';
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  useEffect(() => {
    onBusyChangeRef.current?.(Boolean(busy) || workflowGenerating);
  }, [busy, workflowGenerating]);
  useEffect(() => () => onBusyChangeRef.current?.(false), []);
  const generateWorkflow = async () => {
    const groups = [...workflowGroups.values()].map(group => ({
      week: group.week,
      identityId: group.identity.id,
      identityName: group.identity.name,
      items: group.items.map(item => ({
        photoId: item.photo.photoId,
        baseVersionId: item.photo.baseVersionId,
          personIndex: item.personIndex,
          taskId: item.task.id,
          photoName: item.photo.name,
      })),
    }));
    let requestedOperationId = '';
    const run = (replace = false) => {
      const operationId = crypto.randomUUID();
      requestedOperationId = operationId;
      setWorkflowGeneration({ operationId, projectName: project.name, state: 'running', phase: 'preparing', progress: 0, completedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0, currentName: '', message: '正在准备协作流程…' });
      return legacyApi.generateTeamWorkflow(workspacePath, project.status, project.name, { operationId, preferredIdentityOrder, sameWeekIdentityIds, groups, replace });
    };
    let result = await run();
    if (result.requiresConfirmation) {
      setWorkflowGeneration(null);
      const confirmed = await appDialog.confirm({
        title: '重新生成协作流程？',
        message: '将删除现有任务文件夹，并按当前人物和排期重新生成。',
        confirmLabel: '删除并重新生成',
        tone: 'danger',
      });
      if (!confirmed) return;
      result = await run(true);
    }
    if (result.alreadyRunning) return;
    const presentation = workflowGenerationVisibleTaskIdsRef.current.has(requestedOperationId) ? 'visible' : 'none';
    if (!result.success) {
      if (shouldEmitTerminalToast({ presentation, outcome: result.cancelled ? 'cancelled' : 'failed' })) onNotice(result.cancelled ? result.resumable ? '已停止生成；下次会从现有进度继续' : '已停止生成协作流程' : `生成协作流程失败：${result.error || '未知错误'}`, result.cancelled ? 'info' : 'error');
      workflowGenerationVisibleTaskIdsRef.current.delete(requestedOperationId);
      return;
    }
    if (shouldEmitTerminalToast({ presentation, outcome: 'completed' })) onNotice(`协作流程已保存：${result.groupCount || 0} 个批次，${result.count || 0} 张任务图`, 'success');
    workflowGenerationVisibleTaskIdsRef.current.delete(requestedOperationId);
    await load(false);
  };
  const cancelWorkflowGeneration = async () => {
    if (!workflowGeneration?.operationId || !workflowGenerating) return;
    setWorkflowGeneration(current => current ? { ...current, phase: 'cancelling', message: '正在安全停止…' } : current);
    const result = await legacyApi.cancelTeamWorkflowGeneration(workflowGeneration.operationId);
    if (!result.success) onNotice(`停止生成失败：${result.error || '未知错误'}`, 'error');
  };

  const mergeablePhotos = workspace.photos.filter(photo => {
    const photoSubjects = subjects.filter(subject => subject.photo.photoId === photo.photoId && subject.photo.baseVersionId === photo.baseVersionId);
    return photo.tasks.length > 0
      && photo.tasks.some(task => Boolean(task.editedPatchPath))
      && !isPhotoMergeComplete(workspace, photo)
      && photoSubjects.length > 0
      && photoSubjects.every(subject => Boolean(subject.assignment?.completed));
  });
  const mergedPhotos = workspace.photos.filter(photo => isPhotoMergeComplete(workspace, photo));
  const mergePhotoCount = workspace.photos.filter(photo => photo.tasks.length > 0).length;
  const allPhotosMergedOnce = mergePhotoCount > 0 && mergedPhotos.length === mergePhotoCount;
  const mergeActionLabel: '开始合并' | '继续合并' | '全部重新合并' = allPhotosMergedOnce ? '全部重新合并' : mergedPhotos.length ? '继续合并' : '开始合并';
  const mergeCompletedPhotos = async () => {
    if (!mergeablePhotos.length) return;
    if (!await appDialog.confirm({ title: `${mergeActionLabel} ${mergeablePhotos.length} 张照片？`, message: '将按接力顺序把已确认返图合并到所选位置，并为每张照片生成新的输出版本。', confirmLabel: mergeActionLabel })) return;
    setBusy('merge-workflow');
    setMergeProgress({ active: true, phase: 'preparing', total: mergeablePhotos.length, completed: 0, succeeded: 0, failed: 0 });
    try {
      const target = await outputProgress.ensureTargetProgress(workspace.workflowNode?.id);
      setMergeProgress(current => ({ ...current, phase: 'merging' }));
      let merged = 0;
      let cursor = 0;
      const worker = async () => {
        while (cursor < mergeablePhotos.length) {
          const photo = mergeablePhotos[cursor++];
          let succeeded = false;
          try {
            const result = await legacyApi.mergeTeamPatches(workspacePath, project.status, project.name, {
              photoId: photo.photoId,
              baseVersionId: photo.baseVersionId,
            outputProgressId: target.id,
            versionName: '团片协作合成',
            rebuildToken: crypto.randomUUID(),
            });
            succeeded = Boolean(result.success);
            if (succeeded) merged += 1;
          } finally {
            setMergeProgress(current => ({ ...current, completed: current.completed + 1, succeeded: current.succeeded + (succeeded ? 1 : 0), failed: current.failed + (succeeded ? 0 : 1) }));
          }
        }
      };
      await worker();
      await load(false);
      onNotice(`已将 ${merged}/${mergeablePhotos.length} 张全部完成的图片合成到目标进度`, 'success');
    } catch (error) {
      onNotice(`合成照片失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy('');
      setMergeProgress(current => ({ ...current, active: false, phase: 'complete' }));
    }
  };

  const reoutputPhoto = async (photo: TeamProjectPhoto) => {
    if (busy) return;
    const name = photo.name || photo.displayName || photo.photoId;
    if (!await appDialog.confirm({ title: `重新输出“${name}”？`, message: '会使用已保存的返图重新合成，并在当前目标进度中生成新的输出文件和版本。不会复用已删除的旧输出记录。', confirmLabel: '重新输出' })) return;
    setBusy(`remerge:${photo.photoId}`);
    setMergeProgress({ active: true, phase: 'preparing', total: 1, completed: 0, succeeded: 0, failed: 0 });
    try {
      const target = await outputProgress.ensureTargetProgress(workspace.workflowNode?.id);
      setMergeProgress(current => ({ ...current, phase: 'merging' }));
      let succeeded = false;
      try {
        const result = await legacyApi.mergeTeamPatches(workspacePath, project.status, project.name, {
          photoId: photo.photoId,
          baseVersionId: photo.baseVersionId,
          outputProgressId: target.id,
          versionName: '团片协作合成（重新输出）',
          rebuildToken: crypto.randomUUID(),
        });
        succeeded = Boolean(result.success);
        if (!succeeded) throw new Error(result.error || '重新输出失败');
      } finally {
        setMergeProgress(current => ({ ...current, completed: 1, succeeded: succeeded ? 1 : 0, failed: succeeded ? 0 : 1 }));
      }
      await load(false);
      onNotice(`已为“${name}”生成新的合成输出`, 'success');
    } catch (error) {
      onNotice(`重新输出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy('');
      setMergeProgress(current => ({ ...current, active: false, phase: 'complete' }));
    }
  };

  const remergeAllPhotos = async () => {
    if (busy || !mergedPhotos.length) return;
    if (!await appDialog.confirm({ title: `全部重新合并 ${mergedPhotos.length} 张照片？`, message: '会使用已保存的返图重新合并所有照片，并在当前保存位置为每张照片生成新的文件和版本。', detail: '旧输出记录不会被复用；请确认当前选择的保存位置正确。', confirmLabel: '全部重新合并' })) return;
    setBusy('remerge-all');
    setMergeProgress({ active: true, phase: 'preparing', total: mergedPhotos.length, completed: 0, succeeded: 0, failed: 0 });
    try {
      const target = await outputProgress.ensureTargetProgress(workspace.workflowNode?.id);
      setMergeProgress(current => ({ ...current, phase: 'merging' }));
      let succeededCount = 0;
      let cursor = 0;
      const worker = async () => {
        while (cursor < mergedPhotos.length) {
          const photo = mergedPhotos[cursor++];
          let succeeded = false;
          try {
            const result = await legacyApi.mergeTeamPatches(workspacePath, project.status, project.name, {
              photoId: photo.photoId,
              baseVersionId: photo.baseVersionId,
              outputProgressId: target.id,
              versionName: '团片协作合成（重新输出）',
              rebuildToken: crypto.randomUUID(),
            });
            succeeded = Boolean(result.success);
            if (succeeded) succeededCount += 1;
          } finally {
            setMergeProgress(current => ({ ...current, completed: current.completed + 1, succeeded: current.succeeded + (succeeded ? 1 : 0), failed: current.failed + (succeeded ? 0 : 1) }));
          }
        }
      };
      await worker();
      await load(false);
      onNotice(`已重新合并 ${succeededCount}/${mergedPhotos.length} 张照片`, succeededCount === mergedPhotos.length ? 'success' : 'warning');
    } catch (error) {
      onNotice(`全部重新合并失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy('');
      setMergeProgress(current => ({ ...current, active: false, phase: 'complete' }));
    }
  };

  const mergeReport = mergeAudit({ ...workspace, pendingReturnReviewCount: pendingWorkflowReturnReviewCount });
  const relayGroups = new Map<string, WorkflowItem[]>();
  for (const item of workflow) {
    const key = `${item.photo.photoId}:${item.task.id}`;
    const group = relayGroups.get(key) || [];
    group.push(item); relayGroups.set(key, group);
  }
  const relayChains = [...relayGroups.entries()].map(([key, items]) => ({ key, items, nodes: relayChainForItems(items) }));
  const currentStageSummaries = workflowStageSummaries(workspace, activeStep);
  const nextStep = activeStep === 'assignment' ? 'relay' : activeStep === 'relay' ? 'review' : undefined;
  const nextStage = nextStep ? WORKFLOW_STAGES.find(stage => stage.id === nextStep) : undefined;
  const nextBlockedReason = nextStep ? currentStageSummaries.find(stage => stage.id === nextStep)?.blockedReason : undefined;
  const assignmentSequence = <section data-assignment-sequence className={`mx-auto w-full max-w-3xl rounded-2xl border bg-white p-6 shadow-sm ${workspace.workflowNeedsRegeneration ? 'border-amber-200' : workflowReady ? 'border-emerald-200' : 'border-slate-200'}`}>
    <header className="flex items-start gap-4 border-b border-slate-100 pb-5"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold text-slate-800">{workflowReady ? '已生成的人物顺序' : workspace.workflowNeedsRegeneration ? '已调整的人物顺序' : '设置人物工作周顺序'}</h3>{workflowReady && <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">已完成</span>}{workspace.workflowNeedsRegeneration && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700">待重新生成</span>}</div><p className="mt-1 text-xs leading-5 text-slate-500">每周独占一行；拖动人物可调整顺序，拖到另一周的人物卡上即可归入该周。本页不展示具体修图裁片。</p></div><button type="button" disabled={workflowOrderLocked || Boolean(busy)} onClick={() => void savePreferredIdentityOrder([], [], '已恢复自动排序。请重新生成协作流程。')} className="dialog-secondary shrink-0">恢复自动排序</button></header>
    {workflowIdentityWeeks.length ? <div data-workflow-week-list>{workflowIdentityWeeks.map(group => <section key={group.week} data-workflow-week-row><header data-workflow-week-label><strong className="text-xs font-black">{workflowWeekLabel(group.week)}</strong><span className="mt-1 text-[10px] text-slate-400">{group.entries.length} 人</span></header><div data-workflow-week-people>{group.entries.map(entry => { const identity = entry.identity; const index = workflowIdentitySequence.findIndex(candidate => candidate.identity.id === identity.id); return <article key={identity.id} data-workflow-identity-id={identity.id} className={`flex items-center gap-3 rounded-xl border bg-white p-3 transition ${draggedWorkflowIdentityId === identity.id ? 'opacity-45' : ''} ${workflowDragTargetId === identity.id ? 'border-violet-400 ring-2 ring-violet-200' : 'border-slate-200'}`}><button type="button" disabled={workflowOrderLocked || Boolean(busy)} aria-label={`拖动调整“${identity.name}”的工作周顺序`} title="按住拖到目标人物前；也可用方向键调整" onPointerDown={event => startWorkflowIdentityPointerDrag(event, identity.id)} onPointerMove={moveWorkflowIdentityPointerDrag} onPointerUp={event => finishWorkflowIdentityPointerDrag(event)} onPointerCancel={event => finishWorkflowIdentityPointerDrag(event, true)} onKeyDown={event => moveWorkflowIdentityWithKeyboard(event, identity.id, index)} className="touch-none select-none rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-violet-700 disabled:cursor-default disabled:opacity-40 enabled:cursor-grab enabled:active:cursor-grabbing"><GripVertical size={18}/></button><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-50 text-xs font-black text-violet-700">{index + 1}</span><span className="h-3 w-3 shrink-0 rounded-full" style={{ background: identity.color }}/><strong className="min-w-0 flex-1 truncate text-sm text-slate-800">{identity.name}</strong></article>; })}</div></section>)}</div> : <div className="mt-6 rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">没有可排序的人物，请先完成人物标记。</div>}
    {workflowOrderLocked && <p className="mt-5 text-center text-xs font-bold text-amber-700">已有任务返图或完成，人物顺序已锁定。</p>}
  </section>;

  return <div className="team-shell pf-canvas fixed inset-x-0 bottom-0 top-10 z-[315] flex flex-col">
    <TeamWorkflowHeader activeStep={activeStep} onStepChange={onStepChange} stageSummaries={currentStageSummaries} onBlockedStage={onBlockedStage}/>
    {!loading && Boolean(workspace.photos.length) && <>
      <div className="team-toolbar pf-toolbar flex min-h-14 flex-wrap items-center gap-3 px-5 py-2.5">
        <span className="text-xs font-bold text-slate-700">{activeStep === 'assignment' ? '任务分配' : activeStep === 'relay' ? '接力进度' : '审核输出'}</span>{activeStep !== 'assignment' && <><span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-bold text-violet-700">{weeks.length} 周</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{personWeekCount} 个批次</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{splitIdentityCount} 人跨周</span>{Boolean(workspace.missingReturnCount) && <span title="返图文件已被外部删除或移动；恢复原路径后会自动重新连接" className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-bold text-red-700">返图缺失 {workspace.missingReturnCount}</span>}</>}{historyIssue && <button type="button" className="dialog-secondary text-amber-700" title={historyIssue} onClick={onRetryHistory}>历史恢复需重试</button>}
        {workflowGenerating && workflowGeneration && <><span role="status" aria-live="polite" className="max-w-72 truncate text-xs font-bold text-blue-700" title={`${workflowGeneration.message} · ${workflowGeneration.currentName}`}>{workflowGeneration.message} · {Math.round(workflowGeneration.progress)}% · {workflowGeneration.completedFiles}/{workflowGeneration.totalFiles || '—'} 张</span><button type="button" disabled={workflowGeneration.phase === 'cancelling'} onClick={() => void cancelWorkflowGeneration()} className="dialog-secondary text-blue-700">{workflowGeneration.phase === 'cancelling' ? '正在停止…' : '停止生成'}</button></>}
        {workflowReturnProgress?.active && <span role="status" aria-live="polite" data-workflow-return-progress data-phase={workflowReturnProgress.phase} className="max-w-72 truncate text-xs font-bold text-emerald-700" title={workflowReturnProgress.message}>{workflowReturnProgress.message} · {Math.round(workflowReturnProgress.progress)}%</span>}
        {activeStep === 'assignment' && <><span className={`text-xs ${workspace.workflowNeedsRegeneration ? 'font-bold text-amber-600' : workflowReady ? 'font-bold text-emerald-700' : 'text-slate-500'}`}>{workspace.workflowNeedsRegeneration ? '人物顺序已调整 · 待重新生成' : workflowReady ? '已生成最终人物顺序' : '拖拽人物调整顺序和所在周'}</span><button disabled={!workflowGroups.size || Boolean(busy) || workflowGenerating} onClick={() => void generateWorkflow()} className="dialog-primary ml-auto inline-flex items-center gap-2">{workflowGenerating ? <Loader2 size={15} className="animate-spin"/> : <FolderOutput size={15}/>} {workflowGenerating ? `生成中 ${Math.round(workflowGeneration.progress)}%` : workspace.workflowGenerated ? '按当前顺序重新生成' : '按当前顺序生成任务'}</button></>}
        {activeStep === 'relay' && <><span className="text-xs text-slate-500">可分发 {readyWorkflowItems.length} · 当前审核 {pendingWorkflowReturnReviewCount}</span>{workflowReturnResult?.reviewSessionId && !workflowReturnReviewOpen && <button disabled={Boolean(busy)} onClick={() => setWorkflowReturnReviewOpen(true)} className="dialog-secondary ml-auto inline-flex items-center gap-2"><CheckCircle2 size={15}/>恢复返图批次（{pendingWorkflowReturnReviewCount}）</button>}<button disabled={!workflowReady || !readyWorkflowItems.length || Boolean(busy) || Boolean(workflowReturnResult?.reviewSessionId)} title={workflowReturnResult?.reviewSessionId ? '请先恢复或放弃当前返图批次' : undefined} onClick={() => void receiveWorkflowBatch(readyWorkflowItems)} className="dialog-primary ml-auto inline-flex items-center gap-2">{busy === 'workflow-return' ? <Loader2 size={15} className="animate-spin"/> : <Upload size={15}/>}批量导入返图</button></>}
        {activeStep === 'review' && <><span className="text-xs text-slate-500">{mergeReport.blockers.length} 项阻断 · {mergeReport.completedPhotoCount}/{mergeReport.photoCount} 已输出</span>{workflowReturnResult?.reviewSessionId && <button disabled={Boolean(busy)} onClick={() => setWorkflowReturnReviewOpen(true)} className="dialog-secondary ml-auto inline-flex items-center gap-2"><CheckCircle2 size={15}/>继续返图审核（{pendingWorkflowReturnReviewCount}）</button>}</>}
       </div>
     </>}
    {mergeProgress.active && <div role="status" aria-live="polite" data-merge-progress data-phase={mergeProgress.phase} className="flex min-h-11 items-center gap-3 border-b border-blue-100 bg-blue-50 px-5 py-2 text-xs text-blue-800"><Loader2 size={15} className="shrink-0 animate-spin"/><span className="shrink-0 font-bold">{mergeProgress.phase === 'preparing' ? '正在准备合并目标…' : `正在合并 ${mergeProgress.completed}/${mergeProgress.total} 张`}</span><div className="h-2 min-w-24 flex-1 overflow-hidden rounded-full bg-blue-100" aria-hidden><span className="block h-full rounded-full bg-blue-600 transition-[width] duration-300" style={{ width: `${mergeProgress.total ? Math.round(mergeProgress.completed / mergeProgress.total * 100) : 0}%` }}/></div><span className="shrink-0 font-medium">成功 {mergeProgress.succeeded} · 失败 {mergeProgress.failed}</span></div>}
    {!!pendingResources.size && <div role="status" aria-live="polite" className="border-b border-emerald-100 bg-emerald-50 px-5 py-2 text-xs font-bold text-emerald-700">正在安全保存 {pendingResources.size} 个任务；其他照片仍可操作</div>}
    {loading ? <div className="flex flex-1 items-center justify-center text-sm text-slate-500"><Loader2 className="mr-2 animate-spin"/>正在读取团片历史人物…</div> : workspaceLoadError ? <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"><AlertTriangle size={28} className="text-red-500"/><h3 className="font-bold text-red-700">团片历史人物读取失败</h3><p className="max-w-2xl text-xs leading-5 text-slate-500">{workspaceLoadError}</p><button type="button" className="dialog-primary" onClick={() => void load(true)}>重新读取团片历史</button></div> : !workspace.photos.length ? <div className="flex flex-1 flex-col items-center justify-center text-center"><UsersRound size={42} className="text-slate-300"/><h3 className="mt-4 font-bold text-slate-700">尚未识别人物</h3><p className="mt-2 text-sm text-slate-500">请先加入图片并识别人物。</p><button onClick={() => onStepChange('detect')} className="dialog-primary mt-5">返回人物识别</button></div> : <main ref={peopleScrollRef} className="min-h-0 flex-1 overflow-y-auto p-6"><div className="mx-auto min-h-full max-w-[1800px]"><div className="workflow-board-view">
      {activeStep === 'review' && <MergeReviewSurface workspace={workspace} subjects={subjects} mergeablePhotos={mergeablePhotos} mergeReport={mergeReport} cacheConfig={cacheConfig} componentActive={componentActive} outputProgress={outputProgress} outputProgressDisabled={Boolean(busy)} mergeActionLabel={mergeActionLabel} mergeActionDisabled={Boolean(busy) || (allPhotosMergedOnce ? !mergedPhotos.length : !mergeablePhotos.length || mergeReport.blockers.some(item => item.code !== 'incomplete-task'))} mergeActionBusy={busy === 'merge-workflow' || busy === 'remerge-all'} reoutputingPhotoId={busy.startsWith('remerge:') ? busy.slice('remerge:'.length) : ''} onMergeAction={() => void (allPhotosMergedOnce ? remergeAllPhotos() : mergeCompletedPhotos())} onReoutput={photo => void reoutputPhoto(photo)}/>}
      {activeStep === 'assignment' ? assignmentSequence : activeStep === 'review' ? <div className="grid gap-5 lg:grid-cols-[minmax(280px,.7fr)_minmax(0,1.3fr)]" data-merge-audit><section className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="font-bold text-slate-800">合并前阻断清单</h3><p className="mt-1 text-xs text-slate-500">阻断归零后才能输出；未知证据仍需人工核对。</p><div className="mt-4 space-y-2">{mergeReport.blockers.length ? mergeReport.blockers.map(item => <div key={item.code} className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800"><span>{item.label}</span><span>{item.count}</span></div>) : <div className="rounded-lg bg-emerald-50 px-3 py-3 text-xs font-bold text-emerald-700">没有阻断项，可以合并</div>}</div></section><section className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="font-bold text-slate-800">质量指标与目标进度</h3><div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">任务匹配</p><p className="mt-1 font-bold text-slate-800">{workspace.qualityMetrics?.taskMatchRate === undefined ? '未知 · 需核对' : `${Math.round(workspace.qualityMetrics.taskMatchRate * 100)}%`}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">修改有效性</p><p className="mt-1 font-bold text-slate-800">{workspace.qualityMetrics?.effectiveEditRate === undefined ? '未知 · 需核对' : `${Math.round(workspace.qualityMetrics.effectiveEditRate * 100)}%`}</p></div><div className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-500">逐图结果</p><p className="mt-1 font-bold text-slate-800">{mergeablePhotos.length} 待合并 · {mergeReport.completedPhotoCount} 已输出</p></div></div><div className="mt-5 space-y-2">{workspace.photos.map(photo => { const tasks = photo.tasks || []; const mergedCount = tasks.filter(task => task.status === 'merged').length; return <div key={`${photo.photoId}:${photo.baseVersionId}`} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-xs"><span className="truncate font-bold text-slate-700">{photo.name || photo.displayName || photo.photoId}</span><span className={mergedCount === tasks.length && tasks.length ? 'text-emerald-700' : 'text-slate-500'}>{mergedCount === tasks.length && tasks.length ? '已输出' : `${tasks.filter(task => Boolean(task.editedPatchPath)).length}/${tasks.length} 返图就绪`}</span></div>; })}</div></section></div> : <>{activeStep === 'relay' && <section className="mb-5 overflow-hidden rounded-xl border border-slate-200 bg-white" data-relay-chains><button type="button" aria-expanded={relayChainsOpen} onClick={() => setRelayChainsOpen(current => !current)} className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-slate-50"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-bold text-slate-800">接力链（{relayChains.length}）</h3><span className="text-xs text-slate-500">原始裁图 → 前一位返图 → 下一位</span></div><p className="mt-1 text-[11px] text-slate-400">{relayChainsOpen ? '点击收起接力关系' : '点击展开，查看当前持有人和等待原因'}</p></div><ChevronDown size={17} className={`shrink-0 text-slate-400 transition-transform ${relayChainsOpen ? 'rotate-180' : ''}`}/></button>{relayChainsOpen && <div className="grid gap-3 border-t border-slate-100 p-4 xl:grid-cols-2">{relayChains.map(chain => <article key={chain.key} className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="mb-2 truncate text-xs font-bold text-slate-700">{chain.items[0]?.photo.name} · 工作图 {chain.items[0]?.task.taskOrder || chain.items[0]?.task.id}</p><ol className="flex min-w-0 items-stretch gap-1 overflow-x-auto" aria-label="修图接力链">{chain.nodes.map((node, index) => <li key={node.key} className="flex shrink-0 items-center gap-1">{index > 0 && <span aria-hidden className="text-slate-300">→</span>}<div className={`min-w-28 rounded-md border px-2.5 py-2 text-[11px] ${node.state === 'current' ? 'border-blue-300 bg-blue-50 text-blue-800' : node.state === 'warning' ? 'border-red-300 bg-red-50 text-red-700' : node.state === 'done' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-500'}`}><strong className="block truncate">{node.label}</strong><span className="mt-0.5 block truncate">{node.reason || (node.state === 'done' ? '已就绪' : '等待')}</span></div></li>)}</ol></article>)}</div>}</section>}
      {tab === 'people' ? <><div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4"><div className="min-w-0 flex-1"><h3 className="text-sm font-bold text-blue-800">自动分组已默认采用</h3><p className="mt-1 text-xs leading-5 text-blue-700">系统会结合人脸和外观分组；只需在发现识别错误时点击缩略图修改。</p></div>{subjects.length > subjectPageSize && <button onClick={() => setSubjectPageSize(current => current + 18)} className="dialog-secondary" aria-label="加载更多人物实例">再加载 18 张</button>}<button disabled={Boolean(busy)} onClick={() => void suggest()} className="dialog-primary inline-flex items-center gap-2">{busy === 'suggest' ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>}自动识别同一个人</button><button onClick={() => void createIdentity()} className="dialog-secondary">新建人物</button></div>
        <div className="space-y-5">{[...workspace.identities, { id: '__unassigned__', name: '未标注人物', color: '#64748b', createdAt: 0, updatedAt: 0 }].map(identity => { const items = grouped.get(identity.id) || []; if (!items.length && identity.id === '__unassigned__') return null; const visibleItems = items.slice(0, subjectPageSize); return <section key={identity.id} className="team-card pf-card overflow-hidden"><header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3"><span className="h-3 w-3 rounded-full" style={{ background: identity.color }}/>{identity.id === '__unassigned__' ? <h3 className="font-bold text-slate-700">未标注人物</h3> : <input defaultValue={identity.name} onBlur={event => void renameIdentity(identity, event.target.value)} className="min-w-40 rounded border border-transparent px-1 py-1 font-bold text-slate-800 hover:border-slate-200 focus:border-blue-400 focus:outline-none"/>}<span className="text-xs text-slate-400">{items.length} 张人物实例 · {new Set(items.map(item => item.photo.photoId)).size} 张照片{items.length > visibleItems.length ? ` · 当前显示 ${visibleItems.length} 张` : ''}</span>{identity.id !== '__unassigned__' && <button onClick={() => void removeIdentity(identity)} title="删除人物身份" className="ml-auto rounded p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={15}/></button>}</header><div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">{visibleItems.map(subject => <div key={subject.key} data-team-person-key={subject.key} className="space-y-2"><SubjectThumb active={componentActive} subject={subject} cacheConfig={cacheConfig}/><select value={subject.identity?.id || ''} onChange={event => void assign(subject, event.target.value)} className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"><option value="">未标注</option>{workspace.identities.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select>{subject.assignment?.source === 'suggested' && <p className="text-[10px] text-blue-600">自动采用 · {Math.round(subject.assignment.confidence * 100)}% · 识别错误可修改</p>}</div>)}</div></section>; })}</div></> : <>{!workspace.identities.length ? <div className="team-card pf-card border-dashed p-10 text-center text-sm text-slate-500">请先在“标记人物”中分配身份。</div> : <div className="space-y-7">{weeks.map(week => <section key={week}><h3 className="mb-3 text-sm font-bold text-slate-700">第 {week} 周</h3><div className="space-y-4">{[...workflowGroups.values()].filter(group => group.week === week).map(group => {
          const pending = group.items.filter(item => !item.assignment?.completed);
          const ready = workflowReady ? pending.filter(item => item.ready) : [];
          return <article key={`${week}:${group.identity.id}`} className="workflow-person-lane team-card pf-card overflow-hidden"><header className="workflow-person-summary flex items-center gap-3 border-b border-slate-100 p-4"><span className="h-3 w-3 shrink-0 rounded-full" style={{ background: group.identity.color }}/><div className="min-w-0"><h4 className="truncate font-bold text-slate-800">{group.identity.name}</h4><p className="mt-1 text-xs leading-5 text-slate-400">本周 {group.items.length} 张<br/>可分发 {ready.length} 张 · 已完成 {group.items.length - pending.length} 张</p></div>{activeStep === 'relay' && <><button disabled={!workflowReady || Boolean(busy) || !ready.length} onClick={() => void markWeekNoRetouch(group.identity, week, group.items)} title={workspace.workflowNeedsRegeneration ? '排期已调整，请先重新生成协作流程' : `将“${group.identity.name}”本周当前可分发的 ${ready.length} 个未上传任务标记为不用修`} className="dialog-secondary ml-auto inline-flex shrink-0 items-center gap-2">{busy === `skip:${week}:${group.identity.id}` ? <Loader2 size={14} className="animate-spin"/> : <CheckCircle2 size={14}/>}标记本周不用修</button><button disabled={!workflowReady || Boolean(busy) || !ready.length} title={!workspace.workflowGenerated ? '请先生成协作流程' : workspace.workflowNeedsRegeneration ? '排期已调整，请先重新生成协作流程' : !ready.length ? '等待上一位返图' : '打开当前可分发任务文件夹'} onClick={() => void openTaskFolder(group.identity, week)} className="dialog-secondary inline-flex shrink-0 items-center gap-2">{busy === `open:${week}:${group.identity.id}` ? <Loader2 size={14} className="animate-spin"/> : <FolderOutput size={14}/>}打开任务文件夹</button></>}</header><div className="workflow-task-strip">{group.items.map(item => { const returnMissing = Boolean(item.assignment?.returnMissing); const returned = item.assignment?.completionKind === 'returned' && Boolean(item.assignment.editedPatchPath) && !returnMissing; return <div key={item.key} className="workflow-task-card p-3"><div className="workflow-task-thumbnail shrink-0"><SubjectThumb active={componentActive} subject={item} cacheConfig={cacheConfig} sourcePath={item.workflowImagePath} interactive={!item.assignment?.completed}/></div><div className="min-w-0"><p className="truncate text-sm font-bold text-slate-700">{item.photo.name} · 人物 {item.personIndex}</p><p className={`mt-1 truncate text-xs ${workspace.workflowNeedsRegeneration ? 'font-bold text-amber-600' : returnMissing ? 'font-bold text-red-600' : item.assignment?.completed ? 'text-emerald-600' : item.ready ? 'text-blue-600' : 'text-amber-600'}`} title={workspace.workflowNeedsRegeneration ? '排期已调整，请重新生成协作流程' : returnMissing ? '返图文件已被外部删除或移动；恢复原路径后会自动重新连接，也可以重新上传' : item.blockedBy.join('、')}>{workspace.workflowNeedsRegeneration ? '排期已调整，等待重新生成' : returnMissing ? '返图文件丢失' : item.assignment?.completed ? returned ? '已返图' : '不用修' : item.ready ? '可以分发' : `等待 ${item.blockedBy.join('、')} 完成`}</p></div>{activeStep === 'relay' && <><button disabled={!workflowReady || !item.ready || Boolean(busy)} onClick={() => void upload(item)} className="workflow-task-action dialog-secondary inline-flex items-center justify-center">{busy === `upload:${item.key}` ? <Loader2 size={12} className="animate-spin"/> : <Upload size={12}/>}上传返图</button><button disabled={!workflowReady || !item.assignment || Boolean(busy) || !item.ready && !item.assignment.completed} onClick={() => void (item.assignment?.completed && returned ? removeUpload(item) : toggleComplete(item))} title={workspace.workflowNeedsRegeneration ? '排期已调整，请先重新生成协作流程' : returnMissing ? '返图文件已丢失；可以重新上传，或明确标记为不用修' : item.assignment?.completed ? returned ? '删除返图并撤销完成标记' : '撤销不用修' : '该任务不用修，直接标记完成'} className={`workflow-task-action group inline-flex items-center justify-center rounded-md border font-bold transition ${returnMissing ? 'border-red-200 bg-red-50 text-red-700' : item.assignment?.completed ? returned ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-red-200 hover:bg-red-50 hover:text-red-600' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700' : 'border-slate-200 text-slate-600'}`}>{busy === `complete:${item.key}` || busy === `remove-upload:${item.key}` ? <Loader2 size={12} className="animate-spin"/> : item.assignment?.completed ? <><CheckCircle2 size={12} className="group-hover:hidden"/>{returned ? <Trash2 size={12} className="hidden group-hover:block"/> : <X size={12} className="hidden group-hover:block"/>}</> : <AlertTriangle size={12}/>} {item.assignment?.completed ? <><span className="group-hover:hidden">{returned ? '已返图' : '不用修'}</span><span className="hidden group-hover:inline">{returned ? '删除返图' : '撤销不用修'}</span></> : returnMissing ? '返图丢失' : '不用修'}</button></>}</div>; })}</div></article>;
        })}</div></section>)}</div>}</>}</>}{nextStep && <footer className="team-next-step mt-6 flex justify-center pt-5"><button type="button" disabled={Boolean(busy) || Boolean(nextBlockedReason)} onClick={() => onStepChange(nextStep)} className="dialog-primary inline-flex items-center gap-2" title={nextBlockedReason || `进入${nextStage?.label || '下一个任务'}`}>下一步：{nextStage?.label}<ArrowRight size={15}/></button></footer>}
    </div></div></main>}
    {workflowReturnResult && workflowReturnReviewOpen && createPortal(<WorkflowReturnReviewDialog componentActive={componentActive} result={workflowReturnResult} cacheConfig={cacheConfig} busy={busy} onClose={() => void requestCloseWorkflowReturnReview()} onConfirm={confirmWorkflowReturn} onIgnore={ignoreWorkflowReturn}/>, document.body)}
    {assigningSubject && <IdentityPickerPanel
      description="从已有身份中选择同一个人，或新建人物；本次只修改当前未完成任务。"
      badge="修改当前人物"
      currentPreview={<SubjectThumb active={componentActive} subject={assigningSubject} cacheConfig={cacheConfig} interactive={false}/>}
      currentName={assigningSubject.identity && !isGeneratedIdentity(assigningSubject.identity) ? assigningSubject.identity.name : '未标记'}
      currentStatus={`${assigningSubject.photo.name} · 人物 ${assigningSubject.personIndex}`}
      identities={pickerIdentities}
      selectedIdentityId={assigningSubject.identity?.id}
      identityCount={identity => (grouped.get(identity.id) || []).length}
      renderIdentityPreview={identity => {
        const examples = grouped.get(identity.id) || [];
        const representative = examples.find(item => item.key !== assigningSubject.key) || examples[0];
        return representative ? <SubjectThumb active={componentActive} subject={representative} cacheConfig={cacheConfig} interactive={false}/> : null;
      }}
      onSelect={identity => void assign(assigningSubject, identity.id)}
      onCreate={() => void createIdentityForSubject(assigningSubject)}
      onClear={() => void assign(assigningSubject, '')}
      onClose={() => setAssigningSubject(null)}
      busy={identityPickerBusy}
      selectionDescription="点击人物卡片后，只修改左侧当前人物的归属。"
    />}
  </div>;
};
