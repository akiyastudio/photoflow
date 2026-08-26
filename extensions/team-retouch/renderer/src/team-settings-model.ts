export type TeamSettings = { useGpu: boolean; oversizeCropMode: 'face-centered' | 'expand' };
export type TeamSettingsPatch = Partial<TeamSettings>;
export type TeamSettingsState = { settings?: TeamSettings; loaded: boolean; loading: boolean; error: string };
export type AdvancedEnvironmentState = 'loading' | 'ready' | 'not-installed' | 'repair-needed' | 'unavailable' | 'error';
export type AdvancedEnvironmentPresentation = { state: AdvancedEnvironmentState; label: string; description: string; tone: 'primary' | 'success' | 'warning' | 'danger' };
export const advancedEnvironmentPresentation = (value: unknown, loading: boolean, failed: boolean): AdvancedEnvironmentPresentation => {
  if (loading) return { state: 'loading', label: '正在检查', description: '正在确认增强人物检测的安装与运行状态。', tone: 'primary' };
  if (failed) return { state: 'error', label: '检查失败', description: '暂时无法读取增强版状态；基础人物检测仍可正常使用。', tone: 'danger' };
  const status = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (status.advancedAvailable === true || status.state === 'ready') return { state: 'ready', label: '可用', description: '增强人物检测已就绪，将自动用于多人、遮挡和精细分割场景。', tone: 'success' };
  if (status.errorCategory === 'wsl-access-denied') return { state: 'unavailable', label: '权限受限', description: status.runtimeSource === 'development' ? '当前开发运行进程无权访问 WSL；请从具有 WSL 权限的普通终端启动应用。' : '照片流当前无权访问 WSL；请使用安装高级环境时的 Windows 用户运行。', tone: 'warning' };
  if (status.state === 'not-installed' || status.installed === false) return { state: 'not-installed', label: '未安装', description: '当前使用基础人物检测；可通过离线安装包安装增强版。', tone: 'primary' };
  if (status.state === 'repair-needed') return { state: 'repair-needed', label: '需修复', description: '增强版运行环境不完整；当前已安全回退到基础人物检测。', tone: 'warning' };
  return { state: 'unavailable', label: '不可用', description: '此设备当前无法启用增强版；基础人物检测仍可正常使用。', tone: 'warning' };
};
export const createLatestRequestGuard = () => { let generation = 0; return { begin: () => ++generation, isCurrent: (value: number) => value === generation, invalidate: () => { generation += 1; } }; };

const normalizedSettings = (value: unknown, fallback: TeamSettings = { useGpu: true, oversizeCropMode: 'face-centered' }): TeamSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('团片设置响应无效');
  const candidate = value as Partial<TeamSettings>;
  const hasUseGpu = Object.prototype.hasOwnProperty.call(candidate, 'useGpu');
  const hasCropMode = Object.prototype.hasOwnProperty.call(candidate, 'oversizeCropMode');
  if ((hasUseGpu && typeof candidate.useGpu !== 'boolean') || (hasCropMode && !['face-centered', 'expand'].includes(String(candidate.oversizeCropMode)))) throw new Error('团片设置响应包含无效值');
  return { useGpu: hasUseGpu ? candidate.useGpu as boolean : fallback.useGpu, oversizeCropMode: hasCropMode ? candidate.oversizeCropMode as TeamSettings['oversizeCropMode'] : fallback.oversizeCropMode };
};

export const createTeamSettingsController = ({ read, merge, notice = (_message, _tone) => undefined }: {
  read: () => Promise<{ settings?: unknown }>;
  merge: (patch: TeamSettingsPatch) => Promise<{ settings?: unknown }>;
  notice?: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void;
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

export const runNotifiedAction = async (label: string, action: () => Promise<boolean | void>, notice: (message: string, tone: 'info' | 'success' | 'warning' | 'error') => void) => {
  const completed = await action();
  if (completed !== false) notice(`${label}完成`, 'success');
  return completed !== false;
};
