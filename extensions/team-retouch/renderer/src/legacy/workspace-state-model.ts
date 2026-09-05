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
export const settleWorkspaceMutation = <T extends RevisionedSnapshot>(state: WorkspaceState<T>, succeeded = true): WorkspaceState<T> => {
  const pendingMutations = Math.max(0, state.pendingMutations - 1);
  if (pendingMutations || !state.pendingSnapshot) return { ...state, pendingMutations };
  if (succeeded ? revisionOf(state.pendingSnapshot) <= state.revision : revisionOf(state.pendingSnapshot) < state.revision) return { ...state, pendingMutations: 0, pendingSnapshot: undefined };
  return { ...state, pendingMutations: 0, revision: revisionOf(state.pendingSnapshot), snapshot: state.pendingSnapshot, pendingSnapshot: undefined };
};

export const commitWorkspaceSnapshot = <T extends RevisionedSnapshot>(state: WorkspaceState<T>, scope: string, snapshot: T): WorkspaceState<T> => {
  if (scope !== state.scope || revisionOf(snapshot) <= state.revision) return state;
  const revision = revisionOf(snapshot);
  return { ...state, revision, snapshot, pendingSnapshot: revisionOf(state.pendingSnapshot) > revision ? state.pendingSnapshot : undefined };
};

/** Imperative adapter used by React managers to guard every async completion. */
export const createWorkspaceScopeController = <T extends RevisionedSnapshot>(initialScope: string, initialSnapshot?: T) => {
  let state = createWorkspaceState<T>(initialScope);
  if (initialSnapshot) state = acceptWorkspaceSnapshot(state, initialScope, initialSnapshot);
  return {
    setScope(scope: string) { const changed = scope !== state.scope; state = switchWorkspaceScope(state, scope); return { changed, state }; },
    beginLoad(scope: string) { if (scope !== state.scope) return false; state = beginWorkspaceLoad(state); return true; },
    accept(scope: string, snapshot: T) { const previousSnapshot = state.snapshot; const next = acceptWorkspaceSnapshot(state, scope, snapshot); state = next; return next.snapshot === snapshot && previousSnapshot !== snapshot; },
    beginMutation(scope: string) { if (scope !== state.scope) return false; state = beginWorkspaceMutation(state); return true; },
    commit(scope: string, snapshot: T) { const next = commitWorkspaceSnapshot(state, scope, snapshot); const accepted = next !== state; state = next; return accepted; },
    settleMutation(scope: string, succeeded = true) { if (scope !== state.scope) return state; state = settleWorkspaceMutation(state, succeeded); return state; },
    canMutate: (scope: string) => Boolean(scope) && scope === state.scope && Boolean(state.snapshot),
    isCurrent: (scope: string) => Boolean(scope) && scope === state.scope,
    getState: () => state,
  };
};
