import { FileInput, FolderInput, Loader2, Plus } from 'lucide-react';
import { PanelSwitch } from './PanelSwitch';

type ImportSourceControlsProps = {
  selectionTitle: string;
  selectionDescription: string;
  selectedCount: number;
  onChooseFiles: () => void;
  onChooseFolder?: () => void;
  chooseFilesLabel?: string;
  chooseFolderLabel?: string;
  deleteSourceAfterImport: boolean;
  onDeleteSourceAfterImportChange: (value: boolean) => void;
  deleteSourceDescription: string;
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
  chooseFilesLabel = '选择文件',
  chooseFolderLabel = '选择文件夹',
  deleteSourceAfterImport,
  onDeleteSourceAfterImportChange,
  deleteSourceDescription,
  statusText,
  startLabel = '开始导入',
  busyLabel = '正在导入…',
  busy = false,
  startDisabled = false,
  onStart,
}: ImportSourceControlsProps) => <div className="space-y-4">
  <div className="grid min-h-44 place-items-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-7 text-center">
    <div>
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Plus size={20}/></span>
      <p className="mt-3 text-sm font-bold text-slate-700">{selectionTitle}</p>
      <p className="mt-1 text-xs text-slate-400">{selectionDescription}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" disabled={busy} onClick={onChooseFiles} className="dialog-primary inline-flex items-center gap-2 disabled:opacity-50"><FileInput size={15}/>{chooseFilesLabel}</button>
        {onChooseFolder && <button type="button" disabled={busy} onClick={onChooseFolder} className="dialog-secondary inline-flex items-center gap-2 disabled:opacity-50"><FolderInput size={15}/>{chooseFolderLabel}</button>}
      </div>
    </div>
  </div>

  <PanelSwitch title="导入后删除源文件" description={deleteSourceDescription} checked={deleteSourceAfterImport} disabled={busy} onChange={onDeleteSourceAfterImportChange}/>

  <div className="flex items-center gap-3 border-t border-slate-200 pt-4">
    <span className="mr-auto text-xs text-slate-400">{statusText || (selectedCount ? `已选择 ${selectedCount} 个来源` : '尚未选择来源')}</span>
    <button type="button" onClick={onStart} disabled={busy || startDisabled || !selectedCount} className="dialog-primary inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50">
      {busy && <Loader2 size={15} className="animate-spin"/>}
      {busy ? busyLabel : startLabel}
    </button>
  </div>
</div>;
