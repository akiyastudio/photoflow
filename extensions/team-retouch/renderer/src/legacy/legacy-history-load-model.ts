export type HistoryLoadView = { initialLoading: boolean; loadError: string; entriesLoaded: boolean; entryCount: number };
export const historyLoadPresentation = (state: HistoryLoadView) => {
  if (state.initialLoading && !state.entriesLoaded) return { phase: 'loading' as const, title: '团片协作 · 正在读取团片历史' };
  if (state.loadError && !state.entriesLoaded) return { phase: 'error' as const, title: '团片协作 · 历史读取失败' };
  return { phase: 'ready' as const, title: `团片协作 · ${state.entryCount} 张图片` };
};
export const createLatestHistoryLoadGuard = () => { let current = 0; return { begin: () => ++current, isCurrent: (requestId: number) => requestId === current, invalidate: () => { current += 1; } }; };
export const historyMigrationDelayMs = (phase: string, waitCount: number) => phase === 'host-storage-adoption' ? Math.min(5_000, 750 * (2 ** Math.min(Math.max(0, waitCount), 3))) : 100;
export const createActivationRefreshGate = () => {
  let deactivated = false;
  return { deactivate: () => { deactivated = true; }, activate: () => { if (!deactivated) return false; deactivated = false; return true; } };
};
