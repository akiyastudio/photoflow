export type FilenameSelectionSourceFolder = {
  name: string;
  relativePath: string;
};

const normalizeRelativePath = (value: string | undefined) => String(value || '')
  .trim()
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .replace(/\/+$/, '');

export const resolveFilenameSelectionSource = (
  folders: FilenameSelectionSourceFolder[],
  configuredPath: string | undefined,
  defaultFolderName: 'raw' | 'mov',
) => {
  if (configuredPath !== undefined && !normalizeRelativePath(configuredPath)) return '';
  const requested = normalizeRelativePath(configuredPath) || defaultFolderName;
  const requestedKey = requested.toLocaleLowerCase();
  return folders.find(folder => normalizeRelativePath(folder.relativePath).toLocaleLowerCase() === requestedKey)?.relativePath
    || folders.find(folder => !normalizeRelativePath(folder.relativePath).includes('/') && folder.name.toLocaleLowerCase() === requestedKey)?.relativePath
    || '';
};

export const filenameSelectionOutputName = (sourceRelativePath: string) => {
  const sourceName = normalizeRelativePath(sourceRelativePath).split('/').filter(Boolean).at(-1) || '';
  if (!sourceName) return '';
  if (sourceName.toLocaleLowerCase() === 'raw') return '图片选片';
  if (sourceName.toLocaleLowerCase() === 'mov') return '视频选片';
  return `${sourceName}_选片`;
};
