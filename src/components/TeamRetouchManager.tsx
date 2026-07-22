import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, ScanFace, Sparkles, Upload, UserRound, UsersRound, Wand2, X } from 'lucide-react';
import type { AppConfig, MediaVersion, ProjectFileEntry, TeamPatchBundle, TeamPatchTask, WorkspaceProject } from '../types';

type Props = {
  entry: ProjectFileEntry;
  workspacePath: string;
  project: WorkspaceProject;
  cacheConfig: AppConfig['mediaCache'];
  onClose: () => void;
  onNotice: (message: string) => void;
};

const PatchImage = ({ path, cacheConfig, label }: { path?: string; cacheConfig: AppConfig['mediaCache']; label: string }) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    setUrl('');
    if (!path) return () => { active = false; };
    window.electronAPI.getMediaOriginal(path, 'image', cacheConfig).then(result => {
      if (active && result.success && result.mediaUrl) setUrl(result.mediaUrl);
    });
    return () => { active = false; };
  }, [path, cacheConfig.directory, cacheConfig.maxSizeGB]);
  return <div className="relative flex min-h-36 items-center justify-center overflow-hidden rounded-lg bg-slate-950">
    {url ? <img src={url} alt={label} className="h-44 w-full object-contain"/> : <UserRound size={25} className="text-slate-500"/>}
    <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[10px] font-bold text-white">{label}</span>
  </div>;
};

const statusLabel = (task: TeamPatchTask) => task.status === 'merged' ? '已合回' : task.editedPatchPath ? '已上传' : '等待手机修图';

export const TeamRetouchManager = ({ entry, workspacePath, project, cacheConfig, onClose, onNotice }: Props) => {
  const [bundle, setBundle] = useState<TeamPatchBundle>({ success: true, versions: [], tasks: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'detect' | 'merge' | string>('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [baseVersionId, setBaseVersionId] = useState('');

  const load = async () => {
    setLoading(true);
    const result = await window.electronAPI.getTeamPatches(workspacePath, project.status, project.name, entry.relativePath);
    setLoading(false);
    if (!result.success) { onNotice(`打开多人修脸失败：${result.error || '未知错误'}`); onClose(); return; }
    setBundle(result);
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
    if (tasks.length && !window.confirm('重新检测会替换当前基础版本下的任务清单，确定继续吗？')) return;
    setBusy('detect');
    const result = await window.electronAPI.detectTeamPatchPeople(workspacePath, project.status, project.name, { photoId: bundle.photo.id, baseVersionId: baseVersion.id });
    setBusy('');
    if (!result.success) { onNotice(`人物检测失败：${result.error || '未知错误'}`); return; }
    setBundle(result);
    if (!result.tasks.length) onNotice('没有可靠检测到人物；建议换用正面清晰的成片，后续版本会补手动画框。');
    else onNotice(`已检测 ${result.tasks.length} 个人物并生成带重叠保护区的无损 Patch`);
  };

  const updateTask = async (task: TeamPatchTask, changes: { personName?: string; assignee?: string }) => {
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

  const merge = async () => {
    if (!bundle.photo || !baseVersion) return;
    const uploaded = bundle.tasks.filter(task => task.editedPatchPath).length;
    if (!uploaded) { onNotice('请先上传至少一个人物的修图结果'); return; }
    const nextNumber = Math.max(-1, ...bundle.versions.map(version => version.versionNumber)) + 1;
    const versionName = window.prompt('合成后的版本名称', `多人修脸合成 V${nextNumber}`)?.trim();
    if (!versionName) return;
    setBusy('merge');
    const result = await window.electronAPI.mergeTeamPatches(workspacePath, project.status, project.name, { photoId: bundle.photo.id, baseVersionId: baseVersion.id, versionName });
    setBusy('');
    if (!result.success) { onNotice(`自动回拼失败：${result.error || '未知错误'}`); return; }
    setBundle(result);
    const conflict = result.merge?.conflictPixels || 0;
    onNotice(result.merge?.needsReview ? `已生成 V${result.versions.at(-1)?.versionNumber}；检测到 ${conflict} 个显著重叠冲突像素，请进行版本对比复核` : `已无缝回拼并生成 V${result.versions.at(-1)?.versionNumber}`);
  };

  const uploadedCount = tasks.filter(task => task.editedPatchPath).length;
  const mergedCount = tasks.filter(task => task.status === 'merged').length;

  return <div className="fixed inset-x-0 bottom-0 top-10 z-[310] flex flex-col bg-slate-50">
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
      <div className="flex min-w-0 items-center gap-3"><span className="rounded-xl bg-violet-50 p-2 text-violet-600"><UsersRound size={20}/></span><div className="min-w-0"><h2 className="truncate font-bold text-slate-900">多人修脸 · {bundle.photo?.displayName || entry.name}</h2><p className="mt-0.5 truncate text-xs text-slate-500">每个人只拿到自己的无损重叠裁片；回传后自动对齐、校色并合回原分辨率。</p></div></div>
      <div className="ml-auto flex items-center gap-2"><select aria-label="基础版本" value={baseVersion?.id || ''} onChange={event => setBaseVersionId(event.target.value)} disabled={Boolean(busy)} className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-bold text-slate-700">{bundle.versions.filter(version => !version.fileMissing).map(version => <option key={version.id} value={version.id}>基础 V{version.versionNumber} · {version.versionName}</option>)}</select><button disabled={!baseVersion || Boolean(busy)} onClick={() => void detect()} className="dialog-secondary inline-flex items-center gap-2">{busy === 'detect' ? <Loader2 size={15} className="animate-spin"/> : tasks.length ? <RefreshCw size={15}/> : <ScanFace size={15}/>} {tasks.length ? '重新检测' : 'AI 检测人物'}</button><button disabled={!uploadedCount || Boolean(busy)} onClick={() => void merge()} className="dialog-primary inline-flex items-center gap-2">{busy === 'merge' ? <Loader2 size={15} className="animate-spin"/> : <Wand2 size={15}/>}自动合回 8K</button><button onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><X size={20}/></button></div>
    </header>
    <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-5 py-2 text-xs"><span className="rounded-full bg-blue-50 px-3 py-1 font-bold text-blue-600">1 检测 {tasks.length}</span><span className="text-slate-300">→</span><span className={`rounded-full px-3 py-1 font-bold ${uploadedCount ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>2 手机回传 {uploadedCount}/{tasks.length}</span><span className="text-slate-300">→</span><span className={`rounded-full px-3 py-1 font-bold ${mergedCount ? 'bg-violet-50 text-violet-600' : 'bg-slate-100 text-slate-400'}`}>3 合回版本 {mergedCount ? '完成' : '待处理'}</span><span className="ml-auto text-slate-400">基础：{baseVersion ? `V${baseVersion.versionNumber} · ${baseVersion.versionName}` : '读取中'}</span></div>
    {loading ? <div className="flex flex-1 items-center justify-center gap-2 text-slate-500"><Loader2 size={19} className="animate-spin"/>正在读取 Patch 数据库…</div> : <div className="grid min-h-0 flex-1 grid-cols-[minmax(380px,0.9fr)_minmax(520px,1.1fr)]">
      <section className="min-h-0 overflow-auto border-r border-slate-200 bg-slate-950 p-4">
        <div className="relative mx-auto flex min-h-[520px] max-w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black">
          {previewUrl ? <svg className="max-h-[calc(100vh-190px)] w-full" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet"><image href={previewUrl} width={imageSize.width} height={imageSize.height} onLoad={() => { const image = new Image(); image.onload = () => setImageSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 }); image.src = previewUrl; }}/>{tasks.map((task, index) => <g key={task.id}><rect x={task.crop.x} y={task.crop.y} width={task.crop.width} height={task.crop.height} fill="rgba(59,130,246,.06)" stroke={task.editedPatchPath ? '#34d399' : '#60a5fa'} strokeWidth={Math.max(3, imageSize.width / 900)}/><rect x={task.bbox.x} y={task.bbox.y} width={task.bbox.width} height={task.bbox.height} fill="none" stroke="#fbbf24" strokeWidth={Math.max(2, imageSize.width / 1300)}/><text x={task.crop.x + 10} y={task.crop.y + 28} fill="white" fontSize={Math.max(20, imageSize.width / 85)} fontWeight="700" paintOrder="stroke" stroke="rgba(0,0,0,.75)" strokeWidth="5">{index + 1} · {task.personName}</text></g>)}</svg> : <div className="flex flex-col items-center gap-3 text-slate-500"><ScanFace size={36}/><span>正在加载原图</span></div>}
        </div>
        <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-400"><Sparkles size={14} className="mr-1 inline text-violet-400"/>蓝框是交付裁片，黄框是检测到的人物区域。蓝框预留大面积上下文与羽化边界，手机软件即使压缩整张裁片，也不会直接把压缩边缘贴回原图。</div>
      </section>
      <section className="min-h-0 overflow-y-auto p-5">
        {!tasks.length ? <div className="flex h-full min-h-96 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center"><span className="rounded-2xl bg-violet-50 p-4 text-violet-600"><ScanFace size={32}/></span><h3 className="mt-4 text-lg font-bold text-slate-800">从人物检测开始</h3><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">系统会按人物生成 PNG 无损裁片和坐标清单。将裁片发给对应的人，他们用手机修完后在这里逐个上传。</p><button disabled={Boolean(busy)} onClick={() => void detect()} className="dialog-primary mt-5 inline-flex items-center gap-2"><ScanFace size={16}/>AI 检测人物</button></div> : <div className="grid gap-4 xl:grid-cols-2">{tasks.map(task => <article key={task.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><header className="flex items-start gap-3"><span className={`rounded-full p-2 ${task.editedPatchPath ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>{task.editedPatchPath ? <CheckCircle2 size={17}/> : <UserRound size={17}/>}</span><div className="min-w-0 flex-1"><input defaultValue={task.personName} onBlur={event => { if (event.target.value.trim() !== task.personName) void updateTask(task, { personName: event.target.value }); }} className="w-full rounded border border-transparent px-1 py-0.5 font-bold text-slate-800 outline-none hover:border-slate-200 focus:border-blue-400"/><input defaultValue={task.assignee} onBlur={event => { if (event.target.value.trim() !== task.assignee) void updateTask(task, { assignee: event.target.value }); }} placeholder="填写接收人姓名" className="mt-1 w-full rounded border border-transparent px-1 py-0.5 text-xs text-slate-500 outline-none hover:border-slate-200 focus:border-blue-400"/></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${task.status === 'merged' ? 'bg-violet-50 text-violet-600' : task.editedPatchPath ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>{statusLabel(task)}</span></header><div className={`mt-3 grid gap-2 ${task.editedPatchPath ? 'grid-cols-2' : 'grid-cols-1'}`}><PatchImage path={task.patchPath} cacheConfig={cacheConfig} label="原始裁片"/>{task.editedPatchPath && <PatchImage path={task.editedPatchPath} cacheConfig={cacheConfig} label="手机回传"/>}</div><div className="mt-3 flex flex-wrap gap-2"><button onClick={() => void window.electronAPI.openTeamPatch(task.patchPath)} className="dialog-secondary inline-flex items-center gap-2"><ExternalLink size={14}/>打开交付文件</button><button disabled={Boolean(busy)} onClick={() => void upload(task)} className="dialog-primary inline-flex items-center gap-2">{busy === task.id ? <Loader2 size={14} className="animate-spin"/> : <Upload size={14}/>} {task.editedPatchPath ? '重新上传' : '上传修图结果'}</button></div><p className="mt-3 text-[10px] text-slate-400">Patch ID：<span className="font-mono">{task.id}</span></p></article>)}</div>}
      </section>
    </div>}
  </div>;
};
