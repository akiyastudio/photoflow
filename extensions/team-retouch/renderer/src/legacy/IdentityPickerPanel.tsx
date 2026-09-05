import React, { useMemo, useState } from 'react';
import { Loader2, Search, UserRound, X } from 'lucide-react';
import { useEscapeLayer } from './legacy-layer';

type PickerIdentity = { id: string; name: string; color: string };

type IdentityPickerPanelProps<TIdentity extends PickerIdentity> = {
  title?: string;
  description: string;
  badge?: React.ReactNode;
  currentLabel?: string;
  currentPreview: React.ReactNode;
  currentName: React.ReactNode;
  currentStatus?: React.ReactNode;
  identities: TIdentity[];
  selectedIdentityId?: string;
  identityCount: (identity: TIdentity) => number;
  renderIdentityPreview: (identity: TIdentity) => React.ReactNode;
  onSelect: (identity: TIdentity) => void;
  onCreate: () => void;
  onClear: () => void;
  onClose: () => void;
  busy?: boolean;
  busyLabel?: string;
  selectionTitle?: string;
  selectionDescription: string;
  createLabel?: string;
  clearLabel?: string;
  leadingContent?: React.ReactNode;
  extraCurrentActions?: React.ReactNode;
};

export function IdentityPickerPanel<TIdentity extends PickerIdentity>({
  title = '这是谁？', description, badge, currentLabel = '当前人物', currentPreview, currentName, currentStatus,
  identities, selectedIdentityId, identityCount, renderIdentityPreview, onSelect, onCreate, onClear, onClose,
  busy = false, busyLabel = '正在保存人物归属…', selectionTitle = '选择已有身份', selectionDescription,
  createLabel = '这是一个新人物', clearLabel = '设为未标记', leadingContent, extraCurrentActions,
}: IdentityPickerPanelProps<TIdentity>) {
  const [identitySearch, setIdentitySearch] = useState('');
  const normalizedSearch = identitySearch.trim().toLocaleLowerCase('zh-CN');
  const filteredIdentities = useMemo(() => normalizedSearch
    ? identities.filter(identity => identity.name.toLocaleLowerCase('zh-CN').includes(normalizedSearch))
    : identities, [identities, normalizedSearch]);
  useEscapeLayer(true, onClose, !busy);

  return <div role="dialog" aria-modal="true" aria-label="确认人物身份" className="fixed inset-0 z-[470] flex items-center justify-center bg-slate-950/75 p-5" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="flex h-[94vh] max-h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <header className="flex items-center gap-4 border-b border-slate-200 px-5 py-4"><div><h3 className="font-bold text-slate-900">{title}</h3><p className="mt-1 text-xs text-slate-500">{description}</p></div>{badge && <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">{badge}</span>}<button type="button" disabled={busy} onClick={onClose} className="ml-auto rounded-md p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"><X size={19}/></button></header>
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
        <aside className="overflow-y-auto border-r border-slate-200 bg-slate-50 p-5"><p className="mb-2 text-xs font-bold text-slate-500">{currentLabel}</p>{currentPreview}<p className="mt-3 text-sm font-bold text-slate-800">{currentName}</p>{currentStatus && <div className="mt-1 text-xs text-slate-500">{currentStatus}</div>}<div className="mt-5 space-y-2"><button type="button" disabled={busy} onClick={onCreate} className="dialog-primary w-full">{createLabel}</button><button type="button" disabled={busy} onClick={onClear} className="dialog-secondary w-full">{clearLabel}</button>{extraCurrentActions}</div></aside>
        <section className="min-h-0 overflow-y-auto p-5">{leadingContent}{leadingContent && <div className="my-6 border-t border-slate-200"/>}<div className="flex items-center gap-3"><div><h4 className="text-sm font-bold text-slate-800">{selectionTitle}</h4><p className="mt-1 text-xs text-slate-500">{selectionDescription}</p></div><div className="ml-auto flex items-center gap-2"><label className="relative block"><Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"/><input type="search" value={identitySearch} disabled={busy} onChange={event => setIdentitySearch(event.target.value)} aria-label="搜索人物姓名" placeholder="搜索人物姓名" className="h-9 w-48 rounded-md border border-slate-200 bg-white pl-8 pr-3 text-xs text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:opacity-50"/></label><button type="button" disabled={busy} onClick={onCreate} className="dialog-secondary">新建人物</button></div></div>
          {filteredIdentities.length ? <div data-identity-picker-grid className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{filteredIdentities.map(identity => { const selected = selectedIdentityId === identity.id; return <div key={identity.id} className={`group relative overflow-hidden rounded-lg border bg-white transition hover:border-blue-400 hover:shadow-md focus-within:ring-2 focus-within:ring-blue-500 ${selected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200'} ${busy ? 'opacity-50' : ''}`}>{renderIdentityPreview(identity) || <div className="flex aspect-[4/3] items-center justify-center bg-slate-100 text-slate-400"><UserRound/></div>}<div className="pointer-events-none flex w-full items-center gap-1.5 border-t border-slate-100 p-2 text-left transition group-hover:bg-blue-50"><span className="h-2 w-2 rounded-full" style={{ background: identity.color }}/><span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-800">{identity.name}</span><span className="text-[10px] text-slate-400">{identityCount(identity)} 张</span></div><button type="button" disabled={busy} aria-label={`选择人物身份“${identity.name}”`} title={`选择“${identity.name}”`} onClick={() => onSelect(identity)} className="absolute inset-0 z-10 cursor-pointer rounded-lg focus:outline-none disabled:cursor-not-allowed"><span className="sr-only">选择人物身份“{identity.name}”</span></button></div>; })}</div> : <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">{identities.length ? `没有找到名称包含“${identitySearch.trim()}”的人物。` : '还没有已确认人物，请新建第一个人物。'}</div>}
        </section>
      </div>
      {busy && <footer className="flex items-center justify-center border-t border-blue-100 bg-blue-50 px-5 py-3 text-xs font-bold text-blue-700"><Loader2 size={14} className="mr-2 animate-spin"/>{busyLabel}</footer>}
    </div>
  </div>;
}
