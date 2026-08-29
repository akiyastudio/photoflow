import type { ComponentPageOpenScope, ProjectFileEntry } from '../../types';
const normalizedRelativePaths = (relativePaths: string[]) => relativePaths.map(relativePath => relativePath.replace(/\\/g, '/'));
const commonParentScope = (relativePaths: string[], fallback: string) => {
  if (!relativePaths.length) return fallback.replace(/\\/g, '/');
  const directories = normalizedRelativePaths(relativePaths).map(relativePath => relativePath.split('/').slice(0, -1));
  const common = [...directories[0]];
  for (const directory of directories.slice(1)) while (common.length && (directory.length < common.length || common.some((part, index) => part.toLocaleLowerCase() !== directory[index].toLocaleLowerCase()))) common.pop();
  return common.join('/');
};
export const isSafeComponentHostSelectionEntry = (entry: ProjectFileEntry) => entry.viaShortcut !== true || entry.viaExternalLink === true;
export const componentHostSelectedRelativePaths = (entries: ProjectFileEntry[]) => entries.filter(isSafeComponentHostSelectionEntry).map(entry => entry.relativePath.replace(/\\/g, '/'));
export const mediaContributionScope = (entries: ProjectFileEntry[], _clicked: ProjectFileEntry, sourcePageId: string): ComponentPageOpenScope | null => {
  if (!entries.length || entries.some(entry => !['image', 'raw', 'video'].includes(entry.kind))) return null;
  const selectedRelativePaths = normalizedRelativePaths(entries.map(entry => entry.relativePath));
  return { scopeRelativePath: commonParentScope(selectedRelativePaths, ''), selectedRelativePaths, sourcePageId };
};
export const projectContributionScope = (scopeRelativePath: string, sourcePageId: string, relativePaths: string[] = []): ComponentPageOpenScope => ({
  scopeRelativePath: commonParentScope(relativePaths, scopeRelativePath),
  selectedRelativePaths: normalizedRelativePaths(relativePaths),
  sourcePageId,
});
