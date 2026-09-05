export type RevisionedSnapshot = { revision?: string | number; [key: string]: unknown };
export type WorkspaceState<T extends RevisionedSnapshot> = { scope: string; revision: number; loading: boolean; pendingMutations: number; snapshot?: T; pendingSnapshot?: T };

const revisionOf = (snapshot: RevisionedSnapshot | undefined) => Number(snapshot?.revision) || 0;
export const createWorkspaceState = <T extends RevisionedSnapshot>(scope = ''): WorkspaceState<T> => ({ scope, revision: -1, loading: Boolean(scope), pendingMutations: 0 });
export const switchWorkspaceScope = <T extends RevisionedSnapshot>(state: WorkspaceState<T>, scope: string): WorkspaceState<T> => scope === state.scope ? state : createWorkspaceState<T>(scope);
export const beginWorkspaceLoad = <T extends RevisionedSnapshot>(state: WorkspaceState<T>) => ({ ...state, loading: true });
export const acceptWorkspaceSnapshot = <T extends RevisionedSnapshot>(state: WorkspaceState<T>, scope: string, snapshot: T): WorkspaceState<T> => {
  if (!scope || scope !== state.scope || revisionOf(snapshot) < state.revision) return state;
  if (state.pendingMutations) {
    const pendingSnapshot = revisionOf(snapshot) >= revisionOf(state.pendingSnapshot) ? snapshot : state.pendingSnapshot;
    return { ...state, loading: false, pendingSnapshot };
  }
  return { ...state, revision: revisionOf(snapshot), loading: false, snapshot, pendingSnapshot: undefined };
};
export const beginWorkspaceMutation = <T extends RevisionedSnapshot>(state: WorkspaceState<T>) => ({ ...state, pendingMutations: state.pendingMutations + 1 });
export const settleWorkspaceMutation = <T extends RevisionedSnapshot>(state: WorkspaceState<T>): WorkspaceState<T> => {
  const pendingMutations = Math.max(0, state.pendingMutations - 1);
  if (pendingMutations || !state.pendingSnapshot) return { ...state, pendingMutations };
  return { ...state, pendingMutations: 0, revision: revisionOf(state.pendingSnapshot), snapshot: state.pendingSnapshot, pendingSnapshot: undefined };
};
