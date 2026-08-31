export type ImportOutcome = 'success' | 'partial' | 'skipped' | 'relation-pending';
export type ImportSessionTerminal = 'success' | 'discard-success' | 'session-invalid' | 'error' | 'destination-missing' | 'cancel-failed';

export const shouldForgetImportSession = (terminal: ImportSessionTerminal) => terminal === 'success' || terminal === 'discard-success' || terminal === 'session-invalid';

export type ImportCompletion = {
  projectNames: string[];
  workProjectNames: string[];
  brollProjectNames: string[];
  importedPathsByProject: Record<string, string[]>;
  importedCount: number;
  skipped: boolean;
  failedCount: number;
  relationPending: boolean;
  outcome: ImportOutcome;
};

export type ImportSuccessEvent = {
  projectNames?: unknown;
  importedPathsByProject?: unknown;
  importedCount?: unknown;
  skipped?: boolean;
  failedCount?: unknown;
  relationPending?: boolean;
  sourceType: 'work' | 'broll';
};

export const createImportCompletion = (): ImportCompletion => ({
  projectNames: [],
  workProjectNames: [],
  brollProjectNames: [],
  importedPathsByProject: {},
  importedCount: 0,
  skipped: false,
  failedCount: 0,
  relationPending: false,
  outcome: 'success',
});

export const resolveImportOutcome = ({ importedCount, skipped, failedCount, relationPending }: Pick<ImportCompletion, 'importedCount' | 'skipped' | 'failedCount' | 'relationPending'>): ImportOutcome => relationPending
  ? 'relation-pending'
  : importedCount === 0 && skipped
    ? 'skipped'
    : failedCount > 0
      ? 'partial'
      : 'success';

export const describeImportCompletion = (completion: ImportCompletion) => completion.outcome === 'relation-pending'
  ? '文件已经写入目标位置，媒体关系将在重试成功后补齐。'
  : completion.outcome === 'partial'
    ? `本批次成功导入 ${completion.importedCount} 个文件，${completion.failedCount} 项未完成。`
    : completion.outcome === 'skipped'
      ? '所选来源没有符合当前条件的媒体文件。'
      : '导入完成。';

const uniqueNames = (values: unknown) => Array.isArray(values)
  ? Array.from(new Set(values.map(String).map(value => value.trim()).filter(Boolean)))
  : [];

const normalizedImportedPaths = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([projectName, paths]) => {
    const normalizedName = projectName.trim();
    const normalizedPaths = uniqueNames(paths);
    return normalizedName && normalizedPaths.length ? [[normalizedName, normalizedPaths]] : [];
  }));
};

export const appendImportSuccess = (current: ImportCompletion, event: ImportSuccessEvent): ImportCompletion => {
  const count = Number(event.importedCount);
  const successful = event.skipped !== true && Number.isFinite(count) && count > 0;
  if (!successful) {
    const next = {
      ...current,
      skipped: current.importedCount === 0 && (current.skipped || event.skipped === true),
      failedCount: current.failedCount + (Number.isFinite(Number(event.failedCount)) ? Math.max(0, Number(event.failedCount)) : 0),
      relationPending: current.relationPending || event.relationPending === true,
    };
    return { ...next, outcome: resolveImportOutcome(next) };
  }

  const names = uniqueNames(event.projectNames);
  const importedPathsByProject = { ...current.importedPathsByProject };
  for (const [projectName, paths] of Object.entries(normalizedImportedPaths(event.importedPathsByProject))) {
    const existingName = Object.keys(importedPathsByProject).find(name => name.toLocaleLowerCase() === projectName.toLocaleLowerCase()) || projectName;
    importedPathsByProject[existingName] = Array.from(new Set([...(importedPathsByProject[existingName] || []), ...paths]));
  }
  const workProjectNames = event.sourceType === 'work'
    ? Array.from(new Set([...current.workProjectNames, ...names]))
    : [...current.workProjectNames];
  const brollProjectNames = event.sourceType === 'broll'
    ? Array.from(new Set([...current.brollProjectNames, ...names]))
    : [...current.brollProjectNames];
  const next = {
    projectNames: Array.from(new Set([...current.projectNames, ...names])),
    workProjectNames,
    brollProjectNames,
    importedPathsByProject,
    importedCount: current.importedCount + count,
    skipped: false,
    failedCount: current.failedCount + (Number.isFinite(Number(event.failedCount)) ? Math.max(0, Number(event.failedCount)) : 0),
    relationPending: current.relationPending || event.relationPending === true,
  };
  return { ...next, outcome: resolveImportOutcome(next) };
};
