import type { ProgressTrackingItem, ProgressTrackingSession } from '../../types';

export type TrackingConfirmationCategory = 'recognized' | 'accepted' | 'pending' | 'missing';

export const trackingConfirmationCategory = (item: ProgressTrackingItem): TrackingConfirmationCategory => {
  if (item.status === 'accepted' || item.status === 'rejected') return 'accepted';
  if (item.status === 'pending_confirmation') return 'pending';
  if (item.status === 'missing_reference') return 'missing';
  return 'recognized';
};

export const groupTrackingConfirmationItems = (items: readonly ProgressTrackingItem[]) => (['recognized', 'accepted', 'pending', 'missing'] as const)
  .map(category => ({ category, items: items.filter(item => trackingConfirmationCategory(item) === category) }));

export type TrackingConfirmationViewState = {
  sessionId: string;
  session?: ProgressTrackingSession;
  items: ProgressTrackingItem[];
  selectedItemId?: string;
  nextCursor?: number;
  minimized: boolean;
};

export const unresolvedTrackingStatus = (status: ProgressTrackingItem['status']) =>
  status === 'pending_confirmation' || status === 'missing_reference';

export const firstTrackingPreviewItemId = (items: readonly ProgressTrackingItem[]) =>
  items.find(item => item.status === 'pending_confirmation')?.id
  || items.find(item => item.status === 'missing_reference')?.id
  || items[0]?.id;

export const adjacentTrackingPreviewItemId = (items: readonly ProgressTrackingItem[], selectedId: string | undefined, direction: -1 | 1) => {
  if (!items.length) return undefined;
  const current = items.findIndex(item => item.id === selectedId);
  return items[(current < 0 ? 0 : current + direction + items.length) % items.length]?.id;
};

export const nextPendingTrackingItemId = (items: readonly ProgressTrackingItem[], selectedId?: string) => {
  const start = Math.max(0, items.findIndex(item => item.id === selectedId));
  for (let offset = 1; offset <= items.length; offset += 1) {
    const item = items[(start + offset) % items.length];
    if (item && unresolvedTrackingStatus(item.status)) return item.id;
  }
  return undefined;
};

export const mergeTrackingSessionPage = (
  state: TrackingConfirmationViewState,
  page: { session?: ProgressTrackingSession; items: ProgressTrackingItem[]; nextCursor?: number },
) => {
  if (page.session && page.session.id !== state.sessionId) return state;
  const byId = new Map(state.items.map(item => [item.id, item]));
  page.items.forEach(item => byId.set(item.id, item));
  const items = [...byId.values()];
  return {
    ...state,
    session: page.session || state.session,
    items,
    nextCursor: page.nextCursor,
    selectedItemId: state.selectedItemId && byId.has(state.selectedItemId)
      ? state.selectedItemId
      : page.nextCursor === undefined ? firstTrackingPreviewItemId(items) : undefined,
  };
};

export const applyTrackingItemDecision = (
  state: TrackingConfirmationViewState,
  itemId: string,
  status: 'accepted' | 'rejected',
  referenceName?: string,
) => {
  const items = state.items.map(item => item.id === itemId
    ? { ...item, status, ...(referenceName === undefined ? {} : { referenceName }) }
    : item);
  return {
    ...state,
    items,
    selectedItemId: nextPendingTrackingItemId(items, itemId) || itemId,
    session: state.session ? {
      ...state.session,
      unresolvedCount: items.filter(item => unresolvedTrackingStatus(item.status)).length,
    } : state.session,
  };
};

export const canCommitTrackingSession = (items: readonly ProgressTrackingItem[]) =>
  !items.some(item => unresolvedTrackingStatus(item.status));

const joinTrackingPath = (folderPath: string, name?: string) => name
  ? `${folderPath.replace(/[\\/]+$/, '')}${folderPath.includes('\\') ? '\\' : '/'}${name}`
  : '';

export const resolveTrackingComparisonPaths = (
  item: ProgressTrackingItem | undefined,
  parentFolderPath: string,
  progressFolderPath: string,
) => ({
  referencePath: joinTrackingPath(parentFolderPath, item?.referenceName),
  sourcePath: joinTrackingPath(progressFolderPath, item?.sourceName),
  referenceMissing: Boolean(item && (item.status === 'missing_reference' || !item.referenceName)),
});

export const setTrackingPanelMinimized = (state: TrackingConfirmationViewState, minimized: boolean) => ({ ...state, minimized });

export const createPreviewRequestGate = () => {
  let sequence = 0;
  return {
    begin: () => ++sequence,
    isCurrent: (request: number) => request === sequence,
    invalidate: () => { sequence += 1; },
  };
};
