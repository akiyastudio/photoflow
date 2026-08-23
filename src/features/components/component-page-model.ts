import type { ComponentHostAction, ComponentPageInstance, WorkspaceProject } from '../../types';

export const componentPageIdentity = (componentId: string, workspacePath: string, projectId: string) =>
  `${componentId}\u001f${workspacePath.replace(/\\/g, '/').toLocaleLowerCase()}\u001f${projectId}`;

export const ensureComponentPage = (
  pages: ComponentPageInstance[],
  action: ComponentHostAction,
  project: WorkspaceProject,
  workspacePath: string,
): { pages: ComponentPageInstance[]; page: ComponentPageInstance; created: boolean } => {
  const identity = componentPageIdentity(action.componentId, workspacePath, project.id);
  const existing = pages.find(page => page.identity === identity);
  if (existing) return { pages, page: existing, created: false };
  const page: ComponentPageInstance = {
    identity,
    componentId: action.componentId,
    pageId: action.pageId,
    title: action.pageTitle,
    workspacePath,
    projectId: project.id,
    projectName: project.name,
    instanceId: '',
  };
  return { pages: [...pages, page], page, created: true };
};

export const bindComponentPageInstance = (pages: ComponentPageInstance[], identity: string, instanceId: string) =>
  pages.map(page => page.identity === identity ? { ...page, instanceId } : page);

export const closeComponentPage = (pages: ComponentPageInstance[], identity: string) => pages.filter(page => page.identity !== identity);

export const closeProjectComponentPages = (pages: ComponentPageInstance[], workspacePath: string, projectId: string) => {
  const normalizedWorkspace = workspacePath.replace(/\\/g, '/').toLocaleLowerCase();
  return pages.filter(page => page.projectId !== projectId || page.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() !== normalizedWorkspace);
};
