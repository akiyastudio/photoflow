import { useState } from 'react';
import { FileInput, FolderInput, Loader2, Plus } from 'lucide-react';
import { PanelSwitch } from './PanelSwitch';

type ImportSourceControlsProps = {
  selectionTitle: string;
  selectionDescription: string;
  selectedCount: number;
  onChooseFiles: () => void;
  onChooseFolder?: () => void;
  onDropPaths?: (paths: string[]) => void;
  chooseFilesLabel?: string;
  chooseFolderLabel?: string;
  deleteSourceAfterImport: boolean;
  onDeleteSourceAfterImportChange: (value: boolean) => void;
  deleteSourceDescription: string;
  linkOnly?: boolean;
  onLinkOnlyChange?: (value: boolean) => void;
  statusText?: string;
  startLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  startDisabled?: boolean;
  onStart: () => void;
};

export const ImportSourceControls = ({
  selectionTitle,
  selectionDescription,
  selectedCount,
  onChooseFiles,
  onChooseFolder,
  onDropPaths,
  chooseFilesLabel = '选择文件',
  chooseFolderLabel = '选择文件夹',
  deleteSourceAfterImport,
  onDeleteSourceAfterImportChange,
  deleteSourceDescription,
  linkOnly = false,
  onLinkOnlyChange,
  statusText,
  startLabel = '开始导入',
  busyLabel = '正在导入…',
  busy = false,
  startDisabled = false,
  onStart,
}: ImportSourceControlsProps) => {
  const [dragActive, setDragActive] = useState(false);
  const acceptDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!onDropPaths || busy || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };
  const leaveDropZone = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  };
  const dropSources = (event: React.DragEvent<HTMLDivElement>) => {
    if (!onDropPaths || busy) return;
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const paths = Array.from(event.dataTransfer.files).map(file => {
      try { return window.electronAPI.getPathForFile(file); }
      catch { return ''; }
    }).filter(Boolean);
    if (paths.length) onDropPaths([...new Set(paths)]);
  };

  return <div className="space-y-4">
  <div
    onDragEnter={acceptDrop}
    onDragOver={acceptDrop}
    onDragLeave={leaveDropZone}
    onDrop={dropSources}
    className={`grid min-h-44 place-items-center rounded-xl border border-dashed px-6 py-7 text-center transition ${dragActive ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500/20' : 'border-slate-300 bg-slate-50'}`}
  >
    <div>
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Plus size={20}/></span>
      <p className="mt-3 text-sm font-bold text-slate-700">{selectionTitle}</p>
      <p className={`mt-1 text-xs ${dragActive ? 'font-medium text-blue-600' : 'text-slate-400'}`}>{dragActive ? '松开即可添加文件或文件夹' : selectionDescription}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" disabled={busy} onClick={onChooseFiles} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-50"><FileInput size={15}/>{chooseFilesLabel}</button>
        {onChooseFolder && <button type="button" disabled={busy} onClick={onChooseFolder} className="dialog-secondary inline-flex items-center gap-2 disabled:opacity-50"><FolderInput size={15}/>{chooseFolderLabel}</button>}
      </div>
    </div>
  </div>

  {onLinkOnlyChange && <PanelSwitch title="只导入外链" description="不复制或移动原文件，只在项目内创建快捷方式；外部位置离线时内容会暂时不可用。" checked={linkOnly} disabled={busy} onChange={onLinkOnlyChange}/>}
  <PanelSwitch title="导入后删除源文件" description={linkOnly ? '外链模式不会复制或删除任何源文件。' : deleteSourceDescription} checked={deleteSourceAfterImport} disabled={busy || linkOnly} onChange={onDeleteSourceAfterImportChange}/>

  <div className="flex items-center gap-3 border-t border-slate-200 pt-4">
    <span className="mr-auto text-xs text-slate-400">{statusText || (selectedCount ? `已选择 ${selectedCount} 个来源` : '尚未选择来源')}</span>
    <button type="button" onClick={onStart} disabled={busy || startDisabled || !selectedCount} className="dialog-primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
      {busy && <Loader2 size={15} className="animate-spin"/>}
      {busy ? busyLabel : startLabel}
    </button>
  </div>
</div>;
};
