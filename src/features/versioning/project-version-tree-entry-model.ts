import type { ProgressFolder, ProjectFileEntry } from '../../types';

export type ResolvedVersionTreeEntryItem = { folder: ProgressFolder; entry: ProjectFileEntry };
type RenameAwareProjectFileEntry = ProjectFileEntry & { pendingSourceRelativePath?: string };

export const versionTreeReactKey = (item: {
  key: string;
  nodeKey: string;
  folder?: Pick<ProgressFolder, 'folderId'>;
}) => item.folder
  // A rename keeps both the graph node and physical folder identity stable,
  // so its mounted cover can survive the path transition. A real relink keeps
  // the graph node but changes folderId and must discard the previous cover.
  ? `${item.nodeKey}:folder:${item.folder.folderId || 'unknown'}`
  : item.key;

const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase('zh-CN');
const parentPath = (value: string) => normalizePath(value).split('/').slice(0, -1).join('/');
const externalEntriesByTarget = (entries: RenameAwareProjectFileEntry[]) => {
  const candidates = new Map<string, RenameAwareProjectFileEntry[]>();
  entries.forEach(entry => {
    if (!entry.externalLink || !entry.externalLinkTarget) return;
    const target = normalizePath(entry.externalLinkTarget);
    candidates.set(target, [...(candidates.get(target) || []), entry]);
  });
  // Keep ambiguous targets in the index as undefined. Callers must not fall
  // through to a basename/path match and silently pick one shortcut merely
  // because it appeared first in an input array.
  return new Map([...candidates].map(([target, matches]) => [target, matches.length === 1 ? matches[0] : undefined] as const));
};

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
  const liveEntries = entries as RenameAwareProjectFileEntry[];
  const liveEntryByPath = new Map(liveEntries.map(entry => [normalizePath(entry.relativePath), entry]));
  const liveEntryBySourceAlias = new Map(liveEntries
    .filter(entry => Boolean(entry.pendingSourceRelativePath))
    .map(entry => [normalizePath(entry.pendingSourceRelativePath!), entry]));
  const liveExternalEntryByTarget = externalEntriesByTarget(liveEntries);
  const structureEntryByPath = new Map(structureEntries.map(entry => [normalizePath(entry.relativePath), entry]));
  const structureExternalEntryByTarget = externalEntriesByTarget(structureEntries);
  const versionItems: ResolvedVersionTreeEntryItem[] = folders.flatMap(folder => {
    const stableRelativePath = normalizePath(folder.externalLinkRelativePath || projectRelativePath(folder.folderPath));
    const normalizedFolderPath = normalizePath(folder.folderPath);
    const livePathEntry = liveEntryByPath.get(stableRelativePath);
    const sourceAliasEntry = liveEntryBySourceAlias.get(stableRelativePath);
    const structurePathEntry = structureEntryByPath.get(stableRelativePath);
    const exactAliasEntry = sourceAliasEntry || livePathEntry || structurePathEntry;
    const exactNonExternalEntry = [sourceAliasEntry, livePathEntry, structurePathEntry]
      .find(entry => entry && !entry.externalLink);
    const targetKnown = liveExternalEntryByTarget.has(normalizedFolderPath)
      || structureExternalEntryByTarget.has(normalizedFolderPath);
    const targetEntry = liveExternalEntryByTarget.has(normalizedFolderPath)
      ? liveExternalEntryByTarget.get(normalizedFolderPath)
      : structureExternalEntryByTarget.get(normalizedFolderPath);
    const ambiguousExternalTarget = targetKnown && !targetEntry && !exactNonExternalEntry;
    const foundEntry = sourceAliasEntry
      ? sourceAliasEntry
      : folder.externalLinkRelativePath && exactAliasEntry
        ? exactAliasEntry
        : targetKnown
          ? targetEntry || exactNonExternalEntry
          : exactAliasEntry;
    const entry: ProjectFileEntry | undefined = foundEntry || folder.folderMissing || ambiguousExternalTarget ? foundEntry || {
      kind: 'folder', name: folder.displayName, path: folder.folderPath, relativePath: stableRelativePath, extension: '', size: 0, createdAt: folder.createdAt, updatedAt: folder.updatedAt,
    } : undefined;
    return entry && parentPath(stableRelativePath) === normalizedScopePath ? [{ folder, entry }] : [];
  });
  const trackedEntryPaths = new Set(versionItems.map(item => normalizePath(item.entry.relativePath)));
  const ordinaryEntries = entries.filter(entry => !trackedEntryPaths.has(normalizePath(entry.relativePath)));
  return { versionItems, trackedEntryPaths, ordinaryEntries };
};
