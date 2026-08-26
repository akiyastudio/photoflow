import type { ProgressFolder, ProjectFileEntry } from '../../types';
import type { PendingProjectFileEntry } from '../workspace/file-operation-state-model';

export type ResolvedVersionTreeEntryItem = { folder: ProgressFolder; entry: ProjectFileEntry };

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const parentPath = (value: string) => normalizePath(value).split('/').slice(0, -1).join('/');

export const resolveVersionTreeEntryMapping = ({
  folders,
  entries,
  structureEntries,
  scopePath,
  projectRelativePath,
}: {
  folders: ProgressFolder[];
  entries: ProjectFileEntry[];
  structureEntries: ProjectFileEntry[];
  scopePath: string;
  projectRelativePath: (absolutePath: string) => string;
}) => {
  const normalizedScopePath = normalizePath(scopePath);
  const liveEntries = entries as PendingProjectFileEntry[];
  const liveEntryByPath = new Map(liveEntries.map(entry => [normalizePath(entry.relativePath), entry]));
  const liveEntryBySourceAlias = new Map(liveEntries
    .filter(entry => Boolean(entry.pendingSourceRelativePath))
    .map(entry => [normalizePath(entry.pendingSourceRelativePath!), entry]));
  const liveExternalEntryByTarget = new Map(liveEntries
    .filter(entry => entry.externalLink && entry.externalLinkTarget)
    .map(entry => [normalizePath(entry.externalLinkTarget!), entry]));
  const structureEntryByPath = new Map(structureEntries.map(entry => [normalizePath(entry.relativePath), entry]));
  const structureExternalEntryByTarget = new Map(structureEntries
    .filter(entry => entry.externalLink && entry.externalLinkTarget)
    .map(entry => [normalizePath(entry.externalLinkTarget!), entry]));
  const versionItems: ResolvedVersionTreeEntryItem[] = folders.flatMap(folder => {
    const stableRelativePath = normalizePath(folder.externalLinkRelativePath || projectRelativePath(folder.folderPath));
    const foundEntry = liveEntryBySourceAlias.get(stableRelativePath)
      || liveExternalEntryByTarget.get(normalizePath(folder.folderPath))
      || liveEntryByPath.get(stableRelativePath)
      || structureExternalEntryByTarget.get(normalizePath(folder.folderPath))
      || structureEntryByPath.get(stableRelativePath);
    const entry: ProjectFileEntry | undefined = foundEntry || folder.folderMissing ? foundEntry || {
      kind: 'folder', name: folder.displayName, path: folder.folderPath, relativePath: stableRelativePath, extension: '', size: 0, createdAt: folder.createdAt, updatedAt: folder.updatedAt,
    } : undefined;
    return entry && parentPath(stableRelativePath) === normalizedScopePath ? [{ folder, entry }] : [];
  });
  const trackedEntryPaths = new Set(versionItems.map(item => normalizePath(item.entry.relativePath)));
  const ordinaryEntries = entries.filter(entry => !trackedEntryPaths.has(normalizePath(entry.relativePath)));
  return { versionItems, trackedEntryPaths, ordinaryEntries };
};
