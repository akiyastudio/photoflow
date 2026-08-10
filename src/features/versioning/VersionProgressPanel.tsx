import { Loader2, Minus, X } from 'lucide-react';
import type { ProgressFolder } from '../../types';
import {
  normalizeTrackingPolicy,
  planProgressRootMove,
  selectableWorkflowInputs,
  selectableVersionParents,
  workflowInputLabel,
  VERSION_PANEL_DEFINITIONS,
  type VersionPanelState,
  type VersionRelationKind,
} from './versioning-v2-model';

export type VersionProgressDraft = {
  mode: 'create' | 'import' | 'modify';
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
};

type VersionProgressPanelProps = {
  draft: VersionProgressDraft;
  folders: ProgressFolder[];
  state?: VersionPanelState;
  progress?: { processedCount?: number; totalCount?: number; currentName?: string };
  message?: string;
  error?: string;
  onChange: (draft: VersionProgressDraft) => void;
  onChooseFolder?: () => void;
  onSubmit: () => void;
  onClose: () => void;
  onMinimize?: () => void;
};

const stateLabel: Partial<Record<VersionPanelState, string>> = {
  move_confirm: '需要移动确认', processing: '处理中', waiting_confirmation: '等待确认', result: '已完成', failure: '处理失败',
};

export const VersionProgressPanel = ({ draft, folders, state = 'ready', progress, message, error, onChange, onChooseFolder, onSubmit, onClose, onMinimize }: VersionProgressPanelProps) => {
  const definition = VERSION_PANEL_DEFINITIONS[draft.mode];
  const policy = normalizeTrackingPolicy(draft.relationKind, draft);
  const parents = selectableVersionParents(folders, draft);
  const workflowInputs = selectableWorkflowInputs(folders, draft.mediaKind);
  const movePlan = planProgressRootMove(draft.sourceRelativePath);
  const requiresMove = draft.mode !== 'create' && draft.relationKind === 'main' && movePlan.requiresMove;
  const busy = state === 'processing';
  const update = (patch: Partial<VersionProgressDraft>) => onChange({ ...draft, ...patch });
  const updatePolicy = (patch: Partial<Pick<VersionProgressDraft, 'trackingEnabled' | 'renameFromParent' | 'copyMissingFromParent'>>) => {
    const next = normalizeTrackingPolicy(draft.relationKind, { ...policy, ...patch });
    update(next);
  };

  return <div role="dialog" aria-modal="true" aria-label={definition.title} className="fixed inset-0 z-[340] flex items-center justify-center bg-slate-950/55 p-4">
    <section className="w-full max-w-[660px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4"><div><h3 className="text-lg font-bold text-slate-800">{definition.title}</h3><p className="mt-1 text-xs text-slate-500">关系由节点 ID 建立；文件夹名称只用于显示。</p></div><div className="flex gap-1">{busy && onMinimize && <button type="button" onClick={onMinimize} title="缩小到后台" className="rounded p-1.5 text-slate-500 hover:bg-slate-100"><Minus size={17}/></button>}<button type="button" disabled={busy} onClick={onClose} title="关闭" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"><X size={17}/></button></div></header>
      <div className="space-y-4 px-5 py-4">
        {state !== 'ready' && <div className={`rounded-lg border px-4 py-3 text-sm ${state === 'failure' ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`}><b>{stateLabel[state] || state}</b>{(error || message) && <p className="mt-1 text-xs">{error || message}</p>}{busy && <div className="mt-3"><div className="h-1.5 overflow-hidden rounded bg-blue-100"><div className="h-full bg-blue-500" style={{ width: `${progress?.totalCount ? Math.min(100, Math.round((progress.processedCount || 0) / progress.totalCount * 100)) : 20}%` }}/></div><p className="mt-1 text-xs">{progress?.processedCount || 0} / {progress?.totalCount || '—'} {progress?.currentName ? `· ${progress.currentName}` : ''}</p></div>}</div>}
        <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">{draft.mode === 'create' ? '来源位置' : '项目内文件夹'}</span><div className="flex gap-2"><input value={draft.sourceRelativePath || '项目根目录'} readOnly className="min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm"/>{onChooseFolder && <button type="button" disabled={busy} onClick={onChooseFolder} className="dialog-secondary">选择文件夹</button>}</div></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">进度名称</span><input value={draft.displayName} disabled={busy} onChange={event => update({ displayName: event.target.value })} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"/></label>
        <div><span className="mb-2 block text-xs font-semibold text-slate-600">关系类型</span><div className="grid grid-cols-2 gap-3"><button type="button" disabled={busy} aria-pressed={draft.relationKind === 'main'} onClick={() => { const next = normalizeTrackingPolicy('main', draft); update({ relationKind: 'main', ...next }); }} className={`rounded-lg border p-3 text-left ${draft.relationKind === 'main' ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}><b className="block text-sm">主分支</b><small className="text-slate-500">版本树实线，可开启跟踪策略</small></button><button type="button" disabled={busy} aria-pressed={draft.relationKind === 'auxiliary'} onClick={() => update({ relationKind: 'auxiliary', ...normalizeTrackingPolicy('auxiliary', draft) })} className={`rounded-lg border p-3 text-left ${draft.relationKind === 'auxiliary' ? 'border-violet-500 bg-violet-50' : 'border-slate-200'}`}><b className="block text-sm">附属分支</b><small className="text-slate-500">版本树虚线，仅用于选片</small></button></div></div>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-600">父节点</span><select value={draft.parentProgressId} disabled={busy} onChange={event => update({ parentProgressId: event.target.value })} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"><option value="">无父节点</option>{parents.map(folder => <option key={folder.id} value={folder.id}>{folder.displayName} · {folder.nodeRole === 'original' ? '原始素材' : folder.relationKind === 'auxiliary' ? '附属分支' : '主分支'}</option>)}</select></label>
        <fieldset disabled={busy} className="space-y-2 rounded-lg border border-slate-200 p-3"><legend className="px-1 text-xs font-semibold text-slate-600">工作流输入</legend><p className="text-xs text-slate-500">工作流输入不会改变结构父节点；只有本次明确勾选的节点会连接到该进度。</p>{workflowInputs.length ? workflowInputs.map(folder => <label key={folder.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.workflowInputProgressIds.includes(folder.id)} onChange={event => update({ workflowInputProgressIds: event.target.checked ? [...new Set([...draft.workflowInputProgressIds, folder.id])] : draft.workflowInputProgressIds.filter(id => id !== folder.id) })}/>{workflowInputLabel(folder)}</label>) : <p className="text-xs text-slate-400">当前项目没有可用的选片或协作节点。</p>}</fieldset>
        {requiresMove && <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"><b>需要移动到项目根目录</b><p className="mt-1 text-xs">“{movePlan.sourceRelativePath}”将安全移动为“{movePlan.targetRelativePath}”。移动成功后才会登记进度；快捷方式指向的外部目录不能移动。</p></div>}
        <fieldset disabled={busy || draft.relationKind === 'auxiliary'} className="space-y-2 rounded-lg border border-slate-200 p-3 disabled:opacity-55"><legend className="px-1 text-xs font-semibold text-slate-600">主分支跟踪策略</legend>{draft.relationKind === 'auxiliary' && <p className="text-xs text-violet-600">附属分支禁止图片跟踪、沿用上一版本文件名和补齐缺失媒体。</p>}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.trackingEnabled} onChange={event => updatePolicy({ trackingEnabled: event.target.checked })}/>图片跟踪</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.renameFromParent} disabled={!policy.trackingEnabled} onChange={event => updatePolicy({ renameFromParent: event.target.checked })}/>沿用上一版本文件名</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.copyMissingFromParent} disabled={!policy.trackingEnabled} onChange={event => updatePolicy({ copyMissingFromParent: event.target.checked })}/>补齐缺失媒体</label></fieldset>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4"><button type="button" disabled={busy} onClick={onClose} className="dialog-secondary">取消</button><button type="button" disabled={busy || !draft.displayName.trim() || !draft.parentProgressId && (draft.relationKind === 'auxiliary' || draft.mode !== 'modify')} onClick={onSubmit} className="dialog-primary inline-flex items-center gap-2">{busy && <Loader2 size={15} className="animate-spin"/>}{requiresMove ? '确认移动并继续' : draft.mode === 'create' ? '新建进度' : draft.mode === 'import' ? '导入进度' : '保存修改'}</button></footer>
    </section>
  </div>;
};
