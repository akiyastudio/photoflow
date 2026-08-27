export type FileEntryOpenMode = 'single' | 'double';

export type FileEntryClickIntent = 'ignore-repeat' | 'range-select' | 'toggle-select' | 'add-and-preview' | 'select' | 'open';

export interface FileEntryClickIntentInput {
  openMode: FileEntryOpenMode;
  selectionCount: number;
  range: boolean;
  additive: boolean;
  clickCount?: number;
}

export interface FileEntryPointerModifiers {
  path: string;
  additive: boolean;
  range: boolean;
  pointerType: 'mouse' | 'pen' | 'touch';
}

/** Pointer capture records click/drag context only; selection belongs to click or dragstart. */
export const fileEntryPointerModifiers = ({
  path,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false,
  pointerType,
}: {
  path: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  pointerType: FileEntryPointerModifiers['pointerType'];
}): FileEntryPointerModifiers => ({
  path,
  additive: ctrlKey || metaKey,
  range: shiftKey,
  pointerType,
});

/** A successful dragstart selects only an unselected entry; selected drags retain their group. */
export const fileEntrySelectionAfterDragStart = (
  selectedPaths: readonly string[],
  entryPath: string,
  dragPaths: readonly string[],
) => dragPaths.length > 0 && !selectedPaths.includes(entryPath) ? [entryPath] : [...selectedPaths];

export const fileEntryClickIntent = ({
  openMode,
  selectionCount,
  range,
  additive,
  clickCount = 1,
}: FileEntryClickIntentInput): FileEntryClickIntent => {
  if (clickCount > 1) return 'ignore-repeat';
  if (range) return 'range-select';
  if (additive) return 'toggle-select';
  if (selectionCount > 0) return 'add-and-preview';
  return openMode === 'single' ? 'open' : 'select';
};

const normalizeDirectoryPath = (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

const normalizeComparablePath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/g, '');

const pathSuffixWithin = (candidate: string, directory: string) => {
  const normalizedCandidate = normalizeComparablePath(candidate);
  const normalizedDirectory = normalizeComparablePath(directory);
  const candidateIdentity = normalizedCandidate.toLocaleLowerCase('zh-CN');
  const directoryIdentity = normalizedDirectory.toLocaleLowerCase('zh-CN');
  if (candidateIdentity === directoryIdentity) return '';
  if (!directoryIdentity || !candidateIdentity.startsWith(`${directoryIdentity}/`)) return null;
  return normalizedCandidate.slice(normalizedDirectory.length + 1);
};

export interface ProgressFolderEntryLocation {
  folderPath: string;
  relativePath: string;
}

/** Keep an open media entry attached to the same progress node after its folder moves. */
export const remapEntryAfterProgressFolderMove = <T extends { path: string; relativePath: string; previewUrl?: string }>(
  entry: T,
  previous: ProgressFolderEntryLocation,
  next: ProgressFolderEntryLocation,
): T => {
  const relativeSuffix = pathSuffixWithin(entry.relativePath, previous.relativePath);
  const physicalSuffix = pathSuffixWithin(entry.path, previous.folderPath);
  if (relativeSuffix === null || physicalSuffix === null) return entry;
  const nextRelativeRoot = normalizeDirectoryPath(next.relativePath);
  const nextPhysicalRoot = normalizeComparablePath(next.folderPath);
  const relativePath = [nextRelativeRoot, relativeSuffix].filter(Boolean).join('/');
  const path = [nextPhysicalRoot, physicalSuffix].filter(Boolean).join('/');
  if (relativePath === entry.relativePath && path === entry.path) return entry;
  const { previewUrl: _stalePreviewUrl, ...retained } = entry;
  return { ...retained, path, relativePath } as T;
};

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
