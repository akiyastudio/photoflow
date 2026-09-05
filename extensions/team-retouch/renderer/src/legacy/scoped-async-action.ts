export const normalizeAsyncError = (value: unknown) => value instanceof Error ? value : new Error(String((value as { error?: unknown })?.error || value || '未知错误'));

export const createScopedAsyncController = (initialScope = '') => {
  let scope = initialScope; let generation = 0; let pending = 0;
  return {
    setScope(next: string) { if (next !== scope) { scope = next; generation += 1; pending = 0; } },
    invalidate() { generation += 1; pending = 0; },
    isBusy: () => pending > 0,
    async run<T>(action: () => Promise<T>, handlers: { success?: (value: T) => void; error?: (error: Error) => void; finally?: () => void } = {}) {
      const token = { scope, generation }; pending += 1;
      try { const value = await action(); if (token.scope === scope && token.generation === generation) handlers.success?.(value); return value; }
      catch (error) { const normalized = normalizeAsyncError(error); if (token.scope === scope && token.generation === generation) handlers.error?.(normalized); throw normalized; }
      finally { if (token.scope === scope && token.generation === generation) { pending = Math.max(0, pending - 1); handlers.finally?.(); } }
    },
  };
};
