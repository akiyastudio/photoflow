import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

type DialogTone = 'primary' | 'danger';

type ConfirmDialogOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
};

type PromptDialogOptions = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type DialogRequest = {
  id: number;
  kind: 'confirm' | 'prompt';
  options: ConfirmDialogOptions | PromptDialogOptions;
  resolve: (value: boolean | string | null) => void;
};

type AppDialogApi = {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  prompt: (options: PromptDialogOptions) => Promise<string | null>;
};

const AppDialogContext = createContext<AppDialogApi | null>(null);

const AppDialogProvider = ({ children }: { children: ReactNode }) => {
  const nextId = useRef(1);
  const resolvingId = useRef<number | null>(null);
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const [promptValue, setPromptValue] = useState('');
  const active = queue[0];

  const enqueue = useCallback((kind: DialogRequest['kind'], options: ConfirmDialogOptions | PromptDialogOptions) => new Promise<boolean | string | null>(resolve => {
    setQueue(current => [...current, { id: nextId.current++, kind, options, resolve }]);
  }), []);

  const api = useMemo<AppDialogApi>(() => ({
    confirm: async options => (await enqueue('confirm', options)) === true,
    prompt: async options => {
      const result = await enqueue('prompt', options);
      return typeof result === 'string' ? result : null;
    },
  }), [enqueue]);

  useEffect(() => {
    if (active?.kind === 'prompt') setPromptValue((active.options as PromptDialogOptions).defaultValue || '');
  }, [active?.id, active?.kind]);

  const finish = useCallback((value: boolean | string | null) => {
    if (!active || resolvingId.current === active.id) return;
    resolvingId.current = active.id;
    active.resolve(value);
    setQueue(current => current.filter(request => request.id !== active.id));
    resolvingId.current = null;
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(active.kind === 'confirm' ? false : null);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [active, finish]);

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault();
    if (active?.kind === 'prompt') finish(promptValue);
  };

  const options = active?.options;
  const confirmOptions = active?.kind === 'confirm' ? options as ConfirmDialogOptions : null;
  const promptOptions = active?.kind === 'prompt' ? options as PromptDialogOptions : null;
  const confirmClass = confirmOptions?.tone === 'danger'
    ? 'rounded-md bg-red-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-red-500'
    : 'dialog-primary';

  return <AppDialogContext.Provider value={api}>
    {children}
    {active && options && <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/40 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) finish(active.kind === 'confirm' ? false : null); }}>
      <form onSubmit={active.kind === 'prompt' ? submitPrompt : event => event.preventDefault()} role="dialog" aria-modal="true" aria-labelledby={`app-dialog-title-${active.id}`} aria-describedby={`app-dialog-message-${active.id}`} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <h3 id={`app-dialog-title-${active.id}`} className="font-bold text-slate-800">{options.title}</h3>
          <button type="button" aria-label="关闭对话框" onClick={() => finish(active.kind === 'confirm' ? false : null)} className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18}/></button>
        </div>
        {options.message && <p id={`app-dialog-message-${active.id}`} className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-500">{options.message}</p>}
        {promptOptions && <input autoFocus value={promptValue} onChange={event => setPromptValue(event.target.value)} placeholder={promptOptions.placeholder} className="form-input mt-4"/>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => finish(active.kind === 'confirm' ? false : null)} className="dialog-secondary">{options.cancelLabel || '取消'}</button>
          {confirmOptions
            ? <button type="button" autoFocus onClick={() => finish(true)} className={confirmClass}>{confirmOptions.confirmLabel || '确认'}</button>
            : <button type="submit" disabled={!promptValue.trim()} className="dialog-primary">{promptOptions?.confirmLabel || '确认'}</button>}
        </div>
      </form>
    </div>}
  </AppDialogContext.Provider>;
};

const useAppDialog = () => {
  const value = useContext(AppDialogContext);
  if (!value) throw new Error('useAppDialog must be used inside AppDialogProvider');
  return value;
};

// Provider and hook intentionally live together so every dialog uses the same queue.
// eslint-disable-next-line react-refresh/only-export-components
export { AppDialogProvider, useAppDialog };
export type { ConfirmDialogOptions, PromptDialogOptions };
