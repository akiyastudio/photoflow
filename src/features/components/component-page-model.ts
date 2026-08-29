import type { ComponentHostAction, ComponentPageInstance, WorkspaceProject } from '../../types';

export const componentPageIdentity = (componentId: string, workspacePath: string, projectId: string) =>
  `${componentId}\u001f${workspacePath.replace(/\\/g, '/').toLocaleLowerCase()}\u001f${projectId}`;

export const ensureComponentPage = (
  pages: ComponentPageInstance[],
  action: ComponentHostAction,
  project: WorkspaceProject,
  workspacePath: string,
  insertAfterTabId = 'home',
): { pages: ComponentPageInstance[]; page: ComponentPageInstance; created: boolean } => {
  const identity = componentPageIdentity(action.componentId, workspacePath, project.id);
  const existing = pages.find(page => page.identity === identity);
  if (existing) return { pages, page: existing, created: false };
  const page: ComponentPageInstance = {
    identity,
    componentId: action.componentId,
    componentVersion: action.componentVersion,
    pageId: action.pageId,
    title: action.pageTitle,
    workspacePath,
    projectId: project.id,
    projectName: project.name,
    instanceId: '',
    insertAfterTabId,
    iconUrl: action.iconUrl,
  };
  return { pages: [...pages, page], page, created: true };
};

export const bindComponentPageInstance = (pages: ComponentPageInstance[], identity: string, instanceId: string) =>
  pages.map(page => page.identity === identity ? { ...page, instanceId } : page);

export const closeComponentPage = (pages: ComponentPageInstance[], identity: string) => pages.filter(page => page.identity !== identity);

export const componentPageIsAvailable = (page: ComponentPageInstance, components: Array<{ id: string; version: string; installed: boolean; enabled?: boolean; compatible: boolean; status?: string }>) => {
  const component = components.find(item => item.id === page.componentId);
  return Boolean(component?.installed && component.enabled !== false && component.compatible && component.version === page.componentVersion && !['disabled', 'invalid', 'integrity-invalid', 'incompatible'].includes(String(component.status || '')));
};
export const componentPageActivationSucceeded = (result: { success?: boolean } | null | undefined) => result?.success === true;

export const closeProjectComponentPages = (pages: ComponentPageInstance[], workspacePath: string, projectId: string) => {
  const normalizedWorkspace = workspacePath.replace(/\\/g, '/').toLocaleLowerCase();
  return pages.filter(page => page.projectId !== projectId || page.workspacePath.replace(/\\/g, '/').toLocaleLowerCase() !== normalizedWorkspace);
};
