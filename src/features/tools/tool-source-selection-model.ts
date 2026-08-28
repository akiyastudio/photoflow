import type { ProjectToolSource } from '../../types';

const normalizedPath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/g, '').toLocaleLowerCase();

const pathIsInside = (candidate: string, folder: string) => {
  const normalizedCandidate = normalizedPath(candidate);
  const normalizedFolder = normalizedPath(folder);
  return normalizedCandidate === normalizedFolder || normalizedCandidate.startsWith(`${normalizedFolder}/`);
};

export const resolveInspectedToolSources = (
  sources: readonly ProjectToolSource[] | undefined,
  folderPaths: readonly string[] = [],
  discoveredFilePaths: readonly string[] = [],
): ProjectToolSource[] => {
  if (sources?.length) return sources.map(source => ({ ...source }));
  const folders = [...new Set(folderPaths.filter(Boolean))];
  const directFiles = discoveredFilePaths.filter(candidate => !folders.some(folder => pathIsInside(candidate, folder)));
  return [
    ...folders.map(path => ({ path, kind: 'folder' as const })),
    ...directFiles.map(path => ({ path, kind: 'file' as const })),
  ];
};
