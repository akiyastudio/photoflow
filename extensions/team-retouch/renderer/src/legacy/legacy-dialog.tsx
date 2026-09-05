import { useCallback, useMemo, useReducer, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LegacyDialogContext, type LegacyDialogApi, type LegacyDialogOptions, type LegacyDialogRequest } from './legacy-dialog-context';
import { createDialogQueue } from './dialog-queue-model';
import { useEscapeLayer } from './legacy-layer';

type DialogResult = boolean | string | null;

const LegacyDialog = ({ entry, advance }: { entry: { token: number; request: LegacyDialogRequest }; advance: (token: number, value: DialogResult) => void }) => {
  const { request, token } = entry;
  const [input, setInput] = useState(request.defaultValue || '');
  const dismissible = request.dismissible !== false;
  const cancelValue = request.kind === 'confirm' ? false : null;
  const close = useCallback((value: DialogResult) => advance(token, value), [advance, token]);
  const rootRef = useEscapeLayer<HTMLElement>(true, () => close(cancelValue), dismissible);
  return createPortal(
    <div className="pf-modal-backdrop fixed inset-0 z-[900] flex items-center justify-center p-4" onMouseDown={event => { if (dismissible && event.target === event.currentTarget) close(cancelValue); }}>
      <section ref={rootRef} role="dialog" aria-modal="true" aria-label={request.title} className="pf-modal w-full max-w-md p-5">
        <h3 className="pf-dialog-title text-base font-bold">{request.title}</h3>
        <p className="pf-dialog-message mt-3 text-sm leading-6">{request.message}</p>
        {request.detail && <p className="pf-dialog-detail mt-2 rounded-lg px-3 py-2 text-xs leading-5">{request.detail}</p>}
        {request.kind === 'prompt' && <input autoFocus value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') close(input); }} className="pf-input mt-4 w-full px-3 text-sm"/>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button data-autofocus={request.cancelDefault || undefined} className="pf-button dialog-secondary" onClick={() => close(cancelValue)}>{request.cancelLabel || '取消'}</button>
          {request.kind === 'choice' ? request.choices?.map(choice => <button key={choice.value} data-autofocus={!request.cancelDefault && choice.value === request.defaultValue || undefined} className={choice.tone === 'danger' ? 'pf-button pf-button-danger' : choice.value === request.defaultValue ? 'pf-button-primary dialog-primary' : 'pf-button dialog-secondary'} onClick={() => close(choice.value)}>{choice.label}</button>) : <button data-autofocus={!request.cancelDefault || undefined} className={request.tone === 'danger' ? 'pf-button pf-button-danger' : 'pf-button-primary dialog-primary'} onClick={() => close(request.kind === 'confirm' ? true : input)}>{request.confirmLabel || '确认'}</button>}
        </div>
      </section>
    </div>, document.body);
};

export const LegacyDialogProvider = ({ children }: { children: ReactNode }) => {
  const [queue] = useState(() => createDialogQueue<LegacyDialogRequest, DialogResult>());
  const [, renderNext] = useReducer(value => value + 1, 0);
  const ask = useCallback((kind: LegacyDialogRequest['kind'], value: LegacyDialogOptions) => { const result = queue.ask({ ...value, kind }); renderNext(); return result; }, [queue]);
  const advance = useCallback((token: number, value: DialogResult) => { if (queue.settle(token, value)) renderNext(); }, [queue]);
  const api = useMemo<LegacyDialogApi>(() => ({
    confirm: value => ask('confirm', value) as Promise<boolean>,
    prompt: value => ask('prompt', value) as Promise<string | null>,
    choice: value => ask('choice', value) as Promise<string | null>,
  }), [ask]);
  const current = queue.current();
  return <LegacyDialogContext.Provider value={api}>{children}{current && <LegacyDialog key={current.token} entry={current} advance={advance}/>}</LegacyDialogContext.Provider>;
};
