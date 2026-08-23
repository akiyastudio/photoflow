export type ImportCompletion = {
  projectNames: string[];
  workProjectNames: string[];
  brollProjectNames: string[];
  importedPathsByProject: Record<string, string[]>;
  importedCount: number;
  skipped: boolean;
};

export type ImportSuccessEvent = {
  projectNames?: unknown;
  importedPathsByProject?: unknown;
  importedCount?: unknown;
  skipped?: boolean;
  sourceType: 'work' | 'broll';
};

export const createImportCompletion = (): ImportCompletion => ({
  projectNames: [],
  workProjectNames: [],
  brollProjectNames: [],
  importedPathsByProject: {},
  importedCount: 0,
  skipped: false,
});

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
    return {
      ...current,
      skipped: current.importedCount === 0 && (current.skipped || event.skipped === true),
    };
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
  return {
    projectNames: Array.from(new Set([...current.projectNames, ...names])),
    workProjectNames,
    brollProjectNames,
    importedPathsByProject,
    importedCount: current.importedCount + count,
    skipped: false,
  };
};
