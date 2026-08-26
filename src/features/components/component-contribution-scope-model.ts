import type { ComponentPageOpenScope, ProjectFileEntry } from '../../types';
export const mediaContributionScope = (entries: ProjectFileEntry[], _clicked: ProjectFileEntry, sourcePageId: string): ComponentPageOpenScope | null => {
  if (!entries.length || entries.some(entry => !['image', 'raw', 'video'].includes(entry.kind))) return null;
  const selectedRelativePaths = entries.map(entry => entry.relativePath.replace(/\\/g, '/'));
  const directories = selectedRelativePaths.map(relativePath => relativePath.split('/').slice(0, -1));
  const common = [...directories[0]];
  for (const directory of directories.slice(1)) while (common.length && (directory.length < common.length || common.some((part, index) => part.toLocaleLowerCase() !== directory[index].toLocaleLowerCase()))) common.pop();
  return { scopeRelativePath: common.join('/'), selectedRelativePaths, sourcePageId };
};
export const projectContributionScope = (scopeRelativePath: string, sourcePageId: string): ComponentPageOpenScope => ({ scopeRelativePath, selectedRelativePaths: [], sourcePageId });
