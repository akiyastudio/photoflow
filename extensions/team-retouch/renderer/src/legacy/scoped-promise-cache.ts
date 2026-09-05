export const createScopedPromiseCache = <T>(ttlMs = 2_000, maxEntries = 8) => {
  let generation = 0; let scope = ''; const entries = new Map<string, { expiresAt: number; promise: Promise<T>; generation: number }>();
  return {
    setScope(next: string) { if (next === scope) return; scope = next; generation += 1; entries.clear(); },
    clear() { generation += 1; entries.clear(); },
    get(key: string, loader: () => Promise<T>) {
      const now = Date.now(); for (const [entryKey, entry] of entries) if (entry.expiresAt <= now) entries.delete(entryKey);
      const cacheKey = `${scope}\0${key}`; const cached = entries.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.promise;
      const entryGeneration = generation;
      const promise = loader().catch(error => { const current = entries.get(cacheKey); if (current?.generation === entryGeneration && current.promise === promise) entries.delete(cacheKey); throw error; });
      entries.set(cacheKey, { expiresAt: Date.now() + ttlMs, promise, generation: entryGeneration });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return promise;
    },
    getScope: () => scope,
  };
};
