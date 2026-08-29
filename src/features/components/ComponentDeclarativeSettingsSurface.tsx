import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import type { ComponentSettingsFormField, ComponentSettingsPageContribution, ComponentSettingsValue } from '../../types';
import { ComponentSettingsPageSurface } from './ComponentSettingsPageSurface';

type DeclarativePage = Extract<ComponentSettingsPageContribution, { renderMode: 'declarative' }> | Extract<ComponentSettingsPageContribution, { renderMode: 'hybrid' }>;
type Values = Record<string, ComponentSettingsValue>;

const FieldControl = ({ field, value, saving, onDraft, onCommit }: { field: ComponentSettingsFormField; value: ComponentSettingsValue; saving: boolean; onDraft: (value: ComponentSettingsValue) => void; onCommit: (value: ComponentSettingsValue) => void }) => {
  const inputId = `component-setting-${field.id}`;
  if (field.type === 'toggle') return <div className="flex justify-end"><input id={inputId} type="checkbox" checked={Boolean(value)} disabled={saving} onChange={event => onCommit(event.target.checked)} className="h-4 w-4 accent-blue-600"/></div>;
  if (field.type === 'select') return <div className="pf-control-cluster ml-auto max-w-sm"><select id={inputId} value={String(value)} disabled={saving} onChange={event => onCommit(event.target.value)} className="pf-select min-w-0 flex-1">{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{saving && <Loader2 size={15} className="shrink-0 animate-spin text-blue-600"/>}</div>;
  if (field.type === 'text') return <div className="pf-control-cluster ml-auto max-w-sm"><input id={inputId} value={String(value)} maxLength={field.maxLength} placeholder={field.placeholder} disabled={saving} onChange={event => onDraft(event.target.value)} onBlur={event => onCommit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="pf-input min-w-0 flex-1 px-3"/>{saving && <Loader2 size={15} className="shrink-0 animate-spin text-blue-600"/>}</div>;
  const numericValue = typeof value === 'number' ? value : field.default;
  if (field.type === 'number') return <div className="pf-control-cluster ml-auto max-w-sm"><input id={inputId} type="number" value={numericValue} min={field.min} max={field.max} step={field.step} disabled={saving} onChange={event => onDraft(Number(event.target.value))} onBlur={event => onCommit(Number(event.target.value))} className="pf-input min-w-0 flex-1 px-3"/>{field.suffix && <span className="shrink-0 text-xs font-medium text-slate-500">{field.suffix}</span>}{saving && <Loader2 size={15} className="shrink-0 animate-spin text-blue-600"/>}</div>;
  return <div className="pf-control-cluster ml-auto max-w-sm"><input id={inputId} type="range" value={numericValue} min={field.min} max={field.max} step={field.step} disabled={saving} onChange={event => onDraft(Number(event.target.value))} onPointerUp={event => onCommit(Number(event.currentTarget.value))} onKeyUp={event => onCommit(Number(event.currentTarget.value))} className="min-w-0 flex-1 accent-blue-600"/><output htmlFor={inputId} className="min-w-16 text-right text-sm font-bold tabular-nums text-slate-700">{numericValue}{field.suffix || ''}</output>{saving && <Loader2 size={15} className="shrink-0 animate-spin text-blue-600"/>}</div>;
};

export const ComponentDeclarativeSettingsSurface = ({ page }: { page: DeclarativePage }) => {
  const [values, setValues] = useState<Values>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [customReady, setCustomReady] = useState(false);
  const [customLoadError, setCustomLoadError] = useState('');
  const [customAttempt, setCustomAttempt] = useState(0);
  const committedRef = useRef<Values>({});
  const pendingRef = useRef<Values>({});
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    setLoading(true); setLoadError(''); setSaveError('');
    const result = await window.electronAPI.readComponentSettingsForm({ componentId: page.componentId, pageId: page.pageId });
    if (!result.success || !result.values) { setLoadError(result.error || '无法读取组件设置'); setLoading(false); return; }
    committedRef.current = result.values; pendingRef.current = {}; setValues(result.values); setLoading(false);
  }, [page.componentId, page.pageId]);

  useEffect(() => { void load(); }, [load]);
  const handleCustomReady = useCallback(() => { setCustomLoadError(''); setCustomReady(true); }, []);
  const handleCustomError = useCallback((message: string) => { setCustomReady(false); setCustomLoadError(message); }, []);
  const retryHybridLoad = () => {
    if (loadError) void load();
    if (customLoadError) { setCustomLoadError(''); setCustomReady(false); setCustomAttempt(current => current + 1); }
  };
  const draft = (id: string, value: ComponentSettingsValue) => { pendingRef.current = { ...pendingRef.current, [id]: value }; setValues(current => ({ ...current, [id]: value })); };
  const commit = (id: string, value: ComponentSettingsValue) => {
    if (Object.is(committedRef.current[id], value) && !Object.hasOwn(pendingRef.current, id)) return;
    draft(id, value); setSaveError(''); setSavingIds(current => new Set(current).add(id));
    const run = async () => {
      const desired = pendingRef.current[id];
      const result = await window.electronAPI.updateComponentSettingsForm({ componentId: page.componentId, pageId: page.pageId, patch: { [id]: desired } });
      if (!result.success || !result.values) throw new Error(result.error || '保存组件设置失败');
      committedRef.current = result.values;
      if (Object.is(pendingRef.current[id], desired)) { const next = { ...pendingRef.current }; delete next[id]; pendingRef.current = next; }
      setValues({ ...result.values, ...pendingRef.current });
    };
    const queued = queueRef.current.catch(() => undefined).then(run).catch(error => {
      const next = { ...pendingRef.current }; delete next[id]; pendingRef.current = next;
      setValues({ ...committedRef.current, ...next }); setSaveError(error instanceof Error ? error.message : String(error));
    }).finally(() => setSavingIds(current => { const next = new Set(current); next.delete(id); return next; }));
    queueRef.current = queued;
  };

  const form = <div className="pf-settings-container"><header className="pf-settings-header"><h1 className="pf-settings-title">{page.pageTitle}</h1></header>{saveError && <div role="alert" data-tone="danger" className="pf-callout">{saveError}</div>}{page.form.groups.map(group => <section key={group.id} className="pf-settings-group"><h2 className="pf-settings-group-title">{group.title}</h2>{group.description && <p className="pf-settings-group-description">{group.description}</p>}<div className="pf-settings-card">{group.fields.map(field => <div key={field.id} className="pf-settings-row"><div className="pf-settings-copy"><label htmlFor={`component-setting-${field.id}`} className="pf-settings-row-title">{field.label}</label>{field.description && <p className="pf-settings-description">{field.description}</p>}</div><div className="pf-settings-control"><FieldControl field={field} value={values[field.id] ?? field.default} saving={savingIds.has(field.id)} onDraft={value => draft(field.id, value)} onCommit={value => commit(field.id, value)}/></div></div>)}</div></section>)}</div>;
  if (page.renderMode === 'hybrid') {
    const pageReady = !loading && !loadError && customReady && !customLoadError;
    const failure = loadError || customLoadError;
    return <div className="pf-settings-page relative h-full overflow-hidden">
      <div aria-hidden={!pageReady} className={`h-full overflow-y-auto ${pageReady ? '' : 'invisible'}`}>
        {form}
        <section aria-label={page.customPageTitle} className="mx-auto w-full max-w-6xl overflow-hidden" style={{ height: 'clamp(460px, 65vh, 760px)' }}>
          <ComponentSettingsPageSurface key={customAttempt} page={page} visible={pageReady} onReady={handleCustomReady} onError={handleCustomError}/>
        </section>
      </div>
      {!pageReady && <div className="absolute inset-0 flex items-center justify-center p-6">
        {failure ? <section className="pf-card w-full max-w-xl p-6 text-center"><AlertTriangle size={24} className="mx-auto text-red-600"/><h2 className="mt-3 text-sm font-bold">组件设置读取失败</h2><p className="pf-settings-description mt-2">{failure}</p><button type="button" onClick={retryHybridLoad} className="pf-button mt-4 inline-flex items-center gap-2"><RotateCcw size={14}/>重试</button></section> : <div className="flex items-center gap-2 text-sm font-bold"><Loader2 size={18} className="animate-spin text-blue-600"/>正在打开{page.pageTitle}…</div>}
      </div>}
    </div>;
  }
  if (loading) return <div className="pf-settings-page flex h-full items-center justify-center gap-2 text-sm font-bold"><Loader2 size={18} className="animate-spin text-blue-600"/>正在读取{page.pageTitle}…</div>;
  if (loadError) return <div className="pf-settings-page flex h-full items-center justify-center p-6"><section className="pf-card w-full max-w-xl p-6 text-center"><AlertTriangle size={24} className="mx-auto text-red-600"/><h2 className="mt-3 text-sm font-bold">组件设置读取失败</h2><p className="pf-settings-description mt-2">{loadError}</p><button type="button" onClick={() => void load()} className="pf-button mt-4 inline-flex items-center gap-2"><RotateCcw size={14}/>重试</button></section></div>;
  return <div className="pf-settings-page h-full">{form}</div>;
};
