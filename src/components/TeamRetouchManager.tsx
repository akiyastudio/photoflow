import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, ScanFace, SlidersHorizontal, Trash2, UserRound, UsersRound, Wand2, X } from 'lucide-react';
import type { AppConfig, ComponentStatus, MediaVersion, ProjectFileEntry, TeamIdentity, TeamIdentityWorkspace, TeamPatchBundle, TeamPatchTask, TeamPersonAssignment, WorkspaceProject } from '../types';
import { useAppDialog } from './AppDialogProvider';
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
};

type BatchResult = { relativePath: string; name: string; success: boolean; error?: string };
type Crop = { x: number; y: number; width: number; height: number };
type IdentityState = TeamIdentityWorkspace & { identifying?: boolean };

const assignmentKey = (photoId: string, baseVersionId: string, personIndex: number) => `${photoId}:${baseVersionId}:${personIndex}`;
const membersOf = (task: TeamPatchTask) => task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox }];
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

const useLazyPreview = (filePath: string | undefined, cacheConfig: AppConfig['mediaCache'], size: number) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    setUrl('');
    if (!filePath) return () => { active = false; };
    const stop = window.electronAPI.onThumbnailStateChanged(update => {
      if (active && update.filePath.toLocaleLowerCase() === filePath.toLocaleLowerCase() && update.state === 'READY' && update.previewUrls?.medium) setUrl(update.previewUrls.medium);
    });
    void window.electronAPI.getMediaThumbnail(filePath, 'image', cacheConfig, size, 1, 0).then(result => {
      if (active && result.previewUrl) setUrl(result.previewUrl);
    });
    return () => { active = false; stop(); };
  }, [filePath, size, cacheConfig.directory, cacheConfig.maxSizeGB]);
  return url;
};

const PatchPreview = ({ task, cacheConfig }: { task: TeamPatchTask; cacheConfig: AppConfig['mediaCache'] }) => {
  const url = useLazyPreview(task.patchPath, cacheConfig, 480);
  return <div className="relative flex h-44 items-center justify-center overflow-hidden rounded-lg bg-slate-950">
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
      return <g key={member.personIndex}><rect x={x} y={y} width={width} height={height} fill={`${color}12`} stroke={color} strokeWidth={Math.max(2, task.crop.width / 420)}/><rect x={x} y={labelY} width={labelWidth} height={labelHeight} rx={fontSize * .2} fill={color}/><text x={x + fontSize * .35} y={labelY + fontSize * 1.05} fill="#020617" fontSize={fontSize} fontWeight="800">人物 {member.personIndex}</text></g>;
    })}</svg> : <Loader2 className="animate-spin text-slate-500"/>}
    <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[10px] font-bold text-white">识别工作图</span>
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
    return identityId ? identities.get(identityId)?.name : undefined;
  }).filter((value): value is string => Boolean(value));
  return [...new Set(names)];
};

type PhotoCardProps = Omit<Props, 'entries' | 'activeStep' | 'onStepChange'> & {
  entry: ProjectFileEntry;
  identityState: IdentityState;
  refreshToken: number;
  onIdentityChanged: () => Promise<void>;
  onDetectionComplete: () => Promise<void>;
};

const TeamRetouchPhotoCard = ({ entry, workspacePath, project, cacheConfig, defaultBackendMode, componentStatus, identityState, refreshToken, onIdentityChanged, onDetectionComplete, onNotice, onEntriesChange, onProjectChanged }: PhotoCardProps) => {
  const appDialog = useAppDialog();
  const [bundle, setBundle] = useState<TeamPatchBundle>({ success: true, versions: [], tasks: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [baseVersionId, setBaseVersionId] = useState('');
  const [backendMode, setBackendMode] = useState(defaultBackendMode || 'auto');
  const [cropEditor, setCropEditor] = useState<{ task: TeamPatchTask; crop: Crop } | null>(null);
  const [detectionProgress, setDetectionProgress] = useState({ progress: 0, message: '准备 AI 识别' });

  const load = async () => {
    setLoading(true);
    const result = await window.electronAPI.getTeamPatches(workspacePath, project.status, project.name, entry.relativePath);
    setLoading(false);
    if (!result.success) { onNotice(`打开多人修脸失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeBundle(result));
    setBaseVersionId(current => result.versions.some(version => version.id === current) ? current : result.photo?.currentVersionId || result.tasks[0]?.baseVersionId || result.versions.at(-1)?.id || '');
  };
  useEffect(() => { void load(); }, [entry.path, entry.updatedAt, refreshToken]);

  const baseVersion = useMemo<MediaVersion | undefined>(() => bundle.versions.find(version => version.id === baseVersionId) || bundle.versions.find(version => version.isCurrent) || bundle.versions.at(-1), [bundle.versions, baseVersionId]);
  const tasks = useMemo(() => bundle.tasks.filter(task => task.baseVersionId === baseVersion?.id), [bundle.tasks, baseVersion?.id]);
  const previewUrl = useLazyPreview(baseVersion?.filePath, cacheConfig, 1280);
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

  const detect = async () => {
    if (!bundle.photo || !baseVersion) return;
    if (tasks.length && !await appDialog.confirm({ title: '重新识别这张图片？', message: '会替换当前裁图、人物标注和确认状态。', confirmLabel: '重新识别', tone: 'danger' })) return;
    setBusy('detect');
    setDetectionProgress({ progress: 1, message: '准备 AI 识别' });
    const result = await window.electronAPI.detectTeamPatchPeople(workspacePath, project.status, project.name, { photoId: bundle.photo.id, baseVersionId: baseVersion.id, backendMode });
    setBusy('');
    if (!result.success) { onNotice(`AI 识别失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeBundle(result));
    await onDetectionComplete();
    const personCount = result.detection?.personCount || result.tasks.reduce((total, task) => total + membersOf(task).length, 0);
    onNotice(`已识别 ${personCount} 个人物，并自动尝试匹配项目中的人物身份`);
  };

  const updateTask = async (task: TeamPatchTask, changes: { personName?: string; assignee?: string; crop?: Crop; needsReview?: boolean; reviewReason?: string }) => {
    if (!bundle.photo) return false;
    const result = await window.electronAPI.updateTeamPatch(workspacePath, { photoId: bundle.photo.id, taskId: task.id, ...changes });
    if (!result.success) { onNotice(`更新工作图失败：${result.error || '未知错误'}`); return false; }
    setBundle(current => ({ ...current, tasks: result.tasks }));
    return true;
  };

  const assignMember = async (task: TeamPatchTask, personIndex: number, identityId: string) => {
    if (!bundle.photo || !baseVersion) return;
    setBusy(`assign:${task.id}:${personIndex}`);
    const result = await window.electronAPI.assignTeamIdentity(workspacePath, { projectName: project.name, photoId: bundle.photo.id, baseVersionId: baseVersion.id, personIndex, identityId: identityId || undefined, confidence: 1, source: 'manual' });
    setBusy('');
    if (!result.success) { onNotice(`修改人物失败：${result.error || '未知错误'}`); return; }
    await onIdentityChanged();
  };

  const createIdentity = async (task: TeamPatchTask, personIndex: number) => {
    if (!bundle.photo || !baseVersion) return;
    const name = (await appDialog.prompt({ title: '标记为新人物', message: '填写人物姓名或便于识别的称呼。', defaultValue: `人物 ${identityState.identities.length + 1}`, confirmLabel: '新建并标记' }))?.trim();
    if (!name) return;
    const result = await window.electronAPI.saveTeamIdentity(workspacePath, { projectName: project.name, name, assignments: [{ photoId: bundle.photo.id, baseVersionId: baseVersion.id, personIndex, confidence: 1, source: 'manual' }] });
    if (!result.success) { onNotice(`新建人物失败：${result.error || '未知错误'}`); return; }
    await updateTask(task, { personName: name, assignee: task.assignee || name });
    await onIdentityChanged();
  };

  const confirmTask = async (task: TeamPatchTask) => {
    const unmarked = membersOf(task).filter(member => !assignments.get(assignmentKey(task.photoId, task.baseVersionId, member.personIndex))?.identityId);
    if (unmarked.length) { onNotice(`请先标记这张工作图中的 ${unmarked.length} 个人物`); return; }
    if (await updateTask(task, { needsReview: false, reviewReason: '' })) onNotice('已确认人物归属与裁剪范围');
  };

  const saveCrop = async () => {
    if (!cropEditor) return;
    setBusy(`crop:${cropEditor.task.id}`);
    const success = await updateTask(cropEditor.task, { crop: cropEditor.crop, needsReview: false, reviewReason: '' });
    setBusy('');
    if (success) { setCropEditor(null); onNotice('已按新范围重新生成工作图'); }
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
    if (!bundle.photo || !baseVersion || !await appDialog.confirm({ title: `从多人修脸中删除“${bundle.photo.displayName || entry.name}”？`, message: '会删除这张图片的裁图、人物标注和流程状态，原照片不会删除。', confirmLabel: '删除多人修脸数据', tone: 'danger' })) return;
    setBusy('remove-photo');
    const result = await window.electronAPI.removeProjectTeamPhoto(workspacePath, { photoId: bundle.photo.id, baseVersionId: baseVersion.id });
    setBusy('');
    if (!result.success) { onNotice(`删除失败：${result.error || '未知错误'}`); return; }
    onProjectChanged?.();
    onEntriesChange?.([]);
  };

  const identifiedCount = tasks.reduce((total, task) => total + membersOf(task).filter(member => assignments.get(assignmentKey(task.photoId, task.baseVersionId, member.personIndex))?.identityId).length, 0);
  const personCount = tasks.reduce((total, task) => total + membersOf(task).length, 0);
  const advancedReady = Boolean(componentStatus?.advancedAvailable);

  return <div className={`${cropEditor ? 'overflow-visible' : 'overflow-hidden'} rounded-2xl border border-slate-200 bg-slate-50 shadow-sm`} style={cropEditor ? undefined : { contentVisibility: 'auto', containIntrinsicSize: '900px' }}>
    <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3"><div className="min-w-0"><h3 className="truncate font-bold text-slate-900">{bundle.photo?.displayName || entry.name}</h3><p className="mt-0.5 text-xs text-slate-500">{tasks.length} 张工作图 · {identifiedCount}/{personCount} 个人物已标记 · {tasks.filter(task => task.needsReview).length} 张待确认</p></div><div className="ml-auto flex flex-wrap items-center gap-2"><select aria-label="识别模式" value={backendMode} onChange={event => setBackendMode(event.target.value as AppConfig['personDetection']['backendMode'])} disabled={Boolean(busy)} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-700"><option value="auto">自动（推荐）</option><option value="basic">基础模式</option><option value="advanced" disabled={!advancedReady}>高级模式{advancedReady ? '' : '（不可用）'}</option></select><select aria-label="基础版本" value={baseVersion?.id || ''} onChange={event => setBaseVersionId(event.target.value)} disabled={Boolean(busy)} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-700">{bundle.versions.filter(version => !version.fileMissing).map(version => <option key={version.id} value={version.id}>基础 V{version.versionNumber} · {version.versionName}</option>)}</select><button disabled={!baseVersion || Boolean(busy)} onClick={() => void detect()} className="dialog-secondary inline-flex items-center gap-2">{busy === 'detect' ? <Loader2 size={15} className="animate-spin"/> : tasks.length ? <RefreshCw size={15}/> : <ScanFace size={15}/>} {tasks.length ? '重新识别本图' : '识别本图'}</button>{baseVersion && <button disabled={Boolean(busy)} onClick={() => void removeFromProject()} title="从项目多人修脸中删除这张图片" className="rounded-md border border-red-200 p-2 text-red-600 hover:bg-red-50"><Trash2 size={15}/></button>}</div></header>
    {busy === 'detect' && <div className="border-b border-blue-100 bg-blue-50 px-5 py-3"><div className="flex justify-between text-xs font-bold text-blue-700"><span>{detectionProgress.message}</span><span>{Math.round(detectionProgress.progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full bg-blue-600" style={{ width: `${detectionProgress.progress}%` }}/></div></div>}
    {loading ? <div className="flex min-h-64 items-center justify-center gap-2 text-slate-500"><Loader2 className="animate-spin"/>正在读取人物数据…</div> : <div className="grid grid-cols-[minmax(320px,.9fr)_minmax(440px,1.1fr)]">
      <section className="border-r border-slate-200 bg-slate-950 p-4"><div className="relative mx-auto flex min-h-[500px] items-center justify-center overflow-hidden rounded-xl bg-black">{previewUrl ? <svg className="max-h-[calc(100vh-190px)] w-full" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet"><image href={previewUrl} width={imageSize.width} height={imageSize.height} onLoad={() => { if (tasks.length) return; const image = new Image(); image.onload = () => setImageSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 }); image.src = previewUrl; }}/>{tasks.map((task, index) => <g key={task.id}><rect x={task.crop.x} y={task.crop.y} width={task.crop.width} height={task.crop.height} fill="rgba(59,130,246,.06)" stroke={task.needsReview ? '#fb923c' : '#60a5fa'} strokeWidth={Math.max(3, imageSize.width / 900)}/>{membersOf(task).map(member => { const color = personColor(member.personIndex); const fontSize = Math.max(20, imageSize.width / 100); return <g key={member.personIndex}><rect x={member.bbox.x} y={member.bbox.y} width={member.bbox.width} height={member.bbox.height} fill={`${color}0d`} stroke={color} strokeWidth={Math.max(2, imageSize.width / 1300)}/><text x={member.bbox.x + fontSize * .25} y={Math.max(fontSize, member.bbox.y - fontSize * .25)} fill={color} fontSize={fontSize} fontWeight="800" paintOrder="stroke" stroke="rgba(0,0,0,.85)" strokeWidth="5">人物 {member.personIndex}</text></g>; })}<text x={task.crop.x + 10} y={task.crop.y + 28} fill="white" fontSize={Math.max(20, imageSize.width / 85)} fontWeight="700" paintOrder="stroke" stroke="rgba(0,0,0,.75)" strokeWidth="5">{index + 1} · {task.personName}</text></g>)}</svg> : <Loader2 className="animate-spin text-slate-500"/>}</div><p className="mt-3 text-xs leading-5 text-slate-400">蓝框是工作图范围；每个人物使用独立颜色和编号，并与右侧人物选择行对应。橙色工作图需要人工确认。</p></section>
      <section className="p-5">{!tasks.length ? <div className="flex min-h-96 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center"><ScanFace size={34} className="text-violet-500"/><h4 className="mt-3 font-bold text-slate-800">识别人物并生成工作图</h4><p className="mt-2 text-sm text-slate-500">这一步只识别、裁图和标记人物，不上传返图，也不进行合成。</p><button onClick={() => void detect()} className="dialog-primary mt-4">开始识别</button></div> : <div className="grid gap-4 xl:grid-cols-2">{tasks.map(task => {
        const names = taskIdentityNames(task, task.photoId, task.baseVersionId, assignments, identities);
        return <article key={task.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><header className="flex items-start gap-3"><span className={`rounded-full p-2 ${task.needsReview ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>{task.needsReview ? <AlertTriangle size={17}/> : <UserRound size={17}/>}</span><div className="min-w-0 flex-1"><label className="text-[10px] font-bold text-slate-400">人物名字</label><input value={task.personName} onChange={event => setBundle(current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, personName: event.target.value } : item) }))} onBlur={event => void updateTask(task, { personName: event.target.value })} className="w-full rounded border border-slate-200 px-2 py-1 font-bold text-slate-800"/><label className="mt-1 block text-[10px] font-bold text-slate-400">接收人姓名</label><input value={task.assignee} onChange={event => setBundle(current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, assignee: event.target.value } : item) }))} onBlur={event => void updateTask(task, { assignee: event.target.value })} placeholder={names.length ? names.join('、') : '人物确认后自动填写，也可修改'} className="w-full rounded border border-slate-200 px-2 py-1 text-xs text-slate-600"/></div><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${task.needsReview ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}>{task.needsReview ? '需要确认' : '已确认'}</span></header>
          {task.reviewReason && <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-700">{task.reviewReason}</p>}
          <PatchPreview task={task} cacheConfig={cacheConfig}/>
          <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-2.5"><p className="text-[10px] font-bold text-slate-500">工作图中的人物</p>{membersOf(task).map(member => { const assignment = assignments.get(assignmentKey(task.photoId, task.baseVersionId, member.personIndex)); return <div key={member.personIndex} className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: personColor(member.personIndex) }}/><span className="w-14 text-xs font-bold text-slate-500">人物 {member.personIndex}</span><select aria-label={`人物 ${member.personIndex} 的身份`} value={assignment?.identityId || ''} disabled={Boolean(busy) || identityState.identifying} onChange={event => void assignMember(task, member.personIndex, event.target.value)} className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs"><option value="">未标记</option>{identityState.identities.map(identity => <option key={identity.id} value={identity.id}>{identity.name}</option>)}</select><button onClick={() => void createIdentity(task, member.personIndex)} className="dialog-secondary px-2 py-1.5 text-[10px]">新人物</button></div>; })}</div>
          <div className="mt-3 flex flex-wrap gap-2"><button disabled={task.patchMissing} onClick={() => void window.electronAPI.openTeamPatch(task.patchPath)} className="dialog-secondary inline-flex items-center gap-1.5"><ExternalLink size={13}/>打开工作图</button><button onClick={() => setCropEditor({ task, crop: { ...task.crop } })} className="dialog-secondary inline-flex items-center gap-1.5"><SlidersHorizontal size={13}/>调整范围</button>{task.needsReview && <button disabled={Boolean(busy)} onClick={() => void confirmTask(task)} className="dialog-primary inline-flex items-center gap-1.5"><CheckCircle2 size={13}/>确认无误</button>}<button disabled={Boolean(busy)} onClick={() => void deleteTask(task)} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50"><Trash2 size={13}/>识别错误，删除</button></div>
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
    if (!names.length) return;
    const personName = names.join('、');
    const assignee = !task.assignee || task.assignee === task.personName ? personName : task.assignee;
    if (task.personName === personName && task.assignee === assignee) return;
    await window.electronAPI.updateTeamPatch(workspacePath, { photoId: photo.photoId, taskId: task.id, personName, assignee });
  })));
};

const TeamRetouchWorkspace = ({ entries, workspacePath, project, cacheConfig, defaultBackendMode, componentStatus, activeStep, onStepChange, onClose, onNotice, onEntriesChange, onProjectChanged }: Props) => {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [progress, setProgress] = useState({ itemIndex: 0, itemCount: entries.length, progress: 0, itemName: '', message: '准备批量识别' });
  const [backendMode, setBackendMode] = useState(defaultBackendMode || 'auto');
  const [refreshToken, setRefreshToken] = useState(0);
  const [unrecognizedPaths, setUnrecognizedPaths] = useState<string[]>([]);
  const [checkingEntries, setCheckingEntries] = useState(true);
  const [identityState, setIdentityState] = useState<IdentityState>({ success: true, photos: [], identities: [], assignments: [] });
  const identifyingRef = useRef(false);

  const loadIdentities = async (syncLabels = false) => {
    const result = await window.electronAPI.getTeamProjectWorkspace(workspacePath, project.name);
    if (result.success) {
      if (syncLabels) await syncTaskLabels(workspacePath, result);
      setIdentityState(result);
      if (syncLabels) setRefreshToken(current => current + 1);
    }
  };
  useEffect(() => { void loadIdentities(); }, [workspacePath, project.name]);
  useEffect(() => {
    let active = true;
    setCheckingEntries(true);
    Promise.all(entries.map(async entry => { const result = await window.electronAPI.getTeamPatches(workspacePath, project.status, project.name, entry.relativePath); return !result.success || !result.tasks.length ? entry.relativePath : ''; })).then(paths => { if (active) { setUnrecognizedPaths(paths.filter(Boolean)); setCheckingEntries(false); } }).catch(() => { if (active) setCheckingEntries(false); });
    return () => { active = false; };
  }, [entries, workspacePath, project.status, project.name, refreshToken]);
  useEffect(() => window.electronAPI.onTeamPatchBatchProgress(value => setProgress({ itemIndex: value.itemIndex, itemCount: value.itemCount, progress: value.progress, itemName: value.itemName, message: value.message })), []);

  const identifyAndSync = async () => {
    if (identifyingRef.current) return;
    identifyingRef.current = true;
    setIdentityState(current => ({ ...current, identifying: true }));
    const result = await window.electronAPI.suggestTeamIdentities(workspacePath, project.name);
    identifyingRef.current = false;
    if (!result.success) { setIdentityState(current => ({ ...current, identifying: false })); onNotice(`人物自动标记失败：${result.error || '未知错误'}`); return; }
    await syncTaskLabels(workspacePath, result);
    setIdentityState({ ...result, identifying: false });
    setRefreshToken(current => current + 1);
    onProjectChanged?.();
  };

  const runBatch = async () => {
    if (checkingEntries) return;
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

  return <div className="fixed inset-x-0 bottom-0 top-10 z-[310] flex flex-col bg-slate-50"><header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3"><span className="rounded-xl bg-violet-50 p-2 text-violet-600"><UsersRound size={20}/></span><div><h2 className="font-bold text-slate-900">多人修脸 · {entries.length} 张图片</h2><p className="mt-0.5 text-xs text-slate-500">识别并裁图时同步标记人物；确认后再生成工作流程。</p></div><TeamRetouchSteps value={activeStep} onChange={onStepChange} disabled={running}/><div className="ml-auto flex items-center gap-2"><select aria-label="识别模式" value={backendMode} onChange={event => setBackendMode(event.target.value as AppConfig['personDetection']['backendMode'])} disabled={running} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-700"><option value="auto">自动（推荐）</option><option value="basic">基础模式</option><option value="advanced" disabled={!componentStatus?.advancedAvailable}>高级模式{componentStatus?.advancedAvailable ? '' : '（不可用）'}</option></select><button disabled={running || checkingEntries} onClick={() => void runBatch()} className="dialog-secondary inline-flex items-center gap-2">{running || checkingEntries ? <Loader2 size={15} className="animate-spin"/> : <ScanFace size={15}/>} {checkingEntries ? '检查新增图片…' : unrecognizedPaths.length ? `识别新增图片（${unrecognizedPaths.length} 张）` : entries.length > 1 ? '重新识别全部图片' : '重新识别图片'}</button><button disabled={running || identityState.identifying} onClick={() => void identifyAndSync()} className="dialog-primary inline-flex items-center gap-2">{identityState.identifying ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>}重新自动标记人物</button><button onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={20}/></button></div></header>
    <div className={`border-b px-5 py-2 text-xs ${componentStatus?.advancedAvailable ? 'border-violet-100 bg-violet-50 text-violet-700' : advancedNeedsRepair ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-blue-100 bg-blue-50 text-blue-700'}`}><span className="font-bold">{componentStatus?.advancedAvailable ? '高级引擎可用' : advancedNeedsRepair ? '高级引擎需要修复' : '基础可用 · 高级未安装'}</span></div>
    {running && <div className="border-b border-blue-100 bg-blue-50 px-5 py-3"><div className="flex justify-between text-xs font-bold text-blue-700"><span>{progress.itemIndex ? `${progress.itemIndex}/${progress.itemCount} · ${progress.itemName} · ` : ''}{progress.message}</span><span>{Math.round(overallProgress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full bg-blue-600" style={{ width: `${overallProgress}%` }}/></div></div>}
    <main className="min-h-0 flex-1 overflow-y-auto p-6"><div className="mx-auto max-w-[1600px] space-y-6">{entries.map(entry => { const result = resultByPath.get(entry.relativePath); return <section key={entry.relativePath} className="space-y-2">{result && !result.success && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">{result.error || `${entry.name} 识别失败`}</div>}<TeamRetouchPhotoCard entry={entry} workspacePath={workspacePath} project={project} cacheConfig={cacheConfig} defaultBackendMode={defaultBackendMode} componentStatus={componentStatus} onClose={onClose} onNotice={onNotice} onProjectChanged={onProjectChanged} onEntriesChange={() => { const next = entries.filter(candidate => candidate.relativePath !== entry.relativePath); onEntriesChange?.(next); if (!next.length) onClose(); }} identityState={identityState} refreshToken={refreshToken} onIdentityChanged={() => loadIdentities(true)} onDetectionComplete={identifyAndSync}/></section>; })}</div></main>
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
