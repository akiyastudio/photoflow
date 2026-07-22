import { Loader2, Trash2 } from 'lucide-react';
import type { ProjectFileOperationProgress } from '../../types';

type Props = {
  progress: ProjectFileOperationProgress | null;
  cancelling: boolean;
  onCancel: () => void;
};

const operationTitle = (progress: ProjectFileOperationProgress, cancelling: boolean) => {
  if (progress.operation === 'trash') return '正在移入回收站…';
  if (cancelling) return '正在取消文件操作…';
  if (progress.operation === 'import-broll') {
    if (progress.phase === 'scanning') return '正在准备花絮导入…';
    if (progress.phase === 'splitting') return '正在无损分割大型视频…';
    if (progress.phase === 'finishing') return '正在完成花絮导入…';
    return '正在导入花絮…';
  }
  if (progress.phase === 'scanning') return '正在准备粘贴…';
  if (progress.phase === 'finishing') return '正在完成剪切…';
  return '正在粘贴文件';
};

export const FileOperationProgressOverlay = ({ progress, cancelling, onCancel }: Props) => {
  if (!progress) return null;
  const trashingOne = progress.operation === 'trash' && progress.totalCount === 1;
  return <div className="fixed left-1/2 top-10 z-[410] w-[min(92vw,460px)] -translate-x-1/2 rounded-xl bg-slate-900 p-4 text-white shadow-2xl animate-in fade-in slide-in-from-top-2">
    <div className="flex items-start gap-3">
      {progress.operation === 'trash'
        ? <Trash2 size={19} className="mt-0.5 shrink-0 text-red-300"/>
        : <Loader2 size={19} className="mt-0.5 shrink-0 animate-spin text-blue-300"/>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-bold">{operationTitle(progress, cancelling)}</p>
          <span className="font-mono text-xs text-slate-300">{trashingOne ? '处理中' : `${progress.progress}%`}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/15">
          <div className={`h-full rounded-full transition-[width] duration-150 ${progress.operation === 'trash' ? 'bg-red-400' : 'bg-blue-400'} ${trashingOne ? 'animate-pulse' : ''}`} style={{ width: trashingOne ? '100%' : `${progress.progress}%` }}/>
        </div>
        <p className="mt-2 truncate text-xs text-slate-300">
          {progress.currentName || (progress.phase === 'scanning' ? '正在统计文件大小和数量' : '正在处理文件')}
          {progress.operation === 'trash' && (progress.totalCount || 0) > 1 ? ` · ${progress.processedCount || 0}/${progress.totalCount}` : ''}
        </p>
      </div>
      {progress.operation !== 'trash' && <button type="button" onClick={onCancel} disabled={cancelling || progress.phase === 'finishing'} className="shrink-0 rounded-md border border-white/20 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45">取消</button>}
    </div>
  </div>;
};
