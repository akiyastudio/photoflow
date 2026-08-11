import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, X } from 'lucide-react';
import type { AppConfig, ProgressFolder, ProgressTrackingItem } from '../../types';
import { ProgressPairPreview, type ProgressPairPreviewMode } from './ProgressPairPreview';
import {
  adjacentTrackingPreviewItemId,
  applyTrackingItemDecision,
  canCommitTrackingSession,
  groupTrackingConfirmationItems,
  mergeTrackingSessionPage,
  resolveTrackingComparisonPaths,
  type TrackingConfirmationViewState,
  unresolvedTrackingStatus,
} from './tracking-confirmation-model';

type TrackingConfirmationPanelProps = {
  sessionId: string;
  workspacePath: string;
  progressFolders: ProgressFolder[];
  cacheConfig: AppConfig['mediaCache'];
  onClose: () => void;
  onCommitted: () => void;
  onReleased: () => void;
  onNotice: (message: string) => void;
};

const statusLabel: Record<ProgressTrackingItem['status'], string> = {
  recognized: '已识别', pending_confirmation: '待确认', accepted: '已接受', missing_reference: '引用缺失', rejected: '已拒绝',
};
const categoryLabel = { recognized: '识别匹配', accepted: '已接受', pending: '待确认新素材', missing: '旧版缺失' } as const;

export const TrackingConfirmationPanel = ({ sessionId, workspacePath, progressFolders, cacheConfig, onClose, onCommitted, onReleased, onNotice }: TrackingConfirmationPanelProps) => {
  const [view, setView] = useState<TrackingConfirmationViewState>({ sessionId, items: [], minimized: false });
  const [loading, setLoading] = useState(true);
  const [busyItemId, setBusyItemId] = useState('');
  const [committing, setCommitting] = useState(false);
  const [mode, setMode] = useState<ProgressPairPreviewMode>('side-by-side');
  const [swapped, setSwapped] = useState(false);
  const [relocateName, setRelocateName] = useState('');
  const loadSequenceRef = useRef(0);

  const loadSession = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    let next: number | undefined = 0;
    let loaded: TrackingConfirmationViewState = { sessionId, items: [], minimized: false };
    try {
      do {
        const result = await window.electronAPI.getProgressTrackingSession(workspacePath, { sessionId, cursor: next, limit: 200 });
        if (!result.success || !result.session) throw new Error(result.error || '无法读取跟踪确认会话');
        if (loadSequenceRef.current !== sequence) return;
        loaded = mergeTrackingSessionPage(loaded, result);
        next = loaded.nextCursor;
      } while (next !== undefined);
      if (loadSequenceRef.current === sequence) setView(loaded);
    } catch (error) {
      if (loadSequenceRef.current === sequence) onNotice(`读取跟踪确认失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (loadSequenceRef.current === sequence) setLoading(false);
    }
  }, [sessionId, workspacePath, onNotice]);

  useEffect(() => { void loadSession(); return () => { loadSequenceRef.current += 1; }; }, [loadSession]);

  const selectedItem = view.items.find(item => item.id === view.selectedItemId);
  const progressFolder = progressFolders.find(folder => folder.id === view.session?.progressId);
  const parentFolder = progressFolders.find(folder => folder.id === view.session?.parentProgressId);
  const paths = useMemo(() => resolveTrackingComparisonPaths(selectedItem, parentFolder?.folderPath || '', progressFolder?.folderPath || ''), [selectedItem, parentFolder?.folderPath, progressFolder?.folderPath]);
  useEffect(() => { setRelocateName(selectedItem?.referenceName || ''); }, [selectedItem?.id, selectedItem?.referenceName]);

  const decide = async (status: 'accepted' | 'rejected', referenceName?: string) => {
    if (!selectedItem) return;
    setBusyItemId(selectedItem.id);
    const result = await window.electronAPI.decideProgressTrackingItem(workspacePath, { sessionId, itemId: selectedItem.id, status, ...(referenceName ? { referenceName } : {}) });
    setBusyItemId('');
    if (!result.success) { onNotice(`保存决定失败：${result.error || '未知错误'}`); return; }
    setView(current => applyTrackingItemDecision(current, selectedItem.id, status, referenceName));
  };

  const commit = async () => {
    if (!canCommitTrackingSession(view.items)) return;
    setCommitting(true);
    const result = await window.electronAPI.commitProgressTracking(workspacePath, { sessionId });
    if (!result.success) { setCommitting(false); onNotice(`提交跟踪结果失败：${result.error || '未知错误'}`); return; }
    const released = await window.electronAPI.releaseProgressTrackingSession(workspacePath, { sessionId });
    setCommitting(false);
    if (!released.success || !released.released) onNotice(`跟踪结果已提交，但会话释放失败：${released.error || '稍后将由维护任务清理'}`);
    onNotice('跟踪结果已提交。');
    onCommitted();
  };

  const release = async () => {
    setCommitting(true);
    const result = await window.electronAPI.releaseProgressTrackingSession(workspacePath, { sessionId });
    setCommitting(false);
    if (!result.success) { onNotice(`取消会话失败：${result.error || '未知错误'}`); return; }
    onReleased();
  };

  const unresolved = view.items.filter(item => unresolvedTrackingStatus(item.status)).length;
  const groups = groupTrackingConfirmationItems(view.items);
  return <div role="dialog" aria-modal="true" aria-label="确认跟踪图片" className="fixed inset-0 z-[350] flex items-center justify-center bg-slate-950/55 p-4">
    <div className="tracking-confirmation-dialog">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4"><div><h3 className="text-lg font-bold text-slate-800">确认跟踪图片</h3><p className="mt-1 text-xs text-slate-500">{parentFolder?.displayName || '上一版本'} → {progressFolder?.displayName || '当前版本'} · {view.items.length} 项，{unresolved} 项待处理</p></div><button type="button" onClick={onClose} title="保存并关闭" className="rounded p-1.5 text-slate-500 hover:bg-slate-100"><X size={17}/></button></header>
      {view.session?.error && <p className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700">会话上次处理失败：{view.session.error}</p>}
      {loading ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={20} className="animate-spin"/>正在分页读取会话…</div> : <div className="tracking-confirmation-layout">
        <aside className="tracking-confirmation-list">{groups.map(group => <section key={group.category}>{group.items.length > 0 && <h4 className="sticky top-0 z-10 flex justify-between border-y border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-500"><span>{categoryLabel[group.category]}</span><span>{group.items.length}</span></h4>}{group.items.map(item => <button key={item.id} type="button" aria-pressed={item.id === view.selectedItemId} onClick={() => setView(current => ({ ...current, selectedItemId: item.id }))} className={`tracking-confirmation-row ${item.id === view.selectedItemId ? 'is-selected' : ''}`}><span className="min-w-0"><b className="block truncate" title={item.sourceName || item.targetName}>{item.sourceName || item.targetName || '未命名媒体'}</b><small className="mt-1 block truncate text-slate-400">{item.referenceName ? `上一版 · ${item.referenceName}` : '未关联上一版本'}</small></span><span className={`tracking-confirmation-status is-${item.status}`}>{statusLabel[item.status]}</span><small className="col-span-2 text-right text-slate-400">{item.confidence || '—'}</small></button>)}</section>)}</aside>
        <main className="tracking-confirmation-main">{selectedItem ? <><div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500"><span className="truncate"><b className="text-slate-700">{selectedItem.sourceName || selectedItem.targetName}</b> · {statusLabel[selectedItem.status]} · {selectedItem.confidence || '无置信度'}</span><div className="flex shrink-0 gap-1"><button type="button" onClick={() => setView(current => ({ ...current, selectedItemId: adjacentTrackingPreviewItemId(current.items, current.selectedItemId, -1) }))} className="dialog-secondary !px-2 !py-1" title="上一项"><ArrowLeft size={14}/></button><button type="button" onClick={() => setView(current => ({ ...current, selectedItemId: adjacentTrackingPreviewItemId(current.items, current.selectedItemId, 1) }))} className="dialog-secondary !px-2 !py-1" title="下一项"><ArrowRight size={14}/></button></div></div><ProgressPairPreview referencePath={paths.referencePath} sourcePath={paths.sourcePath} referenceLabel={selectedItem.referenceName ? `上一版本 · ${selectedItem.referenceName}` : '上一版本'} sourceLabel={`当前版本 · ${selectedItem.sourceName || selectedItem.targetName || ''}`} referenceMissing={paths.referenceMissing} mode={mode} swapped={swapped} cacheConfig={cacheConfig} onModeChange={setMode} onSwappedChange={setSwapped}/><div className="tracking-confirmation-decisions">{unresolvedTrackingStatus(selectedItem.status) && <div className="flex min-w-[240px] flex-1 gap-2"><input value={relocateName} onChange={event => setRelocateName(event.target.value)} placeholder="输入上一版本中的文件名" className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-xs"/><button type="button" disabled={!relocateName.trim() || Boolean(busyItemId)} onClick={() => void decide('accepted', relocateName.trim())} className="dialog-secondary">关联上一版本</button></div>}{unresolvedTrackingStatus(selectedItem.status) && <><button type="button" disabled={Boolean(busyItemId)} onClick={() => void decide('rejected')} className="dialog-secondary">拒绝</button>{selectedItem.status === 'pending_confirmation' && <button type="button" disabled={Boolean(busyItemId)} onClick={() => void decide('accepted')} className="dialog-primary">确认为新素材</button>}</>}</div></> : <div className="flex flex-1 items-center justify-center text-sm text-slate-400">该会话没有确认项目。</div>}</main>
      </div>}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4"><button type="button" disabled={committing} onClick={() => void release()} className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-40">取消并释放会话</button><div className="flex gap-2"><button type="button" disabled={committing} onClick={onClose} className="dialog-secondary">保存并关闭</button><button type="button" disabled={committing || loading || !canCommitTrackingSession(view.items) || Boolean(view.session?.status === 'failed' && !view.items.length)} onClick={() => void commit()} className="dialog-primary inline-flex items-center gap-2">{committing && <Loader2 size={15} className="animate-spin"/>}确认并提交</button></div></footer>
    </div>
  </div>;
};
