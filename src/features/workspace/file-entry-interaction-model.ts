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

export const directoryEntryToSelectOnReturn = (currentPath: string, targetPath: string) => {
  const current = normalizeDirectoryPath(currentPath);
  const target = normalizeDirectoryPath(targetPath);
  if (!current || current === target || target && !current.startsWith(`${target}/`)) return '';
  const nextSegment = current.slice(target ? target.length + 1 : 0).split('/')[0];
  return nextSegment ? [target, nextSegment].filter(Boolean).join('/') : '';
};
