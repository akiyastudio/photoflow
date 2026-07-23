import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, ScanFace, Sparkles, Trash2, Upload, UserRound, UsersRound, Wand2, X } from 'lucide-react';
import type { AppConfig, MediaVersion, ProjectFileEntry, TeamPatchBundle, TeamPatchReturnBatchResult, TeamPatchTask, WorkspaceProject } from '../types';
import { useAppDialog } from './AppDialogProvider';

type Props = {
  entries: ProjectFileEntry[];
  workspacePath: string;
  project: WorkspaceProject;
  cacheConfig: AppConfig['mediaCache'];
  onClose: () => void;
  onNotice: (message: string) => void;
};

type SingleProps = Omit<Props, 'entries'> & { entry: ProjectFileEntry };
const normalizeVisibleBundle = (bundle: TeamPatchBundle): TeamPatchBundle => ({
  ...bundle,
  versions: bundle.versions.map(version => ({
    ...version,
    versionName: version.versionName.replace(/^R\d+\s*·\s*/i, ''),
  })),
});

const PatchImage = ({ path, cacheConfig, label }: { path?: string; cacheConfig: AppConfig['mediaCache']; label: string }) => {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setUrl('');
    setError('');
    if (!path) return () => { active = false; };
    window.electronAPI.getMediaOriginal(path, 'image', cacheConfig).then(result => {
      if (active && result.success && result.mediaUrl) setUrl(result.mediaUrl);
      else if (active) setError(result.error || '工作图文件无法读取');
    }).catch(() => { if (active) setError('工作图文件无法读取'); });
    return () => { active = false; };
  }, [path, cacheConfig.directory, cacheConfig.maxSizeGB]);
  return <div className="relative flex min-h-36 items-center justify-center overflow-hidden rounded-lg bg-slate-950">
    {url ? <img src={url} alt={label} className="h-44 w-full object-contain"/> : <UserRound size={25} className="text-slate-500"/>}
    {error && <span className="absolute inset-x-4 bottom-5 text-center text-xs text-amber-300">工作图文件无法读取，请重新识别</span>}
    <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[10px] font-bold text-white">{label}</span>
  </div>;
};

const statusLabel = (task: TeamPatchTask) => task.needsReview ? '需要确认' : task.status === 'merged' ? '已合回' : task.editedPatchPath ? '已上传' : '等待手机修图';

const SingleTeamRetouchManager = ({ entry, workspacePath, project, cacheConfig, onClose, onNotice }: SingleProps) => {
  const appDialog = useAppDialog();
  const [bundle, setBundle] = useState<TeamPatchBundle>({ success: true, versions: [], tasks: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'detect' | 'merge' | string>('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [baseVersionId, setBaseVersionId] = useState('');
  const [detectionProgress, setDetectionProgress] = useState({ progress: 0, message: '准备AI识别' });

  const load = async () => {
    setLoading(true);
    const result = await window.electronAPI.getTeamPatches(workspacePath, project.status, project.name, entry.relativePath);
    setLoading(false);
    if (!result.success) { onNotice(`打开多人修脸失败：${result.error || '未知错误'}`); onClose(); return; }
    setBundle(normalizeVisibleBundle(result));
    const missingCount = result.tasks.filter(task => task.patchMissing).length;
    if (missingCount) onNotice(`${missingCount} 张工作图无法恢复，请点击“重新识别”再次生成`);
    setBaseVersionId(current => result.versions.some(version => version.id === current)
      ? current
      : result.tasks.find(task => task.baseVersionId === result.photo?.currentVersionId)?.baseVersionId
        || result.photo?.currentVersionId
        || result.tasks[0]?.baseVersionId
        || result.versions.at(-1)?.id
        || '');
  };
  useEffect(() => { void load(); }, [entry.path, entry.updatedAt]);

  const baseVersion = useMemo<MediaVersion | undefined>(() => {
    return bundle.versions.find(version => version.id === baseVersionId)
      || bundle.versions.find(version => version.isCurrent)
      || bundle.versions[bundle.versions.length - 1];
  }, [baseVersionId, bundle.versions]);
  const tasks = useMemo(() => bundle.tasks.filter(task => task.baseVersionId === baseVersion?.id), [baseVersion?.id, bundle.tasks]);

  useEffect(() => window.electronAPI.onTeamPatchDetectionProgress(value => {
    if (value.photoId !== bundle.photo?.id || value.baseVersionId !== baseVersion?.id) return;
    setDetectionProgress({ progress: value.progress, message: value.message });
  }), [bundle.photo?.id, baseVersion?.id]);

  useEffect(() => {
    let active = true;
    setPreviewUrl('');
    if (!baseVersion || baseVersion.fileMissing) return () => { active = false; };
    window.electronAPI.getMediaOriginal(baseVersion.filePath, 'image', cacheConfig).then(result => {
      if (active && result.success && result.mediaUrl) setPreviewUrl(result.mediaUrl);
    });
    return () => { active = false; };
  }, [baseVersion?.id, baseVersion?.filePath, cacheConfig.directory, cacheConfig.maxSizeGB]);

  const detect = async () => {
    if (!bundle.photo || !baseVersion) return;
    if (tasks.length && !await appDialog.confirm({
      title: '确定重新识别吗？',
      message: '重新检测会替换当前基础版本下的任务清单。',
      confirmLabel: '重新识别',
      tone: 'danger',
    })) return;
    setDetectionProgress({ progress: 1, message: '准备AI识别' });
    setBusy('detect');
    const result = await window.electronAPI.detectTeamPatchPeople(workspacePath, project.status, project.name, { photoId: bundle.photo.id, baseVersionId: baseVersion.id });
    setBusy('');
    if (!result.success) { onNotice(`AI识别失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeVisibleBundle(result));
    if (!result.tasks.length) onNotice('没有可靠检测到人物；请更换图片或稍后使用手动确认。');
    else {
      const reviewCount = result.detection?.needsReviewCount || result.tasks.filter(task => task.needsReview).length;
      const fallback = result.detection?.fallbackReason ? `；${result.detection.fallbackReason}` : '';
      const personCount = result.detection?.personCount || result.tasks.reduce((total, task) => total + Math.max(1, task.members?.length || 0), 0);
      onNotice(`AI识别到 ${personCount} 个人物，已合并成 ${result.tasks.length} 张工作图${reviewCount ? `；其中 ${reviewCount} 张需要确认` : ''}${fallback}`);
    }
  };

  const updateTask = async (task: TeamPatchTask, changes: { personName?: string; assignee?: string; needsReview?: boolean; reviewReason?: string }) => {
    const result = await window.electronAPI.updateTeamPatch(workspacePath, { taskId: task.id, ...changes });
    if (!result.success) { onNotice(`更新任务失败：${result.error || '未知错误'}`); return; }
    setBundle(current => ({ ...current, tasks: result.tasks }));
  };

  const upload = async (task: TeamPatchTask) => {
    if (!bundle.photo) return;
    setBusy(task.id);
    const result = await window.electronAPI.uploadTeamPatch(workspacePath, { photoId: bundle.photo.id, taskId: task.id });
    setBusy('');
    if (result.cancelled) return;
    if (!result.success) { onNotice(`上传 Patch 失败：${result.error || '未知错误'}`); return; }
    setBundle(current => ({ ...current, tasks: result.tasks }));
    onNotice(`${task.personName} 的手机修图结果已进入 Patch 数据库`);
  };

  const openPatch = async (task: TeamPatchTask) => {
    const result = await window.electronAPI.openTeamPatch(task.patchPath);
    if (!result.success) onNotice(`打开工作图失败：${result.error || '文件不存在，请重新识别'}`);
  };

  const merge = async () => {
    if (!bundle.photo || !baseVersion) return;
    const uploaded = bundle.tasks.filter(task => task.editedPatchPath).length;
    if (!uploaded) { onNotice('请先上传至少一张工作图的修图结果'); return; }
    const nextNumber = Math.max(-1, ...bundle.versions.map(version => version.versionNumber)) + 1;
    const versionName = (await appDialog.prompt({
      title: '合成后的版本名称',
      defaultValue: `多人修脸合成 V${nextNumber}`,
      confirmLabel: '开始合成',
    }))?.trim();
    if (!versionName) return;
    setBusy('merge');
    const result = await window.electronAPI.mergeTeamPatches(workspacePath, project.status, project.name, { photoId: bundle.photo.id, baseVersionId: baseVersion.id, versionName });
    setBusy('');
    if (!result.success) { onNotice(`自动回拼失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeVisibleBundle(result));
    const conflict = result.merge?.conflictPixels || 0;
    onNotice(result.merge?.needsReview ? `已生成 V${result.versions.at(-1)?.versionNumber}；检测到 ${conflict} 个显著重叠冲突像素，请进行版本对比复核` : `已无缝回拼并生成 V${result.versions.at(-1)?.versionNumber}`);
  };

  const cleanupCompleted = async () => {
    if (!bundle.photo || !baseVersion || !tasks.length) return;
    if (!await appDialog.confirm({
      title: '确定清理已完成工作数据吗？',
      message: '已生成的合成版本会保留，但工作图、上传图和任务记录会删除，之后不能直接重新合并；如需再次处理，需要重新识别。',
      confirmLabel: '清理工作数据',
      tone: 'danger',
    })) return;
    setBusy('cleanup');
    const result = await window.electronAPI.cleanupTeamPatches(workspacePath, { photoId: bundle.photo.id, baseVersionId: baseVersion.id });
    setBusy('');
    if (!result.success) { onNotice(`清理多人修脸工作数据失败：${result.error || '未知错误'}`); return; }
    setBundle(normalizeVisibleBundle(result));
    onNotice(`已清理完成任务的工作数据${result.removedArtifactCount ? `（${result.removedArtifactCount} 项）` : ''}，合成版本已保留`);
  };

  const uploadedCount = tasks.filter(task => task.editedPatchPath).length;
  const mergedCount = tasks.filter(task => task.status === 'merged').length;
  const canCleanupCompleted = tasks.length > 0 && tasks.every(task => task.status === 'merged');

  return <div className="fixed inset-x-0 bottom-0 top-10 z-[310] flex flex-col bg-slate-50">
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
      <div className="flex min-w-0 items-center gap-3"><span className="rounded-xl bg-violet-50 p-2 text-violet-600"><UsersRound size={20}/></span><div className="min-w-0"><h2 className="truncate font-bold text-slate-900">多人修脸 · {bundle.photo?.displayName || entry.name}</h2><p className="mt-0.5 truncate text-xs text-slate-500">AI识别人后规划尽量少的工作图；手机修完自动合回原尺寸。</p></div></div>
      <div className="ml-auto flex items-center gap-2"><select aria-label="基础版本" value={baseVersion?.id || ''} onChange={event => setBaseVersionId(event.target.value)} disabled={Boolean(busy)} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-700">{bundle.versions.filter(version => !version.fileMissing).map(version => <option key={version.id} value={version.id}>基础 V{version.versionNumber} · {version.versionName}</option>)}</select><button disabled={!baseVersion || Boolean(busy)} onClick={() => void detect()} className="dialog-secondary inline-flex items-center gap-2">{busy === 'detect' ? <Loader2 size={15} className="animate-spin"/> : tasks.length ? <RefreshCw size={15}/> : <ScanFace size={15}/>} {tasks.length ? '重新识别' : 'AI识别并规划'}</button><button disabled={!uploadedCount || Boolean(busy)} onClick={() => void merge()} className="dialog-primary inline-flex items-center gap-2">{busy === 'merge' ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>}自动合回原尺寸</button><button onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={20}/></button></div>
    </header>
    <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-5 py-2 text-xs"><span className="rounded-full bg-blue-50 px-3 py-1 font-bold text-blue-600">1 工作图 {tasks.length}</span><span className="text-slate-300">→</span><span className={`rounded-full px-3 py-1 font-bold ${uploadedCount ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>2 手机回传 {uploadedCount}/{tasks.length}</span><span className="text-slate-300">→</span><span className={`rounded-full px-3 py-1 font-bold ${mergedCount ? 'bg-violet-50 text-violet-600' : 'bg-slate-100 text-slate-400'}`}>3 合回版本 {mergedCount ? '完成' : '待处理'}</span>{canCleanupCompleted && <button type="button" disabled={Boolean(busy)} onClick={() => void cleanupCompleted()} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 font-bold text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"><Trash2 size={13}/>{busy === 'cleanup' ? '正在清理…' : '清理已完成工作数据'}</button>}<span className={canCleanupCompleted ? 'text-slate-400' : 'ml-auto text-slate-400'}>基础：{baseVersion ? `V${baseVersion.versionNumber} · ${baseVersion.versionName}` : '读取中'}</span></div>
    {busy === 'detect' && <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-5 py-3" role="progressbar" aria-label="AI识别进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(detectionProgress.progress)}><div className="flex items-center justify-between gap-4 text-xs"><span className="font-bold text-blue-700">{detectionProgress.message}</span><span className="tabular-nums text-blue-600">{Math.round(detectionProgress.progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width] duration-500 ease-out" style={{ width: `${detectionProgress.progress}%` }}/></div></div>}
    {loading ? <div className="flex flex-1 items-center justify-center gap-2 text-slate-500"><Loader2 size={19} className="animate-spin"/>正在读取 Patch 数据库…</div> : <div className="grid min-h-0 flex-1 grid-cols-[minmax(380px,0.9fr)_minmax(520px,1.1fr)]">
      <section className="min-h-0 overflow-auto border-r border-slate-200 bg-slate-950 p-4">
        <div className="relative mx-auto flex min-h-[520px] max-w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black">
          {previewUrl ? <svg className="max-h-[calc(100vh-190px)] w-full" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet"><image href={previewUrl} width={imageSize.width} height={imageSize.height} onLoad={() => { const image = new Image(); image.onload = () => setImageSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 }); image.src = previewUrl; }}/>{tasks.map((task, index) => <g key={task.id}><rect x={task.crop.x} y={task.crop.y} width={task.crop.width} height={task.crop.height} fill="rgba(59,130,246,.06)" stroke={task.editedPatchPath ? '#34d399' : '#60a5fa'} strokeWidth={Math.max(3, imageSize.width / 900)}/>{(task.members?.length ? task.members : [{ personIndex: task.personIndex, bbox: task.bbox }]).map(member => <rect key={member.personIndex} x={member.bbox.x} y={member.bbox.y} width={member.bbox.width} height={member.bbox.height} fill="none" stroke="#fbbf24" strokeWidth={Math.max(2, imageSize.width / 1300)}/>) }<text x={task.crop.x + 10} y={task.crop.y + 28} fill="white" fontSize={Math.max(20, imageSize.width / 85)} fontWeight="700" paintOrder="stroke" stroke="rgba(0,0,0,.75)" strokeWidth="5">{index + 1} · {task.personName}</text></g>)}</svg> : <div className="flex flex-col items-center gap-3 text-slate-500"><ScanFace size={36}/><span>正在加载原图</span></div>}
        </div>
        <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-400"><Sparkles size={14} className="mr-1 inline text-violet-400"/>蓝框是优先按 2:3 或 3:2 规划的工作图，黄框是其中包含的人物。相邻的 2～3 人会尽量共用一张图；人物超过 4000 像素时，会按设置选择以脸为中心保留 4000 像素，或扩大裁剪保留完整人物。</div>
      </section>
      <section className="min-h-0 overflow-y-auto p-5">
        {!tasks.length ? <div className="flex h-full min-h-96 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center"><span className="rounded-2xl bg-violet-50 p-4 text-violet-600"><ScanFace size={32}/></span><h3 className="mt-4 text-lg font-bold text-slate-800">先让AI识别人</h3><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">AI会找出图片里的人，再规划尽量少的工作图。相邻人物可以共用一张，手机修完后逐张上传，系统会自动合回原尺寸。</p><button disabled={Boolean(busy)} onClick={() => void detect()} className="dialog-primary mt-5 inline-flex items-center gap-2"><ScanFace size={16}/>AI识别并规划工作图</button></div> : <div className="grid gap-4 xl:grid-cols-2">{tasks.map(task => <article key={task.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><header className="flex items-start gap-3"><span className={`rounded-full p-2 ${task.needsReview ? 'bg-amber-50 text-amber-600' : task.editedPatchPath ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>{task.needsReview ? <AlertTriangle size={17}/> : task.editedPatchPath ? <CheckCircle2 size={17}/> : <UserRound size={17}/>}</span><div className="min-w-0 flex-1"><input defaultValue={task.personName} onBlur={event => { if (event.target.value.trim() !== task.personName) void updateTask(task, { personName: event.target.value }); }} className="w-full rounded border border-transparent px-1 py-0.5 font-bold text-slate-800 outline-none hover:border-slate-200 focus:border-blue-400"/><p className="px-1 text-[10px] text-slate-400">包含 {Math.max(1, task.members?.length || 0)} 人 · {task.crop.width}×{task.crop.height}px</p><input defaultValue={task.assignee} onBlur={event => { if (event.target.value.trim() !== task.assignee) void updateTask(task, { assignee: event.target.value }); }} placeholder="填写接收人姓名" className="mt-1 w-full rounded border border-transparent px-1 py-0.5 text-xs text-slate-500 outline-none hover:border-slate-200 focus:border-blue-400"/></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${task.needsReview ? 'bg-amber-50 text-amber-600' : task.status === 'merged' ? 'bg-violet-50 text-violet-600' : task.editedPatchPath ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>{statusLabel(task)}</span></header>{task.reviewReason && <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-700">{task.reviewReason}</p>}<div className={`mt-3 grid gap-2 ${task.editedPatchPath ? 'grid-cols-2' : 'grid-cols-1'}`}><PatchImage path={task.patchPath} cacheConfig={cacheConfig} label="原始工作图"/>{task.editedPatchPath && <PatchImage path={task.editedPatchPath} cacheConfig={cacheConfig} label="手机回传"/>}</div><div className="mt-3 flex flex-wrap gap-2"><button disabled={task.patchMissing} onClick={() => void openPatch(task)} className="dialog-secondary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-45"><ExternalLink size={14}/>{task.patchMissing ? '工作图文件缺失' : '打开交付文件'}</button>{task.needsReview && <button disabled={Boolean(busy)} onClick={() => void updateTask(task, { needsReview: false, reviewReason: '' })} className="dialog-secondary inline-flex items-center gap-2"><CheckCircle2 size={14}/>确认人物与范围</button>}<button disabled={Boolean(busy) || task.patchMissing} onClick={() => void upload(task)} className="dialog-primary inline-flex items-center gap-2">{busy === task.id ? <Loader2 size={14} className="animate-spin"/> : <Upload size={14}/>} {task.editedPatchPath ? '重新上传' : '上传修图结果'}</button></div><p className="mt-3 text-[10px] text-slate-400">Patch ID：<span className="font-mono">{task.id}</span></p></article>)}</div>}
      </section>
    </div>}
  </div>;
};

type BatchResult = {
  relativePath: string;
  name: string;
  success: boolean;
  personCount?: number;
  workTileCount?: number;
  error?: string;
};

const BatchTeamRetouchManager = ({ entries, workspacePath, project, onClose, onNotice, onOpen }: Props & { onOpen: (entry: ProjectFileEntry) => void }) => {
  const [running, setRunning] = useState(false);
  const [returning, setReturning] = useState(false);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [returnResult, setReturnResult] = useState<TeamPatchReturnBatchResult | null>(null);
  const [progress, setProgress] = useState({ itemIndex: 0, itemCount: entries.length, progress: 0, itemName: '', message: '准备批量识别' });
  const [returnProgress, setReturnProgress] = useState({ phase: '', progress: 0, message: '准备接收返回图片' });

  useEffect(() => window.electronAPI.onTeamPatchBatchProgress(value => {
    setProgress({ itemIndex: value.itemIndex, itemCount: value.itemCount, progress: value.progress, itemName: value.itemName, message: value.message });
  }), []);

  useEffect(() => window.electronAPI.onTeamPatchReturnBatchProgress(value => {
    setReturnProgress({ phase: value.phase, progress: value.progress, message: value.message });
  }), []);

  const runBatch = async () => {
    setRunning(true);
    setResults([]);
    setProgress({ itemIndex: 0, itemCount: entries.length, progress: 0, itemName: '', message: '正在启动批量推理服务' });
    const result = await window.electronAPI.detectTeamPatchBatch(workspacePath, project.status, project.name, { relativePaths: entries.map(entry => entry.relativePath) });
    setRunning(false);
    setResults(result.results || []);
    if (!result.success) {
      onNotice(`批量多人修脸失败：${result.error || '未知错误'}`);
      return;
    }
    const successCount = result.results.filter(item => item.success).length;
    onNotice(`批量识别完成：${successCount}/${entries.length} 张成功；推理服务已关闭并释放显存`);
  };

  const receiveBatch = async () => {
    setReturning(true);
    setReturnResult(null);
    setReturnProgress({ phase: 'matching', progress: 0, message: '请选择手机返回的全部修图结果' });
    const result = await window.electronAPI.returnTeamPatchBatch(workspacePath, project.status, project.name, { relativePaths: entries.map(entry => entry.relativePath) });
    setReturning(false);
    if (result.cancelled) return;
    setReturnResult(result);
    if (!result.success) {
      onNotice(`批量回传失败：${result.error || '未知错误'}`);
      return;
    }
    onNotice(`批量回传完成：自动接收 ${result.acceptedCount || 0} 张，合成 ${result.mergedCount || 0} 张团片，${result.reviewCount || 0} 项需要处理`);
  };

  const overallProgress = progress.itemCount
    ? Math.max(0, Math.min(100, ((Math.max(1, progress.itemIndex) - 1) + progress.progress / 100) / progress.itemCount * 100))
    : 0;
  const resultByPath = new Map(results.map(result => [result.relativePath, result]));

  return <div className="fixed inset-x-0 bottom-0 top-10 z-[310] flex flex-col bg-slate-50">
    <header className="flex min-h-16 items-center gap-3 border-b border-slate-200 bg-white px-5 py-3"><span className="rounded-xl bg-violet-50 p-2 text-violet-600"><UsersRound size={20}/></span><div><h2 className="font-bold text-slate-900">批量多人修脸 · {entries.length} 张图片</h2><p className="mt-0.5 text-xs text-slate-500">批量裁切后，可以一次提交手机返回的全部图片，由内容自动匹配并合成。</p></div><div className="ml-auto flex gap-2"><button disabled={running || returning} onClick={() => void runBatch()} className="dialog-secondary inline-flex items-center gap-2">{running ? <Loader2 size={15} className="animate-spin"/> : <ScanFace size={15}/>} {results.length ? '重新批量识别' : '开始批量识别'}</button><button disabled={running || returning} onClick={() => void receiveBatch()} className="dialog-primary inline-flex items-center gap-2">{returning ? <Loader2 size={15} className="animate-spin"/> : <Upload size={15}/>}批量提交返回图并合成</button><button disabled={running || returning} onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-40"><X size={20}/></button></div></header>
    {running && <div className="border-b border-blue-100 bg-blue-50 px-5 py-3"><div className="flex items-center justify-between gap-4 text-xs"><span className="font-bold text-blue-700">{progress.itemIndex ? `${progress.itemIndex}/${progress.itemCount} · ${progress.itemName} · ` : ''}{progress.message}</span><span className="tabular-nums text-blue-600">{Math.round(overallProgress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width] duration-500" style={{ width: `${overallProgress}%` }}/></div></div>}
    {returning && <div className="border-b border-emerald-100 bg-emerald-50 px-5 py-3"><div className="flex items-center justify-between gap-4 text-xs"><span className="font-bold text-emerald-700">{returnProgress.message}</span><span className="tabular-nums text-emerald-600">{Math.round(returnProgress.progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-emerald-100"><div className="h-full rounded-full bg-emerald-600 transition-[width] duration-500" style={{ width: `${returnProgress.progress}%` }}/></div></div>}
    <main className="min-h-0 flex-1 overflow-y-auto p-6"><div className="mx-auto max-w-5xl space-y-4">
      {returnResult?.success && <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"><header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3"><div><h3 className="text-sm font-bold text-slate-800">本次批量回传</h3><p className="mt-0.5 text-xs text-slate-500">高置信度结果已自动入库；只有工作图全部齐全的团片才会自动合成。</p></div><div className="ml-auto flex gap-2 text-xs font-bold"><span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">已接收 {returnResult.acceptedCount || 0}</span><span className="rounded-full bg-violet-50 px-3 py-1 text-violet-700">已合成 {returnResult.mergedCount || 0}</span><span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">待处理 {returnResult.reviewCount || 0}</span></div></header><div className="max-h-72 overflow-y-auto">{returnResult.matches.map(match => <div key={match.returnId} className="grid grid-cols-[minmax(140px,1fr)_24px_minmax(180px,1.2fr)_100px] items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-xs last:border-0"><span className="truncate font-medium text-slate-700" title={match.sourceName}>{match.sourceName}</span><span className="text-center text-slate-300">→</span><span className="truncate text-slate-600">{match.matched ? `${match.photoName} · ${match.personName}` : '未找到候选'}</span><span className={`justify-self-end rounded-full px-2.5 py-1 font-bold ${match.accepted ? 'bg-emerald-50 text-emerald-700' : match.confidence === 'medium' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-600'}`}>{match.accepted ? `自动匹配 ${Math.round(match.score * 100)}%` : '需要确认'}</span></div>)}</div>{Boolean(returnResult.missingTaskCount) && <p className="border-t border-amber-100 bg-amber-50 px-4 py-2.5 text-xs text-amber-700">还有 {returnResult.missingTaskCount} 张原始工作图没有收到对应返回图。</p>}{returnResult.merges.some(item => !item.success) && <div className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">{returnResult.merges.filter(item => !item.success).map(item => <p key={item.photoId}>{item.photoName}：{item.error || '未自动合成'}</p>)}</div>}</section>}
      {returnResult && !returnResult.success && <section className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{returnResult.error || '批量回传失败'}</section>}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">{entries.map((entry, index) => { const result = resultByPath.get(entry.relativePath); return <div key={entry.relativePath} className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0"><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${result?.success ? 'bg-emerald-50 text-emerald-600' : result ? 'bg-red-50 text-red-500' : running && progress.itemIndex === index + 1 ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>{running && progress.itemIndex === index + 1 ? <Loader2 size={15} className="animate-spin"/> : result?.success ? <CheckCircle2 size={16}/> : result ? <X size={15}/> : index + 1}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-800">{entry.name}</p><p className={`mt-0.5 truncate text-xs ${result && !result.success ? 'text-red-500' : 'text-slate-400'}`}>{result?.success ? `识别 ${result.personCount || 0} 人 · 生成 ${result.workTileCount || 0} 张工作图` : result?.error || (running && progress.itemIndex === index + 1 ? progress.message : '可批量识别，或直接接收已有裁切任务的返回图')}</p></div>{result?.success && <button onClick={() => onOpen(entry)} className="dialog-secondary">查看与上传</button>}</div>; })}</div><p className="text-xs leading-5 text-slate-500">自动比对不依赖文件名和元数据；系统使用画面结构与局部特征做整批一一匹配。相似结果会留给人工确认，不会冒险合成。</p>
    </div></main>
  </div>;
};

export const TeamRetouchManager = (props: Props) => {
  const [activeEntry, setActiveEntry] = useState<ProjectFileEntry | null>(props.entries.length === 1 ? props.entries[0] : null);
  if (activeEntry) return <SingleTeamRetouchManager {...props} entry={activeEntry} onClose={() => props.entries.length > 1 ? setActiveEntry(null) : props.onClose()}/>;
  return <BatchTeamRetouchManager {...props} onOpen={setActiveEntry}/>;
};
