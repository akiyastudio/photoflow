export type ImportCompletion = {
  projectNames: string[];
  workProjectNames: string[];
  brollProjectNames: string[];
  importedCount: number;
  skipped: boolean;
};

export type ImportSuccessEvent = {
  projectNames?: unknown;
  importedCount?: unknown;
  skipped?: boolean;
  sourceType: 'work' | 'broll';
};

export const createImportCompletion = (): ImportCompletion => ({
  projectNames: [],
  workProjectNames: [],
  brollProjectNames: [],
  importedCount: 0,
  skipped: false,
});

const uniqueNames = (values: unknown) => Array.isArray(values)
  ? Array.from(new Set(values.map(String).map(value => value.trim()).filter(Boolean)))
  : [];

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
    importedCount: current.importedCount + count,
    skipped: false,
  };
};
