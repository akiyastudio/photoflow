type ProgressFolderLike = { id: string; mediaKind: string; folderMissing?: boolean; relationKind?: string; nodeRole: string; contentRef?: { relativeDirectory?: string } };
const normalize = (value = '') => value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();

export const resolveLegacyTeamSourceProgressIds = (sourceFilePaths: string[], folders: ProgressFolderLike[]) => {
  const eligible = folders.filter(folder => folder.mediaKind === 'image' && !folder.folderMissing && folder.relationKind !== 'auxiliary' && folder.nodeRole === 'progress');
  const resolved: string[] = [];
  for (const sourceFilePath of sourceFilePaths.filter(Boolean)) {
    const sourcePath = normalize(sourceFilePath);
    const owner = eligible.filter(folder => {
      const relativeDirectory = normalize(folder.contentRef?.relativeDirectory || '');
      if (!relativeDirectory) return false;
      return sourcePath === relativeDirectory || sourcePath.startsWith(`${relativeDirectory}/`);
    }).sort((left, right) => normalize(right.contentRef?.relativeDirectory).length - normalize(left.contentRef?.relativeDirectory).length)[0];
    if (owner && !resolved.includes(owner.id)) resolved.push(owner.id);
  }
  return resolved;
};
