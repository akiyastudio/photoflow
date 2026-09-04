export type HistoryLoadView = { initialLoading: boolean; loadError: string; entriesLoaded: boolean; entryCount: number };
export const historyLoadPresentation = (state: HistoryLoadView) => {
  if (state.initialLoading && !state.entriesLoaded) return { phase: 'loading' as const, title: '团片协作 · 正在读取团片历史' };
  if (state.loadError && !state.entriesLoaded) return { phase: 'error' as const, title: '团片协作 · 历史读取失败' };
  return { phase: 'ready' as const, title: `团片协作 · ${state.entryCount} 张图片` };
};
export const needsBlockingHistoryCalibration = (workspace: Record<string, any>, resolution: { historyPhotoCount?: number; resolvedHistoryCount?: number }) => (
  Number(resolution.historyPhotoCount) > 0
  && Number(resolution.resolvedHistoryCount) === 0
  && Number(workspace?.calibration?.pendingCount) > 0
);
export const historyCalibrationMadeProgress = (previousPending: number, workspace: Record<string, any>, calibratedCount: number) => (
  Number(calibratedCount) > 0 && Number(workspace?.calibration?.pendingCount) < Number(previousPending)
);
export const createLatestHistoryLoadGuard = () => { let current = 0; return { begin: () => ++current, isCurrent: (requestId: number) => requestId === current, invalidate: () => { current += 1; } }; };
export const historyMigrationDelayMs = (phase: string, waitCount: number) => phase === 'host-storage-adoption' ? Math.min(5_000, 750 * (2 ** Math.min(Math.max(0, waitCount), 3))) : 100;
export const createActivationRefreshGate = () => {
  let deactivated = false;
  return { deactivate: () => { deactivated = true; }, activate: () => { if (!deactivated) return false; deactivated = false; return true; } };
};
export type HistoryLoadContext = {
  componentId?: string; componentVersion?: string; projectId?: string; projectName?: string; projectStatus?: string;
  scopeRelativePath?: string; selectedRelativePaths?: string[]; sourcePageId?: string; resolvedTheme?: string;
};
export const historyLoadContextSignature = (context: HistoryLoadContext) => JSON.stringify([
  String(context.componentId || ''), String(context.componentVersion || ''), String(context.projectId || ''),
  String(context.projectName || ''), String(context.projectStatus || ''), String(context.scopeRelativePath || ''),
  (context.selectedRelativePaths || []).map(String), String(context.sourcePageId || ''),
]);
export const createHistoryContextLoadCoordinator = <T extends HistoryLoadContext>(load: (context: T, manualMigrationRetry: boolean) => Promise<void>) => {
  type Pending = { context: T; signature: string; force: boolean; manualMigrationRetry: boolean };
  let current: Promise<void> | null = null;
  let activeSignature = '';
  let completedSignature = '';
  let queued: Pending | null = null;
  const start = (pending: Pending): Promise<void> => {
    activeSignature = pending.signature;
    const operation = Promise.resolve(load(pending.context, pending.manualMigrationRetry)).then(() => { completedSignature = pending.signature; }).finally(() => {
      if (current !== operation) return;
      current = null; activeSignature = '';
      const next = queued; queued = null;
      if (next && (next.force || next.signature !== completedSignature)) start(next);
    });
    current = operation; return operation;
  };
  const request = (context: T, options: { force?: boolean; manualMigrationRetry?: boolean } = {}) => {
    const pending: Pending = { context, signature: historyLoadContextSignature(context), force: options.force === true, manualMigrationRetry: options.manualMigrationRetry === true };
    if (current) {
      if (!pending.force && pending.signature === activeSignature) { if (!queued?.force) queued = null; return current; }
      if (!pending.force && queued?.signature === pending.signature) return current;
      queued = pending; return current;
    }
    if (!pending.force && pending.signature === completedSignature) return Promise.resolve();
    return start(pending);
  };
  return { request, isLoading: () => Boolean(current), hasQueuedLoad: () => Boolean(queued) };
};
