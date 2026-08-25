export type TeamSettings = { useGpu: boolean; oversizeCropMode: 'face-centered' | 'expand' };
export type TeamSettingsPatch = Partial<TeamSettings>;
export type TeamSettingsState = { settings?: TeamSettings; loaded: boolean; loading: boolean; error: string };
export const createLatestRequestGuard = () => { let generation = 0; return { begin: () => ++generation, isCurrent: (value: number) => value === generation, invalidate: () => { generation += 1; } }; };

const normalizedSettings = (value: unknown, fallback: TeamSettings = { useGpu: true, oversizeCropMode: 'face-centered' }): TeamSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('团片设置响应无效');
  const candidate = value as Partial<TeamSettings>;
  const hasUseGpu = Object.prototype.hasOwnProperty.call(candidate, 'useGpu');
  const hasCropMode = Object.prototype.hasOwnProperty.call(candidate, 'oversizeCropMode');
  if ((hasUseGpu && typeof candidate.useGpu !== 'boolean') || (hasCropMode && !['face-centered', 'expand'].includes(String(candidate.oversizeCropMode)))) throw new Error('团片设置响应包含无效值');
  return { useGpu: hasUseGpu ? candidate.useGpu as boolean : fallback.useGpu, oversizeCropMode: hasCropMode ? candidate.oversizeCropMode as TeamSettings['oversizeCropMode'] : fallback.oversizeCropMode };
};

export const createTeamSettingsController = ({ read, merge, notice = () => undefined }: {
  read: () => Promise<{ settings?: unknown }>;
  merge: (patch: TeamSettingsPatch) => Promise<{ settings?: unknown }>;
  notice?: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
}) => {
  let authoritative: TeamSettings | undefined;
  let pending: Array<{ id: number; patch: TeamSettingsPatch }> = [];
  let state: TeamSettingsState = { loaded: false, loading: true, error: '' };
  let loadGeneration = 0;
  let nextPatchId = 1;
  let tail = Promise.resolve();
  const listeners = new Set<(value: TeamSettingsState) => void>();
  const visibleSettings = () => authoritative ? pending.reduce((value, item) => ({ ...value, ...item.patch }), { ...authoritative }) : undefined;
  const publish = (update: Partial<TeamSettingsState> = {}) => {
    state = { ...state, ...update, settings: visibleSettings() };
    for (const listener of listeners) listener(state);
  };
  const refresh = async () => {
    const generation = ++loadGeneration;
    publish({ loading: true, error: '' });
    try {
      await tail.catch(() => undefined);
      if (generation !== loadGeneration) return false;
      const result = await read();
      if (generation !== loadGeneration) return false;
      authoritative = normalizedSettings(result.settings);
      publish({ loaded: true, loading: false, error: '' });
      return true;
    } catch (error) {
      if (generation !== loadGeneration) return false;
      const message = error instanceof Error ? error.message : String(error);
      publish({ loaded: Boolean(authoritative), loading: false, error: message });
      return false;
    }
  };
  const patch = (value: TeamSettingsPatch) => {
    if (!state.loaded || !authoritative) return Promise.reject(new Error('团片设置尚未读取完成'));
    const keys = Object.keys(value);
    if (keys.length !== 1 || !['useGpu', 'oversizeCropMode'].includes(keys[0])) return Promise.reject(new Error('团片设置补丁无效'));
    if ((keys[0] === 'useGpu' && typeof value.useGpu !== 'boolean') || (keys[0] === 'oversizeCropMode' && !['face-centered', 'expand'].includes(String(value.oversizeCropMode)))) return Promise.reject(new Error('团片设置补丁无效'));
    loadGeneration += 1;
    const item = { id: nextPatchId++, patch: { ...value } };
    pending.push(item);
    publish({ loading: false, error: '' });
    const operation = tail.catch(() => undefined).then(async () => {
      try {
        const result = await merge(item.patch);
        authoritative = normalizedSettings(result.settings, { ...(authoritative || { useGpu: true, oversizeCropMode: 'face-centered' }), ...item.patch } as TeamSettings);
        pending = pending.filter(candidate => candidate.id !== item.id);
        publish({ loaded: true, error: '' });
      } catch (error) {
        pending = pending.filter(candidate => candidate.id !== item.id);
        const message = error instanceof Error ? error.message : String(error);
        try { authoritative = normalizedSettings((await read()).settings); }
        catch { /* retain the last authoritative snapshot */ }
        publish({ loaded: Boolean(authoritative), error: message });
        notice(`保存团片协作设置失败：${message}`, 'error');
        throw error;
      }
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  return {
    getState: () => state,
    subscribe(listener: (value: TeamSettingsState) => void) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    refresh,
    patch,
    invalidate() { loadGeneration += 1; },
  };
};

export const runNotifiedAction = async (label: string, action: () => Promise<boolean | void>, notice: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void) => {
  const completed = await action();
  if (completed !== false) notice(`${label}完成`, 'success');
  return completed !== false;
};
