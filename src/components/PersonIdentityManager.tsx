import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderOutput, GripVertical, Loader2, Trash2, Upload, UserRound, UsersRound, Wand2, X } from 'lucide-react';
import type { AppConfig, TeamIdentity, TeamIdentityWorkspace, TeamPatchReturnBatchResult, TeamPatchTask, TeamPersonAssignment, TeamProjectPhoto, TeamWorkflowGenerationProgress, ThumbnailState, WorkspaceProject } from '../types';
import { scheduleWorkflowWeeks } from '../utils/teamWorkflow';
import { useAppDialog } from './AppDialogProvider';
import { TeamRetouchSteps, type TeamRetouchStep } from './TeamRetouchSteps';
import { TeamOutputProgressPicker } from './TeamRetouchOutputProgress';
import { useTeamOutputProgress } from './useTeamOutputProgress';

type Props = {
  workspacePath: string;
  project: WorkspaceProject;
  cacheConfig: AppConfig['mediaCache'];
  activeStep: Extract<TeamRetouchStep, 'people' | 'workflow'>;
  onStepChange: (step: TeamRetouchStep) => void;
  onClose: () => void;
  onNotice: (message: string) => void;
  onProjectChanged: () => void;
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
const formatWorkflowBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : 1)} MB`;

const IDENTITY_THUMBNAIL_SIZE = 384;
type IdentityThumbnailListener = (state: ThumbnailState, url?: string) => void;
const identityThumbnailListeners = new Map<string, Set<IdentityThumbnailListener>>();
const identityThumbnailRequests = new Map<string, ReturnType<typeof window.electronAPI.getMediaThumbnail>>();
const identityThumbnailUrls = new Map<string, string>();
let stopIdentityThumbnailUpdates: (() => void) | undefined;
const identityThumbnailKey = (filePath: string) => filePath.toLocaleLowerCase();
const subscribeIdentityThumbnail = (filePath: string, listener: IdentityThumbnailListener) => {
  const key = identityThumbnailKey(filePath);
  const listeners = identityThumbnailListeners.get(key) || new Set<IdentityThumbnailListener>();
  listeners.add(listener);
  identityThumbnailListeners.set(key, listeners);
  if (!stopIdentityThumbnailUpdates) {
    stopIdentityThumbnailUpdates = window.electronAPI.onThumbnailStateChanged(update => {
      const subscribers = identityThumbnailListeners.get(identityThumbnailKey(update.filePath));
      if (!subscribers) return;
      const url = update.previewUrls?.medium;
      for (const callback of subscribers) callback(update.state, url);
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) identityThumbnailListeners.delete(key);
    if (!identityThumbnailListeners.size) {
      stopIdentityThumbnailUpdates?.();
      stopIdentityThumbnailUpdates = undefined;
    }
  };
};

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

const SubjectThumb = memo(({ subject, cacheConfig, interactive = true }: { subject: Subject; cacheConfig: AppConfig['mediaCache']; interactive?: boolean }) => {
  const container = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(() => identityThumbnailUrls.get(identityThumbnailKey(subject.task.patchPath)) || '');
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl(identityThumbnailUrls.get(identityThumbnailKey(subject.task.patchPath)) || '');
    setLoadFailed(false);
    const unsubscribe = subscribeIdentityThumbnail(subject.task.patchPath, (state, nextUrl) => {
      if (!active) return;
      if (state === 'READY' && nextUrl) { identityThumbnailUrls.set(identityThumbnailKey(subject.task.patchPath), nextUrl); setUrl(nextUrl); }
      else if (state === 'FAILED' || state === 'MISSING') setLoadFailed(true);
    });
    const node = container.current;
    const observer = node ? new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer?.disconnect();
      const key = identityThumbnailKey(subject.task.patchPath);
      let request = identityThumbnailRequests.get(key);
      if (!request) {
        request = window.electronAPI.getMediaThumbnail(subject.task.patchPath, 'image', cacheConfig, IDENTITY_THUMBNAIL_SIZE, 1, 0);
        identityThumbnailRequests.set(key, request);
        void request.finally(() => identityThumbnailRequests.delete(key));
      }
      void request.then(result => {
        if (!active) return;
        if (result.previewUrl) { identityThumbnailUrls.set(key, result.previewUrl); setUrl(result.previewUrl); }
        else if (!result.success || result.state === 'FAILED' || result.state === 'MISSING') setLoadFailed(true);
      }).catch(() => { if (active) setLoadFailed(true); });
    }, { rootMargin: '320px' }) : null;
    if (node) observer?.observe(node);
    return () => { active = false; observer?.disconnect(); unsubscribe(); };
  }, [subject.task.patchPath, cacheConfig.directory, cacheConfig.maxSizeGB]);
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
  return <div ref={container} role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined} onClick={openVisualPicker} onKeyDown={event => { if (interactive && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openVisualPicker(); } }} title={interactive ? '点击看图修改人物归属' : undefined} className={`group relative aspect-[4/3] overflow-hidden rounded-lg bg-slate-950 ${interactive ? 'cursor-pointer ring-blue-400 transition hover:ring-2 focus:outline-none focus:ring-2' : ''}`}>
    {url ? <svg className="block h-full w-full overflow-hidden" overflow="hidden" viewBox={`${viewX} ${viewY} ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet"><image href={url} width={subject.task.crop.width} height={subject.task.crop.height}/><rect x={x} y={y} width={boxWidth} height={boxHeight} fill="none" stroke="#facc15" strokeWidth={Math.max(3, viewWidth / 180)}/></svg> : <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-500"><UserRound/>{loadFailed && <span className="px-2 text-center text-[10px] text-amber-400">预览读取失败，请重新识别生成工作图</span>}</div>}
    <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-2 py-1 text-[10px] font-bold text-white">{subject.photo.name} · 人物 {subject.personIndex}</span>
    {typeof subject.matchScore === 'number' && subject.matchScore >= 0 && <span className="absolute left-1.5 top-1.5 rounded bg-emerald-600/95 px-1.5 py-0.5 text-[9px] font-bold text-white">匹配度 {Math.round(subject.matchScore * 100)}% · {subject.matchEvidence === 'face+body' ? '脸+外观' : '外观辅助'}</span>}
    {interactive && <span className="absolute right-1.5 top-1.5 rounded bg-blue-600/90 px-1.5 py-0.5 text-[9px] font-bold text-white opacity-0 transition group-hover:opacity-100">看图改归属</span>}
  </div>;
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
    && previous.interactive === next.interactive;
});

type WorkflowItem = Subject & { week: number; ready: boolean; blockedBy: string[] };

const buildWorkflow = (subjects: Subject[], identities: TeamIdentity[], preferredIdentityOrder: string[] = []) => {
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
  })), { preferredIdentityOrder });
  const items: WorkflowItem[] = [];
  for (const members of byTask.values()) {
    const ordered = [...members].sort((left, right) => (scheduledWeeks.get(left.key) || 1) - (scheduledWeeks.get(right.key) || 1) || orderOf(left) - orderOf(right) || left.personIndex - right.personIndex);
    ordered.forEach((subject, index) => {
      const predecessors = ordered.slice(0, index);
      const blockedBy = [...new Set(predecessors
        .filter(item => !item.assignment?.completed)
        .map(item => item.identity?.name || `人物 ${item.personIndex}`))];
      items.push({ ...subject, week: scheduledWeeks.get(subject.key) || 1, ready: blockedBy.length === 0, blockedBy });
    });
  }
  return items.sort((left, right) => left.week - right.week || orderOf(left) - orderOf(right) || left.photo.name.localeCompare(right.photo.name));
};

export const PersonIdentityManager = ({ workspacePath, project, cacheConfig, activeStep, onStepChange, onClose, onNotice, onProjectChanged }: Props) => {
  const appDialog = useAppDialog();
  const [workspace, setWorkspace] = useState<TeamIdentityWorkspace>({ success: true, photos: [], identities: [], assignments: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const tab = activeStep;
  const [assigningSubject, setAssigningSubject] = useState<Subject | null>(null);
  const [workflowReturnResult, setWorkflowReturnResult] = useState<TeamPatchReturnBatchResult | null>(null);
  const [workflowReturnProgress, setWorkflowReturnProgress] = useState({ progress: 0, message: '' });
  const [workflowGeneration, setWorkflowGeneration] = useState<TeamWorkflowGenerationProgress | null>(null);
  const [similarities, setSimilarities] = useState<NonNullable<TeamIdentityWorkspace['similarities']>>([]);
  const [showAllSubjects, setShowAllSubjects] = useState(false);
  const [draggedWorkflowIdentityId, setDraggedWorkflowIdentityId] = useState('');
  const peopleScrollRef = useRef<HTMLElement>(null);
  const pendingPeopleScrollAnchorRef = useRef<{ key: string; top: number; scrollTop: number } | null>(null);
  const load = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    const result = await window.electronAPI.getTeamProjectWorkspace(workspacePath, project.name);
    if (showLoading) setLoading(false);
    if (!result.success) { onNotice(`读取人物识别失败：${result.error || '未知错误'}`); return; }
    setWorkspace(result);
  };
  useEffect(() => { void load(true); }, [workspacePath, project.name]);
  useEffect(() => window.electronAPI.onTeamPatchReturnBatchProgress(value => {
    setWorkflowReturnProgress({ progress: value.progress, message: value.message });
  }), []);
  useEffect(() => {
    let active = true;
    const unsubscribe = window.electronAPI.onTeamWorkflowGenerationProgress(value => {
      if (value.projectName === project.name) setWorkflowGeneration(value);
    });
    void window.electronAPI.getTeamWorkflowGenerationStatus(workspacePath, project.status, project.name).then(result => {
      if (active && result.success && result.job) setWorkflowGeneration(result.job);
    });
    return () => { active = false; unsubscribe(); };
  }, [workspacePath, project.status, project.name]);
  const subjects = useMemo(() => subjectsFromWorkspace(workspace), [workspace]);
  const similarityByPair = useMemo(() => new Map(similarities.map(item => [similarityPairKey(item.leftKey, item.rightKey), item])), [similarities]);
  const similarityFor = (left: string, right: string) => similarityByPair.get(similarityPairKey(left, right));
  useEffect(() => {
    const handlePick = async (event: Event) => {
      if (tab !== 'people') return;
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      const subject = subjects.find(item => item.key === key);
      if (subject) {
        if (!similarities.length) {
          const result = await window.electronAPI.getTeamIdentitySimilarities(workspacePath, project.name);
          if (result.success) setSimilarities(result.similarities);
        }
        setAssigningSubject(subject);
      }
    };
    window.addEventListener('photoflow-team-person-pick', handlePick);
    return () => window.removeEventListener('photoflow-team-person-pick', handlePick);
  }, [subjects, tab, similarities, workspacePath, project.name]);
  const workflowIdentityOptions = useMemo(() => workspace.identities.filter(identity => subjects.some(subject => subject.identity?.id === identity.id)), [subjects, workspace.identities]);
  const preferredIdentityOrder = useMemo(() => {
    const storedOrder = workspace.workflowSettings?.preferredIdentityOrder?.length
      ? workspace.workflowSettings.preferredIdentityOrder
      : workspace.workflowSettings?.preferredIdentityId ? [workspace.workflowSettings.preferredIdentityId] : [];
    const availableIds = new Set(workflowIdentityOptions.map(identity => identity.id));
    return [...new Set(storedOrder)].filter(identityId => availableIds.has(identityId));
  }, [workflowIdentityOptions, workspace.workflowSettings]);
  const workflow = useMemo(() => buildWorkflow(subjects.filter(subject => !subject.task.needsReview), workspace.identities, preferredIdentityOrder), [subjects, workspace.identities, preferredIdentityOrder]);
  const preferredWorkflowIdentities = preferredIdentityOrder.map(identityId => workflowIdentityOptions.find(identity => identity.id === identityId)).filter((identity): identity is TeamIdentity => Boolean(identity));
  const availableWorkflowIdentities = workflowIdentityOptions.filter(identity => !preferredIdentityOrder.includes(identity.id));
  const workflowOrderLocked = workspace.assignments.some(assignment => assignment.completed)
    || workspace.photos.some(photo => photo.tasks.some(task => Boolean(task.editedPatchPath) || !['', 'exported'].includes(String(task.status || 'exported'))));
  const outputProgress = useTeamOutputProgress(workspace.photos[0]?.sourcePath || '', workspacePath, project, onNotice);
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
    if (!assigningSubject) return workspace.identities;
    const bestScoreByIdentity = new Map<string, number>();
    for (const subject of subjects) {
      if (!subject.identity || subject.key === assigningSubject.key) continue;
      const score = similarityByPair.get(similarityPairKey(assigningSubject.key, subject.key))?.score ?? -1;
      bestScoreByIdentity.set(subject.identity.id, Math.max(bestScoreByIdentity.get(subject.identity.id) ?? -1, score));
    }
    // Similar identities are ordered only inside the picker. Reordering the
    // workspace identities made every section on the page move twice per mark.
    return [...workspace.identities].sort((left, right) =>
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
    setBusy('suggest');
    const result = await window.electronAPI.suggestTeamIdentities(workspacePath, project.name);
    setBusy('');
    if (!result.success) { onNotice(`自动人物分组失败：${result.error || '未知错误'}`); return; }
    setSimilarities([]);
    setWorkspace({ ...result, similarities: undefined, workflowSettings: workspace.workflowSettings });
    onProjectChanged();
    const engine = result.faceBackend?.startsWith('adaface') ? 'AdaFace 实验模型' : 'SFace';
    onNotice(`已生成 ${result.candidateGroupCount || 0} 个跨图候选组；${result.unmatchedCount || 0} 个人物因证据不足保持未标注 · ${engine}`);
  };
  const createIdentity = async () => {
    const answer = await appDialog.prompt({ title: '新建人物身份', message: '填写姓名或便于团队识别的称呼。', defaultValue: `人物 ${workspace.identities.length + 1}`, confirmLabel: '新建' });
    if (!answer?.trim()) return;
    const result = await window.electronAPI.saveTeamIdentity(workspacePath, { projectName: project.name, name: answer.trim() });
    if (!result.success) onNotice(`新建人物失败：${result.error || '未知错误'}`); else void load(false);
  };
  const renameIdentity = async (identity: TeamIdentity, name: string) => {
    if (!name.trim() || name.trim() === identity.name) return;
    const result = await window.electronAPI.saveTeamIdentity(workspacePath, { projectName: project.name, identityId: identity.id, name: name.trim() });
    if (!result.success) onNotice(`保存姓名失败：${result.error || '未知错误'}`); else void load(false);
  };
  const assign = async (subject: Subject, identityId: string) => {
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
    const reopenPickerOnFailure = assigningSubject?.key === subject.key;
    preservePeopleScrollPosition(subject.key);
    setWorkspace(current => replaceAssignment(current, optimisticAssignment));
    setAssigningSubject(null);
    const result = await window.electronAPI.assignTeamIdentity(workspacePath, { projectName: project.name, photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, personIndex: subject.personIndex, identityId: nextIdentityId, source: 'manual', confidence: 1, completed });
    if (!result.success) {
      preservePeopleScrollPosition(subject.key);
      setWorkspace(current => {
        const currentAssignment = current.assignments.find(item => assignmentKey(item.photoId, item.baseVersionId, item.personIndex) === subject.key);
        return currentAssignment?.updatedAt === updatedAt ? replaceAssignment(current, previousAssignment) : current;
      });
      if (reopenPickerOnFailure) setAssigningSubject(subject);
      onNotice(`标注人物失败：${result.error || '未知错误'}`);
    } else if (previousAssignment?.identityId && previousAssignment.identityId !== nextIdentityId) {
      preservePeopleScrollPosition(subject.key);
      setWorkspace(current => ({
        ...current,
        identities: current.identities.filter(identity => identity.id !== previousAssignment.identityId || !isGeneratedIdentity(identity) || current.assignments.some(item => item.identityId === identity.id)),
      }));
    }
  };
  const createIdentityForSubject = async (subject: Subject) => {
    const answer = await appDialog.prompt({ title: '把这张图标记为新人物', message: '填写姓名或便于团队识别的称呼。', defaultValue: `人物 ${workspace.identities.length + 1}`, confirmLabel: '新建并归入' });
    if (!answer?.trim()) return;
    const result = await window.electronAPI.saveTeamIdentity(workspacePath, { projectName: project.name, name: answer.trim(), assignments: [{ photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, personIndex: subject.personIndex, confidence: 1, source: 'manual' }] });
    if (!result.success) onNotice(`新建人物失败：${result.error || '未知错误'}`); else { setAssigningSubject(null); void load(false); }
  };
  const removeIdentity = async (identity: TeamIdentity) => {
    const answer = await appDialog.confirm({ title: `删除人物“${identity.name}”？`, message: '只删除身份与归属标记，不会删除照片或团片协作工作图。', confirmLabel: '删除', tone: 'danger' });
    if (!answer) return;
    const result = await window.electronAPI.deleteTeamIdentity(workspacePath, { projectName: project.name, identityId: identity.id });
    if (!result.success) onNotice(`删除人物失败：${result.error || '未知错误'}`); else void load(false);
  };
  const savePreferredIdentityOrder = async (identityOrder: string[], successMessage: string) => {
    if (workflowOrderLocked) {
      onNotice('已有任务返图或完成，开工顺序已锁定');
      return;
    }
    const nextOrder = [...new Set(identityOrder)].filter(identityId => workflowIdentityOptions.some(identity => identity.id === identityId));
    setBusy('workflow-settings');
    const result = await window.electronAPI.saveTeamWorkflowSettings(workspacePath, {
      projectName: project.name,
      preferredIdentityOrder: nextOrder,
    });
    setBusy('');
    if (!result.success) {
      onNotice(`保存开工顺序失败：${result.error || '未知错误'}`);
      return;
    }
    setWorkspace(current => ({
      ...current,
      workflowSettings: result.workflowSettings || { preferredIdentityOrder: nextOrder, preferredIdentityId: nextOrder[0] },
    }));
    onNotice(successMessage);
  };
  const addPreferredIdentity = async (identityId: string) => {
    if (!identityId || preferredIdentityOrder.includes(identityId)) return;
    const identityName = workflowIdentityOptions.find(identity => identity.id === identityId)?.name || '该人物';
    await savePreferredIdentityOrder([...preferredIdentityOrder, identityId], `已将“${identityName}”加入优先队列；如已生成工作流程，请重新生成`);
  };
  const removePreferredIdentity = async (identityId: string) => {
    const nextOrder = preferredIdentityOrder.filter(currentId => currentId !== identityId);
    await savePreferredIdentityOrder(nextOrder, nextOrder.length ? '已更新优先队列；如已生成工作流程，请重新生成' : '已恢复自动排期；如已生成工作流程，请重新生成');
  };
  const movePreferredIdentity = async (sourceIdentityId: string, targetIdentityId: string) => {
    if (!sourceIdentityId || sourceIdentityId === targetIdentityId) return;
    const sourceIndex = preferredIdentityOrder.indexOf(sourceIdentityId);
    const targetIndex = preferredIdentityOrder.indexOf(targetIdentityId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextOrder = [...preferredIdentityOrder];
    const [moved] = nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, moved);
    await savePreferredIdentityOrder(nextOrder, '已保存新的开工优先顺序；如已生成工作流程，请重新生成');
  };
  const toggleComplete = async (item: WorkflowItem) => {
    const completed = !item.assignment?.completed;
    const result = await window.electronAPI.completeTeamIdentity(workspacePath, { photoId: item.photo.photoId, baseVersionId: item.photo.baseVersionId, personIndex: item.personIndex, completed });
    if (!result.success) onNotice(`更新完成状态失败：${result.error || '未知错误'}`); else void load(false);
  };
  const upload = async (item: WorkflowItem) => {
    setBusy(`upload:${item.key}`);
    const result = await window.electronAPI.uploadTeamPatch(workspacePath, { photoId: item.photo.photoId, taskId: item.task.id, personIndex: item.personIndex, projectName: project.name, status: project.status });
    setBusy('');
    if (!result.success) onNotice(`上传返图失败：${result.error || '未知错误'}`); else if (!result.cancelled) { onNotice('返图已接收，可以标记这个人物已完成'); void load(false); }
  };
  const openTaskFolder = async (identity: TeamIdentity, week: number) => {
    setBusy(`open:${week}:${identity.id}`);
    const result = await window.electronAPI.exportTeamIdentityTasks(workspacePath, project.status, project.name, { week, identityId: identity.id });
    setBusy('');
    if (!result.success) onNotice(`打开任务文件夹失败：${result.error || '未知错误'}`); else if (result.path) void window.electronAPI.openTeamPatchFolder(result.path);
  };
  const receiveWorkflowBatch = async (items: WorkflowItem[]) => {
    setBusy('workflow-return');
    setWorkflowReturnResult(null);
    setWorkflowReturnProgress({ progress: 0, message: '请选择本轮收到的全部返图' });
    try {
      const selected = await window.electronAPI.selectTeamPatchReturns(project.name);
      if (!selected.success) throw new Error(selected.error || '无法选择返图');
      if (selected.cancelled || !selected.files?.length) { setBusy(''); return; }
      const result = await window.electronAPI.returnTeamWorkflowBatch(workspacePath, project.name, {
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
      setWorkflowReturnResult(result);
      setBusy('');
      if (!result.success) { onNotice(`工作流程批量返图失败：${result.error || '未知错误'}`); return; }
      await load(false);
      onProjectChanged();
      onNotice(`批量返图完成：自动识别并标记完成 ${result.acceptedCount || 0} 张，${result.reviewCount || 0} 张需要单独确认`);
    } catch (error) {
      setBusy('');
      onNotice(`工作流程批量返图失败：${error instanceof Error ? error.message : String(error)}`);
    }
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
  const readyWorkflowItems = workflow.filter(item => item.identity && item.ready && !item.assignment?.completed);
  const workflowGenerating = workflowGeneration?.state === 'running';
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
    const run = (replace = false) => {
      const operationId = crypto.randomUUID();
      setWorkflowGeneration({ operationId, projectName: project.name, state: 'running', phase: 'preparing', progress: 0, completedFiles: 0, totalFiles: 0, copiedBytes: 0, totalBytes: 0, currentName: '', message: '正在准备工作流程…' });
      return window.electronAPI.generateTeamWorkflow(workspacePath, project.status, project.name, { operationId, preferredIdentityOrder, groups, replace });
    };
    let result = await run();
    if (result.requiresConfirmation) {
      setWorkflowGeneration(null);
      const confirmed = await appDialog.confirm({
        title: '重新生成工作流程？',
        message: '项目“团片协作”文件夹中上一次生成的周次、角色目录及任务图片将被删除，然后按照当前人物标注和排期重新生成。',
        confirmLabel: '删除并重新生成',
        tone: 'danger',
      });
      if (!confirmed) return;
      result = await run(true);
    }
    if (result.alreadyRunning) return;
    if (!result.success) {
      if (result.cancelled) onNotice(result.resumable ? '已停止生成；下次会从现有进度继续' : '已停止生成工作流程');
      else onNotice(`生成工作流程失败：${result.error || '未知错误'}`);
      return;
    }
    onNotice(`工作流程已保存到项目“团片协作”文件夹：${result.groupCount || 0} 个角色批次，${result.count || 0} 张任务图`);
    onProjectChanged();
  };
  const cancelWorkflowGeneration = async () => {
    if (!workflowGeneration?.operationId || !workflowGenerating) return;
    setWorkflowGeneration(current => current ? { ...current, phase: 'cancelling', message: '正在安全停止…' } : current);
    const result = await window.electronAPI.cancelTeamWorkflowGeneration(workflowGeneration.operationId);
    if (!result.success) onNotice(`停止生成失败：${result.error || '未知错误'}`);
  };

  const mergeablePhotos = workspace.photos.filter(photo => {
    const photoSubjects = subjects.filter(subject => subject.photo.photoId === photo.photoId && subject.photo.baseVersionId === photo.baseVersionId);
    return photo.tasks.length > 0
      && photo.tasks.every(task => Boolean(task.editedPatchPath))
      && photo.tasks.some(task => task.status !== 'merged')
      && photoSubjects.length > 0
      && photoSubjects.every(subject => Boolean(subject.assignment?.completed));
  });
  const mergeCompletedPhotos = async () => {
    if (!mergeablePhotos.length) return;
    setBusy('merge-workflow');
    try {
      const target = await outputProgress.ensureTargetProgress();
      let merged = 0;
      for (const photo of mergeablePhotos) {
        const result = await window.electronAPI.mergeTeamPatches(workspacePath, project.status, project.name, {
          photoId: photo.photoId,
          baseVersionId: photo.baseVersionId,
          outputProgressId: target.id,
          versionName: '团片协作工作流程合成',
        });
        if (result.success) merged += 1;
      }
      await load(false);
      onProjectChanged();
      onNotice(`已将 ${merged}/${mergeablePhotos.length} 张全部完成的图片合成到目标进度`);
    } catch (error) {
      onNotice(`合成工作流程结果失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy('');
    }
  };

  return <div className="fixed inset-x-0 bottom-0 top-10 z-[315] flex flex-col bg-slate-50">
    <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3"><span className="rounded-xl bg-violet-50 p-2 text-violet-600"><UsersRound size={20}/></span><div><h2 className="font-bold text-slate-900">团片协作</h2><p className="mt-0.5 text-xs text-slate-500">先识别并裁图，再确认跨图片人物身份，最后生成和执行接力工作流程。</p></div><TeamRetouchSteps value={activeStep} onChange={onStepChange}/><button onClick={onClose} className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={20}/></button></header>
    {tab === 'workflow' && !loading && Boolean(workspace.photos.length) && <>
      <div className="flex min-h-14 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-2.5">
        <span className="text-xs font-bold text-slate-700">流程概览</span><span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-bold text-violet-700">{weeks.length} 周</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{personWeekCount} 个批次</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{splitIdentityCount} 人跨周</span><span className="text-xs text-slate-500">当前可接收 {readyWorkflowItems.length} 张返图</span>
        <label title={workflowOrderLocked ? '已有任务返图或完成，开工顺序已锁定' : '加入多个人物后，可在下方拖拽调整优先顺序'} className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600"><span>优先队列</span><select value="" disabled={Boolean(busy) || workflowOrderLocked || !availableWorkflowIdentities.length} onChange={event => void addPreferredIdentity(event.target.value)} className="max-w-44 bg-transparent text-xs font-medium text-slate-700 outline-none disabled:cursor-not-allowed disabled:text-slate-400"><option value="">{preferredIdentityOrder.length ? `已排序 ${preferredIdentityOrder.length} 人 · 添加人物` : '自动排期 · 添加人物'}</option>{availableWorkflowIdentities.map(identity => <option key={identity.id} value={identity.id}>{identity.name}</option>)}</select>{busy === 'workflow-settings' && <Loader2 size={13} className="animate-spin"/>}</label>
        {workflowOrderLocked && <span className="text-[11px] text-amber-600">已有返图，顺序已锁定</span>}<TeamOutputProgressPicker controller={outputProgress} disabled={Boolean(busy)}/><button disabled={!workflowGroups.size || Boolean(busy) || workflowGenerating} onClick={() => void generateWorkflow()} className="dialog-secondary ml-auto inline-flex items-center gap-2">{workflowGenerating ? <Loader2 size={15} className="animate-spin"/> : <FolderOutput size={15}/>} {workflowGenerating ? `生成中 ${Math.round(workflowGeneration.progress)}%` : '生成工作流程'}</button><button disabled={!readyWorkflowItems.length || Boolean(busy)} onClick={() => void receiveWorkflowBatch(readyWorkflowItems)} className="dialog-primary inline-flex items-center gap-2">{busy === 'workflow-return' ? <Loader2 size={15} className="animate-spin"/> : <Upload size={15}/>}批量导入返图并识别</button><button disabled={!mergeablePhotos.length || Boolean(busy)} onClick={() => void mergeCompletedPhotos()} className="dialog-primary inline-flex items-center gap-2">{busy === 'merge-workflow' ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>}合成已完成图片（{mergeablePhotos.length}）</button>
      </div>
      {!!preferredWorkflowIdentities.length && <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-violet-100 bg-violet-50/70 px-5 py-2"><span className="mr-1 text-xs font-bold text-violet-800">拖拽开工顺序</span>{preferredWorkflowIdentities.map((identity, index) => <div key={identity.id} draggable={!workflowOrderLocked && !busy} onDragStart={event => { setDraggedWorkflowIdentityId(identity.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', identity.id); }} onDragOver={event => { if (!workflowOrderLocked && !busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => { event.preventDefault(); const sourceIdentityId = draggedWorkflowIdentityId || event.dataTransfer.getData('text/plain'); setDraggedWorkflowIdentityId(''); void movePreferredIdentity(sourceIdentityId, identity.id); }} onDragEnd={() => setDraggedWorkflowIdentityId('')} className={`inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white py-1 pl-1.5 pr-2 text-xs font-bold text-violet-800 shadow-sm ${draggedWorkflowIdentityId === identity.id ? 'opacity-40' : ''} ${workflowOrderLocked || busy ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}><GripVertical size={13} className="text-violet-400"/><span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-violet-100 px-1 text-[10px] text-violet-700">{index + 1}</span><span className="max-w-32 truncate">{identity.name}</span><button type="button" disabled={workflowOrderLocked || Boolean(busy)} onClick={() => void removePreferredIdentity(identity.id)} title={`将“${identity.name}”交回自动排期`} className="ml-0.5 rounded-full p-0.5 text-violet-400 hover:bg-violet-100 hover:text-violet-700 disabled:opacity-40"><X size={12}/></button></div>)}<span className="text-[11px] text-violet-600">未加入的人物继续自动安排</span><button type="button" disabled={workflowOrderLocked || Boolean(busy)} onClick={() => void savePreferredIdentityOrder([], '已恢复自动排期；如已生成工作流程，请重新生成')} className="ml-auto text-xs font-bold text-violet-700 hover:text-violet-900 disabled:opacity-40">全部恢复自动</button></div>}
    </>}
    {workflowGenerating && workflowGeneration && <div className="border-b border-blue-100 bg-blue-50 px-5 py-3">
      <div className="flex items-center gap-4 text-xs">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-4 font-bold text-blue-700">
            <span className="truncate">{workflowGeneration.message}{workflowGeneration.currentName ? ` · ${workflowGeneration.currentName}` : ''}</span>
            <span className="shrink-0 tabular-nums">{Math.round(workflowGeneration.progress)}%</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-blue-600">
            <span>{workflowGeneration.completedFiles}/{workflowGeneration.totalFiles || '—'} 张</span>
            <span>{formatWorkflowBytes(workflowGeneration.copiedBytes)}{workflowGeneration.totalBytes ? ` / ${formatWorkflowBytes(workflowGeneration.totalBytes)}` : ''}</span>
            <span>可继续查看和标记人物；离开页面后任务仍会继续</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100">
            <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300" style={{ width: `${workflowGeneration.progress}%` }}/>
          </div>
        </div>
        <button type="button" disabled={workflowGeneration.phase === 'cancelling'} onClick={() => void cancelWorkflowGeneration()} className="shrink-0 rounded-md border border-blue-200 bg-white px-3 py-2 font-bold text-blue-700 hover:bg-blue-100 disabled:opacity-50">
          {workflowGeneration.phase === 'cancelling' ? '正在停止…' : '停止'}
        </button>
      </div>
    </div>}
    {busy === 'workflow-return' && <div className="border-b border-emerald-100 bg-emerald-50 px-5 py-3"><div className="flex items-center justify-between gap-4 text-xs"><span className="font-bold text-emerald-700">{workflowReturnProgress.message}</span><span className="tabular-nums text-emerald-600">{Math.round(workflowReturnProgress.progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-emerald-100"><div className="h-full rounded-full bg-emerald-600 transition-[width] duration-500" style={{ width: `${workflowReturnProgress.progress}%` }}/></div></div>}
    {tab === 'workflow' && workflowReturnResult?.success && <div className="max-h-52 overflow-y-auto border-b border-slate-200 bg-white"><div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-slate-100 bg-white px-5 py-2 text-xs"><span className="font-bold text-slate-700">本次批量返图</span><span className="rounded-full bg-emerald-50 px-2.5 py-1 font-bold text-emerald-700">已完成 {workflowReturnResult.acceptedCount || 0}</span><span className="rounded-full bg-amber-50 px-2.5 py-1 font-bold text-amber-700">待确认 {workflowReturnResult.reviewCount || 0}</span>{Boolean(workflowReturnResult.missingTaskCount) && <span className="text-slate-500">另有 {workflowReturnResult.missingTaskCount} 张当前任务未收到可靠返图</span>}</div>{workflowReturnResult.matches.map(match => <div key={match.returnId} className="grid grid-cols-[minmax(140px,1fr)_24px_minmax(180px,1.2fr)_110px] items-center gap-3 border-b border-slate-100 px-5 py-2 text-xs last:border-0"><span className="truncate font-medium text-slate-700" title={match.sourceName}>{match.sourceName}</span><span className="text-center text-slate-300">→</span><span className="truncate text-slate-600">{match.matched ? `${match.photoName} · ${match.personName}` : '未找到候选任务'}</span><span className={`justify-self-end rounded-full px-2.5 py-1 font-bold ${match.accepted ? 'bg-emerald-50 text-emerald-700' : match.confidence === 'medium' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-600'}`}>{match.accepted ? `已完成 ${Math.round(match.score * 100)}%` : '请单独上传确认'}</span></div>)}</div>}
    {tab === 'workflow' && workflowReturnResult && !workflowReturnResult.success && <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">{workflowReturnResult.error || '批量返图失败'}</div>}
    {loading ? <div className="flex flex-1 items-center justify-center text-sm text-slate-500"><Loader2 className="mr-2 animate-spin"/>正在读取项目人物…</div> : !workspace.photos.length ? <div className="flex flex-1 flex-col items-center justify-center text-center"><UsersRound size={42} className="text-slate-300"/><h3 className="mt-4 font-bold text-slate-700">还没有完成第一步</h3><p className="mt-2 text-sm text-slate-500">请先在“人物识别”中加入图片并完成识别裁图。</p><button onClick={() => onStepChange('detect')} className="dialog-primary mt-5">返回人物识别</button></div> : <main ref={peopleScrollRef} className={`min-h-0 flex-1 p-6 ${tab === 'workflow' ? 'overflow-hidden' : 'overflow-y-auto'}`}><div className={`mx-auto max-w-[1800px] ${tab === 'workflow' ? 'h-full' : 'min-h-full'}`}><div className={tab === 'workflow' ? 'workflow-board-view' : 'min-h-full'}>
      {tab === 'people' ? <><div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4"><div className="min-w-0 flex-1"><h3 className="text-sm font-bold text-blue-800">自动分组是候选，不是最终身份</h3><p className="mt-1 text-xs leading-5 text-blue-700">系统使用对齐后的人脸身份特征，并用 OSNet 人体特征辅助侧脸和遮挡场景；同一照片中的人物不会自动归为同一身份。证据不足的人保持未标注，请点击缩略图看图确认。</p></div>{subjects.length > 18 && <button onClick={() => setShowAllSubjects(current => !current)} className="dialog-secondary">{showAllSubjects ? '每组只显示前 18 张' : '显示全部人物图'}</button>}<button disabled={Boolean(busy)} onClick={() => void suggest()} className="dialog-primary inline-flex items-center gap-2">{busy === 'suggest' ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>}自动识别同一个人</button><button onClick={() => void createIdentity()} className="dialog-secondary">新建人物</button></div>
        <div className="space-y-5">{[...workspace.identities, { id: '__unassigned__', name: '未标注人物', color: '#64748b', createdAt: 0, updatedAt: 0 }].map(identity => { const items = grouped.get(identity.id) || []; if (!items.length && identity.id === '__unassigned__') return null; const visibleItems = showAllSubjects ? items : items.slice(0, 18); return <section key={identity.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" style={{ contentVisibility: 'auto', containIntrinsicSize: '420px' }}><header className="flex items-center gap-3 border-b border-slate-100 px-4 py-3"><span className="h-3 w-3 rounded-full" style={{ background: identity.color }}/>{identity.id === '__unassigned__' ? <h3 className="font-bold text-slate-700">未标注人物</h3> : <input defaultValue={identity.name} onBlur={event => void renameIdentity(identity, event.target.value)} className="min-w-40 rounded border border-transparent px-1 py-1 font-bold text-slate-800 hover:border-slate-200 focus:border-blue-400 focus:outline-none"/>}<span className="text-xs text-slate-400">{items.length} 张人物实例 · {new Set(items.map(item => item.photo.photoId)).size} 张照片{!showAllSubjects && items.length > visibleItems.length ? ` · 当前显示 ${visibleItems.length} 张` : ''}</span>{identity.id !== '__unassigned__' && <button onClick={() => void removeIdentity(identity)} title="删除人物身份" className="ml-auto rounded p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={15}/></button>}</header><div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">{visibleItems.map(subject => <div key={subject.key} data-team-person-key={subject.key} className="space-y-2"><SubjectThumb subject={subject} cacheConfig={cacheConfig}/><select value={subject.identity?.id || ''} onChange={event => void assign(subject, event.target.value)} className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"><option value="">未标注</option>{workspace.identities.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select>{subject.assignment?.source === 'suggested' && <p className="text-[10px] text-amber-600">自动候选 · {Math.round(subject.assignment.confidence * 100)}% · 请人工确认</p>}</div>)}</div></section>; })}</div></> : <>{!workspace.identities.length ? <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">请先在“标记人物”中确认身份。</div> : <div className="space-y-7">{weeks.map(week => <section key={week}><h3 className="mb-3 text-sm font-bold text-slate-700">第 {week} 周</h3><div className="space-y-4">{[...workflowGroups.values()].filter(group => group.week === week).map(group => { const pending = group.items.filter(item => !item.assignment?.completed); const ready = pending.filter(item => item.ready); return <article key={`${week}:${group.identity.id}`} className="workflow-person-lane overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"><header className="workflow-person-summary flex items-center gap-3 border-b border-slate-100 p-4"><span className="h-3 w-3 shrink-0 rounded-full" style={{ background: group.identity.color }}/><div className="min-w-0"><h4 className="truncate font-bold text-slate-800">{group.identity.name}</h4><p className="mt-1 text-xs leading-5 text-slate-400">本周 {group.items.length} 张<br/>可分发 {ready.length} 张 · 已完成 {group.items.length - pending.length} 张</p></div><button disabled={Boolean(busy)} onClick={() => void openTaskFolder(group.identity, week)} className="dialog-primary ml-auto inline-flex shrink-0 items-center gap-2">{busy === `open:${week}:${group.identity.id}` ? <Loader2 size={14} className="animate-spin"/> : <FolderOutput size={14}/>}打开任务文件夹</button></header><div className="workflow-task-strip">{group.items.map(item => <div key={item.key} className="workflow-task-card border-r border-slate-100 p-3 last:border-0"><div className="workflow-task-thumbnail shrink-0"><SubjectThumb subject={item} cacheConfig={cacheConfig}/></div><div className="min-w-0"><p className="truncate text-sm font-bold text-slate-700">{item.photo.name} · 人物 {item.personIndex}</p><p className={`mt-1 truncate text-xs ${item.assignment?.completed ? 'text-emerald-600' : item.ready ? 'text-blue-600' : 'text-amber-600'}`} title={item.blockedBy.join('、')}>{item.assignment?.completed ? '已完成' : item.ready ? '可以分发' : `等待 ${item.blockedBy.join('、')} 完成`}</p></div><button disabled={!item.ready || Boolean(busy)} onClick={() => void upload(item)} className="dialog-secondary inline-flex items-center justify-center gap-1.5">{busy === `upload:${item.key}` ? <Loader2 size={13} className="animate-spin"/> : <Upload size={13}/>}上传返图</button><button disabled={!item.assignment || !item.ready && !item.assignment.completed} onClick={() => void toggleComplete(item)} className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-bold ${item.assignment?.completed ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'}`}>{item.assignment?.completed ? <CheckCircle2 size={13}/> : <AlertTriangle size={13}/>} {item.assignment?.completed ? '已完成' : '标记完成'}</button></div>)}</div></article>; })}</div></section>)}</div>}</>}
    </div></div></main>}
    {assigningSubject && <div role="dialog" aria-modal="true" aria-label="看图修改人物归属" className="fixed inset-0 z-[450] flex items-center justify-center bg-slate-950/70 p-5" onMouseDown={event => { if (event.target === event.currentTarget) setAssigningSubject(null); }}><div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"><header className="flex items-center gap-3 border-b border-slate-200 px-5 py-4"><div><h3 className="font-bold text-slate-900">这是谁？</h3><p className="mt-1 text-xs text-slate-500">左边是识别错误的人；从右边选择同一个人的代表图，不需要记“待确认人物”编号。</p></div><button onClick={() => setAssigningSubject(null)} className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={19}/></button></header><div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]"><aside className="border-r border-slate-200 bg-slate-50 p-5"><p className="mb-2 text-xs font-bold text-slate-500">待修改</p><SubjectThumb subject={assigningSubject} cacheConfig={cacheConfig} interactive={false}/><p className="mt-3 text-sm font-bold text-slate-800">{assigningSubject.photo.name} · 人物 {assigningSubject.personIndex}</p><p className="mt-1 text-xs text-slate-500">当前：{assigningSubject.identity?.name || '未标注'}</p><div className="mt-5 space-y-2"><button onClick={() => void assign(assigningSubject, '')} className="dialog-secondary w-full">设为未标注</button><button onClick={() => void createIdentityForSubject(assigningSubject)} className="dialog-primary w-full">这是一个新人物</button></div></aside><section className="min-h-0 overflow-y-auto p-5"><h4 className="mb-3 text-sm font-bold text-slate-700">选择同一个人</h4><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{pickerIdentities.map(identity => { const examples = grouped.get(identity.id) || []; const representative = examples.find(item => item.key !== assigningSubject.key) || examples[0]; return <button key={identity.id} onClick={() => void assign(assigningSubject, identity.id)} className={`overflow-hidden rounded-xl border bg-white text-left transition hover:border-blue-400 hover:shadow-md ${assigningSubject.identity?.id === identity.id ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200'}`}>{representative ? <SubjectThumb subject={representative} cacheConfig={cacheConfig} interactive={false}/> : <div className="flex aspect-[4/3] items-center justify-center bg-slate-100 text-slate-400"><UserRound/></div>}<div className="flex items-center gap-2 p-3"><span className="h-2.5 w-2.5 rounded-full" style={{ background: identity.color }}/><span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">{identity.name}</span><span className="text-[10px] text-slate-400">{examples.length} 张</span></div></button>; })}</div></section></div></div></div>}
  </div>;
};
