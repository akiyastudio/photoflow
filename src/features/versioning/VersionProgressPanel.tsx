import { Loader2 } from 'lucide-react';
import type { ProgressFolder } from '../../types';
import { isUserVersionKey, nextVersionKeys, normalizeTrackingPolicy, planProgressRootMove, selectableVersionParents, type VersionPanelState, type VersionRelationKind } from './versioning-v2-model';

export type VersionProgressDraft = {
  mode: 'create' | 'create-next' | 'import' | 'modify';
  sourceRelativePath: string;
  displayName: string;
  mediaKind: ProgressFolder['mediaKind'];
  relationKind: VersionRelationKind;
  parentProgressId: string;
  trackingEnabled: boolean;
  renameFromParent: boolean;
  copyMissingFromParent: boolean;
  workflowInputProgressIds: string[];
  existingProgressId?: string;
  versionKey?: string;
  versionKind?: 'main' | 'branch';
};

type VersionProgressPanelProps = {
  draft: VersionProgressDraft;
  folders: ProgressFolder[];
  state?: VersionPanelState;
  progress?: { percentage?: number; processedCount?: number; totalCount?: number; currentName?: string };
  message?: string;
  error?: string;
  onChange: (draft: VersionProgressDraft) => void;
  onChooseFolder?: () => void;
  onSubmit: () => void;
  onClose: () => void;
};

const stateLabel: Partial<Record<VersionPanelState, string>> = {
  move_confirm: '需要确认移动', processing: '正在处理', waiting_confirmation: '等待确认', result: '操作完成', failure: '处理失败',
};
const fieldClass = 'mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-500';
const folderPrefix = (mediaKind: ProgressFolder['mediaKind']) => mediaKind === 'video' ? '视频后期' : '图片后期';
const lastPathPart = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || '项目根目录';
const generatedFolderName = (draft: VersionProgressDraft) => `${folderPrefix(draft.mediaKind)}_${draft.versionKey?.trim() || '—'}${draft.displayName.trim() ? `_${draft.displayName.trim()}` : ''}`;

const Callout = ({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning' | 'danger'; title: string; children: React.ReactNode }) => {
  const toneClass = tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800' : tone === 'danger' ? 'border-red-200 bg-red-50 text-red-800' : 'border-blue-200 bg-blue-50 text-blue-800';
  return <div className={`rounded-xl border px-4 py-3 ${toneClass}`}><b className="text-sm">{title}</b><div className="mt-1 text-xs leading-5 opacity-80">{children}</div></div>;
};
const Card = ({ title, meta, children }: { title?: string; meta?: string; children: React.ReactNode }) => <section className="rounded-xl border border-slate-200 bg-white p-4">{(title || meta) && <div className="mb-3 flex items-center justify-between gap-3"><b className="text-sm text-slate-800">{title}</b>{meta && <span className="text-[11px] text-slate-400">{meta}</span>}</div>}{children}</section>;

export const VersionProgressPanel = ({ draft, folders, state = 'ready', progress, message, error, onChange, onChooseFolder, onSubmit, onClose }: VersionProgressPanelProps) => {
  const policy = normalizeTrackingPolicy('main', draft);
  const parents = selectableVersionParents(folders, { ...draft, relationKind: 'main' });
  const parent = folders.find(folder => folder.id === draft.parentProgressId);
  const movePlan = planProgressRootMove(draft.sourceRelativePath);
  const requiresMove = draft.mode !== 'create' && movePlan.requiresMove;
  const busy = state === 'processing';
  const update = (patch: Partial<VersionProgressDraft>) => onChange({ ...draft, ...patch, relationKind: 'main' });
  const updatePolicy = (patch: Partial<Pick<VersionProgressDraft, 'trackingEnabled' | 'renameFromParent' | 'copyMissingFromParent'>>) => update(normalizeTrackingPolicy('main', { ...policy, ...patch }));
  const targetName = lastPathPart(draft.sourceRelativePath);
  const versionLabel = `V${draft.versionKey || '—'}`;
  const suggestions = nextVersionKeys(folders, draft.mediaKind, parent, draft.existingProgressId);
  const versionKind = draft.versionKind || (draft.versionKey?.includes('_') ? 'branch' : 'main');
  const setVersionKind = (nextKind: 'main' | 'branch') => {
    if (nextKind === versionKind && isUserVersionKey(draft.versionKey || '') && (nextKind !== 'branch' || draft.versionKey === suggestions.branch)) return;
    if (nextKind === 'branch' && !parent) return;
    update({
      versionKind: nextKind,
      versionKey: nextKind === 'branch' ? suggestions.branch : suggestions.main,
    });
  };
  const setParent = (parentProgressId: string) => {
    const nextParent = folders.find(folder => folder.id === parentProgressId);
    const nextSuggestions = nextVersionKeys(folders, draft.mediaKind, nextParent, draft.existingProgressId);
    update({
      parentProgressId,
      versionKey: versionKind === 'branch' ? nextSuggestions.branch : draft.versionKey,
    });
  };
  const setMediaKind = (mediaKind: ProgressFolder['mediaKind']) => {
    if (mediaKind === draft.mediaKind) return;
    const nextSuggestions = nextVersionKeys(folders, mediaKind, parent, draft.existingProgressId);
    update({ mediaKind, versionKey: versionKind === 'branch' ? nextSuggestions.branch : nextSuggestions.main });
  };
  const versionKindControl = <fieldset>
    <legend className="text-xs font-semibold text-slate-600">创建类型</legend>
    <div className="mt-1 grid grid-cols-2 gap-2">
      <button type="button" aria-pressed={versionKind === 'main'} onClick={() => setVersionKind('main')} className={`h-10 rounded-lg border text-sm font-semibold ${versionKind === 'main' ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>主版本</button>
      <button type="button" disabled={!parent} title={parent ? `创建 V${suggestions.branch}` : '请先选择父版本'} aria-pressed={versionKind === 'branch'} onClick={() => setVersionKind('branch')} className={`h-10 rounded-lg border text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${versionKind === 'branch' ? 'border-violet-500 bg-violet-50 text-violet-700 ring-1 ring-violet-200' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>子分支</button>
    </div>
    <p className="mt-1.5 text-[11px] leading-4 text-slate-400">{versionKind === 'branch' ? `从父版本分出，系统编号为 V${suggestions.branch || '—'}` : `沿主线继续，系统编号为 V${suggestions.main}`}</p>
  </fieldset>;

  if (state !== 'ready') return <div className="space-y-4"><Callout tone={state === 'failure' ? 'danger' : state === 'result' ? 'success' : 'info'} title={stateLabel[state] || state}>{error || message || (busy ? '版本任务正在后台执行；收起面板不会中断任务。' : '版本节点及其自动关系已更新。')}</Callout>{busy && <Card><div className="flex items-center justify-between text-xs font-semibold text-slate-600"><span className="truncate">{progress?.currentName || '正在准备版本任务…'}</span><span className="ml-3 tabular-nums text-blue-600">{Math.round(progress?.percentage ?? 0)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${Math.max(2, progress?.percentage ?? (progress?.totalCount ? Math.min(100, Math.round((progress.processedCount || 0) / progress.totalCount * 100)) : 2))}%` }}/></div><p className="mt-2 text-xs text-slate-500">{progress?.processedCount || 0} / {progress?.totalCount || '—'}{progress?.currentName ? ` · ${progress.currentName}` : ''}</p></Card>}<div className="flex justify-end"><button type="button" disabled={busy} onClick={onClose} className="dialog-primary">关闭</button></div></div>;

  return <div className="space-y-4">
    {draft.mode === 'create' && <Callout title="版本关系与文件夹名称自动建立">填写版本号和可选名称，文件夹名称将自动生成。</Callout>}
    {draft.mode === 'import' && <Callout title="导入并创建版本进度">版本号、名称和文件夹命名规则与新建进度完全一致；提交后再选择要导入的文件或文件夹。</Callout>}
    {draft.mode === 'create-next' && <Callout tone="success" title={`默认创建 ${versionLabel}`}>已刷新版本状态并生成版本号。</Callout>}
    {draft.mode === 'import' && requiresMove && <Callout tone="warning" title="所选文件夹不在项目根目录">登记前会预检并移动到“{movePlan.targetRelativePath}”。快捷方式或外部目录不能移动或覆盖。</Callout>}
    {draft.mode === 'modify' && <Callout tone="warning" title={`${versionLabel} · ${targetName}`}>这里只修改当前版本进度。</Callout>}
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={draft.mode === 'create-next' ? '创建摘要' : draft.mode === 'modify' ? '版本设置' : '版本信息'} meta={draft.mode === 'create-next' ? '拖拽目标' : undefined}>
        {draft.mode === 'create-next' ? <div className="space-y-3"><label className="block text-xs font-semibold text-slate-600">父版本<input className={fieldClass} readOnly value={parent ? `V${parent.versionKey} · ${parent.displayName}` : '—'}/></label>{versionKindControl}<label className="block text-xs font-semibold text-slate-600">目标文件夹<input className={fieldClass} readOnly value={targetName}/></label><label className="block text-xs font-semibold text-slate-600">版本号（自动生成）<input className={fieldClass} readOnly value={draft.versionKey || ''}/></label><label className="block text-xs font-semibold text-slate-600">将创建<input className={fieldClass} readOnly value={`${versionLabel} · ${targetName}`}/></label></div> : <div className="space-y-3">
          {draft.mode !== 'modify' && <label className="block text-xs font-semibold text-slate-600">{draft.mode === 'import' ? '导入来源' : '创建位置'}<div className="mt-1 flex gap-2"><input className={`${fieldClass} mt-0 min-w-0 flex-1`} readOnly value={draft.mode === 'import' ? '提交后选择要导入的文件或文件夹' : draft.sourceRelativePath || '项目根目录'}/>{onChooseFolder && <button type="button" disabled={busy} onClick={onChooseFolder} className="dialog-secondary shrink-0">浏览…</button>}</div></label>}
          <div className="grid gap-3 sm:grid-cols-2">{draft.mode !== 'modify' && <fieldset><legend className="text-xs font-semibold text-slate-600">媒体类型</legend><div className="mt-1 grid grid-cols-2 gap-2"><button type="button" aria-pressed={draft.mediaKind === 'image'} onClick={() => setMediaKind('image')} className={`h-10 rounded-lg border text-sm font-semibold ${draft.mediaKind === 'image' ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>图片</button><button type="button" aria-pressed={draft.mediaKind === 'video'} onClick={() => setMediaKind('video')} className={`h-10 rounded-lg border text-sm font-semibold ${draft.mediaKind === 'video' ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>视频</button></div></fieldset>}{versionKindControl}<label className="block text-xs font-semibold text-slate-600">版本号（自动生成）<input className={fieldClass} readOnly value={draft.versionKey || ''}/></label>{draft.mode === 'modify' && <label className="block text-xs font-semibold text-slate-600">名称（可选）<input className={fieldClass} value={draft.displayName} onChange={event => update({ displayName: event.target.value })}/></label>}</div>
          {draft.mode === 'modify' && <label className="block text-xs font-semibold text-slate-600">修改后的文件夹名称<input className={fieldClass} readOnly value={generatedFolderName(draft)}/></label>}
          {(draft.mode === 'create' || draft.mode === 'import') && <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-semibold text-slate-600">名称（可选）<input className={fieldClass} value={draft.displayName} placeholder="例如 精修" onChange={event => update({ displayName: event.target.value })}/></label><label className="block text-xs font-semibold text-slate-600">文件夹名称（自动生成）<input className={fieldClass} readOnly value={generatedFolderName(draft)}/></label></div>}
          <label className="block text-xs font-semibold text-slate-600">父版本<select className={fieldClass} value={draft.parentProgressId} onChange={event => setParent(event.target.value)}><option value="">无（仅首个独立版本）</option>{parents.map(folder => <option key={folder.id} value={folder.id}>{folder.nodeRole === 'original' ? folder.displayName : `V${folder.versionKey} · ${folder.displayName}`}</option>)}</select></label>
        </div>}
      </Card>
      <Card title="版本跟踪策略" meta="仅版本节点可用"><div className="divide-y divide-slate-100">{([['trackingEnabled', '版本跟踪', '检测当前文件夹的媒体变化。'], ['renameFromParent', '沿用上一版本文件名', '确认关联后使用父版本媒体文件名。'], ['copyMissingFromParent', '补齐缺失媒体', '父版本新增媒体后，此版本会变成“待刷新”。']] as const).map(([key, title, help]) => <label key={key} className={`flex gap-3 py-3 first:pt-0 last:pb-0 ${key !== 'trackingEnabled' && !policy.trackingEnabled ? 'opacity-50' : ''}`}><input type="checkbox" className="mt-0.5" checked={policy[key]} disabled={key !== 'trackingEnabled' && !policy.trackingEnabled} onChange={event => updatePolicy({ [key]: event.target.checked })}/><span><b className="block text-sm text-slate-700">{title}</b><small className="mt-0.5 block text-xs leading-5 text-slate-400">{help}</small></span></label>)}</div></Card>
    </div>
    {draft.mode === 'create-next' && <Callout title="需要分支时明确选择">带下划线的版本号表示版本分支。</Callout>}
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4"><span className="mr-auto max-w-xl text-xs leading-5 text-slate-400">{draft.mode === 'create' || draft.mode === 'import' ? '按“媒体前缀_版本号_名称”生成文件夹；名称为空时只保留媒体前缀和版本号。' : draft.mode === 'modify' ? '保存后会同步更新版本文件夹路径和数据库记录。' : ''}</span><button type="button" disabled={busy} onClick={onClose} className="dialog-secondary">取消</button><button type="button" disabled={busy || !draft.versionKey?.trim()} onClick={onSubmit} className="dialog-primary inline-flex items-center gap-2">{busy && <Loader2 size={15} className="animate-spin"/>}{requiresMove ? '继续并检查移动' : draft.mode === 'create' ? '新建进度' : draft.mode === 'create-next' ? `创建 ${versionLabel}` : draft.mode === 'import' ? '导入并新建进度' : '保存设置'}</button></div>
  </div>;
};
