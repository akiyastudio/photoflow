type ProgressFolderLike = { id: string; mediaKind: string; folderMissing?: boolean; missing?: boolean; relationKind?: string; nodeRole: string; folderPath?: string; contentRef?: { relativeDirectory?: string } };
const normalize = (value = '') => value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();

export const resolveLegacyTeamSourceProgressIds = (sourceFilePaths: string[], folders: ProgressFolderLike[]) => {
  const eligible = folders.filter(folder => folder.mediaKind === 'image' && !folder.folderMissing && !folder.missing && folder.relationKind !== 'auxiliary' && folder.nodeRole === 'progress');
  const resolved: string[] = [];
  for (const sourceFilePath of sourceFilePaths.filter(Boolean)) {
    const sourcePath = normalize(sourceFilePath);
    const owner = eligible.filter(folder => {
      const folderPath = normalize(folder.folderPath || folder.contentRef?.relativeDirectory || '');
      if (!folderPath) return false;
      const folderName = folderPath.split('/').filter(Boolean).at(-1) || '';
      return sourcePath === folderPath || sourcePath.startsWith(`${folderPath}/`) || sourcePath === folderName || sourcePath.startsWith(`${folderName}/`);
    }).sort((left, right) => normalize(right.folderPath).length - normalize(left.folderPath).length)[0];
    if (owner && !resolved.includes(owner.id)) resolved.push(owner.id);
  }
  return resolved;
};
