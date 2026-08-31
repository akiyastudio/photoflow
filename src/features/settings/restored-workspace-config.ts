import type { AppConfig } from '../../types';

type SettingsSaveCoordinatorOptions<T> = {
  initial: T;
  normalize: (value: T) => T;
  applyDraft: (value: T) => void;
  save: (value: T) => boolean | Promise<boolean>;
  onFailure: (value: T, error: Error) => void;
};

export const patchSettingsDraft = <T extends object>(current: T, patch: (current: T) => Partial<T>): T => ({ ...current, ...patch(current) });

export const createSettingsSaveCoordinator = <T,>({ initial, normalize, applyDraft, save, onFailure }: SettingsSaveCoordinatorOptions<T>) => {
  let tail = Promise.resolve();
  let persisted = initial;
  let latestDraftVersion = 0;
  const apply = (value: T, version = ++latestDraftVersion) => {
    const normalized = normalize(value);
    if (version === latestDraftVersion) applyDraft(normalized);
    return { normalized, version };
  };
  const saveApplied = async ({ normalized, version }: ReturnType<typeof apply>) => {
    try {
      if (!await save(normalized)) throw new Error('设置没有保存成功');
      persisted = normalized;
      return true;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      onFailure(normalized, error);
      if (version === latestDraftVersion) {
        applyDraft(persisted);
        try { await save(persisted); } catch { /* Re-applying still restores an optimistic parent draft. */ }
      }
      return false;
    }
  };
  const queue = <R,>(operation: () => Promise<R>) => { const result = tail.then(operation, operation); tail = result.then(() => undefined, () => undefined); return result; };
  const enqueue = (value: T) => { const applied = apply(value); return queue(() => saveApplied(applied)); };
  const transaction = <R,>(worker: (saveInTransaction: (value: T) => Promise<boolean>) => Promise<R>) => {
    const transactionVersion = ++latestDraftVersion;
    return queue(() => worker(value => saveApplied(apply(value, transactionVersion))));
  };
  return {
    enqueue,
    transaction,
    drain: () => tail,
    syncPersisted: (value: T) => { persisted = normalize(value); },
    mergePersisted: (merge: (value: T) => T) => { persisted = normalize(merge(persisted)); },
  };
};

const canonicalWorkspacePath = (value: string) => {
  const trimmed = String(value || '').trim();
  return trimmed.length > 3 ? trimmed.replace(/[\\/]+$/, '') : trimmed;
};

export const restoredWorkspaceConfig = (savedConfig: AppConfig, workspacePath: string, currentConfig?: AppConfig): AppConfig => ({
  ...savedConfig,
  telemetry: currentConfig?.telemetry || savedConfig.telemetry,
  backup: currentConfig?.backup || savedConfig.backup,
  workspacePath: canonicalWorkspacePath(workspacePath),
  workspacePaths: [canonicalWorkspacePath(workspacePath)].filter(Boolean),
});

