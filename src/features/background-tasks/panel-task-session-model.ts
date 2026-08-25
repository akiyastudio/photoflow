export type PanelTaskRestoreDetail = {
  ownerPageId?: string;
  panelKind?: string;
};

export const panelTaskSessionKey = (ownerPageId: string, panelKind: string) => `${ownerPageId}:${panelKind}`;

export const panelTaskRestoreDetail = (ownerPageId: string, panelKind: string): PanelTaskRestoreDetail => ({
  ownerPageId,
  panelKind,
});

export const isPanelTaskRestoreForPage = (ownerPageId: string, detail?: PanelTaskRestoreDetail) => detail?.ownerPageId === ownerPageId;

export const nextPanelTaskStartedAt = (
  previous: { state?: string; startedAt?: number } | undefined,
  nextState: string,
  now = Date.now(),
) => {
  const retained = Number(previous?.startedAt);
  const retainedStartedAt = Number.isFinite(retained) && retained > 0 ? retained : 0;
  if (nextState !== 'running') return retainedStartedAt;
  return previous?.state === 'running' && retainedStartedAt ? retainedStartedAt : now;
};

export const removePanelTasksByOwnerPageId = <T extends { ownerPageId: string }>(tasks: Record<string, T>, ownerPageId: string) => {
  let changed = false;
  const remaining = Object.fromEntries(Object.entries(tasks).filter(([, task]) => {
    const keep = task.ownerPageId !== ownerPageId;
    if (!keep) changed = true;
    return keep;
  })) as Record<string, T>;
  return changed ? remaining : tasks;
};
