import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LegacyDialogContext, type LegacyDialogApi, type LegacyDialogOptions, type LegacyDialogRequest } from './legacy-dialog-context';

export const LegacyDialogProvider = ({ children }: { children: ReactNode }) => {
  const [request, setRequest] = useState<LegacyDialogRequest>();
  const [input, setInput] = useState('');
  const ask = <T,>(kind: LegacyDialogRequest['kind'], value: LegacyDialogOptions) => new Promise<T>(resolve => { setInput(value.defaultValue || ''); setRequest({ ...value, kind, resolve }); });
  const close = (value: any) => { const current = request; setRequest(undefined); current?.resolve(value); };
  const api: LegacyDialogApi = { confirm: value => ask('confirm', value), prompt: value => ask('prompt', value), choice: value => ask('choice', value) };
  return <LegacyDialogContext.Provider value={api}>{children}{request && createPortal(
    <div className="pf-modal-backdrop fixed inset-0 z-[900] flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(request.kind === 'confirm' ? false : null); }}>
      <section role="dialog" aria-modal="true" aria-label={request.title} className="pf-modal w-full max-w-md p-5">
        <h3 className="text-base font-bold text-slate-900">{request.title}</h3>
        <p className="mt-3 text-sm leading-6 text-slate-600">{request.message}</p>
        {request.detail && <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">{request.detail}</p>}
        {request.kind === 'prompt' && <input autoFocus value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') close(input); if (event.key === 'Escape') close(null); }} className="pf-input mt-4 w-full px-3 text-sm"/>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className="pf-button dialog-secondary" onClick={() => close(request.kind === 'confirm' ? false : null)}>{request.cancelLabel || '取消'}</button>
          {request.kind === 'choice' ? request.choices?.map(choice => <button key={choice.value} className={choice.value === request.defaultValue ? 'pf-button-primary dialog-primary' : 'pf-button dialog-secondary'} onClick={() => close(choice.value)}>{choice.label}</button>) : <button className={request.tone === 'danger' ? 'rounded-md bg-red-600 px-4 py-2 text-xs font-bold text-white' : 'pf-button-primary dialog-primary'} onClick={() => close(request.kind === 'confirm' ? true : input)}>{request.confirmLabel || '确认'}</button>}
        </div>
      </section>
    </div>, document.body)}</LegacyDialogContext.Provider>;
};
