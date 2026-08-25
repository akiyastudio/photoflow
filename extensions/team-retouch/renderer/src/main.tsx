/* eslint-disable react-refresh/only-export-components -- this is a packaged single-entry component renderer */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import './style.css';
import { notify, rpc, type ComponentContext } from './sdk';
import { clampCrop, clampZoom, expandCrop, fitCropToMembers, normalizeRotation, progressCandidates, rankIdentityCandidates, resizeCrop, returnCandidates, returnReviewItems, shouldBlink, subjectsFromWorkspace, taskMembers, workflowGroups, type CompareMode, type Crop, type CropHandle, type Json, type Tab } from './interaction-model';

type Settings = { useGpu: boolean; oversizeCropMode: 'face-centered' | 'expand' };
type Progress = { progress: number; message: string; operationId?: string };
const EMPTY_WORKSPACE = { photos: [], identities: [], assignments: [] };
const TABS: Array<[Tab, string, string]> = [['detect', '检测与裁剪', '1'], ['people', '人物身份', '2'], ['workflow', '工作流', '3'], ['returns', '返图审核', '4'], ['merge', '合并输出', '5'], ['settings', '设置', '6']];
const imageFile = (entry: Json) => entry.kind === 'image' || /\.(jpe?g|png|tiff?|heic|webp|dng|cr[23]|nef|arw|raf)$/i.test(entry.name || entry.relativePath || '');
const relativePathOf = (entry: Json) => String(entry.relativePath || entry.path || '');
const assertSuccess = (value: Json, fallback: string) => { if (value?.success === false) throw new Error(value.error || fallback); return value; };
type MediaRef = { kind: 'original' | 'working' | 'returned' | 'review-return'; photoId?: string; baseVersionId?: string; taskId?: string; reviewSessionId?: string; returnId?: string };

function useEscape(active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, close]);
}

function Dialog({ title, children, close, wide = false }: { title: string; children: React.ReactNode; close: () => void; wide?: boolean }) {
  useEscape(true, close);
  const titleId = useMemo(() => `dialog-${crypto.randomUUID()}`, []);
  return createPortal(<div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby={titleId} className={`dialog ${wide ? 'wide' : ''}`}>
      <header><h2 id={titleId}>{title}</h2><button className="icon-btn" aria-label="关闭" onClick={close}>×</button></header>{children}
    </section>
  </div>, document.body);
}

function ConfirmDialog({ title, message, confirmLabel = '确认', danger = false, close, confirm }: { title: string; message: string; confirmLabel?: string; danger?: boolean; close: () => void; confirm: () => void }) {
  return <Dialog title={title} close={close}><div className="dialog-body"><p>{message}</p></div><footer><button className="btn" onClick={close}>取消</button><button className={`btn ${danger ? 'danger-solid' : 'primary'}`} onClick={confirm}>{confirmLabel}</button></footer></Dialog>;
}

function useAuthorizedMedia(media: MediaRef | undefined, enabled: boolean, variant: 'preview' | 'original' = 'preview') {
  const [source, setSource] = useState('');
  const key = JSON.stringify(media || {});
  useEffect(() => {
    let mounted = true; setSource('');
    if (!enabled || !media) return () => { mounted = false; };
    void rpc<Json>('team.media.authorize.v1', { ...media, variant }).then(result => { if (mounted && result.success !== false && /^photoflow-media:/i.test(String(result.url || ''))) setSource(String(result.url)); }).catch(() => undefined);
    return () => { mounted = false; };
  }, [enabled, key, variant]);
  return source;
}

function ImagePreview({ media, alt, enabled, overlay, imageStyle }: { media?: MediaRef; alt: string; enabled: boolean; overlay?: React.ReactNode; imageStyle?: React.CSSProperties }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enabled) { setVisible(false); return; }
    const node = ref.current;
    if (!node || !('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } }, { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, JSON.stringify(media || {})]);
  const src = useAuthorizedMedia(media, enabled && visible);
  return <div ref={ref} className="preview">{src ? <img src={src} alt={alt} loading="lazy" style={imageStyle}/> : <div className="preview-placeholder"><span>▧</span><small>{enabled ? '预览由宿主按 ID 授权' : '页面已暂停'}</small></div>}{overlay}</div>;
}

function CropEditor({ photo, task, active, close, save }: { photo: Json; task: Json; active: boolean; close: () => void; save: (crop: Crop) => void }) {
  const bounds = { width: Number(task.sourceWidth || task.maskWidth || photo.width || Number(task.mask?.width || 0) * Number(task.mask?.scale || 0) || task.crop?.width || 1), height: Number(task.sourceHeight || task.maskHeight || photo.height || Number(task.mask?.height || 0) * Number(task.mask?.scale || 0) || task.crop?.height || 1) };
  const [crop, setCrop] = useState<Crop>(() => clampCrop(task.crop || { x: 0, y: 0, ...bounds }, bounds));
  const source = useAuthorizedMedia({ kind: 'original', photoId: photo.photoId, baseVersionId: photo.baseVersionId }, active, 'original');
  const drag = useRef<{ x: number; y: number; crop: Crop; handle: CropHandle }>();
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setCrop(resizeCrop(drag.current.crop, drag.current.handle, (event.clientX - drag.current.x) * bounds.width / rect.width, (event.clientY - drag.current.y) * bounds.height / rect.height, bounds));
  };
  const start = (event: ReactPointerEvent<SVGElement>, handle: CropHandle) => { event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, crop, handle }; };
  const handles: Array<[Exclude<CropHandle, 'move'>, number, number]> = [['nw', crop.x, crop.y], ['n', crop.x + crop.width / 2, crop.y], ['ne', crop.x + crop.width, crop.y], ['e', crop.x + crop.width, crop.y + crop.height / 2], ['se', crop.x + crop.width, crop.y + crop.height], ['s', crop.x + crop.width / 2, crop.y + crop.height], ['sw', crop.x, crop.y + crop.height], ['w', crop.x, crop.y + crop.height / 2]];
  return <Dialog title={`可视化裁剪 · ${photo.name || photo.displayName || photo.photoId}`} close={close} wide><div className="dialog-body crop-layout">
    <div className="crop-canvas"><svg viewBox={`0 0 ${bounds.width} ${bounds.height}`} aria-label="拖动裁剪框和八个控制点调整范围" onPointerMove={move} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}><rect width={bounds.width} height={bounds.height} fill="#101828"/>{source && <image href={source} width={bounds.width} height={bounds.height} preserveAspectRatio="none"/>}<rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} className="crop-box" onPointerDown={event => start(event, 'move')}/>{handles.map(([handle, x, y]) => <rect key={handle} data-crop-handle={handle} aria-label={`${handle} 裁剪控制点`} x={x - 7} y={y - 7} width="14" height="14" className={`crop-handle handle-${handle}`} onPointerDown={event => start(event, handle)}/>) }{taskMembers(task).map((member: Json) => <rect key={member.personIndex} x={member.bbox?.x || 0} y={member.bbox?.y || 0} width={member.bbox?.width || 1} height={member.bbox?.height || 1} className="person-box"/> )}</svg></div>
    <div className="crop-fields">{(['x', 'y', 'width', 'height'] as const).map(field => <label className="field" key={field}><span>{field}</span><input type="number" min={field === 'width' || field === 'height' ? 1 : 0} max={field === 'x' || field === 'width' ? bounds.width : bounds.height} value={crop[field]} onChange={event => setCrop(clampCrop({ ...crop, [field]: Number(event.target.value) }, bounds))}/></label>)}<div className="row"><button className="btn" onClick={() => setCrop(expandCrop(crop, bounds))}>四边扩展 10%</button><button className="btn" onClick={() => setCrop(fitCropToMembers(taskMembers(task), bounds))}>一键完整包人</button></div><p className="hint">拖动蓝框移动；八个控制点支持四角缩放和四边扩展；黄色框为人物。</p></div>
  </div><footer><button className="btn" onClick={close}>取消</button><button className="btn primary" onClick={() => save(crop)}>保存裁剪</button></footer></Dialog>;
}

function DetectionPanel({ files, workspace, active, busy, run, refresh }: PanelProps & { files: Json[]; refresh: () => Promise<void> }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState('');
  const [bundle, setBundle] = useState<Json>();
  const [cropTarget, setCropTarget] = useState<{ photo: Json; task: Json }>();
  const photos = workspace.photos || [];
  const toggle = (path: string) => setSelected(current => current.includes(path) ? current.filter(item => item !== path) : [...current, path]);
  const detect = (paths: string[], restoreExcluded = false) => run(paths.length === 1 ? '正在检测单张图片' : `正在检测 ${paths.length} 张图片`, async () => {
    if (!paths.length) throw new Error('请选择图片');
    assertSuccess(await rpc<Json>('team.project.register.v1', { relativePaths: paths }), '登记团片失败');
    if (paths.length === 1) {
      const photo = photos.find((item: Json) => item.relativePath === paths[0]);
      if (photo) assertSuccess(await rpc<Json>('team.patch.detect.v1', { photoId: photo.photoId, baseVersionId: photo.baseVersionId, restoreExcluded }), '检测失败');
      else assertSuccess(await rpc<Json>('team.patch.detect-batch.v1', { relativePaths: paths }), '检测失败');
    } else assertSuccess(await rpc<Json>('team.patch.detect-batch.v1', { relativePaths: paths }), '批量检测失败');
    await refresh();
  });
  const open = async (photo: Json) => {
    setExpanded(String(photo.photoId));
    const result = await rpc<Json>('team.patch.get.v1', { relativePath: photo.relativePath });
    setBundle(assertSuccess(result, '无法读取工作图'));
  };
  return <div className="grid">
    <section className="card third"><h2>项目图片</h2><div className="metric">{files.length}</div><p className="hint">选择后可单图或批量检测。</p></section>
    <section className="card third"><h2>已检测</h2><div className="metric">{photos.length}</div><p className="hint">原图与工作图进入视口后才加载。</p></section>
    <section className="card third"><h2>检测操作</h2><div className="row"><button className="btn primary" disabled={busy || !selected.length} onClick={() => detect(selected)}>检测所选</button><button className="btn" disabled={busy || !files.length} onClick={() => detect(files.map(relativePathOf).filter(Boolean))}>检测全部</button></div></section>
    <section className="card half"><h2>选择项目图片</h2><div className="list compact">{files.map(file => { const path = relativePathOf(file); return <label className="check-row" key={path}><input type="checkbox" checked={selected.includes(path)} onChange={() => toggle(path)}/><span>{file.name || path}</span><button type="button" className="text-btn" disabled={busy} onClick={event => { event.preventDefault(); void detect([path]); }}>检测此图</button></label>; })}</div></section>
    <section className="card half"><h2>检测结果与工作图</h2><div className="list">{photos.length ? photos.map((photo: Json) => <div className="photo-result" key={`${photo.photoId}:${photo.baseVersionId}`}><button className="result-head" aria-expanded={expanded === String(photo.photoId)} onClick={() => void open(photo)}><span><strong>{photo.name || photo.displayName || photo.photoId}</strong><small>{photo.tasks?.length || 0} 个工作图 · 排除 {photo.excludedPersonCount || 0} 人</small></span><span>›</span></button>{expanded === String(photo.photoId) && <><div className="task-grid"><ImagePreview enabled={active} media={{ kind: 'original', photoId: photo.photoId, baseVersionId: photo.baseVersionId }} alt="原图预览"/>{(bundle?.tasks || photo.tasks || []).map((task: Json) => <article className="task-card" key={task.id}><ImagePreview enabled={active} media={{ kind: 'working', photoId: photo.photoId, baseVersionId: photo.baseVersionId, taskId: task.id }} alt={`工作图 ${task.id}`}/><strong>人物 {taskMembers(task).map((item: Json) => item.personIndex).join('、')}</strong><div className="row"><button className="btn" onClick={() => setCropTarget({ photo, task })}>调整裁剪</button><button className="btn" onClick={() => void run('打开工作图', async () => { assertSuccess(await rpc<Json>('team.patch.open.v1', { photoId: photo.photoId, baseVersionId: photo.baseVersionId, taskId: task.id }), '打开失败'); })}>打开工作图</button><button className="btn" onClick={() => void run('更新工作图', async () => { assertSuccess(await rpc<Json>('team.patch.update.v1', { photoId: photo.photoId, taskId: task.id, crop: task.crop, needsReview: !task.needsReview }), '更新失败'); await refresh(); })}>{task.needsReview ? '标记已复核' : '需要复核'}</button><button className="btn danger" onClick={() => void run('移除工作图', async () => { assertSuccess(await rpc<Json>('team.patch.delete.v1', { photoId: photo.photoId, taskId: task.id }), '移除失败'); await refresh(); })}>移除</button></div></article>)}</div><div className="row result-actions"><button className="btn" disabled={!photo.excludedPersonCount} onClick={() => void detect([photo.relativePath], true)}>恢复已排除人物并重检</button><button className="btn danger" onClick={() => void run('移出团片项目', async () => { assertSuccess(await rpc<Json>('team.project.remove-photo.v1', { photoId: photo.photoId, baseVersionId: photo.baseVersionId }), '移除失败'); })}>移出团片项目</button></div></>}</div>) : <Empty text="尚未检测图片"/>}</div></section>
    {cropTarget && <CropEditor {...cropTarget} active={active} close={() => setCropTarget(undefined)} save={crop => void run('保存裁剪', async () => { assertSuccess(await rpc<Json>('team.patch.update.v1', { photoId: cropTarget.photo.photoId, taskId: cropTarget.task.id, crop }), '保存裁剪失败'); setCropTarget(undefined); await refresh(); })}/>}
  </div>;
}

type PanelProps = { workspace: Json; active: boolean; busy: boolean; run: (label: string, action: () => Promise<void>) => Promise<void> };
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }

function PeoplePanel({ workspace, active, busy, run }: PanelProps) {
  const subjects = useMemo(() => subjectsFromWorkspace(workspace), [workspace]);
  const [selected, setSelected] = useState(subjects[0]?.key || '');
  const [candidate, setCandidate] = useState('');
  const [name, setName] = useState('');
  const [groupKeys, setGroupKeys] = useState<string[]>([]);
  const [consentOpen, setConsentOpen] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  const [similarities, setSimilarities] = useState<Json[]>([]);
  const subject = subjects.find((item: Json) => item.key === selected) || subjects[0];
  const identities = workspace.identities || [];
  const ranked = useMemo(() => subject ? rankIdentityCandidates(subject, subjects, identities, similarities) : [], [subject, subjects, identities, similarities]);
  const refreshAfter = async () => { /* host events refresh the project; activation also refreshes */ };
  useEffect(() => { if (!selected && subjects[0]) setSelected(subjects[0].key); }, [selected, subjects]);
  useEffect(() => { setCandidate(''); }, [selected]);
  useEffect(() => { let mounted = true; void rpc<Json>('team.identity.similarities.v1').then(result => { if (mounted && result.success !== false) setSimilarities(result.similarities || []); }); return () => { mounted = false; }; }, [workspace.assignments]);
  const suggest = () => {
    if (localStorage.getItem('photoflow:team-retouch:face-consent') !== 'granted') { setConsentOpen(true); return; }
    void run('正在分析人物候选', async () => { const result = assertSuccess(await rpc<Json>('team.identity.suggest.v1'), '自动人物标记失败'); setSimilarities(result.similarities || []); });
  };
  const assign = () => void run('确认人物身份', async () => {
    if (!subject || !candidate) throw new Error('请选择人物与身份候选');
    assertSuccess(await rpc<Json>('team.identity.assign.v1', { photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, personIndex: subject.personIndex, identityId: candidate, confidence: 1, source: 'manual', completed: true }), '确认失败');
    await rpc<Json>('team.identity.complete.v1', { photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, personIndex: subject.personIndex, completed: true, completionKind: 'manual', taskId: subject.task.id, taskOrder: subject.task.taskOrder });
    await refreshAfter();
  });
  const confirmGroup = () => void run('确认人物组', async () => {
    if (!subject || !groupKeys.length || (!candidate && !name.trim())) throw new Error('请选择组成员与目标身份');
    const assignments = subjects.filter((item: Json) => groupKeys.includes(item.key)).map((item: Json) => ({ photoId: item.photo.photoId, baseVersionId: item.photo.baseVersionId, personIndex: item.personIndex, confidence: 1, source: 'manual', completed: true }));
    assertSuccess(await rpc<Json>('team.identity.confirm-group.v1', { anchorSubjectKey: subject.key, identityId: candidate || undefined, name: name.trim() || undefined, assignments }), '组确认失败');
  });
  return <div className="grid">
    <section className="card"><div className="section-head"><div><h2>逐人物身份确认</h2><p className="hint">候选确认、组确认与身份库维护均在组件内部完成。</p></div><button className="btn primary" disabled={busy || !subjects.length} onClick={suggest}>自动生成候选</button></div>
      <div className="people-layout"><div className="subject-list">{subjects.map((item: Json) => <button key={item.key} className={`subject ${item.key === subject?.key ? 'selected' : ''}`} onClick={() => setSelected(item.key)}><ImagePreview enabled={active} media={{ kind: 'working', photoId: item.photo.photoId, baseVersionId: item.photo.baseVersionId, taskId: item.task.id }} alt={`${item.photo.name} 人物 ${item.personIndex}`}/><span>{item.photo.name || item.photo.photoId} · 人物 {item.personIndex}</span><small>{item.identity?.name || '待确认'}</small></button>)}</div>
      <div className="identity-editor">{subject ? <><h3>{subject.photo.name || subject.photo.photoId} · 人物 {subject.personIndex}</h3><ImagePreview enabled={active} media={{ kind: 'working', photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, taskId: subject.task.id }} alt="人物工作图"/><div className="candidate-list" role="listbox" aria-label="按相似度排序的身份候选">{ranked.map((item: Json) => <button key={item.identity.id} role="option" aria-selected={candidate === item.identity.id} className={`candidate ${candidate === item.identity.id ? 'selected' : ''}`} onClick={() => setCandidate(item.identity.id)}><strong>{item.identity.name}</strong><span>{item.score ? `${Math.round(item.score * 100)}% · ${item.confidence}置信度` : '暂无相似证据'}</span><small>{item.evidence === 'body-only' ? '人体外观证据' : item.evidence ? '人脸 + 人体证据' : '可人工选择'}{item.faceScore != null ? ` · face ${Math.round(item.faceScore * 100)}%` : ''}{item.bodyScore != null ? ` · body ${Math.round(item.bodyScore * 100)}%` : ''}</small></button>)}</div><button className="btn primary" disabled={!candidate || busy} onClick={assign}>确认此人物</button><button className="btn" disabled={busy} onClick={() => void run('排除此人物', async () => { assertSuccess(await rpc<Json>('team.person.exclude.v1', { photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, personIndex: subject.personIndex }), '排除失败'); })}>不是人物 / 排除</button></> : <Empty text="请先检测人物"/>}</div>
      <div className="group-editor"><h3>组确认</h3><p className="hint">勾选同一人物的多张工作图，一次确认归属。</p>{subjects.map((item: Json) => <label className="check-row" key={item.key}><input type="checkbox" checked={groupKeys.includes(item.key)} onChange={() => setGroupKeys(current => current.includes(item.key) ? current.filter(key => key !== item.key) : [...current, item.key])}/><span>{item.photo.name || item.photo.photoId} · {item.personIndex}</span></label>)}<button className="btn" disabled={!groupKeys.length || busy} onClick={confirmGroup}>确认所选组</button></div></div>
    </section>
    <section className="card half"><h2>身份库</h2><div className="row"><input value={name} onChange={event => setName(event.target.value)} placeholder="输入姓名"/><button className="btn primary" disabled={!name.trim() || busy} onClick={() => void run('保存身份', async () => { assertSuccess(await rpc<Json>('team.identity.save.v1', { name: name.trim(), assignments: [] }), '保存失败'); setName(''); })}>新建</button></div><div className="list">{identities.map((identity: Json) => <div className="item" key={identity.id}><input defaultValue={identity.name} aria-label={`${identity.name} 名称`} onBlur={event => { const next = event.target.value.trim(); if (next && next !== identity.name) void run('重命名身份', async () => { assertSuccess(await rpc<Json>('team.identity.save.v1', { identityId: identity.id, name: next, assignments: [] }), '重命名失败'); }); }}/><span className="spacer"/><span className="pill">{subjects.filter((item: Json) => item.assignment?.identityId === identity.id).length} 人次</span><button className="btn danger" onClick={() => setDeleteId(identity.id)}>删除</button></div>)}</div></section>
    <section className="card half"><h2>工作图上传</h2><p className="hint">上传通过宿主文件选择授权；组件不读取任意本地路径。</p><div className="list">{subjects.map((item: Json) => <div className="item" key={item.key}><span>{item.photo.name || item.photo.photoId} · 人物 {item.personIndex}</span><span className="spacer"/><button className="btn" onClick={() => void run('上传工作图', async () => { assertSuccess(await rpc<Json>('team.patch.upload.v1', { photoId: item.photo.photoId, taskId: item.task.id, personIndex: item.personIndex }), '上传失败'); })}>上传</button><button className="btn danger" onClick={() => void run('移除上传', async () => { assertSuccess(await rpc<Json>('team.patch.remove-upload.v1', { photoId: item.photo.photoId, taskId: item.task.id, personIndex: item.personIndex }), '移除失败'); })}>移除</button></div>)}</div></section>
    {consentOpen && <Dialog title="人物识别隐私授权" close={() => setConsentOpen(false)}><div className="dialog-body"><p>人物候选会在本地分析面部与外观特征，仅用于当前项目的身份分组。请确认已获得照片相关人员授权。</p></div><footer><button className="btn" onClick={() => setConsentOpen(false)}>暂不使用</button><button className="btn primary" onClick={() => { localStorage.setItem('photoflow:team-retouch:face-consent', 'granted'); setConsentOpen(false); suggest(); }}>同意并继续</button></footer></Dialog>}
    {deleteId && <ConfirmDialog
      title="删除人物身份"
      message="删除后相关人物会回到待确认状态。"
      danger
      confirmLabel="删除"
      close={() => setDeleteId('')}
      confirm={() => { const id = deleteId; setDeleteId(''); void run('删除身份', async () => { assertSuccess(await rpc<Json>('team.identity.delete.v1', { identityId: id }), '删除失败'); }); }}
    />}
  </div>;
}

function WorkflowPanel({ workspace, active: _active, busy, run }: PanelProps) {
  const initialOrder = (workspace.workflowSettings?.preferredIdentityOrder || workspace.identities?.map((item: Json) => item.id) || []) as string[];
  const [order, setOrder] = useState<string[]>(initialOrder);
  const [weeks, setWeeks] = useState<Record<string, number>>({});
  const [sameWeek, setSameWeek] = useState<string[]>(workspace.workflowSettings?.sameWeekIdentityIds || []);
  const [status, setStatus] = useState<Json>();
  const [replace, setReplace] = useState(false);
  const dragged = useRef('');
  const identities = new Map((workspace.identities || []).map((item: Json) => [String(item.id), item]));
  const groups = workflowGroups(workspace, order, weeks);
  useEffect(() => {
    const next = (workspace.workflowSettings?.preferredIdentityOrder || workspace.identities?.map((item: Json) => item.id) || []) as string[];
    setOrder(current => current.length ? current.filter(id => next.includes(id)).concat(next.filter(id => !current.includes(id))) : next);
  }, [workspace.identities, workspace.workflowSettings]);
  useEffect(() => { let mounted = true; void rpc<Json>('team.workflow.status.v1').then(result => { if (mounted && result.success !== false) setStatus(result.job || result); }); return () => { mounted = false; }; }, []);
  const moveBefore = (target: string) => { const source = dragged.current; if (!source || source === target) return; setOrder(current => { const next = current.filter(id => id !== source); next.splice(next.indexOf(target), 0, source); return next; }); };
  const readStatus = () => run('读取工作流状态', async () => { const result = assertSuccess(await rpc<Json>('team.workflow.status.v1'), '读取状态失败'); setStatus(result.job || result); });
  const generate = () => run('正在生成工作流', async () => {
    if (!groups.length) throw new Error('没有已确认且可编排的人物任务');
    assertSuccess(await rpc<Json>('team.workflow.settings.save.v1', { preferredIdentityOrder: order, preferredIdentityId: order[0], sameWeekIdentityIds: sameWeek }), '保存排期失败');
    const result = assertSuccess(await rpc<Json>('team.workflow.generate.v1', { operationId: crypto.randomUUID(), replace, preferredIdentityOrder: order, preferredIdentityId: order[0], sameWeekIdentityIds: sameWeek, groups }), '生成失败');
    if (result.requiresConfirmation) { setReplace(true); throw new Error('目标目录已存在。已开启替换选项，请确认后再次生成。'); }
    setStatus(result.job || result);
  });
  return <div className="grid"><section className="card half"><div className="section-head"><div><h2>拖拽排期</h2><p className="hint">拖动人物调整优先级，也可直接指定周次。</p></div><button className="btn" onClick={() => void readStatus()}>刷新状态</button></div><div className="schedule">{order.map((id, index) => { const identity = identities.get(id) as Json | undefined; if (!identity) return null; return <div className="schedule-item" key={id} draggable onDragStart={() => { dragged.current = id; }} onDragOver={event => event.preventDefault()} onDrop={() => moveBefore(id)}><span className="grip" aria-hidden>⠿</span><strong>{identity.name}</strong><span className="pill">优先级 {index + 1}</span><label>第 <input type="number" min="1" value={weeks[id] || index + 1} onChange={event => setWeeks(current => ({ ...current, [id]: Math.max(1, Number(event.target.value)) }))}/> 周</label><label className="same-week"><input type="checkbox" checked={sameWeek.includes(id)} onChange={() => setSameWeek(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])}/>允许同周</label></div>; })}</div></section>
    <section className="card half"><h2>生成与导出</h2><p className="hint">长任务可取消；重启页面后可读取正在运行的任务。</p><label className="check-row"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)}/><span>替换现有工作流目录</span></label><div className="row"><button className="btn primary" disabled={busy || !groups.length} onClick={() => void generate()}>生成工作流</button><button className="btn danger" disabled={!status?.operationId && !status?.id} onClick={() => { const operationId = status?.operationId || status?.id; if (operationId) void run('取消工作流', async () => { assertSuccess(await rpc<Json>('team.workflow.cancel.v1', { operationId }), '取消失败'); }); }}>取消</button></div>{status && <div className="status-box"><strong>{status.message || status.status || '工作流任务'}</strong><small>{status.error || status.currentItem || ''}</small></div>}</section>
    <section className="card"><h2>当前任务排期</h2><div className="week-grid">{groups.map(group => <article className="week-card" key={`${group.week}:${group.identityId}`}><header><span className="pill">第 {group.week} 周</span><strong>{group.identityName}</strong><button className="text-btn" onClick={() => void run('导出人物任务', async () => { assertSuccess(await rpc<Json>('team.workflow.export.v1', { week: group.week, identityId: group.identityId }), '导出失败'); assertSuccess(await rpc<Json>('team.workflow.open-export.v1', { week: group.week, identityId: group.identityId }), '打开导出目录失败'); })}>导出并打开目录</button></header><ul>{group.items.map((item: Json) => <li key={`${item.taskId}:${item.personIndex}`}>{item.photoName} · 人物 {item.personIndex}</li>)}</ul></article>)}</div></section></div>;
}

function Comparison({ item, candidate, active, onCandidate }: { item: Json; candidate: Json; active: boolean; onCandidate: (value: Json) => void }) {
  const [mode, setMode] = useState<CompareMode>('split');
  const [split, setSplit] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [blinkAfter, setBlinkAfter] = useState(true);
  const candidates = returnCandidates(item);
  useEffect(() => {
    setBlinkAfter(true);
    if (!shouldBlink(mode, active)) return;
    const timer = window.setInterval(() => setBlinkAfter(value => !value), 520);
    return () => window.clearInterval(timer);
  }, [mode, active]);
  const transform = { transform: `scale(${zoom}) rotate(${rotation}deg)` };
  const before = <ImagePreview enabled={active} media={{ kind: 'working', photoId: candidate.photoId, baseVersionId: candidate.baseVersionId, taskId: candidate.taskId }} alt="返图前" imageStyle={transform}/>;
  const after = <ImagePreview enabled={active} media={{ kind: 'review-return', reviewSessionId: item.reviewSessionId, returnId: item.returnId || item.id }} alt="返图后" imageStyle={transform}/>;
  return <div className="comparison"><div className="compare-toolbar" role="toolbar" aria-label="返图对比模式">{([['side-by-side', '并排'], ['overlay', '叠加'], ['blink', '闪烁'], ['difference', '差异'], ['split', 'Split']] as Array<[CompareMode, string]>).map(([id, label]) => <button className={`text-btn ${mode === id ? 'active' : ''}`} key={id} onClick={() => setMode(id)}>{label}</button>)}</div><div className={`compare-stage mode-${mode}`}>{mode === 'side-by-side' ? <><div className="compare-side">{before}</div><div className="compare-side">{after}</div></> : <>{before}<div className={`compare-after ${mode === 'difference' ? 'difference' : ''}`} style={mode === 'split' ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : mode === 'overlay' ? { opacity: opacity / 100 } : mode === 'blink' ? { opacity: blinkAfter ? 1 : 0 } : undefined}>{after}</div>{mode === 'split' && <span className="compare-line" style={{ left: `${split}%` }}/>}</>}</div>{mode === 'split' && <input aria-label="拖动比较返图前后" type="range" min="0" max="100" value={split} onChange={event => setSplit(Number(event.target.value))}/>} {mode === 'overlay' && <input aria-label="返图叠加透明度" type="range" min="0" max="100" value={opacity} onChange={event => setOpacity(Number(event.target.value))}/>}<div className="row"><button className="btn" onClick={() => setZoom(value => clampZoom(value - .25))}>−</button><span className="pill">{Math.round(zoom * 100)}%</span><button className="btn" onClick={() => setZoom(value => clampZoom(value + .25))}>＋</button><button className="btn" onClick={() => setRotation(value => normalizeRotation(value - 90))}>↶</button><button className="btn" onClick={() => setRotation(value => normalizeRotation(value + 90))}>↷</button><button className="text-btn" onClick={() => { setZoom(1); setRotation(0); setSplit(50); setOpacity(50); }}>重置</button></div><div className="return-candidates">{candidates.map((itemCandidate: Json) => <button key={`${itemCandidate.taskId}:${itemCandidate.personIndex}`} className={`candidate ${itemCandidate.taskId === candidate.taskId && itemCandidate.personIndex === candidate.personIndex ? 'selected' : ''}`} onClick={() => onCandidate(itemCandidate)}><strong>{itemCandidate.photoName || itemCandidate.personName || itemCandidate.taskId}</strong><span>{Math.round(Number(itemCandidate.score || 0) * 100)}%</span></button>)}</div></div>;
}

function ReturnsPanel({ workspace, active, busy, run }: PanelProps) {
  const [review, setReview] = useState<Json>();
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, Json>>({});
  const items = returnReviewItems(review);
  const fetchReview = async () => { const result = assertSuccess(await rpc<Json>('team.workflow.return-review.get.v1'), '读取审核失败'); const next = result.review || result.session || (result.success ? undefined : result); setReview(next); setSelectedCandidates(Object.fromEntries(returnReviewItems(next).map((item: Json) => [String(item.returnId || item.id), returnCandidates(item)[0] || item]))); };
  const load = () => run('读取返图审核', fetchReview);
  useEffect(() => { void fetchReview().catch(() => undefined); }, []);
  const choose = () => run('选择并匹配返图', async () => {
    const selected = assertSuccess(await rpc<Json>('team.patch.select-returns.v1'), '选择返图失败');
    if (selected.cancelled) return;
    const returnedFiles = selected.files || selected.returnedFiles || [];
    const result = assertSuccess(await rpc<Json>('team.workflow.return-batch.v1', { returnedFiles, items: subjectsFromWorkspace(workspace).map((subject: Json) => ({ photoId: subject.photo.photoId, baseVersionId: subject.photo.baseVersionId, personIndex: subject.personIndex, taskId: subject.task.id, taskOrder: subject.task.taskOrder })) }), '返图匹配失败');
    const next = result.review || result; setReview(next); setSelectedCandidates(Object.fromEntries(returnReviewItems(next).map((item: Json) => [String(item.returnId || item.id), returnCandidates(item)[0] || item])));
  });
  const sessionId = review?.reviewSessionId || review?.id;
  return <div className="grid"><section className="card half"><h2>返图选择</h2><p className="hint">由宿主选择文件后自动匹配任务，无法确定的项目进入逐张审核。</p><button className="btn primary" disabled={busy} onClick={() => void choose()}>选择返图文件</button></section><section className="card half"><h2>审核会话</h2><div className="row"><button className="btn" disabled={busy} onClick={() => void load()}>恢复待审核会话</button>{sessionId && <button className="btn danger" onClick={() => void run('放弃审核会话', async () => { assertSuccess(await rpc<Json>('team.workflow.return-review.discard.v1', { reviewSessionId: sessionId }), '放弃失败'); setReview(undefined); })}>放弃本批</button>}</div></section>
    <section className="card"><h2>逐张对比确认</h2>{items.length ? <div className="review-grid">{items.map((item: Json, index: number) => { const returnId = String(item.returnId || item.id); const candidate = selectedCandidates[returnId] || returnCandidates(item)[0] || item; return <article className="review-card" key={returnId || index}><Comparison item={{ ...item, reviewSessionId: sessionId }} candidate={candidate} active={active} onCandidate={value => setSelectedCandidates(current => ({ ...current, [returnId]: value }))}/><h3>{item.sourceName || item.fileName || item.returnedName || `返图 ${index + 1}`}</h3><p className="hint">候选：{candidate.photoName || candidate.personName || '未命名'} · 匹配度 {Math.round(Number(candidate.score || 0) * 100)}%</p><div className="row"><button className="btn primary" onClick={() => void run('确认返图', async () => { assertSuccess(await rpc<Json>('team.workflow.return-confirm.v1', { reviewSessionId: sessionId, returnId, photoId: candidate.photoId, baseVersionId: candidate.baseVersionId, personIndex: candidate.personIndex, taskId: candidate.taskId, taskOrder: candidate.taskOrder }), '确认失败'); await fetchReview(); })}>确认匹配</button><button className="btn" onClick={() => void run('忽略返图', async () => { assertSuccess(await rpc<Json>('team.workflow.return-review.ignore.v1', { reviewSessionId: sessionId, returnId }), '忽略失败'); await fetchReview(); })}>忽略此图</button></div></article>; })}</div> : <Empty text="没有待审核返图"/>}</section></div>;
}

function MergePanel({ workspace, active: _active, busy, run }: PanelProps) {
  const [progress, setProgress] = useState<Json[]>([]);
  const [target, setTarget] = useState(localStorage.getItem('photoflow:team-retouch-output') || '__new__');
  const [name, setName] = useState('图片后期_团片协作合成');
  useEffect(() => { let mounted = true; void rpc<Json>('team.progress.list.v1').then(result => { if (mounted && result.success !== false) setProgress(progressCandidates(result, [])); }); return () => { mounted = false; }; }, [workspace.photos]);
  const ensureTarget = async () => {
    if (target !== '__new__') return target;
    const result = assertSuccess(await rpc<Json>('team.progress.create.v1', { progress: { mediaKind: 'image', displayName: name }, workflowInputProgressIds: workspace.workflowProgressId ? [workspace.workflowProgressId] : [] }), '创建输出进度失败');
    const id = result.progressFolder?.id || result.progressId;
    if (!id) throw new Error('宿主未返回输出进度');
    setTarget(id); localStorage.setItem('photoflow:team-retouch-output', id); return id;
  };
  const merge = (photo: Json) => run('正在合并照片', async () => { const outputProgressId = await ensureTarget(); assertSuccess(await rpc<Json>('team.patch.merge.v1', { photoId: photo.photoId, baseVersionId: photo.baseVersionId, outputProgressId, versionName: '团片协作合并' }), '合并失败'); });
  return <div className="grid"><section className="card"><h2>选择合并目标进度</h2><div className="row"><select value={target} onChange={event => { setTarget(event.target.value); if (event.target.value === '__new__') localStorage.removeItem('photoflow:team-retouch-output'); else localStorage.setItem('photoflow:team-retouch-output', event.target.value); }}><option value="__new__">新建图片进度</option>{progress.map(item => <option value={item.id} key={item.id}>{item.displayName || item.versionKey}</option>)}</select>{target === '__new__' && <input value={name} onChange={event => setName(event.target.value)} aria-label="新进度名称"/>}</div><p className="hint">来源进度不可作为目标；选择会按项目记忆。</p></section><section className="card"><h2>逐张合并</h2><div className="list">{(workspace.photos || []).map((photo: Json) => <div className="item" key={`${photo.photoId}:${photo.baseVersionId}`}><div><strong>{photo.name || photo.displayName || photo.photoId}</strong><small>{photo.tasks?.filter((task: Json) => ['uploaded', 'merged'].includes(String(task.status))).length || 0} / {photo.tasks?.length || 0} 个返图就绪</small></div><span className="spacer"/><button className="btn primary" disabled={busy || !photo.tasks?.length} onClick={() => void merge(photo)}>合并到目标进度</button></div>)}</div></section></div>;
}

function SettingsPanel({ settings, setSettings, busy, run }: PanelProps & { settings: Settings; setSettings: (settings: Settings) => void }) {
  const [environment, setEnvironment] = useState<Json>();
  return <div className="grid"><section className="card half"><h2>组件设置</h2><label className="check-row"><input type="checkbox" checked={settings.useGpu} onChange={event => setSettings({ ...settings, useGpu: event.target.checked })}/><span>优先使用 GPU</span></label><label className="field"><span>超大人物裁剪</span><select value={settings.oversizeCropMode} onChange={event => setSettings({ ...settings, oversizeCropMode: event.target.value as Settings['oversizeCropMode'] })}><option value="face-centered">保持 4000 像素并以面部居中</option><option value="expand">扩大范围保留完整人物</option></select></label><button className="btn primary" disabled={busy} onClick={() => void run('保存组件设置', async () => { assertSuccess(await rpc<Json>('team.settings.update.v1', settings), '保存失败'); })}>保存设置</button></section>
    <section className="card half"><h2>高级环境</h2><p className="hint">环境操作只管理组件自带算法和模型，不修改视频播放器边界。</p><div className="row"><button className="btn" disabled={busy} onClick={() => void run('检查高级环境', async () => { setEnvironment(await rpc<Json>('team.advanced.preflight.v1')); })}>检查</button><button className="btn primary" disabled={busy} onClick={() => void run('安装/修复高级环境', async () => { assertSuccess(await rpc<Json>('team.advanced.install.v1', { repair: true }), '安装失败'); })}>安装 / 修复</button><button className="btn danger" disabled={busy} onClick={() => void run('卸载高级环境', async () => { assertSuccess(await rpc<Json>('team.advanced.uninstall.v1'), '卸载失败'); })}>卸载</button></div>{environment && <pre className={environment.success === false ? 'error-text' : ''}>{environment.message || environment.error || JSON.stringify(environment, null, 2)}</pre>}</section></div>;
}

function App() {
  const [context, setContext] = useState<ComponentContext>();
  const [tab, setTab] = useState<Tab>('detect');
  const [workspace, setWorkspace] = useState<Json>(EMPTY_WORKSPACE);
  const [files, setFiles] = useState<Json[]>([]);
  const [settings, setSettings] = useState<Settings>({ useGpu: true, oversizeCropMode: 'face-centered' });
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(true);
  const [progress, setProgress] = useState<Progress>();
  const busyRef = useRef(false);
  const refresh = useCallback(async () => {
    const pages: Json[] = []; let cursor = '';
    do { const page = assertSuccess(await rpc<Json>('team.media.page.v1', cursor ? { cursor } : {}), '无法读取项目图片'); pages.push(page); cursor = page.hasMore ? String(page.cursor || '') : ''; } while (cursor && pages.length < 100);
    const [project, savedSettings] = await Promise.all([rpc<Json>('team.project.get.v1'), rpc<Json>('team.settings.get.v1')]);
    setWorkspace(assertSuccess(project, '无法读取团片项目'));
    setFiles(pages.flatMap(page => page.entries || page.files || []).filter(imageFile));
    if (savedSettings.success !== false && savedSettings.settings) setSettings(savedSettings.settings as Settings);
  }, []);
  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); notify(label, 'info');
    try { await action(); notify(`${label}完成`, 'success'); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { busyRef.current = false; setBusy(false); }
  }, [refresh]);
  useEffect(() => {
    let mounted = true;
    void window.photoFlowComponent.getContext().then(value => { if (mounted) { setContext(value); void run('载入团片项目', refresh); } });
    const stops = [window.photoFlowComponent.onActivate(() => { setActive(true); void refresh(); }), window.photoFlowComponent.onDeactivate(() => setActive(false))];
    for (const topic of ['team.patch.detect.progress.v1', 'team.patch.detect-batch.progress.v1', 'team.return.progress.v1', 'team.workflow.progress.v1']) stops.push(window.photoFlowComponent.onEvent(topic, value => { const update = value as Json; setProgress({ progress: Math.max(0, Math.min(100, Number(update.progress ?? update.percent) || 0)), message: String(update.message || update.currentItem || '处理中'), operationId: update.operationId }); }));
    return () => { mounted = false; stops.forEach(stop => stop()); };
  }, [refresh, run]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.altKey && /^[1-6]$/.test(event.key)) { const next = TABS[Number(event.key) - 1]; if (next) setTab(next[0]); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  const common = { workspace, active, busy, run };
  return <div className="shell" data-theme="system"><header className="topbar"><div className="brand"><span className="logo">团</span><div><h1>团片协作</h1><p>{context?.projectName || '正在连接项目'}</p></div></div><nav className="tabs" aria-label="团片协作步骤">{TABS.map(([id, label, shortcut]) => <button key={id} className={`tab ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} title={`Alt+${shortcut}`} onClick={() => setTab(id)}>{label}</button>)}</nav><span className="state">{active ? (busy ? '处理中…' : `组件 ${context?.componentVersion || ''}`) : '页面已暂停'}</span></header>
    {progress?.message && <aside className="task-progress" role="status"><span>{progress.message}</span><div className="progress"><i style={{ width: `${progress.progress}%` }}/></div><b>{Math.round(progress.progress)}%</b></aside>}
    <main className="main">{tab === 'detect' && <DetectionPanel {...common} files={files} refresh={refresh}/>} {tab === 'people' && <PeoplePanel {...common}/>} {tab === 'workflow' && <WorkflowPanel {...common}/>} {tab === 'returns' && <ReturnsPanel {...common}/>} {tab === 'merge' && <MergePanel {...common}/>} {tab === 'settings' && <SettingsPanel {...common} settings={settings} setSettings={setSettings}/>}</main>
  </div>;
}

createRoot(document.getElementById('app')!).render(<StrictMode><App/></StrictMode>);
