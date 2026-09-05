export const workspaceSeedScopeKey = (workspacePath: string, project: { id?: string }, workspace?: { authoritativeGeneration?: unknown }) =>
  [workspacePath, project.id || '', String(workspace?.authoritativeGeneration || 'original')].join('\0');

export const isUsableWorkspaceSeed = (value: unknown): value is { success?: boolean; photos: unknown[]; identities: unknown[]; assignments: unknown[] } => {
  const seed = value as Record<string, unknown> | null;
  return Boolean(seed && seed.success !== false && Array.isArray(seed.photos) && Array.isArray(seed.identities) && Array.isArray(seed.assignments));
};

export const createWorkspaceSeedGate = (initialScopeKey = '', hasInitialSeed = false) => {
  let seededScopeKey = hasInitialSeed ? initialScopeKey : '';
  return {
    isSeeded: (scopeKey: string) => Boolean(scopeKey && seededScopeKey === scopeKey),
    consume: (scopeKey: string, hasSeed: boolean) => {
      if (!hasSeed || !scopeKey || seededScopeKey === scopeKey) return false;
      seededScopeKey = scopeKey; return true;
    },
  };
};
