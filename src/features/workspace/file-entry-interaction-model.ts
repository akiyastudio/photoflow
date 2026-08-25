export type FileEntryOpenMode = 'single' | 'double';

export type FileEntryClickIntent = 'ignore-repeat' | 'range-select' | 'toggle-select' | 'open' | 'focus';

export interface FileEntryClickIntentInput {
  openMode: FileEntryOpenMode;
  selectionCount: number;
  range: boolean;
  additive: boolean;
  clickCount?: number;
}

export const fileEntryClickIntent = ({
  openMode,
  selectionCount,
  range,
  additive,
  clickCount = 1,
}: FileEntryClickIntentInput): FileEntryClickIntent => {
  if (clickCount > 1) return 'ignore-repeat';
  if (range) return 'range-select';
  if (additive || selectionCount > 0) return 'toggle-select';
  return openMode === 'single' ? 'open' : 'focus';
};

const normalizeDirectoryPath = (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

export const mutatedEntryCanBeRevealed = ({
  requestedProjectPath,
  currentProjectPath,
  mutationDirectoryPath,
  currentDirectoryPath,
  browseMode,
}: {
  requestedProjectPath: string;
  currentProjectPath: string;
  mutationDirectoryPath: string;
  currentDirectoryPath: string;
  browseMode: string;
}) => requestedProjectPath === currentProjectPath
  && normalizeDirectoryPath(mutationDirectoryPath) === normalizeDirectoryPath(currentDirectoryPath)
  && (browseMode === 'grid' || browseMode === 'list');

export const mutatedEntryFiltersNeedReset = ({
  searchQuery,
  fileFilter,
  ratingFilter,
  filterScope,
}: {
  searchQuery: string;
  fileFilter: string;
  ratingFilter: string;
  filterScope: string;
}) => Boolean(searchQuery.trim()) || fileFilter !== 'all' || ratingFilter !== 'all' || filterScope !== 'current-folder';

export const mergeRefreshedEntryMetadata = <T extends { relativePath: string; size: number; createdAt: number; updatedAt: number }>(
  refreshedEntries: readonly T[],
  retainedEntries: readonly T[],
) => {
  const retainedByPath = new Map(retainedEntries.map(entry => [entry.relativePath, entry]));
  return refreshedEntries.map(entry => {
    const retained = retainedByPath.get(entry.relativePath);
    return retained?.updatedAt ? { ...entry, size: retained.size, createdAt: retained.createdAt, updatedAt: retained.updatedAt } : entry;
  });
};

export const renamedEntryDestinationPath = (
  sourceRelativePath: string,
  nextName: string,
  movedItems: ReadonlyArray<{ sourceRelativePath: string; destinationRelativePath: string }> = [],
) => {
  const source = normalizeDirectoryPath(sourceRelativePath);
  const moved = movedItems.find(item => normalizeDirectoryPath(item.sourceRelativePath).toLocaleLowerCase('zh-CN') === source.toLocaleLowerCase('zh-CN'));
  if (moved?.destinationRelativePath) return normalizeDirectoryPath(moved.destinationRelativePath);
  const parent = source.split('/').slice(0, -1).join('/');
  const name = normalizeDirectoryPath(nextName);
  return name ? [parent, name].filter(Boolean).join('/') : '';
};

export const directoryEntryToRevealOnReturn = (currentPath: string, targetPath: string) => {
  const current = normalizeDirectoryPath(currentPath);
  const target = normalizeDirectoryPath(targetPath);
  if (!current || current === target || target && !current.startsWith(`${target}/`)) return '';
  const nextSegment = current.slice(target ? target.length + 1 : 0).split('/')[0];
  return nextSegment ? [target, nextSegment].filter(Boolean).join('/') : '';
};
