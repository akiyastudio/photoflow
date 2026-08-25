export type LegacyMigrationProgress = {
  phase?: string;
  processedCount?: number;
  pendingCount?: number;
  maintenancePendingCount?: number;
};

const count = (value: unknown) => Math.max(0, Number(value) || 0);

export const legacyMigrationRemainingCount = (migration?: LegacyMigrationProgress) => (
  count(migration?.pendingCount) + count(migration?.maintenancePendingCount)
);

export const legacyMigrationMadeProgress = (previous?: LegacyMigrationProgress, current?: LegacyMigrationProgress) => (
  count(current?.processedCount) > count(previous?.processedCount)
  || count(current?.pendingCount) < count(previous?.pendingCount)
  || count(current?.maintenancePendingCount) < count(previous?.maintenancePendingCount)
);

export const nextLegacyMigrationNoProgressCount = (previous: LegacyMigrationProgress | undefined, current: LegacyMigrationProgress | undefined, currentCount: number) => (
  legacyMigrationMadeProgress(previous, current) ? 0 : Math.max(0, Number(currentCount) || 0) + 1
);

export const legacyMigrationActivityLabel = (migration?: LegacyMigrationProgress) => (
  migration?.phase === 'workflow-reconcile' ? '团片工作流程目录恢复' : '团片旧项目文件整理'
);

export const legacyMigrationRunningMessage = (migration?: LegacyMigrationProgress) => (
  `${legacyMigrationActivityLabel(migration)}中，剩余约 ${legacyMigrationRemainingCount(migration)} 项；历史可正常只读。`
);

export const legacyMigrationPausedMessage = (migration?: LegacyMigrationProgress) => (
  `${legacyMigrationActivityLabel(migration)}暂无进展，已暂停自动重试（剩余约 ${legacyMigrationRemainingCount(migration)} 项）；历史可正常只读。`
);

export const legacyMigrationErrorMessage = (migration: LegacyMigrationProgress | undefined, error: string) => (
  `${error}（剩余约 ${legacyMigrationRemainingCount(migration)} 项，历史可正常只读）`
);
